// The Watch page: episode list, title info, side panel and theater mode.
import { artworkFallback, escapeHtml, icon, refreshImages, toast } from "../ui/ui.js";
import { boundedPosterUrl, formatRuntime, metahubVariant, posterSrcset } from "../catalog/home-feed.js";
import { chapterCode, chapterWatchStatus } from "../../shared/media/series-sources.js";
import { ANILIST_STATUS_LABELS, anilistProgressText, seriesAniList } from "../anilist/anilist-library.js";
import { readAniListAccount } from "../anilist/anilist-auto-client.js";
import { eligibleForPublicAnimeRating } from "../catalog/title-public-ratings.js";
import { watchSidebarPicks } from "../catalog/watch-discovery.js";
import { frame, state, video } from "../../app.js";
import { saveLibrary } from "../app/saved-state.js";
import { $ } from "../app/dom.js";
import { fetchJson } from "../app/http.js";
import { navigateWatchToLibrary, switchView } from "../app/navigation.js";
import { closePopupMenu, openPopupMenu, wirePopupMenu } from "../ui/popup-menu.js";
import { playerLoadingLibraryId, resumePlayback, seekPlayerTo, setPlayerLoadingTitle } from "../player/player-core.js";
import { playLibraryEpisode, watchPendingSelection } from "../player/torrent-playback.js";
import {
  currentLibraryEpisode, explicitlyUnwatchedChapter, flushAniListUnwatches, markTitleChapterWatched,
  pendingAniListUnwatches, toggleEpisodeWatched, watchEpisodeStatus,
} from "./watched-status.js";
import {
  catalogChapterList, catalogChapterLists, currentCatalogNeighbors, findWatchEpisodeSources,
  libraryArtCached, libraryArtFor, movieArtRecords, playCatalogNeighbor,
} from "./episode-navigation.js";
import {
  buildLibrarySeries, currentChapterNavigation, groupLibraryChapters, libraryEntryById,
  librarySeriesKey, librarySourceDetails, normalizeLibrarySourceMeta,
} from "../library/library-data.js";
import { libraryOrderedChapters } from "../library/library-page.js";
import {
  formatTitleDay, largePosterUrl, openHomeTitle, openLibrarySeries, openTitlePage, titleInfo,
  titleListText, titleSubject,
} from "../title/title-page.js";
import { addCatalogChapterSource, chapterResumeMs, chapterUpcoming } from "../title/title-chapters.js";
import { homeTitleIndex, loadHomeCatalog } from "../home/home-page.js";
import { compareLibrarySourceRefsByPeers } from "../catalog/catalog-search.js";

// Match the episode list to the actual video rectangle, not the full player
// column (which extends farther down for subtitles and title details).
export function syncWatchEpisodeHeight() {
  const layout = $("#watch-player-layout");
  const height = frame?.getBoundingClientRect().height || 0;
  if (layout && height > 0) layout.style.setProperty("--watch-episode-player-height", `${Math.round(height)}px`);
}

export function updateChapterButtons() {
  const nav = currentChapterNavigation();
  const catalog = currentCatalogNeighbors();
  const previousButton = $("#player-prev-chapter");
  const nextButton = $("#player-next-chapter");
  if (previousButton) previousButton.disabled = !(catalog?.previous || nav.previous);
  if (nextButton) nextButton.disabled = !(catalog?.next || nav.next);
  renderWatchChapters();
}

// Miruro-style episode browser: one collapsible block on the Watch page,
// with individual collapsible seasons and progress from the saved Library.
let watchChaptersSourceKey = "";
let watchChapterActions = new Map();
export let watchEpisodeSourcesOpen = "";
export const watchEpisodeSourceLookups = new Map();
// Keep existing focus and event targets when startup repeats an identical
// chapter render; source-specific action data is refreshed independently.
const watchChapterMarkupByNode = new WeakMap();
function setWatchChapterMarkup(node, markup) {
  if (watchChapterMarkupByNode.get(node) === markup) return false;
  node.innerHTML = markup;
  watchChapterMarkupByNode.set(node, markup);
  return true;
}

