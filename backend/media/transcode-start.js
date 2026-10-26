// The browser's fMP4 clock begins at zero even when -noaccurate_seek copies
// video from an earlier source keyframe. This probe MUST fail closed: guessing
// the original requested seek timestamp would shift embedded subtitles.
import { spawn } from "node:child_process";

const TIMEOUT_MS = 8_000;
const OUTPUT_LIMIT = 16 * 1024;
const MAX_PREROLL_SECONDS = 15;

function invalid(message, statusCode = 422) {
  return Object.assign(new Error(message), { statusCode });
}

export function parseCopiedSeekOrigin(payload, requestedStartSeconds) {
  const requested = Number(requestedStartSeconds);
  if (!Number.isFinite(requested) || requested <= 0 || requested > 24 * 60 * 60)
    throw invalid("Invalid copied-video seek timestamp", 400);
  const stream = payload?.streams?.[0];
  if (!["h264", "hevc"].includes(String(stream?.codec_name || "").toLowerCase()))
    throw invalid("Source codec cannot be verified for a copied-video seek");
  // Edit lists, negative start times and nonzero stream origins can change how
  // FFmpeg normalizes PTS. Do not offer a guessed clock for these sources.
  const startTimes = [stream?.start_time, payload?.format?.start_time];
  if (startTimes.some((value) => value != null && (!Number.isFinite(Number(value)) || Math.abs(Number(value)) > 0.05)))
    throw invalid("Nonzero or ambiguous source timeline cannot be safely copied");
  const duration = Number(payload?.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0 || requested > duration - 0.25)
    throw invalid("Copied-video seek is outside the verified movie duration");
  // FFprobe combines the collections under packets_and_frames when asked to
  // show both in the same invocation (otherwise each has its own array).
  const combined = payload?.packets_and_frames || [];
  const packet = payload?.packets?.[0] || combined.find((entry) => entry.type === "packet");
  const frame = payload?.frames?.[0] || combined.find((entry) => entry.type === "frame");
  const pts = Number(packet?.pts_time);
  const displayPts = Number(frame?.best_effort_timestamp_time);
  if (!packet || !frame || !String(packet.flags || "").startsWith("K") || Number(frame.key_frame) !== 1
    || !Number.isFinite(pts) || !Number.isFinite(displayPts) || pts < 0 || displayPts < 0
    || Math.abs(pts - displayPts) > 0.02 || displayPts > requested + 0.001
    || requested - displayPts > MAX_PREROLL_SECONDS)
    throw invalid("Copied-video seek keyframe and decoded display timestamp do not agree");
  const effectiveStartSeconds = Math.round(displayPts * 1_000_000) / 1_000_000;
  return { requestedStartSeconds: requested, effectiveStartSeconds,
    prerollSeconds: Math.round((requested - effectiveStartSeconds) * 1_000_000) / 1_000_000, verified: true };
}

export async function probeCopiedSeekOrigin({ source, requestedStartSeconds, executable, signal,
  timeoutMs = TIMEOUT_MS, maxOutputBytes = OUTPUT_LIMIT } = {}) {
  const requested = Number(requestedStartSeconds);
  if (!Number.isFinite(requested) || requested < 0 || requested > 24 * 60 * 60)
    throw invalid("start must be a finite nonnegative movie time", 400);
  if (signal?.aborted) throw invalid("Copied-video seek probe cancelled", 499);
  if (!executable) throw invalid("Bundled FFprobe is unavailable", 503);
  if (!source || typeof source !== "string") throw invalid("Missing source URL", 400);
  if (requested === 0) return { requestedStartSeconds: 0, effectiveStartSeconds: 0, prerollSeconds: 0, verified: true };
  const args = [
    "-v", "error",
    ...(source.startsWith("http://127.0.0.1:") ? ["-rw_timeout", "5000000", "-seekable", "1"] : []),
    "-probesize", "1048576", "-analyzeduration", "1000000",
    // Match FFmpeg's input -ss on the same file. Read a small amount past the
    // demuxer's preceding keyframe, enough to decode even with B-frame reorder.
    "-read_intervals", `${requested}%+0.6`, "-select_streams", "v:0",
    "-show_packets", "-show_frames",
    "-show_entries", "stream=codec_name,start_time:format=duration,start_time:packet=pts_time,flags:frame=key_frame,best_effort_timestamp_time",
    "-of", "json", source,
  ];
  return new Promise((resolve, reject) => {
    let probe;
    try { probe = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (error) { reject(invalid(error.message || "Could not launch FFprobe", 502)); return; }
    let output = "";
    let diagnostic = "";
    let settled = false;
    const stop = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancelled);
      if (error && !probe.killed) probe.kill();
      if (error) reject(error);
      else resolve(value);
    };
    const cancelled = () => stop(invalid("Copied-video seek probe cancelled", 499));
    const timer = setTimeout(() => stop(invalid("Copied-video seek probe timed out", 504)), timeoutMs);
    timer.unref?.();
    signal?.addEventListener("abort", cancelled, { once: true });
    if (signal?.aborted) return cancelled();
    probe.stdout.on("data", (chunk) => {
      if (settled) return;
      if (Buffer.byteLength(output) + chunk.length > maxOutputBytes) {
        stop(invalid("Copied-video seek probe exceeded output budget", 422));
        return;
      }
      output += chunk.toString("utf8");
    });
    probe.stderr.on("data", (chunk) => { if (diagnostic.length < 1024) diagnostic += chunk.toString("utf8"); });
    probe.once("error", (error) => stop(invalid(error.message || "FFprobe failed", 502)));
    probe.once("close", (code) => {
      if (settled) return;
      if (code) return stop(invalid(diagnostic.trim() || "Copied-video seek probe could not read source", 422));
      let parsed;
      try { parsed = JSON.parse(output); } catch { return stop(invalid("Copied-video seek probe returned invalid JSON")); }
      try { stop(null, parseCopiedSeekOrigin(parsed, requested)); }
      catch (error) { stop(error); }
    });
  });
}
