// The title page.
import {
  artworkFallback, buttonMarkup, confirmDialog, emptyMarkup, escapeHtml, icon, iconButtonMarkup,
  metaMarkup, refreshImages, skeletonHeroMarkup, toast,
} from "../ui/ui.js";
import {
  boundedPosterUrl, formatRuntime, largeAniListCover, metahubVariant, posterSrcset,
  preferredPosterArt,
} from "../catalog/home-feed.js";
import { chapterCode, heightFromQualityLabel, meetsSourceFloor } from "../../shared/media/series-sources.js";
import { seriesAniList } from "../anilist/anilist-library.js";
import {
  ANILIST_MANUAL_ID_VERIFY, parseManualAniListId, planVerifiedManualAniListSeason,
} from "../anilist/anilist-manual-season-link.js";
import { anilistGraphql, readAniListAccount } from "../anilist/anilist-auto-client.js";
import {
  eligibleForPublicAnimeRating, fetchMatchedPublicAniListSeasons, fetchPublicAniListTitle,
  fetchPublicAnimeRelatedMovies, publicCatalogSeasonCounts, verifiedPublicAnimeFranchiseRoot,
} from "../catalog/title-public-ratings.js";
import { t } from "../ui/ui-i18n.js";
import {
  CHAPTER_PAGE, clientFeatures, DEFAULT_DOCUMENT_TITLE, libraryDialogView, recsUi, TITLE_STATUS,
  titleSeedMeta, titleView, VIEW_ROUTES, viewScroll,
} from "../../app.js";
import { $, $$, setToolStatus } from "../app/dom.js";
import { fetchJson } from "../app/http.js";
import { lastViewKey, switchView, viewActive } from "../app/navigation.js";
import { importCatalogStream, openMagnetDialog, playLibraryEpisode } from "../player/torrent-playback.js";
import { markTitleChapterWatched } from "../watch/watched-status.js";
import {
  catalogChapterList, catalogChapterLists, libraryArtCached, movieArtRecords,
} from "../watch/episode-navigation.js";
import {
  addCatalogPlaceholder, buildLibrarySeries, groupLibraryChapters, librarySeriesChapterCount,
  librarySeriesKey, resolveCatalogMetaForLibrarySeries, updateLibrarySeriesEntries,
} from "../library/library-data.js";
import {
  libraryChapterName, libraryDialogChapterMarkup, libraryDialogChaptersMarkup, libraryDialogThumbs,
  openLibraryContextMenu, resumeLibrarySeries, seriesNextUp,
} from "../library/library-page.js";
import {
  catalogStreamRowMarkup, chapterUpcoming, handleCatalogChapterClick, playCatalogChapter,
  renderTitleChapters,
} from "./title-chapters.js";
import { homeTitleIndex, markHomeTitleInLibrary } from "../home/home-page.js";
import { resolveAnimeBrowserCatalog } from "../home/anime-browser.js";
import { addBestCatalogMovie, compareStreamsByPeers, setButtonText } from "../catalog/catalog-search.js";
import { authenticatedTitleAniList } from "../anilist/anilist-sync.js";
import { showLibraryVocabulary } from "../learning/vocabulary-cards.js";

let titleMovieView = null;
let titleRenderQueued = false;

export function titleRoute() {
  const params = new URLSearchParams(window.location.search);
  const id = String(params.get("id") || "");
  // A title a feature owns (a manga with no anime): /title?f=comics&item=anilist-30013.
  const feature = String(params.get("f") || "");
  const item = String(params.get("item") || "");
  const owned = /^[a-z][a-z0-9-]{1,31}$/.test(feature) && /^[\w:.-]{1,120}$/.test(item);
  // A feature section to open first, e.g. /title?id=tt…&section=manga.
  const section = String(params.get("section") || "");
  return {
    id: !owned && /^tt\d{5,12}$/.test(id) ? id : "",
    type: params.get("type") === "movie" ? "movie" : "series",
    key: owned ? "" : String(params.get("key") || "").slice(0, 300),
    feature: owned ? feature : "",
    item: owned ? item : "",
    section: /^[a-z][a-z0-9-]{1,31}$/.test(section) ? section : "",
  };
}

function titleUrl({ id = "", type = "series", key = "", feature = "", item = "", section = "" } = {}) {
  const params = new URLSearchParams();
  if (feature && item) {
    params.set("f", feature);
    params.set("item", item);
  } else if (/^tt\d{5,12}$/.test(String(id || ""))) {
    params.set("id", id);
    params.set("type", type === "movie" ? "movie" : "series");
  }
  if (key && !feature) params.set("key", key);
  if (section) params.set("section", section);
  return `${VIEW_ROUTES.title}?${params}`;
}

export function openTitlePage({ id = "", type = "series", key = "", meta = null, feature = "", item = "", section = "" } = {}, { historyMode = "push" } = {}) {
  if (meta?.id) titleSeedMeta.set(meta.id, meta);
  const url = titleUrl({ id, type, key, feature, item, section });
  if (historyMode === "push") {
    if (`${window.location.pathname}${window.location.search}` !== url) {
      viewScroll.set(lastViewKey, window.scrollY);
      window.history.pushState({ view: "title" }, "", url);
      titleView.fromApp = true;
    }
  } else if (historyMode === "replace") window.history.replaceState({ view: "title" }, "", url);
  switchView("title", { historyMode: "none" });
  window.scrollTo({ top: 0, behavior: "instant" });
}

export function openLibrarySeries(seriesKey) {
  const series = buildLibrarySeries().find((item) => item.key === seriesKey);
  if (series) openTitlePage({ id: series.catalogId, type: series.type, key: series.key });
}

// Catalog ids and AniList ids of the video titles in the Library (features join
// their own entries to these, e.g. a manga to the anime it was adapted into).
export function libraryTitleIds() {
  const catalogIds = new Set();
  const anilistIds = new Set();
  const add = (value) => { const id = Number(value); if (Number.isSafeInteger(id) && id > 0) anilistIds.add(id); };
  for (const series of buildLibrarySeries()) {
    if (series.catalogId) catalogIds.add(series.catalogId);
    for (const entry of series.sources || []) {
      add(entry.anilistId);
      add(entry.anilist?.showId);
      for (const part of [...(entry.anilist?.seasons || []), ...(entry.anilist?.seasons || []).flatMap((season) => season?.parts || [])]) { add(part?.anilistId); add(part?.id); }
      for (const part of [...(entry.anilistManualLinks || []), ...(entry.anilistAutoLinks || [])]) add(part?.anilistId);
    }
  }
  return { catalogIds, anilistIds };
}

export function openHomeTitle(meta) {
  if (!meta) return;
  const existing = buildLibrarySeries().find((series) => (meta.id && series.catalogId === meta.id) || series.key === librarySeriesKey(meta.name));
  openTitlePage({ id: meta.id || existing?.catalogId || "", type: meta.type === "movie" ? "movie" : "series", key: existing?.key || "", meta });
}

// The Library title the page is about, if any: the one with this catalog id, then the saved key,
// then a title of the same name that has no catalog id yet.
export function titleSubject(route = titleRoute()) {
  const all = buildLibrarySeries();
  const seed = route.id ? titleSeedMeta.get(route.id) || homeTitleIndex.get(route.id) : null;
  const series = (route.id && all.find((item) => item.catalogId === route.id))
    || (route.key && all.find((item) => item.key === route.key && (!route.id || !item.catalogId || item.catalogId === route.id)))
    || (seed?.name && all.find((item) => !item.catalogId && item.key === librarySeriesKey(seed.name)))
    || null;
  return {
    id: route.id || series?.catalogId || "",
    type: series ? (series.type === "movie" ? "movie" : "series") : route.type,
    key: series?.key || "",
    series,
  };
}

// Full catalog details (chapters with ratings, people, trailers): one request per title, shared
// with the chapter list the player uses for previous/next and with the Library's artwork.
function titleMetaFor(type, id) {
  if (!id) return null;
  if (type === "movie") {
    const record = movieArtRecords.get(id);
    if (record?.meta) return record.meta;
    if (record?.pending) {
      if (!record.listeners.includes(refreshTitlePage)) record.listeners.push(refreshTitlePage);
      return null;
    }
    if (record?.failedAt && Date.now() - record.failedAt < 30_000) return null;
    const next = { meta: null, pending: true, failedAt: 0, error: "", listeners: [refreshTitlePage] };
    movieArtRecords.set(id, next);
    fetchJson(`/api/catalog/meta?type=movie&id=${encodeURIComponent(id)}`)
      .then((data) => { next.meta = data.meta || null; })
      .catch((error) => { next.failedAt = Date.now(); next.error = error.message || ""; })
      .finally(() => {
        next.pending = false;
        const listeners = next.listeners;
        next.listeners = [];
        listeners.forEach((listener) => { try { listener(next.meta); } catch {} });
      });
    return null;
  }
  const record = catalogChapterLists.get(id);
  if (record?.meta) return record.meta;
  catalogChapterList(id, refreshTitlePage);
  return null;
}

function titleMetaState(type, id) {
  const record = id ? (type === "movie" ? movieArtRecords.get(id) : catalogChapterLists.get(id)) : null;
  return {
    pending: Boolean(!record || record.pending),
    failed: Boolean(record && !record.pending && !record.meta && record.failedAt),
    error: record?.error || "",
  };
}

