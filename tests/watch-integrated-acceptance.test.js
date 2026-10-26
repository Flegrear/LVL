import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { boundedPosterUrl, posterSrcset, preferredPosterArt } from "../frontend/catalog/home-feed.js";

// Integration-level, deterministic DOM doubles of the actual browser handlers.
// These tests deliberately never launch a browser, fetch remote media, or touch a user profile.
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../frontend/styles/styles.css", import.meta.url), "utf8");

function section(start, end) {
  const from = app.indexOf(start);
  const to = app.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `Application integration seam missing: ${start} -> ${end}`);
  return app.slice(from, to);
}

function fakeClasses(initial = []) {
  const values = new Set(initial);
  return {
    contains: (name) => values.has(name),
    add: (name) => values.add(name),
    remove: (name) => values.delete(name),
    toggle(name, enabled) {
      const next = enabled === undefined ? !values.has(name) : Boolean(enabled);
      if (next) values.add(name);
      else values.delete(name);
      return next;
    },
  };
}

function fakeNode(attributes = {}) {
  const listeners = new Map();
  return {
    hidden: false, open: false, innerHTML: "", textContent: "", dataset: {}, attributes,
    classList: fakeClasses(), focused: false, title: "",
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes[name] ?? null; },
    addEventListener(name, callback) { listeners.set(name, callback); },
    emit(name, properties = {}) {
      const event = { preventDefault() {}, stopPropagation() {}, currentTarget: this,
        target: this, ...properties };
      assert.ok(listeners.has(name), `No ${name} listener on node`);
      return listeners.get(name)(event);
    },
    focus() { this.focused = true; },
    close() { this.open = false; if (listeners.has("close")) this.emit("close"); },
    showModal() { this.open = true; },
    getBoundingClientRect() { return { left: 100, top: 100, right: 300, bottom: 300 }; },
  };
}

test("shared topbar hamburger expands an overlay and restores full-width content on outside click, Escape and mobile", () => {
  const main = html.indexOf('<main class="app-main">');
  const topbar = html.indexOf('id="home-topbar"');
  const hamburger = html.indexOf('id="app-sidebar-toggle"');
  const watch = html.indexOf('id="view-watch"');
  assert.ok(main >= 0 && main < topbar && topbar < hamburger && hamburger < watch);
  assert.match(css, /\.app-shell,\.app-shell\.sidebar-expanded\s*\{[^}]*display:block;\s*width:100%/);
  assert.match(css, /\.app-sidebar\s*\{[^}]*position:fixed;[^}]*transform:translateX\(-100%\)/);
  assert.match(css, /\.app-main\s*\{[^}]*width:100%;[^}]*max-width:none;\s*margin:0/);
  assert.match(css, /\.watch-player-layout\.has-chapters\.is-theater\s*\{\s*grid-template-columns:minmax\(0,1fr\)/);

  const shell = fakeNode();
  const drawer = fakeNode();
  const top = fakeNode();
  const inside = fakeNode();
  const documentNode = fakeNode();
  const handlers = new Map();
  const windowNode = { innerWidth: 1366, addEventListener(type, cb) { handlers.set(type, cb); } };
  const writes = [];
  let notificationClosures = 0;
  const context = vm.createContext({
    $: (name) => ({ ".app-shell": shell, ".app-sidebar": drawer, "#sidebar-toggle": inside,
      "#app-sidebar-toggle": top })[name],
    window: windowNode,
    document: { addEventListener(type, cb) { documentNode.addEventListener(type, cb); } },
    localStorage: { setItem: (key, value) => writes.push([key, value]) },
    persistPreferences() {}, t: (text) => text,
    closeUpdateNotificationPopover() { notificationClosures++; },
  });
  vm.runInContext(section("function setSidebarExpanded(", '\nframe.addEventListener("pointerenter"'), context);
  top.emit("click");
  assert.ok(shell.classList.contains("sidebar-expanded"));
  assert.equal(top.getAttribute("aria-expanded"), "true");
  assert.equal(inside.getAttribute("aria-expanded"), "true");
  assert.equal(inside.focused, true);
  shell.emit("click", { target: { closest: () => null } });
  assert.equal(shell.classList.contains("sidebar-expanded"), false);
  assert.ok(notificationClosures >= 1, "collapsing the sidebar also closes an open notification panel");
  top.emit("click");
  documentNode.emit("keydown", { key: "Escape" });
  assert.equal(shell.classList.contains("sidebar-expanded"), false);
  assert.equal(top.focused, true);
  assert.ok(notificationClosures >= 2, "Escape dismissal also closes notification panel");
  top.emit("click");
  windowNode.innerWidth = 600;
  handlers.get("resize")();
  assert.equal(shell.classList.contains("sidebar-expanded"), false);
  assert.ok(notificationClosures >= 3, "responsive collapse also closes notification panel");
  top.emit("click");
  assert.equal(shell.classList.contains("sidebar-expanded"), false);
  assert.equal(writes.length, 0, "Drawer visibility is transient, never a persistent preference");
});

