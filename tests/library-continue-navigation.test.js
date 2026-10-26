import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { cardMarkup, shelfMarkup } from "../frontend/ui/ui.js";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");

test("Continue watching poster resumes, while the title and episode description open anime details", () => {
  const start = app.indexOf("function renderLibraryContinue(");
  const end = app.indexOf("\nfunction renderLibrary()", start);
  assert.ok(start > 0 && end > start);
  const section = { hidden: true, innerHTML: "" };
  const series = { key: "jojo's bizarre adventure", title: "JoJo's Bizarre Adventure", type: "series" };
  const point = { episode: { code: "S01E01" }, progress: {
    positionMs: 1303167, durationMs: 1444256, updatedAt: 200, finished: false,
  } };
  const ctx = vm.createContext({
    $: (selector) => selector === "#library-continue" ? section : null,
    isLibraryTitleMarkedWatched: () => false,
    seriesResumePoint: () => point,
    explicitlyUnwatchedChapter: () => false,
    libraryChapterName: () => "S1 E1",
    libraryCardImage: () => ({ image: "https://example.org/jojo.jpg" }),
    libraryArtCached: () => null,
    cardMarkup, shelfMarkup,
    bindShelves: () => {}, refreshImages: () => {}, Math,
  });
  vm.runInContext(app.slice(start, end), ctx);
  vm.runInContext("renderLibraryContinue", ctx)([series]);
  assert.equal(section.hidden, false);
  const markup = section.innerHTML;
  assert.match(markup, /<button class="ui-card__hit" type="button" data-ui-action="resume" aria-label="Resume JoJo/);
  assert.match(markup, /<button class="ui-card__hit ui-card__body" type="button" data-ui-action="library" aria-label="View JoJo/);
  assert.match(markup, /<span class="ui-card__title">JoJo&#39;s Bizarre Adventure<\/span>/);
  assert.match(markup, /2 min left/);
  assert.match(markup, /data-series-key="jojo&#39;s bizarre adventure"/);
  assert.match(markup, /<\/button><button class="ui-card__hit ui-card__body"/, "Poster and title are independent sibling buttons");
});

test("Continue watching respects the selected Library category, search and AniList status", () => {
  const renderStart = app.indexOf("function renderLibrary() {");
  const renderEnd = app.indexOf("\nasync function resumeLibrarySeries(", renderStart);
  const render = app.slice(renderStart, renderEnd);
  assert.ok(renderStart > 0 && renderEnd > renderStart);
  assert.match(render, /const shown = filteredByCategoryAndSearch[\s\S]*?renderLibraryContinue\(shown\)/,
    "Only matching Library items should reach Continue watching");
  assert.doesNotMatch(render, /renderLibraryContinue\(all\)/,
    "The full unfiltered Library must not leak into other tabs");

  const start = app.indexOf("function renderLibraryContinue(");
  const end = app.indexOf("\nfunction renderLibrary()", start);
  const section = { hidden: true, innerHTML: "" };
  const ctx = vm.createContext({
    $: () => section,
    isLibraryTitleMarkedWatched: () => false,
    seriesResumePoint: () => ({ episode: { code: "S01E02" }, progress: {
      positionMs: 90_000, durationMs: 900_000, updatedAt: 100, finished: false,
    } }),
    explicitlyUnwatchedChapter: () => false,
    libraryChapterName: () => "S1 E2",
    libraryCardImage: () => ({ image: "https://example.org/poster.jpg" }),
    libraryArtCached: () => null,
    cardMarkup, shelfMarkup,
    bindShelves: () => {}, refreshImages: () => {}, Math,
  });
  vm.runInContext(app.slice(start, end), ctx);
  const renderContinue = vm.runInContext("renderLibraryContinue", ctx);
  renderContinue([{ key: "frieren", title: "Frieren", type: "series" }]);
  assert.equal(section.hidden, false);
  assert.match(section.innerHTML, /Frieren/);
  assert.doesNotMatch(section.innerHTML, /Edgerunners/);

  renderContinue([]);
  assert.equal(section.hidden, true, "Switching to a category with no matching resume cards hides the shelf");
  assert.equal(section.innerHTML, "", "Stale cards must be cleared when switching filters");
});

test("Library keeps an accessible title without showing the oversized heading", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /<h1 class="ui-visually-hidden" data-i18n="Library">Library<\/h1>/);
  assert.doesNotMatch(html, /id="library-summary"|id="library-add-title"/);
  assert.match(html, /id="library-add-magnet"/);
});

test("Continue watching's two actions route to either the title page or the saved playback position", () => {
  const start = app.indexOf("function handleLibraryCardAction(");
  const end = app.indexOf("\nfunction rebuildHomeTitleIndex(", start);
  assert.ok(start > 0 && end > start);
  const calls = [];
  const holder = { dataset: { seriesKey: "jojo's bizarre adventure" } };
  const section = { contains: (node) => node === holder };
  const ctx = vm.createContext({
    $: (selector) => selector === "#library-continue" ? section : { contains: () => false },
    openLibrarySeries: (key) => calls.push(["title", key]),
    resumeLibrarySeries: (key) => calls.push(["resume", key]),
  });
  vm.runInContext(app.slice(start, end), ctx);
  const click = vm.runInContext("handleLibraryCardAction", ctx);
  const event = (action) => ({ target: { closest: (selector) => selector === "[data-ui-action], [data-library-empty]" ? {
    dataset: { uiAction: action }, closest: (child) => child === "[data-series-key]" ? holder : null,
  } : null } });
  click(event("library"));
  click(event("resume"));
  assert.deepEqual(calls, [["title", "jojo's bizarre adventure"], ["resume", "jojo's bizarre adventure"]]);
});
