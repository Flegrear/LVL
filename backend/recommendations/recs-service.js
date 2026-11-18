/**
 * Recommendations: linked accounts, your ratings, refreshes and the automatic schedule.
 *
 * A refresh reads only what's missing or older than the update interval: your linked lists,
 * AniList entries for anime you rated in the app, the "fans also recommend" lists of your
 * favorites (AniList, and TMDB when a key is set), then details for the strongest candidates.
 * Picks that are a later season are shown as their first season, and each pick is matched to
 * a title in the catalog so it opens on its page.
 */
import { DETAILS_BATCH, bestAniListMatch, createAniListClient, normalizeAniListList, verifyAuthenticatedAniListSession } from "../integrations/anilist.js";
import { createTmdbClient } from "../integrations/tmdb.js";
import { fetchLetterboxdFeed, readLetterboxdExport } from "../integrations/letterboxd.js";
import { fitCurve, linkStrength, mergeRatings, ratingScale, ratingSignal, recommend, roundScore } from "./recommend.js";
import { RECS_INTERVALS, appRatingKey } from "./recs-store.js";

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
  let bestScore = -Infinity;
  const bestById = new Map();
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
    if (score > bestScore) {
      bestScore = score;
      bestById.clear();
    }
    if (score === bestScore && !bestById.has(result.id)) bestById.set(result.id, result);
  }
  // Several search hits for the same IMDb identity are harmless; equally
  // plausible *different* IMDb IDs cannot be bound by provider result order.
  return bestScore >= 4 && bestById.size === 1 ? bestById.values().next().value : null;
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

// An imported score has a stable AniList media ID, but its title is not proof
// that an unrelated local IMDb work owns it. Require the independent, exact
// provider→catalog crosswalk already stored on that media ID.
function confirmedImportedAniListId(rating, imported, items) {
  if (!/^tt\d{5,12}$/.test(String(rating.catalogId || ""))
    || rating.season !== null) return null;
  const movie = rating.kind === "anime-movie";
  const matches = imported.filter((entry) => {
    const item = items.get(entry.itemId);
    if (!item || item.imdbId !== rating.catalogId) return false;
    if (movie ? item.format !== "MOVIE" : !TV_LIKE.has(item.format)) return false;
    // The graph's season number is mutable; never use it to authorize
    // ownership of a local season-specific rating.
    return true;
  });
  return matches.length === 1 ? matches[0].itemId : null;
}

