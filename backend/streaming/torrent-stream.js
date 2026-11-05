// Streaming a torrent's video file: direct ranges, indexed and progressive seeking, copied seek origins and remux warm windows.
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { probeCopiedSeekOrigin } from "../media/transcode-start.js";
import { verifyTorrentFileByteRange } from "../media/verified-torrent-range.js";
import { isTorrentFileFullyVerified } from "../media/verified-torrent-file.js";
import { indexedCacheEligibility } from "../media/indexed-video-cache.js";
import {
  activeForegroundTranscodeCount, activeTranscodes, ffprobePath, indexedVideoCache,
  internalReaderRoles, MAX_TORRENT_VIDEO_BYTES, MAX_TRANSCODE_JOBS, mime, playbackTrace, port,
  progressiveActiveProcesses, progressiveIndexCache, progressiveIslandStarts, progressiveStarts,
  progressiveVerifiedSource, remuxSegmentCache, storage, streamHealth, torrentRoot, torrentSessions,
  VIDEO_EXTENSIONS,
} from "../../server.js";
import { json, localRequestRejected, methodNotAllowed } from "../app/http-helpers.js";
import {
  internalTorrentSource, rejectOversizeVideo, safeTorrentRelativePath, trackOpenStream,
} from "../torrents/torrent-sessions.js";
import { getCachedMediaProbe } from "../media/torrent-probe.js";

const MAX_COPIED_SEEK_PROBES = 2;
const MAX_COPIED_SEEK_SUBSCRIBERS = 16;
const MAX_COPIED_SEEK_CACHE_ENTRIES = 64;
const COPIED_SEEK_CACHE_TTL_MS = 10 * 60 * 1000;

const copiedSeekOriginCache = new Map();
const copiedSeekOriginInflight = new Map();

let activeCopiedSeekProbes = 0;

// Independently verified fMP4/IDR windows become readable while the next GOP
// is still converting. This is separate from the existing complete MP4 index.
// It uses local, fully bitfield-verified source bytes only: no optional cache
// worker may download missing torrent pieces or consume both FFmpeg slots.
// A committed GOP is announced as soon as its complete MP4 + FFprobe proof
// hits the atomic index. Browser readiness therefore need not wait for the
// next three-second poll; subscribers still fetch the authenticated status
// before drawing a new bright interval.
const progressiveReadyListeners = new Map();

