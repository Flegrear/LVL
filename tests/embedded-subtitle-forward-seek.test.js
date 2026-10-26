import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { parseSubtitle } from "../learning/browser/core.js";
import { defaultEmbeddedSubtitleTrack } from "../frontend/player/embedded-subtitle-default.js";
import {
  EMBEDDED_WINDOW_SECONDS, completedWebVttText, embeddedExtractionError,
  embeddedSubtitleCovers, embeddedSubtitleCoverageEnd, embeddedSubtitleSeekStart, embeddedTrackMatchesSource,
  mergeSubtitleWindows, subtitleWindowStart,
} from "../shared/subtitles/subtitle-stream.js";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const begin = app.indexOf("const embeddedSubtitleImports = new Map();");
const end = app.indexOf("\nfunction renderEmbeddedSubtitleControls()", begin);
assert.ok(begin >= 0 && end > begin);
const importAndWindowCode = app.slice(begin, end);
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fixture({ initialTrack = true } = {}) {
  const source = {
    kind: "torrent", sessionId: "subtitle-session", fileIndex: 2,
    fileName: "episode.mkv", sourceTag: "episode", libraryId: "abc",
  };
  const subtitleMeta = { streamIndex: 4, textBased: true, language: "eng", codec: "ass" };
  const state = {
    currentSource: source, currentMediaProbe: { subtitleTracks: [subtitleMeta] },
    subtitlesVisible: true, tracks: [], currentMs: 2500, selectedTrackId: null,
  };
  const firstCue = { id: "original", startMs: 1000, endMs: 3000, text: "First window", trackId: "embedded" };
  if (initialTrack) {
    state.tracks.push({
      id: "embedded", source: { ...source }, sourceTag: source.sourceTag,
      origin: "embedded", cues: [firstCue], embeddedStreamIndex: 4,
      visible: true, embeddedCompletedWindows: [0], embeddedImportPartial: false,
    });
    state.selectedTrackId = "embedded";
  }
  const requests = [];
  const timers = new Map();
  let nextId = 0;
  let now = 123456789;
  const frame = { classList: { contains: () => true } };
  let lastPaint = null;
  const ctx = vm.createContext({
    state, frame, AbortController, TextDecoder, Date: { now: () => now },
    window: {
      setTimeout(fn, delay) { const id = ++nextId; timers.set(id, { fn, delay }); return id; },
      clearTimeout(id) { timers.delete(id); },
    },
    $: () => ({ textContent: "" }),
    subtitleWindowStart, completedWebVttText, embeddedExtractionError, embeddedTrackMatchesSource,
    EMBEDDED_WINDOW_SECONDS, embeddedSubtitleCovers, embeddedSubtitleCoverageEnd, embeddedSubtitleSeekStart,
    mergeSubtitleWindows, parseSubtitle, defaultEmbeddedSubtitleTrack,
    preferredLanguagePair: () => ["EN"],
    normalizeTrackLanguage: () => "EN",
    absolutePlaybackSeconds: () => state.currentMs / 1000,
    presentedSubtitleSeconds: () => null,
    currentSourceTracks: () => state.tracks,
    embeddedSubtitleLabel: () => "Embedded English",
    subtitleFingerprint: (cues) => String(cues.length),
    subtitleRenderMemo: { key: "" },
    addSubtitleText(text, label, language, opts) {
      const track = { id: "embedded", source: { ...source }, sourceTag: source.sourceTag,
        origin: opts.origin, cues: parseSubtitle(text, "embedded"), embeddedCompletedWindows: [],
        visible: false, label, language };
      state.tracks.push(track);
      return { track };
    },
    syncSelectedTrackForSource: () => { state.selectedTrackId = "embedded"; },
    renderSubtitleStyleControls() {},
    updatePlayerPreferenceButtons() {},
    renderEmbeddedSubtitleControls() {},
    renderSubtitleWorkspace() {},
    saveCurrentEpisodeAnalysis() {},
    renderSubtitles() {
      const active = state.tracks.find((track) => track.visible && track.cues?.some((cue) =>
        cue.startMs <= state.currentMs && state.currentMs <= cue.endMs));
      lastPaint = active?.cues?.find((cue) =>
        cue.startMs <= state.currentMs && state.currentMs <= cue.endMs)?.text || null;
    },
    fetch: async (url, { signal }) => {
      const start = Number(new URL(url, "http://localhost").searchParams.get("start"));
      let release;
      const response = new Promise((resolve) => { release = resolve; });
      const job = { start, signal, release, response };
      requests.push(job);
      return { ok: true, body: { getReader: () => {
        let first = true;
        return { read() {
          if (!first) return Promise.resolve({ done: true });
          first = false;
          return response;
        } };
      } } };
    },
  });
  vm.runInContext(importAndWindowCode, ctx);
  return {
    ctx, state, requests, timers,
    get lastPaint() { return lastPaint; },
    move(seconds, { seeked = false } = {}) {
      state.currentMs = seconds * 1000;
      vm.runInContext("loadMoreEmbeddedSubtitles", ctx)({ seeked });
    },
    enable(seconds) { state.currentMs = seconds * 1000; vm.runInContext("enableDefaultEmbeddedSubtitles", ctx)(state.currentMediaProbe, seconds); },
    complete(job, text) {
      job.release({ done: false, value: new TextEncoder().encode(
        `WEBVTT\n\n00:${String(Math.floor((job.start + 5) / 60)).padStart(2, "0")}:${String((job.start + 5) % 60).padStart(2, "0")}.000 --> 00:${String(Math.floor((job.start + 7) / 60)).padStart(2, "0")}:${String((job.start + 7) % 60).padStart(2, "0")}.000\n${text}\n\nNOTE LVL-EXTRACT-COMPLETE\n`) });
    },
    expire(job) { job.release({ done: true }); },
    advance(ms) { now += ms; },
  };
}