let watchSelectedSeason = null;
let watchInfoRenderKey = "";
const watchCatalogMatches = new Map();
export function watchCatalogIdFor(series) {
  if (!series) return "";
  if (/^tt\d{5,12}$/.test(String(series.catalogId || ""))) return series.catalogId;
  const aliases = [series.title, ...(series.aliases || [])].filter(Boolean);
  const normalize = (name) => String(name || "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const keys = new Set(aliases.map(normalize).filter(Boolean));
  const type = series.type === "movie" ? "movie" : "series";
  if (!keys.size) return "";
  // A strict title match can reuse a known Home record without extra traffic.
  const local = [...homeTitleIndex.values()].find((item) => item.type === type && /^tt\d{5,12}$/.test(String(item.id || "")) && keys.has(normalize(item.name)));
  if (local) return local.id;
  const key = `${type}:${series.key}`;
  const cached = watchCatalogMatches.get(key);
  if (cached?.id) return cached.id;
  if (cached && (cached.pending || Date.now() < cached.retryAfter)) return "";
  const record = { id: "", pending: true, retryAfter: 0, failed: false };
  watchCatalogMatches.set(key, record);
  void fetchJson(`/api/catalog/search?q=${encodeURIComponent(series.title)}`)
    .then((data) => {
      const exact = (data.results || []).find((item) => item.type === type && /^tt\d{5,12}$/.test(String(item.id || "")) && keys.has(normalize(item.name)));
      if (exact) record.id = exact.id;
      else record.retryAfter = Date.now() + 10 * 60_000;
    })
    .catch(() => { record.failed = true; record.retryAfter = Date.now() + 60_000; })
    .finally(() => { record.pending = false; refreshWatchCatalogDetails(); });
  return "";
}
function refreshWatchCatalogDetails() {
  if ((playerLoadingLibraryId || state.currentSource?.libraryId)
    && $("#view-watch")?.classList.contains("is-active")) {
    renderWatchChapters();
    if (!$("#video-loading")?.hidden)
      setPlayerLoadingTitle(libraryEntryById(playerLoadingLibraryId || state.currentSource.libraryId));
  }
}

// LVL's editable tracking status is kept distinct from the last imported
// AniList value. A playback event must not silently write to a remote account
// or change a user-selected Paused, Dropped, Completed or Rewatching status.
export function watchTrackingStatus(series) {
  return (series?.sources || []).map((item) => item.trackingStatus)
    .find((value) => Object.hasOwn(ANILIST_STATUS_LABELS, value))
    || seriesAniList(series)?.status || "";
}

export function setWatchTrackingStatus(seriesKey, status, { automatic = false } = {}) {
  if (!Object.hasOwn(ANILIST_STATUS_LABELS, status)) return false;
  const series = buildLibrarySeries().find((item) => item.key === seriesKey);
  if (!series || series.mediaKind !== "anime") return false;
  const previous = watchTrackingStatus(series);
  if (automatic && previous !== "PLANNING") return false;
  if (previous === status && series.sources.every((item) => item.trackingStatus === status)) return false;
  const at = Date.now();
  for (const entry of series.sources) {
    entry.trackingStatus = status;
    entry.updatedAt = at;
  }
  saveLibrary();
  const active = state.currentSource?.libraryId && libraryEntryById(state.currentSource.libraryId);
  if (active && (active.seriesKey || librarySeriesKey(active.title)) === seriesKey) {
    renderWatchInfo(buildLibrarySeries().find((item) => item.key === seriesKey), active);
  }
  return true;
}

function renderWatchInfo(series, entry) {
  const info = $("#watch-title-info");
  const rail = $("#watch-side-rail");
  const layout = $("#watch-player-layout");
  const related = $("#watch-related");
  const recommended = $("#watch-recommended");
  if (!info || !rail || !layout || !related || !recommended) return;
  if (!entry || !series) {
    info.hidden = true;
    rail.hidden = true;
    layout.classList.remove("has-chapters");
    watchInfoRenderKey = "";
    return;
  }
  info.hidden = false;
  rail.hidden = false;
  layout.classList.add("has-chapters");
  const catalogId = watchCatalogIdFor(series) || entry.catalogId || "";
  // Home's abbreviated synopsis is useful while loading, but does not contain
  // cast, status or the episode stills. Always request the full title record.
  const full = (series.type === "movie" ? movieArtRecords : catalogChapterLists).get(catalogId)?.meta;
  if (!full && /^tt\d{5,12}$/.test(catalogId)) {
    if (series.type === "movie") libraryArtFor({ ...series, catalogId }, refreshWatchCatalogDetails, { full: true });
    else catalogChapterList(catalogId, refreshWatchCatalogDetails);
  }
  const meta = full || libraryArtCached(series) || {};
  const details = titleInfo({ id: catalogId, type: series.type, series }, meta);
  const anilist = seriesAniList(series);
  const title = series.title || entry.displayTitle || entry.title || "Untitled";
  const genres = details.genres || [];
  const cover = series.coverUrl || details.posterFallback || seriesAniList(series)?.cover || "";
  const originalPoster = details.poster || largePosterUrl(cover);
  const poster = boundedPosterUrl(originalPoster);
  const posterSrcsetValue = posterSrcset({ poster });
  const imageFallback = poster !== originalPoster ? originalPoster : details.posterFallback;
  const image = poster ? `<img src="${escapeHtml(poster)}"${posterSrcsetValue ? ` srcset="${escapeHtml(posterSrcsetValue)}" sizes="(max-width:680px) 120px, (min-width:1440px) 275px, 19vw"` : ""} alt="" loading="lazy" decoding="async" data-fallback="poster" data-fallback-title="${escapeHtml(title)}"${imageFallback && imageFallback !== poster ? ` data-fallback-src="${escapeHtml(imageFallback)}"` : ""} />`
    : `<img src="${escapeHtml(artworkFallback(title))}" alt="" />`;
  const description = String(details.description || entry.description || "").trim();
  const savedChapters = series.type === "movie" ? 0 : libraryOrderedChapters(series).length;
  const episodeCount = details.chapterTotal || savedChapters;
  const facts = [
    ["Format", series.mediaKind === "anime" ? "Anime" : series.type === "movie" ? "Movie" : "TV series"],
    [series.type === "movie" ? "Released" : "First aired", formatTitleDay(details.released) || details.releaseInfo],
    ["Broadcast status", details.status],
    ["Rating", details.rating ? `★ ${details.rating} / 10` : ""],
    ["Episodes", episodeCount ? String(episodeCount) : ""],
    ["Seasons", details.seasonCount ? String(details.seasonCount) : ""],
    ["Runtime", details.runtime ? (series.type === "movie" ? formatRuntime(details.runtime) || details.runtime : `${details.runtime} per episode`) : ""],
    ["Country", details.country],
    ["Starring", series.mediaKind === "anime" || eligibleForPublicAnimeRating({ genres, country: details.country })
      ? "" : titleListText(details.cast, 5)],
    ["Written by", titleListText(details.writer, 4)],
    ["Directed by", titleListText(details.director, 4)],
    ["Awards", details.awards],
    ["AniList status (last synced)", ANILIST_STATUS_LABELS[anilist?.status] || ""],
    ["Your AniList progress", anilistProgressText(anilist)],
  ].filter(([, value]) => String(value || "").trim());
  const localStatus = series.mediaKind === "anime" ? watchTrackingStatus(series) : "";
  const tracking = series.mediaKind === "anime" ? `<div class="watch-info-tracking">
    <label for="watch-tracking-status">Tracking status</label>
    <select id="watch-tracking-status" data-watch-tracking-status aria-label="Edit LVL tracking status">
      <option value="" disabled${localStatus ? "" : " selected"}>Choose status</option>
      ${Object.entries(ANILIST_STATUS_LABELS).map(([value, label]) =>
        `<option value="${value}"${localStatus === value ? " selected" : ""}>${escapeHtml(label)}</option>`).join("")}
    </select>
    <small>Saved in LVL. AniList status above changes only after a verified AniList sync.</small>
  </div>` : "";
  const subject = { id: catalogId, type: series.type === "movie" ? "movie" : "series", genres };
  const picks = watchSidebarPicks(state.homeCatalog, subject, { excluded: [subject.id], relatedLimit: 5, recommendedLimit: 6 });
  const signature = JSON.stringify([entry.id, title, cover, poster, description, genres, facts, localStatus,
    state.homeCatalogUpdatedAt, picks.related.map((item) => item.id), picks.recommended.map((item) => item.id)]);
  if (signature === watchInfoRenderKey) return;
  watchInfoRenderKey = signature;
  info.innerHTML = `<div class="watch-info-poster">${image}</div>
    <div class="watch-info-copy"><h2><button type="button" class="watch-info-title-link" data-watch-title-details
        data-watch-series-key="${escapeHtml(series.key || "")}" data-watch-catalog-id="${escapeHtml(catalogId)}"
        data-watch-catalog-type="${series.type === "movie" ? "movie" : "series"}"
        aria-label="${escapeHtml(`Open ${title} in Library`)}">${escapeHtml(title)}</button></h2>
      ${genres.length ? `<ul class="watch-info-genres" aria-label="Genres">${genres.map((genre) => `<li>${escapeHtml(genre)}</li>`).join("")}</ul>` : ""}
      <p class="watch-info-description">${description ? escapeHtml(description) : "Description is not available for this title yet."}</p>
      <dl class="watch-info-facts">${facts.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(String(value))}</dd></div>`).join("")}</dl>
      ${tracking}
    </div>`;
  const cardMarkup = (item) => {
    const thumb = metahubVariant(item.poster || "", "small") || item.poster || artworkFallback(item.name);
    const genresText = (item.genres || []).slice(0, 2).join(" - ") || (item.type === "movie" ? "Movie" : "Series");
    return `<li><button type="button" class="watch-discovery-card" data-watch-title-id="${escapeHtml(item.id)}"
      aria-label="${escapeHtml(`View ${item.name}`)}">
      <span class="watch-discovery-cover"><img src="${escapeHtml(thumb)}" alt="" loading="lazy" decoding="async" data-fallback="poster" data-fallback-title="${escapeHtml(item.name)}" /></span>
      <span class="watch-discovery-copy"><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(genresText)}</small></span>
      ${icon("chevron-right")}</button></li>`;
  };
  for (const [element, items, heading] of [[related, picks.related, "Related"], [recommended, picks.recommended, "Recommended"]]) {
    element.hidden = false;
    element.innerHTML = `<h3 class="watch-side-heading">${heading}</h3>`
      + (items.length ? `<ol class="watch-discovery-list">${items.map(cardMarkup).join("")}</ol>`
        : `<p class="watch-side-empty">${state.homeLoaded ? "No matching titles in the catalog yet." : "Loading catalog suggestions…"}</p>`);
  }
  refreshImages(info);
  refreshImages(rail);
  if (!state.homeLoaded) void loadHomeCatalog();
}

export function renderWatchChapters() {
  const root = $("#watch-chapters");
  const body = $("#watch-chapters-body");
  const layout = $("#watch-player-layout");
  if (!root || !body) return;
  const source = watchPendingSelection || state.currentSource;
  const entry = source?.libraryId ? libraryEntryById(source.libraryId) : null;
  const seriesKey = entry?.seriesKey || (entry ? librarySeriesKey(entry.title) : "");
  const series = seriesKey ? buildLibrarySeries().find((item) => item.key === seriesKey) : null;
  renderWatchInfo(series, entry);
  if (!series || series.type === "movie" || source?.fileIndex === undefined || source?.fileIndex === null) {
    root.hidden = true;
    if (body.childNodes.length) body.replaceChildren();
    watchChapterMarkupByNode.delete(body);
    const seasonsNode = $("#watch-seasons");
    if (seasonsNode) {
      seasonsNode.hidden = true;
      if (seasonsNode.childNodes.length) seasonsNode.replaceChildren();
      watchChapterMarkupByNode.delete(seasonsNode);
    }
    watchChapterActions = new Map();
    watchChaptersSourceKey = "";
    return;
  }
  root.hidden = false;
  const playingEpisode = entry.episodes?.find((item) => Number(item.fileIndex) === Number(source.fileIndex));
  const playingCode = String(playingEpisode?.code || source.episode?.code || "").toUpperCase();
  const sourceKey = `${seriesKey}:${source.libraryId}:${source.fileIndex}`;
  const sourceChanged = sourceKey !== watchChaptersSourceKey;
  if (sourceChanged) {
    watchChaptersSourceKey = sourceKey;
    watchEpisodeSourcesOpen = "";
    watchSelectedSeason = null;
  }
  const stored = new Map();
  [...series.seasons.entries()].forEach(([, refs]) => {
    groupLibraryChapters(refs).forEach((chapter) => {
      const code = String(chapter.code || "").toUpperCase();
      if (code) stored.set(code, chapter);
    });
  });
  const catalogId = watchCatalogIdFor(series) || entry.catalogId || "";
  const hasCatalog = /^tt\d{5,12}$/.test(catalogId) && series.type !== "movie";
  const cached = hasCatalog ? catalogChapterLists.get(catalogId)?.list : null;
  // Fetch even when the collapsible chapter panel is closed. A previously
  // collapsed panel used to show only saved episodes indefinitely.
  if (hasCatalog && !cached) catalogChapterList(catalogId, refreshWatchCatalogDetails);
  const collected = new Map();
  if (cached) {
    for (const season of cached.seasons || []) {
      collected.set(season.season, (season.episodes || []).map((episode) => ({
        ...episode, season: season.season, code: chapterCode(season.season, episode.episode),
        stored: stored.get(chapterCode(season.season, episode.episode)),
      })));
    }
  }
  for (const [season, refs] of series.seasons) {
    const existing = collected.get(season) || [];
    const listed = new Set(existing.map((chapter) => chapter.code));
    for (const group of groupLibraryChapters(refs)) {
      if (listed.has(String(group.code).toUpperCase())) continue;
      existing.push({ code: group.code, season, name: group.title || group.code, stored: group });
    }
    existing.sort((a, b) => (Number(String(a.code).match(/E(\d+)/)?.[1]) || 0)
      - (Number(String(b.code).match(/E(\d+)/)?.[1]) || 0));
    collected.set(season, existing);
  }
  const seasons = [...collected.entries()].sort((a, b) => a[0] - b[0]);
  const chapters = seasons.flatMap(([, rows]) => rows);
  const watchedCount = chapters.filter((chapter) => watchEpisodeStatus(series, chapter).watched).length;
  const catalogRecord = hasCatalog ? catalogChapterLists.get(catalogId) : null;
  const titleLookup = !hasCatalog ? watchCatalogMatches.get(`${series.type}:${series.key}`) : null;
  const loading = catalogRecord?.pending || titleLookup?.pending;
  const unavailable = (catalogRecord?.failedAt && !cached) || (titleLookup && !titleLookup.pending && !titleLookup.id);
  $("#watch-chapters-summary").textContent = `${chapters.length} episodes - ${watchedCount} watched${loading ? " - Loading full list…" : unavailable ? " - Catalog unavailable" : ""}`;
  const currentSeason = String(Number(playingCode.match(/^S(\d+)E/)?.[1] ?? seasons[0]?.[0] ?? 1));
  if (!seasons.some(([season]) => String(season) === String(watchSelectedSeason))) watchSelectedSeason = currentSeason;
  const chapterArt = catalogChapterLists.get(catalogId)?.meta || libraryArtCached(series) || {};
  const posterFallback = series.coverUrl || chapterArt.poster || seriesAniList(series)?.cover || "";
  const wideFallback = chapterArt.background || posterFallback;
  const seasonsNode = $("#watch-seasons");
  if (seasonsNode) {
    seasonsNode.hidden = seasons.length < 2;
    const seasonsMarkup = seasons.length < 2 ? "" : `<h3 class="watch-side-heading">Seasons</h3><div class="watch-season-tiles">${seasons.map(([season, episodes]) => {
      const still = episodes.find((item) => item.thumbnail)?.thumbnail || "";
      const image = still || wideFallback;
      const backup = still ? wideFallback : posterFallback;
      const picture = image
        ? `<img src="${escapeHtml(image)}" alt="" loading="lazy" decoding="async" data-fallback="wide" data-fallback-title="${escapeHtml(series.title)}"${backup && backup !== image ? ` data-fallback-src="${escapeHtml(backup)}"` : ""} />`
        : `<img src="${escapeHtml(artworkFallback(series.title, { ratio: "wide", label: `Season ${season}` }))}" alt="" />`;
      const finished = episodes.filter((item) => watchEpisodeStatus(series, item).watched).length;
      return `<button type="button" class="watch-season-tile${String(season) === String(watchSelectedSeason) ? " is-selected" : ""}"
        data-watch-season="${season}" aria-pressed="${String(season) === String(watchSelectedSeason)}">
        ${picture}<span>${season === 0 ? "Specials" : `Season ${season}`}</span><small>${finished}/${episodes.length}</small>
      </button>`;
    }).join("")}</div>`;
    if (setWatchChapterMarkup(seasonsNode, seasonsMarkup)) refreshImages(seasonsNode);
  }
  const scrollTop = body.scrollTop;
  const focusedEpisode = body.contains(document.activeElement) ? document.activeElement.closest?.(".watch-episode[data-watch-episode-code]") : null;
  const previouslyFocused = focusedEpisode?.dataset.watchEpisodeCode || "";
  const focusedControl = document.activeElement?.hasAttribute?.("data-watch-episode-sources") ? "sources"
    : document.activeElement?.hasAttribute?.("data-watch-episode") ? "play" : "card";
  watchChapterActions = new Map();
  const episodesMarkup = (unavailable ? `<div class="watch-chapter-notice"><span>Full episode information couldn't load; your saved episodes remain available.</span><button type="button" class="ui-btn ui-btn--secondary ui-btn--sm" data-watch-retry-chapters>Retry</button></div>` : "") + seasons.filter(([season]) => String(season) === String(watchSelectedSeason)).map(([, rows]) => {
    return `<ol class="watch-episode-list">${rows.map((chapter) => {
        const code = String(chapter.code || "").toUpperCase();
        const status = watchEpisodeStatus(series, chapter);
        const current = playingCode === code;
        const upcoming = Boolean(chapter.id && chapterUpcoming(chapter));
        const label = status.watched ? "Watched" : status.percent > 0 ? `${status.percent}% watched` : status.saved ? "Not started" : "No source saved";
        const name = chapter.name && chapter.name !== code ? String(chapter.name) : `Episode ${Number(code.match(/E(\d+)/)?.[1] || 0)}`;
        const sourceRefs = chapter.stored?.sources?.slice().sort(compareLibrarySourceRefsByPeers) || [];
        const best = sourceRefs[0] || null;
        const sourcesOpen = watchEpisodeSourcesOpen === code;
        const lookup = chapter.id ? watchEpisodeSourceLookups.get(chapter.id) : null;
        const candidates = [
          ...sourceRefs.map((ref) => ({ kind: "saved", ref, peers: Number(normalizeLibrarySourceMeta(ref.entry?.sourceMeta).peers) || 0 })),
          ...(lookup?.status === "ready" ? lookup.rows.map((stream) => ({ kind: "remote", stream, peers: Number(stream.peers) || 0 }))
            .filter((item) => !sourceRefs.some((ref) => String(ref.entry?.id || "").toLowerCase() === String(item.stream.infoHash || "").toLowerCase())) : []),
        ].sort((a, b) => b.peers - a.peers).slice(0, 3);
        const thumbnail = chapter.thumbnail || wideFallback;
        const backup = chapter.thumbnail ? wideFallback : posterFallback;
        const picture = thumbnail
          ? `<img src="${escapeHtml(thumbnail)}" alt="" loading="lazy" decoding="async" data-fallback="wide" data-fallback-title="${escapeHtml(series.title)}"${backup && backup !== thumbnail ? ` data-fallback-src="${escapeHtml(backup)}"` : ""} />`
          : `<img src="${escapeHtml(artworkFallback(series.title, { ratio: "wide", label: code }))}" alt="" />`;
        watchChapterActions.set(code, { best, candidates, sourceRefs, saved: chapter.stored || null, catalog: chapter.id ? chapter : null, entry, series, list: cached, current });
        return `<li class="watch-episode${current ? " is-current" : ""}${status.watched ? " is-watched" : ""}" tabindex="0"
          data-watch-episode-code="${escapeHtml(code)}" aria-label="${escapeHtml(`${code} ${name}, ${current ? "currently playing" : label}. Press Shift+F10 for actions`)}" aria-keyshortcuts="Shift+F10">
          <div class="watch-episode__shell">
          <button class="watch-episode__details" type="button" data-watch-episode-sources="${escapeHtml(code)}" aria-expanded="${sourcesOpen}" aria-controls="watch-episode-sources-${escapeHtml(code)}"
            aria-label="${escapeHtml(`Choose sources for ${code} ${name}`)}">
            <span class="lib-chapter-thumb watch-episode__thumb">${picture}${status.percent > 0 && !status.watched ? `<span class="lib-chapter-progress" aria-hidden="true"><span style="width:${status.percent}%"></span></span>` : ""}${status.watched ? `<span class="lib-chapter-watched" aria-hidden="true">${icon("check")}</span>` : ""}</span>
            <span class="watch-episode__copy"><span class="watch-episode__code">${escapeHtml(code)}</span><strong>${escapeHtml(name)}</strong><small>${escapeHtml(current ? "Playing now" : upcoming ? "Upcoming" : label)}</small>
              ${status.percent > 0 ? `<span class="watch-episode__progress"><span style="width:${status.percent}%"></span></span>` : ""}
            </span>
          </button>
          <button type="button" class="watch-episode__play" data-watch-episode="${escapeHtml(code)}" ${upcoming || (!current && !best && !chapter.id) ? 'disabled' : ""}
            aria-label="${escapeHtml(current ? `Return to playing episode ${code} ${name}` : `Play ${code} ${name}`)}" title="${current ? "Return to playing episode" : upcoming ? "Not released yet" : "Play episode"}">${icon("play")}</button>
          </div>
          <div class="watch-episode__sources" id="watch-episode-sources-${escapeHtml(code)}"${sourcesOpen ? "" : " hidden"}>
            <div class="watch-episode__sources-head"><strong>Episode sources</strong></div>
            ${candidates.map((item, index) => {
              const info = item.kind === "saved" ? librarySourceDetails(item.ref.entry, item.ref.episode) : item.stream;
              const release = item.kind === "saved" ? info.releaseName : String(info.title || "Episode source").split("\n")[0];
              const quality = info.quality && info.quality !== "UNKNOWN" ? info.quality : "";
              return `<button type="button" class="watch-episode__source" data-watch-episode-source-index="${index}" data-watch-episode-source-code="${escapeHtml(code)}"><span><strong title="${escapeHtml(release)}">${escapeHtml(release)}</strong><small>${escapeHtml([quality, item.peers ? `${item.peers} peers` : "Peers unavailable", item.kind === "saved" ? "Saved" : "Online"].filter(Boolean).join(" - "))}</small></span><span>Play</span></button>`;
            }).join("")}
            ${lookup?.status === "loading" ? '<p role="status">Finding episode sources…</p>' : ""}
            ${lookup?.status === "error" ? `<p role="alert">${escapeHtml(lookup.error || "Source search failed")} <button type="button" class="ui-btn ui-btn--ghost ui-btn--sm" data-watch-episode-sources-retry="${escapeHtml(code)}">Retry</button></p>` : ""}
            ${!candidates.length && lookup?.status !== "loading" && lookup?.status !== "error" ? '<p>No episode sources available yet.</p>' : ""}
          </div>
        </li>`;
      }).join("")}</ol>`;
  }).join("") || '<p class="watch-episode-empty">No chapters have been identified for this title yet.</p>';
  if (!setWatchChapterMarkup(body, episodesMarkup)) return;
  body.scrollTop = scrollTop;
  if (previouslyFocused) {
    const item = [...body.querySelectorAll(".watch-episode[data-watch-episode-code]")].find((node) => node.dataset.watchEpisodeCode === previouslyFocused);
    (focusedControl === "card" ? item : item?.querySelector(focusedControl === "sources" ? "[data-watch-episode-sources]" : "[data-watch-episode]"))?.focus({ preventScroll: true });
  }
  refreshImages(body);
}

