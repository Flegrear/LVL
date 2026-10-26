// Public community ratings for the title header. No AniList account credentials
// are involved: these must never be confused with personal MediaList scores or
// used to establish an identity for watched-progress/score mutations.
const PUBLIC_ANIME_FIELDS = `id format episodes seasonYear status averageScore isAdult
  title { english romaji native }
  synonyms
  coverImage { medium }
  relations { edges { relationType node { id } } }`;

export const ANILIST_PUBLIC_TITLE_QUERY = `query ($search: String!) {
  Page(perPage: 50) {
    media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
      ${PUBLIC_ANIME_FIELDS}
    }
  }
}`;
export const ANILIST_PUBLIC_SEQUELS_QUERY = `query ($ids: [Int]) {
  Page(perPage: 10) {
    media(id_in: $ids, type: ANIME) {
      ${PUBLIC_ANIME_FIELDS}
    }
  }
}`;

// Read ONLY the relationships of already verified series/cour AniList IDs.
// A linked movie is a distinct catalog title, never another TV season.
export const ANILIST_PUBLIC_RELATED_MOVIES_QUERY = `query ($ids: [Int]) {
  Page(perPage: 24) {
    media(id_in: $ids, type: ANIME) {
      id relations { edges { relationType node {
        id type format isAdult seasonYear averageScore
        title { english romaji }
        coverImage { large }
      } } }
    }
  }
}`;

const MOVIE_RELATIONS = new Set(["PREQUEL", "SEQUEL", "SIDE_STORY", "PARENT"]);

// Some catalog series use the localized/dub premiere year (Dragon Ball Z is
// listed as 1996 in Cinemeta vs 1989 on AniList). For *display-only franchise
// films*, allow a verified unique original series whose exact title AND total
// episode count both match. This must not authorize ratings/watchlist writes.
export function verifiedPublicAnimeFranchiseRoot(media = [], { title = "", totalEpisodes = 0 } = {}) {
  const normalized = (value) => String(value || "").normalize("NFKC").toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
  const wanted = normalized(title);
  if (wanted.length < 3 || !Number.isSafeInteger(totalEpisodes) || totalEpisodes < 1) return null;
  const matches = (media || []).filter((item) =>
    Number.isSafeInteger(item?.id) && item.id > 0 && item.isAdult === false
    && ["TV", "TV_SHORT", "ONA"].includes(item.format) && item.episodes === totalEpisodes
    && [item.title?.english, item.title?.romaji, ...(item.synonyms || [])]
      .some((name) => normalized(name) === wanted));
  return matches.length === 1 ? matches[0].id : null;
}

/** Verify each public franchise edge before displaying a related film. */
export function relatedPublicAnimeMovies(media = [], verifiedSeriesIds = []) {
  const approved = new Set(verifiedSeriesIds.filter((id) => Number.isSafeInteger(id) && id > 0));
  const byId = new Map();
  for (const series of media || []) {
    if (!approved.has(series?.id)) continue;
    for (const edge of series?.relations?.edges || []) {
      const node = edge?.node;
      if (!MOVIE_RELATIONS.has(edge?.relationType) || node?.type !== "ANIME"
        || node?.format !== "MOVIE" || node?.isAdult
        || !Number.isSafeInteger(node?.id) || node.id <= 0 || approved.has(node.id)) continue;
      const title = String(node.title?.english || node.title?.romaji || "").trim();
      if (!title) continue;
      byId.set(node.id, { id: node.id, title,
        titleAlt: String(node.title?.romaji || "").trim(), format: "MOVIE",
        year: Number.isInteger(node.seasonYear) ? node.seasonYear : null,
        cover: /^https:\/\//.test(node.coverImage?.large || "") ? node.coverImage.large : "",
        score: Number.isFinite(node.averageScore) ? node.averageScore : null });
    }
  }
  return [...byId.values()].sort((a, b) => (a.year || 9999) - (b.year || 9999) || a.title.localeCompare(b.title)).slice(0, 40);
}

