import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import AdmZip from "adm-zip";
import { appRatingKey, createRecsStore, RECS_DEFAULTS } from "../backend/recommendations/recs-store.js";
import { exportRecsData, ratingsCsv } from "../backend/recommendations/recs-export.js";
import { bestAniListMatch, normalizeAniListLinks, normalizeAniListList, normalizeAniListMedia } from "../backend/integrations/anilist.js";
import { normalizeTmdbTitle, tmdbAuth } from "../backend/integrations/tmdb.js";
import { filmKey, parseCsv, parseLetterboxdRss, readLetterboxdExport, starsToScore } from "../backend/integrations/letterboxd.js";
import { media, memoryStore } from "./recs-fixtures.js";

test("fresh and existing recommendation settings always schedule daily without losing linked accounts", () => {
  assert.deepEqual(RECS_DEFAULTS, { mode: "auto", intervalDays: 1 });
  const values = new Map();
  values.set("recs_settings", JSON.stringify({
    mode: "manual", intervalDays: 7,
    anilist: { username: "existing-user", syncedAt: 100, count: 3 },
    letterboxd: { username: "film-user" }, tmdbKey: "existing-key",
    ratingsChangedAt: 12345,
  }));
  const store = createRecsStore({
    db: new DatabaseSync(":memory:"),
    getMeta: (key) => values.get(key),
    setMeta: (key, value) => values.set(key, value),
  });
  assert.equal(store.settings().mode, "auto", "old opt-out settings are migrated on read");
  assert.equal(store.settings().intervalDays, 1);
  assert.equal(store.settings().anilist.username, "existing-user");
  assert.equal(store.settings().letterboxd.username, "film-user");
  assert.equal(store.settings().tmdbKey, "existing-key");
  assert.equal(store.settings().ratingsChangedAt, 12345);
  store.saveSettings({ mode: "manual", intervalDays: 30, tmdbKey: "updated-key" });
  assert.equal(store.settings().mode, "auto", "legacy clients cannot turn off daily generation");
  assert.equal(store.settings().intervalDays, 1);
  assert.equal(JSON.parse(values.get("recs_settings")).mode, "auto", "next write persists the migrated policy");
  assert.equal(JSON.parse(values.get("recs_settings")).intervalDays, 1);
  assert.equal(store.settings().tmdbKey, "updated-key", "migration does not discard account details");
  assert.equal(memoryStore().settings().mode, "auto", "fresh profiles start automatic");
  assert.equal(memoryStore().settings().intervalDays, 1);
});

test("store keeps one row per season with snapshot time; fan links, staleness and show ids", () => {
  let clock = 1_000_000;
  const store = memoryStore(() => clock);
  store.upsertItems([{ itemId: "anilist:1", source: "anilist", sourceId: "1", title: "Frieren", genres: ["Fantasy"], score: 91,
    scoredBy: 10000, likedShare: 0.92, popularity: 80000, fetchedAt: clock }]);
  store.upsertItems([{ itemId: "anilist:1", source: "anilist", sourceId: "1", title: "Frieren", genres: [], score: 50,
    scoredBy: 100, likedShare: 0.33, popularity: 100, fetchedAt: 5 }]);
  const item = store.item("anilist:1");
  assert.deepEqual(item.genres, ["Fantasy"], "an empty list doesn't wipe known genres");
  assert.deepEqual([item.score, item.scoredBy, item.likedShare, item.popularity], [91, 10000, 0.92, 80000],
    "an older partial snapshot must not replace more recent community ratings");
  assert.equal(item.fetchedAt, 1_000_000, "the newest snapshot time is kept");
  store.upsertItems([{ itemId: "anilist:1", source: "anilist", sourceId: "1", title: "Frieren", score: 93,
    scoredBy: 11000, fetchedAt: clock + 1 }]);
  assert.equal(store.item("anilist:1").score, 93, "newer scores still refresh");
  store.setLinks("anilist:1", [{ to: "anilist:2", votes: 1191 }, { to: "anilist:1", votes: 5 }]);
  assert.deepEqual(store.links(["anilist:1"]).get("anilist:1").map((link) => [link.to, link.votes]), [["anilist:2", 1191]]);
  clock += 10 * 86_400_000;
  assert.deepEqual(store.staleItems(["anilist:1", "anilist:9"], 7 * 86_400_000, { links: true }), ["anilist:1", "anilist:9"]);
  store.setItemIds("anilist:1", { franchiseId: "anilist:1", seasonNumber: 1, imdbId: "tt22248376" });
  assert.equal(store.item("anilist:1").imdbId, "tt22248376");
  store.setItemIds("anilist:1", { franchiseId: "anilist:0", seasonNumber: 2 });
  assert.deepEqual([store.item("anilist:1").franchiseId, store.item("anilist:1").seasonNumber, store.item("anilist:1").imdbId],
    ["anilist:0", 2, "tt22248376"], "recalculated season identity replaces stale values without clearing external ids");
  store.setItemIds("anilist:1", { seasonNumber: null });
  assert.equal(store.item("anilist:1").seasonNumber, null, "a non-season entry can clear stale season metadata");
});

