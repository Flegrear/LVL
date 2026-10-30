import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");

test("native seek while paused repaints subtitles at the new absolute playback clock", () => {
  const from = app.indexOf('video.addEventListener("seeking", () => {');
  const to = app.indexOf('video.addEventListener("loadedmetadata",', from);
  assert.ok(from > 0 && to > from, "seeking listener remains registered with the media element");

  const callbacks = new Map();
  const state = { currentMs: 1_000, pendingSeek: null, transcodeBaseOffsetSeconds: 0 };
  const video = {
    currentTime: 65, duration: 180, paused: true, dataset: { mode: "torrent-direct" },
    addEventListener(type, callback) { callbacks.set(type, callback); },
  };
  const renders = [];
  const context = vm.createContext({
    state, video, isNewSourceFramePending: () => false,
    frame: { classList: { contains: () => true } },
    $: () => ({ hidden: true }),
    isPlayerTimeBuffered: () => true,
    clearAutoNext() {}, clearBufferingTimer() {}, hideLoadingForBufferedSeek() {},
    scheduleAudioSync() {}, audioSync: { key: "" },
    loadMoreEmbeddedSubtitles() {},
    invalidateSubtitleFrameClock() {},
    recoveryWaitingSince: null,
    absolutePlaybackSeconds: () => video.currentTime,
    renderSubtitles: () => renders.push(state.currentMs),
  });
  vm.runInContext(app.slice(from, to), context);
  assert.ok(callbacks.has("seeking"));

  callbacks.get("seeking")();
  assert.equal(video.paused, true, "native seeking need not resume playback");
  assert.deepEqual(renders, [65_000],
    "renderSubtitles must not reuse the old cue when media currentTime advances without a timeupdate event");
});
