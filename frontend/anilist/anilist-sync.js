// AniList: automatic sync, scores and the library import.
import { toast } from "../ui/ui.js";
import { chapterCode } from "../../shared/media/series-sources.js";
import {
  canLinkAniListTv, fillMissingAniListAverages, importedEntryId, planAniListLibrary, seriesAniList,
  verifiedAniListLibraryIdentity,
} from "./anilist-library.js";
import { resolveVerifiedAniListLibraryLinks } from "./anilist-auto-association.js";
import {
  ANILIST_AUTH_LIBRARY_QUERY, ANILIST_CALLBACK_PATH, ANILIST_LIST_QUERY, ANILIST_OAUTH_PENDING,
  ANILIST_OAUTH_STORAGE, ANILIST_SAVE_PROGRESS, ANILIST_SINGLE_PROGRESS_QUERY, ANILIST_SYNC_QUEUE,
  ANILIST_VIEWER_QUERY, anilistGraphql, consumeAniListCallback, consumeAniListLocalCallback,
  parseAniListPinToken, readAniListAccount, readAniListPreference, remoteAniListEntries,
  writeAniListPreference,
} from "./anilist-auto-client.js";
import { planAniListWatchSync, reconcileAniListProgressQueue, resolveAniListEpisode } from "./anilist-watch-sync.js";
import { runAniListReversibleSmoke } from "./anilist-test-sync.js";
import {
  acknowledgeUnconfirmedAniListScore, planAniListScoresIntoLvl, planMissingAniListScores,
  readUnconfirmedAniListScore, resolveAniListScorePart, saveAniListScore,
  stageUnconfirmedAniListScore,
} from "./anilist-score-sync.js";
import {
  eligibleForPublicAnimeRating, fetchPublicAniListSequels, fetchPublicAniListTitle,
  matchPublicAniListSeasons, verifiedPublicAniListLinks,
} from "../catalog/title-public-ratings.js";
import { ANILIST_LIBRARY_KEY, anilistOAuthResponse, calendarUi, recsUi, state } from "../../app.js";
import { persistentAppStateReady, readStorageArray, readStorageObject, saveLibrary } from "../app/saved-state.js";
import { $, setToolStatus } from "../app/dom.js";
import { fetchJson, postJson } from "../app/http.js";
import { viewActive } from "../app/navigation.js";
import { renderWatchChapters } from "../watch/watch-page.js";
import {
  explicitAniListUnwatchRun, explicitlyUnwatchedChapter, flushAniListUnwatches,
  invalidateAniListUnwatchApprovals,
} from "../watch/watched-status.js";
import {
  addCatalogPlaceholder, buildLibrarySeries, libraryEntryById, librarySeriesKey,
  updateLibrarySeriesEntries,
} from "../library/library-data.js";
import { renderLibrary, updateLibrarySummary } from "../library/library-page.js";
import { refreshTitlePage } from "../title/title-page.js";

export let anilistAutoTimer = 0;
export let anilistAutoRun = null;
let anilistAutoDevTestRun = false;
let anilistAutoAuthGeneration = 0;
let anilistAutoAuthPending = false;
let anilistAutoStatusMessage = "";
let anilistAutoRetryAfter = 0;
let anilistAutoLastQueueSnapshot = null;
let anilistAutoImportWarning = "";

let anilistLibraryRun = null;
let communityScoreBackfillStarted = false;
export function backfillAniListCommunityScores() {
  if (communityScoreBackfillStarted || !persistentAppStateReady
    || !state.library.some((entry) => entry.anilist?.showId && !(Number(entry.anilist.averageScore) > 0))) return;
  communityScoreBackfillStarted = true;
  // Existing server-side AniList metadata already has public scores. Refresh
  // missing values once per app session, without another AniList request or
  // re-importing titles, statuses, ratings or playing sources.
  void fetchJson("/api/recs/anilist/library").then((data) => {
    if (!Array.isArray(data?.shows)) return;
    if (!fillMissingAniListAverages(state.library, data.shows)) return;
    saveLibrary();
    if (viewActive("library")) renderLibrary();
  }).catch(() => {});
}
const ANILIST_SCORE_SYNC_KEY = "lvl-anilist-score-sync-v1";
const anilistScoreRuns = new Map();
export function anilistScoreSyncEnabled() {
  const account = readAniListAccount(localStorage);
  if (!account) return false;
  try {
    const prefs = JSON.parse(localStorage.getItem(ANILIST_SCORE_SYNC_KEY) || "{}");
    return prefs?.userId === account.userId && prefs.enabled === true;
  } catch { return false; }
}

// A title editor can outlive an account change, Library import, or manual
// season re-link. Re-read the currently saved title by exact Library identity;
// never use the legacy display-only association as write authorization.
export function authenticatedTitleAniList(subject, account) {
  if (!Number.isSafeInteger(account?.userId) || account.userId <= 0) return null;
  const key = subject?.seriesKey || subject?.key;
  const catalogId = subject?.catalogId || subject?.id || "";
  if (!key) return null;
  const series = buildLibrarySeries().find((item) => item.key === key && (!catalogId || item.catalogId === catalogId));
  return series ? seriesAniList(series, account.userId) : null;
}

export async function saveUserAniListScore(subject, season, score) {
  if (!anilistScoreSyncEnabled() || !["anime", "anime-movie"].includes(subject?.kind)) return "";
  if (anilistAutoDevTestRun) throw new Error("The AniList diagnostics test is running. Your score was saved locally; retry after it finishes.");
  const account = readAniListAccount(localStorage);
  const linked = authenticatedTitleAniList(subject, account);
  const part = resolveAniListScorePart(linked, season);
  const rendered = resolveAniListScorePart(subject?.anilist, season);
  if (!part || rendered?.anilistId !== part.anilistId)
    throw new Error("LVL saved your rating locally, but could not safely identify this AniList anime/season for the current account and Library mapping. Nothing was changed on AniList.");
  // Sometimes one AniList MediaList entry spans two LVL catalog seasons.
  // Those two local scores cannot be written as distinct AniList scores:
  // a second write would overwrite the first on the same remote entry.
  if (linked?.seasons?.some((entry) => entry.season !== season && entry.anilistId === part.anilistId))
    throw new Error("LVL saved the season rating locally. This AniList entry covers multiple LVL seasons, so separate season scores cannot be synced to it.");
  // Persist the *explicit* unsent edit before any network request. A failed
  // request or an external score conflict must not visually erase that edit.
  // Neither this pending record nor any request to the local server has a token.
  stageUnconfirmedAniListScore(localStorage, account.userId, part.anilistId, score);
  const key = `${account.userId}:${part.anilistId}`;
  // Avoid two rapid local edits racing each other on AniList's same list ID.
  const previous = anilistScoreRuns.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(async () => {
    const expectedRaw = Number.isFinite(part.score) && part.score > 0 ? Math.round(part.score * 10) : 0;
    const result = await saveAniListScore({
      account, mediaId: part.anilistId, score, expectedRaw, graphql: anilistGraphql,
      stillConnected: () => {
        // Revalidate throughout the asynchronous prewrite/mutation/readback,
        // not just before staging: a manual relink or Library refresh while
        // GraphQL is pending must never write the previous season/media ID.
        const latest = readAniListAccount(localStorage);
        return Boolean(anilistScoreSyncEnabled()) && latest?.token === account.token
          && latest?.userId === account.userId
          && resolveAniListScorePart(authenticatedTitleAniList(subject, latest), season)?.anilistId === part.anilistId
          && !authenticatedTitleAniList(subject, latest)?.seasons?.some((entry) => entry.season !== season && entry.anilistId === part.anilistId);
      },
    });
    if (readAniListAccount(localStorage)?.token !== account.token) return "AniList account changed.";
    part.score = result.scoreRaw ? result.scoreRaw / 10 : null;
    // Only acknowledge this exact edit. A newer queued edit on the same anime
    // must remain visible until its own round trip succeeds.
    acknowledgeUnconfirmedAniListScore(localStorage, account.userId, part.anilistId, score);
    // Persist the confirmed score locally before an optional full import;
    // if title metadata refresh is offline, the UI still shows the new value.
    saveLibrary();
    recsUi.invalidateRatings();
    // Fixed raw 100-point units permit one decimal in a 0–10 UI.
    await syncAniListLibrary({ quiet: true, skipScoreSync: true }).catch((error) => {
      console.warn("AniList score saved; Library refresh deferred:", error?.message);
    });
    const message = result.unchanged ? "Already up to date on AniList" : `Saved to AniList (${(result.scoreRaw / 10).toFixed(1)}/10)`;
    showAniListAutoStatus(message);
    toast(message);
    return message;
  });
  anilistScoreRuns.set(key, current);
  void current.finally(() => { if (anilistScoreRuns.get(key) === current) anilistScoreRuns.delete(key); }).catch(() => {});
  return current;
}

