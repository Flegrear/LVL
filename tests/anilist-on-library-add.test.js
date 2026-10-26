import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { seriesAniList } from "../frontend/anilist/anilist-library.js";
import { eligibleForPublicAnimeRating } from "../frontend/catalog/title-public-ratings.js";
import { resolveVerifiedAniListLibraryLinks } from "../frontend/anilist/anilist-auto-association.js";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const addFrom = app.indexOf("function addCatalogPlaceholder(");
const addTo = app.indexOf("\nfunction currentSeriesChapters(", addFrom);
const matcherFrom = app.indexOf("const newlyAddedAniListMatches = new Set();");
const matcherTo = app.indexOf("\nfunction gatherAniListWatchedQueue(", matcherFrom);
assert.ok(addFrom > 0 && addTo > addFrom && matcherFrom > 0 && matcherTo > matcherFrom,
  "add and auto-association integration must both remain present");

const fmab = { id: "tt1355642", type: "series", name: "Fullmetal Alchemist: Brotherhood",
  releaseInfo: "2009–2010", genres: ["Animation", "Action"], country: "Japan",
  seasons: [{ season: 0, count: 20 }, { season: 1, count: 64 }] };
const fullmetal = { id: 5114, format: "TV", episodes: 64, seasonYear: 2009,
  title: { english: "Fullmetal Alchemist: Brotherhood" }, relations: { edges: [] } };

function fixture({ account = { userId: 42, token: "connected-token" }, details = fmab,
  candidates = [fullmetal], pendingCandidates = null, mediaKind = "anime" } = {}) {
  const state = { library: [] };
  const calls = [];
  let connected = account;
  let unblock = null;
  const deferred = pendingCandidates ? new Promise((resolve) => { unblock = resolve; }) : null;
  const context = vm.createContext({
    Set, Date, Number, String, console, state, localStorage: {},
    librarySeriesKey: (name) => name.toLowerCase(),
    catalogMediaKind: () => mediaKind,
    readAniListAccount: () => connected,
    saveLibrary: () => calls.push("save"),
    renderLibrary: () => calls.push("render"),
    updateLibrarySummary: () => calls.push("summary"),
    $: () => null,
    fetchJson: async (url) => { calls.push("catalog"); assert.match(url, /tt1355642/); return { meta: details }; },
    fetchPublicAniListTitle: async (name) => {
      calls.push("search");
      assert.equal(name, "Fullmetal Alchemist: Brotherhood");
      return deferred ? await deferred : candidates;
    },
    fetchPublicAniListSequels: async () => { calls.push("sequel"); return []; },
    resolveVerifiedAniListLibraryLinks, eligibleForPublicAnimeRating, seriesAniList,
    buildLibrarySeries: () => state.library.map((entry) => ({
      key: entry.seriesKey, type: entry.catalogType, mediaKind: entry.mediaKind,
      catalogId: entry.catalogId, sources: state.library.filter((other) => other.seriesKey === entry.seriesKey),
    })),
    updateLibrarySeriesEntries: (key, updater) => {
      calls.push("persist-link");
      for (const entry of state.library.filter((item) => item.seriesKey === key)) updater(entry);
      calls.push("save");
    },
  });
  vm.runInContext(app.slice(addFrom, addTo), context);
  vm.runInContext(app.slice(matcherFrom, matcherTo), context);
  const add = (metadata = fmab, options = {}) => vm.runInContext("addCatalogPlaceholder", context)(metadata, options);
  const settle = async () => { for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve)); };
  return { add, settle, state, calls,
    switchAccount: (value) => { connected = value; }, releaseCandidates: () => unblock?.(pendingCandidates) };
}

test("saving a new catalog anime immediately and quietly verifies/persists its correct AniList season", async () => {
  const env = fixture();
  const saved = env.add();
  assert.ok(saved && env.state.library.length === 1);
  assert.ok(env.calls.includes("save"), "Library entry is saved before the network lookup completes");
  await env.settle();
  assert.deepEqual(Array.from(saved.anilistAutoLinks, ({ season, anilistId, episodes, start, end, userId }) =>
    [season, anilistId, episodes, start, end, userId]), [[1, 5114, 64, 1, 64, 42]]);
  assert.equal(saved.anilist, undefined, "No invented AniList list status or authenticated write");
  assert.deepEqual(env.calls, ["save", "summary", "catalog", "search", "persist-link", "save"]);
  assert.deepEqual(seriesAniList({ catalogId: fmab.id, sources: [saved] }, 42).seasons.map((item) => item.anilistId), [5114]);
});

test("no account, imported AniList entry, and render=false never schedule add-time linking", async () => {
  const noAccount = fixture({ account: null });
  noAccount.add(); await noAccount.settle();
  assert.deepEqual(noAccount.calls, ["save", "summary"]);
  const imported = fixture();
  imported.add(fmab, { externalSource: "ANILIST" }); await imported.settle();
  assert.deepEqual(imported.calls, ["save", "summary"]);
  const deferred = fixture();
  deferred.add(fmab, { render: false }); await deferred.settle();
  assert.deepEqual(deferred.calls, []);
});

test("unknown/non-Japanese animation or ambiguous season never gets an automatic link", async () => {
  const nonAnime = fixture({ details: { ...fmab, genres: ["Drama"], country: "United States" }, mediaKind: "" });
  const entry = nonAnime.add(); await nonAnime.settle();
  assert.equal(entry.anilistAutoLinks, undefined);
  assert.ok(!nonAnime.calls.includes("search"));

  const ambiguous = fixture({ candidates: [fullmetal, { ...fullmetal, id: 999999 }] });
  const saved = ambiguous.add(); await ambiguous.settle();
  assert.equal(saved.anilistAutoLinks, undefined);
  assert.ok(!ambiguous.calls.includes("persist-link"));
});

test("switching AniList accounts during the public lookup blocks stale persistence", async () => {
  const env = fixture({ pendingCandidates: [fullmetal] });
  const saved = env.add();
  await env.settle();
  assert.ok(env.calls.includes("search"));
  env.switchAccount({ userId: 43, token: "new-account" });
  env.releaseCandidates();
  await env.settle();
  assert.equal(saved.anilistAutoLinks, undefined);
  assert.ok(!env.calls.includes("persist-link"));
});

test("removing the saved title during lookup or retaining another account's link cannot be overwritten", async () => {
  const removed = fixture({ pendingCandidates: [fullmetal] });
  removed.add(); await removed.settle();
  removed.state.library.length = 0;
  removed.releaseCandidates(); await removed.settle();
  assert.ok(!removed.calls.includes("persist-link"));

  const other = fixture();
  const entry = other.add();
  entry.anilistAutoLinks = [{ userId: 43, catalogId: fmab.id, season: 1,
    anilistId: 5114, format: "TV", episodes: 64, start: 1, end: 64 }];
  await other.settle();
  assert.deepEqual(Array.from(entry.anilistAutoLinks, (link) => link.userId).sort(), [42, 43]);
});
