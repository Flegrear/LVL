/**
 * TMDB (needs your free key): finds a title by its IMDb id, reads details (genres, keywords,
 * companies, score and voters) and TMDB's "Recommendations" list, which works like fans' links
 * for movies and series. Accepts the v3 API key (32 characters) or the API Read Access Token.
 */

export const TMDB_ORIGIN = "https://api.themoviedb.org/3";
const IMAGE_ORIGIN = "https://image.tmdb.org/t/p";
const LINKS_PER_TITLE = 20;

/** How to send the key, or null when it isn't one. */
export function tmdbAuth(key) {
  const value = String(key || "").trim();
  if (/^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(value)) return { header: `Bearer ${value}` };
  if (/^[a-f0-9]{32}$/i.test(value)) return { query: value };
  return null;
}

const tmdbKind = (kind) => (kind === "movie" ? "movie" : "tv");
const yearOf = (value) => Number(String(value || "").slice(0, 4)) || null;

/** Our record of one TMDB movie or series (from its details, or from a list result). */
export function normalizeTmdbTitle(kind, data, { genreNames = null, fetchedAt = Date.now() } = {}) {
  if (!data?.id) return null;
  const type = tmdbKind(kind);
  const keywords = type === "movie" ? data.keywords?.keywords : data.keywords?.results;
  const genres = Array.isArray(data.genres) ? data.genres.map((genre) => genre?.name).filter(Boolean)
    : (data.genre_ids || []).map((id) => genreNames?.get(id)).filter(Boolean);
  const collection = data.belongs_to_collection?.id ? `tmdb:collection:${data.belongs_to_collection.id}` : null;
  return {
    itemId: `tmdb:${type}:${data.id}`,
    source: "tmdb",
    sourceId: `${type}:${data.id}`,
    kind: type === "movie" ? "movie" : "series",
    franchiseId: collection,
    title: data.title || data.name || `TMDB ${data.id}`,
    titleAlt: (data.original_title || data.original_name) && (data.original_title || data.original_name) !== (data.title || data.name) ? data.original_title || data.original_name : "",
    format: type,
    year: yearOf(data.release_date || data.first_air_date),
    episodes: Number.isInteger(data.number_of_episodes) ? data.number_of_episodes : null,
    score: Number(data.vote_average) > 0 ? Math.round(Number(data.vote_average) * 10) : null,
    scoredBy: Number.isInteger(data.vote_count) ? data.vote_count : null,
    likedShare: null,
    popularity: Number.isFinite(data.popularity) ? Math.round(data.popularity) : null,
    genres,
    tags: (Array.isArray(keywords) ? keywords : []).slice(0, 15).map((keyword) => ({ name: keyword.name, weight: 60 })),
    studios: (data.production_companies || []).slice(0, 3).map((company) => company?.name).filter(Boolean),
    relations: [],
    description: String(data.overview || "").replace(/\s+/g, " ").trim().slice(0, 900),
    cover: data.poster_path ? `${IMAGE_ORIGIN}/w500${data.poster_path}` : "",
    banner: data.backdrop_path ? `${IMAGE_ORIGIN}/w1280${data.backdrop_path}` : "",
    adult: Boolean(data.adult),
    imdbId: (type === "movie" ? data.imdb_id : data.external_ids?.imdb_id) || null,
    tmdbId: String(data.id),
    // A list result has no keywords or ids: marked old so the details are read when needed.
    fetchedAt: Array.isArray(data.genres) ? fetchedAt : 1,
  };
}

export function createTmdbClient({ key, fetchImpl = globalThis.fetch, minGapMs = 120, timeoutMs = 15_000, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const auth = tmdbAuth(key);
  if (!auth) throw Object.assign(new Error("That isn't a TMDB key. Paste the API key (32 characters) or the API Read Access Token."), { statusCode: 400 });
  let queue = Promise.resolve();
  let lastAt = 0;
  let requests = 0;
  let genreNames = null;

  async function send(pathname, params = {}, attempt = 0) {
    const wait = lastAt + minGapMs - now();
    if (wait > 0) await sleep(wait);
    lastAt = now();
    requests += 1;
    const url = new URL(`${TMDB_ORIGIN}${pathname}`);
    for (const [name, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== "") url.searchParams.set(name, String(value));
    if (auth.query) url.searchParams.set("api_key", auth.query);
    const response = await fetchImpl(url, {
      headers: { Accept: "application/json", ...(auth.header ? { Authorization: auth.header } : {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 429 && attempt < 2) {
      await sleep(Math.min(30, Math.max(2, Number(response.headers?.get?.("retry-after")) || 10)) * 1000);
      return send(pathname, params, attempt + 1);
    }
    const payload = await response.json().catch(() => null);
    if (response.status === 401) throw Object.assign(new Error("TMDB didn't accept that key."), { status: 401, statusCode: 400 });
    if (!response.ok) throw Object.assign(new Error(payload?.status_message || `TMDB answered HTTP ${response.status}`), { status: response.status });
    return payload || {};
  }

  const request = (pathname, params) => {
    const run = queue.then(() => send(pathname, params));
    queue = run.catch(() => {});
    return run;
  };

  async function genres() {
    if (genreNames) return genreNames;
    const [movie, tv] = await Promise.all([request("/genre/movie/list"), request("/genre/tv/list")]);
    genreNames = new Map([...(movie.genres || []), ...(tv.genres || [])].map((genre) => [genre.id, genre.name]));
    return genreNames;
  }

  return {
    get requests() { return requests; },
    /** Checks the key (one small request). */
    validate: () => request("/configuration"),
    /** TMDB ids of a title found by its IMDb id. */
    async findImdb(imdbId) {
      const data = await request(`/find/${encodeURIComponent(imdbId)}`, { external_source: "imdb_id" });
      return { movie: data.movie_results?.[0]?.id || null, tv: data.tv_results?.[0]?.id || null };
    },
    async details(kind, id) {
      const type = tmdbKind(kind);
      const data = await request(`/${type}/${encodeURIComponent(id)}`, { append_to_response: type === "movie" ? "keywords" : "keywords,external_ids" });
      return normalizeTmdbTitle(type, data, { fetchedAt: now() });
    },
    /** TMDB's recommendations for a title: links by position, plus each result's basics. */
    async recommendations(kind, id) {
      const type = tmdbKind(kind);
      const names = await genres();
      const data = await request(`/${type}/${encodeURIComponent(id)}/recommendations`, { page: 1 });
      const results = (data.results || []).filter((result) => result?.id && !result.adult).slice(0, LINKS_PER_TITLE);
      const resultType = (result) => (result.media_type === "movie" || result.media_type === "tv" ? result.media_type : type);
      return {
        items: results.map((result) => normalizeTmdbTitle(resultType(result), result, { genreNames: names, fetchedAt: now() })).filter(Boolean),
        links: results.map((result, rank) => ({ to: `tmdb:${resultType(result)}:${result.id}`, rank })),
      };
    },
    /** A movie's TMDB id from its title and year (for Letterboxd exports, which have no ids). */
    async searchMovie(title, year = null) {
      const data = await request("/search/movie", { query: String(title || "").slice(0, 120), year: year || undefined });
      const wanted = String(title || "").toLowerCase();
      const results = data.results || [];
      const exact = results.find((result) => String(result.title || "").toLowerCase() === wanted && (!year || yearOf(result.release_date) === Number(year)));
      return (exact || results[0])?.id || null;
    },
  };
}