export function wireWatchSidePanel() {
  $("#watch-title-info")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-watch-title-details]");
    if (!button) return;
    const entry = state.currentSource?.libraryId ? libraryEntryById(state.currentSource.libraryId) : null;
    const key = button.dataset.watchSeriesKey || entry?.seriesKey || (entry ? librarySeriesKey(entry.title) : "");
    const catalogId = button.dataset.watchCatalogId || "";
    if (key || catalogId) void navigateWatchToLibrary(() => {
      if (key && buildLibrarySeries().some((series) => series.key === key)) openLibrarySeries(key);
      else if (catalogId) openTitlePage({ id: catalogId, type: button.dataset.watchCatalogType || "series" });
    });
  });
  $("#watch-title-info")?.addEventListener("change", (event) => {
    const select = event.target.closest("[data-watch-tracking-status]");
    if (!select) return;
    const entry = state.currentSource?.libraryId ? libraryEntryById(state.currentSource.libraryId) : null;
    if (!entry) return;
    setWatchTrackingStatus(entry.seriesKey || librarySeriesKey(entry.title), select.value);
  });
  $("#watch-side-rail")?.addEventListener("click", (event) => {
    const seasonButton = event.target.closest("[data-watch-season]");
    if (seasonButton) {
      watchSelectedSeason = String(seasonButton.dataset.watchSeason);
      $("#watch-chapters-body").scrollTop = 0;
      renderWatchChapters();
      return;
    }
    const item = event.target.closest("[data-watch-title-id]");
    if (!item) return;
    const meta = homeTitleIndex.get(item.dataset.watchTitleId);
    if (meta) openHomeTitle(meta);
  });
}
// Episodes scroll independently from the Watch page even when the pointer is
// over a card, play icon or the heading. Never trap wheel input when the list
// fits or has reached its edge. Native touch and focused keyboard scrolling
// continue to use the same overflow-y:auto element.
export function scrollWatchEpisodesOnWheel(event, body) {
  if (!body || !Number.isFinite(event.deltaY) || event.deltaY === 0) return;
  const limit = Math.max(0, body.scrollHeight - body.clientHeight);
  if (limit <= 1) return;
  const pixels = event.deltaY * (event.deltaMode === 1 ? 18 : event.deltaMode === 2 ? body.clientHeight : 1);
  const target = Math.max(0, Math.min(limit, body.scrollTop + pixels));
  if (Math.abs(target - body.scrollTop) < .01) return;
  event.preventDefault();
  body.scrollTop = target;
}