test("ratings: yours in the app by title and season, imported ones replaced or merged by source", () => {
  const store = memoryStore();
  assert.equal(appRatingKey({ catalogId: "tt1", season: null }), "app:tt1:all");
  assert.equal(appRatingKey({ seriesKey: "rick and morty", season: 2 }), "app:key:rick and morty:2");
  const saved = store.setAppRating({ catalogId: "tt1", title: "Frieren", kind: "anime", score: 9.7 });
  assert.equal(saved.score, 9.7);
  store.setRatingItem(saved.key, "anilist:1");
  assert.equal(store.setAppRating({ catalogId: "tt1", title: "Frieren", kind: "anime", score: 9.8 }).itemId, "anilist:1", "same title and kind keep the match");
  assert.equal(store.setAppRating({ catalogId: "tt1", title: "Frieren", kind: "anime", year: 2020, score: 9.8 }).itemId, null,
    "a newly resolved release year requires rematching the rating");
  store.setRatingItem(saved.key, "anilist:2");
  assert.equal(store.setAppRating({ catalogId: "tt1", title: "Frieren", kind: "anime", year: 2005, score: 9.8 }).itemId, null,
    "changing between same-name releases invalidates a stale title mapping");
  assert.equal(store.setAppRating({ catalogId: "tt1", title: "Frieren", kind: "series", score: 9.8 }).itemId, null, "another kind is matched again");
  assert.equal(store.setAppRating({ catalogId: "tt1", title: "Frieren", score: null }), null, "no score and no status removes it");
  store.replaceSourceRatings("anilist", [{ key: "1", itemId: "anilist:1", title: "A", score: 8 }, { key: "2", itemId: "anilist:2", title: "B", score: null, status: "DROPPED" }]);
  store.replaceSourceRatings("anilist", [{ key: "1", itemId: "anilist:1", title: "A", score: 8.5 }]);
  assert.deepEqual(store.ratings().map((rating) => [rating.source, rating.score]), [["anilist", 8.5]]);
  store.mergeSourceRatings("letterboxd", [{ key: "film:x:2020", title: "X", score: 9, ratedAt: 10 }]);
  store.mergeSourceRatings("letterboxd", [{ key: "film:x:2020", title: "X", score: null, ratedAt: 20, itemId: "tmdb:movie:5" }]);
  store.mergeSourceRatings("letterboxd", [{ key: "film:x:2020", title: "X", score: 6, ratedAt: 5 }]);
  const film = store.ratings().find((rating) => rating.source === "letterboxd");
  assert.equal(film.score, 9, "a later status-only entry or older scored entry keeps the most recent score");
  assert.equal(film.itemId, "tmdb:movie:5");
  assert.equal(film.ratedAt, 20, "older feed snapshots cannot roll back the recorded date");
  store.mergeSourceRatings("letterboxd", [{ key: "film:x:2020", title: "X", score: 9.5, ratedAt: 30 }]);
  assert.equal(store.ratings().find((rating) => rating.source === "letterboxd").score, 9.5, "a newer scored entry updates the rating");
  assert.ok(store.settings().ratingsChangedAt > 0);
});

