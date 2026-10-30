import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import path from "node:path";
import vm from "node:vm";
import { createTranscodePlan, transcodeVideoFilter } from "../shared/media/media-compat.js";
import { pruneExitedTranscodes } from "../backend/media/transcode-slot-lifecycle.js";

const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
const from = server.indexOf("async function copiedSeekOrigin(");
const to = server.indexOf("\nfunction pruneMediaProbeCache()", from);
assert.ok(from >= 0 && to > from, "route must use real copied seek helpers in server.js");
const endpointSource = server.slice(from, to);

function harness({ probe, duration = 0, sessionState = "ready" } = {}) {
  const id = "01234567-89ab-cdef-0123-456789abcdef";
  const session = { id, state: sessionState, torrent: { files: [{ name: "show.mkv", length: 5000 }] } };
  const torrentSessions = new Map([[id, session]]);
  const responses = [];
  const calls = [];
  let probeCall = probe || (async ({ requestedStartSeconds, source }) => {
    calls.push({ requestedStartSeconds, source });
    return { requestedStartSeconds, effectiveStartSeconds: 4, prerollSeconds: requestedStartSeconds - 4, verified: true };
  });
  const context = vm.createContext({
    AbortController, Date, Number, String, path, port: 4173, ffprobePath: "ffprobe",
    VIDEO_EXTENSIONS: new Set([".mkv", ".mp4"]), MAX_TORRENT_VIDEO_BYTES: 20 * 1024 ** 3,
    MAX_COPIED_SEEK_PROBES: 2, MAX_COPIED_SEEK_SUBSCRIBERS: 16,
    MAX_COPIED_SEEK_CACHE_ENTRIES: 64, COPIED_SEEK_CACHE_TTL_MS: 600_000,
    torrentSessions, getCachedMediaProbe: () => duration ? { durationSeconds: duration } : null,
    probeCopiedSeekOrigin: (options) => probeCall(options),
    json: (res, status, body) => {
      res.status = status;
      res.body = body;
      responses.push({ status, body });
      res.writableEnded = true;
      res.emit("close");
    },
    methodNotAllowed: (res) => { res.status = 405; res.writableEnded = true; res.emit("close"); },
  });
  const localRequestRejectedStart = server.indexOf("function localRequestRejected(");
  const localRequestRejectedEnd = server.indexOf("\nfunction requestNativeUpdate(", localRequestRejectedStart);
  vm.runInContext(`${server.slice(localRequestRejectedStart, localRequestRejectedEnd)}\nlet activeCopiedSeekProbes = 0; const copiedSeekOriginCache = new Map(); const copiedSeekOriginInflight = new Map();\n${endpointSource}`, context);
  const call = async (start = "5.37", options = {}) => {
    const req = Object.assign(new EventEmitter(), { method: "GET", headers: { host: "127.0.0.1:4173" } }, options.request || {});
    const res = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false, status: 0, body: null });
    const url = new URL(`http://127.0.0.1:4173/api/torrents/${id}/files/0/transcode-start?start=${encodeURIComponent(start)}&video=${options.video || "copy"}`);
    await vm.runInContext("copiedSeekOriginEndpoint", context)(req, res, session, 0, url);
    return { res, req };
  };
  const begin = (start = "5.37") => {
    const req = Object.assign(new EventEmitter(), { method: "GET", headers: { host: "127.0.0.1:4173" } });
    const res = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false, status: 0, body: null });
    const url = new URL(`http://127.0.0.1:4173/api/torrents/${id}/files/0/transcode-start?start=${start}&video=copy`);
    const promise = vm.runInContext("copiedSeekOriginEndpoint", context)(req, res, session, 0, url);
    return { req, res, promise };
  };
  return { context, session, torrentSessions, responses, calls, call, begin, setProbe: (next) => { probeCall = next; } };
}

test("actual route contract returns copy preroll clock with no cached metadata and caches only verified results", async () => {
  assert.match(server, /\(stream\|transcode\|transcode-start\|metadata\|subtitle\|speech\|indexed\|indexed\\\/status\|remux-cache\\\/window\)/,
    "verified copied-seek preflight stays available alongside bounded cache-window route");
  assert.match(server, /if \(fileAction === "transcode-start"\)/);
  const h = harness();
  const first = await h.call();
  assert.equal(first.res.status, 200);
  assert.equal(first.res.body.requestedStartSeconds, 5.37);
  assert.equal(first.res.body.effectiveStartSeconds, 4);
  assert.equal(first.res.body.prerollSeconds, 1.37);
  assert.equal(first.res.body.verified, true);
  assert.equal(h.calls.length, 1);
  assert.match(h.calls[0].source, /^http:\/\/127\.0\.0\.1:4173\/api\/torrents\/.*\/files\/0\/stream$/);
  assert.equal((await h.call()).res.status, 200);
  assert.equal(h.calls.length, 1, "positive verified origin should be reused rather than re-reading torrent pieces");
  const zero = await h.call("0");
  assert.equal(zero.res.status, 200);
  assert.equal(zero.res.body.effectiveStartSeconds, 0);
  assert.equal(h.calls.length, 1, "zero seek has no preroll and should not spawn FFprobe");
});

