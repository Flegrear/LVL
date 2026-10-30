import test from "node:test";
import assert from "node:assert/strict";
import { createPlaybackTrace, parseFfmpegProgress } from "../backend/media/performance-trace.js";
import { createBrowserPlaybackTrace } from "../frontend/player/performance-trace.js";

const id = "00000000-0000-4000-8000-000000000001";

test("backend trace starts disabled, bounds events, expires and omits sensitive source data", () => {
  let time = 1000;
  const trace = createPlaybackTrace({ now: () => time });
  assert.equal(trace.snapshot(id), null);
  trace.start(id, 2);
  trace.plan(id, 2, { videoMode: "copy", videoReason: "hevc-client-opt-in-required", sourceVideoCodec: "hevc", audioMode: "stereo",
    audioReason: "compatibility", audioOutputCodec: "aac", audioOutputChannels: 2, fileName: "private-title.mkv", magnet: "magnet:secret" });
  for (let i = 0; i < 200; i++) trace.event(id, "sample", { sample: i });
  const snapshot = trace.snapshot(id);
  assert.equal(snapshot.plan.mode, "remux");
  assert.equal(snapshot.plan.videoReason, "hevc-client-opt-in-required");
  assert.equal(snapshot.events.length, 160);
  assert.ok(!JSON.stringify(snapshot).includes("private-title"));
  assert.ok(!JSON.stringify(snapshot).includes("magnet:"));
  assert.equal(snapshot.ffmpegCpuPercent, null);
  assert.equal(snapshot.playheadPiecePresent, null);
  time += 16 * 60_000;
  assert.equal(trace.snapshot(id), null);
});

test("reader timing is first-byte actual, reader cancellation is idempotent, and piece status is qualified", () => {
  let time = 0;
  const trace = createPlaybackTrace({ now: () => time });
  trace.start(id, 0);
  const reader = trace.reader(id, 0, { start: 1024, end: 2047 });
  assert.equal(trace.snapshot(id).activeReaderCount, 1);
  time += 35;
  reader.firstByte();
  reader.firstByte();
  reader.end("cancel");
  reader.end("complete");
  const snapshot = trace.snapshot(id, { torrent: { pieceLength: 1024, bitfield: { get: (piece) => piece === 3 }, numPeers: 2, downloadSpeed: 20 },
    file: { offset: 2048 }, fileIndex: 0 });
  assert.equal(snapshot.activeReaderCount, 0);
  assert.equal(snapshot.events.filter((event) => event.type === "reader-first-byte").length, 1);
  assert.equal(snapshot.events.find((event) => event.type === "reader-first-byte").ms, 35);
  assert.equal(snapshot.events.filter((event) => event.type === "reader-end").length, 1);
  assert.equal(snapshot.observedReaderPiecePresent, null);
  assert.equal(snapshot.playheadPiecePresent, null);
});

test("FFmpeg progress accepts only numeric speed and never leaks progress keys", () => {
  assert.equal(parseFfmpegProgress("speed= 1.32x"), 1.32);
  assert.equal(parseFfmpegProgress("speed=N/A"), null);
  assert.equal(parseFfmpegProgress("frame=25"), null);
  const trace = createPlaybackTrace();
  trace.start(id, 0);
  trace.progress(id, "speed= 1.32x");
  assert.equal(trace.snapshot(id).ffmpegSpeed, 1.32);
});

test("old reader callbacks cannot corrupt a restarted trace for the same session", () => {
  const trace = createPlaybackTrace();
  trace.start(id, 0);
  const old = trace.reader(id, 0, { start: 123, end: 456 });
  trace.start(id, 1);
  old.firstByte();
  old.end("cancel");
  assert.equal(trace.snapshot(id).activeReaderCount, 0);
  assert.deepEqual(trace.snapshot(id).events.map((event) => event.type), ["trace-started"]);
  const fresh = trace.reader(id, 1, { start: 0, end: 5 });
  fresh.firstByte();
  fresh.end("complete");
  assert.deepEqual(trace.snapshot(id).events.map((event) => event.type),
    ["trace-started", "reader-start", "reader-first-byte", "reader-end"]);
});

test("stale conversion token cannot overwrite a new trace's FFmpeg mode or speed", () => {
  const trace = createPlaybackTrace();
  trace.start(id, 0);
  const old = trace.captureToken(id, 0);
  assert.ok(old);
  trace.start(id, 1);
  const current = trace.captureToken(id, 1);
  assert.ok(current);
  assert.equal(trace.captureToken(id, 0), null);
  trace.plan(id, 1, { videoMode: "copy", sourceVideoCodec: "h264" }, current);
  trace.progress(id, "speed= 1.5x", current);
  trace.plan(id, 1, { videoMode: "h264", sourceVideoCodec: "bad" }, old);
  trace.progress(id, "speed= 99x", old);
  assert.equal(trace.snapshot(id).plan.mode, "remux");
  assert.equal(trace.snapshot(id).ffmpegSpeed, 1.5);
});

