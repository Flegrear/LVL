// What a torrent's video file holds (ffprobe), with a cache.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { inspectMediaCompatibility } from "../../shared/media/media-compat.js";
import { dolbyVisionFromProbe } from "../../shared/media/video-profile.js";
import { normalizeEmbeddedChapterMarkers } from "../../shared/media/embedded-chapter-markers.js";
import { isTorrentFileFullyVerified } from "./verified-torrent-file.js";
import { ffprobePath, MAX_TORRENT_VIDEO_BYTES, mediaProbeCache, port, torrentRoot, torrentSessions, VIDEO_EXTENSIONS } from "../../server.js";
import { internalTorrentSource } from "../torrents/torrent-sessions.js";
import { mediaAdmissionsClosed, registerMediaShutdownChild } from "./media-shutdown.js";

const MAX_PROBE_JOBS = 2;
const MAX_PROBE_CACHE_ENTRIES = 32;
const MEDIA_PROBE_TIMEOUT_MS = 20 * 1000;
const MEDIA_PROBE_CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_PROBE_OUTPUT_BYTES = 256 * 1024;
const KEEP_DOWNLOADS = process.platform === "android";
const MAX_SAVED_PROBE_BYTES = 256 * 1024;
const probeChapterScan = new WeakMap();
// Legacy v1/v2 metadata may be useful temporarily, but only a fresh FFprobe
// can establish a canonical container stream index for the current source.
const legacySavedProbeValues = new WeakSet();

let activeProbeJobs = 0;
// A timed-out request may settle before Windows reports the child's actual
// close. Such a child still owns a process slot and a shutdown obligation.
const activeProbeChildren = new Set();

function probeCacheKey(sessionId, fileIndex) {
  return `${sessionId}:${fileIndex}`;
}

function savedProbeFile(session, fileIndex) {
  if (!/^[A-Za-z0-9-]{1,64}$/.test(String(session?.id ?? ""))
      || !Number.isSafeInteger(fileIndex) || fileIndex < 0 || fileIndex > 100_000)
    return null;
  return path.join(torrentRoot, session.id, `lvl-probe-${fileIndex}.json`);
}

function readSavedMediaProbe(session, fileIndex, file, includeChapters) {
  if (!KEEP_DOWNLOADS || !session?.id || !/^[0-9a-f]{40}$/.test(session.infoHash || "")) return null;
  try {
    const filename = savedProbeFile(session, fileIndex);
    if (!filename) return null;
    const bytes = fs.statSync(filename).size;
    if (!(bytes > 0 && bytes <= MAX_SAVED_PROBE_BYTES)) return null;
    const saved = JSON.parse(fs.readFileSync(filename, "utf8"));
    if (![1, 2, 3].includes(saved?.version) || saved.name !== file.name
      || saved.length !== Number(file.length) || saved.includeChapters !== includeChapters
      || !Number.isFinite(saved.value?.durationSeconds) || saved.value.durationSeconds <= 0) return null;
    if (saved.version >= 2) {
      if (saved.infoHash !== session.infoHash || saved.path !== file.path
        || saved.downloadedBytes !== Number(file.downloaded)) return null;
    } else if (file.done !== true || Number(file.downloaded) !== Number(file.length)) {
      // Old persisted probes had no piece-progress stamp; reuse only for a
      // completed file, where the source can no longer gain missing pieces.
      return null;
    }
    if (saved.version === 3) return saved.value;
    // A pre-fix cache has no raw FFprobe index proof: the older Number()
    // conversion could fabricate zero or duplicate a different stream.
    // Keep duration/codec metadata without elevating legacy IDs to authority.
    const value = saved.value;
    const unknownIdentity = {
      ...value,
      ...(Array.isArray(value.audioTracks) ? { audioTracks: value.audioTracks.map(
        (track) => ({ ...track, streamIndex: null })) } : {}),
      ...(Array.isArray(value.subtitleTracks) ? { subtitleTracks: value.subtitleTracks.map(
        (track) => ({ ...track, streamIndex: null })) } : {}),
    };
    legacySavedProbeValues.add(unknownIdentity);
    return unknownIdentity;
  } catch { return null; }
}