function retryTitleMeta(subject) {
  const records = subject.type === "movie" ? movieArtRecords : catalogChapterLists;
  if (subject.id && !records.get(subject.id)?.pending) records.delete(subject.id);
  renderTitlePage();
}

// The title page shows the poster at up to 240 px (480 px on sharp screens): ask for a larger
// size of the same image when its host has sizes in the URL. The stored URL is the fallback.
export function largePosterUrl(url) {
  const value = String(url || "");
  const metahub = metahubVariant(value, "large");
  if (metahub) return metahub;
  const anilist = largeAniListCover(value);
  if (anilist) return anilist;
  if (/^https:\/\/m\.media-amazon\.com\/images\/M\/[^?#]+@\._V1_[^/?#]*\.jpg$/i.test(value)) return value.replace(/\._V1_[^/?#]*\.jpg$/i, "._V1_SX780.jpg");
  return value;
}

// What the page shows: Library name and poster when the title is saved, catalog details for the
// rest, the larger image sizes for the backdrop and poster.
export function titleInfo(subject, meta) {
  const series = subject.series;
  const seed = subject.id ? titleSeedMeta.get(subject.id) || homeTitleIndex.get(subject.id) || (series ? libraryArtCached(series) : null) : null;
  const pick = (field) => (meta && meta[field]) || (seed && seed[field]) || "";
  const artwork = preferredPosterArt({
    saved: series?.coverUrl || "",
    catalog: pick("poster"),
    anilist: series ? seriesAniList(series)?.cover : "",
    artworkSource: series?.artworkSource,
    pinned: series?.artworkPinned,
  });
  const posterRaw = artwork.image;
  const background = pick("background");
  const logo = pick("logo");
  const seasons = (Array.isArray(meta?.seasons) ? meta.seasons : []).filter((item) => Number(item.count) || item.episodes?.length);
  const count = (item) => Number(item.count) || item.episodes.length;
  const regular = seasons.filter((item) => item.season > 0);
  return {
    id: subject.id,
    type: subject.type,
    name: series?.title || pick("name") || "Untitled",
    poster: boundedPosterUrl(largePosterUrl(posterRaw)),
    posterFallback: boundedPosterUrl(largePosterUrl(posterRaw)) !== largePosterUrl(posterRaw)
      ? largePosterUrl(posterRaw) : (artwork.fallback || (posterRaw !== largePosterUrl(posterRaw) ? posterRaw : "")),
    backdrop: background ? metahubVariant(background, "large") || background : "",
    backdropFallback: background,
    logo: logo ? metahubVariant(logo, "medium") || logo : "",
    description: pick("description"),
    genres: (meta?.genres?.length ? meta.genres : seed?.genres || []).slice(0, 6),
    releaseInfo: pick("releaseInfo") || series?.releaseInfo || "",
    runtime: pick("runtime"),
    rating: pick("imdbRating"),
    imdbSeasons: regular.map((season) => ({ season: season.season,
      score: Number.isFinite(Number(season.imdbRating)) && Number(season.imdbRating) > 0 && Number(season.imdbRating) <= 10
        ? Number(season.imdbRating) : null })),
    cast: meta?.cast || [],
    writer: meta?.writer || [],
    director: meta?.director || [],
    country: meta?.country || "",
    awards: meta?.awards || "",
    status: meta?.status || "",
    released: meta?.released || "",
    trailers: Array.isArray(meta?.trailers) ? meta.trailers : [],
    seasonCount: regular.length,
    chapterTotal: regular.reduce((sum, item) => sum + count(item), 0),
    specialCount: seasons.filter((item) => item.season === 0).reduce((sum, item) => sum + count(item), 0),
  };
}

// The catalog record new sources are saved under: the Library title's own name and poster when
// it has them, so a renamed or re-postered title stays one title.
function titleCatalogMeta(subject = titleSubject()) {
  const meta = (subject.id && (titleMetaFor(subject.type, subject.id) || titleSeedMeta.get(subject.id) || homeTitleIndex.get(subject.id))) || {};
  const series = subject.series;
  const name = series?.title || meta.name || "Untitled";
  return {
    ...meta,
    id: subject.id,
    type: subject.type,
    name,
    poster: series?.coverUrl || meta.poster || "",
    releaseInfo: meta.releaseInfo || series?.releaseInfo || "",
    aliases: [...new Set([name, meta.name, ...(series?.aliases || [])].filter(Boolean))],
  };
}

export function refreshTitlePage() {
  if (!viewActive("title") || titleRenderQueued) return;
  titleRenderQueued = true;
  queueMicrotask(() => {
    titleRenderQueued = false;
    renderTitlePage();
  });
}

export function titleListText(names = [], limit = 6) {
  const list = names.slice(0, limit);
  return list.length > 1 ? `${list.slice(0, -1).join(", ")} and ${list.at(-1)}` : list.join("");
}

export function formatTitleDay(day) {
  const match = String(day || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return "";
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

const publicTitleRatingCache = new Map();
const titleRelatedMovieCache = new Map();
let relatedMovieOpenToken = 0;

// Public, read-only franchise links: only request from AniList media that was
// unambiguously verified against the anime's catalog seasons. No title guessing
// and no MediaList/account write or backend restart is necessary.
function titleRelatedMovies(confirmedRating, subject = null, meta = null) {
  const ids = [...new Set((confirmedRating?.seasons || []).flatMap((season) =>
    (season.parts || []).map((part) => part.id)).filter((id) => Number.isSafeInteger(id) && id > 0))].slice(0, 24);
  if (!ids.length) {
    // Strict display-only fallback for long shows split across catalog seasons,
    // or localized releases whose year differs from AniList's original airing.
    if (!meta || !eligibleForPublicAnimeRating({ mediaKind: subject?.series?.mediaKind,
      genres: meta.genres, country: meta.country })) return null;
    const totals = publicCatalogSeasonCounts(meta.seasons || []);
    const count = totals.filter((season) => season.season > 0).reduce((sum, season) => sum + season.count, 0);
    if (!count || !meta.name) return null;
    const key = `franchise:${meta.name}:${count}`;
    const prior = titleRelatedMovieCache.get(key);
    if (prior && Date.now() - prior.createdAt < (prior.failed ? 5 * 60_000 : 60 * 60_000)) return prior;
    // The films found last time stay listed while they're looked up again.
    const record = { items: prior?.items || [], pending: true, failed: false, createdAt: Date.now() };
    titleRelatedMovieCache.set(key, record);
    void fetchPublicAniListTitle(meta.name).then(async (media) => {
      const rootId = verifiedPublicAnimeFranchiseRoot(media, { title: meta.name, totalEpisodes: count });
      if (!rootId) { record.failed = true; return; }
      record.items = await fetchPublicAnimeRelatedMovies([rootId]);
    }).catch(() => { record.failed = true; }).finally(() => {
      record.pending = false;
      if (titleRelatedMovieCache.get(key) === record) refreshTitlePage();
    });
    return record;
  }
  const key = ids.slice().sort((a, b) => a - b).join(",");
  const old = titleRelatedMovieCache.get(key);
  if (old && Date.now() - old.createdAt < (old.failed ? 5 * 60_000 : 60 * 60_000)) return old;
  const record = { items: old?.items || [], pending: true, failed: false, createdAt: Date.now() };
  if (titleRelatedMovieCache.size >= 80) titleRelatedMovieCache.clear();
  titleRelatedMovieCache.set(key, record);
  void fetchPublicAnimeRelatedMovies(ids).then((movies) => {
    record.items = movies;
  }).catch(() => {
    record.failed = true;
  }).finally(() => {
    record.pending = false;
    if (titleRelatedMovieCache.get(key) === record) refreshTitlePage();
  });
  return record;
}

// The Movies tab next to the seasons: the films AniList links to this anime.
export function titleRelatedMoviesMarkup(movies = []) {
  if (!movies.length) return "";
  return `<div class="title-related-movies__grid">${movies.map((movie) =>
      `<button type="button" class="title-related-movie" data-title-action="related-movie" data-anime-movie-id="${movie.id}"
        aria-label="${escapeHtml(`Open ${movie.title}`)}">
        <span class="title-related-movie__art">${movie.cover ? `<img src="${escapeHtml(movie.cover)}" alt="" loading="lazy" decoding="async" data-fallback="poster" data-fallback-title="${escapeHtml(movie.title)}"/>` : icon("film")}</span>
        <strong>${escapeHtml(movie.title)}</strong>
        <small>${escapeHtml([movie.year, "Film"].filter(Boolean).join(" - "))}</small>
      </button>`).join("")}</div>`;
}

function titleCommunityRating(subject, meta) {
  if (subject.type !== "series" || !meta?.id || !Array.isArray(meta.seasons)) return null;
  if (!eligibleForPublicAnimeRating({ mediaKind: subject.series?.mediaKind,
    genres: meta.genres, country: meta.country })) return null;
  const seasons = publicCatalogSeasonCounts(meta.seasons).filter((item) => item.season > 0 && Number(item.count) > 0);
  const year = Number(String(meta.releaseInfo || "").match(/\d{4}/)?.[0]);
  const name = String(meta.name || "").trim();
  if (!seasons.length || !Number.isInteger(year) || !name) return null;
  const aliases = subject.series?.aliases || [];
  const key = `${meta.id}:${year}:${name}:${aliases.join("|")}:${seasons.map((item) => `${item.season}:${item.count}`).join(",")}`;
  const existing = publicTitleRatingCache.get(key);
  // Missing ratings can be a transient match/indexing gap; don't persist a
  // blank chip for six hours. Successful public ratings remain long-cached.
  if (existing && Date.now() - existing.createdAt < (existing.failed ? 5 * 60_000
    : existing.rating?.score && existing.rating?.seasons?.length === existing.rating?.totalSeasons
      ? 6 * 60 * 60_000 : 15 * 60_000)) return existing.rating;
  // Serve a previously verified rating while it is being refreshed. A
  // temporary AniList error or expired TTL must not make the visible badge
  // disappear for an otherwise unchanged catalog title/season identity.
  const entry = { createdAt: Date.now(), rating: existing?.rating || null, failed: false };
  if (publicTitleRatingCache.size > 80) publicTitleRatingCache.clear();
  publicTitleRatingCache.set(key, entry);
  // Community ratings are PUBLIC and read directly in the browser. Never use
  // a personal OAuth token or store this match as an AniList watch association.
  void fetchMatchedPublicAniListSeasons({ title: name, aliases, year, seasons }).then((rating) => {
    if (rating) entry.rating = rating;
    else entry.failed = true;
  }).catch(() => { entry.failed = true; }).finally(() => {
    if (publicTitleRatingCache.get(key) === entry) refreshTitlePage();
  });
  return entry.rating;
}

function titleRatingBreakdownMarkup({ provider, value, seasons = [], totalSeasons = 0, href = "", note = "", root = false } = {}) {
  if (!Number.isFinite(Number(value)) || Number(value) <= 0 || Number(value) > 10) return "";
  const score = Number(value).toFixed(1);
  const showLink = /^https:\/\/(?:www\.imdb\.com|anilist\.co)\//.test(href);
  const seenSharedRuns = new Set();
  const rows = seasons.map((season) => {
    // Cinemeta can split one continuous AniList series into multiple seasons.
    // Keep their catalog-season rating weights unchanged, but present the ONE
    // actual AniList entry just once in the expanded breakdown.
    const sharedSeasons = provider === "AniList" && Array.isArray(season.sharedSeasons)
      && season.sharedSeasons.length > 1 ? season.sharedSeasons : null;
    const sharedKey = sharedSeasons ? `${sharedSeasons.join(",")}:${(season.parts || []).map((part) => part.id).join(",")}` : "";
    if (sharedKey && seenSharedRuns.has(sharedKey)) return "";
    if (sharedKey) seenSharedRuns.add(sharedKey);
    const seasonScore = Number.isFinite(season.score) && season.score > 0 ? season.score.toFixed(1) : "—";
    const shared = sharedSeasons
      ? `One AniList series covers all ${sharedSeasons.length} catalog seasons (${(season.parts || []).map((part) => part.episodes).filter(Number.isInteger).join(" + ") || "multiple"} episodes)`
      : "";
    const parts = (season.parts || []).map((part) => {
      const image = /^https:\/\/s\d+\.anilist\.co\//.test(part.cover || "")
        ? `<img src="${escapeHtml(part.cover)}" alt="" loading="lazy" />` : icon("film");
      const scoreText = Number.isFinite(part.score) && part.score > 0 ? `${part.score.toFixed(1)}/10` : "Not rated";
      return `<div class="title-rating-part">${image}<span>${escapeHtml(part.title)}</span><strong>${escapeHtml(scoreText)}</strong></div>`;
    }).join("");
    const catalogLabel = sharedSeasons ? `Seasons ${sharedSeasons[0]}–${sharedSeasons.at(-1)}` : `Season ${season.season}`;
    const seasonLabel = catalogLabel;
    return `<div class="title-rating-season"><div class="title-rating-season__head">${provider === "IMDb" ? icon("star") : ""}<span>${escapeHtml(seasonLabel)}</span><strong>${escapeHtml(seasonScore === "—" ? "Unavailable" : `${seasonScore}/10`)}</strong></div>${shared ? `<small class="title-rating-season__source">${escapeHtml(shared)}</small>` : ""}${parts}</div>`;
  }).join("");
  const cover = totalSeasons > seasons.length ? `${seasons.length} of ${totalSeasons} seasons matched. ` : "";
  return `<details class="title-rating-wrap" data-title-rating-provider="${provider}">
    <summary class="title-rating" aria-label="${escapeHtml(`${provider} ${score} out of 10; show season breakdown`)}">${icon("star")}<strong>${score}</strong><span>${escapeHtml(provider)}</span>${icon("chevron-down")}</summary>
    <div class="title-rating-breakdown"><div class="title-rating-breakdown__heading"><strong>${escapeHtml(provider)}</strong>${provider === "AniList" ? "" : `<span>${root ? "Overall series score" : "Mean of rated seasons"}</span>`}</div>
      ${rows || '<p class="title-rating-breakdown__note">No season scores available.</p>'}
      ${provider !== "AniList" && (note || cover) ? `<p class="title-rating-breakdown__note">${escapeHtml(cover + note)}</p>` : ""}
      ${showLink && provider !== "AniList" ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">Open on ${escapeHtml(provider)} ↗</a>` : ""}
    </div></details>`;
}

// The rating popup lives inside the poster hero. Choose the side of its badge
// with more actual viewport room, and constrain its scroll area accordingly.
export function positionTitleRatingBreakdown(wrap) {
  const badge = wrap?.querySelector("summary");
  const popup = wrap?.querySelector(".title-rating-breakdown");
  if (!badge || !popup) return;
  const rect = badge.getBoundingClientRect();
  // The badges may wrap or sit close to either viewport edge. Anchor the
  // floating panel to its own badge while keeping the full panel on screen.
  const popupWidth = popup.getBoundingClientRect().width;
  const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
  const margin = 16;
  const preferredLeft = wrap.dataset.titleRatingProvider === "LVL" ? rect.right - popupWidth : rect.left;
  const left = Math.max(margin, Math.min(preferredLeft, viewportWidth - margin - popupWidth));
  popup.style.left = `${Math.round(left - rect.left)}px`;
  popup.style.right = "auto";
  const above = Math.max(0, rect.top - 12);
  const below = Math.max(0, window.innerHeight - rect.bottom - 12);
  const placeBelow = below > above;
  wrap.classList.toggle("is-below", placeBelow);
  popup.style.setProperty("--rating-available-height", `${Math.max(70, Math.floor(placeBelow ? below : above))}px`);
}

export function keepTitleRatingExclusive(wrap) {
  if (!wrap?.open) return;
  const scores = wrap.closest(".title-hero__scores");
  for (const other of scores?.querySelectorAll(".title-rating-wrap[open]") || []) {
    if (other !== wrap) other.open = false;
  }
}

function titleRatingMarkup(info) {
  if (!info.rating) return "";
  const seasons = info.imdbSeasons || [];
  const rated = seasons.filter((item) => Number.isFinite(item.score) && item.score > 0);
  const complete = seasons.length > 0 && rated.length === seasons.length;
  // IMDb's series-wide user rating is a distinct source value, not the average
  // of IMDb season page ratings (whose voter pools and weights can differ).
  // Never overwrite it with a derived arithmetic mean just because all seasons
  // happened to provide scores, or pretend the derived number is from IMDb.
  return titleRatingBreakdownMarkup({ provider: "IMDb", value: Number(info.rating), seasons, totalSeasons: seasons.length,
    root: true, href: info.id ? `https://www.imdb.com/title/${info.id}/` : "",
    note: complete ? "IMDb overall series rating shown above; season ratings are separate and are not averaged into it."
      : "IMDb season scores are not supplied by the catalog. The badge shows the IMDb series rating." });
}

function titleAniListRatingMarkup(rating, { eligible = false } = {}) {
  if (!rating || !Number.isFinite(rating.score) || rating.score <= 0) {
    // Keep the provider in its usual place on anime title pages, without
    // inventing a numeric zero or a clickable breakdown for missing data.
    return eligible ? `<span class="title-rating title-rating--unavailable" data-title-rating-provider="AniList" aria-label="AniList score unavailable">${icon("star")}<strong aria-hidden="true"></strong><span>AniList</span></span>` : "";
  }
  const first = rating.seasons[0]?.parts[0];
  return titleRatingBreakdownMarkup({ provider: "AniList", value: rating.score,
    seasons: rating.seasons, totalSeasons: rating.totalSeasons,
    href: first ? `https://anilist.co/anime/${first.id}` : "" });
}

function titleTrailerUrl(trailer) {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(trailer.id)}`;
}

// Keep trailers inside the current LVL window when modal video embeds are
// supported. The original link remains the fallback without dialog support.
export function openTitleTrailer(id, watchUrl) {
  if (!/^[a-zA-Z0-9_-]{11}$/.test(String(id || "")) || typeof HTMLDialogElement === "undefined") return false;
  let dialog = $("#title-trailer-dialog");
  if (!dialog) {
    dialog = document.createElement("dialog");
    dialog.id = "title-trailer-dialog";
    dialog.className = "title-trailer-dialog";
    dialog.setAttribute("aria-label", "Trailer video");
    const close = document.createElement("button");
    close.type = "button";
    close.className = "title-trailer-dialog__close";
    close.textContent = "×";
    close.setAttribute("aria-label", "Close trailer");
    close.title = "Close trailer";
    close.addEventListener("click", () => dialog.close());
    const frame = document.createElement("iframe");
    frame.className = "title-trailer-dialog__frame";
    frame.title = "Trailer video";
    frame.allow = "accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture; web-share";
    frame.allowFullscreen = true;
    frame.referrerPolicy = "strict-origin-when-cross-origin";
    dialog.append(frame, close);
    dialog.addEventListener("close", () => frame.removeAttribute("src"));
    dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
    document.body.append(dialog);
  }
  dialog.querySelector(".title-trailer-dialog__frame").src = `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0`;
  if (!dialog.open) dialog.showModal();
  // Keep initial keyboard focus in the parent dialog rather than the YouTube
  // iframe, so the native Escape action and accessible close stay reachable.
  dialog.querySelector(".title-trailer-dialog__close")?.focus();
  return true;
}

// The first chapter that has aired, for "Play S1 E1" on a title with nothing saved yet.
function titleFirstChapter(view) {
  const season = view?.seasons.find((item) => item.season > 0) || view?.seasons[0];
  const episode = season?.episodes.find((item) => !chapterUpcoming(item));
  return episode ? { ...episode, season: season.season } : null;
}

export function savedTitleBadge(series) {
  if (!series) return null;
  // A magnet is a reusable torrent source, not downloaded video bytes.
  return (series.sources || []).some((entry) =>
    Boolean(entry?.magnet) && (entry.episodes || []).some((episode) =>
      episode.fileIndex !== null && episode.fileIndex !== undefined
      && Number.isInteger(Number(episode.fileIndex)) && Number(episode.fileIndex) >= 0))
    ? { label: "Torrent saved", title: "Torrent source saved in your Library" }
    : { label: "On your list", title: "Title added to your Library; no torrent source saved" };
}

function titleHeroMarkup(subject, info, view, communityRating = null) {
  const series = subject.series;
  const savedBadge = savedTitleBadge(series);
  const movie = subject.type === "movie";
  const next = series ? seriesNextUp(series) : null;
  const first = !next && !movie ? titleFirstChapter(view) : null;
  const facts = [
    movie ? "Movie" : "Series",
    info.releaseInfo,
    !movie && info.seasonCount ? `${info.seasonCount} season${info.seasonCount === 1 ? "" : "s"}` : "",
    !movie && info.chapterTotal ? `${info.chapterTotal} chapter${info.chapterTotal === 1 ? "" : "s"}` : "",
    movie ? formatRuntime(info.runtime) || info.runtime : info.runtime,
    info.status ? `${movie ? "Release status" : "Broadcast status"}: ${info.status}` : "",
  ];
  const actions = [];
  if (next) actions.push(buttonMarkup({ label: next.label, variant: "primary", size: "lg", icon: "play", attrs: { "data-title-action": "play-next" } }));
  else if (first) actions.push(buttonMarkup({ label: `Play ${libraryChapterName({ code: chapterCode(first.season, first.episode) }) || "the first chapter"}`, variant: "primary", size: "lg", icon: "play", attrs: { "data-title-action": "play-first" } }));
  else if (movie && info.id) actions.push(buttonMarkup({ label: "Find sources", variant: "primary", size: "lg", icon: "search", attrs: { "data-title-action": "movie-sources" } }));
  if (!series && info.id) actions.push(buttonMarkup({ label: "Add to Library", variant: "glass", size: "lg", icon: "plus", attrs: { "data-title-action": "add" } }));
  if (info.trailers.length) actions.push(`<a class="ui-btn ui-btn--glass ui-btn--lg title-trailer" data-trailer-id="${escapeHtml(info.trailers[0].id)}" href="${escapeHtml(titleTrailerUrl(info.trailers[0]))}" target="_blank" rel="noopener noreferrer">${icon("film")}<span>Trailer</span></a>`);
  if (series && !info.id) actions.push(buttonMarkup({ label: "Find this title", variant: "glass", size: "lg", icon: "search", attrs: { "data-title-action": "find-title" } }));
  if (series && !movie) actions.push(buttonMarkup({ label: "Magnet link", variant: "glass", size: "lg", attrs: { "data-title-action": "magnet" } }));
  if (series) actions.push('<div id="title-watch-status-slot" class="title-watch-status-slot"></div>');
  if (series) actions.push(iconButtonMarkup({ icon: "more", label: `More for ${info.name}`, variant: "glass", attrs: { "data-title-action": "menu", "aria-haspopup": "menu", "aria-expanded": "false" } }));
  const fallbackAttr = (url, shown) => (url && url !== shown ? ` data-fallback-src="${escapeHtml(url)}"` : "");
  const heroPosterSrcset = posterSrcset({ poster: info.poster });
  const poster = info.poster
    ? `<img class="title-hero__poster" src="${escapeHtml(info.poster)}"${heroPosterSrcset ? ` srcset="${escapeHtml(heroPosterSrcset)}" sizes="(max-width:680px) 112px, (max-width:1067px) 160px, (min-width:1600px) 240px, 15vw"` : ""} alt="${escapeHtml(`${info.name} poster`)}" decoding="async" data-fallback="poster" data-fallback-title="${escapeHtml(info.name)}"${fallbackAttr(info.posterFallback, info.poster)} />`
    : `<img class="title-hero__poster" src="${escapeHtml(artworkFallback(info.name, { label: movie ? "Movie" : "Series" }))}" alt="" />`;
  return `<div class="title-hero${info.backdrop ? " has-backdrop" : ""}">
    <div class="title-hero__media" aria-hidden="true">${info.backdrop ? `<img class="title-hero__backdrop" src="${escapeHtml(info.backdrop)}" alt="" decoding="async" fetchpriority="high"${fallbackAttr(info.backdropFallback, info.backdrop)} />` : ""}</div>
    <div class="title-hero__shade" aria-hidden="true"></div>
    <div class="title-hero__bar">${buttonMarkup({ label: titleView.fromApp ? "Back" : "Library", variant: "glass", size: "sm", icon: "chevron-left", className: "title-back", attrs: { "data-title-action": "back" } })}</div>
    <div class="title-hero__content">
      <div class="title-hero__poster-wrap">${poster}${savedBadge ? `<span class="title-hero__poster-saved" title="${escapeHtml(savedBadge.title)}">${icon("check")}<span>${escapeHtml(savedBadge.label)}</span></span>` : ""}</div>
      <div class="title-hero__copy">
        <h1 class="ui-hero__title title-hero__title" id="title-name">${info.logo ? `<img class="ui-hero__logo title-hero__logo" src="${escapeHtml(info.logo)}" alt="" data-ui-logo="" />` : ""}<span class="ui-hero__title-text">${escapeHtml(info.name)}</span></h1>
        <div class="title-hero__facts">${metaMarkup(facts)}<div class="title-hero__scores">${titleRatingMarkup(info)}${titleAniListRatingMarkup(communityRating, { eligible: eligibleForPublicAnimeRating({ mediaKind: series?.mediaKind, genres: info.genres, country: info.country }) })}<div id="title-lvl-rating-slot" class="title-lvl-rating-slot"></div></div></div>
        ${info.genres.length ? `<ul class="title-genres" aria-label="Genres">${info.genres.map((genre) => `<li>${escapeHtml(genre)}</li>`).join("")}</ul>` : ""}
        ${info.description ? `<p class="title-hero__synopsis">${escapeHtml(info.description)}</p>` : ""}
        ${info.cast.length && !eligibleForPublicAnimeRating({ mediaKind: series?.mediaKind,
          genres: info.genres, country: info.country }) ? `<p class="title-hero__people"><span>Starring</span> ${escapeHtml(titleListText(info.cast, 4))}</p>` : ""}
        <div class="title-hero__actions">${actions.join("")}</div>
      </div>
    </div>
  </div>`;
}

// Your progress with a Library title: playback/AniList always, learning metrics
// only while Learning is enabled. Do not hide rating or watched progress.
function titleProgressMarkup(subject, info) {
  const series = subject.series;
  if (!series) return "";
  // The title hero already carries the essential metadata and ratings.
  // The hero already shows the scores. Leave unavailable ratings blank there;
  // only a small collapsed manual URL/ID fallback belongs below the hero.
  const account = series.mediaKind === "anime" ? readAniListAccount(localStorage) : null;
  const seasons = [...new Set([
    ...series.seasons.keys(),
    ...(subject.id && catalogSeriesView?.meta?.id === subject.id
      ? catalogSeriesView.seasons.map((season) => season.season) : []),
  ])].filter((season) => Number.isInteger(season) && season > 0).sort((a, b) => a - b);
  const mapped = account && seriesAniList(series, account.userId);
  const missing = account && seasons.filter((season) => !(mapped?.seasons || []).some((part) => part.season === season));
  if (!missing?.length || !/^tt\d{5,12}$/.test(series.catalogId || "")) return "";
  return `<details class="title-anilist-manual" aria-label="Manual AniList season link">
    <summary>Link AniList manually</summary>
    <div class="title-anilist-manual__controls">
      <label>Season <select id="title-anilist-link-season">${missing.map((season) => `<option value="${season}">${season}</option>`).join("")}</select></label>
      <label>AniList URL or ID <input id="title-anilist-link-id" type="text" inputmode="url" autocomplete="off" maxlength="512" placeholder="anilist.co/anime/5114" /></label>
      <button class="ui-btn ui-btn--secondary ui-btn--sm" type="button" data-title-anilist-link>Verify & link</button>
    </div><p id="title-anilist-link-results" class="title-anilist-manual__status" role="status" aria-live="polite"></p>
  </details>`;
}

let anilistTitleManualLinkSerial = 0;
function anilistLinkTitle(media) {
  return String(media?.title?.english || media?.title?.romaji || "Untitled");
}
export async function handleTitleAniListLink(event) {
  if (!event.target.closest("[data-title-anilist-link]")) return;
  const series = titleSubject().series;
  const account = readAniListAccount(localStorage);
  const input = $("#title-anilist-link-id");
  const season = Number($("#title-anilist-link-season")?.value);
  if (!series || !account?.token || !input || !Number.isInteger(season) || season < 1) return;
  // Capture immutable identity: the Library can mutate the same series object
  // in place while an authenticated lookup is still pending.
  const seriesKey = series.key;
  const catalogId = series.catalogId;
  const serial = ++anilistTitleManualLinkSerial;
  const id = parseManualAniListId(input.value);
  const current = () => {
    const active = titleSubject().series;
    const signed = readAniListAccount(localStorage);
    return serial === anilistTitleManualLinkSerial && signed?.token === account.token
      && signed?.userId === account.userId && active?.key === seriesKey
      && active?.catalogId === catalogId && Number($("#title-anilist-link-season")?.value) === season
      && parseManualAniListId($("#title-anilist-link-id")?.value) === id ? active : null;
  };
  const show = (message, error = false) => {
    const results = $("#title-anilist-link-results");
    if (results?.isConnected && current()) {
      results.textContent = message;
      results.classList.toggle("is-error", error);
    }
  };
  try {
    if (!id) throw new Error("Paste a valid AniList anime URL or numeric media ID.");
    if (!/^tt\d{5,12}$/.test(catalogId || "")) throw new Error("Find the catalog title before linking AniList.");
    show("Verifying season and AniList entry…");
    const [catalog, data] = await Promise.all([
      fetchJson(`/api/catalog/meta?type=series&id=${encodeURIComponent(catalogId)}`),
      anilistGraphql(account.token, ANILIST_MANUAL_ID_VERIFY, { id }),
    ]);
    const active = current();
    if (!active) return;
    const media = data?.Media;
    if (media?.id !== id) throw new Error("AniList returned a different media ID. No link was saved.");
    const planned = planVerifiedManualAniListSeason({ media, meta: catalog?.meta,
      series: active, linked: seriesAniList(active, account.userId), season, accountId: account.userId });
    if (!planned) throw new Error("This AniList entry cannot be verified as the selected complete catalog season. Split cours or ambiguous seasons need an exact mapping; no watched progress was linked.");
    const locallyWatched = Object.keys(Object.assign({}, ...active.sources.map((entry) => entry.watchedChapters || {})));
    // Imported video files can have a verified SxxEyy code without parsed
    // season/episode numbers (e.g. JoJo S01E01). Check both representations,
    // so a shorter remote season cannot be linked by bypassing this guard.
    const localEpisodes = [...active.sources.flatMap((entry) => (entry.episodes || []).flatMap((episode) => [
      String(episode.code || "").toUpperCase(),
      ...(Number.isInteger(episode.season) && episode.season > 0 && Number.isInteger(episode.episode) && episode.episode > 0
        ? [chapterCode(episode.season, episode.episode)] : []),
    ])), ...locallyWatched]
      .filter((code) => new RegExp(`^S${String(season).padStart(2, "0")}E\\d{2,4}$`).test(code))
      .map((code) => Number(code.split("E")[1]));
    if (localEpisodes.some((episode) => episode > planned.episodes))
      throw new Error("The selected AniList entry has fewer episodes than the Library season.");
    if (!current()) return;
    if (!(await confirmDialog({ title: `Link ${active.title} season ${season}?`, confirmLabel: "Link",
      text: `To ${anilistLinkTitle(media)} (${planned.episodes} episodes, AniList #${id}). Watched episodes may then sync to your AniList account. No scores are changed.` }))) {
      show("No mapping saved.");
      return;
    }
    const latest = current();
    if (!latest || seriesAniList(latest, account.userId)?.seasons?.some((part) => part.season === season)) return;
    updateLibrarySeriesEntries(latest.key, (entry) => {
      if (entry.id !== latest.sources[0]?.id) return;
      const links = Array.isArray(entry.anilistManualLinks) ? entry.anilistManualLinks : [];
      entry.anilistManualLinks = [...links.filter((link) => !(link.userId === account.userId && link.season === season)), {
        ...planned, verifiedAt: Date.now(),
      }];
    });
    toast(`AniList season ${season} linked. Watched progress will sync if enabled.`);
  } catch (error) {
    show(error.message || "Could not verify that AniList season.", true);
  }
}

