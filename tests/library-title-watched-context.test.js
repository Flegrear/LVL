import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");

test("catalog-only films can be marked watched from Library without pretending to edit AniList", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /data-library-action="mark-watched"/, "context menu must expose the watched action");
  const start = app.indexOf("function isLibraryTitleMarkedWatched(");
  const end = app.indexOf("\nfunction libraryProgressRatio(", start);
  assert.ok(start > 0 && end > start);
  const movie = { key: "the first slam dunk", title: "THE FIRST SLAM DUNK", sources: [{ id: "catalog:movie:tt15242330", watchedTitleAt: 0, episodes: [] }] };
  const changes = [];
  const context = vm.createContext({
    Date: { now: () => 12345 },
    updateLibrarySeriesEntries: (key, updater) => {
      assert.equal(key, movie.key);
      movie.sources.forEach(updater);
      changes.push("save");
      return true;
    },
    renderLibrary: () => changes.push("render"),
    refreshTitlePage: () => changes.push("title"),
    toast: (text) => changes.push(text),
  });
  vm.runInContext(app.slice(start, end), context);
  assert.equal(context.isLibraryTitleMarkedWatched(movie), false);
  assert.equal(context.setLibraryTitleWatched(movie, true), true);
  assert.equal(context.isLibraryTitleMarkedWatched(movie), true);
  assert.equal(movie.sources[0].watchedTitleAt, 12345);
  assert.equal(context.setLibraryTitleWatched(movie, false), true);
  assert.equal(context.isLibraryTitleMarkedWatched(movie), false);
  assert.equal(movie.sources[0].watchedTitleAt, 0);
  assert.deepEqual(changes.filter((value) => value === "save"), ["save", "save"]);
  assert.match(app, /badge: isLibraryTitleMarkedWatched\(series\) \? "Watched"/);
  assert.match(app, /\.filter\(\(\{ series, point, replay \}\) => !isLibraryTitleMarkedWatched\(series\)/);
  assert.match(app, /button\.dataset\.libraryAction === "mark-watched"/);
  assert.match(app, /if \(isLibraryTitleMarkedWatched\(series\)\) return "COMPLETED";/, "the Completed view should reflect explicit local watched marks");
  assert.doesNotMatch(app.slice(start, end), /anilistGraphql|ANILIST_SAVE_PROGRESS/);
});

test("right-clicking a nested Library poster opens actions for its owning title", () => {
  const start = app.indexOf('page?.addEventListener("contextmenu",');
  const end = app.indexOf('\n  bindTabs(', start);
  assert.ok(start > 0 && end > start, "Library should delegate card context menus");

  class FakeElement {
    closest(selector) {
      assert.match(selector, /data-series-key/);
      return card;
    }
  }
  const card = { dataset: { seriesKey: "the first slam dunk" } };
  const list = { contains: (node) => node === card };
  const listeners = {};
  const opened = [];
  const page = {
    addEventListener: (name, listener) => { listeners[name] = listener; },
    querySelector: (selector) => selector === "#library-list" ? list : null,
  };
  vm.runInNewContext(app.slice(start, end), {
    Element: FakeElement,
    page,
    openLibraryContextMenu: (event, key) => { event.preventDefault(); opened.push(key); },
  });
  assert.equal(typeof listeners.contextmenu, "function");
  const event = {
    target: new FakeElement(),
    button: 2,
    detail: 0,
    type: "contextmenu",
    preventDefault() { this.defaultPrevented = true; },
  };
  listeners.contextmenu(event);
  assert.equal(event.defaultPrevented, true, "browser menu should be suppressed over Library cards");
  assert.deepEqual(opened, ["the first slam dunk"]);
});

test("Edge mouse right-click uses the pointer even with detail=0; keyboard menu uses the card", () => {
  const start = app.indexOf("function openLibraryContextMenu(");
  const end = app.indexOf("\nfunction closeLibraryContextMenu(", start);
  assert.ok(start > 0 && end > start);
  const menu = {};
  const watched = { textContent: "" };
  const calls = [];
  const context = vm.createContext({
    $: (selector) => selector.includes("mark-watched") ? watched : menu,
    buildLibrarySeries: () => [{ key: "slam", sources: [{ watchedTitleAt: 0 }] }],
    renderLibrarySeasonActions: () => {},
    openPopupMenu: (_menu, options) => calls.push(options),
  });
  vm.runInContext(app.slice(start, end), context);
  const anchor = { id: "card" };
  context.openLibraryContextMenu({ type: "contextmenu", button: 2, detail: 0, clientX: 200, clientY: 150,
    preventDefault() {} }, "slam", { anchor });
  assert.equal(calls[0].x, 200);
  assert.equal(calls[0].y, 150);
  assert.equal(calls[0].focusFirst, false);
  assert.equal(watched.textContent, "Mark as watched");
  context.openLibraryContextMenu({ type: "contextmenu", button: 0, detail: 0,
    preventDefault() {} }, "slam", { anchor });
  assert.equal(calls[1].anchor, anchor);
  assert.equal(calls[1].x, null);
  assert.equal(calls[1].focusFirst, true);
});

