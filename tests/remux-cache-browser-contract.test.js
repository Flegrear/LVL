import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import path from "node:path";
import vm from "node:vm";
import { createTranscodePlan, transcodeVideoFilter } from "../shared/media/media-compat.js";
import { pruneExitedTranscodes } from "../backend/media/transcode-slot-lifecycle.js";

// A cached remux replay must remain the SAME browser contract as the live
// /transcode response: the video element owns a separate absolute movie clock,
// and subtitles unmute only after a verified presented target frame.
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const cancelBegin = app.indexOf("function cancelTranscodeStart(");
const cancelEnd = app.indexOf("\nfunction setPlayerMutePreference(", cancelBegin);
const begin = app.indexOf("async function openTranscodeAt(");
const end = app.indexOf("\nasync function restartTranscodeAt(", begin);
assert.ok(cancelBegin > 0 && cancelEnd > cancelBegin && begin > 0 && end > begin);

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function player({ preflight = null, copyVideo = true, paused = false } = {}) {
  const requests = [];
  const sources = [];
  const frames = new Map();
  const classes = new Set();
  const overlay = { aria: null,
    getAttribute: () => overlay.aria,
    setAttribute: (_name, value) => { overlay.aria = value; },
    removeAttribute: () => { overlay.aria = null; },
  };
  let frameId = 0;
  const source = { kind: "torrent", sessionId: "01234567-89ab-cdef-0123-456789abcdef", fileIndex: 2, sourceTag: "ep" };
  const context = { sessionId: source.sessionId, fileIndex: source.fileIndex,
    baseUrl: `/api/torrents/${source.sessionId}/files/2/transcode`,
    audioIndex: 1, copyVideo };
  const state = { currentSource: source, transcodeContext: context, selectedAudioTrack: 1,
    mediaDurationMs: 10000, currentMs: 0, pendingSeek: null, subtitlesVisible: true,
    transcodeBaseOffsetSeconds: 0 };
  const video = { paused, muted: false, src: "old-source", dataset: {},
    pause() { this.paused = true; },
    load() { sources.push(this.src); },
    play() { this.paused = false; return Promise.resolve(); },
    requestVideoFrameCallback(callback) { frames.set(++frameId, callback); return frameId; },
    cancelVideoFrameCallback(id) { frames.delete(id); },
    addEventListener() {}, removeEventListener() {},
  };
  const events = [];
  const ctx = vm.createContext({
    Number, String, Math, Date, AbortController, AbortSignal, URLSearchParams,
    state, video, frame: { classList: {
      add(value) { classes.add(value); }, remove(value) { classes.delete(value); },
    } },
    window: { setTimeout: () => 123, clearTimeout() {} },
    $: (selector) => selector === "#subtitle-overlay" ? overlay : null,
    playbackLoadRequestId: 1, audioSync: { key: "" },
    remuxMseCacheAllowed: false, closeRemuxMseSession() {},
    expectNewVideoFrame() {},
    transcodeQuery: (target, audio) => new URLSearchParams({
      start: target.toFixed(3), audio: String(audio), audioMode: "auto",
      video: copyVideo ? "copy" : "h264", hevc: "1",
    }),
    fetchJson: async (url, options) => {
      requests.push({ url, options });
      return preflight ? await preflight.promise : {
        requestedStartSeconds: 9.37, effectiveStartSeconds: 8, verified: true,
      };
    },
    formatTime: () => "00:09", setPlayerLoading() {},
    renderSubtitles() {}, updateCompatControls() {},
    invalidateSubtitleFrameClock() {},
    schedulePresentedSubtitleFrame() {},
    finishPlayerLoading() { events.push("visible"); },
    clearTranscodeSeekFrame() {},
    presentedSubtitleSeconds: () => null,
    absolutePlaybackSeconds: () => 9.37,
    scheduleAudioSync() {},
  });
  vm.runInContext(`let transcodeStartAttempt = null; let transcodeStartSerial = 0;
    let transcodePauseSnapshot = null; let subtitlePresentedFrame = null;
    ${app.slice(cancelBegin, cancelEnd)}
    ${app.slice(begin, end)}`, ctx);
  const open = vm.runInContext("openTranscodeAt", ctx);
  const present = (mediaTime) => {
    const [id, callback] = frames.entries().next().value || [];
    assert.ok(callback, "frame callback remains registered during verified preroll");
    frames.delete(id);
    callback(0, { mediaTime });
  };
  return { ctx, source, context, state, video, overlay, classes, requests, sources,
    events, frames, open, present };
}