// Authenticated AniList is deliberately separate from the existing *public*
// AniList profile reader. GraphQL calls are made by this browser directly to
// AniList; LVL's localhost server never receives or stores OAuth credentials.
export function showAniListAutoStatus(message, error = false) {
  anilistAutoStatusMessage = message || "";
  const node = $("#anilist-auto-status");
  if (node) {
    node.textContent = message;
    node.dataset.error = error ? "true" : "false";
  }
}

export function renderAniListAutoSettings() {
  const options = readAniListPreference(localStorage);
  const account = readAniListAccount(localStorage);
  const storedAccount = readStorageObject(ANILIST_OAUTH_STORAGE);
  const redirect = $("#anilist-auto-redirect-url");
  if (redirect) redirect.textContent = window.location.origin + ANILIST_CALLBACK_PATH;
  const enabled = $("#anilist-auto-enabled");
  const scoreEnabled = $("#anilist-score-sync-enabled");
  if (scoreEnabled && document.activeElement !== scoreEnabled) scoreEnabled.checked = anilistScoreSyncEnabled();
  if (scoreEnabled) scoreEnabled.disabled = !account;
  const migrate = $("#anilist-score-migrate");
  if (migrate && !anilistScoreCopyRun) migrate.disabled = !account;
  const threshold = $("#anilist-auto-threshold");
  const client = $("#anilist-auto-client-id");
  if (enabled && document.activeElement !== enabled) enabled.checked = options.enabled;
  if (threshold && document.activeElement !== threshold) threshold.value = String(options.threshold);
  if (client && document.activeElement !== client) client.value = options.clientId;
  const stateNode = $("#anilist-auto-state");
  if (stateNode) {
    stateNode.textContent = account ? `Authorized: ${account.username}` : storedAccount.token ? "Reconnect required" : "";
    stateNode.hidden = !stateNode.textContent;
  }
  const connect = $("#anilist-auto-connect");
  const disconnect = $("#anilist-auto-disconnect");
  const sync = $("#anilist-auto-sync");
  // Always allow reauthorization. A revoked/expired token may have an old
  // reconciliation request in flight; blocking Connect until it finishes
  // can make the action appear inert, even though recovery requires login.
  if (connect) connect.disabled = false;
  if (connect) {
    connect.textContent = account ? "Reconnect AniList" : "Authorize account sync";
    connect.title = account ? `Already connected as ${account.username}. Reauthorize only if needed.` : "Connect an AniList account";
  }
  // An expired token is still sensitive local data. Keep Disconnect available
  // to remove it, including while an in-flight sync is being cancelled.
  if (disconnect) disconnect.disabled = !storedAccount.token;
  if (sync) sync.disabled = !account || Boolean(anilistAutoRun) || anilistAutoDevTestRun;
  const importConnected = $("#anilist-import-connected");
  if (importConnected) importConnected.hidden = !account;
  const diagnostics = $("#anilist-auto-dev-diagnostics");
  if (diagnostics) diagnostics.hidden = window.location.port !== "4187" || !account;
  if (account && !anilistAutoStatusMessage) {
    const last = Math.max(options.lastPull, options.lastPush);
    showAniListAutoStatus(options.enabled
      ? `Automatic progress syncing is on.${last ? ` Last synced ${new Date(last).toLocaleString()}.` : " Waiting for the first sync."}`
      : "Connected. Automatic writes are paused; use Sync now to update.");
  } else if (!account && !anilistAutoStatusMessage) {
    showAniListAutoStatus(storedAccount.token
      ? "Your previous AniList authorization has expired. Reconnect, or use Disconnect to erase the stored token."
      : "Connect your account to enable authorized syncing. Nothing is sent before you approve.");
  }
}

export function anilistStoredQueue() {
  const id = readAniListAccount(localStorage)?.userId;
  if (!Number.isSafeInteger(id) || id <= 0) return [];
  // The generic saved-state reader treats an inaccessible storage key as an
  // empty array. That is unsafe for a durable outbox: a later gather would
  // persist [] over thousands of unsent records. Read and parse exactly once,
  // propagating storage/JSON errors before ANY queue mutation.
  if (typeof localStorage.getItem !== "function") return readStorageArray(ANILIST_SYNC_QUEUE);
  const queueFrom = (text) => {
    if (text == null) return [];
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new Error("AniList pending queue cannot be read; unsent records were preserved."); }
    if (!Array.isArray(parsed)) throw new Error("AniList pending queue is invalid; unsent records were preserved.");
    return parsed;
  };
  const canonical = anilistQueueAccountKey(id);
  const canonicalText = localStorage.getItem(canonical);
  if (canonicalText != null) return queueFrom(canonicalText);
  const owner = Number(localStorage.getItem(ANILIST_QUEUE_OWNER_KEY)) || null;
  // A primary value is legacy-only; ownership cannot follow a partially
  // switched account. In particular, another account's archived entries must
  // never be selected by the current OAuth identity.
  return owner && owner !== id ? [] : queueFrom(localStorage.getItem(ANILIST_SYNC_QUEUE));
}
export function persistAniListQueue(queue) {
  const id = readAniListAccount(localStorage)?.userId;
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("AniList account is required to save pending work.");
  const content = JSON.stringify(Array.isArray(queue) ? queue : []);
  if (content.length > 4 * 1024 * 1024)
    throw new Error(`AniList queue capacity exceeded (${queue.length} records); previous pending work remains saved.`);
  const owner = Number(localStorage.getItem?.(ANILIST_QUEUE_OWNER_KEY)) || null;
  if (owner && owner !== id) switchAniListQueueAccount(id, owner);
  const canonical = anilistQueueAccountKey(id);
  if (localStorage.getItem?.(canonical) != null) {
    // Newer queues live solely under their authenticated user id. Do not copy
    // foreign data into the shared primary during an account transition.
    saveAniListQueueText(canonical, content);
  } else {
    // Existing same-account primary queues stay in place until a switch moves
    // them, avoiding a second full copy for a >5,000-row legacy queue.
    saveAniListQueueText(ANILIST_SYNC_QUEUE, content);
    saveAniListQueueText(ANILIST_QUEUE_OWNER_KEY, String(id));
  }
}

const ANILIST_QUEUE_OWNER_KEY = `${ANILIST_SYNC_QUEUE}-owner`;
const anilistQueueAccountKey = (id) => `${ANILIST_SYNC_QUEUE}-account-${id}`;

function saveAniListQueueText(key, text) {
  try {
    localStorage.setItem(key, text);
  } catch (error) {
    throw new Error(`AniList pending queue exceeds available local storage; previous unsent items remain saved. ${error?.message || "Storage full"}`);
  }
}

// The legacy key remains readable for older installations. The owner marker
// prevents its records being sent after a different-account authorization.
function switchAniListQueueAccount(nextId, previousId = null) {
  const owner = Number(localStorage.getItem?.(ANILIST_QUEUE_OWNER_KEY)) || Number(previousId) || null;
  const oldText = localStorage.getItem?.(ANILIST_SYNC_QUEUE);
  if (oldText && owner && owner !== nextId && localStorage.getItem?.(anilistQueueAccountKey(owner)) == null)
    saveAniListQueueText(anilistQueueAccountKey(owner), oldText);
  if (oldText && !owner) saveAniListQueueText(`${ANILIST_SYNC_QUEUE}-unowned`, oldText);
  // The target's own canonical key must exist before moving the marker. An
  // interrupted marker write leaves the original account's archive readable;
  // an interrupted OAuth write cannot reveal foreign pending entries.
  if (owner !== nextId && localStorage.getItem?.(anilistQueueAccountKey(nextId)) == null)
    saveAniListQueueText(anilistQueueAccountKey(nextId), "[]");
  saveAniListQueueText(ANILIST_QUEUE_OWNER_KEY, String(nextId));
}

const anilistAutoLinkAttempts = new Map();

/** Try exact metadata links for watched anime before building the write queue.
 * This never writes to AniList; the normal authenticated preflight still runs
 * before ANY watched-progress update. Unverifiable titles stay manual-only.
 */