test("large forward seek preempts a still-open earlier subtitle extraction, without losing previous cues", async () => {
  const f = fixture();
  f.move(171); // Window zero is complete, so the next window may be prefetched.
  assert.deepEqual(f.requests.map((r) => r.start), [180]);
  const old = f.requests[0];
  f.move(545); // The old stream is still waiting for torrent pieces.
  assert.equal(old.signal.aborted, true, "outdated extraction must release the track immediately");
  assert.deepEqual(f.requests.map((r) => r.start), [180, 540]);
  assert.equal(f.state.tracks[0].cues[0].text, "First window");
  f.complete(f.requests[1], "Caption at new playback position");
  await tick();
  assert.equal(f.lastPaint, "Caption at new playback position");
  assert.equal(f.state.tracks[0].cues.length, 2);
  f.complete(old, "Stale, delayed old extraction");
  await tick();
  assert.equal(f.state.tracks[0].cues.length, 2, "aborted older stream cannot mutate the active track");
  assert.equal(f.state.tracks[0].visible, true);
  f.expire(f.requests[1]);
  await tick();
  assert.equal(f.state.tracks[0].embeddedCompletedWindows.includes(540), true);
  assert.equal(f.state.tracks[0].cues[0].text, "First window");
});

test("seek near a 180-second boundary loads the current missing window before speculative lookahead", () => {
  const f = fixture();
  f.state.tracks[0].embeddedCompletedWindows = [];
  f.move(175);
  assert.deepEqual(f.requests.map((r) => r.start), [0]);
  f.move(175);
  assert.equal(f.requests.length, 1, "same-window timeupdates never duplicate requests");
});

test("near-boundary seek does not replace the already-running next-window subtitle prefetch with a later gap", () => {
  const f = fixture();
  f.move(171);
  assert.deepEqual(f.requests.map((r) => r.start), [180]);
  const nextWindow = f.requests[0];
  // The next-window extraction is already running at 180s. Seeking from 171
  // to 179 must not abort that job and start from 198s, leaving 180..198
  // entirely without captions until a later read.
  f.move(179, { seeked: true });
  assert.equal(nextWindow.signal.aborted, false,
    "keep the relevant adjacent window rather than delaying captions after the boundary");
  assert.deepEqual(f.requests.map((r) => r.start), [180]);
});

