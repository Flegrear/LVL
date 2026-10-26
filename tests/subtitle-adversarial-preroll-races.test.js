import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const start = app.indexOf("let transcodeStartAttempt = null;");
const end = app.indexOf("\n// While a seek is waiting", start);
assert.ok(start > 0 && end > start, "real copied-video preroll controller is available");

function fixture({ lookup = null, rejectPlay = false } = {}) {
  const states = new Set();
  const timers = new Map();
  const frames = new Map();
  const loading = [];
  const lookups = [];
  const overlayAttrs = new Map();
  const subtitleOverlay = {
    getAttribute: (name) => overlayAttrs.get(name) ?? null,
    setAttribute: (name, value) => overlayAttrs.set(name, String(value)),
    removeAttribute: (name) => overlayAttrs.delete(name),
  };
  let nextTimer = 0;
  let nextFrame = 0;
  let plays = 0;
  const source = { sessionId: "session", fileIndex: 2 };
  const transcodeContext = { baseUrl: "/api/torrents/session/files/2/transcode", sessionId: "session",
    fileIndex: 2, audioIndex: 1, copyVideo: true };
  const state = { currentSource: source, transcodeContext, mediaDurationMs: 15_000,
    transcodeBaseOffsetSeconds: 0, selectedAudioTrack: 1, pendingSeek: null,
    currentMs: 0, loadingProgress: 100 };
  const video = {
    dataset: { mode: "transcode" }, paused: true, muted: false, volume: 0.75,
    src: "initial.mp4", currentTime: 0,
    pause() { this.paused = true; }, load() {},
    play() { plays++; if (rejectPlay) return Promise.reject(new Error("No decoded frame available"));
      this.paused = false; return Promise.resolve(); },
    requestVideoFrameCallback(fn) { const id = ++nextFrame; frames.set(id, fn); return id; },
    cancelVideoFrameCallback(id) { frames.delete(id); },
    addEventListener() {}, removeEventListener() {},
  };
  const frame = { classList: { add: (name) => states.add(name), remove: (name) => states.delete(name), contains: (name) => states.has(name) } };
  const ctx = vm.createContext({
    state, video, frame,
    $: (selector) => selector === "#subtitle-overlay" ? subtitleOverlay : null,
    window: { setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; },
      clearTimeout(id) { timers.delete(id); } },
    AbortController, AbortSignal, URLSearchParams,
    playbackLoadRequestId: 1, transcodePauseSnapshot: null,
    fetchJson: async (url, options) => {
      const request = { url, options };
      lookups.push(request);
      const requestedStartSeconds = Number(new URL(url, "http://127.0.0.1").searchParams.get("start"));
      return lookup ? lookup(request) : { requestedStartSeconds, effectiveStartSeconds: Math.floor(requestedStartSeconds / 4) * 4, verified: true };
    },
    transcodeQuery: (target, audio) => new URLSearchParams({ start: String(target), audio: String(audio), video: "copy" }),
    absolutePlaybackSeconds: () => state.pendingSeek ? state.pendingSeek.target : state.transcodeBaseOffsetSeconds + video.currentTime,
    setPlayerLoading: (...args) => loading.push(args),
    formatTime: (milliseconds) => String(milliseconds),
    renderSubtitles() {}, updateCompatControls() {}, finishPlayerLoading() {},
    audioSync: { key: "" }, scheduleAudioSync() {},
    setMediaSource() { throw new Error("initialization branch is not under test"); },
  });
  vm.runInContext(app.slice(start, end), ctx);
  return { state, video, frame, frames, timers, loading, lookups, source, transcodeContext,
    get plays() { return plays; },
    run: (expression) => vm.runInContext(expression, ctx),
    emitFrame(time, movieCurrentTime = time) {
      video.currentTime = movieCurrentTime;
      const entry = frames.entries().next().value;
      assert.ok(entry, "requestVideoFrameCallback must be scheduled");
      frames.delete(entry[0]);
      entry[1](0, { mediaTime: time });
    },
    watchdog() {
      this.fireDelay(45_000);
    },
    fireDelay(ms) {
      const entry = [...timers].find(([, timer]) => timer.ms === ms);
      assert.ok(entry, `expected an active ${ms}ms timer`);
      timers.delete(entry[0]);
      entry[1].fn();
    },
  };
}

