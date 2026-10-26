import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");

test("a timeupdate during decoder stall cannot replace the last presented-frame subtitle clock with ahead-of-frame currentTime", () => {
  const from = app.indexOf('video.addEventListener("timeupdate", () => {');
  const to = app.indexOf('video.addEventListener("ended", () => {', from);
  assert.ok(from > 0 && to > from);
  let onTimeupdate;
  const lastPresentedMediaTime = 5;
  const state = { currentMs: lastPresentedMediaTime * 1000,
    transcodeBaseOffsetSeconds: 0, pendingSeek: null };
  const video = {
    currentTime: 7, seeking: false, paused: false, dataset: { mode: "torrent-direct" },
    addEventListener(type, callback) { if (type === "timeupdate") onTimeupdate = callback; },
  };
  const painted = [];
  vm.runInNewContext(app.slice(from, to), {
    state, video, learningEnabled: false,
    absolutePlaybackSeconds: () => video.currentTime,
    presentedSubtitleSeconds: () => lastPresentedMediaTime,
    refreshEpisodeSkipOptions() {}, markPlaybackMotion() {},
    prefetchUpcomingChapter() {}, loadMoreEmbeddedSubtitles() {},
    renderSubtitles() { painted.push(state.currentMs); },
    updateCompatControls() {}, checkAudioSyncCoverage() {}, recordWatchProgress() {},
  });
  assert.equal(typeof onTimeupdate, "function");
  onTimeupdate();
  assert.deepEqual(painted, [5_000],
    "timeupdate is the browser media clock, not proof the next decoder frame was presented");
});