test("refresh runs keep their picks; hidden titles drop out; outcomes compare later ratings with your average", () => {
  let clock = 1_000;
  const store = memoryStore(() => clock);
  store.upsertItems([{ itemId: "anilist:5", source: "anilist", sourceId: "5", title: "Pick" }]);
  const runId = store.startRun("manual");
  store.savePicks(runId, [{ rank: 1, itemId: "anilist:5", match: 0.9, raw: 2.2, features: {}, reasons: [{ kind: "shared", names: ["Drama"] }], summary: "Drama, like your favorites" }]);
  store.finishRun(runId, { status: "done", picks: 1 });
  assert.equal(store.currentPicks().picks[0].item.title, "Pick");
  clock = 5_000;
  store.replaceSourceRatings("anilist", [{ key: "5", itemId: "anilist:5", title: "Pick", score: 9, ratedAt: 4_000 }]);
  assert.deepEqual(store.outcomes(8), [{ raw: 2.2, liked: true }]);
  store.hide("anilist:5");
  assert.equal(store.currentPicks().picks.length, 0);
  for (let index = 0; index < 15; index += 1) store.finishRun(store.startRun("auto"), { status: "done" });
  assert.equal(Number(store.statement("SELECT COUNT(*) AS n FROM rec_runs").get().n), 12, "older refreshes are pruned");
});

test("failed automatic refresh history never prunes the latest successful recommendations", () => {
  let clock = 1_000;
  const store = memoryStore(() => clock);
  store.upsertItems([
    { itemId: "anilist:1", source: "anilist", sourceId: "1", title: "Last good pick" },
    { itemId: "anilist:2", source: "anilist", sourceId: "2", title: "New good pick" },
  ]);
  const complete = (status, pick = null) => {
    clock += 60 * 60_000;
    const id = store.startRun("auto");
    if (pick) store.savePicks(id, [{ rank: 1, itemId: pick, match: 0.8, raw: 1.5, reasons: [], features: {} }]);
    store.finishRun(id, { status, picks: pick ? 1 : 0, error: status === "failed" ? "Provider unavailable" : null });
    return id;
  };
  const oldSuccess = complete("done", "anilist:1");
  for (let i = 0; i < 30; i += 1) complete("failed");
  assert.equal(store.lastGoodRun().run_id, oldSuccess, "the latest successful run must survive any failure streak");
  assert.deepEqual(store.currentPicks().picks.map((pick) => pick.item.title), ["Last good pick"]);
  assert.equal(store.lastRun().status, "failed", "the newest failed run still controls retry backoff");
  assert.equal(store.lastRun().run_id, oldSuccess + 30);
  assert.equal(Number(store.statement("SELECT COUNT(*) AS n FROM rec_runs").get().n), 12, "history remains bounded");
  assert.equal(Number(store.statement("SELECT COUNT(*) AS n FROM rec_picks WHERE run_id = ?").get(oldSuccess).n), 1,
    "retained success keeps the picks used by the UI");
  const reopened = createRecsStore({
    db: store.db, getMeta: () => null, setMeta: () => {}, now: () => clock,
  });
  assert.equal(reopened.lastGoodRun().run_id, oldSuccess, "the protected snapshot is readable by a reopened store");
  assert.deepEqual(reopened.currentPicks().picks.map((pick) => pick.item.title), ["Last good pick"]);
  assert.equal(reopened.lastRun().status, "failed", "restart still sees the latest failure for retry scheduling");

  const nextSuccess = complete("done", "anilist:2");
  assert.equal(store.lastGoodRun().run_id, nextSuccess, "fresh successful results supersede the old snapshot");
  assert.deepEqual(store.currentPicks().picks.map((pick) => pick.item.title), ["New good pick"]);
  assert.equal(store.statement("SELECT COUNT(*) AS n FROM rec_runs WHERE run_id = ?").get(oldSuccess).n, 0,
    "the prior protected success is now eligible for pruning");
  assert.equal(store.statement("SELECT COUNT(*) AS n FROM rec_picks WHERE run_id = ?").get(oldSuccess).n, 0,
    "old pick rows are removed alongside their obsolete parent run");
  for (let i = 0; i < 20; i += 1) complete("failed");
  assert.equal(store.lastGoodRun().run_id, nextSuccess);
  assert.deepEqual(store.currentPicks().picks.map((pick) => pick.item.title), ["New good pick"]);
  assert.equal(store.statement("SELECT COUNT(*) AS n FROM rec_runs").get().n, 12);
  assert.equal(store.statement("SELECT COUNT(*) AS n FROM rec_picks WHERE run_id NOT IN (SELECT run_id FROM rec_runs)").get().n, 0,
    "pruning never leaves orphaned pick rows");
});