test("Learning OFF player menu keeps embedded/external captions and modal options, with outside-click dismissal", () => {
  assert.match(css, /html\[data-learning-mode="off"\]\s*\[data-learning-only\]/);
  const menu = fakeNode(); menu.hidden = true;
  const toggle = fakeNode();
  const floatingToggle = fakeNode();
  const dialog = fakeNode();
  const close = fakeNode();
  const srcMenu = fakeNode(); srcMenu.hidden = true;
  const audioMenu = fakeNode(); audioMenu.hidden = true;
  const documentNode = fakeNode();
  const attached = { id: "es", label: "Spanish", language: "es", origin: "external", visible: true };
  const state = { subtitlesVisible: true, currentSource: { kind: "torrent" },
    currentMediaProbe: { subtitleTracks: [{ textBased: true, streamIndex: 3, title: "English CC", language: "en" }] } };
  const elements = { "#player-source-menu": srcMenu, "#player-audio-menu": audioMenu,
    "#player-subtitle-menu": menu, "#player-toggle-subs": toggle, "#floating-player-captions": floatingToggle,
    "#player-subtitle-dialog": dialog, "#subtitle-manager-close": close };
  let rendered = 0;
  let imported = 0;
  const context = vm.createContext({
    $: (selector) => elements[selector], state, floatingDesktopWindow: null, subtitleRenderMemo: { key: "cached" },
    preferredSourceTracks: () => [attached], currentSourceTracks: () => [attached],
    embeddedSubtitleImports: new Map(), embeddedSubtitleImportKey: () => "key",
    embeddedSubtitleLabel: (track) => track.title, trackLanguageName: (lang) => lang,
    normalizeTrackLanguage: (lang) => lang, escapeHtml: (value) => String(value),
    revealPlayerControls() {}, clearPlayerControlsHideTimer() {}, schedulePlayerControlsHide() {},
    renderTracks() {}, renderEmbeddedSubtitleControls() {},
    renderSubtitleWorkspace: () => { rendered++; }, syncSelectedTrackForSource() {},
    importEmbeddedSubtitleTrack: () => { imported++; },
    openMenuState: null, closePopupMenu() {},
    document: { addEventListener(type, listener) { documentNode.addEventListener(type, listener); } },
  });
  const controller = section("function closePlayerPopovers(", "\nfunction renderPlayerSourceMenu(");
  const toggleController = section("function togglePlayerSubtitleMenu(", '\n$("#player-toggle-subs").addEventListener("click"');
  const actions = section('$("#player-toggle-subs").addEventListener("click"', '$("#player-loop-line").addEventListener("click"');
  // Match the player menu's own listener, not the separate update-notification
  // click-dismiss listener declared much earlier in app.js. Find via its unique
  // comment rather than hardcoding LF/CRLF source line endings.
  const playerMenuComment = app.indexOf("// The click that opened a menu (on its button)");
  const playerMenuOutsideStart = app.lastIndexOf('document.addEventListener("click", (event) => {', playerMenuComment);
  const playerMenuOutsideEnd = app.indexOf('window.addEventListener("scroll",', playerMenuComment);
  assert.ok(playerMenuComment > 0 && playerMenuOutsideStart > 0 && playerMenuOutsideEnd > playerMenuOutsideStart);
  const outside = app.slice(playerMenuOutsideStart, playerMenuOutsideEnd);
  vm.runInContext(controller + toggleController + actions + outside, context);

  toggle.emit("click");
  assert.equal(menu.hidden, false);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(floatingToggle.getAttribute("aria-expanded"), "true");
  for (const required of ["All captions", "Hide all", "Embedded in video", "English CC", "Added tracks", "Spanish", "Customize"]) {
    assert.ok(menu.innerHTML.includes(required), `Missing player caption choice ${required}`);
  }
  documentNode.emit("click", { target: { closest: () => null } });
  assert.equal(menu.hidden, true, "Outside the player, the popup must close");
  assert.equal(toggle.getAttribute("aria-expanded"), "false");

  toggle.emit("click");
  menu.emit("click", { target: { closest: () => ({ hasAttribute: (name) => name === "data-caption-off" }) } });
  assert.equal(state.subtitlesVisible, false, "Off should not remove the embedded subtitle provider");
  assert.equal(menu.hidden, false, "Keep the caption chooser open for another track selection");
  assert.ok(menu.innerHTML.includes("English CC"), "Embedded tracks remain available after Off");
  menu.emit("click", { target: { closest: () => ({ hasAttribute: (name) => name === "data-caption-embedded",
    dataset: { captionEmbedded: "3" } }) } });
  assert.equal(imported, 1, "Embedded selection uses the real import flow");
  menu.emit("click", { target: { closest: () => ({ hasAttribute: (name) => name === "data-caption-customize" }) } });
  assert.equal(dialog.open, true);
  assert.equal(menu.hidden, true);
  dialog.emit("click", { target: dialog, clientX: 160, clientY: 160 });
  assert.equal(dialog.open, true, "Clicks within the dialog rectangle must not dismiss");
  dialog.emit("click", { target: dialog, clientX: 5, clientY: 160 });
  assert.equal(dialog.open, false, "Edge-retargeted backdrop clicks dismiss modal");
  assert.ok(rendered >= 2);
  assert.match(html, /id="embedded-subtitle-tracks"/);
  assert.match(html, /id="subtitle-manager-close"/);
});