test("rejects remote host, invalid or beyond-EOF requests, unsupported source and saturated probe budget", async () => {
  const h = harness({ duration: 10 });
  for (const start of ["-5", "NaN", "Infinity", "1e300", "", "9.8", "12"]) {
    const { res } = await h.call(start);
    assert.ok([400, 422].includes(res.status), `${start} => ${res.status}`);
  }
  assert.equal((await h.call("5.37", { video: "h264" })).res.status, 400);
  assert.equal((await h.call("5.37", { request: { headers: { host: "evil.example:4173" } } })).res.status, 403);
  assert.equal((await h.call("5.37", { request: { headers: { host: "127.0.0.1:4173", "sec-fetch-site": "cross-site" } } })).res.status, 403);
  assert.equal((await h.call("5.37", { request: { headers: { host: "127.0.0.1:4173", origin: "http://evil.example" } } })).res.status, 403);
  assert.equal((await h.call("5.37", { request: { method: "HEAD" } })).res.status, 405);
  h.session.torrent.files[0].name = "show.txt";
  assert.equal((await h.call()).res.status, 415);
  h.session.torrent.files[0].name = "show.mkv";
  vm.runInContext("activeCopiedSeekProbes = 2", h.context);
  assert.equal((await h.call()).res.status, 429);
});

test("cancelling an HTTP response aborts a pending lookup and never caches or emits stale output", async () => {
  let wasCancelled = false;
  const h = harness({ probe: ({ signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => { wasCancelled = true; reject(new Error("aborted")); }, { once: true });
  }) });
  const pending = h.begin();
  pending.res.destroyed = true;
  pending.res.emit("close");
  await pending.promise;
  assert.equal(wasCancelled, true);
  assert.equal(pending.res.status, 0);
  assert.equal(h.responses.length, 0);
  assert.equal(vm.runInContext("activeCopiedSeekProbes", h.context), 0);
  assert.equal(vm.runInContext("copiedSeekOriginCache.size", h.context), 0);
});

test("session replacement while probing rejects the stale video origin", async () => {
  let release;
  const h = harness({ probe: () => new Promise((resolve) => { release = resolve; }) });
  const pending = h.begin();
  h.torrentSessions.set(h.session.id, { ...h.session, torrent: { files: [] } });
  release({ requestedStartSeconds: 5.37, effectiveStartSeconds: 4, prerollSeconds: 1.37, verified: true });
  await pending.promise;
  assert.equal(pending.res.status, 410);
  assert.equal(vm.runInContext("copiedSeekOriginCache.size", h.context), 0);
});

test("FFmpeg transcode retains codec, requested speech tape and -t, and exports the verified effective base", () => {
  const transcode = server.slice(server.indexOf("async function transcodeTorrentFile("), server.indexOf("\nfunction boundedInteger(", server.indexOf("async function transcodeTorrentFile(")));
  assert.match(transcode, /effectiveStartSeconds = origin\.effectiveStartSeconds/);
  assert.match(transcode, /plan\.video\.mode === "copy" \? effectiveStartSeconds : startSeconds/);
  assert.match(transcode, /Number\(media\.durationSeconds\) - durationOrigin/);
  assert.match(transcode, /"X-Media-Effective-Start-Seconds": String\(effectiveStartSeconds\)/);
  assert.match(transcode, /speechTapeWriter\(session\.id, fileIndex, audioTrackOrder, startSeconds\)/,
    "the speech tape must still be keyed to requested time, not copied-video GOP preroll");
  assert.match(transcode, /"-noaccurate_seek"/);
  assert.match(transcode, /plan\.video\.mode === "copy" \? \["-c:v", "copy"\]/);
  assert.doesNotMatch(transcode, /plan\.video\.mode === "copy"[^\n]+\["-c:v", "libx264"\]/,
    "no silent HDR codec downgrade is allowed");
});

