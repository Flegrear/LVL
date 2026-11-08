// A title's chapter list and its sources.
import {
  artworkFallback, badgeMarkup, buttonMarkup, emptyMarkup, escapeHtml, icon, metaMarkup,
  refreshImages,
} from "../ui/ui.js";
import {
  absoluteEpisodeNumber, chapterCode, chapterFileIndex, chapterPlayOrder, groupChapterSources,
  heightFromQualityLabel, meetsSourceFloor, packChapterMap,
} from "../../shared/media/series-sources.js";
import { t } from "../ui/ui-i18n.js";
import { CHAPTER_PAGE, clientFeatures, formatBytes, TITLE_STATUS, titleView } from "../../app.js";
import { $, setToolStatus } from "../app/dom.js";
import { fetchJson } from "../app/http.js";
import { viewActive } from "../app/navigation.js";
import {
  playbackLoadRequestId, playLibraryEpisode, releaseTorrentSession, resolveTorrentMagnet,
} from "../player/torrent-playback.js";
import { explicitlyUnwatchedChapter, manuallyWatchedChapter } from "../watch/watched-status.js";
import {
  buildLibrarySeries, catalogMediaKind, groupLibraryChapters, libraryEntryById, librarySourceDetails,
  normalizeLibrarySourceMeta, upsertLibrarySession,
} from "../library/library-data.js";
import {
  libraryChapterName, libraryCodecLabel, libraryOriginText, renderLibrary,
  repeatedLibrarySourceIndexes, repeatedLibrarySourceTag, updateLibrarySummary,
} from "../library/library-page.js";
import {
  catalogSeriesView, renderTitlePage, titleRelatedMoviesMarkup, titleRendered, titleSourceRouteToken, titleSubject,
} from "./title-page.js";
import {
  buttonText, catalogKindText, catalogSeriesKey, compareLibrarySourceRefsByPeers, setButtonText,
  streamProviderBadges,
} from "../catalog/catalog-search.js";

const SEASON_PACKS_SHOWN = 6;
let catalogSourceRequestSerial = 0;

function catalogSeasonLabel(season) {
  return Number(season) === 0 ? "Specials" : `Season ${season}`;
}

function formatChapterDate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return "";
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  // Reuse one formatter across long chapter lists instead of rebuilding it for every row.
  formatChapterDate.format ||= new Intl.DateTimeFormat("en-US", {
    year: "numeric", month: "short", day: "numeric", timeZone: "UTC",
  });
  return Number.isNaN(date.getTime()) ? "" : formatChapterDate.format.format(date);
}

export function chapterUpcoming(episode) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(episode?.released || "")) && Date.parse(`${episode.released}T00:00:00Z`) > Date.now();
}

// Library key for a catalog series: the saved series with this catalog id, then the Library title
// the page is about, then a key from the title.
function librarySeriesKeyForCatalog(meta) {
  const groups = buildLibrarySeries();
  return groups.find((item) => meta?.id && item.catalogId === meta.id)?.key
    || (titleView.key && meta?.id === titleView.id && groups.some((item) => item.key === titleView.key) ? titleView.key : "")
    || catalogSeriesKey(meta);
}

// Saved chapters of a catalog series: chapter code (S01E05) → its sources (best first), the one
// last watched and its progress.
function savedCatalogChapterGroups(meta) {
  const key = librarySeriesKeyForCatalog(meta);
  const series = buildLibrarySeries().find((item) => item.key === key);
  const groups = new Map();
  if (!series || series.type === "movie") return groups;
  [...series.seasons.values()].forEach((refs) => groupLibraryChapters(refs).forEach((chapter) => {
    const code = String(chapter.code || "").toUpperCase();
    if (!/^S\d{2}E\d{2,4}$/.test(code) || groups.has(code)) return;
    const sorted = chapter.sources.slice().sort(compareLibrarySourceRefsByPeers);
    if (!sorted.length) return;
    const resume = chapter.sources
      .filter(({ episode }) => episode.progress?.durationMs > 0)
      .sort((a, b) => (b.episode.progress.updatedAt || 0) - (a.episode.progress.updatedAt || 0))[0] || null;
    groups.set(code, { best: sorted[0], refs: sorted, resume, progress: resume?.episode.progress || null });
  }));
  return groups;
}

export function savedCatalogChapters(meta) {
  return new Map([...savedCatalogChapterGroups(meta)].map(([code, group]) => [code, group.best]));
}

export function chapterResumeMs(progress, series = null, code = "") {
  // Unwatch retains the historical position, but near-end resumes would never
  // re-arm watched completion. Replay from the beginning in that case.
  if (progress?.durationMs > 0 && progress.positionMs > progress.durationMs * 0.8
    && explicitlyUnwatchedChapter(series, String(code).toUpperCase())) return 0;
  return progress && !progress.finished && progress.durationMs > 0 ? Math.max(0, progress.positionMs - 5000) : 0;
}

