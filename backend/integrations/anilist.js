/**
 * AniList (public GraphQL API, no key): a linked user's anime list with scores, anime details
 * (community score and voters, genres, tags, studios, relations) with the "fans also recommend"
 * votes, and title search for matching your titles. One request at a time, a gap between
 * requests (the limit is 30–90 a minute), and a 429 waits for Retry-After.
 */

export const ANILIST_ENDPOINT = "https://graphql.anilist.co";
export const DETAILS_BATCH = 25;
const LINKS_PER_ANIME = 25;

const LIST_QUERY = `query ($name: String) {
  MediaListCollection(userName: $name, type: ANIME) {
    user { id name }
    lists { entries {
      status progress score(format: POINT_10_DECIMAL) updatedAt
      media { id idMal format seasonYear episodes isAdult genres averageScore popularity title { romaji english } coverImage { extraLarge large } }
    } }
  }
}`;

const DETAILS_FIELDS = `id idMal format seasonYear episodes isAdult title { romaji english } description(asHtml: false) coverImage { extraLarge large } bannerImage
  averageScore popularity genres tags { name rank isMediaSpoiler isGeneralSpoiler isAdult } studios(isMain: true) { nodes { name } }
  stats { scoreDistribution { score amount } } relations { edges { relationType node { id type format } } }`;

const DETAILS_QUERY = `query ($ids: [Int], $per: Int, $links: Int, $withLinks: Boolean!) { Page(perPage: $per) { media(id_in: $ids, type: ANIME) {
  ${DETAILS_FIELDS}
  recommendations(sort: RATING_DESC, perPage: $links) @include(if: $withLinks) { nodes { rating mediaRecommendation { id } } }
} } }`;

const SEARCH_QUERY = `query ($q: String) { Page(perPage: 8) { media(search: $q, type: ANIME, sort: SEARCH_MATCH) {
  id format seasonYear popularity isAdult title { romaji english native } synonyms
} } }`;

const cleanDescription = (value) => String(value || "")
  .replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\(Source:[^)]*\)/gi, " ")
  .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&amp;/g, "&")
  .replace(/\s+/g, " ").trim().slice(0, 900);

const anilistId = (id) => `anilist:${Number(id)}`;

/** Our record of one AniList entry (a season, part or movie). */
export function normalizeAniListMedia(media, fetchedAt = Date.now()) {
  if (!media || !Number.isInteger(Number(media.id))) return null;
  const distribution = Array.isArray(media.stats?.scoreDistribution) ? media.stats.scoreDistribution : [];
  const scoredBy = distribution.reduce((sum, bucket) => sum + (Number(bucket.amount) || 0), 0);
  const liked = distribution.filter((bucket) => Number(bucket.score) >= 80).reduce((sum, bucket) => sum + (Number(bucket.amount) || 0), 0);
  return {
    itemId: anilistId(media.id),
    source: "anilist",
    sourceId: String(media.id),
    kind: "anime",
    title: media.title?.english || media.title?.romaji || `AniList ${media.id}`,
    titleAlt: media.title?.english && media.title?.romaji && media.title.romaji !== media.title.english ? media.title.romaji : "",
    format: media.format || "",
    year: Number.isInteger(media.seasonYear) ? media.seasonYear : null,
    episodes: Number.isInteger(media.episodes) ? media.episodes : null,
    score: Number.isFinite(media.averageScore) ? media.averageScore : null,
    scoredBy: scoredBy || null,
    likedShare: scoredBy ? Math.round((liked / scoredBy) * 1000) / 1000 : null,
    popularity: Number.isFinite(media.popularity) ? media.popularity : null,
    genres: Array.isArray(media.genres) ? media.genres : [],
    tags: (Array.isArray(media.tags) ? media.tags : [])
      .filter((tag) => tag?.name && !tag.isMediaSpoiler && !tag.isGeneralSpoiler && !tag.isAdult)
      .slice(0, 15)
      .map((tag) => ({ name: tag.name, weight: Number(tag.rank) || 50 })),
    studios: (media.studios?.nodes || []).map((studio) => studio?.name).filter(Boolean),
    relations: (media.relations?.edges || [])
      .filter((edge) => edge?.node?.type === "ANIME" && edge.relationType)
      .map((edge) => ({ type: edge.relationType, id: anilistId(edge.node.id), format: edge.node.format || "" })),
    description: cleanDescription(media.description),
    cover: media.coverImage?.extraLarge || media.coverImage?.large || "",
    banner: media.bannerImage || "",
    adult: Boolean(media.isAdult),
    malId: Number.isInteger(media.idMal) ? media.idMal : null,
    fetchedAt,
  };
}

/** "Fans also recommend" links with their net votes (only those with more up than down votes). */
export function normalizeAniListLinks(media) {
  return (media?.recommendations?.nodes || [])
    .filter((node) => node?.mediaRecommendation?.id && Number(node.rating) > 0)
    .map((node) => ({ to: anilistId(node.mediaRecommendation.id), votes: Number(node.rating) }));
}

