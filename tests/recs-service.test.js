import test from "node:test";
import assert from "node:assert/strict";
import { bestCatalogMatch, createRecsService } from "../backend/recommendations/recs-service.js";
import { fakeAniList, media, memoryStore } from "./recs-fixtures.js";

const DAY = 86_400_000;
const quiet = { warn() {} };
const title = (english, romaji = english) => ({ english, romaji });

// Frieren (rated 9.7 on AniList) and JJK (rated 9.00 in the app) lead to their fans' picks.
const anime = {
  154587: media(154587, { title: title("Frieren: Beyond Journey's End", "Sousou no Frieren"), seasonYear: 2023, genres: ["Adventure", "Drama", "Fantasy"], tags: [{ name: "Travel", rank: 96 }], studios: { nodes: [{ name: "MADHOUSE" }] },
    recommendations: { nodes: [
      { rating: 1191, mediaRecommendation: { id: 21827 } }, { rating: 765, mediaRecommendation: { id: 153518 } },
      { rating: 900, mediaRecommendation: { id: 2001 } }, { rating: 298, mediaRecommendation: { id: 2002 } },
    ] } }),
  113415: media(113415, { title: title("JUJUTSU KAISEN", "Jujutsu Kaisen"), genres: ["Action", "Supernatural"], studios: { nodes: [{ name: "MAPPA" }] },
    recommendations: { nodes: [{ rating: 800, mediaRecommendation: { id: 127230 } }] } }),
  20: media(20, { title: title("Naruto"), genres: ["Action"], recommendations: { nodes: [{ rating: 500, mediaRecommendation: { id: 21 } }] } }),
  21827: media(21827, { title: title("Violet Evergarden"), seasonYear: 2018, averageScore: 85, genres: ["Drama", "Fantasy"], tags: [{ name: "Travel", rank: 70 }] }),
  153518: media(153518, { title: title("Delicious in Dungeon", "Dungeon Meshi"), seasonYear: 2024, averageScore: 85, genres: ["Adventure", "Fantasy", "Comedy"] }),
  127230: media(127230, { title: title("Chainsaw Man"), seasonYear: 2022, genres: ["Action", "Supernatural"], studios: { nodes: [{ name: "MAPPA" }] } }),
  2001: media(2001, { title: title("Frieren Season 2"), relations: { edges: [{ relationType: "PREQUEL", node: { id: 154587, type: "ANIME", format: "TV" } }] } }),
  2002: media(2002, { title: title("Mushishi Zoku Shou"), seasonYear: 2014, averageScore: 86, genres: ["Adventure", "Mystery"], relations: { edges: [{ relationType: "PREQUEL", node: { id: 457, type: "ANIME", format: "TV" } }] } }),
  457: media(457, { title: title("Mushi-shi", "Mushishi"), seasonYear: 2005, averageScore: 84, genres: ["Adventure", "Mystery"], relations: { edges: [{ relationType: "SEQUEL", node: { id: 2002, type: "ANIME", format: "TV" } }] } }),
  21: media(21, { title: title("Boruto"), genres: ["Action"], averageScore: 58 }),
};
const list = [
  { status: "COMPLETED", score: 9.7, progress: 28, updatedAt: 1_700_000_000, media: anime[154587] },
  { status: "COMPLETED", score: 4, progress: 220, updatedAt: 1_600_000_000, media: anime[20] },
];
const search = { "Jujutsu Kaisen": [{ id: 113415, format: "TV", seasonYear: 2020, popularity: 900000, title: title("JUJUTSU KAISEN", "Jujutsu Kaisen"), synonyms: [] }] };
const catalog = {
  "Violet Evergarden": [{ id: "tt7078180", type: "series", name: "Violet Evergarden", releaseInfo: "2018" }],
  "Delicious in Dungeon": [{ id: "tt21621494", type: "series", name: "Delicious in Dungeon", releaseInfo: "2024–" }],
  "Mushi-shi": [{ id: "tt0807832", type: "series", name: "Mushi-Shi", releaseInfo: "2005–2006" }],
};

function setup({ clock = { now: 50 * DAY } } = {}) {
  const store = memoryStore(() => clock.now);
  const anilist = fakeAniList({ list, anime, search });
  const searches = [];
  const service = createRecsService({ store, anilist, searchCatalog: async (query) => { searches.push(query); return catalog[query] || []; }, now: () => clock.now, log: quiet });
  return { store, anilist, service, clock, searches };
}