test("copied seek preserves user mute choice and blocks presentation until a verified frame", async () => {
  const f = fixture();
  assert.equal(await f.run("openTranscodeAt(5.37, { wasPlaying: true })"), true);
  assert.equal(f.state.transcodeBaseOffsetSeconds, 4);
  assert.equal(f.video.muted, true);
  assert.equal(f.frame.classList.contains("is-sync-preroll"), true);
  assert.equal(f.state.pendingSeek?.priming, true);
  f.run("setPlayerMutePreference(true)");
  f.emitFrame(1.0);
  assert.equal(f.state.pendingSeek?.priming, true);
  f.emitFrame(1.38);
  assert.equal(f.state.pendingSeek, null);
  assert.equal(f.video.muted, true, "user-selected mute survives the safety mute");
  assert.equal(f.frame.classList.contains("is-sync-preroll"), false);
  assert.equal(f.frames.size, 1, "after preroll a single current-source frame callback keeps captions aligned");
  assert.equal(f.timers.size, 0);
});

test("failed play before the first frame retries behind the branded loader, then fails closed", async () => {
  const f = fixture({ rejectPlay: true });
  await f.run("openTranscodeAt(5.37, { wasPlaying: true })");
  await new Promise(setImmediate);
  assert.equal(f.state.pendingSeek?.priming, true);
  assert.equal(f.video.muted, true);
  assert.equal(f.timers.size, 2, "retry and watchdog are scheduled, with no runaway loop");
  assert.equal(f.loading.some(([percent]) => percent === 100), false);
  f.fireDelay(700);
  await new Promise(setImmediate);
  assert.equal(f.lookups.length, 2);
  assert.equal(f.state.pendingSeek?.priming, true);
  assert.equal(f.video.muted, true);
  f.fireDelay(1400);
  await new Promise(setImmediate);
  assert.equal(f.lookups.length, 3, "only two automatic retries are allowed");
  assert.equal(f.state.pendingSeek, null);
  assert.equal(f.video.muted, false);
  assert.equal(f.timers.size, 0);
  assert.equal(f.frames.size, 0, "obsolete hidden frame callbacks must be cancelled");
  assert.ok(f.loading.some(([percent, title]) => percent === 100 && title === "Video synchronization unavailable"));
});

test("hidden frame callbacks never reveal preroll; watchdog retries twice then terminates", async () => {
  const f = fixture();
  await f.run("openTranscodeAt(13, { wasPlaying: true })");
  assert.equal(f.frames.size, 1);
  assert.equal(f.video.muted, true);
  f.watchdog();
  assert.equal(f.state.pendingSeek?.priming, true);
  assert.equal(f.video.muted, true);
  assert.equal(f.loading.some(([percent]) => percent === 100), false);
  f.fireDelay(700);
  await new Promise(setImmediate);
  assert.equal(f.lookups.length, 2);
  assert.equal(f.frames.size, 1, "stale hidden callbacks are replaced, not multiplied");
  f.watchdog();
  assert.equal(f.loading.some(([percent]) => percent === 100), false);
  f.fireDelay(1400);
  await new Promise(setImmediate);
  assert.equal(f.lookups.length, 3);
  f.watchdog();
  assert.equal(f.video.paused, true);
  assert.equal(f.frames.size, 0);
  assert.equal(f.state.pendingSeek, null);
  assert.equal(f.frame.classList.contains("is-sync-preroll"), false);
  assert.equal(f.video.muted, false);
  assert.equal(f.timers.size, 0);
  assert.ok(f.loading.some(([percent, title]) => percent === 100 && title === "Video synchronization unavailable"));
});

test("superseded first seek cannot restore video, unmute or attach callbacks after a newer seek", async () => {
  const deferred = [];
  const f = fixture({ lookup: () => new Promise((resolve) => deferred.push(resolve)) });
  const obsolete = f.run("openTranscodeAt(5.37, { wasPlaying: true })");
  const current = f.run("openTranscodeAt(9.37, { wasPlaying: true })");
  assert.equal(f.lookups.length, 2);
  assert.equal(f.lookups[0].options.signal.aborted, true);
  deferred[1]({ requestedStartSeconds: 9.37, effectiveStartSeconds: 8, verified: true });
  assert.equal(await current, true);
  const wanted = f.video.src;
  deferred[0]({ requestedStartSeconds: 5.37, effectiveStartSeconds: 4, verified: true });
  assert.equal(await obsolete, false);
  assert.equal(f.video.src, wanted);
  assert.equal(f.state.transcodeBaseOffsetSeconds, 8);
  assert.equal(f.frames.size, 1, "only newest attempt owns a frame callback");
});