export function renderTitleChapters({ focusSelector = "" } = {}) {
  const view = catalogSeriesView;
  const container = $("#title-chapters");
  if (!view || !container) return;
  const { meta, seasons } = view;
  const current = seasons.find((item) => item.season === view.season) || seasons[0];
  const groups = savedCatalogChapterGroups(meta);
  const codeOf = (episode) => chapterCode(current.season, episode.episode);
  const seriesForMarks = { key: librarySeriesKeyForCatalog(meta) };
  const savedHere = current.episodes.filter((episode) => groups.has(codeOf(episode))).length;
  const watchedHere = current.episodes.filter((episode) => groups.get(codeOf(episode))?.progress?.finished
    || manuallyWatchedChapter(seriesForMarks, codeOf(episode))).length;
  const count = Number(current.count) || current.episodes.length;
  const chapters = current.episodes.slice(0, view.shown);
  const remaining = current.episodes.length - chapters.length;
  const packState = view.seasonPacks.get(current.season);
  // Feature sections (Manga…) sit with the seasons; the feature fills the list area itself.
  const hasFeatures = typeof clientFeatures !== "undefined";
  const sectionPayload = hasFeatures ? { meta, subject: titleSubject() } : { meta };
  const featureChips = hasFeatures ? clientFeatures.titleSectionChips(sectionPayload) : [];
  const featureOpen = Boolean(view.featureSection && featureChips.some((chip) => chip.id === view.featureSection));
  const movies = view.movies || [];
  const moviesOpen = !featureOpen && Boolean(view.moviesActive && movies.length);
  const packOpen = !featureOpen && !moviesOpen && Boolean(view.packsActive);
  const packPanelId = `catalog-season-packs-${current.season}`;
  const packButton = `<button class="ui-chip catalog-season-pack-toggle" type="button" aria-pressed="${packOpen}" aria-controls="${packPanelId}">${icon("library")}<span>Packs</span>${packState?.status === "ready" ? `<span class="ui-chip__count">${packState.rows.length}</span>` : ""}</button>`;
  const moviesButton = movies.length ? `<button class="ui-chip catalog-movies-toggle" type="button" aria-pressed="${moviesOpen}">${icon("film")}<span>Movies</span><span class="ui-chip__count">${movies.length}</span></button>` : "";
  const featureButtons = featureChips.map((chip) => `<button class="ui-chip catalog-feature-section" type="button" data-feature-section="${escapeHtml(chip.id)}" aria-pressed="${featureOpen && view.featureSection === chip.id}">${escapeHtml(t(chip.label))}${Number.isFinite(chip.count) ? `<span class="ui-chip__count">${chip.count}</span>` : ""}</button>`).join("");
  if (featureOpen) {
    // Same heading and chips as a season, so switching to a feature section moves nothing.
    const markup = `<div class="title-section__head">
      <h2 class="title-section__title" id="title-chapters-heading">Chapters</h2>
      <div class="title-feature-head"></div>
    </div>
    <div class="ui-chip-row catalog-season-switch" role="group" aria-label="Season and pack sources">
      ${seasons.map((item) => `<button class="ui-chip catalog-season-option" type="button" data-season="${item.season}" aria-pressed="false">${escapeHtml(catalogSeasonLabel(item.season))}<span class="ui-chip__count">${Number(item.count) || item.episodes.length}</span></button>`).join("")}
      ${packButton}
      ${moviesButton}
      ${featureButtons}
    </div><div class="title-feature-section" data-feature-section="${escapeHtml(view.featureSection)}"></div>`;
    if (titleRendered.chapters !== markup) {
      titleRendered.chapters = markup;
      container.innerHTML = markup;
      clientFeatures.renderTitleSection(view.featureSection, container.querySelector(".title-feature-section"), { ...sectionPayload, head: container.querySelector(".title-feature-head") });
    }
    if (focusSelector) container.querySelector(focusSelector)?.focus();
    return;
  }
  const listOpen = !packOpen && !moviesOpen;
  const markup = `<div class="title-section__head">
      <h2 class="title-section__title" id="title-chapters-heading">${moviesOpen ? "Movies" : packOpen ? "Packs" : "Chapters"}</h2>
      ${listOpen ? `<p class="catalog-chapters-note">${count} chapter${count === 1 ? "" : "s"}${savedHere ? `<span>${savedHere} in your Library</span>` : ""}${watchedHere ? `<span>${watchedHere} watched</span>` : ""}</p>` : ""}
      ${listOpen ? `<button class="ui-btn ui-btn--secondary ui-btn--sm catalog-fetch-all" type="button"${view.fetchAll?.running ? " disabled" : ""}><span>${escapeHtml(catalogFetchAllLabel(view, chapters.length))}</span></button>` : ""}
    </div>
    <div class="ui-chip-row catalog-season-switch" role="group" aria-label="Season and pack sources">
      ${seasons.map((item) => `<button class="ui-chip catalog-season-option" type="button" data-season="${item.season}" aria-pressed="${listOpen && item.season === current.season}">${escapeHtml(catalogSeasonLabel(item.season))}<span class="ui-chip__count">${Number(item.count) || item.episodes.length}</span></button>`).join("")}
      ${packButton}
      ${moviesButton}
      ${featureButtons}
    </div>
    ${moviesOpen
      ? `<div class="catalog-movies-panel">${titleRelatedMoviesMarkup(movies)}</div>`
      : packOpen
      ? `<div class="catalog-season-pack-panel" id="${packPanelId}">${catalogSeasonPacksMarkup(packState)}</div>`
      : `<ol class="catalog-chapter-list" aria-label="${escapeHtml(`${meta.name}, ${catalogSeasonLabel(current.season)}`)}">${chapters.map((episode) => catalogChapterMarkup(view, current.season, episode, groups)).join("")}</ol>
         ${remaining > 0 ? `<button class="ui-btn ui-btn--ghost catalog-chapters-more" type="button"><span>Show ${Math.min(CHAPTER_PAGE, remaining)} more</span></button>` : ""}`}`;
  if (titleRendered.chapters !== markup) {
    titleRendered.chapters = markup;
    container.innerHTML = markup;
    refreshImages(container);
  }
  if (focusSelector) container.querySelector(focusSelector)?.focus();
}

export function catalogChapterTarget(view, chapter) {
  return {
    season: chapter.season,
    episode: chapter.episode,
    absoluteEpisode: absoluteEpisodeNumber(view.seasons, chapter.season, chapter.episode),
  };
}

function catalogChapterFromNode(view, node) {
  const item = node?.closest?.(".catalog-chapter");
  if (!item || !view) return null;
  const season = view.seasons.find((entry) => entry.season === Number(item.dataset.season));
  const episode = season?.episodes.find((entry) => entry.id === item.dataset.videoId);
  return episode ? { ...episode, season: season.season, item } : null;
}

