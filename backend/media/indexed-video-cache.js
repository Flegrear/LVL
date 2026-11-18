// Optional, durable, indexed seek renditions for hash-verified WebTorrent files.
// Never serves partial output, never deletes source torrent data, and shares
// the same per-session player-storage quota as WebTorrent/remux caches.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn as systemSpawn } from 'node:child_process';
import { isTorrentFileFullyVerified } from './verified-torrent-file.js';
import { waitForChildStdioDrain } from './transcode-slot-lifecycle.js';
import { mediaAdmissionsClosed } from './media-shutdown.js';
import { createSharedCacheReservation } from './shared-cache-admission.js';

const MAX_INDEXED_BYTES = 8 * 1024 ** 3;
const MIN_FREE_BYTES = 64 * 1024 ** 2;
const MAX_DURATION_SECONDS = 4 * 60 * 60;
const CHECK_MS = 4000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{40}$/i;
const CANCELLED = Symbol('indexed-cache-cancelled');
const INDEXED_SCHEMA = 'indexed-seek-v3-binary-and-content-sha256';

const inBounds = (n, max) => Number.isSafeInteger(n) && n >= 0 && n <= max;
const indexedOutputBudget = sourceLength => Math.min(6 * 1024 ** 3,
  Math.max(128 * 1024 ** 2, Math.ceil(sourceLength * 1.25)));

// Read the actual accepted binary/output through one pinned file handle, not
// a filename, package version, or metadata-only mtime fingerprint. Hashing is
// performed by normal app code on demand; it never executes the binary.
async function sha256File(filename, maxBytes) {
  if (!path.isAbsolute(filename || '')) return null;
  let handle;
  try {
    handle = await fsp.open(filename, 'r');
    const before = await handle.stat();
    if (!before.isFile() || !inBounds(before.size, maxBytes) || before.size < 1) return null;
    const digest = crypto.createHash('sha256');
    const block = Buffer.allocUnsafe(256 * 1024);
    for (let offset = 0; offset < before.size;) {
      const { bytesRead } = await handle.read(block, 0, Math.min(block.length, before.size - offset), offset);
      if (!bytesRead) return null;
      digest.update(block.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs || before.ino !== after.ino
      || before.dev !== after.dev) return null;
    return digest.digest('hex');
  } catch { return null; }
  finally { await handle?.close().catch(() => {}); }
}

function indexedArgs(identity, input, output) {
  const videoArgs = identity.videoStrategy === 'copy'
    ? ['-c:v','copy','-avoid_negative_ts','make_zero']
    : ['-c:v','libx264','-preset','veryfast','-crf','23',
      '-vf','setpts=PTS-STARTPTS,format=yuv420p','-pix_fmt','yuv420p',
      '-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709'];
  return ['-hide_banner','-loglevel','error','-nostdin','-y',
    '-i',input,'-map','0:v:0','-map',`0:${identity.audioStreamIndex}`,
    ...videoArgs,'-c:a','aac','-ac',String(identity.channels),'-b:a',identity.bitrate,
    '-af','asetpts=PTS-STARTPTS,aresample=async=1:first_pts=0',
    // Encoder output cannot exceed the bytes admitted for this job. A
    // truncated result will fail the complete FFprobe duration check.
    '-fs',String(indexedOutputBudget(identity.sourceLength)),
    '-movflags','+faststart','-f','mp4',output];
}

function indexedArgsHash(identity) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(indexedArgs(identity, '<accepted-source>', '<private-output>')))
    .digest('hex');
}