/** The linked list: one rating per entry (scores 0 = none), skipping adult titles. */
export function normalizeAniListList(payload) {
  const collection = payload?.MediaListCollection;
  const seen = new Set();
  const entries = [];
  for (const list of collection?.lists || []) {
    for (const entry of list?.entries || []) {
      const media = entry?.media;
      if (!media?.id || media.isAdult || seen.has(media.id)) continue;
      seen.add(media.id);
      const score = Number(entry.score);
      const updatedAt = Number(entry.updatedAt) > 0 ? Number(entry.updatedAt) * 1000 : null;
      entries.push({
        key: String(media.id),
        itemId: anilistId(media.id),
        title: media.title?.english || media.title?.romaji || `AniList ${media.id}`,
        kind: "anime",
        year: Number.isInteger(media.seasonYear) ? media.seasonYear : null,
        score: score > 0 ? Math.round(Math.min(10, score) * 100) / 100 : null,
        status: entry.status || null,
        progress: Number.isInteger(entry.progress) ? entry.progress : null,
        ratedAt: updatedAt,
        updatedAt: updatedAt || Date.now(),
        media: {
          itemId: anilistId(media.id), source: "anilist", sourceId: String(media.id), kind: "anime",
          title: media.title?.english || media.title?.romaji || `AniList ${media.id}`,
          titleAlt: media.title?.english && media.title?.romaji !== media.title?.english ? media.title?.romaji || "" : "",
          format: media.format || "", year: Number.isInteger(media.seasonYear) ? media.seasonYear : null,
          episodes: Number.isInteger(media.episodes) ? media.episodes : null, score: Number.isFinite(media.averageScore) ? media.averageScore : null,
          popularity: Number.isFinite(media.popularity) ? media.popularity : null, genres: Array.isArray(media.genres) ? media.genres : [],
          cover: media.coverImage?.extraLarge || media.coverImage?.large || "", adult: false, malId: Number.isInteger(media.idMal) ? media.idMal : null,
          // Only the list's basics: marked old so the full details are read when needed.
          fetchedAt: 1,
        },
      });
    }
  }
  return { user: collection?.user || null, entries };
}

const normalizeTitle = (value) => String(value || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
  .replace(/\b(?:the|season \d+|part \d+|\d+(?:st|nd|rd|th) season)\b/g, " ").replace(/[^a-z0-9]+/g, " ").trim();

/** The search result that is the same show: title match, then year, format and popularity. */
export function bestAniListMatch(results = [], { title = "", year = null, movie = false } = {}) {
  const wanted = normalizeTitle(title);
  let best = null;
  for (const media of results) {
    if (!media?.id || media.isAdult) continue;
    const names = [media.title?.english, media.title?.romaji, media.title?.native, ...(media.synonyms || [])].map(normalizeTitle).filter(Boolean);
    let score = names.includes(wanted) ? 6 : names.some((name) => name.startsWith(wanted) || wanted.startsWith(name)) ? 3 : 0;
    if (Number.isInteger(year) && Number.isInteger(media.seasonYear)) score += Math.abs(media.seasonYear - year) <= 1 ? 3 : -2;
    if (movie ? media.format === "MOVIE" : ["TV", "ONA", "TV_SHORT"].includes(media.format)) score += 2;
    score += Math.min(1, (Number(media.popularity) || 0) / 200000);
    if (!best || score > best.score) best = { score, media };
  }
  return best && best.score >= 3 ? best.media : null;
}

export function createAniListClient({ endpoint = ANILIST_ENDPOINT, fetchImpl = globalThis.fetch, minGapMs = 2100, timeoutMs = 20_000, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  let queue = Promise.resolve();
  let lastAt = 0;
  let requests = 0;

  async function send(query, variables, attempt = 0, raw = false) {
    const wait = lastAt + minGapMs - now();
    if (wait > 0) await sleep(wait);
    lastAt = now();
    requests += 1;
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 429 && attempt < 2) {
      const seconds = Math.min(65, Math.max(5, Number(response.headers?.get?.("retry-after")) || 60));
      await sleep(seconds * 1000);
      return send(query, variables, attempt + 1, raw);
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.errors?.length) {
      const message = payload?.errors?.[0]?.message || `AniList answered HTTP ${response.status}`;
      throw Object.assign(new Error(!raw && /not found/i.test(message) ? "That AniList user wasn't found, or their list is private." : message), { status: response.status });
    }
    return payload?.data || {};
  }

  const request = (query, variables, raw = false) => {
    const run = queue.then(() => send(query, variables, 0, raw));
    queue = run.catch(() => {});
    return run;
  };

  return {
    get requests() { return requests; },
    /** Any AniList GraphQL query, through the same queue and rate limit as the methods below. */
    async query(query, variables = {}) {
      if (typeof query !== "string" || !query.trim()) throw new Error("AniList query must be a non-empty string");
      return request(query, variables, true);
    },
    async userList(username) {
      return normalizeAniListList(await request(LIST_QUERY, { name: String(username || "").trim() }));
    },
    /** Details (and, with links, the fans' recommendations) for up to DETAILS_BATCH ids per request. */
    async details(ids = [], { links = false } = {}) {
      const numbers = [...new Set(ids.map((id) => Number(String(id).replace(/^anilist:/, ""))).filter(Number.isInteger))];
      const out = [];
      for (let index = 0; index < numbers.length; index += DETAILS_BATCH) {
        const batch = numbers.slice(index, index + DETAILS_BATCH);
        const data = await request(DETAILS_QUERY, { ids: batch, per: batch.length, links: LINKS_PER_ANIME, withLinks: Boolean(links) });
        const fetchedAt = now();
        for (const media of data?.Page?.media || []) {
          const item = normalizeAniListMedia(media, fetchedAt);
          if (item) out.push({ item, links: links ? normalizeAniListLinks(media) : null });
        }
      }
      return out;
    },
    async search(title) {
      const data = await request(SEARCH_QUERY, { q: String(title || "").slice(0, 120) });
      return data?.Page?.media || [];
    },
  };
}
