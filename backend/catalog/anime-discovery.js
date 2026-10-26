// Public anime discovery (AniList), read-only and account-independent.
// One filtered page per user request, bounded cache and in-flight deduplication.
export const ANIME_GENRES = Object.freeze([
  "Action", "Adventure", "Comedy", "Drama", "Fantasy", "Horror", "Mahou Shoujo",
  "Mecha", "Music", "Mystery", "Psychological", "Romance", "Sci-Fi",
  "Slice of Life", "Sports", "Supernatural", "Thriller",
]);
export const ANIME_SEASONS = Object.freeze(["WINTER", "SPRING", "SUMMER", "FALL"]);
export const ANIME_FORMATS = Object.freeze(["TV", "TV_SHORT", "MOVIE", "OVA", "ONA", "SPECIAL"]);
export const ANIME_STATUSES = Object.freeze(["RELEASING", "FINISHED", "NOT_YET_RELEASED", "HIATUS"]);
export const ANIME_SORTS = Object.freeze(["POPULARITY_DESC", "SCORE_DESC", "TRENDING_DESC", "START_DATE_DESC"]);

export function animeDiscoveryFilters(input = {}, currentYear = new Date().getFullYear()) {
  const text = (name) => String(input.get?.(name) ?? input[name] ?? "").trim();
  const enumValue = (name, allowed, fallback = null) => allowed.includes(text(name).toUpperCase()) ? text(name).toUpperCase() : fallback;
  const year = Number(text("year"));
  const page = Number(text("page"));
  return {
    year: text("year") === "all" ? null : Number.isInteger(year) && year >= 1940 && year <= currentYear + 2 ? year : currentYear,
    season: enumValue("season", ANIME_SEASONS),
    format: enumValue("format", ANIME_FORMATS),
    status: enumValue("status", ANIME_STATUSES),
    sort: enumValue("sort", ANIME_SORTS, "POPULARITY_DESC"),
    genre: ANIME_GENRES.find((genre) => genre.toLowerCase() === text("genre").toLowerCase()) || null,
    search: text("search").slice(0, 90),
    page: Number.isInteger(page) && page >= 1 && page <= 12 ? page : 1,
  };
}

// AniList rejects date comparison operators when their argument is null. Build
// one of three fixed query shapes rather than sending a null date comparison.
export function animeDiscoveryQuery(args = {}) {
  const declarations = ["$page: Int!"];
  const filters = ["type: ANIME", "isAdult: false"];
  const add = (key, type) => {
    if (args[key] === null || args[key] === undefined || args[key] === "") return;
    declarations.push(`$${key}: ${type}`);
    filters.push(`${({ year: "seasonYear", after: "startDate_greater", before: "startDate_lesser" })[key] || key}: $${key}`);
  };
  if (args.season) {
    add("year", "Int");
    add("season", "MediaSeason");
  } else if (args.after && args.before) {
    add("after", "FuzzyDateInt");
    add("before", "FuzzyDateInt");
  }
  add("format", "MediaFormat");
  add("status", "MediaStatus");
  add("genre", "String");
  add("sort", "[MediaSort]");
  add("search", "String");
  return `query (${declarations.join(", ")}) {
  Page(page: $page, perPage: 24) {
    pageInfo { currentPage hasNextPage }
    media(${filters.join(", ")}) {
      id format season seasonYear episodes status averageScore popularity genres
      title { english romaji }
      coverImage { extraLarge large }
    }
  }
}`;
}

export function createAnimeDiscoveryService({ fetchImpl = fetch, endpoint = "https://graphql.anilist.co", now = Date.now, ttlMs = 10 * 60_000 } = {}) {
  const cache = new Map();
  async function discover(filters) {
    const args = animeDiscoveryFilters(filters, new Date(now()).getFullYear());
    const key = JSON.stringify(args);
    const previous = cache.get(key);
    if (previous && previous.expires > now()) return previous.promise;
    if (cache.size > 100) {
      for (const [cacheKey, entry] of cache) if (entry.expires <= now()) cache.delete(cacheKey);
      if (cache.size > 100) cache.delete(cache.keys().next().value);
    }
    const promise = (async () => {
      const seasonYear = args.season ? args.year : null;
      const variables = {
        page: args.page, year: seasonYear, season: args.season,
        after: args.season || !args.year ? null : args.year * 10000 + 100,
        before: args.season || !args.year ? null : args.year * 10000 + 1232,
        format: args.format, status: args.status, genre: args.genre,
        sort: [args.sort], search: args.search || null,
      };
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ query: animeDiscoveryQuery(variables), variables }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(response.status === 429 ? "AniList is rate-limiting requests. Try again shortly." : `AniList returned HTTP ${response.status}`);
      const payload = await response.json();
      if (payload?.errors?.length) throw new Error(String(payload.errors[0].message || "AniList search failed").slice(0, 200));
      if (!Array.isArray(payload?.data?.Page?.media)) throw new Error("AniList returned an invalid search response");
      const pageInfo = payload.data.Page.pageInfo || {};
      return {
        filters: args,
        items: payload.data.Page.media.filter((m) => m?.id && !m.isAdult).map((m) => ({
          id: m.id, title: m.title?.english || m.title?.romaji || `Anime ${m.id}`,
          titleAlt: m.title?.romaji && m.title.romaji !== m.title?.english ? m.title.romaji : "",
          cover: m.coverImage?.extraLarge || m.coverImage?.large || "",
          format: m.format || "", season: m.season || "", year: m.seasonYear || null,
          episodes: m.episodes || null, score: m.averageScore || null,
          popularity: m.popularity || 0, genres: m.genres || [], status: m.status || "",
        })),
        hasNextPage: Boolean(pageInfo.hasNextPage) && args.page < 12,
      };
    })();
    cache.set(key, { promise, expires: now() + ttlMs });
    try { return await promise; }
    catch (error) { cache.delete(key); throw error; }
  }
  return { discover };
}
