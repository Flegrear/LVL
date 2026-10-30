// Optional, durable, indexed seek renditions for hash-verified WebTorrent files.
// Never serves partial output, never deletes source torrent data, and shares
// the same per-session player-storage quota as WebTorrent/remux caches.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn as systemSpawn } from 'node:child_process';
import { isTorrentFileFullyVerified } from './verified-torrent-file.js';

const MAX_INDEXED_BYTES = 8 * 1024 ** 3;
const MIN_FREE_BYTES = 64 * 1024 ** 2;
const MAX_DURATION_SECONDS = 4 * 60 * 60;
const CHECK_MS = 4000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{40}$/i;
const CANCELLED = Symbol('indexed-cache-cancelled');

const inBounds = (n, max) => Number.isSafeInteger(n) && n >= 0 && n <= max;

export function indexedCacheEligibility({ session, fileIndex, media, audioIndex, audioMode, enabled }) {
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
  const encodeMain10 = codec === 'hevc' && depth === 10 && profile === 'main 10'
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
  const channels = audioMode === 'stereo' ? Math.min(2, track.channels)
    : audioMode === 'surround' ? Math.min(6, track.channels) : Math.min(6, track.channels);
  const bitrate = channels <= 2 ? '160k' : channels <= 5 ? '256k' : '384k';
  const identity = {
    sessionId: session.id, infoHash: session.infoHash.toLowerCase(), fileIndex,
    sourceLength: file.length, sourceName: file.name, audioIndex, audioMode,
    channels, bitrate, duration: Number(media.durationSeconds.toFixed(3)),
    videoCodec: codec, videoDepth: depth, videoWidth: video.width, videoHeight: video.height,
    videoTransfer: transfer, videoPrimaries: primaries, videoSpace: space,
    videoStrategy: copyH264 ? 'copy' : 'encode',
    cacheVersion: 'indexed-seek-v2-h264-aac-faststart',
  };
  return { eligible: true, identity, key: crypto.createHash('sha256')
    .update(JSON.stringify(identity)).digest('hex'),
    // Recheck the selected file's real piece bitfield while this background
    // job is alive; file.done/downloaded can lag a lost or invalidated piece.
    sourceVerified: () => isTorrentFileFullyVerified(session.torrent, fileIndex) };
}

