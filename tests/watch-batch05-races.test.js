import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
function slice(start, end) {
  const from = app.indexOf(start);
  const to = app.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `Missing ${start}`);
  return app.slice(from, to);
}

function catalogHarness() {
  const starts = [];
  const messages = [];
  let resolveLookup;
  const lookup = new Promise((resolve) => { resolveLookup = resolve; });
  let visible = true;
  const context = vm.createContext({
    playbackLoadRequestId: 4,
    manualCatalogPlaybackId: 0,
    state: { currentSource: { libraryId: "old", fileIndex: 0 } },
    viewActive: (view) => view === "watch" && visible,
    savedCatalogChapters: () => new Map(),
    chapterCode: () => "S01E02",
    fetchJson: () => lookup,
    groupChapterSources: (streams) => streams,
    chapterPlayOrder: (streams) => streams,
    catalogChapterTarget: () => ({}),
    addCatalogChapterSource: async (_view, _chapter, stream) => { starts.push(stream.id); },
    $: () => ({ textContent: "" }),
    toast: (value) => messages.push(value),
  });
  vm.runInContext(slice("async function playCatalogNeighbor(", "\nasync function playAdjacentChapter("), context);
  const entry = { catalogId: "tt1234567", displayTitle: "Series" };
  const chapter = { id: "tt1234567:1:2", season: 1, episode: 2 };
  const play = () => vm.runInContext("playCatalogNeighbor", context)({ entry, list: { seasons: [] } }, chapter);
  return { context, starts, messages, play, resolveLookup, leave() { visible = false; } };
}

test("An Up Next source lookup finishing after leaving Watch never plays the episode", async () => {
  const h = catalogHarness();
  const pending = h.play();
  h.leave();
  h.resolveLookup({ streams: [{ id: "late-source" }] });
  await pending;
  assert.deepEqual(h.starts, []);
  assert.deepEqual(h.messages, ["Finding a source for S01E02…"],
    "abandoned navigation does not post a misleading late error toast");
});

test("An older Up Next lookup cannot overwrite a newer playback selection", async () => {
  const h = catalogHarness();
  const pending = h.play();
  h.context.playbackLoadRequestId += 1;
  h.resolveLookup({ streams: [{ id: "late-source" }] });
  await pending;
  assert.deepEqual(h.starts, []);
});

test("An unsaved next chapter starts only while its lookup still owns Watch", async () => {
  const h = catalogHarness();
  const pending = h.play();
  h.resolveLookup({ streams: [{ id: "correct-episode" }] });
  await pending;
  assert.deepEqual(h.starts, ["correct-episode"]);
});

test("A late torrent resolution for Up Next cannot launch playback after cancellation", async () => {
  let finishMagnet;
  let stillCurrent = true;
  const magnet = new Promise((resolve) => { finishMagnet = resolve; });
  const starts = [];
  const releases = [];
  const context = vm.createContext({
    playbackLoadRequestId: 5,
    manualCatalogPlaybackId: 0,
    chapterCode: () => "S01E02",
    buttonText: () => "",
    resolveTorrentMagnet: () => magnet,
    releaseTorrentSession: async (id) => { releases.push(id); },
    upsertLibrarySession: () => ({ id: "saved" }),
    chapterSourceMeta: () => ({}),
    librarySeriesKeyForCatalog: () => "series",
    catalogMediaKind: () => "series",
    playLibraryEpisode: async (id, fileIndex) => { starts.push([id, fileIndex]); return true; },
    DOMException,
  });
  vm.runInContext(slice("async function addCatalogChapterSource(", "\nfunction catalogFetchAllLabel("), context);
  const pending = vm.runInContext("addCatalogChapterSource", context)(
    { meta: { id: "tt1234567", name: "Series" }, seasons: [] },
    { season: 1, episode: 2 },
    { magnet: "magnet:?xt=test", fileIdx: 0 },
    { play: true, quiet: true, stillCurrent: () => stillCurrent },
  );
  stillCurrent = false;
  finishMagnet({ id: "pending-session", files: [{ index: 0, video: true }] });
  await assert.rejects(pending, (error) => error.name === "AbortError");
  assert.deepEqual(starts, [], "the late magnet must not start a player");
  assert.deepEqual(releases, ["pending-session"], "abandoned torrent reservation is released");
});

