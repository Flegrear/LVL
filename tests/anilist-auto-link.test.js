import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { seriesAniList } from "../frontend/anilist/anilist-library.js";
import { matchPublicAniListSeasons, verifiedPublicAniListLinks } from "../frontend/catalog/title-public-ratings.js";

const source = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const start = source.indexOf("const anilistAutoLinkAttempts = new Map();");
const end = source.indexOf("\nfunction gatherAniListWatchedQueue(", start);
assert.ok(start > 0 && end > start);

const parts = [
  { id: 14719, format: "TV", episodes: 26, seasonYear: 2012, title: { english: "JoJo's Bizarre Adventure (TV)" }, sequel: 20474 },
  { id: 20474, format: "TV", episodes: 24, seasonYear: 2014, title: { english: "Stardust Crusaders" }, sequel: 20799 },
  { id: 20799, format: "TV", episodes: 24, seasonYear: 2015, title: { english: "Battle in Egypt" }, sequel: null },
].map(({ sequel, ...media }) => ({ ...media, relations: { edges: sequel ? [{ relationType: "SEQUEL", node: { id: sequel } }] : [] } }));

function fixture({ available = parts, accountChanged = false, prelinked = false, mediaKind = "anime" } = {}) {
  const entry = { id: "jojo-local", episodes: [
    { code: "S01E01", season: null, episode: null,
      progress: { positionMs: 1303167, durationMs: 1444256, finished: false } },
  ], watchedChapters: {}, anilistAutoLinks: prelinked ? [{ userId: 42, catalogId: "tt2359704", season: 1,
    anilistId: 14719, format: "TV", episodes: 26, start: 1, end: 26 }] : [] };
  const series = { key: "jojo's bizarre adventure", title: "JoJo's Bizarre Adventure",
    type: "series", mediaKind, catalogId: "tt2359704", sources: [entry] };
  const calls = [];
  let currentAccount = { userId: 42, token: "fake-test-token" };
  const context = vm.createContext({
    Map, Date, console,
    buildLibrarySeries: () => [series],
    seriesAniList, matchPublicAniListSeasons, verifiedPublicAniListLinks,
    readAniListAccount: () => currentAccount,
    readAniListPreference: () => ({ threshold: 80, enabled: true }),
    localStorage: {},
    fetchJson: async (url) => {
      calls.push(["catalog", url]);
      return { meta: { id: "tt2359704", name: "JoJo's Bizarre Adventure", releaseInfo: "2012–",
        seasons: [{ season: 0, count: 23 }, { season: 1, count: 26 }, { season: 2, count: 48 }] } };
    },
    fetchPublicAniListTitle: async (search) => {
      calls.push(["public", search]);
      if (accountChanged) currentAccount = { userId: 43, token: "other-token" };
      return available;
    },
    updateLibrarySeriesEntries: (key, updater) => {
      assert.equal(key, series.key);
      calls.push(["local-write"]);
      updater(entry);
    },
  });
  vm.runInContext(source.slice(start, end), context);
  return {
    link: () => vm.runInContext("autoLinkAniListWatchedSeries", context)({ userId: 42, token: "fake-test-token" }),
    entry, series, calls,
  };
}

test("watched unlisted JoJo is linked automatically with exact safe season/cour IDs, no AniList writes", async () => {
  const env = fixture();
  assert.equal(await env.link(), 1);
  assert.equal(env.entry.anilistAutoLinks.length, 3);
  assert.deepEqual(env.entry.anilistAutoLinks.map(({ season, anilistId, start, end }) => [season, anilistId, start, end]),
    [[1, 14719, 1, 26], [2, 20474, 1, 24], [2, 20799, 25, 48]]);
  assert.equal(env.entry.anilist, undefined, "An automatic identity match does not fabricate a remote MediaList entry");
  assert.ok(env.entry.anilistAutoLinks.every((link) => !Object.hasOwn(link, "token") && link.userId === 42));
  assert.deepEqual(env.calls.map(([kind]) => kind), ["catalog", "public", "local-write"]);
  assert.equal(await env.link(), 0, "Repeat checks do not overwrite or duplicate existing associations");
});

test("automatic matching never stores partial, ambiguous, switched-account or non-anime associations", async () => {
  const ambiguous = fixture({ available: [parts[0], { ...parts[0], id: 200000 }, ...parts.slice(1)] });
  assert.equal(await ambiguous.link(), 0);
  assert.deepEqual(ambiguous.entry.anilistAutoLinks, []);

  const partial = fixture({ available: parts.slice(0, 2) });
  assert.equal(await partial.link(), 0);
  assert.deepEqual(partial.entry.anilistAutoLinks, []);

  const switched = fixture({ accountChanged: true });
  assert.equal(await switched.link(), 0);
  assert.deepEqual(switched.entry.anilistAutoLinks, []);

  const nonAnime = fixture({ mediaKind: "series" });
  assert.equal(await nonAnime.link(), 0);
  assert.deepEqual(nonAnime.calls, []);

  const alreadyLinked = fixture({ prelinked: true });
  assert.equal(await alreadyLinked.link(), 0);
  assert.deepEqual(alreadyLinked.calls, []);
});