test("existing remux /transcode URL, requested audio/HDR and absolute frame-gated subtitles survive transparent cache replay", async () => {
  const p = player();
  assert.equal(await p.open(9.37), true);
  assert.equal(p.requests.length, 1, "origin remains verified by independent copied-seek preflight");
  assert.match(p.requests[0].url, /\/files\/2\/transcode-start\?start=9\.370&video=copy$/);
  assert.equal(p.sources.length, 1);
  assert.match(p.sources[0], /\/files\/2\/transcode\?start=9\.370&audio=1&audioMode=auto&video=copy&hevc=1$/);
  assert.equal(p.state.transcodeBaseOffsetSeconds, 8);
  assert.equal(p.state.pendingSeek?.target, 9.37);
  assert.equal(p.video.muted, true, "preroll must not leak audio before the requested decoded frame");
  assert.equal(p.overlay.aria, "true", "two language subtitle layers remain hidden only during preroll");
  p.present(1.0); // Absolute 9s is before the requested 9.37s.
  assert.equal(p.video.muted, true);
  assert.equal(p.events.length, 0);
  p.present(1.38);
  assert.equal(p.video.muted, false);
  assert.equal(p.state.pendingSeek, null);
  assert.equal(p.events.length, 1);
  assert.equal(p.overlay.aria, null);
  assert.equal(p.state.subtitlesVisible, true);
});

test("obsolete copied-seek preflight cannot load a former source or change its audio/timebase", async () => {
  const preflight = deferred();
  const p = player({ preflight });
  const pending = p.open(9.37);
  assert.equal(p.requests.length, 1);
  p.state.currentSource = { ...p.source, sourceTag: "new episode" };
  preflight.resolve({ requestedStartSeconds: 9.37, effectiveStartSeconds: 8, verified: true });
  assert.equal(await pending, false);
  assert.equal(p.sources.length, 0);
  assert.equal(p.video.src, "old-source");
  assert.equal(p.state.transcodeBaseOffsetSeconds, 0);
});

test("reencoded video never asks for copied-keyframe preflight or attempts remux replay", async () => {
  const p = player({ copyVideo: false });
  assert.equal(await p.open(9.37), true);
  assert.equal(p.requests.length, 0);
  assert.match(p.sources[0], /video=h264/);
  assert.equal(p.video.dataset.mode, "transcode");
  assert.equal(p.state.transcodeBaseOffsetSeconds, 9.37);
});

// Execute the real server /transcode handler with fake media I/O. In particular,
// a fully validated disk replay must have exactly the same clock and codec
// headers as its live FFmpeg counterpart and never create another conversion.
const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
const handlerBegin = server.indexOf("async function transcodeTorrentFile(");
const handlerEnd = server.indexOf("\nfunction boundedInteger(", handlerBegin);
assert.ok(handlerBegin > 0 && handlerEnd > handlerBegin);

