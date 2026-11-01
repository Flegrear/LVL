// AniList queries for the Comics section. Requests go through the shared
// AniList client (ctx.anilist.query), so they share one queue and rate limit
// with recommendations. Adult titles are excluded unless the user turned on
// "Show adult content" (Settings › Comics; off by default): { adult: true }.

const CARD_FIELDS = `id idMal title { romaji english native userPreferred } synonyms
  coverImage { large extraLarge color } bannerImage format status chapters volumes
  averageScore popularity genres countryOfOrigin startDate { year } description(asHtml: false) isAdult siteUrl`;

const COMIC_FORMATS = "[MANGA, ONE_SHOT]";
// AniList's isAdult filter: false hides adult titles; leaving it out returns both.
const adultArg = (adult) => (adult ? "" : "isAdult: false, ");
const PAGE = (alias, args, extra = "", perPage = "$perPage", adult = false) => `${alias}: Page(perPage: ${perPage}) { media(type: MANGA, format_in: ${COMIC_FORMATS}, ${adultArg(adult)}${args}) { ${CARD_FIELDS} ${extra} } }`;
const NOT_ANIMATED_EXTRA = "relations { edges { relationType node { type } } }";

const YEAR_NOW = new Date().getFullYear();
export const HOME_SECTIONS = Object.freeze([
  Object.freeze({ id: "trending", title: "Trending now", args: "sort: TRENDING_DESC" }),
  Object.freeze({ id: "new", title: "New series", args: `status: RELEASING, startDate_greater: ${(YEAR_NOW - 1) * 10000}, sort: POPULARITY_DESC` }),
  Object.freeze({ id: "manga", title: "Popular manga", args: "countryOfOrigin: \"JP\", sort: POPULARITY_DESC" }),
  Object.freeze({ id: "manhwa", title: "Popular manhwa", args: "countryOfOrigin: \"KR\", sort: POPULARITY_DESC" }),
  Object.freeze({ id: "manhua", title: "Popular manhua", args: "countryOfOrigin: \"CN\", sort: POPULARITY_DESC" }),
  Object.freeze({ id: "top-rated", title: "Top rated", args: "sort: SCORE_DESC, popularity_greater: 20000" }),
  Object.freeze({ id: "completed", title: "Completed series", args: "status: FINISHED, sort: POPULARITY_DESC" }),
  Object.freeze({ id: "not-animated", title: "Not animated", args: "sort: SCORE_DESC, popularity_greater: 15000", extra: NOT_ANIMATED_EXTRA, pool: true }),
]);

export function homeQuery(sections = HOME_SECTIONS, { adult = false } = {}) {
  const pages = sections.map((section) => PAGE(section.id.replace(/-/g, "_"), section.args, section.extra || "", section.pool ? "$pool" : "$perPage", adult));
  return `query ($perPage: Int, $pool: Int) { ${pages.join(" ")} }`;
}

export const searchQuery = ({ adult = false } = {}) => `query ($q: String, $genre: String, $page: Int, $sort: [MediaSort]) {
  Page(page: $page, perPage: 30) { pageInfo { hasNextPage }
    media(type: MANGA, format_in: ${COMIC_FORMATS}, ${adultArg(adult)}search: $q, genre: $genre, sort: $sort) { ${CARD_FIELDS} } } }`;
export const SEARCH_QUERY = searchQuery();