async function autoLinkAniListWatchedSeries(account) {
  const threshold = readAniListPreference(localStorage).threshold / 100;
  const eligible = buildLibrarySeries().filter((series) => {
    if (series.type !== "series" || series.mediaKind !== "anime"
      || !/^tt\d{5,12}$/.test(series.catalogId || "")
      || seriesAniList(series, account.userId)?.seasons?.length) return false;
    if (series.sources.some((entry) => (entry.anilistManualLinks || []).some((link) => link.userId === account.userId)
      || (entry.anilistAutoLinks || []).some((link) => link.userId === account.userId))) return false;
    return series.sources.some((entry) => Object.values(entry.watchedChapters || {}).some(Boolean)
      || (entry.episodes || []).some((episode) => episode.progress?.finished
        || Number(episode.progress?.durationMs) > 0
          && Number(episode.progress.positionMs) / Number(episode.progress.durationMs) >= threshold));
  }).slice(0, 3);
  let linked = 0;
  for (const series of eligible) {
    const attemptKey = `${account.userId}:${series.catalogId}`;
    if (Date.now() - (anilistAutoLinkAttempts.get(attemptKey) || 0) < 30 * 60_000) continue;
    anilistAutoLinkAttempts.set(attemptKey, Date.now());
    try {
      const response = await fetchJson(`/api/catalog/meta?type=series&id=${encodeURIComponent(series.catalogId)}`);
      const meta = response?.meta;
      if (meta?.id !== series.catalogId || !Array.isArray(meta.seasons)) continue;
      const year = Number(String(meta.releaseInfo || "").match(/\d{4}/)?.[0]);
      const seasons = meta.seasons.filter((season) => season.season > 0 && Number(season.count) > 0);
      if (!Number.isInteger(year) || !seasons.length) continue;
      const media = await fetchPublicAniListTitle(meta.name);
      const match = matchPublicAniListSeasons({ media, title: meta.name, year, seasons });
      const links = verifiedPublicAniListLinks(match, { userId: account.userId, year, catalogId: series.catalogId });
      if (!links.length || readAniListAccount(localStorage)?.token !== account.token) continue;
      const current = buildLibrarySeries().find((item) => item.key === series.key && item.catalogId === series.catalogId);
      if (!current || seriesAniList(current, account.userId)?.seasons?.length
        || current.sources.some((entry) => (entry.anilistManualLinks || []).some((link) => link.userId === account.userId)
          || (entry.anilistAutoLinks || []).some((link) => link.userId === account.userId))) continue;
      updateLibrarySeriesEntries(current.key, (entry) => {
        if (entry !== current.sources[0]) return;
        entry.anilistAutoLinks = links.map((link) => ({ ...link, verifiedAt: Date.now() }));
      });
      linked++;
    } catch (error) {
      // Public metadata or network failures cannot authorize guessed links.
      console.warn("Automatic AniList identification deferred:", error?.message);
    }
  }
  return linked;
}

const newlyAddedAniListMatches = new Set();

/** Resolve a just-saved anime's AniList identity immediately, not after watching.
 * Identity requires the complete strict season/cour chain; failures remain
 * manually selectable and never create an AniList list entry or remote write.
 */
export async function autoLinkNewlyAddedAnime({ catalogId, seriesKey, entryId, account }) {
  if (!account?.token || !Number.isSafeInteger(account.userId) || account.userId < 1
    || !/^tt\d{5,12}$/.test(String(catalogId || ""))) return false;
  const identity = `${account.userId}:${catalogId}`;
  if (newlyAddedAniListMatches.has(identity)) return false;
  newlyAddedAniListMatches.add(identity);
  try {
    const sameAccount = () => {
      const now = readAniListAccount(localStorage);
      return now?.userId === account.userId && now?.token === account.token;
    };
    const currentSeries = () => buildLibrarySeries().find((item) => item.key === seriesKey
      && item.catalogId === catalogId && item.sources.some((entry) => entry.id === entryId));
    const needsLink = (series) => series && !seriesAniList(series, account.userId)?.seasons?.length
      && !series.sources.some((entry) => (entry.anilistManualLinks || []).some((link) => link.userId === account.userId)
        || (entry.anilistAutoLinks || []).some((link) => link.userId === account.userId));
    if (!sameAccount() || !needsLink(currentSeries())) return false;
    const response = await fetchJson(`/api/catalog/meta?type=series&id=${encodeURIComponent(catalogId)}`);
    const meta = response?.meta;
    if (!sameAccount() || meta?.id !== catalogId || !Array.isArray(meta.seasons)
      || !eligibleForPublicAnimeRating({ mediaKind: currentSeries()?.mediaKind, genres: meta.genres,
        country: meta.country })) return false;
    const links = await resolveVerifiedAniListLibraryLinks({ catalogId, meta, userId: account.userId,
      fetchTitle: fetchPublicAniListTitle, fetchSequels: fetchPublicAniListSequels });
    if (!links.length || !sameAccount()) return false;
    const current = currentSeries();
    if (!needsLink(current)) return false;
    // Retain all other account associations, any explicit links, and video data.
    updateLibrarySeriesEntries(current.key, (entry) => {
      if (entry.id !== entryId) return;
      entry.anilistAutoLinks = [...(entry.anilistAutoLinks || []).filter((link) => link.userId !== account.userId),
        ...links.map((link) => ({ ...link, verifiedAt: Date.now() }))];
    });
    if ($("#view-library")?.classList.contains("is-active")) renderLibrary();
    return true;
  } finally {
    newlyAddedAniListMatches.delete(identity);
  }
}

function gatherAniListWatchedQueue() {
  const threshold = readAniListPreference(localStorage).threshold / 100;
  const stored = anilistStoredQueue();
  const found = [];
  const blocked = [];
  const mappedSeries = new Set();
  let unmapped = 0;
  const accountId = readAniListAccount(localStorage)?.userId;
  for (const series of buildLibrarySeries()) {
    if (series.type !== "series") continue;
    const info = seriesAniList(series, accountId);
    if (!info?.seasons?.length) {
      // Unlisted anime like JoJo may already have completed local episodes,
      // but without a confirmed AniList media ID they must not be guessed or
      // silently counted as zero queued. Surface the mapping gap in status.
      if (series.mediaKind === "anime") {
        const codes = new Set(series.sources.flatMap((entry) => [
          ...Object.keys(entry.watchedChapters || {}).filter((code) => entry.watchedChapters[code]),
          ...(entry.episodes || []).filter((episode) => episode.progress?.finished === true
            || Number(episode.progress?.durationMs) > 0 && Number(episode.progress.positionMs) / Number(episode.progress.durationMs) >= threshold)
            .map((episode) => episode.code || chapterCode(episode.season, episode.episode)),
        ]));
        unmapped += codes.size;
      }
      continue;
    }
    mappedSeries.add(series.key);
    const foreign = new Set();
    const watchedChapters = {};
    for (const item of series.sources) for (const [code, watched] of Object.entries(item.watchedChapters || {})) {
      const origin = item.watchedChapterOrigins?.[code]
        || (item.anilist?.showId ? { source: "anilist", accountUserId: item.anilist.accountUserId || null } : null);
      if (watched && origin?.source === "anilist" && origin.accountUserId !== accountId) { foreign.add(code); continue; }
      watchedChapters[code] = watched;
    }
    const unwatched = new Set(Object.entries(watchedChapters)
      .filter(([, value]) => value === false).map(([code]) => code));
    for (const entry of series.sources) {
      for (const [code, value] of Object.entries(entry.watchedChapters || {}))
        if (value === false) unwatched.add(code);
    }
    for (const code of unwatched) watchedChapters[code] = false;
    const episodes = series.sources.flatMap((entry) => (entry.episodes || []).map((episode) => {
      const finished = !unwatched.has(String(episode.code || "").toUpperCase()) && (
        episode.progress?.finished === true || (Number(episode.progress?.durationMs) > 0
          && Number(episode.progress?.positionMs) / Number(episode.progress.durationMs) >= threshold));
      // The pure planner also looks at progress.finished, so mask BOTH fields
      // without changing any saved playback positions or completion records.
      return { ...episode, progress: { ...episode.progress, finished }, finished };
    }));
    const plan = planAniListWatchSync({
      seasons: info.seasons, type: series.type, seriesKey: series.key,
      ranges: info.ranges || [],
      episodes, watchedChapters, queue: stored.filter((row) => row.seriesKey === series.key && !unwatched.has(row.code) && !foreign.has(row.code)),
    });
    const rejects = new Set(plan.blockedQueue);
    found.push(...plan.queue.filter((row) => !rejects.has(row)));
    blocked.push(...plan.blockedQueue);
    unmapped += plan.unmapped.length;
  }
  // Keep orphaned/ambiguous queued rows locally for review, but never send
  // them under a different title or an AniList ID that has since changed.
  blocked.push(...stored.filter((row) => !mappedSeries.has(row.seriesKey)));
  const planned = reconcileAniListProgressQueue({ completed: found });
  persistAniListQueue([...planned.queue, ...blocked]);
  return { queue: planned.queue, blocked, unmapped: unmapped + blocked.length };
}

function blockedAniListForwardMedia(accountId) {
  // AniList stores a contiguous prefix. A local negative marker for episode
  // 2 must block an auto-upload of episodes 6/7 on that same remote season:
  // otherwise the monotonic planner would undo the user's explicit removal.
  const blocked = new Set();
  for (const series of buildLibrarySeries()) {
    if (series.type !== "series") continue;
    const codes = new Set(series.sources.flatMap((entry) => Object.entries(entry.watchedChapters || {})
      .filter(([, value]) => value === false).map(([code]) => code)));
    if (!codes.size) continue;
    const info = seriesAniList(series, accountId);
    if (!info?.seasons?.length) continue;
    for (const code of codes) {
      const mapped = resolveAniListEpisode({ seasons: info.seasons, ranges: info.ranges || [],
        episodeCode: code, type: series.type });
      if (mapped) blocked.add(mapped.mediaId);
      else for (const part of info.seasons) if (Number.isSafeInteger(Number(part.anilistId)))
        blocked.add(Number(part.anilistId)); // Unknown episode identity: block conservatively.
    }
  }
  return blocked;
}

