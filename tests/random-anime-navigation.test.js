import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { reasonGroups } from "../frontend/recommendations/recs-ui.js";
import { findSavedRandomTitle, randomPickIdentity, randomPickMatchesCategory, randomSeriesAlreadySeen, verifiedRandomCatalogMatch } from "../frontend/catalog/home-feed.js";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../frontend/styles/styles.css", import.meta.url), "utf8");
const start = app.indexOf('let previousRandomRecommendationId = "";');
const end = app.indexOf('$("#view-home")?.addEventListener("click", handleCatalogCardAction)', start);
assert.ok(start > 0 && end > start);

function fixture({ picks = [], discovery = [], catalogSearch = [], saved = [], category = "anime", source = "recommended", catalog = null,
  recsResponses = null, refreshError = null } = {}) {
  const opened = [];
  const requests = [];
  const posts = [];
  const loadCalls = [];
  const notifications = [];
  let nextRecsResponse = 0;
  let timerCalls = 0;
  let view = "home";
  const trigger = () => ({
    disabled: false, attributes: new Map(),
    activeClasses: new Set(),
    addEventListener(type, fn) { this[type] = fn; },
    setAttribute(key, value) { this.attributes.set(key, value); },
    removeAttribute(key) { this.attributes.delete(key); },
    classList: { toggle(name, on) { if (on) this.owner.activeClasses.add(name); else this.owner.activeClasses.delete(name); } },
    getBoundingClientRect() { return { right: 960, top: 45, bottom: 85 }; },
    focus() {},
  });
  const home = trigger();
  const section = trigger();
  home.classList.owner = home;
  section.classList.owner = section;
  const popover = {
    hidden: true, innerHTML: "", style: {}, offsetHeight: 155, listeners: {},
    getBoundingClientRect() { return { width: 310, bottom: 280 }; },
    addEventListener(name, fn) { this.listeners[name] = fn; },
    querySelector() { return { focus() {} }; },
    focus() {},
  };
  const elements = { "#home-refresh-picks": home, "#section-random-pick": section, "#random-pick-popover": popover };
  const stored = new Map(source === "recommended" ? [] : [["lvl-random-source", source]]);
  const setting = { value: "", addEventListener(name, fn) { this[name] = fn; } };
  elements["#settings-random-source"] = setting;
  const ctx = vm.createContext({
    $: (selector) => elements[selector] ?? null,
    document: { addEventListener() {} },
    window: { innerWidth: 1000, innerHeight: 800, addEventListener() {} },
    requestAnimationFrame: (fn) => fn(),
    viewActive: (name) => name === view,
    titleRoute: () => ({ id: opened.at(-1)?.id || "", key: opened.at(-1)?.key || "" }),
    escapeHtml: (str) => String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
    reasonGroups,
    buildLibrarySeries: () => saved,
    librarySeriesKey: (str) => String(str).toLowerCase(),
    seriesAniList: () => null,
    anilistStatusKey: () => "",
    isLibraryTitleMarkedWatched: () => false,
    seriesResumePoint: () => null,
    recsUi: {
      load: async (options = {}) => {
        loadCalls.push(options);
        return recsResponses ? recsResponses[Math.min(nextRecsResponse++, recsResponses.length - 1)] : { picks };
      },
      openPick: (id) => opened.push({ externalId: id }),
    },
    fetchJson: async (url) => { requests.push(url); return url.startsWith("/api/catalog/search?") ? { results: catalogSearch } : { items: discovery }; },
    postJson: async (url, body) => { posts.push({ url, body }); if (refreshError) throw refreshError; return {}; },
    // Run one polling step per awaited timer, without spending real seconds in a VM test.
    setTimeout: (callback) => { timerCalls += 1; callback(); return timerCalls; },
    resolveAnimeBrowserCatalog: async (media) => ({ id: "tt7654321", type: "series", name: media.title }),
    openHomeTitle: (meta) => { opened.push(meta); view = "title"; },
    openTitlePage: (meta) => { opened.push(meta); view = "title"; },
    openLibrarySeries: (key) => { opened.push({ key }); view = "title"; },
    toast: (message) => notifications.push(message),
    localStorage: { getItem: (key) => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) },
    homeBrowseCategory: category,
    libraryView: { filter: "all" },
    state: { currentSource: null, homeLoaded: Boolean(catalog), homeCatalog: catalog || { movies: [], series: [], anime: [] } },
    randomPickIdentity, randomPickMatchesCategory, randomSeriesAlreadySeen, findSavedRandomTitle, verifiedRandomCatalogMatch,
    Math: { floor: Math.floor, min: Math.min, max: Math.max, random: () => .3 },
    URLSearchParams,
  });
  vm.runInContext(app.slice(start, end), ctx);
  return {
    home, section, popover, opened, requests, posts, loadCalls, notifications,
    get timerCalls() { return timerCalls; },
    setting, stored, setView: (name) => { view = name; },
    choose: (mode) => popover.listeners.click({ target: { closest: () => ({ dataset: { randomMode: mode } }) } }),
    run: (script) => vm.runInContext(script, ctx),
  };
}

