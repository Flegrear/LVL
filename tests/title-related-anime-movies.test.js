import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { ANILIST_PUBLIC_RELATED_MOVIES_QUERY, fetchPublicAnimeRelatedMovies,
  relatedPublicAnimeMovies, verifiedPublicAnimeFranchiseRoot } from "../frontend/catalog/title-public-ratings.js";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../frontend/styles/styles.css", import.meta.url), "utf8");

const film = (id, name, format = "MOVIE") => ({
  id, type: "ANIME", format, isAdult: false, seasonYear: 2021,
  title: { english: name, romaji: name + " romaji" },
  coverImage: { large: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/sample.jpg" },
  averageScore: 82,
});
const edge = (relationType, node) => ({ relationType, node });

test("verified Jujutsu Kaisen AniList PREQUEL relationship surfaces JJK 0 once as a film, not a season", () => {
  const media = [
    { id: 113415, relations: { edges: [
      edge("PREQUEL", film(131573, "Jujutsu Kaisen 0")),
      edge("SEQUEL", film(9999, "Season Two", "TV")),
      edge("OTHER", film(456, "Unrelated other title")),
    ] } },
    { id: 777, relations: { edges: [edge("SIDE_STORY", film(131573, "Jujutsu Kaisen 0"))] } },
    { id: 555, relations: { edges: [edge("PREQUEL", film(888, "Another show"))] } },
  ];
  const matches = relatedPublicAnimeMovies(media, [113415, 777]);
  assert.deepEqual(matches.map((movie) => movie.id), [131573]);
  assert.equal(matches[0].format, "MOVIE");
  assert.equal(matches[0].title, "Jujutsu Kaisen 0");
  assert.equal(matches[0].year, 2021);
  assert.equal(matches[0].cover.startsWith("https://"), true);
  assert.deepEqual(relatedPublicAnimeMovies(media, [111111]), [], "unverified source IDs must contribute nothing");
});

test("Dragon Ball Z localized catalog year can still reveal all verified films using exact 291-episode original anime identity", () => {
  const root = { id: 813, type: "ANIME", format: "TV", isAdult: false, episodes: 291,
    seasonYear: 1989, title: { english: "Dragon Ball Z", romaji: "Dragon Ball Z" }, synonyms: [] };
  assert.equal(verifiedPublicAnimeFranchiseRoot([root], { title: "Dragon Ball Z", totalEpisodes: 291 }), 813);
  assert.equal(verifiedPublicAnimeFranchiseRoot([root], { title: "Dragon Ball Z", totalEpisodes: 24 }), null);
  assert.equal(verifiedPublicAnimeFranchiseRoot([root], { title: "Dragon Ball Z Kai", totalEpisodes: 291 }), null);
  assert.equal(verifiedPublicAnimeFranchiseRoot([root, { ...root, id: 9000 }], { title: "Dragon Ball Z", totalEpisodes: 291 }), null,
    "ambiguous exact TV roots are not linked");
  assert.equal(verifiedPublicAnimeFranchiseRoot([{ ...root, isAdult: true }], { title: "Dragon Ball Z", totalEpisodes: 291 }), null);
  const nodes = Array.from({ length: 15 }, (_, i) => film(894 + i, `Dragon Ball Z: Movie ${i + 1}`));
  const movies = relatedPublicAnimeMovies([{ id: 813, relations: { edges: nodes.map((node) => edge("SIDE_STORY", node)) } }], [813]);
  assert.equal(movies.length, 15, "the franchise Movies section is not truncated to 12");
});

test("series-title fallback fetches films for exact AniList original series despite localized catalog year", async () => {
  const begin = app.indexOf("const publicTitleRatingCache = new Map();");
  const end = app.indexOf("function titleCommunityRating(", begin);
  let queried = 0;
  let relatedCalls = 0;
  const context = vm.createContext({
    fetchPublicAniListTitle: async (title) => {
      queried += 1;
      assert.equal(title, "Dragon Ball Z");
      return [{ id: 813, type: "ANIME", format: "TV", episodes: 291, isAdult: false,
        title: { english: "Dragon Ball Z" }, synonyms: [] }];
    },
    fetchPublicAnimeRelatedMovies: async (ids) => {
      relatedCalls += 1;
      assert.deepEqual([...ids], [813]);
      return [{ id: 894, title: "Dragon Ball Z: Dead Zone", format: "MOVIE", year: 1989 }];
    },
    verifiedPublicAnimeFranchiseRoot,
    publicCatalogSeasonCounts: () => [{ season: 1, count: 291 }],
    eligibleForPublicAnimeRating: () => true,
    refreshTitlePage() {},
    Date, Map, Set,
  });
  vm.runInContext(app.slice(begin, end), context);
  const subject = { type: "series", series: { mediaKind: "anime" } };
  const meta = { name: "Dragon Ball Z", releaseInfo: "1996–2003", genres: ["Animation"], country: "Japan", seasons: [{ season: 1, episodes: [] }] };
  const record = context.titleRelatedMovies(null, subject, meta);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(record.items[0].title, "Dragon Ball Z: Dead Zone");
  assert.equal(record.pending, false);
  assert.equal(context.titleRelatedMovies(null, subject, meta), record);
  assert.equal(queried, 1, "public exact match is cached");
  assert.equal(relatedCalls, 1, "no repeated AniList graph fetch on render");
});

test("movie association refuses adult films, unrelated formats, untrusted edges and empty names", () => {
  const media = [{ id: 42, relations: { edges: [
    edge("PREQUEL", { ...film(1, "Hidden film"), isAdult: true }),
    edge("SEQUEL", { ...film(2, "Live action"), type: "MANGA" }),
    edge("SIDE_STORY", film(3, "Not a film", "OVA")),
    edge("CHARACTER", film(4, "Same character, separate film")),
    edge("ALTERNATIVE", film(5, "Alternative universe")),
    edge("PREQUEL", film(6, "  ")),
    edge("SEQUEL", { ...film(7, "Bad cover"), coverImage: { large: "javascript:alert(1)" } }),
  ] } }];
  const movies = relatedPublicAnimeMovies(media, [42]);
  assert.deepEqual(movies.map((movie) => movie.id), [7]);
  assert.equal(movies[0].cover, "");
});

test("public movie relationships fetch is anonymous, bounded, and never mutates AniList accounts", async () => {
  assert.match(ANILIST_PUBLIC_RELATED_MOVIES_QUERY, /media\(id_in: \$ids, type: ANIME\)/);
  assert.match(ANILIST_PUBLIC_RELATED_MOVIES_QUERY, /relations \{ edges \{ relationType node/);
  assert.doesNotMatch(ANILIST_PUBLIC_RELATED_MOVIES_QUERY, /MediaListEntry|Viewer|mutation|accessToken/);
  const calls = [];
  const results = await fetchPublicAnimeRelatedMovies([113415, 113415, 777, -1], {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, json: async () => ({ data: { Page: { media: [{
        id: 113415, relations: { edges: [edge("PREQUEL", film(131573, "Jujutsu Kaisen 0"))] },
      }] } } }) };
    },
  });
  assert.deepEqual(results.map((item) => item.id), [131573]);
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].options.body).variables.ids, [113415, 777]);
  assert.equal(calls[0].options.credentials, "omit");
  assert.equal(calls[0].options.referrerPolicy, "no-referrer");
  assert.equal(Object.keys(calls[0].options.headers).some((name) => /authorization/i.test(name)), false);
  assert.equal((await fetchPublicAnimeRelatedMovies([], { fetchImpl: () => { throw Error("should not fetch"); } })).length, 0);
});