test("explicit seeking can retry a failed current window without a minute of missing captions or request spam", async () => {
  const f = fixture();
  f.move(365);
  assert.deepEqual(f.requests.map((r) => r.start), [360]);
  f.expire(f.requests[0]); // Torrent lacked the subtitle pieces; no cues extracted.
  await tick();
  f.move(365, { seeked: true });
  assert.equal(f.requests.length, 1, "an immediate repeat seek is rate-limited");
  f.advance(1600);
  f.move(365, { seeked: true });
  assert.deepEqual(f.requests.map((r) => r.start), [360, 359],
    "a deliberate seek retries close to the actual playhead without waiting 60 seconds");
  f.complete(f.requests[1], "Recovered subtitle");
  await tick();
  assert.equal(f.lastPaint, "Recovered subtitle");
  assert.equal(f.state.tracks[0].cues[0].text, "First window");
  f.expire(f.requests[1]);
  await tick();
});

test("focused seek starts six seconds before the target and caches only its actual covered interval", async () => {
  const f = fixture();
  f.move(545, { seeked: true });
  assert.deepEqual(f.requests.map((r) => r.start), [539],
    "don't scan the 540s-aligned window from its beginning on a forward seek");
  f.complete(f.requests[0], "Fast caption");
  await tick();
  assert.equal(f.lastPaint, "Fast caption", "focused cue reaches the requested playhead");
  f.expire(f.requests[0]);
  await tick();
  const track = f.state.tracks[0];
  assert.equal(track.embeddedCompletedWindows.includes(540), false,
    "offset 539s extraction must not claim full 540-720s window coverage");
  assert.deepEqual(Array.from(track.embeddedCompletedRanges || [], ({ start, end }) => [start, end]), [[539, 719]]);
  f.move(600);
  assert.equal(f.requests.length, 1, "loaded offset range prevents redundant FFmpeg work");
  f.move(700);
  assert.deepEqual(f.requests.map((r) => r.start), [539, 713],
    "before an offset window expires, extract near the new uncached lookahead rather than from 540s");
});

test("prefetch begins at the end of cached subtitle coverage, leaving no unscanned gap", async () => {
  const f = fixture();
  f.move(545, { seeked: true });
  f.complete(f.requests[0], "Fast caption");
  await tick();
  f.expire(f.requests[0]);
  await tick();
  // With the previous lookahead-based calculation, 711+25-6=730 would
  // silently skip captions in [719, 730); offset coverage ends at 719.
  f.move(711);
  assert.deepEqual(f.requests.map((r) => r.start), [539, 713],
    "six seconds of overlap at the covered boundary avoids a subtitle hole");
});

test("far seek within the same 180-second bucket replaces its slow old extraction", async () => {
  const f = fixture();
  f.state.tracks[0].embeddedCompletedWindows = [];
  f.move(10);
  assert.deepEqual(f.requests.map((r) => r.start), [0]);
  const old = f.requests[0];
  f.move(160, { seeked: true });
  assert.equal(old.signal.aborted, true,
    "same-bucket forward seeks must not wait for 150 seconds of earlier subtitle packets");
  assert.deepEqual(f.requests.map((r) => r.start), [0, 154]);
  f.move(161, { seeked: true });
  assert.equal(f.requests.length, 2, "duplicate near-target seeking must not restart fast extraction");
  f.complete(f.requests[1], "Same bucket fast caption");
  await tick();
  assert.equal(f.lastPaint, "Same bucket fast caption");
  f.complete(old, "Outdated caption");
  await tick();
  assert.equal(f.state.tracks[0].cues.some((cue) => cue.text === "Outdated caption"), false);
  f.expire(f.requests[1]);
  await tick();
});

