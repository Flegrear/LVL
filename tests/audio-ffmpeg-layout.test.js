import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import ffprobe from "ffprobe-static";
import { planCompatibleAudio } from "../shared/media/audio-policy.js";

function run(binary, args) {
  const result = spawnSync(binary, args, { encoding: "utf8", timeout: 15_000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.error?.message || "FFmpeg failure");
  return result.stdout;
}

test("Actual FFmpeg AAC fallback maps 7.1 input to stereo and 5.1 without invalid layout", { timeout: 30_000 }, () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "lvl-audio-layout-"));
  try {
    for (const [mode, outputChannels] of [["stereo", 2], ["auto", 6]]) {
      const plan = planCompatibleAudio({ codec: "pcm_s16le", channels: 8, channelLayout: "7.1" }, { audioMode: mode });
      assert.equal(plan.channels, outputChannels);
      const out = path.join(folder, `output-${mode}.m4a`);
      run(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-f", "lavfi", "-i", "anullsrc=channel_layout=7.1:sample_rate=48000", "-t", "0.5",
        "-c:a", plan.codec, "-b:a", plan.bitRate, "-ac", String(plan.channels), out]);
      const probe = JSON.parse(run(ffprobe.path, ["-v", "error", "-select_streams", "a:0",
        "-show_entries", "stream=codec_name,channels,channel_layout", "-of", "json", out]));
      assert.equal(probe.streams?.[0]?.codec_name, "aac");
      assert.equal(probe.streams?.[0]?.channels, outputChannels);
      assert.match(String(probe.streams?.[0]?.channel_layout), outputChannels === 2 ? /stereo/i : /5\.1/i);
    }
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
