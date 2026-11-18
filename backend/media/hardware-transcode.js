import { spawn } from "node:child_process";

// FFmpeg's encoder list only shows what was compiled in, not which GPU and
// drivers are present. Attempt an actual frame encode before enabling one.
export const WINDOWS_H264_ENCODERS = Object.freeze(["h264_amf", "h264_qsv", "h264_nvenc"]);
export const ANDROID_H264_ENCODERS = Object.freeze(["h264_mediacodec"]);

// Raw YUV avoids lavfi/testsrc2, which is deliberately omitted from the
// minimal Android FFmpeg. The same frame reaches the device encoder that
// would be used for playback; an encoder listing alone is insufficient.
// Several Android MediaCodec implementations reject 64x64 despite supporting
// ordinary video resolutions. Probe a small but widely supported 128x128
// frame using the actual playback MP4 muxer.
const PROBE_WIDTH = 128;
const PROBE_FRAME = Buffer.alloc(PROBE_WIDTH * PROBE_WIDTH * 3 / 2, 128);
PROBE_FRAME.fill(16, 0, PROBE_WIDTH * PROBE_WIDTH);

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
      "-s:v", `${PROBE_WIDTH}x${PROBE_WIDTH}`, "-r", android ? "4" : "1", "-i", "pipe:0",
      "-frames:v", android ? "8" : "1", "-pix_fmt", "yuv420p",
      ...hardwareVideoEncodingArgs(encoder),
      ...(android ? ["-movflags", "frag_keyframe+empty_moov", "-f", "mp4", "pipe:1"] : ["-f", "null", "-"]),
    ];
    let settled = false;
    let job;
    let timer;
    let terminationTimer;
    let timedOut = false;
    let failed = false;
    let stdoutEnded = false;
    let stderrEnded = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(terminationTimer);
      resolve(ok);
    };
    // A successful kill() call only means the signal was submitted. A probe
    // must retain ownership (and block later candidates) until its exact child
    // emits close, after both redirected output streams have drained.
    const running = () => job && job.exitCode == null && job.signalCode == null;
    const terminate = () => {
      if (running()) try { job.kill("SIGTERM"); } catch {}
      if (!terminationTimer) terminationTimer = setTimeout(() => {
        if (running()) try { job.kill("SIGKILL"); } catch {}
      }, 1000);
    };
    try {
      job = spawnFn(binary, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      return done(false);
    }
    timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, Number.isFinite(timeoutMs) ? Math.max(1, timeoutMs) : 3000);
    job.stdout?.on("end", () => { stdoutEnded = true; });
    job.stderr?.on("end", () => { stderrEnded = true; });
    job.stdout?.on("error", () => { failed = true; terminate(); });
    job.stderr?.on("error", () => { failed = true; terminate(); });
    job.stdout?.resume?.(); // Drain bounded diagnostic output without buffering.
    job.stderr?.resume?.();
    job.once("error", () => {
      failed = true;
      // A spawn failure with no real child has no physical process to retain.
      if (!Number.isSafeInteger(job.pid) || job.pid <= 0) done(false);
      else terminate();
    });
    job.once("close", (code) => done(!failed && !timedOut && code === 0
      && stdoutEnded && stderrEnded));
    job.stdin?.on("error", () => {}); // FFmpeg may close stdin before reading it.
    try { job.stdin?.end(android ? Buffer.concat(Array(8).fill(PROBE_FRAME)) : PROBE_FRAME); }
    catch {
      failed = true;
      terminate();
    }
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