test("Random and Library occupy the same two final navbar slots on Home and every section", () => {
  const home = html.slice(html.indexOf('<header id="home-topbar"'), html.indexOf("</header>"));
  const section = html.slice(html.indexOf('<header id="section-topbar"'), html.indexOf("</header>", html.indexOf('<header id="section-topbar"')));
  for (const [markup, random, library] of [
    [home, "home-refresh-picks", "home-open-library"],
    [section, "section-random-pick", "section-open-library"],
  ]) {
    assert.ok(markup.indexOf('class="catalog-search-host"') < markup.indexOf(`id="${random}"`));
    assert.ok(markup.indexOf(`id="${random}"`) < markup.indexOf(`id="${library}"`));
    assert.match(markup, new RegExp(`id="${random}"[^>]*aria-controls="random-pick-popover"`));
    assert.equal((markup.match(/class="ui-icon-btn[^"]*"/g) || []).length, 2);
  }
  assert.match(css, /\.app-topbar \.ui-topbar__actions > \.ui-icon-btn\s*\{ flex:0 0 40px; \}/);
  assert.match(app, /\$\("#section-open-library"\)\?\.addEventListener\("click", \(\) => switchView\("library"\)\)/);
  assert.match(html, /id="random-pick-popover"[^>]*role="dialog"/);
});

test("Random anime recommendations use AniList picks only and explain observed fan votes", async () => {
  const f = fixture({ picks: [
    { itemId: "tv", source: "tmdb", type: "series", imdbId: "tt1234567", title: "Other TV" },
    { itemId: "violet", source: "anilist", type: "series", imdbId: "tt7654321", title: "Violet Evergarden",
      reasons: [{ kind: "fans", from: [{ title: "Frieren", score: 9.8, votes: 212 }] }] },
  ] });
  f.home.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.opened.length, 1);
  assert.equal(f.opened[0].name, "Violet Evergarden");
  assert.doesNotMatch(f.popover.innerHTML, /Recommended: Violet Evergarden/);
  assert.match(f.popover.innerHTML, /Why it matches your taste/);
  assert.match(f.popover.innerHTML, /Fans of Frieren/);
  assert.match(f.popover.innerHTML, /212 votes/);
  assert.equal(f.section.attributes.get("aria-expanded"), "true");
  assert.doesNotMatch(f.popover.innerHTML, /above your average/, "never imply rating-relative preference without evidence");
  f.choose("close");
  assert.equal(f.popover.hidden, true, "reason popup can be dismissed");
  assert.equal(f.section.attributes.get("aria-expanded"), "false");
  assert.equal(f.section.attributes.get("aria-label"), "Show why this title was recommended");
  assert.ok(f.section.activeClasses.has("is-random-entry"), "the active random entry shows a white icon glow");
  f.section.pointerenter();
  assert.equal(f.popover.hidden, false, "hover restores the exact saved recommendation without a new random pick");
  assert.match(f.popover.innerHTML, /Fans of Frieren/);
  assert.equal(f.opened.length, 1);
  f.run('rememberRandomEntry({mode:"anything"})');
  assert.equal(f.section.attributes.get("aria-label"), "Randomly chosen title");
  f.setView("library");
  f.run("refreshRandomPickIndicator()");
  assert.equal(f.section.activeClasses.has("is-random-entry"), false, "glow disappears when leaving the random title");
  assert.equal(f.popover.hidden, true, "the explanation cannot leak into another view");
});

test("Random popup separates public reception and a disliked fan source from positive evidence", async () => {
  const f = fixture({ picks: [{
    itemId: "mob", source: "anilist", type: "series", imdbId: "tt7654321", title: "Mob Psycho 100",
    reasons: [
      { kind: "fans", from: [{ title: "JUJUTSU KAISEN", score: 9.4, votes: 212 }] },
      { kind: "shared", names: ["Drama", "Male Protagonist", "Coming of Age"] },
      { kind: "community", score: 84, scoredBy: 306826, source: "anilist" },
      { kind: "caution", from: [{ title: "My Hero Academia", score: 6 }] },
      { kind: "planned" },
    ],
  }] });
  f.home.click();
  await new Promise((resolve) => setImmediate(resolve));
  const html = f.popover.innerHTML;
  assert.match(html, /Why it matches your taste/);
  assert.match(html, /categories associated with titles you rated higher/);
  assert.match(html, /Counter-signals/);
  assert.match(html, /your 6\.00 rating of My Hero Academia.*counts against this match/);
  assert.doesNotMatch(html, /Additional context|AniList users rate it|Recommended: Mob Psycho/);
  assert.ok(html.indexOf("Counter-signals") > html.indexOf("Why it matches your taste"));
  assert.ok(html.indexOf("Counter-signals") > html.indexOf("Why it matches your taste"));
});

test("Anything anime samples discover rather than recommendations and opens only verified catalog matches", async () => {
  const f = fixture({ source: "anything", discovery: [{ id: 553, title: "Random Anime", format: "TV", year: 2010, status: "FINISHED" }] });
  f.home.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.opened.map((entry) => entry.id), ["tt7654321"]);
  assert.equal(f.requests.length, 2, "sparse historical samples are supplemented by a broad unfiltered page");
  assert.match(f.requests[0], /^\/api\/anime\/discover\?/);
  assert.match(f.requests[1], /year=all/);
  assert.equal(f.popover.hidden, true, "Anything goes straight to the title with no reason popup");
});