function verifiedAniListCreationKeys(userId) {
  const allowed = new Set();
  if (!Number.isSafeInteger(userId) || userId < 1) return allowed;
  for (const series of buildLibrarySeries()) {
    if (series.type !== "series") continue;
    for (const entry of series.sources) {
      for (const link of entry.anilistManualLinks || []) {
        if (link.userId === userId && canLinkAniListTv({ id: link.anilistId,
          format: link.format, episodes: link.episodes })) allowed.add(`${series.key}\0${link.anilistId}`);
      }
      for (const link of entry.anilistAutoLinks || []) {
        if (link.userId === userId && link.catalogId === series.catalogId
          && Number.isSafeInteger(link.anilistId) && link.anilistId > 0
          && Number.isSafeInteger(link.episodes) && link.episodes > 0
          && Number.isSafeInteger(link.start) && link.start > 0
          && link.end === link.start + link.episodes - 1)
          allowed.add(`${series.key}\0${link.anilistId}`);
      }
    }
  }
  return allowed;
}

function applyAniListRemoteWatchHistory(remote, accountId = readAniListAccount(localStorage)?.userId) {
  let changed = false;
  // AniList stores a count (rather than individual episode IDs). Mark the
  // corresponding preceding episodes locally only for unambiguous season
  // mappings. Never overwrite a saved playback position or source file.
  for (const series of buildLibrarySeries()) {
    // The authenticated list may not yet include an anime explicitly linked
    // from LVL. Use only mappings owned by this authenticated account.
    const info = seriesAniList(series, accountId);
    if (!info?.seasons?.length || series.type !== "series") continue;
    const anchor = series.sources.find((entry) => state.library.includes(entry));
    if (!anchor) continue;
    const watched = { ...(anchor.watchedChapters || {}) };
    const uniqueSeasons = new Map();
    for (const item of info.seasons) uniqueSeasons.set(item.season, (uniqueSeasons.get(item.season) || 0) + 1);
    for (const part of info.seasons) {
      if (!Number.isInteger(part.season) || part.season <= 0) continue;
      const multiple = uniqueSeasons.get(part.season) !== 1;
      const offset = multiple ? (info.ranges || []).find((range) => range.season === part.season
        && range.anilistId === part.anilistId && range.end - range.start + 1 === part.episodes) : null;
      if (multiple && !offset) continue;
      const remoteEntry = remote.get(Number(part.anilistId));
      if (!remoteEntry || remoteEntry.progressKnown === false || !Number.isInteger(remoteEntry.progress)) continue;
      const progress = Math.min(part.episodes, 500, Math.max(0, remoteEntry.progress));
      for (let episode = 1; episode <= progress; episode++) {
        const number = episode + (offset?.start || 1) - 1;
        const code = `S${String(part.season).padStart(2, "0")}E${String(number).padStart(2, "0")}`;
        const mapped = resolveAniListEpisode({ seasons: info.seasons, ranges: info.ranges || [], episodeCode: code, type: series.type });
        if (!mapped || mapped.mediaId !== Number(part.anilistId) || Object.hasOwn(watched, code)
          || explicitlyUnwatchedChapter(series, code)) continue;
        watched[code] = Date.now();
        anchor.watchedChapterOrigins = { ...(anchor.watchedChapterOrigins || {}), [code]: {
          source: "anilist", accountUserId: accountId, mediaId: mapped.mediaId, updatedAt: watched[code] } };
        changed = true;
      }
    }
    if (Object.keys(watched).length) anchor.watchedChapters = watched;
    // Imported list status should stay in sync even if changed outside LVL.
    for (const entry of series.sources) {
      if (!entry.anilist?.seasons || entry.anilist.accountUserId !== accountId) continue;
      for (const part of entry.anilist.seasons) {
        const latest = remote.get(Number(part.anilistId));
        if (!latest || latest.progressKnown === false || !Number.isInteger(latest.progress)) continue;
        if (part.progress !== latest.progress || (latest.status && part.status !== latest.status)) changed = true;
        part.progress = latest.progress;
        if (latest.status) part.status = latest.status;
      }
    }
  }
  if (changed) {
    saveLibrary();
    if ($("#view-watch")?.classList.contains("is-active")) renderWatchChapters();
    if ($("#view-library")?.classList.contains("is-active")) renderLibrary();
  }
  return changed;
}