let watchEpisodeContextCode = "";
let titleEpisodeContextCode = "";
let episodeContextSurface = "watch";
function watchEpisodeContextMenu() {
  let menu = $("#watch-episode-context-menu");
  if (menu) return menu;
  menu = document.createElement("div");
  menu.id = "watch-episode-context-menu";
  menu.className = "ui-menu watch-episode-context-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Episode actions");
  menu.hidden = true;
  menu.innerHTML = '<button type="button" class="ui-menu__item" role="menuitem" data-watch-mark-watched>Mark as watched</button>'
    + '<button type="button" class="ui-menu__item" role="menuitem" data-watch-retry-anilist title="Retry updating AniList after marking this episode as not watched" hidden>Retry AniList update</button>';
  document.body.append(menu);
  wirePopupMenu(menu);
  menu.addEventListener("click", (event) => {
    if (event.target.closest("[data-watch-retry-anilist]")) {
      const surface = episodeContextSurface;
      const code = surface === "title" ? titleEpisodeContextCode : watchEpisodeContextCode;
      const series = surface === "title" ? titleSubject().series : watchChapterActions.get(code)?.series;
      const accountId = readAniListAccount(localStorage)?.userId;
      closePopupMenu();
      if (series && accountId) void flushAniListUnwatches({ interactive: true,
        only: { accountId, seriesKey: series.key, code } });
      return;
    }
    if (!event.target.closest("[data-watch-mark-watched]")) return;
    const surface = episodeContextSurface;
    const code = surface === "title" ? titleEpisodeContextCode : watchEpisodeContextCode;
    const action = surface === "watch" ? watchChapterActions.get(code) : null;
    closePopupMenu();
    if (surface === "title") { markTitleChapterWatched(code); return; }
    const result = action && toggleEpisodeWatched(action.series, code, action.saved);
    if (!result) return;
    renderWatchChapters();
    $("#watch-chapters-body")?.querySelectorAll(".watch-episode[data-watch-episode-code]").forEach((item) => {
      if (item.dataset.watchEpisodeCode === code) item.focus({ preventScroll: true });
    });
    toast(result === "unwatched" ? "Episode marked as not watched" : "Episode marked as watched");
  });
  return menu;
}
function setEpisodeContextActions(menu, series, code, watched) {
  menu.querySelector("[data-watch-mark-watched]").textContent = watched
    ? "Mark as not watched" : "Mark as watched";
  const retry = menu.querySelector("[data-watch-retry-anilist]");
  const accountId = readAniListAccount(localStorage)?.userId;
  retry.hidden = !accountId || !pendingAniListUnwatches().some((row) =>
    row.accountId === accountId && row.seriesKey === series.key && row.code === code);
}
export function openWatchEpisodeContextMenu(event, item, { keyboard = false } = {}) {
  const code = item?.dataset.watchEpisodeCode;
  if (!code || !watchChapterActions.has(code)) return;
  event.preventDefault();
  watchEpisodeContextCode = code;
  episodeContextSurface = "watch";
  const menu = watchEpisodeContextMenu();
  const action = watchChapterActions.get(code);
  setEpisodeContextActions(menu, action.series, code,
    watchEpisodeStatus(action.series, { code, stored: action.saved }).watched);
  openPopupMenu(menu, {
    anchor: item,
    x: keyboard ? null : event.clientX,
    y: keyboard ? null : event.clientY,
  });
}
export function openTitleEpisodeContextMenu(event, item, { keyboard = false } = {}) {
  const series = titleSubject().series;
  if (!series || series.type !== "series" || !item) return;
  const code = item.dataset.chapterCode || (item.matches(".catalog-chapter")
    ? chapterCode(Number(item.dataset.season), Number(item.dataset.episode)) : "");
  if (!/^S\d{2}E\d{2,4}$/.test(String(code || ""))) return;
  event.preventDefault();
  titleEpisodeContextCode = code;
  episodeContextSurface = "title";
  const menu = watchEpisodeContextMenu();
  const chapter = libraryOrderedChapters(series).find((item) => item.code === code);
  setEpisodeContextActions(menu, series, code,
    watchEpisodeStatus(series, { code, stored: chapter ? { sources: chapter.sources } : null }).watched);
  openPopupMenu(menu, {
    anchor: item,
    x: keyboard ? null : event.clientX,
    y: keyboard ? null : event.clientY,
  });
}

