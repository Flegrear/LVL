import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import { parseSubtitle } from "../learning/browser/core.js";

test("embedded ASS captions near a late video seek retain absolute timestamps", { timeout: 30_000 }, () => {
  const directory = mkdtempSync(path.join(tmpdir(), "lvl-subtitle-late-"));
  const video = path.join(directory, "episode.mkv");
  const subtitles = path.join(directory, "episode.srt");
  const run = (args) => spawnSync(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-nostdin", ...args], {
    encoding: "utf8", windowsHide: true, timeout: 18_000, maxBuffer: 2 * 1024 * 1024,
  });
  try {
    writeFileSync(subtitles,
      "1\n00:00:01,000 --> 00:00:02,000\nEarly line\n\n"
      + "2\n00:03:01,500 --> 00:03:02,500\nLate line\n\n"
      + "3\n00:03:10,000 --> 00:03:11,000\nAnother late line\n");
    const mux = run([
      "-f", "lavfi", "-i", "color=c=black:size=32x32:rate=1",
      "-i", subtitles, "-t", "210",
      "-map", "0:v:0", "-map", "1:0", "-c:v", "libx264", "-c:s", "ass", "-y", video,
    ]);
    assert.equal(mux.status, 0, mux.stderr);
    const extract = run([
      "-ss", "180", "-i", video, "-map", "0:1", "-t", "30",
      "-output_ts_offset", "180", "-f", "webvtt", "pipe:1",
    ]);
    assert.equal(extract.status, 0, extract.stderr);
    const cues = parseSubtitle(extract.stdout, "absolute");
    assert.ok(cues.some((cue) => cue.text.includes("Late line") && Math.abs(cue.startMs - 181500) < 200),
      `Late subtitle is available and timed at absolute playback: ${extract.stdout}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
