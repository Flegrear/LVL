// What a torrent's video file holds (ffprobe), with a cache.
import path from "node:path";
import { spawn } from "node:child_process";
import { inspectMediaCompatibility } from "../../shared/media/media-compat.js";
import { dolbyVisionFromProbe } from "../../shared/media/video-profile.js";
import { normalizeEmbeddedChapterMarkers } from "../../shared/media/embedded-chapter-markers.js";
import { isTorrentFileFullyVerified } from "./verified-torrent-file.js";
import { ffprobePath, MAX_TORRENT_VIDEO_BYTES, mediaProbeCache, port, VIDEO_EXTENSIONS } from "../../server.js";
import { internalTorrentSource } from "../torrents/torrent-sessions.js";

const MAX_PROBE_JOBS = 2;
const MAX_PROBE_CACHE_ENTRIES = 32;
const MEDIA_PROBE_TIMEOUT_MS = 20 * 1000;
const MEDIA_PROBE_CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_PROBE_OUTPUT_BYTES = 256 * 1024;

let activeProbeJobs = 0;

function probeCacheKey(sessionId, fileIndex) {
  return `${sessionId}:${fileIndex}`;
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
  if (entry.expiresAt <= Date.now()) {
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
    const probe = spawn(ffprobePath, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
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
      if (!probe.killed) probe.kill();
      const error = new Error("Timed out probing media metadata");
      error.statusCode = 504;
      finish(error);
    }, MEDIA_PROBE_TIMEOUT_MS);
    timer.unref?.();

    probe.stdout.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_PROBE_OUTPUT_BYTES) {
        if (!probe.killed) probe.kill();
        const error = new Error("Media probe returned too much metadata");
        error.statusCode = 502;
        finish(error);
        return;
      }
      stdout += chunk.toString("utf8");
    });
    probe.stderr.on("data", (chunk) => {
      if (stderr.length < 16 * 1024) stderr += chunk.toString("utf8");
    });
    probe.once("error", (error) => finish(Object.assign(error, { statusCode: 500 })));
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
          streamIndex: Number.isFinite(Number(stream.index)) ? Number(stream.index) : null,
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
            streamIndex: Number.isFinite(Number(stream.index)) ? Number(stream.index) : null,
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
    return await runFfprobe(sourceUrl, file, { includeChapters });
  } catch (error) {
    if (error.statusCode !== 502 && error.statusCode !== 504) throw error;
    await new Promise((resolve) => setTimeout(resolve, 250));
    // A failed optional chapter scan must not be repeated during startup.
    return runFfprobe(sourceUrl, file, { includeChapters: false });
  }
}

export async function probeTorrentFile(session, fileIndex) {
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
  const pending = mediaProbeCache.get(key)?.promise;
  if (pending) return pending;

  pruneMediaProbeCache();
  if (mediaProbeCache.size >= MAX_PROBE_CACHE_ENTRIES) {
    const error = new Error("Media probe cache is busy");
    error.statusCode = 429;
    throw error;
  }
  if (activeProbeJobs >= MAX_PROBE_JOBS) {
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
  const includeChapters = isTorrentFileFullyVerified(session.torrent, fileIndex);
  const promise = runFfprobeWithRetry(sourceUrl, file, { includeChapters })
    .then((value) => {
      mediaProbeCache.set(key, {
        value,
        promise: null,
        expiresAt: Date.now() + MEDIA_PROBE_CACHE_TTL_MS,
        lastAccess: Date.now(),
      });
      return value;
    })
    .catch((error) => {
      mediaProbeCache.delete(key);
      throw error;
    })
    .finally(() => {
      tagged?.release();
      activeProbeJobs -= 1;
    });
  mediaProbeCache.set(key, {
    value: null,
    promise,
    expiresAt: Date.now() + MEDIA_PROBE_CACHE_TTL_MS,
    lastAccess: Date.now(),
  });
  return promise;
}