function saveMediaProbe(session, fileIndex, file, includeChapters, value) {
  if (!KEEP_DOWNLOADS || !session?.id || !value || !/^[0-9a-f]{40}$/.test(session.infoHash || "")) return;
  const filename = savedProbeFile(session, fileIndex);
  if (!filename) return;
  try {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    const payload = JSON.stringify({
      version: 3, infoHash: session.infoHash, path: file.path, name: file.name,
      length: Number(file.length), downloadedBytes: Number(file.downloaded), includeChapters, value,
    });
    if (Buffer.byteLength(payload) > MAX_SAVED_PROBE_BYTES) return;
    const temporary = `${filename}.tmp`;
    fs.writeFileSync(temporary, payload);
    fs.renameSync(temporary, filename);
  } catch (error) {
    console.warn(`Could not save media details for ${session.id}:`, error.message);
  }
}

function pruneMediaProbeCache() {
  const now = Date.now();
  for (const [key, entry] of mediaProbeCache) {
    if (!entry.promise && entry.expiresAt <= now) mediaProbeCache.delete(key);
  }
  if (mediaProbeCache.size < MAX_PROBE_CACHE_ENTRIES) return;

  const evictable = [...mediaProbeCache.entries()]
    .filter(([, entry]) => !entry.promise)
    .sort((a, b) => a[1].lastAccess - b[1].lastAccess);
  while (mediaProbeCache.size >= MAX_PROBE_CACHE_ENTRIES && evictable.length) {
    mediaProbeCache.delete(evictable.shift()[0]);
  }
}

export function getCachedMediaProbe(sessionId, fileIndex) {
  const key = probeCacheKey(sessionId, fileIndex);
  const entry = mediaProbeCache.get(key);
  if (!entry || entry.promise) return null;
  // A stable download ID may be recreated with another torrent/session
  // incarnation. Old completed metadata belongs to its original object.
  if (!entry.session || torrentSessions.get(sessionId) !== entry.session) {
    mediaProbeCache.delete(key);
    return null;
  }
  if (entry.expiresAt <= Date.now()) {
    mediaProbeCache.delete(key);
    return null;
  }
  if (entry.legacyFallback) {
    // A failed migration remains unknown until a bounded retry. Never return
    // fallback metadata across a changed torrent, file or download generation.
    const stamp = entry.legacySource;
    const torrent = entry.session.torrent;
    const file = torrent?.files?.[fileIndex];
    if (!stamp || entry.session.state !== "ready" || torrent !== stamp.torrent
        || torrent?.destroyed || file !== stamp.file
        || entry.session.infoHash !== stamp.infoHash
        || file?.name !== stamp.name || file?.path !== stamp.path
        || Number(file?.length) !== stamp.length
        || Number(file?.downloaded) !== stamp.downloaded
        || mediaAdmissionsClosed()
        || isTorrentFileFullyVerified(torrent, fileIndex) !== entry.verifiedAtProbe) {
      mediaProbeCache.delete(key);
      return null;
    }
    if (entry.legacyRetryAfter <= Date.now()) {
      mediaProbeCache.delete(key);
      return null;
    }
    entry.lastAccess = Date.now();
    return entry.value;
  }
  // A partial-file probe does not contain the chapters that become available
  // once WebTorrent verifies the complete file. Refresh on that transition.
  if (entry.verifiedAtProbe === false) {
    const session = torrentSessions.get(sessionId);
    if (session && isTorrentFileFullyVerified(session.torrent, fileIndex)) {
      mediaProbeCache.delete(key);
      return null;
    }
  }
  if (entry.chaptersScanned === false && entry.chapterRetryAfter <= Date.now()
      && isTorrentFileFullyVerified(entry.session.torrent, fileIndex)) {
    mediaProbeCache.delete(key);
    return null;
  }
  entry.lastAccess = Date.now();
  return entry.value;
}

