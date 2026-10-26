import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { animeCatalogRootSearchNames, animeCatalogSearchNames, verifiedAnimeCatalogMatch } from "../frontend/catalog/anime-catalog-match.js";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../frontend/styles/styles.css", import.meta.url), "utf8");
const start = app.indexOf("const animeBrowserTitleCache = new Map();");
const end = app.indexOf("\nconst animeBrowserSelect =", start);
assert.ok(start > 0 && end > start, "The real Anime browser resolver is present");

function harness({ local = [], library = [] } = {}) {
  const requests = [];
  const ctx = vm.createContext({
    homeTitleIndex: new Map(local.map((item) => [item.id, item])),
    buildLibrarySeries: () => library,
    fetchJson: (url) => new Promise((resolve, reject) => requests.push({ url, resolve, reject })),
    animeCatalogRootSearchNames, animeCatalogSearchNames, verifiedAnimeCatalogMatch,
  });
  vm.runInContext(app.slice(start, end), ctx);
  return { ctx, requests, resolve: vm.runInContext("resolveAnimeBrowserCatalog", ctx) };
}

const anime = { id: 177, title: "The Apothecary Diaries Season 3", titleAlt: "Kusuriya no Hitorigoto 3rd Season", format: "TV", year: 2026 };
const catalog = { id: "tt1234567", name: "Kusuriya no Hitorigoto 3rd Season", type: "series" };

test("AniList click searches English and romanized titles at once and opens on the earliest exact hit", async () => {
  const h = harness();
  const request = h.resolve(anime);
  assert.equal(h.requests.length, 2, "Both aliases should begin before either finishes");
  assert.match(h.requests[0].url, /The%20Apothecary/);
  assert.match(h.requests[1].url, /Kusuriya/);
  h.requests[1].resolve({ results: [catalog, { id: "tt999999", name: "Different", type: "series" }] });
  assert.equal((await request).id, catalog.id);
  h.requests[0].resolve({ results: [] });
  assert.equal((await h.resolve(anime)).id, catalog.id);
  assert.equal(h.requests.length, 2, "A repeated click reuses a successful mapping");
});

test("Already-known catalog titles navigate without any new network lookup", async () => {
  const h = harness({ local: [{ id: "tt1234567", name: anime.title, type: "series" }] });
  const found = await h.resolve(anime);
  assert.equal(found.name, anime.title);
  assert.equal(h.requests.length, 0);
});

test("Existing Library titles can provide a safe exact match even when not on Home", async () => {
  const h = harness({ library: [{ catalogId: "tt1234567", title: anime.titleAlt, type: "anime" }] });
  assert.equal((await h.resolve(anime)).id, catalog.id);
  assert.equal(h.requests.length, 0);
});

test("Searches cannot open a similarly named but wrong anime and failures are retryable", async () => {
  const h = harness();
  const promise = h.resolve(anime);
  for (const item of h.requests) item.resolve({ results: [
    { id: "tt44444", name: "The Apothecary Diaries", type: "series", releaseInfo: "2028" },
    { id: "tt33333", name: anime.title, type: "movie" },
  ] });
  await new Promise((resolve) => setImmediate(resolve));
  for (const item of h.requests.slice(2)) item.resolve({ results: [] });
  await assert.rejects(promise, /No verified LVL catalog match/);
  const second = h.resolve(anime);
  assert.equal(h.requests.length, 6, "A missing or failed mapping is not cached permanently");
  for (const item of h.requests.slice(4)) item.reject(new Error("Timeout"));
  await new Promise((resolve) => setImmediate(resolve));
  for (const item of h.requests.slice(6)) item.resolve({ results: [] });
  await assert.rejects(second, /temporarily unavailable/);
});

test("Navigating two different cards never reuses another anime's mapping", async () => {
  const h = harness();
  const first = h.resolve(anime);
  const another = h.resolve({ id: 178, title: "Black Clover Season 2", format: "TV", year: 2026 });
  assert.equal(h.requests.length, 3);
  h.requests[2].resolve({ results: [{ id: "tt55555", name: "Black Clover Season 2", type: "series" }] });
  assert.equal((await another).id, "tt55555");
  h.requests[0].resolve({ results: [{ id: "tt1234567", name: anime.title, type: "series" }] });
  h.requests[1].resolve({ results: [] });
  assert.equal((await first).id, "tt1234567");
});

test("Anime cards show active navigation feedback and prefetch on hover or focus", () => {
  assert.match(app, /function queueAnimeBrowserPrefetch\(event\)/);
  assert.match(app, /addEventListener\("focusin", queueAnimeBrowserPrefetch\)/);
  assert.match(app, /addEventListener\("pointerover", queueAnimeBrowserPrefetch\)/);
  assert.match(app, /card\?\.setAttribute\("aria-busy", "true"\)/);
  assert.match(app, /token !== animeBrowser\.openRequestId/);
  assert.match(css, /\.anime-browser-card\.is-resolving/);
});
