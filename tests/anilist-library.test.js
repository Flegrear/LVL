import test from "node:test";
import assert from "node:assert/strict";
import { catalogTitles, createRecsService } from "../backend/recommendations/recs-service.js";
import { ANILIST_LINK_SEARCH, ANILIST_LINK_VERIFY, anilistProgressText, anilistRatingText, anilistWatchedSummary, canLinkAniListTv, fillMissingAniListAverages, importedEntryId, planAniListLibrary, seriesAniList } from "../frontend/anilist/anilist-library.js";
import { resolveAniListEpisode } from "../frontend/anilist/anilist-watch-sync.js";
import { fakeAniList, media, memoryStore } from "./recs-fixtures.js";

const title = (english) => ({ english, romaji: english });
const rel = (type, id, format = "TV") => ({ relationType: type, node: { id, type: "ANIME", format } });
const anime = {
  1: media(1, { title: title("Titan"), seasonYear: 2013, relations: { edges: [rel("SEQUEL", 2), rel("SIDE_STORY", 4, "OVA")] } }),
  2: media(2, { title: title("Titan Season 2"), seasonYear: 2017, relations: { edges: [rel("PREQUEL", 1), rel("SEQUEL", 3)] } }),
  3: media(3, { title: title("Titan Season 2 Part 2"), seasonYear: 2018, relations: { edges: [rel("PREQUEL", 2)] } }),
  4: media(4, { format: "OVA", title: title("Titan: Lost Girls"), seasonYear: 2017, relations: { edges: [rel("PARENT", 1)] } }),
  5: media(5, { format: "MOVIE", title: title("Titan: The Movie"), seasonYear: 2015, relations: { edges: [rel("PREQUEL", 1)] } }),
  10: media(10, { title: title("Hunter x Hunter (2011)"), seasonYear: 2011 }),
  20: media(20, { title: title("Quiet Show"), seasonYear: 2020, relations: { edges: [rel("SEQUEL", 21)] } }),
  21: media(21, { title: title("Quiet Show Season 2"), seasonYear: 2022, relations: { edges: [rel("PREQUEL", 20)] } }),
};
const entry = (id, status, score, progress, updatedAt) => ({ status, score, progress, updatedAt, media: anime[id] });
const list = [
  entry(2, "COMPLETED", 9, 12, 1_700_000_100), entry(1, "COMPLETED", 8.5, 25, 1_700_000_000), entry(3, "CURRENT", 0, 4, 1_700_000_300),
  entry(4, "PLANNING", 0, 0, 1_700_000_050), entry(5, "COMPLETED", 8, 1, 1_700_000_200), entry(10, "COMPLETED", 9.5, 148, 1_600_000_000),
  entry(21, "PLANNING", 0, 0, 1_700_000_400),
];
const catalog = {
  Titan: [{ id: "tt2560140", type: "series", name: "Titan", releaseInfo: "2013–2023" }],
  "Hunter x Hunter": [{ id: "tt2098220", type: "series", name: "Hunter x Hunter", releaseInfo: "2011–2014" }],
  "Titan: The Movie": [{ id: "tt5000001", type: "movie", name: "Titan: The Movie", releaseInfo: "2015" }],
};

test("catalog name variants drop a subtitle, a (2011) and a Season 2", () => {
  assert.deepEqual(catalogTitles({ title: "Hunter x Hunter (2011)", titleAlt: "HUNTER×HUNTER (2011)" }).slice(0, 3), ["Hunter x Hunter (2011)", "HUNTER×HUNTER (2011)", "Hunter x Hunter"]);
  assert.ok(catalogTitles({ title: "Jujutsu Kaisen Season 2" }).includes("Jujutsu Kaisen"));
  assert.ok(catalogTitles({ title: "Yu Yu Hakusho: Ghostfiles" }).includes("Yu Yu Hakusho"));
});