function transcode({ cache = "miss", hdr = true, codecMode = "copy" } = {}) {
  const source = { id: "01234567-89ab-cdef-0123-456789abcdef", infoHash: "private-verified-hash",
    torrent: { files: [{ name: "episode.mkv", length: 4096 }] } };
  const media = { durationSeconds: 10,
    video: hdr
      ? { codec: "hevc", pix_fmt: "yuv420p10le", color_transfer: "smpte2084", width: 128, height: 72 }
      : { codec: "h264", pix_fmt: "yuv420p", width: 128, height: 72 },
    audioTracks: [{ codec: "ac3", channels: 2 }, { codec: "ac3", channels: 2 }],
  };
  const replay = [];
  const spawns = [];
  const cacheLookups = [];
  const trackCalls = [];
  const closeCalls = [];
  const disk = {
    openSync(file, mode) {
      assert.equal(mode, "r");
      if (cache === "missing-file") throw new Error("Cache removed after lookup");
      assert.equal(file, "owned-cache.mp4");
      return 31;
    },
    fstatSync(fd) { assert.equal(fd, 31); return { size: cache === "wrong-size" ? 18 : 5000 }; },
    closeSync(fd) { closeCalls.push(fd); },
    createReadStream(file, { fd, autoClose }) {
      assert.equal(file, "owned-cache.mp4");
      assert.equal(fd, 31);
      assert.equal(autoClose, true);
      return Object.assign(new EventEmitter(), {
        pipe(res) { replay.push("cached-bytes-served"); res.piped = "cache"; return res; },
      });
    },
  };
  const remuxSegmentCache = {
    async openComplete(identity) {
      cacheLookups.push(identity);
      if (["miss", "disabled", "missing-file", "wrong-size"].includes(cache)) return null;
      return {
        bytes: 5000,
        handle: { createReadStream(options) {
          assert.equal(options.start, 0);
          assert.equal(options.end, 4999);
          assert.equal(options.autoClose, false);
          return new EventEmitter();
        } },
        async release() { closeCalls.push("lease released"); },
      };
    },
    begin(identity) {
      cacheLookups.push({ recording: true, ...identity });
      return null;
    },
  };
  const ctx = vm.createContext({
    Buffer, Number, Math, String, AbortController, path, fs: disk, port: 5000,
    VIDEO_EXTENSIONS: new Set([".mkv"]), MAX_TORRENT_VIDEO_BYTES: 20 * 1024 ** 3,
    MAX_TRANSCODE_JOBS: 2, SPEECH_SAMPLE_RATE: 16000,
    createTranscodePlan, transcodeVideoFilter,
    activeTranscodes: new Set(), pruneExitedTranscodes, ffmpegPath: "ffmpeg", playbackTrace: { captureToken: () => null },
    getCachedMediaProbe: () => media, probeTorrentFile: async () => media,
    rejectOversizeVideo: () => false,
    copiedSeekOrigin: async () => ({ effectiveStartSeconds: 8, verified: true }),
    videoTranscodeEncoder: async () => "libx264", hardwareVideoEncodingArgs: () => ["-c:v", "libx264"],
    remuxSegmentCache, scheduleSessionExpiry() {},
    pipeline: async (_readable, response) => { replay.push("cached-bytes-served"); response.piped = "cache"; },
    trackOpenStream(_session, res) { trackCalls.push(res); },
    json(res, status, body) { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); },
    speechTapeWriter() { return { push() {}, end() {} }; },
    spawn(_exe, args) {
      const child = new EventEmitter();
      child.killed = false;
      child.kill = () => { child.killed = true; };
      child.stdout = Object.assign(new EventEmitter(), {
        pipe(res) { res.piped = "live"; return res; },
      });
      child.stderr = new EventEmitter();
      child.stdio = [null, child.stdout, child.stderr, new EventEmitter()];
      spawns.push({ args, child });
      return child;
    },
  });
  vm.runInContext(server.slice(handlerBegin, handlerEnd), ctx);
  const request = async (query = null) => {
    const req = Object.assign(new EventEmitter(), { method: "GET" });
    const res = Object.assign(new EventEmitter(), {
      headers: null, status: 0, piped: null, destroyed: false, writableEnded: false,
      headersSent: false,
      writeHead(code, headers) { this.status = code; this.headers = headers; this.headersSent = true; },
      flushHeaders() {},
      end() { this.writableEnded = true; },
      destroy() { this.destroyed = true; },
    });
    const params = query ?? `start=9.37&audio=1&audioMode=auto&video=${codecMode}&hevc=1`;
    const url = new URL(`http://127.0.0.1:5000/api/torrents/${source.id}/files/0/transcode?${params}`);
    await vm.runInContext("transcodeTorrentFile", ctx)(req, res, source, 0, url);
    return res;
  };
  return { request, spawns, cacheLookups, trackCalls, replay, closeCalls };
}