function startProgressiveWhenNewPieces(params, status) {
  if (storage.limits().remuxCacheEnabled !== true || !status?.identityKey
    || activeTranscodes.size >= MAX_TRANSCODE_JOBS || fullIndexFirstActive(params)
    || !['waiting','partial'].includes(status.status)) return false;
  const size = status.sourceFullyVerified === true
    && Number.isSafeInteger(status.sourceFileBytes) && status.sourceFileBytes > 0
    ? `whole:${status.sourceFileBytes}`
    : `prefix:${Number(status.verifiedSourceBytes) || 0}`;
  const previous = progressiveStarts.get(status.identityKey);
  // A stopped/failed partial conversion must NOT re-encode a 58-minute prefix
  // every time the UI checks status. Newly hash-verified source bytes, however,
  // grant exactly one new attempt; new GOPs can be published before torrent EOF.
  if ((status.status === 'waiting'
    || status.status === 'partial' && status.canContinue === true)
    && previous?.bytes !== size) {
    if (progressiveStarts.size >= 256)
      progressiveStarts.delete(progressiveStarts.keys().next().value);
    progressiveStarts.set(status.identityKey,{bytes:size,sessionId:params.session.id});
    void progressiveIndexCache.start(params);
    return true;
  }
  if (status.sourceMode !== 'verified-prefix') return false;
  // A hash-verified remote MKV Cluster can be independently reconstructed
  // from its verified EBML header plus a complete, verified later Cluster.
  // The cache must still decode it, prove IDR/AAC and recover original movie
  // PTS before publication. An arbitrary downloaded island is NOT bright.
  const evidence = progressiveVerifiedSource.inspect(params);
  if (!evidence?.eligible || !evidence.islands?.length) return false;
  let attempts = progressiveIslandStarts.get(status.identityKey);
  if (!attempts) {
    if (progressiveIslandStarts.size >= 64)
      progressiveIslandStarts.delete(progressiveIslandStarts.keys().next().value);
    attempts = new Set();
    progressiveIslandStarts.set(status.identityKey,attempts);
  }
  for (const island of evidence.islands) {
    const priorClusters=(status.ranges||[]).filter(item=>
      item.sourceKind==='isolated-cluster'
      && Number.isSafeInteger(item.sourceClusterStart)
      && item.sourceClusterStart>=island.start
      && item.sourceClusterStart<=island.end);
    const afterStartBytes=priorClusters.length
      ?Math.max(...priorClusters.map(item=>item.sourceClusterStart))+1
      :island.start;
    const signature=`${island.start}:${island.end}:${afterStartBytes}`;
    if (attempts.has(signature)) continue;
    if (attempts.size>=8192)return false;
    attempts.add(signature); // one attempt per verified island/cluster horizon
    void progressiveIndexCache.start(params,{sourceKind:'island',afterStartBytes});
    return true;
  }
  return false;
}
// Once a file is fully downloaded and verified, video that is copied (not
// re-encoded) becomes seekable from start to end in one FFmpeg pass: about
// 30 s for a 24-minute 1080p episode. Preparing the same episode section by
// section takes about 9 minutes, because every section gets its own check
// and index update. So a complete, copyable source builds the whole-episode
// file first; sections already prepared stay usable meanwhile. If that build
// hasn't started within 20 s (quota, a busy converter), or the player starts
// playing from sections, the section job is started again: a stopped job on a
// complete file doesn't restart by itself.
const fullIndexFirst = new Map(); // `${sessionId}:${fileIndex}` -> { since, gaveUp, stopped, ... }
const FULL_INDEX_FIRST_GRACE_MS = 20_000;
function fullIndexFirstChoice(params) {
  // Android does not build full-episode indexed copies in the background.
  // Preserve the desktop optimization and any already verified cache reads.
  if (process.platform === "android" || storage.limits().remuxCacheEnabled !== true) return null;
  const key = `${params.session?.id}:${params.fileIndex}`;
  const known = fullIndexFirst.get(key);
  if (known) return known.gaveUp ? null : known;
  const info = indexedCacheEligibility({ ...params, enabled: true });
  if (!info.eligible || info.identity?.videoStrategy !== 'copy') return null;
  if (fullIndexFirst.size >= 64) fullIndexFirst.delete(fullIndexFirst.keys().next().value);
  const entry = { since: Date.now(), gaveUp: false };
  fullIndexFirst.set(key, entry);
  return entry;
}
function fullIndexFirstActive(params) {
  const entry = fullIndexFirst.get(`${params.session?.id}:${params.fileIndex}`);
  return Boolean(entry && !entry.gaveUp && !entry.playerUsesSections);
}
function giveUpFullIndexFirst(entry, params) {
  entry.gaveUp = true;
  resumeStoppedSections(entry, params);
}
// The section cache skips sections it already has, so this continues where it stopped.
function resumeStoppedSections(entry, params) {
  if (!entry.stopped) return;
  entry.stopped = false;
  for (const [key, value] of progressiveStarts) if (value.sessionId === params.session?.id) progressiveStarts.delete(key);
  const inputPath = localVerifiedTorrentInputPath(params.session, params.fileIndex);
  if (inputPath) void progressiveIndexCache.start({ ...params, inputPath });
}
export function emitProgressiveReady(event) {
  const clients = progressiveReadyListeners.get(event?.identityKey);
  if (!clients?.size) return;
  const payload = `event: ready\ndata: ${JSON.stringify({id:event.id})}\n\n`;
  for (const entry of [...clients]) {
    try {
      if (entry.res.destroyed || entry.res.writableEnded) clients.delete(entry);
      else entry.res.write(payload);
    } catch { clients.delete(entry); }
  }
  if (!clients.size) progressiveReadyListeners.delete(event.identityKey);
}
export function closeProgressiveReadyListeners(sessionId = null) {
  for (const [key, clients] of progressiveReadyListeners) {
    for (const entry of [...clients]) {
      if (sessionId && entry.sessionId !== sessionId) continue;
      clients.delete(entry);
      if (!entry.res.destroyed && !entry.res.writableEnded) entry.res.end();
    }
    if (!clients.size) progressiveReadyListeners.delete(key);
  }
}

function parseRange(rangeHeader, length) {
  if (!rangeHeader) return null;
  const requested = rangeHeader.trim();
  // Multipart responses are not implemented. HTTP permits ignoring a valid
  // multiple-range request and returning the entire representation as 200.
  if (/^bytes=(?:\d+-\d*|-\d+)(?:\s*,\s*(?:\d+-\d*|-\d+))+$/i.test(requested)) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(requested);
  if (!match) return false;

  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return false;
    start = Math.max(0, length - suffix);
    end = length - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : length - 1;
  }

  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= length) return false;
  return { start, end: Math.min(end, length - 1) };
}

// WebTorrent's addUID:true store is NOT <session>/<file.path>. It writes
// <session>/<torrent.name> - <infohash8>/<file.path>. HTTP stream readers
// resolve this internally, but optional *local-only* FFmpeg index inputs must
// use the exact same physical path. Never fall back to a network reader here.
function localVerifiedTorrentInputPath(session, fileIndex) {
  const torrent=session?.torrent, file=torrent?.files?.[fileIndex];
  const relative=String(file?.path||file?.name||"");
  const hash=String(torrent?.infoHash||session?.infoHash||"").toLowerCase();
  if(!safeTorrentRelativePath(relative)||!/^[a-f0-9]{40}$/.test(hash)
    ||typeof session?.id!=="string"||!/^[a-f0-9-]{36}$/i.test(session.id))return null;
  const root=path.resolve(torrentRoot,session.id);
  const uid=torrent.addUID===true ? `${String(torrent.name||"")} - ${hash.slice(0,8)}` : "";
  if(uid&&!safeTorrentRelativePath(uid))return null;
  const input=path.resolve(root,uid,relative);
  return input.startsWith(root+path.sep)?input:null;
}

