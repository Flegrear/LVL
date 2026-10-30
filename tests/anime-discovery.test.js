import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { animeDiscoveryFilters, createAnimeDiscoveryService } from "../backend/catalog/anime-discovery.js";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../frontend/styles/styles.css", import.meta.url), "utf8");

test("anime discovery accepts historical years, seasonal sorting, filters and safe defaults", () => {
  const filters = animeDiscoveryFilters(new URLSearchParams("year=2006&season=FALL&format=TV&genre=Action&status=FINISHED&sort=SCORE_DESC&page=2"), 2026);
  assert.deepEqual(filters, { year: 2006, season: "FALL", format: "TV", status: "FINISHED", sort: "SCORE_DESC", genre: "Action", search: "", page: 2 });
  const all = animeDiscoveryFilters(new URLSearchParams("year=all&season=&format=MOVIE&search=Naruto"), 2026);
  assert.equal(all.year, null);
  assert.equal(all.season, null);
  assert.equal(all.format, "MOVIE");
  const untrusted = animeDiscoveryFilters({ year: "999999", sort: "SECRET", genre: "Bogus", page: "1000", search: "x".repeat(200) }, 2026);
  assert.equal(untrusted.year, 2026);
  assert.equal(untrusted.sort, "POPULARITY_DESC");
  assert.equal(untrusted.genre, null);
  assert.equal(untrusted.page, 1);
  assert.equal(untrusted.search.length, 90);
});

test("anime discovery sends year/season GraphQL filters, normalizes cards and caches repeat requests", async () => {
  const calls = [];
  const fetchImpl = async (_url, options) => {
    calls.push(JSON.parse(options.body).variables);
    return { ok: true, json: async () => ({ data: { Page: { pageInfo: { hasNextPage: true }, media: [
      { id: 101, title: { english: "Code Geass" }, coverImage: { large: "https://example.test/code.jpg" },
        averageScore: 86, format: "TV", seasonYear: 2006, season: "FALL", isAdult: false },
    ] } } }) };
  };
  const service = createAnimeDiscoveryService({ fetchImpl, now: () => new Date("2026-10-22").getTime() });
  const query = new URLSearchParams("year=2006&season=FALL&format=TV");
  const [first, second] = await Promise.all([service.discover(query), service.discover(query)]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].year, 2006);
  assert.equal(calls[0].season, "FALL");
  assert.equal(calls[0].after, null);
  assert.equal(first.items[0].title, "Code Geass");
  assert.equal(first.items[0].score, 86);
  assert.equal(first.hasNextPage, true);
  assert.equal(first, second);
  await service.discover(new URLSearchParams("year=2006&season="));
  assert.equal(calls[1].year, null);
  assert.equal(calls[1].after, 20060100);
  assert.equal(calls[1].before, 20061232);
});

test("anime discovery rejects upstream errors and retries without caching failed data", async () => {
  let calls = 0;
  const service = createAnimeDiscoveryService({ fetchImpl: async () => {
    calls += 1;
    return calls === 1 ? { ok: false, status: 429 }
      : { ok: true, json: async () => ({ data: { Page: { pageInfo: { hasNextPage: false }, media: [] } } }) };
  } });
  await assert.rejects(() => service.discover({ year: 2026 }), /rate-limiting/);
  const next = await service.discover({ year: 2026 });
  assert.equal(next.items.length, 0);
  assert.equal(calls, 2);
});

test('new AniList entries retry their large cover when extraLarge CDN artwork fails', async () => {
  const extraLarge = 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/extraLarge/new-entry.jpg';
  const large = 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/new-entry.jpg';
  const service = createAnimeDiscoveryService({ fetchImpl: async () => ({ ok: true,
    json: async () => ({ data: { Page: { pageInfo: {}, media: [
      { id: 2026, title: { english: 'New entry' }, coverImage: { extraLarge, large } },
    ] } } }) }) });
  const result = await service.discover({ year: 2026 });
  assert.equal(result.items[0].cover, extraLarge);
  assert.equal(result.items[0].coverFallback, large,
    'if extraLarge is missing the existing responsive-image retry should use the real large artwork');
  assert.match(app, /item\.coverFallback && item\.coverFallback !== item\.cover[\s\S]{0,80}data-fallback-src/,
    'Anime Home cards should wire the existing image-fallback handler');
});