function catalogChapterMarkup(view, season, episode, saved) {
  const code = chapterCode(season, episode.episode);
  const group = saved.get(code) || null;
  const sources = view.sources.get(episode.id);
  const open = Boolean(sources?.open);
  const panelId = `catalog-chapter-sources-${String(episode.id).replace(/[^a-z0-9]+/gi, "-")}`;
  const date = formatChapterDate(episode.released);
  const upcoming = chapterUpcoming(episode);
  const seriesName = view.meta.name;
  const progress = group?.progress || null;
  const markSeries = { key: librarySeriesKeyForCatalog(view.meta) };
  const watched = !explicitlyUnwatchedChapter(markSeries, code)
    && (Boolean(progress?.finished) || manuallyWatchedChapter(markSeries, code));
  const inLibrary = Boolean(titleSubject().series);
  const ratio = progress && !watched && progress.durationMs > 0 ? Math.min(1, progress.positionMs / progress.durationMs) : 0;
  const details = group ? librarySourceDetails(group.best.entry, group.best.episode) : null;
  const thumb = episode.thumbnail
    ? `<img src="${escapeHtml(episode.thumbnail)}" alt="" loading="lazy" decoding="async" data-fallback="wide" data-fallback-title="${escapeHtml(seriesName)}" />`
    : `<img src="${escapeHtml(artworkFallback(seriesName, { ratio: "wide", label: season ? `S${season} E${episode.episode}` : `Special ${episode.episode}` }))}" alt="" />`;
  const facts = metaMarkup([
    season ? `Chapter ${episode.episode}` : `Special ${episode.episode}`,
    date,
    view.meta.runtime || "",
    details && details.quality !== "UNKNOWN" ? details.quality : "",
    watched ? "Watched" : ratio ? `${Math.max(1, Math.round((progress.durationMs - progress.positionMs) / 60_000))} min left` : "",
  ], { rating: episode.rating || "" });
  const badges = [upcoming ? badgeMarkup("Upcoming") : "", group ? badgeMarkup("Source saved", { variant: "solid" }) : ""].join("");
  const action = ratio ? "Resume" : "Play";
  const playLabel = `${action} chapter ${episode.episode}: ${episode.name}${group ? "" : " (finds the best source first)"}`;
  return `<li class="catalog-chapter${group ? " is-saved" : ""}${open ? " is-open" : ""}${watched ? " is-watched" : ""}" data-video-id="${escapeHtml(episode.id)}" data-season="${season}" data-episode="${episode.episode}"${inLibrary ? ` data-chapter-code="${escapeHtml(code)}" tabindex="0" aria-keyshortcuts="Shift+F10"` : ""}>
    <div class="catalog-chapter-row">
      <span class="catalog-chapter-thumb">${thumb}${ratio ? `<span class="lib-chapter-progress" aria-hidden="true"><span style="width:${Math.round(ratio * 100)}%"></span></span>` : ""}${watched ? `<span class="lib-chapter-watched" aria-hidden="true">${icon("check")}</span>` : ""}</span>
      <div class="catalog-chapter-copy">
        <span class="catalog-chapter-code">${facts}${badges}</span>
        <strong>${escapeHtml(episode.name)}</strong>
        ${episode.overview ? `<p>${escapeHtml(episode.overview)}</p>` : ""}
      </div>
      <div class="catalog-chapter-actions">
        <button class="ui-btn ui-btn--primary ui-btn--sm catalog-chapter-play" type="button" aria-label="${escapeHtml(playLabel)}"${upcoming && !group ? " disabled" : ""}>${icon("play")}<span>${action}</span></button>
        ${inLibrary ? `<button class="ui-btn ui-btn--ghost ui-btn--sm title-mark-watched" type="button" data-title-mark-watched="${escapeHtml(code)}">${watched ? "Mark as not watched" : "Mark as watched"}</button>` : ""}
        <button class="ui-btn ui-btn--ghost ui-btn--sm catalog-chapter-toggle" type="button" aria-expanded="${open}" aria-controls="${panelId}" aria-label="${escapeHtml(`Sources for chapter ${episode.episode}`)}"><span>Sources</span>${icon("chevron-down")}</button>
      </div>
    </div>
    <div class="catalog-chapter-sources" id="${panelId}"${open ? "" : " hidden"}>${open ? catalogChapterPanelMarkup(view, code, sources) : ""}</div>
  </li>`;
}

// A chapter's panel: the sources saved in the Library (Play each), then torrents found for it
// (right away for an unsaved chapter, on request for a saved one).
function catalogChapterPanelMarkup(view, code, sources) {
  const group = savedCatalogChapterGroups(view.meta).get(code);
  if (!group) return catalogChapterSourcesMarkup(sources);
  const repeated = repeatedLibrarySourceIndexes(group.refs);
  const saved = `<section class="catalog-source-group">
      <div class="catalog-sources-head catalog-sources-head--group"><h4>Saved</h4><span class="ui-chip__count">${group.refs.length}</span></div>
      <div class="title-saved-sources">${group.refs.map(({ entry, episode }, index) => {
        const item = librarySourceDetails(entry, episode);
        const origin = libraryOriginText(item);
        const resumeAt = chapterResumeMs(episode.progress, { key: librarySeriesKeyForCatalog(view.meta) }, code);
        return `<div class="lib-source"><div><span class="lib-source-title"><strong title="${escapeHtml(item.releaseName)}">${escapeHtml(origin.release)}</strong>${repeatedLibrarySourceTag(repeated.has(index))}</span>${metaMarkup([origin.pack ? "From a pack" : "", item.providers, item.quality !== "UNKNOWN" ? item.quality : "", libraryCodecLabel(item.codec), item.peers ? `${item.peers} peers` : "", episode.length ? formatBytes(episode.length) : ""])}</div>${buttonMarkup({ label: resumeAt ? "Resume" : "Play", variant: "secondary", size: "sm", icon: "play", className: "library-play", attrs: { "data-library-id": entry.id, "data-file-index": episode.fileIndex, "data-resume-ms": resumeAt } })}</div>`;
      }).join("")}</div>
    </section>`;
  const lookup = sources?.status && sources.status !== "idle"
    ? catalogChapterSourcesMarkup(sources)
    : `<div class="title-source-actions">${buttonMarkup({ label: "Find more sources", variant: "ghost", size: "sm", icon: "search", className: "catalog-source-find" })}</div>`;
  return saved + lookup;
}

