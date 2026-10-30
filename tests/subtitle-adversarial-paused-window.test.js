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
  const end = app.indexOf("\nfunction playerReadyRangeSeconds()", start);
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

test("a stale presented frame after pause/audio switch cannot strand newly enabled captions", () => {
  const start = app.indexOf("function visibleSubtitleClockSeconds() {");
  const end = app.indexOf("\nfunction schedulePresentedSubtitleFrame()", start);
  const renderStart = app.indexOf("function renderSubtitles() {");
  const renderEnd = app.indexOf("\nfunction trackLanguageName(", renderStart);
  assert.ok(start >= 0 && end > start && renderStart >= 0 && renderEnd > renderStart);
  const state = { currentMs: 2_000, subtitlesVisible: true, baseLanguage: "EN", targetLanguage: "EN",
    wordColoring: false, subtitleStyle: { romanization: false } };
  const track = { id: "english", language: "EN", visible: true,
    cues: [{ id: "at-resume", text: "Captions survive resume", startMs: 19_000, endMs: 23_000 }] };
  const overlay = { lines: [], set innerHTML(_text) { this.lines = []; },
    append(line) { this.lines.push(line); } };
  const memo = { key: "old frame" };
  let movieTime = 21;
  let displayedFrame = 2;
  const ctx = vm.createContext({ state, subtitleRenderMemo: memo,
    absolutePlaybackSeconds: () => movieTime, presentedSubtitleSeconds: () => displayedFrame,
    preferredSourceTracks: () => [track], activeTrack: () => track,
    getActiveCue: (item) => item.cues.find((cue) => state.currentMs >= cue.startMs && state.currentMs <= cue.endMs) || null,
    comparisonCueForTrack: (item) => item.cues.find((cue) => state.currentMs >= cue.startMs && state.currentMs <= cue.endMs) || null,
    $: () => overlay, video: { paused: true }, learningEnabled: false, learningRevision: 0,
    normalizeTrackLanguage: (language) => language, isRomanizableLanguage: () => false,
    document: { createElement: () => ({}) },
  });
  vm.runInContext(app.slice(start, end) + app.slice(renderStart, renderEnd), ctx);
  vm.runInContext("refreshSubtitleClockForInteraction(); renderSubtitles()", ctx);
  assert.equal(state.currentMs, 21_000);
  assert.deepEqual(overlay.lines.map((line) => line.textContent), ["Captions survive resume"]);
  state.subtitlesVisible = false;
  vm.runInContext("renderSubtitles()", ctx);
  assert.equal(overlay.lines.length, 0);
  state.subtitlesVisible = true;
  vm.runInContext("refreshSubtitleClockForInteraction(); renderSubtitles()", ctx);
  assert.deepEqual(overlay.lines.map((line) => line.textContent), ["Captions survive resume"],
    "hide/show while paused must immediately repaint the current cue");
  displayedFrame = 21.15;
  movieTime = 21.5;
  assert.equal(vm.runInContext("visibleSubtitleClockSeconds()", ctx), 21.15,
    "a fresh presented frame still takes priority over audio currentTime");
});