test("series title renders a lightweight Movies section after metadata verifies the AniList season", async () => {
  const begin = app.indexOf("const publicTitleRatingCache = new Map();");
  const end = app.indexOf("function titleCommunityRating(", begin);
  assert.ok(begin > 0 && end > begin);
  let requests = 0;
  let refreshed = 0;
  const context = vm.createContext({
    fetchPublicAnimeRelatedMovies: async (ids) => {
      requests += 1;
      assert.deepEqual([...ids], [113415]);
      return [{ id: 131573, title: "Jujutsu Kaisen 0", year: 2021,
        cover: "https://s4.anilist.co/cover.jpg", format: "MOVIE" }];
    },
    escapeHtml: (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;"),
    icon: () => "[film icon]",
    refreshTitlePage: () => { refreshed += 1; },
    Date, Map, Set,
  });
  vm.runInContext(app.slice(begin, end), context);
  assert.equal(context.titleRelatedMovies(null), null, "no verified anime identity, no network request");
  const confirmed = { seasons: [{ parts: [{ id: 113415 }, { id: 113415 }] }] };
  const record = context.titleRelatedMovies(confirmed);
  assert.equal(record.pending, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(record.pending, false);
  assert.equal(requests, 1, "duplicate AniList cour ID is fetched only once");
  assert.equal(refreshed, 1);
  assert.equal(context.titleRelatedMovies(confirmed), record, "navigation re-render uses cached results");
  assert.equal(requests, 1);
  const output = context.titleRelatedMoviesMarkup(record);
  assert.match(output, /<h2[^>]*>Movies<\/h2>/);
  assert.match(output, /data-title-action="related-movie" data-anime-movie-id="131573"/);
  assert.match(output, /Jujutsu Kaisen 0/);
  assert.match(output, /2021 - Film/);
  assert.equal(context.titleRelatedMoviesMarkup({ items: [], pending: false }), "",
    "unrelated series receive no empty nested panel");
});

test("movie click reuses verified catalog resolver, safeguards navigation races and never guesses a movie ID", async () => {
  assert.match(html, /id="title-main"[\s\S]*id="title-related-movies"[\s\S]*id="title-about"/);
  assert.match(css, /\.title-related-movies\[hidden\]\s*\{ display:none;/);
  assert.match(app, /const movies = subject\.type === "series" \? titleRelatedMovies\(communityRating, subject, meta\) : null;/);
  assert.match(app, /else if \(action === "related-movie"\) void openRelatedAnimeMovie\(button\.dataset\.animeMovieId\);/);
  const start = app.indexOf("async function openRelatedAnimeMovie(");
  const stop = app.indexOf("\nfunction handleTitleAction(", start);
  assert.ok(start > 0 && stop > start);
  const opened = [];
  let routeId = "tt1234567";
  let allowResolution;
  const context = vm.createContext({
    Number,
    titleRelatedMovieCache: new Map([["113415", { items: [{ id: 131573, title: "Jujutsu Kaisen 0", format: "MOVIE" }] }]]),
    titleRoute: () => ({ id: routeId, key: "", type: "series" }),
    viewActive: (name) => name === "title",
    setToolStatus: () => {},
    TITLE_STATUS: "#title-status",
    resolveAnimeBrowserCatalog: async () => new Promise((resolve) => { allowResolution = resolve; }),
    openTitlePage: (meta) => opened.push(meta),
  });
  vm.runInContext("let relatedMovieOpenToken = 0; " + app.slice(start, stop), context);
  const pending = context.openRelatedAnimeMovie(131573);
  routeId = "tt9988776";
  allowResolution({ id: "tt24681357", type: "movie", name: "Jujutsu Kaisen 0" });
  await pending;
  assert.equal(opened.length, 0, "late movie lookup must never redirect another title");
  routeId = "tt1234567";
  const correct = context.openRelatedAnimeMovie(131573);
  allowResolution({ id: "tt24681357", type: "movie", name: "Jujutsu Kaisen 0" });
  await correct;
  assert.equal(opened.length, 1);
  assert.equal(opened[0].type, "movie");
  assert.equal(opened[0].id, "tt24681357");
  await context.openRelatedAnimeMovie(31337);
  assert.equal(opened.length, 1, "unverified ID cannot open anything");
});