// Only a completed, verified, plan-matched indexed file may answer Range.
// Partials are not addressable. The browser never sees filesystem paths.
function equivalentIndexedAudioMode(media,audioIndex,audioMode) {
  // The finished MP4 is already exactly stereo when the selected track has
  // <=2 channels. Auto and Stereo yield identical AAC output in that case;
  // a mode-only cache-key difference must not hide an existing full-episode
  // indexed MP4 and send the player back into short progressive GOPs.
  const channels=Number(media?.audioTracks?.[audioIndex]?.channels);
  return audioMode === "auto" && Number.isSafeInteger(channels)
    && channels >= 1 && channels <= 2 ? "stereo" : audioMode;
}
export async function serveIndexedSeek(req, res, session, fileIndex, url, statusOnly = false) {
  const file = session.torrent?.files?.[fileIndex];
  if (!file || !VIDEO_EXTENSIONS.has(path.extname(file.name).toLowerCase())) {
    json(res, 404, { error: "Video not found" }); return;
  }
  const audioIndex = Number(url.searchParams.get("audio") ?? 0);
  const audioMode = String(url.searchParams.get("audioMode") || "stereo");
  const media = getCachedMediaProbe(session.id, fileIndex);
  const params = { session, fileIndex, media, audioIndex,
    audioMode: equivalentIndexedAudioMode(media,audioIndex,audioMode) };
  let startFullIndex = process.platform !== "android" && statusOnly && req.method === "GET";
  const first = startFullIndex ? fullIndexFirstChoice(params) : null;
  if (first) {
    // The player sends sections=1 while it plays from prepared sections; then
    // it needs them to keep coming, and both jobs run side by side instead.
    first.playerUsesSections = url.searchParams.get("sections") === "1";
    const full = await indexedVideoCache.status(params, { start: false });
    if (full.status === "ready") {
      if (!first.readyLogged) {
        first.readyLogged = true;
        console.log(`Seek cache: whole episode seekable ${Math.round((Date.now() - first.since) / 1000)} s after the download finished`);
      }
    } else if (full.status !== "building" && Date.now() - first.since > FULL_INDEX_FIRST_GRACE_MS) {
      giveUpFullIndexFirst(first, params);
      console.log(`Seek cache: the whole-episode file didn't start (${full.status}; ${activeTranscodes.size} converters running, ${activeForegroundTranscodeCount()} for playback); preparing sections again`);
    } else if (first.playerUsesSections) {
      resumeStoppedSections(first, params);
    } else {
      // Free the converter slot the section job holds; its ready sections stay.
      if (!first.stopLogged) { first.stopLogged = true; console.log("Seek cache: download finished; making the whole episode seekable first"); }
      first.stopped = true;
      await progressiveIndexCache.stopSession(session.id);
    }
  }
  if (startFullIndex && !fullIndexFirstActive(params) && storage.limits().remuxCacheEnabled === true) {
    // SERVER-SIDE priority matters: merely ordering two async fetch() calls
    // in the browser cannot guarantee the progressive worker claims the spare
    // FFmpeg slot first. A full-episode builder can occupy that slot until
    // EOF and prevent the first early GOP from ever becoming seek-ready.
    const inputPath=localVerifiedTorrentInputPath(session,fileIndex);
    if (inputPath) {
      const progressiveParams = { ...params,
        inputPath };
      const progressive = await progressiveIndexCache.status(progressiveParams);
      if (progressive.status === "waiting" || progressive.status === "building"
        || progressive.status === "partial" && progressive.canContinue === true) {
        // The optional cache itself rechecks exact source identity, verified
        // pieces, local path and foreground slot admission before spawning.
        const admittedProgressive = startProgressiveWhenNewPieces(progressiveParams, progressive);
        // When the progressive producer has already CLAIMED one slot and no
        // foreground player uses the other slot, a full-index optimization
        // may run concurrently. Once a player appears the normal preemption
        // path cancels optional producers before admitting user playback.
        // Never let a full index race a progressive job while its first
        // verified GOP is still only `waiting` admission.
        startFullIndex = activeTranscodes.size < MAX_TRANSCODE_JOBS
          && (progressive.status === 'building'
            ? progressiveActiveProcesses.size > 0
            : !admittedProgressive);
        // A progressive attempt can fail before spawning its child (local
        // path, quota or FFprobe admission). Its same-source retry memo then
        // prevents CPU churn; it MUST NOT indefinitely block the older
        // complete-MP4 indexed optimization in this valid source/session.
      }
    }
  }
  // Never admit a third FFmpeg even if a stale index poll arrived after the
  // converter became busy. Existing ready manifests remain readable.
  if (activeTranscodes.size >= MAX_TRANSCODE_JOBS) startFullIndex = false;
  const state = await indexedVideoCache.status(params, { start: startFullIndex });
  if (statusOnly) {
    const headers = { "Cache-Control": "no-store" };
    json(res, 200, {
      status: state.status, bytes: state.bytes || 0,
      duration: state.duration || 0,
      ...(state.status === "ready" ? { url: `/api/torrents/${encodeURIComponent(session.id)}/files/${fileIndex}/indexed?audio=${audioIndex}&audioMode=${audioMode}` } : {}),
    }, headers);
    return;
  }
  if (state.status !== "ready") { json(res, 404, { error: "Indexed video is not ready", status: state.status }); return; }
  const saved = await indexedVideoCache.finished(state.info);
  if (!saved) { json(res, 404, { error: "Indexed video unavailable" }); return; }
  // Open the exact verified output BEFORE writing a 200/206 header. Storage
  // cleanup can remove a manifest/file between finished() and open(); if so,
  // return a recoverable 404 rather than a seemingly valid zero-byte video.
  let handle;
  try {
    handle = await fs.promises.open(saved.file, "r");
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== saved.bytes) throw new Error("Indexed rendition changed");
  } catch {
    await handle?.close().catch(() => {});
    if (!res.destroyed && !res.writableEnded) json(res, 404, { error: "Indexed video unavailable" });
    return;
  }
  if (res.destroyed || res.writableEnded) { await handle.close().catch(() => {}); return; }
  const range = req.method === "HEAD" ? null : parseRange(req.headers.range, saved.bytes);
  if (range === false) {
    await handle.close().catch(() => {});
    res.writeHead(416, { "Accept-Ranges": "bytes", "Content-Range": `bytes */${saved.bytes}` });
    res.end(); return;
  }
  const common = { "Content-Type": "video/mp4", "Accept-Ranges": "bytes",
    "Cache-Control": "no-store", "X-LVL-Indexed-Seek": "verified-h264-aac-v1",
    "X-Media-Duration-Seconds": String(saved.duration) };
  if (req.method === "HEAD") {
    await handle.close().catch(() => {});
    res.writeHead(200, { ...common, "Content-Length": saved.bytes }); res.end(); return;
  }
  const size = range ? range.end - range.start + 1 : saved.bytes;
  const stream = handle.createReadStream(range || undefined);
  stream.on("error", () => res.destroy());
  res.on("close", () => stream.destroy());
  trackOpenStream(session, res, fileIndex);
  res.writeHead(range ? 206 : 200, { ...common, "Content-Length": size,
    ...(range ? { "Content-Range": `bytes ${range.start}-${range.end}/${saved.bytes}` } : {}) });
  stream.pipe(res);
}

