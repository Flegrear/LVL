import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
const serverTranscode = server.slice(server.indexOf("async function transcodeTorrentFile("), server.indexOf("\nfunction boundedInteger(", server.indexOf("async function transcodeTorrentFile(")));

function exec(binary, args, timeout = 15_000) {
  const result = spawnSync(binary, args, { windowsHide: true, timeout, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.error?.message || `exit ${result.status}`);
  return result.stdout;
}

function audioPacketGap(file) {
  const output = exec(ffprobeStatic.path, ["-v", "error", "-select_streams", "a:0",
    "-show_entries", "packet=pts_time", "-of", "csv=p=0", file]);
  const pts = output.split(/\r?\n/).map(Number).filter(Number.isFinite);
  assert.ok(pts.length >= 50, "enough audio frames to measure timestamps");
  return Math.max(...pts.slice(1).map((value, index) => value - pts[index]));
}

test("Seeked MKV video-copy + AAC remux retains continuous audio across the initial keyframe preroll", { timeout: 30_000 }, () => {
  assert.match(serverTranscode, /startSeconds > 0 && plan\.video\.mode === "copy" \? \["-noaccurate_seek"\]/,
    "actual server FFmpeg command must disable accurate seek only for copied video");
  assert.match(serverTranscode, /plan\.video\.mode === "copy"\s*\? \(plan\.video\.tag/,
    "preserve remux/video-copy path");
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "lvl-remux-seek-sync-"));
  const input = path.join(folder, "long-gop.mkv");
  try {
    // A 4-second GOP makes the discrepancy visible when seeking to 5.37s.
    // With accurate input seek, FFmpeg copies video from the 4s keyframe while
    // beginning converted audio at 5.37s, leaving a large AAC packet gap.
    exec(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=25",
      "-f", "lavfi", "-i", "sine=frequency=600:sample_rate=48000",
      "-t", "14", "-map", "0:v:0", "-map", "1:a:0",
      "-c:v", "libx264", "-threads", "2", "-preset", "ultrafast", "-g", "100",
      "-keyint_min", "100", "-sc_threshold", "0", "-pix_fmt", "yuv420p",
      "-c:a", "ac3", input]);

    const remux = (name, preserveKeyframePreroll) => {
      const file = path.join(folder, `${name}.mp4`);
      exec(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-nostdin",
        ...(preserveKeyframePreroll ? ["-noaccurate_seek"] : []),
        "-ss", "5.37", "-i", input, "-map", "0:v:0", "-map", "0:a:0",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "128k", "-ac", "2",
        "-af", "aresample=async=1", "-t", "5", "-avoid_negative_ts", "make_zero",
        "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", "-y", file]);
      return audioPacketGap(file);
    };
    const oldGap = remux("accurate-broken", false);
    const fixedGap = remux("keyframe-aligned", true);
    assert.ok(oldGap > 0.7, `fixture must reproduce an audio timestamp hole (${oldGap}s)`);
    assert.ok(fixedGap < 0.08, `audio must remain continuous alongside copied video (${fixedGap}s)`);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
