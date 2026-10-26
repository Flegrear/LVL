import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { rankCatalogSearchResults } from "../frontend/catalog/home-feed.js";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../frontend/styles/styles.css", import.meta.url), "utf8");

test("Home and section topbars share a live non-modal search list without redundant Library Add title button", () => {
  assert.doesNotMatch(html, /<dialog id="catalog-dialog"/);
  assert.equal((html.match(/id="catalog-search-panel"/g) || []).length, 1);
  assert.equal((html.match(/id="catalog-search-shell"/g) || []).length, 1);
  assert.equal((html.match(/id="catalog-search-input"/g) || []).length, 1);
  assert.match(html, /id="catalog-search-input"[^>]*placeholder="Search titles"[^>]*data-i18n-placeholder="Search titles"/);
  assert.doesNotMatch(html, /id="catalog-search-close"/);
  assert.match(html, /id="topbar-catalog-search-host"/);
  assert.match(html, /id="section-catalog-search-host"/);
  assert.match(html, /id="section-search-title"/);
  assert.match(html, /id="library-catalog-search-host"/);
  assert.match(html, /id="catalog-results" class="catalog-search-results"/);
  assert.doesNotMatch(html, /id="library-add-title"/);
  assert.match(app, /\$\("#home-search-title"\)\?\.addEventListener\("click", \(\) => openCatalogSearch\("topbar"\)\)/);
  assert.match(app, /\$\("#section-search-title"\)\?\.addEventListener\("click", \(\) => openCatalogSearch\("section"\)\)/);
  assert.match(css, /\.catalog-search-panel\[hidden\]\s*\{\s*display:none !important;/);
  assert.match(css, /\.library-catalog-search-host \.catalog-search-panel\s*\{\s*position:static;/);
  assert.match(css, /:is\(#topbar-catalog-search-host,#section-catalog-search-host\):has\(> \.catalog-search-shell:not\(\[hidden\]\)\)\s*\{[^}]*width:min\(460px,calc\(100vw - 170px\)\);[^}]*flex:0 0 min\(460px,calc\(100vw - 170px\)\);/);
  assert.match(css, /\.app-topbar :is\(#topbar-catalog-search-host,#section-catalog-search-host\)\s*\{\s*width:460px;\s*flex:0 1 460px;/,
    "idle search can shrink before the fixed Random and Library icons are displaced");
  assert.match(css, /\.app-topbar :is\(#home-search-title,#section-search-title\)\s*\{\s*width:100%;\s*min-width:0;\s*background:rgba\(0,0,0,\.45\);/);
  assert.match(css, /\.app-topbar:has\(\.catalog-search-shell:not\(\[hidden\]\)\) \.ui-topbar__actions\s*\{\s*flex:0 0 auto;/);
  assert.doesNotMatch(css, /\.app-topbar:has\(#topbar-catalog-search-host \.catalog-search-shell:not\(\[hidden\]\)\) #home-tabs\s*\{\s*display:none;/);
  assert.match(css, /\.app-topbar #home-tabs\s*\{[^}]*overflow-x:auto;[^}]*scrollbar-width:none;/);
  assert.match(css, /\.catalog-search-shell\s*\{[^}]*width:100%;/);
  assert.match(css, /\.catalog-search-panel\s*\{[^}]*width:100%;[^}]*background:#000;/);
  assert.match(css, /\.catalog-search-shell input\.ui-search__input\s*\{[^}]*background:rgba\(0,0,0,\.45\);[^}]*backdrop-filter:blur\(10px\);/);
  assert.match(css, /\.catalog-search-shell input\.ui-search__input:focus\s*\{[^}]*background:rgba\(0,0,0,\.45\);[^}]*box-shadow:none;/);
  assert.doesNotMatch(app, /const picksRow = recsUi\.homePicksMarkup/);
  assert.doesNotMatch(html, /id="library-picks"/);
});

function searchFixture() {
  const elements = new Map();
  const make = (id) => {
    const node = {
      id, hidden: false, innerHTML: "", value: "", textContent: "", classList: { toggle() {} },
      attributes: {}, setAttribute(k, v) { this.attributes[k] = v; }, focus() { focused.push(id); },
      querySelector() { return null; },
    };
    elements.set(`#${id}`, node);
    return node;
  };
  const focused = [];
  const topbar = make("topbar-catalog-search-host");
  const section = make("section-catalog-search-host");
  const library = make("library-catalog-search-host");
  const shell = make("catalog-search-shell");
  shell.hidden = true;
  const panel = make("catalog-search-panel");
  panel.hidden = true;
  topbar.appendChild = library.appendChild = section.appendChild = function (child) { child.parentElement = this; };
  topbar.appendChild(shell);
  const input = make("catalog-search-input");
  const results = make("catalog-results");
  const status = make("catalog-status");
  const globalTrigger = make("home-search-title");
  const sectionTrigger = make("section-search-title");
  const libraryTrigger = make("library-add-title");
  const calls = [];
  const opened = [];
  const pending = new Map();
  let tick = 0;
  const context = vm.createContext({
    $: (selector) => elements.get(selector) || null,
    state: { catalogResults: [] },
    window: {
      setTimeout(fn) { pending.set(++tick, fn); return tick; },
      clearTimeout(id) { pending.delete(id); },
    },
    AbortController,
    setToolStatus: (selector, message) => { status.textContent = message; },
    fetchJson: (url, options) => new Promise((resolve) => { calls.push({ url, signal: options.signal, resolve }); }),
    renderImages: () => {},
    refreshImages: () => {},
    buildLibrarySeries: () => [{ key: "saved", catalogId: "tt2", sources: [] }],
    homeTitleIndex: new Map([["tt33", { id: "tt33", name: "One Piece", type: "series" }]]),
    savedTitleBadge: () => ({ label: "On your list" }),
    catalogCardItem: (meta) => ({ id: meta.id, title: meta.name, image: "", meta: ["2026", meta.type] }),
    rankCatalogSearchResults,
    librarySeriesKey: (name) => name,
    escapeHtml: (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;"),
    emptyMarkup: () => "Empty catalog results",
    openHomeTitle: (meta) => opened.push(meta),
  });
  const start = app.indexOf("function renderCatalogResults(results)");
  const end = app.indexOf("async function addBestCatalogMovie(", start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(app.slice(start, end), context);
  const invoke = (expr) => vm.runInContext(expr, context);
  const flush = () => { const queued = [...pending.values()]; pending.clear(); queued.forEach((fn) => fn()); };
  return { invoke, flush, calls, opened, input, panel, shell, topbar, section, library, results, status, globalTrigger, sectionTrigger, libraryTrigger, focused };
}

test("Live results load while typing; stale queries cannot replace newer matches", async () => {
  const f = searchFixture();
  f.invoke('openCatalogSearch("topbar")');
  assert.equal(f.shell.parentElement, f.topbar);
  assert.equal(f.shell.hidden, false);
  assert.equal(f.panel.hidden, true, "focusing the blank field does not show a dropdown");
  assert.equal(f.input.value, "");
  assert.equal(f.status.textContent, "");
  assert.equal(f.globalTrigger.hidden, true);
  assert.equal(f.globalTrigger.attributes["aria-expanded"], "true");
  f.input.value = "a";
  f.invoke("queueCatalogSearch()");
  assert.equal(f.panel.hidden, false, "typing starts the dropdown");
  f.flush();
  assert.equal(f.calls.length, 0, "one character does not fetch");
  f.input.value = "one";
  f.invoke("queueCatalogSearch()");
  assert.match(f.results.innerHTML, /One Piece/, "matching titles already in Home show immediately");
  f.flush();
  assert.match(f.calls[0].url, /q=one/);
  f.input.value = "two";
  f.invoke("queueCatalogSearch()");
  f.flush();
  assert.equal(f.calls[0].signal.aborted, true);
  f.calls[0].resolve({ results: [{ id: "tt1", name: "Old result", type: "series" }] });
  await new Promise(setImmediate);
  assert.doesNotMatch(f.results.innerHTML, /Old result/);
  f.calls[1].resolve({ results: [{ id: "tt2", name: "New result", type: "movie" }] });
  await new Promise(setImmediate);
  assert.match(f.results.innerHTML, /New result/);
  assert.match(f.results.innerHTML, /On your list/);
  assert.match(f.status.textContent, /1 titles found/);
  f.input.value = "";
  f.invoke("queueCatalogSearch()");
  assert.equal(f.panel.hidden, true, "clearing the query closes the dropdown");
  f.input.value = "two";
  f.invoke("queueCatalogSearch()");
  assert.match(f.results.innerHTML, /New result/, "recent queries are served without a new request");
  f.flush();
  assert.equal(f.calls.length, 2);
});

test("Library empty-state search still uses the shared panel without a redundant Add title button", async () => {
  const f = searchFixture();
  f.invoke('openCatalogSearch("library")');
  assert.equal(f.shell.parentElement, f.library);
  assert.equal(f.panel.hidden, true);
  f.input.value = "anime";
  f.invoke("queueCatalogSearch()");
  f.flush();
  const meta = { id: "tt2", name: "New anime", type: "series" };
  f.calls[0].resolve({ results: [meta] });
  await new Promise(setImmediate);
  f.invoke('openCatalogResult("tt2")');
  assert.equal(f.shell.hidden, true);
  assert.deepEqual(f.opened, [meta]);
  f.invoke('openCatalogSearch("topbar")');
  assert.equal(f.shell.parentElement, f.topbar, "one search input moves between entry points");
  f.invoke("closeCatalogSearch()");
  assert.equal(f.shell.hidden, true);
});

test("Secondary topbar uses the same search panel, then restores focus to its own trigger", () => {
  const f = searchFixture();
  f.invoke('openCatalogSearch("section")');
  assert.equal(f.shell.parentElement, f.section);
  assert.equal(f.sectionTrigger.hidden, true);
  assert.equal(f.globalTrigger.hidden, false);
  assert.equal(f.sectionTrigger.attributes["aria-expanded"], "true");
  assert.equal(f.panel.hidden, true);
  f.invoke('closeCatalogSearch({restoreFocus:true})');
  assert.equal(f.sectionTrigger.hidden, false);
  assert.equal(f.sectionTrigger.attributes["aria-expanded"], "false");
  assert.equal(f.focused.at(-1), "section-search-title");
});

test("Searching Dragon Ball Z ranks the exact anime series before movies, without deleting film results", () => {
  const movies = Array.from({ length: 19 }, (_, n) => ({
    id: `tt${String(n + 100000).padStart(7, "0")}`, name: `Dragon Ball Z: Film ${n + 1}`, type: "movie",
  }));
  const original = { id: "tt0214341", name: "Dragon Ball Z", type: "series" };
  const kai = { id: "tt1409055", name: "Dragon Ball Z Kai", type: "series" };
  const raw = [...movies, original, kai];
  const sorted = rankCatalogSearchResults(raw, "dragon ball z");
  assert.equal(sorted[0], original, "exact series outranks all movie prequels and sequels");
  assert.equal(sorted[1], kai, "related series ranks ahead of franchise films");
  assert.equal(sorted.filter((entry) => entry.type === "movie").length, 19, "individual movies remain searchable");
  assert.equal(rankCatalogSearchResults(raw, "dragon ball z film 3")[0], movies[2], "explicit film search is still prioritized");
  const f = searchFixture();
  f.input.value = "dragon ball z";
  f.invoke(`renderCatalogResults(${JSON.stringify(raw)})`);
  const firstId = f.results.innerHTML.match(/data-title-id="([^"]+)"/)?.[1];
  assert.equal(firstId, original.id, "the browser sees the ranked series first, not just the server payload");
});
