import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { parseSubtitle } from "../learning/browser/core.js";
import {
  EMBEDDED_WINDOW_SECONDS, completedWebVttText, embeddedExtractionError,
  embeddedSubtitleSeekStart, embeddedTrackMatchesSource, mergeSubtitleWindows, subtitleWindowStart,
} from "../shared/subtitles/subtitle-stream.js";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const start = app.indexOf("const embeddedSubtitleImports = new Map();");
const end = app.indexOf("\nlet initialEmbeddedSubtitleSource =", start);
assert.ok(start >= 0 && end > start, "real embedded importer remains available");

function deferred() {
  let resolve;
  return { promise: new Promise((done) => { resolve = done; }), resolve: (value) => resolve(value) };
}

function fixture() {
  const first = { kind: "torrent", sessionId: "session-a", fileIndex: 0,
    sourceTag: "Episode S01E01", fileName: "one.mkv", libraryId: "abc" };
  const second = { kind: "torrent", sessionId: "session-b", fileIndex: 0,
    sourceTag: "Episode S01E02", fileName: "two.mkv", libraryId: "def" };
  const state = { currentSource: first, subtitlesVisible: true, tracks: [], currentMs: 50_000 };
  const requests = [];
  let paintings = 0;
  const context = vm.createContext({
    state, AbortController, TextDecoder, Date, parseSubtitle,
    subtitleWindowStart, completedWebVttText, embeddedExtractionError,
    EMBEDDED_WINDOW_SECONDS, embeddedSubtitleSeekStart, embeddedTrackMatchesSource,
    mergeSubtitleWindows,
    window: { setTimeout: () => 1, clearTimeout() {} },
    $: () => ({ textContent: "" }),
    currentSourceTracks: () => state.tracks.filter((track) =>
      track.sourceTag === state.currentSource.sourceTag && embeddedTrackMatchesSource(track, state.currentSource)),
    absolutePlaybackSeconds: () => state.currentMs / 1000,
    presentedSubtitleSeconds: () => null,
    embeddedSubtitleLabel: () => "English",
    normalizeTrackLanguage: () => "EN",
    subtitleFingerprint: (cues) => String(cues.length),
    subtitleRenderMemo: { key: "" },
    addSubtitleText: (text, label, language, options) => {
      const track = { id: `embedded-${state.tracks.length}`, source: { ...state.currentSource },
        sourceTag: state.currentSource.sourceTag, origin: options.origin,
        label, language, visible: false, cues: parseSubtitle(text, "embedded") };
      state.tracks.push(track);
      return { track };
    },
    renderSubtitles: () => { paintings++; },
    renderSubtitleWorkspace() {}, renderEmbeddedSubtitleControls() {},
    syncSelectedTrackForSource() {}, saveCurrentEpisodeAnalysis() {},
    fetch: async (_url, { signal }) => {
      const next = deferred();
      const request = { signal, next };
      requests.push(request);
      let delivered = false;
      return { ok: true, body: { getReader: () => ({
        read: () => {
          if (delivered) return Promise.resolve({ done: true });
          delivered = true;
          // The first chunk may already be queued when AbortController aborts.
          // A well-behaved caller still rejects it after a source switch.
          return next.promise;
        },
      }) } };
    },
  });
  vm.runInContext(app.slice(start, end), context);
  const importTrack = vm.runInContext("importEmbeddedSubtitleTrack", context);
  const imports = vm.runInContext("embeddedSubtitleImports", context);
  const begin = (seconds = 50) => importTrack({ streamIndex: 4, language: "eng" }, null,
    { startSeconds: seconds, automatic: true, activate: true, focused: true, urgent: true });
  const deliver = (request, seconds = 50) => request.next.resolve({ done: false,
    value: new TextEncoder().encode(`WEBVTT\n\n00:00:${String(seconds).padStart(2, "0")}.000 --> 00:00:${String(seconds + 2).padStart(2, "0")}.000\nStale caption\n\nNOTE LVL-EXTRACT-COMPLETE\n`) });
  return { state, first, second, context, imports, requests, begin, deliver, get paintings() { return paintings; } };
}

test("A→B→A source transition never imports an aborted previous generation's buffered subtitle cue", async () => {
  const f = fixture();
  const older = f.begin();
  assert.equal(f.requests.length, 1);
  f.state.currentSource = f.second;
  for (const controller of f.imports.values()) controller.abort("source changed");
  // Same session, file index and display source are revisited in a new
  // playback generation. Equality of source keys alone is insufficient.
  f.state.currentSource = { ...f.first };
  f.deliver(f.requests[0]);
  assert.equal(await older, false, "old request resolves without touching new playback");
  assert.equal(f.state.tracks.length, 0, "no stale cues become attached after returning to A");
  assert.equal(f.paintings, 0, "no stale cue is shown on screen");
});

test("late old-episode subtitle chunks do not displace active new-episode cues", async () => {
  const f = fixture();
  const older = f.begin();
  f.state.currentSource = f.second;
  for (const controller of f.imports.values()) controller.abort("episode changed");
  const newer = f.begin();
  assert.equal(f.requests.length, 2);
  f.deliver(f.requests[1]);
  assert.equal(await newer, true);
  const paintedAtNew = f.paintings;
  f.deliver(f.requests[0]);
  assert.equal(await older, false);
  assert.equal(f.state.tracks.length, 1);
  assert.equal(f.state.tracks[0].sourceTag, f.second.sourceTag);
  assert.equal(f.paintings, paintedAtNew);
});