test("Manual catalog selection supersedes older pending magnets and cancels on Home", async () => {
  const pendingMagnets = new Map();
  const starts = [];
  const releases = [];
  let visible = "title";
  const context = vm.createContext({
    playbackLoadRequestId: 10, manualCatalogPlaybackId: 0,
    viewActive: (name) => visible === name,
    chapterCode: () => "S01E02",
    buttonText: () => "",
    resolveTorrentMagnet: (magnet) => new Promise((resolve) => pendingMagnets.set(magnet, resolve)),
    releaseTorrentSession: async (id) => { releases.push(id); },
    upsertLibrarySession: () => ({ id: "saved" }),
    chapterSourceMeta: () => ({}),
    librarySeriesKeyForCatalog: () => "series",
    catalogMediaKind: () => "series",
    playLibraryEpisode: async (id) => { starts.push(id); return true; },
    DOMException,
  });
  vm.runInContext(slice("async function addCatalogChapterSource(", "\nfunction catalogFetchAllLabel("), context);
  const play = (magnet) => vm.runInContext("addCatalogChapterSource", context)(
    { meta: { id: "tt1234567", name: "Series" }, seasons: [] },
    { season: 1, episode: 2 }, { magnet, fileIdx: 0 }, { play: true, quiet: true },
  );
  const finish = (magnet) => pendingMagnets.get(magnet)({ id: magnet, files: [{ index: 0, video: true }] });
  const old = play("old");
  const newer = play("new");
  finish("old");
  await assert.rejects(old, (error) => error.name === "AbortError");
  finish("new");
  await newer;
  assert.deepEqual(starts, ["saved"], "only the latest source is started");
  assert.ok(releases.includes("old"));

  const abandoned = play("home-abandoned");
  visible = "home";
  finish("home-abandoned");
  await assert.rejects(abandoned, (error) => error.name === "AbortError");
  assert.deepEqual(starts, ["saved"], "leaving the catalog cannot open a hidden player later");
});

test("Up Next countdown is eight ticks, and Cancel/source switch/navigation prevent late autoplay", () => {
  const intervals = new Map();
  const nodes = new Map();
  let serial = 0;
  let current = "source:0";
  let visible = true;
  let starts = 0;
  const context = vm.createContext({
    localStorage: { getItem: () => "1" },
    window: {
      setInterval: (fn) => { const id = ++serial; intervals.set(id, fn); return id; },
      clearInterval: (id) => intervals.delete(id),
    },
    $: (selector) => {
      if (!nodes.has(selector)) nodes.set(selector, { hidden: true, textContent: "" });
      return nodes.get(selector);
    },
    state: { currentSource: { libraryId: "source", fileIndex: 0 }, mediaDurationMs: 0 },
    viewActive: () => visible,
    currentCatalogNeighbors: () => ({ next: { code: "S01E02" } }),
    currentChapterNavigation: () => ({ next: null }),
    adjacentChapterBusy: false,
    artworkFallback: () => "data:image/svg+xml,preview",
    revealPlayerControls() {},
    playAdjacentChapter: () => { starts += 1; },
  });
  vm.runInContext(slice("let autoNextInterval = null;", "\n// Chapters are saved one at a time"), context);
  const call = (name) => vm.runInContext(`${name}()`, context);
  const tick = () => [...intervals.values()][0]?.();
  call("startAutoNext");
  assert.equal(nodes.get("#player-up-next-countdown").textContent, "Playing in 8 seconds");
  assert.equal(nodes.get("#player-up-next-image").src, "data:image/svg+xml,preview");
  for (let i = 0; i < 7; i++) tick();
  assert.equal(starts, 0);
  tick();
  assert.equal(starts, 1);
  assert.equal(intervals.size, 0);

  call("startAutoNext");
  call("cancelAutoNext");
  assert.equal(intervals.size, 0);
  call("startAutoNext");
  assert.equal(intervals.size, 0, "cancelled source does not re-arm");
  current = "source:1";
  context.state.currentSource.fileIndex = 1;
  call("startAutoNext");
  context.state.currentSource.fileIndex = 2;
  tick();
  assert.equal(intervals.size, 0, "source replacement cancels the timer");
  call("startAutoNext");
  visible = false;
  tick();
  assert.equal(intervals.size, 0, "navigating away cancels the timer");
  assert.equal(starts, 1);
});