test("the export is organized by show and season, and the CSV escapes titles", () => {
  const store = memoryStore();
  store.upsertItems([
    { itemId: "anilist:1", source: "anilist", sourceId: "1", title: "Show", franchiseId: "anilist:1", seasonNumber: 1, score: 85, scoredBy: 1000 },
    { itemId: "anilist:2", source: "anilist", sourceId: "2", title: "Show Season 2", franchiseId: "anilist:1", seasonNumber: 2, fetchedAt: 1 },
  ]);
  store.setLinks("anilist:1", [{ to: "anilist:2", votes: 10 }]);
  store.replaceSourceRatings("anilist", [{ key: "1", itemId: "anilist:1", title: 'Show, "the" one', score: 9.25 }]);
  store.saveSettings({ tmdbKey: "secret" });
  const data = exportRecsData(store);
  assert.equal(data.shows.length, 1);
  assert.deepEqual(data.shows[0].seasons.map((season) => season.season), [1, 2]);
  assert.equal(data.shows[0].seasons[0].yourRatings[0].score, 9.25);
  assert.equal(data.shows[0].seasons[0].fansAlsoRecommend[0].votes, 10);
  assert.equal(data.shows[0].seasons[1].snapshotAt, null, "only the basics read: no snapshot date (not 1970)");
  assert.ok(!JSON.stringify(data).includes("secret"), "the TMDB key is never exported");
  assert.match(ratingsCsv(store), /^title,season,score/);
  assert.match(ratingsCsv(store), /"Show, ""the"" one",,9\.25,/);
});

test("AniList entries: spoiler tags dropped, share who liked it, links with positive votes, list scores", () => {
  const item = normalizeAniListMedia(media(7, {
    tags: [{ name: "Travel", rank: 96 }, { name: "Twist", rank: 90, isMediaSpoiler: true }],
    relations: { edges: [{ relationType: "PREQUEL", node: { id: 6, type: "ANIME", format: "TV" } }, { relationType: "ADAPTATION", node: { id: 3, type: "MANGA" } }] },
  }), 99);
  assert.deepEqual(item.tags, [{ name: "Travel", weight: 96 }]);
  assert.equal(item.likedShare, 0.6);
  assert.equal(item.scoredBy, 100);
  assert.equal(item.description, "A story about things.");
  assert.deepEqual(item.relations, [{ type: "PREQUEL", id: "anilist:6", format: "TV" }]);
  assert.deepEqual(normalizeAniListLinks({ recommendations: { nodes: [{ rating: 12, mediaRecommendation: { id: 8 } }, { rating: -3, mediaRecommendation: { id: 9 } }] } }), [{ to: "anilist:8", votes: 12 }]);
  const list = normalizeAniListList({ MediaListCollection: { user: { id: 1, name: "me" }, lists: [
    { entries: [{ status: "COMPLETED", score: 9.7, progress: 28, updatedAt: 1700000000, media: media(1) }, { status: "PLANNING", score: 0, media: media(2) }] },
    { entries: [{ status: "COMPLETED", score: 9.7, media: media(1) }, { status: "COMPLETED", score: 8, media: media(3, { isAdult: true }) }] },
  ] } });
  assert.deepEqual(list.entries.map((entry) => [entry.itemId, entry.score, entry.status]), [["anilist:1", 9.7, "COMPLETED"], ["anilist:2", null, "PLANNING"]]);
  const match = bestAniListMatch([
    { id: 10, format: "MOVIE", seasonYear: 2021, title: { english: "Jujutsu Kaisen 0" } },
    { id: 11, format: "TV", seasonYear: 2020, popularity: 900000, title: { english: "JUJUTSU KAISEN", romaji: "Jujutsu Kaisen" } },
  ], { title: "Jujutsu Kaisen", year: 2020 });
  assert.equal(match.id, 11);
  assert.equal(bestAniListMatch([{ id: 1, title: { english: "Something else" } }], { title: "Frieren" }), null);
});

