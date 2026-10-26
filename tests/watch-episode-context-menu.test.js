import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { chapterWatchStatus } from "../shared/media/series-sources.js";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../frontend/styles/styles.css", import.meta.url), "utf8");
const begin = app.indexOf("function manuallyWatchedChapter(");
const end = app.indexOf("\nfunction renderWatchInfo(", begin);
assert.ok(begin >= 0 && end > begin, "Watch watched-status helpers must be present");
const helpers = app.slice(begin, end);

function watchedHarness(entries, currentId = entries[0]?.id) {
  const state = { library: entries, currentSource: { libraryId: currentId } };
  let saves = 0;
  const context = vm.createContext({
    state,
    chapterWatchStatus,
    librarySeriesKey: (title) => String(title || "").trim().toLowerCase(),
    saveLibrary: () => { saves += 1; },
    explicitUnwatchCompletionArmed: new Set(),
    persistAniListQueue: () => {}, anilistStoredQueue: () => [],
    localStorage: { getItem: () => "[]", setItem: () => {} },
    Date,
  });
  vm.runInContext(helpers, context, { filename: "app.js:watchEpisodeStatus" });
  return {
    mark: vm.runInContext("markWatchEpisodeWatched", context),
    unmark: vm.runInContext("markWatchEpisodeUnwatched", context),
    status: vm.runInContext("watchEpisodeStatus", context),
    get saves() { return saves; },
  };
}

test("mark watched persists catalog-only episodes without creating fake video files", () => {
  const entry = { id: "torrent-a", seriesKey: "my show", title: "My Show", episodes: [] };
  const series = { key: "my show" };
  const catalogOnly = { code: "S01E07", stored: null };
  const harness = watchedHarness([entry]);
  assert.equal(harness.status(series, catalogOnly).watched, false);
  assert.equal(harness.mark(series, "S01E07"), true);
  assert.equal(harness.saves, 1, "Library persistence must be invoked");
  assert.ok(entry.watchedChapters.S01E07 > 0);
  assert.deepEqual(entry.episodes, [], "do not fabricate unavailable torrent sources");
  assert.equal(harness.status(series, catalogOnly).watched, true);
  assert.equal(harness.status(series, catalogOnly).percent, 100);
  assert.equal(harness.status(series, catalogOnly).saved, false);

  const reload = watchedHarness(structuredClone([entry]));
  assert.equal(reload.status(series, catalogOnly).watched, true, "saved marker survives library reload");
  assert.equal(reload.status({ key: "different show" }, catalogOnly).watched, false, "mark cannot spill into another series");
  assert.equal(harness.mark(series, "S01E1000"), true, "four-digit episode numbers also accept a manual watched mark");
});

test("unwatch clears all saved copies and leaves explicit false until the user rewatches", () => {
  const a = { code: "S01E03", progress: { positionMs: 20000, durationMs: 20000, finished: true } };
  const b = { code: "S01E03", progress: { positionMs: 20000, durationMs: 20000, finished: true } };
  const entries = [
    { id: "source-a", seriesKey: "my show", title: "My Show", watchedChapters: { S01E03: 123 }, episodes: [a] },
    { id: "source-b", seriesKey: "my show", title: "My Show", episodes: [b] },
  ];
  const series = { key: "my show" };
  const harness = watchedHarness(entries);
  const chapter = { code: "S01E03", stored: { sources: [{ episode: a }, { episode: b }] } };
  assert.equal(harness.status(series, chapter).watched, true);
  assert.equal(harness.unmark(series, "S01E03"), true);
  assert.equal(entries[0].watchedChapters.S01E03, false);
  assert.equal(a.progress.finished, false);
  assert.equal(b.progress.finished, false);
  assert.equal(a.progress.positionMs, 20000, "Unwatch must preserve the resume point");
  assert.equal(b.progress.positionMs, 20000, "Every saved source keeps its resume point");
  assert.equal(harness.status(series, chapter).watched, false);
  assert.equal(harness.mark(series, "S01E03", chapter.stored), true);
  assert.equal(harness.status(series, chapter).watched, true);
  assert.ok(entries[0].watchedChapters.S01E03 > 0);
});

