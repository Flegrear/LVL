// Subtitle tracks inside a torrent's video file.
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import { MAX_SUBTITLE_TEXT_BYTES, port } from "../../server.js";
import { boundedInteger, json, methodNotAllowed } from "../app/http-helpers.js";
import { internalTorrentSource } from "../torrents/torrent-sessions.js";
import { probeTorrentFile } from "../media/torrent-probe.js";
import { mediaAdmissionsClosed, registerMediaShutdownChild } from "../media/media-shutdown.js";

const MAX_EMBEDDED_SUBTITLE_JOBS = 2;

const activeEmbeddedSubtitleJobs = new Set();
const activeEmbeddedSubtitleProbes = new Set();

export async function extractTorrentSubtitle(req, res, session, fileIndex, url) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  if (mediaAdmissionsClosed()) { json(res, 503, { error: "Media server is shutting down" }); return; }
  if (!ffmpegPath) {
    json(res, 503, { error: "Bundled FFmpeg binary is unavailable" });
    return;
  }
  // URLSearchParams.get() returns null for a missing selector, and Number(null)
  // is zero. A request without an explicit subtitle track must never acquire
  // the authority of global stream 0 (often the video rather than subtitles).
  const rawStream = url.searchParams.get("stream");
  const streamIndex = rawStream !== null && /^(?:0|[1-9][0-9]{0,3})$/.test(rawStream)
    ? boundedInteger(rawStream, 0, 9999) : undefined;
  if (streamIndex === undefined) {
    json(res, 400, { error: "A valid embedded subtitle stream index is required" });
    return;
  }
  // Reserve before the asynchronous torrent metadata probe. Otherwise dozens
  // of seeks can occupy independent probes while the two-FFmpeg cap is idle.
  if (activeEmbeddedSubtitleJobs.size + activeEmbeddedSubtitleProbes.size >= MAX_EMBEDDED_SUBTITLE_JOBS) {
    json(res, 429, { error: "Too many embedded subtitle windows are being extracted" });
    return;
  }
  const probeReservation = {};
  activeEmbeddedSubtitleProbes.add(probeReservation);
  // Metadata can take a long time on a torrent. Listen for disconnects BEFORE
  // awaiting it; otherwise a closed request can spawn an orphan FFmpeg later.
  let clientClosed = Boolean(res.destroyed || res.writableEnded || req.aborted);
  const markClientClosed = () => { clientClosed = true; };
  req.once("aborted", markClientClosed);
  res.once("close", markClientClosed);
  let media;
  try { media = await probeTorrentFile(session, fileIndex); }
  finally {
    activeEmbeddedSubtitleProbes.delete(probeReservation);
    req.off("aborted", markClientClosed);
    res.off("close", markClientClosed);
  }
  if (clientClosed || res.destroyed || res.writableEnded || req.aborted) return;
  if (mediaAdmissionsClosed()) { json(res, 503, { error: "Media server is shutting down" }); return; }
  const subtitle = (media.subtitleTracks || []).find((track) => Number(track.streamIndex) === streamIndex);
  if (!subtitle) {
    json(res, 404, { error: "Embedded subtitle track was not found" });
    return;
  }
  if (!subtitle.textBased) {
    json(res, 415, { error: `Embedded ${subtitle.codec || "subtitle"} track is image-based and cannot be converted to text` });
    return;
  }
  // An ASS stream in MKV is interleaved with the whole movie. Waiting for EOF
  // before responding means a torrent may not yield any subtitles for minutes.
  // Progressive callers can use cues immediately and continue importing as
  // pieces arrive. Normal callers keep the original atomic response.
  const progressive = url.searchParams.get("progressive") === "1";
  const requestedStart = Number(url.searchParams.get("start") || 0);
  const durationKnown = Number.isFinite(media.durationSeconds) && media.durationSeconds > 0;
  // With no verified duration, only the beginning is a defensible seek point:
  // never invent an end time, but allow the bounded initial subtitle window.
  if (!Number.isFinite(requestedStart) || requestedStart < 0
    || (durationKnown ? requestedStart > media.durationSeconds : requestedStart !== 0)) {
    json(res, 400, { error: "Subtitle window start is outside the video" });
    return;
  }
  const windowStart = Math.floor(requestedStart);
  const windowSeconds = progressive ? 180 : 0;
  // Each extractor has its own HTTP torrent-piece reader. Cap them separately
  // from video transcoding so rapid seeks don't launch unbounded FFmpeg jobs.
  if (activeEmbeddedSubtitleJobs.size >= MAX_EMBEDDED_SUBTITLE_JOBS) {
    json(res, 429, { error: "Too many embedded subtitle windows are being extracted" });
    return;
  }
  const tagged = typeof internalTorrentSource === "function"
    ? internalTorrentSource(session, fileIndex, "subtitle") : null;
  if (mediaAdmissionsClosed()) {
    tagged?.release();
    json(res, 503, { error: "Media server is shutting down" });
    return;
  }
  const sourceUrl = tagged?.url || `http://127.0.0.1:${port}/api/torrents/${encodeURIComponent(session.id)}/files/${fileIndex}/stream`;
  const args = [
    "-v", "error",
    "-rw_timeout", "18000000",
    // Byte-range seeking with -ss + -copyts + -t silently returns zero cues
    // on seeked MKVs (FFmpeg even exits 0). Seek without -copyts, then
    // restore absolute playback timestamps via output_ts_offset.
    ...(progressive && windowStart > 0 ? ["-ss", String(windowStart)] : []),
    "-i", sourceUrl,
    "-map", `0:${streamIndex}`,
    ...(progressive ? ["-t", String(windowSeconds)] : []),
    ...(progressive && windowStart > 0 ? ["-output_ts_offset", String(windowStart)] : []),
    "-f", "webvtt",
    "pipe:1",
  ];
  let ffmpeg;
  try { ffmpeg = spawn(ffmpegPath, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); }
  catch (error) {
    tagged?.release();
    if (!res.destroyed && !res.writableEnded) json(res, 500, { error: error.message });
    return;
  }
  if (!registerMediaShutdownChild(ffmpeg)) {
    tagged?.release();
    if (!res.destroyed && !res.writableEnded)
      json(res, 503, { error: "Media server is shutting down" });
    return;
  }
  activeEmbeddedSubtitleJobs.add(ffmpeg);
  let jobReleased = false;
  let escalation = null;
  const releaseSubtitleJob = () => {
    if (jobReleased) return;
    jobReleased = true;
    clearTimeout(escalation);
    tagged?.release();
    activeEmbeddedSubtitleJobs.delete(ffmpeg);
  };
  // Child 'exit' precedes trailing subtitle bytes. Retain the slot and source
  // reader through stdio close, except a proven spawn failure with no PID.
  ffmpeg.once("close", releaseSubtitleJob);
  const chunks = [];
  let size = 0;
  let stderr = "";
  let settled = false;
  let streaming = false;
  let drainListener = null;
  const stop = () => {
    if (drainListener) { res.off("drain", drainListener); drainListener = null; }
    // ChildProcess.killed merely records successful signal delivery, not OS
    // exit. Also, successful 'close' is a normal terminal event: finish()
    // must not signal its possibly recycled PID.
    const stillRunning = () => !jobReleased && ffmpeg.exitCode == null
      && ffmpeg.signalCode == null;
    if (stillRunning()) try { ffmpeg.kill("SIGTERM"); } catch {}
    if (Number.isSafeInteger(ffmpeg.pid) && ffmpeg.pid > 0 && !jobReleased && !escalation) {
      escalation = setTimeout(() => {
        if (stillRunning()) try { ffmpeg.kill("SIGKILL"); } catch {}
      }, 2000);
      escalation.unref?.();
    }
  };
  const beginStreaming = () => {
    if (streaming || settled || res.destroyed || res.writableEnded) return;
    streaming = true;
    res.writeHead(200, {
      "Content-Type": "text/vtt; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Subtitle-Progressive": "1",
      "X-Subtitle-Language": String(subtitle.language || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24),
      "X-Subtitle-Start": String(windowStart),
      "X-Subtitle-Window-Seconds": String(windowSeconds),
    });
    res.flushHeaders?.();
  };
  const finish = (status, body, headers = {}) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    stop();
    if (progressive && streaming) {
      if (!res.destroyed) res.end(status === 200
        ? "\n\nNOTE LVL-EXTRACT-COMPLETE\n"
        : `\n\nNOTE LVL-EXTRACT-PARTIAL: ${String(body || "Extraction interrupted").replace(/[\r\n]/g, " ").slice(0, 200)}\n`);
    } else if (status === 200) {
      res.writeHead(200, {
        "Content-Type": "text/vtt; charset=utf-8",
        "Cache-Control": "no-store",
        ...headers,
      });
      res.end(body);
    } else {
      json(res, status, { error: String(body || "Embedded subtitle extraction failed") });
    }
  };
  const timer = setTimeout(() => finish(504, "Timed out reading video. Some torrent pieces may still be missing."), progressive ? 42_000 : 20_000);
  timer.unref?.();
  ffmpeg.stdout.on("data", (chunk) => {
    if (settled || res.destroyed || res.writableEnded) return;
    size += chunk.length;
    if (size > MAX_SUBTITLE_TEXT_BYTES) {
      finish(413, "Embedded subtitle track is too large");
      return;
    }
    if (progressive) {
      beginStreaming();
      if (!res.write(chunk)) {
        ffmpeg.stdout.pause();
        drainListener = () => {
          drainListener = null;
          if (!settled && !res.destroyed && !res.writableEnded) ffmpeg.stdout.resume();
        };
        res.once("drain", drainListener);
      }
    } else chunks.push(chunk);
  });
  ffmpeg.stderr.on("data", (chunk) => {
    if (settled) return;
    if (stderr.length < 16 * 1024) stderr += chunk.toString("utf8");
  });
  ffmpeg.stdout.on("error", (error) => {
    if (settled || res.destroyed || res.writableEnded) return;
    finish(502, error.message);
  });
  ffmpeg.stderr.on("error", () => {});
  ffmpeg.once("error", (error) => {
    if (!Number.isSafeInteger(ffmpeg.pid) || ffmpeg.pid <= 0) releaseSubtitleJob();
    finish(500, error.message);
  });
  ffmpeg.once("close", (code) => {
    if (settled) return;
    if (code !== 0) {
      finish(502, stderr.trim().slice(-1200) || `FFmpeg exited with code ${code}`);
      return;
    }
    const text = progressive ? "" : Buffer.concat(chunks).toString("utf8");
    if (progressive && streaming) return finish(200, "");
    if (!text.trim()) {
      finish(422, "Embedded subtitle track was empty");
      return;
    }
    finish(200, text, {
      "X-Subtitle-Language": String(subtitle.language || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24),
      "X-Subtitle-Title": encodeURIComponent(String(subtitle.title || "Embedded subtitle").slice(0, 200)),
    });
  });
  res.once("close", () => {
    if (!settled) {
      settled = true;
      clearTimeout(timer);
      stop();
    }
  });
}
