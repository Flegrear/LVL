import test from "node:test";
import assert from "node:assert/strict";
import { resolveVerifiedAniListLibraryLinks } from "../frontend/anilist/anilist-auto-association.js";
import { seriesAniList } from "../frontend/anilist/anilist-library.js";

const root = (id, title, year, episodes, sequel = null) => ({
  id, title: { english: title, romaji: title }, seasonYear: year, episodes,
  format: "TV", relations: { edges: sequel ? [{ relationType: "SEQUEL", node: { id: sequel } }] : [] },
});
const brotherhood = root(5114, "Fullmetal Alchemist: Brotherhood", 2009, 64);
const meta = (id, name, year, counts) => ({ id, name, releaseInfo: `${year}–`,
  seasons: [{ season: 0, count: 16 }, ...counts.map((count, index) => ({ season: index + 1, count }))] });
const fmabCatalog = meta("tt1355642", "Fullmetal Alchemist: Brotherhood", 2009, [64]);
const resolve = (catalog, found, options = {}) => {
  const fetched = [];
  return { fetched, result: resolveVerifiedAniListLibraryLinks({
    catalogId: catalog?.id, meta: catalog, userId: 42,
    fetchTitle: async (search) => { fetched.push(["search", search]); return found; },
    fetchSequels: async (ids) => { fetched.push(["sequel", ...ids]); return options.lookup?.filter((item) => ids.includes(item.id)) || []; },
  }) };
};

test("FMA Brotherhood catalog-only 64-episode original auto-links exact single AniList TV season", async () => {
  const { fetched, result } = resolve(fmabCatalog, [brotherhood, root(121, "Fullmetal Alchemist", 2003, 51),
    { ...root(6421, "Fullmetal Alchemist: Brotherhood OVA Collection", 2009, 4), format: "OVA" }]);
  const links = await result;
  assert.deepEqual(links.map(({ season, anilistId, episodes, start, end, catalogId, userId }) =>
    ({ season, anilistId, episodes, start, end, catalogId, userId })),
  [{ season: 1, anilistId: 5114, episodes: 64, start: 1, end: 64, catalogId: "tt1355642", userId: 42 }]);
  assert.deepEqual(fetched, [["search", "Fullmetal Alchemist: Brotherhood"]],
    "One verified season needs no extra sequel lookups or personal AniList requests");
  const info = seriesAniList({ catalogId: "tt1355642", sources: [{ anilistAutoLinks: links }] }, 42);
  assert.deepEqual(info.seasons.map(({ season, anilistId, episodes }) => ({ season, anilistId, episodes })),
    [{ season: 1, anilistId: 5114, episodes: 64 }]);
  assert.equal(info.status, null, "Identifying a show must not fabricate a personal list entry");
  assert.equal(seriesAniList({ catalogId: "tt1355642", sources: [{ anilistAutoLinks: links }] }, 43), null,
    "Automatic links belong only to the account under which they were verified");
});

test("no guesses on wrong title/year/episode count, competing roots or missing metadata", async () => {
  const catalogs = [
    meta("tt1355642", "Fullmetal Alchemist", 2009, [64]),
    meta("tt1355642", "Fullmetal Alchemist: Brotherhood", 2003, [64]),
    meta("tt1355642", "Fullmetal Alchemist: Brotherhood", 2009, [63]),
    meta("tt1355642", "Fullmetal Alchemist: Brotherhood", 2009, [12, 52]),
    { ...fmabCatalog, releaseInfo: "" },
    { ...fmabCatalog, id: "unverified-name" },
  ];
  for (const catalog of catalogs) assert.deepEqual(await resolve(catalog, [brotherhood]).result, [], catalog.name);
  assert.deepEqual(await resolve(fmabCatalog, [brotherhood, { ...brotherhood, id: 99999 }]).result, [],
    "Two equally plausible roots cannot be chosen by search position");
  assert.deepEqual(await resolve(fmabCatalog, [{ ...brotherhood, episodes: null }]).result, [],
    "Unknown episode counts cannot authorize watched progress");
  assert.deepEqual(await resolve(fmabCatalog, [{ ...brotherhood, format: "MOVIE" }]).result, []);
});

const jojo = [root(14719, "JoJo's Bizarre Adventure (TV)", 2012, 26, 20474),
  root(20474, "Stardust Crusaders", 2014, 24, 20799),
  root(20799, "Battle in Egypt", 2015, 24)];
const jojoCatalog = meta("tt2359704", "JoJo's Bizarre Adventure", 2012, [26, 48]);

test("multi-season automatic matches fetch only explicit unique sequel IDs and require complete cour boundaries", async () => {
  const { fetched, result } = resolve(jojoCatalog, [jojo[0]], { lookup: jojo.slice(1) });
  const links = await result;
  assert.deepEqual(links.map(({ season, anilistId, start, end }) => [season, anilistId, start, end]),
    [[1, 14719, 1, 26], [2, 20474, 1, 24], [2, 20799, 25, 48]]);
  assert.deepEqual(fetched, [["search", "JoJo's Bizarre Adventure"], ["sequel", 20474], ["sequel", 20799]]);
  assert.deepEqual(await resolve(jojoCatalog, [jojo[0]], { lookup: [jojo[1]] }).result, [],
    "Missing last cour must never persist a partial association");
  assert.deepEqual(await resolve(meta("tt2359704", "JoJo's Bizarre Adventure", 2012, [26, 47]), jojo).result, [],
    "A one-episode catalog disagreement invalidates the full association");
});

test("branched TV/movies, reversed graph, unexpected format and ongoing sequel stay manual-only", async () => {
  const fork = { ...jojo[0], relations: { edges: [
    { relationType: "SEQUEL", node: { id: 20474 } },
    { relationType: "SEQUEL", node: { id: 4000 } },
  ] } };
  const forked = resolve(jojoCatalog, [fork], { lookup: [...jojo.slice(1), { ...root(4000, "Movie", 2014, 1), format: "MOVIE" }] });
  assert.deepEqual(await forked.result, []);
  assert.deepEqual(forked.fetched, [["search", "JoJo's Bizarre Adventure"]],
    "Even a movie fork must not be silently treated as unique without verification");
  assert.deepEqual(await resolve(jojoCatalog, [{ ...jojo[0], relations: { edges: [] } }], { lookup: jojo.slice(1) }).result, []);
  assert.deepEqual(await resolve(jojoCatalog, [jojo[0]], { lookup: [{ ...jojo[1], format: "MOVIE" }, jojo[2]] }).result, []);
  assert.deepEqual(await resolve(jojoCatalog, [jojo[0]], { lookup: [{ ...jojo[1], episodes: null, status: "RELEASING" }, jojo[2]] }).result, [],
    "Read-only display-only ongoing sequel ratings must never authorize remote syncing");
});

test("reject incomplete identity, wrong account, bad root, or unusable AniList fetch payload", async () => {
  const common = { catalogId: fmabCatalog.id, meta: fmabCatalog,
    fetchTitle: async () => [brotherhood], fetchSequels: async () => [] };
  assert.deepEqual(await resolveVerifiedAniListLibraryLinks({ ...common, userId: 0 }), []);
  assert.deepEqual(await resolveVerifiedAniListLibraryLinks({ ...common, userId: 42, catalogId: "tt0000000" }), []);
  assert.deepEqual(await resolveVerifiedAniListLibraryLinks({ ...common, userId: 42, fetchTitle: async () => null }), []);
  assert.deepEqual(await resolveVerifiedAniListLibraryLinks({ ...common, userId: 42, fetchTitle: null }), []);
});
