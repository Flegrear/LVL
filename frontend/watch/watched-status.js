// Watched and unwatched episodes, progress, and AniList unwatch.
import { confirmDialog, toast } from "../ui/ui.js";
import { chapterWatchStatus } from "../../shared/media/series-sources.js";
import { seriesAniList } from "../anilist/anilist-library.js";
import {
  ANILIST_SAVE_PROGRESS, ANILIST_SINGLE_PROGRESS_QUERY, anilistGraphql, readAniListAccount,
  writeAniListPreference,
} from "../anilist/anilist-auto-client.js";
import { resolveAniListEpisode } from "../anilist/anilist-watch-sync.js";
import { planAniListUnwatch } from "../anilist/anilist-unwatch.js";
import { frame, POPUP_HANDOFF, state, video } from "../../app.js";
import { saveLibrary } from "../app/saved-state.js";
import { $ } from "../app/dom.js";
import { viewActive } from "../app/navigation.js";
import { absolutePlaybackSeconds, seekPlayerTo } from "../player/player-core.js";
import { explicitUnwatchCompletionArmed } from "../player/audio-sync.js";
import { renderWatchChapters, setWatchTrackingStatus, watchTrackingStatus } from "./watch-page.js";
import { invalidateAutoNextAfterEpisodeEdit } from "./episode-navigation.js";
import { buildLibrarySeries, libraryEntryById, librarySeriesKey } from "../library/library-data.js";
import { libraryOrderedChapters } from "../library/library-page.js";
import { refreshTitlePage, titleSubject } from "../title/title-page.js";
import { anilistAutoRun, anilistAutoTimer, anilistStoredQueue, persistAniListQueue } from "../anilist/anilist-sync.js";

export function currentLibraryEpisode() {
  const source = state.currentSource;
  if (!source?.libraryId || source.fileIndex === null || source.fileIndex === undefined) return null;
  const entry = libraryEntryById(source.libraryId);
  const episode = entry?.episodes?.find((item) => Number(item.fileIndex) === Number(source.fileIndex));
  return entry && episode ? { entry, episode } : null;
}

// Where you stopped watching: kept per Library episode (Continue watching, Resume). Saved at most
// every 10 s while playing, and right away on pause or when leaving the page.
let watchProgressSavedAt = 0;

// positionSeconds/playing: the pop-up player's position, saved by LVL's window while it plays there.
export function recordWatchProgress({ force = false, positionSeconds = null, playing = null } = {}) {
  if (typeof POPUP_HANDOFF !== "undefined" && POPUP_HANDOFF) return;
  const current = currentLibraryEpisode();
  if (!current || !frame.classList.contains("has-video") || state.pendingSeek) return;
  const durationMs = Math.round(Number(state.mediaDurationMs) || 0);
  // The subtitle overlay follows the last frame actually presented, which
  // Chromium can throttle in a background tab while audio keeps playing.
  // Continue Watching must persist the absolute *playback* clock instead.
  const positionMs = Math.max(0, Math.round((positionSeconds ?? absolutePlaybackSeconds()) * 1000) || 0);
  if (!durationMs || positionMs < 5000) return;
  const now = Date.now();
  const code = String(current.episode.code || "").toUpperCase();
  const key = current.entry.seriesKey || librarySeriesKey(current.entry.title);
  const completionKey = `${key}\0${code}`;
  const manuallyUnwatched = explicitlyUnwatchedChapter({ key }, code);
  if (manuallyUnwatched && positionMs <= durationMs * 0.8) explicitUnwatchCompletionArmed.add(completionKey);
  const finished = positionMs >= durationMs * 0.92
    && (!manuallyUnwatched || explicitUnwatchCompletionArmed.has(completionKey));
  current.episode.progress = { positionMs, durationMs, updatedAt: now, finished };
  if (current.episode.progress.finished) {
    explicitUnwatchCompletionArmed.delete(completionKey);
    for (const entry of state.library.filter((item) => (item.seriesKey || librarySeriesKey(item.title)) === key)) {
      if (entry.watchedChapters?.[code] === false) {
        entry.watchedChapters = { ...entry.watchedChapters };
        delete entry.watchedChapters[code];
      }
    }
  }
  current.entry.lastPlayedAt = now;
  current.entry.lastPlayedFileIndex = Number(current.episode.fileIndex);
  // Real playback (not merely loading a planned anime) promotes only Planning
  // to Watching. Keep the user's other explicit tracking choices unchanged.
  if ((playing ?? !video.paused) && positionMs >= 5000) {
    const series = buildLibrarySeries().find((item) => item.key === key);
    if (series?.mediaKind === "anime" && watchTrackingStatus(series) === "PLANNING") {
      setWatchTrackingStatus(key, "CURRENT", { automatic: true });
    }
  }
  if (force || now - watchProgressSavedAt >= 10_000) {
    watchProgressSavedAt = now;
    saveLibrary();
    if ($("#watch-chapters") && !$("#watch-chapters").hidden) renderWatchChapters();
  }
}