test("catalog matching needs the same name; year and type settle ties", () => {
  const results = [{ id: "tt1", type: "movie", name: "Violet Evergarden: The Movie", releaseInfo: "2020" }, { id: "tt7078180", type: "series", name: "Violet Evergarden", releaseInfo: "2018" }];
  assert.equal(bestCatalogMatch(results, { titles: ["Violet Evergarden"], year: 2018 }).id, "tt7078180");
  assert.equal(bestCatalogMatch(results, { titles: ["Something else"] }), null);
  assert.equal(bestCatalogMatch([{ id: "tt5555555", type: "series", name: "Titan Evolution", releaseInfo: "2020" }],
    { titles: ["Titan"], year: 2020 }), null, "a shared prefix cannot link a different show");
  assert.equal(bestCatalogMatch([{ id: "tt6666666", type: "series", name: "Titan", releaseInfo: "2005" }],
    { titles: ["Titan"], year: 2020 }), null, "an unrelated same-name remake must fail the release-year check");
  assert.equal(bestCatalogMatch([{ id: "tt7777777", type: "movie", name: "Titan", releaseInfo: "2020" }],
    { titles: ["Titan"], year: 2020 }), null, "a movie with the same title cannot map a series");
});

test("rating-to-AniList mapping rejects prefix, year and format collisions", async () => {
  for (const { label, entry } of [
    { label: "prefix", entry: { id: 1, title: title("Titan Evolution"), seasonYear: 2020, format: "TV" } },
    { label: "year", entry: { id: 2, title: title("Titan"), seasonYear: 2005, format: "TV" } },
    { label: "format", entry: { id: 3, title: title("Titan"), seasonYear: 2020, format: "MOVIE" } },
  ]) {
    const store = memoryStore();
    const service = createRecsService({ store, anilist: fakeAniList({ search: { Titan: [entry] } }), log: quiet });
    service.rate({ catalogId: "tt1234567", title: "Titan", kind: "anime", year: 2020, score: 8 });
    await service.refresh();
    assert.equal(store.ratings().find((rating) => rating.source === "app").itemId, null, `${label} mismatch should not assign a rating to another anime`);
  }
});

test("title ratings reject unrelated anime with the same prefix or a different release year", () => {
  const { store, service } = setup();
  store.replaceSourceRatings("anilist", [
    { key: "same", itemId: "anilist:1", title: "Titan", year: 2020, kind: "anime", score: 9 },
    { key: "sequel", itemId: "anilist:2", title: "Titan Evolution", year: 2020, kind: "anime", score: 8 },
    { key: "remake", itemId: "anilist:3", title: "Titan", year: 2005, kind: "anime", score: 6 },
  ]);
  assert.deepEqual(service.titleRatings({ catalogId: "tt1234567", title: "Titan", year: 2020 }).ratings.map((entry) => entry.key),
    ["anilist:same"], "fuzzy name matching must not attach scores from another show or remake");
  store.upsertItems([{ itemId: "anilist:3", source: "anilist", sourceId: "3", title: "Titan", imdbId: "tt1234567" }]);
  assert.deepEqual(service.titleRatings({ catalogId: "tt1234567", title: "Titan", year: 2020 }).ratings.map((entry) => entry.key).sort(),
    ["anilist:remake", "anilist:same"], "explicit item-to-catalog linkage still takes priority over name and year heuristics");
});

test("incomplete authenticated AniList collection cannot erase synced scores", () => {
  const { store, service } = setup();
  store.replaceSourceRatings("anilist", [{ key: "101", itemId: "anilist:101", title: "Protected", score: 9 }]);
  const settings = store.settings().anilist;
  assert.throws(() => service.linkAuthenticatedAniList({ Viewer: { id: 5, name: "viewer" }, MediaListCollection: null }), /invalid authenticated list/);
  assert.throws(() => service.linkAuthenticatedAniList({ Viewer: { id: 5, name: "viewer" }, MediaListCollection: { lists: [] } }), /invalid authenticated list/);
  assert.equal(store.ratings().find((rating) => rating.source === "anilist").score, 9);
  assert.equal(store.settings().anilist, settings);
});