async function syncAniListAuto({ manual = false } = {}) {
  if (anilistAutoDevTestRun) return;
  if (anilistAutoRun) return anilistAutoRun;
  // Explicit user-approved decreases take priority over an automatic
  // monotonic push. The reverse path already waits for any earlier auto run.
  if (explicitAniListUnwatchRun) await explicitAniListUnwatchRun;
  if (anilistAutoRun) return anilistAutoRun;
  if (!persistentAppStateReady) return;
  const account = readAniListAccount(localStorage);
  const options = readAniListPreference(localStorage);
  if (!account || (!manual && !options.enabled)) return;
  if (!manual && Date.now() < anilistAutoRetryAfter) return;
  const stillConnected = () => {
    const active = readAniListAccount(localStorage);
    return active?.userId === account.userId && active?.token === account.token;
  };
  const mayContinue = () => stillConnected() && (manual || readAniListPreference(localStorage).enabled);
  anilistAutoRun = (async () => {
    // Unlisted shows can obtain exact, account-scoped season identities via
    // public metadata before the normal authenticated list reconciliation.
    await autoLinkAniListWatchedSeries(account);
    if (!mayContinue()) return;
    // Ordinary Library saves happen periodically while watching. Re-read
    // AniList after new completed episodes or for hourly reconciliation.
    const before = gatherAniListWatchedQueue();
    const snapshot = JSON.stringify(before.queue);
    if (!manual && anilistAutoLastQueueSnapshot === snapshot
      && Date.now() - options.lastPull < 60 * 60_000) return;
    showAniListAutoStatus("Checking AniList and reconciling watched episodes…");
    renderAniListAutoSettings();
    const data = await anilistGraphql(account.token, ANILIST_LIST_QUERY, { id: account.userId });
    if (!mayContinue()) return; // disconnected, reauthorized or disabled
    if (Number(data?.Viewer?.id) !== account.userId
      || (data.MediaListCollection !== null && !Array.isArray(data?.MediaListCollection?.lists)))
      throw new Error("AniList did not return a complete watch list; no changes were sent.");
    const remote = remoteAniListEntries(data);
    const initiallyListedMedia = new Set(remote.keys());
    applyAniListRemoteWatchHistory(remote, account.userId);
    const watched = gatherAniListWatchedQueue();
    // A missing entry is an explicitly verified empty AniList list entry, not
    // an offline failure. Never fabricate a zero progress before fetching.
    const allowedNewEntries = verifiedAniListCreationKeys(account.userId);
    for (const item of watched.queue) {
      // A public/old-account AniList import is fine for DISPLAY, but it does
      // not authorize creating a brand-new remote list entry for this Viewer.
      // Missing remote IDs require explicit/manual or complete verified public
      // association owned by the current account (as JoJo now has).
      if (!remote.has(item.mediaId) && !allowedNewEntries.has(`${item.seriesKey}\0${item.mediaId}`)) continue;
      if (!remote.has(item.mediaId)) remote.set(item.mediaId, {
        mediaId: item.mediaId, progress: 0, status: "PLANNING", episodes: null,
      });
    }
    let planned = reconcileAniListProgressQueue({
      queue: watched.queue,
      remote: [...remote.values()].map((entry) => ({ ...entry, anilistId: entry.mediaId })),
      allowStatusUpdates: true,
    });
    persistAniListQueue([...planned.queue, ...watched.blocked]);
    writeAniListPreference(localStorage, { lastPull: Date.now() });
    let sent = 0;
    const outgoing = planned.updates.slice(0, 8);
    for (const update of outgoing) {
      if (!mayContinue()) break;
      if (blockedAniListForwardMedia(account.userId).has(update.mediaId)) continue;
      // Store the pacing slot on this private runner so a second invocation
      // cannot immediately spend another batch of the provider's quota.
      const pacingDelay = Math.max(0, (syncAniListAuto.nextWriteSlot || 0) - Date.now());
      if (pacingDelay) await new Promise((resolve) => setTimeout(resolve, pacingDelay));
      if (!mayContinue() || blockedAniListForwardMedia(account.userId).has(update.mediaId)) break;
      syncAniListAuto.nextWriteSlot = Date.now() + 8500;
      // Read this exact user/media again immediately before each write. Other
      // AniList clients may have advanced progress since the initial list pull.
      // AniList has no conditional/max-progress mutation, so this narrows (but
      // cannot eliminate) the external read-to-write race.
      const freshData = await anilistGraphql(account.token, ANILIST_SINGLE_PROGRESS_QUERY,
        { id: account.userId, mediaId: update.mediaId });
      if (!mayContinue()) return;
      if (!Object.hasOwn(freshData, "MediaList")) throw new Error("AniList returned an incomplete episode status; no update was sent.");
      if (freshData.MediaList === null) {
        // If an existing entry vanished since the initial pull, treat the
        // removal as intentional, rather than recreating it behind the user.
        if (initiallyListedMedia.has(update.mediaId)) continue;
        remote.set(update.mediaId, { mediaId: update.mediaId, progress: 0,
          status: "PLANNING", episodes: null, existing: false });
      } else {
        const latest = remoteAniListEntries({ MediaListCollection: { lists: [{ entries: [freshData.MediaList] }] } }).get(update.mediaId);
        if (!latest || latest.progressKnown === false) throw new Error("AniList returned unknown episode progress; no update was sent.");
        remote.set(update.mediaId, { ...latest, existing: true });
      }
      // The user may have marked an episode unwatched while the remote
      // preflight was in flight. Never resurrect an old queued completion or
      // send an update from an obsolete local watched snapshot.
      const currentWatched = gatherAniListWatchedQueue();
      planned = reconcileAniListProgressQueue({ queue: currentWatched.queue,
        remote: [...remote.values()].map((entry) => ({ ...entry, anilistId: entry.mediaId })),
        allowStatusUpdates: true });
      const freshUpdate = planned.updates.find((item) => item.mediaId === update.mediaId);
      if (!freshUpdate) {
        persistAniListQueue([...planned.queue, ...currentWatched.blocked]);
        continue;
      }
      if (!mayContinue()) return;
      if (blockedAniListForwardMedia(account.userId).has(freshUpdate.mediaId)) continue;
      const actual = await anilistGraphql(account.token, ANILIST_SAVE_PROGRESS, freshUpdate);
      // A disconnect or reauthorization may have happened while AniList was
      // processing this request. Never restore a previous session's queue.
      if (readAniListAccount(localStorage)?.token !== account.token) return;
      if (!stillConnected()) return;
      const confirmed = actual?.SaveMediaListEntry;
      if (Number(confirmed?.mediaId) !== freshUpdate.mediaId || Number(confirmed?.progress) < freshUpdate.progress)
        throw new Error("AniList did not confirm the episode progress update.");
      // Mutation responses are not an authoritative view: another device can
      // race the preflight or change this entry after the write. A failed or
      // mismatched third read keeps the local intent queued for later review.
      let verified;
      try {
        verified = await anilistGraphql(account.token, ANILIST_SINGLE_PROGRESS_QUERY,
          { id: account.userId, mediaId: freshUpdate.mediaId });
      } catch (error) {
        throw Object.assign(new Error("AniList could not verify the episode after sending it. Pending progress was preserved for retry."),
          { retryAfter: Math.max(5 * 60_000, Number(error?.retryAfter) || 0) });
      }
      if (!stillConnected()) return;
      if (!manual && !readAniListPreference(localStorage).enabled) return;
      const rechecked = gatherAniListWatchedQueue();
      if (blockedAniListForwardMedia(account.userId).has(freshUpdate.mediaId)
        || !rechecked.queue.some((row) => row.mediaId === freshUpdate.mediaId)) {
        // An explicit local unwatch or changed media association supersedes
        // this automatic push, even after a successful remote mutation. The
        // current local queue is authoritative for all future attempts.
        planned = reconcileAniListProgressQueue({ queue: rechecked.queue,
          remote: [...remote.values()].map((entry) => ({ ...entry, anilistId: entry.mediaId })) });
        persistAniListQueue([...planned.queue, ...rechecked.blocked]);
        continue;
      }
      const readEntry = Object.hasOwn(verified || {}, "MediaList") ? verified.MediaList : undefined;
      const readRemote = readEntry && Number(readEntry.mediaId) === freshUpdate.mediaId
        ? remoteAniListEntries({ MediaListCollection: { lists: [{ entries: [readEntry] }] } }).get(freshUpdate.mediaId)
        : null;
      if (!readRemote || readRemote.progressKnown === false
        || !Number.isSafeInteger(readRemote.progress) || readRemote.progress < freshUpdate.progress
        || (readRemote.episodes !== null && readRemote.progress > readRemote.episodes)
        || rechecked.queue.some((row) => row.mediaId === freshUpdate.mediaId
          && Number.isSafeInteger(row.episodeCount) && row.episodeCount > 0
          && readRemote.episodes !== null && row.episodeCount !== readRemote.episodes))
        throw Object.assign(new Error("AniList's authoritative readback did not confirm this episode. Local progress remains queued; LVL will retry after a delay."),
          { retryAfter: 5 * 60_000 });
      // Adopt a higher authoritative progress conservatively for reconciliation;
      // never overwrite another client's higher count or its score/status.
      const nextRemote = new Map(remote);
      nextRemote.set(update.mediaId, { ...readRemote, existing: true });
      const reconciled = reconcileAniListProgressQueue({ queue: rechecked.queue,
        remote: [...nextRemote.values()].map((entry) => ({ ...entry, anilistId: entry.mediaId })) });
      if (rechecked.queue.some((row) => row.mediaId === freshUpdate.mediaId
        && row.episode <= readRemote.progress && reconciled.queue.some((remaining) =>
          remaining.mediaId === row.mediaId && remaining.seriesKey === row.seriesKey && remaining.code === row.code)))
        throw Object.assign(new Error("AniList readback conflicts with the verified episode mapping. Local progress remains queued."),
          { retryAfter: 5 * 60_000 });
      remote.set(update.mediaId, { ...readRemote, existing: true });
      // The ordinary remote history importer respects explicit local unwatch
      // markers and account-owned episode mappings. It can now reflect a
      // concurrent advance without changing playback resume positions.
      applyAniListRemoteWatchHistory(new Map([[update.mediaId, readRemote]]), account.userId);
      planned = reconciled;
      persistAniListQueue([...planned.queue, ...rechecked.blocked]);
      writeAniListPreference(localStorage, { lastPush: Date.now() });
      sent++;
    }
    if (!mayContinue()) return;
    if (Date.now() - (Number(localStorage.getItem(ANILIST_LIBRARY_KEY)) || 0) >= 60 * 60_000) {
      try { await syncAniListLibrary({ quiet: true }); }
      catch (error) {
        anilistAutoImportWarning = "Authenticated Library refresh will retry later.";
        console.warn("AniList Library refresh deferred:", error?.message);
      }
    }
    const pending = planned.queue.length + watched.blocked.length;
    // Compare against the *local* completion set, not only outstanding remote
    // writes: previously confirmed episodes remain watched in the Library.
    anilistAutoLastQueueSnapshot = snapshot;
    anilistAutoRetryAfter = 0;
    showAniListAutoStatus(`Synced ${account.username}: ${sent} update${sent === 1 ? "" : "s"} sent and verified; ${pending} episode${pending === 1 ? "" : "s"} queued.${watched.unmapped ? ` ${watched.unmapped} episode(s) skipped: no safe AniList season match.` : ""}${anilistAutoImportWarning ? ` ${anilistAutoImportWarning}` : ""}`);
    if (manual) toast(`AniList sync complete: ${sent} update${sent === 1 ? "" : "s"}`);
    return { ok: true, sent, pending };
  })().catch((error) => {
    if (readAniListAccount(localStorage)?.token !== account.token) return;
    anilistAutoRetryAfter = Date.now() + (Number(error?.retryAfter) || 2 * 60_000);
    showAniListAutoStatus(error?.message || "AniList sync failed; local progress is preserved.", true);
    if (manual) toast(error?.message || "AniList sync failed", { tone: "error" });
    // Don't turn a failed progress preflight into a misleading success when
    // the Settings Sync now button refreshes the optional score metadata.
    return { ok: false };
  }).finally(() => {
    anilistAutoRun = null;
    renderAniListAutoSettings();
  });
  return anilistAutoRun;
}

export function scheduleAniListAutoSync(delay = 3500) {
  if (anilistAutoDevTestRun || !persistentAppStateReady || !readAniListAccount(localStorage)
    || !readAniListPreference(localStorage).enabled) return;
  clearTimeout(anilistAutoTimer);
  anilistAutoTimer = window.setTimeout(() => {
    anilistAutoTimer = 0;
    void Promise.resolve(syncAniListAuto()).then(() => flushAniListUnwatches({ interactive: false }));
  }, delay);
}