export function createRecsService({ store, searchCatalog = async () => [], anilist = createAniListClient(), verifyAuthenticatedAniList = verifyAuthenticatedAniListSession, tmdbFactory = (key) => createTmdbClient({ key }), letterboxdFeed = fetchLetterboxdFeed, now = Date.now, log = console } = {}) {
  let current = null;
  // Suggestions may be recomputed after a restart, but never persisted as
  // authoritative crosswalks or used as rating/account identity.
  const catalogSuggestions = new Map();
  let timer = null;
  let stopped = false;
  let shutdownDrain = null;
  const eligibleRatings = () => store.ratingsForRecommendations?.() || store.ratings().filter((entry) => entry.accountId !== "legacy:unverified");
  let revision = 0;
  let authenticatedImportAttempt = 0;
  const authenticatedImports = new Set();
  const stale = () => fail("Account or cache changed during the update; the previous request was superseded", 409);
  const ensureCurrent = (state) => { if (stopped || state.revision !== revision || state.cancelled) throw stale(); };
  const invalidate = ({ cleared = false } = {}) => {
    revision += 1;
    if (current) {
      current.cancelled = true;
      if (!cleared && current.runId) store.finishRun(current.runId, { status: "failed", error: "Account changed during update" });
      current = null;
    }
    libraryRun = null;
    libraryMisses.clear();
    catalogSuggestions.clear();
    return revision;
  };
  // This process has no update running yet, so a run still marked "running" was cut short.
  store.failInterruptedRuns?.();

  const tmdbFor = (settings) => {
    if (!settings.tmdbKey) return null;
    try { return tmdbFactory(settings.tmdbKey); } catch { return null; }
  };
  const conflictsWithKnownImdb = (itemId, catalogId) => {
    const known = itemId && catalogId ? store.item(itemId) : null;
    return Boolean(known?.imdbId && known.imdbId !== catalogId);
  };

  async function uniqueCatalogMatch(titles, options) {
    // Catalog aliases can return different result subsets. Resolve against the
    // entire candidate set so an ambiguous first search cannot be resolved by
    // whichever alias happens to appear next in the provider's ordering.
    const candidates = [];
    for (const title of titles) {
      const matches = await searchCatalog(title);
      if (Array.isArray(matches)) candidates.push(...matches);
    }
    return bestCatalogMatch(candidates, { titles, ...options });
  }

  function publicSettings() {
    const settings = store.settings();
    return {
      mode: settings.mode,
      intervalDays: settings.intervalDays,
      intervals: RECS_INTERVALS,
      // The browser checks the exact independently attested numeric user and
      // authenticated flag before adopting a Library snapshot. These are
      // public identity/status metadata, NOT OAuth credentials or a token.
      anilist: settings.anilist ? {
        username: settings.anilist.username,
        userId: Number.isSafeInteger(settings.anilist.userId) && settings.anilist.userId > 0
          ? settings.anilist.userId : null,
        authenticated: settings.anilist.authenticated === true,
        scoreSync: settings.anilist.authenticated === true && settings.anilist.scoreSync === true,
        syncedAt: settings.anilist.syncedAt,
        count: settings.anilist.count,
        scored: settings.anilist.scored,
      } : null,
      letterboxd: settings.letterboxd ? { username: settings.letterboxd.username || "", syncedAt: settings.letterboxd.syncedAt || null, count: settings.letterboxd.count || 0, scored: settings.letterboxd.scored ?? null, importedAt: settings.letterboxd.importedAt || null, imported: settings.letterboxd.imported || 0 } : null,
      tmdb: { linked: Boolean(settings.tmdbKey), checkedAt: settings.tmdbCheckedAt || null },
    };
  }

  function status() {
    const settings = store.settings();
    const last = store.lastRun();
    const ratingsChanged = settings.ratingsChangedAt > (last?.started_at || 0);
    const eligible = eligibleRatings().length > 0 || Boolean(settings.anilist?.username || settings.letterboxd?.username);
    const nextRunAt = eligible && settings.mode === "auto"
      ? Math.max(now(), nextScheduledRunAt(settings)) : null;
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
      suggestedCatalogId: catalogSuggestions.get(item.itemId) || null,
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
    // The running scheduler reads persisted settings on every due check.
    // Switching to automatic can start an overdue refresh immediately.
    if (patch.mode === "auto" && !current) checkScheduledRefresh();
    return overview();
  }

  function applyAniListList(list, { authenticated = false, scoreSync = false } = {}) {
    store.upsertItems(list.entries.map((entry) => entry.media));
    store.replaceSourceRatings("anilist", list.entries.map(({ media, ...entry }) => entry),
      { account: { username: list.user.name, userId: list.user.id } });
    store.saveSettings({ anilist: { username: list.user.name, userId: list.user.id, authenticated, scoreSync: authenticated && scoreSync, syncedAt: now(), count: list.entries.length, scored: list.entries.filter((entry) => entry.score !== null).length } });
  }

  async function linkAuthenticatedAniList(credentials = {}, { signal } = {}) {
    // A transient bearer authorizes this import, not a browser-posted Viewer.
    // Production independently fetches Viewer and collection from AniList.
    const { token, userId, scoreSyncEnabled } = credentials || {};
    if (typeof token !== "string" || !/^[A-Za-z0-9_.-]{40,4096}$/.test(token))
      throw fail("AniList account verification requires your connected access token. Existing ratings were preserved.", 401);
    if (!Number.isSafeInteger(userId) || userId <= 0)
      throw fail("The connected AniList account ID is invalid. Existing ratings were preserved.");
    if (stopped) throw fail("Recommendations service has stopped", 503);
    const attempt = ++authenticatedImportAttempt;
    const requestRevision = revision;
    const work = (async () => {
    const verified = await upstream(() => verifyAuthenticatedAniList({ token, expectedUserId: userId, signal }));
    if (stopped || signal?.aborted || attempt !== authenticatedImportAttempt || requestRevision !== revision) throw stale();
    const viewer = verified?.Viewer;
    const collection = verified?.MediaListCollection;
    if (!Number.isSafeInteger(viewer?.id) || viewer.id <= 0
        || !/^[A-Za-z0-9_-]{2,40}$/.test(String(viewer.name || ""))
        || viewer.id !== userId
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
      if (!Number.isSafeInteger(id) || id <= 0 || !(entry.score === null || (entry.score !== "" && Number.isFinite(Number(entry.score))))
          || Number(entry.score) < 0 || Number(entry.score) > 10
          || !(entry.progress === null || (Number.isInteger(entry.progress) && entry.progress >= 0)))
        throw fail("AniList returned an incomplete score or media entry. No ratings were changed.");
      const signature = JSON.stringify([entry.score, entry.status || null, entry.progress, entry.updatedAt || null]);
      if (seen.has(id) && seen.get(id) !== signature)
        throw fail("AniList returned conflicting entries for the same anime. No ratings were changed.");
      seen.set(id, signature);
    }
    const list = normalizeAniListList(verified);
    if (list.user?.id !== viewer.id || list.entries.length > seen.size)
      throw fail("AniList returned an incomplete authenticated list. No existing ratings were changed.");
    if (stopped || signal?.aborted || attempt !== authenticatedImportAttempt || requestRevision !== revision) throw stale();
    invalidate();
    applyAniListList(list, { authenticated: true, scoreSync: scoreSyncEnabled === true });
    checkScheduledRefresh();
    return overview();
    })();
    authenticatedImports.add(work);
    try { return await work; }
    finally { authenticatedImports.delete(work); }
  }

  /** Turning two-way scores OFF is local and non-elevating. Never require an
   * upstream read just to honor an opt-out while the provider is unavailable.
   * Enabling again is deliberately possible only after a fresh verified import.
   */
  function disableAuthenticatedAniListScores(userId) {
    if (stopped) throw fail("Recommendations service has stopped", 503);
    if (!Number.isSafeInteger(userId) || userId <= 0) throw fail("AniList account ID is invalid");
    const existing = store.settings().anilist;
    if (!existing || existing.userId !== userId || existing.authenticated !== true)
      throw fail("AniList account changed; reconnect before changing authenticated score settings", 409);
    // Fence a previously started true-enabled authenticated import before it
    // can restore score precedence after this explicit user opt-out.
    authenticatedImportAttempt += 1;
    if (existing.scoreSync === true)
      store.saveSettings({ anilist: { ...existing, scoreSync: false } });
    return overview();
  }

  async function linkAniList(username) {
    const name = String(username || "").trim();
    if (!/^[A-Za-z0-9_-]{2,40}$/.test(name)) throw fail("Enter your AniList user name");
    const requestRevision = invalidate();
    const list = await upstream(() => anilist.userList(name));
    if (requestRevision !== revision) throw stale();
    if (!list.user) throw fail("That AniList user wasn't found, or their list is private.", 404);
    applyAniListList(list);
    checkScheduledRefresh();
    return overview();
  }

  async function syncAniList() {
    const linked = store.settings().anilist;
    if (!linked?.username) throw fail("Link an AniList account first");
    if (linked.authenticated) throw fail("Refresh your authenticated AniList list in LVL instead of using the public username lookup.");
    const requestRevision = revision;
    const list = await upstream(() => anilist.userList(linked.username));
    if (requestRevision !== revision || store.settings().anilist?.username !== linked.username) throw stale();
    applyAniListList(list);
    return overview();
  }

  function unlinkAniList() {
    invalidate();
    store.removeSourceRatings("anilist");
    store.saveSettings({ anilist: null });
    return overview();
  }

  async function setTmdbKey(key) {
    const value = String(key || "").trim();
    if (!value) {
      invalidate();
      store.saveSettings({ tmdbKey: "", tmdbCheckedAt: null });
      return overview();
    }
    const requestRevision = invalidate();
    await upstream(() => tmdbFactory(value).validate());
    if (requestRevision !== revision) throw stale();
    store.saveSettings({ tmdbKey: value, tmdbCheckedAt: now() });
    return overview();
  }

  async function linkLetterboxd(username) {
    const requestRevision = invalidate();
    const feed = await upstream(() => letterboxdFeed(username));
    if (requestRevision !== revision) throw stale();
    if (!feed.entries.length) throw fail("No recent films found in this public Letterboxd feed. Import your Letterboxd export (.zip) for your full ratings.", 422);
    store.mergeSourceRatings("letterboxd", feed.entries, { account: { username: feed.username } });
    const previous = store.settings().letterboxd || {};
    const sameAccount = String(previous.username || "").toLowerCase() === String(feed.username).toLowerCase();
    store.saveSettings({ letterboxd: { ...(sameAccount ? previous : { importedAt: previous.importedAt, imported: previous.imported }),
      username: feed.username, syncedAt: now(), count: feed.entries.length,
      scored: feed.entries.filter((entry) => Number.isFinite(entry.score)).length } });
    checkScheduledRefresh();
    return overview();
  }

  function importLetterboxd(buffer) {
    const entries = readLetterboxdExport(buffer);
    if (!entries.length) throw fail("No films were found in that file. Use the .zip from Letterboxd › Settings › Data › Export your data.", 422);
    invalidate();
    // A manual CSV export has no authenticated account proof: keep it in the
    // explicit import namespace, including when a public profile is linked.
    store.mergeSourceRatings("letterboxd", entries, { account: {} });
    const previous = store.settings().letterboxd || {};
    store.saveSettings({ letterboxd: { ...previous, importedAt: now(), imported: entries.length } });
    checkScheduledRefresh();
    return overview();
  }

  function unlinkLetterboxd() {
    invalidate();
    store.removeSourceRatings("letterboxd");
    store.saveSettings({ letterboxd: null });
    return overview();
  }

  // /api/ratings is a local user-edit endpoint, not an authenticated AniList
  // import endpoint. A caller-supplied {accountUserId,mediaId,score} is only a
  // claim until the *independently verified*, active backend AniList snapshot
  // contains that exact account's scored media. Core's accepted sync replay
  // calls store.setAppRating directly, preserving historical foreign-account
  // provenance without pretending a newly linked account attested to it.
  function verifiedLocalAniListCopy(provenance, { catalogId, seriesKey, season, kind, score }) {
    if (provenance == null) return null;
    const linked = store.settings().anilist;
    const accountUserId = provenance?.accountUserId;
    const mediaId = provenance?.mediaId;
    if (provenance?.source !== "anilist"
      || !Number.isSafeInteger(accountUserId) || accountUserId <= 0
      || !Number.isSafeInteger(mediaId) || mediaId <= 0
      || linked?.authenticated !== true || linked.userId !== accountUserId
      || !["anime", "anime-movie"].includes(kind)
      || !Number.isFinite(score) || provenance.score !== score)
      throw fail("AniList score ownership is no longer verified; refresh the authenticated list before copying.", 409);
    const itemId = `anilist:${mediaId}`;
    const records = store.ratings().filter((row) => row.source === "anilist"
      && row.accountId === `user:${accountUserId}` && row.itemId === itemId);
    const item = store.item(itemId);
    const savedApp = store.rating(appRatingKey({ catalogId, seriesKey, season, kind }));
    // The independent account/media attestation identifies *who* scored a
    // provider entry, not which LVL work it belongs to. A verified IMDb
    // crosswalk or an already mapped exact app work is required before
    // copying that number into another title. A bare browser title/seriesKey
    // cannot mint a provider-to-work link.
    const boundWork = catalogId
      ? item?.imdbId === catalogId
      : savedApp?.source === "app" && savedApp.itemId === itemId
        && savedApp.kind === kind;
    if (records.length !== 1 || records[0].score !== score
      || item?.source !== "anilist"
      || !boundWork
      || (kind === "anime-movie" ? item.format !== "MOVIE" : item.format === "MOVIE")
      || (catalogId && item.imdbId && item.imdbId !== catalogId))
      throw fail("The authenticated AniList score does not match this media and rating kind.", 409);
    return { source: "anilist", accountUserId, mediaId, score };
  }

  /** Your rating of a title in the app (1.00–10.00), or none to remove it. */
  function rate({ catalogId = "", seriesKey = "", season = null, title = "", kind = "", year = null, score = null, status = null, provenance = null, expectedLocalUpdatedAt = undefined, anilistIds = [], statusOnly = false, scoreOnly = false } = {}) {
    if (catalogId && !/^tt\d{5,12}$/.test(String(catalogId))) throw fail("Unknown title");
    if (!catalogId && !seriesKey) throw fail("A title is required");
    const preserveScore = statusOnly === true;
    const value = preserveScore || score === null || score === "" ? null : roundScore(score);
    if (!preserveScore && score !== null && score !== "" && value === null) throw fail("A rating is a number from 1 to 10");
    const validatedKind = KINDS.has(kind) ? kind : null;
    const verifiedProvenance = preserveScore ? null : provenance;
    if (verifiedProvenance && expectedLocalUpdatedAt === undefined)
      throw fail("AniList score copy requires the current local rating revision.", 409);
    const saved = store.setAppRating({
      catalogId: catalogId || "", seriesKey: String(seriesKey || "").slice(0, 300), season: Number.isInteger(season) ? season : null,
      title: String(title || "").slice(0, 300), kind: validatedKind, year: Number(year) || null, score: value,
      status: ["COMPLETED", "CURRENT", "DROPPED", "PAUSED", "PLANNING"].includes(status) ? status : null,
      provenance: verifiedProvenance,
      expectedLocalUpdatedAt: verifiedProvenance ? expectedLocalUpdatedAt : undefined,
      statusOnly: preserveScore,
      // A score-clear action must not implicitly delete the tracking status.
      // The store applies this against the current row in one transaction.
      scoreOnly: scoreOnly === true && !preserveScore,
    }, { verifyWrite: verifiedProvenance
      ? () => verifiedLocalAniListCopy(verifiedProvenance, {
        catalogId, seriesKey, season: Number.isInteger(season) ? season : null,
        kind: validatedKind, score: value,
      })
      : null });
    checkScheduledRefresh();
    return { rating: saved, ...titleRatings({ catalogId, seriesKey, kind: validatedKind, title, year, anilistIds }) };
  }

  /** Title-page imports require a verified provider→catalog crosswalk. */
  function titleRatings({ catalogId = "", seriesKey = "", kind = null, year = null, anilistIds = [] } = {}) {
    const found = store.titleRatings({ catalogId, seriesKey, kind, year, anilistIds });
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
    if (stopped) return Promise.reject(fail("Recommendations service has stopped", 503));
    if (!libraryRun) {
      const request = buildAniListLibrary().finally(() => {
        // invalidate() may have replaced the old account's request while it
        // was waiting on catalog lookups. Old cleanup cannot release the new
        // generation's shared request slot.
        if (libraryRun === request) libraryRun = null;
      });
      libraryRun = request;
    }
    return libraryRun;
  }

  async function buildAniListLibrary() {
    const requestRevision = revision;
    const verify = () => { if (stopped || requestRevision !== revision) throw stale(); };
    const syncedAt = store.settings().anilist?.syncedAt || null;
    const entries = eligibleRatings().filter((rating) => rating.source === "anilist" && String(rating.itemId || "").startsWith("anilist:"));
    if (!entries.length) return { syncedAt, shows: [] };
    const loaded = (id) => (store.item(id)?.fetchedAt || 0) > 1;
    // The list doesn't say which entries are seasons of one show; AniList's relations do. Earlier
    // seasons that aren't on your list are read too, so a show starts at its first season.
    const read = new Set();
    let pending = entries.map((entry) => entry.itemId).filter((id) => !loaded(id));
    for (let round = 0; round < 4 && pending.length; round += 1) {
      const batch = [...new Set(pending)].slice(0, 150);
      batch.forEach((id) => read.add(id));
      const details = await upstream(() => anilist.details(batch));
      verify();
      store.upsertItems(details.map(({ item }) => item));
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
    // Title/year lookup suggests catalog pages but never verifies the identity.
    // Only an explicitly reconciled provider ID may become a stored IMDb link.
    const unmatched = shows.filter((show) => {
      if (show.imdbId) return false;
      // Positive catalog candidates are display-only suggestions, not verified
      // work identity. Reuse them for this service/account generation instead
      // of probing the same aliases again on every Library opening.
      const suggested = catalogSuggestions.get(show.showId);
      if (suggested) {
        show.suggestedCatalogId = suggested;
        return false;
      }
      return now() - (libraryMisses.get(show.showId) || 0) >= DAY;
    });
    await eachLimit(unmatched, MATCH_CONCURRENCY, async (show) => {
      const root = items.get(show.showId);
      const titles = catalogTitles(root);
      try {
        const found = await uniqueCatalogMatch(titles, { year: root.year, movie: show.type === "movie" });
        verify();
        if (found) {
          show.suggestedCatalogId = found.id;
          catalogSuggestions.set(show.showId, found.id);
          return;
        }
        libraryMisses.set(show.showId, now());
      } catch (error) {
        verify();
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
    overview, status, updateSettings, linkAniList, linkAuthenticatedAniList, disableAuthenticatedAniListScores, syncAniList, unlinkAniList, setTmdbKey, linkLetterboxd, importLetterboxd, unlinkLetterboxd, rate, titleRatings,
    anilistLibrary: () => anilistLibrary(),
    refresh: (options) => refresh(options),
    hide(itemId) { store.hide(String(itemId || "")); return overview(); },
    unhideAll() { store.unhideAll(); return overview(); },
    clearCache() { invalidate({ cleared: true }); store.clearCache(); return overview(); },
    startScheduler: () => startScheduler(),
    // Synchronous cancellation fences every awaited producer immediately.
    // Callers may await the bounded drain before closing the SQLite store.
    stopScheduler: (options) => stopScheduler(options),
  };

  // ----------------------------------------------------------------- refresh

  function refresh({ trigger = "manual" } = {}) {
    if (stopped) return Promise.reject(fail("Recommendations service has stopped", 503));
    if (current) return current.promise;
    const state = { trigger, phase: "Starting", startedAt: now(), progress: 0, revision };
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
    state.runId = runId;
    try {
      state.progress = 0.02;
      await syncLinked(state, settings);
      ensureCurrent(state);
      state.progress = 0.08;
      await matchRatings(state, tmdb);
      ensureCurrent(state);
      state.progress = 0.15;
      const merged = mergeRatings(eligibleRatings().filter((rating) => rating.itemId), {
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
        if (!store.savePicks(runId, []) || !store.finishRun(runId, { status: "done", requests: requests() })) throw stale();
        return overview();
      }
      await readFanLinks(state, { animeSeeds, tmdbSeeds, tmdb, maxAgeMs: settings.intervalDays * DAY });
      ensureCurrent(state);

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
        const fresh = await detailsWithProgress(state, staleAnime, { from: 0.45, to: 0.68 });
        ensureCurrent(state);
        store.upsertItems(fresh.map(({ item }) => item));
      }
      assignShows();

      state.phase = "Ranking";
      state.progress = 0.7;
      const curve = fitCurve(store.outcomes(scale.mean));
      const result = recommend({ ratings: merged, items: store.items([...seeds, ...candidates]), links, hidden: store.hidden(), curve, limit: PICK_LIMIT * 2 });
      const picks = (await firstSeasons(state, result.picks, known)).slice(0, PICK_LIMIT).map((pick, index) => ({ ...pick, rank: index + 1 }));
      ensureCurrent(state);
      state.phase = "Matching picks to titles";
      state.progress = 0.8;
      await matchPicks(state, picks, tmdb);
      ensureCurrent(state);
      if (!store.savePicks(runId, picks) || !store.finishRun(runId, { status: "done", seeds: seeds.length, candidates: result.candidates, picks: picks.length, requests: requests(), curve })) throw stale();
      return overview();
    } catch (error) {
      // stopScheduler already records the final cancellation while SQLite is
      // open. A late provider rejection cannot write after the drain deadline.
      if (!stopped && state.revision === revision)
        store.finishRun(runId, { status: "failed", requests: requests(), error: error.message || String(error) });
      throw error;
    }
  }

  async function syncLinked(state, settings) {
    if (settings.anilist?.username && !settings.anilist.authenticated && now() - (settings.anilist.syncedAt || 0) > HOUR) {
      state.phase = "Reading your AniList list";
      try {
        const list = await anilist.userList(settings.anilist.username);
        ensureCurrent(state);
        if (list.user?.id !== settings.anilist.userId && settings.anilist.userId) throw stale();
        applyAniListList(list);
      } catch (error) { ensureCurrent(state); log.warn?.("AniList sync failed:", error.message); }
    }
    if (settings.letterboxd?.username && now() - (settings.letterboxd.syncedAt || 0) > HOUR) {
      state.phase = "Reading your Letterboxd diary";
      try {
        const feed = await letterboxdFeed(settings.letterboxd.username);
        ensureCurrent(state);
        if (feed.username.toLowerCase() !== settings.letterboxd.username.toLowerCase()) throw stale();
        if (!feed.entries?.length) throw fail("No Letterboxd diary entries returned", 422);
        store.mergeSourceRatings("letterboxd", feed.entries, { account: { username: feed.username } });
        store.saveSettings({ letterboxd: { ...settings.letterboxd, syncedAt: now(), count: feed.entries.length,
          scored: feed.entries.filter((entry) => Number.isFinite(entry.score)).length } });
      } catch (error) { ensureCurrent(state); log.warn?.("Letterboxd sync failed:", error.message); }
    }
  }

  // Only exact verified provider/catalog relations may connect app ratings to
  // other services. Provisional Letterboxd export rows remain independent.
  async function matchRatings(state, tmdb) {
    const retryBefore = now() - MAP_RETRY;
    const imported = eligibleRatings().filter((rating) => rating.source === "anilist" && rating.itemId);
    const importedItems = store.items(imported.map((rating) => rating.itemId));
    for (const rating of store.unmappedRatings("app", retryBefore)) {
      if (rating.kind === "anime" || rating.kind === "anime-movie") {
        const importedId = confirmedImportedAniListId(rating, imported, importedItems);
        if (importedId) {
          store.setRatingItem(rating.key, importedId);
          continue;
        }
        // An AniList search hit or prequel-season ordinal is only a possible
        // match. Do not create a provider ID/crosswalk or change the rating
        // authority without an explicit stable-media reconciliation.
        store.setRatingItem(rating.key, null);
      } else if (tmdb && rating.catalogId && (rating.kind === "movie" || rating.kind === "series")) {
        state.phase = `Finding ${rating.title} on TMDB`;
        const found = await tmdb.findImdb(rating.catalogId);
        ensureCurrent(state);
        const type = rating.kind === "movie" ? "movie" : "tv";
        const id = type === "movie" ? found.movie : found.tv;
        const verifiedId = id && !conflictsWithKnownImdb(`tmdb:${type}:${id}`, rating.catalogId) ? id : null;
        if (verifiedId) store.upsertItems([{ itemId: `tmdb:${type}:${verifiedId}`, source: "tmdb", sourceId: `${type}:${verifiedId}`, kind: type === "movie" ? "movie" : "series", title: rating.title, format: type, year: rating.year, imdbId: rating.catalogId, tmdbId: String(verifiedId), fetchedAt: 1 }]);
        store.setRatingItem(rating.key, verifiedId ? `tmdb:${type}:${verifiedId}` : null);
      }
    }
    // Imported CSV/diary titles lacking a provider film ID remain provisional.
    // TMDb title/year search cannot upgrade them to owned ratings.
  }

  // AniList details read a batch at a time, moving the progress bar from `from` to `to`.
  async function detailsWithProgress(state, ids, { links = false, from = 0, to = 1 } = {}) {
    const out = [];
    for (let index = 0; index < ids.length; index += DETAILS_BATCH) {
      const batch = await anilist.details(ids.slice(index, index + DETAILS_BATCH), { links });
      ensureCurrent(state);
      out.push(...batch);
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
      const read = await detailsWithProgress(state, staleAnime, { links: true, from: 0.15, to: animeEnd });
      ensureCurrent(state);
      for (const { item, links } of read) {
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
        ensureCurrent(state);
        if (details) store.upsertItems([details]);
        const found = await tmdb.recommendations(kind, id);
        ensureCurrent(state);
        store.upsertItems(found.items);
        store.setLinks(seed, found.links);
      } catch (error) {
        ensureCurrent(state);
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
      const fetched = await anilist.details([...new Set(missing)].slice(0, 50));
      ensureCurrent(state);
      store.upsertItems(fetched.map(({ item }) => item));
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
        await matchPick(pick, tmdb, state);
      } catch (error) {
        log.warn?.("Matching a pick failed:", error.message);
      }
      done += 1;
      state.progress = 0.8 + 0.19 * (done / Math.max(1, picks.length));
    });
  }

  async function matchPick(pick, tmdb, state = null) {
    const item = store.item(pick.itemId);
    if (!item || item.imdbId) return;
    if (item.source === "tmdb") {
      if (!tmdb) return;
      const [, type, id] = item.sourceId.match(/^(movie|tv):(\d+)$/) || [];
      const details = type ? await tmdb.details(type, id) : null;
      if (state) ensureCurrent(state);
      if (details) store.upsertItems([details]);
      return;
    }
    const titles = catalogTitles(item);
    const movie = item.format === "MOVIE";
    const found = await uniqueCatalogMatch(titles, { year: item.year, movie });
    if (state) ensureCurrent(state);
    if (found) catalogSuggestions.set(item.itemId, found.id);
  }

  // ----------------------------------------------------------------- schedule

  // A successful generation (manual or automatic) satisfies the configured
  // number of local calendar days, not an arbitrary rolling UTC duration.
  // A failed run leaves old picks intact; the persisted failure delays retry
  // for an hour, including when the app is opened again after a crash.
  function nextLocalBoundary(timestamp, intervalDays) {
    const boundary = new Date(timestamp);
    boundary.setHours(0, 0, 0, 0);
    boundary.setDate(boundary.getDate() + intervalDays);
    return boundary.getTime();
  }

  function nextScheduledRunAt(settings = store.settings()) {
    const lastGood = store.lastGoodRun();
    const last = store.lastRun();
    const nextSuccess = lastGood
      ? nextLocalBoundary(lastGood.finished_at || lastGood.started_at, settings.intervalDays) : 0;
    const failedAfterSuccess = last?.status === "failed" && (!lastGood || last.run_id > lastGood.run_id);
    const nextRetry = failedAfterSuccess ? (last.finished_at || last.started_at) + FAILED_AUTO_RETRY : 0;
    return Math.max(nextSuccess, nextRetry);
  }

  function checkScheduledRefresh() {
    if (stopped || current || !timer) return;
    const settings = store.settings();
    if (settings.mode !== "auto") return;
    const hasRatings = eligibleRatings().length > 0 || Boolean(settings.anilist?.username || settings.letterboxd?.username);
    if (!hasRatings || now() < nextScheduledRunAt(settings)) return;
    refresh({ trigger: "auto" }).catch((error) => log.warn?.("Automatic recommendations refresh failed:", error.message));
  }

  // Check as soon as the app opens, then check periodically if it remains open.
  // Reopening on the same day never generates a second set of picks.
  function startScheduler({ everyMs = 5 * 60 * 1000 } = {}) {
    if (stopped) throw fail("Recommendations service has stopped", 503);
    if (timer) clearInterval(timer);
    timer = setInterval(checkScheduledRefresh, everyMs);
    timer.unref?.();
    checkScheduledRefresh();
    return checkScheduledRefresh;
  }

  function stopScheduler({ timeoutMs = 5_000 } = {}) {
    if (shutdownDrain) return shutdownDrain;
    if (timer) clearInterval(timer);
    timer = null;
    // Capture both independent workflows before invalidating their generation.
    const pending = [current?.promise, libraryRun, ...authenticatedImports].filter(Boolean);
    const run = current;
    revision += 1;
    if (run) run.cancelled = true;
    current = null;
    libraryRun = null;
    libraryMisses.clear();
    // This is the last permitted write by this service: record a cancelled run
    // before the stopped fence is published, while the database is still open.
    if (run?.runId) store.finishRun(run.runId, {
      status: "failed", error: "Recommendations service stopped",
    });
    stopped = true;
    const boundedMs = Number.isFinite(timeoutMs)
      ? Math.max(0, Math.min(15_000, Math.floor(timeoutMs))) : 5_000;
    shutdownDrain = (async () => {
      if (!pending.length) return { drained: true, pending: 0 };
      let alarm;
      try {
        const drained = await Promise.race([
          Promise.allSettled(pending).then(() => true),
          new Promise((resolve) => { alarm = setTimeout(() => resolve(false), boundedMs); }),
        ]);
        return { drained, pending: drained ? 0 : pending.length };
      } finally {
        if (alarm !== undefined) clearTimeout(alarm);
      }
    })();
    return shutdownDrain;
  }
}