test("Empty personalized anime picks remain explicitly empty without switching to Anything", async () => {
  const f = fixture({ picks: [{ itemId: "movie", source: "tmdb", type: "movie", imdbId: "tt1234567", title: "A movie" }] });
  await f.run('openRandomRecommendation({ category: "anime" })');
  assert.equal(f.opened.length, 0);
  assert.equal(f.requests.length, 0);
  assert.equal(f.popover.hidden, true);
});

test("Random defaults to Recommended and never opens the old chooser on click", async () => {
  const f = fixture({ picks: [{ itemId: "a", source: "anilist", type: "series", title: "Show", imdbId: "tt7654321" }] });
  assert.equal(f.setting.value, "recommended");
  f.home.click();
  assert.doesNotMatch(f.popover.innerHTML, /Choose a random title|Anything · Anime/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.opened.length, 1);
  assert.doesNotMatch(f.popover.innerHTML, /Recommended: Show/);
  assert.match(f.popover.innerHTML, /no documented personal match reason/i);
});

test("First Random click with 71 imported AniList scores generates picks once and opens after two forced polls", async () => {
  const pick = { itemId: "anilist:1", source: "anilist", type: "series", imdbId: "tt7654321", title: "Violet Evergarden" };
  const initial = { picks: [], settings: { anilist: { scored: 71 } }, stats: { ratings: 71 }, status: { lastRun: null, running: null } };
  const running = { ...initial, status: { lastRun: { status: "running" }, running: { phase: "Ranking", progress: .6 } } };
  const finished = { ...initial, picks: [pick], status: { lastRun: { status: "done" }, running: null } };
  const f = fixture({ recsResponses: [initial, running, finished] });

  f.home.click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(f.opened.length, 1);
  assert.equal(f.opened[0].id, pick.imdbId);
  assert.equal(f.opened[0].name, pick.title);
  assert.deepEqual(f.posts.map((request) => request.url), ["/api/recs/refresh"], "initial generation runs only once");
  assert.deepEqual(f.loadCalls.map((options) => options.force === true), [false, true, true]);
  assert.equal(f.timerCalls, 2, "one bounded polling wait per forced load");
  assert.equal(f.home.disabled, false);
  assert.equal(f.section.disabled, false);
  assert.match(f.popover.innerHTML, /no documented personal match reason/i);
});

