import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");

test("paused native seeking across an embedded subtitle window boundary starts loading its cues", () => {
  const from = app.indexOf('video.addEventListener("seeking", () => {');
  const to = app.indexOf('video.addEventListener("loadedmetadata",', from);
  assert.ok(from >= 0 && to > from);
  const events = new Map();
  const state = { currentMs: 2_000, pendingSeek: null };
  const video = { currentTime: 235, seeking: true, paused: true, dataset: { mode: "torrent-direct" },
    addEventListener(event, callback) { events.set(event, callback); } };
  let extractionChecks = 0;
  const ctx = vm.createContext({
    video, state,
    $: () => ({ hidden: true }),
    frame: { classList: { contains: () => true } },
    absolutePlaybackSeconds: () => video.currentTime,
    clearAutoNext() {}, isPlayerTimeBuffered: () => true,
    clearBufferingTimer() {}, hideLoadingForBufferedSeek() {},
    invalidateSubtitleFrameClock() {},
    renderSubtitles() {}, scheduleAudioSync() {},
    loadMoreEmbeddedSubtitles() { extractionChecks++; },
    audioSync: { key: "" },
    recoveryWaitingSince: null,
  });
  vm.runInContext(app.slice(from, to), ctx);
  assert.ok(events.has("seeking"));
  events.get("seeking")();
  assert.equal(state.currentMs, 235_000, "the clock advances despite pause and no timeupdate");
  assert.equal(extractionChecks, 1,
    "entering a new 180s embedded subtitle window while paused must schedule its cue extraction, not wait for Play");
});

test("speed changes and floating/PiP views retain media clock seconds, not wall-time-scaled subtitle offsets", () => {
  const start = app.indexOf("function absolutePlaybackSeconds() {");
  const end = app.indexOf("\nfunction playerReadyEndSeconds()", start);
  assert.ok(start >= 0 && end > start);
  const video = { currentTime: 35.25, playbackRate: 1, dataset: { mode: "transcode" } };
  const state = { pendingSeek: null, transcodeBaseOffsetSeconds: 180 };
  const ctx = vm.createContext({ state, video });
  vm.runInContext(app.slice(start, end), ctx);
  for (const rate of [0.5, 1, 1.5, 2]) {
    video.playbackRate = rate;
    assert.equal(vm.runInContext("absolutePlaybackSeconds()", ctx), 215.25,
      `subtitle absolute time must not be multiplied by ${rate}× speed`);
  }
  video.dataset.mode = "torrent-direct";
  assert.equal(vm.runInContext("absolutePlaybackSeconds()", ctx), 35.25);
  state.pendingSeek = { target: 225.75, wasPlaying: false };
  assert.equal(vm.runInContext("absolutePlaybackSeconds()", ctx), 225.75,
    "queued seek is already an absolute movie timestamp, including while paused");
  assert.match(app, /document\.pictureInPictureElement === video/,
    "native PiP retains the same media element instead of a second video clock");
});
