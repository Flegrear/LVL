import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { readFileSync as readText } from "node:fs";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const slice = (start, end) => {
  const a = app.indexOf(start);
  const b = app.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `Could not find ${start}`);
  return app.slice(a, b);
};

test("Direct and local playback seek instantly within buffered ranges; missing ranges show loading", () => {
  const messages = [];
  const video = {
    dataset: { mode: "torrent-direct" },
    buffered: { length: 2, start: (i) => [0, 50][i], end: (i) => [35, 75][i] },
    currentTime: 3,
    duration: 100,
  };
  const context = vm.createContext({
    video,
    state: { mediaDurationMs: 100000, transcodeBaseOffsetSeconds: 0, currentMs: 3000 },
    frame: { classList: { contains: () => true } },
    absolutePlaybackSeconds: () => video.currentTime,
    clearBufferingTimer: () => messages.push("clear"),
    hideLoadingForBufferedSeek: () => messages.push("hide"),
    setPlayerLoading: (percent, title) => messages.push(`show:${title}:${percent}`),
    renderSubtitles() {}, updateCompatControls() {},
    formatTime: () => "01:20",
    scheduleTranscodeSeek: (target) => messages.push(`restart:${target}`),
    openProgressiveSeekAt: () => false,
    seekGapViaVerifiedIndexedOrNative: () => false,
    playerIsPlaying: () => true,
    loadMoreEmbeddedSubtitles: () => messages.push("refresh-embedded-captions"),
  });
  vm.runInContext(slice("function isPlayerTimeBuffered(seconds) {", "\nfunction hideLoadingForBufferedSeek()"), context);
  vm.runInContext(slice("function seekPlayerTo(seconds) {", "\nfunction seekPlayerBy("), context);
  const seek = vm.runInContext("seekPlayerTo", context);
  seek(20);
  assert.deepEqual(messages, ["clear", "hide"]);
  assert.equal(video.currentTime, 20);
  messages.length = 0;
  seek(44);
  assert.deepEqual(messages, ["show:Seeking:18"]);
  messages.length = 0;
  video.dataset.mode = "local";
  seek(60);
  assert.deepEqual(messages, ["clear", "hide"], "Local buffered seek is instant too");
  messages.length = 0;
  video.dataset.mode = "transcode";
  seek(90);
  assert.deepEqual(messages, ["restart:90", "refresh-embedded-captions"],
    "Transcode seeks start a new fragment and refresh captions without a native seeking event");
  assert.equal(vm.runInContext("isPlayerTimeBuffered(60)", context), false);
});

