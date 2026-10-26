/**
 * Recommendations: linked accounts, your ratings, refreshes and the automatic schedule.
 *
 * A refresh reads only what's missing or older than the update interval: your linked lists,
 * AniList entries for anime you rated in the app, the "fans also recommend" lists of your
 * favorites (AniList, and TMDB when a key is set), then details for the strongest candidates.
 * Picks that are a later season are shown as their first season, and each pick is matched to
 * a title in the catalog so it opens on its page.
 */
import { DETAILS_BATCH, bestAniListMatch, createAniListClient, normalizeAniListList } from "../integrations/anilist.js";
import { createTmdbClient } from "../integrations/tmdb.js";
import { fetchLetterboxdFeed, readLetterboxdExport } from "../integrations/letterboxd.js";
import { fitCurve, linkStrength, mergeRatings, ratingScale, ratingSignal, recommend, roundScore } from "./recommend.js";
import { RECS_INTERVALS } from "./recs-store.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const FAILED_AUTO_RETRY = HOUR;
const SEED_LIMIT = 30;
const CANDIDATE_DETAILS = 150;
const PICK_LIMIT = 24;
const ITEM_MAX_AGE = 30 * DAY;
const MAP_RETRY = 7 * DAY;
const LETTERBOXD_MATCHES_PER_REFRESH = 60;
const KINDS = new Set(["anime", "anime-movie", "movie", "series"]);
const TV_LIKE = new Set(["TV", "ONA", "TV_SHORT"]);
// "Part 2", "Cour 2", "2nd cour": a continuation of the season before it.
const PART = /\b(?:part|cour)\s*(?:\d+|ii|iii|iv)\b|\b\d+(?:st|nd|rd|th)\s+cour\b/i;

const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const MATCH_CONCURRENCY = 4;