// Manual watched marks belong to the Library series, not a torrent file: a
// catalog-only chapter remains watched even before a playable source is saved.
export function manuallyWatchedChapter(series, code) {
  if (!series || !/^S\d{2}E\d{2,4}$/.test(String(code))) return false;
  return state.library.some((item) => (item.seriesKey || librarySeriesKey(item.title)) === series.key
    && Boolean(item.watchedChapters?.[code]));
}
export function explicitlyUnwatchedChapter(series, code) {
  return Boolean(series) && state.library.some((item) =>
    (item.seriesKey || librarySeriesKey(item.title)) === series.key
    && Object.hasOwn(item.watchedChapters || {}, code) && item.watchedChapters[code] === false);
}

export function watchEpisodeStatus(series, chapter) {
  if (explicitlyUnwatchedChapter(series, String(chapter.code || "").toUpperCase()))
    return { ...chapterWatchStatus(chapter.stored?.sources || []), watched: false, percent: 0, resume: null };
  const status = chapterWatchStatus(chapter.stored?.sources || []);
  return manuallyWatchedChapter(series, String(chapter.code || "").toUpperCase())
    ? { ...status, watched: true, percent: 100, resume: null }
    : status;
}
function markWatchEpisodeUnwatched(series, code) {
  const normalized = String(code || "").toUpperCase();
  if (!series || !/^S\d{2}E\d{2,4}$/.test(normalized)) return false;
  if (typeof invalidateAutoNextAfterEpisodeEdit === "function") invalidateAutoNextAfterEpisodeEdit(series, normalized);
  explicitUnwatchCompletionArmed.delete(`${series.key}\0${normalized}`);
  const entries = state.library.filter((item) => (item.seriesKey || librarySeriesKey(item.title)) === series.key);
  const anchor = entries.find((item) => item.id === state.currentSource?.libraryId) || entries[0];
  if (!anchor) return false;
  for (const entry of entries) {
    if (entry.watchedChapters && Object.hasOwn(entry.watchedChapters, normalized)) {
      entry.watchedChapters = { ...entry.watchedChapters };
      delete entry.watchedChapters[normalized];
    }
    for (const episode of entry.episodes || []) {
      if (String(episode.code || "").toUpperCase() !== normalized || !episode.progress) continue;
      // Explicitly marking a chapter not watched resets its replay position.
      // A watched→unwatched toggle must never resume seconds before the end
      // and silently trip the pending Up Next countdown again.
      episode.progress = { ...episode.progress, positionMs: 0, finished: false, updatedAt: Date.now() };
    }
  }
  // An explicit false flag prevents stale AniList imports from immediately
  // re-watching this episode before the remote correction has completed.
  anchor.watchedChapters = { ...anchor.watchedChapters, [normalized]: false };
  anchor.watchedChapterUpdatedAt = { ...(anchor.watchedChapterUpdatedAt || {}), [normalized]: Date.now() };
  anchor.watchedChapterOrigins = { ...(anchor.watchedChapterOrigins || {}), [normalized]: { source: "local", updatedAt: Date.now() } };
  persistAniListQueue(anilistStoredQueue().filter((row) =>
    !(row.seriesKey === series.key && row.code === normalized)));
  saveLibrary();
  const current = state.currentSource;
  const selected = entries.find((entry) => entry.id === current?.libraryId)
    ?.episodes?.find((episode) => Number(episode.fileIndex) === Number(current?.fileIndex));
  if (String(selected?.code || "").toUpperCase() === normalized
    && typeof viewActive === "function" && viewActive("watch")
    && typeof seekPlayerTo === "function") seekPlayerTo(0);
  return true;
}

const ANILIST_UNWATCH_QUEUE_KEY = "lvl-anilist-unwatch-queue";
export function pendingAniListUnwatches() {
  try {
    const rows = JSON.parse(localStorage.getItem(ANILIST_UNWATCH_QUEUE_KEY) || "[]");
    return Array.isArray(rows) ? rows.slice(-100) : [];
  } catch { return []; }
}
export function savePendingAniListUnwatches(rows) {
  localStorage.setItem(ANILIST_UNWATCH_QUEUE_KEY, JSON.stringify(rows.slice(-100)));
}
export function invalidateAniListUnwatchApprovals() {
  // Previous approvals must never silently survive logout, account changes,
  // or reauthorization, even when an old account is later reconnected.
  const pending = pendingAniListUnwatches();
  if (pending.some((row) => row.approvedProgress !== null))
    savePendingAniListUnwatches(pending.map((row) => ({ ...row, approvedProgress: null })));
}

