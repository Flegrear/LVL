import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../frontend/styles/styles.css", import.meta.url), "utf8");

function section(start, end) {
  const from = app.indexOf(start);
  const to = app.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `Could not locate ${start}`);
  return app.slice(from, to);
}

function markupContext() {
  const context = vm.createContext({
    escapeHtml: (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;"),
    buttonMarkup: ({ label, className = "" }) => `<button class="${className}">${label}</button>`,
    emptyMarkup: ({ title, text = "" }) => `<p>${title}: ${text}</p>`,
    catalogChapterSourceRowMarkup: (stream, rowIndex) => `<article data-row-index="${rowIndex}">${stream.title}</article>`,
    meetsSourceFloor: (stream) => stream.height >= 720 && stream.peers >= 2,
    heightFromQualityLabel: () => 0,
  });
  vm.runInContext('const SEASON_PACKS_SHOWN = 6;\n' +
    section("function catalogChapterSourcesMarkup(", "\nfunction catalogChapterSourceRowMarkup("), context);
  return context;
}

test("episode Source panels never list season packs, including bulk episode-torrent mode", () => {
  const context = markupContext();
  const episode = { title: "Show.S01E01.1080p", height: 1080, peers: 20 };
  const pack = { title: "Show.Season.1.1080p", height: 1080, peers: 999 };
  const lookup = {
    status: "ready", rows: [episode, pack],
    groups: { episodeFiles: [episode], packs: [pack], others: [], unplayable: 0 },
  };
  const render = vm.runInContext("catalogChapterSourcesMarkup", context);
  assert.match(render(lookup), /Show\.S01E01/);
  assert.doesNotMatch(render(lookup), /Show\.Season\.1|<h4>Packs<\/h4>/);
  assert.doesNotMatch(render({ ...lookup, floorOnly: true }), /Show\.Season\.1/);
  assert.match(render({ ...lookup, floorOnly: true }), /1 episode magnet/);
  assert.match(render({ ...lookup, groups: { ...lookup.groups, episodeFiles: [] } }), /No single-episode sources found/);
  assert.doesNotMatch(render({ ...lookup, groups: { ...lookup.groups, episodeFiles: [] } }), /Season and multi-season packs|season selector/);
});

test("season panel owns pack rows, shows six initially, and expands independently", () => {
  const context = markupContext();
  const show = vm.runInContext("catalogSeasonPacksMarkup", context);
  const rows = Array.from({ length: 10 }, (_, index) => ({ title: `Season pack ${index + 1}` }));
  const collapsed = show({ status: "ready", rows });
  assert.match(collapsed, /<section class="catalog-source-group" aria-label="Packs">/);
  assert.doesNotMatch(collapsed, /Season and multi-season packs|<h4>Packs<\/h4>/,
    "Packs content must not repeat the heading already above the tabs");
  assert.match(collapsed, /Season pack 6/);
  assert.doesNotMatch(collapsed, /Season pack 7/);
  assert.match(collapsed, /Show all 10 packs/);
  const expanded = show({ status: "ready", rows, showAll: true });
  assert.match(expanded, /Season pack 10/);
  assert.match(expanded, /data-row-index="9"/);
  assert.match(show({ status: "error", error: "Not available" }), /catalog-season-pack-retry/);
  assert.match(show({ status: "loading" }), /Finding packs/);
  assert.match(show({ status: "ready", rows: [] }), /No packs found/);
});

test("Packs tab and heading are concise, with no season-specific subtitle or duplicate panel heading", () => {
  const container = { innerHTML: "", querySelector: () => null };
  const view = {
    meta: { name: "Example" }, season: 1, shown: 12, packsActive: true,
    seasons: [{ season: 1, count: 1, episodes: [] }],
    seasonPacks: new Map([[1, { status: "ready", rows: [] }]]),
  };
  const context = markupContext();
  Object.assign(context, {
    catalogSeriesView: view,
    $: (selector) => selector === "#title-chapters" ? container : null,
    savedCatalogChapterGroups: () => new Map(),
    librarySeriesKeyForCatalog: () => "example",
    catalogSeasonLabel: (season) => "Season " + season,
    icon: (name) => "<icon>" + name + "</icon>",
    titleRendered: { chapters: "" },
    refreshImages() {},
    catalogFetchAllLabel: () => "Fetch all",
  });
  vm.runInContext(section("function renderTitleChapters(", "\nfunction catalogChapterTarget("), context);
  const render = vm.runInContext("renderTitleChapters", context);
  render();
  assert.match(container.innerHTML, /id="title-chapters-heading">Packs<\/h2>/);
  assert.match(container.innerHTML, /catalog-season-pack-toggle[^>]*><icon>library<\/icon><span>Packs<\/span>/);
  assert.doesNotMatch(container.innerHTML, /catalog-chapters-note|Packs for Season|Season &amp; series packs|Season and multi-season packs/);
  assert.match(container.innerHTML, /No packs found/);
  view.packsActive = false;
  render();
  assert.match(container.innerHTML, /id="title-chapters-heading">Chapters<\/h2>/);
  assert.match(container.innerHTML, /class="catalog-chapters-note">1 chapter/);
});

test("pack lookup uses the selected season's first released episode and keeps results separate", async () => {
  const lookups = [];
  const renders = [];
  const first = { id: "tt111:1:1", episode: 1 };
  const second = { id: "tt111:2:1", episode: 1 };
  const chapters = [
    { season: 1, episodes: [first] },
    { season: 2, episodes: [second] },
  ];
  const view = { season: 1, seasons: chapters, seasonPacks: new Map() };
  const context = vm.createContext({
    catalogSeriesView: view,
    chapterUpcoming: () => false,
    renderTitleChapters: () => renders.push(view.season),
    loadCatalogChapterSources: async (_view, chapter) => {
      lookups.push(chapter);
      return { status: "ready", groups: { episodeFiles: [{ title: "Single" }], packs: [{ title: `Pack for ${chapter.season}` }] } };
    },
  });
  vm.runInContext(section("async function loadCatalogSeasonPacks(", "\nfunction chapterSourceMeta("), context);
  const load = vm.runInContext("loadCatalogSeasonPacks", context);
  const one = await load(view, 1);
  assert.equal(one.status, "ready");
  assert.equal(one.rows.length, 1);
  assert.equal(one.rows[0].title, "Pack for 1");
  assert.equal(lookups[0].id, first.id);
  await load(view, 1);
  assert.equal(lookups.length, 1, "Reopening a season reuses its cached lookup");
  view.season = 2;
  const two = await load(view, 2);
  assert.equal(two.rows[0].title, "Pack for 2");
  assert.equal(lookups[1].id, second.id);
  assert.equal(view.seasonPacks.get(1), one);
  assert.ok(renders.includes(1) && renders.includes(2));
});

test("pack tab for a season with no released episodes resolves empty, not endless loading", async () => {
  const chapter = { id: "tt111:4:1", season: 4, episode: 1 };
  const view = { packsActive: true, season: 4, seasons: [{ season: 4, episodes: [chapter] }], seasonPacks: new Map() };
  let renders = 0;
  const context = vm.createContext({
    catalogSeriesView: view,
    chapterUpcoming: () => true,
    renderTitleChapters: () => { renders += 1; },
    loadCatalogChapterSources: () => { throw new Error("Unreleased episodes should not trigger source searches"); },
  });
  vm.runInContext(section("async function loadCatalogSeasonPacks(", "\nfunction chapterSourceMeta("), context);
  const state = await vm.runInContext("loadCatalogSeasonPacks", context)(view, 4);
  assert.equal(state.status, "ready");
  assert.equal(state.rows.length, 0);
  assert.equal(view.seasonPacks.get(4), state);
  assert.equal(renders, 1);
});

test("pack row buttons preserve the selected source and its season/chapter mapping", async () => {
  const selected = [];
  const stream = { title: "Multi-season pack", chapterSource: { kind: "pack" } };
  const chapter = { id: "tt111:2:1", season: 2, episode: 1 };
  const view = { season: 2, busy: false, seasonPacks: new Map([[2, { open: true, status: "ready", rows: [stream], chapter }]]) };
  const context = vm.createContext({
    catalogSeriesView: view,
    renderTitleChapters: () => {},
    catalogChapterFromNode: () => null,
    addCatalogChapterSource: async (_view, target, source, options) => selected.push({ target, source, play: options.play }),
    setToolStatus: () => {},
  });
  vm.runInContext(section("function handleCatalogChapterClick(", "\nasync function releaseTorrentSession("), context);
  const click = vm.runInContext("handleCatalogChapterClick", context);
  const target = (kind) => ({
    matches: (selector) => selector.split(",").map((part) => part.trim()).includes(`.catalog-source-${kind}`),
    closest: (selector) => selector === ".catalog-season-pack-panel" ? {} : selector === "[data-row-index]" ? { dataset: { rowIndex: "0" } } : null,
  });
  const event = (kind) => ({ target: { closest: () => target(kind) }, currentTarget: { contains: () => true } });
  click(event("add"));
  await new Promise((resolve) => setImmediate(resolve));
  click(event("play"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(selected.map((item) => item.play), [false, true]);
  assert.equal(selected[0].target, chapter);
  assert.equal(selected[0].source, stream);
  assert.equal(view.busy, false);
});

test("pack controls are a mutually exclusive tab beside seasons, not an expandable block", () => {
  assert.match(app, /class="ui-chip-row catalog-season-switch"[\s\S]*?catalog-season-pack-toggle/);
  assert.match(app, /catalog-season-pack-toggle" type="button" aria-pressed="\$\{packOpen\}"/);
  assert.match(app, /packOpen\s*\? `<div class="catalog-season-pack-panel"/);
  assert.match(app, /: `<ol class="catalog-chapter-list"/);
  assert.match(app, /view\.packsActive = false;/);
  assert.match(app, /view\.packsActive = true;/);
  assert.doesNotMatch(app, /From this season’s first chapter lookup\./);
  assert.doesNotMatch(app, /for this chapter` : size/);
});
