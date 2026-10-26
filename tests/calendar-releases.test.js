import test from "node:test";
import assert from "node:assert/strict";
import {
  createReleaseCalendarService, normalizeAniListAiring, normalizeTvmazeAiring,
  normalizeTmdbPremiere, releaseRange,
} from "../backend/catalog/calendar-releases.js";

test("Season windows are valid and calendar sources reject fabricated dates", () => {
  assert.ok(releaseRange("2026-10-01", "2026-12-31"));
  assert.equal(releaseRange("2026-02-30", "2026-04-01"), null);
  assert.equal(releaseRange("2026-10-19", "2027-04-19"), null);
  assert.equal(releaseRange("2026-10-30", "2026-10-01"), null);
  assert.equal(normalizeTmdbPremiere({ id: 1, release_date: "2026-02-30" }), null);
  assert.equal(normalizeAniListAiring({ id: 1, airingAt: 0, media: { id: 2 } }), null);
});

test("Air dates preserve UTC instants so the browser can place shows in its timezone", () => {
  const anime = normalizeAniListAiring({
    id: 201, episode: 6, airingAt: 1792467000,
    media: { id: 77, title: { english: "Example Anime" }, format: "TV" },
  });
  assert.equal(anime.type, "anime");
  assert.equal(anime.timestamp, 1792467000 * 1000);
  const tv = normalizeTvmazeAiring({
    id: 93, name: "Night release", season: 2, number: 1,
    airstamp: "2026-10-20T01:00:00Z",
    show: { id: 40, name: "Example Show", externals: { imdb: "tt1234567" } },
  });
  assert.equal(tv.catalogId, "tt1234567");
  assert.equal(tv.timestamp, Date.parse("2026-10-20T01:00:00Z"));
  assert.equal(tv.code, "S02E01");
  assert.equal(normalizeTvmazeAiring({ id: 11, airdate: "not-a-date", show: { name: "X" } }), null);
});

test("One range combines AniList, TVmaze and TMDb; reports missing TMDb key", async () => {
  const calls = [];
  const fetchImpl = async (request, options) => {
    const url = String(request);
    calls.push(url);
    let data;
    if (url.includes("anilist")) {
      const variables = JSON.parse(options.body).variables;
      assert.equal(variables.page, 1);
      data = { data: { Page: { pageInfo: { hasNextPage: false }, airingSchedules: [{
        id: 7, episode: 3, airingAt: Date.parse("2026-10-20T02:00:00Z") / 1000,
        media: { id: 12, format: "TV", title: { english: "New Anime" } },
      }] } } };
    } else if (url.includes("tvmaze")) {
      data = [{ id: 8, name: "Pilot", season: 1, number: 1,
        airstamp: "2026-10-20T03:00:00Z", show: { id: 13, name: "New Series" } }];
    } else if (url.includes("themoviedb")) {
      data = { total_pages: 1, results: [{
        id: 9, title: "New Movie", release_date: "2026-10-21", poster_path: "/poster.jpg",
      }] };
    } else throw new Error(`Unexpected request: ${url}`);
    return { ok: true, json: async () => data };
  };
  const service = createReleaseCalendarService({ fetchImpl, getTmdbKey: () => "",
    anilistEndpoint: "https://example.test/anilist", tvmazeEndpoint: "https://example.test/tvmaze",
    tmdbEndpoint: "https://api.themoviedb.org/3" });
  const first = await service.releases("2026-10-19", "2026-10-25");
  assert.deepEqual(first.events.map((event) => event.type), ["anime", "series"]);
  assert.equal(first.coverage.TMDb.status, "needs_key");
  assert.equal(calls.length, 2);
  await service.releases("2026-10-19", "2026-10-25");
  assert.equal(calls.length, 2, "Repeat renders use the cache");

  const withKey = createReleaseCalendarService({ fetchImpl, getTmdbKey: () => "a".repeat(32),
    anilistEndpoint: "https://example.test/anilist", tvmazeEndpoint: "https://example.test/tvmaze" });
  const second = await withKey.releases("2026-10-19", "2026-10-25");
  assert.deepEqual(new Set(second.events.map((event) => event.type)), new Set(["anime", "series", "movie"]));
  assert.equal(second.coverage.TMDb.status, "ok");
  assert.doesNotMatch(JSON.stringify(second), /aaaaaaaaaaaaaaaa/);
});

