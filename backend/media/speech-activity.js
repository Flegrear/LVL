// Where people speak in a stretch of audio (for lining subtitles up with the audio).
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import { SPEECH_FRAME_MS, SPEECH_SAMPLE_RATE, speechActivityFromPcm } from "../../shared/subtitles/subtitle-sync.js";
import { speechTapeActivity, speechTapeCoverage } from "./speech-tape.js";
import { port, TORRENT_SESSION_TTL_MS, torrentSessions } from "../../server.js";
import { boundedInteger, json, methodNotAllowed } from "../app/http-helpers.js";
import { internalTorrentSource } from "../torrents/torrent-sessions.js";
import { probeTorrentFile } from "./torrent-probe.js";

// Speech activity of one audio window, for syncing subtitles to what is actually said. Decodes only
// that stretch (input seeking), as 16 kHz mono speech-band audio, and returns activity per 10 ms.
const SPEECH_WINDOW_MAX_SECONDS = 120;
const MAX_SPEECH_JOBS = 2;
const MAX_SPEECH_WINDOW_WAITERS = 16;
const speechWindowCache = new Map();
const speechMetadataWaiters = new WeakMap();
// In-flight entries are scoped to the actual session object (not its ID).
// Only successful completed windows enter the small time-bounded result cache.
const speechWindowInflight = new WeakMap();
// A child whose termination could not be confirmed after a bounded kill
// escalation still reserves one slot until its actual 'close' event arrives.
const speechUnclosedChildren = new Set();
let activeSpeechJobs = 0;

export function invalidateSpeechWindowSession(session) {
  const probing = speechMetadataWaiters.get(session);
  if (probing) {
    speechMetadataWaiters.delete(session);
    for (const wake of probing) wake({ status: 410 });
    probing.clear();
  }
  const flights = speechWindowInflight.get(session);
  if (flights) {
    speechWindowInflight.delete(session);
    for (const flight of flights.values()) {
      flight.controller.abort();
      // The client may still be connected. Null means the client disconnected;
      // session removal needs a terminal HTTP response instead of a hanging GET.
      for (const subscriber of flight.subscribers)
        subscriber.resolve({ status: 410, message: "Audio source changed; request a fresh window" });
      flight.subscribers.clear();
    }
    flights.clear();
  }
  for (const [key, entry] of speechWindowCache) {
    if (entry.session === session) speechWindowCache.delete(key);
  }
}