const TV_FORMATS = new Set(["TV", "TV_SHORT", "ONA"]);

const canonicalName = (value) => String(value || "")
  .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
  .replace(/\(TV\)$/i, "").replace(/\([^)]*\d{4}[^)]*\)$/i, "")
  .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
// Only public *display* identities permit common equivalent spellings; an
// authenticated episode mapping still uses the stricter canonicalName.
const canonicalDisplayName = (value) => canonicalName(String(value || "").replace(/&/g, " and "))
  .replace(/\biii\b/g, "3").replace(/\bii\b/g, "2");

const validRating = (value) => typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 100;
const ratingOf = (media) => validRating(media.averageScore) ? media.averageScore / 10 : null;
const finiteYear = (value) => Number.isInteger(value) && value >= 1900 && value <= 2200;

/** Cinemeta occasionally repeats a season's numbered chapter. An episode
 * count inflated by duplicate records should not hide a public rating.
 * This is display-only; watched progress still requires its own strict map.
 */
export function publicCatalogSeasonCounts(seasons = []) {
  return (Array.isArray(seasons) ? seasons : []).map((season) => {
    const episodes = Array.isArray(season?.episodes) ? season.episodes : [];
    const count = Number(season?.count);
    const numbers = episodes.map((item) => Number(item?.episode));
    const reliable = Number.isInteger(count) && count > 0 && episodes.length === count
      && numbers.every((episode) => Number.isInteger(episode) && episode > 0);
    const distinct = new Set(numbers);
    // Deduplication cannot establish a shorter season when its numbering has
    // gaps (e.g. 1,3,3,4 is missing episode 2, unlike 1,2,2,3).
    return reliable && numbers.every((episode) => episode <= distinct.size)
      ? { ...season, count: distinct.size } : season;
  });
}
// An airing sequel can have an AniList score before AniList knows its final
// episode count. The catalog's actual episode-one air date is the independent
// season identity needed to show that *public* score without assuming a length.
const catalogPremiereYear = (season) => {
  const first = (Array.isArray(season?.episodes) ? season.episodes : [])
    .find((episode) => Number(episode?.episode) === 1);
  const match = String(first?.released || "").match(/^(\d{4})-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])(?:$|T)/);
  const year = match ? Number(match[1]) : null;
  return finiteYear(year) ? year : null;
};
const catalogSeasons = (seasons) => (Array.isArray(seasons) ? seasons : [])
  .map((season) => ({ season: Number(season.season), count: Number(season.count), premiereYear: catalogPremiereYear(season) }))
  .filter((season) => Number.isInteger(season.season) && season.season > 0
    && Number.isInteger(season.count) && season.count > 0)
  .sort((a, b) => a.season - b.season);

// Some episode catalogs split one continuous AniList run into several seasons.
// Gintama's 201-episode first run, for example, appears as 49+50+51+51 in
// Cinemeta. Only accept a run at an exact *whole-season* boundary; never split
// an AniList rating across a partial/incompatible chapter range.
function wholeCatalogSeasonSpan(seasons, from, episodes) {
  let covered = 0;
  for (let index = from; index < seasons.length; index++) {
    if (seasons[index].season !== seasons[from].season + index - from) break;
    covered += seasons[index].count;
    if (covered === episodes) return index - from + 1;
    if (covered > episodes) break;
  }
  return 0;
}

function sequelIds(media) {
  return [...new Set((media?.relations?.edges || [])
    .filter((edge) => edge?.relationType === "SEQUEL" && Number.isSafeInteger(edge?.node?.id) && edge.node.id > 0)
    .map((edge) => edge.node.id))];
}

