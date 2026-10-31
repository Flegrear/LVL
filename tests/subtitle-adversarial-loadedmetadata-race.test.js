import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");

test("superseded loadedmetadata callback cannot seek a new load of the same media URL backwards", () => {
  const from = app.indexOf("function setMediaSource({");
  const to = app.indexOf("\nfunction updateCompatControls()", from);
  assert.ok(from >= 0 && to > from, "actual setMediaSource load implementation found");
  const metadataCallbacks = [];
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, { hidden: false, textContent: "", value: "", max: "" });
    return nodes.get(id);
  };
  const video = {
    dataset: { mode: "local" }, currentTime: 0, src: "", controls: true,
    pause() {}, load() {},
    addEventListener(name, handler, options) {
      if (name === "loadedmetadata") metadataCallbacks.push({ handler, once: options?.once });
    },
  };
  const state = { pendingSeek: null, mediaDurationMs: 0, loadingProgress: 0, transcodeBaseOffsetSeconds: 0 };
  const ctx = vm.createContext({
    video, state, frame: { classList: { add() {} } },
    $: node, window: { clearTimeout() {} }, URL,
    transcodePauseSnapshot: null,
    progressiveSeekController: null, progressiveMseLoader: null,
    progressiveContinueController: null, progressiveSeekOriginalMute: null,
    progressiveIndexStatus: 'unknown', progressiveWaitingSince: 0,
    progressiveTimelineVersion: 0, progressiveTimelineRangesFingerprint: '',
    closeProgressiveEventStream() {},
    renderProgressiveSeekableRanges() {},
    cancelTranscodeStart() {}, invalidateSubtitleFrameClock() {},
    clearAutoNext() {}, beginRecoveryWatch() {}, stopRecoveryWatch() {},
    drawPlayerDownloadMap() {}, revealPlayerControls() {},
    setPlayerLoading() {}, updateChapterButtons() {}, updatePlayerPreferenceButtons() {},
    renderSubtitleWorkspace() {}, formatTime: (ms) => String(ms),
  });
  vm.runInContext(app.slice(from, to), ctx);
  const open = vm.runInContext("setMediaSource", ctx);
  const src = "http://127.0.0.1:4273/api/torrents/session/files/1/stream";

  open({ src, title: "First load", status: "Playing", mode: "torrent-direct", startAtSeconds: 100 });
  assert.equal(metadataCallbacks.length, 1);
  // A second open to the *same URL*, but this time from the beginning, can
  // supersede the first before Chromium delivers loadedmetadata.
  open({ src, title: "Second load", status: "Playing", mode: "torrent-direct", startAtSeconds: 0 });
  assert.equal(state.currentMs, 0);
  for (const callback of metadataCallbacks) callback.handler();
  assert.equal(video.currentTime, 0,
    "the retired first load's resume seek must not reposition the second load to 100 seconds");
});

test("direct-torrent recovery reload also cancels an earlier deferred seek for the same session and file", () => {
  const from = app.indexOf("function reloadDirectTorrentAt(seconds)");
  const to = app.indexOf("\nasync function recoverPlayback(", from);
  assert.ok(from > 0 && to > from);
  const callbacks = [];
  const state = { currentSource: { sessionId: "same-session", fileIndex: 1 } };
  const video = {
    currentTime: 0,
    _src: "",
    get src() { return this._src; },
    set src(value) { this._src = new URL(value, "http://127.0.0.1:4273/").href; },
    load() {},
    play() { return Promise.resolve(); },
    addEventListener(type, callback) { if (type === "loadedmetadata") callbacks.push(callback); },
  };
  const ctx = vm.createContext({
    state, video, URL, location: { href: "http://127.0.0.1:4273/" },
    setPlayerLoading() {}, beginRecoveryWatch() {}, invalidateSubtitleFrameClock() {},
    formatTime: (ms) => String(ms),
  });
  vm.runInContext(app.slice(from, to), ctx);
  const reload = vm.runInContext("reloadDirectTorrentAt", ctx);
  reload(100);
  assert.equal(callbacks.length, 1);
  reload(0);
  for (const callback of callbacks) callback();
  assert.equal(video.currentTime, 0,
    "an old recovery callback cannot undo a newer same-URL restart requested from the beginning");
});

test("a rejected direct-stream restart triggers bounded recovery only for the current load", async () => {
  const from = app.indexOf("function reloadDirectTorrentAt(seconds)");
  const to = app.indexOf("\nasync function recoverPlayback(", from);
  assert.ok(from > 0 && to > from);
  const failures = [];
  const recoveries = [];
  const state = { currentSource: { sessionId: "live-session", fileIndex: 0 }, pendingSeek: null };
  const video = {
    _src: "", get src() { return this._src; },
    set src(src) { this._src = new URL(src, "http://127.0.0.1:4273/").href; },
    load() {},
    play() { return new Promise((_resolve, reject) => failures.push(reject)); },
    addEventListener() {},
  };
  const context = vm.createContext({
    state, video, URL, location: { href: "http://127.0.0.1:4273/" },
    recoveryPlaybackRequested: true,
    setPlayerLoading() {}, beginRecoveryWatch() {}, invalidateSubtitleFrameClock() {},
    formatTime: (ms) => String(ms),
    recoverPlayback: (reason) => { recoveries.push(reason); },
  });
  vm.runInContext(app.slice(from, to), context);
  const restart = vm.runInContext("reloadDirectTorrentAt", context);
  restart(100);
  restart(0); // New request supersedes first; first failure must not revive old media.
  failures[0](new Error("old stream rejected"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(recoveries, []);
  failures[1](new Error("current stream rejected"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(recoveries, ["error"], "current failed play is not silently stranded in a paused state");
});
