import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import { probeCopiedSeekOrigin } from "../backend/media/transcode-start.js";

function run(file, args) {
  const child = spawnSync(file, args, { windowsHide: true, encoding: "utf8", timeout: 15000 });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  return child.stdout;
}

function videoFrameCount(file) {
  const result = JSON.parse(run(ffprobeStatic.path, ["-v", "error", "-select_streams", "v:0",
    "-count_frames", "-show_entries", "stream=nb_read_frames", "-of", "json", file]));
  return Number(result.streams[0].nb_read_frames);
}

function audioDuration(file) {
  const result = JSON.parse(run(ffprobeStatic.path, ["-v", "error", "-select_streams", "a:0",
    "-show_entries", "stream=duration", "-of", "json", file]));
  return Number(result.streams[0].duration);
}

test("copied GOP seek must extend -t to preserve audio through the last video frames", { timeout: 30000 }, async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "lvl-remux-eof-"));
  try {
    const source = path.join(folder, "long-gop.mkv");
    run(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=128x72:rate=25",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "10",
      "-c:v", "libx264", "-threads", "2", "-preset", "ultrafast", "-g", "100",
      "-keyint_min", "100", "-sc_threshold", "0", "-c:a", "aac", source]);
    const origin = await probeCopiedSeekOrigin({ source, requestedStartSeconds: 9.37, executable: ffprobeStatic.path });
    assert.equal(origin.effectiveStartSeconds, 8);
    const remux = (label, duration) => {
      const output = path.join(folder, `${label}.mp4`);
      run(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-nostdin", "-noaccurate_seek",
        "-ss", "9.37", "-i", source, "-map", "0:v:0", "-map", "0:a:0",
        "-c:v", "copy", "-c:a", "aac", "-af", "aresample=async=1",
        "-t", String(duration), "-avoid_negative_ts", "make_zero",
        "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", "-y", output]);
      return { frames: videoFrameCount(output), audioSeconds: audioDuration(output) };
    };
    const requestedDurationFrames = remux("requested-duration", 10 - origin.requestedStartSeconds);
    const expandedDurationFrames = remux("expanded-duration", 10 - origin.effectiveStartSeconds);
    assert.ok(requestedDurationFrames.frames >= 48,
      `FFmpeg already retains GOP preroll and reaches the movie ending: ${requestedDurationFrames.frames} frames`);
    assert.equal(expandedDurationFrames.frames, requestedDurationFrames.frames,
      "extending -t for preroll must not add out-of-range video frames");
    assert.ok(requestedDurationFrames.audioSeconds < 1,
      `old -t should demonstrate truncated final audio: ${requestedDurationFrames.audioSeconds}s`);
    assert.ok(expandedDurationFrames.audioSeconds > requestedDurationFrames.audioSeconds + 1,
      `extended -t must preserve the previously cut final audio: ${JSON.stringify({ requestedDurationFrames, expandedDurationFrames })}`);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});