// canEncode: false (LVL's Android app, whose FFmpeg has no H.264 encoder) leaves only the copied
// H.264 renditions; sources that would need encoding are unsupported there.
export function indexedCacheEligibility({ session, fileIndex, media, audioIndex, audioMode, enabled, canEncode = true }) {
  const file = session?.torrent?.files?.[fileIndex];
  if (!enabled) return { eligible: false, reason: 'disabled' };
  if (!UUID.test(String(session?.id || '')) || !HASH.test(String(session?.infoHash || ''))
    || !inBounds(fileIndex, 1024) || !file || file.done !== true || file.downloaded !== file.length
    || !inBounds(Number(file.length), 20 * 1024 ** 3) || file.length < 1
    || !isTorrentFileFullyVerified(session.torrent, fileIndex))
    return { eligible: false, reason: 'source-incomplete' };
  const video = media?.video;
  const codec = String(video?.codec || '').toLowerCase();
  const pixel = String(video?.pixelFormat || '');
  const profile = String(video?.profile || '').trim().toLowerCase();
  const depth = Number(video?.bitDepth) || (/10le|10be|p10/i.test(pixel) ? 10 : 8);
  const transfer = String(video?.colorTransfer || '').toLowerCase();
  const primaries = String(video?.colorPrimaries || '').toLowerCase();
  const space = String(video?.colorSpace || '').toLowerCase();
  // Fully verified H264 4:2:0 SDR already has browser-compatible video. Remux
  // those samples unchanged into indexed MP4 rather than needlessly encoding
  // an entire episode. Unsupported H264 profiles/bit depths stay native/MSE.
  const copyH264 = codec === 'h264' && depth === 8 && pixel.toLowerCase() === 'yuv420p'
    && ['baseline','constrained baseline','main','high'].includes(profile);
  const encodeMain10 = canEncode !== false && codec === 'hevc' && depth === 10 && profile === 'main 10'
    && ['yuv420p10le','yuv420p10be','p010le'].includes(pixel.toLowerCase());
  if ((!copyH264 && !encodeMain10) || video?.dolbyVision || video?.hdrKind
    || media?.compatibility?.video?.hdr || media?.compatibility?.video?.hdrKind
    || (transfer && !['bt709','iec61966-2-1'].includes(transfer))
    || (primaries && !['bt709','smpte170m','bt470bg'].includes(primaries))
    || (space && !['bt709','smpte170m','bt470bg'].includes(space))
    || !Number.isFinite(media?.durationSeconds) || media.durationSeconds < 2
    || media.durationSeconds > MAX_DURATION_SECONDS
    || !inBounds(video?.width, 3840) || video.width < 16
    || !inBounds(video?.height, 2160) || video.height < 16)
    return { eligible: false, reason: 'unsupported-video' };
  if (!inBounds(audioIndex, 64) || !['auto', 'stereo', 'surround'].includes(audioMode))
    return { eligible: false, reason: 'invalid-audio' };
  const track = media?.audioTracks?.[audioIndex];
  if (!track || !inBounds(Number(track.channels), 8) || Number(track.channels) < 1)
    return { eligible: false, reason: 'unsupported-audio' };
  if (!inBounds(track.streamIndex, 9999) || typeof file.path !== 'string'
    || !file.path || file.path.length > 4096)
    return { eligible: false, reason: 'ambiguous-source-or-stream' };
  const channels = audioMode === 'stereo' ? Math.min(2, track.channels)
    : audioMode === 'surround' ? Math.min(6, track.channels) : Math.min(6, track.channels);
  const bitrate = channels <= 2 ? '160k' : channels <= 5 ? '256k' : '384k';
  const identity = {
    sessionId: session.id, infoHash: session.infoHash.toLowerCase(), fileIndex,
    sourceLength: file.length, sourceName: file.name, sourcePath: file.path,
    audioIndex, audioStreamIndex: track.streamIndex, audioMode,
    channels, bitrate, duration: Number(media.durationSeconds.toFixed(3)),
    videoCodec: codec, videoDepth: depth, videoWidth: video.width, videoHeight: video.height,
    videoTransfer: transfer, videoPrimaries: primaries, videoSpace: space,
    videoStrategy: copyH264 ? 'copy' : 'encode',
    cacheVersion: INDEXED_SCHEMA,
  };
  return { eligible: true, identity, key: crypto.createHash('sha256')
    .update(JSON.stringify(identity)).digest('hex'),
    // Recheck the selected file's real piece bitfield while this background
    // job is alive; file.done/downloaded can lag a lost or invalidated piece.
    sourceVerified: () => session.torrent?.files?.[fileIndex] === file
      && session.torrent?.destroyed !== true
      && isTorrentFileFullyVerified(session.torrent, fileIndex) };
}