// Home's comic browser (like the anime browser): the query names only the filters that are set,
// since AniList rejects some arguments given as null ("Illegal operator and value combination").
const BROWSE_ARGS = Object.freeze({
  q: ["String", "search"], genre: ["String", "genre"], sort: ["[MediaSort]", "sort"], status: ["MediaStatus", "status"], country: ["CountryCode", "countryOfOrigin"],
  formats: ["[MediaFormat]", "format_in"], from: ["FuzzyDateInt", "startDate_greater"], to: ["FuzzyDateInt", "startDate_lesser"], minPopularity: ["Int", "popularity_greater"],
});
export function browseQuery(variables = {}, { adult = false } = {}) {
  const set = Object.keys(BROWSE_ARGS).filter((name) => variables[name] !== null && variables[name] !== undefined);
  const declared = ["$page: Int", ...set.map((name) => `$${name}: ${BROWSE_ARGS[name][0]}`)].join(", ");
  const args = ["type: MANGA", ...(adult ? [] : ["isAdult: false"]), ...set.map((name) => `${BROWSE_ARGS[name][1]}: $${name}`)].join(", ");
  return `query (${declared}) { Page(page: $page, perPage: 30) { pageInfo { hasNextPage } media(${args}) { ${CARD_FIELDS} } } }`;
}
export const BROWSE_TYPES = Object.freeze({ manga: { country: "JP", formats: ["MANGA"] }, manhwa: { country: "KR", formats: ["MANGA"] },
  manhua: { country: "CN", formats: ["MANGA"] }, oneshot: { country: null, formats: ["ONE_SHOT"] } });
export const BROWSE_SORTS = Object.freeze(["POPULARITY_DESC", "SCORE_DESC", "TRENDING_DESC", "START_DATE_DESC", "FAVOURITES_DESC"]);
export const BROWSE_STATUSES = Object.freeze(["RELEASING", "FINISHED", "HIATUS", "CANCELLED", "NOT_YET_RELEASED"]);
export const BROWSE_GENRES = Object.freeze(["Action", "Adventure", "Comedy", "Drama", "Ecchi", "Fantasy", "Horror", "Mahou Shoujo", "Mecha", "Music",
  "Mystery", "Psychological", "Romance", "Sci-Fi", "Slice of Life", "Sports", "Supernatural", "Thriller"]);

// Query-string filters -> AniList variables, or an error message for a bad value.
export function browseVariables(input = {}, { year: yearNow = YEAR_NOW } = {}) {
  const get = (name) => String(input[name] ?? "").trim();
  const q = get("q").slice(0, 100);
  const type = get("type");
  const sort = get("sort") || "POPULARITY_DESC";
  const status = get("status");
  const genre = get("genre");
  const year = get("year");
  const page = Number.parseInt(get("page"), 10) || 1;
  if (type && !BROWSE_TYPES[type]) return { error: "Unknown type" };
  if (!BROWSE_SORTS.includes(sort)) return { error: "Unknown order" };
  if (status && !BROWSE_STATUSES.includes(status)) return { error: "Unknown status" };
  if (genre && !BROWSE_GENRES.includes(genre)) return { error: "Unknown genre" };
  const yearNumber = Number(year);
  if (year && (!/^\d{4}$/.test(year) || yearNumber < 1900 || yearNumber > yearNow + 1)) return { error: "Unknown year" };
  if (page < 1 || page > 50) return { error: "Unknown page" };
  const kind = BROWSE_TYPES[type] || { country: null, formats: ["MANGA", "ONE_SHOT"] };
  // Rankings by score or date skip near-empty entries (unless searching by name).
  const minPopularity = q ? null : sort === "SCORE_DESC" ? 3000 : sort === "START_DATE_DESC" ? 500 : null;
  const all = {
    page, q: q || null, genre: genre || null, status: status || null, country: kind.country, formats: kind.formats,
    sort: q ? ["SEARCH_MATCH", sort] : [sort],
    from: year ? yearNumber * 10000 : null, to: year ? (yearNumber + 1) * 10000 : null, minPopularity,
  };
  return {
    variables: Object.fromEntries(Object.entries(all).filter(([, value]) => value !== null && value !== undefined)),
    key: [q.toLowerCase(), type, sort, status, genre, year, page].join("|"),
  };
}

export const DETAILS_QUERY = `query ($id: Int) { Media(id: $id, type: MANGA) { ${CARD_FIELDS}
  staff(perPage: 6, sort: RELEVANCE) { edges { role node { name { full } } } }
  relations { edges { relationType node { id type format status title { userPreferred english romaji } coverImage { large } startDate { year } isAdult } } }
  externalLinks { site url type } } }`;

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", "#39": "'", apos: "'", nbsp: " " };