async function connectVerifiedAniListAccount(auth, generation) {
    const data = await anilistGraphql(auth.token, ANILIST_VIEWER_QUERY);
    if (generation !== anilistAutoAuthGeneration) return;
    const viewer = data?.Viewer;
    if (!Number.isInteger(viewer?.id) || !viewer?.name) throw new Error("AniList could not verify the logged-in account.");
    // Keep accounts isolated even when the old bearer token has expired. The
    // queue can be rebuilt from the Library's completed episodes for this
    // account; never carry a previous account's pending writes across login.
    const priorStored = readStorageObject(ANILIST_OAUTH_STORAGE);
    const oldUserId = Number(priorStored.userId) || null;
    const switchedAccount = oldUserId !== null && oldUserId !== viewer.id;
    const previousQueueOwner = Number(localStorage.getItem(ANILIST_QUEUE_OWNER_KEY)) || oldUserId;
    const changedKnownOwner = previousQueueOwner != null && previousQueueOwner !== viewer.id;
    // Preserve unsent watches on a same-account reauthorization; some may
    // outlive their original local video source and exist only in the queue.
    switchAniListQueueAccount(viewer.id, oldUserId);
    if (oldUserId !== viewer.id) localStorage.removeItem(ANILIST_SYNC_QUEUE);
    invalidateAniListUnwatchApprovals();
    // A failed preference write must leave the original OAuth identity active.
    // An account change stays paused even when the prior token had expired.
    writeAniListPreference(localStorage, {
      enabled: !switchedAccount && !changedKnownOwner,
      lastPull: 0, lastPush: 0,
    });
    localStorage.setItem(ANILIST_OAUTH_STORAGE, JSON.stringify({
      ...auth, userId: viewer.id, username: viewer.name,
    }));
    anilistAutoLastQueueSnapshot = null;
    anilistAutoImportWarning = "";
    showAniListAutoStatus(switchedAccount
      ? `Connected as ${viewer.name}. Different AniList account detected; automatic writes are paused until you review your Library and enable syncing.`
      : `Connected as ${viewer.name}. Loading your AniList watch history…`);
    renderAniListAutoSettings();
    // Reuse the existing public list importer to attach AniList IDs to LVL
    // titles. Authorization and progress writes never go through this API.
    try {
      localStorage.removeItem(ANILIST_LIBRARY_KEY);
      const imported = await syncAniListLibrary({ quiet: true });
      if (generation !== anilistAutoAuthGeneration) return;
      showAniListAutoStatus(`Connected as ${viewer.name}. ${imported.total} AniList title${imported.total === 1 ? "" : "s"} ready in your Library.`);
      void recsUi.load({ force: true }).catch(() => {});
    } catch (error) {
      console.warn("AniList public title import could not complete:", error?.message);
      if (generation === anilistAutoAuthGeneration) {
        anilistAutoImportWarning = "Library import failed; retry with Library → Import → Import connected AniList. Unmatched anime will not be written.";
        showAniListAutoStatus(`Connected as ${viewer.name}. ${anilistAutoImportWarning}`, true);
      }
    }
    if (generation === anilistAutoAuthGeneration && readAniListPreference(localStorage).enabled) scheduleAniListAutoSync(500);
}

export async function completeAniListAuthorization() {
  if (!anilistOAuthResponse) return;
  const generation = ++anilistAutoAuthGeneration;
  try {
    // AniList's live implicit redirect omits state. Only the new local flow
    // accepts that response, and ONLY after a same-tab pending authorization
    // with a matching JWT audience/issuance time. Legacy callbacks still
    // require strict state validation.
    const pending = JSON.parse(sessionStorage.getItem(ANILIST_OAUTH_PENDING) || "null");
    const args = { hash: anilistOAuthResponse.hash, sessionStorage, origin: window.location.origin };
    const auth = pending?.mode === "local-implicit"
      ? consumeAniListLocalCallback(args)
      : consumeAniListCallback(args);
    await connectVerifiedAniListAccount(auth, generation);
  } catch (error) {
    if (generation === anilistAutoAuthGeneration) showAniListAutoStatus(error?.message || "Could not finish AniList login.", true);
  }
}

export function wireAniListAutoSettings() {
  $("#anilist-score-sync-enabled")?.addEventListener("change", (event) => {
    const account = readAniListAccount(localStorage);
    if (!account) { event.target.checked = false; return; }
    localStorage.setItem(ANILIST_SCORE_SYNC_KEY, JSON.stringify({ userId: account.userId, enabled: event.target.checked }));
    recsUi.invalidateRatings();
    if (event.target.checked) {
      showAniListAutoStatus("Two-way rating sync on. Reading your AniList scores…");
      void syncAniListLibrary({ quiet: true })
        .then((result) => showAniListAutoStatus(result?.scores ? aniListScoreSummary(result.scores)
          : "AniList scores read. Your AniList list couldn't be verified for this account, so no scores were changed."))
        .catch((error) => showAniListAutoStatus(error.message, true));
    } else showAniListAutoStatus("Anime score syncing disabled. Local ratings and AniList scores are preserved.");
  });
  $("#anilist-score-migrate")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    if (!readAniListAccount(localStorage)) { showAniListAutoStatus("Connect AniList first.", true); return; }
    button.disabled = true;
    showAniListAutoStatus("Reading your AniList scores…");
    try {
      // A fresh, verified list read; the copy below then uses it.
      const read = await syncAniListLibrary({ quiet: true, skipScoreSync: true });
      const account = readAniListAccount(localStorage);
      if (!account || !read?.authenticatedAt) throw new Error("Your AniList list couldn't be verified for this account. No scores were changed.");
      showAniListAutoStatus(aniListScoreSummary(await copyAniListScoresIntoLvl(account, { snapshotAt: read.authenticatedAt })));
    } catch (error) {
      showAniListAutoStatus(error.message || "Couldn't migrate AniList scores.", true);
    } finally {
      button.disabled = !readAniListAccount(localStorage);
    }
  });
  $("#anilist-auto-dev-test")?.addEventListener("click", async (event) => {
    const account = readAniListAccount(localStorage);
    const status = $("#anilist-auto-dev-test-status");
    if (window.location.port !== "4187" || !account || anilistAutoDevTestRun || anilistAutoRun) {
      if (status) status.textContent = "Connect AniList and wait for any ongoing sync to finish first.";
      return;
    }
    anilistAutoDevTestRun = true;
    clearTimeout(anilistAutoTimer);
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await runAniListReversibleSmoke({
        account,
        stillConnected: () => readAniListAccount(localStorage)?.token === account.token,
        onStep: (message) => { if (status) status.textContent = message; },
      });
      if (status) status.textContent = `Passed: ${result.name}, episodes 1 → 2 → 3, temporary entry deleted. No local watched data was modified.`;
    } catch (error) {
      if (status) status.textContent = `Test stopped: ${error.message}`;
    } finally {
      anilistAutoDevTestRun = false;
      button.disabled = false;
      scheduleAniListAutoSync(5000);
    }
  });
  $("#anilist-auto-client-id")?.addEventListener("change", (event) => {
    const clientId = String(event.target.value || "").trim();
    writeAniListPreference(localStorage, { clientId });
    renderAniListAutoSettings();
  });
  $("#anilist-auto-enabled")?.addEventListener("change", (event) => {
    writeAniListPreference(localStorage, { enabled: Boolean(event.target.checked) });
    showAniListAutoStatus(event.target.checked ? "Automatic AniList sync enabled." : "Automatic AniList sync paused.");
    if (event.target.checked) scheduleAniListAutoSync(500);
    renderAniListAutoSettings();
  });
  $("#anilist-auto-threshold")?.addEventListener("change", (event) => {
    writeAniListPreference(localStorage, { threshold: Math.max(1, Math.min(100, Math.round(Number(event.target.value) || 80))) });
    renderAniListAutoSettings();
    scheduleAniListAutoSync(500);
  });
  // The primary Connect button is wired by an independent early module in
  // index.html. Do not register a second handler/navigation here.
  $("#anilist-auto-pin-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (anilistAutoAuthPending) return;
    const generation = ++anilistAutoAuthGeneration;
    anilistAutoAuthPending = true;
    const field = $("#anilist-auto-pin");
    const pasted = field?.value || "";
    if (field) field.value = ""; // clear the sensitive input immediately
    const button = $("#anilist-auto-pin-submit");
    if (button) button.disabled = true;
    try {
      const auth = parseAniListPinToken(pasted);
      showAniListAutoStatus("Verifying your AniList token directly with AniList…");
      await connectVerifiedAniListAccount(auth, generation);
    } catch (error) {
      if (generation === anilistAutoAuthGeneration) showAniListAutoStatus(error?.message || "Could not connect AniList.", true);
    } finally {
      anilistAutoAuthPending = false;
      if (button) button.disabled = false;
      renderAniListAutoSettings();
    }
  });
    $("#anilist-auto-disconnect")?.addEventListener("click", () => {
    ++anilistAutoAuthGeneration; // invalidate pending Viewer verification
    const oldUserId = Number(readStorageObject(ANILIST_OAUTH_STORAGE).userId)
      || Number(localStorage.getItem(ANILIST_QUEUE_OWNER_KEY)) || null;
    try {
      if (oldUserId) {
        const owner = Number(localStorage.getItem(ANILIST_QUEUE_OWNER_KEY)) || oldUserId;
        if (owner === oldUserId && localStorage.getItem(ANILIST_SYNC_QUEUE)
          && localStorage.getItem(anilistQueueAccountKey(oldUserId)) == null)
          saveAniListQueueText(anilistQueueAccountKey(oldUserId), localStorage.getItem(ANILIST_SYNC_QUEUE));
      }
      localStorage.removeItem(ANILIST_OAUTH_STORAGE);
      localStorage.removeItem(ANILIST_SCORE_SYNC_KEY);
      localStorage.removeItem(ANILIST_SYNC_QUEUE);
      localStorage.removeItem(ANILIST_QUEUE_OWNER_KEY);
    } catch (error) {
      showAniListAutoStatus(error.message, true);
      return;
    }
    invalidateAniListUnwatchApprovals();
    clearTimeout(anilistAutoTimer);
    anilistAutoLastQueueSnapshot = null;
    writeAniListPreference(localStorage, { enabled: false });
    showAniListAutoStatus("AniList disconnected. Existing local and imported watch history was preserved.");
    renderAniListAutoSettings();
  });
  $("#anilist-auto-sync")?.addEventListener("click", () => {
    // Refresh authenticated season identities and import their watched count
    // before reconciling the local watch queue. This works even if automatic
    // uploads and two-way score syncing are disabled.
    void syncAniListLibrary({ quiet: true }).then(() => syncAniListAuto({ manual: true }))
      .then((result) => result?.ok && anilistScoreSyncEnabled()
      ? syncAniListLibrary({ quiet: true }).then(async () => {
        const account = readAniListAccount(localStorage);
        if (!account) return;
        const scores = await syncMissingLocalAniListScores(account);
        if (scores.sent) await syncAniListLibrary({ quiet: true });
        showAniListAutoStatus(`Episode progress checked; AniList ratings refreshed.${scores.sent ? ` ${scores.sent} previously local-only score${scores.sent === 1 ? "" : "s"} copied to AniList.` : ""}${scores.skipped ? ` ${scores.skipped} score candidate${scores.skipped === 1 ? " was" : "s were"} left unchanged (unverified, already scored, or conflicting).` : ""}`);
      })
      : null).catch((error) => showAniListAutoStatus(error.message, true));
  });
  renderAniListAutoSettings();
}