export async function serveProgressiveSeek(req, res, session, fileIndex, url, statusOnly = false) {
  const file = session.torrent?.files?.[fileIndex];
  if (!file || !VIDEO_EXTENSIONS.has(path.extname(file.name).toLowerCase())) {
    json(res, 404, { error: "Video not found" }); return;
  }
  // An optional background conversion must never read via WebTorrent HTTP:
  // that would silently fetch missing torrent pieces. Both the source's
  // complete verified bitfield and the local path are independently checked
  // again by the cache before spawning FFmpeg and before publication.
  const inputPath=localVerifiedTorrentInputPath(session,fileIndex);
  if (!inputPath) {
    json(res, 404, { error: "Video path unavailable" }); return;
  }
  const audioIndex = Number(url.searchParams.get("audio") ?? 0);
  const audioMode = String(url.searchParams.get("audioMode") || "auto");
  const media = getCachedMediaProbe(session.id, fileIndex);
  const params = { session, fileIndex, audioIndex, audioMode, media,
    inputPath };
  if (url.pathname.endsWith('/progressive/events')) {
    const status = await progressiveIndexCache.status(params);
    if (req.method !== 'GET' || !status.identityKey
      || storage.limits().remuxCacheEnabled !== true) {
      json(res, 404, {error:'Progressive events unavailable'}); return;
    }
    const key = status.identityKey;
    let clients = progressiveReadyListeners.get(key);
    if (!clients) { clients = new Set(); progressiveReadyListeners.set(key,clients); }
    if (clients.size >= 8 || progressiveReadyListeners.size > 64) {
      json(res, 429, {error:'Too many active progressive viewers'}); return;
    }
    res.writeHead(200, {'Content-Type':'text/event-stream; charset=utf-8',
      'Cache-Control':'no-store', 'Connection':'keep-alive',
      'X-Content-Type-Options':'nosniff'});
    // An authenticated paused Watch may retain this notification connection
    // without an active video Range reader. Keep its torrent UUID alive while
    // this bounded EventSource is open; close releases the normal TTL lease.
    trackOpenStream(session,res,fileIndex);
    const entry={sessionId:session.id,res};
    clients.add(entry);
    res.write(': verified-sections\n\n');
    const remove=()=>{
      clients.delete(entry);
      if (!clients.size) progressiveReadyListeners.delete(key);
    };
    req.once('aborted',remove);
    res.once('close',remove);
    return;
  }
  if (statusOnly) {
    const status = await progressiveIndexCache.status(params);
    // HEAD must remain read-only; GET explicitly opts into the bounded local
    // producer. A cache miss cannot prevent the original playback response.
    // Partial means a previous producer stopped/faulted but its individually
    // verified GOPs remain safe. Do NOT restart 58 minutes of FFmpeg on every
    // three-second status poll; an explicit later retry must be separately
    // bounded and admitted. 'building' is already single-flight.
    if (req.method === "GET")
      startProgressiveWhenNewPieces(params,status);
    const duration = Number(media?.durationSeconds) || 0;
    const generation = Number(url.searchParams.get("generation"));
    const readable = status.ranges?.length > 0 && duration > 0;
    const codecStrings = new Set((status.ranges || []).map(item => item.videoCodecString));
    const videoCodec = codecStrings.size === 1 ? [...codecStrings][0] : null;
    const mime = /^avc1\.[0-9a-f]{6}$/i.test(String(videoCodec || ""))
      ? `video/mp4; codecs="${videoCodec}, mp4a.40.2"` : "";
    json(res, 200, {
      kind: "indexed-video-segments",
      status: readable ? (status.complete ? "ready" : "partial-ready") : status.status,
      identityKey: status.identityKey || "",
      ranges: status.ranges || [],
      readyRanges: status.readyRanges || [],
      sourceKey: `torrent:${session.id}:${fileIndex}`,
      generation: Number.isSafeInteger(generation) && generation >= 0 ? generation : 0,
      audioIndex, audioMode, durationSeconds: duration,
      videoCodec: "h264", audioCodec: "aac", container: "fmp4",
      mime, sourceVerified: readable && Boolean(mime), initVerified: readable && Boolean(mime),
      // Bright readiness is based on independently committed and FFprobe-
      // verified decoded samples; no bytes-downloaded estimate participates.
      segments: (status.ranges || []).map(item => ({
        id: item.id, startSeconds: item.start, endSeconds: item.end,
        mediaStartSeconds: item.mediaStart, initHash: item.initHash,
        timelineOffsetSeconds: item.timelineOffsetSeconds ?? 0,
        bytes: item.bytes, complete: true, verified: true,
        independentlyDecodable: true, keyframeStart: true,
        movieClockVerified: true,
      })),
    }, { "Cache-Control": "no-store" });
    return;
  }
  const id = /\/progressive\/window\/([a-f0-9]{64})$/.exec(url.pathname)?.[1];
  if (!id) { json(res, 400, { error: "Invalid progressive video window" }); return; }
  const reader = await progressiveIndexCache.open(params, id);
  if (!reader) { json(res, 404, { error: "Verified video window unavailable" }); return; }
  try {
    // Cache.open() validates its pin, but a source switch or Settings OFF can
    // occur after that async validation and before the HTTP response starts.
    // Never serve an old section using a replaced session/disabled generation.
    if (req.aborted || res.destroyed || res.writableEnded) return;
    const proof = reader.sourceKind === 'isolated-cluster'
      && Array.isArray(reader.sourceRanges) && reader.sourceRanges.length === 2
      ? reader.sourceRanges.every(({start,end})=>
          verifyTorrentFileByteRange(session.torrent,fileIndex,{start,end}).verified === true)
      : Number.isSafeInteger(reader.sourceByteEnd)
        ? verifyTorrentFileByteRange(session.torrent,fileIndex,
            {start:0,end:reader.sourceByteEnd}).verified === true
        : isTorrentFileFullyVerified(session.torrent,fileIndex);
    if (torrentSessions.get(session.id) !== session
      || storage.limits().remuxCacheEnabled !== true || !proof) {
      json(res, 404, { error: "Verified video window unavailable" });
      return;
    }
    const headers = {
      "Content-Type": "video/mp4", "Content-Length": String(reader.bytes),
      "Cache-Control": "no-store", "Accept-Ranges": "none",
      "X-Content-Type-Options": "nosniff",
      "X-LVL-Progressive-Start-Seconds": String(reader.start),
      "X-LVL-Progressive-End-Seconds": String(reader.end),
      "X-LVL-Progressive-Source": session.id,
    };
    if (req.method === "HEAD") { res.writeHead(200, headers); res.end(); return; }
    trackOpenStream(session, res, fileIndex);
    const stream = reader.handle.createReadStream({ autoClose: false });
    res.once("close", () => stream.destroy());
    res.writeHead(200, headers);
    await pipeline(stream, res);
  } catch { if (!res.destroyed) res.destroy(); }
  finally { await reader.release(); }
}

