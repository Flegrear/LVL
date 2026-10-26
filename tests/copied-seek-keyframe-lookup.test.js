import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

function run(binary, args, timeout = 18000) {
  const proc = spawnSync(binary, args, { encoding: "utf8", timeout, windowsHide: true, maxBuffer: 2_000_000 });
  assert.equal(proc.status, 0, proc.stderr || proc.error?.message || `exit ${proc.status}`);
  return proc.stdout;
}
function seekOrigin(file, seconds) {
  const result = JSON.parse(run(ffprobeStatic.path, [
    "-v", "error", "-read_intervals", `${seconds}%+0.1`,
    "-select_streams", "v:0", "-show_entries", "packet=pts_time,flags", "-of", "json", file,
  ]));
  const packet = result.packets?.[0];
  assert.ok(packet?.flags?.startsWith("K"), "The seek must return a verified keyframe");
  const time = Number(packet.pts_time);
  assert.ok(Number.isFinite(time) && time >= 0 && time <= seconds);
  return time;
}
function firstFrame(file, start = undefined) {
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin"];
  if (start !== undefined) args.push("-ss", String(start));
  args.push("-i", file, "-map", "0:v:0", "-frames:v", "1", "-pix_fmt", "yuv420p", "-f", "framemd5", "-");
  return run(ffmpegPath, args).split(/\r?\n/).find((line) => /^0,/.test(line))?.split(",").at(-1).trim();
}

for (const config of [
  { name: "H264 B-frames in MKV", codec: "libx264", ext: "mkv", codecArgs: ["-bf", "2", "-x264-params", "scenecut=0"] },
  { name: "H264 B-frames in MP4", codec: "libx264", ext: "mp4", codecArgs: ["-bf", "2", "-x264-params", "scenecut=0"] },
  { name: "HEVC 10-bit copy in MKV", codec: "libx265", ext: "mkv", codecArgs: ["-pix_fmt", "yuv420p10le", "-x265-params", "pools=1:frame-threads=1:keyint=100:min-keyint=100:scenecut=0"] },
]) {
  test(`ffprobe nearest preceding keyframe matches actual copied stream start for ${config.name}`, { timeout: 60000 }, () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lvl-pts-audit-"));
    try {
      const src = path.join(directory, `source.${config.ext}`);
      const remux = path.join(directory, "remux.mp4");
      run(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=25", "-f", "lavfi", "-i", "sine=frequency=650:sample_rate=48000",
        "-t", "10", "-map", "0:v:0", "-map", "1:a:0", "-c:v", config.codec, "-threads", "2",
        ...(config.codec === "libx264" ? ["-preset", "ultrafast"] : ["-preset", "fast"]),
        "-g", "100", "-keyint_min", "100", ...config.codecArgs, "-c:a", "ac3", src], 25000);
      const actualOrigin = seekOrigin(src, 5.37);
      const originFrame = firstFrame(src, actualOrigin);
      const targetFrame = firstFrame(src, 5.37);
      assert.notEqual(originFrame, targetFrame, "fixture must distinguish keyframe from requested frame");
      run(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-nostdin", "-noaccurate_seek",
        "-ss", "5.37", "-i", src, "-map", "0:v:0", "-map", "0:a:0", "-c:v", "copy",
        ...(config.codec === "libx265" ? ["-tag:v", "hvc1"] : []),
        "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-af", "aresample=async=1",
        "-t", "4", "-avoid_negative_ts", "make_zero", "-movflags", "frag_keyframe+empty_moov+default_base_moof",
        "-f", "mp4", "-y", remux]);
      assert.equal(firstFrame(remux), originFrame, `actual first decoded frame must match verified FFprobe keyframe ${actualOrigin}s`);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
}
