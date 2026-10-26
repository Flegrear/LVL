import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import { parseSubtitle } from "../learning/browser/core.js";

function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ["-v", "error", "-nostdin", ...args], { windowsHide: true });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("torrent-like HTTP byte-range MKV seeks yield subtitle cues on the original timeline", { timeout: 30000 }, async () => {
  const folder = mkdtempSync(path.join(tmpdir(), "lvl-http-ass-"));
  const subtitle = path.join(folder, "lines.srt");
  const video = path.join(folder, "episode.mkv");
  let server;
  const requestedRanges = [];
  try {
    writeFileSync(subtitle, [
      "1", "00:00:01,000 --> 00:00:02,000", "Early caption", "",
      "2", "00:02:55,000 --> 00:02:59,000", "Boundary caption", "",
      "3", "00:03:05,000 --> 00:03:07,000", "Seeked caption", "",
      "4", "00:03:11,000 --> 00:03:13,000", "Later caption", "",
    ].join("\n"));
    const mux = spawnSync(ffmpegPath, [
      "-v", "error", "-nostdin", "-f", "lavfi", "-i", "color=c=black:size=32x32:rate=1",
      "-i", subtitle, "-t", "200", "-map", "0:v:0", "-map", "1:0",
      "-c:v", "mpeg4", "-c:s", "ass", "-y", video,
    ], { windowsHide: true, timeout: 12000, encoding: "utf8" });
    assert.equal(mux.status, 0, mux.stderr);
    const bytes = readFileSync(video);
    server = http.createServer((req, res) => {
      const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "");
      let start = 0, end = bytes.length - 1;
      if (req.headers.range && !match) { res.writeHead(416); res.end(); return; }
      if (match) {
        start = Number(match[1]);
        end = match[2] ? Math.min(Number(match[2]), end) : end;
        if (start >= bytes.length || end < start) {
          res.writeHead(416, { "Content-Range": `bytes */${bytes.length}` });
          res.end();
          return;
        }
        requestedRanges.push({ start, end });
      }
      res.writeHead(match ? 206 : 200, {
        "Content-Type": "video/x-matroska",
        "Accept-Ranges": "bytes",
        "Content-Length": end - start + 1,
        ...(match ? { "Content-Range": `bytes ${start}-${end}/${bytes.length}` } : {}),
      });
      res.end(bytes.subarray(start, end + 1));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}/video`;
    // Input seek keeps HTTP range reads fast; output_ts_offset restores the
    // original timeline so a cue at 03:05 shows at 03:05, not at 00:05.
    // -ss before -i with -copyts used to exit 0 with an empty VTT here.
    const extracted = await ffmpeg([
      "-rw_timeout", "18000000", "-ss", "180", "-i", url,
      "-map", "0:1", "-t", "180", "-output_ts_offset", "180",
      "-f", "webvtt", "pipe:1",
    ]);
    assert.equal(extracted.code, 0, extracted.stderr);
    const cues = parseSubtitle(extracted.stdout, "http");
    assert.ok(cues.length, `HTTP seek should return cues; FFmpeg: ${extracted.stderr}`);
    assert.ok(cues.some((cue) => Math.abs(cue.startMs - 185000) < 500), JSON.stringify(cues));
    assert.ok(cues.some((cue) => Math.abs(cue.startMs - 191000) < 500), JSON.stringify(cues));
    assert.ok(cues.every((cue) => cue.startMs >= 180_000), "Seeked cues must not appear at time zero");
    assert.ok(requestedRanges.length > 0, "FFmpeg must exercise the torrent-like HTTP 206 byte-range path");
    assert.ok(requestedRanges.every(({ start, end }) => start >= 0 && end >= start && end < bytes.length));
    // The client now jumps near the target rather than always seeking from
    // the start of the enclosing 180s bucket. Backtrack 6s so an already
    // displayed cue that begins at 175s is not clipped at a seek to 181s.
    const quick = await ffmpeg([
      "-rw_timeout", "18000000", "-ss", "173", "-i", url,
      "-map", "0:1", "-t", "180", "-output_ts_offset", "173",
      "-f", "webvtt", "pipe:1",
    ]);
    assert.equal(quick.code, 0, quick.stderr);
    const quickCues = parseSubtitle(quick.stdout, "near-playhead");
    assert.ok(quickCues.some((cue) => cue.text === "Boundary caption" && Math.abs(cue.startMs - 175000) < 500),
      "focused 173s extraction retains the caption beginning before the seek at 179s");
    assert.ok(quickCues.some((cue) => cue.text === "Seeked caption" && Math.abs(cue.startMs - 185000) < 500),
      "offset seeking retains absolute subtitle timestamps after conversion");
    assert.equal(quickCues.some((cue) => cue.text === "Early caption"), false,
      "focused seek avoids extracting irrelevant earlier subtitle packets");
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    rmSync(folder, { recursive: true, force: true });
  }
});
