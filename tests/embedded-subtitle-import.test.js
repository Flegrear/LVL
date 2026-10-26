import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { parseSubtitle } from "../learning/browser/core.js";
import { EMBEDDED_WINDOW_SECONDS, completedWebVttText, embeddedExtractionError, embeddedSubtitleSeekStart, embeddedTrackMatchesSource, mergeSubtitleWindows, subtitleWindowStart } from "../shared/subtitles/subtitle-stream.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
function section(start, end) {
  const from = app.indexOf(start);
  const to = app.indexOf(end, from);
  assert.ok(from >= 0 && to > from, "Missing real Watch subtitle code");
  return app.slice(from, to);
}
const importCode = section("const embeddedSubtitleImports = new Map();", "\nfunction loadMoreEmbeddedSubtitles(");
const renderCode = section("function renderSubtitles() {", "\nfunction trackLanguageName(");

test("Watch Add imports streamed embedded subtitles, draws cues at playhead and can Show a hidden track", async () => {
  const source = {
    kind: "torrent", sourceTag: "Episode · S01E01", sessionId: "torrent-session",
    fileIndex: 2, fileName: "Episode.S01E01.mkv", libraryId: "a".repeat(40),
  };
  const state = {
    currentSource: source, tracks: [], currentMs: 185500, targetLanguage: "JA",
    baseLanguage: "EN", subtitlesVisible: false, wordColoring: false,
    subtitleStyle: { romanization: false },
  };
  const overlay = {
    children: [], _html: "",
    get innerHTML() { return this._html; },
    set innerHTML(value) { this._html = value; this.children = []; },
    append(node) { this.children.push(node); },
  };
  const nodes = {
    "#subtitle-overlay": overlay,
    "#media-status": { textContent: "" },
  };
  const subtitleRenderMemo = { key: "" };
  let requests = 0;
  let renders = 0;
  const chunks = [
    "WEBVTT\n\n00:03:05.000 --> ",
    "00:03:07.000\nHel",
    "lo from the MKV\n\n",
    "\nNOTE LVL-EXTRACT-COMPLETE\n",
  ];
  const windowRequests = new Map();
  const context = vm.createContext({
    state, subtitleRenderMemo, video: { paused: true },
    absolutePlaybackSeconds: () => state.currentMs / 1000,
    presentedSubtitleSeconds: () => null,
    learningEnabled: true,
    learningRevision: 0,
    $: (selector) => nodes[selector],
    window: { setTimeout, clearTimeout },
    AbortController, TextDecoder, Date, console,
    subtitleWindowStart, completedWebVttText, embeddedExtractionError, parseSubtitle, mergeSubtitleWindows,
    EMBEDDED_WINDOW_SECONDS, embeddedSubtitleSeekStart,
    embeddedTrackMatchesSource,
    embeddedSubtitleLabel: (track) => track.title || "Embedded English",
    normalizeTrackLanguage: () => "EN",
    addSubtitleText: (text, label, language, options) => {
      const id = "track-stream";
      const track = {
        id, label, language, origin: options.origin, sourceTag: source.sourceTag,
        source: { ...source }, cues: parseSubtitle(text, id), visible: false,
      };
      state.tracks.push(track);
      return { track, added: true };
    },
    currentSourceTracks: () => state.tracks.filter((track) =>
      track.sourceTag === source.sourceTag &&
      (track.origin !== "embedded" || embeddedTrackMatchesSource(track, state.currentSource))),
    subtitleFingerprint: (cues) => String(cues.length),
    syncSelectedTrackForSource: () => { state.selectedTrackId = state.tracks[0]?.id; },
    renderSubtitleStyleControls: () => {},
    updatePlayerPreferenceButtons: () => {},
    renderEmbeddedSubtitleControls: () => {},
    saveCurrentEpisodeAnalysis: () => {},
    renderSubtitleWorkspace: () => { renders += 1; vm.runInContext("renderSubtitles()", context); },
    fetch: async (url) => {
      requests += 1;
      assert.match(url, /\/files\/2\/subtitle\?stream=4&progressive=1&start=(?:180|360|540|720)$/);
      const start = Number(new URL(url, "http://localhost").searchParams.get("start"));
      const attempt = (windowRequests.get(start) || 0) + 1;
      windowRequests.set(start, attempt);
      if (start === 720 && attempt === 1) return {
        ok: false, status: 502, text: async () => JSON.stringify({ error: "FFmpeg connection interrupted" }),
      };
      const responseChunks = start === 360
        ? ["WEBVTT\n\n", "\nNOTE LVL-EXTRACT-COMPLETE\n"]
        : start === 540
          ? [
            "WEBVTT\n\n00:09:05.000 --> 00:09:06.000\nPartial cue\n\n",
            ...(attempt === 1
              ? ["\nNOTE LVL-EXTRACT-PARTIAL: read timed out\n"]
              : ["00:09:07.000 --> 00:09:08.000\nRecovered cue\n\n", "\nNOTE LVL-EXTRACT-COMPLETE\n"]),
          ]
          : start === 720
            ? ["WEBVTT\n\n00:12:05.000 --> 00:12:06.000\nHTTP retry recovered\n\n", "\nNOTE LVL-EXTRACT-COMPLETE\n"]
            : chunks;
      let cursor = 0;
      return {
        ok: true,
        body: { getReader: () => ({ read: async () =>
          cursor < responseChunks.length
            ? { done: false, value: new TextEncoder().encode(responseChunks[cursor++]) }
            : { done: true } }) },
      };
    },
    preferredSourceTracks: () => state.tracks,
    activeTrack: () => state.tracks[0],
    getActiveCue: (track) => track?.cues?.find((cue) => state.currentMs >= cue.startMs && state.currentMs <= cue.endMs) || null,
    comparisonCueForTrack: (track) => track?.cues?.find((cue) => state.currentMs >= cue.startMs && state.currentMs <= cue.endMs) || null,
    isRomanizableLanguage: () => false,
    appendLearningCue: () => {},
    document: { createElement: () => ({ className: "", textContent: "" }) },
  });
  vm.runInContext(importCode + "\n" + renderCode, context);
  const track = { streamIndex: 4, language: "eng", codec: "ass", title: "English", order: 0 };
  const added = await vm.runInContext("importEmbeddedSubtitleTrack", context)(track, null, { startSeconds: 185 });
  assert.equal(added, true);
  assert.equal(state.tracks.length, 1);
  assert.equal(state.tracks[0].exactMedia, true);
  assert.equal(state.tracks[0].embeddedImportPartial, false, "complete imports must not enter retry mode");
  assert.equal(state.tracks[0].embeddedStreamIndex, 4);
  assert.equal(state.tracks[0].cues[0].startMs, 185000);
  assert.equal(state.tracks[0].cues.length, 1, "partial network chunks must not add duplicate half-text cues");
  assert.equal(state.tracks[0].visible, true);
  assert.equal(state.subtitlesVisible, true);
  assert.equal(overlay.children[0]?.textContent, "Hello from the MKV", "Watch overlay must draw the newly imported caption");
  assert.ok(renders > 0);
  assert.equal(requests, 1);

  state.tracks[0].visible = false;
  subtitleRenderMemo.key = "";
  vm.runInContext("renderSubtitles()", context);
  assert.equal(overlay.children.length, 0);
  const shown = await vm.runInContext("importEmbeddedSubtitleTrack", context)(track, null, { startSeconds: 185 });
  assert.equal(shown, true);
  assert.equal(requests, 1, "Show should reveal already extracted subtitles without fetching them again");
  assert.equal(overlay.children[0]?.textContent, "Hello from the MKV");

  // Long silent stretches produce a valid completed window with zero new cues.
  // That must not make the previously loaded track partial or lose its captions.
  const emptyWindow = await vm.runInContext("importEmbeddedSubtitleTrack", context)(track, null, { startSeconds: 360, automatic: true });
  assert.equal(emptyWindow, true);
  assert.equal(requests, 2);
  assert.equal(state.tracks[0].embeddedImportPartial, false);
  assert.equal(state.tracks[0].embeddedCompletedWindows.includes(360), true);
  assert.equal(state.tracks[0].cues.length, 1);
  assert.equal(state.tracks[0].visible, true);

  // A genuinely interrupted stream can contain useful cues, but its window
  // must remain incomplete and be retryable at the same playback position.
  const partial = await vm.runInContext("importEmbeddedSubtitleTrack", context)(track, null, { startSeconds: 540, automatic: true });
  assert.equal(partial, true);
  assert.equal(state.tracks[0].embeddedImportPartial, true);
  assert.equal(state.tracks[0].embeddedCompletedWindows.includes(540), false);
  assert.equal(state.tracks[0].cues.length, 2, "the partial cue remains available alongside the original cue");
  assert.equal(state.tracks[0].visible, true);
  const partialRetry = await vm.runInContext("importEmbeddedSubtitleTrack", context)(track, null, { startSeconds: 540 });
  assert.equal(partialRetry, true);
  assert.equal(windowRequests.get(540), 2, "retry must request the same incomplete window again");
  assert.equal(state.tracks[0].embeddedImportPartial, false);
  assert.equal(state.tracks[0].embeddedCompletedWindows.includes(540), true);
  assert.equal(state.tracks[0].cues.length, 3, "retry merges new cues without duplicating earlier ones");
  assert.deepEqual(state.tracks[0].cues.map((cue) => cue.startMs), [185000, 545000, 547000]);

  // An HTTP extraction error must also leave the window retryable and avoid
  // discarding captions successfully imported before the failed request.
  const failed = await vm.runInContext("importEmbeddedSubtitleTrack", context)(track, null, { startSeconds: 720, automatic: true });
  assert.equal(failed, true, "earlier cues remain usable when this request fails");
  assert.equal(state.tracks[0].embeddedImportPartial, true);
  assert.equal(state.tracks[0].embeddedCompletedWindows.includes(720), false);
  assert.equal(state.tracks[0].cues.length, 3);
  const httpRetry = await vm.runInContext("importEmbeddedSubtitleTrack", context)(track, null, { startSeconds: 720 });
  assert.equal(httpRetry, true);
  assert.equal(windowRequests.get(720), 2);
  assert.equal(state.tracks[0].embeddedImportPartial, false);
  assert.equal(state.tracks[0].embeddedCompletedWindows.includes(720), true);
  assert.equal(state.tracks[0].cues.length, 4);
  assert.equal(state.tracks[0].cues[0].text, "Hello from the MKV");
  assert.equal(state.tracks[0].visible, true);
});