export let explicitAniListUnwatchRun = null;
async function syncExplicitAniListUnwatch(series, code) {
  const account = readAniListAccount(localStorage);
  if (!account) {
    toast("Unwatched locally. Connect AniList to sync this change.");
    return;
  }
  const info = seriesAniList(series, account.userId);
  const mapped = resolveAniListEpisode({ seasons: info?.seasons, ranges: info?.ranges || [],
    episodeCode: code, type: series.type });
  if (!mapped) {
    toast("Unwatched locally. AniList needs a verified season link before progress can change.");
    return;
  }
  const pending = pendingAniListUnwatches().filter((item) => !(item.accountId === account.userId
    && item.seriesKey === series.key && item.code === code));
  pending.push({ accountId: account.userId, seriesKey: series.key, code,
    mediaId: mapped.mediaId, episode: mapped.episode, episodeCount: mapped.episodeCount,
    approvedProgress: null });
  savePendingAniListUnwatches(pending);
  clearTimeout(anilistAutoTimer);
  await flushAniListUnwatches({ interactive: true,
    only: { accountId: account.userId, seriesKey: series.key, code } });
}

export async function flushAniListUnwatches({ interactive = false, only = null } = {}) {
  if (explicitAniListUnwatchRun) {
    const currentRun = explicitAniListUnwatchRun;
    if (!interactive) return currentRun;
    // An additional unwatch pressed during an ongoing request must not get
    // stranded behind the first run's snapshot of pending rows.
    await currentRun;
    return flushAniListUnwatches({ interactive, only });
  }
  explicitAniListUnwatchRun = (async () => {
    const account = readAniListAccount(localStorage);
    if (!account) return;
    if (anilistAutoRun) await anilistAutoRun;
    const stillConnected = () => readAniListAccount(localStorage)?.token === account.token;
    for (const row of pendingAniListUnwatches()) {
      if (!stillConnected()) return;
      if (row.accountId !== account.userId) continue;
      if (only && (row.accountId !== only.accountId
        || row.seriesKey !== only.seriesKey || row.code !== only.code)) continue;
      const series = buildLibrarySeries().find((item) => item.key === row.seriesKey);
      const part = seriesAniList(series, account.userId);
      const mapped = resolveAniListEpisode({ seasons: part?.seasons, ranges: part?.ranges || [],
        episodeCode: row.code, type: series?.type });
      if (!mapped || mapped.mediaId !== row.mediaId || mapped.episode !== row.episode
        || mapped.episodeCount !== row.episodeCount || !explicitlyUnwatchedChapter(series, row.code)) continue;
      try {
        const fresh = await anilistGraphql(account.token, ANILIST_SINGLE_PROGRESS_QUERY,
          { id: account.userId, mediaId: row.mediaId });
        if (!stillConnected()) return;
        const planned = planAniListUnwatch({ mapped, remote: fresh?.MediaList, accountId: account.userId });
        if (!planned) throw new Error("AniList entry missing, protected, or no longer matches the verified season.");
        if (planned.alreadySynced) {
          savePendingAniListUnwatches(pendingAniListUnwatches().filter((item) => item !== row
            && !(item.accountId === row.accountId && item.seriesKey === row.seriesKey && item.code === row.code)));
          continue;
        }
        if (row.approvedProgress !== null && row.approvedProgress !== planned.previousProgress
          && planned.previousProgress !== planned.progress) {
          if (!interactive) throw new Error("AniList progress changed since you approved this edit. Recheck before retrying.");
          // A fresh user gesture may approve the *new* count; never reuse a
          // stale consent against an updated remote AniList list.
          row.approvedProgress = null;
        }
        if (row.approvedProgress === null) {
          if (!interactive) continue; // Never silently approve a remote reduction on reload.
          const span = planned.discardedFollowing > 0
            ? ` This also reduces AniList's contiguous progress for ${planned.discardedFollowing} later episode(s).` : "";
          const approved = await confirmDialog({ title: "Change your AniList progress?", confirmLabel: "Change it",
            text: `AniList stores episode progress as one number. Change this title from episode ${planned.previousProgress} to ${planned.progress}?${span}` });
          if (!approved) {
            savePendingAniListUnwatches(pendingAniListUnwatches().filter((item) =>
              !(item.accountId === row.accountId && item.seriesKey === row.seriesKey && item.code === row.code)));
            toast("Episode unwatched locally; AniList was left unchanged.");
            continue;
          }
          row.approvedProgress = planned.previousProgress;
          savePendingAniListUnwatches(pendingAniListUnwatches().map((item) =>
            item.accountId === row.accountId && item.seriesKey === row.seriesKey && item.code === row.code ? row : item));
        }
        if (!stillConnected() || !explicitlyUnwatchedChapter(series, row.code)) return;
        const sent = await anilistGraphql(account.token, ANILIST_SAVE_PROGRESS,
          { mediaId: row.mediaId, progress: planned.progress, ...(planned.status ? { status: planned.status } : {}) });
        if (!stillConnected()) return;
        if (Number(sent?.SaveMediaListEntry?.mediaId) !== row.mediaId
          || sent.SaveMediaListEntry.progress !== planned.progress) throw new Error("AniList did not confirm the decreased episode count.");
        const readback = await anilistGraphql(account.token, ANILIST_SINGLE_PROGRESS_QUERY,
          { id: account.userId, mediaId: row.mediaId });
        if (!stillConnected()) return;
        if (Number(readback?.MediaList?.progress) !== planned.progress
          || (planned.status && readback.MediaList.status !== planned.status))
          throw new Error("AniList did not confirm the updated count and status on reread.");
        savePendingAniListUnwatches(pendingAniListUnwatches().filter((item) =>
          !(item.accountId === row.accountId && item.seriesKey === row.seriesKey && item.code === row.code)));
        writeAniListPreference(localStorage, { lastPush: Date.now() });
        toast(`AniList progress updated to ${planned.progress}`);
      } catch (error) {
        if (!stillConnected()) return;
        toast(`Episode unwatched locally. AniList not updated: ${error.message}`, { tone: "error" });
      }
    }
  })().finally(() => { explicitAniListUnwatchRun = null; });
  return explicitAniListUnwatchRun;
}