function nextPublicTvSequel(current, byId, displayOnly) {
  const ids = sequelIds(current);
  let nextId = null;
  if (ids.length === 1) {
    nextId = displayOnly && byId.has(ids[0])
      && !TV_FORMATS.has(byId.get(ids[0])?.format) ? null : ids[0];
  } else if (displayOnly && ids.length && ids.every((id) => byId.has(id))) {
    // A film and a TV continuation may both be listed as SEQUEL. For public
    // ratings, skip the film only after checking EVERY branch's actual format.
    const tv = ids.filter((id) => TV_FORMATS.has(byId.get(id)?.format));
    nextId = tv.length === 1 ? tv[0] : null;
  }
  if (!nextId || !byId.has(nextId)) return nextId;
  const sequel = byId.get(nextId);
  // AniList can name a true continuation entirely differently (JoJo), but an
  // explicit PREQUEL to a different media ID disproves this particular link.
  // Older records without PREQUEL metadata retain the existing SEQUEL path.
  const declaredPrequels = (sequel?.relations?.edges || [])
    .filter((edge) => edge?.relationType === "PREQUEL" && Number.isSafeInteger(edge?.node?.id))
    .map((edge) => edge.node.id);
  if (declaredPrequels.length && !declaredPrequels.includes(current.id)) return null;
  if (finiteYear(current.seasonYear) && finiteYear(sequel?.seasonYear)
    && sequel.seasonYear < current.seasonYear) return null;
  return nextId;
}

function matchingPublicRoots(media, { title, aliases, year, firstCount, seasons, allowSynonyms }) {
  const nameKey = allowSynonyms ? canonicalDisplayName : canonicalName;
  const wanted = new Set([title, ...(Array.isArray(aliases) ? aliases.slice(0, 20) : [])]
    .map(nameKey).filter(Boolean));
  if (!wanted.size || !finiteYear(year) || !Number.isInteger(firstCount) || firstCount < 1) return [];
  return (Array.isArray(media) ? media : []).filter((item) =>
    Number.isSafeInteger(item?.id) && item.id > 0 && TV_FORMATS.has(item.format)
    && Number.isInteger(item.episodes) && item.episodes > 0
    && (allowSynonyms ? (item.episodes <= firstCount
      || wholeCatalogSeasonSpan(seasons || [], 0, item.episodes) > 0) : item.episodes === firstCount)
    && finiteYear(item.seasonYear) && Math.abs(item.seasonYear - year) <= 1
    && [item.title?.english, item.title?.romaji, ...(allowSynonyms
      ? [item.title?.native, ...(Array.isArray(item.synonyms) ? item.synonyms : [])] : [])]
      .some((candidate) => wanted.has(nameKey(candidate))));
}

/** Display-only AniList ratings also apply to Chinese animation (donghua).
 * Do not reuse this flag for authenticated MediaList/watch account writes.
 */
export function eligibleForPublicAnimeRating({ mediaKind = "", genres = [], country = "" } = {}) {
  if (mediaKind === "anime") return true;
  return Array.isArray(genres) && genres.some((genre) => /^(animation|anime)$/i.test(String(genre)))
    && /\b(?:japan|china|chinese)\b/i.test(String(country));
}

/**
 * Confirm public AniList series from an unambiguous starting TV/ONA entry:
 * exact English/Romaji title (allowing "(TV)"), first release year and
 * first season's exact episode count. Then follow ONLY explicit SEQUEL edges,
 * accumulating contiguous cour/part counts into the catalog's season lengths.
 * Unlike progress syncing, this is display-only; a public match NEVER saves
 * an AniList association or authorizes any remote write.
 */