export function plainDescription(value, max = 1200) {
  const text = String(value || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_m, name) => ENTITIES[name])
    // AniList appends credits and trivia; the synopsis is what comes before them.
    .split(/\n\s*(?:Notes?|Note \d+)\s*:/i)[0]
    .replace(/^\s*\((?:Source|Sources)\s*:[^)]*\)\s*$/gim, "")
    .replace(/\(Source:[^)]*\)\s*$/i, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

const httpsUrl = (value) => {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
};

// options.adult: keep adult titles (Settings › Comics › Show adult content). Safe to use
// in .map(normalizeComic): a numeric second argument means the default (hidden).
export function normalizeComic(media, options = {}) {
  if (!media || !Number.isInteger(media.id) || (media.isAdult && options?.adult !== true)) return null;
  const title = media.title || {};
  const name = title.english || title.romaji || title.userPreferred || title.native || "Untitled";
  const aliases = [...new Set([title.english, title.romaji, title.userPreferred, title.native, ...(media.synonyms || [])]
    .filter((value) => typeof value === "string" && value.trim() && value !== name))].slice(0, 12);
  return {
    id: `anilist-${media.id}`,
    anilistId: media.id,
    malId: Number.isInteger(media.idMal) ? media.idMal : null,
    title: name,
    aliases,
    cover: httpsUrl(media.coverImage?.extraLarge || media.coverImage?.large),
    color: /^#[0-9a-f]{6}$/i.test(media.coverImage?.color || "") ? media.coverImage.color : "",
    banner: httpsUrl(media.bannerImage),
    format: media.format || "",
    status: media.status || "",
    chapters: Number.isInteger(media.chapters) ? media.chapters : null,
    volumes: Number.isInteger(media.volumes) ? media.volumes : null,
    score: Number.isFinite(media.averageScore) ? media.averageScore / 10 : null,
    popularity: Number.isFinite(media.popularity) ? media.popularity : null,
    genres: (media.genres || []).filter((genre) => typeof genre === "string").slice(0, 8),
    country: media.countryOfOrigin || "",
    year: media.startDate?.year || null,
    description: plainDescription(media.description),
    siteUrl: httpsUrl(media.siteUrl),
    ...(media.isAdult ? { adult: true } : {}),
  };
}

export function hasAnimeAdaptation(media) {
  return (media?.relations?.edges || []).some((edge) => edge?.node?.type === "ANIME"
    && ["ADAPTATION", "ALTERNATIVE", "SOURCE"].includes(edge.relationType));
}

export function normalizeHome(data, { perSection = 20, adult = false } = {}) {
  return HOME_SECTIONS.map((section) => {
    const media = data?.[section.id.replace(/-/g, "_")]?.media || [];
    const kept = section.pool ? media.filter((item) => !hasAnimeAdaptation(item)) : media;
    return { id: section.id, title: section.title, items: kept.map((item) => normalizeComic(item, { adult })).filter(Boolean).slice(0, perSection) };
  });
}

export function normalizeDetails(media, { adult = false } = {}) {
  const comic = normalizeComic(media, { adult });
  if (!comic) return null;
  const staff = (media.staff?.edges || [])
    .map((edge) => ({ name: edge?.node?.name?.full || "", role: edge?.role || "" }))
    .filter((person) => person.name).slice(0, 6);
  const relations = (media.relations?.edges || [])
    .filter((edge) => edge?.node && Number.isInteger(edge.node.id) && (adult || !edge.node.isAdult))
    .map((edge) => ({
      relation: edge.relationType || "",
      anilistId: edge.node.id,
      type: edge.node.type || "",
      format: edge.node.format || "",
      title: edge.node.title?.english || edge.node.title?.romaji || edge.node.title?.userPreferred || "",
      cover: httpsUrl(edge.node.coverImage?.large),
      year: edge.node.startDate?.year || null,
    }));
  const links = (media.externalLinks || [])
    .map((link) => ({ site: String(link?.site || ""), url: httpsUrl(link?.url), type: String(link?.type || "") }))
    .filter((link) => link.site && link.url);
  return { ...comic, staff, relations, links };
}
