// Public, read-only release schedules. Times are preserved as instants so the
// browser can place episodes on the correct day in the viewer's timezone.
import { tmdbAuth } from "../integrations/tmdb.js";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const ANILIST_QUERY = `query ($page: Int, $from: Int, $to: Int, $ids: [Int]) {
  Page(page: $page, perPage: 50) {
    pageInfo { hasNextPage lastPage }
    airingSchedules(mediaId_in: $ids, airingAt_greater: $from, airingAt_lesser: $to, sort: TIME) {
      id airingAt episode
      media { id format isAdult seasonYear title { english romaji } coverImage { large } }
    }
  }
}`;
// AniList may return HTTP 500 for mediaId_in: null. Use a separate query
// without that argument when requesting the global airing feed.
const ANILIST_PUBLIC_QUERY = `query ($page: Int, $from: Int, $to: Int) {
  Page(page: $page, perPage: 50) {
    pageInfo { hasNextPage lastPage }
    airingSchedules(airingAt_greater: $from, airingAt_lesser: $to, sort: TIME) {
      id airingAt episode
      media { id format isAdult seasonYear title { english romaji } coverImage { large } }
    }
  }
}`;
// A general airing schedule is capped at 20 pages. Query the linked user's
// exact media IDs as well so busy weeks do not hide their next episodes.
const ANILIST_NEXT_QUERY = `query ($ids: [Int]) {
  Page(perPage: 50) {
    media(id_in: $ids, type: ANIME) {
      id format isAdult title { english romaji } coverImage { large }
      nextAiringEpisode { id airingAt episode }
    }
  }
}`;
// A saved AniList entry identifies a season, not the whole show. Follow
// AniList's explicit SEQUEL relations to find later TV seasons, including
// entries absent from the user's MediaList and from busy public schedules.
const ANILIST_FAMILY_QUERY = `query ($ids: [Int]) {
  Page(perPage: 50) {
    media(id_in: $ids, type: ANIME) {
      id format isAdult title { english romaji } coverImage { large }
      nextAiringEpisode { id airingAt episode }
      relations { edges { relationType node { id type format } } }
    }
  }
}`;
const TV_FORMATS = new Set(["TV", "TV_SHORT", "ONA"]);

export function releaseRange(from, to) {
  if (!DATE.test(from || "") || !DATE.test(to || "")) return null;
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)
    || new Date(start).toISOString().slice(0, 10) !== from
    || new Date(end).toISOString().slice(0, 10) !== to
    || start > end || end - start > 99 * DAY_MS) return null;
  return { from, to, start, end };
}

const validImage = (url) => typeof url === "string" && /^https:\/\//.test(url) ? url : "";
const isoDate = (milliseconds) => new Date(milliseconds).toISOString().slice(0, 10);
const safeText = (value, max = 180) => String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
const imdbId = (value) => /^tt\d{5,12}$/.test(String(value || "")) ? value : "";

export function normalizeAniListAiring(row) {
  const media = row?.media;
  const when = Number(row?.airingAt) * 1000;
  if (!Number.isSafeInteger(Number(row?.id)) || !media?.id || media.isAdult || !Number.isFinite(when) || when <= 0) return null;
  return {
    id: `anilist:${row.id}`, providerId: String(media.id),
    title: safeText(media.title?.english || media.title?.romaji),
    episodeTitle: `Episode ${Number(row.episode) || "?"}`, code: `EP ${Number(row.episode) || "?"}`,
    date: isoDate(when), timestamp: when, verifiedTime: true,
    artwork: validImage(media.coverImage?.large), thumbnail: "",
    type: media.format === "MOVIE" ? "movie" : "anime", source: "AniList",
    preview: false, watched: false,
  };
}

export function normalizeTvmazeAiring(row) {
  const show = row?.show || row?._embedded?.show;
  if (!row?.id || !show?.name) return null;
  const stamp = Date.parse(row.airstamp || "");
  const hasTime = Number.isFinite(stamp);
  const date = hasTime ? isoDate(stamp) : row.airdate;
  if (!releaseRange(date, date)) return null;
  const season = Number(row.season);
  const episode = Number(row.number);
  const code = Number.isInteger(season) && Number.isInteger(episode) && episode > 0
    ? `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}` : "Episode";
  return {
    id: `tvmaze:${row.id}`, providerId: String(show.id),
    catalogId: imdbId(show.externals?.imdb),
    title: safeText(show.name), episodeTitle: safeText(row.name || "Episode"),
    code, date, timestamp: hasTime ? stamp : null, verifiedTime: hasTime,
    artwork: validImage(show.image?.medium || show.image?.original),
    thumbnail: validImage(row.image?.medium), type: "series",
    source: "TVmaze", preview: false, watched: false,
  };
}