export function matchPublicAniListSeasons({ media = [], title = "", aliases = [], year = null, seasons = [],
  allowSynonyms = false } = {}) {
  const catalog = catalogSeasons(seasons);
  if (!catalog.length || catalog[0].season !== 1) return null;
  const allById = new Map((Array.isArray(media) ? media : [])
    .filter((item) => Number.isSafeInteger(item?.id) && item.id > 0)
    .map((item) => [item.id, item]));
  const byId = new Map((Array.isArray(media) ? media : [])
    .filter((item) => Number.isSafeInteger(item?.id) && item.id > 0 && TV_FORMATS.has(item.format)
      && ((Number.isInteger(item.episodes) && item.episodes > 0)
        || (allowSynonyms && item.episodes == null && item.status === "RELEASING")))
    .map((item) => [item.id, item]));
  const roots = matchingPublicRoots([...byId.values()], {
    title, aliases, year, firstCount: catalog[0].count, seasons: catalog, allowSynonyms,
  });
  if (roots.length !== 1) return null;

  const seasonRows = [];
  const seen = new Set();
  let current = roots[0];
  for (let seasonIndex = 0; seasonIndex < catalog.length; seasonIndex++) {
    const season = catalog[seasonIndex];
    // A missing catalog season makes subsequent AniList continuation offsets
    // uncertain; never relabel the next sequel as a later season.
    if (seasonIndex && season.season !== catalog[seasonIndex - 1].season + 1) break;
    // AniList leaves `episodes` null for some currently airing sequels (e.g.
    // Black Clover's 2026 second season). A unique verified SEQUEL edge, TV
    // format, RELEASING status and independently dated episode-one premiere
    // permit the *display-only* community score. The unknown episode total is
    // never inferred from the catalog, nor used for watched-progress mapping.
    if (allowSynonyms && seasonIndex > 0 && current && !seen.has(current.id)
      && current.episodes == null && current.status === "RELEASING"
      && finiteYear(current.seasonYear) && current.seasonYear === season.premiereYear) {
      seen.add(current.id);
      const part = { id: current.id, title: current.title?.english || current.title?.romaji || `AniList #${current.id}`,
        cover: current.coverImage?.medium || "", episodes: null, format: current.format,
        year: current.seasonYear, score: ratingOf(current) };
      seasonRows.push({ season: season.season, score: part.score, parts: [part] });
      // A later season cannot be aligned until this run's final length is known.
      break;
    }
    if (allowSynonyms && current && current.episodes > season.count) {
      const span = wholeCatalogSeasonSpan(catalog, seasonIndex, current.episodes);
      if (!span || seen.has(current.id)) break;
      seen.add(current.id);
      const part = { id: current.id, title: current.title?.english || current.title?.romaji || `AniList #${current.id}`,
        cover: current.coverImage?.medium || "", episodes: current.episodes, format: current.format,
        year: current.seasonYear, score: ratingOf(current) };
      const sharedSeasons = catalog.slice(seasonIndex, seasonIndex + span).map((item) => item.season);
      for (const dividedSeason of catalog.slice(seasonIndex, seasonIndex + span)) {
        seasonRows.push({ season: dividedSeason.season, score: part.score, parts: [part],
          sharedSeasons });
      }
      const nextId = nextPublicTvSequel(current, allById, true);
      current = nextId && !seen.has(nextId) ? byId.get(nextId) : null;
      seasonIndex += span - 1;
      if (!current) break;
      continue;
    }
    const parts = [];
    let covered = 0;
    while (current && !seen.has(current.id) && covered < season.count) {
      // A currently airing title may report episodes=null. Only the independently
      // dated standalone-season exception above can use it; null is never a
      // zero-length cour inside an otherwise "complete" catalog season.
      if (!Number.isSafeInteger(current.episodes) || current.episodes <= 0) break;
      if (covered + current.episodes > season.count) break;
      seen.add(current.id);
      parts.push({ id: current.id, title: current.title?.english || current.title?.romaji || `AniList #${current.id}`,
        cover: current.coverImage?.medium || "", episodes: current.episodes, format: current.format,
        year: current.seasonYear, score: ratingOf(current) });
      covered += current.episodes;
      // The graph may fork into alternate continuations. An unseen branch is
      // still a branch: never pick whichever single sequel appeared in search.
      const nextId = nextPublicTvSequel(current, allById, allowSynonyms);
      current = nextId && !seen.has(nextId) ? byId.get(nextId) : null;
    }
    if (covered !== season.count) break; // Never label a partial or wrong cour as a complete season.
    // An incomplete community average for one cour is not a full season score.
    // Keep each part's actual rating visible without mislabelling the season.
    const rated = parts.filter((part) => part.score !== null);
    const score = rated.length === parts.length
      ? rated.reduce((sum, part) => sum + part.score, 0) / rated.length : null;
    seasonRows.push({ season: season.season, score, parts });
    if (!current) break;
  }
  if (!seasonRows.length) return null;
  const ratedSeasons = seasonRows.filter((season) => season.score !== null);
  return {
    score: ratedSeasons.length ? ratedSeasons.reduce((sum, season) => sum + season.score, 0) / ratedSeasons.length : null,
    seasons: seasonRows,
    totalSeasons: catalog.length,
    ratedSeasons: ratedSeasons.length,
    ...(allowSynonyms ? { displayOnly: true } : {}),
  };
}

