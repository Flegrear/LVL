// The Library page: cards, continue watching, menus and removal.
import { normalizeText } from "../../shared/subtitles/subtitle-text.js";
import {
  artworkFallback, bindShelves, buttonMarkup, cardMarkup, emptyMarkup, escapeHtml, icon,
  iconButtonMarkup, metaMarkup, refreshImages, setActiveTab, shelfMarkup, toast,
} from "../ui/ui.js";
import {
  boundedPosterUrl, libraryCategory, metahubVariant, preferredPosterArt, sharperPoster,
} from "../catalog/home-feed.js";
import { chapterCode } from "../../shared/media/series-sources.js";
import { ANILIST_STATUS_LABELS, seriesAniList } from "../anilist/anilist-library.js";
import { t } from "../ui/ui-i18n.js";
import { clientFeatures, formatBytes, libraryDialogView, libraryView, state } from "../../app.js";
import { saveLibrary } from "../app/saved-state.js";
import { $, $$ } from "../app/dom.js";
import { viewActive } from "../app/navigation.js";
import { closePopupMenu, contextMenuPosition, isNativeTextMenuTarget, openMenuState, openPopupMenu } from "../ui/popup-menu.js";
import { explicitUnwatchCompletionArmed } from "../player/audio-sync.js";
import { playLibraryEpisode } from "../player/torrent-playback.js";
import { watchTrackingStatus } from "../watch/watch-page.js";
import {
  explicitlyUnwatchedChapter, manuallyWatchedChapter, pendingAniListUnwatches,
  savePendingAniListUnwatches,
} from "../watch/watched-status.js";
import { catalogChapterList, catalogChapterLists, libraryArtCached } from "../watch/episode-navigation.js";
import {
  buildLibrarySeries, groupLibraryChapters, librarySeriesChapterCount, librarySeriesKey,
  librarySourceDetails, updateLibrarySeriesEntries,
} from "./library-data.js";
import { largePosterUrl, openLibrarySeries, refreshTitlePage } from "../title/title-page.js";
import { renderLibraryRecommendations } from "../home/home-page.js";
import { compareLibrarySourceRefsByPeers } from "../catalog/catalog-search.js";
import { anilistStoredQueue, persistAniListQueue } from "../anilist/anilist-sync.js";

export let libraryContextSeriesKey = null;

export function libraryDialogThumbs(series, rerender) {
  const thumbs = new Map();
  if (!series.catalogId || series.type === "movie") return thumbs;
  const list = catalogChapterList(series.catalogId, rerender);
  (list?.chapters || []).forEach((episode) => {
    thumbs.set(chapterCode(episode.season, episode.episode), { thumbnail: episode.thumbnail || "", name: episode.name || "", released: episode.released || "" });
  });
  return thumbs;
}

export function libraryOriginText(details) {
  const release = details.releaseName.length > 90 ? `${details.releaseName.slice(0, 88)}…` : details.releaseName;
  const pack = details.sourceKind === "pack-file" || details.sourceKind === "season-pack" || details.sourceKind === "multi-episode-pack";
  return { pack, release };
}

// A shared torrent only means shared episode content when it resolves to the
// same file within that torrent. Season packs use one hash for many files.
function libraryTorrentFileKey({ entry, episode } = {}) {
  const id = String(entry?.id || "").trim();
  const magnetHash = String(entry?.magnet || "").match(/(?:[?&]xt=urn:btih:)([a-z0-9]{32}|[a-f0-9]{40})(?:&|$)/i)?.[1] || "";
  const hash = /^[a-f0-9]{40}$/i.test(id) ? id : magnetHash;
  const index = Number(episode?.fileIndex);
  return hash && Number.isInteger(index) && index >= 0 ? `${hash.toLowerCase()}:${index}` : "";
}

export function repeatedLibrarySourceIndexes(refs) {
  const seen = new Set();
  return new Set(refs.flatMap((ref, index) => {
    const key = libraryTorrentFileKey(ref);
    if (!key) return [];
    if (seen.has(key)) return [index];
    seen.add(key);
    return [];
  }));
}

export function repeatedLibrarySourceTag(duplicate) {
  return duplicate ? '<span class="lib-source-duplicate">Same source/content</span>' : "";
}

export function libraryCodecLabel(codec) {
  const value = String(codec || "").toUpperCase();
  return value === "H264" ? "H.264" : value === "UNKNOWN" ? "" : value;
}