export async function speechActivityWindow(req, res, session, fileIndex, url) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  const audioOrder = boundedInteger(url.searchParams.get("audio") ?? "0", 0, 63);
  if (audioOrder === undefined) {
    json(res, 400, { error: "audio must be a track number" });
    return;
  }
  // What the playback transcode has already converted (and so can be analysed at once).
  if (url.searchParams.get("coverage") === "1") {
    json(res, 200, { frameMs: SPEECH_FRAME_MS, ranges: speechTapeCoverage(session.id, fileIndex, audioOrder) });
    return;
  }
  const start = Number(url.searchParams.get("start"));
  const duration = Number(url.searchParams.get("duration"));
  if (!Number.isFinite(start) || start < 0 || !Number.isFinite(duration) || duration < 10 || duration > SPEECH_WINDOW_MAX_SECONDS) {
    json(res, 400, { error: `start (s), duration (10-${SPEECH_WINDOW_MAX_SECONDS} s) and audio are required` });
    return;
  }
  const live = speechTapeActivity(session.id, fileIndex, audioOrder, Math.round(start * 1000), Math.round(duration * 1000));
  if (live) {
    json(res, 200, {
      startMs: Math.round(start * 1000),
      frameMs: SPEECH_FRAME_MS,
      durationMs: live.length * SPEECH_FRAME_MS,
      audio: audioOrder,
      live: true,
      activity: Buffer.from(live).toString("base64"),
    });
    return;
  }
  if (url.searchParams.get("live") === "only") {
    json(res, 409, { error: "That stretch has not played yet" });
    return;
  }
  if (!ffmpegPath) {
    json(res, 503, { error: "Bundled FFmpeg binary is unavailable" });
    return;
  }
  let clientClosed = Boolean(req.aborted || res.destroyed || res.writableEnded);
  let cancelSubscriber = null;
  let stopMetadata = null;
  const onClientClose = () => {
    clientClosed = true;
    stopMetadata?.(null);
    cancelSubscriber?.();
  };
  // The metadata probe may be long. A disconnected caller must not start a
  // speech FFmpeg once that probe eventually returns.
  req.once("aborted", onClientClose);
  res.once("close", onClientClose);
  const currentSession = () => torrentSessions.get(session.id) === session && session.state === "ready";
  try {
    if (clientClosed) return;
    if (!currentSession()) {
      json(res, 410, { error: "Audio source changed; request a fresh window" });
      return;
    }
    let metadataWaiters = speechMetadataWaiters.get(session);
    if (!metadataWaiters) {
      metadataWaiters = new Set();
      speechMetadataWaiters.set(session, metadataWaiters);
    }
    if (metadataWaiters.size >= MAX_SPEECH_WINDOW_WAITERS) {
      json(res, 429, { error: "Too many callers are waiting for audio metadata" });
      return;
    }
    let media;
    try {
      const interrupted = new Promise((resolve) => {
        stopMetadata = resolve;
        metadataWaiters.add(resolve);
      });
      // Observe both outcomes even when the HTTP waiter disconnects: shared
      // FFprobe continues for others, but its later rejection is always caught.
      const probeTask = Promise.resolve().then(() => probeTorrentFile(session, fileIndex))
        .then((value) => ({ media: value }), (error) => ({ error }));
      const metadata = await Promise.race([probeTask, interrupted]);
      if (!metadata || clientClosed || req.aborted || res.destroyed || res.writableEnded) return;
      if (metadata.status === 410) {
        json(res, 410, { error: "Audio source changed; request a fresh window" });
        return;
      }
      if (metadata.error) throw metadata.error;
      media = metadata.media;
    } finally {
      metadataWaiters.delete(stopMetadata);
      if (!metadataWaiters.size && speechMetadataWaiters.get(session) === metadataWaiters)
        speechMetadataWaiters.delete(session);
      stopMetadata = null;
    }
    if (clientClosed || req.aborted || res.destroyed || res.writableEnded) return;
    if (!currentSession()) {
      json(res, 410, { error: "Audio source changed; request a fresh window" });
      return;
    }
    const audioTracks = Array.isArray(media?.audioTracks) ? media.audioTracks : [];
    if (!audioTracks.length) {
      json(res, 422, { error: "This video has no audio track" });
      return;
    }
    const order = audioOrder < audioTracks.length ? audioOrder : 0;
    const total = Number(media?.durationSeconds) || 0;
    const startSeconds = Math.round((total ? Math.min(start, Math.max(0, total - 10)) : start) * 100) / 100;
    const seconds = Math.round((total ? Math.min(duration, Math.max(10, total - startSeconds)) : duration) * 100) / 100;
    const key = `${fileIndex}:${order}:${startSeconds}:${seconds}`;
    const cacheKey = `${session.id}:${key}`;
    for (const [entryKey, entry] of speechWindowCache) if (entry.expiresAt < Date.now() || entry.session?.state !== "ready"
      || torrentSessions.get(entry.session?.id) !== entry.session) speechWindowCache.delete(entryKey);
    const cached = speechWindowCache.get(cacheKey);
    if (cached?.session === session) {
      json(res, 200, cached.value);
      return;
    }
    let flights = speechWindowInflight.get(session);
    let flight = flights?.get(key);
    if (!flight) {
      if (activeSpeechJobs + speechUnclosedChildren.size >= MAX_SPEECH_JOBS) {
        json(res, 429, { error: "Audio analysis is busy; try again shortly" });
        return;
      }
      if (!flights) {
        flights = new Map();
        speechWindowInflight.set(session, flights);
      }
      flight = { controller: new AbortController(), subscribers: new Set(), done: false };
      flights.set(key, flight);
      activeSpeechJobs += 1;
      const producer = flight;
      const ownerFlights = flights;
      // Queue the worker after this HTTP request subscribes, so a synchronous
      // disconnect can cancel it without spawning another decoder.
      queueMicrotask(() => {
        void (async () => {
          let result = null;
          try {
            if (producer.controller.signal.aborted) return;
            const pcm = await decodeSpeechAudio(session, fileIndex, {
              startSeconds, seconds, order, signal: producer.controller.signal,
            });
            if (producer.controller.signal.aborted) return;
            if (pcm.length < SPEECH_SAMPLE_RATE * 5) {
              result = { status: 422, message: "No audio was decoded in this range" };
            } else {
              const activity = speechActivityFromPcm(pcm, { sampleRate: SPEECH_SAMPLE_RATE });
              const value = {
                startMs: Math.round(startSeconds * 1000),
                frameMs: SPEECH_FRAME_MS,
                durationMs: activity.length * SPEECH_FRAME_MS,
                audio: order,
                activity: Buffer.from(activity).toString("base64"),
              };
              if (currentSession() && producer.subscribers.size && !producer.controller.signal.aborted) {
                if (speechWindowCache.size >= 60) speechWindowCache.delete(speechWindowCache.keys().next().value);
                speechWindowCache.set(cacheKey, { session, value, expiresAt: Date.now() + TORRENT_SESSION_TTL_MS });
              }
              result = { value };
            }
          } catch (error) {
            result = { error };
          } finally {
            producer.done = true;
            if (ownerFlights.get(key) === producer) ownerFlights.delete(key);
            if (!ownerFlights.size && speechWindowInflight.get(session) === ownerFlights)
              speechWindowInflight.delete(session);
            activeSpeechJobs -= 1;
            for (const subscriber of producer.subscribers) subscriber.resolve(result);
            producer.subscribers.clear();
          }
        })();
      });
    }
    if (flight.subscribers.size >= MAX_SPEECH_WINDOW_WAITERS) {
      json(res, 429, { error: "Too many callers are waiting for audio analysis" });
      return;
    }
    const pending = flight;
    const result = await new Promise((resolve) => {
      const subscriber = { resolve };
      pending.subscribers.add(subscriber);
      cancelSubscriber = () => {
        if (!pending.subscribers.delete(subscriber)) return;
        resolve(null);
        if (!pending.subscribers.size && !pending.done) {
          if (flights.get(key) === pending) flights.delete(key);
          pending.controller.abort();
        }
      };
      if (clientClosed) cancelSubscriber();
    });
    cancelSubscriber = null;
    if (!result || clientClosed || req.aborted || res.destroyed || res.writableEnded) return;
    if (!currentSession()) {
      json(res, 410, { error: "Audio source changed; request a fresh window" });
      return;
    }
    if (result.status) {
      json(res, result.status, { error: result.message });
      return;
    }
    if (result.error) throw result.error;
    json(res, 200, result.value);
  } finally {
    req.off("aborted", onClientClose);
    res.off("close", onClientClose);
  }
}