test("Watch title click navigates without requesting native PiP; in-app floating player handles continued playback", async () => {
  const watchInfo = fakeNode();
  const order = [];
  let source = { kind: "torrent", libraryId: "saved" };
  const video = { paused: false, readyState: 3, addEventListener: () => {}, requestPictureInPicture: async () => {
    order.push("PiP"); return {};
  } };
  const catalog = { pictureInPictureEnabled: true, pictureInPictureElement: null };
  const context = vm.createContext({
    video, document: catalog, HTMLMediaElement: { HAVE_CURRENT_DATA: 2 },
    viewActive: (view) => view === "watch",
    state: { get currentSource() { return source; } },
    $: (selector) => selector === "#watch-title-info" ? watchInfo : null,
    libraryEntryById: (id) => id === "saved" ? { seriesKey: "series-a", title: "Saved Title" } : null,
    buildLibrarySeries: () => [{ key: "series-a" }], librarySeriesKey: (text) => text,
    openLibrarySeries: (key) => order.push(`Library:${key}`),
    openTitlePage: ({ id }) => order.push(`Title:${id}`),
    console: { warn: () => order.push("PiP unsupported") },
  });
  vm.runInContext(section("async function navigateWatchToLibrary(", '\n$("#settings-float-auto")?.addEventListener')
    + section('$("#watch-title-info")?.addEventListener', '\n$("#watch-side-rail")?.addEventListener'), context);
  const click = (dataset) => watchInfo.emit("click", { target: { closest: () => ({ dataset }) } });
  click({ watchSeriesKey: "series-a", watchCatalogId: "tt2359704" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["Library:series-a"]);
  order.length = 0;
  source = { kind: "torrent", libraryId: "not-saved" };
  video.requestPictureInPicture = async () => { throw new Error("user denied PiP"); };
  click({ watchSeriesKey: "", watchCatalogId: "tt28618556", watchCatalogType: "series" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["Title:tt28618556"]);
  order.length = 0;
  video.paused = true;
  click({ watchSeriesKey: "series-a", watchCatalogId: "" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["Library:series-a"]);
});

test("26 Specials remain separate from 13 playable chapters and expanded title metadata retains IMDb root rating", () => {
  const context = vm.createContext({
    titleSeedMeta: new Map(), homeTitleIndex: new Map(),
    libraryArtCached: () => null, largePosterUrl: (url) => url, preferredPosterArt, boundedPosterUrl,
    metahubVariant: (url) => url,
    icon: (name) => `<icon>${name}</icon>`,
    escapeHtml: (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;"),
  });
  vm.runInContext(section("function catalogChapterListFrom(", "\n// Catalog art"), context);
  vm.runInContext(section("function titleInfo(", "\n// The catalog record new sources"), context);
  vm.runInContext(section("function titleRatingBreakdownMarkup(", "\nfunction titleTrailerUrl("), context);
  const episodes = (count) => Array.from({ length: count }, (_, i) => ({ episode: i + 1, name: `Episode ${i + 1}` }));
  const meta = { id: "tt28618556", name: "Lord of Mysteries", logo: "https://example.com/logo.png",
    poster: "https://example.com/poster.png", background: "https://example.com/background.png",
    releaseInfo: "2025–", imdbRating: "8.5", genres: ["Animation", "Adventure"],
    description: "A mystery beneath the fog.", country: "China", cast: ["Voice Actor"],
    trailers: [{ id: "abcdef12345", title: "Trailer" }],
    seasons: [{ season: 0, count: 26, episodes: episodes(26) },
      { season: 1, count: 13, episodes: episodes(13) }],
  };
  const chapters = vm.runInContext("catalogChapterListFrom", context)(meta);
  assert.equal(chapters.seasons.length, 2);
  assert.equal(chapters.chapters.length, 13);
  assert.ok(chapters.chapters.every((chapter) => chapter.season === 1));
  assert.equal(chapters.seasons[0].episodes[25].episode, 26, "Last special cannot be truncated");
  const info = vm.runInContext("titleInfo", context)({ id: meta.id, type: "series", series: null }, meta);
  assert.deepEqual([info.name, info.releaseInfo, info.chapterTotal, info.specialCount, info.seasonCount],
    ["Lord of Mysteries", "2025–", 13, 26, 1]);
  assert.equal(info.description, meta.description);
  assert.equal(info.logo, meta.logo);
  assert.equal(info.country, "China");
  const score = vm.runInContext("titleRatingMarkup", context)(info);
  assert.match(score, /8\.5/);
  assert.match(score, /Season 1[\s\S]*Unavailable/);
  assert.match(score, /IMDb season scores are not supplied by the catalog/);
  assert.ok(!score.includes("Season 0"), "Specials are not regular IMDb season scores");
});

test("Watch renders full catalog details below the player and keeps Related/Recommended in their own rail", () => {
  assert.ok(html.indexOf('id="video"') < html.indexOf('id="watch-title-info"'));
  assert.ok(html.indexOf('id="watch-title-info"') < html.indexOf('id="watch-side-rail"'));
  const info = fakeNode(); info.hidden = true;
  const rail = fakeNode(); rail.hidden = true;
  const layout = fakeNode();
  const related = fakeNode(); related.hidden = true;
  const recommended = fakeNode(); recommended.hidden = true;
  const full = { id: "tt2359704", name: "JoJo's Bizarre Adventure", poster: "https://example.com/poster.jpg",
    description: "Full public catalog synopsis.", releaseInfo: "2012–", imdbRating: "8.6",
    genres: ["Animation", "Action"], country: "Japan", status: "Ended", awards: "Five awards",
    cast: ["Lead One", "Lead Two"], writer: ["Writer"], director: ["Director"],
    seasons: [{ season: 0, count: 23 }, { season: 1, count: 26 }, { season: 2, count: 48 }],
  };
  const series = { type: "series", mediaKind: "anime", key: "jojo", title: "JoJo's Bizarre Adventure",
    catalogId: full.id, coverUrl: "https://example.com/poster.jpg" };
  const entry = { id: "saved", title: series.title, catalogId: full.id };
  const context = vm.createContext({
    $: (selector) => ({ "#watch-title-info": info, "#watch-side-rail": rail,
      "#watch-player-layout": layout, "#watch-related": related, "#watch-recommended": recommended })[selector],
    state: { homeLoaded: true, homeCatalog: {}, homeCatalogUpdatedAt: 1 },
    catalogChapterLists: new Map([[full.id, { meta: full }]]), movieArtRecords: new Map(),
    titleSeedMeta: new Map(), homeTitleIndex: new Map(),
    watchCatalogIdFor: () => full.id, libraryArtCached: () => ({ description: "Abbreviated Home synopsis" }),
    libraryArtFor() {}, catalogChapterList() {}, libraryOrderedChapters: () => [],
    titleInfo: null, seriesAniList: () => null, watchTrackingStatus: () => "", formatTitleDay: () => "",
    formatRuntime: (value) => value, titleListText: (items) => items.join(", "),
    ANILIST_STATUS_LABELS: {}, anilistProgressText: () => "",
    watchSidebarPicks: () => ({
      related: [{ id: "tt1000001", name: "Related Show", type: "series", poster: "", genres: ["Animation"] }],
      recommended: [{ id: "tt1000002", name: "Recommended Show", type: "series", poster: "", genres: ["Action"] }],
    }),
    largePosterUrl: (url) => url, artworkFallback: (title) => `fallback:${title}`,
    posterSrcset, preferredPosterArt, boundedPosterUrl,
    escapeHtml: (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;"),
    icon: () => "", refreshImages() {}, loadHomeCatalog() {},
    metahubVariant: (url) => url,
  });
  vm.runInContext(section("function titleInfo(", "\n// The catalog record new sources"), context);
  vm.runInContext('let watchInfoRenderKey = "";' + section("function renderWatchInfo(", "\nfunction renderWatchChapters()"), context);
  vm.runInContext("renderWatchInfo", context)(series, entry);
  assert.equal(info.hidden, false);
  assert.equal(rail.hidden, false);
  assert.equal(layout.classList.contains("has-chapters"), true);
  assert.match(info.innerHTML, /Full public catalog synopsis/);
  assert.doesNotMatch(info.innerHTML, /Abbreviated Home synopsis/);
  for (const fact of ["JoJo", "2012", "8.6", "Japan", "Five awards", "Director", "data-watch-title-details"]) {
    assert.ok(info.innerHTML.includes(fact), `Missing Watch title detail ${fact}`);
  }
  assert.doesNotMatch(info.innerHTML, /Starring|Lead One/, "Anime should hide the cast row on Watch too");
  assert.match(related.innerHTML, /Related Show/);
  assert.doesNotMatch(related.innerHTML, /Recommended Show/);
  assert.match(recommended.innerHTML, /Recommended Show/);
  assert.doesNotMatch(recommended.innerHTML, /Related Show/);
});

test("loading source identity changes without displaying a redundant video title", () => {
  const context = vm.createContext({});
  vm.runInContext(section("let playerLoadingLibraryId = \"\";", "\n// Loading stages"), context);
  const setTitle = vm.runInContext("setPlayerLoadingTitle", context);
  setTitle({ id: "jojo", title: "JoJo's Bizarre Adventure" });
  assert.equal(vm.runInContext("playerLoadingLibraryId", context), "jojo");
  setTitle({ id: "steel", title: "Steel Ball Run", coverUrl: "https://images.example/old.png" });
  assert.equal(vm.runInContext("playerLoadingLibraryId", context), "steel");
  setTitle(null, "Standalone film without catalog art");
  assert.equal(vm.runInContext("playerLoadingLibraryId", context), "");
  assert.match(app, /function setPlayerLoadingArtwork\(primary, fallback = ""\)/);
  assert.match(app, /playerLoadingArtworkRequest/);
  assert.match(app, /logoUrl\(\{ id, logo: raw \}\)/);
  assert.doesNotMatch(html, /id="video-loading-(?:media-title|copy)"/);
  assert.match(css, /\.video-loading-brand__fill\s*\{[^}]*clip-path:inset/);
  assert.match(css, /\.video-loading\.is-error \.video-loading-title\s*\{[^}]*position:static/);
  assert.doesNotMatch(html, /class="video-loading-activity"|id="video-loading-percent"/);
});

test("watched/unwatched state survives Library persistence and overrides stale finished playback from duplicate sources", () => {
  const sourceA = { id: "a", title: "Series", seriesKey: "series", episodes: [
    { code: "S01E03", progress: { durationMs: 1000, positionMs: 1000, finished: true } } ], watchedChapters: {} };
  const sourceB = { id: "b", title: "Series", seriesKey: "series", episodes: [
    { code: "S01E03", progress: { durationMs: 1000, positionMs: 600, finished: false } } ], watchedChapters: {} };
  const state = { library: [sourceA, sourceB], currentSource: { libraryId: "a" } };
  const persisted = [];
  const context = vm.createContext({
    state, librarySeriesKey: (name) => name.toLowerCase(),
    chapterWatchStatus: (sources) => ({ watched: sources.some(({ episode }) => episode.progress?.finished),
      percent: 100, resume: null, saved: sources.length > 0 }),
    explicitUnwatchCompletionArmed: new Set(),
    persistAniListQueue() {}, anilistStoredQueue: () => [],
    saveLibrary: () => { persisted.push(JSON.stringify(state.library)); },
    savePendingAniListUnwatches() {}, pendingAniListUnwatches: () => [],
  });
  vm.runInContext(section("function manuallyWatchedChapter(", "\nconst ANILIST_UNWATCH_QUEUE_KEY"), context);
  vm.runInContext(section("function markWatchEpisodeWatched(", "\nfunction markTitleChapterWatched"), context);
  const status = vm.runInContext("watchEpisodeStatus", context);
  const unwatch = vm.runInContext("markWatchEpisodeUnwatched", context);
  const watch = vm.runInContext("markWatchEpisodeWatched", context);
  const series = { key: "series" };
  const chapter = { code: "S01E03", stored: { sources: [{ episode: sourceA.episodes[0] }, { episode: sourceB.episodes[0] }] } };

  assert.equal(status(series, chapter).watched, true);
  assert.equal(unwatch(series, "S01E03"), true);
  assert.equal(sourceA.watchedChapters.S01E03, false);
  assert.equal(sourceA.episodes[0].progress.finished, false);
  assert.equal(sourceA.episodes[0].progress.positionMs, 1000, "Unwatch cannot destroy the saved resume point");
  assert.equal(status(series, chapter).watched, false);
  assert.equal(persisted.length, 1);
  sourceB.episodes[0].progress.finished = true; // A delayed imported progress snapshot.
  assert.equal(status(series, chapter).watched, false, "Explicit unwatch wins over stale imported completion");

  state.library = JSON.parse(persisted[0]);
  assert.equal(status(series, { code: "S01E03", stored: { sources: [{ episode: state.library[1].episodes[0] }] } }).watched,
    false, "Persisted explicit unwatch survives Library reload");
  assert.equal(watch(series, "S01E03", { sources: state.library.map((entry) => ({ episode: entry.episodes[0] })) }), true);
  assert.equal(status(series, { code: "S01E03", stored: { sources: [{ episode: state.library[0].episodes[0] }] } }).watched, true);
  assert.equal(state.library[0].watchedChapters.S01E03 > 0, true);
});

test("a completed older source cannot hide newer loading or an error/retry panel", () => {
  const overlay = { hidden: true, classList: fakeClasses(), style: { values: {},
    setProperty(name, value) { this.values[name] = value; } } };
  const nodes = { "#video-loading": overlay, "#video-loading-actions": { hidden: true },
    "#video-loading-title": { textContent: "" } };
  const timers = new Map();
  let id = 0;
  const state = { loadingProgress: 0, loadingDetail: "", loadingTransferDetail: "" };
  const context = vm.createContext({
    $: (selector) => nodes[selector], state, currentRecoveryKey: () => "retry-possible",
    recoveryDisplayPhase: "", renderRecoveryOverlay() {},
    frame: { classList: fakeClasses(["source-transition"]) },
    window: { setTimeout(fn) { timers.set(++id, fn); return id; }, clearTimeout(timer) { timers.delete(timer); } },
  });
  vm.runInContext(section("let playerLoadingHideTimer = 0;", "\nfunction updateLoadingTransferDetail(")
    + section("function finishPlayerLoading() {", "\nfunction clearPlayerControlsHideTimer()"), context);
  const loading = vm.runInContext("setPlayerLoading", context);
  const finish = vm.runInContext("finishPlayerLoading", context);
  loading(70, "Reading media");
  finish();
  assert.equal(timers.size, 1);
  loading(4, "Connecting new source");
  assert.equal(timers.size, 0, "A new request must cancel prior delayed overlay dismissal");
  assert.equal(overlay.hidden, false);
  loading(60, "Finding peers");
  loading(100, "Playback unavailable", "Retry or choose source", { error: true });
  const stage = state.loadingProgress;
  finish();
  assert.equal(state.loadingProgress, stage, "Late canplay cannot fake completion after failure");
  assert.equal(timers.size, 0);
  assert.equal(overlay.classList.contains("is-error"), true);
  assert.equal(nodes["#video-loading-actions"].hidden, false, "Retry remains reachable");
  assert.equal(overlay.hidden, false);
});
