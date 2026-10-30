import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../frontend/styles/styles.css", import.meta.url), "utf8");

function slice(start, end) {
  const a = app.indexOf(start), b = app.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, "Missing actual application section: " + start);
  return app.slice(a, b);
}

test("Next episode shows catalog thumbnail and name in compact solid-black UI", () => {
  assert.match(html, /id="player-up-next-image"/);
  assert.match(html, /class="player-up-next__main"/);
  assert.match(css, /\.player-up-next\s*\{[^}]*background:#000;/);
  assert.match(css, /\.player-up-next__image\s*\{[^}]*object-fit:cover;/);
  const nodes = new Map();
  const image = { src: "", onerror: null };
  const state = { currentSource: { libraryId: "source", fileIndex: 0, title: "Apothecary" } };
  const intervals = new Map();
  let index = 0;
  const ctx = vm.createContext({
    localStorage: { getItem: () => "1" }, state, manualCatalogPlaybackId: 7,
    $: (name) => name === "#player-up-next-image" ? image
      : (nodes.get(name) || (nodes.set(name, { hidden: false, textContent: "" }), nodes.get(name))),
    window: { setInterval: (fn) => { intervals.set(++index, fn); return index; }, clearInterval: (id) => intervals.delete(id) },
    viewActive: () => true,
    currentCatalogNeighbors: () => ({ next: { code: "S01E02", name: "Chilly Apothecary", thumbnail: "/safe-ep2.jpg" } }),
    currentChapterNavigation: () => ({ next: null }),
    artworkFallback: (_title, { label }) => "fallback:" + label,
    adjacentChapterBusy: false, revealPlayerControls: () => {}, playAdjacentChapter: () => {},
  });
  vm.runInContext(slice("let autoNextInterval = null;", "\n// SkipDB is a lightweight"), ctx);
  vm.runInContext("startAutoNext()", ctx);
  assert.equal(image.src, "/safe-ep2.jpg");
  assert.equal(nodes.get("#player-up-next-title").textContent, "S01E02 · Chilly Apothecary");
  image.onerror();
  assert.equal(image.src, "fallback:S01E02", "bad still falls back to existing UI artwork");
});

test("watched→unwatched reset cancels pending E2 countdown and stale episode switch", () => {
  let pendingStarts = 0;
  const timers = new Map();
  const nodes = new Map();
  let sequence = 0;
  const episode = { code: "S01E01", fileIndex: 0,
    progress: { positionMs: 950000, durationMs: 1000000, finished: false } };
  const entry = { id: "source", seriesKey: "series", title: "Series", episodes: [episode], watchedChapters: {} };
  const state = { library: [entry], currentSource: { libraryId: "source", fileIndex: 0 } };
  const ctx = vm.createContext({
    state, Date, manualCatalogPlaybackId: 8, localStorage: { getItem: () => "1" },
    libraryEntryById: () => entry, librarySeriesKey: () => "series",
    $: (name) => nodes.get(name) || (nodes.set(name, { hidden: true, textContent: "" }), nodes.get(name)),
    window: { setInterval: (fn) => { timers.set(++sequence, fn); return sequence; }, clearInterval: (id) => timers.delete(id) },
    currentCatalogNeighbors: () => ({ next: { code: "S01E02" } }),
    currentChapterNavigation: () => ({ next: null }),
    artworkFallback: () => "fallback",
    adjacentChapterBusy: false, viewActive: () => true,
    revealPlayerControls() {}, playAdjacentChapter: () => { pendingStarts++; },
    explicitUnwatchCompletionArmed: new Set(),
    saveLibrary() {}, anilistStoredQueue: () => [], persistAniListQueue() {},
    pendingAniListUnwatches: () => [], savePendingAniListUnwatches() {},
    seekPlayerTo: (position) => { assert.equal(position, 0); },
  });
  vm.runInContext(slice("let autoNextInterval = null;", "\n// SkipDB is a lightweight"), ctx);
  vm.runInContext(slice("function markWatchEpisodeUnwatched(", "\nconst ANILIST_UNWATCH_QUEUE_KEY"), ctx);
  vm.runInContext(slice("function markWatchEpisodeWatched(", "\nfunction markTitleChapterWatched("), ctx);
  vm.runInContext("startAutoNext()", ctx);
  assert.equal(timers.size, 1);
  assert.equal(vm.runInContext("markWatchEpisodeWatched", ctx)({ key: "series" }, "S01E01", { sources: [{ episode }] }), true);
  assert.equal(timers.size, 0);
  assert.equal(vm.runInContext("markWatchEpisodeUnwatched", ctx)({ key: "series" }, "S01E01"), true);
  assert.equal(episode.progress.positionMs, 0);
  assert.equal(episode.progress.finished, false);
  assert.equal(vm.runInContext("manualCatalogPlaybackId", ctx), 10, "invalidate already-in-flight automatic provider lookups");
  vm.runInContext("startAutoNext()", ctx);
  assert.equal(timers.size, 0, "explicit replay must not rearm an ended episode");
  assert.equal(pendingStarts, 0);
  assert.equal(nodes.get("#player-up-next").hidden, true);
});