export function libraryDialogChapterMarkup(series, chapter, thumbs, { movie = false } = {}) {
  const sources = chapter.sources.slice().sort(compareLibrarySourceRefsByPeers);
  const repeated = repeatedLibrarySourceIndexes(sources);
  const best = sources[0];
  const details = librarySourceDetails(best.entry, best.episode);
  const code = String(chapter.code || "").toUpperCase();
  const match = code.match(/^S(\d{2})E(\d{2,4})$/);
  const catalog = thumbs.get(code);
  const title = movie ? series.title : (chapter.title && !/^S\d{2}E\d{2,4}$/i.test(chapter.title) ? chapter.title : catalog?.name || chapter.title || "Chapter");
  const number = match ? `Chapter ${Number(match[2])}` : movie ? "Movie" : "Video";
  const progress = sources.map(({ episode }) => episode.progress).filter((item) => item?.durationMs > 0).sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const watched = !explicitlyUnwatchedChapter(series, code)
    && (Boolean(progress?.finished) || (!movie && manuallyWatchedChapter(series, code)));
  const ratio = progress && !watched ? Math.min(1, progress.positionMs / progress.durationMs) : 0;
  const art = catalog?.thumbnail
    ? `<img src="${escapeHtml(catalog.thumbnail)}" alt="" loading="lazy" decoding="async" data-fallback="wide" data-fallback-title="${escapeHtml(series.title)}" />`
    : `<img src="${escapeHtml(artworkFallback(series.title, { ratio: "wide", label: movie ? "Movie" : number }))}" alt="" />`;
  const key = `${series.key}|${chapter.key}`;
  const open = libraryDialogView.open.has(key);
  const others = sources.slice(1);
  const origin = libraryOriginText(details);
  const resumeAt = ratio ? Math.max(0, progress.positionMs - 5000) : 0;
  const playLabel = ratio ? "Resume" : "Play";
  return `<li class="lib-chapter${open ? " is-open" : ""}${watched ? " is-watched" : ""}" data-chapter-key="${escapeHtml(key)}"${match && !movie ? ` data-chapter-code="${escapeHtml(code)}" tabindex="0" aria-keyshortcuts="Shift+F10"` : ""}>
    <div class="lib-chapter-row">
      <span class="lib-chapter-thumb">${art}${ratio ? `<span class="lib-chapter-progress" aria-hidden="true"><span style="width:${Math.round(ratio * 100)}%"></span></span>` : ""}${watched ? `<span class="lib-chapter-watched" aria-hidden="true">${icon("check")}</span>` : ""}</span>
      <div class="lib-chapter-copy">
        <span class="lib-chapter-facts">${metaMarkup([number, details.quality !== "UNKNOWN" ? details.quality : "", libraryCodecLabel(details.codec), watched ? "Watched" : ratio ? `${Math.max(1, Math.round((progress.durationMs - progress.positionMs) / 60_000))} min left` : ""])}</span>
        <strong>${escapeHtml(title)}</strong>
        <small class="lib-chapter-origin" title="${escapeHtml(details.releaseName)}">${origin.pack ? '<span class="lib-origin-kind">From a pack</span>' : ""}<span class="lib-origin-release">${escapeHtml(origin.release)}</span><span class="lib-origin-provider">${escapeHtml(details.providers)}</span></small>
      </div>
      <div class="lib-chapter-actions">
        <button class="ui-btn ui-btn--primary ui-btn--sm library-play" type="button" data-library-id="${escapeHtml(best.entry.id)}" data-file-index="${best.episode.fileIndex}" data-resume-ms="${resumeAt}" aria-label="${escapeHtml(`${playLabel} ${movie ? series.title : `${number}: ${title}`}`)}">${icon("play")}<span>${playLabel}</span></button>
        ${match && !movie ? `<button class="ui-btn ui-btn--ghost ui-btn--sm title-mark-watched" type="button" data-title-mark-watched="${escapeHtml(code)}">${watched ? "Mark as not watched" : "Mark as watched"}</button>` : ""}
        ${others.length ? `<button class="ui-btn ui-btn--ghost ui-btn--sm lib-chapter-more" type="button" aria-expanded="${open}"><span>${others.length + 1} sources</span>${icon("chevron-down")}</button>` : ""}
      </div>
    </div>
    ${others.length ? `<div class="lib-chapter-sources"${open ? "" : " hidden"}>${sources.map(({ entry, episode }, index) => {
      const item = librarySourceDetails(entry, episode);
      const itemOrigin = libraryOriginText(item);
      return `<div class="lib-source"><div><span class="lib-source-title"><strong>${escapeHtml(itemOrigin.release)}</strong>${repeatedLibrarySourceTag(repeated.has(index))}</span>${metaMarkup([itemOrigin.pack ? "From a pack" : "", item.providers, item.quality !== "UNKNOWN" ? item.quality : "", libraryCodecLabel(item.codec), item.peers ? `${item.peers} peers` : "", episode.length ? formatBytes(episode.length) : ""])}</div><button class="ui-btn ui-btn--secondary ui-btn--sm library-play" type="button" data-library-id="${escapeHtml(entry.id)}" data-file-index="${episode.fileIndex}">Play</button></div>`;
    }).join("")}</div>` : ""}
  </li>`;
}