test("floating player leaves media element mounted and only appears when playing outside Watch", () => {
  const start = app.indexOf("// A single live video/subtitle DOM");
  const end = app.indexOf("\n// restoreScroll:", start);
  assert.ok(start >= 0 && end > start);
  const floating = app.slice(start, end);
  assert.match(floating, /function floatMayDisplay\(\)/);
  assert.match(floating, /frame\.classList\.contains\("has-video"\)/);
  assert.match(floating, /leaving && floatingPrefs\.auto && !video\.paused/);
  assert.match(floating, /function showSiteFloating\(show\)/);
  assert.match(floating, /function restoreDocumentFloating\(/);
  assert.match(floating, /pip\.document\.body\.append\(frame\)/);
  assert.ok(html.includes('<video id="video" playsinline>'));
  assert.ok(css.includes("#view-watch.is-floating #video-frame"));
});

test("anime Home replaces only the Top 10 anime shelf and preserves other shelves", () => {
  assert.match(app, /feed\.category === "anime"[\s\S]*?row\.id === "top-anime"[\s\S]*?rowMarkup\[topIndex\] = animeBrowserMarkup\(\)/);
  assert.match(app, /animeBrowserSelect\("Year"/);
  assert.match(app, /animeBrowserSelect\("Season"/);
  assert.match(app, /animeBrowserSelect\("Genre"/);
  assert.match(app, /\/api\/anime\/discover\?/);
  assert.match(css, /\.anime-browser-grid\s*\{/);
});

test("anime discovery removes its redundant header while preserving filter controls", () => {
  const from = app.indexOf("function animeBrowserMarkup() {");
  const to = app.indexOf("\nfunction renderAnimeBrowserResults()", from);
  assert.ok(from > 0 && to > from);
  const context = vm.createContext({
    animeBrowser: { filters: { year: "2026", season: "FALL", sort: "SCORE_DESC", format: "TV", status: "", genre: "", search: "" } },
    animeBrowserSelect: (label) => `<select aria-label="${label}"></select>`,
    escapeHtml: String,
  });
  vm.runInContext(app.slice(from, to), context);
  const markup = vm.runInContext("animeBrowserMarkup()", context);
  assert.doesNotMatch(markup, /AniList discovery<\/span>|<h2[^>]*>Browse anime|Top seasonal shows, every year/);
  assert.match(markup, /anime-browser-form/);
  assert.match(markup, /Year.*Season.*Rank by.*Format.*Status.*Genre/s);
  assert.match(markup, /anime-browser-results/);
});

test("anime browse cards show numerical 10-point scores, never percent ratings", () => {
  const from = app.indexOf("function renderAnimeBrowserResults() {");
  const to = app.indexOf("\nasync function loadAnimeBrowser(", from);
  assert.ok(from > 0 && to > from);
  const grid = { innerHTML: "" };
  const status = { textContent: "", classList: { toggle() {} } };
  const more = { hidden: false, disabled: false, textContent: "" };
  const context = vm.createContext({
    animeBrowser: { items: [
      { id: 1, title: "Rated Anime", cover: "https://example.test/cover.jpg", year: 2026, season: "FALL", format: "TV", score: 87 },
      { id: 2, title: "Not Yet Rated", cover: "", year: 2026, season: "FALL", format: "TV", score: null },
    ], loading: false, loaded: true, error: "", hasNextPage: false },
    homeBrowseCategory: "anime", viewActive: () => true, escapeHtml: String,
    artworkFallback: () => "fallback.svg", refreshImages: () => {},
    $: (selector) => ({ "#anime-browser-results": grid, "#anime-browser-status": status, "#anime-browser-more": more })[selector],
  });
  vm.runInContext(app.slice(from, to), context);
  vm.runInContext("renderAnimeBrowserResults()", context);
  assert.match(grid.innerHTML, /8\.7\/10/);
  assert.doesNotMatch(grid.innerHTML, /87%|0\.0\/10|NaN/);
});