test("All Anime fetches only the unrestricted AniList schedule, with its own cache", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(String(url));
    if (String(url).includes("tvmaze")) return { ok: true, json: async () => [] };
    assert.match(String(url), /anilist/);
    const { variables } = JSON.parse(options.body);
    assert.equal(variables.ids, undefined, "All Anime must omit the linked Library media-ID filter");
    assert.doesNotMatch(JSON.parse(options.body).query, /mediaId_in/, "An explicit null filter fails on the live AniList API");
    return { ok: true, json: async () => ({ data: { Page: {
      pageInfo: { hasNextPage: false }, airingSchedules: [
        { id: 701, episode: 3, airingAt: Date.parse("2026-10-21T16:00:00Z") / 1000,
          media: { id: 101, format: "TV", title: { english: "Saved Anime" } } },
        { id: 702, episode: 7, airingAt: Date.parse("2026-10-22T16:00:00Z") / 1000,
          media: { id: 555, format: "TV", title: { english: "Another Seasonal Anime" } } },
        { id: 703, episode: 1, airingAt: Date.parse("2026-10-23T16:00:00Z") / 1000,
          media: { id: 556, format: "MOVIE", title: { english: "An Anime Film" } } },
      ],
    } } }) };
  };
  const service = createReleaseCalendarService({ fetchImpl, getTmdbKey: () => "",
    anilistEndpoint: "https://example.test/anilist", tvmazeEndpoint: "https://example.test/tvmaze" });
  const args = ["2026-10-19", "2026-10-25"];
  const all = await service.releases(...args, { scope: "anime-all", anilistIds: [101] });
  assert.deepEqual(all.events.map((row) => row.title), ["Saved Anime", "Another Seasonal Anime"]);
  assert.deepEqual(Object.keys(all.coverage), ["AniList"]);
  assert.equal(all.coverage.AniList.status, "ok");
  assert.deepEqual(calls, ["https://example.test/anilist"], "All Anime does not call TVmaze or TMDb");
  assert.equal(await service.releases(...args, { scope: "anime-all" }), all,
    "All Anime uses the same global cache regardless of Library IDs");
  assert.equal(calls.length, 1);
  const list = await service.releases(...args, { scope: "list", anilistIds: [] });
  assert.notEqual(list, all, "The restricted and unrestricted scopes must not share cached responses");
  assert.deepEqual(list.events.map((row) => row.type), ["anime", "anime", "movie"],
    "My List retains the previous provider behavior while All Anime excludes films");
  assert.ok(calls.some((call) => call.includes("tvmaze")), "My List retains its existing TVmaze feed");
  await assert.rejects(service.releases(...args, { scope: "all" }), { statusCode: 400 });
});

test("Busy monthly schedules fetch provider pages with bounded concurrency", async () => {
  const pages = { anime: [], movies: [] };
  const active = { anime: 0, movies: 0 };
  const maxActive = { anime: 0, movies: 0 };
  const fetchImpl = async (request, options) => {
    const url = String(request);
    if (url.includes("tvmaze")) return { ok: true, json: async () => [] };
    const anime = url.includes("anilist");
    const provider = anime ? "anime" : "movies";
    const page = anime ? JSON.parse(options.body).variables.page : Number(new URL(url).searchParams.get("page"));
    pages[provider].push(page);
    active[provider]++;
    maxActive[provider] = Math.max(maxActive[provider], active[provider]);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active[provider]--;
    return { ok: true, json: async () => anime
      ? { data: { Page: { pageInfo: { hasNextPage: page < 7, lastPage: 7 }, airingSchedules: [{
        id: page, airingAt: Date.parse("2026-10-20T12:00:00Z") / 1000, episode: page,
        media: { id: 42, title: { english: "Seasonal Show" } },
      }] } } }
      : { total_pages: 7, results: [{ id: page, title: `Movie ${page}`, release_date: "2026-10-20" }] } };
  };
  const service = createReleaseCalendarService({ fetchImpl, getTmdbKey: () => "a".repeat(32),
    anilistEndpoint: "https://example.test/anilist", tvmazeEndpoint: "https://example.test/tvmaze",
    tmdbEndpoint: "https://api.themoviedb.org/3" });
  const result = await service.releases("2026-10-01", "2026-10-31");
  assert.deepEqual(pages.anime.sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(pages.movies.sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7]);
  assert.ok(maxActive.anime > 1 && maxActive.anime <= 3);
  assert.ok(maxActive.movies > 1 && maxActive.movies <= 3);
  assert.equal(result.events.length, 14);
  assert.equal(result.coverage.AniList.status, "ok");
  assert.equal(result.coverage.TMDb.status, "ok");
});