function catalogSourceKindPresentation(stream) {
  if (stream.contentType === "movie") return { label: "Movie", action: "Add" };
  const sourceKind = stream.sourceKind === "season-pack" ? "season-pack"
    : stream.sourceKind === "multi-episode-pack" ? "multi-episode-pack"
      : "episode";
  const coverage = Number(stream.coverage) || (Array.isArray(stream.episodes) ? stream.episodes.length : 1);
  const total = Number(stream.totalSeasonEpisodes) || 0;
  const covers = total ? `${coverage} of ${total} chapters` : `${coverage} chapters`;
  if (sourceKind === "season-pack") return { label: `Season pack, ${covers}`, action: "Add pack" };
  if (sourceKind === "multi-episode-pack") return { label: `Pack, ${covers}`, action: "Add pack" };
  return { label: "Episode file", action: "Add" };
}

// Source facts; unknown values are left out. Drawn as a facts row (thin rules, no dots).
function streamMetaParts(stream, sizeDetail = "") {
  const known = (value) => value && !/^unknown$/i.test(String(value));
  return [
    known(stream.quality) ? stream.quality : "",
    known(stream.codec) ? libraryCodecLabel(stream.codec) : "",
    stream.audioLanguages?.length ? stream.audioLanguages.join(", ") : "",
    stream.peers ? `${stream.peers} peer${stream.peers === 1 ? "" : "s"}` : "",
    sizeDetail,
  ].filter(Boolean);
}

export function catalogStreamRowMarkup(stream, index, { seriesKey = null, compact = false, contentType = null, requestSerial = null } = {}) {
  const releaseName = String(stream.title || "Torrent source").split("\n")[0];
  const kind = catalogSourceKindPresentation({ ...stream, contentType: contentType || stream.contentType });
  const isMovie = (contentType || stream.contentType) === "movie";
  const size = stream.sizeBytes ? formatBytes(stream.sizeBytes) : "";
  return `<article class="catalog-stream-row${compact ? " compact" : ""}" data-stream-index="${index}"${requestSerial === null ? "" : ` data-source-request="${requestSerial}"`} ${seriesKey ? `data-series-key="${escapeHtml(seriesKey)}"` : ""}>
    <span class="catalog-stream-rank">${index + 1}</span>
    <div class="catalog-stream-copy">
      <strong title="${escapeHtml(releaseName)}">${escapeHtml(releaseName)}</strong>
      ${metaMarkup([isMovie ? "" : kind.label, ...streamMetaParts(stream, size)])}
      ${streamProviderBadges(stream)}
    </div>
    ${isMovie && sourceInLibrary(stream)
      ? buttonMarkup({ label: "Added", variant: "ghost", size: "sm", icon: "check", className: "catalog-add-stream", attrs: { disabled: true } })
      : buttonMarkup({ label: kind.action, variant: index === 0 ? "primary" : "secondary", size: "sm", icon: "plus", className: "catalog-add-stream" })}
  </article>`;
}

function catalogChapterSourcesMarkup(sources) {
  if (sources?.status === "error") {
    return `<p class="catalog-chapter-sources-status is-error" role="alert">${escapeHtml(sources.error || "The source lookup failed")}</p>`
      + buttonMarkup({ label: "Try again", variant: "secondary", size: "sm", icon: "refresh", className: "catalog-source-retry" });
  }
  if (!sources || sources.status !== "ready" || !sources.groups) return '<p class="catalog-chapter-sources-status" role="status">Finding sources…</p>';
  const { episodeFiles, others, unplayable, nonmatching } = sources.groups;
  if (sources.floorOnly) {
    // Bulk episode lookup must not put season-wide torrents under every chapter.
    const listed = [...episodeFiles, ...others]
      .map((stream) => ({ stream, rowIndex: sources.rows.indexOf(stream) }))
      .filter(({ stream }) => meetsSourceFloor(stream))
      .sort((a, b) => (Number(b.stream.height) || heightFromQualityLabel(b.stream.quality) || 0) - (Number(a.stream.height) || heightFromQualityLabel(a.stream.quality) || 0)
        || (Number(b.stream.peers) || 0) - (Number(a.stream.peers) || 0));
    const hidden = episodeFiles.length + others.length - listed.length;
    return `<section class="catalog-source-group">
      <div class="catalog-sources-head catalog-sources-head--group"><h4>${listed.length} episode magnet${listed.length === 1 ? "" : "s"}</h4><span class="catalog-sources-note">720p or better, 2+ peers</span>${hidden ? buttonMarkup({ label: `Show all ${episodeFiles.length + others.length}`, variant: "ghost", size: "sm", className: "catalog-source-all" }) : ""}</div>
      ${listed.length ? `<div class="catalog-stream-list">${listed.map(({ stream, rowIndex }, position) => catalogChapterSourceRowMarkup(stream, rowIndex, position, sources.requestSerial)).join("")}</div>` : '<p class="catalog-chapter-sources-status">No single-episode sources meet the quality and peer requirements.</p>'}
    </section>`;
  }
  if (!episodeFiles.length && !others.length) {
    return emptyMarkup({ compact: true, title: "No single-episode sources found", text: [nonmatching ? `${nonmatching} different-episode result${nonmatching === 1 ? "" : "s"} omitted.` : "", unplayable ? `${unplayable} archive${unplayable === 1 ? "" : "s"} skipped.` : ""].filter(Boolean).join(" ") });
  }
  const rows = (list, offset) => list.map((stream, index) => catalogChapterSourceRowMarkup(stream, sources.rows.indexOf(stream), offset + index, sources.requestSerial)).join("");
  const group = (title, list, offset) => `<section class="catalog-source-group">
      <div class="catalog-sources-head catalog-sources-head--group"><h4>${title}</h4><span class="ui-chip__count">${list.length}</span></div>
      <div class="catalog-stream-list">${rows(list, offset)}</div>
    </section>`;
  return [
    episodeFiles.length ? group("Episode files", episodeFiles, 0) : "",
    others.length ? group("Other single-file matches", others, episodeFiles.length) : "",
  ].join("");
}