test("manual unwatch near the ending is not instantly undone by a stale timeupdate", () => {
  const start = app.indexOf("let watchProgressSavedAt = 0;");
  const end = app.indexOf("\nfunction trackSyncKey(", start);
  assert.ok(start >= 0 && end > start);
  const episode = { code: "S01E03", fileIndex: 0, progress: { finished: false, positionMs: 95000, durationMs: 100000 } };
  const entry = { seriesKey: "my-show", watchedChapters: { S01E03: false }, episodes: [episode] };
  const state = { library: [entry], currentMs: 95000, mediaDurationMs: 100000, pendingSeek: false };
  let saves = 0;
  const sandbox = vm.createContext({ state, video: { paused: true }, frame: { classList: { contains: () => true } },
    absolutePlaybackSeconds: () => state.currentMs / 1000,
    currentLibraryEpisode: () => ({ entry, episode }), librarySeriesKey: () => entry.seriesKey,
    explicitlyUnwatchedChapter: () => entry.watchedChapters?.S01E03 === false,
    $: () => null, renderWatchChapters: () => {}, saveLibrary: () => { saves++; }, Date });
  vm.runInContext(app.slice(start, end), sandbox);
  const record = vm.runInContext("recordWatchProgress", sandbox);
  record({ force: true });
  assert.equal(episode.progress.finished, false);
  assert.equal(entry.watchedChapters.S01E03, false);
  state.currentMs = 60000;
  record({ force: true });
  assert.equal(episode.progress.finished, false);
  state.currentMs = 95000;
  record({ force: true });
  assert.equal(episode.progress.finished, true, "Actual replay from an earlier point can mark watched again");
  assert.equal(entry.watchedChapters.S01E03, undefined);
  assert.equal(saves, 3);
});

test("mark watched updates each real saved source using progress.finished semantics", () => {
  const a = { progress: { positionMs: 1200, durationMs: 4200, updatedAt: 1, finished: false } };
  const b = { progress: null };
  const sourceRefs = [{ episode: a }, { episode: b }];
  const entry = { id: "torrent-a", seriesKey: "my show", title: "My Show", episodes: [a] };
  const second = { id: "torrent-b", seriesKey: "my show", title: "My Show", episodes: [b] };
  const harness = watchedHarness([entry, second]);
  const series = { key: "my show" };
  const chapter = { code: "S02E04", stored: { sources: sourceRefs } };
  assert.equal(harness.status(series, chapter).watched, false);
  assert.equal(harness.mark(series, chapter.code, chapter.stored), true);
  for (const episode of [a, b]) {
    assert.equal(episode.progress.finished, true);
    assert.ok(episode.progress.durationMs > 0);
    assert.equal(episode.progress.positionMs, episode.progress.durationMs);
    assert.ok(episode.progress.updatedAt > 1);
  }
  assert.equal(a.progress.durationMs, 4200, "known playback duration is preserved");
  assert.equal(harness.status(series, chapter).watched, true);
  assert.equal(harness.saves, 1);
  assert.equal(harness.mark(series, "../bad", chapter.stored), false);
  assert.equal(harness.saves, 1, "invalid episode keys cannot be persisted");
});