test("First Random click without rating seeds reports no picks and never starts refresh", async () => {
  const f = fixture({ recsResponses: [{ picks: [], settings: { anilist: { scored: 0 } },
    stats: { ratings: 0 }, status: { lastRun: null, running: null } }] });

  f.home.click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(f.opened.length, 0);
  assert.equal(f.posts.length, 0, "no fan recommendations can be generated without rating seeds");
  assert.deepEqual(f.loadCalls, [{}]);
  assert.equal(f.timerCalls, 0);
  assert.equal(f.home.disabled, false);
  assert.equal(f.section.disabled, false);
  assert.equal(f.popover.hidden, true);
  assert.match(f.notifications.at(-1), /recommendations have no eligible picks yet/i);
});

test("Random waits for a recommendation run already started elsewhere without launching a second refresh", async () => {
  const pick = { itemId: "anilist:2", source: "anilist", type: "series", title: "Haikyu!!", imdbId: "tt3398540" };
  const running = {
    picks: [],
    settings: { anilist: { scored: 71 } },
    stats: { ratings: { anilist: { count: 122, scored: 71 }, app: { count: 1, scored: 1 } } },
    status: { lastRun: { status: "running" }, running: { phase: "Matching picks to titles", progress: .93 } },
  };
  const done = { ...running, picks: [pick], status: { lastRun: { status: "done" }, running: null } };
  const f = fixture({ recsResponses: [running, done] });
  f.home.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.posts, [], "never start a duplicate refresh while one is active");
  assert.deepEqual(f.loadCalls.map(({ force }) => Boolean(force)), [false, true]);
  assert.equal(f.opened[0]?.id, "tt3398540");
  assert.equal(f.timerCalls, 1);
  assert.equal(f.notifications.length, 0);
  assert.equal(f.home.disabled, false);
});

test("Random recognizes in-app scored ratings when no AniList account is linked", async () => {
  const initial = {
    picks: [],
    settings: { anilist: null },
    stats: { ratings: { app: { count: 1, scored: 1 } } },
    status: { lastRun: null, running: null },
  };
  const done = { ...initial, picks: [], status: { lastRun: { status: "done" }, running: null } };
  const f = fixture({ recsResponses: [initial, done] });
  f.home.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.posts.map((request) => request.url), ["/api/recs/refresh"]);
  assert.equal(f.timerCalls, 1);
  assert.match(f.notifications.at(-1), /recommendations have no eligible picks yet/i);
});

test("First Random refresh failure reports an error and restores the controls", async () => {
  const f = fixture({ recsResponses: [{ picks: [], settings: { anilist: { scored: 71 } },
    stats: { ratings: 71 }, status: { lastRun: null, running: null } }], refreshError: new Error("Recommendations service unavailable") });

  f.home.click();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(f.posts.length, 1);
  assert.equal(f.opened.length, 0);
  assert.deepEqual(f.loadCalls, [{}]);
  assert.equal(f.timerCalls, 0);
  assert.equal(f.home.disabled, false);
  assert.equal(f.section.disabled, false);
  assert.match(f.notifications.at(-1), /Recommendations service unavailable/);
});