test("TMDB: key formats and titles", () => {
  assert.deepEqual(tmdbAuth("0123456789abcdef0123456789abcdef"), { query: "0123456789abcdef0123456789abcdef" });
  assert.deepEqual(tmdbAuth("eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJ4In0.abc_DEF-123"), { header: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJ4In0.abc_DEF-123" });
  assert.equal(tmdbAuth("nope"), null);
  const movie = normalizeTmdbTitle("movie", { id: 27205, title: "Inception", release_date: "2010-07-15", vote_average: 8.4, vote_count: 38000, genres: [{ id: 1, name: "Science Fiction" }], keywords: { keywords: [{ name: "dream" }] }, imdb_id: "tt1375666", belongs_to_collection: null, poster_path: "/p.jpg" });
  assert.equal(movie.itemId, "tmdb:movie:27205");
  assert.equal(movie.score, 84);
  assert.equal(movie.imdbId, "tt1375666");
  assert.deepEqual(movie.tags, [{ name: "dream", weight: 60 }]);
  const listed = normalizeTmdbTitle("tv", { id: 1, name: "Show", genre_ids: [18], first_air_date: "2019-01-01" }, { genreNames: new Map([[18, "Drama"]]) });
  assert.deepEqual(listed.genres, ["Drama"]);
  assert.equal(listed.fetchedAt, 1, "a list result is marked for a details read");
});

test("Letterboxd: profile feed, CSV files and the export zip; stars become 1–10", () => {
  assert.equal(starsToScore("4.5"), 9);
  assert.equal(starsToScore(""), null);
  const xml = `<rss><channel><item><title>Film, 2020 - ★★★★½</title><link>https://letterboxd.com/me/film/film/</link>
    <letterboxd:watchedDate>2026-09-30</letterboxd:watchedDate><letterboxd:filmTitle>Film &amp; Co</letterboxd:filmTitle>
    <letterboxd:filmYear>2020</letterboxd:filmYear><letterboxd:memberRating>4.5</letterboxd:memberRating><tmdb:movieId>123</tmdb:movieId></item>
    <item><title>A list</title><link>https://letterboxd.com/me/list/x/</link></item></channel></rss>`;
  const feed = parseLetterboxdRss(xml);
  assert.deepEqual(feed.map((entry) => [entry.title, entry.score, entry.itemId, entry.key]), [["Film & Co", 9, "tmdb:movie:123", filmKey("Film & Co", 2020)]]);
  assert.deepEqual(parseCsv('Name,Year,Rating\r\n"Hello, ""World""",2001,3.5\r\n'), [{ name: 'Hello, "World"', year: "2001", rating: "3.5" }]);
  const zip = new AdmZip();
  zip.addFile("watched.csv", Buffer.from("Date,Name,Year,Letterboxd URI\n2024-01-01,Film & Co,2020,https://boxd.it/a\n2024-01-02,Other,2019,https://boxd.it/b\n"));
  zip.addFile("ratings.csv", Buffer.from("Date,Name,Year,Letterboxd URI,Rating\n2024-02-01,Film & Co,2020,https://boxd.it/a,4\n"));
  const entries = readLetterboxdExport(zip.toBuffer());
  const byTitle = Object.fromEntries(entries.map((entry) => [entry.title, entry.score]));
  assert.deepEqual(byTitle, { "Film & Co": 8, Other: null });
  assert.equal(entries.find((entry) => entry.title === "Film & Co").key, filmKey("Film & Co", 2020), "the export lines up with the feed");
});
