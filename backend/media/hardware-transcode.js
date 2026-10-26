import { spawn } from "node:child_process";

// FFmpeg's encoder list only shows what was compiled in, not which GPU and
// drivers are present. Attempt an actual frame encode before enabling one.
export const WINDOWS_H264_ENCODERS = Object.freeze(["h264_amf", "h264_qsv", "h264_nvenc"]);

export function hardwareVideoEncodingArgs(encoder, height = 1080) {
  const targetBitrate = Number(height) >= 2160 ? "18000k" : Number(height) > 1080 ? "10000k" : "6000k";
  return encoder === "libx264"
    ? ["-c:v", "libx264", "-preset", "veryfast", "-crf", "21"]
    : ["-c:v", encoder, "-b:v", targetBitrate, "-maxrate", targetBitrate, "-bufsize", targetBitrate];
}

function verifyEncoder(binary, encoder, timeoutMs) {
  return new Promise((resolve) => {
    const args = [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=1",
      "-frames:v", "1", "-pix_fmt", "yuv420p",
      ...hardwareVideoEncodingArgs(encoder),
      "-f", "null", "-",
    ];
    let settled = false;
    let job;
    let timer;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    try {
      job = spawn(binary, args, { windowsHide: true, stdio: "ignore" });
    } catch {
      return done(false);
    }
    timer = setTimeout(() => { job.kill(); done(false); }, timeoutMs);
    timer.unref?.();
    job.once("error", () => done(false));
    job.once("close", (code) => done(code === 0));
  });
}

export async function detectHardwareH264Encoder(binary, { platform = process.platform, timeoutMs = 3000 } = {}) {
  if (!binary || platform !== "win32") return null;
  for (const encoder of WINDOWS_H264_ENCODERS) {
    if (await verifyEncoder(binary, encoder, timeoutMs)) return encoder;
  }
  return null;
}