test("AniList cards show completed and rated progress without making up local chapters", () => {
  const completed = { seasons: [
    { season: 1, progress: 12, episodes: 12, status: "COMPLETED", score: 9.5 },
    { season: 2, progress: 6, episodes: 12, status: "PAUSED", score: 8.5 },
  ] };
  assert.equal(anilistProgressText(completed), "S1 E12 of 12", "Previously watched episodes are visible outside CURRENT status");
  assert.deepEqual(anilistWatchedSummary(completed), { watched: 18, total: 24 });
  assert.equal(anilistRatingText(completed), "Your rating: 9/10");
  assert.equal(anilistRatingText({ seasons: [{ status: "PLANNING", progress: 0, score: null }] }), "");
  assert.equal(anilistProgressText({ seasons: [{ status: "PLANNING", progress: 0 }] }), "");
  assert.deepEqual(anilistWatchedSummary({ seasons: [{ progress: 3, episodes: null }] }), { watched: 3, total: null });
});

test("your AniList list for the Library: a title per show with its seasons in order, movies apart, catalog pages", async () => {
  const store = memoryStore();
  const anilist = fakeAniList({ list, anime });
  const searches = [];
  const service = createRecsService({ store, anilist, searchCatalog: async (query) => { searches.push(query); return catalog[query] || []; }, log: { warn() {} } });
  await service.linkAniList("me");
  const { shows } = await service.anilistLibrary();
  const byTitle = Object.fromEntries(shows.map((show) => [show.title, show]));
  assert.deepEqual(Object.keys(byTitle).sort(), ["Hunter x Hunter (2011)", "Quiet Show", "Titan", "Titan: The Movie"]);
  const titan = byTitle.Titan;
  assert.equal(titan.type, "series");
  assert.equal(titan.imdbId, "tt2560140");
  assert.equal(titan.status, "CURRENT", "watching any season makes the show Watching");
  assert.equal(titan.averageScore, 80, "the public score comes from AniList media metadata, not personal list ratings");
  assert.deepEqual(titan.seasons.map((season) => [season.title, season.season]), [["Titan", 1], ["Titan Season 2", 2], ["Titan Season 2 Part 2", 2], ["Titan: Lost Girls", null]]);
  assert.equal(byTitle["Titan: The Movie"].type, "movie");
  assert.equal(byTitle["Titan: The Movie"].imdbId, "tt5000001");
  assert.equal(byTitle["Hunter x Hunter (2011)"].imdbId, "tt2098220", "found without the (2011)");
  const quiet = byTitle["Quiet Show"];
  assert.deepEqual(quiet.seasons.map((season) => season.title), ["Quiet Show Season 2"], "the first season isn't on the list but names the show");
  assert.equal(quiet.status, "PLANNING");
  assert.equal(quiet.imdbId, null);

  // A second read uses what's saved: no AniList requests, and a miss isn't searched again today.
  const requests = anilist.requests;
  const searched = searches.length;
  await service.anilistLibrary();
  assert.equal(anilist.requests, requests);
  assert.equal(searches.length, searched);
});

test("missing community averages backfill onto exact show identities without changing personal AniList data", () => {
  const entries = [
    { anilist: { showId: "anilist:1", averageScore: null, status: "CURRENT", seasons: [{ score: 9.5 }] } },
    { anilist: { showId: "anilist:2", averageScore: 77, status: "COMPLETED" } },
    { anilist: { showId: "anilist:3", averageScore: null, status: "DROPPED" } },
    { anilist: { showId: "anilist:4", averageScore: null } },
  ];
  const changed = fillMissingAniListAverages(entries, [
    { showId: "anilist:1", averageScore: 85 },
    { showId: "anilist:2", averageScore: 99 },
    { showId: "anilist:3", averageScore: 0 },
    { showId: "anilist:5", averageScore: 90 },
  ]);
  assert.equal(changed, 1);
  assert.equal(entries[0].anilist.averageScore, 85);
  assert.equal(entries[0].anilist.status, "CURRENT");
  assert.equal(entries[0].anilist.seasons[0].score, 9.5);
  assert.equal(entries[1].anilist.averageScore, 77);
  assert.equal(entries[2].anilist.averageScore, null);
  assert.equal(entries[3].anilist.averageScore, null);
  assert.equal(fillMissingAniListAverages(entries, [{ showId: "anilist:1", averageScore: 85 }]), 0);
});