function transcodeHarness(h, { noCachedMetadata = false, hdr = false } = {}) {
  const media = {
    durationSeconds: 10,
    video: hdr ? { codec: "hevc", pix_fmt: "yuv420p10le", color_transfer: "smpte2084", width: 128, height: 72 }
      : { codec: "h264", pix_fmt: "yuv420p", width: 128, height: 72 },
    audioTracks: [{ codec: "ac3", channels: 2 }, { codec: "ac3", channels: 2 }],
  };
  let created = 0;
  const spawned = [];
  const tapeCalls = [];
  Object.assign(h.context, {
    createTranscodePlan, transcodeVideoFilter, MAX_TRANSCODE_JOBS: 2,
    SPEECH_SAMPLE_RATE: 16000,
    activeTranscodes: new Set(), pruneExitedTranscodes, ffmpegPath: "ffmpeg", probeTorrentFile: async () => media,
    getCachedMediaProbe: () => noCachedMetadata ? null : media,
    rejectOversizeVideo: () => false, scheduleSessionExpiry: () => {}, trackOpenStream: () => {},
    videoTranscodeEncoder: async () => "libx264", hardwareVideoEncodingArgs: () => ["-c:v", "libx264"],
    speechTapeWriter: (sessionId, index, audio, start) => {
      tapeCalls.push({ sessionId, index, audio, start });
      return { push() {}, end() {} };
    },
    spawn: (_file, args) => {
      created += 1;
      const ffmpeg = new EventEmitter();
      ffmpeg.killed = false;
      ffmpeg.kill = () => { ffmpeg.killed = true; };
      ffmpeg.stderr = new EventEmitter();
      ffmpeg.stdout = Object.assign(new EventEmitter(), { pipe: (res) => { res.piped = true; } });
      ffmpeg.stdio = [null, ffmpeg.stdout, ffmpeg.stderr, new EventEmitter()];
      spawned.push({ args, ffmpeg });
      return ffmpeg;
    },
  });
  const start = server.indexOf("async function transcodeTorrentFile(");
  const end = server.indexOf("\nfunction boundedInteger(", start);
  vm.runInContext(server.slice(start, end), h.context);
  const call = async (params = "start=9.37&video=copy&audio=1") => {
    const req = Object.assign(new EventEmitter(), { method: "GET", headers: { host: "127.0.0.1:4173" } });
    const res = Object.assign(new EventEmitter(), {
      destroyed: false, writableEnded: false, status: 0, body: null, headers: null,
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      flushHeaders() {}, end() { this.writableEnded = true; }, destroy() { this.destroyed = true; },
    });
    const url = new URL(`http://127.0.0.1:4173/api/torrents/${h.session.id}/files/0/transcode?${params}`);
    await vm.runInContext("transcodeTorrentFile", h.context)(req, res, h.session, 0, url);
    return { res, req };
  };
  return { call, spawned, tapeCalls, media, get created() { return created; } };
}

test("preflight and copied HEVC HDR transcode preserve GOP preroll through EOF", async () => {
  const h = harness({ duration: 10 });
  let probed = 0;
  h.setProbe(async ({ requestedStartSeconds }) => {
    probed += 1;
    return { requestedStartSeconds, effectiveStartSeconds: 8, prerollSeconds: 1.37, verified: true };
  });
  const preflight = await h.call("9.37");
  assert.equal(preflight.res.status, 200);
  assert.equal(preflight.res.body.effectiveStartSeconds, 8);
  const player = transcodeHarness(h, { hdr: true });
  const { res } = await player.call("start=9.37&video=copy&audio=1&hevc=1");
  assert.equal(probed, 1, "transcode must reuse the already verified keyframe, not diverge from preflight");
  assert.equal(player.created, 1);
  assert.equal(res.status, 200);
  assert.equal(res.headers["X-Media-Start-Seconds"], "9.37");
  assert.equal(res.headers["X-Media-Effective-Start-Seconds"], "8");
  assert.equal(res.headers["X-Media-Video-Mode"], "copy");
  assert.equal(res.headers["X-Media-HDR-Output"], "pq");
  const args = player.spawned[0].args;
  const paired = (flag, value) => args.some((entry, index) => entry === flag && args[index + 1] === value);
  assert.ok(args.includes("-noaccurate_seek"));
  assert.ok(paired("-ss", "9.37"), "FFmpeg must still seek from the requested movie timestamp");
  assert.ok(paired("-c:v", "copy"), "explicit HEVC HDR must never downgrade to H264");
  assert.ok(paired("-map", "0:a:1?"), "selected second audio track must be retained");
  assert.ok(Math.abs(Number(args[args.indexOf("-t") + 1]) - 2) < 0.000001,
    "copied -t must include 1.37s of GOP preroll so audio is not truncated before video EOF");
  assert.equal(player.tapeCalls[0].start, 9.37, "speech tape stays on requested timeline");
  assert.equal(player.tapeCalls[0].audio, 1);
});

test("uncached media metadata still resolves correct selected audio track with verified copied seek", async () => {
  const h = harness();
  const player = transcodeHarness(h, { noCachedMetadata: true });
  await player.call("start=5.37&video=copy&audio=1");
  assert.equal(player.created, 1);
  assert.equal(player.tapeCalls[0].audio, 1);
  assert.ok(player.spawned[0].args.some((entry, index, args) => entry === "-map" && args[index + 1] === "0:a:1?"));
});

test("unverified copied seek refuses to launch FFmpeg or silently reencode", async () => {
  const h = harness();
  h.setProbe(async () => { throw Object.assign(new Error("No verified source frame"), { statusCode: 422 }); });
  const player = transcodeHarness(h, { hdr: true });
  const { res } = await player.call("start=5.37&video=copy&audio=1&hevc=1");
  assert.equal(res.status, 422);
  assert.equal(player.created, 0);
  assert.equal(player.tapeCalls.length, 0);
});