test("Global AniList stops when pages end even if page one reports a bogus lastPage", async () => {
  const pages = [];
  const fetchImpl = async (url, options) => {
    const page = JSON.parse(options.body).variables.page;
    pages.push(page);
    return { ok: true, json: async () => ({ data: { Page: {
      pageInfo: { hasNextPage: page < 7, lastPage: page === 1 ? 100 : 7 },
      airingSchedules: page <= 7 ? [{ id: 8000 + page, episode: page,
        airingAt: Date.parse("2026-10-23T16:00:00Z") / 1000,
        media: { id: 999, title: { english: "Global Series" } } }] : [],
    } } }) };
  };
  const service = createReleaseCalendarService({ fetchImpl, getTmdbKey: () => "",
    anilistEndpoint: "https://example.test/anilist" });
  const result = await service.releases("2026-10-19", "2026-10-25", { scope: "anime-all" });
  assert.equal(result.events.length, 7);
  assert.equal(result.coverage.AniList.status, "ok");
  assert.deepEqual(pages.sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7],
    "Stop at the first batch reporting no next page instead of blindly loading 20 pages");
});

test("Linked AniList IDs supply next episodes when the broad airing feed misses them", async () => {
  const nextQueries = [];
  const fetchImpl = async (url, options = {}) => {
    if (String(url).includes("tvmaze")) return { ok: true, json: async () => [] };
    const body = JSON.parse(options.body);
    if (body.query.includes("nextAiringEpisode")) {
      nextQueries.push(body.variables.ids);
      return { ok: true, json: async () => ({ data: { Page: { media: body.variables.ids.map((id) => ({
        id, format: "TV", title: { english: "Saved Anime" }, coverImage: { large: "https://example.test/cover.png" },
        nextAiringEpisode: { id: 8000 + id, episode: 4, airingAt: Date.parse("2026-10-22T18:00:00Z") / 1000 },
      })) } } }) };
    }
    // A broad feed can report success while omitting the user's own show.
    return { ok: true, json: async () => ({ data: { Page: { pageInfo: { hasNextPage: false }, airingSchedules: [] } } }) };
  };
  const service = createReleaseCalendarService({
    fetchImpl, getTmdbKey: () => "", anilistEndpoint: "https://example.test/anilist",
    tvmazeEndpoint: "https://example.test/tvmaze",
  });
  const saved = Array.from({ length: 51 }, (_, i) => i + 100);
  const result = await service.releases("2026-10-19", "2026-10-25", { anilistIds: saved });
  assert.equal(result.events.length, 51);
  assert.ok(result.events.every((entry) => entry.source === "AniList" && entry.code === "EP 4"));
  assert.deepEqual(nextQueries.map((batch) => batch.length), [50, 1]);
  const cached = await service.releases("2026-10-19", "2026-10-25", { anilistIds: [...saved].reverse() });
  assert.equal(cached, result, "The same account ID set shares the schedule cache regardless of order");
  const unlinked = await service.releases("2026-10-19", "2026-10-25");
  assert.equal(unlinked.events.length, 0, "A different linked-list identity does not reuse a prior user's events");
});