/** Runs work(item) for every item, at most `limit` at a time. */
async function eachLimit(items, limit, work) {
  let next = 0;
  const runner = async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await work(item);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, runner));
}
const normalize = (value) => String(value || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

/** Names to look an AniList title up by in the catalog: as written, and without a subtitle, a "(2011)" or a "Season 2". */
export function catalogTitles(item = {}) {
  const names = [item.title, item.titleAlt].filter(Boolean);
  const variants = names.flatMap((name) => [
    name.split(/\s*[:：]\s+|\s+-\s+/)[0],
    name.replace(/\s*\((?:19|20)\d{2}\)\s*$/, ""),
    name.replace(/\b(?:season|part|cour)\s*\d+\b|\b\d+(?:st|nd|rd|th)\s+season\b/gi, " ").replace(/\s+/g, " ").trim(),
  ]).map((name) => name.trim()).filter((name) => name.length >= 3);
  return [...new Set([...names, ...variants])];
}

// AniList, TMDB and Letterboxd failures answer the page with a clear status instead of a 500.
async function upstream(work) {
  try {
    return await work();
  } catch (error) {
    if (!error.statusCode) error.statusCode = error.status === 404 ? 404 : error.status >= 400 && error.status < 500 ? 400 : 502;
    throw error;
  }
}

/** The catalog title (IMDb id) that is this pick: same name (any of its titles), then year and type. */
export function bestCatalogMatch(results = [], { titles = [], year = null, movie = false } = {}) {
  const wanted = titles.map(normalize).filter(Boolean);
  let best = null;
  for (const result of results) {
    if (!/^tt\d+$/.test(String(result?.id || ""))) continue;
    const name = normalize(result.name);
    // A prefix is not a title identity (e.g. "Titan" and "Titan Evolution").
    // All known title variants are supplied by catalogTitles() already.
    if (!name || !wanted.includes(name)) continue;
    const resultYear = Number(String(result.releaseInfo || "").match(/\d{4}/)?.[0]) || null;
    if (year && resultYear && Math.abs(resultYear - year) > 1) continue;
    const type = String(result.type || "").toLowerCase();
    if (!type || (type === "movie") !== movie) continue;
    let score = 6;
    if (year && resultYear) score += 2;
    score += 1;
    if (!best || score > best.score) best = { score, result };
  }
  return best && best.score >= 4 ? best.result : null;
}

function confirmedAniListMatch(results, rating) {
  const movie = rating.kind === "anime-movie";
  const found = bestAniListMatch(results, { title: rating.title, year: rating.year, movie });
  if (!found) return null;
  const names = [found.title?.english, found.title?.romaji, found.title?.native, ...(found.synonyms || [])];
  if (!names.some((name) => normalize(name) === normalize(rating.title))) return null;
  if (rating.year && found.seasonYear && Math.abs(rating.year - found.seasonYear) > 1) return null;
  if (movie ? found.format !== "MOVIE" : !TV_LIKE.has(found.format)) return null;
  return found;
}

// An imported score already has a stable AniList media ID. Reuse that ID for
// the same locally rated anime only when its title, year and format identify a
// single entry. This also works when the public search service is unavailable.
function confirmedImportedAniListId(rating, imported, items) {
  if (!Number.isInteger(rating.year) || rating.year < 1900 || (rating.season !== null && rating.season !== 1)) return null;
  const movie = rating.kind === "anime-movie";
  const wanted = normalize(rating.title);
  if (!wanted) return null;
  const matches = imported.filter((entry) => {
    const item = items.get(entry.itemId);
    if (!item || !Number.isInteger(item.year) || Math.abs(item.year - rating.year) > 1) return false;
    if (movie ? item.format !== "MOVIE" : !TV_LIKE.has(item.format)) return false;
    if (!movie && Number.isInteger(item.seasonNumber) && item.seasonNumber > 1) return false;
    return [entry.title, item.title, item.titleAlt].some((title) => normalize(title) === wanted);
  });
  return matches.length === 1 ? matches[0].itemId : null;
}

export function createRecsService({ store, searchCatalog = async () => [], anilist = createAniListClient(), tmdbFactory = (key) => createTmdbClient({ key }), letterboxdFeed = fetchLetterboxdFeed, now = Date.now, log = console } = {}) {
  let current = null;
  let timer = null;
  // This process has no update running yet, so a run still marked "running" was cut short.
  store.failInterruptedRuns?.();

  const tmdbFor = (settings) => {
    if (!settings.tmdbKey) return null;
    try { return tmdbFactory(settings.tmdbKey); } catch { return null; }
  };

  function publicSettings() {
    const settings = store.settings();
    return {
      mode: settings.mode,
      intervalDays: settings.intervalDays,
      intervals: RECS_INTERVALS,
      anilist: settings.anilist ? { username: settings.anilist.username, syncedAt: settings.anilist.syncedAt, count: settings.anilist.count, scored: settings.anilist.scored } : null,
      letterboxd: settings.letterboxd ? { username: settings.letterboxd.username || "", syncedAt: settings.letterboxd.syncedAt || null, count: settings.letterboxd.count || 0, scored: settings.letterboxd.scored ?? null, importedAt: settings.letterboxd.importedAt || null, imported: settings.letterboxd.imported || 0 } : null,
      tmdb: { linked: Boolean(settings.tmdbKey), checkedAt: settings.tmdbCheckedAt || null },
    };
  }

  function status() {
    const settings = store.settings();
    const last = store.lastRun();
    const ratingsChanged = settings.ratingsChangedAt > (last?.started_at || 0);
    const eligible = store.ratings().length > 0 || Boolean(settings.anilist?.username || settings.letterboxd?.username);
    const nextRunAt = eligible ? Math.max(now(), nextScheduledRunAt()) : null;
    return {
      running: current ? { trigger: current.trigger, phase: current.phase, startedAt: current.startedAt, progress: Math.round(Math.min(1, current.progress || 0) * 100) / 100 } : null,
      lastRun: last ? { trigger: last.trigger, status: last.status, startedAt: last.started_at, finishedAt: last.finished_at, picks: last.picks, seeds: last.seeds, candidates: last.candidates, requests: last.requests, error: last.error } : null,
      nextRunAt,
      ratingsChanged,
    };
  }

  function pickForClient({ rank, itemId, match, summary, reasons, item }) {
    const movie = item.kind === "movie" || item.format === "MOVIE" || item.format === "movie";
    const [, tmdbType, tmdbId] = item.source === "tmdb" ? item.sourceId.match(/^(movie|tv):(\d+)$/) || [] : [];
    return {
      rank, itemId, match, summary, reasons,
      title: item.title, titleAlt: item.titleAlt || "", kind: item.kind, type: movie ? "movie" : "series", year: item.year,
      cover: item.cover, banner: item.banner, description: item.description, genres: item.genres,
      score: item.score, scoredBy: item.scoredBy, source: item.source, imdbId: item.imdbId || null,
      url: item.source === "anilist" ? `https://anilist.co/anime/${item.sourceId}` : tmdbId ? `https://www.themoviedb.org/${tmdbType}/${tmdbId}` : "",
    };
  }

  function overview() {
    const { run, picks } = store.currentPicks();
    return { settings: publicSettings(), status: status(), stats: store.stats(), picks: picks.map(pickForClient), updatedAt: run?.finished_at || null, calibratedWith: run?.curve?.fitted || 0 };
  }

  function updateSettings({ mode, intervalDays } = {}) {
    const patch = {};
    if (mode !== undefined) {
      if (mode !== "auto" && mode !== "manual") throw fail("Choose automatic or manual updates");
      patch.mode = mode;
    }
    if (intervalDays !== undefined) {
      if (!RECS_INTERVALS.includes(Number(intervalDays))) throw fail(`Update every ${RECS_INTERVALS.join(", ")} days`);
      patch.intervalDays = Number(intervalDays);
    }
    store.saveSettings(patch);
    return overview();
  }

  function applyAniListList(list, { authenticated = false, scoreSync = false } = {}) {
    store.upsertItems(list.entries.map((entry) => entry.media));
    store.replaceSourceRatings("anilist", list.entries.map(({ media, ...entry }) => entry));
    store.saveSettings({ anilist: { username: list.user.name, userId: list.user.id, authenticated, scoreSync: authenticated && scoreSync, syncedAt: now(), count: list.entries.length, scored: list.entries.filter((entry) => entry.score !== null).length } });
  }

  function linkAuthenticatedAniList(snapshot) {
    // No access tokens enter this method or the server. Only an authenticated
    // browser supplies the Viewer and MediaListCollection response metadata.
    const viewer = snapshot?.Viewer;
    const collection = snapshot?.MediaListCollection;
    if (!Number.isSafeInteger(viewer?.id) || viewer.id <= 0
        || !/^[A-Za-z0-9_-]{2,40}$/.test(String(viewer.name || ""))
        || !collection || !Array.isArray(collection.lists)
        || collection.user?.id !== viewer.id || collection.user?.name !== viewer.name)
      throw fail("AniList returned an invalid authenticated list. No existing ratings were changed.");
    const lists = collection?.lists || [];
    if (lists.length > 300 || lists.some((list) => !Array.isArray(list?.entries))
        || lists.reduce((sum, list) => sum + list.entries.length, 0) > 11_000)
      throw fail("AniList returned an incomplete or unexpectedly large list. No ratings were changed.");
    const seen = new Map();
    for (const entry of lists.flatMap((list) => list.entries)) {
      const id = entry?.media?.id;
      if (!Number.isSafeInteger(id) || id <= 0 || !Number.isFinite(Number(entry.score))
          || Number(entry.score) < 0 || Number(entry.score) > 10
          || !(entry.progress === null || (Number.isInteger(entry.progress) && entry.progress >= 0)))
        throw fail("AniList returned an incomplete score or media entry. No ratings were changed.");
      const signature = JSON.stringify([entry.score, entry.status || null, entry.progress, entry.updatedAt || null]);
      if (seen.has(id) && seen.get(id) !== signature)
        throw fail("AniList returned conflicting entries for the same anime. No ratings were changed.");
      seen.set(id, signature);
    }
    const list = normalizeAniListList({ MediaListCollection: { user: { id: viewer.id, name: viewer.name }, lists } });
    applyAniListList(list, { authenticated: true, scoreSync: snapshot.scoreSyncEnabled === true });
    checkScheduledRefresh();
    return overview();
  }

  async function linkAniList(username) {
    const name = String(username || "").trim();
    if (!/^[A-Za-z0-9_-]{2,40}$/.test(name)) throw fail("Enter your AniList user name");
    const list = await upstream(() => anilist.userList(name));
    if (!list.user) throw fail("That AniList user wasn't found, or their list is private.", 404);
    applyAniListList(list);
    checkScheduledRefresh();
    return overview();
  }

  async function syncAniList() {
    const linked = store.settings().anilist;
    if (!linked?.username) throw fail("Link an AniList account first");
    if (linked.authenticated) throw fail("Refresh your authenticated AniList list in LVL instead of using the public username lookup.");
    applyAniListList(await upstream(() => anilist.userList(linked.username)));
    return overview();
  }

  function unlinkAniList() {
    store.removeSourceRatings("anilist");
    store.saveSettings({ anilist: null });
    return overview();
  }

  async function setTmdbKey(key) {
    const value = String(key || "").trim();
    if (!value) {
      store.saveSettings({ tmdbKey: "", tmdbCheckedAt: null });
      return overview();
    }
    await upstream(() => tmdbFactory(value).validate());
    store.saveSettings({ tmdbKey: value, tmdbCheckedAt: now() });
    return overview();
  }

  async function linkLetterboxd(username) {
    const feed = await upstream(() => letterboxdFeed(username));
    if (!feed.entries.length) throw fail("No recent films found in this public Letterboxd feed. Import your Letterboxd export (.zip) for your full ratings.", 422);
    store.mergeSourceRatings("letterboxd", feed.entries);
    const previous = store.settings().letterboxd || {};
    store.saveSettings({ letterboxd: { ...previous, username: feed.username, syncedAt: now(), count: feed.entries.length,
      scored: feed.entries.filter((entry) => Number.isFinite(entry.score)).length } });
    checkScheduledRefresh();
    return overview();
  }

  function importLetterboxd(buffer) {
    const entries = readLetterboxdExport(buffer);
    if (!entries.length) throw fail("No films were found in that file. Use the .zip from Letterboxd › Settings › Data › Export your data.", 422);
    store.mergeSourceRatings("letterboxd", entries);
    const previous = store.settings().letterboxd || {};
    store.saveSettings({ letterboxd: { ...previous, importedAt: now(), imported: entries.length } });
    checkScheduledRefresh();
    return overview();
  }

  function unlinkLetterboxd() {
    store.removeSourceRatings("letterboxd");
    store.saveSettings({ letterboxd: null });
    return overview();
  }

  /** Your rating of a title in the app (1.00–10.00), or none to remove it. */
  function rate({ catalogId = "", seriesKey = "", season = null, title = "", kind = "", year = null, score = null, status = null } = {}) {
    if (catalogId && !/^tt\d{5,12}$/.test(String(catalogId))) throw fail("Unknown title");
    if (!catalogId && !seriesKey) throw fail("A title is required");
    const value = score === null || score === "" ? null : roundScore(score);
    if (score !== null && score !== "" && value === null) throw fail("A rating is a number from 1 to 10");
    const saved = store.setAppRating({
      catalogId: catalogId || "", seriesKey: String(seriesKey || "").slice(0, 300), season: Number.isInteger(season) ? season : null,
      title: String(title || "").slice(0, 300), kind: KINDS.has(kind) ? kind : null, year: Number(year) || null, score: value,
      status: ["COMPLETED", "CURRENT", "DROPPED", "PAUSED", "PLANNING"].includes(status) ? status : null,
    });
    checkScheduledRefresh();
    return { rating: saved, ...titleRatings({ catalogId, seriesKey, title, year }) };
  }

  const showName = (value) => normalize(value)
    .replace(/\b(?:season|part|cour)\s*\d+\b/g, " ").replace(/\b\d+(?:st|nd|rd|th)\s+season\b/g, " ").replace(/\s+/g, " ").trim();

  /** Ratings shown on a title's page: yours in the app, and imported ones for the same show (matched by id, else by name). */
  function titleRatings({ catalogId = "", seriesKey = "", title = "", year = null } = {}) {
    const found = store.titleRatings({ catalogId, seriesKey });
    const keys = new Set(found.map((rating) => rating.key));
    const wanted = showName(title);
    if (wanted.length >= 2) {
      for (const rating of store.ratings()) {
        if (rating.source === "app" || keys.has(rating.key)) continue;
        const name = showName(rating.title);
        // A shared title prefix does not identify a season: unrelated anime,
        // remakes and spin-offs often start with exactly the same words.
        // Additional seasons are included through their mapped item IDs above.
        const sameShow = name === wanted;
        const closeYear = !year || !rating.year || Math.abs(rating.year - Number(year)) <= 1;
        if (sameShow && closeYear) {
          found.push(rating);
          keys.add(rating.key);
        }
      }
    }
    const items = store.items(found.map((rating) => rating.itemId).filter(Boolean));
    const ratings = found.map((rating) => {
      const item = rating.itemId ? items.get(rating.itemId) : null;
      return { ...rating, itemTitle: item?.title || null, seasonNumber: item?.seasonNumber ?? null, format: item?.format || null };
    }).sort((a, b) => (a.source === "app" ? -1 : 0) - (b.source === "app" ? -1 : 0) || (a.seasonNumber ?? 99) - (b.seasonNumber ?? 99) || (a.year ?? 0) - (b.year ?? 0));
    return { ratings };
  }

  // ----------------------------------------------------------------- your AniList list in the Library

  const libraryMisses = new Map();
  let libraryRun = null;

  /** Your AniList list for the Library: a title per show (its seasons in order) and per movie, with catalog pages. */
  function anilistLibrary() {
    if (!libraryRun) libraryRun = buildAniListLibrary().finally(() => { libraryRun = null; });
    return libraryRun;
  }

  async function buildAniListLibrary() {
    const syncedAt = store.settings().anilist?.syncedAt || null;
    const entries = store.ratings().filter((rating) => rating.source === "anilist" && String(rating.itemId || "").startsWith("anilist:"));
    if (!entries.length) return { syncedAt, shows: [] };
    const loaded = (id) => (store.item(id)?.fetchedAt || 0) > 1;
    // The list doesn't say which entries are seasons of one show; AniList's relations do. Earlier
    // seasons that aren't on your list are read too, so a show starts at its first season.
    const read = new Set();
    let pending = entries.map((entry) => entry.itemId).filter((id) => !loaded(id));
    for (let round = 0; round < 4 && pending.length; round += 1) {
      const batch = [...new Set(pending)].slice(0, 150);
      batch.forEach((id) => read.add(id));
      store.upsertItems((await upstream(() => anilist.details(batch))).map(({ item }) => item));
      pending = [...entries.map((entry) => entry.itemId), ...read]
        .flatMap((id) => (store.item(id)?.relations || []).filter((relation) => relation.type === "PREQUEL" || relation.type === "PARENT").map((relation) => relation.id))
        .filter((id) => !loaded(id) && !read.has(id));
    }
    assignShows();
    const items = store.items();
    const groups = new Map();
    for (const entry of entries) {
      const item = items.get(entry.itemId);
      if (!item) continue;
      const root = item.format === "MOVIE" ? item : showRoot(item, items);
      const group = groups.get(root.itemId) || { root, members: [] };
      group.members.push({ item, entry });
      groups.set(root.itemId, group);
    }
    const shows = [...groups.values()].map(showForLibrary);
    // Titles without a catalog page yet are looked up by name, a few at a time; a miss is tried again the next day.
    const unmatched = shows.filter((show) => !show.imdbId && now() - (libraryMisses.get(show.showId) || 0) >= DAY);
    await eachLimit(unmatched, MATCH_CONCURRENCY, async (show) => {
      const root = items.get(show.showId);
      const titles = catalogTitles(root);
      try {
        for (const title of titles) {
          const found = bestCatalogMatch(await searchCatalog(title), { titles, year: root.year, movie: show.type === "movie" });
          if (found) {
            show.imdbId = found.id;
            store.setItemIds(root.itemId, { imdbId: found.id });
            return;
          }
        }
        libraryMisses.set(show.showId, now());
      } catch (error) {
        log.warn?.("Matching an AniList title failed:", error.message);
      }
    });
    return { syncedAt, shows: shows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)) };
  }

  // The first season of an entry's show: back through its prequels (a special or OVA also through
  // the show it belongs to) to the earliest TV, ONA or short series.
  function showRoot(item, items) {
    let root = item;
    let cursor = item;
    const seen = new Set([item.itemId]);
    for (let step = 0; step < 16; step += 1) {
      const next = (cursor.relations || []).find((relation) => (relation.type === "PREQUEL" || (relation.type === "PARENT" && !TV_LIKE.has(cursor.format)))
        && !seen.has(relation.id) && items.has(relation.id));
      if (!next) break;
      seen.add(next.id);
      cursor = items.get(next.id);
      if (TV_LIKE.has(cursor.format)) root = cursor;
    }
    return root;
  }

  function showForLibrary({ root, members }) {
    const publicScores = members.map(({ item }) => Number(item.score))
      .filter((score) => Number.isFinite(score) && score > 0 && score <= 100);
    const seasons = members.map(({ item, entry }) => ({
      itemId: item.itemId, anilistId: Number(item.sourceId), season: TV_LIKE.has(item.format) ? item.seasonNumber ?? null : null,
      title: item.title, format: item.format || null, year: item.year ?? null, episodes: item.episodes ?? null,
      status: entry.status || null, progress: entry.progress ?? null, score: entry.score ?? null, updatedAt: entry.updatedAt || null,
    })).sort((a, b) => (a.season ?? 99) - (b.season ?? 99) || (a.year ?? 0) - (b.year ?? 0));
    const statuses = seasons.map((season) => season.status);
    // One status for the show: watching (or rewatching) any season wins, then paused; completed if
    // any season is done; plan to watch or dropped only when every season is.
    const status = statuses.some((value) => value === "CURRENT" || value === "REPEATING") ? "CURRENT"
      : statuses.includes("PAUSED") ? "PAUSED"
        : statuses.every((value) => value === "PLANNING") ? "PLANNING"
          : statuses.every((value) => value === "DROPPED") ? "DROPPED"
            : statuses.includes("COMPLETED") ? "COMPLETED" : statuses[0] || null;
    return {
      showId: root.itemId, anilistId: Number(root.sourceId), type: root.format === "MOVIE" ? "movie" : "series",
      averageScore: publicScores.length ? publicScores.reduce((sum, score) => sum + score, 0) / publicScores.length
        : Number(root.score) > 0 && Number(root.score) <= 100 ? Number(root.score) : null,
      title: root.title, titleAlt: root.titleAlt || "", year: root.year ?? null, cover: root.cover || members[0].item.cover || "",
      imdbId: root.imdbId || members.map(({ item }) => item.imdbId).find(Boolean) || null,
      status, updatedAt: Math.max(0, ...seasons.map((season) => season.updatedAt || 0)) || null,
      url: `https://anilist.co/anime/${root.sourceId}`, seasons,
    };
  }

  return {
    overview, status, updateSettings, linkAniList, linkAuthenticatedAniList, syncAniList, unlinkAniList, setTmdbKey, linkLetterboxd, importLetterboxd, unlinkLetterboxd, rate, titleRatings,
    anilistLibrary: () => anilistLibrary(),
    refresh: (options) => refresh(options),
    hide(itemId) { store.hide(String(itemId || "")); return overview(); },
    unhideAll() { store.unhideAll(); return overview(); },
    clearCache() { store.clearCache(); return overview(); },
    startScheduler: () => startScheduler(),
    stopScheduler: () => { if (timer) clearInterval(timer); timer = null; },
  };

  // ----------------------------------------------------------------- refresh

  function refresh({ trigger = "manual" } = {}) {
    if (current) return current.promise;
    const state = { trigger, phase: "Starting", startedAt: now(), progress: 0 };
    current = state;
    state.promise = runRefresh(state).finally(() => { if (current === state) current = null; });
    return state.promise;
  }

  async function runRefresh(state) {
    const settings = store.settings();
    const tmdb = tmdbFor(settings);
    const requestsAtStart = anilist.requests + (tmdb?.requests || 0);
    const requests = () => anilist.requests + (tmdb?.requests || 0) - requestsAtStart;
    const runId = store.startRun(state.trigger);
    try {
      state.progress = 0.02;
      await syncLinked(state, settings);
      state.progress = 0.08;
      await matchRatings(state, tmdb);
      state.progress = 0.15;
      const merged = mergeRatings(store.ratings().filter((rating) => rating.itemId), {
        preferAniListScores: Boolean(store.settings().anilist?.authenticated && store.settings().anilist?.scoreSync),
      });
      const scale = ratingScale(merged.map((rating) => rating.score));
      const seedDetails = store.items(merged.map((rating) => rating.itemId));
      const signals = merged.map((rating) => ({ rating, weight: ratingSignal(rating, scale, seedDetails.get(rating.itemId)) }))
        .filter(({ weight }) => Math.abs(weight) >= 0.05)
        .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
      const animeSeeds = signals.filter(({ rating }) => rating.itemId.startsWith("anilist:")).slice(0, SEED_LIMIT).map(({ rating }) => rating.itemId);
      const tmdbSeeds = tmdb ? signals.filter(({ rating }) => rating.itemId.startsWith("tmdb:")).slice(0, SEED_LIMIT).map(({ rating }) => rating.itemId) : [];
      const seeds = [...animeSeeds, ...tmdbSeeds];
      if (!seeds.length) {
        store.savePicks(runId, []);
        store.finishRun(runId, { status: "done", requests: requests() });
        return overview();
      }
      await readFanLinks(state, { animeSeeds, tmdbSeeds, tmdb, maxAgeMs: settings.intervalDays * DAY });

      // The strongest candidates first (fans' links × how much you liked the title), then their details.
      const links = store.links(seeds);
      const weightOf = new Map(signals.map(({ rating, weight }) => [rating.itemId, weight]));
      const known = new Set(merged.filter((rating) => rating.status !== "PLANNING" || rating.score !== null).map((rating) => rating.itemId));
      const strength = new Map();
      for (const [from, list] of links) {
        for (const link of list) {
          if (known.has(link.to)) continue;
          strength.set(link.to, (strength.get(link.to) || 0) + Math.max(0, weightOf.get(from) || 0) * linkStrength(link));
        }
      }
      const candidates = [...strength].sort((a, b) => b[1] - a[1]).slice(0, CANDIDATE_DETAILS).map(([id]) => id);
      const staleAnime = store.staleItems(candidates.filter((id) => id.startsWith("anilist:")), ITEM_MAX_AGE);
      state.progress = 0.45;
      if (staleAnime.length) {
        state.phase = "Reading the candidates";
        store.upsertItems((await detailsWithProgress(state, staleAnime, { from: 0.45, to: 0.68 })).map(({ item }) => item));
      }
      assignShows();

      state.phase = "Ranking";
      state.progress = 0.7;
      const curve = fitCurve(store.outcomes(scale.mean));
      const result = recommend({ ratings: merged, items: store.items([...seeds, ...candidates]), links, hidden: store.hidden(), curve, limit: PICK_LIMIT * 2 });
      const picks = (await firstSeasons(state, result.picks, known)).slice(0, PICK_LIMIT).map((pick, index) => ({ ...pick, rank: index + 1 }));
      state.phase = "Matching picks to titles";
      state.progress = 0.8;
      await matchPicks(state, picks, tmdb);
      store.savePicks(runId, picks);
      store.finishRun(runId, { status: "done", seeds: seeds.length, candidates: result.candidates, picks: picks.length, requests: requests(), curve });
      return overview();
    } catch (error) {
      store.finishRun(runId, { status: "failed", requests: requests(), error: error.message || String(error) });
      throw error;
    }
  }

  async function syncLinked(state, settings) {
    if (settings.anilist?.username && !settings.anilist.authenticated && now() - (settings.anilist.syncedAt || 0) > HOUR) {
      state.phase = "Reading your AniList list";
      try { applyAniListList(await anilist.userList(settings.anilist.username)); } catch (error) { log.warn?.("AniList sync failed:", error.message); }
    }
    if (settings.letterboxd?.username && now() - (settings.letterboxd.syncedAt || 0) > HOUR) {
      state.phase = "Reading your Letterboxd diary";
      try { await linkLetterboxd(settings.letterboxd.username); } catch (error) { log.warn?.("Letterboxd sync failed:", error.message); }
    }
  }

  // Titles you rated in the app (and Letterboxd films from an export) get their AniList or TMDB entry.
  async function matchRatings(state, tmdb) {
    const retryBefore = now() - MAP_RETRY;
    const imported = store.ratings().filter((rating) => rating.source === "anilist" && rating.itemId);
    const importedItems = store.items(imported.map((rating) => rating.itemId));
    for (const rating of store.unmappedRatings("app", retryBefore)) {
      if (rating.kind === "anime" || rating.kind === "anime-movie") {
        const importedId = confirmedImportedAniListId(rating, imported, importedItems);
        if (importedId) {
          store.setRatingItem(rating.key, importedId);
          continue;
        }
        state.phase = `Finding ${rating.title} on AniList`;
        const media = confirmedAniListMatch(await anilist.search(rating.title), rating);
        if (media) {
          store.upsertItems([{ itemId: `anilist:${media.id}`, source: "anilist", sourceId: String(media.id), kind: "anime", title: media.title?.english || media.title?.romaji || rating.title,
            titleAlt: media.title?.romaji || "", format: media.format, year: media.seasonYear, popularity: media.popularity, imdbId: rating.catalogId, fetchedAt: 1 }]);
        }
        const season = Number(rating.season) || 0;
        store.setRatingItem(rating.key, media ? (season > 1 && rating.kind === "anime" ? await laterSeason(`anilist:${media.id}`, season, rating.catalogId) : `anilist:${media.id}`) : null);
      } else if (tmdb && rating.catalogId && (rating.kind === "movie" || rating.kind === "series")) {
        state.phase = `Finding ${rating.title} on TMDB`;
        const found = await tmdb.findImdb(rating.catalogId);
        const type = rating.kind === "movie" ? (found.movie ? "movie" : found.tv ? "tv" : "") : found.tv ? "tv" : found.movie ? "movie" : "";
        const id = type === "movie" ? found.movie : found.tv;
        if (id) store.upsertItems([{ itemId: `tmdb:${type}:${id}`, source: "tmdb", sourceId: `${type}:${id}`, kind: type === "movie" ? "movie" : "series", title: rating.title, format: type, year: rating.year, imdbId: rating.catalogId, tmdbId: String(id), fetchedAt: 1 }]);
        store.setRatingItem(rating.key, id ? `tmdb:${type}:${id}` : null);
      }
    }
    if (!tmdb) return;
    for (const rating of store.unmappedRatings("letterboxd", retryBefore).slice(0, LETTERBOXD_MATCHES_PER_REFRESH)) {
      state.phase = "Matching your Letterboxd films";
      const id = await tmdb.searchMovie(rating.title, rating.year);
      if (id) store.upsertItems([{ itemId: `tmdb:movie:${id}`, source: "tmdb", sourceId: `movie:${id}`, kind: "movie", title: rating.title, format: "movie", year: rating.year, tmdbId: String(id), fetchedAt: 1 }]);
      store.setRatingItem(rating.key, id ? `tmdb:movie:${id}` : null);
    }
  }

  // Season N of a show rated in the app: follow AniList's sequels from the first season. Catalogs
  // usually count a "Part 2" or "2nd cour" as the same season, so those don't add one.
  async function laterSeason(firstId, season, catalogId = "") {
    let itemId = firstId;
    let number = 1;
    const seen = new Set([firstId]);
    const loaded = async (id) => {
      const stored = store.item(id);
      if (stored && stored.fetchedAt > 1) return stored;
      const [found] = await anilist.details([id]);
      if (!found) return null;
      store.upsertItems([found.item]);
      return store.item(id);
    };
    for (let step = 0; step < 12 && number < season; step += 1) {
      const item = await loaded(itemId);
      const next = (item?.relations || []).find((relation) => relation.type === "SEQUEL" && TV_LIKE.has(relation.format) && !seen.has(relation.id));
      if (!next) return null;
      seen.add(next.id);
      const sequel = await loaded(next.id);
      if (!sequel) return null;
      itemId = next.id;
      if (!PART.test(`${sequel.title} ${sequel.titleAlt || ""}`)) number += 1;
    }
    if (number !== season) return null;
    if (catalogId) store.setItemIds(itemId, { imdbId: catalogId });
    return itemId;
  }

  // AniList details read a batch at a time, moving the progress bar from `from` to `to`.
  async function detailsWithProgress(state, ids, { links = false, from = 0, to = 1 } = {}) {
    const out = [];
    for (let index = 0; index < ids.length; index += DETAILS_BATCH) {
      out.push(...await anilist.details(ids.slice(index, index + DETAILS_BATCH), { links }));
      state.progress = from + (to - from) * Math.min(1, (index + DETAILS_BATCH) / ids.length);
    }
    state.progress = to;
    return out;
  }

  async function readFanLinks(state, { animeSeeds, tmdbSeeds, tmdb, maxAgeMs }) {
    const staleAnime = store.staleItems(animeSeeds, maxAgeMs, { links: true });
    const staleTmdb = store.staleItems(tmdbSeeds, maxAgeMs, { links: true });
    const animeEnd = staleTmdb.length ? 0.35 : 0.45;
    if (staleAnime.length) {
      state.phase = "Reading what fans of your favorites recommend";
      for (const { item, links } of await detailsWithProgress(state, staleAnime, { links: true, from: 0.15, to: animeEnd })) {
        store.upsertItems([item]);
        store.setLinks(item.itemId, links || [], item.fetchedAt);
      }
    }
    for (const [index, seed] of staleTmdb.entries()) {
      state.phase = "Reading TMDB recommendations";
      state.progress = animeEnd + (0.45 - animeEnd) * (index / staleTmdb.length);
      const [, kind, id] = seed.split(":");
      try {
        const details = await tmdb.details(kind, id);
        if (details) store.upsertItems([details]);
        const found = await tmdb.recommendations(kind, id);
        store.upsertItems(found.items);
        store.setLinks(seed, found.links);
      } catch (error) {
        if (error.status === 401) throw error;
        log.warn?.("TMDB recommendations failed:", error.message);
      }
    }
  }

  // Each AniList entry gets the show it belongs to (its first entry) and its season number.
  function assignShows() {
    const anime = [...store.items().values()].filter((item) => item.source === "anilist");
    const byId = new Map(anime.map((item) => [item.itemId, item]));
    for (const item of anime) {
      // Season N counts the TV entries up to this one; a "Part 2" continues the season before it.
      const opensSeason = (entry) => TV_LIKE.has(entry.format) && !PART.test(`${entry.title} ${entry.titleAlt || ""}`);
      let root = item;
      let seasons = opensSeason(item) ? 1 : 0;
      const seen = new Set([item.itemId]);
      for (let step = 0; step < 12; step += 1) {
        const prequel = (root.relations || []).find((relation) => relation.type === "PREQUEL" && byId.has(relation.id) && !seen.has(relation.id));
        if (!prequel) break;
        root = byId.get(prequel.id);
        seen.add(root.itemId);
        if (opensSeason(root)) seasons += 1;
      }
      const seasonNumber = TV_LIKE.has(item.format) ? Math.max(1, seasons) : null;
      if (item.franchiseId !== root.itemId || item.seasonNumber !== seasonNumber) store.setItemIds(item.itemId, { franchiseId: root.itemId, seasonNumber });
    }
  }

  // A pick that is a later season is shown as the show's first season (if you haven't seen that).
  async function firstSeasons(state, picks, known) {
    for (let round = 0; round < 3; round += 1) {
      const items = store.items(picks.map((pick) => pick.itemId));
      const missing = [];
      for (const pick of picks) {
        let item = items.get(pick.itemId);
        for (let step = 0; item && step < 12; step += 1) {
          const prequel = (item.relations || []).find((relation) => relation.type === "PREQUEL");
          if (!prequel) break;
          const next = store.item(prequel.id);
          if (!next || !next.relations.length) { missing.push(prequel.id); break; }
          item = next;
        }
      }
      if (!missing.length) break;
      state.phase = "Finding first seasons";
      state.progress = Math.max(state.progress || 0, 0.72 + round * 0.03);
      store.upsertItems((await anilist.details([...new Set(missing)].slice(0, 50))).map(({ item }) => item));
    }
    assignShows();
    const shown = new Map();
    for (const pick of picks) {
      const item = store.item(pick.itemId);
      const rootId = item?.franchiseId || pick.itemId;
      const root = store.item(rootId);
      if (rootId !== pick.itemId && (known.has(rootId) || !root)) continue;
      const shownId = root ? rootId : pick.itemId;
      if (!shown.has(shownId)) shown.set(shownId, { ...pick, itemId: shownId });
    }
    return [...shown.values()];
  }

  async function matchPicks(state, picks, tmdb) {
    let done = 0;
    // Catalog searches are independent, so a few run at once (AniList isn't asked here).
    await eachLimit(picks, MATCH_CONCURRENCY, async (pick) => {
      try {
        await matchPick(pick, tmdb);
      } catch (error) {
        log.warn?.("Matching a pick failed:", error.message);
      }
      done += 1;
      state.progress = 0.8 + 0.19 * (done / Math.max(1, picks.length));
    });
  }

  async function matchPick(pick, tmdb) {
    const item = store.item(pick.itemId);
    if (!item || item.imdbId) return;
    if (item.source === "tmdb") {
      if (!tmdb) return;
      const [, type, id] = item.sourceId.match(/^(movie|tv):(\d+)$/) || [];
      const details = type ? await tmdb.details(type, id) : null;
      if (details) store.upsertItems([details]);
      return;
    }
    const titles = catalogTitles(item);
    const movie = item.format === "MOVIE";
    for (const title of titles) {
      const found = bestCatalogMatch(await searchCatalog(title), { titles, year: item.year, movie });
      if (found) {
        store.setItemIds(item.itemId, { imdbId: found.id });
        return;
      }
    }
  }

  // ----------------------------------------------------------------- schedule

  // A successful generation (manual or automatic) satisfies the local calendar
  // day. A new local date permits the next refresh even before 24 hours pass.
  // A failed run leaves old picks intact; the persisted failure delays retry
  // for an hour, including when the app is opened again after a crash.
  function nextLocalMidnight(timestamp) {
    const midnight = new Date(timestamp);
    midnight.setHours(24, 0, 0, 0);
    return midnight.getTime();
  }

  function nextScheduledRunAt() {
    const lastGood = store.lastGoodRun();
    const last = store.lastRun();
    const nextSuccess = lastGood ? nextLocalMidnight(lastGood.finished_at || lastGood.started_at) : 0;
    const failedAfterSuccess = last?.status === "failed" && (!lastGood || last.run_id > lastGood.run_id);
    const nextRetry = failedAfterSuccess ? (last.finished_at || last.started_at) + FAILED_AUTO_RETRY : 0;
    return Math.max(nextSuccess, nextRetry);
  }

  function checkScheduledRefresh() {
    if (current || !timer) return;
    const settings = store.settings();
    const hasRatings = store.ratings().length > 0 || Boolean(settings.anilist?.username || settings.letterboxd?.username);
    if (!hasRatings || now() < nextScheduledRunAt()) return;
    refresh({ trigger: "auto" }).catch((error) => log.warn?.("Automatic recommendations refresh failed:", error.message));
  }

  // Check as soon as the app opens, then check periodically if it remains open.
  // Reopening on the same day never generates a second set of picks.
  function startScheduler({ everyMs = 5 * 60 * 1000 } = {}) {
    if (timer) clearInterval(timer);
    timer = setInterval(checkScheduledRefresh, everyMs);
    timer.unref?.();
    checkScheduledRefresh();
    return checkScheduledRefresh;
  }
}
