// The catalog: titles, details, Home rows and search.
import { catalogTitleDetails } from "./catalog-details.js";
import { appDatabase, CINEMETA_ORIGIN, IMDB_SUGGEST_ORIGIN } from "../../server.js";
import { fetchUpstreamJson, json, methodNotAllowed, pruneTimedCache } from "../app/http-helpers.js";

const MAX_CATALOG_QUERY_LENGTH = 180;
const MAX_CATALOG_RESULTS = 24;
const CATALOG_CACHE_TTL_MS = 10 * 60 * 1000;

// The chapter list is metadata only, so it can list long anime seasons in full.
const MAX_SEASON_LIST_EPISODES = 2000;

const catalogSearchCache = new Map();

const homeCatalogCache = new Map();
const HOME_CATALOG_META_KEY = "home_catalog_v1";
let homeCatalogRestoredFromDisk = false;

export function validateCatalogType(value) {
  return value === "movie" || value === "series" ? value : null;
}

export function validateImdbId(value, { allowVideoId = false } = {}) {
  const pattern = allowVideoId ? /^tt\d{5,12}(?::\d{1,3}:\d{1,4})?$/ : /^tt\d{5,12}$/;
  return typeof value === "string" && pattern.test(value) ? value : null;
}

function httpsImageUrl(value) {
  return typeof value === "string" && value.length <= 2048 && /^https:\/\//i.test(value) ? value : "";
}

function catalogRating(value) {
  const rating = Number.parseFloat(value);
  return Number.isFinite(rating) && rating > 0 && rating <= 10 ? rating.toFixed(1) : "";
}

function catalogRuntime(value) {
  const runtime = String(value ?? "").trim();
  return runtime.length <= 24 && /\d/.test(runtime) && /^[\w .:-]+$/.test(runtime) ? runtime : "";
}