function parseFrameRate(value) {
  if (typeof value !== "string" || !value) return null;
  const [numerator, denominator = "1"] = value.split("/");
  const rate = Number(numerator) / Number(denominator);
  return Number.isFinite(rate) && rate > 0 ? Math.round(rate * 1000) / 1000 : null;
}

// FFprobe stream.index is a container UID, never a track ordinal. Reject
// coercible/missing values; a literal numeric 0 remains valid only when unique.
function canonicalFfprobeStreamIndex(raw) {
  if (typeof raw === "number") return Number.isSafeInteger(raw) && raw >= 0
    && !Object.is(raw, -0) ? raw : null;
  if (typeof raw !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(raw)) return null;
  const index = Number(raw);
  return Number.isSafeInteger(index) ? index : null;
}

function uniqueFfprobeStreamIndex(stream, counts) {
  const index = canonicalFfprobeStreamIndex(stream?.index);
  return index !== null && counts.get(index) === 1 ? index : null;
}

function runFfprobe(sourceUrl, file, { includeChapters = false } = {}) {
  if (!ffprobePath) {
    const error = new Error("Bundled FFprobe binary is unavailable");
    error.statusCode = 503;
    return Promise.reject(error);
  }

  const args = [
    "-v", "error",
    "-rw_timeout", "18000000",
    // The torrent stream endpoint supports byte ranges. Let FFprobe seek so
    // MP4/MOV files with metadata near the end can expose their real duration
    // without reading the movie sequentially from byte zero.
    "-seekable", "1",
    "-probesize", "2097152",
    "-analyzeduration", "3000000",
    // Chapter enumeration is OPTIONAL and may seek into the missing tail of
    // an unfinished MKV. Never make cold-swarm *playback metadata* depend on
    // this optional chapter lookup; inspect chapters only for hash-verified files.
    ...(includeChapters ? ["-show_chapters"] : []),
    "-show_entries", "format=duration,format_name,bit_rate:stream=index,codec_type,codec_name,profile,pix_fmt,bits_per_raw_sample,width,height,avg_frame_rate,r_frame_rate,duration,channels,channel_layout,sample_rate,bit_rate,color_range,color_space,color_transfer,color_primaries:stream_disposition=default,forced:stream_side_data_list=side_data_type,dv_profile,dv_bl_signal_compatibility_id:stream_tags=language,title"
      + (includeChapters ? ":chapter=start_time,end_time:chapter_tags=title" : ""),
    "-of", "json",
    sourceUrl,
  ];

  return new Promise((resolve, reject) => {
    if (mediaAdmissionsClosed() || activeProbeChildren.size >= MAX_PROBE_JOBS) {
      const error = new Error(mediaAdmissionsClosed()
        ? "Media server is shutting down" : "Too many media probe children are still draining");
      error.statusCode = mediaAdmissionsClosed() ? 503 : 429;
      reject(error);
      return;
    }
    const probe = spawn(ffprobePath, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (!registerMediaShutdownChild(probe)) {
      const error = new Error("Media server is shutting down");
      error.statusCode = 503;
      reject(error);
      return;
    }
    activeProbeChildren.add(probe);
    let escalationTimer = null;
    let exitedDrainTimer = null;
    let exitObserved = false;
    let closeObserved = false;
    let stopRequested = false;
    const pipes = [probe.stdout, probe.stderr].filter(Boolean);
    const exited = () => exitObserved || probe.exitCode != null || probe.signalCode != null;
    const drainExited = () => {
      if (closeObserved || exitedDrainTimer) return;
      exitedDrainTimer = setTimeout(() => {
        // An exited FFprobe cannot write further metadata. Destroy only its
        // own undrained pipes; never signal a PID that may already be reused.
        for (const pipe of pipes) {
          if (!pipe.readableEnded && !pipe.destroyed) try { pipe.destroy?.(); } catch {}
        }
        const error = new Error("FFprobe exited without draining metadata pipes");
        error.statusCode = 502;
        finish(error);
      }, 2000);
      exitedDrainTimer.unref?.();
    };
    const stopProbe = () => {
      if (stopRequested || closeObserved) return;
      stopRequested = true;
      if (!Number.isSafeInteger(probe.pid) || probe.pid <= 0) {
        // A failed spawn owns no OS process and may never emit close.
        for (const pipe of pipes) try { pipe.destroy?.(); } catch {}
        activeProbeChildren.delete(probe);
        return;
      }
      for (const pipe of pipes) try { pipe.resume?.(); } catch {}
      if (!exited()) try { probe.kill("SIGTERM"); } catch {}
      else drainExited();
      escalationTimer = setTimeout(() => {
        if (!exited()) {
          // ChildProcess.kill() setting .killed does NOT prove the OS child
          // terminated. Escalate on the exact retained child object.
          try { probe.kill("SIGKILL"); } catch {}
        } else drainExited();
      }, 2000);
      escalationTimer.unref?.();
    };
    probe.once("exit", () => {
      exitObserved = true;
      drainExited();
    });
    probe.once("close", () => {
      closeObserved = true;
      clearTimeout(escalationTimer);
      clearTimeout(exitedDrainTimer);
      activeProbeChildren.delete(probe);
    });
    probe.once("error", () => {
      if (!Number.isSafeInteger(probe.pid) || probe.pid <= 0) {
        clearTimeout(escalationTimer);
        clearTimeout(exitedDrainTimer);
        activeProbeChildren.delete(probe);
      } else stopProbe();
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };

    const timer = setTimeout(() => {
      stopProbe();
      const error = new Error("Timed out probing media metadata");
      error.statusCode = 504;
      finish(error);
    }, MEDIA_PROBE_TIMEOUT_MS);
    timer.unref?.();

    probe.stdout.on("data", (chunk) => {
      if (settled) return;
      outputBytes += chunk.length;
      if (outputBytes > MAX_PROBE_OUTPUT_BYTES) {
        stopProbe();
        const error = new Error("Media probe returned too much metadata");
        error.statusCode = 502;
        finish(error);
        return;
      }
      stdout += chunk.toString("utf8");
    });
    probe.stderr.on("data", (chunk) => {
      if (settled) return;
      if (stderr.length < 16 * 1024) stderr += chunk.toString("utf8");
    });
    probe.once("error", (error) => {
      stopProbe();
      finish(Object.assign(error, { statusCode: 500 }));
    });
    probe.once("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        const error = new Error(stderr.trim().slice(-1200) || `FFprobe exited with code ${code}`);
        error.statusCode = 502;
        finish(error);
        return;
      }

      let payload;
      try {
        payload = JSON.parse(stdout);
      } catch {
        const error = new Error("FFprobe returned invalid metadata");
        error.statusCode = 502;
        finish(error);
        return;
      }

      const streams = Array.isArray(payload.streams) ? payload.streams : [];
      // Count across the entire container: an audio/subtitle index duplicated by
      // any video, audio, subtitle or other stream cannot identify one track.
      const streamIndexCounts = new Map();
      for (const stream of streams) {
        const index = canonicalFfprobeStreamIndex(stream?.index);
        if (index !== null)
          streamIndexCounts.set(index, (streamIndexCounts.get(index) || 0) + 1);
      }
      const video = streams.find((stream) => stream.codec_type === "video") || null;
      const audioStreams = streams.filter((stream) => stream.codec_type === "audio");
      const subtitleStreams = streams.filter((stream) => stream.codec_type === "subtitle");
      const audio = audioStreams[0] || null;
      const durationCandidates = [payload.format?.duration, ...streams.map((stream) => stream.duration)]
        .map(Number)
        .filter((value) => Number.isFinite(value) && value > 0);
      const duration = durationCandidates.length ? Math.max(...durationCandidates) : NaN;
      if (!Number.isFinite(duration) || duration <= 0) {
        const error = new Error("Media duration is unavailable from the torrent file");
        error.statusCode = 422;
        finish(error);
        return;
      }

      const durationSeconds = Math.round(duration * 1000) / 1000;
      const media = {
        durationSeconds,
        durationMs: Math.round(duration * 1000),
        // Only strict, unambiguous OP/ED chapters from this exact probed file.
        // Never expose arbitrary embedded titles or guess missing cut markers.
        embeddedSkipMarkers: normalizeEmbeddedChapterMarkers(payload.chapters, durationSeconds),
        format: payload.format?.format_name || path.extname(file.name).slice(1).toLowerCase() || null,
        bitRate: Number.isFinite(Number(payload.format?.bit_rate)) ? Number(payload.format.bit_rate) : null,
        video: video ? {
          codec: video.codec_name || null,
          profile: video.profile || null,
          pixelFormat: video.pix_fmt || null,
          bitsPerRawSample: Number.isFinite(Number(video.bits_per_raw_sample)) && Number(video.bits_per_raw_sample) > 0 ? Number(video.bits_per_raw_sample) : null,
          width: Number.isFinite(Number(video.width)) ? Number(video.width) : null,
          height: Number.isFinite(Number(video.height)) ? Number(video.height) : null,
          frameRate: parseFrameRate(video.avg_frame_rate || video.r_frame_rate),
          colorRange: video.color_range || null,
          colorSpace: video.color_space || null,
          colorTransfer: video.color_transfer || null,
          colorPrimaries: video.color_primaries || null,
          dolbyVision: dolbyVisionFromProbe(video),
        } : null,
        audio: audio ? {
          codec: audio.codec_name || null,
          profile: audio.profile || null,
          channels: Number.isFinite(Number(audio.channels)) ? Number(audio.channels) : null,
          channelLayout: audio.channel_layout || null,
          sampleRate: Number.isFinite(Number(audio.sample_rate)) ? Number(audio.sample_rate) : null,
          bitRate: Number.isFinite(Number(audio.bit_rate)) ? Number(audio.bit_rate) : null,
          language: audio.tags?.language || null,
          title: audio.tags?.title || null,
        } : null,
        audioTracks: audioStreams.map((stream, order) => ({
          order,
          streamIndex: uniqueFfprobeStreamIndex(stream, streamIndexCounts),
          codec: stream.codec_name || null,
          profile: stream.profile || null,
          channels: Number.isFinite(Number(stream.channels)) ? Number(stream.channels) : null,
          channelLayout: stream.channel_layout || null,
          sampleRate: Number.isFinite(Number(stream.sample_rate)) ? Number(stream.sample_rate) : null,
          bitRate: Number.isFinite(Number(stream.bit_rate)) ? Number(stream.bit_rate) : null,
          language: stream.tags?.language || null,
          title: stream.tags?.title || null,
        })),
        subtitleTracks: subtitleStreams.map((stream, order) => {
          const codec = String(stream.codec_name || "").toLowerCase();
          return {
            order,
            streamIndex: uniqueFfprobeStreamIndex(stream, streamIndexCounts),
            codec: codec || null,
            language: stream.tags?.language || null,
            title: stream.tags?.title || null,
            // Preserve FFprobe's track intent. Forced-only captions usually
            // cover signs or foreign speech, not the entire dialogue track.
            disposition: {
              default: Number(stream.disposition?.default) === 1 ? 1 : 0,
              forced: Number(stream.disposition?.forced) === 1 ? 1 : 0,
            },
            textBased: ["subrip", "srt", "ass", "ssa", "webvtt", "mov_text", "text"].includes(codec),
          };
        }),
      };
      media.compatibility = inspectMediaCompatibility(media, { fileName: file.name });
      finish(null, media);
    });
  });
}