test("Saving One Punch Man season one includes later seasons through explicit AniList sequel IDs", async () => {
  const when = Date.parse("2026-10-23T18:00:00Z") / 1000;
  const media = {
    100: { id: 100, format: "TV", title: { english: "One Punch Man" },
      relations: { edges: [
        { relationType: "SEQUEL", node: { id: 200, type: "ANIME", format: "TV" } },
        { relationType: "SIDE_STORY", node: { id: 900, type: "ANIME", format: "TV" } },
      ] } },
    200: { id: 200, format: "TV", title: { english: "One Punch Man Season 2" },
      relations: { edges: [{ relationType: "SEQUEL", node: { id: 300, type: "ANIME", format: "TV" } }] } },
    300: { id: 300, format: "TV", title: { english: "One Punch Man Season 3" },
      coverImage: { large: "https://example.test/s3-cover.jpg" },
      nextAiringEpisode: { id: 330, episode: 4, airingAt: when }, relations: { edges: [] } },
  };
  const requestedIds = [];
  const scheduleIds = [];
  const fetchImpl = async (url, options = {}) => {
    if (String(url).includes("tvmaze")) return { ok: true, json: async () => [] };
    const body = JSON.parse(options.body);
    if (body.query.includes("relations")) {
      requestedIds.push(...body.variables.ids);
      return { ok: true, json: async () => ({ data: { Page: { media: body.variables.ids.map((id) => media[id]).filter(Boolean) } } }) };
    }
    scheduleIds.push(body.variables.ids);
    return { ok: true, json: async () => ({ data: { Page: { pageInfo: { hasNextPage: false }, airingSchedules: [
      { id: 331, episode: 5, airingAt: when + 86400, media: { ...media[300] } },
      { id: 901, episode: 7, airingAt: when, media: { id: 900, title: { english: "Other anime" }, format: "TV" } },
    ] } } }) };
  };
  const service = createReleaseCalendarService({ fetchImpl, getTmdbKey: () => "",
    anilistEndpoint: "https://example.test/anilist", tvmazeEndpoint: "https://example.test/tvmaze" });
  const result = await service.releases("2026-10-19", "2026-10-25", { anilistIds: [100] });
  assert.deepEqual(requestedIds, [100, 200, 300], "Traverse both sequel seasons without loading side stories");
  assert.deepEqual(scheduleIds[0], [100, 200, 300], "The public airing query searches only verified seasons");
  assert.deepEqual(result.events.filter((event) => event.providerId === "300")
    .map((event) => [event.code, event.linkedAniListIds, event.artwork]), [
    ["EP 4", [100], "https://example.test/s3-cover.jpg"],
    ["EP 5", [100], "https://example.test/s3-cover.jpg"],
  ]);
  assert.equal(result.events.find((event) => event.providerId === "900")?.linkedAniListIds, undefined);
  const again = await service.releases("2026-10-26", "2026-11-01", { anilistIds: [100] });
  assert.deepEqual(requestedIds, [100, 200, 300], "Family graph is cached across months");
  assert.ok(again.coverage.AniList);
});

test("Ambiguous sequel branches are not combined with a saved anime", async () => {
  const requestedIds = [];
  const fetchImpl = async (url, options = {}) => {
    if (String(url).includes("tvmaze")) return { ok: true, json: async () => [] };
    const body = JSON.parse(options.body);
    if (body.query.includes("relations")) {
      requestedIds.push(...body.variables.ids);
      return { ok: true, json: async () => ({ data: { Page: { media: [{ id: 1, format: "TV", relations: { edges: [
        { relationType: "SEQUEL", node: { id: 2, type: "ANIME", format: "TV" } },
        { relationType: "SEQUEL", node: { id: 3, type: "ANIME", format: "ONA" } },
      ] } }] } } }) };
    }
    return { ok: true, json: async () => ({ data: { Page: { pageInfo: { hasNextPage: false }, airingSchedules: [] } } }) };
  };
  const service = createReleaseCalendarService({ fetchImpl, anilistEndpoint: "https://example.test/anilist",
    tvmazeEndpoint: "https://example.test/tvmaze" });
  await service.releases("2026-10-19", "2026-10-25", { anilistIds: [1] });
  assert.deepEqual(requestedIds, [1]);
});
