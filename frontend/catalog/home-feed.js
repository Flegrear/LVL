// home-feed.js: pure data shaping for the Home catalog (no DOM access).
//
// The server sends three popularity-ordered lists (movies, series, anime). This module turns
// them into a hero selection plus Netflix-style rows for the chosen category, and maps catalog
// metadata onto the card/hero item shapes that ui.js renders.

export const HOME_CATEGORIES = Object.freeze([
  Object.freeze({ id: "all", label: "All", noun: "titles" }),
  Object.freeze({ id: "movie", label: "Movies", noun: "movies" }),
  Object.freeze({ id: "tv", label: "TV Shows", noun: "TV shows" }),
  Object.freeze({ id: "anime", label: "Anime", noun: "anime" }),
]);

// Search providers return separate movie and series lists, historically putting
// every movie before the actual show. Rank title relevance before provider order
// and preserve films as independent searchable titles.
export function rankCatalogSearchResults(results = [], query = "") {
  const normalize = (value) => String(value || "").normalize("NFKC").toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
  const needle = normalize(query);
  if (!needle) return [...results];
  const score = (item) => {
    const title = normalize(item?.name || item?.title);
    const exact = title === needle;
    const begins = title.startsWith(needle + " ");
    const contains = title.includes(needle);
    const series = item?.type === "series";
    return (exact ? 0 : begins ? 1 : contains ? 2 : 3) * 10 + (series ? 0 : 1);
  };
  return results.map((item, index) => ({ item, index, rank: score(item) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index).map(({ item }) => item);
}

// Strict, read-only Random eligibility. Being in Library alone is not "seen":
// PLANNING is discoverable; even a partly played or marked episode is not.
const RANDOM_SEEN_STATUSES = new Set(["CURRENT", "COMPLETED", "REPEATING", "PAUSED", "DROPPED", "WATCHED"]);
export function randomSeriesAlreadySeen(series, { activeLibraryId = "" } = {}) {
  if (!series) return false;
  const sources = Array.isArray(series.sources) ? series.sources : [];
  if (sources.some((entry) => {
    if (entry.id === activeLibraryId && activeLibraryId) return true;
    if (RANDOM_SEEN_STATUSES.has(String(entry.trackingStatus || "").toUpperCase())) return true;
    if ((Number(entry.watchedTitleAt) || 0) > 0 || (Number(entry.lastPlayedAt) || 0) > 0) return true;
    // Explicit chapter marks store their timestamp, rather than `true`.
    // A `false` mark is an intentional unwatched override and stays eligible.
    if (Object.values(entry.watchedChapters || {}).some((value) => value === true || Number(value) > 0)) return true;
    return (entry.episodes || []).some((episode) =>
      episode?.progress?.finished === true || Number(episode?.progress?.positionMs) > 0 || episode?.watched === true);
  })) return true;
  const linked = sources.map((entry) => entry.anilist).filter(Boolean);
  return linked.some((info) =>
    RANDOM_SEEN_STATUSES.has(String(info.status || "").toUpperCase())
    || (info.seasons || []).some((part) =>
      RANDOM_SEEN_STATUSES.has(String(part.status || "").toUpperCase()) || Number(part.progress) > 0));
}
const randomKeyOf = (value) => String(value || "").normalize("NFKD").replace(/\p{M}/gu, "")
  .toLocaleLowerCase().replace(/['’]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
export function findSavedRandomTitle(saved = [], { imdbId = "", catalogId = "", anilistId = 0, title = "", titleAlt = "" } = {}) {
  const id = String(imdbId || catalogId || "");
  const aniId = Number(anilistId) || 0;
  const titles = [title, titleAlt].map(randomKeyOf).filter(Boolean);
  const matches = saved.filter((series) => {
    if (id && id === series.catalogId) return true;
    if (aniId && (series.sources || []).some((entry) => {
      const info = entry.anilist;
      return Number(info?.anilistId) === aniId || Number(String(info?.showId || "").split(":").at(-1)) === aniId
        || (info?.seasons || []).some((part) => Number(part.anilistId) === aniId)
        || (String(entry.externalSource || "").toUpperCase() === "ANILIST" && Number(entry.externalId) === aniId);
    })) return true;
    return titles.length > 0 && [series.title, ...(series.aliases || []), ...(series.sources || []).map((entry) => entry.title)]
      .some((name) => titles.includes(randomKeyOf(name)));
  });
  // Imports and separately added sources can create multiple Library groups for
  // one title. A watched group must not be hidden by an earlier planning group.
  return matches.find((series) => randomSeriesAlreadySeen(series)) || matches[0] || null;
}
export function randomPickMatchesCategory(pick, category = "all") {
  const anime = pick?.source === "anilist" || pick?.mediaKind === "anime";
  if (category === "anime") return anime;
  if (category === "movie") return !anime && pick?.type === "movie";
  if (category === "tv") return !anime && (pick?.type === "series" || pick?.type === "tv");
  return category === "all";
}

// TMDB recommendations sometimes have no IMDb id even after their details are
// fetched. A local search may supply one, but name alone is unsafe for a title
// that has remakes or multiple adaptations. Only allow a unique exact match.
export function verifiedRandomCatalogMatch(pick, candidates = []) {
  const names = new Set([pick?.title, pick?.titleAlt].map(randomKeyOf).filter(Boolean));
  const type = pick?.type === "movie" ? "movie" : "series";
  const year = Number(pick?.year) || null;
  if (!names.size) return null;
  const matches = (Array.isArray(candidates) ? candidates : []).filter((candidate) => {
    if (!/^tt\d{5,12}$/.test(String(candidate?.id || ""))) return false;
    if (candidate.type !== type || !names.has(randomKeyOf(candidate.name || candidate.title))) return false;
    const candidateYear = Number(String(candidate.releaseInfo || candidate.year || "").match(/\b(?:19|20)\d{2}\b/)?.[0]) || null;
    return !year || !candidateYear || Math.abs(candidateYear - year) <= 1;
  });
  return new Set(matches.map((candidate) => candidate.id)).size === 1 ? matches[0] : null;
}

export function randomPickIdentity(pick) {
  const imdb = String(pick?.imdbId || "");
  if (/^tt\d{5,12}$/.test(imdb)) return `imdb:${imdb}`;
  const anilist = pick?.source === "anilist" && /^https:\/\/anilist\.co\/anime\/(\d+)(?:[/?#]|$)/.exec(String(pick.url || ""));
  if (anilist) return `anilist:${anilist[1]}`;
  return String(pick?.itemId || `title:${randomKeyOf(pick?.title)}:${pick?.type || ""}:${pick?.year || ""}`);
}

// Related genres share a row so rows stay full; "Animation" is ignored for anime titles.
export const GENRE_GROUPS = Object.freeze([
  Object.freeze({ id: "action", label: "Action & adventure", genres: Object.freeze(["Action", "Adventure"]) }),
  Object.freeze({ id: "comedy", label: "Comedy", genres: Object.freeze(["Comedy"]) }),
  Object.freeze({ id: "drama", label: "Drama", genres: Object.freeze(["Drama"]) }),
  Object.freeze({ id: "crime", label: "Crime", genres: Object.freeze(["Crime"]) }),
  Object.freeze({ id: "thriller", label: "Thrillers & mystery", genres: Object.freeze(["Thriller", "Mystery"]) }),
  Object.freeze({ id: "scifi", label: "Sci-fi & fantasy", genres: Object.freeze(["Sci-Fi", "Fantasy"]) }),
  Object.freeze({ id: "horror", label: "Horror", genres: Object.freeze(["Horror"]) }),
  Object.freeze({ id: "romance", label: "Romance", genres: Object.freeze(["Romance"]) }),
  Object.freeze({ id: "family", label: "Family & animation", genres: Object.freeze(["Family", "Animation"]) }),
  Object.freeze({ id: "true-story", label: "Based on real events", genres: Object.freeze(["Biography", "History", "Documentary", "War"]) }),
]);

export const MIN_ROW_ITEMS = 6;
const ROW_LIMIT = 24;
const TOP_LIMIT = 10;
const HERO_COUNT = 5;

export function normalizeHomeCategory(value, fallback = "all") {
  return HOME_CATEGORIES.some((category) => category.id === value) ? value : fallback;
}

export function categoryNoun(category) {
  return HOME_CATEGORIES.find((item) => item.id === category)?.noun || "titles";
}

/* ---------------------------------------------------------------- Metadata parsing */

export function titleYear(meta) {
  const match = String(meta?.releaseInfo ?? meta?.year ?? "").match(/\b(?:18|19|20)\d{2}\b/);
  return match ? Number(match[0]) : null;
}

export function titleRating(meta) {
  const value = Number.parseFloat(meta?.imdbRating);
  return Number.isFinite(value) && value > 0 && value <= 10 ? Math.round(value * 10) / 10 : null;
}

// "101 min" -> "1h 41m", "45 min" -> "45m", "2h 10min" -> "2h 10m". Unknown formats -> "".
export function formatRuntime(value) {
  const text = String(value ?? "").trim().toLowerCase();
  let minutes = 0;
  const plain = text.match(/^(\d{1,4})\s*(?:m|min|mins|minutes)?$/);
  const hours = text.match(/^(\d{1,2})\s*h(?:ours?|rs?)?\s*(?:(\d{1,2})\s*(?:m|min|mins|minutes)?)?$/);
  if (plain) minutes = Number(plain[1]);
  else if (hours) minutes = Number(hours[1]) * 60 + Number(hours[2] || 0);
  if (!minutes || minutes > 1440) return "";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h${m ? ` ${m}m` : ""}` : `${m}m`;
}

/* ---------------------------------------------------------------- Ordering helpers */

// FNV-1a: a stable, seedable order so "Shuffle" rotates picks without randomness in tests.
export function hashScore(text) {
  let hash = 2166136261;
  const value = String(text);
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function itemScore(item, seed, salt) {
  return hashScore(`${item?.id || ""}|${item?.name || ""}|${seed}|${salt}`);
}

export function seededOrder(items, seed, salt = "") {
  return (items || [])
    .map((item) => ({ item, score: itemScore(item, seed, salt) }))
    .sort((a, b) => a.score - b.score)
    .map((entry) => entry.item);
}

// Mostly keeps popularity order but lets nearby titles swap places for each seed.
export function jitteredOrder(items, seed, salt = "", spread = 12) {
  return (items || [])
    .map((item, index) => ({ item, index, score: index + (itemScore(item, seed, salt) % spread) }))
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((entry) => entry.item);
}

export function interleave(...lists) {
  const output = [];
  const longest = Math.max(0, ...lists.map((list) => list.length));
  for (let index = 0; index < longest; index += 1) {
    lists.forEach((list) => {
      if (index < list.length) output.push(list[index]);
    });
  }
  return output;
}

export function uniqueById(items) {
  const seen = new Set();
  return (items || []).filter((item) => {
    const key = item?.id || item?.key || item?.name;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/* ---------------------------------------------------------------- Artwork URLs */

const METAHUB_ORIGIN = "https://images.metahub.space";
const METAHUB_PATTERN = /^https:\/\/images\.metahub\.space\/(poster|background|logo)\/(small|medium|large)\/(tt\d{5,12})\/img$/;
const METAHUB_SIZES = new Set(["small", "medium", "large"]);

export function metahubVariant(url, size) {
  const match = METAHUB_PATTERN.exec(String(url || ""));
  return match && METAHUB_SIZES.has(size) ? `${METAHUB_ORIGIN}/${match[1]}/${size}/${match[3]}/img` : "";
}

export function metahubUrl(kind, size, id) {
  return /^tt\d{5,12}$/.test(String(id || "")) && METAHUB_SIZES.has(size) && ["poster", "background", "logo"].includes(kind)
    ? `${METAHUB_ORIGIN}/${kind}/${size}/${id}/img`
    : "";
}

// AniList keeps every cover in small (100 px), medium (230 px) and large (460 px) under the same
// file name. Older entries saved the medium one; cards ask for the large one (the saved one is
// the fallback).
const ANILIST_COVER_PATTERN = /^(https:\/\/s4\.anilist\.co\/file\/anilistcdn\/media\/(?:anime|manga)\/cover\/)(?:small|medium)(\/[^?#\s]+)$/;

export function largeAniListCover(url) {
  const match = ANILIST_COVER_PATTERN.exec(String(url || ""));
  return match ? `${match[1]}large${match[2]}` : "";
}

/** A card image: the sharper size when there is one, and the saved one as its fallback. */
export function sharperPoster(url) {
  const value = String(url || "");
  const large = largeAniListCover(value);
  return large ? { image: large, imageFallback: value } : { image: value, imageFallback: "" };
}

// Real widths of metahub's sizes (measured): posters 300 / 500 / 780 px, backdrops 480 px small
// and 1920 px for both medium and large (the same file). The browser picks one for the size the
// card is drawn at on this screen, so posters stay sharp at 125–200% scaling too.
const POSTER_WIDTHS = { small: 300, medium: 500, large: 780 };

export function posterSrcset(meta) {
  const entries = ["small", "medium", "large"].map((size) => [metahubVariant(meta?.poster, size), POSTER_WIDTHS[size]]).filter(([url]) => url);
  return entries.length === 3 ? entries.map(([url, width]) => `${url} ${width}w`).join(", ") : "";
}

// Prefer the matched catalog's high-quality, size-adaptive artwork for automatic covers,
// but never replace artwork the viewer explicitly chose. No extra remote images are fetched
// just to rank them: the browser requests only the srcset variant its screen needs (max 780px).
export function preferredPosterArt({ saved = "", catalog = "", anilist = "", artworkSource = "", pinned = false } = {}) {
  const chosen = String(saved || "");
  const catalogCover = String(catalog || "");
  const anilistCover = String(anilist || "");
  const manual = pinned || /^(?:CUSTOM|TVMAZE|MANUAL)$/i.test(String(artworkSource || "")) || /^data:image\//i.test(chosen);
  const sharpCatalog = metahubVariant(catalogCover, "large");
  const image = manual && chosen ? chosen : sharpCatalog || chosen || catalogCover || anilistCover;
  const fallback = [chosen, anilistCover, catalogCover].find((candidate) => candidate && candidate !== image) || "";
  return { image, fallback, srcset: posterSrcset({ poster: image }) };
}

// The TVMaze CDN's original portraits can be multi-megabyte JPEGs. Keep the
// exact user-selected artwork, but ask our local server for a capped WebP render.
// Other trusted image CDNs already serve appropriately sized variants directly.
export function boundedPosterUrl(url) {
  const value = String(url || "");
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "https:" && parsed.host === "static.tvmaze.com"
      && /^\/uploads\/images\/original_untouched\/\d+\/\d+\.(?:jpe?g|png|webp)$/i.test(parsed.pathname)
      && !parsed.search && !parsed.hash) {
      return `/api/images/poster?src=${encodeURIComponent(value)}`;
    }
  } catch {}
  return value;
}

// Cinemeta backdrops live on metahub; older payloads without `background` fall back to the
// id-based URL, and a missing image is handled by the card's fallback artwork.
export function backdropUrl(meta, size = "medium") {
  if (meta?.background) return metahubVariant(meta.background, size) || meta.background;
  return metahubUrl("background", size, meta?.id);
}

const BACKDROP_WIDTHS = { small: 480, medium: 1920, large: 1920 };

export function backdropSrcset(meta, sizes = ["medium", "large"]) {
  const entries = sizes
    .map((size) => [backdropUrl(meta, size), BACKDROP_WIDTHS[size]])
    .filter(([url, width]) => url && width);
  // One entry per real width: medium and large are the same 1920 px file, so only one is listed.
  const unique = entries.filter(([, width], index) => entries.findIndex(([, other]) => other === width) === index);
  return new Set(unique.map(([url]) => url)).size === unique.length && unique.length > 1
    ? unique.map(([url, width]) => `${url} ${width}w`).join(", ")
    : "";
}

export function logoUrl(meta) {
  if (meta?.logo) return metahubVariant(meta.logo, "medium") || meta.logo;
  return metahubUrl("logo", "medium", meta?.id);
}

/* ---------------------------------------------------------------- Item mapping */

// Tag each list entry with its category (`kind`) and 1-based popularity `rank`.
export function catalogLists(catalog) {
  const source = catalog && typeof catalog === "object" ? catalog : {};
  const tag = (list, kind) => (Array.isArray(list) ? list : [])
    .filter((meta) => meta && meta.id && meta.name)
    .map((meta, index) => ({ ...meta, kind, rank: index + 1 }));
  return { movie: tag(source.movies, "movie"), tv: tag(source.series, "tv"), anime: tag(source.anime, "anime") };
}

export function typeLabel(meta, category = "all") {
  if (meta?.kind === "anime" && category !== "anime") return "Anime";
  if (meta?.type === "movie") return category === "anime" ? "Film" : "Movie";
  return "Series";
}

function displayGenres(meta, limit) {
  return (Array.isArray(meta?.genres) ? meta.genres : [])
    .filter((genre) => !(genre === "Animation" && meta?.kind === "anime"))
    .slice(0, limit);
}

export function catalogCardItem(meta, { category = "all", detailed = false } = {}) {
  const year = titleYear(meta);
  const detail = detailed ? (meta?.type === "movie" ? formatRuntime(meta?.runtime) : "") || displayGenres(meta, 1)[0] || "" : "";
  return {
    id: meta?.id || "",
    title: meta?.name || "Untitled",
    image: meta?.poster || "",
    imageSrcset: posterSrcset(meta),
    backdrop: backdropUrl(meta, "small"),
    backdropSrcset: backdropSrcset(meta, ["small", "medium"]),
    backdropFallback: meta?.background || "",
    logo: logoUrl(meta),
    logoFallback: meta?.logo || "",
    meta: [year ? String(year) : "", typeLabel(meta, category), detail],
    rating: titleRating(meta) ?? "",
    description: meta?.description || "",
  };
}

export function heroSlideItem(meta) {
  const year = titleYear(meta);
  const runtime = meta?.type === "movie" ? formatRuntime(meta?.runtime) : "";
  const genres = displayGenres(meta, 3);
  return {
    id: meta?.id || "",
    title: meta?.name || "Untitled",
    backdrop: backdropUrl(meta, "medium"),
    backdropSrcset: backdropSrcset(meta, ["medium", "large"]),
    backdropFallback: meta?.background || "",
    logo: logoUrl(meta),
    logoFallback: meta?.logo || "",
    meta: [year ? String(year) : "", runtime, genres.join(", ")],
    rating: titleRating(meta) ?? "",
    description: meta?.description || "",
  };
}

/* ---------------------------------------------------------------- Feed */

function pickHero(category, lists, pool, seed) {
  const pick = (list, count, salt) => {
    const candidates = list.slice(0, 14);
    const described = candidates.filter((meta) => meta.description);
    return seededOrder(described.length >= count ? described : candidates, seed, `hero:${salt}`).slice(0, count);
  };
  if (category !== "all") return pick(pool, HERO_COUNT, category);
  return uniqueById(interleave(pick(lists.tv, 2, "tv"), pick(lists.movie, 2, "movie"), pick(lists.anime, 1, "anime"))).slice(0, HERO_COUNT);
}

function newReleasesRow(pool, category, currentYear) {
  const items = pool
    .map((meta, index) => ({ meta, index, year: titleYear(meta) || 0 }))
    .filter((entry) => entry.year >= currentYear - 1 && entry.year <= currentYear + 1)
    .sort((a, b) => b.year - a.year || a.index - b.index)
    .slice(0, ROW_LIMIT)
    .map((entry) => entry.meta);
  return { id: "new", title: category === "all" ? "New releases" : `New ${categoryNoun(category)}`, variant: "poster", items };
}

function acclaimedRow(pool) {
  const rated = pool
    .map((meta, index) => ({ meta, index, rating: titleRating(meta) || 0 }))
    .filter((entry) => entry.rating >= 7);
  const strong = rated.filter((entry) => entry.rating >= 7.5);
  const chosen = strong.length >= MIN_ROW_ITEMS ? strong : rated;
  return {
    id: "acclaimed",
    title: "Critically acclaimed",
    subtitle: `IMDb ${chosen === strong ? "7.5" : "7.0"}+`,
    variant: "poster",
    items: chosen.sort((a, b) => b.rating - a.rating || a.index - b.index).slice(0, ROW_LIMIT).map((entry) => entry.meta),
  };
}

function spotlightRow(pool, seed, hero) {
  const heroIds = new Set(hero.map((meta) => meta.id));
  const candidates = pool.slice(0, 60).filter((meta) => meta.description && !heroIds.has(meta.id));
  return { id: "spotlight", title: "In the spotlight", variant: "wide", items: seededOrder(candidates, seed, "spotlight").slice(0, 10) };
}

function genreRows(pool, category, seed) {
  return GENRE_GROUPS.map((group) => {
    const genres = new Set(group.genres);
    const matches = pool.filter((meta) => (meta.genres || []).some((genre) => genres.has(genre) && !(genre === "Animation" && meta.kind === "anime")));
    return {
      id: `genre-${group.id}`,
      title: group.label,
      variant: "poster",
      items: jitteredOrder(matches, seed, `genre:${group.id}:${category}`).slice(0, ROW_LIMIT),
    };
  });
}

function discoverRow(pool, category, seed, isInLibrary) {
  const tail = pool.slice(ROW_LIMIT).filter((meta) => !isInLibrary(meta));
  return { id: "discover", title: "Discover something new", variant: "poster", items: seededOrder(tail, seed, `discover:${category}`).slice(0, ROW_LIMIT) };
}

// Library tabs partition saved titles exactly once. Anime films and anime
// series both live under Anime, while other films/series keep their own tabs.
// AniList and the catalog's anime list provide stronger evidence than names.
export function libraryCategory(item, { animeIds = new Set(), details = null } = {}) {
  const sources = Array.isArray(item?.sources) ? item.sources : [];
  const kinds = [item?.mediaKind, item?.kind, details?.kind, ...sources.map((entry) => entry?.mediaKind)];
  const animeSource = sources.some((entry) => entry?.anilist?.showId || entry?.anilistId
    || entry?.anilistImported || String(entry?.externalSource || "").toUpperCase() === "ANILIST");
  const genres = details?.genres || item?.genres || [];
  const country = String(details?.country || item?.country || "");
  const animeGenre = genres.some((genre) => String(genre).toLowerCase() === "anime")
    || (genres.some((genre) => String(genre).toLowerCase() === "animation") && /japan/i.test(country));
  if (animeSource || kinds.some((kind) => /^(?:anime|anime-movie)$/i.test(String(kind || "")))
    || (item?.catalogId && animeIds.has(item.catalogId)) || animeGenre) return "anime";
  return item?.type === "movie" || item?.catalogType === "movie" ? "movie" : "series";
}

function libraryKind(item, animeIds) {
  if (item?.mediaKind === "anime" || item?.kind === "anime") return "anime";
  if (item?.catalogId && animeIds.has(item.catalogId)) return "anime";
  return item?.type === "movie" ? "movie" : "tv";
}

/**
 * Build the Home feed for one category.
 * options.library: Library items ({ key, title, image, type, catalogId, meta }) for "From your library".
 * options.isInLibrary(meta): keeps saved titles out of "Discover".
 * Returns { category, hero: meta[], rows: [{ id, title, subtitle?, variant, ranked?, items }], total }.
 * Row variants: "poster" | "wide" (catalog metas) and "library" (Library items). ranked: true marks the
 * Top 10 row: a normal poster row whose cards carry a small position tag.
 */
export function buildHomeFeed(catalog, { category = "all", seed = 0, isInLibrary = () => false, library = [], currentYear = new Date().getFullYear() } = {}) {
  const lists = catalogLists(catalog);
  const selected = normalizeHomeCategory(category);
  const pool = selected === "all" ? uniqueById(interleave(lists.tv, lists.movie, lists.anime)) : lists[selected];
  const animeIds = new Set(lists.anime.map((meta) => meta.id));
  const saved = (Array.isArray(library) ? library : []).filter((item) => selected === "all" || libraryKind(item, animeIds) === selected);
  const noun = categoryNoun(selected);
  const hero = pickHero(selected, lists, pool, seed);
  const rows = [];
  const push = (row, min = 4) => {
    if (row.items.length >= min) rows.push(row);
  };
  // A saved catalog can be served during upstream 504s/timeouts, and Cinemeta
  // does not supply a weekly ranking timestamp. Keep this label truthful.
  const topRow = (id, items, label) => ({ id, title: `Top ${items.length} ${label}`, subtitle: "Catalog ranking", variant: "poster", ranked: true, items });

  if (selected === "all") {
    push(topRow("top-tv", lists.tv.slice(0, TOP_LIMIT), "TV shows"), 3);
    push({ id: "popular-movies", title: "Popular movies", variant: "poster", items: lists.movie.slice(0, ROW_LIMIT) });
    push({ id: "library", title: "From your library", variant: "library", items: saved.slice(0, ROW_LIMIT) }, 1);
    push({ id: "popular-anime", title: "Popular anime", variant: "poster", items: lists.anime.slice(0, ROW_LIMIT) });
    push({ id: "popular-tv", title: "Popular TV shows", variant: "poster", items: lists.tv.slice(TOP_LIMIT, TOP_LIMIT + ROW_LIMIT) });
  } else {
    push(topRow(`top-${selected}`, pool.slice(0, TOP_LIMIT), noun), 3);
    push({ id: `popular-${selected}`, title: `Popular ${noun}`, variant: "poster", items: pool.slice(TOP_LIMIT, TOP_LIMIT + ROW_LIMIT) });
    push({ id: "library", title: "From your library", variant: "library", items: saved.slice(0, ROW_LIMIT) }, 1);
  }
  push(newReleasesRow(pool, selected, currentYear));
  push(spotlightRow(pool, seed, hero));
  push(acclaimedRow(pool));
  genreRows(pool, selected, seed).forEach((row) => push(row, MIN_ROW_ITEMS));
  push(discoverRow(pool, selected, seed, isInLibrary));

  return { category: selected, hero, rows, total: pool.length };
}

// "Recommended next" on the Library page: less-popular movies and series not saved yet.
export function libraryRecommendations(catalog, { seed = 0, isInLibrary = () => false, limit = ROW_LIMIT } = {}) {
  const lists = catalogLists(catalog);
  const pick = (items, salt) => seededOrder(items.slice(ROW_LIMIT).filter((meta) => !isInLibrary(meta)), seed, salt).slice(0, limit);
  return seededOrder([...pick(lists.movie, "movies"), ...pick(lists.tv, "series")], seed, "library").slice(0, limit);
}