test("the Library plan: adds new shows, marks your own titles, drops imports no longer on your list", () => {
  const keyOf = (name) => String(name || "").trim().toLowerCase();
  const own = { key: "frieren", catalogId: "tt22248376", aliases: [], sources: [{ id: "magnet:abc", episodes: [{ code: "S01E01" }] }] };
  const oldImport = { key: "gone show", catalogId: "", aliases: [], sources: [{ id: "anilist:77", anilistImported: true, episodes: [] }] };
  const renamedImport = { key: "titan", catalogId: "", aliases: [], sources: [{ id: "anilist:1", anilistImported: true, episodes: [] }] };
  const stale = { key: "naruto", catalogId: "tt0409591", aliases: [], sources: [{ id: "catalog:series:tt0409591", anilist: { showId: "anilist:20" }, episodes: [] }] };
  const shows = [
    { showId: "anilist:154587", anilistId: 154587, title: "Frieren: Beyond Journey's End", imdbId: "tt22248376", type: "series", status: "COMPLETED", seasons: [] },
    { showId: "anilist:1", anilistId: 1, title: "Titan", imdbId: "tt2560140", type: "series", status: "CURRENT", seasons: [{ season: 2, status: "CURRENT", progress: 4, episodes: 10 }] },
  ];
  const plan = planAniListLibrary({ series: [own, oldImport, renamedImport, stale], shows, keyOf });
  assert.deepEqual(plan.annotate.map(({ series }) => series.key), ["frieren"]);
  assert.deepEqual(plan.add.map(({ show }) => importedEntryId(show)), ["catalog:series:tt2560140"]);
  assert.deepEqual(plan.remove.sort(), ["anilist:1", "anilist:77"], "the old id of a show now on its catalog page goes too");
  assert.deepEqual(plan.clear, ["catalog:series:tt0409591"]);
  assert.equal(anilistProgressText(plan.add[0].info), "S2 E4 of 10");
});

test("the earlier importer's entries (one per season) fold into one title per show; one with videos stays", () => {
  const keyOf = (name) => String(name || "").trim().toLowerCase();
  const legacy = (id, name, episodes = []) => ({ key: keyOf(name), catalogId: "", aliases: [name], sources: [{ id: `anilist:${id}`, externalSource: "ANILIST", anilistId: id, episodes }] });
  const series = [legacy(1, "Titan"), legacy(2, "Titan Season 2"), legacy(3, "Titan Season 2 Part 2"), legacy(9, "Old Favorite", [{ code: "S01E01" }])];
  const shows = [{ showId: "anilist:1", anilistId: 1, title: "Titan", imdbId: "tt2560140", type: "series", status: "CURRENT", seasons: [] }];
  const plan = planAniListLibrary({ series, shows, keyOf });
  assert.deepEqual(plan.add.map(({ show }) => importedEntryId(show)), ["catalog:series:tt2560140"], "the show is added once, on its catalog page");
  assert.deepEqual(plan.annotate, [], "an old import isn't treated as a title you added");
  assert.deepEqual(plan.remove.sort(), ["anilist:1", "anilist:2", "anilist:3"], "its per-season entries go");
  assert.ok(!plan.remove.includes("anilist:9"), "an old import you added videos to stays");
});

test("an earlier import merged into a title you added yourself goes; your entry keeps its videos and gets the status", () => {
  const keyOf = (name) => String(name || "").trim().toLowerCase();
  const yours = { key: "attack on titan", catalogId: "tt2560140", aliases: [], sources: [
    { id: "magnet:aot", episodes: [{ code: "S01E01" }, { code: "S01E02" }] },
    { id: "anilist:16498", externalSource: "ANILIST", anilistId: 16498, episodes: [] },
  ] };
  const shows = [{ showId: "anilist:16498", anilistId: 16498, title: "Attack on Titan", imdbId: "tt2560140", type: "series", status: "COMPLETED", seasons: [] }];
  const plan = planAniListLibrary({ series: [yours], shows, keyOf });
  assert.deepEqual(plan.add, []);
  assert.deepEqual(plan.annotate.map(({ series }) => series.key), ["attack on titan"]);
  assert.deepEqual(plan.remove, ["anilist:16498"]);
  assert.deepEqual(plan.clear, []);
});

