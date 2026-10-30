import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const eventStart = app.indexOf('video.addEventListener("play", () => {');
const eventEnd = app.indexOf('$("#compat-play").addEventListener("click",', eventStart);
const recoveryStart = app.indexOf('async function recoverPlayback(reason = "error")');
const recoveryGuardEnd = app.indexOf("  const alternatives =", recoveryStart);
const resumeStart = app.indexOf("function resumePlayback() {");
const resumeEnd = app.indexOf("\nfunction togglePlayback() {", resumeStart);
assert.ok(eventStart > 0 && eventEnd > eventStart);
assert.ok(recoveryStart > 0 && recoveryGuardEnd > recoveryStart);
assert.ok(resumeStart > 0 && resumeEnd > resumeStart);

function eventsFixture() {
  const handlers = new Map();
  const attempts = [];
  const pendingTimers = [];
  let now = 1_000_000;
  const video = {
    paused: true, readyState: 4, error: null,
    dataset: { mode: "transcode" },
    addEventListener(name, handler) { handlers.set(name, handler); },
  };
  const state = { pendingSeek: null, loadingProgress: 100 };
  const overlay = { hidden: true };
  const context = vm.createContext({
    video, state, recoveryBusy: false, recoveryDisplayPhase: "", recoveryWaitingSince: null,
    isNewSourceFramePending: () => false, fallbackActiveRemuxMseToNative: () => false,
    recoveryPlaybackRequested: false,
    recoveryPauseSerial: 0,
    window: { setTimeout(callback, delay) { pendingTimers.push({ callback, at: now + delay }); } },
    HTMLMediaElement: { HAVE_CURRENT_DATA: 2 },
    $: (selector) => selector === "#video-loading" ? overlay : { textContent: "" },
    resetRecoveryDisplay() {}, setPlayerLoading() {},
    resyncTranscodeAfterLongPause() { return false; },
    noteTranscodePause() {}, clearBufferingTimer() {},
    refreshSubtitleClockForInteraction() {}, renderSubtitles() {},
    recordWatchProgress() {}, updateCompatControls() {},
    scheduleBufferingIndicator() {},
    currentRecoveryKey: () => "library:0",
    recoverPlayback(reason) { attempts.push(reason); },
    frame: { classList: { remove() {} } },
    Date: { now: () => now },
  });
  vm.runInContext(app.slice(eventStart, eventEnd), context);
  return {
    video, handlers, attempts,
    emit: (name) => handlers.get(name)?.(),
    advance(ms) {
      now += ms;
      for (const timer of pendingTimers.splice(0)) {
        if (timer.at <= now) timer.callback();
        else pendingTimers.push(timer);
      }
    },
  };
}

test("a media error during a resume attempt still recovers if the browser marks the element paused", () => {
  const f = eventsFixture();
  f.video.paused = false;
  f.emit("play");
  f.advance(5 * 60_000);
  f.video.paused = true;
  f.video.error = { code: 2 }; // Network error while resuming after a long idle pause.
  f.emit("pause"); // Some browsers emit pause as part of a failed media load.
  f.emit("error");
  assert.deepEqual(f.attempts, ["error"]);
});

test("an explicit pause suppresses late idle errors even after five minutes", () => {
  const f = eventsFixture();
  f.video.paused = false;
  f.emit("play");
  f.video.paused = true;
  f.emit("pause"); // Clean user Pause with no media error.
  f.advance(5 * 60_000);
  f.video.error = { code: 2 };
  f.emit("error");
  assert.deepEqual(f.attempts, []);
});

test("an error arriving after pause but before the browser populates MediaError remains recoverable", () => {
  const f = eventsFixture();
  f.video.paused = false;
  f.emit("play");
  f.video.paused = true;
  f.emit("pause"); // Failure-induced pause, error property is still unset.
  f.advance(100);
  f.video.error = { code: 2 };
  f.emit("error");
  f.advance(1_000); // Deferred pause check must not invalidate an error recovery.
  assert.deepEqual(f.attempts, ["error"]);
});

