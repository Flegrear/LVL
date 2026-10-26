import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { findSavedRandomTitle, randomPickIdentity, randomPickMatchesCategory, randomSeriesAlreadySeen, verifiedRandomCatalogMatch } from "../frontend/catalog/home-feed.js";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../frontend/styles/styles.css", import.meta.url), "utf8");

test("Home has browsing controls while Watch uses a separate branded header with search", () => {
  const home = html.slice(html.indexOf('<header id="home-topbar"'), html.indexOf("</header>"));
  const section = html.slice(html.indexOf('<header id="section-topbar"'), html.indexOf("</header>", html.indexOf('<header id="section-topbar"')));
  assert.match(home, /id="home-search-title"/);
  assert.match(home, /id="home-tabs"/);
  assert.match(home, /id="home-refresh-picks"[^>]*aria-label="Open random recommendation"/);
  assert.match(home, /id="home-open-library"[^>]*aria-label="Open Library"/);
  assert.doesNotMatch(home, /id="home-brand-link"|app-topbar__brand/);
  assert.match(section, /id="section-search-title"/);
  assert.match(section, /id="section-random-pick"[^>]*aria-label="Open random recommendation"/);
  assert.match(section, /id="section-open-library"[^>]*aria-label="Open Library"/);
  assert.ok(section.indexOf('id="section-search-title"') < section.indexOf('id="section-random-pick"') && section.indexOf('id="section-random-pick"') < section.indexOf('id="section-open-library"'));
  assert.match(section, /id="section-sidebar-toggle"/);
  assert.doesNotMatch(section, /id="section-brand-link"|app-topbar__brand/);
  assert.match(section, /id="app-topbar-view-label" class="ui-visually-hidden"/);
  assert.doesNotMatch(section, /id="home-tabs"|id="home-refresh-picks"/);
  assert.doesNotMatch(section, /<kbd[^>]*>\/</);
  assert.doesNotMatch(css, /\.home-topbar__library\s*\{\s*display:none;/, "Library button must remain on mobile");
  assert.match(css, /\.section-topbar:not\(\.is-solid\)\s*\{[^}]*background:linear-gradient/);
  assert.doesNotMatch(css, /#view-watch:not\(\.is-floating\)\s*\{\s*margin-top:calc\(var\(--ui-topbar-h\) \* -1\)/);
});

test("LVL icon sits at the top of the actual sidebar and navigates to /home", () => {
  const sidebar = html.slice(html.indexOf('<aside id="app-primary-nav"'), html.indexOf('</aside>'));
  const head = sidebar.slice(sidebar.indexOf('class="sidebar-head"'), sidebar.indexOf('class="sidebar-label"'));
  assert.match(head, /id="sidebar-brand-link" class="sidebar-brand-link" type="button" aria-label="Go to Home"/);
  assert.match(head, /src="\/brand\/lvl_app_icon_dark\.svg"/);
  assert.match(head, /id="sidebar-toggle"/);
  assert.ok(head.indexOf('id="sidebar-toggle"') < head.indexOf('id="sidebar-brand-link"'), "hamburger stays on the left; LVL icon moves to the right");
  assert.match(css, /\.sidebar-brand-link:focus-visible\s*\{\s*outline:2px solid #fff;/);
  assert.doesNotMatch(html, /id="home-brand-link"|id="section-brand-link"/);
  const start = app.indexOf('$("#sidebar-brand-link")?.addEventListener("click", () => {');
  const end = app.indexOf('let previousRandomRecommendationId = "";', start);
  assert.ok(start >= 0 && end > start);
  const handlers = {};
  const visited = [];
  const context = vm.createContext({
    $: (selector) => ({ addEventListener: (_type, callback) => { handlers[selector] = callback; } }),
    viewActive: (view) => view === "home" && visited.includes("home"),
    window: { scrollTo: (options) => visited.push(`scroll:${options.top}`) },
    switchView: (view) => visited.push(view),
  });
  vm.runInContext(app.slice(start, end), context);
  handlers["#sidebar-brand-link"]();
  assert.deepEqual(visited, ["home"]);
  handlers["#sidebar-brand-link"]();
  assert.deepEqual(visited, ["home", "scroll:0", "home"]);
});

test("Only the active header is visible; ui.css cannot override section-header hidden state", () => {
  assert.match(css, /\.app-shell:has\(#view-home\.is-active\) #section-topbar\s*\{\s*display:none;/);
  assert.match(css, /\.app-shell:not\(:has\(#view-home\.is-active\)\) \.home-topbar\s*\{\s*display:none;/);
  assert.match(css, /\.app-shell:not\(:has\(#view-home\.is-active\)\) #section-topbar\s*\{\s*display:flex;/);
  assert.match(css, /\/\* ui\.css is loaded after styles\.css and gives \.ui-topbar display:flex\./);
  assert.match(css, /\.app-topbar #home-tabs\s*\{[^}]*overflow-x:auto;/);
  assert.equal((html.match(/id="catalog-search-shell"/g) || []).length, 1);
});

test("Library, title, Calendar, Settings and study sections use the same searchable section topbar", () => {
  assert.match(css, /\.app-shell:not\(:has\(#view-home\.is-active\)\) #section-topbar\s*\{\s*display:flex;/);
  assert.match(css, /@media \(max-width: 680px\)[\s\S]*?\.section-topbar\s*\{\s*gap:10px; min-height:48px; padding:0 12px;/);
  assert.match(html, /id="section-catalog-search-host"/);
  assert.match(app, /document\.querySelector\("\.view\.is-active"\)/);
  assert.match(app, /openCatalogSearch\(viewActive\("home"\) \? "topbar" : "section"\);/);
});

test("Selecting a category from Library or title details navigates to the correct Home shelf", () => {
  const start = app.indexOf('bindTabs($("#home-tabs"), {');
  const end = app.indexOf('setActiveTab($("#home-tabs"), homeBrowseCategory);', start);
  assert.ok(start >= 0 && end > start);
  const visited = [];
  const saved = [];
  let currentView = "library";
  let onChange;
  const context = vm.createContext({
    $: () => ({ offsetHeight: 100 }),
    bindTabs: (_element, options) => { onChange = options.onChange; },
    animeBrowser: { openRequestId: 0 },
    animeBrowserPrefetchTimer: 0,
    homeBrowseCategory: "all",
    normalizeHomeCategory: (value) => value,
    localStorage: { setItem: (...args) => saved.push(args) },
    window: { clearTimeout() {}, scrollY: 0, scrollTo() {} },
    viewActive: (view) => view === currentView,
    switchView: (view) => { visited.push(view); currentView = view; },
    renderHome: () => visited.push("render"),
  });
  vm.runInContext(app.slice(start, end), context);
  onChange("anime");
  assert.deepEqual(visited, ["home", "render"]);
  assert.deepEqual(saved, [["blackline-home-filter", "anime"]]);
  onChange("movie");
  assert.deepEqual(visited, ["home", "render", "render"], "already on Home: filter without redundant navigation");
});

test("Player groups transfers with elapsed time and uses a shadow-free playback speed menu", () => {
  assert.match(html, /class="player-playback-metrics"[\s\S]*?id="player-transfer-stats"[\s\S]*?id="compat-time"[\s\S]*?<\/div>/);
  assert.match(css, /\.player-playback-metrics\s*\{[^}]*display:inline-flex;[^}]*gap:12px;/);
  assert.match(css, /\.player-control-row > :is\(#player-prev-chapter,#player-seek-back,#compat-play,#player-seek-forward,#player-next-chapter\)\[data-tooltip\]::after\s*\{\s*display:none;/);
  assert.match(css, /\.player-speed-menu\s*\{[^}]*background:transparent;\s*\}/);
  assert.match(css, /\.player-speed-menu button\s*\{[^}]*background:transparent;[^}]*font:600 12px\/1\.2 var\(--font-sans\);/);
});

function makeRandomFixture(picks) {
  const opened = [];
  const notifications = [];
  const trigger = { disabled: false, addEventListener(type, callback) { this[type] = callback; },
    setAttribute() {}, removeAttribute() {}, classList: { toggle() {} } };
  const saved = [
    { key: "completed", title: "Completed Show", type: "series", catalogId: "tt111111", sources: [{ id: "done", watchedTitleAt: 123 }] },
    { key: "watching", title: "Watching Show", type: "series", catalogId: "tt222222", sources: [{ id: "started", episodes: [{ progress: { positionMs: 120000, durationMs: 240000, finished: false } }] }] },
  ];
  const context = vm.createContext({
    $: (selector) => selector === "#home-refresh-picks" ? trigger : null,
    recsUi: { load: async () => ({ picks }), openPick: (id) => opened.push({ externalId: id }) },
    buildLibrarySeries: () => saved,
    librarySeriesKey: (title) => String(title).toLowerCase(),
    seriesAniList: () => null,
    anilistStatusKey: () => "",
    isLibraryTitleMarkedWatched: (series) => Boolean(series.watched),
    seriesResumePoint: (series) => series.progress ? { progress: series.progress } : null,
    openHomeTitle: (meta) => opened.push({ id: meta.id, name: meta.name }),
    openLibrarySeries: (key) => opened.push({ seriesKey: key }),
    toast: (message) => notifications.push(message),
    document: { addEventListener() {} },
    window: { addEventListener() {} },
    reasonGroups: () => ({ matches: [], cautions: [], context: [] }),
    escapeHtml: (value) => String(value),
    requestAnimationFrame: (callback) => callback(),
    Math: { random: () => 0, floor: Math.floor },
    localStorage: { getItem: () => null, setItem() {} },
    homeBrowseCategory: "all",
    state: { currentSource: null },
    viewActive: (name) => name === "home",
    titleRoute: () => ({ id: opened.at(-1)?.id || "", key: "" }),
    randomPickIdentity,
    randomPickMatchesCategory,
    randomSeriesAlreadySeen,
    findSavedRandomTitle,
    verifiedRandomCatalogMatch,
    libraryView: { filter: "all" },
    resolveAnimeBrowserCatalog: async (media) => ({ id: "tt444444", type: "series", name: media.title }),
    openTitlePage: (meta) => opened.push({ id: meta.id, name: meta.meta?.name }),
    URLSearchParams,
  });
  const start = app.indexOf('let previousRandomRecommendationId = "";');
  const end = app.indexOf('$("#view-home")?.addEventListener("click", handleCatalogCardAction)', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(app.slice(start, end), context);
  return { opened, notifications, trigger, invoke: () => vm.runInContext("openRandomRecommendation()", context) };
}

test("Random recommendation avoids seen titles and immediate repeats without preferring partly watched titles", async () => {
  const picks = [
    { itemId: "completed", imdbId: "tt111111", type: "series", title: "Completed Show" },
    { itemId: "watching", imdbId: "tt222222", type: "series", title: "Watching Show" },
    { itemId: "new", imdbId: "tt333333", type: "series", title: "New Show" },
  ];
  const fixture = makeRandomFixture(picks);
  await fixture.invoke();
  await fixture.invoke();
  assert.deepEqual(fixture.opened.map(({ id }) => id), ["tt333333", "tt333333"]);
  assert.equal(fixture.trigger.disabled, false);
  assert.deepEqual(fixture.notifications, []);
});

test("Random recommendation opens trusted catalog alternatives and reports missing picks", async () => {
  const anilist = makeRandomFixture([{ itemId: "anilist-1", title: "Anime Pick", type: "series", url: "https://anilist.co/anime/1234" }]);
  await anilist.invoke();
  assert.deepEqual(anilist.opened, [], "a non-AniList provider without a verified ID never opens an external destination");
  const missing = makeRandomFixture([]);
  await missing.invoke();
  assert.match(missing.notifications[0], /recommendations have no eligible picks yet/i);
  assert.equal(missing.trigger.disabled, false);
});