export function toggleEpisodeWatched(series, code, saved = null) {
  const normalized = String(code || "").toUpperCase();
  const status = watchEpisodeStatus(series, { code: normalized, stored: saved });
  if (status.watched) {
    if (!markWatchEpisodeUnwatched(series, normalized)) return false;
    void syncExplicitAniListUnwatch(series, normalized);
    return "unwatched";
  }
  return markWatchEpisodeWatched(series, normalized, saved) ? "watched" : false;
}

function markWatchEpisodeWatched(series, code, saved = null) {
  const normalized = String(code || "").toUpperCase();
  if (!series || !/^S\d{2}E\d{2,4}$/.test(normalized)) return false;
  if (typeof invalidateAutoNextAfterEpisodeEdit === "function") invalidateAutoNextAfterEpisodeEdit(series, normalized);
  explicitUnwatchCompletionArmed.delete(`${series.key}\0${normalized}`);
  const entries = state.library.filter((item) => (item.seriesKey || librarySeriesKey(item.title)) === series.key);
  const anchor = entries.find((item) => item.id === state.currentSource?.libraryId) || entries[0];
  if (!anchor) return false;
  savePendingAniListUnwatches(pendingAniListUnwatches().filter((item) =>
    !(item.seriesKey === series.key && item.code === normalized)));
  const now = Date.now();
  for (const item of entries) {
    if (item.watchedChapters?.[normalized] === false) {
      item.watchedChapters = { ...item.watchedChapters };
      delete item.watchedChapters[normalized];
    }
  }
  anchor.watchedChapters = { ...(anchor.watchedChapters || {}), [normalized]: now };
  anchor.watchedChapterOrigins = { ...(anchor.watchedChapterOrigins || {}), [normalized]: { source: "local", updatedAt: now } };
  for (const { episode } of saved?.sources || []) {
    if (!episode) continue;
    const durationMs = Math.max(1, Number(episode.progress?.durationMs) || 0, Number(episode.progress?.positionMs) || 0);
    episode.progress = { ...episode.progress, positionMs: durationMs, durationMs, updatedAt: now, finished: true };
  }
  saveLibrary();
  return true;
}

export function markTitleChapterWatched(code) {
  const series = titleSubject().series;
  const normalized = String(code || "").toUpperCase();
  if (!series || series.type !== "series") return false;
  const chapter = libraryOrderedChapters(series).find((item) => String(item.code || "").toUpperCase() === normalized);
  const result = toggleEpisodeWatched(series, normalized, chapter ? { sources: chapter.sources } : null);
  if (!result) return false;
  refreshTitlePage();
  toast(result === "unwatched" ? "Episode marked as not watched" : "Episode marked as watched");
  return true;
}