function titleAboutMarkup(subject, info) {
  const movie = subject.type === "movie";
  const anime = eligibleForPublicAnimeRating({ mediaKind: subject.series?.mediaKind,
    genres: info.genres, country: info.country });
  const text = (value) => (value ? escapeHtml(value) : "");
  const chapters = !movie && info.chapterTotal
    ? [`${info.seasonCount} season${info.seasonCount === 1 ? "" : "s"}`, `${info.chapterTotal} chapter${info.chapterTotal === 1 ? "" : "s"}`, info.specialCount ? `${info.specialCount} special${info.specialCount === 1 ? "" : "s"}` : ""].filter(Boolean).join(", ")
    : "";
  const rows = [
    ["Genres", text(info.genres.join(", "))],
    ["Starring", anime ? "" : text(titleListText(info.cast, 12))],
    ["Written by", text(titleListText(info.writer, 12))],
    ["Directed by", text(titleListText(info.director, 12))],
    [movie ? "Released" : "First aired", text(formatTitleDay(info.released) || info.releaseInfo)],
    [movie ? "Release status" : "Broadcast status", text(info.status)],
    ["Runtime", text(info.runtime ? (movie ? formatRuntime(info.runtime) || info.runtime : `${info.runtime} per chapter`) : "")],
    ["Chapters", text(chapters)],
    ["Country", text(info.country)],
    ["Awards", text(info.awards)],
    ["Trailers", info.trailers.map((trailer, index) => `<a class="title-trailer" data-trailer-id="${escapeHtml(trailer.id)}" href="${escapeHtml(titleTrailerUrl(trailer))}" target="_blank" rel="noopener noreferrer">${escapeHtml(info.trailers.length > 1 ? `Trailer ${index + 1}` : "Trailer")}</a>`).join(" ")],
  ].filter(([, value]) => value);
  if (!info.description && !rows.length) return "";
  // The hero shows about four lines of the synopsis; the full text goes here when it's longer.
  const longSynopsis = info.description.length > 260;
  return `<h2 class="title-section__title" id="title-about-heading">About</h2>
    ${longSynopsis ? `<p class="title-about__synopsis">${escapeHtml(info.description)}</p>` : ""}
    ${rows.length ? `<dl class="title-facts">${rows.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${value}</dd></div>`).join("")}</dl>` : ""}`;
}

// Chapters: the catalog's full list (rendered by renderTitleChapters), or the saved chapters while
// it loads, when it failed, or when the title has no catalog data.
function titleChaptersSectionMarkup(subject, meta, view) {
  const series = subject.series;
  if (view) return `<section class="title-block" aria-labelledby="title-chapters-heading"><div id="title-chapters"></div></section>${titleOtherVideosMarkup(subject, view)}`;
  const status = titleMetaState(subject.type, subject.id);
  const saved = Boolean(series && (librarySeriesChapterCount(series) || series.extras.length));
  let note = "";
  if (subject.id && status.pending) note = '<p class="title-note" role="status">Loading the chapter list…</p>';
  else if (subject.id && status.failed) note = `<p class="title-note is-error" role="alert">${escapeHtml(status.error || "Couldn't load the chapter list.")} ${buttonMarkup({ label: "Try again", variant: "ghost", size: "sm", icon: "refresh", attrs: { "data-title-action": "retry" } })}</p>`;
  else if (subject.id && meta) note = '<p class="title-note">No chapters are listed for this title yet.</p>';
  else if (!subject.id && series) note = '<p class="title-note">Only the chapters you saved are shown. Find this title to list all of them.</p>';
  const body = saved ? libraryDialogChaptersMarkup(series, refreshTitlePage) : note ? "" : emptyMarkup({ compact: true, title: "No chapters saved yet" });
  return `<section class="title-block" aria-labelledby="title-chapters-heading">
    <div class="title-section__head"><h2 class="title-section__title" id="title-chapters-heading">Chapters</h2></div>
    ${note}<div id="title-chapters" class="title-saved-list">${body}</div>
  </section>`;
}

// Saved videos the catalog's chapter list doesn't have: extras, and files with other numbers.
function titleOtherVideosMarkup(subject, view) {
  const series = subject.series;
  if (!series) return "";
  const listed = new Set(view.seasons.flatMap((season) => season.episodes.map((episode) => chapterCode(season.season, episode.episode))));
  const unmatched = [...series.seasons.values()].flatMap((refs) => groupLibraryChapters(refs))
    .filter((chapter) => !listed.has(String(chapter.code || "").toUpperCase()));
  const chapters = [...unmatched, ...groupLibraryChapters(series.extras)];
  if (!chapters.length) return "";
  const thumbs = libraryDialogThumbs(series, refreshTitlePage);
  return `<section class="title-block" aria-labelledby="title-other-heading">
    <div class="title-section__head"><h2 class="title-section__title" id="title-other-heading">Other videos</h2><span class="catalog-sources-note">Extras and files outside the chapter list</span></div>
    <ol class="lib-chapter-list">${chapters.map((chapter) => libraryDialogChapterMarkup(series, chapter, thumbs)).join("")}</ol>
  </section>`;
}

function titleMovieMarkup(subject, info, meta = null) {
  const series = subject.series;
  const saved = series && ([...series.seasons.values()].flat().length || series.extras.length)
    ? `<section class="title-block" aria-labelledby="title-saved-heading"><div class="title-section__head"><h2 class="title-section__title" id="title-saved-heading">In your Library</h2></div><div id="title-chapters" class="title-saved-list">${libraryDialogChaptersMarkup(series, refreshTitlePage)}</div></section>`
    : "";
  const sources = info.id ? `<section class="title-block" id="title-sources" aria-labelledby="title-sources-heading">${titleMovieSourcesMarkup(info)}</section>` : "";
  const movie = saved + sources || emptyMarkup({ compact: true, title: "No sources saved" });
  // Feature sections (Comics…): a chip row like a series' seasons, "Movie" first.
  const chips = typeof clientFeatures !== "undefined" ? clientFeatures.titleSectionChips(titleMovieSectionPayload(subject, info, meta)) : [];
  if (!chips.length) return movie;
  const open = chips.some((chip) => chip.id === titleView.featureSection) ? titleView.featureSection : "";
  const row = `<div class="ui-chip-row catalog-season-switch" role="group" aria-label="Sections">`
    + `<button class="ui-chip catalog-feature-section" type="button" data-feature-section="" aria-pressed="${!open}">Movie</button>`
    + chips.map((chip) => `<button class="ui-chip catalog-feature-section" type="button" data-feature-section="${escapeHtml(chip.id)}" aria-pressed="${chip.id === open}">${escapeHtml(t(chip.label))}${Number.isFinite(chip.count) ? `<span class="ui-chip__count">${chip.count}</span>` : ""}</button>`).join("")
    + "</div>";
  if (!open) return `<section class="title-block title-movie-sections" aria-label="Sections">${row}</section>${movie}`;
  return `<section class="title-block" aria-labelledby="title-chapters-heading"><div class="title-movie-feature">
      <div class="title-section__head"><h2 class="title-section__title" id="title-chapters-heading">Chapters</h2><div class="title-feature-head"></div></div>
      ${row}<div class="title-feature-section" data-feature-section="${escapeHtml(open)}"></div></div></section>`;
}

const titleMovieSectionPayload = (subject, info, meta) => ({ meta, info, subject });

// A movie's torrents, looked up only when asked (Find sources), best first.
function titleMovieSourcesMarkup(info) {
  const view = titleMovieView?.id === info.id ? titleMovieView : null;
  const head = (title, extra = "") => `<div class="title-section__head"><h2 class="title-section__title" id="title-sources-heading">${escapeHtml(title)}</h2>${extra}</div>`;
  const best = buttonMarkup({ label: "Add the best source", variant: "secondary", size: "sm", icon: "plus", className: "catalog-add-best-detail" });
  if (!view || view.status === "idle") {
    return `${head("Sources")}<div class="title-source-actions">${buttonMarkup({ label: "Find sources", variant: "secondary", size: "sm", icon: "search", attrs: { "data-title-action": "movie-sources" } })}${best}</div>`;
  }
  if (view.status === "loading") return `${head("Sources")}<p class="catalog-chapter-sources-status" role="status">Finding sources…</p>`;
  if (view.status === "error") {
    return `${head("Sources")}<p class="catalog-chapter-sources-status is-error" role="alert">${escapeHtml(view.error)}</p>
      <div class="title-source-actions">${buttonMarkup({ label: "Try again", variant: "secondary", size: "sm", icon: "refresh", attrs: { "data-title-action": "movie-sources" } })}</div>`;
  }
  const height = (stream) => Number(stream.height) || heightFromQualityLabel(stream.quality) || 0;
  view.visible = view.floorOnly
    ? view.streams.filter((stream) => meetsSourceFloor(stream)).sort((a, b) => height(b) - height(a) || (Number(b.peers) || 0) - (Number(a.peers) || 0))
    : view.streams.slice().sort(compareStreamsByPeers).slice(0, 30);
  const title = view.floorOnly ? `${view.visible.length} magnet${view.visible.length === 1 ? "" : "s"}` : `${view.streams.length} source${view.streams.length === 1 ? "" : "s"}`;
  const toggle = view.floorOnly
    ? buttonMarkup({ label: `Show all ${view.streams.length}`, variant: "ghost", size: "sm", className: "catalog-movie-all" })
    : buttonMarkup({ label: "Fetch all magnets", variant: "ghost", size: "sm", className: "catalog-fetch-all-movie" });
  return `${head(title, view.floorOnly ? '<span class="catalog-sources-note">720p or better, 2+ peers</span>' : "")}
    <div class="title-source-actions">${best}${toggle}</div>
    <div class="catalog-stream-list">${view.visible.length
      ? view.visible.map((stream, index) => catalogStreamRowMarkup(stream, index, { contentType: "movie" })).join("")
      : emptyMarkup({ compact: true, title: view.floorOnly ? "None at 720p or better with 2+ peers" : "No sources found" })}</div>`;
}

function renderTitleMovieSources() {
  const section = $("#title-sources");
  if (!section) return;
  const subject = titleSubject();
  section.innerHTML = titleMovieSourcesMarkup(titleInfo(subject, titleMetaFor(subject.type, subject.id)));
}

async function loadTitleMovieSources({ scroll = false } = {}) {
  const id = titleView.id;
  if (!id) return;
  titleMovieView = { id, status: "loading", streams: [], floorOnly: false, error: "", visible: [] };
  renderTitleMovieSources();
  if (scroll) $("#title-sources")?.scrollIntoView({ behavior: "smooth", block: "start" });
  try {
    const data = await fetchJson(`/api/streams?type=movie&id=${encodeURIComponent(id)}`);
    if (titleMovieView?.id === id) titleMovieView = { ...titleMovieView, status: "ready", streams: data.streams || [] };
  } catch (error) {
    if (titleMovieView?.id === id) titleMovieView = { ...titleMovieView, status: "error", error: error.message || "The source lookup failed" };
  }
  renderTitleMovieSources();
}

function titleMissingMarkup() {
  return `<div class="title-missing">${emptyMarkup({
    icon: "film",
    title: "This title isn't here",
    text: "It may have been removed from your Library.",
    action: buttonMarkup({ label: "Go to the Library", variant: "primary", attrs: { "data-title-action": "library" } }),
  })}</div>`;
}

// Parts are only replaced when their markup changed, so a refresh doesn't reload the backdrop.
export const titleRendered = { hero: "", progress: "", main: "", about: "", chapters: "" };

function setTitlePart(node, part, markup) {
  if (titleRendered[part] === markup) return false;
  titleRendered[part] = markup;
  node.innerHTML = markup;
  node.hidden = !markup;
  return true;
}

// Catalog backdrops are usually 1920 px wide; one far smaller than the hero is shown at its own
// size on the right, faded into the page, instead of stretched soft.
export function fitTitleBackdrop() {
  const hero = $("#view-title .title-hero");
  const img = hero?.querySelector(".title-hero__backdrop");
  if (!hero || !img) return;
  const apply = () => {
    if (!img.naturalWidth || !img.isConnected) return;
    hero.style.setProperty("--backdrop-w", `${img.naturalWidth}px`);
    hero.style.setProperty("--backdrop-h", `${img.naturalHeight}px`);
    hero.classList.toggle("has-small-backdrop", img.naturalWidth < hero.clientWidth * 0.75);
  };
  if (img.complete) apply();
  else img.addEventListener("load", apply, { once: true });
}

// What "Your rating" saves with a rating: the title, its year, its kind (anime is matched on
// AniList, other titles on TMDB) and the seasons that can be rated one by one.
function titleRatingSubject(subject, info, meta) {
  const movie = subject.type === "movie";
  // Public/legacy AniList annotations may be displayed elsewhere, but cannot
  // supply the signed-in account's editable score or remote write target.
  const linkedAniList = authenticatedTitleAniList(subject, readAniListAccount(localStorage));
  const anime = Boolean(subject.series?.sources?.some((entry) => entry.anilistId))
    || eligibleForPublicAnimeRating({ mediaKind: subject.series?.mediaKind,
      genres: info.genres, country: info.country });
  const seasonsFromCatalog = movie ? [] : (Array.isArray(meta?.seasons) ? meta.seasons : [])
    .filter((item) => item.season > 0 && (Number(item.count) || item.episodes?.length))
    .map((item) => item.season);
  const seasons = movie ? [] : [...new Set([
    ...seasonsFromCatalog,
    ...(linkedAniList?.seasons || []).map((part) => part.season).filter((season) => Number.isInteger(season) && season > 0),
  ])].sort((a, b) => a - b);
  return {
    catalogId: subject.id || "",
    seriesKey: subject.key || "",
    title: info.name === "Untitled" ? "" : info.name,
    year: Number(String(info.releaseInfo || info.released || "").match(/\d{4}/)?.[0]) || null,
    kind: anime ? (movie ? "anime-movie" : "anime") : movie ? "movie" : "series",
    seasons,
    anilist: linkedAniList,
  };
}

// A title a feature owns (titleSubjects; e.g. a manga with no anime), drawn with
// the same hero, "Chapters" heading and chips as a video title. The feature's
// describe() gives { name, poster, backdrop, description, genres, facts, scores,
// actions, inLibrary, progressHtml, aboutHtml } or null while it loads; its title
// sections (chips) fill the chapter area, and mount() binds its own controls.
function featureTitleHeroMarkup(info) {
  const actions = (info.actions || []).map((action, index) => buttonMarkup({ label: action.label, variant: action.variant || (index ? "glass" : "primary"),
    size: "lg", icon: action.icon || "", attrs: action.attrs || {}, i18n: action.i18n !== false })).join("");
  const scores = (info.scores || []).filter((score) => Number.isFinite(Number(score.value)) && Number(score.value) > 0 && Number(score.value) <= 10)
    .map((score) => `<span class="title-rating" data-title-rating-provider="${escapeHtml(score.provider)}">${icon("star")}<strong>${escapeHtml(Number(score.value).toFixed(1))}</strong><span>${escapeHtml(score.provider)}</span></span>`).join("");
  const poster = info.poster
    ? `<img class="title-hero__poster" src="${escapeHtml(info.poster)}" alt="${escapeHtml(`${info.name} cover`)}" decoding="async" data-fallback="poster" data-fallback-title="${escapeHtml(info.name)}" />`
    : `<img class="title-hero__poster" src="${escapeHtml(artworkFallback(info.name, { label: info.kind || "" }))}" alt="" />`;
  return `<div class="title-hero${info.backdrop ? " has-backdrop" : ""}">
    <div class="title-hero__media" aria-hidden="true">${info.backdrop ? `<img class="title-hero__backdrop" src="${escapeHtml(info.backdrop)}" alt="" decoding="async" fetchpriority="high" />` : ""}</div>
    <div class="title-hero__shade" aria-hidden="true"></div>
    <div class="title-hero__bar">${buttonMarkup({ label: titleView.fromApp ? "Back" : "Library", variant: "glass", size: "sm", icon: "chevron-left", className: "title-back", attrs: { "data-title-action": "back" } })}</div>
    <div class="title-hero__content">
      <div class="title-hero__poster-wrap">${poster}</div>
      <div class="title-hero__copy">
        <h1 class="ui-hero__title title-hero__title" id="title-name"><span class="ui-hero__title-text">${escapeHtml(info.name)}</span></h1>
        ${info.subtitle ? `<p class="title-hero__subtitle">${escapeHtml(info.subtitle)}</p>` : ""}
        <div class="title-hero__facts">${metaMarkup(info.facts || [])}<div class="title-hero__scores">${scores}<div id="title-lvl-rating-slot" class="title-lvl-rating-slot"></div></div></div>
        ${info.genres?.length ? `<ul class="title-genres" aria-label="Genres">${info.genres.map((genre) => `<li>${escapeHtml(genre)}</li>`).join("")}</ul>` : ""}
        ${info.description ? `<p class="title-hero__synopsis">${escapeHtml(info.description)}</p>` : ""}
        <div class="title-hero__actions">${actions}<div id="title-feature-actions" class="title-feature-actions"></div></div>
      </div>
    </div>
  </div>`;
}

function renderFeatureTitlePage(route) {
  const parts = { hero: $("#title-hero"), progress: $("#title-progress"), main: $("#title-main"), about: $("#title-about") };
  if (Object.values(parts).some((node) => !node)) return;
  recsUi.renderTitleRating($("#title-your-rating"), null);
  const info = clientFeatures.titleSubjectInfo(route.feature, route.item);
  if (!info || info.missing) {
    document.title = DEFAULT_DOCUMENT_TITLE;
    setTitlePart(parts.hero, "hero", info?.missing ? titleMissingMarkup() : `<div class="title-hero">${skeletonHeroMarkup()}</div>`);
    for (const part of ["progress", "main", "about"]) setTitlePart(parts[part], part, "");
    return;
  }
  $$(".nav-btn").forEach((button) => button.classList.toggle("is-active", button.dataset.view === (info.inLibrary ? "library" : "home")));
  document.title = `${info.name} | ${DEFAULT_DOCUMENT_TITLE}`;
  const heroChanged = setTitlePart(parts.hero, "hero", featureTitleHeroMarkup(info));
  if (heroChanged) fitTitleBackdrop();
  setTitlePart(parts.progress, "progress", info.progressHtml || "");
  // Same heading and chips as a video title; the feature's sections are the chips.
  const payload = { feature: route.feature, item: route.item, info, subject: { feature: route.feature, item: route.item } };
  const chips = clientFeatures.titleSectionChips(payload);
  const open = chips.find((chip) => chip.id === titleView.featureSection)?.id || chips[0]?.id || "";
  const markup = `<section class="title-block" aria-labelledby="title-chapters-heading"><div id="title-chapters">
      <div class="title-section__head"><h2 class="title-section__title" id="title-chapters-heading">Chapters</h2><div class="title-feature-head"></div></div>
      <div class="ui-chip-row catalog-season-switch" role="group" aria-label="Sections">${chips.map((chip) => `<button class="ui-chip catalog-feature-section" type="button" data-feature-section="${escapeHtml(chip.id)}" aria-pressed="${chip.id === open}">${escapeHtml(t(chip.label))}${Number.isFinite(chip.count) ? `<span class="ui-chip__count">${chip.count}</span>` : ""}</button>`).join("")}</div>
      <div class="title-feature-section" data-feature-section="${escapeHtml(open)}"></div></div></section>`;
  const mainChanged = setTitlePart(parts.main, "main", markup);
  if (mainChanged && open) {
    const main = parts.main;
    clientFeatures.renderTitleSection(open, main.querySelector(".title-feature-section"), { ...payload, head: main.querySelector(".title-feature-head") });
  }
  const aboutChanged = setTitlePart(parts.about, "about", info.aboutHtml || "");
  if (heroChanged || mainChanged || aboutChanged) refreshImages($("#view-title"));
  clientFeatures.mountTitleSubject(route.feature, { ...parts, changed: { hero: heroChanged, main: mainChanged, about: aboutChanged } }, route.item);
}

export function renderTitlePage() {
  if (!viewActive("title")) return;
  const route = titleRoute();
  const routeKey = `${route.id}|${route.key}|${route.type}|${route.feature}|${route.item}`;
  if (titleView.routeKey !== routeKey) {
    titleView.routeKey = routeKey;
    titleView.featureSection = route.section || "";
    catalogSeriesView = null;
    catalogSeriesToken += 1;
    titleMovieView = null;
    libraryDialogView.key = "";
    libraryDialogView.season = null;
    libraryDialogView.open.clear();
    // Unknown, not "": a part the new title leaves empty must still clear the last title's content.
    Object.keys(titleRendered).forEach((part) => { titleRendered[part] = null; });
    setToolStatus(TITLE_STATUS, "");
  }
  if (route.feature) {
    renderFeatureTitlePage(route);
    return;
  }
  const subject = titleSubject(route);
  Object.assign(titleView, { id: subject.id, type: subject.type, key: subject.key });
  $$(".nav-btn").forEach((button) => button.classList.toggle("is-active", button.dataset.view === (subject.series ? "library" : "home")));
  const hero = $("#title-hero");
  const progress = $("#title-progress");
  const main = $("#title-main");
  const about = $("#title-about");
  if (!hero || !progress || !main || !about) return;
  if (!subject.id && !subject.series) {
    document.title = DEFAULT_DOCUMENT_TITLE;
    setTitlePart(hero, "hero", titleMissingMarkup());
    ["progress", "main", "about"].forEach((part) => setTitlePart({ progress, main, about }[part], part, ""));
    recsUi.renderTitleRating($("#title-your-rating"), null);
    return;
  }
  const meta = titleMetaFor(subject.type, subject.id);
  const info = titleInfo(subject, meta);
  const view = subject.type !== "movie" && meta ? titleSeriesView(subject, meta) : null;
  const communityRating = titleCommunityRating(subject, meta);
  document.title = `${info.name} | ${DEFAULT_DOCUMENT_TITLE}`;
  const heroChanged = setTitlePart(hero, "hero", titleHeroMarkup(subject, info, view, communityRating));
  if (heroChanged) fitTitleBackdrop();
  setTitlePart(progress, "progress", titleProgressMarkup(subject, info));
  // The rating needs the details (genres, country) to know an anime from a series.
  const detailsReady = !subject.id || meta || !titleMetaState(subject.type, subject.id).pending;
  recsUi.renderTitleRating($("#title-your-rating"), detailsReady ? titleRatingSubject(subject, info, meta) : null);
  const mainChanged = setTitlePart(main, "main", subject.type === "movie" ? titleMovieMarkup(subject, info, meta) : titleChaptersSectionMarkup(subject, meta, view));
  if (mainChanged) titleRendered.chapters = "";
  // A movie's open feature section (Comics…) is filled by the feature once its markup is new.
  const movieSection = subject.type === "movie" ? main.querySelector(".title-movie-feature .title-feature-section") : null;
  if (mainChanged && movieSection) {
    clientFeatures.renderTitleSection(movieSection.dataset.featureSection, movieSection,
      { ...titleMovieSectionPayload(subject, info, meta), head: main.querySelector(".title-movie-feature .title-feature-head") });
  }
  // Films linked on AniList get a Movies tab with the seasons.
  const movies = subject.type === "series" ? titleRelatedMovies(communityRating, subject, meta) : null;
  if (view) {
    view.movies = movies?.items || [];
    renderTitleChapters();
  }
  const aboutChanged = setTitlePart(about, "about", titleAboutMarkup(subject, info));
  if (heroChanged || mainChanged || aboutChanged) refreshImages($("#view-title"));
  clientFeatures.run("title:render", { subject, info, meta, view: $("#view-title") });
}

async function openRelatedAnimeMovie(id) {
  const selected = Number(id);
  if (!Number.isSafeInteger(selected) || selected <= 0) return;
  const movie = [...titleRelatedMovieCache.values()].flatMap((entry) => entry.items || [])
    .find((item) => item.id === selected);
  if (!movie || !viewActive("title")) return;
  const route = titleRoute();
  const token = ++relatedMovieOpenToken;
  setToolStatus(TITLE_STATUS, `Finding ${movie.title} in the LVL catalog…`);
  try {
    const matched = await resolveAnimeBrowserCatalog(movie);
    if (token !== relatedMovieOpenToken || !viewActive("title")
      || titleRoute().id !== route.id || titleRoute().key !== route.key) return;
    setToolStatus(TITLE_STATUS, "");
    openTitlePage({ id: matched.id, type: matched.type, meta: matched });
  } catch (error) {
    if (token !== relatedMovieOpenToken || !viewActive("title")
      || titleRoute().id !== route.id || titleRoute().key !== route.key) return;
    setToolStatus(TITLE_STATUS, error.message || "No verified LVL movie title was found.", true);
  }
}

export function handleTitleAction(event) {
  const button = event.target.closest("[data-title-action]");
  if (!button || button.disabled || !$("#view-title")?.contains(button)) return;
  const subject = titleSubject();
  const series = subject.series;
  const action = button.dataset.titleAction;
  if (action === "back") {
    if (titleView.fromApp) window.history.back();
    else switchView("library");
  } else if (action === "related-movie") void openRelatedAnimeMovie(button.dataset.animeMovieId);
  else if (action === "library") switchView("library");
  else if (action === "play-next" && series) void resumeLibrarySeries(series.key);
  else if (action === "play-first") {
    const chapter = titleFirstChapter(catalogSeriesView);
    if (catalogSeriesView && chapter) void playCatalogChapter(catalogSeriesView, chapter, button);
  } else if (action === "add") titleAddToLibrary(subject);
  else if (action === "magnet" && series) openMagnetDialog({ seriesKey: series.key });
  else if (action === "menu" && series) openLibraryContextMenu(event, series.key, { anchor: button });
  else if (action === "find-title" && series) void titleFindCatalogMatch(series, button);
  else if (action === "retry") retryTitleMeta(subject);
  else if (action === "movie-sources") void loadTitleMovieSources({ scroll: !button.closest("#title-sources") });
}

function titleAddToLibrary(subject) {
  const meta = titleCatalogMeta(subject);
  if (!meta.id) return;
  const entry = addCatalogPlaceholder(meta, { aliases: meta.aliases, externalSource: "HOME" });
  if (!entry) return;
  markHomeTitleInLibrary(meta);
  toast(`${meta.name} added to your Library`);
  renderTitlePage();
}

// A Library title without catalog data: find it by name, then show the full page.
async function titleFindCatalogMatch(series, button) {
  if (button) { button.disabled = true; setButtonText(button, "Looking…"); }
  setToolStatus(TITLE_STATUS, `Looking for ${series.title}…`);
  try {
    const meta = await resolveCatalogMetaForLibrarySeries(series);
    // Navigation may have changed while the catalog lookup was in flight.
    // A late result must not redirect away from a different title or view.
    if (!viewActive("title") || titleSubject()?.series?.key !== series.key) return;
    setToolStatus(TITLE_STATUS, "");
    openTitlePage({ id: meta.id, type: meta.type, key: series.key, meta }, { historyMode: "replace" });
  } catch (error) {
    if (!viewActive("title") || titleSubject()?.series?.key !== series.key) return;
    setToolStatus(TITLE_STATUS, error.message || "Couldn't find this title", true);
    if (button?.isConnected) { button.disabled = false; setButtonText(button, "Find this title"); }
  }
}

// One click handler for the page body: saved sources, words, the saved-chapter list, movie
// sources; everything else goes to the chapter list (catalog rows).
export function handleTitleMainClick(event) {
  const target = event.target.closest("button");
  if (!target || target.disabled || !event.currentTarget.contains(target)) return;
  // A feature's title page: its chips switch sections; the rest is the feature's.
  if (titleRoute().feature) {
    const section = target.matches(".catalog-feature-section") ? target.dataset.featureSection : "";
    if (section && section !== titleView.featureSection) {
      titleView.featureSection = section;
      titleRendered.main = "";
      renderTitlePage();
      $(`#title-main .catalog-feature-section[data-feature-section="${CSS.escape(section)}"]`)?.focus();
    }
    return;
  }
  // A movie's section chips: "Movie" (empty id) or a feature section; the section's own clicks are the feature's.
  if (titleView.type === "movie" && target.matches(".catalog-feature-section")) {
    const section = target.dataset.featureSection || "";
    if (section !== (titleView.featureSection || "")) {
      titleView.featureSection = section;
      renderTitlePage();
      $(`#title-main .catalog-feature-section[data-feature-section="${CSS.escape(section)}"]`)?.focus();
    }
    return;
  }
  if (titleView.type === "movie" && target.closest(".title-feature-section")) return;
  if (target.matches(".title-mark-watched")) {
    markTitleChapterWatched(target.dataset.titleMarkWatched);
    return;
  }
  if (target.matches(".library-play")) {
    const resumeAtSeconds = Math.max(0, Number(target.dataset.resumeMs) || 0) / 1000;
    void playLibraryEpisode(target.dataset.libraryId, Number(target.dataset.fileIndex), { resumeAtSeconds });
  } else if (target.matches(".library-vocab")) {
    showLibraryVocabulary(target.dataset.libraryId, Number(target.dataset.fileIndex), target.dataset.kind);
  } else if (target.matches(".lib-season-option")) {
    libraryDialogView.season = target.dataset.season;
    renderTitlePage();
    $(`#title-chapters .lib-season-option[data-season="${CSS.escape(target.dataset.season)}"]`)?.focus();
  } else if (target.matches(".lib-chapter-more")) {
    const item = target.closest(".lib-chapter");
    const key = item?.dataset.chapterKey;
    if (!key) return;
    const open = !libraryDialogView.open.has(key);
    if (open) libraryDialogView.open.add(key); else libraryDialogView.open.delete(key);
    item.classList.toggle("is-open", open);
    target.setAttribute("aria-expanded", String(open));
    const panel = item.querySelector(".lib-chapter-sources");
    if (panel) panel.hidden = !open;
    titleRendered.main = "";
  } else if (target.matches(".catalog-add-best-detail")) {
    void addBestCatalogMovie(titleCatalogMeta(), target, { seriesKey: titleView.key || null });
  } else if (target.matches(".catalog-fetch-all-movie, .catalog-movie-all")) {
    if (!titleMovieView) return;
    titleMovieView.floorOnly = target.matches(".catalog-fetch-all-movie");
    renderTitleMovieSources();
  } else if (target.matches(".catalog-add-stream")) {
    const stream = titleMovieView?.visible?.[Number(target.closest("[data-stream-index]")?.dataset.streamIndex)];
    if (stream) {
      void importCatalogStream(titleCatalogMeta(), stream, { button: target, seriesKey: titleView.key || null })
        .catch((error) => setToolStatus(TITLE_STATUS, error.message || "Could not add this source", true));
    }
  } else handleCatalogChapterClick(event);
}