test("Branded loading progresses in small frames and creeps ahead of stage estimates without premature completion", () => {
  const vars = {};
  const classes = new Set();
  const overlay = {
    hidden: true,
    style: { setProperty: (key, val) => { vars[key] = val; } },
    classList: {
      toggle: (key, enabled) => enabled ? classes.add(key) : classes.delete(key),
      contains: (key) => classes.has(key),
    },
  };
  const brand = { hidden: false };
  const callbacks = new Map();
  const timers = new Map();
  let nextId = 0;
  const fakeWindow = {
    requestAnimationFrame(cb) { const id = ++nextId; callbacks.set(id, cb); return id; },
    cancelAnimationFrame(id) { callbacks.delete(id); },
    setTimeout(cb) { const id = ++nextId; timers.set(id, cb); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const context = vm.createContext({
    window: fakeWindow,
    recoveryDisplayPhase: "", renderRecoveryOverlay() {}, playerLoadingArtworkPending: false,
    state: { loadingProgress: 0, loadingDetail: "" },
    $: (selector) => ({
      "#video-loading": overlay,
      "#video-loading-brand": brand,
      "#video-loading-actions": { hidden: true },
      "#video-loading-title": { textContent: "" },
    })[selector],
    currentRecoveryKey: () => null, isNewSourceFramePending: () => false,
    frame: { classList: { remove() {} } },
  });
  vm.runInContext(slice("let playerLoadingHideTimer = 0;", "\nfunction updateLoadingTransferDetail(")
    + slice("function finishPlayerLoading() {", "\nfunction clearPlayerControlsHideTimer()"), context);
  const setLoading = vm.runInContext("setPlayerLoading", context);
  const finish = vm.runInContext("finishPlayerLoading", context);
  const tick = (time) => {
    for (const [id, callback] of [...callbacks]) {
      callbacks.delete(id);
      callback(time);
    }
  };
  setLoading(68, "Reading media");
  assert.equal(vars["--load-fill"], "0%", "Does not jump straight to 68%");
  for (let time = 16; time <= 1000; time += 16) tick(time);
  const oneSecond = Number(vars["--load-fill"].replace("%", ""));
  assert.ok(oneSecond > 12 && oneSecond < 25, `Gradual fill after one second: ${oneSecond}`);
  for (let time = 1016; time <= 5400; time += 16) tick(time);
  const plateau = Number(vars["--load-fill"].replace("%", ""));
  assert.ok(plateau > 68 && plateau < 92, `Progress creeps beyond a stalled stage: ${plateau}`);
  const logoBeforeRepeat = vars["--logo-fill"];
  setLoading(68, "Reading media");
  assert.equal(vars["--load-fill"], `${plateau.toFixed(2).replace(/\.00$/, "")}%`,
    "A repeated torrent stage must not reset presentation progress ahead of the stage");
  assert.equal(vars["--logo-fill"], logoBeforeRepeat,
    "Repeated peer/decoder status must not restart the colored logo sweep");
  for (let time = 5416; time <= 5656; time += 16) tick(time);
  assert.notEqual(vars["--logo-fill"], logoBeforeRepeat, "the branded logo continues moving while loading is stalled");
  setLoading(4, "Next source");
  assert.equal(vars["--load-fill"], "0%", "New source clears previous logo progress");
  tick(5672);
  assert.ok(Number(vars["--load-fill"].replace("%", "")) < 2);
  // The first harness also covers artwork-free completion; the following
  // harness separately checks the full colored-logo finish sequence.
  brand.hidden = true;
  finish();
  assert.equal(timers.size, 1);
  for (let time = 5688; time <= 6200; time += 16) tick(time);
  assert.equal(vars["--load-fill"], "100%", "Completed playback finishes the logo reveal");
  for (const callback of timers.values()) callback();
  assert.equal(overlay.hidden, true);
  assert.equal(callbacks.size, 0, "No animation remains after playback starts");
});

test("Logo color wipes independently from stage progress and never finishes before playback is ready", () => {
  const css = readText(new URL("../frontend/styles/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.video-loading-brand__ghost\s*\{[^}]*filter:grayscale\(1\)/);
  assert.match(css, /\.video-loading-brand__fill\s*\{[^}]*clip-path:inset\(0 calc\(100% - var\(--logo-fill,0%\)\) 0 0\)/);
  const vars = {};
  const frames = new Map();
  const timers = new Map();
  let id = 0;
  const overlay = {
    hidden: true,
    style: { setProperty: (key, value) => { vars[key] = value; } },
    classList: { toggle() {}, contains: () => false },
  };
  const brand = { hidden: false };
  const context = vm.createContext({
    recoveryDisplayPhase: "", renderRecoveryOverlay() {}, playerLoadingArtworkPending: false,
    window: {
      requestAnimationFrame(cb) { frames.set(++id, cb); return id; },
      cancelAnimationFrame(key) { frames.delete(key); },
      setTimeout(cb) { timers.set(++id, cb); return id; },
      clearTimeout(key) { timers.delete(key); },
    },
    state: { loadingProgress: 0, loadingDetail: "" },
    $: (key) => ({ "#video-loading": overlay, "#video-loading-brand": brand,
      "#video-loading-actions": { hidden: true }, "#video-loading-title": { textContent: "" } })[key],
    frame: { classList: { remove() {} } }, currentRecoveryKey: () => null,
    isNewSourceFramePending: () => false,
  });
  vm.runInContext(slice("let playerLoadingHideTimer = 0;", "\nfunction updateLoadingTransferDetail(")
    + slice("function finishPlayerLoading() {", "\nfunction clearPlayerControlsHideTimer()"), context);
  const tick = (time) => { for (const [key, cb] of [...frames]) { frames.delete(key); cb(time); } };
  vm.runInContext('setPlayerLoading(94, "Transcoding")', context);
  for (let t = 16; t <= 1600; t += 16) tick(t);
  const before = Number(vars["--logo-fill"].replace("%", ""));
  assert.ok(before > 20 && before < 40, `logo reveals gradually despite stage estimate already at 94: ${before}`);
  assert.notEqual(Number(vars["--load-fill"].replace("%", "")), before, "logo wipe is not bound to a jumped loading percentage");
  for (let t = 1616; t <= 6800; t += 16) tick(t);
  const late = Number(vars["--logo-fill"].replace("%", ""));
  assert.ok(late >= 0 && late < 100, "indeterminate color wipe never claims loading is complete");
  for (let t = 6816; t <= 8816; t += 16) tick(t);
  const cycling = Number(vars["--logo-fill"].replace("%", ""));
  assert.ok(Math.abs(cycling - late) >= 15, "loading logo stays animated after a long buffering stall");
  vm.runInContext("finishPlayerLoading()", context);
  for (const callback of [...timers.values()]) callback();
  assert.equal(overlay.hidden, false, "the colored wipe is allowed to finish after readiness");
  for (let t = 8832; t <= 11024; t += 16) tick(t);
  assert.equal(vars["--logo-fill"], "100%");
  for (const callback of [...timers.values()]) callback();
  assert.equal(overlay.hidden, true);
});