test("TMDB recommendations without IMDb ids resolve a unique verified local catalog title", async () => {
  const pick = { itemId: "tmdb:tv:11", source: "tmdb", type: "series", title: "The Office", year: 2005 };
  const f = fixture({ category: "tv", picks: [pick], catalogSearch: [
    { id: "tt0290978", type: "series", name: "The Office", releaseInfo: "2001" },
    { id: "tt0386676", type: "series", name: "The Office", releaseInfo: "2005" },
  ] });
  await f.run('openRandomRecommendation({ category: "tv" })');
  assert.equal(f.opened[0]?.id, "tt0386676");
  assert.equal(f.requests.filter((url) => url.startsWith("/api/catalog/search?")).length, 1);
  assert.match(f.popover.innerHTML, /no documented personal match reason/i);
});

test("A title without an IMDb id cannot open an ambiguous match or bypass watched status", async () => {
  const pick = { itemId: "tmdb:tv:11", source: "tmdb", type: "series", title: "Same Show", year: 2005 };
  const match = { id: "tt0386676", type: "series", name: "Same Show", releaseInfo: "2005" };
  const ambiguous = fixture({ category: "tv", picks: [pick], catalogSearch: [match, { ...match, id: "tt1234567" }] });
  await ambiguous.run('openRandomRecommendation({ category: "tv" })');
  assert.equal(ambiguous.opened.length, 0);

  const watched = fixture({ category: "tv", picks: [pick], catalogSearch: [match], saved: [
    { title: "Same Show", catalogId: match.id, sources: [{ watchedChapters: { S01E01: 1730000000000 } }] },
  ] });
  await watched.run('openRandomRecommendation({ category: "tv" })');
  assert.equal(watched.opened.length, 0);
});

test("Changing the default in Settings persists and selects broad TV rather than anime or recommendation picks", async () => {
  const f = fixture({ category: "tv", picks: [{ itemId: "not-needed", type: "series", source: "tmdb", imdbId: "tt6789012" }],
    catalog: { movies: [{ id: "tt333333", name: "Movie", type: "movie" }],
      series: [{ id: "tt7654321", name: "TV episode series", type: "series" }], anime: [] } });
  f.setting.value = "anything";
  f.setting.change();
  assert.equal(f.stored.get("lvl-random-source"), "anything");
  f.home.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.opened.length, 1);
  assert.equal(f.opened[0].id, "tt7654321");
  assert.equal(f.popover.hidden, true);
  assert.equal(f.requests.length, 0, "available non-anime catalog requires no personalized network call");
});

test("Random recommendation excludes an anime with one locally started episode, including an AniList alias match", async () => {
  const saved = [{ key: "apothecary", title: "The Apothecary Diaries", aliases: ["Kusuriya no Hitorigoto"],
    sources: [{ id: "episode-source", episodes: [{ progress: { positionMs: 23000, finished: false } }] }] }];
  const f = fixture({ saved, picks: [
    { itemId: "seen", source: "anilist", type: "series", title: "Kusuriya no Hitorigoto", url: "https://anilist.co/anime/553" },
    { itemId: "unseen", source: "anilist", type: "series", title: "Violet Evergarden", imdbId: "tt7654321" },
  ] });
  f.home.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.opened.length, 1);
  assert.equal(f.opened[0].name, "Violet Evergarden");
});

test("Broad anime checks watched identity again after a verified catalog match", async () => {
  const saved = [{ key: "apothecary", title: "The Apothecary Diaries", catalogId: "tt7654321",
    sources: [{ id: "ep1", episodes: [{ progress: { positionMs: 1200 } }] }] }];
  const f = fixture({ saved, source: "anything", discovery: [{ id: 553, title: "Kusuriya no Hitorigoto", status: "FINISHED" }] });
  f.home.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.opened.length, 0, "cannot open a seen title even if AniList's title did not match the saved alias");
  assert.equal(f.popover.hidden, true);
});