test("complete same-plan remux hit serves full file without FFmpeg but preserves live timebase, audio, codec, HDR headers", async () => {
  const live = transcode({ cache: "miss" });
  const cached = transcode({ cache: "complete" });
  const liveRes = await live.request();
  const cachedRes = await cached.request();
  assert.equal(liveRes.status, 200);
  assert.equal(cachedRes.status, 200);
  assert.equal(liveRes.piped, "live");
  assert.equal(cachedRes.piped, "cache");
  assert.equal(live.spawns.length, 1);
  assert.equal(cached.spawns.length, 0, "a complete verified remux hit must not create a duplicate FFmpeg");
  assert.equal(cached.trackCalls.length, 1, "cache replay retains session lifetime accounting");
  assert.equal(cachedRes.headers["X-LVL-Remux-Cache"], "complete-hit");
  assert.equal(cachedRes.headers["Content-Length"], "5000");
  for (const name of [
    "Content-Type", "X-Blackline-Transcode", "X-Media-Start-Seconds", "X-Media-Effective-Start-Seconds",
    "X-Media-Video-Mode", "X-Media-Video-Source-Codec", "X-Media-Video-Output-Codec",
    "X-Media-Video-Keyframe-Seek", "X-Media-HDR-Source", "X-Media-HDR-Output",
    "X-Media-Audio-Mode", "X-Media-Audio-Channels", "X-Media-Audio-Output-Codec",
    "X-Media-Audio-Output-Bitrate", "X-Audio-Track-Index", "X-Media-Duration-Seconds",
  ]) assert.equal(cachedRes.headers[name], liveRes.headers[name], `${name} must not differ between cache and live`);
  assert.equal(cachedRes.headers["X-Media-Start-Seconds"], "9.37");
  assert.equal(cachedRes.headers["X-Media-Effective-Start-Seconds"], "8");
  assert.equal(cachedRes.headers["X-Audio-Track-Index"], "1");
  assert.equal(cachedRes.headers["X-Media-Video-Source-Codec"], "hevc");
  assert.equal(cachedRes.headers["X-Media-HDR-Output"], "pq");
  assert.equal(cached.cacheLookups[0].audioTrack, 1);
  assert.equal(cached.cacheLookups[0].effectiveStartSeconds, 8);
  assert.equal(cached.cacheLookups[0].sourceIdentity, "private-verified-hash");
});

test("cache miss, missing file and wrong-size file all fall back to untouched live transcode", async () => {
  for (const cache of ["miss", "disabled", "missing-file", "wrong-size"]) {
    const fixture = transcode({ cache });
    const res = await fixture.request();
    assert.equal(res.status, 200, cache);
    assert.equal(res.piped, "live", cache);
    assert.equal(fixture.spawns.length, 1, cache);
    assert.equal(res.headers["X-LVL-Remux-Cache"], undefined, cache);
    assert.equal(fixture.cacheLookups[0]?.audioTrack, 1, cache);
  }
});

test("fallback video reencoding never looks up or replays a copied-HDR cache", async () => {
  const fixture = transcode({ cache: "complete", hdr: false, codecMode: "h264" });
  const res = await fixture.request("start=9.37&audio=1&video=h264");
  assert.equal(res.piped, "live");
  assert.equal(fixture.spawns.length, 1);
  assert.equal(fixture.cacheLookups.length, 0);
  assert.equal(res.headers["X-Media-Video-Mode"], "h264");
});
