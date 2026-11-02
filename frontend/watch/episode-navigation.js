// Next and previous episodes, and autoplay next.
import { artworkFallback, toast } from "../ui/ui.js";
import { chapterCode, chapterPlayOrder, groupChapterSources } from "../../shared/media/series-sources.js";
import { autoNextInline, autoNextToggle, state } from "../../app.js";
import { $ } from "../app/dom.js";
import { fetchJson } from "../app/http.js";
import { viewActive } from "../app/navigation.js";
import { revealPlayerControls } from "../player/player-core.js";
import { playbackLoadRequestId, playLibraryEpisode } from "../player/torrent-playback.js";
import {
  renderWatchChapters, updateChapterButtons, watchEpisodeSourceLookups, watchEpisodeSourcesOpen,
} from "./watch-page.js";
import { currentChapterNavigation, libraryEntryById, librarySeriesKey } from "../library/library-data.js";
import {
  addCatalogChapterSource, catalogChapterTarget, chapterUpcoming, invalidateManualCatalogPlayback,
  manualCatalogPlaybackId, savedCatalogChapters,
} from "../title/title-chapters.js";
import { homeTitleIndex } from "../home/home-page.js";
import { compareStreamsByPeers } from "../catalog/catalog-search.js";

export async function findWatchEpisodeSources(action, { force = false } = {}) {
  const chapter = action?.catalog;
  if (!chapter?.id || !action.list) return;
  const existing = watchEpisodeSourceLookups.get(chapter.id);
  if (!force && (existing?.status === "ready" || existing?.status === "loading")) return;
  const lookup = { status: "loading", rows: [] };
  watchEpisodeSourceLookups.set(chapter.id, lookup);
  renderWatchChapters();
  try {
    const view = { seasons: action.list.seasons };
    const data = await fetchJson(`/api/streams?type=series&id=${encodeURIComponent(chapter.id)}`);
    const groups = groupChapterSources(data.streams || [], catalogChapterTarget(view, chapter));
    lookup.rows = [...groups.episodeFiles, ...groups.others]
      .filter((stream) => stream.magnet)
      .sort(compareStreamsByPeers);
    lookup.status = "ready";
  } catch (error) {
    lookup.status = "error";
    lookup.error = error.message || "Source lookup failed";
  }
  if (watchEpisodeSourceLookups.get(chapter.id) === lookup && watchEpisodeSourcesOpen === chapter.code) renderWatchChapters();
}

export let autoNextInterval = null;
let autoNextRemaining = 0;
let autoNextSource = "";
let autoNextDismissedSource = "";
let autoNextPrefetchKey = "";
export let autoNextEnabled = localStorage.getItem("lvl-autoplay-next") !== "0";
const AUTO_NEXT_SECONDS = 8;

function autoNextSourceId() {
  const source = state.currentSource;
  return source?.libraryId && source.fileIndex !== null && source.fileIndex !== undefined
    ? `${source.libraryId}:${source.fileIndex}` : "";
}

export function clearAutoNext({ resetDismissal = false } = {}) {
  if (autoNextInterval !== null) window.clearInterval(autoNextInterval);
  autoNextInterval = null;
  autoNextSource = "";
  $("#player-up-next").hidden = true;
  if (resetDismissal) autoNextDismissedSource = "";
}

export function cancelAutoNext() {
  autoNextDismissedSource = autoNextSource || autoNextSourceId();
  clearAutoNext();
}

export function invalidateAutoNextAfterEpisodeEdit(series, code) {
  const source = state.currentSource;
  if (!source?.libraryId || source.fileIndex == null) return;
  const entry = libraryEntryById(source.libraryId);
  if (!entry || (entry.seriesKey || librarySeriesKey(entry.title)) !== series?.key) return;
  const selected = entry.episodes?.find((episode) => Number(episode.fileIndex) === Number(source.fileIndex));
  if (String(selected?.code || "").toUpperCase() !== String(code || "").toUpperCase()) return;
  // A watched-state edit is a new user intent, even if it does not replace
  // the media URL. Stop both an armed timer and an already-in-flight lookup.
  cancelAutoNext();
  invalidateManualCatalogPlayback();
}

export function playAutoNextNow() {
  if (!autoNextSource || autoNextSourceId() !== autoNextSource) return clearAutoNext();
  clearAutoNext();
  void playAdjacentChapter(1);
}