export function streamTorrentFile(req, res, session, fileIndex, requestUrl = null) {
  if (session.state !== "ready") {
    json(res, 425, { error: "Torrent metadata is still resolving" });
    return;
  }
  const file = session.torrent.files[fileIndex];
  if (!file) {
    json(res, 404, { error: "Torrent file not found" });
    return;
  }
  if (!VIDEO_EXTENSIONS.has(path.extname(file.name).toLowerCase())) {
    json(res, 415, { error: "Only video files can be streamed from torrent sessions" });
    return;
  }
  if (Number(file.length) > MAX_TORRENT_VIDEO_BYTES) {
    json(res, 413, { error: `Selected video is too large (max ${Math.round(MAX_TORRENT_VIDEO_BYTES / 1024 / 1024 / 1024)} GB)` });
    return;
  }
  if (rejectOversizeVideo(res, file)) return;

  // HEAD describes the full resource, independently of any Range header.
  const range = req.method === "HEAD" ? null : parseRange(req.headers.range, file.length);
  if (range === false) {
    res.writeHead(416, { "Content-Range": `bytes */${file.length}` });
    res.end();
    return;
  }

  const type = file.type || mime[path.extname(file.name).toLowerCase()] || "application/octet-stream";
  const commonHeaders = {
    "Accept-Ranges": "bytes",
    "Content-Type": type,
    "Cache-Control": "no-store",
    "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(path.basename(file.name))}`,
  };

  if (req.method === "HEAD") {
    res.writeHead(200, { ...commonHeaders, "Content-Length": file.length });
    res.end();
    return;
  }

  // WebTorrent can throw during iterator creation. Open it before committing
  // response headers so a failed Range cannot claim a successful partial 206.
  let stream;
  try {
    stream = range ? file.createReadStream(range) : file.createReadStream();
  } catch {
    json(res, 503, { error: "Torrent reader unavailable" });
    return;
  }

  const pipeTorrentReader = () => {
    // Only server-issued, scoped opaque tags identify LVL-owned FFmpeg/FFprobe
    // readers. Anonymous browser/direct readers remain unknown. This role is
    // diagnostic data, NEVER authorization or torrent scheduling priority.
    const observedRange = range || { start: 0, end: file.length - 1 };
    const role = typeof internalReaderRoles === "undefined" ? "unknown"
      : internalReaderRoles.classify(session, fileIndex, requestUrl?.searchParams?.get("lvl_reader"));
    const healthReader = typeof streamHealth !== "undefined"
      ? streamHealth.begin(session, { fileIndex, ...observedRange, role }) : null;
    if (healthReader) {
      stream.on("data", (chunk) => healthReader.progress(chunk?.length));
      stream.once("end", () => healthReader.end("complete"));
      stream.once("error", () => healthReader.end("error"));
      stream.once("close", () => healthReader.end("cancel"));
    }
    const traceReader = typeof playbackTrace !== "undefined" && playbackTrace.enabled(session.id)
      ? playbackTrace.reader(session.id, fileIndex, observedRange) : null;
    if (traceReader) {
      stream.once("data", () => traceReader.firstByte());
      stream.once("end", () => traceReader.end("complete"));
      stream.once("error", () => traceReader.end("error"));
      stream.once("close", () => traceReader.end("cancel"));
    }
    trackOpenStream(session, res, fileIndex);
    // A browser changing src closes the response, but an already-complete GET
    // request need not emit 'aborted'. Tear down its WebTorrent piece reader so
    // old paused/seeked positions stop competing with the new stream.
    const stop = () => {
      // The HTTP response may close before WebTorrent's Readable emits its
      // own close/end (notably a slow swarm after the requested Range ends).
      // Release observational state when this actual request closes; keep the
      // destroy call that cancels the WebTorrent piece iterator.
      healthReader?.end(res.writableFinished ? "complete" : "cancel");
      traceReader?.end(res.writableFinished ? "complete" : "cancel");
      stream.destroy();
      detach();
    };
    const detach = () => {
      req.off("aborted", stop);
      res.off("close", stop);
    };
    req.once("aborted", stop);
    res.once("close", stop);
    stream.once("end", detach);
    stream.once("close", detach);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  };

  if (range) {
    res.writeHead(206, {
      ...commonHeaders,
      "Content-Length": range.end - range.start + 1,
      "Content-Range": `bytes ${range.start}-${range.end}/${file.length}`,
    });
    res.flushHeaders?.();
    pipeTorrentReader();
    return;
  }

  res.writeHead(200, { ...commonHeaders, "Content-Length": file.length });
  res.flushHeaders?.();
  pipeTorrentReader();
}