function decodeSpeechAudio(session, fileIndex, { startSeconds, seconds, order, signal }) {
  if (signal?.aborted) return Promise.reject(Object.assign(new Error("Audio analysis cancelled"), { statusCode: 499 }));
  const tagged = typeof internalTorrentSource === "function"
    ? internalTorrentSource(session, fileIndex, "speech") : null;
  const sourceUrl = tagged?.url || `http://127.0.0.1:${port}/api/torrents/${encodeURIComponent(session.id)}/files/${fileIndex}/stream`;
  const args = [
    "-hide_banner", "-loglevel", "error", "-nostdin",
    "-rw_timeout", "30000000",
    ...(startSeconds > 0 ? ["-ss", String(startSeconds)] : []),
    "-i", sourceUrl,
    "-t", String(seconds),
    "-map", `0:a:${order}`,
    "-vn", "-sn", "-dn",
    "-ac", "1", "-ar", String(SPEECH_SAMPLE_RATE),
    "-af", "highpass=f=120,lowpass=f=4000",
    "-f", "s16le", "pipe:1",
  ];
  const maxBytes = Math.ceil(seconds * SPEECH_SAMPLE_RATE * 2) + 64 * 1024;
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(ffmpegPath, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    ffmpeg.once("close", () => tagged?.release());
    ffmpeg.once("error", () => tagged?.release());
    const chunks = [];
    let size = 0;
    let stderr = "";
    let settled = false;
    let stopReason = null;
    let escalationTimer = null;
    let closeDeadline = null;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(escalationTimer);
      clearTimeout(closeDeadline);
      signal?.removeEventListener("abort", cancel);
      if (error) reject(error);
      else resolve(value);
    };
    const requestStop = (reason) => {
      if (settled || stopReason) return;
      stopReason = reason;
      clearTimeout(timer);
      try { ffmpeg.kill(); } catch { /* still wait for confirmed process close */ }
      // A kill request is not evidence the child exited. Retry once with a
      // stronger signal, then bound the HTTP failure without freeing its slot.
      escalationTimer = setTimeout(() => {
        try { ffmpeg.kill("SIGKILL"); } catch { /* keep capacity reserved */ }
      }, 2_000);
      escalationTimer.unref?.();
      closeDeadline = setTimeout(() => {
        if (settled) return;
        speechUnclosedChildren.add(ffmpeg);
        finish(stopReason);
      }, 8_000);
      closeDeadline.unref?.();
    };
    const cancel = () => requestStop(Object.assign(new Error("Audio analysis cancelled"), { statusCode: 499 }));
    const timer = setTimeout(() => requestStop(Object.assign(new Error("Timed out reading audio for subtitle sync"), { statusCode: 504 })), 45_000);
    timer.unref?.();
    ffmpeg.stdout.on("data", (chunk) => {
      if (size + chunk.length > maxBytes) chunk = chunk.subarray(0, Math.max(0, maxBytes - size));
      size += chunk.length;
      chunks.push(chunk);
    });
    ffmpeg.stderr.on("data", (chunk) => {
      if (stderr.length < 8 * 1024) stderr += chunk.toString("utf8");
    });
    ffmpeg.once("error", (error) => requestStop(error));
    ffmpeg.once("close", (code) => {
      speechUnclosedChildren.delete(ffmpeg);
      if (settled) return;
      if (stopReason) return finish(stopReason);
      const buffer = Buffer.concat(chunks);
      if (code !== 0 && buffer.length < SPEECH_SAMPLE_RATE * 2) {
        finish(Object.assign(new Error(stderr.trim().slice(-600) || `FFmpeg exited with code ${code}`), { statusCode: 502 }));
        return;
      }
      const samples = new Int16Array(Math.floor(buffer.length / 2));
      for (let index = 0; index < samples.length; index += 1) samples[index] = buffer.readInt16LE(index * 2);
      finish(null, samples);
    });
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}