export function startAutoNext() {
  if (!autoNextEnabled) return;
  const key = autoNextSourceId();
  if (!key || key === autoNextDismissedSource || autoNextInterval !== null || !viewActive("watch")) return;
  const catalog = currentCatalogNeighbors();
  const nextNav = currentChapterNavigation().next;
  const next = catalog?.next || nextNav?.episode;
  if (!next || adjacentChapterBusy) return;
  autoNextSource = key;
  autoNextRemaining = AUTO_NEXT_SECONDS;
  const label = next.code || (Number.isInteger(next.season) && Number.isInteger(next.episode)
    ? chapterCode(next.season, next.episode) : next.episodeTitle || "Next episode");
  const title = String(next.name || next.episodeTitle || next.title || "").trim();
  $("#player-up-next-title").textContent = title ? `${label} · ${title}` : label;
  const preview = $("#player-up-next-image");
  if (preview) {
    const fallbackTitle = state.currentSource?.title || "Next episode";
    const fallback = artworkFallback(fallbackTitle, { ratio: "wide", label });
    const thumbnail = String(next.thumbnail || next.image || nextNav?.episode?.thumbnail || "").trim();
    preview.onerror = () => {
      preview.onerror = null;
      preview.src = fallback;
    };
    preview.src = thumbnail || fallback;
  }
  const update = () => { $("#player-up-next-countdown").textContent = `Playing in ${autoNextRemaining} second${autoNextRemaining === 1 ? "" : "s"}`; };
  update();
  $("#player-up-next").hidden = false;
  revealPlayerControls();
  autoNextInterval = window.setInterval(() => {
    if (autoNextSourceId() !== key || !viewActive("watch")) return clearAutoNext();
    autoNextRemaining -= 1;
    if (autoNextRemaining <= 0) return playAutoNextNow();
    update();
  }, 1000);
}

export function prefetchUpcomingChapter() {
  if (!autoNextEnabled || !autoNextSourceId() || !state.mediaDurationMs) return;
  const remaining = state.mediaDurationMs - state.currentMs;
  if (remaining > 60_000 || remaining < 0) return;
  const catalog = currentCatalogNeighbors();
  const chapter = catalog?.next;
  if (!chapter?.id) return;
  const key = `${autoNextSourceId()}|${chapter.id}`;
  if (autoNextPrefetchKey === key) return;
  autoNextPrefetchKey = key;
  // Warm the server's short-lived source cache without starting a second
  // player or torrent. The actual episode begins only after the countdown.
  void fetch(`/api/streams?type=series&id=${encodeURIComponent(chapter.id)}`).catch(() => {});
}

// Chapters are saved one at a time, so previous/next follow the catalog's chapter order when the
// series is known: a saved neighbor plays right away, an unsaved one gets a source first (same
// order as Play in series details). Without catalog data they follow the Library's saved chapters.
export const catalogChapterLists = new Map();
let adjacentChapterBusy = false;

function catalogChapterListFrom(meta) {
  // Specials (S00) belong in the Watch episode rail, but never precede the
  // main series in automatic next/previous episode playback.
  const seasons = (meta?.seasons || []).filter((season) =>
    Number.isInteger(season?.season) && season.season >= 0
    && Array.isArray(season.episodes) && season.episodes.length);
  const chapters = seasons.filter((season) => season.season > 0)
    .flatMap((season) => season.episodes.map((episode) => ({ ...episode, season: season.season })));
  return { seasons, chapters };
}

// Catalog art and details (backdrop, logo, synopsis, year) for Library titles with a catalog id:
// Home's catalog first, then one metadata request per title. Series share the request that
// brings their chapter list (catalogChapterList).
export const movieArtRecords = new Map();

export function libraryArtCached(series) {
  const id = series?.catalogId;
  if (!id) return null;
  return homeTitleIndex.get(id) || catalogChapterLists.get(id)?.meta || movieArtRecords.get(id)?.meta || null;
}

export function libraryArtFor(series, onReady = null, { full = false } = {}) {
  const id = String(series?.catalogId || "");
  if (!/^tt\d{5,12}$/.test(id)) return null;
  const cached = libraryArtCached(series);
  if (!full && (cached?.background || cached?.description)) return cached;
  if (series.type !== "movie") {
    const record = catalogChapterLists.get(id);
    if (record?.meta) return record.meta;
    if (record?.list && !record.meta) return cached;
    catalogChapterList(id, onReady);
    return cached;
  }
  const record = movieArtRecords.get(id);
  if (record?.meta) return record.meta;
  if (record?.pending) {
    if (onReady && !record.listeners.includes(onReady)) record.listeners.push(onReady);
    return cached;
  }
  if (record?.failedAt && Date.now() - record.failedAt < 60_000) return cached;
  const next = { meta: null, pending: true, failedAt: 0, listeners: onReady ? [onReady] : [] };
  movieArtRecords.set(id, next);
  fetchJson(`/api/catalog/meta?type=movie&id=${encodeURIComponent(id)}`)
    .then((data) => { next.meta = data.meta || null; })
    .catch(() => { next.failedAt = Date.now(); })
    .finally(() => {
      next.pending = false;
      const listeners = next.listeners;
      next.listeners = [];
      if (next.meta) listeners.forEach((listener) => { try { listener(next.meta); } catch {} });
    });
  return cached;
}

