import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

test("FFmpeg can seek into MKV, copy video into fragmented MP4 and convert 5.1 audio", { timeout: 30_000 }, () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "lvl-media-remux-"));
  const input = path.join(folder, "sample.mkv");
  const output = path.join(folder, "sample.mp4");
  const run = (args) => spawnSync(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-nostdin", ...args], {
    timeout: 12000, windowsHide: true, encoding: "utf8",
  });
  try {
    const sample = run([
      "-f", "lavfi", "-i", "testsrc2=size=96x64:rate=10",
      "-f", "lavfi", "-i", "anullsrc=channel_layout=5.1:sample_rate=48000",
      "-t", "4", "-map", "0:v:0", "-map", "1:a:0",
      "-c:v", "libx264", "-g", "10", "-pix_fmt", "yuv420p",
      "-c:a", "ac3", "-ac", "6", "-y", input,
    ]);
    assert.equal(sample.status, 0, sample.stderr);
    const remux = run([
      "-ss", "1.5", "-i", input,
      "-map", "0:v:0", "-map", "0:a:0",
      "-c:v", "copy", "-c:a", "aac", "-b:a", "384k", "-ac", "6",
      "-avoid_negative_ts", "make_zero",
      "-movflags", "frag_keyframe+empty_moov+default_base_moof",
      "-f", "mp4", "-y", output,
    ]);
    assert.equal(remux.status, 0, remux.stderr);
    const probe = spawnSync(ffprobeStatic.path, ["-v", "error", "-show_entries", "stream=codec_name,channels", "-of", "json", output], {
      timeout: 5000, encoding: "utf8", windowsHide: true,
    });
    assert.equal(probe.status, 0, probe.stderr);
    const streams = JSON.parse(probe.stdout).streams;
    assert.equal(streams[0].codec_name, "h264");
    assert.equal(streams[1].codec_name, "aac");
    assert.equal(streams[1].channels, 6);
    assert.ok(fs.statSync(output).size > 1000);
  } finally {
    for (const file of [input, output]) if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(folder);
  }
});

test("HEVC Main10 HDR10 survives fragmented MP4 remux with video stream copy", { timeout: 30_000 }, () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "lvl-hdr-remux-"));
  const input = path.join(folder, "hdr.mkv");
  const output = path.join(folder, "hdr.mp4");
  const run = (args) => spawnSync(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-nostdin", ...args], {
    timeout: 12000, windowsHide: true, encoding: "utf8",
  });
  try {
    const generated = run([
      "-f", "lavfi", "-i", "testsrc2=size=96x64:rate=10",
      "-t", "2", "-c:v", "libx265", "-x265-params", "log-level=error",
      "-pix_fmt", "yuv420p10le", "-color_primaries", "bt2020",
      "-color_trc", "smpte2084", "-colorspace", "bt2020nc",
      "-y", input,
    ]);
    assert.equal(generated.status, 0, generated.stderr);
    const copied = run([
      "-ss", "0.5", "-i", input, "-map", "0:v:0", "-c:v", "copy",
      "-tag:v", "hvc1", "-an", "-avoid_negative_ts", "make_zero",
      "-movflags", "frag_keyframe+empty_moov+default_base_moof",
      "-f", "mp4", "-y", output,
    ]);
    assert.equal(copied.status, 0, copied.stderr);
    const probed = spawnSync(ffprobeStatic.path, [
      "-v", "error", "-show_entries", "stream=codec_name,pix_fmt,color_transfer,color_primaries",
      "-of", "json", output,
    ], { timeout: 5000, encoding: "utf8", windowsHide: true });
    assert.equal(probed.status, 0, probed.stderr);
    const [stream] = JSON.parse(probed.stdout).streams;
    assert.equal(stream.codec_name, "hevc");
    assert.equal(stream.pix_fmt, "yuv420p10le");
    assert.equal(stream.color_transfer, "smpte2084");
    assert.equal(stream.color_primaries, "bt2020");
  } finally {
    for (const file of [input, output]) if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(folder);
  }
});