async function runFfprobeWithRetry(sourceUrl, file, { includeChapters = false } = {}) {
  try {
    const value = await runFfprobe(sourceUrl, file, { includeChapters });
    probeChapterScan.set(value, includeChapters);
    return value;
  } catch (error) {
    if (error.statusCode !== 502 && error.statusCode !== 504) throw error;
    await new Promise((resolve) => setTimeout(resolve, 250));
    // A failed optional chapter scan must not be repeated during startup.
    const value = await runFfprobe(sourceUrl, file, { includeChapters: false });
    probeChapterScan.set(value, false);
    return value;
  }
}

export async function probeTorrentFile(session, fileIndex) {
  if (mediaAdmissionsClosed()) {
    const error = new Error("Media server is shutting down");
    error.statusCode = 503;
    throw error;
  }
  if (session.state !== "ready") {
    const error = new Error("Torrent metadata is still resolving");
    error.statusCode = 425;
    throw error;
  }
  const file = session.torrent.files[fileIndex];
  if (!file) {
    const error = new Error("Torrent file not found");
    error.statusCode = 404;
    throw error;
  }
  if (!VIDEO_EXTENSIONS.has(path.extname(file.name).toLowerCase())) {
    const error = new Error("Selected torrent file is not a supported video file");
    error.statusCode = 415;
    throw error;
  }
  if (Number(file.length) > MAX_TORRENT_VIDEO_BYTES) {
    const error = new Error(`Selected video is too large (max ${Math.round(MAX_TORRENT_VIDEO_BYTES / 1024 / 1024 / 1024)} GB)`);
    error.statusCode = 413;
    throw error;
  }

  const key = probeCacheKey(session.id, fileIndex);
  const cached = getCachedMediaProbe(session.id, fileIndex);
  if (cached) return cached;
  const previous = mediaProbeCache.get(key);
  if (previous && previous.session !== session) mediaProbeCache.delete(key);
  const pending = mediaProbeCache.get(key)?.promise;
  if (pending) return pending;

  const verified = isTorrentFileFullyVerified(session.torrent, fileIndex);
  const saved = readSavedMediaProbe(session, fileIndex, file, verified);
  const legacySaved = saved !== null && legacySavedProbeValues.has(saved);
  if (saved && !legacySaved) {
    // A valid saved v3 record needs no native probe. Never exceed the bounded
    // metadata cache when all existing entries are still in-flight borrowers.
    pruneMediaProbeCache();
    if (mediaProbeCache.size < MAX_PROBE_CACHE_ENTRIES) {
      mediaProbeCache.set(key, {
        value: saved, promise: null, session,
        verifiedAtProbe: verified,
        chaptersScanned: verified,
        expiresAt: Date.now() + MEDIA_PROBE_CACHE_TTL_MS,
        lastAccess: Date.now(),
      });
    }
    return saved;
  }

  // Legacy identity upgrades are bound to the exact current source and byte
  // generation. No old probe result may be published into a reopened session.
  const legacySource = legacySaved ? {
    torrent: session.torrent, file, infoHash: session.infoHash,
    name: file.name, path: file.path, length: Number(file.length),
    downloaded: Number(file.downloaded),
  } : null;
  const sameLegacySource = () => !legacySaved || (
    session.state === "ready" && !mediaAdmissionsClosed()
    && torrentSessions.get(session.id) === session
    && session.torrent === legacySource.torrent && !session.torrent.destroyed
    && session.torrent.files[fileIndex] === legacySource.file
    && session.infoHash === legacySource.infoHash
    && file.name === legacySource.name && file.path === legacySource.path
    && Number(file.length) === legacySource.length
    && Number(file.downloaded) === legacySource.downloaded
    && isTorrentFileFullyVerified(session.torrent, fileIndex) === verified);
  const retainUnknownLegacy = (delayMs) => {
    if (!legacySaved || !sameLegacySource()) return null;
    const now = Date.now();
    mediaProbeCache.set(key, {
      value: saved, promise: null, session, legacyFallback: true, legacySource,
      legacyRetryAfter: now + delayMs,
      verifiedAtProbe: verified, chaptersScanned: verified,
      expiresAt: now + MEDIA_PROBE_CACHE_TTL_MS, lastAccess: now,
    });
    return saved;
  };

  pruneMediaProbeCache();
  if (mediaProbeCache.size >= MAX_PROBE_CACHE_ENTRIES) {
    // Optional metadata cannot exceed the existing process/cache admission cap.
    if (legacySaved && sameLegacySource()) return saved;
    const error = new Error("Media probe cache is busy");
    error.statusCode = 429;
    throw error;
  }
  if (activeProbeJobs >= MAX_PROBE_JOBS || activeProbeChildren.size >= MAX_PROBE_JOBS) {
    if (legacySaved && sameLegacySource()) return retainUnknownLegacy(30_000);
    const error = new Error("Too many media files are being probed right now");
    error.statusCode = 429;
    throw error;
  }
  const tagged = typeof internalTorrentSource === "function"
    ? internalTorrentSource(session, fileIndex, "probe") : null;
  const sourceUrl = tagged?.url || `http://127.0.0.1:${port}/api/torrents/${encodeURIComponent(session.id)}/files/${fileIndex}/stream`;
  activeProbeJobs += 1;
  // Hash-verified completion is the only safe admission for the optional
  // chapter scan; the ordinary codec probe remains the original short path.
  const includeChapters = verified;
  const downloadedAtProbeStart = Number(file.downloaded);
  const promise = runFfprobeWithRetry(sourceUrl, file, { includeChapters })
    .then((value) => {
      if (legacySaved && (!sameLegacySource()
          || mediaProbeCache.get(key)?.promise !== promise)) {
        const error = new Error("Torrent source changed during legacy stream identity upgrade");
        error.statusCode = 409;
        throw error;
      }
      // A retained session id can be reopened while an older FFprobe is still
      // exiting. Only the current session may publish into that shared key.
      if (torrentSessions.get(session.id) === session && !session.torrent.destroyed
        && mediaProbeCache.get(key)?.promise === promise) {
        mediaProbeCache.set(key, {
          value,
          promise: null, session,
          verifiedAtProbe: verified,
          chaptersScanned: !verified || probeChapterScan.get(value) === true,
          chapterRetryAfter: Date.now() + 5 * 60_000,
          expiresAt: Date.now() + MEDIA_PROBE_CACHE_TTL_MS,
          lastAccess: Date.now(),
        });
        // A moving download can expose new metadata after probing begins.
        if (Number(file.downloaded) === downloadedAtProbeStart) {
          saveMediaProbe(session, fileIndex, file, probeChapterScan.get(value) === true, value);
        }
      }
      return value;
    })
    .catch((error) => {
      const ownsPending = mediaProbeCache.get(key)?.promise === promise;
      if (ownsPending) mediaProbeCache.delete(key);
      // Failed fresh source proof never promotes guessed legacy indices.
      // The same-source fallback is temporary and retryable after backoff.
      if (legacySaved && ownsPending && sameLegacySource())
        return retainUnknownLegacy(60_000);
      throw error;
    })
    .finally(() => {
      tagged?.release();
      activeProbeJobs -= 1;
    });
  mediaProbeCache.set(key, {
    value: null, session,
    promise,
    expiresAt: Date.now() + MEDIA_PROBE_CACHE_TTL_MS,
    lastAccess: Date.now(),
  });
  return promise;
}