export function libraryDialogChaptersMarkup(series, rerender) {
  const thumbs = libraryDialogThumbs(series, rerender);
  if (series.type === "movie") {
    const videos = [...[...series.seasons.values()].flat(), ...series.extras];
    return `<ol class="lib-chapter-list">${libraryDialogChapterMarkup(series, { key: "movie", code: "VIDEO", title: series.title, sources: videos }, thumbs, { movie: true })}</ol>`;
  }
  const seasons = [...series.seasons.entries()].sort((a, b) => a[0] - b[0]);
  const tabs = seasons.map(([number, refs]) => ({ id: String(number), label: number === 0 ? "Specials" : `Season ${number}`, chapters: groupLibraryChapters(refs) }));
  if (series.extras.length) tabs.push({ id: "extras", label: "Extras", chapters: groupLibraryChapters(series.extras) });
  if (libraryDialogView.key !== series.key || !tabs.some((tab) => tab.id === libraryDialogView.season)) {
    libraryDialogView.key = series.key;
    libraryDialogView.season = tabs[0]?.id ?? null;
  }
  const current = tabs.find((tab) => tab.id === libraryDialogView.season) || tabs[0];
  if (!current) return "";
  return `${tabs.length > 1 ? `<div class="ui-chip-row lib-season-switch" role="group" aria-label="Season">${tabs.map((tab) => `<button class="ui-chip lib-season-option" type="button" data-season="${escapeHtml(tab.id)}" aria-pressed="${tab.id === current.id}">${escapeHtml(tab.label)}<span class="ui-chip__count">${tab.chapters.length}</span></button>`).join("")}</div>` : ""}
    <ol class="lib-chapter-list" aria-label="${escapeHtml(`${series.title}, ${current.label}`)}">${current.chapters.map((chapter) => libraryDialogChapterMarkup(series, chapter, thumbs)).join("")}</ol>`;
}

export function openLibraryContextMenu(event, seriesKey, { anchor = null } = {}) {
  if (isNativeTextMenuTarget(event)) return;
  event?.preventDefault?.();
  libraryContextSeriesKey = seriesKey;
  const series = buildLibrarySeries().find((item) => item.key === seriesKey);
  const watchedAction = $("#library-context-menu [data-library-action='mark-watched']");
  if (watchedAction) watchedAction.textContent = series?.sources.some((entry) => Number(entry.watchedTitleAt) > 0)
    ? "Mark as not watched" : "Mark as watched";
  renderLibrarySeasonActions(series);
  if (series?.type === "series" && /^tt\d{5,12}$/.test(series.catalogId || "")
    && !catalogChapterLists.get(series.catalogId)?.list) {
    catalogChapterList(series.catalogId, () => {
      if (libraryContextSeriesKey === seriesKey && openMenuState?.menu?.id === "library-context-menu") {
        renderLibrarySeasonActions(buildLibrarySeries().find((item) => item.key === seriesKey));
      }
    });
  }
  const press = contextMenuPosition(event, { anchor });
  openPopupMenu($("#library-context-menu"), {
    anchor,
    x: press?.x ?? null,
    y: press?.y ?? null,
    focusFirst: !press,
  });
}

export function closeLibraryContextMenu() {
  if (openMenuState?.menu?.id === "library-context-menu") closePopupMenu({ restoreFocus: false });
  else if ($("#library-context-menu")) $("#library-context-menu").hidden = true;
}

export function updateLibrarySummary(count = null) {
  const resolvedCount = Number.isInteger(count)
    ? count
    : new Set(state.library.filter((entry) => entry.libraryHidden !== true)
      .map((entry) => entry.seriesKey || librarySeriesKey(entry.title)).filter(Boolean)).size;
  if ($("#library-count")) $("#library-count").textContent = resolvedCount;
}