test("Unlisted anime can only map a season through an explicit account-scoped verified TV link", () => {
  const media = { id: 14719, format: "TV", episodes: 26, title: "JoJo's Bizarre Adventure", season: 1, userId: 42 };
  const entry = { id: "local-jojo", episodes: [{ code: "S01E01", progress: { finished: true } }],
    anilistManualLinks: [{ userId: 42, season: 1, anilistId: media.id, format: media.format, episodes: media.episodes, title: media.title }] };
  const series = { key: "jojo's bizarre adventure", sources: [entry] };
  assert.equal(seriesAniList(series), null, "Manual links are not presented as authenticated remote list statuses");
  assert.equal(seriesAniList(series, 99), null, "A different signed-in account cannot use another account's link");
  const linked = seriesAniList(series, 42);
  assert.equal(linked.seasons.length, 1);
  assert.deepEqual(linked.seasons.map(({ season, anilistId, episodes }) => [season, anilistId, episodes]), [[1, 14719, 26]]);
  assert.equal(linked.seasons[0].progress, null, "Linking never claims AniList has any remote watched progress");
  assert.equal(linked.seasons[0].score, null, "Linking never fabricates an AniList score");
  assert.equal(canLinkAniListTv({ id: 14719, format: "OVA", episodes: 26 }), false);
  assert.equal(canLinkAniListTv({ id: 14719, format: "TV", episodes: null }), false);
  assert.equal(canLinkAniListTv({ id: 200, format: "TV", episodes: 12, title: { english: "Anime Season Part 2" } }), false,
    "An isolated later cour must never be mapped as episode one without explicit episode offsets");
  assert.match(ANILIST_LINK_SEARCH, /media\(search: \$search, type: ANIME/);
  assert.match(ANILIST_LINK_VERIFY, /Media\(id: \$id, type: ANIME/);

  const imported = { showId: "remote:list", accountUserId: 42, seasons: [{ season: 2, anilistId: 100, episodes: 12, format: "TV", status: "CURRENT" }] };
  entry.anilist = imported;
  assert.equal(seriesAniList(series, 42).seasons.length, 2, "Manual first season merges with an imported second season");
  imported.seasons.push({ season: 1, anilistId: 14719, episodes: 26, format: "TV" });
  assert.equal(seriesAniList(series, 42).seasons.length, 2, "The identical media cannot double-count after an AniList refresh");
  delete entry.anilist;
  assert.equal(seriesAniList(series, 42).seasons.length, 1, "The manual link survives authenticated list cleanup");
});

test("account-scoped automatic AniList links support verified split parts without claiming any remote entry", () => {
  const series = { key: "jojo's bizarre adventure", catalogId: "tt2359704", sources: [{
    episodes: [{ code: "S01E01" }], anilistAutoLinks: [
      { userId: 42, catalogId: "tt2359704", season: 1, anilistId: 14719, format: "TV", episodes: 26, title: "JoJo TV", start: 1, end: 26 },
      { userId: 42, catalogId: "tt2359704", season: 2, anilistId: 20474, format: "TV", episodes: 24, title: "Stardust", start: 1, end: 24 },
      { userId: 42, catalogId: "tt2359704", season: 2, anilistId: 20799, format: "TV", episodes: 24, title: "Battle in Egypt", start: 25, end: 48 },
    ],
  }] };
  assert.equal(seriesAniList(series), null, "No claim that the user added JoJo to AniList");
  assert.equal(seriesAniList(series, 43), null, "Another account cannot reuse the verified mapping");
  const info = seriesAniList(series, 42);
  assert.equal(info.seasons.length, 3);
  assert.equal(info.seasons[0].status, null);
  assert.equal(info.seasons[0].progress, null);
  assert.equal(info.ranges.length, 3);
  assert.deepEqual(resolveAniListEpisode({ seasons: info.seasons, ranges: info.ranges, episodeCode: "S02E25" }),
    { mediaId: 20799, episode: 1, episodeCount: 24, code: "S02E25", season: 2 });
  assert.deepEqual(resolveAniListEpisode({ seasons: info.seasons, ranges: info.ranges, episodeCode: "S02E24" }),
    { mediaId: 20474, episode: 24, episodeCount: 24, code: "S02E24", season: 2 });
  series.catalogId = "tt9999999";
  assert.equal(seriesAniList(series, 42), null, "Changing the catalog identity invalidates old automatic links");
});
