import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawnSync } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import { parseCopiedSeekOrigin, probeCopiedSeekOrigin } from "../backend/media/transcode-start.js";

function run(binary, args) {
  const process = spawnSync(binary, args, { encoding: "utf8", timeout: 20000, windowsHide: true, maxBuffer: 1000000 });
  assert.equal(process.status, 0, process.stderr || process.error?.message);
  return process.stdout;
}

test("strict parser returns actual earliest *displayed* decoded keyframe only", () => {
  const positive = { streams: [{ codec_name: "hevc", start_time: "0.000000" }], format: { start_time: "0.000000", duration: "14" },
    packets: [{ pts_time: "4.000000", flags: "K_" }, { pts_time: "4.120000", flags: "__" }],
    frames: [{ key_frame: 1, best_effort_timestamp_time: "4.000000" }, { best_effort_timestamp_time: "4.040000" }] };
  assert.deepEqual(parseCopiedSeekOrigin(positive, 5.37), { requestedStartSeconds: 5.37, effectiveStartSeconds: 4, prerollSeconds: 1.37, verified: true });
  for (const patch of [
    { packets: [{ pts_time: "4.000000", flags: "__" }] },
    { frames: [{ key_frame: 0, best_effort_timestamp_time: "4.000000" }] },
    { frames: [{ key_frame: 1, best_effort_timestamp_time: "4.040000" }] },
    { frames: [] }, { packets: [] },
    { streams: [{ codec_name: "vp9", start_time: "0" }] },
    { frames: [{ key_frame: 1, best_effort_timestamp_time: "-1.000000" }] },
    { packets: [{ pts_time: "-1.000000", flags: "K_" }] },
    { format: { start_time: "-1.000000", duration: "14" } },
    { streams: [{ codec_name: "h264", start_time: "2.500000" }] },
    { packets: [{ pts_time: "5.500000", flags: "K_" }] },
  ]) assert.throws(() => parseCopiedSeekOrigin({ ...positive, ...patch }, 5.37));
  assert.throws(() => parseCopiedSeekOrigin(positive, -1));
  assert.throws(() => parseCopiedSeekOrigin(positive, 15));
});

for (const fixture of [
  { codec: "libx264", ext: "mkv", settings: ["-bf", "2", "-x264-params", "scenecut=0"] },
  { codec: "libx264", ext: "mp4", settings: ["-bf", "2", "-x264-params", "scenecut=0"] },
  { codec: "libx265", ext: "mkv", settings: ["-pix_fmt", "yuv420p10le", "-x265-params", "pools=1:frame-threads=1:keyint=100:min-keyint=100:scenecut=0"] },
]) test(`bounded FFprobe frame lookup matches actual ${fixture.codec} ${fixture.ext} seek origin`, { timeout: 30000 }, async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "lvl-probe-seek-"));
  try {
    const input = path.join(folder, `source.${fixture.ext}`);
    run(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=128x72:rate=25", "-t", "10", "-c:v", fixture.codec,
      "-threads", "2", "-g", "100", "-keyint_min", "100", ...fixture.settings, input]);
    const result = await probeCopiedSeekOrigin({ source: input, requestedStartSeconds: 5.37, executable: ffprobeStatic.path });
    assert.deepEqual(result, { requestedStartSeconds: 5.37, effectiveStartSeconds: 4, prerollSeconds: 1.37, verified: true });
  } finally { fs.rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test("abort rejects before spawning a slow probe", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(probeCopiedSeekOrigin({ source: "unused", requestedStartSeconds: 8, executable: ffprobeStatic.path, signal: controller.signal }));
});

test("bounded FFprobe keyframe lookup uses localhost ranged HTTP and closes its reader", { timeout: 30000 }, async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "lvl-probe-http-"));
  let server;
  try {
    const input = path.join(folder, "source.mkv");
    run(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=128x72:rate=25", "-t", "10", "-c:v", "libx264",
      "-threads", "2", "-g", "100", "-keyint_min", "100", "-x264-params", "scenecut=0", input]);
    let rangedRequests = 0;
    server = http.createServer((req, res) => {
      const length = fs.statSync(input).size;
      const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "");
      const from = match ? Number(match[1]) : 0;
      const to = match && match[2] ? Math.min(length - 1, Number(match[2])) : length - 1;
      if (match) rangedRequests += 1;
      res.writeHead(match ? 206 : 200, {
        "Content-Type": "video/x-matroska", "Accept-Ranges": "bytes",
        "Content-Length": to - from + 1,
        ...(match ? { "Content-Range": `bytes ${from}-${to}/${length}` } : {}),
      });
      const stream = fs.createReadStream(input, { start: from, end: to });
      res.once("close", () => stream.destroy());
      stream.pipe(res);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const result = await probeCopiedSeekOrigin({
      source: `http://127.0.0.1:${server.address().port}/stream`,
      requestedStartSeconds: 5.37, executable: ffprobeStatic.path,
    });
    assert.equal(result.effectiveStartSeconds, 4);
    assert.equal(result.prerollSeconds, 1.37);
    assert.ok(rangedRequests >= 1, "FFprobe should read bounded, seekable byte ranges");
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("resource bounds reject overlarge FFprobe output or abort during probe", { timeout: 30000 }, async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "lvl-probe-budget-"));
  try {
    const input = path.join(folder, "source.mkv");
    run(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=128x72:rate=25", "-t", "10", "-c:v", "libx264",
      "-threads", "2", "-g", "100", "-keyint_min", "100", input]);
    await assert.rejects(probeCopiedSeekOrigin({ source: input, requestedStartSeconds: 5.37,
      executable: ffprobeStatic.path, maxOutputBytes: 32 }), (error) => error.statusCode === 422);
    const controller = new AbortController();
    const pending = probeCopiedSeekOrigin({ source: input, requestedStartSeconds: 5.37,
      executable: ffprobeStatic.path, signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, (error) => error.statusCode === 499);
  } finally {
    // On Windows the aborted FFprobe can still be closing its source handle
    // when the promise rejects; retry only this disposable fixture cleanup.
    fs.rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