export function normalizeTmdbPremiere(row) {
  const date = row?.release_date;
  if (!row?.id || !releaseRange(date, date) || row.adult) return null;
  return {
    id: `tmdb:movie:${row.id}`, providerId: String(row.id),
    title: safeText(row.title || row.original_title), episodeTitle: "Movie premiere",
    code: "PREMIERE", date, timestamp: null, verifiedTime: false,
    artwork: /^\/[\w/-]+\.(?:jpg|png|webp)$/.test(row.poster_path || "")
      ? `https://image.tmdb.org/t/p/w500${row.poster_path}` : "",
    thumbnail: "", type: "movie", source: "TMDb",
    preview: false, watched: false,
  };
}

export function createReleaseCalendarService({
  fetchImpl = globalThis.fetch, getTmdbKey = () => "",
  anilistEndpoint = "https://graphql.anilist.co",
  tvmazeEndpoint = "https://api.tvmaze.com/schedule/full",
  tmdbEndpoint = "https://api.themoviedb.org/3",
  now = Date.now,
} = {}) {
  const cache = new Map();
  const familyCache = new Map();
  let tvmazeSnapshot = null;
  let tvmazeRequest = null;

  async function jsonFetch(url, options = {}, timeout = 25_000) {
    const response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(timeout) });
    if (!response.ok) throw new Error(`Release provider HTTP ${response.status}`);
    return response.json();
  }

  // Keep a small number of provider requests in flight. A busy month can have
  // dozens of pages, and fetching each page sequentially blocked the calendar.
  async function remainingPages(lastPage, loadPage) {
    let nextPage = 2;
    await Promise.all(Array.from({ length: Math.min(3, Math.max(0, lastPage - 1)) }, async () => {
      while (nextPage <= lastPage) await loadPage(nextPage++);
    }));
  }

  async function anime(range, mediaIds = null) {
    const result = [];
    let complete = false;
    // Timezone margins: UTC query includes events that land on adjoining local days.
    const from = Math.floor((range.start - DAY_MS) / 1000) - 1;
    const to = Math.floor((range.end + 2 * DAY_MS) / 1000) + 1;
    const fetchPage = async (page) => {
      const payload = await jsonFetch(anilistEndpoint, {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          query: mediaIds === null ? ANILIST_PUBLIC_QUERY : ANILIST_QUERY,
          variables: mediaIds === null ? { page, from, to } : { page, from, to, ids: mediaIds },
        }),
      });
      if (payload?.errors?.length) throw new Error(payload.errors[0]?.message || "AniList query failed");
      for (const row of payload?.data?.Page?.airingSchedules || []) {
        const event = normalizeAniListAiring(row);
        if (event) result.push(event);
      }
      return payload?.data?.Page?.pageInfo || {};
    };
    const firstPage = await fetchPage(1);
    if (firstPage.hasNextPage === false) complete = true;
    else {
      // The global AniList endpoint sometimes reports lastPage=100 for a
      // schedule with only ~7 pages. Do not prefetch 20 unnecessary pages:
      // inspect consecutive small batches and stop on hasNextPage=false.
      for (let first = 2; first <= 20; first += 3) {
        const pages = Array.from({ length: Math.min(3, 21 - first) }, (_, i) => first + i);
        const responses = await Promise.allSettled(pages.map(fetchPage));
        if (responses.some((response) => response.status === "rejected")) break;
        if (responses.some((response) => response.value.hasNextPage === false)) {
          complete = true;
          break;
        }
      }
    }
    return { events: result, complete };
  }

  async function animeNext(anilistIds) {
    const events = [];
    for (let start = 0; start < anilistIds.length; start += 50) {
      const ids = anilistIds.slice(start, start + 50);
      const payload = await jsonFetch(anilistEndpoint, {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ query: ANILIST_NEXT_QUERY, variables: { ids } }),
      });
      if (payload?.errors?.length) throw new Error(payload.errors[0]?.message || "AniList next episode query failed");
      for (const media of payload?.data?.Page?.media || []) {
        if (!media?.nextAiringEpisode) continue;
        const event = normalizeAniListAiring({ ...media.nextAiringEpisode, media });
        if (event) events.push(event);
      }
    }
    return events;
  }

  async function animeFamily(seedIds, force = false) {
    const key = seedIds.join(",");
    const cached = familyCache.get(key);
    if (!force && cached && now() - cached.at < 15 * 60_000) return cached.promise;
    const promise = (async () => {
      const origins = new Map(seedIds.map((id) => [id, new Set([id])]));
      const details = new Map();
      const fetched = new Set();
      let frontier = new Set(seedIds);
      for (let depth = 0; depth < 12 && frontier.size; depth++) {
        const missing = [...frontier].filter((id) => !fetched.has(id));
        for (let start = 0; start < missing.length; start += 50) {
          const ids = missing.slice(start, start + 50);
          const payload = await jsonFetch(anilistEndpoint, {
            method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ query: ANILIST_FAMILY_QUERY, variables: { ids } }),
          });
          if (payload?.errors?.length) throw new Error(payload.errors[0]?.message || "AniList relations unavailable");
          if (!Array.isArray(payload?.data?.Page?.media)) throw new Error("AniList relations response incomplete");
          ids.forEach((id) => fetched.add(id));
          for (const media of payload.data.Page.media) {
            if (Number.isSafeInteger(media?.id) && !media.isAdult) details.set(media.id, media);
          }
        }
        const next = new Set();
        for (const id of frontier) {
          const media = details.get(id);
          if (!media) continue;
          const continuations = [...new Set((media.relations?.edges || [])
            .filter((edge) => edge?.relationType === "SEQUEL" && edge.node?.type === "ANIME"
              && TV_FORMATS.has(edge.node.format) && Number.isSafeInteger(edge.node.id) && edge.node.id > 0)
            .map((edge) => edge.node.id))];
          // Two TV sequel branches cannot be assumed to be one continuous show.
          if (continuations.length !== 1) continue;
          const sequelId = continuations[0];
          const linked = origins.get(sequelId) || new Set();
          const before = linked.size;
          for (const origin of origins.get(id) || []) linked.add(origin);
          if (linked.size !== before) {
            if (!origins.has(sequelId) && origins.size >= 350) continue;
            origins.set(sequelId, linked);
            next.add(sequelId);
          }
        }
        frontier = next;
      }
      const linkedById = new Map([...origins].map(([id, linked]) => [id, [...linked].sort((a, b) => a - b)]));
      const events = [...details.values()].flatMap((media) => {
        if (!media.nextAiringEpisode) return [];
        const event = normalizeAniListAiring({ ...media.nextAiringEpisode, media });
        return event ? [{ ...event, linkedAniListIds: linkedById.get(media.id) || [] }] : [];
      });
      return { linkedById, events };
    })();
    familyCache.set(key, { at: now(), promise });
    promise.catch(() => { if (familyCache.get(key)?.promise === promise) familyCache.delete(key); });
    if (familyCache.size > 6) familyCache.delete(familyCache.keys().next().value);
    return promise;
  }

  async function tv() {
    if (tvmazeSnapshot && now() - tvmazeSnapshot.at < 6 * 60 * 60_000) return tvmazeSnapshot.events;
    if (!tvmazeRequest) {
      tvmazeRequest = jsonFetch(tvmazeEndpoint, {}, 35_000)
        .then((data) => {
          if (!Array.isArray(data)) throw new Error("TVmaze schedule was not a list");
          const events = data.map(normalizeTvmazeAiring).filter(Boolean);
          tvmazeSnapshot = { at: now(), events };
          return events;
        })
        .finally(() => { tvmazeRequest = null; });
    }
    return tvmazeRequest;
  }

  async function movies(range, key) {
    const auth = tmdbAuth(key);
    if (!auth) return { events: [], complete: false, needsKey: true };
    const result = [];
    let complete = false;
    const fetchPage = async (page) => {
      const url = new URL(`${tmdbEndpoint}/discover/movie`);
      url.searchParams.set("primary_release_date.gte", range.from);
      url.searchParams.set("primary_release_date.lte", range.to);
      url.searchParams.set("sort_by", "primary_release_date.asc");
      url.searchParams.set("include_adult", "false");
      url.searchParams.set("page", String(page));
      if (auth.query) url.searchParams.set("api_key", auth.query);
      const data = await jsonFetch(url, { headers: { Accept: "application/json", ...(auth.header ? { Authorization: auth.header } : {}) } });
      for (const row of data?.results || []) {
        const event = normalizeTmdbPremiere(row);
        if (event) result.push(event);
      }
      return data;
    };
    const firstPage = await fetchPage(1);
    const lastPage = Math.max(1, Number(firstPage?.total_pages) || 1);
    await remainingPages(Math.min(25, lastPage), fetchPage);
    complete = lastPage <= 25;
    return { events: result, complete };
  }

  async function load(range, anilistIds = [], force = false, scope = "list") {
    if (scope === "anime-all") {
      // The global schedule is intentionally independent of account and
      // Library; no TVmaze shows or TMDb films belong in this view.
      try {
        const result = await anime(range);
        return {
          events: result.events.filter((event) => event.type === "anime"
            && event.date >= isoDate(range.start - DAY_MS)
            && event.date <= isoDate(range.end + DAY_MS))
            .sort((a, b) => a.timestamp - b.timestamp || a.title.localeCompare(b.title)),
          coverage: { AniList: { status: result.complete ? "ok" : "partial" } },
          updatedAt: new Date(now()).toISOString(),
        };
      } catch {
        return { events: [], coverage: { AniList: { status: "unavailable" } },
          updatedAt: new Date(now()).toISOString() };
      }
    }
    const tmdbKey = getTmdbKey();
    // Give the small, exact-list query first access to AniList's rate limit;
    // the general schedule can otherwise spend it on unrelated anime.
    const family = anilistIds.length ? animeFamily(anilistIds, force).catch(() => null) : null;
    const targeted = family ? family.then((result) => result?.events || animeNext(anilistIds)) : null;
    // Query the airing schedule for this show's verified IDs, including its
    // sequels. The old global query fetched thousands of unrelated anime and
    // exhausted AniList's rate limit before the user's episodes were loaded.
    const broad = family
      ? family.then((result) => anime(range, result ? [...result.linkedById.keys()] : anilistIds))
      : anime(range);
    const entries = await Promise.allSettled([
      broad, tv(), movies(range, tmdbKey),
      ...(targeted ? [targeted] : []),
    ]);
    const providerNames = ["AniList", "TVmaze", "TMDb"];
    const coverage = {};
    const events = new Map();
    const linkedById = family ? (await family)?.linkedById : null;
    entries.slice(0, 3).forEach((entry, index) => {
      const provider = providerNames[index];
      if (entry.status === "rejected") {
        coverage[provider] = { status: "unavailable" };
        return;
      }
      const item = index === 1 ? { events: entry.value, complete: true } : entry.value;
      coverage[provider] = { status: item.needsKey ? "needs_key" : item.complete ? "ok" : "partial" };
      for (const event of item.events) {
        if (event.date >= isoDate(range.start - DAY_MS) && event.date <= isoDate(range.end + DAY_MS))
          events.set(event.id, event.source === "AniList" && linkedById?.has(Number(event.providerId))
            ? { ...event, linkedAniListIds: linkedById.get(Number(event.providerId)) } : event);
      }
    });
    // An exact next-episode result supplements the broad public feed even when
    // the latter is truncated. A targeted outage does not hide other dates.
    if (entries[3]?.status === "fulfilled") {
      for (const event of entries[3].value) {
        if (event.date >= isoDate(range.start - DAY_MS) && event.date <= isoDate(range.end + DAY_MS))
          events.set(event.id, event);
      }
    } else if (entries[3] && coverage.AniList?.status === "ok") coverage.AniList.status = "partial";
    if (family && !linkedById && coverage.AniList?.status === "ok") coverage.AniList.status = "partial";
    return {
      events: [...events.values()].sort((a, b) => (a.timestamp || Date.parse(a.date)) - (b.timestamp || Date.parse(b.date))
        || a.title.localeCompare(b.title)),
      coverage, updatedAt: new Date(now()).toISOString(),
    };
  }

  return {
    async releases(from, to, { force = false, anilistIds = [], scope = "list" } = {}) {
      const range = releaseRange(from, to);
      if (!range) throw Object.assign(new Error("Choose a valid release range of at most 100 days."), { statusCode: 400 });
      const ids = [...new Set(anilistIds.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))]
        .sort((a, b) => a - b).slice(0, 300);
      if (!["list", "anime-all"].includes(scope)) throw Object.assign(new Error("Invalid calendar scope."), { statusCode: 400 });
      const key = `${scope}:${from}:${to}:${scope === "list" ? Boolean(tmdbAuth(getTmdbKey())) : ""}:${scope === "list" ? ids.join(",") : ""}`;
      const cached = cache.get(key);
      if (!force && cached && now() - cached.at < 15 * 60_000) return cached.promise;
      const promise = load(range, ids, force, scope);
      cache.set(key, { at: now(), promise });
      promise.catch(() => { if (cache.get(key)?.promise === promise) cache.delete(key); });
      if (cache.size > 16) cache.delete(cache.keys().next().value);
      return promise;
    },
  };
}