test("context menu remains usable for episodes without sources, mouse and keyboard", () => {
  const markup = app.slice(app.indexOf("function renderWatchChapters()"), app.indexOf("\nlet autoNextInterval"));
  assert.match(markup, /data-watch-episode-code=/);
  assert.match(markup, /tabindex="0"/);
  assert.match(markup, /aria-keyshortcuts="Shift\+F10"/);
  assert.match(markup, /data-watch-episode-sources=/, "episode body opens the source picker");
  assert.match(markup, /data-watch-episode=/, "a dedicated play target remains");
  assert.match(markup, /\? 'disabled' : ""/, "only the dedicated play button is disabled without a source");
  assert.match(app, /addEventListener\("contextmenu", \(event\) => \{\s*const item = event\.target\.closest\("\.watch-episode\[data-watch-episode-code\]"/);
  assert.match(app, /event\.key === "ContextMenu" \|\| \(event\.key === "F10" && event\.shiftKey\)/);
  assert.match(app, /wirePopupMenu\(menu\)/, "menu supports Escape, arrows, and Tab");
  assert.match(app, /openPopupMenu\(menu, \{/, "uses shared clamped popup positioning");
  assert.match(app, /toggleEpisodeWatched\(action\.series, code, action\.saved\)/);
  assert.match(app, /button\.getAttribute\("aria-disabled"\) === "true"/, "aria-disabled prevents playback");
  assert.match(app, /watchedChapters: existing\?\.watchedChapters \|\| \{\}/, "source refresh keeps manual marks");
  assert.match(styles, /\.ui-menu\.watch-episode-context-menu\s*\{[^}]*position:fixed/);
  assert.match(styles, /\.watch-episode:focus-visible/);

  const menuSource = app.slice(app.indexOf("function watchEpisodeContextMenu()"), app.indexOf("function openWatchEpisodeContextMenu("));
  assert.equal((menuSource.match(/role=\\"menuitem\\"/g) || []).length, 0);
  assert.equal((menuSource.match(/role="menuitem"/g) || []).length, 2, "menu includes a separately hidden retry action");
  assert.match(menuSource, />Mark as watched<\/button>/);
});

test("right-click popup positions at its pointer with edge flipping, never zero-coerced to a row anchor", () => {
  const start = app.indexOf("function openPopupMenu(menu, ");
  const end = app.indexOf("\nfunction closePopupMenu(", start);
  assert.ok(start > 0 && end > start);
  const calls = [];
  const host = { append: () => {} };
  const anchor = {
    setAttribute: () => {},
    getBoundingClientRect: () => ({ left: 110, top: 400, right: 340, bottom: 470 }),
  };
  const menu = { parentElement: host, hidden: true, style: {}, offsetWidth: 180, offsetHeight: 40,
    getBoundingClientRect: () => ({ left: Number.parseFloat(menu.style.left), top: Number.parseFloat(menu.style.top) }),
    querySelector: () => ({ focus: () => calls.push("focus") }) };
  const context = vm.createContext({ openMenuState: null, window: { innerWidth: 800, innerHeight: 600 },
    document: { body: host, querySelectorAll: () => [] }, closePopupMenu: () => {}, Math, Number });
  vm.runInContext(app.slice(start, end), context);
  const open = vm.runInContext("openPopupMenu", context);
  open(menu, { anchor, x: 250, y: 120, focusFirst: false });
  assert.equal(menu.style.left, "254px");
  assert.equal(menu.style.top, "124px", "right-click menu belongs at cursor, not below 470px row");
  open(menu, { anchor, x: 795, y: 590, focusFirst: false });
  assert.equal(menu.style.left, "611px", "menu flips to pointer's left at right edge");
  assert.equal(menu.style.top, "546px", "menu flips above the pointer at bottom edge");
  open(menu, { anchor, x: null, y: null, focusFirst: false });
  assert.equal(menu.style.left, "160px", "keyboard activation anchors to row");
  assert.equal(menu.style.top, "476px");
});

test("popup arrow keys skip the hidden AniList retry action", () => {
  const start = app.indexOf("function wirePopupMenu(menu) {");
  const end = app.indexOf("\nfunction openLibraryContextMenu(", start);
  assert.ok(start > 0 && end > start);
  const document = { activeElement: null };
  const watched = { focus() { document.activeElement = watched; } };
  const retry = { hidden: true, focus() { throw new Error("Hidden action was focused"); } };
  let onKeydown;
  const menu = {
    addEventListener(event, handler) { if (event === "keydown") onKeydown = handler; },
    querySelectorAll(selector) {
      assert.match(selector, /:not\(\[hidden\]\)/);
      return retry.hidden ? [watched] : [watched, retry];
    },
  };
  const ctx = vm.createContext({ document, closePopupMenu: () => {} });
  vm.runInContext(app.slice(start, end), ctx);
  vm.runInContext("wirePopupMenu", ctx)(menu);
  watched.focus();
  for (const key of ["ArrowDown", "ArrowUp", "Home", "End"]) {
    let prevented = false;
    onKeydown({ key, preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(document.activeElement, watched);
  }
});

test("Library title chapter rows offer Mark as watched and keyboard/right-click menu", () => {
  const saved = app.slice(app.indexOf("function libraryDialogChapterMarkup("), app.indexOf("\nfunction libraryDialogChaptersMarkup("));
  const catalog = app.slice(app.indexOf("function catalogChapterMarkup("), app.indexOf("\nfunction catalogChapterPanelMarkup("));
  assert.match(saved, /data-title-mark-watched/);
  assert.match(saved, /manuallyWatchedChapter\(series, code\)/);
  assert.match(catalog, /data-title-mark-watched/);
  assert.match(catalog, /data-chapter-code=/, "Catalog chapter rows expose their exact saved-episode code to the context-menu handler");
  assert.match(catalog, /const inLibrary = Boolean\(titleSubject\(\)\.series\)/, "unadded catalog entries cannot silently create local marks");
  assert.match(app, /markTitleChapterWatched\(target\.dataset\.titleMarkWatched\)/);
  assert.match(app, /openTitleEpisodeContextMenu\(event, item, \{ keyboard: event\.button !== 2 && event\.detail === 0 \}\)/);
  assert.match(app, /event\.key === "ContextMenu" \|\| \(event\.key === "F10" && event\.shiftKey\)/);
  assert.match(app, /toggleEpisodeWatched\(series, normalized, chapter \? \{ sources: chapter\.sources \} : null\)/);
  assert.match(app, /const surface = episodeContextSurface;/);
  assert.match(app, /if \(surface === "title"\) \{ markTitleChapterWatched\(code\); return; \}/);
});

test("Edge mouse contextmenu opens by right-click coordinates even when detail=0; keyboard keeps row anchor", () => {
  const start = app.indexOf("function openTitleEpisodeContextMenu(");
  const end = app.indexOf('$("#watch-chapters-body")?.addEventListener("contextmenu"', start);
  assert.ok(start > 0 && end > start, "Extract the real title-page handlers");
  const handlers = {};
  const menu = {};
  const calls = [];
  const titleMain = { addEventListener: (event, handler) => { handlers[event] = handler; } };
  const chapter = {
    dataset: { chapterCode: "S01E01" },
    matches: (selector) => selector === ".lib-chapter",
  };
  const ctx = vm.createContext({
    $: (selector) => selector === "#title-main" ? titleMain : null,
    titleSubject: () => ({ series: { type: "series" } }),
    watchEpisodeContextMenu: () => menu,
    libraryOrderedChapters: () => [],
    setEpisodeContextActions: () => {},
    watchEpisodeStatus: () => ({ watched: false }),
    openPopupMenu: (actual, options) => { assert.equal(actual, menu); calls.push(options); },
    titleEpisodeContextCode: "", episodeContextSurface: "watch",
    chapterCode: (season, episode) => `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`,
  });
  vm.runInContext(app.slice(start, end), ctx);
  const select = ".lib-chapter[data-chapter-code], .catalog-chapter[data-chapter-code]";
  const pointer = { button: 2, detail: 0, clientX: 270, clientY: 138, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; }, target: { closest: (selector) => selector === select ? chapter : null } };
  handlers.contextmenu(pointer);
  assert.equal(pointer.defaultPrevented, true, "Native browser context menu should be suppressed");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].x, 270);
  assert.equal(calls[0].y, 138);
  assert.equal(calls[0].anchor, chapter);
  assert.equal(vm.runInContext("titleEpisodeContextCode", ctx), "S01E01");
  assert.equal(vm.runInContext("episodeContextSurface", ctx), "title");

  const keyboard = { key: "F10", shiftKey: true, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; }, target: { closest: (selector) => selector === select ? chapter : null } };
  handlers.keydown(keyboard);
  assert.equal(keyboard.defaultPrevented, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].x, null);
  assert.equal(calls[1].y, null);
  assert.equal(calls[1].anchor, chapter);

  const catalog = { dataset: { chapterCode: "S01E02", season: "1", episode: "2" },
    matches: (selector) => selector === ".catalog-chapter" };
  handlers.contextmenu({ ...pointer, target: { closest: (selector) => selector === select ? catalog : null },
    preventDefault() {} });
  assert.equal(vm.runInContext("titleEpisodeContextCode", ctx), "S01E02");
  assert.equal(calls[2].x, 270);
  assert.equal(calls[2].anchor, catalog);
});

test("Watch episode right-click stays at its mouse position in Edge instead of opening below the row", () => {
  const start = app.indexOf('$("#watch-chapters-body")?.addEventListener("contextmenu"');
  const end = app.indexOf('$("#watch-chapters-body")?.addEventListener("click"', start);
  assert.ok(start > 0 && end > start);
  const listeners = {};
  const opened = [];
  const item = { dataset: { watchEpisodeCode: "S01E03" } };
  const target = { closest: () => item };
  const context = vm.createContext({
    $: () => ({ addEventListener: (name, handler) => { listeners[name] = handler; } }),
    openWatchEpisodeContextMenu: (event, row, options) => opened.push({ event, row, options }),
  });
  vm.runInContext(app.slice(start, end), context);
  listeners.contextmenu({ target, type: "contextmenu", button: 2, detail: 0, clientX: 350, clientY: 180 });
  assert.equal(opened[0].row, item);
  assert.equal(opened[0].options.keyboard, false, "detail=0 is still a pointer when button=2");
  listeners.contextmenu({ target, type: "contextmenu", button: 0, detail: 0 });
  assert.equal(opened[1].options.keyboard, true);
  listeners.keydown({ target, key: "F10", shiftKey: true });
  assert.equal(opened[2].options.keyboard, true);
});