export async function customCoverDataUrl(file) {
  if (!file?.type?.startsWith("image/")) throw new Error("Choose an image file.");
  if (file.size > 20 * 1024 * 1024) throw new Error("Image is too large. Maximum is 20 MB.");
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = 600;
  canvas.height = 900;
  const context = canvas.getContext("2d");
  const targetRatio = canvas.width / canvas.height;
  const sourceRatio = bitmap.width / bitmap.height;
  let sx = 0;
  let sy = 0;
  let sw = bitmap.width;
  let sh = bitmap.height;
  if (sourceRatio > targetRatio) {
    sw = bitmap.height * targetRatio;
    sx = (bitmap.width - sw) / 2;
  } else {
    sh = bitmap.width / targetRatio;
    sy = (bitmap.height - sh) / 2;
  }
  context.drawImage(bitmap, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return canvas.toDataURL("image/jpeg", 0.84);
}

/* ---------------------------------------------------------------- Library page */

export const LIBRARY_VIEW_KEY = "blackline-library-view";

export function saveLibraryView() {
  localStorage.setItem(LIBRARY_VIEW_KEY, JSON.stringify({ filter: libraryView.filter, sort: libraryView.sort, status: libraryView.status }));
}

// The last episode watched in a series: { entry, episode, progress } or null.
function seriesResumePoint(series) {
  let best = null;
  let unfinished = null;
  for (const entry of series.sources || []) {
    for (const episode of entry.episodes || []) {
      const progress = episode.progress;
      if (!progress?.updatedAt || !(progress.durationMs > 0)) continue;
      const unwatched = explicitlyUnwatchedChapter(series, String(episode.code || "").toUpperCase());
      const finished = !unwatched && (progress.finished || manuallyWatchedChapter(series, String(episode.code || "").toUpperCase()));
      const item = { entry, episode, progress: { ...progress, finished } };
      if (!best || progress.updatedAt > best.progress.updatedAt) best = item;
      if (!finished && (!unfinished || progress.updatedAt > unfinished.progress.updatedAt)) unfinished = item;
    }
  }
  // A more recently *finished* episode must not hide an older paused episode
  // from the Continue shelf or erase its resume point.
  return unfinished || best;
}

// Every saved chapter in watching order (season 0, specials, last), each with its best source.
export function libraryOrderedChapters(series) {
  const seasons = [...series.seasons.entries()].sort((a, b) => (a[0] === 0) - (b[0] === 0) || a[0] - b[0]);
  return seasons.flatMap(([, refs]) => groupLibraryChapters(refs).map((chapter) => ({
    ...chapter,
    ref: chapter.sources.slice().sort(compareLibrarySourceRefsByPeers)[0],
  })));
}

export function libraryChapterName(episode) {
  const match = String(episode?.code || "").match(/^S(\d{2})E(\d{2,4})$/i);
  return match ? `S${Number(match[1])} E${Number(match[2])}` : "";
}

/**
 * What the series' main button does: resume where you stopped, play the next chapter after one
 * you finished, or start from the first chapter. Returns { label, entry, episode, atMs } or null.
 */
export function seriesNextUp(series) {
  const point = seriesResumePoint(series);
  const chapters = series.type === "movie" ? [] : libraryOrderedChapters(series);
  const watched = chapter => !explicitlyUnwatchedChapter(series, chapter.code)
    && (manuallyWatchedChapter(series, chapter.code) || chapter.sources.some(ref => ref.episode.progress?.finished));
  const wasExplicitlyUnwatched = point && explicitlyUnwatchedChapter(series, String(point.episode.code || "").toUpperCase());
  if (point && (!point.progress.finished || wasExplicitlyUnwatched)) {
    const name = libraryChapterName(point.episode);
    // Unwatch retains the old resume position for history, but entering at the
    // ending would leave the episode unwatchable: intentional unwatch cannot
    // re-arm completion until the viewer replays at or before 80%.
    const replayFromStart = wasExplicitlyUnwatched
      && point.progress.durationMs > 0 && point.progress.positionMs > point.progress.durationMs * 0.8;
    return { label: `${replayFromStart ? "Replay" : "Resume"}${name ? ` ${name}` : ""}`,
      entry: point.entry, episode: point.episode,
      atMs: replayFromStart ? 0 : Math.max(0, point.progress.positionMs - 5000) };
  }
  if (point && point.progress.finished && chapters.length) {
    const index = chapters.findIndex((chapter) => chapter.sources.some((ref) => ref.episode === point.episode));
    const next = index >= 0 ? chapters.slice(index + 1).find(chapter => !watched(chapter)) : null;
    if (next) return { label: `Play ${libraryChapterName(next.ref.episode) || "next"}`, entry: next.ref.entry, episode: next.ref.episode, atMs: 0 };
  }
  if (series.type === "movie") {
    const ref = [...[...series.seasons.values()].flat(), ...series.extras].sort(compareLibrarySourceRefsByPeers)[0];
    return ref ? { label: "Play", entry: ref.entry, episode: ref.episode, atMs: 0 } : null;
  }
  const first = chapters.find(chapter => !watched(chapter)) || chapters[0];
  return first ? { label: `Play ${libraryChapterName(first.ref.episode) || ""}`.trim(), entry: first.ref.entry, episode: first.ref.episode, atMs: 0 } : null;
}

function seriesActivityAt(series) {
  return Math.max(0, ...(series.sources || []).map((entry) => Math.max(Number(entry.lastPlayedAt) || 0, Number(entry.updatedAt) || 0, Number(entry.addedAt) || 0)));
}

function seriesAddedAt(series) {
  return Math.max(0, ...(series.sources || []).map((entry) => Number(entry.addedAt) || 0));
}

function libraryWatchedAt(series) {
  return Math.max(0, ...(series.sources || []).map((entry) => Math.max(Number(entry.lastPlayedAt) || 0,
    Number(entry.watchedTitleAt) || 0)));
}

export function isLibraryTitleMarkedWatched(series) {
  return Boolean(series?.sources?.some((entry) => Number(entry.watchedTitleAt) > 0));
}

function librarySeasonChapterCodes(series) {
  const seasons = new Map();
  if (!series || series.type !== "series") return seasons;
  const add = (season, code) => {
    const normalized = String(code || "").toUpperCase();
    if (!Number.isInteger(season) || season < 1 || !/^S\d{2}E\d{2,4}$/.test(normalized)
      || Number(normalized.slice(1, 3)) !== season) return;
    if (!seasons.has(season)) seasons.set(season, new Set());
    seasons.get(season).add(normalized);
  };
  const list = catalogChapterLists.get(series.catalogId)?.list;
  for (const season of list?.seasons || []) {
    if (!Number.isInteger(season.season) || season.season < 1) continue;
    for (const chapter of season.episodes || []) {
      if (Number.isInteger(chapter.episode) && chapter.episode > 0)
        add(season.season, chapterCode(season.season, chapter.episode));
    }
  }
  for (const [season, refs] of series.seasons || []) {
    for (const ref of refs) add(season, ref.episode?.code);
  }
  return new Map([...seasons].sort((a, b) => a[0] - b[0]));
}

function librarySeasonAllWatched(series, codes) {
  return codes.length > 0 && codes.every((code) => !explicitlyUnwatchedChapter(series, code)
    && (isLibraryTitleMarkedWatched(series) || manuallyWatchedChapter(series, code) || series.sources.some((entry) =>
      (entry.episodes || []).some((episode) => String(episode.code || "").toUpperCase() === code && episode.progress?.finished))));
}

function renderLibrarySeasonActions(series) {
  const node = $("#library-context-menu [data-library-season-actions]");
  if (!node) return;
  const seasons = librarySeasonChapterCodes(series);
  node.hidden = !seasons.size;
  node.innerHTML = [...seasons].map(([season, codes]) => {
    const watched = librarySeasonAllWatched(series, [...codes]);
    return `<button type="button" role="menuitem" class="ui-menu__item" data-library-action="mark-season" data-library-season="${season}" data-library-watched="${watched ? 'false' : 'true'}">Season ${season} - Mark as ${watched ? 'not watched' : 'watched'}</button>`;
  }).join("");
}

export function setLibrarySeasonWatched(series, season, watched) {
  const codes = librarySeasonChapterCodes(series).get(season);
  if (!codes?.size) return false;
  const entries = state.library.filter((entry) => (entry.seriesKey || librarySeriesKey(entry.title)) === series.key);
  const anchor = entries.find((entry) => entry.id === state.currentSource?.libraryId) || entries[0];
  if (!anchor) return false;
  const now = Date.now();
  for (const code of codes) explicitUnwatchCompletionArmed.delete(`${series.key}\0${code}`);
  for (const entry of entries) {
    const flags = { ...(entry.watchedChapters || {}) };
    for (const code of codes) delete flags[code];
    entry.watchedChapters = flags;
    if (!watched) {
      entry.watchedTitleAt = 0;
      for (const episode of entry.episodes || []) {
        if (!codes.has(String(episode.code || "").toUpperCase()) || !episode.progress) continue;
        episode.progress = { ...episode.progress, finished: false, updatedAt: now };
      }
    }
    entry.updatedAt = now;
  }
  anchor.watchedChapters = { ...anchor.watchedChapters,
    ...Object.fromEntries([...codes].map((code) => [code, watched ? now : false])) };
  anchor.watchedChapterUpdatedAt = { ...(anchor.watchedChapterUpdatedAt || {}),
    ...Object.fromEntries([...codes].map(code => [code, now])) };
  anchor.watchedChapterOrigins = { ...(anchor.watchedChapterOrigins || {}),
    ...Object.fromEntries([...codes].map(code => [code, { source: "local", updatedAt: now }])) };
  savePendingAniListUnwatches(pendingAniListUnwatches().filter((row) =>
    row.seriesKey !== series.key || !codes.has(row.code)));
  if (!watched) persistAniListQueue(anilistStoredQueue().filter((row) =>
    row.seriesKey !== series.key || !codes.has(row.code)));
  saveLibrary();
  renderLibrary();
  refreshTitlePage();
  toast(`Season ${season} marked as ${watched ? "watched" : "not watched"} locally`);
  return true;
}

// A title-level watched mark works for catalog-only films (no torrent/chapter).
// Keep it local: AniList watch progress must follow its independently verified
// season/movie mapping, never a guessed whole-series completion mutation.
export function setLibraryTitleWatched(series, watched) {
  if (!series?.key) return false;
  const at = watched ? Date.now() : 0;
  const changed = updateLibrarySeriesEntries(series.key, (entry) => {
    entry.watchedTitleAt = at;
    entry.updatedAt = Date.now();
  });
  if (changed) {
    renderLibrary();
    refreshTitlePage();
    toast(`${series.title} marked as ${watched ? "watched" : "not watched"} locally`);
  }
  return changed;
}

function libraryProgressRatio(series) {
  if (isLibraryTitleMarkedWatched(series)) return 1;
  const chapters = series.type === "series" ? libraryOrderedChapters(series) : [];
  if (chapters.length) return chapters.reduce((total, chapter) => {
    if (explicitlyUnwatchedChapter(series, chapter.code)) return total;
    if (manuallyWatchedChapter(series, chapter.code)) return total + 1;
    return total + Math.max(0, ...chapter.sources.map(ref => {
      const progress = ref.episode.progress;
      return progress?.finished ? 1 : progress?.durationMs > 0 ? Math.max(0, Math.min(1, progress.positionMs / progress.durationMs)) : 0;
    }));
  }, 0) / chapters.length;
  const progress = [...(series.sources || []).flatMap((entry) => entry.episodes || [])
    .map((episode) => episode.progress).filter((item) => item?.durationMs > 0)];
  if (!progress.length) return 0;
  return progress.reduce((sum, item) => sum + (item.finished ? 1 : Math.max(0, Math.min(1, item.positionMs / item.durationMs))), 0) / progress.length;
}

// The sharpest version of a Library title's cover for a card: catalog posters as a 300–780 px
// set (the browser picks the size this screen needs), AniList's large cover, IMDb's 780 px; the
// saved cover is the fallback, and AniList's cover after that.
export function libraryCardImage(series, art = null) {
  const saved = series.coverUrl || art?.poster || "";
  const anilistCover = seriesAniList(series)?.cover || "";
  const selected = preferredPosterArt({ saved, catalog: art?.poster || "", anilist: anilistCover,
    artworkSource: series.artworkSource, pinned: series.artworkPinned });
  const catalog = metahubVariant(selected.image, "small");
  if (catalog) return { image: catalog, imageSrcset: selected.srcset, imageFallback: selected.fallback };
  const sharper = sharperPoster(selected.image);
  if (sharper.imageFallback) return { image: sharper.image, imageSrcset: "", imageFallback: sharper.imageFallback };
  const imdb = largePosterUrl(selected.image);
  const bounded = boundedPosterUrl(imdb);
  if (bounded && bounded !== selected.image) return { image: bounded, imageSrcset: "", imageFallback: bounded !== imdb ? imdb : selected.image };
  return { image: selected.image, imageSrcset: selected.srcset, imageFallback: selected.fallback };
}

function libraryCardItem(series, category = null) {
  const chapters = librarySeriesChapterCount(series);
  const point = seriesResumePoint(series);
  const art = libraryArtCached(series);
  const videos = chapters + series.extras.length;
  const progress = point && !point.progress.finished ? Math.min(1, point.progress.positionMs / point.progress.durationMs) : 0;
  const anilist = seriesAniList(series);
  const listStatus = ANILIST_STATUS_LABELS[watchTrackingStatus(series)] || "";
  // AniList list scores are the user's own rating. Don't mislabel them as the
  // community average: only show a sourced public percentage when available.
  const publicAverage = Number(anilist?.averageScore ?? art?.anilistAverageScore);
  const communityScore = category === "anime" && publicAverage > 0 && publicAverage <= 100
    ? `★ ${(publicAverage / 10).toFixed(1)}` : "";
  const seasonEpisodes = (anilist?.seasons || []).map((season) => Number(season.episodes));
  const knownEpisodes = seasonEpisodes.length && seasonEpisodes.every((value) => Number.isInteger(value) && value > 0)
    ? seasonEpisodes.reduce((sum, value) => sum + value, 0) : chapters;
  const count = series.type !== "movie" && knownEpisodes ? `${knownEpisodes} eps` : "";
  return {
    key: series.key,
    title: series.title,
    ...libraryCardImage(series, art),
    meta: [
      category === "anime" ? (series.type === "movie" ? "Anime film" : "Anime") : series.type === "movie" ? "Movie" : "TV",
      art?.releaseInfo ? String(art.releaseInfo).slice(0, 4) : series.releaseInfo ? String(series.releaseInfo).slice(0, 4) : "",
      count,
      communityScore,
    ],
    badge: isLibraryTitleMarkedWatched(series) ? "Watched" : videos ? "" : listStatus || "No sources",
    progress: isLibraryTitleMarkedWatched(series) ? 1 : progress,
  };
}

function libraryMoreButton(series) {
  return iconButtonMarkup({ icon: "more", label: `More for ${series.title}`, variant: "glass", size: "sm", attrs: { "data-ui-action": "menu", "aria-haspopup": "menu", "aria-expanded": "false" } });
}

function renderLibraryContinue(all) {
  const section = $("#library-continue");
  if (!section) return;
  const items = all
    .map((series) => {
      const point = seriesResumePoint(series);
      const replay = Boolean(point && explicitlyUnwatchedChapter(series, String(point.episode.code || "").toUpperCase())
        && point.progress.positionMs > point.progress.durationMs * 0.8);
      return { series, point, replay };
    })
    .filter(({ series, point, replay }) => !isLibraryTitleMarkedWatched(series) && point
      && (!point.progress.finished || replay) && (point.progress.positionMs > 30_000 || replay))
    .sort((a, b) => b.point.progress.updatedAt - a.point.progress.updatedAt)
    .slice(0, 16);
  section.hidden = !items.length;
  if (!items.length) {
    section.innerHTML = "";
    return;
  }
  section.innerHTML = shelfMarkup({
    id: "library-continue-shelf",
    title: "Continue watching",
    cards: items.map(({ series, point, replay }) => {
      const left = Math.max(1, Math.round((point.progress.durationMs - point.progress.positionMs) / 60_000));
      return cardMarkup({
        key: series.key,
        title: series.title,
        ...libraryCardImage(series, libraryArtCached(series)),
        meta: [libraryChapterName(point.episode) || (series.type === "movie" ? "Movie" : ""), replay ? "Replay episode" : `${left} min left`],
        progress: replay ? 0 : point.progress.positionMs / point.progress.durationMs,
      }, { primaryAction: "resume", bodyAction: "library", actions: false });
    }),
  });
  bindShelves(section);
  refreshImages(section);
}

export function renderLibrary() {
  const list = $("#library-list");
  if (!list) return;
  const all = buildLibrarySeries();
  updateLibrarySummary(all.length);
  renderLibraryRecommendations(all);
  const animeIds = new Set((state.homeCatalog.anime || []).map((meta) => meta.id).filter(Boolean));
  const groups = { series: [], movie: [], anime: [] };
  const categories = new Map();
  all.forEach((series) => {
    const category = libraryCategory(series, { animeIds, details: libraryArtCached(series) });
    categories.set(series.key, category);
    groups[category].push(series);
  });
  const counts = { all: all.length, series: groups.series.length, movie: groups.movie.length, anime: groups.anime.length };
  document.querySelectorAll("[data-library-count]").forEach((node) => { node.textContent = counts[node.dataset.libraryCount] ? String(counts[node.dataset.libraryCount]) : ""; });
  setActiveTab($("#library-filter"), libraryView.filter);
  // A feature filter (Manga, Books…) fills the list itself. data-feature-filter
  // lets its stylesheet hide video-only parts (Continue watching, picks).
  const libraryPage = $("#view-library");
  const featureOptions = { query: libraryView.query, sort: libraryView.sort, status: libraryView.status };
  const paintStatusCounts = (counts, labels = {}) => $$("#library-status-filter [data-library-status]").forEach((button) => {
    const key = button.dataset.libraryStatus;
    button.setAttribute("aria-pressed", String(key === libraryView.status));
    const count = button.querySelector("[data-library-status-count]");
    if (count) count.textContent = counts[key] ? String(counts[key]) : "";
    // A feature filter (Manga…) names the lists its own way: Reading, Rereading.
    const name = button.querySelector("span:not([data-library-status-count])");
    if (!name || name === count) return;
    if (button.dataset.coreLabel === undefined) button.dataset.coreLabel = name.textContent;
    const text = labels[key] ? t(labels[key]) : button.dataset.coreLabel;
    if (name.textContent !== text) name.textContent = text;
  });
  if (typeof clientFeatures !== "undefined" && clientFeatures.showLibraryFilter(libraryView.filter, list, featureOptions)) {
    if (libraryPage) libraryPage.dataset.featureFilter = libraryView.filter;
    paintStatusCounts(clientFeatures.libraryFilterStatuses(libraryView.filter, featureOptions), clientFeatures.libraryStatusLabels(libraryView.filter));
    return;
  }
  if (libraryPage) delete libraryPage.dataset.featureFilter;
  const sort = $("#library-sort");
  if (sort && sort.value !== libraryView.sort) sort.value = libraryView.sort;
  const status = libraryView.status;
  const query = normalizeText(libraryView.query || "");
  const filteredByCategoryAndSearch = all
    .filter((series) => libraryView.filter === "all" || groups[libraryView.filter]?.includes(series))
    .filter((series) => !query || [series.title, ...(series.aliases || [])].some((name) => normalizeText(name).includes(query)));
  const libraryStatus = (series) => {
    const local = (series.sources || []).map((entry) => entry.trackingStatus)
      .find((value) => Object.hasOwn(ANILIST_STATUS_LABELS, value));
    if (local) return local;
    if (isLibraryTitleMarkedWatched(series)) return "COMPLETED";
    const info = seriesAniList(series);
    // A fully rewatching show may be grouped as CURRENT by the AniList import.
    const active = (info?.seasons || []).filter((part) => ["CURRENT", "REPEATING"].includes(part.status));
    if (active.length && active.every((part) => part.status === "REPEATING")) return "REPEATING";
    return info?.status || "";
  };
  const statuses = { any: filteredByCategoryAndSearch.length, CURRENT: 0, COMPLETED: 0, PLANNING: 0, PAUSED: 0, DROPPED: 0, REPEATING: 0 };
  for (const series of filteredByCategoryAndSearch) {
    const key = libraryStatus(series);
    if (Object.hasOwn(statuses, key)) statuses[key] += 1;
  }
  // Feature groups (Comics…) join the "All" view and its status counts.
  const featureGroups = libraryView.filter === "all" && typeof clientFeatures !== "undefined" ? clientFeatures.libraryAllGroups(featureOptions) : [];
  for (const group of featureGroups) {
    for (const [key, value] of Object.entries(group.statuses)) if (Object.hasOwn(statuses, key)) statuses[key] += Number(value) || 0;
  }
  const featureShown = featureGroups.reduce((sum, group) => sum + group.shown, 0);
  paintStatusCounts(statuses);
  const shown = filteredByCategoryAndSearch
    .filter((series) => status === "any" || libraryStatus(series) === status)
    .sort((a, b) => {
      const alpha = a.title.localeCompare(b.title, undefined, { sensitivity: "base", numeric: true });
      if (libraryView.sort === "title") return alpha;
      if (libraryView.sort === "title-desc") return -alpha;
      if (libraryView.sort === "added") return seriesAddedAt(b) - seriesAddedAt(a) || alpha;
      if (libraryView.sort === "watched") return libraryWatchedAt(b) - libraryWatchedAt(a) || alpha;
      if (libraryView.sort === "progress") return libraryProgressRatio(b) - libraryProgressRatio(a) || alpha;
      if (libraryView.sort === "unfinished") return libraryProgressRatio(a) - libraryProgressRatio(b) || alpha;
      return seriesActivityAt(b) - seriesActivityAt(a) || alpha;
    });
  // The Continue shelf belongs to the current Library view. Do not show
  // anime resume cards under Movies/Series or ignore the status/search filters.
  renderLibraryContinue(shown);
  if (!all.length && !featureShown) {
    list.classList.remove("is-grouped");
    list.innerHTML = emptyMarkup({
      icon: "library",
      title: "Your Library is empty",
      text: "Add a movie or series to watch it with subtitles and turn its lines into cards.",
      action: buttonMarkup({ label: "Add a title", variant: "primary", icon: "plus", attrs: { "data-library-empty": "add" } }),
    });
    return;
  }
  if (!shown.length && !featureShown) {
    list.classList.remove("is-grouped");
    list.innerHTML = emptyMarkup({ compact: true, icon: "search", title: "No matches", text: libraryView.query ? `Nothing in your Library matches "${libraryView.query}".` : status !== "any" ? `No titles match ${ANILIST_STATUS_LABELS[status]?.toLowerCase() || "this status"}.` : "Nothing here yet." });
    return;
  }
  const card = (series) => cardMarkup(libraryCardItem(series, categories.get(series.key)), { primaryAction: "library", actionsMarkup: libraryMoreButton(series) });
  const grouped = libraryView.filter === "all";
  list.classList.toggle("is-grouped", grouped);
  if (grouped) {
    list.innerHTML = [
      ["series", "Series"], ["movie", "Movies"], ["anime", "Anime"],
    ].map(([kind, heading]) => {
      const items = shown.filter((series) => groups[kind].includes(series));
      if (!items.length) return "";
      return `<section class="lib-category" aria-label="${heading}"><header class="lib-category__head"><h2>${heading}</h2><span class="lib-category__count">${items.length}</span></header><div class="ui-grid lib-grid">${items.map(card).join("")}</div></section>`;
    }).join("") + featureGroups.filter((group) => group.shown).map((group) => {
      const heading = escapeHtml(t(group.label));
      return `<section class="lib-category" aria-label="${heading}" data-feature="${escapeHtml(group.id)}"><header class="lib-category__head"><h2>${heading}</h2><span class="lib-category__count">${group.shown}</span></header><div class="ui-grid lib-grid">${group.html}</div></section>`;
    }).join("");
  } else {
    list.innerHTML = shown.map(card).join("");
  }
  refreshImages(list);
}

export async function resumeLibrarySeries(seriesKey) {
  const series = buildLibrarySeries().find((item) => item.key === seriesKey);
  const next = series ? seriesNextUp(series) : null;
  if (!next) {
    openLibrarySeries(seriesKey);
    return;
  }
  await playLibraryEpisode(next.entry.id, Number(next.episode.fileIndex), { resumeAtSeconds: next.atMs / 1000 });
}

export function handleLibraryCardAction(event) {
  const trigger = event.target.closest("[data-ui-action], [data-library-empty]");
  if (!trigger) return;
  if (trigger.dataset.libraryEmpty === "add") {
    openCatalogDialog();
    return;
  }
  const holder = trigger.closest("[data-series-key]");
  if (!holder || (!$("#library-list")?.contains(holder) && !$("#library-continue")?.contains(holder))) return;
  const key = holder.dataset.seriesKey;
  const action = trigger.dataset.uiAction;
  if (action === "menu") openLibraryContextMenu(event, key, { anchor: trigger });
  else if (action === "resume") void resumeLibrarySeries(key);
  else openLibrarySeries(key);
}

// The in-page action distinguishes removing a Library listing from removing
// its chapter/source records. A retained entry is hidden from Library cards,
// but its saved episodes, mappings and progress remain available on re-add.
let pendingLibraryRemoval = null;
export function openLibraryRemoveDialog(series) {
  const dialog = $("#library-remove-dialog");
  if (!series || !dialog) return;
  pendingLibraryRemoval = { key: series.key, title: series.title };
  if (!dialog.open) dialog.showModal();
  $("#library-remove-cancel")?.focus();
}
function closeLibraryRemoveDialog() {
  $("#library-remove-dialog")?.close();
  pendingLibraryRemoval = null;
}
export function wireLibraryRemoveDialog() {
  $("#library-remove-cancel")?.addEventListener("click", closeLibraryRemoveDialog);
  $("#library-remove-dialog")?.addEventListener("close", () => { pendingLibraryRemoval = null; });
}
export function confirmLibraryRemoval({ removeChapters = false } = {}) {
  const removing = pendingLibraryRemoval;
  if (!removing) return;
  closeLibraryRemoveDialog();
  // Recheck the saved key at confirmation; a stale dialog cannot affect a
  // different series. Only the explicitly destructive option drops chapters.
  const matches = (entry) => (entry.seriesKey || librarySeriesKey(entry.title)) === removing.key;
  if (!state.library.some((entry) => matches(entry) && entry.libraryHidden !== true)) return;
  if (removeChapters) state.library = state.library.filter((entry) => !matches(entry));
  else for (const entry of state.library) if (matches(entry)) entry.libraryHidden = true;
  saveLibrary();
  $("#library-words-dialog")?.close();
  // Never navigate away from Title/Watch/Library after either choice.
  renderLibrary();
  if (viewActive("title")) refreshTitlePage();
  toast(removeChapters ? `${removing.title} and saved chapters removed from your Library`
    : `${removing.title} removed from your Library; chapters retained`);
}
