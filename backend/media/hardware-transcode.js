import { spawn } from "node:child_process";

// FFmpeg's encoder list only shows what was compiled in, not which GPU and
// drivers are present. Attempt an actual frame encode before enabling one.
export const WINDOWS_H264_ENCODERS = Object.freeze(["h264_amf", "h264_qsv", "h264_nvenc"]);
export const ANDROID_H264_ENCODERS = Object.freeze(["h264_mediacodec"]);

// Raw YUV avoids lavfi/testsrc2, which is deliberately omitted from the
// minimal Android FFmpeg. The same frame reaches the device encoder that
// would be used for playback; an encoder listing alone is insufficient.
const PROBE_FRAME = Buffer.alloc(64 * 64 * 3 / 2, 128);
PROBE_FRAME.fill(16, 0, 64 * 64);

export function hardwareVideoEncodingArgs(encoder, height = 1080) {
  const targetBitrate = Number(height) >= 2160 ? "18000k" : Number(height) > 1080 ? "10000k" : "6000k";
  return encoder === "libx264"
    ? ["-c:v", "libx264", "-preset", "veryfast", "-crf", "21"]
    : ["-c:v", encoder, "-b:v", targetBitrate, "-maxrate", targetBitrate, "-bufsize", targetBitrate,
      // The standalone FFmpeg process is not attached to Android's Java VM.
      // Force the NDK MediaCodec interface instead of assuming JNI is usable.
      ...(encoder === "h264_mediacodec" ? ["-ndk_codec", "1"] : [])];
}

function verifyEncoder(binary, encoder, timeoutMs, spawnFn = spawn) {
  return new Promise((resolve) => {
    const android = encoder === "h264_mediacodec";
    const args = [
      "-hide_banner", "-loglevel", "error",
      // Some Android encoders accept frames into the null muxer but emit no
      // video into MP4. Probe playback's container and reject empty output.
      ...(android ? ["-abort_on", "empty_output"] : []),
      "-nostdin", "-f", "rawvideo", "-pix_fmt", "yuv420p",
      "-s:v", "64x64", "-r", android ? "4" : "1", "-i", "pipe:0",
      "-frames:v", android ? "8" : "1", "-pix_fmt", "yuv420p",
      ...hardwareVideoEncodingArgs(encoder),
      ...(android ? ["-movflags", "frag_keyframe+empty_moov", "-f", "mp4", "pipe:1"] : ["-f", "null", "-"]),
    ];
    let settled = false;
    let job;
    let timer;
    let terminationTimer;
    let timedOut = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(terminationTimer);
      resolve(ok);
    };
    try {
      job = spawnFn(binary, args, { windowsHide: true, stdio: ["pipe", "ignore", "ignore"] });
    } catch {
      return done(false);
    }
    timer = setTimeout(() => {
      timedOut = true;
      try { job.kill("SIGKILL"); } catch { /* close/error may already be arriving */ }
      // A failed or stuck kill must not keep the server's capability check
      // pending indefinitely. The child is explicitly killed before timeout.
      terminationTimer = setTimeout(() => done(false), 1000);
    }, Math.max(1, timeoutMs));
    job.once("error", () => done(false));
    job.once("close", (code) => done(!timedOut && code === 0));
    job.stdin?.on("error", () => {}); // FFmpeg may close stdin before reading it.
    try { job.stdin?.end(android ? Buffer.concat(Array(8).fill(PROBE_FRAME)) : PROBE_FRAME); } catch { done(false); }
  });
}

export async function detectHardwareH264Encoder(binary, { platform = process.platform, timeoutMs = 3000, spawnFn = spawn } = {}) {
  if (!binary) return null;
  const candidates = platform === "win32" ? WINDOWS_H264_ENCODERS
    : platform === "android" ? ANDROID_H264_ENCODERS : [];
  for (const encoder of candidates) {
    if (await verifyEncoder(binary, encoder, timeoutMs, spawnFn)) return encoder;
  }
  return null;
}

// Android ships LGPL FFmpeg without libx264. Never probe or claim a GPL
// software encoder there; Windows and desktop Linux retain their CPU fallback.
export async function canEncodeH264(binary, { platform = process.platform, timeoutMs = 5000, spawnFn = spawn } = {}) {
  if (!binary) return false;
  if (platform !== "android" && await verifyEncoder(binary, "libx264", timeoutMs, spawnFn)) return true;
  return Boolean(await detectHardwareH264Encoder(binary, { platform, timeoutMs, spawnFn }));
}