async function syncAniListAuthenticatedRatings(account) {
  if (!account?.token) throw new Error("Connect AniList before refreshing your authenticated list.");
  const data = await anilistGraphql(account.token, ANILIST_AUTH_LIBRARY_QUERY, { id: account.userId });
  if (readAniListAccount(localStorage)?.token !== account.token)
    throw new Error("AniList account changed during Library import; retry with the connected account.");
  if (Number(data?.Viewer?.id) !== account.userId
      || (data.MediaListCollection !== null && !Array.isArray(data?.MediaListCollection?.lists))
      || (data.MediaListCollection?.user && Number(data.MediaListCollection.user.id) !== account.userId))
    throw new Error("AniList did not return a complete list for this account. Existing Library data was preserved.");
  // This POST contains list metadata only. Never forward account.token or any
  // Authorization header to LVL's local server.
  const response = await postJson("/api/recs/anilist/authenticated", { ...data, scoreSyncEnabled: anilistScoreSyncEnabled() });
  recsUi.invalidateRatings();
  return response;
}

// A manual Sync now can fill *missing* AniList scores from explicitly saved app
// ratings, but only after two-way score sync was enabled. Every mutation has an
// exact account-owned list entry, unique season/media mapping, fresh scoreRaw=0
// preflight, and read-back verification through saveAniListScore. Never create
// entries, guess mappings, overwrite remote scores, or send credentials to Node.
async function syncMissingLocalAniListScores(account) {
  if (!account?.token || !anilistScoreSyncEnabled()) return { sent: 0, skipped: 0 };
  let sent = 0;
  let skipped = 0;
  const candidates = [];
  for (const series of buildLibrarySeries().filter((item) => item.mediaKind === "anime").slice(0, 250)) {
    if (!anilistScoreSyncEnabled() || readAniListAccount(localStorage)?.token !== account.token) break;
    const info = seriesAniList(series, account.userId);
    if (!info?.seasons?.length) continue;
    const params = new URLSearchParams({ catalogId: series.catalogId || "", key: series.key });
    let ratings;
    try { ({ ratings } = await fetchJson(`/api/ratings?${params}`)); }
    catch (error) { console.warn("Local score reconciliation deferred:", error?.message); skipped++; continue; }
    for (const rating of (ratings || []).filter((row) => row.source === "app" && Number.isFinite(row.score) && row.score >= 1 && row.score <= 10)) {
      if (rating.provenance?.source === "anilist" && rating.provenance.accountUserId !== account.userId) { skipped++; continue; }
      const season = Number.isInteger(rating.season) ? rating.season : null;
      const part = resolveAniListScorePart(info, season);
      candidates.push({ seriesKey: series.key, season, score: rating.score, part });
    }
  }
  // Plan the *whole* batch first. First-wins writes could otherwise send a
  // conflicting local score when different titles/seasons share one media ID.
  const plan = planMissingAniListScores(candidates, { limit: 25 });
  skipped += plan.skipped.length;
  for (const update of plan.updates) {
    if (!anilistScoreSyncEnabled() || readAniListAccount(localStorage)?.token !== account.token) break;
    try {
      await saveAniListScore({ account, mediaId: update.mediaId, score: update.score,
        expectedRaw: update.expectedRaw, graphql: anilistGraphql,
        stillConnected: () => {
          const series = buildLibrarySeries().find((item) => item.key === update.seriesKey);
          const part = series && resolveAniListScorePart(seriesAniList(series, account.userId), update.season);
          return Boolean(anilistScoreSyncEnabled()
            && readAniListAccount(localStorage)?.token === account.token
            && part?.anilistId === update.mediaId);
        },
      });
      sent++;
    } catch (error) {
      skipped++;
      console.warn("Local AniList score preserved; remote score not overwritten:", error?.message);
    }
  }
  return { sent, skipped };
}

// AniList -> LVL: each season scored on the signed-in user's AniList list
// becomes that season's LVL rating. When both have a different score, AniList's
// wins (see planAniListScoresIntoLvl). Runs on its own with two-way sync, and
// from Settings > Library > Migrate scores from AniList.
let anilistScoreCopyRun = null;
function copyAniListScoresIntoLvl(account, { snapshotAt = 0 } = {}) {
  if (anilistScoreCopyRun) return anilistScoreCopyRun;
  anilistScoreCopyRun = (async () => {
    const result = { copied: 0, same: 0, skipped: 0, failed: 0, changes: [] };
    if (!account?.token) return result;
    const candidates = [];
    for (const series of buildLibrarySeries().filter((item) => item.mediaKind === "anime").slice(0, 400)) {
      if (readAniListAccount(localStorage)?.token !== account.token) return result;
      const info = seriesAniList(series, account.userId);
      const parts = (info?.seasons || []).filter((part) => Number.isSafeInteger(part.anilistId) && part.anilistId > 0
        && Number(part.score) > 0);
      if (!parts.length) continue;
      let ratings;
      try {
        ({ ratings } = await fetchJson(`/api/ratings?${new URLSearchParams({ catalogId: series.catalogId || "", key: series.key })}`));
      } catch (error) {
        result.failed++;
        console.warn("AniList score copy deferred for one title:", error?.message);
        continue;
      }
      const own = (ratings || []).filter((row) => row.source === "app");
      for (const part of parts) {
        // A movie is rated as a whole; a series per season.
        const season = part.format === "MOVIE" && info.seasons.length === 1 ? null
          : Number.isInteger(part.season) && part.season > 0 ? part.season : undefined;
        if (season === undefined) { result.skipped++; continue; }
        const unique = resolveAniListScorePart(info, season)?.anilistId === part.anilistId;
        const shared = !unique || info.seasons.some((other) => other !== part && other.anilistId === part.anilistId);
        const local = own.find((row) => (Number.isInteger(row.season) ? row.season : null) === season) || null;
        const pending = Boolean(readUnconfirmedAniListScore(localStorage, account.userId, part.anilistId))
          || anilistScoreRuns.has(`${account.userId}:${part.anilistId}`);
        candidates.push({ seriesKey: series.key, catalogId: series.catalogId || "", title: series.title || "",
          season, part, shared, local, pending, snapshotAt });
      }
    }
    const plan = planAniListScoresIntoLvl(candidates);
    result.same = plan.skipped.filter((row) => row.reason === "same").length;
    result.skipped += plan.skipped.length - result.same;
    for (const update of plan.updates) {
      if (readAniListAccount(localStorage)?.token !== account.token) break;
      try {
        await postJson("/api/ratings", { catalogId: update.catalogId, seriesKey: update.seriesKey, season: update.season,
          title: update.title, kind: update.kind, year: update.year, score: update.score, status: update.status,
          provenance: { source: "anilist", accountUserId: account.userId, mediaId: update.mediaId, score: update.score } });
        result.copied++;
        result.changes.push({ title: update.title, season: update.season, from: update.previous, to: update.score });
      } catch (error) {
        result.failed++;
        console.warn("AniList score not copied into LVL:", error?.message);
      }
    }
    if (result.copied) recsUi.invalidateRatings();
    return result;
  })().finally(() => { anilistScoreCopyRun = null; });
  return anilistScoreCopyRun;
}