function catalogSeasonPacksMarkup(state) {
  if (!state || state.status === "loading") return '<p class="catalog-chapter-sources-status" role="status">Finding packs…</p>';
  if (state.status === "error") return `<p class="catalog-chapter-sources-status is-error" role="alert">${escapeHtml(state.error || "Pack lookup failed")}</p>`
    + buttonMarkup({ label: "Try again", variant: "secondary", size: "sm", icon: "refresh", className: "catalog-season-pack-retry" });
  const rows = state.rows || [];
  const visible = state.showAll ? rows : rows.slice(0, SEASON_PACKS_SHOWN);
  return `<section class="catalog-source-group" aria-label="Packs">
    ${visible.length ? `<div class="catalog-stream-list">${visible.map((stream, index) => catalogChapterSourceRowMarkup(stream, index)).join("")}</div>` : emptyMarkup({ compact: true, title: "No packs found", text: "Try a different season or an individual chapter." })}
    ${rows.length > visible.length ? buttonMarkup({ label: `Show all ${rows.length} packs`, variant: "ghost", size: "sm", className: "catalog-season-pack-more" }) : ""}
  </section>`;
}

function catalogChapterSourceRowMarkup(stream, rowIndex, position = rowIndex, requestSerial = null) {
  const info = stream.chapterSource;
  const releaseName = String(stream.title || "Torrent source").split("\n")[0];
  const size = stream.sizeBytes ? formatBytes(stream.sizeBytes) : "";
  // Providers may report either a torrent total or one file's size. Do not
  // present the unverified provider figure as a measured chapter/pack total.
  const fileDetail = size ? (info.kind === "pack" ? `${size} reported size` : size) : "";
  const added = sourceInLibrary(stream);
  return `<article class="catalog-stream-row compact" data-row-index="${rowIndex}"${requestSerial === null || requestSerial === undefined ? "" : ` data-source-request="${requestSerial}"`}>
    <span class="catalog-stream-rank">${position + 1}</span>
    <div class="catalog-stream-copy">
      <strong title="${escapeHtml(releaseName)}">${escapeHtml(releaseName)}</strong>
      ${metaMarkup([catalogKindText(info.label), ...streamMetaParts(stream, fileDetail)])}
      ${streamProviderBadges(stream)}
    </div>
    <div class="catalog-stream-actions">
      ${buttonMarkup({ label: "Play", variant: "primary", size: "sm", icon: "play", className: "catalog-source-play" })}
      ${added
        ? buttonMarkup({ label: "Added", variant: "ghost", size: "sm", icon: "check", className: "catalog-source-add", attrs: { disabled: true } })
        : buttonMarkup({ label: info.kind === "pack" ? "Add pack" : "Add", variant: "secondary", size: "sm", icon: "plus", className: "catalog-source-add" })}
    </div>
  </article>`;
}

// This torrent is in the Library already (with the provider's file for this chapter, if it named one).
function sourceInLibrary(stream) {
  const entry = libraryEntryById(String(stream?.infoHash || "").toLowerCase());
  if (!entry) return false;
  const fileIndex = Number.isInteger(stream.fileIdx) ? stream.fileIdx : null;
  return fileIndex === null || (entry.episodes || []).some((episode) => Number(episode.fileIndex) === fileIndex);
}

function renderCatalogChapterPanel(item, sources) {
  const panel = item?.querySelector(".catalog-chapter-sources");
  if (!panel || !catalogSeriesView) return;
  if (catalogSeriesView.sources.get(item.dataset.videoId) !== sources) return;
  const open = Boolean(sources?.open);
  item.classList.toggle("is-open", open);
  item.querySelector(".catalog-chapter-toggle")?.setAttribute("aria-expanded", String(open));
  panel.hidden = !open;
  panel.innerHTML = open ? catalogChapterPanelMarkup(catalogSeriesView, chapterCode(Number(item.dataset.season), Number(item.dataset.episode)), sources) : "";
  // The list's markup no longer matches what was last rendered in full.
  titleRendered.chapters = "";
}

function catalogChapterItem(videoId) {
  return [...document.querySelectorAll("#title-chapters .catalog-chapter")].find((node) => node.dataset.videoId === videoId) || null;
}

async function loadCatalogChapterSources(view, chapter, { force = false } = {}) {
  const current = view.sources.get(chapter.id);
  const routeToken = titleSourceRouteToken();
  if (current?.status === "ready" && !force && current.routeToken === routeToken) return current;
  if (current?.promise && !force && current.routeToken === routeToken) return current.promise;
  const sources = {
    open: Boolean(current?.open), floorOnly: Boolean(current?.floorOnly), status: "loading",
    requestSerial: ++catalogSourceRequestSerial, routeToken,
  };
  const ownsCache = () => view.sources.get(chapter.id) === sources && catalogSeriesView === view
    && titleSourceRouteToken() === routeToken
    && (!view.routeKey || view.routeKey === titleView.routeKey);
  const mayPaint = () => ownsCache() && viewActive("title");
  view.sources.set(chapter.id, sources);
  if (mayPaint()) renderCatalogChapterPanel(catalogChapterItem(chapter.id), sources);
  sources.promise = (async () => {
    try {
      const data = await fetchJson(`/api/streams?type=series&id=${encodeURIComponent(chapter.id)}`);
      if (!ownsCache()) return null;
      sources.groups = groupChapterSources(data.streams || [], catalogChapterTarget(view, chapter));
      sources.rows = Object.freeze([...sources.groups.episodeFiles, ...sources.groups.packs, ...sources.groups.others]);
      sources.status = "ready";
    } catch (error) {
      if (!ownsCache()) return null;
      sources.status = "error";
      sources.error = error.message || "Source lookup failed";
    } finally {
      delete sources.promise;
    }
    if (mayPaint()) renderCatalogChapterPanel(catalogChapterItem(chapter.id), sources);
    return sources;
  })();
  return sources.promise;
}