export function createIndexedVideoCache({
  sessionsRoot, enabled, allowance, sourceUrl, ffmpegPath, ffprobePath,
  isCurrent, foregroundBusy = () => false, spawn = systemSpawn,
  canEncode = () => true,
  onSpawn = () => {}, onClose = () => {},
  checkEveryMs = CHECK_MS,
  removeIndexedDir = (dir, options) => fsp.rm(dir, options),
  purgeRetryMs = 2000,
}) {
  const jobs = new Map();
  let purging = false;
  let purgeOperation = null;
  let purgeRetryTimer = null;
  let retryRunning = false;
  const pendingPurges = new Set();
  function paths(info) {
    const dir = path.join(sessionsRoot, info.identity.sessionId, 'indexed-seek');
    return { dir, output: path.join(dir, info.key + '.mp4'),
      partial: path.join(dir, info.key + '.part.mp4'), manifest: path.join(dir, info.key + '.json') };
  }
  async function scopedDir(info, p) {
    try {
      const root = await fsp.realpath(sessionsRoot);
      const home = await fsp.realpath(path.join(sessionsRoot, info.identity.sessionId));
      const dir = await fsp.realpath(p.dir);
      // Session UUID and rendition hex key are not enough if a local
      // symlink or junction redirects the directory outside the quota tree.
      return path.relative(root, home).toLowerCase() === info.identity.sessionId.toLowerCase()
        && path.relative(home, dir).toLowerCase() === 'indexed-seek';
    } catch { return false; }
  }
  async function finished(info) {
    const p = paths(info);
    if (!valid(info) || !await scopedDir(info,p)) return null;
    try {
      const [data, stat] = await Promise.all([fsp.readFile(p.manifest, 'utf8'), fsp.lstat(p.output)]);
      const saved = JSON.parse(data);
      if (!stat.isFile() || stat.isSymbolicLink()
        || JSON.stringify(saved.identity) !== JSON.stringify(info.identity)
        || !inBounds(saved.bytes, MAX_INDEXED_BYTES) || saved.bytes < 4096
        || saved.schema !== INDEXED_SCHEMA
        || !/^[a-f0-9]{64}$/.test(String(saved.outputSha256 || ''))
        || saved.encoderSha256 !== info.identity.ffmpegSha256
        || saved.encoderArgsSha256 !== info.identity.encoderArgsSha256
        || stat.size !== saved.bytes || !valid(info)) return null;
      const outputRealPath = await fsp.realpath(p.output);
      if (path.relative(p.dir,outputRealPath).toLowerCase() !== (info.key+'.mp4').toLowerCase()
        || await sha256File(p.output, MAX_INDEXED_BYTES) !== saved.outputSha256
        || !valid(info)) return null;
      return { file: p.output, bytes: stat.size, duration: saved.duration };
    } catch { return null; }
  }
  const valid = (info) => !purging && !pendingPurges.has(paths(info).dir)
    && enabled() && isCurrent(info.identity)
    && (typeof info.sourceVerified !== 'function' || info.sourceVerified());
  async function cancelJob(job) {
    if (job.cancelled) return;
    job.cancelled = true;
    job.resolveCancellation(CANCELLED);
    const signalable = child => child && !job.closedChildren.has(child)
      && child.exitCode == null && child.signalCode == null
      && Number.isSafeInteger(child.pid) && child.pid > 0;
    for (const child of [job.child, job.probe]) {
      if (signalable(child)) try { child.kill('SIGTERM'); } catch {}
    }
    if ([job.child, job.probe].some(signalable)) {
      job.escalation = setTimeout(() => {
        for (const child of [job.child, job.probe]) {
          // Exit without close is still draining, but cannot be signalled
          // using a PID which may have been recycled by the OS.
          if (signalable(child)) try { child.kill('SIGKILL'); } catch {}
        }
      }, 2000);
      job.escalation.unref?.();
    }
  }
  async function stopSession(id) {
    const affected = [...jobs.values()].filter(job => job.info.identity.sessionId === id);
    await Promise.all(affected.map(async job => { await cancelJob(job); await job.finished; }));
  }
  async function stopAll() {
    const affected = [...jobs.values()];
    await Promise.all(affected.map(async job => { await cancelJob(job); await job.finished; }));
  }
  function schedulePurgeRetry() {
    if (!pendingPurges.size || purgeRetryTimer !== null) return;
    purgeRetryTimer = setTimeout(() => {
      purgeRetryTimer = null;
      void retryPendingPurges();
    }, Math.max(10, Number(purgeRetryMs) || 2000));
    purgeRetryTimer.unref?.();
  }
  async function retryPendingPurges() {
    if (retryRunning) return;
    retryRunning = true;
    try {
      for (const dir of [...pendingPurges]) {
        try {
          await removeIndexedDir(dir, { recursive: true, force: true,
            maxRetries: 1, retryDelay: 100 });
          pendingPurges.delete(dir);
        } catch {
          // Windows refuses to delete an MP4 held by an active Range reader.
          // Hold this directory closed to new conversions until retry succeeds.
        }
      }
    } finally {
      retryRunning = false;
      schedulePurgeRetry();
    }
  }
  async function purgeAll() {
    if (purgeOperation) return purgeOperation;
    purging = true;
    purgeOperation = (async () => {
      await stopAll();
      let entries = [];
      try { entries = await fsp.readdir(sessionsRoot, { withFileTypes: true }); } catch {}
      for (const entry of entries) {
        if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
        pendingPurges.add(path.join(sessionsRoot, entry.name, 'indexed-seek'));
      }
      await retryPendingPurges();
    })();
    try { await purgeOperation; }
    finally { purgeOperation = null; purging = false; }
  }
  async function build(info) {
    const p = paths(info);
    if (!/^[a-f0-9]{64}$/.test(String(info?.identity?.ffmpegSha256 || ''))
      || info.identity.encoderArgsSha256 !== indexedArgsHash(info.identity)
      || info.identity.cacheVersion !== INDEXED_SCHEMA) return;
    // Claim the background slot BEFORE the first await. Foreground stopAll()
    // must also see a job waiting on an arbitrarily slow quota or disk check.
    if (jobs.has(info.key) || jobs.size || foregroundBusy() || mediaAdmissionsClosed() || !valid(info)) return;
    const job = { info, cancelled: false, child: null, probe: null,
      escalation: null, closedChildren: new Set(), outputCommitted: false, published: false,
      quota: createSharedCacheReservation({ sessionsRoot, allowance }) };
    job.cancellation = new Promise(resolve => { job.resolveCancellation = resolve; });
    job.finished = new Promise(resolve => { job.resolveFinished = resolve; });
    jobs.set(info.key, job);
    try {
      if (await Promise.race([finished(info), job.cancellation])) return;
      if (job.cancelled || !valid(info) || foregroundBusy() || mediaAdmissionsClosed()) return;
      await fsp.mkdir(p.dir, { recursive: true });
      if (job.cancelled || !valid(info) || !await scopedDir(info,p)) return;
      // An interrupted previous process can leave an MP4 without its final
      // manifest (or an uncommitted .tmp); both are private, unusable caches.
      // Never replace an output that could have an active native Range
      // borrower. Unusable/legacy outputs require an explicit retired purge.
      try { await fsp.stat(p.output); return; }
      catch (error) { if (error?.code !== 'ENOENT') return; }
      await Promise.all([
        fsp.rm(p.partial, { force: true }),
        fsp.rm(p.manifest, { force: true }),
        fsp.rm(p.manifest + '.tmp', { force: true }),
      ]);
      if (job.cancelled || !valid(info) || foregroundBusy() || mediaAdmissionsClosed()) return;
      if (await Promise.race([
        job.quota.reserve(indexedOutputBudget(info.identity.sourceLength)), job.cancellation,
      ]) !== true
        || job.cancelled || !valid(info) || foregroundBusy() || mediaAdmissionsClosed()) return;
      const input = sourceUrl(info.identity);
      if (!input?.url) return;
      try {
        const i = info.identity;
        const args = indexedArgs(i, input.url, p.partial);
        if (job.cancelled || !valid(info) || foregroundBusy()) return;
        // Recheck the actual binary immediately before admission: a replaced
        // FFmpeg path must never inherit the previous generation's identity.
        if (await sha256File(ffmpegPath, 1024 ** 3) !== i.ffmpegSha256
          || job.cancelled || !valid(info)) return;
        job.child = spawn(ffmpegPath, args, { stdio: ['ignore','ignore','pipe'], windowsHide: true });
        // Register termination handling before callbacks can throw or
        // cancellation races a just-spawned child. 'exit' alone is NOT a
        // completed MP4: stderr may still be draining after the OS process
        // has exited, and a slot must stay reserved until the close/EOF
        // boundary. An exited child with stuck pipes fails after a bounded
        // drain window; no partial output may be published.
        let stderr = '';
        job.child.stderr?.on('data', chunk => { if (stderr.length < 2048) stderr += String(chunk).slice(0,2048); });
        const child = job.child;
        const completion = waitForChildStdioDrain(child, {
          afterExitMs: 2000,
          onError: () => { void cancelJob(job); },
        }).then(code => {
          // Actual close, all pipe EOF after confirmed exit, or a failed
          // no-PID spawn are the only retirement boundaries.
          job.closedChildren.add(child);
          clearTimeout(job.escalation);
          try { onClose(child, info.identity); } catch {}
          return code;
        });
        try { onSpawn(job.child, info.identity); }
        catch { await cancelJob(job); }
        if (job.cancelled) {
          await completion;
          return;
        }
        let monitorBusy = false;
        let accountedBytes = 0;
        const timer = setInterval(async () => {
          if (monitorBusy || job.cancelled) return;
          monitorBusy = true;
          try {
            if (!valid(info) || foregroundBusy()) { await cancelJob(job); return; }
            let size;
            try { size = (await fsp.stat(p.partial)).size; }
            catch (error) {
              // FFmpeg may still be creating its output immediately after
              // spawn; other filesystem errors mean storage cannot be trusted.
              if (error?.code !== 'ENOENT') await cancelJob(job);
              return;
            }
            if (size > MAX_INDEXED_BYTES) { await cancelJob(job); return; }
            if (size > indexedOutputBudget(info.identity.sourceLength)
              || (size > accountedBytes && !job.quota.consume(size - accountedBytes))) {
              await cancelJob(job); return;
            }
            accountedBytes = size;
            // Existing partial bytes are already included in playerUsage().
            if (!(await allowance(MIN_FREE_BYTES))?.allowed) await cancelJob(job);
          } catch { await cancelJob(job); }
          finally { monitorBusy = false; }
        }, checkEveryMs);
        timer.unref?.();
        const code = await completion;
        clearInterval(timer);
        if (code !== 0 || job.cancelled || !valid(info)) return;
        const stat = await fsp.stat(p.partial);
        if (stat.size < 4096 || stat.size > MAX_INDEXED_BYTES) return;
        if (stat.size > indexedOutputBudget(info.identity.sourceLength)
          || (stat.size > accountedBytes && !job.quota.consume(stat.size - accountedBytes))) return;
        accountedBytes = stat.size;
        const probe = await (async () => {
          const child = spawn(ffprobePath, ['-v','error','-show_entries',
            'format=duration:stream=codec_name,codec_type,channels,pix_fmt,width,height','-of','json',p.partial],
            { stdio: ['ignore','pipe','pipe'], windowsHide: true });
          job.probe = child;
          let out = '';
          let timedOut = false;
          child.stdout?.on('data', c => { if (out.length < 16384) out += c.toString().slice(0, 16384-out.length); });
          child.stderr?.resume?.();
          const completion = waitForChildStdioDrain(child, {
            timeoutMs: 20_000,
            onTimeout: () => { timedOut = true; try { child.kill('SIGKILL'); } catch {} },
            onError: () => { void cancelJob(job); },
          });
          if (job.cancelled) try { child.kill('SIGTERM'); } catch {}
          const code = await completion;
          job.closedChildren.add(child);
          if (code !== 0 || timedOut || job.cancelled) return null;
          try { return JSON.parse(out); } catch { return null; }
        })();
        const duration = Number(probe?.format?.duration);
        const videos = probe?.streams?.filter(stream => stream.codec_type === 'video') || [];
        const audios = probe?.streams?.filter(stream => stream.codec_type === 'audio') || [];
        if (!probe || !Number.isFinite(duration) || Math.abs(duration - info.identity.duration) > 3
          || videos.length !== 1 || videos[0].codec_name !== 'h264'
          || videos[0].pix_fmt !== 'yuv420p'
          || videos[0].width !== info.identity.videoWidth
          || videos[0].height !== info.identity.videoHeight
          || audios.length !== 1 || audios[0].codec_name !== 'aac'
          || audios[0].channels !== info.identity.channels
          || job.cancelled || !valid(info)) return;
        if (!(await Promise.race([allowance(MIN_FREE_BYTES), job.cancellation]))?.allowed
          || job.cancelled || !valid(info)) return;
        // No reader can observe a .part file; manifest is published last.
        // Flush the actual MP4 before committing its manifest; otherwise a
        // sudden shutdown could preserve metadata but lose recent media bytes.
        // Windows FlushFileBuffers requires a handle with write access.
        const outputHandle = await fsp.open(p.partial, 'r+');
        try { await outputHandle.sync(); } finally { await outputHandle.close(); }
        if (job.cancelled || !valid(info)) return;
        const outputSha256 = await sha256File(p.partial, MAX_INDEXED_BYTES);
        if (!outputSha256
          || await sha256File(ffmpegPath, 1024 ** 3) !== i.ffmpegSha256
          || job.cancelled || !valid(info)) return;
        await fsp.rename(p.partial, p.output);
        job.outputCommitted = true;
        if (job.cancelled || !valid(info)) return;
        const manifestFile = await fsp.open(p.manifest + '.tmp', 'wx');
        try {
          await manifestFile.writeFile(JSON.stringify({
            schema: INDEXED_SCHEMA, identity: info.identity,
            encoderSha256: i.ffmpegSha256,
            encoderArgsSha256: i.encoderArgsSha256,
            outputSha256, duration, bytes: stat.size,
          }));
          await manifestFile.sync();
        } finally { await manifestFile.close(); }
        if (job.cancelled || !valid(info)) return;
        await fsp.rename(p.manifest + '.tmp', p.manifest);
        job.published = true;
      } finally { input.release?.(); }
    } catch { /* Failed optional work cannot interrupt foreground video. */ }
    finally {
      clearTimeout(job.escalation);
      try { await fsp.rm(p.partial, { force: true }); } catch {}
      try { await fsp.rm(p.manifest + '.tmp', { force: true }); } catch {}
      if (job.outputCommitted && !job.published) {
        try { await fsp.rm(p.output, { force: true }); } catch {}
      }
      job.quota.release();
      if (jobs.get(info.key) === job) jobs.delete(info.key);
      job.resolveFinished();
    }
  }
  async function status(params, { start = true } = {}) {
    if (mediaAdmissionsClosed()) return { status: 'shutdown' };
    const info = indexedCacheEligibility({ ...params, enabled: enabled(), canEncode: canEncode() });
    if (!info.eligible) return { status: info.reason };
    const binarySha256 = await sha256File(ffmpegPath, 1024 ** 3);
    if (!binarySha256) return { status: 'encoder-unavailable' };
    info.identity = { ...info.identity, ffmpegSha256: binarySha256,
      encoderArgsSha256: indexedArgsHash(info.identity) };
    info.key = crypto.createHash('sha256').update(JSON.stringify(info.identity)).digest('hex');
    const complete = await finished(info);
    if (complete) return { status: 'ready', bytes: complete.bytes,
      duration: complete.duration, info };
    if (jobs.has(info.key)) return { status: 'building' };
    if (start) void build(info);
    return { status: 'waiting' };
  }
  return { status, finished, build, stopSession, stopAll, purgeAll, paths };
}