// Preflight for a copy-video fMP4 stream: FFmpeg seeks to a preceding video
// keyframe, not to the requested timestamp. Only verified *decoded* timestamps
// may be used as the absolute movie clock by the client. Never guess on errors.
export async function copiedSeekOrigin(session, fileIndex, startSeconds, signal) {
  if (session.state !== "ready") throw Object.assign(new Error("Torrent metadata is not ready"), { statusCode: 425 });
  const file = session.torrent?.files?.[fileIndex];
  if (!file) throw Object.assign(new Error("Torrent file not found"), { statusCode: 404 });
  if (!VIDEO_EXTENSIONS.has(path.extname(file.name).toLowerCase()))
    throw Object.assign(new Error("Only supported video files can be copied"), { statusCode: 415 });
  if (Number(file.length) > MAX_TORRENT_VIDEO_BYTES)
    throw Object.assign(new Error("Torrent video exceeds size limit"), { statusCode: 413 });
  if (!Number.isFinite(startSeconds) || startSeconds < 0 || startSeconds > 24 * 60 * 60)
    throw Object.assign(new Error("Invalid seek start time"), { statusCode: 400 });
  const knownDuration = Number(getCachedMediaProbe(session.id, fileIndex)?.durationSeconds) || 0;
  if (knownDuration && startSeconds > Math.max(0, knownDuration - 0.25))
    throw Object.assign(new Error("Seek is beyond playable video duration"), { statusCode: 422 });
  if (signal?.aborted) throw Object.assign(new Error("Seek origin request cancelled"), { statusCode: 499 });
  if (startSeconds === 0) return { requestedStartSeconds: 0, effectiveStartSeconds: 0, prerollSeconds: 0, verified: true };
  const key = `${session.id}:${fileIndex}:${startSeconds}`;
  const cached = copiedSeekOriginCache.get(key);
  if (cached && cached.session === session && cached.expiresAt > Date.now()) return cached.result;
  const shared = copiedSeekOriginInflight.get(key);
  if (shared) {
    if (shared.session !== session || shared.controller.signal.aborted || shared.finished)
      throw Object.assign(new Error("Copied-video source changed during lookup"), { statusCode: 410 });
    return subscribeCopiedSeekOrigin(shared, signal);
  }
  if (activeCopiedSeekProbes >= MAX_COPIED_SEEK_PROBES)
    throw Object.assign(new Error("Copied-video seek probe is busy"), { statusCode: 429 });
  const flight = { key, session, controller: new AbortController(), subscribers: new Set(), finished: false };
  activeCopiedSeekProbes += 1;
  copiedSeekOriginInflight.set(key, flight);
  const subscribed = subscribeCopiedSeekOrigin(flight, signal);
  // The task catches all errors and settles each subscriber itself. No detached
  // rejected promise can escape into an unhandled-rejection event.
  void (async () => {
    let result;
    let failure;
    const tagged = typeof internalTorrentSource === "function"
      ? internalTorrentSource(session, fileIndex, "probe") : null;
    const source = tagged?.url || `http://127.0.0.1:${port}/api/torrents/${encodeURIComponent(session.id)}/files/${fileIndex}/stream`;
    try {
      if (flight.controller.signal.aborted) throw Object.assign(new Error("Seek origin request cancelled"), { statusCode: 499 });
      result = await probeCopiedSeekOrigin({ source, requestedStartSeconds: startSeconds,
        executable: ffprobePath, signal: flight.controller.signal });
      // An abandoned probe can complete despite cancellation. Its result must
      // never enter the cache or overwrite a subsequent fresh probe's result.
      if (flight.controller.signal.aborted)
        throw Object.assign(new Error("Seek origin request cancelled"), { statusCode: 499 });
      if (torrentSessions.get(session.id) !== session || session.state !== "ready")
        throw Object.assign(new Error("Copied-video source changed during lookup"), { statusCode: 410 });
      if (flight.subscribers.size) {
        for (const [itemKey, item] of copiedSeekOriginCache) if (item.expiresAt <= Date.now()) copiedSeekOriginCache.delete(itemKey);
        if (copiedSeekOriginCache.size >= MAX_COPIED_SEEK_CACHE_ENTRIES) copiedSeekOriginCache.delete(copiedSeekOriginCache.keys().next().value);
        copiedSeekOriginCache.set(key, { result, session, expiresAt: Date.now() + COPIED_SEEK_CACHE_TTL_MS });
      }
    } catch (error) {
      failure = error;
    } finally {
      tagged?.release();
      flight.finished = true;
      if (copiedSeekOriginInflight.get(key) === flight) copiedSeekOriginInflight.delete(key);
      activeCopiedSeekProbes -= 1;
      for (const subscriber of flight.subscribers) {
        subscriber.signal?.removeEventListener("abort", subscriber.cancel);
        if (failure) subscriber.reject(failure);
        else subscriber.resolve(result);
      }
      flight.subscribers.clear();
    }
  })();
  return subscribed;
}