// Providers accept episode IDs, not season IDs. Reuse the selected season's first released
// episode lookup, but display its packs in a mutually exclusive season-source tab.
async function loadCatalogSeasonPacks(view, seasonNumber, { force = false } = {}) {
  const mayPaint = () => typeof viewActive !== "function" || viewActive("title");
  const season = view.seasons.find((item) => item.season === seasonNumber);
  const first = season?.episodes.find((episode) => !chapterUpcoming(episode));
  if (!first) {
    const empty = { status: "ready", rows: [], showAll: false, chapter: null };
    view.seasonPacks.set(seasonNumber, empty);
    if (catalogSeriesView === view && mayPaint() && view.season === seasonNumber && view.packsActive) renderTitleChapters();
    return empty;
  }
  const current = view.seasonPacks.get(seasonNumber);
  if (current?.status === "ready" && !force) return current;
  if (current?.promise && !force) return current.promise;
  const state = { status: "loading", rows: [], showAll: Boolean(current?.showAll), chapter: { ...first, season: seasonNumber } };
  view.seasonPacks.set(seasonNumber, state);
  if (catalogSeriesView === view && mayPaint() && view.season === seasonNumber) renderTitleChapters();
  state.promise = (async () => {
    try {
      let sources = await loadCatalogChapterSources(view, state.chapter, { force });
      if (view.seasonPacks.get(seasonNumber) !== state || catalogSeriesView !== view) return null;
      // If a newer episode lookup superseded this one, join its result.
      if (!sources) sources = await loadCatalogChapterSources(view, state.chapter);
      if (view.seasonPacks.get(seasonNumber) !== state || catalogSeriesView !== view || !sources) return null;
      if (sources.status !== "ready") throw new Error(sources.error || "Pack lookup failed");
      state.rows = sources.groups.packs;
      state.status = "ready";
    } catch (error) {
      if (view.seasonPacks.get(seasonNumber) !== state || catalogSeriesView !== view) return null;
      state.status = "error";
      state.error = error.message || "Pack lookup failed";
    } finally {
      delete state.promise;
    }
    if (catalogSeriesView === view && mayPaint() && view.season === seasonNumber && view.seasonPacks.get(seasonNumber) === state) renderTitleChapters();
    return state;
  })();
  return state.promise;
}

function chapterSourceMeta(stream, chapter) {
  const info = stream.chapterSource || {};
  return normalizeLibrarySourceMeta({
    provider: stream.provider,
    providers: stream.providers || [stream.provider],
    releaseName: String(stream.title || "").split("\n")[0],
    quality: stream.quality,
    codec: stream.codec,
    peers: stream.peers,
    sizeBytes: stream.sizeBytes,
    audioLanguages: stream.audioLanguages || [],
    filename: stream.filename || "",
    score: stream.score,
    sourceKind: info.kind === "pack" ? "pack-file" : "episode",
    packLabel: info.kind === "pack" ? info.label : "",
    coverage: 1,
    coveredEpisodes: [Number(chapter.episode)],
  });
}

export let manualCatalogPlaybackId = 0;

// Saves one chapter from one source: resolves torrent metadata, finds the chapter's file, and adds
// a Library entry that holds only that file (packs included). With play, starts it right away.
export async function addCatalogChapterSource(view, chapter, stream, { play = false, button = null, quiet = false, stillCurrent = null, onPlaybackStart = null } = {}) {
  if (!stream?.magnet) throw new Error("This source did not provide a usable torrent hash.");
  // Direct catalog clicks must claim playback before waiting for torrent metadata.
  // Automatic Up Next passes its own ownership predicate instead.
  const manualIntent = play && !stillCurrent ? ++manualCatalogPlaybackId : 0;
  const originView = manualIntent ? (viewActive("watch") ? "watch" : viewActive("title") ? "title" : "") : "";
  const canContinue = () => (!manualIntent || (manualIntent === manualCatalogPlaybackId
    && (!originView || viewActive(originView)))) && (!stillCurrent || stillCurrent());
  const { meta } = view;
  const code = chapterCode(chapter.season, chapter.episode);
  const providerIndex = Number.isInteger(stream.fileIdx) && stream.fileIdx >= 0 ? stream.fileIdx : null;
  const oldText = buttonText(button);
  if (button) { button.disabled = true; setButtonText(button, "Opening…"); }
  let session = null;
  let keepSession = false;
  try {
    session = await resolveTorrentMagnet(stream.magnet, (current, elapsed) => {
      if (!quiet) setToolStatus(TITLE_STATUS, `Opening ${libraryChapterName({ code }) || code}… ${elapsed} s${current.numPeers ? `, ${current.numPeers} peer${current.numPeers === 1 ? "" : "s"}` : ""}`);
    }, { timeoutMs: 25_000, preferredFileIndex: providerIndex });
    if (!canContinue()) throw new DOMException("Playback selection changed", "AbortError");
    const fileIndex = providerIndex ?? chapterFileIndex(session.files, catalogChapterTarget(view, chapter));
    const file = (session.files || []).find((item) => Number(item.index) === Number(fileIndex));
    if (fileIndex === null || !file?.video) throw new Error(`Couldn't find ${code}'s file in that source. Choose another one.`);
    // A pack brings all of its chapters into the Library (nothing is downloaded until one plays).
    const fileIndexes = [file.index];
    const chapterLabels = { [String(file.index)]: { code, title: chapter.name } };
    if (stream.chapterSource?.kind === "pack") {
      const episodesBySeason = new Map(view.seasons.map((item) => [item.season, new Map(item.episodes.map((episode) => [Number(episode.episode), episode]))]));
      for (const [index, placed] of packChapterMap(session.files, view.seasons)) {
        if (Number(index) === Number(file.index)) continue;
        const listed = episodesBySeason.get(placed.season)?.get(placed.episode);
        fileIndexes.push(index);
        chapterLabels[String(index)] = { code: chapterCode(placed.season, placed.episode), title: listed?.name || "" };
      }
    }
    const entry = upsertLibrarySession(session, stream.magnet, {
      seriesKeyOverride: librarySeriesKeyForCatalog(meta),
      displayTitleOverride: meta.name,
      coverUrlOverride: meta.poster || "",
      catalogId: meta.id,
      catalogType: "series",
      mediaKind: catalogMediaKind(meta),
      sourceMeta: chapterSourceMeta(stream, chapter),
      aliases: meta.aliases || [meta.name],
      fileIndexes,
      chapterLabels,
      render: false,
    });
    if (!entry) throw new Error("That source has no supported video file for this chapter.");
    if (play) {
      if (!canContinue()) throw new DOMException("Playback selection changed", "AbortError");
      const expectedLoadId = playbackLoadRequestId + 1;
      onPlaybackStart?.(expectedLoadId);
      const started = await playLibraryEpisode(entry.id, Number(file.index));
      if (!started && playbackLoadRequestId !== expectedLoadId)
        throw new DOMException("Playback selection changed", "AbortError");
      if (!started) throw new Error(`Couldn't start ${code} from that source.`);
      keepSession = true; // Keep it only after playback accepted this source.
      return entry;
    }
    if (button) { setButtonText(button, "Added"); button.dataset.done = "1"; }
    const packChapters = fileIndexes.length;
    if (!quiet) setToolStatus(TITLE_STATUS, packChapters > 1
      ? `${packChapters} chapters from this pack added to your Library`
      : `${libraryChapterName({ code }) || code} added to your Library`);
    if ($("#view-library")?.classList.contains("is-active")) renderLibrary();
    else updateLibrarySummary();
    if (catalogSeriesView === view) {
      renderTitlePage();
      catalogChapterItem(chapter.id)?.querySelector(".catalog-chapter-toggle")?.focus({ preventScroll: true });
    }
    return entry;
  } finally {
    if (session?.id && !keepSession) await releaseTorrentSession(session.id);
    if (button && button.dataset.done !== "1") { button.disabled = false; setButtonText(button, oldText); }
  }
}