function truncateCatalogText(value, maxLength) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  const cut = text.slice(0, maxLength - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s,.;:–-]+$/, "")}…`;
}

export function normalizeCatalogMeta(meta, type) {
  const id = validateImdbId(meta?.id);
  if (!id) return null;
  const name = String(meta?.name || "").trim().slice(0, 240);
  if (!name) return null;
  const releaseInfo = String(meta?.releaseInfo || meta?.year || "").trim().slice(0, 80);
  return {
    id,
    type,
    name,
    poster: httpsImageUrl(meta?.poster),
    background: httpsImageUrl(meta?.background),
    logo: httpsImageUrl(meta?.logo),
    releaseInfo,
    description: String(meta?.description || "").trim().slice(0, 1200),
    genres: Array.isArray(meta?.genres) ? meta.genres.map((item) => String(item)).slice(0, 8) : [],
    imdbRating: catalogRating(meta?.imdbRating),
    runtime: catalogRuntime(meta?.runtime),
  };
}

// Home browsing payload: enough for posters, the hero billboard (backdrop, logo, synopsis) and
// card metadata. Still metadata only; torrent sources are fetched only when a user asks.
function lightweightCatalogMeta(meta, type) {
  const normalized = normalizeCatalogMeta(meta, type);
  if (!normalized) return null;
  return {
    id: normalized.id,
    type: normalized.type,
    name: normalized.name,
    poster: normalized.poster,
    background: normalized.background,
    logo: normalized.logo,
    releaseInfo: normalized.releaseInfo,
    description: truncateCatalogText(normalized.description, 360),
    genres: normalized.genres,
    imdbRating: normalized.imdbRating,
    runtime: normalized.runtime,
  };
}

function savedHomeCatalog() {
  try {
    const value = JSON.parse(appDatabase.getMeta(HOME_CATALOG_META_KEY) || "null");
    if (value && ["movies", "series", "anime"].every((key) => Array.isArray(value[key]))) {
      return value;
    }
  } catch (error) {
    console.warn("Could not read saved Home catalog:", error.message);
  }
  return null;
}

export async function homeCatalog(req, res, url) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  pruneTimedCache(homeCatalogCache, 4);
  const cached = homeCatalogCache.get("home");
  const refresh = url.searchParams.get("refresh") === "1";
  if (!refresh && cached?.expiresAt > Date.now()) {
    json(res, 200, { ...cached.value, cached: true });
    return true;
  }
  const previous = cached?.value || savedHomeCatalog();
  const restoreOnStartup = !refresh && !cached && previous && !homeCatalogRestoredFromDisk;
  homeCatalogRestoredFromDisk = true;
  // Opening the app should be immediate after the catalog has loaded once, even if
  // Cinemeta is currently slow or unreachable. A later refresh can update this copy.
  if (restoreOnStartup) {
    const restored = { ...previous, stale: true };
    homeCatalogCache.set("home", { value: restored, expiresAt: Date.now() + 60_000 });
    json(res, 200, { ...restored, cached: true });
    return true;
  }

  const requests = [
    ...["movie", "series"].flatMap((type) => [0, 50].map((skip) => ({
      label: `${type} top ${skip}`,
      type,
      anime: false,
      url: CINEMETA_ORIGIN + "/catalog/" + type + "/top" + (skip ? "/skip=" + skip : "") + ".json",
    }))),
    ...["movie", "series"].map((type) => ({
      label: `${type} anime`,
      type,
      anime: true,
      url: CINEMETA_ORIGIN + "/catalog/" + type + "/top/genre=Anime.json",
    })),
  ];
  const responses = await Promise.allSettled(requests.map(({ url: endpoint }) => fetchUpstreamJson(endpoint, 8_000)));
  const groups = { movie: [], series: [], animeMovie: [], animeSeries: [] };
  let successfulRequests = 0;
  const failed = [];
  responses.forEach((response, index) => {
    const request = requests[index];
    if (response.status === "rejected") {
      failed.push(`${request.label}: ${response.reason?.message || "unavailable"}`);
      return;
    }
    const group = request.anime ? (request.type === "series" ? "animeSeries" : "animeMovie") : request.type;
    successfulRequests += 1;
    for (const meta of Array.isArray(response.value.metas) ? response.value.metas : []) {
      const normalized = lightweightCatalogMeta(meta, request.type);
      if (normalized) groups[group].push(normalized);
    }
  });
  if (failed.length) console.warn("Home catalog provider errors:", failed.join("; "));
  if (!successfulRequests && previous) {
    const restored = { ...previous, stale: true, partial: true };
    homeCatalogCache.set("home", { value: restored, expiresAt: Date.now() + 60_000 });
    json(res, 200, { ...restored, cached: true });
    return true;
  }
  const dedupe = (items, limit) => [...new Map(items.map((item) => [item.id, item])).values()].slice(0, limit);
  const allMovies = groups.movie.length ? dedupe(groups.movie, 96) : (previous?.movies || []);
  const allSeries = groups.series.length ? dedupe(groups.series, 96) : (previous?.series || []);
  const animeSeries = groups.animeSeries.length ? dedupe(groups.animeSeries, 50) : (previous?.anime || []).filter((item) => item.type === "series");
  const animeMovies = groups.animeMovie.length ? dedupe(groups.animeMovie, 50) : (previous?.anime || []).filter((item) => item.type === "movie");
  const reusedSavedTitles = Boolean(previous) && (
    (!groups.movie.length && allMovies.length > 0)
    || (!groups.series.length && allSeries.length > 0)
    || (!groups.animeSeries.length && animeSeries.length > 0)
    || (!groups.animeMovie.length && animeMovies.length > 0)
  );
  const animeTitles = dedupe([...animeSeries, ...animeMovies], 100);
  if (!allMovies.length && !allSeries.length && !animeTitles.length) {
    json(res, 503, { error: "The catalog provider is unavailable. Try again shortly." });
    return true;
  }
  const animeIds = new Set(animeTitles.map((item) => item.id));
  const movies = allMovies.filter((item) => !animeIds.has(item.id));
  const series = allSeries.filter((item) => !animeIds.has(item.id));
  const anime = animeTitles;
  const value = {
    movies,
    series,
    anime,
    seed: Math.floor(Date.now() / (10 * 60 * 1000)),
    generatedAt: Date.now(),
    refreshAfterMs: 10 * 60 * 1000,
  };
  const partial = failed.length > 0;
  value.partial = partial;
  if (reusedSavedTitles) value.stale = true;
  homeCatalogCache.set("home", { value, expiresAt: Date.now() + (partial ? 60_000 : 10 * 60 * 1000) });
  if (successfulRequests) {
    try { appDatabase.setMeta(HOME_CATALOG_META_KEY, JSON.stringify(value)); }
    catch (error) { console.warn("Could not save Home catalog:", error.message); }
  }
  json(res, 200, { ...value, cached: false, partial });
  return true;
}

export async function searchCatalog(req, res, url) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  const query = String(url.searchParams.get("q") || "").trim();
  if (!query || query.length > MAX_CATALOG_QUERY_LENGTH) {
    json(res, 400, { error: "A short movie or series title is required" });
    return true;
  }
  const { results, cached } = await catalogSearchResults(query, { withCacheFlag: true });
  json(res, 200, { query, results, cached });
  return true;
}

// Public IMDb title suggestions are a fallback when Cinemeta's search is down.
// They include IMDb ids, titles, release years and posters, so the same title
// page and source lookup can operate without a separate API key.
async function imdbCatalogSearch(query) {
  const normalizedQuery = String(query).trim().toLowerCase();
  const first = normalizedQuery[0];
  const endpoint = `${IMDB_SUGGEST_ORIGIN}/${encodeURIComponent(first)}/${encodeURIComponent(normalizedQuery)}.json`;
  const payload = await fetchUpstreamJson(endpoint, 5_000);
  if (!Array.isArray(payload.d)) throw new Error("IMDb suggestions returned an invalid result");
  return payload.d.map((item) => {
    const category = `${item?.qid || ""} ${item?.q || ""}`.toLowerCase();
    const type = /(?:series|miniseries|mini series)/.test(category) ? "series"
      : /(?:movie|feature|film)/.test(category) ? "movie"
        : null;
    if (!type) return null; // Person, game, TV episode and unrelated suggestions.
    const rawPoster = httpsImageUrl(item?.i?.imageUrl);
    const poster = rawPoster.replace(/_V1_[^/]*\.(?:jpe?g)$/i, "_V1_UX300.jpg");
    return normalizeCatalogMeta({
      id: item.id, name: item.l, releaseInfo: item.y, poster,
    }, type);
  }).filter(Boolean);
}

// Cinemeta movie and series search, cached for a while.
export async function catalogSearchResults(query, { withCacheFlag = false } = {}) {
  const value = String(query || "").trim().slice(0, MAX_CATALOG_QUERY_LENGTH);
  if (!value) return withCacheFlag ? { results: [], cached: false } : [];
  pruneTimedCache(catalogSearchCache, 60);
  const cacheKey = value.toLowerCase();
  const cached = catalogSearchCache.get(cacheKey);
  if (cached?.expiresAt > Date.now()) return withCacheFlag ? { results: cached.results, cached: true } : cached.results;

  const searches = ["movie", "series"].map(async (type) => {
    const endpoint = `${CINEMETA_ORIGIN}/catalog/${type}/top/search=${encodeURIComponent(value)}.json`;
    try {
      const payload = await fetchUpstreamJson(endpoint, 4_000);
      return {
        available: true,
        results: (Array.isArray(payload.metas) ? payload.metas : [])
          .map((meta) => normalizeCatalogMeta(meta, type))
          .filter(Boolean),
      };
    } catch (error) {
      console.warn(`Cinemeta ${type} search failed:`, error.message);
      return { available: false, results: [] };
    }
  });
  const responses = await Promise.all(searches);
  const providerFailures = responses.filter((response) => !response.available).length;
  let imdbAvailable = false;
  let imdbResults = [];
  if (providerFailures) {
    try {
      imdbResults = await imdbCatalogSearch(value);
      imdbAvailable = true;
    } catch (error) {
      console.warn("IMDb title suggestion fallback failed:", error.message);
    }
  }
  if (!responses.some((response) => response.available) && !imdbAvailable) {
    if (withCacheFlag) {
      const error = new Error("Title search is temporarily unavailable. Try again shortly.");
      error.statusCode = 503;
      throw error;
    }
    return [];
  }
  const combined = [...responses.flatMap((response) => response.results), ...imdbResults];
  const seen = new Set();
  const results = [];
  for (const result of combined) {
    const key = `${result.type}:${result.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(result);
    if (results.length >= MAX_CATALOG_RESULTS) break;
  }
  // Retry Cinemeta sooner after partial outages, even if the IMDb fallback succeeded.
  catalogSearchCache.set(cacheKey, { results, expiresAt: Date.now() + (providerFailures ? 60_000 : CATALOG_CACHE_TTL_MS) });
  return withCacheFlag ? { results, cached: false } : results;
}