test("Locally rated anime reuses a unique authenticated AniList media ID and the opt-in remote score drives picks", async () => {
  const { store, service, anilist } = setup();
  const snapshot = (scoreSyncEnabled) => ({
    Viewer: { id: 42, name: "me" },
    MediaListCollection: { user: { id: 42, name: "me" }, lists: [{ entries: [
      { status: "COMPLETED", score: 9.7, progress: 28, updatedAt: 1_700_000_000, media: anime[154587] },
    ] }] },
    scoreSyncEnabled,
  });
  service.linkAuthenticatedAniList(snapshot(false));
  service.rate({ catalogId: "tt22248376", title: "Frieren: Beyond Journey's End", kind: "anime", year: 2023, score: 3 });
  anilist.search = async () => { throw new Error("Exact imported media must not need a search"); };
  await service.refresh();
  const local = store.ratings().find((rating) => rating.source === "app");
  assert.equal(local.itemId, "anilist:154587");
  assert.equal(local.score, 3, "Imported list must not overwrite local edits");
  assert.equal(service.overview().picks.some((pick) => pick.title === "Violet Evergarden"), false, "Default preference honors the local score");

  service.linkAuthenticatedAniList(snapshot(true));
  await service.refresh();
  const violet = service.overview().picks.find((pick) => pick.title === "Violet Evergarden");
  assert.ok(violet, "Opted-in AniList score is a positive recommendation seed");
  assert.match(violet.summary, /Frieren: Beyond Journey's End 9\.70/);
  assert.equal(store.ratings().find((rating) => rating.source === "app").score, 3);
});

test("link AniList, rate a title in the app, refresh: picks from fans' links, shown as first seasons, with reasons and titles", async () => {
  const { service, store, anilist, searches } = setup();
  await assert.rejects(service.linkAniList("someone-else"), /wasn't found/);
  let overview = await service.linkAniList("me");
  assert.equal(overview.settings.anilist.username, "me");
  assert.equal(overview.settings.anilist.scored, 2);
  const rated = service.rate({ catalogId: "tt12343534", title: "Jujutsu Kaisen", kind: "anime", year: 2020, score: 9.004 });
  assert.equal(rated.rating.score, 9);
  assert.throws(() => service.rate({ catalogId: "tt12343534", title: "x", score: "abc" }), /number from 1 to 10/);

  overview = await service.refresh({ trigger: "manual" });
  const titles = overview.picks.map((pick) => pick.title);
  assert.ok(titles.includes("Violet Evergarden"), titles.join(", "));
  assert.ok(titles.includes("Chainsaw Man"), "JJK, rated in the app, was found on AniList and used");
  assert.ok(titles.includes("Mushi-shi"), "a later season is shown as the show's first season");
  for (const left of ["Mushishi Zoku Shou", "Frieren Season 2", "Boruto"]) assert.ok(!titles.includes(left), `${left} should not be a pick`);
  const violet = overview.picks.find((pick) => pick.title === "Violet Evergarden");
  assert.equal(violet.imdbId, "tt7078180", "matched to the catalog, so it opens on its page");
  assert.equal(violet.summary, "Because you rated Frieren: Beyond Journey's End 9.70");
  assert.ok(violet.match > 0.8, `match ${violet.match}`);
  assert.equal(overview.picks.find((pick) => pick.title === "Mushi-shi").imdbId, "tt0807832");
  assert.ok(searches.includes("Violet Evergarden"));
  assert.equal(store.item("anilist:2002").franchiseId, "anilist:457");
  assert.equal(store.item("anilist:2002").seasonNumber, 2);
  assert.equal(overview.status.lastRun.status, "done");
  assert.ok(overview.status.lastRun.requests >= 3 && overview.status.lastRun.requests <= 12, `requests ${overview.status.lastRun.requests}`);

  // A second refresh right away reuses the stored data: no new AniList requests.
  const before = anilist.requests;
  await service.refresh({ trigger: "manual" });
  assert.equal(anilist.requests - before, 0);

  // Hidden titles go away; the export knows every show.
  overview = service.hide(violet.itemId);
  assert.ok(!overview.picks.some((pick) => pick.itemId === violet.itemId));
  assert.equal(service.unhideAll().stats.hidden, 0);
  const ratings = service.titleRatings({ catalogId: "tt22248376", title: "Frieren: Beyond Journey's End", year: 2023 }).ratings;
  assert.deepEqual(ratings.map((rating) => [rating.source, rating.score]), [["anilist", 9.7]], "your AniList score shows on the title's page");
});

test("a failed refresh keeps the previous picks; unlinking removes imported ratings only", async () => {
  const { service, anilist } = setup();
  await service.linkAniList("me");
  service.rate({ catalogId: "tt12343534", title: "Jujutsu Kaisen", kind: "anime", score: 9 });
  await service.refresh();
  const picks = service.overview().picks.length;
  assert.ok(picks > 0);
  anilist.search = async () => { throw new Error("AniList is down"); };
  service.rate({ catalogId: "tt0000001", title: "Another", kind: "anime", score: 8 });
  await assert.rejects(service.refresh(), /AniList is down/);
  assert.equal(service.overview().status.lastRun.status, "failed");
  assert.equal(service.overview().picks.length, picks, "the last good picks are still shown");
  service.unlinkAniList();
  const overview = service.overview();
  assert.equal(overview.settings.anilist, null);
  assert.equal(overview.stats.ratings.anilist, undefined);
  assert.equal(overview.stats.ratings.app.count, 2);
});

test("recommendations generate immediately on first eligible opening, once daily, and Update now resets the daily deadline", async () => {
  const clock = { now: new Date(2026, 9, 24, 10).getTime() };
  const { service, anilist, store } = setup({ clock });
  await service.linkAniList("me");
  const check = service.startScheduler({ everyMs: 1e9 });
  assert.ok(service.status().running, "startup begins a due refresh immediately");
  assert.equal(service.status().running.trigger, "auto");
  await service.refresh();
  const runs = () => Number(store.statement("SELECT COUNT(*) AS n FROM rec_runs").get().n);
  assert.equal(runs(), 1);
  assert.equal(service.overview().picks.length > 0, true);
  assert.equal(service.overview().settings.mode, "auto");
  assert.equal(service.overview().settings.intervalDays, 1);
  assert.throws(() => service.updateSettings({ intervalDays: 5 }), /Update every/);
  service.updateSettings({ mode: "manual", intervalDays: 7 });
  assert.equal(service.overview().settings.mode, "auto", "old manual settings cannot disable daily generation");
  assert.equal(service.overview().settings.intervalDays, 1);
  const followingMidnight = new Date(clock.now);
  followingMidnight.setHours(24, 0, 0, 0);
  clock.now = followingMidnight.getTime() - 1;
  check();
  assert.equal(runs(), 1, "no automatic duplicate before a day has passed");
  service.rate({ catalogId: "tt12343534", title: "Jujutsu Kaisen", kind: "anime", score: 9 });
  assert.equal(runs(), 1, "new ratings do not create a second set within the same day");
  check();
  assert.equal(runs(), 1);
  clock.now = followingMidnight.getTime();
  check();
  assert.equal(runs(), 2, "the next day's first check automatically regenerates");
  await service.refresh();
  clock.now += 6 * 60_000;
  await service.refresh({ trigger: "manual" });
  assert.equal(runs(), 3, "Update now always works within the daily window");
  const afterManualMidnight = new Date(clock.now);
  afterManualMidnight.setHours(24, 0, 0, 0);
  clock.now = afterManualMidnight.getTime() - 1;
  check();
  assert.equal(runs(), 3, "manual Update now postpones the next automatic generation");
  clock.now = afterManualMidnight.getTime();
  check();
  assert.equal(runs(), 4);
  await service.refresh();
  service.stopScheduler();
  assert.ok(anilist.requests > 0);
});

test("reopening the app on the same day skips refresh; a new day starts it without waiting for the polling timer", async () => {
  const { service, store, clock, anilist } = setup({ clock: { now: new Date(2026, 9, 25, 16).getTime() } });
  await service.linkAniList("me");
  service.startScheduler({ everyMs: 1e9 });
  await service.refresh();
  service.stopScheduler();
  const reopened = createRecsService({ store, anilist, now: () => clock.now, log: quiet, searchCatalog: async () => [] });
  reopened.startScheduler({ everyMs: 1e9 });
  assert.equal(store.lastRun().trigger, "auto");
  assert.equal(reopened.status().running, null, "the persisted successful run counts across restarts");
  const tomorrow = new Date(clock.now);
  tomorrow.setHours(24, 0, 0, 0);
  clock.now = tomorrow.getTime() + 60_000;
  reopened.stopScheduler();
  reopened.startScheduler({ everyMs: 1e9 });
  assert.equal(reopened.status().running?.trigger, "auto", "a due run starts on opening");
  await reopened.refresh();
  reopened.stopScheduler();
});

test("failed automatic refreshes back off across app restarts", async () => {
  const clock = { now: 120 * DAY };
  const { store, service, anilist } = setup({ clock });
  await service.linkAniList("me");
  const original = anilist.details.bind(anilist);
  anilist.details = async () => { throw new Error("temporary AniList outage"); };
  const check = service.startScheduler({ everyMs: 1e9 });
  await assert.rejects(service.refresh(), /temporary AniList outage/);
  assert.equal(store.lastRun().status, "failed");
  assert.ok(service.status().nextRunAt >= clock.now + 60 * 60_000, "retry is delayed one hour");
  const count = () => Number(store.statement("SELECT COUNT(*) AS n FROM rec_runs").get().n);
  for (let attempt = 0; attempt < 5; attempt++) check();
  assert.equal(count(), 1, "polling cannot hammer the upstream service after failure");
  service.stopScheduler();
  clock.now += 30 * 60_000;
  const reopened = createRecsService({ store, anilist, now: () => clock.now, log: quiet });
  const reopenedCheck = reopened.startScheduler({ everyMs: 1e9 });
  assert.equal(count(), 1, "reopening during backoff must not start another request");
  clock.now += 30 * 60_000;
  anilist.details = original;
  reopenedCheck();
  assert.equal(count(), 2, "retry begins after persisted cooldown");
  await reopened.refresh();
  assert.equal(store.lastRun().status, "done");
  assert.ok(reopened.overview().picks.length > 0);
  reopened.stopScheduler();
});

test("a due scheduler tick and simultaneous manual Update now share one in-flight refresh", async () => {
  const clock = { now: new Date(2026, 9, 25, 11).getTime() };
  const { store, service, anilist } = setup({ clock });
  await service.linkAniList("me");
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const details = anilist.details.bind(anilist);
  anilist.details = async (...args) => {
    await gate;
    return details(...args);
  };
  const check = service.startScheduler({ everyMs: 1e9 });
  const first = service.refresh({ trigger: "manual" });
  const second = service.refresh({ trigger: "auto" });
  check();
  check();
  const count = () => Number(store.statement("SELECT COUNT(*) AS n FROM rec_runs").get().n);
  assert.equal(count(), 1, "all callers share the already running generation");
  assert.equal(service.status().running?.trigger, "auto", "first scheduler tick wins the trigger");
  release();
  await Promise.all([first, second]);
  check();
  assert.equal(count(), 1, "completion does not immediately retrigger");
  service.stopScheduler();
});

test("linking an AniList account after startup triggers the first recommendations without a five-minute delay", async () => {
  const { store, service } = setup({ clock: { now: 160 * DAY } });
  service.startScheduler({ everyMs: 1e9 });
  assert.equal(store.lastRun(), null, "no ratings or linked list should not burn an empty run");
  assert.equal(service.status().nextRunAt, null, "without a source there is no misleading upcoming refresh date");
  await service.linkAniList("me");
  assert.equal(service.status().running?.trigger, "auto");
  await service.refresh();
  assert.equal(store.lastRun().status, "done");
  service.stopScheduler();
});

test("a season you rate in the app maps to that season on AniList; a Part 2 belongs to the season before", async () => {
  const chain = [[1, "Titan"], [2, "Titan Season 2"], [3, "Titan Season 3"], [4, "Titan Season 3 Part 2"], [5, "Titan The Final Season"]];
  const shows = Object.fromEntries(chain.map(([id, name], index) => [id, media(id, { title: title(name), relations: { edges: [
    ...(index ? [{ relationType: "PREQUEL", node: { id: chain[index - 1][0], type: "ANIME", format: "TV" } }] : []),
    ...(chain[index + 1] ? [{ relationType: "SEQUEL", node: { id: chain[index + 1][0], type: "ANIME", format: "TV" } }] : []),
    { relationType: "SEQUEL", node: { id: 90, type: "ANIME", format: "MOVIE" } },
  ] } })]));
  const store = memoryStore();
  const anilist = fakeAniList({ anime: shows, search: { Titan: [{ id: 1, format: "TV", seasonYear: 2020, title: title("Titan"), synonyms: [] }] } });
  const service = createRecsService({ store, anilist, searchCatalog: async () => [], log: quiet });
  service.rate({ catalogId: "tt2560140", title: "Titan", kind: "anime", score: 9 });
  service.rate({ catalogId: "tt2560140", season: 3, title: "Titan", kind: "anime", score: 8.5 });
  service.rate({ catalogId: "tt2560140", season: 4, title: "Titan", kind: "anime", score: 9.5 });
  service.rate({ catalogId: "tt2560140", season: 7, title: "Titan", kind: "anime", score: 7 });
  await service.refresh();
  const mapped = Object.fromEntries(store.ratings().map((rating) => [rating.season ?? "all", rating.itemId]));
  assert.deepEqual(mapped, { all: "anilist:1", 3: "anilist:3", 4: "anilist:5", 7: null });
  assert.equal(store.item("anilist:5").imdbId, "tt2560140", "the season keeps the show's page");
});

test("an update reports its step and progress; one left running when the app stopped is marked failed", async () => {
  const store = memoryStore();
  store.startRun("manual");
  createRecsService({ store, anilist: fakeAniList(), log: quiet });
  assert.equal(store.lastRun().status, "failed");
  assert.match(store.lastRun().error, /stopped/);

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const anilist = fakeAniList({ list, anime, search });
  const details = anilist.details.bind(anilist);
  anilist.details = async (...args) => { await gate; return details(...args); };
  const service = createRecsService({ store, anilist, searchCatalog: async () => [], log: quiet });
  await service.linkAniList("me");
  const running = service.refresh();
  await new Promise((resolve) => setImmediate(resolve));
  const during = service.status().running;
  assert.ok(during && during.progress > 0 && during.progress < 1, JSON.stringify(during));
  assert.match(during.phase, /fans of your favorites/);
  release();
  await running;
  assert.equal(service.status().running, null);
  assert.equal(service.status().lastRun.status, "done");
});

test("TMDB key: movies you rate lead to TMDB recommendations; Letterboxd entries are kept", async () => {
  const fakeTmdb = {
    requests: 0,
    async validate() { this.requests += 1; },
    async findImdb(id) { this.requests += 1; return id === "tt1375666" ? { movie: 27205, tv: null } : { movie: null, tv: null }; },
    async details(kind, id) {
      this.requests += 1;
      const known = { 27205: ["Inception", "tt1375666"], 157336: ["Interstellar", "tt0816692"] }[id];
      return known ? { itemId: `tmdb:movie:${id}`, source: "tmdb", sourceId: `movie:${id}`, kind: "movie", format: "movie", title: known[0], imdbId: known[1], genres: ["Science Fiction"], score: 84, scoredBy: 30000, fetchedAt: Date.now() } : null;
    },
    async recommendations() {
      this.requests += 1;
      return { items: [{ itemId: "tmdb:movie:157336", source: "tmdb", sourceId: "movie:157336", kind: "movie", format: "movie", title: "Interstellar", genres: ["Science Fiction"], score: 85, scoredBy: 35000, fetchedAt: 1 }], links: [{ to: "tmdb:movie:157336", rank: 0 }] };
    },
    async searchMovie() { this.requests += 1; return null; },
  };
  const store = memoryStore();
  const service = createRecsService({ store, anilist: fakeAniList(), tmdbFactory: (key) => { if (key !== "0123456789abcdef0123456789abcdef") throw Object.assign(new Error("That isn't a TMDB key."), { statusCode: 400 }); return fakeTmdb; },
    letterboxdFeed: async (name) => ({ username: name, entries: [{ key: "film:heat:1995", itemId: "tmdb:movie:949", title: "Heat", kind: "movie", year: 1995, score: 9, status: "WATCHED", ratedAt: 1 }] }), log: quiet });
  await assert.rejects(service.setTmdbKey("nope"), /TMDB key/);
  assert.equal((await service.setTmdbKey("0123456789abcdef0123456789abcdef")).settings.tmdb.linked, true);
  service.rate({ catalogId: "tt1375666", title: "Inception", kind: "movie", year: 2010, score: 9.5 });
  const overview = await service.refresh();
  assert.deepEqual(overview.picks.map((pick) => [pick.title, pick.imdbId, pick.type]), [["Interstellar", "tt0816692", "movie"]]);
  const linked = await service.linkLetterboxd("someone");
  assert.equal(linked.settings.letterboxd.username, "someone");
  assert.equal(linked.settings.letterboxd.scored, 1);
  assert.equal(linked.stats.ratings.letterboxd.count, 1);
  assert.equal(service.unlinkLetterboxd().stats.ratings.letterboxd, undefined);
});

test("empty public Letterboxd feeds never silently link or replace existing ratings", async () => {
  const store = memoryStore();
  const service = createRecsService({ store, letterboxdFeed: async () => ({ username: "empty", entries: [] }), log: quiet });
  await assert.rejects(service.linkLetterboxd("empty"), /No recent films found/);
  assert.equal(service.overview().settings.letterboxd, null);
  assert.equal(service.overview().stats.ratings.letterboxd, undefined);
});