export function createIndexedVideoCache({
  sessionsRoot, enabled, allowance, sourceUrl, ffmpegPath, ffprobePath,
  isCurrent, foregroundBusy = () => false, spawn = systemSpawn,
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
  const MAX_START_ESTIMATE = 6 * 1024 ** 3;
  const reserve = (sourceLength) => Math.min(MAX_START_ESTIMATE,
    Math.max(128 * 1024 ** 2, Math.ceil(sourceLength * 1.25)));
  function paths(info) {
    const dir = path.join(sessionsRoot, info.identity.sessionId, 'indexed-seek');
    return { dir, output: path.join(dir, info.key + '.mp4'),
      partial: path.join(dir, info.key + '.part.mp4'), manifest: path.join(dir, info.key + '.json') };
  }
  async function finished(info) {
    const p = paths(info);
    if (!valid(info)) return null;
    try {
      const [data, stat] = await Promise.all([fsp.readFile(p.manifest, 'utf8'), fsp.stat(p.output)]);
      const saved = JSON.parse(data);
      if (!stat.isFile() || JSON.stringify(saved.identity) !== JSON.stringify(info.identity)
        || !inBounds(saved.bytes, MAX_INDEXED_BYTES) || saved.bytes < 4096
        || stat.size !== saved.bytes || !valid(info)) return null;
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
    for (const child of [job.child, job.probe]) {
      if (child && !job.closedChildren.has(child)) try { child.kill('SIGTERM'); } catch {}
    }
    if ([job.child, job.probe].some(child => child && !job.closedChildren.has(child))) {
      job.escalation = setTimeout(() => {
        for (const child of [job.child, job.probe]) {
          if (child && !job.closedChildren.has(child)) try { child.kill('SIGKILL'); } catch {}
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
    // Claim the background slot BEFORE the first await. Foreground stopAll()
    // must also see a job waiting on an arbitrarily slow quota or disk check.
    if (jobs.has(info.key) || jobs.size || foregroundBusy() || !valid(info)) return;
    const job = { info, cancelled: false, child: null, probe: null,
      escalation: null, closedChildren: new Set(), outputCommitted: false, published: false };
    job.cancellation = new Promise(resolve => { job.resolveCancellation = resolve; });
    job.finished = new Promise(resolve => { job.resolveFinished = resolve; });
    jobs.set(info.key, job);
    try {
      if (await Promise.race([finished(info), job.cancellation])) return;
      if (job.cancelled || !valid(info) || foregroundBusy()) return;
      await fsp.mkdir(p.dir, { recursive: true });
      if (job.cancelled || !valid(info)) return;
      // An interrupted previous process can leave an MP4 without its final
      // manifest (or an uncommitted .tmp); both are private, unusable caches.
      await Promise.all([
        fsp.rm(p.partial, { force: true }), fsp.rm(p.output, { force: true }),
        fsp.rm(p.manifest, { force: true }),
        fsp.rm(p.manifest + '.tmp', { force: true }),
      ]);
      if (job.cancelled || !valid(info) || foregroundBusy()) return;
      const initial = await Promise.race([allowance(reserve(info.identity.sourceLength)), job.cancellation]);
      if (initial === CANCELLED || !initial?.allowed || job.cancelled || !valid(info) || foregroundBusy()) return;
      const input = sourceUrl(info.identity);
      if (!input?.url) return;
      try {
        const i = info.identity;
        const videoArgs = i.videoStrategy === 'copy'
          ? ['-c:v','copy','-avoid_negative_ts','make_zero']
          : ['-c:v','libx264','-preset','veryfast','-crf','23',
            '-vf','setpts=PTS-STARTPTS,format=yuv420p','-pix_fmt','yuv420p',
            '-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709'];
        const args = ['-hide_banner','-loglevel','error','-nostdin','-y',
          '-i',input.url,'-map','0:v:0','-map',`0:a:${i.audioIndex}`,
          ...videoArgs,
          '-c:a','aac','-ac',String(i.channels),'-b:a',i.bitrate,
          '-af','asetpts=PTS-STARTPTS,aresample=async=1:first_pts=0',
          '-movflags','+faststart','-f','mp4',p.partial];
        if (job.cancelled || !valid(info) || foregroundBusy()) return;
        job.child = spawn(ffmpegPath, args, { stdio: ['ignore','ignore','pipe'], windowsHide: true });
        // Register exit handling before callbacks can throw or cancellation
        // races a just-spawned child. A slot is released only on actual close.
        // Drain stderr to prevent FFmpeg's own log pipe from pinning 'close'.
        let stderr = '';
        job.child.stderr?.on('data', chunk => { if (stderr.length < 2048) stderr += String(chunk).slice(0,2048); });
        const completion = new Promise(resolve => {
          job.child.once('error', () => { void cancelJob(job); });
          job.child.once('close', code => {
            job.closedChildren.add(job.child);
            clearTimeout(job.escalation);
            try { onClose(job.child, info.identity); } catch {}
            resolve(code);
          });
        });
        try { onSpawn(job.child, info.identity); }
        catch { await cancelJob(job); }
        if (job.cancelled) {
          await completion;
          return;
        }
        let monitorBusy = false;
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
        const probe = await new Promise(resolve => {
          const child = spawn(ffprobePath, ['-v','error','-show_entries',
            'format=duration:stream=codec_name,codec_type,channels,pix_fmt,width,height','-of','json',p.partial],
            { stdio: ['ignore','pipe','pipe'], windowsHide: true });
          job.probe = child;
          let out = '';
          let completed = false;
          const finish = value => { if (!completed) { completed = true; clearTimeout(timeout); resolve(value); } };
          const timeout = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 20_000);
          timeout.unref?.();
          child.stdout?.on('data', c => { if (out.length < 16384) out += c.toString().slice(0, 16384-out.length); });
          child.once('error', () => { void cancelJob(job); });
          child.once('close', code => {
            job.closedChildren.add(child);
            if (code || job.cancelled) return finish(null);
            try { finish(JSON.parse(out)); } catch { finish(null); }
          });
          if (job.cancelled) try { child.kill('SIGTERM'); } catch {}
        });
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
        await fsp.rename(p.partial, p.output);
        job.outputCommitted = true;
        if (job.cancelled || !valid(info)) return;
        const manifestFile = await fsp.open(p.manifest + '.tmp', 'wx');
        try {
          await manifestFile.writeFile(JSON.stringify({
            identity: info.identity, duration, bytes: stat.size,
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
      if (jobs.get(info.key) === job) jobs.delete(info.key);
      job.resolveFinished();
    }
  }
  async function status(params, { start = true } = {}) {
    const info = indexedCacheEligibility({ ...params, enabled: enabled() });
    if (!info.eligible) return { status: info.reason };
    const complete = await finished(info);
    if (complete) return { status: 'ready', bytes: complete.bytes,
      duration: complete.duration, info };
    if (jobs.has(info.key)) return { status: 'building' };
    if (start) void build(info);
    return { status: 'waiting' };
  }
  return { status, finished, build, stopSession, stopAll, purgeAll, paths };
}
