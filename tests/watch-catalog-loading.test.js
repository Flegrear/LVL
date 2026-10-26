import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const start = app.indexOf("const catalogChapterLists = new Map();");
const end = app.indexOf("\nfunction currentCatalogNeighbors()", start);
assert.ok(start > 0 && end > start);
const source = app.slice(start, end);

test("Watch fetches complete catalog metadata despite a cached Home synopsis, with one in-flight request", async () => {
  const id = "tt1234567";
  let requests = 0;
  let resolveRequest;
  let refreshes = 0;
  const pending = new Promise((resolve) => { resolveRequest = resolve; });
  const context = vm.createContext({
    homeTitleIndex: new Map([[id, { id, description: "Short Home synopsis", poster: "https://example.com/a.jpg" }]]),
    fetchJson: async () => { requests += 1; return pending; },
    updateChapterButtons: () => {},
    Date,
  });
  vm.runInContext(source, context);
  const series = { type: "series", catalogId: id };
  const onReady = () => { refreshes += 1; };
  const artwork = vm.runInContext("libraryArtFor", context);
  assert.equal(artwork(series, onReady, { full: true }).description, "Short Home synopsis");
  assert.equal(artwork(series, onReady, { full: true }).description, "Short Home synopsis");
  assert.equal(requests, 1, "Full details are fetched once, even after repeated renders");
  resolveRequest({ meta: {
    id, description: "Complete description with cast and release details", cast: ["Actor"],
    seasons: [{ season: 1, episodes: [{ episode: 1, id: "tt1234567:1:1", thumbnail: "https://example.com/still.jpg" }] }],
  } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refreshes, 1, "Repeated renders register the same callback only once");
  assert.equal(artwork(series, onReady, { full: true }).cast[0], "Actor");
  const record = vm.runInContext(`catalogChapterLists.get("${id}")`, context);
  assert.equal(record.list.chapters.length, 1);
  assert.equal(record.list.chapters[0].thumbnail, "https://example.com/still.jpg");
});

test("Watch fills missing catalog IDs only from exact title matches without changing Library data", async () => {
  const from = app.indexOf("const watchCatalogMatches = new Map();");
  const to = app.indexOf("\nfunction renderWatchInfo(", from);
  assert.ok(from > 0 && to > from);
  const context = vm.createContext({
    homeTitleIndex: new Map(),
    state: { currentSource: null },
    playerLoadingLibraryId: "",
    $: () => null,
    fetchJson: async () => ({ results: [
      { id: "tt9999999", type: "series", name: "Unrelated show" },
      { id: "tt1234567", type: "series", name: "Sentenced to Be a Hero" },
    ] }),
    Date,
  });
  vm.runInContext(app.slice(from, to), context);
  const lookup = vm.runInContext("watchCatalogIdFor", context);
  const series = { key: "sentenced to be a hero", title: "Sentenced to Be a Hero", type: "series", catalogId: "" };
  assert.equal(lookup(series), "", "The lookup starts asynchronously");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lookup(series), "tt1234567", "Only the exact matching title is used");
  assert.equal(series.catalogId, "", "A temporary lookup does not rewrite the Library record");
  assert.match(app, /libraryEntryById\(playerLoadingLibraryId \|\| state\.currentSource\.libraryId\)/,
    "A late metadata refresh must not replace a new loading title with the previous source");
});