async function getCatalogMeta(type, imdbId) {
  const endpoint = `${CINEMETA_ORIGIN}/meta/${type}/${encodeURIComponent(imdbId)}.json`;
  const payload = await fetchUpstreamJson(endpoint, 8_000);
  const meta = payload.meta;
  if (!meta || typeof meta !== "object") {
    const error = new Error("Metadata was not found for that title");
    error.statusCode = 404;
    throw error;
  }
  return meta;
}

export async function catalogMeta(req, res, url) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  const type = validateCatalogType(url.searchParams.get("type"));
  const imdbId = validateImdbId(url.searchParams.get("id"));
  if (!type || !imdbId) {
    json(res, 400, { error: "A valid movie/series type and IMDb id are required" });
    return true;
  }
  const meta = await getCatalogMeta(type, imdbId);
  const normalized = {
    ...(normalizeCatalogMeta(meta, type) || { id: imdbId, type, name: String(meta.name || imdbId) }),
    ...catalogTitleDetails(meta),
  };
  if (type === "series") {
    const seasons = new Map();
    for (const video of Array.isArray(meta.videos) ? meta.videos : []) {
      const season = Number(video.season);
      const episode = Number(video.episode ?? video.number);
      const videoId = validateImdbId(video.id, { allowVideoId: true });
      if (!Number.isInteger(season) || season < 0 || !Number.isInteger(episode) || episode < 1 || !videoId) continue;
      const record = seasons.get(season) || { season, count: 0, episodes: [] };
      record.count += 1;
      if (record.episodes.length < MAX_SEASON_LIST_EPISODES) record.episodes.push(catalogEpisodeRecord(video, videoId, episode));
      seasons.set(season, record);
    }
    normalized.seasons = [...seasons.values()]
      .map((record) => ({ ...record, episodes: record.episodes.sort((a, b) => a.episode - b.episode) }))
      .sort((a, b) => a.season - b.season);
  }
  json(res, 200, { meta: normalized });
  return true;
}

// One chapter of a series for the chapter list: metadata only, no torrent lookups.
function catalogEpisodeRecord(video, videoId, episode) {
  const released = String(video.released || video.firstAired || "").match(/^\d{4}-\d{2}-\d{2}/)?.[0] || "";
  return {
    id: videoId,
    episode,
    name: String(video.name || video.title || `Episode ${episode}`).replace(/\s+/g, " ").trim().slice(0, 240) || `Episode ${episode}`,
    released,
    thumbnail: httpsImageUrl(video.thumbnail),
    overview: truncateCatalogText(video.overview || video.description || "", 900),
    rating: catalogRating(video.rating),
  };
}
