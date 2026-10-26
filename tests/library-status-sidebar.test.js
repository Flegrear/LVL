import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../frontend/styles/styles.css", import.meta.url), "utf8");

function fixture() {
  const entries = [
    { key: "watching", title: "Watching Anime", category: "anime", anilist: { status: "CURRENT", seasons: [{ status: "CURRENT" }] } },
    { key: "rewatching", title: "Rewatching Anime", category: "anime", anilist: { status: "CURRENT", seasons: [{ status: "REPEATING" }] } },
    { key: "planned", title: "Planned Anime", category: "anime", anilist: { status: "PLANNING" } },
    { key: "completed", title: "Finished Movie", category: "movie", watched: true },
  ];
  const buttons = Object.fromEntries(["any", "CURRENT", "COMPLETED", "PLANNING", "PAUSED", "DROPPED", "REPEATING"]
    .map((status) => {
      const count = { textContent: "" };
      return [status, {
        dataset: { libraryStatus: status }, attributes: {},
        setAttribute(key, value) { this.attributes[key] = value; },
        querySelector() { return count; }, count,
      }];
    }));
  const list = { innerHTML: "", classList: { remove() {}, toggle() {} } };
  const elements = new Map([
    ["#library-list", list], ["#library-sort", { value: "recent" }],
    ["#library-filter", {}], ["#library-status-filter", { addEventListener(_event, callback) { this.click = callback; } }],
  ]);
  const libraryView = { filter: "anime", query: "", status: "any", sort: "title" };
  const saved = [];
  const shown = [];
  const context = vm.createContext({
    $: (selector) => elements.get(selector) || null,
    $$: (selector) => selector === "#library-status-filter [data-library-status]" ? Object.values(buttons) : [],
    state: { homeCatalog: { anime: [] } },
    document: { querySelectorAll: () => [] },
    buildLibrarySeries: () => entries, updateLibrarySummary() {}, renderLibraryRecommendations() {},
    libraryCategory: (series) => series.category, libraryArtCached: () => null,
    setActiveTab() {}, libraryView, normalizeText: (value) => value.toLowerCase(),
    isLibraryTitleMarkedWatched: (series) => Boolean(series.watched),
    seriesAniList: (series) => series.anilist || null,
    renderLibraryContinue: (items) => { shown.push(items.map((series) => series.key)); },
    seriesActivityAt: () => 0, emptyMarkup: () => "<p>No matches</p>",
    libraryCardItem: (series) => ({ title: series.title }),
    libraryMoreButton: () => "", cardMarkup: (item) => `<article>${item.title}</article>`,
    refreshImages() {}, ANILIST_STATUS_LABELS: { CURRENT: "Watching", REPEATING: "Rewatching" },
    ANILIST_STATUS_FILTERS: ["CURRENT", "COMPLETED", "PLANNING", "PAUSED", "DROPPED"],
    saveLibraryView: () => saved.push(libraryView.status),
  });
  const start = app.indexOf("function renderLibrary() {");
  const end = app.indexOf("\nasync function resumeLibrarySeries(", start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(app.slice(start, end), context);
  const clickStart = app.indexOf('$("#library-status-filter")?.addEventListener("click",');
  const clickEnd = app.indexOf("\n  const moreButton =", clickStart);
  assert.ok(clickStart >= 0 && clickEnd > clickStart);
  vm.runInContext(app.slice(clickStart, clickEnd), context);
  return { buttons, list, libraryView, saved, shown, statusControl: elements.get("#library-status-filter"),
    render: () => vm.runInContext("renderLibrary()", context) };
}

test("Library status sidebar is alongside poster area, with the canonical larger LVL topbar logo", () => {
  const library = html.slice(html.indexOf('id="view-library"'), html.indexOf('id="view-title"'));
  assert.ok(library.indexOf('class="lib-status-sidebar"') < library.indexOf('class="lib-main"'));
  assert.doesNotMatch(library, /id="library-status-field"|id="library-status"/);
  assert.match(html, /id="section-view-icon"[^>]*src="\/brand\/lvl_app_icon_dark\.svg"[^>]*width="42" height="42"/);
  assert.match(css, /\.lib-status-list \{[^}]*display:grid/);
  assert.match(css, /@media \(max-width:860px\) \{[\s\S]*?\.lib-status-list \{ display:flex;/);
});

test("Status counts respect Library category, rewatching is separate, and click persists active choice", () => {
  const f = fixture();
  f.render();
  assert.equal(f.buttons.any.count.textContent, "3", "Movie is excluded from the Anime category");
  assert.equal(f.buttons.CURRENT.count.textContent, "1");
  assert.equal(f.buttons.REPEATING.count.textContent, "1", "Rewatching season is not silently merged with Watching");
  assert.equal(f.buttons.PLANNING.count.textContent, "1");
  assert.equal(f.buttons.COMPLETED.count.textContent, "");
  assert.equal(f.buttons.any.attributes["aria-pressed"], "true");
  f.statusControl.click({ target: { closest: () => f.buttons.REPEATING } });
  assert.deepEqual(f.saved, ["REPEATING"]);
  assert.equal(f.buttons.REPEATING.attributes["aria-pressed"], "true");
  assert.equal(f.buttons.any.attributes["aria-pressed"], "false");
  assert.deepEqual(f.shown.at(-1), ["rewatching"]);
  assert.match(f.list.innerHTML, /Rewatching Anime/);
  f.libraryView.filter = "all";
  f.statusControl.click({ target: { closest: () => f.buttons.COMPLETED } });
  assert.deepEqual(f.shown.at(-1), ["completed"], "Locally marked watched titles still count as completed");
  assert.equal(f.buttons.COMPLETED.count.textContent, "1");
});