// Each client has its own AbortSignal, while all clients seeking the same source
// frame share a single FFprobe. Cancelling one consumer must not cancel another.
function subscribeCopiedSeekOrigin(flight, signal) {
  if (signal?.aborted) return Promise.reject(Object.assign(new Error("Seek origin request cancelled"), { statusCode: 499 }));
  if (flight.subscribers.size >= MAX_COPIED_SEEK_SUBSCRIBERS)
    return Promise.reject(Object.assign(new Error("Too many callers are awaiting this copied-video seek"), { statusCode: 429 }));
  return new Promise((resolve, reject) => {
    const subscriber = { resolve, reject, signal, cancel: null };
    const cancel = () => {
      if (!flight.subscribers.delete(subscriber)) return;
      signal?.removeEventListener("abort", cancel);
      reject(Object.assign(new Error("Seek origin request cancelled"), { statusCode: 499 }));
      if (!flight.subscribers.size && !flight.finished) {
        // Remove abandoned work from the coalescing map immediately. The job
        // slot remains occupied until the underlying FFprobe promise settles.
        if (copiedSeekOriginInflight.get(flight.key) === flight) copiedSeekOriginInflight.delete(flight.key);
        flight.controller.abort();
      }
    };
    subscriber.cancel = cancel;
    flight.subscribers.add(subscriber);
    signal?.addEventListener("abort", cancel, { once: true });
    // An abort can race adding the listener after the first check.
    if (signal?.aborted) cancel();
  });
}

