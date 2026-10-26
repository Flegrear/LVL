import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { parseSubtitle } from "../learning/browser/core.js";
import { defaultEmbeddedSubtitleTrack } from "../frontend/player/embedded-subtitle-default.js";
import {
  EMBEDDED_WINDOW_SECONDS, completedWebVttText, embeddedExtractionError, embeddedSubtitleSeekStart, embeddedTrackMatchesSource,
  mergeSubtitleWindows, subtitleWindowStart,
} from "../shared/subtitles/subtitle-stream.js";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const start = app.indexOf("const embeddedSubtitleImports = new Map();");
const end = app.indexOf("\nfunction loadMoreEmbeddedSubtitles(", start);
assert.ok(start >= 0 && end > start);
const importCode = app.slice(start, end);
const renderStart = app.indexOf("function renderSubtitles() {");
const renderEnd = app.indexOf("\nfunction trackLanguageName(", renderStart);
assert.ok(renderStart >= 0 && renderEnd > renderStart);

test("embedded cues arriving while playback continues repaint promptly, including after a seek", async () => {
  const source = { kind: "torrent", sessionId: "live", fileIndex: 1, sourceTag: "episode", fileName: "episode.mkv" };
  const state = {
    currentSource: source, tracks: [], currentMs: 1500,
    subtitlesVisible: true, targetLanguage: "JA", baseLanguage: "EN",
    subtitleStyle: { romanization: false }, wordColoring: false,
  };
  let now = 100000;
  let videoSeconds = 1.5;
  let nextTimer = 0;
  const timers = new Map();
  const overlay = { children: [], set innerHTML(_value) { this.children = []; }, append(node) { this.children.push(node); } };
  const nodes = { "#subtitle-overlay": overlay, "#media-status": { textContent: "" } };
  const window = {
    setTimeout: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
  };
  const advance = (durationMs) => {
    now += durationMs;
    for (;;) {
      const due = [...timers].find(([, timer]) => timer.at <= now);
      if (!due) break;
      timers.delete(due[0]);
      due[1].fn();
    }
  };
  const chunks = [
    "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nFirst caption\n\n",
    "00:00:05.000 --> 00:00:06.000\nCaption after seek\n\n",
  ];
  let readCount = 0;
  let complete;
  const video = { paused: false, pause: () => { throw new Error("Caption loading must not pause playback"); } };
  const context = vm.createContext({
    state, video, window, AbortController, TextDecoder, Date: { now: () => now },
    subtitleRenderMemo: { key: "" }, learningEnabled: false, learningRevision: 0,
    $: (selector) => nodes[selector],
    subtitleWindowStart, completedWebVttText, embeddedExtractionError, parseSubtitle,
    EMBEDDED_WINDOW_SECONDS, embeddedSubtitleSeekStart,
    mergeSubtitleWindows, embeddedTrackMatchesSource,
    absolutePlaybackSeconds: () => videoSeconds,
    presentedSubtitleSeconds: () => null,
    currentSourceTracks: () => state.tracks,
    preferredSourceTracks: () => state.tracks,
    activeTrack: () => state.tracks[0],
    getActiveCue: (track) => track?.cues?.find((cue) => state.currentMs >= cue.startMs && state.currentMs <= cue.endMs) || null,
    comparisonCueForTrack: (track) => track?.cues?.find((cue) => state.currentMs >= cue.startMs && state.currentMs <= cue.endMs) || null,
    normalizeTrackLanguage: () => "EN",
    isRomanizableLanguage: () => false,
    document: { createElement: () => ({ className: "", textContent: "" }) },
    embeddedSubtitleLabel: () => "English",
    subtitleFingerprint: (cues) => String(cues.length),
    addSubtitleText: (text, label, language) => {
      const track = { id: "live-track", label, language, visible: false, origin: "embedded",
        source, sourceTag: source.sourceTag, cues: parseSubtitle(text, "live-track") };
      state.tracks.push(track);
      return { track };
    },
    syncSelectedTrackForSource: () => { state.selectedTrackId = "live-track"; },
    renderEmbeddedSubtitleControls: () => {},
    renderSubtitleStyleControls: () => {},
    updatePlayerPreferenceButtons: () => {},
    saveCurrentEpisodeAnalysis: () => {},
    renderSubtitleWorkspace: () => {}, // The streamed path must paint without relying on a workspace rerender.
    fetch: async () => ({ ok: true, body: { getReader: () => ({
      read: async () => readCount < chunks.length
        ? { done: false, value: new TextEncoder().encode(chunks[readCount++]) }
        : new Promise((resolve) => { complete = () => resolve({ done: true }); }),
    }) } }),
  });
  vm.runInContext(`${importCode}\n${app.slice(renderStart, renderEnd)}`, context);
  const pending = vm.runInContext("importEmbeddedSubtitleTrack", context)(
    { streamIndex: 4, language: "eng" }, null, { activate: true, automatic: true });
  for (let attempt = 0; readCount < 2 && attempt < 5; attempt++) await new Promise(setImmediate);
  assert.equal(readCount, 2);
  assert.equal(video.paused, false);
  assert.equal(overlay.children[0]?.textContent, "First caption");

  // A user seek can change the media clock while a progressive response is open.
  // There is no timeupdate/pause/play event after this change in the test.
  videoSeconds = 5.5;
  advance(550);
  assert.equal(state.currentMs, 5500);
  assert.equal(overlay.children[0]?.textContent, "Caption after seek");
  assert.equal(state.tracks[0].cues.length, 2);
  assert.equal(video.paused, false);
  complete();
  assert.equal(await pending, true);
});

test("failed initial embedded extraction permits another automatic attempt for the current source", async () => {
  const state = { currentSource: { kind: "torrent", sessionId: "session", fileIndex: 2, sourceTag: "ep" }, subtitlesVisible: true };
  const media = { subtitleTracks: [{ streamIndex: 4, language: "eng", textBased: true }] };
  let calls = 0;
  let fail;
  const context = vm.createContext({
    state, defaultEmbeddedSubtitleTrack, EMBEDDED_WINDOW_SECONDS, preferredLanguagePair: () => ["EN"],
    normalizeTrackLanguage: () => "EN", currentSourceTracks: () => [],
    embeddedSubtitleImports: new Map(),
    embeddedSubtitleImportKey: (source, stream) => `${source.sessionId}:${source.fileIndex}:${source.sourceTag}:${stream}`,
    importEmbeddedSubtitleTrack: () => { calls++; return new Promise((resolve) => { fail = () => resolve(false); }); },
  });
  vm.runInContext(importCode.slice(importCode.indexOf("let initialEmbeddedSubtitleSource =")), context);
  vm.runInContext("enableDefaultEmbeddedSubtitles", context)(media, 0);
  vm.runInContext("enableDefaultEmbeddedSubtitles", context)(media, 0);
  assert.equal(calls, 1, "only one request is active at a time");
  fail();
  await new Promise(setImmediate);
  vm.runInContext("enableDefaultEmbeddedSubtitles", context)(media, 181);
  assert.equal(calls, 2, "a failed extraction no longer locks out another window");
});