export let catalogSeriesView = null;
let catalogSeriesToken = 0;

// The page's chapter list for a catalog series. Kept per title, so open source panels and the
// chosen season survive re-renders; starts on the season of the next chapter to watch.
function titleSeriesView(subject, meta) {
  if (catalogSeriesView?.routeKey === titleView.routeKey && catalogSeriesView.meta.id === meta.id) {
    catalogSeriesView.meta = { ...titleCatalogMeta(subject), runtime: meta.runtime || "" };
    return catalogSeriesView;
  }
  const listed = (meta.seasons || []).filter((item) => Array.isArray(item.episodes) && item.episodes.length);
  const seasons = [...listed.filter((item) => item.season > 0), ...listed.filter((item) => item.season === 0)];
  if (!seasons.length) return null;
  const nextCode = String((subject.series ? seriesNextUp(subject.series) : null)?.episode?.code || "").toUpperCase();
  const initial = seasons.find((item) => nextCode.startsWith(`S${String(item.season).padStart(2, "0")}E`)) || seasons[0];
  const nextIndex = initial.episodes.findIndex((episode) => chapterCode(initial.season, episode.episode) === nextCode);
  catalogSeriesView = {
    routeKey: titleView.routeKey,
    meta: { ...titleCatalogMeta(subject), runtime: meta.runtime || "" },
    seasons,
    season: initial.season,
    shown: Math.max(CHAPTER_PAGE, nextIndex + 12),
    sources: new Map(),
    seasonPacks: new Map(),
    packsActive: false,
    // Films AniList links to this anime (set on each render) and whether their tab is open.
    movies: [],
    moviesActive: false,
    // ?section=manga opens a feature section first (once; the chips change it after).
    featureSection: titleView.featureSection || null,
    busy: false,
  };
  return catalogSeriesView;
}