/**
 * An automatic WATCH link has stricter requirements than a display-only
 * community rating: every catalog season and every cour must form a complete,
 * gapless chain; the first release year must agree exactly. A partial or
 * ambiguous result is never eligible for a saved watched-progress mapping.
 * The returned fields are local metadata, not AniList MediaList entries.
 */
export function verifiedPublicAniListLinks(match, { userId, year, catalogId } = {}) {
  if (!Number.isSafeInteger(userId) || userId <= 0 || !finiteYear(year)
    || !/^tt\d{5,12}$/.test(String(catalogId || ""))
    || !match || match.displayOnly || !Number.isSafeInteger(match.totalSeasons) || match.totalSeasons < 1
    || !Array.isArray(match.seasons) || match.seasons.length !== match.totalSeasons
    || match.seasons.length > 24) return [];
  const firstPart = match.seasons[0]?.parts?.[0];
  if (firstPart?.year !== year) return [];
  const ids = new Set();
  const result = [];
  for (const [index, season] of match.seasons.entries()) {
    if (season.season !== index + 1 || !Array.isArray(season.parts) || !season.parts.length) return [];
    let start = 1;
    for (const part of season.parts) {
      if (!Number.isSafeInteger(part.id) || part.id <= 0 || ids.has(part.id)
        || !TV_FORMATS.has(part.format) || !Number.isSafeInteger(part.episodes) || part.episodes <= 0
        || !finiteYear(part.year) || !part.title) return [];
      ids.add(part.id);
      result.push({ userId, season: season.season, anilistId: part.id,
        episodes: part.episodes, format: part.format, title: part.title,
        start, end: start + part.episodes - 1, catalogId,
      });
      start += part.episodes;
    }
  }
  return result;
}

/** Only public, anonymous browser-side requests; never supply an OAuth token. */
async function publicAniListGraphql(query, variables, fetchImpl) {
  const response = await fetchImpl("https://graphql.anilist.co", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15_000),
    referrerPolicy: "no-referrer",
    credentials: "omit",
  });
  if (!response.ok) throw new Error(`AniList public ratings unavailable (HTTP ${response.status}).`);
  const payload = await response.json();
  if (payload?.errors?.length || !Array.isArray(payload?.data?.Page?.media)) throw new Error("AniList returned incomplete public ratings.");
  return payload.data.Page.media;
}

export async function fetchPublicAniListTitle(search, { fetchImpl = fetch } = {}) {
  const value = String(search || "").trim().slice(0, 160);
  if (value.length < 2) return [];
  return publicAniListGraphql(ANILIST_PUBLIC_TITLE_QUERY, { search: value }, fetchImpl);
}

export async function fetchPublicAniListSequels(ids, { fetchImpl = fetch } = {}) {
  const unique = [...new Set((Array.isArray(ids) ? ids : [])
    .filter((id) => Number.isSafeInteger(id) && id > 0))].slice(0, 10);
  if (!unique.length) return [];
  return publicAniListGraphql(ANILIST_PUBLIC_SEQUELS_QUERY, { ids: unique }, fetchImpl);
}