export function catalogChapterList(catalogId, onReady = null) {
  const record = catalogChapterLists.get(catalogId);
  if (record?.list) return record.list;
  if (record?.pending) {
    if (onReady && !(record.listeners || []).includes(onReady)) record.listeners = [...(record.listeners || []), onReady];
    return null;
  }
  if (record?.failedAt && Date.now() - record.failedAt < 60_000) return null;
  const next = { list: null, pending: true, failedAt: 0, listeners: onReady ? [onReady] : [] };
  catalogChapterLists.set(catalogId, next);
  fetchJson(`/api/catalog/meta?type=series&id=${encodeURIComponent(catalogId)}`)
    .then((data) => {
      next.meta = data.meta || null;
      const list = catalogChapterListFrom(next.meta);
      if (!list.seasons.length) {
        next.failedAt = Date.now();
        next.error = "No episodes were included in the catalog response";
      } else next.list = list;
    })
    .catch((error) => { next.failedAt = Date.now(); next.error = error.message || ""; })
    .finally(() => {
      next.pending = false;
      updateChapterButtons();
      const listeners = next.listeners || [];
      next.listeners = [];
      listeners.forEach((listener) => { try { listener(next.list); } catch {} });
    });
  return null;
}

export function currentCatalogNeighbors() {
  const source = state.currentSource;
  if (!source?.libraryId || source.fileIndex === null || source.fileIndex === undefined) return null;
  const entry = libraryEntryById(source.libraryId);
  if (!/^tt\d{5,12}$/.test(String(entry?.catalogId || "")) || entry.catalogType === "movie") return null;
  const episode = entry.episodes?.find((item) => Number(item.fileIndex) === Number(source.fileIndex));
  const match = String(episode?.code || "").match(/^S(\d{2})E(\d{2,4})$/i);
  if (!match) return null;
  const list = catalogChapterList(entry.catalogId);
  if (!list) return null;
  const index = list.chapters.findIndex((chapter) => chapter.season === Number(match[1]) && chapter.episode === Number(match[2]));
  if (index < 0) return null;
  const pick = (offset) => {
    const chapter = list.chapters[index + offset];
    return chapter && !chapterUpcoming(chapter) ? chapter : null;
  };
  return { entry, list, previous: pick(-1), next: pick(1) };
}

export async function playCatalogNeighbor({ entry, list }, chapter) {
  // An unsaved Up Next chapter can spend time looking up providers. A newer
  // selection or leaving Watch must win even if that lookup resolves later.
  let expectedLoadId = playbackLoadRequestId;
  const expectedManualSelection = manualCatalogPlaybackId;
  const stillCurrent = () => viewActive("watch") && playbackLoadRequestId === expectedLoadId
    && manualCatalogPlaybackId === expectedManualSelection;
  const code = chapterCode(chapter.season, chapter.episode);
  const view = {
    meta: { id: entry.catalogId, type: "series", name: entry.displayTitle || entry.title, poster: entry.coverUrl || "", aliases: entry.aliases || [] },
    seasons: list.seasons,
  };
  const saved = savedCatalogChapters(view.meta).get(code);
  if (saved) {
    if (!stillCurrent()) return;
    await playLibraryEpisode(saved.entry.id, Number(saved.episode.fileIndex));
    return;
  }
  $("#media-status").textContent = `Finding a source for ${code}…`;
  toast(`Finding a source for ${code}…`);
  try {
    const data = await fetchJson(`/api/streams?type=series&id=${encodeURIComponent(chapter.id)}`);
    if (!stillCurrent()) return;
    const candidates = chapterPlayOrder(groupChapterSources(data.streams || [], catalogChapterTarget(view, chapter)));
    if (!candidates.length) throw new Error(`No playable source was found for ${code}.`);
    let lastError = null;
    for (const stream of candidates) {
      if (!stillCurrent()) return;
      try {
        await addCatalogChapterSource(view, chapter, stream, {
          play: true, quiet: true, stillCurrent,
          onPlaybackStart: (loadId) => { expectedLoadId = loadId; },
        });
        return;
      } catch (error) {
        if (error?.name === "AbortError") return; // Another selection owns playback now.
        lastError = error;
      }
    }
    throw lastError || new Error(`No source for ${code} passed torrent validation.`);
  } catch (error) {
    if (!stillCurrent()) return;
    $("#media-status").textContent = `Couldn't play ${code}`;
    toast(error.message || `Couldn't play ${code}`, { tone: "error" });
  }
}

export async function playAdjacentChapter(direction) {
  clearAutoNext();
  if (adjacentChapterBusy) return;
  adjacentChapterBusy = true;
  try {
    const catalog = currentCatalogNeighbors();
    const chapter = catalog ? (direction < 0 ? catalog.previous : catalog.next) : null;
    if (chapter) {
      await playCatalogNeighbor(catalog, chapter);
      return;
    }
    const nav = currentChapterNavigation();
    const target = direction < 0 ? nav.previous : nav.next;
    if (target) await playLibraryEpisode(target.entry.id, Number(target.episode.fileIndex));
  } finally {
    adjacentChapterBusy = false;
  }
}

export function setAutoplayNextEnabled(enabled) {
  autoNextEnabled = Boolean(enabled);
  localStorage.setItem("lvl-autoplay-next", autoNextEnabled ? "1" : "0");
  if (autoNextToggle) autoNextToggle.checked = autoNextEnabled;
  if (autoNextInline) autoNextInline.setAttribute("aria-pressed", String(autoNextEnabled));
  if (!autoNextEnabled) cancelAutoNext();
}
