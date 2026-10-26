import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import { parseSubtitle } from "../learning/browser/core.js";

test("embedded ASS tracks from MKV are converted to WebVTT and understood by the player", { timeout: 20000 }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lvl-embedded-ass-"));
  const subtitles = path.join(dir, "subtitles.srt");
  const video = path.join(dir, "episode.mkv");
  const run = (args) => spawnSync(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-nostdin", ...args], {
    encoding: "utf8", windowsHide: true, timeout: 12000, maxBuffer: 2 * 1024 * 1024,
  });
  try {
    writeFileSync(subtitles, "1\n00:00:00,300 --> 00:00:01,500\nHello there\n\n2\n00:00:02,000 --> 00:00:03,300\nSecond subtitle line\n\n3\n00:00:03,400 --> 00:00:03,800\n字幕テスト — español\n");
    const mux = run(["-f", "lavfi", "-i", "color=c=black:size=64x64:rate=5", "-i", subtitles,
      "-t", "4", "-map", "0:v:0", "-map", "1:0", "-c:v", "libx264", "-c:s", "ass", "-y", video]);
    assert.equal(mux.status, 0, mux.stderr);
    const extract = run(["-i", video, "-map", "0:1", "-f", "webvtt", "pipe:1"]);
    assert.equal(extract.status, 0, extract.stderr);
    assert.match(extract.stdout, /^WEBVTT/);
    const cues = parseSubtitle(extract.stdout, "embedded-preview");
    assert.equal(cues.length, 3);
    assert.equal(cues[0].text, "Hello there");
    assert.equal(cues[1].text, "Second subtitle line");
    assert.equal(cues[2].text, "字幕テスト — español", "embedded Japanese and accented characters survive MKV ASS→WebVTT decoding");
    // Streaming readers may receive a UTF-8 character split across bytes.
    // The player uses the same stateful decoder with { stream:true }.
    const decoder = new TextDecoder("utf-8");
    let streamed = "";
    for (const byte of Buffer.from(extract.stdout, "utf8")) streamed += decoder.decode(Uint8Array.of(byte), { stream: true });
    streamed += decoder.decode();
    assert.equal(parseSubtitle(streamed, "utf8-stream")[2].text, "字幕テスト — español");
    // Progressive import also accepts the first complete cue without waiting
    // for the rest of the video or subtitle track to finish.
    assert.equal(parseSubtitle(extract.stdout.split("Second subtitle line")[0], "embedded-preview").length, 1);
    const windowed = run(["-ss", "1.5", "-copyts", "-i", video,
      "-map", "0:1", "-t", "3", "-f", "webvtt", "pipe:1"]);
    assert.equal(windowed.status, 0, windowed.stderr);
    const windowedCues = parseSubtitle(windowed.stdout, "seeked");
    assert.ok(windowedCues.length > 0, windowed.stdout);
    assert.ok(windowedCues.some((cue) => Math.abs(cue.startMs - 2000) < 100), windowed.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