export async function fetchPublicAnimeRelatedMovies(ids, { fetchImpl = fetch } = {}) {
  const unique = [...new Set((Array.isArray(ids) ? ids : [])
    .filter((id) => Number.isSafeInteger(id) && id > 0))].slice(0, 24);
  if (!unique.length) return [];
  const media = await publicAniListGraphql(ANILIST_PUBLIC_RELATED_MOVIES_QUERY, { ids: unique }, fetchImpl);
  return relatedPublicAnimeMovies(media, unique);
}

function missingUniqueSequel(media, rootId) {
  const byId = new Map(media.map((item) => [item?.id, item]));
  const visited = new Set();
  let cursor = byId.get(rootId);
  for (let depth = 0; cursor && depth < 24 && !visited.has(cursor.id); depth++) {
    visited.add(cursor.id);
    const next = sequelIds(cursor);
    if (!next.length) return [];
    const missing = next.filter((id) => !byId.has(id));
    if (missing.length) return missing.length <= 10 ? missing : [];
    const nextId = nextPublicTvSequel(cursor, byId, true);
    if (!nextId || visited.has(nextId)) return [];
    cursor = byId.get(nextId);
  }
  return [];
}

/** Retry a small number of distinct catalog aliases, but only accept a unique
 * AniList starting entry with matching year, episode count and name/synonym.
 * Read-only display metadata: this is intentionally separate from auto-linking
 * authenticated watched progress, which uses the stricter matcher defaults.
 */
export async function fetchMatchedPublicAniListSeasons({ title = "", aliases = [], year = null, seasons = [] } = {},
  { fetchTitle = fetchPublicAniListTitle, fetchSequels = fetchPublicAniListSequels } = {}) {
  const names = [...new Set([title, ...(Array.isArray(aliases) ? aliases : [])]
    .map((name) => String(name || "").trim().slice(0, 160)).filter((name) => name.length >= 2))]
    // AniList's SEARCH_MATCH may index "&" and "and" separately even when
    // our verified identity matcher considers them equivalent.
    .filter((name, index, array) => array.findIndex((other) =>
      other.normalize("NFKC").toLowerCase() === name.normalize("NFKC").toLowerCase()) === index)
    .slice(0, 3);
  const seen = new Map();
  for (const name of names) {
    const results = await fetchTitle(name);
    for (const item of results) {
      if (Number.isSafeInteger(item?.id) && item.id > 0) seen.set(item.id, item);
    }
  }
  const catalog = catalogSeasons(seasons);
  if (!catalog.length) return null;
  // Consider every searched alias before picking a root. Returning after the
  // first successful query hides ambiguous second roots and renamed sequels.
  const rootCandidates = matchingPublicRoots([...seen.values()], {
    title, aliases, year, firstCount: catalog[0].count, seasons: catalog, allowSynonyms: true,
  });
  if (rootCandidates.length !== 1) return null;
  const rootId = rootCandidates[0].id;
  let match = matchPublicAniListSeasons({ media: [...seen.values()], title, aliases,
    year, seasons, allowSynonyms: true });
  // AniList search is by name; later SEQUELs often have completely different
  // names (JoJo, Monogatari). Follow ONLY unique explicit sequel IDs and cap
  // anonymous requests. No public lookup can create an authenticated link.
  const requested = new Set();
  for (let step = 0; step < 10 && (!match || match.seasons.length < catalog.length); step++) {
    const missingIds = missingUniqueSequel([...seen.values()], rootId).filter((id) => !requested.has(id));
    if (!missingIds.length || requested.size + missingIds.length > 10) break;
    missingIds.forEach((id) => requested.add(id));
    let added;
    try { added = await fetchSequels(missingIds); }
    catch { break; } // Preserve confirmed earlier seasons during upstream failure.
    if (!missingIds.every((id) => added.some((item) => item?.id === id))) break;
    for (const item of added) if (Number.isSafeInteger(item?.id) && item.id > 0) seen.set(item.id, item);
    match = matchPublicAniListSeasons({ media: [...seen.values()], title, aliases,
      year, seasons, allowSynonyms: true });
  }
  return match;
}