test("marking a grouped series watched updates every local source without mutating episodes", () => {
  const start = app.indexOf("function isLibraryTitleMarkedWatched(");
  const end = app.indexOf("\nfunction libraryProgressRatio(", start);
  const series = {
    key: "slam dunk",
    title: "Slam Dunk",
    sources: [
      { id: "catalog:series:slam", watchedTitleAt: 0, episodes: [{ code: "S01E01", progress: { finished: false } }] },
      { id: "torrent:slam", watchedTitleAt: 0, episodes: [{ code: "S01E02", progress: { finished: false } }] },
    ],
  };
  const context = vm.createContext({
    Date: { now: () => 42 },
    updateLibrarySeriesEntries: (key, update) => {
      assert.equal(key, series.key);
      series.sources.forEach(update);
      return true;
    },
    renderLibrary() {}, refreshTitlePage() {}, toast() {},
  });
  vm.runInContext(app.slice(start, end), context);
  assert.equal(context.setLibraryTitleWatched(series, true), true);
  assert.deepEqual(series.sources.map((source) => source.watchedTitleAt), [42, 42]);
  assert.equal(series.sources[0].episodes[0].progress.finished, false);
  assert.equal(series.sources[1].episodes[0].progress.finished, false);
  assert.equal(context.setLibraryTitleWatched(series, false), true);
  assert.deepEqual(series.sources.map((source) => source.watchedTitleAt), [0, 0]);
});

test("Library season context actions mark only that season and preserve the other season and playback position", () => {
  const start = app.indexOf("function librarySeasonChapterCodes(");
  const end = app.indexOf("\n// A title-level watched mark works", start);
  assert.ok(start > 0 && end > start);
  const sources = [
    { id: "catalog", seriesKey: "diaries", watchedTitleAt: 10, watchedChapters: {}, episodes: [] },
    { id: "torrent", seriesKey: "diaries", watchedTitleAt: 10, watchedChapters: {}, episodes: [
      { code: "S01E01", progress: { finished: true, positionMs: 260, durationMs: 500 } },
      { code: "S02E01", progress: { finished: false, positionMs: 90, durationMs: 500 } },
    ] },
  ];
  const series = { key: "diaries", title: "Apothecary Diaries", type: "series", catalogId: "tt1234567",
    sources, seasons: new Map([[1, [{ episode: { code: "S01E01" } }]], [2, [{ episode: { code: "S02E01" } }]]]) };
  const cache = new Map([["tt1234567", { list: { seasons: [
    { season: 1, episodes: [{ episode: 1 }, { episode: 2 }] },
    { season: 2, episodes: [{ episode: 1 }] },
  ] } }]]);
  const changes = [];
  const menu = { hidden: true, innerHTML: "" };
  const ctx = vm.createContext({
    state: { library: sources, currentSource: null },
    catalogChapterLists: cache,
    isLibraryTitleMarkedWatched: (group) => group.sources.some((entry) => entry.watchedTitleAt > 0),
    chapterCode: (season, episode) => `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`,
    manuallyWatchedChapter: (group, code) => group.sources.some((entry) => Boolean(entry.watchedChapters[code])),
    explicitlyUnwatchedChapter: (group, code) => group.sources.some((entry) => entry.watchedChapters[code] === false),
    librarySeriesKey: (title) => title.toLowerCase(),
    explicitUnwatchCompletionArmed: new Set(),
    pendingAniListUnwatches: () => [],
    savePendingAniListUnwatches: () => {},
    anilistStoredQueue: () => [{ seriesKey: "diaries", code: "S01E01" }, { seriesKey: "diaries", code: "S02E01" }],
    persistAniListQueue: (rows) => changes.push(rows.map((row) => row.code).join(",")),
    $: () => menu,
    saveLibrary: () => changes.push("saved"),
    renderLibrary: () => changes.push("render"),
    refreshTitlePage: () => changes.push("title"),
    toast: (value) => changes.push(value),
    Date: { now: () => 456 },
  });
  vm.runInContext(app.slice(start, end), ctx);
  const codes = ctx.librarySeasonChapterCodes(series);
  assert.deepEqual([...codes.get(1)], ["S01E01", "S01E02"]);
  assert.deepEqual([...codes.get(2)], ["S02E01"]);
  ctx.renderLibrarySeasonActions(series);
  assert.match(menu.innerHTML, /data-library-season="1" data-library-watched="false"/,
    "Whole-title watched state should be reflected by each season");
  assert.match(menu.innerHTML, /data-library-season="2" data-library-watched="false"/);
  assert.equal(ctx.setLibrarySeasonWatched(series, 1, true), true);
  assert.equal(sources[0].watchedChapters.S01E02, 456);
  assert.equal(sources[1].episodes[1].progress.finished, false, "Season 2 must remain untouched");
  ctx.renderLibrarySeasonActions(series);
  assert.match(menu.innerHTML, /data-library-season="1" data-library-watched="false"/);
  assert.equal(ctx.setLibrarySeasonWatched(series, 1, false), true);
  assert.equal(sources[0].watchedChapters.S01E02, false);
  assert.equal(sources[1].episodes[0].progress.finished, false);
  assert.equal(sources[1].episodes[0].progress.positionMs, 260, "Unwatching keeps the resume point");
  assert.equal(sources[0].watchedTitleAt, 0, "An explicit season unwatch clears whole-title watched override");
  assert.equal(sources[1].watchedChapters.S02E01, undefined);
  assert.ok(changes.includes("S02E01"), "Queued watched uploads for the unwatched season are removed");
  assert.equal(changes.filter((item) => item === "saved").length, 2, "One persisted change per season action");
  assert.match(readFileSync(new URL("../index.html", import.meta.url), "utf8"), /data-library-season-actions/);
  assert.match(app, /button\.dataset\.libraryAction === "mark-season"/);
});