export function wireWatchChapters() {
  $("#watch-chapters-body")?.addEventListener("keydown", (event) => {
    if (!(event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey))) return;
    const item = event.target.closest(".watch-episode[data-watch-episode-code]");
    if (item) openWatchEpisodeContextMenu(event, item, { keyboard: true });
  });
  $("#watch-chapters-body")?.addEventListener("click", (event) => {
    if (event.target.closest("[data-watch-retry-chapters]")) {
      const source = state.currentSource;
      const entry = source?.libraryId ? libraryEntryById(source.libraryId) : null;
      const series = buildLibrarySeries().find((item) => item.key === (entry?.seriesKey || librarySeriesKey(entry?.title)));
      const catalogId = series ? watchCatalogIdFor(series) : entry?.catalogId;
      if (catalogId && !catalogChapterLists.get(catalogId)?.pending) {
        catalogChapterLists.delete(catalogId);
        catalogChapterList(catalogId, refreshWatchCatalogDetails);
        renderWatchChapters();
      } else if (series) {
        watchCatalogMatches.delete(`${series.type}:${series.key}`);
        renderWatchChapters();
      }
      return;
    }
    const sourceButton = event.target.closest("[data-watch-episode-source-index]");
    if (sourceButton) {
      const action = watchChapterActions.get(sourceButton.dataset.watchEpisodeSourceCode);
      const chosen = action?.candidates?.[Number(sourceButton.dataset.watchEpisodeSourceIndex)];
      if (!chosen) return;
      watchEpisodeSourcesOpen = "";
      if (chosen.kind === "saved") {
        const source = chosen.ref;
        const resume = chapterWatchStatus(action.catalog?.stored?.sources || [source]).resume;
        const resumeAtSeconds = resume ? Math.max(0, (resume.positionMs - 5000) / 1000) : 0;
        void playLibraryEpisode(source.entry.id, Number(source.episode.fileIndex), { resumeAtSeconds });
      } else if (action.catalog && action.list) {
        const view = {
          meta: { id: watchCatalogIdFor(action.series) || action.entry.catalogId, type: "series",
            name: action.entry.displayTitle || action.entry.title, poster: action.entry.coverUrl || "", aliases: action.entry.aliases || [] },
          seasons: action.list.seasons,
        };
        void addCatalogChapterSource(view, action.catalog, chosen.stream, { play: true, quiet: true })
          .catch((error) => toast(error.message || "Could not play this episode source", { tone: "error" }));
      }
      renderWatchChapters();
      return;
    }
    const retry = event.target.closest("[data-watch-episode-sources-retry]");
    if (retry) {
      const action = watchChapterActions.get(retry.dataset.watchEpisodeSourcesRetry);
      if (action) void findWatchEpisodeSources(action, { force: true });
      return;
    }
    const selector = event.target.closest("[data-watch-episode-sources]");
    if (selector) {
      const code = selector.dataset.watchEpisodeSources;
      watchEpisodeSourcesOpen = watchEpisodeSourcesOpen === code ? "" : code;
      renderWatchChapters();
      if (watchEpisodeSourcesOpen) {
        const action = watchChapterActions.get(code);
        if (action) void findWatchEpisodeSources(action);
      }
      return;
    }
    const button = event.target.closest("[data-watch-episode]");
    if (!button || button.disabled || button.getAttribute("aria-disabled") === "true") return;
    const action = watchChapterActions.get(button.dataset.watchEpisode);
    if (!action) return;
    if (action.current) {
      switchView("watch");
      const code = action.catalog?.code || action.best?.episode?.code || button.dataset.watchEpisode;
      const series = action.series;
      const selectedEpisode = currentLibraryEpisode()?.episode;
      if (explicitlyUnwatchedChapter(series, code) && selectedEpisode?.progress?.positionMs === 0) {
        seekPlayerTo(0);
      }
      if (video.paused) resumePlayback();
      return;
    }
    if (action.best) {
      const code = action.catalog?.code || action.best.episode.code;
      const resume = chapterWatchStatus(action.catalog?.stored?.sources || [action.best]).resume;
      const resumeAtSeconds = chapterResumeMs(resume, action.series, code) / 1000;
      void playLibraryEpisode(action.best.entry.id, Number(action.best.episode.fileIndex), { resumeAtSeconds });
    } else if (action.catalog && action.list) {
      void playCatalogNeighbor({ entry: action.entry, list: action.list }, action.catalog);
    }
  });
}

export function setWatchTheaterMode(enabled) {
  const theater = Boolean(enabled);
  const layout = $("#watch-player-layout");
  const button = $("#player-theater");
  layout?.classList.toggle("is-theater", theater);
  if (button) {
    button.classList.toggle("is-active", theater);
    button.setAttribute("aria-pressed", String(theater));
    const label = theater ? "Exit theater mode" : "Theater mode";
    button.setAttribute("aria-label", label);
    button.dataset.tooltip = label;
  }
}