// A newer user action (another source, or an episode edit) makes a lookup in flight stale.
export function invalidateManualCatalogPlayback() {
  manualCatalogPlaybackId += 1;
}

function catalogFetchAllLabel(view, shownCount) {
  const run = view.fetchAll;
  if (run?.running && run.season === view.season) return `Fetching ${run.done} of ${run.total}…`;
  if (run?.season === view.season && run.done) return "Fetch again";
  return shownCount > 1 ? "Fetch episode torrents" : "Fetch episode torrent";
}

// Looks up every shown chapter of the season (three at a time) and opens chapter-specific
// torrents at 720p or better with 2+ peers. Pack lists are requested separately.
async function fetchAllCatalogChapterSources(view) {
  const season = view.seasons.find((item) => item.season === view.season);
  if (!season || view.fetchAll?.running) return;
  const chapters = season.episodes.slice(0, view.shown).filter((episode) => !chapterUpcoming(episode)).map((episode) => ({ ...episode, season: season.season }));
  if (!chapters.length) return;
  const force = view.fetchAll?.season === season.season && view.fetchAll.done > 0;
  view.fetchAll = { season: season.season, running: true, done: 0, total: chapters.length };
  chapters.forEach((chapter) => {
    const sources = view.sources.get(chapter.id) || { status: "idle" };
    sources.open = true;
    sources.floorOnly = true;
    view.sources.set(chapter.id, sources);
  });
  renderTitleChapters();
  const label = () => {
    const button = $("#title-chapters .catalog-fetch-all");
    if (button) setButtonText(button, catalogFetchAllLabel(view, chapters.length));
  };
  let next = 0;
  const worker = async () => {
    while (next < chapters.length && catalogSeriesView === view && view.season === season.season) {
      const chapter = chapters[next];
      next += 1;
      await loadCatalogChapterSources(view, chapter, { force });
      if (catalogSeriesView !== view || !viewActive("title") || view.season !== season.season) return;
      view.fetchAll.done += 1;
      label();
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  view.fetchAll.running = false;
  if (catalogSeriesView !== view) return;
  const found = chapters.reduce((sum, chapter) => sum + (view.sources.get(chapter.id)?.groups?.episodeFiles || []).filter((stream) => meetsSourceFloor(stream)).length, 0);
  setToolStatus(TITLE_STATUS, `${found} episode magnet${found === 1 ? "" : "s"} at 720p or better with 2+ peers, across ${chapters.length} chapter${chapters.length === 1 ? "" : "s"}`);
  const button = $("#title-chapters .catalog-fetch-all");
  if (button) {
    button.disabled = false;
    label();
  }
  titleRendered.chapters = "";
}

export async function playCatalogChapter(view, chapter, button) {
  const code = chapterCode(chapter.season, chapter.episode);
  const group = savedCatalogChapterGroups(view.meta).get(code);
  if (group) {
    // Play the copy you were watching, from where you stopped (unless you finished it).
    const ref = group.resume && !group.progress?.finished ? group.resume : group.best;
    void playLibraryEpisode(ref.entry.id, Number(ref.episode.fileIndex), { resumeAtSeconds:
      chapterResumeMs(ref.episode.progress, { key: librarySeriesKeyForCatalog(view.meta) }, code) / 1000 });
    return;
  }
  if (view.busy) return;
  view.busy = true;
  const oldText = buttonText(button) || "Play";
  if (button) { button.disabled = true; setButtonText(button, "Finding…"); }
  try {
    setToolStatus(TITLE_STATUS, `Finding a source for ${libraryChapterName({ code }) || code}…`);
    const sources = await loadCatalogChapterSources(view, chapter);
    if (!sources || catalogSeriesView !== view || !viewActive("title")
      || view.sources.get(chapter.id) !== sources) return;
    if (sources.status !== "ready") throw new Error(sources.error || "Source lookup failed.");
    const candidates = chapterPlayOrder(sources.groups);
    if (!candidates.length) throw new Error(`No playable source was found for ${code}.`);
    let lastError = null;
    for (let index = 0; index < candidates.length; index += 1) {
      const stream = candidates[index];
      setToolStatus(TITLE_STATUS, `Trying source ${index + 1} of ${candidates.length}: ${catalogKindText(stream.chapterSource.label).toLowerCase()}${stream.quality && stream.quality !== "UNKNOWN" ? `, ${stream.quality}` : ""}, ${stream.peers || 0} peer${stream.peers === 1 ? "" : "s"}`);
      try {
        await addCatalogChapterSource(view, chapter, stream, { play: true, quiet: true });
        setToolStatus(TITLE_STATUS, "");
        return;
      } catch (error) {
        if (error?.name === "AbortError") return;
        lastError = error;
      }
    }
    throw lastError || new Error(`No source for ${code} passed torrent validation.`);
  } catch (error) {
    setToolStatus(TITLE_STATUS, error.message || "Could not play this chapter", true);
  } finally {
    view.busy = false;
    if (button?.isConnected) { button.disabled = false; setButtonText(button, oldText); }
  }
}

export function handleCatalogChapterClick(event) {
  const view = catalogSeriesView;
  const target = event.target.closest("button");
  if (!view || !target || !event.currentTarget.contains(target)) return;
  if (target.matches(".catalog-feature-section")) {
    const section = target.dataset.featureSection;
    if (view.featureSection === section) return;
    view.featureSection = section;
    view.packsActive = false;
    view.moviesActive = false;
    renderTitleChapters({ focusSelector: `.catalog-feature-section[data-feature-section="${section}"]` });
    return;
  }
  if (target.closest(".title-feature-section")) return;
  if (target.matches(".catalog-season-option")) {
    const season = Number(target.dataset.season);
    if (season === view.season && !view.packsActive && !view.moviesActive && !view.featureSection) return;
    view.featureSection = null;
    view.season = season;
    view.packsActive = false;
    view.moviesActive = false;
    view.shown = CHAPTER_PAGE;
    renderTitleChapters({ focusSelector: `.catalog-season-option[data-season="${season}"]` });
    return;
  }
  if (target.matches(".catalog-movies-toggle")) {
    if (view.moviesActive && !view.featureSection) return;
    view.featureSection = null;
    view.packsActive = false;
    view.moviesActive = true;
    renderTitleChapters({ focusSelector: ".catalog-movies-toggle" });
    return;
  }
  if (target.matches(".catalog-season-pack-toggle")) {
    const season = view.season;
    if (view.packsActive && !view.featureSection) return;
    const state = view.seasonPacks.get(season);
    view.featureSection = null;
    view.moviesActive = false;
    view.packsActive = true;
    renderTitleChapters({ focusSelector: ".catalog-season-pack-toggle" });
    if (state?.status !== "ready" && state?.status !== "loading") void loadCatalogSeasonPacks(view, season);
    return;
  }
  const packPanel = target.closest(".catalog-season-pack-panel");
  if (packPanel) {
    const state = view.seasonPacks.get(view.season);
    if (!state) return;
    if (target.matches(".catalog-season-pack-retry")) {
      void loadCatalogSeasonPacks(view, view.season, { force: true });
      return;
    }
    if (target.matches(".catalog-season-pack-more")) {
      state.showAll = true;
      renderTitleChapters();
      return;
    }
    const row = target.closest("[data-row-index]");
    const stream = row && state.rows?.[Number(row.dataset.rowIndex)];
    if (!stream || !target.matches(".catalog-source-play, .catalog-source-add") || view.busy) return;
    view.busy = true;
    void addCatalogChapterSource(view, state.chapter, stream, { play: target.matches(".catalog-source-play"), button: target })
      .catch((error) => setToolStatus(TITLE_STATUS, error.message || "Could not use this pack", true))
      .finally(() => { view.busy = false; });
    return;
  }
  if (target.matches(".catalog-chapters-more")) {
    const first = view.shown;
    view.shown += CHAPTER_PAGE;
    renderTitleChapters({ focusSelector: `.catalog-chapter:nth-child(${first + 1}) .catalog-chapter-play` });
    return;
  }
  if (target.matches(".catalog-fetch-all")) {
    target.disabled = true;
    void fetchAllCatalogChapterSources(view);
    return;
  }
  const chapter = catalogChapterFromNode(view, target);
  if (!chapter) return;
  if (target.matches(".catalog-chapter-play")) {
    void playCatalogChapter(view, chapter, target);
    return;
  }
  if (target.matches(".catalog-chapter-toggle")) {
    const sources = view.sources.get(chapter.id) || { status: "idle" };
    sources.open = !sources.open;
    view.sources.set(chapter.id, sources);
    // A saved chapter shows its saved sources first; torrents are looked up when asked.
    const saved = savedCatalogChapters(view.meta).has(chapterCode(chapter.season, chapter.episode));
    if (sources.open && !saved && sources.status !== "ready" && sources.status !== "loading") void loadCatalogChapterSources(view, chapter);
    else renderCatalogChapterPanel(chapter.item, sources);
    return;
  }
  const sources = view.sources.get(chapter.id);
  if (target.matches(".catalog-source-find")) {
    void loadCatalogChapterSources(view, chapter);
    return;
  }
  if (target.matches(".catalog-source-retry")) {
    void loadCatalogChapterSources(view, chapter, { force: true });
    return;
  }
  if (target.matches(".catalog-source-all") && sources) {
    sources.floorOnly = false;
    renderCatalogChapterPanel(chapter.item, sources);
    return;
  }
  const row = target.closest("[data-row-index]");
  if (!row || row.dataset.sourceRequest !== String(sources?.requestSerial)) return;
  const stream = sources?.rows?.[Number(row?.dataset.rowIndex)];
  if (!stream || !target.matches(".catalog-source-play, .catalog-source-add")) return;
  if (view.busy) return;
  view.busy = true;
  void addCatalogChapterSource(view, chapter, stream, { play: target.matches(".catalog-source-play"), button: target })
    .catch((error) => setToolStatus(TITLE_STATUS, error.message || "Could not use this source", true))
    .finally(() => { view.busy = false; });
}