test("initial default embedded selection can follow a forward seek even before the first cue arrives", async () => {
  const f = fixture({ initialTrack: false });
  f.enable(2);
  assert.deepEqual(f.requests.map((r) => r.start), [0]);
  const old = f.requests[0];
  f.enable(365);
  assert.equal(old.signal.aborted, true);
  assert.deepEqual(f.requests.map((r) => r.start), [0, 360]);
  f.complete(f.requests[1], "Fresh captions");
  await tick();
  assert.equal(f.state.tracks.length, 1);
  assert.equal(f.state.tracks[0].visible, true);
  assert.equal(f.lastPaint, "Fresh captions");
  f.complete(old, "Obsolete first window");
  await tick();
  assert.equal(f.state.tracks[0].cues.length, 1);
  f.expire(f.requests[1]);
  await tick();
});

test("a canceled default extraction cannot reset the new seek's selected import state", async () => {
  const code = importAndWindowCode.slice(importAndWindowCode.indexOf("let initialEmbeddedSubtitleSource ="));
  const source = { kind: "torrent", sessionId: "abc", fileIndex: 1, sourceTag: "episode" };
  const media = { subtitleTracks: [{ streamIndex: 4, textBased: true, language: "eng" }] };
  const currentJobs = new Map();
  const requests = [];
  const ctx = vm.createContext({
    state: { currentSource: source, subtitlesVisible: true },
    defaultEmbeddedSubtitleTrack,
    preferredLanguagePair: () => ["EN"],
    normalizeTrackLanguage: () => "EN",
    currentSourceTracks: () => [],
    subtitleWindowStart, EMBEDDED_WINDOW_SECONDS,
    embeddedSubtitleImports: currentJobs,
    embeddedSubtitleImportKey: (src, stream) => `${src.sessionId}:${src.fileIndex}:${src.sourceTag}:${stream}`,
    importEmbeddedSubtitleTrack: (_track, _button, options) => new Promise((resolve) => {
      const key = `${source.sessionId}:${source.fileIndex}:${source.sourceTag}:4`;
      currentJobs.set(key, { windowStart: subtitleWindowStart(options.startSeconds) });
      requests.push({ resolve, start: options.startSeconds });
    }),
  });
  vm.runInContext(code, ctx);
  const enable = vm.runInContext("enableDefaultEmbeddedSubtitles", ctx);
  enable(media, 0);
  enable(media, 360);
  assert.equal(requests.length, 2);
  requests[0].resolve(false); // Canceled old window finishes after the newer request started.
  await tick();
  enable(media, 360);
  assert.equal(requests.length, 2, "stale abort must not unlock another default extraction");
  requests[1].resolve(false);
  await tick();
  enable(media, 540);
  assert.equal(requests.length, 3, "real current-window failure still permits a later retry");
  requests[2].resolve(true);
  await tick();
});

test("transcode forward seek requests captions immediately instead of relying on native seeking/timeupdate", () => {
  const from = app.indexOf("function seekPlayerTo(seconds) {");
  const end = app.indexOf("\nfunction seekPlayerBy(", from);
  assert.ok(from >= 0 && end > from);
  const state = { mediaDurationMs: 600000, transcodeBaseOffsetSeconds: 0, currentMs: 2000 };
  const video = { dataset: { mode: "transcode" }, currentTime: 2 };
  const requests = [];
  const ctx = vm.createContext({
    state, video, frame: { classList: { contains: () => true } },
    absolutePlaybackSeconds: () => state.pendingSeek?.target ?? video.currentTime,
    scheduleTranscodeSeek(target) { state.pendingSeek = { target, wasPlaying: true }; },
    loadMoreEmbeddedSubtitles() { requests.push(state.pendingSeek?.target); },
  });
  vm.runInContext(app.slice(from, end), ctx);
  assert.equal(vm.runInContext("seekPlayerTo(365)", ctx), true);
  assert.deepEqual(requests, [365], "embedded window refresh must not wait for a new transcode to play");
});