export async function copiedSeekOriginEndpoint(req, res, session, fileIndex, url) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  if (localRequestRejected(req, res)) return;
  // Read-only nevertheless expensive: third-party pages must not be able to
  // trigger FFprobe/torrent-piece work using cross-site image/fetch requests.
  const requestSite = String(req.headers["sec-fetch-site"] || "").toLowerCase();
  const origin = String(req.headers.origin || "").toLowerCase();
  const host = String(req.headers.host || "").toLowerCase();
  if ((requestSite && requestSite !== "same-origin" && requestSite !== "none")
    || (origin && origin !== `http://${host}`)) {
    json(res, 403, { error: "Copied-video seek probes are available only to the local player" });
    return;
  }
  if (url.searchParams.get("video") !== "copy" || !/^\d{1,6}(?:\.\d{1,6})?$/.test(url.searchParams.get("start") || "")) {
    json(res, 400, { error: "video=copy and a finite, nonnegative start are required" });
    return;
  }
  const start = Number(url.searchParams.get("start"));
  const controller = new AbortController();
  const cancel = () => controller.abort();
  req.once("aborted", cancel);
  res.once("close", cancel);
  try {
    const result = await copiedSeekOrigin(session, fileIndex, start, controller.signal);
    if (!controller.signal.aborted && !res.destroyed && !res.writableEnded) json(res, 200, result);
  } catch (error) {
    if (!controller.signal.aborted && !res.destroyed && !res.writableEnded)
      json(res, error?.statusCode && error.statusCode !== 499 ? error.statusCode : 422,
        { error: String(error?.message || "Could not verify copied-video seek origin").slice(0, 300) });
  } finally {
    req.off("aborted", cancel);
    res.off("close", cancel);
  }
}

export async function serveRemuxWarmWindow(req,res,session,fileIndex,requestUrl){
  if(req.method!=="GET")return methodNotAllowed(res,["GET"]);
  if(!session.torrent?.files?.[fileIndex]){
    json(res,404,{error:"Torrent video unavailable"});return;
  }
  const producerToken=requestUrl.searchParams.get("producer")||"";
  const start=requestUrl.searchParams.get("start")||"";
  if(!/^[a-f0-9]{48}$/.test(producerToken)||!/^(?:0|[1-9]\d{0,5})(?:\.\d{1,3})?$/.test(start)){
    json(res,400,{error:"Invalid cached window request"});return;
  }
  const window=await remuxSegmentCache.lookupWarmWindow({
    sessionId:session.id,fileIndex,sourceIdentity:session.infoHash,
    producerToken,startSeconds:Number(start),maxWindowBytes:16*1024*1024,
  });
  if(!window){json(res,404,{error:"Warm remux window unavailable"});return;}
  async function* segments(){
    for(const range of window.ranges){
      for(let offset=range.start;offset<=range.end;){
        const buffer=Buffer.allocUnsafe(Math.min(64*1024,range.end-offset+1));
        const {bytesRead}=await window.handle.read(buffer,0,buffer.length,offset);
        if(bytesRead<=0)throw Error('Warm remux window was truncated');
        offset+=bytesRead;
        yield buffer.subarray(0,bytesRead);
      }
    }
  }
  try{
    if(res.destroyed||res.writableEnded)return;
    res.writeHead(200,{
      "Content-Type":"video/mp4","Content-Length":String(window.bytes),
      "Cache-Control":"no-store","Accept-Ranges":"none",
      "X-Content-Type-Options":"nosniff",
      "X-LVL-Window-Base-Seconds":String(window.baseSeconds),
      "X-LVL-Window-Start-Seconds":String(window.windowStartSeconds),
      "X-LVL-Window-End-Seconds":String(window.windowEndSeconds),
      "X-LVL-Window-Producer":window.producerToken,
      "X-LVL-Window-Source-Generation":window.sourceGeneration,
    });
    trackOpenStream(session,res,fileIndex);
    await pipeline(Readable.from(segments()),res);
  }catch{
    if(!res.destroyed)res.destroy();
  }finally{
    await window.release();
  }
}