// Two-way sync after each AniList list read: AniList scores into LVL first,
// then LVL scores into AniList entries that have none yet.
async function reconcileAniListScores(account, snapshotAt) {
  const copied = await copyAniListScoresIntoLvl(account, { snapshotAt });
  const sent = await syncMissingLocalAniListScores(account);
  return { ...copied, sent: sent.sent, sendSkipped: sent.skipped };
}

function aniListScoreSummary(result) {
  if (!result) return "";
  const parts = [];
  if (result.copied) parts.push(`${result.copied} AniList score${result.copied === 1 ? "" : "s"} copied into LVL`);
  if (result.sent) parts.push(`${result.sent} LVL score${result.sent === 1 ? "" : "s"} sent to AniList`);
  if (!parts.length) parts.push(result.same ? "LVL and AniList scores already match" : "No AniList scores to copy");
  if (result.failed) parts.push(`${result.failed} couldn't be saved; try again`);
  return `${parts.join(". ")}.`;
}

export function syncAniListLibrary({ quiet = false, status = "", skipAuthPull = false, skipScoreSync = false } = {}) {
  if (anilistLibraryRun) return anilistLibraryRun;
  if (status) setToolStatus(status, "Adding your AniList list to the Library. The first time takes up to half a minute.");
  else if (!quiet) toast("Adding your AniList list to the Library");
  const account = readAniListAccount(localStorage);
  anilistLibraryRun = Promise.resolve()
    .then(() => account && !skipAuthPull ? syncAniListAuthenticatedRatings(account) : null)
    .then(async (authenticated) => {
      if (account && readAniListAccount(localStorage)?.token !== account.token)
        throw new Error("AniList account changed during import; Library was not modified.");
      const data = await fetchJson("/api/recs/anilist/library");
      return { data, authenticatedAt: Number(authenticated?.settings?.anilist?.syncedAt) || 0 };
    })
    .then(async ({ data, authenticatedAt }) => {
      if (account && readAniListAccount(localStorage)?.token !== account.token)
        throw new Error("AniList account changed during import; Library was not modified.");
      // This is the same authenticated snapshot only if its server revision
      // still matches the just-verified Viewer import. Public username data,
      // stale snapshots and concurrent account changes remain display-only.
      const ownerId = account && authenticatedAt > 0 && Number(data.syncedAt) === authenticatedAt
        ? account.userId : null;
      const shows = Array.isArray(data.shows) ? data.shows : [];
      const result = applyAniListLibrary(shows, { accountUserId: ownerId });
      if (ownerId) {
        // The authenticated import already contains exact, account-owned
        // episode counts. Apply them locally now, even when outbound automatic
        // progress writes are off. Never change playback positions or upload.
        const remote = new Map();
        for (const show of shows) for (const part of show.seasons || []) {
          const id = Number(part.anilistId);
          if (!Number.isSafeInteger(id) || id <= 0 || !Number.isInteger(part.progress)
            || part.progress < 0 || !Number.isInteger(part.episodes)
            || part.episodes < 1 || part.progress > part.episodes) continue;
          if (remote.has(id)) remote.set(id, { progressKnown: false });
          else remote.set(id, { mediaId: id, progress: part.progress, status: part.status });
        }
        applyAniListRemoteWatchHistory(remote, ownerId);
      }
      recsUi.invalidateRatings();
      localStorage.setItem(ANILIST_LIBRARY_KEY, String(Number(data.syncedAt) || Date.now()));
      result.authenticatedAt = ownerId ? authenticatedAt : 0;
      // Two-way score sync: only with a verified, account-owned list.
      if (ownerId && !skipScoreSync && anilistScoreSyncEnabled() && !anilistAutoDevTestRun) {
        try { result.scores = await reconcileAniListScores(account, authenticatedAt); }
        catch (error) { console.warn("AniList score sync deferred:", error?.message); }
      }
      const text = result.added
        ? `Added ${result.added} title${result.added === 1 ? "" : "s"} from AniList to your Library`
        : `Your Library has ${result.total} AniList title${result.total === 1 ? "" : "s"}`;
      if (status) setToolStatus(status, text);
      if (!status && (result.added || !quiet)) toast(text);
      return result;
    })
    .catch((error) => {
      if (status) setToolStatus(status, error.message || "Couldn't add your AniList list", true);
      else if (!quiet) toast(error.message || "Couldn't add your AniList list", { tone: "error" });
      throw error;
    })
    .finally(() => { anilistLibraryRun = null; });
  return anilistLibraryRun;
}

// Once per AniList sync: a linked list that the Library doesn't have yet is added on its own.
// It waits for the saved Library (the picks can arrive before it), so it never works on an
// empty or half-loaded Library.
export function maybeSyncAniListLibrary(overview) {
  const syncedAt = Number(overview?.settings?.anilist?.syncedAt) || 0;
  if (!syncedAt || anilistLibraryRun) return;
  if (Number(localStorage.getItem(ANILIST_LIBRARY_KEY)) >= syncedAt) return;
  if (!persistentAppStateReady) {
    window.setTimeout(() => maybeSyncAniListLibrary(overview), 1000);
    return;
  }
  void syncAniListLibrary({ quiet: true }).catch(() => {});
}

function applyAniListLibrary(shows, { accountUserId = null } = {}) {
  const preserveOrigins = (entry) => {
    if (!entry.anilist?.showId) return;
    for (const [code, watched] of Object.entries(entry.watchedChapters || {})) {
      if (!watched || entry.watchedChapterOrigins?.[code]) continue;
      entry.watchedChapterOrigins = { ...(entry.watchedChapterOrigins || {}), [code]: {
        source: "anilist", accountUserId: entry.anilist.accountUserId || null,
        updatedAt: typeof watched === "number" ? watched : Number(entry.watchedChapterUpdatedAt?.[code]) || 0 } };
    }
  };
  const plan = planAniListLibrary({ series: buildLibrarySeries(), shows, keyOf: librarySeriesKey });
  const ownerId = Number.isSafeInteger(accountUserId) && accountUserId > 0 ? accountUserId : null;
  const showsById = new Map(shows.map((show) => [show.showId, show]));
  for (const { series, info } of plan.annotate) {
    info.accountUserId = ownerId && verifiedAniListLibraryIdentity(series, showsById.get(info.showId))
      ? ownerId : null;
    series.sources.forEach((entry) => {
      // Preserve the origin of legacy imported flags before changing accounts.
      preserveOrigins(entry);
      entry.anilist = info;
      if (!entry.anilistId) entry.anilistId = info.anilistId;
    });
  }
  let added = 0;
  for (const { show, info } of plan.add) {
    // A newly imported title is directly identified by the authenticated
    // AniList media ID; no unrelated local title was matched by name.
    info.accountUserId = ownerId;
    const isNew = !libraryEntryById(importedEntryId(show));
    const entry = addCatalogPlaceholder({
      id: show.imdbId || "",
      type: show.type === "movie" ? "movie" : "series",
      name: show.title,
      // The catalog poster when the show has a page there (sharper), else AniList's cover.
      poster: show.cover || (show.imdbId ? `https://images.metahub.space/poster/medium/${show.imdbId}/img` : ""),
      releaseInfo: show.year ? String(show.year) : "",
    }, { aliases: [show.title, show.titleAlt].filter(Boolean), externalSource: "ANILIST", externalId: String(show.anilistId), render: false });
    if (!entry) continue;
    // Imported titles sort by when you last changed them on AniList, so your own stay on top.
    const at = Number(show.updatedAt) || entry.addedAt;
    preserveOrigins(entry);
    Object.assign(entry, { anilistImported: true, anilistId: show.anilistId, anilist: info, updatedAt: at });
    // Previous imports preferred a catalog proxy that can return broken art.
    // Upgrade their automatic artwork to the AniList cover, preserving pins.
    if (show.cover && !entry.artworkPinned && (isNew || entry.artworkSource === "ANILIST"
      || entry.coverUrl?.startsWith("https://images.metahub.space/poster/medium/"))) {
      entry.coverUrl = show.cover;
      entry.artworkSource = "ANILIST";
    }
    if (isNew) {
      entry.addedAt = at;
      added += 1;
    }
  }
  const gone = new Set(plan.remove);
  if (gone.size) state.library = state.library.filter((entry) => !gone.has(entry.id));
  plan.clear.forEach((id) => { const entry = libraryEntryById(id); if (entry) delete entry.anilist; });
  saveLibrary();
  if ($("#view-library")?.classList.contains("is-active")) renderLibrary();
  else updateLibrarySummary();
  if (viewActive("calendar")) calendarUi.refresh();
  if (viewActive("title")) refreshTitlePage();
  return { added, marked: plan.annotate.length, removed: gone.size, total: shows.length };
}