test("a superseded FFmpeg process cannot replace current speed within the same file trace", () => {
  const trace = createPlaybackTrace();
  trace.start(id, 0);
  const old = trace.captureToken(id, 0);
  trace.progress(id, "speed= 0.8x", old);
  assert.equal(trace.snapshot(id).ffmpegSpeed, 0.8);
  const next = trace.captureToken(id, 0);
  assert.equal(trace.snapshot(id).ffmpegSpeed, null);
  trace.plan(id, 0, { videoMode: "copy", sourceVideoCodec: "h264" }, next);
  trace.progress(id, "speed= 2x", next);
  trace.progress(id, "speed= 300x", old);
  trace.plan(id, 0, { videoMode: "h264", sourceVideoCodec: "hevc" }, old);
  assert.equal(trace.snapshot(id).ffmpegSpeed, 2);
  assert.equal(trace.snapshot(id).plan.mode, "remux");
});

test("untrusted codec/reason metadata and numeric NaN never enter the source-redacted trace", () => {
  const trace = createPlaybackTrace();
  trace.start(id, 0);
  trace.plan(id, 0, { videoMode: "copy", sourceVideoCodec: "private-title.mkv",
    audioReason: "magnet:?xt=urn:btih:private", audioMode: "stereo", audioOutputCodec: "aac",
    videoReason: "a".repeat(500), startSeconds: NaN, audioOutputChannels: -1 });
  const sample = trace.snapshot(id);
  assert.equal(sample.plan.sourceVideoCodec, null);
  assert.equal(sample.plan.audioReason, null);
  assert.equal(sample.plan.videoReason, null);
  assert.equal(sample.plan.startSeconds, null);
  assert.equal(sample.plan.audioOutputCodec, "aac");
  assert.ok(!JSON.stringify(sample).includes("private-title"));
  assert.ok(!JSON.stringify(sample).includes("magnet:"));
});

test("client serializes start/stop through rapid same-session file switches", async () => {
  const seen = [];
  const resolvers = [];
  const request = (_url, options) => {
    const payload = JSON.parse(options.body);
    seen.push(payload);
    return new Promise((resolve) => resolvers.push(() => resolve({ ok: true })));
  };
  const video = { addEventListener() {} };
  const trace = createBrowserPlaybackTrace(video, { request });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const first = trace.trackTorrent(id, 0);
  await flush(); // allow the queued first POST start to begin
  assert.deepEqual(seen.map((p) => [p.action, p.fileIndex]), [["start", 0]]);
  const next = trace.trackTorrent(id, 1);
  assert.equal(seen.length, 1); // never issue an overlapping stop
  resolvers.shift()();
  await first;
  await flush();
  assert.deepEqual(seen.map((p) => p.action), ["start", "stop"]);
  resolvers.shift()();
  await flush();
  assert.deepEqual(seen.map((p) => [p.action, p.fileIndex]),
    [["start", 0], ["stop", undefined], ["start", 1]]);
  resolvers.shift()();
  await next;
});

test("client requires a frame at the seek target, not merely the seeked event", async () => {
  let time = 0;
  const listeners = new Map();
  const callbacks = new Map();
  let count = 0;
  const video = {
    currentTime: 0, seeking: false, readyState: 4,
    addEventListener(name, cb) { (listeners.get(name) || (listeners.set(name, []), listeners.get(name))).push(cb); },
    requestVideoFrameCallback(cb) { callbacks.set(++count, cb); return count; },
    cancelVideoFrameCallback(index) { callbacks.delete(index); },
    getVideoPlaybackQuality() { return { totalVideoFrames: 17, droppedVideoFrames: 1 }; },
  };
  const emit = (type) => { for (const cb of listeners.get(type) || []) cb(); };
  const frame = (mediaTime) => {
    const [key, callback] = callbacks.entries().next().value;
    callbacks.delete(key);
    callback(0, { mediaTime });
  };
  const trace = createBrowserPlaybackTrace(video, { clock: () => time, request: async () => ({ ok: false }) });
  trace.selection({ playbackMode: "remux", playbackReason: "audio" });
  trace.newSource({ playbackMode: "transcode" });
  time = 30;
  emit("loadeddata");
  time = 95;
  frame(0);
  video.currentTime = 42;
  video.seeking = true;
  time = 110;
  emit("seeking");
  time = 120;
  video.seeking = false;
  emit("seeked");
  time = 150;
  frame(1); // stale buffered frame
  time = 200;
  frame(42.1);
  const result = await trace.snapshot();
  assert.equal(result.mode, "remux");
  assert.equal(result.firstPresentedFrameMs, 95);
  assert.deepEqual(result.events.filter((e) => e.type === "seek-presented-frame").map((e) => e.ms), [90]);
  assert.equal(result.droppedFrames, 1);
  assert.equal(result.firstAudibleOutputMs, null);
});