test("native Pause clears its intent after the grace period and superseded pauses cannot clear a newer Play", () => {
  const f = eventsFixture();
  f.video.paused = false;
  f.emit("play");
  f.video.paused = true;
  f.emit("pause");
  f.video.paused = false;
  f.emit("play"); // Earlier pause timer must be ignored.
  f.video.paused = true;
  f.advance(1_100);
  f.video.error = { code: 2 };
  f.emit("error");
  assert.deepEqual(f.attempts, ["error"]);

  const clean = eventsFixture();
  clean.video.paused = false;
  clean.emit("play");
  clean.video.paused = true;
  clean.emit("pause");
  clean.advance(1_100);
  clean.video.error = { code: 2 };
  clean.emit("error");
  assert.deepEqual(clean.attempts, [], "Native Pause should not recover from later unrelated errors");
});

test("a transient 429-like transcode response can recover when surfaced as media error code 4", () => {
  const f = eventsFixture();
  f.video.paused = false;
  f.emit("play");
  f.advance(5 * 60_000);
  f.video.paused = true;
  f.video.error = { code: 4 }; // Browsers can report an HTTP media rejection as source unsupported.
  f.emit("error");
  assert.deepEqual(f.attempts, ["error"]);
});

test("an error before any Play intent does not wake an intentionally idle player", () => {
  const f = eventsFixture();
  f.video.error = { code: 4 };
  f.emit("error");
  assert.deepEqual(f.attempts, []);
});

test("explicit Resume records intent even when play() rejects before a play event", async () => {
  let calls = 0, recoveries = 0;
  const ctx = vm.createContext({
    linePreview: { pending: false, active: false, preventBackgroundPlayback: false },
    state: { pendingSeek: null },
    video: { play() { calls++; return Promise.reject(new Error("network resume failed")); } },
    resyncTranscodeAfterLongPause: () => false,
    playbackLoadRequestId: 1,
    fallbackActiveRemuxMseToNative: () => false,
    recoverPlayback: () => { recoveries++; },
    recoveryPlaybackRequested: false,
    recoveryPauseSerial: 0,
  });
  vm.runInContext(app.slice(resumeStart, resumeEnd), ctx);
  vm.runInContext("resumePlayback()", ctx);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(vm.runInContext("recoveryPlaybackRequested", ctx), true);
  assert.equal(vm.runInContext("recoveryPauseSerial", ctx), 1);
  assert.equal(recoveries, 1, "a rejected resume must not silently strand a paused player");
});

function recoveryGuardFixture({ paused, playingIntent, ended = false, visible = true, busy = false } = {}) {
  const context = vm.createContext({
    video: { paused, ended },
    state: { loadingProgress: 100, pendingSeek: null },
    recoveryPlaybackRequested: playingIntent,
    recoveryBusy: busy,
    currentRecoveryKey: () => "library:0",
    viewActive: () => visible,
    $: () => ({ classList: { contains: () => false } }),
    document: { pictureInPictureElement: null },
    window: { documentPictureInPicture: null },
    floatingDesktopWindow: null, floatingDesktopPending: false,
  });
  vm.runInContext(app.slice(recoveryStart, recoveryGuardEnd) + '  return "recover";\n}', context);
  return (reason) => vm.runInContext(`recoverPlayback(${JSON.stringify(reason)})`, context);
}

test("the actual recovery entrypoint respects Play intent, pause, visibility, and retry lock", async () => {
  assert.equal(await recoveryGuardFixture({ paused: true, playingIntent: true })("error"), "recover");
  assert.equal(await recoveryGuardFixture({ paused: true, playingIntent: false })("error"), undefined);
  assert.equal(await recoveryGuardFixture({ paused: true, playingIntent: false, ended: true })("early-eof"), "recover");
  assert.equal(await recoveryGuardFixture({ paused: true, playingIntent: true, visible: false })("error"), undefined);
  assert.equal(await recoveryGuardFixture({ paused: true, playingIntent: true, busy: true })("error"), undefined);
});
