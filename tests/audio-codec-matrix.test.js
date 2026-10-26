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
  const result = spawnSync(binary, args, { windowsHide: true, encoding: "utf8", timeout: 15_000 });
  assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr || result.error?.message}`);
  return result.stdout;
}

test("Real AAC/MP3/Opus/FLAC/AC3/EAC3 fixtures produce the planned playable MP4 audio", { timeout: 45_000 }, () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "lvl-audio-codecs-"));
  const codecs = [
    ["aac", "aac"], ["mp3", "libmp3lame"], ["opus", "libopus"],
    ["flac", "flac"], ["ac3", "ac3"], ["eac3", "eac3"],
  ];
  try {
    for (const [codec, encoder] of codecs) {
      const input = path.join(folder, `${codec}.mka`);
      const output = path.join(folder, `${codec}.mp4`);
      run(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "0.5", "-c:a", encoder, input]);
      const audio = planCompatibleAudio({ codec, channels: 1 }, { audioMode: "auto" });
      run(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", input,
        "-map", "0:a:0", "-c:a", audio.codec,
        ...(audio.codec === "copy" ? [] : ["-b:a", audio.bitRate, "-ac", String(audio.channels)]),
        "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", output]);
      const stream = JSON.parse(run(ffprobe.path, ["-v", "error", "-select_streams", "a:0",
        "-show_entries", "stream=codec_name,channels", "-of", "json", output])).streams?.[0];
      assert.equal(stream?.codec_name, audio.outputCodec, `${codec} output codec matches planned path`);
      assert.equal(stream?.channels, 1);
    }
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