test("frame-verified preroll completion must not jump subtitle clock ahead of the presented target frame", async () => {
  const f = fixture();
  await f.run("openTranscodeAt(5.37, { wasPlaying: true })");
  // During an Edge stall currentTime can lead the frame actually shown.
  // Presenting target frame t=1.37 after keyframe t=4 is enough to unhide;
  // setting subtitle state to currentTime=3s would display later dialogue.
  f.emitFrame(1.37, 3);
  assert.equal(f.state.pendingSeek, null);
  assert.ok(Math.abs(f.state.currentMs - 5370) < 110,
    `caption clock must begin at the actually presented frame, got ${f.state.currentMs}ms`);
});

test("preroll reaching an early EOF fails closed without autoplaying the next chapter or recording progress", () => {
  const timeupdate = app.indexOf('video.addEventListener("timeupdate", () => {');
  const from = app.indexOf('video.addEventListener("ended", () => {', timeupdate);
  const to = app.indexOf('video.addEventListener("seeking",', from);
  assert.ok(timeupdate >= 0 && from > timeupdate && to > from);
  let endHandler;
  let autoNext = 0;
  let recorded = 0;
  const errors = [];
  const state = { pendingSeek: { priming: true, streamInstalled: true }, mediaDurationMs: 15_000 };
  const video = { paused: false, pause() { this.paused = true; }, addEventListener(event, handler) { if (event === "ended") endHandler = handler; } };
  vm.runInNewContext(app.slice(from, to), {
    state, video,
    cancelTranscodeStart() { state.pendingSeek = null; },
    setPlayerLoading: (...args) => errors.push(args),
    stopRecoveryWatch() {}, recordWatchProgress() { recorded++; },
    startAutoNext() { autoNext++; },
    absolutePlaybackSeconds: () => 14.4,
    recoverPlayback() { throw new Error("premature EOF must not reenter ordinary recovery"); },
  });
  assert.equal(typeof endHandler, "function");
  endHandler();
  assert.equal(autoNext, 0);
  assert.equal(recorded, 0);
  assert.equal(video.paused, true);
  assert.equal(errors[0]?.[0], 100);
});

test("a transient preroll media error keeps the logo; an exhausted one fails closed, without switching sources", () => {
  const from = app.indexOf('video.addEventListener("error", () => {');
  const to = app.indexOf('$("#compat-play").addEventListener', from);
  assert.ok(from >= 0 && to > from);
  for (const willRetry of [true, false]) {
    let handler;
    let recoveries = 0;
    let paused = 0;
    let retries = 0;
    const errors = [];
    const state = { pendingSeek: { priming: true, streamInstalled: true } };
    const video = { paused: false, error: new Error("stream closed"),
      pause() { paused++; this.paused = true; },
      addEventListener(event, callback) { if (event === "error") handler = callback; } };
    const transcodeStartAttempt = { retryTransient(reason) {
      assert.equal(reason, video.error);
      retries++;
      return willRetry;
    } };
    vm.runInNewContext(app.slice(from, to), {
      state, video, transcodeStartAttempt,
      cancelTranscodeStart() { state.pendingSeek = null; },
      setPlayerLoading: (...args) => errors.push(args),
      $: () => ({ hidden: false }),
      recoveryPlaybackRequested: true, recoveryBusy: false,
      currentRecoveryKey: () => "known-torrent-episode",
      recoverPlayback() { recoveries++; },
      frame: { classList: { remove() {} } },
    });
    assert.equal(typeof handler, "function");
    handler();
    assert.equal(retries, 1);
    assert.equal(recoveries, 0, "preroll failure must not switch source or trigger ordinary recovery");
    assert.equal(paused, willRetry ? 0 : 1);
    assert.equal(Boolean(state.pendingSeek), willRetry);
    assert.equal(errors.some(([percent]) => percent === 100), false === willRetry);
  }
});
