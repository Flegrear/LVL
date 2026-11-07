import {
  bindTabs, confirmDialog, escapeHtml, installImageFallbacks, installTips, promptDialog,
  setActiveTab,
} from "./frontend/ui/ui.js";
import { normalizeHomeCategory } from "./frontend/catalog/home-feed.js";
import { installPlaybackTrace } from "./frontend/player/performance-trace.js";
import { createRecsUi } from "./frontend/recommendations/recs-ui.js";
import { ANILIST_STATUS_FILTERS } from "./frontend/anilist/anilist-library.js";
import {
  ANILIST_CALLBACK_PATH, readAniListAccount, readAniListPreference,
} from "./frontend/anilist/anilist-auto-client.js";
import { readUnconfirmedAniListScore, resolveAniListScorePart } from "./frontend/anilist/anilist-score-sync.js";
import { normalizeLearningLocale } from "./shared/settings/language-settings.js";
import { createCalendarView } from "./frontend/calendar/calendar-view.js";
import { installUiI18n, registerUiTranslations, t } from "./frontend/ui/ui-i18n.js";
import { createClientFeatureHost } from "./frontend/features/feature-host.js";
import { CLIENT_FEATURES } from "./frontend/features/registry.js";
import {
  hydratePersistentAppState, localCopyMissing, persistentAppStateReady, persistPreferences, refreshPersistentLibrary,
  readStorageArray, readStorageObject,
} from "./frontend/app/saved-state.js";
import { $, $$, setToolStatus } from "./frontend/app/dom.js";
import { fetchJson, postJson } from "./frontend/app/http.js";
import {
  activeSidebarLauncher, navigateWatchToLibrary, restoreLastWatchOnVisit, setSidebarExpanded,
  registerPhonePlayerNavigationHook, switchView, viewActive, viewFromLocation,
} from "./frontend/app/navigation.js";
import { closePopupMenu, openMenuState, openPopupMenu, wirePopupMenu } from "./frontend/ui/popup-menu.js";
import { renderLocaleOptions, renderSettings, renderSettingsTabs } from "./frontend/settings/settings-page.js";
import { wireStorageSettings } from "./frontend/settings/storage-settings.js";
import {
  appUpdateSettingsBusy, appUpdateView, closeUpdateNotificationPopover, dismissAppUpdateCard,
  handleOutsideUpdateNotificationClick, openUpdateChangelog, openUpdateNotificationPopover,
  paintAppUpdateCard, paintUpdateNotifications, refreshAppUpdateSettings, reloadAfterAppUpdate,
  renderBundledChangelog, startAppUpdateFromCard, UPDATE_ALERTS_PREF, UPDATE_LATER_KEY,
  wireAppUpdateSettings, writeStoredJson,
} from "./frontend/updates/app-updates.js";
import {
  absolutePlaybackSeconds, cancelTranscodeStart, clearPlayerControlsHideTimer,
  continueProgressiveOrRecover, endScrub, fallbackActiveRemuxMseToNative, hidePlayerControls,
  isNewSourceFramePending, markPlaybackMotion, openTranscodeAt, playerArrowSeek, playerWantsMuted,
  presentedSubtitleSeconds, progressiveBufferEndAroundCurrent, progressTimeAt, recoverPlayback,
  refreshSubtitleClockForInteraction, resumePlayback, revealPlayerControls,
  schedulePlayerControlsHide, seekPlayerBy, seekPlayerTo, setPlayerLoading, setPlayerMutePreference,
  showScrubTime, stopRecoveryWatch, syncPlayerSpeed, togglePlayback, transcodeStartAttempt,
  updateCompatControls, updatePlayerPreferenceButtons, watchMediaStatus, wirePlayerSourceButtons,
  wirePlayerVideoEvents, wireSourceFrameGate,
} from "./frontend/player/player-core.js";
import {
  activeTrack, applyLanguagePreferencesToTracks, currentSourceTracks, preferredSourceTracks,
} from "./frontend/player/player-tracks.js";
import {
  closePlayerPopovers, openPlayerSubtitleManager, renderPlayerAudioMenu, renderPlayerSourceMenu,
  renderPlayerSubtitleMenu, togglePlayerSubtitleMenu,
} from "./frontend/player/player-menus.js";
import {
  cuePlaybackMs, currentCueIndex, renderSubtitles, renderTracks, seekTo, subtitleRenderMemo,
} from "./frontend/player/subtitle-display.js";
import {
  alignCurrentSubtitleSet, allPrimaryCues, cuePlaybackBounds, nudgeSubtitleTracks,
} from "./frontend/player/subtitle-timing.js";
import {
  applySubtitleStyle, openSubtitleStyleDialog, readSubtitleStyleControls, subtitleStyleDefaults,
} from "./frontend/player/subtitle-style.js";
import {
  importEmbeddedSubtitleTrack, loadMoreEmbeddedSubtitles, noteSubtitleVisibilityIntent,
} from "./frontend/player/embedded-subtitles.js";
import {
  handleSubtitleFiles, openSubtitleSearch, parseSubtitleFinderLanguages, saveSubtitlePreferences,
  searchWebSubtitles, subtitleFinderLanguages, syncSubtitleFinderLanguageChips,
} from "./frontend/player/subtitle-search.js";
import {
  audioSyncSource, audioSyncTracks, checkAudioSyncCoverage, resetAudioSync, scheduleAudioSync,
} from "./frontend/player/audio-sync.js";
import { refreshEpisodeSkipOptions, setEpisodeAutoSkip } from "./frontend/player/episode-skips.js";
import {
  finishPopupWindow, FLOAT_AUTO_KEY, popupHost, refreshPopupAvailability, siteFloatEdge,
  startPopupPlayback, updateFloatingControls, warmPopupPlayer, wireFloatingFrame, wireFloatingPlayer,
} from "./frontend/player/floating-player.js";
import { openMagnetDialog, resolveMagnet, wireLocalVideoInput } from "./frontend/player/torrent-playback.js";
import { createTimelineScrubController } from "./frontend/player/phone-seek-input.js";
import { registerPhonePlayerLifecycle } from "./frontend/player/phone-seek-lifecycle.js";
import { installPhonePlayerControls } from "./frontend/phone/player-controls.js";
import {
  openTitleEpisodeContextMenu, openWatchEpisodeContextMenu, scrollWatchEpisodesOnWheel,
  setWatchTheaterMode, syncWatchEpisodeHeight, updateChapterButtons, wireWatchChapters,
  wireWatchSidePanel,
} from "./frontend/watch/watch-page.js";
import { recordWatchProgress } from "./frontend/watch/watched-status.js";
import {
  autoNextEnabled, cancelAutoNext, catalogChapterList, playAdjacentChapter, playAutoNextNow,
  prefetchUpcomingChapter, setAutoplayNextEnabled, startAutoNext,
} from "./frontend/watch/episode-navigation.js";
import {
  artworkNotice, buildLibrarySeries, fetchArtworkForSeriesKey, updateLibrarySeriesEntries,
} from "./frontend/library/library-data.js";
import {
  closeLibraryContextMenu, confirmLibraryRemoval, customCoverDataUrl, handleLibraryCardAction,
  isLibraryTitleMarkedWatched, LIBRARY_VIEW_KEY, libraryContextSeriesKey, openLibraryContextMenu,
  openLibraryRemoveDialog, renderLibrary, saveLibraryView, setLibrarySeasonWatched,
  setLibraryTitleWatched, wireLibraryRemoveDialog,
} from "./frontend/library/library-page.js";
import { exportLibraryDatabase, mergeImportedLibrary } from "./frontend/library/library-backup.js";
import {
  catalogSeriesView, fitTitleBackdrop, handleTitleAction, handleTitleAniListLink,
  handleTitleMainClick, keepTitleRatingExclusive, libraryTitleIds, openLibrarySeries, openTitlePage,
  openTitleTrailer, positionTitleRatingBreakdown, refreshTitlePage, renderTitlePage,
} from "./frontend/title/title-page.js";
import { renderTitleChapters } from "./frontend/title/title-chapters.js";
import {
  handleCatalogCardAction, HOME_CATALOG_REFRESH_MS, loadHomeCatalog, renderHome,
} from "./frontend/home/home-page.js";
import {
  animeBrowserPrefetchTimer, loadAnimeBrowser, openAnimeBrowserTitle, resolveAnimeBrowserCatalog,
  wireAnimeBrowserPrefetch,
} from "./frontend/home/anime-browser.js";
import { wireRandomPick } from "./frontend/home/random-pick.js";
import {
  catalogSearchIsOpen, closeCatalogSearch, openCatalogResult, openCatalogSearch, queueCatalogSearch,
  searchCatalogTitles,
} from "./frontend/catalog/catalog-search.js";
import {
  anilistScoreSyncEnabled, authenticatedTitleAniList, backfillAniListCommunityScores,
  completeAniListAuthorization, maybeSyncAniListLibrary, saveUserAniListScore,
  scheduleAniListAutoSync, showAniListAutoStatus, syncAniListLibrary, wireAniListAutoSettings,
} from "./frontend/anilist/anilist-sync.js";

// An older server that is still running may lack the static route for
// /frontend/player/progressive-seek.js. A mandatory ESM import of an unserved
// module would prevent the WHOLE
// Watch/Library SPA from booting (black page). Only enable the optional cache
// when the module itself was actually served; otherwise fail closed to native
// playback until a non-destructive backend activation is possible.
const progressiveSeekModule = await import("./frontend/player/progressive-seek.js")
  .catch(() => null);
export const progressiveSeekAvailable = Boolean(progressiveSeekModule);
export const normalizeProgressiveSeekStatus = progressiveSeekModule?.normalizeProgressiveSeekStatus
  ?? (() => null);
export const progressiveReadyRanges = progressiveSeekModule?.progressiveReadyRanges
  ?? (() => []);
export const findProgressiveReadySegment = progressiveSeekModule?.findProgressiveReadySegment
  ?? (() => null);
export const createProgressiveSeekController = progressiveSeekModule?.createProgressiveSeekController
  ?? (() => null);
export const createStandaloneProgressiveMseLoader = progressiveSeekModule?.createStandaloneProgressiveMseLoader
  ?? (() => null);

// Optional features (reader, franchises, reading sources) add views, nav buttons,
// Settings tabs, Library filters, styles and strings through
// frontend/features/registry.js. Installed here, before translation and the
// nav/tab listeners below, so they behave like core elements.
export const clientFeatures = createClientFeatureHost(CLIENT_FEATURES);
clientFeatures.install(document, {
  registerTranslations: registerUiTranslations,
  t: (...args) => t(...args),
  switchView: (...args) => switchView(...args),
  viewActive: (...args) => viewActive(...args),
  fetchJson: (...args) => fetchJson(...args),
  setToolStatus: (...args) => setToolStatus(...args),
  escapeHtml: (...args) => escapeHtml(...args),
  preferences: () => ({
    interfaceLanguage: state.interfaceLanguage, baseLanguage: state.baseLanguage, targetLanguage: state.targetLanguage,
  }),
  refreshLibrary: () => { if (viewActive("library")) renderLibrary(); },
  refreshSyncedLibrary: (revision) => refreshPersistentLibrary({ revision }),
  // Feature chips changed (a section became available): series redraw their chapter area;
  // movie pages redraw the main part (unchanged markup isn't touched).
  refreshTitle: () => {
    if (!viewActive("title")) return;
    if (catalogSeriesView) renderTitleChapters();
    else if (titleView.type === "movie") renderTitlePage();
  },
  // A catalog title page (series or movie, "tt…" id) with a feature section open first.
  openVideoTitle: ({ id, type = "series", section = "", historyMode = "push" } = {}) => {
    if (!/^tt\d{5,12}$/.test(String(id || ""))) return false;
    openTitlePage({ id: String(id), type: type === "movie" ? "movie" : "series", section: /^[a-z][a-z0-9-]{1,31}$/.test(section) ? section : "" },
      { historyMode: historyMode === "replace" ? "replace" : "push" });
    return true;
  },
  // Opens the video title page for an AniList anime through the same verified
  // catalog match the Home Anime browser uses. Rejects when no exact match exists.
  // section: a feature section to open first ("manga"). year: the anime's start year,
  // which picks between titles with the same name (One Piece anime vs live action).
  openAnimeTitle: async ({ anilistId, title, titleAlt = "", year = null, section = "", historyMode = "push" } = {}) => {
    const match = await resolveAnimeBrowserCatalog({ id: Number(anilistId), title: String(title || ""), titleAlt: String(titleAlt || ""), year: Number(year) || null });
    openTitlePage({ id: match.id, type: match.type, meta: match, section: /^[a-z][a-z0-9-]{1,31}$/.test(section) ? section : "" }, { historyMode: historyMode === "replace" ? "replace" : "push" });
    return match;
  },
  // The same match, without opening the page: { id, type }.
  findAnimeTitle: async ({ anilistId, title, titleAlt = "", year = null } = {}) => {
    const match = await resolveAnimeBrowserCatalog({ id: Number(anilistId), title: String(title || ""), titleAlt: String(titleAlt || ""), year: Number(year) || null });
    return { id: match.id, type: match.type };
  },
  // A title page a feature owns (titleSubjects), e.g. a manga with no anime.
  openFeatureTitle: ({ feature, item, section = "", historyMode = "push" } = {}) => openTitlePage({ feature, item, section }, { historyMode }),
  refreshTitlePage: () => refreshTitlePage(),
  // Video titles in the Library, by catalog id and by AniList id (for features that join theirs to them).
  libraryTitleIds: () => libraryTitleIds(),
  // The signed-in AniList account (token included) and the user's sync choices; null when not connected.
  anilistAccount: () => readAniListAccount(localStorage),
  anilistSync: () => ({ progress: readAniListPreference(localStorage).enabled, scores: anilistScoreSyncEnabled() }),
});

// Reserved compatibility state for older saved views and styles.
export const learningEnabled = false;
document.documentElement.dataset.learningMode = "off";

// OAuth's implicit token arrives in the URL fragment, which must be removed
// from browser history before the SPA router or any navigation can expose it.
export const anilistOAuthResponse = window.__lvlAniListOAuthResponse
  || (window.location.pathname === ANILIST_CALLBACK_PATH
    ? { hash: window.location.hash } : null);
delete window.__lvlAniListOAuthResponse;
if (anilistOAuthResponse) {
  window.history.replaceState({ view: "settings" }, "", "/settings");
  localStorage.setItem("blackline-settings-tab", "library");
}

// Keys whose copy was missing when the page opened: nothing is written for them until the
// database's version has loaded (a partial copy written before that could later replace it).
export const localCopyUnloaded = localCopyMissing();

const legacyLanguagePair = (localStorage.getItem("blackline-subdl-languages") || "").split(",").map((value) => value.trim().toUpperCase()).filter(Boolean);
const initialBaseLanguage = localStorage.getItem("blackline-base-language") || legacyLanguagePair[0] || "EN";
const initialTargetLanguage = localStorage.getItem("blackline-target-language") || legacyLanguagePair.find((value) => value !== initialBaseLanguage) || (initialBaseLanguage === "EN" ? "ES" : "EN");
const initialSubtitleStyle = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem("blackline-subtitle-style") || "{}");
    return { ...subtitleStyleDefaults, ...(saved && typeof saved === "object" ? saved : {}) };
  } catch {
    return { ...subtitleStyleDefaults };
  }
})();

export const state = {
  tracks: [],
  currentMs: 0,
  known: new Set(readStorageArray("blackline-known")),
  cards: readStorageArray("blackline-cards"),
  selectedTrackId: null,
  pauseAfterCue: false,
  lastCueId: null,
  webSubtitleResults: [],
  catalogResults: [],
  homeCatalog: { movies: [], series: [], anime: [], seed: 0 },
  homeLoaded: false,
  homeCatalogUpdatedAt: 0,
  library: readStorageArray("blackline-library"),
  subdlKey: localStorage.getItem("blackline-subdl-key") || "",
  wyzieKey: localStorage.getItem("blackline-wyzie-key") || "",
  subsourceKey: localStorage.getItem("blackline-subsource-key") || "",
  baseLanguage: initialBaseLanguage,
  targetLanguage: initialTargetLanguage,
  baseLocale: normalizeLearningLocale(initialBaseLanguage, localStorage.getItem("blackline-base-locale")),
  targetLocale: normalizeLearningLocale(initialTargetLanguage, localStorage.getItem("blackline-target-locale")),
  interfaceLanguage: localStorage.getItem("blackline-interface-language") || "auto",
  mediaDurationMs: 0,
  loopLine: false,
  subtitlesVisible: true,
  transcodeBaseOffsetSeconds: 0,
  transcodeRequestedStartSeconds: 0,
  transcodeContext: null,
  currentMediaProbe: null,
  selectedAudioTrack: 0,
  bufferingTimer: null,
  transferStatsTimer: null,
  loadingProgress: 0,
  subtitleStyle: initialSubtitleStyle,
  pendingMagnetSeriesKey: null,
  learningExposure: readStorageObject("blackline-learning-exposure"),
  testResults: readStorageArray("blackline-test-results"),
  coachTranscripts: readStorageArray("blackline-coach-transcripts"),
  alignedSubtitleTimeline: [],
  alignedSubtitleSourceKey: "",
  currentSource: {
    kind: "idle",
    title: "No video loaded",
    sourceTag: "No source loaded",
    libraryId: null,
    fileIndex: null,
  },
};
// Top picks, Settings › Recommendations and "Your rating" (recs-ui.js). The hooks only run later.
export const recsUi = createRecsUi({
  $,
  fetchJson: (url) => fetchJson(url),
  postJson: (url, payload) => postJson(url, payload),
  setToolStatus: (selector, message, error) => setToolStatus(selector, message, error),
  openTitlePage: (target) => openTitlePage(target),
  openSettings: () => {
    settingsView.tab = "library";
    localStorage.setItem("blackline-settings-tab", "library");
    switchView("settings");
    renderSettingsTabs();
  },
  isViewActive: (name) => viewActive(name),
  homeCategory: () => homeBrowseCategory,
  onHomeChange: () => { if (!clientFeatures.homeCategoryIds.includes(homeBrowseCategory)) renderHome(); },
  onTitleChange: () => refreshTitlePage(),
  onOverview: (overview) => maybeSyncAniListLibrary(overview),
  getAniListScoreSyncState: () => ({
    enabled: Boolean(readAniListAccount(localStorage)) && anilistScoreSyncEnabled(),
  }),
  getAniListScorePending: (subject, season) => {
    const account = readAniListAccount(localStorage);
    const part = resolveAniListScorePart(authenticatedTitleAniList(subject, account), season);
    const rendered = resolveAniListScorePart(subject?.anilist, season);
    return account && part && rendered?.anilistId === part.anilistId
      ? readUnconfirmedAniListScore(localStorage, account.userId, part.anilistId) : null;
  },
  onRatingSaved: async (subject, season, score) => saveUserAniListScore(subject, season, score),
  showHomePicks: async () => {
    if (homeBrowseCategory !== "all") {
      homeBrowseCategory = "all";
      localStorage.setItem("blackline-home-filter", "all");
    }
    switchView("home");
    // Opened from another page, Home's rows may still be loading: the picks row comes with them.
    try { await loadHomeCatalog(); } catch {}
    renderHome();
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    requestAnimationFrame(() => $("#home-picks")?.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" }));
  },
});
export const video = $("#video");
export const playbackMetrics = installPlaybackTrace(video);
export const frame = $("#video-frame");
// Set when this page is the borderless pop-up player window (index.html reads the handoff).
export const POPUP_HANDOFF = window.__lvlPopupHandoff?.playback ? window.__lvlPopupHandoff : null;
if (typeof ResizeObserver !== "undefined") new ResizeObserver(syncWatchEpisodeHeight).observe(frame);
window.addEventListener("resize", syncWatchEpisodeHeight);
export const uiLanguage = installUiI18n({ interfaceLanguage: state.interfaceLanguage, baseLanguage: state.baseLanguage });
export let homeBrowseCategory = (() => {
  // A new Android session starts with the full Library of discovery rows.
  // Desktop keeps its saved category, and in-session tab changes still persist.
  if (/\bLVL-Android\//.test(window.navigator?.userAgent || "")) return "all";
  const saved = localStorage.getItem("blackline-home-filter");
  return clientFeatures.homeCategoryIds.includes(saved) ? saved : normalizeHomeCategory(saved);
})();

export const SETTINGS_TABS = ["general", "library", "storage", "updates", "notifications", ...clientFeatures.settingsTabIds];
// Tracking (ratings, AniList, Letterboxd, recommendations) is part of Library;
// a tab saved as "recs" before that opens Library.
const savedSettingsTab = localStorage.getItem("blackline-settings-tab") === "recs" ? "library" : localStorage.getItem("blackline-settings-tab");
export const settingsView = { tab: SETTINGS_TABS.includes(savedSettingsTab) ? savedSettingsTab : "general" };
void reloadAfterAppUpdate();
setInterval(() => { void reloadAfterAppUpdate(); }, 10_000);
wireAppUpdateSettings();

$("#sidebar-notifications")?.addEventListener("click", openUpdateNotificationPopover);
$("#app-notifications-close")?.addEventListener("click", () => closeUpdateNotificationPopover({ restoreFocus: true }));
$("#app-notifications-settings")?.addEventListener("click", () => {
  closeUpdateNotificationPopover();
  settingsView.tab = "notifications";
  switchView("settings");
  renderSettingsTabs();
});
$("#settings-app-updates-changelog-details")?.addEventListener("toggle", (event) => {
  if (event.target.open) void renderBundledChangelog($("#settings-app-updates-changelog-inline"));
});
$("#app-changelog-close")?.addEventListener("click", () => $("#app-changelog-dialog")?.close());
$("#app-update-card-install")?.addEventListener("click", () => {
  void startAppUpdateFromCard("/api/app-updates/install", {});
});
$("#app-update-card-retry")?.addEventListener("click", () => {
  if (appUpdateView.phase === "stuck") { window.location.reload(); return; }
  // A fresh check that installs what it finds, also after LVL restarted.
  void startAppUpdateFromCard("/api/app-updates/check", { apply: true });
});
$("#app-update-card-notes")?.addEventListener("click", () => { void openUpdateChangelog(); });
$("#app-update-card-later")?.addEventListener("click", () => {
  writeStoredJson(UPDATE_LATER_KEY, { version: appUpdateView.version, at: Date.now() });
  paintAppUpdateCard();
});
$("#app-update-card-close")?.addEventListener("click", dismissAppUpdateCard);
$("#settings-notification-update-alerts")?.addEventListener("change", (event) => {
  localStorage.setItem(UPDATE_ALERTS_PREF, event.target.checked ? "1" : "0");
  paintUpdateNotifications();
  if (event.target.checked) void refreshAppUpdateSettings();
});
document.addEventListener("click", handleOutsideUpdateNotificationClick);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("#app-notifications-popover")?.hidden) {
    event.preventDefault();
    closeUpdateNotificationPopover({ restoreFocus: true });
  }
});
paintUpdateNotifications();
void refreshAppUpdateSettings({ checkNotifications: true });
setInterval(() => {
  if (!appUpdateSettingsBusy) void refreshAppUpdateSettings({ checkNotifications: true });
}, 60_000);
wireSourceFrameGate();
export const audioSync = { key: "", generation: 0, windows: [], caches: new Map(), pending: false, timer: 0, timerDueAt: 0, failures: 0, lastCheckMs: -Infinity };

// Lines of the base-language track that belong with a cue of another track, in video time.
export const pairedCueMemo = new Map();
export function renderSubtitleWorkspace() {
  renderTracks();
  renderSubtitles();
  updatePlayerPreferenceButtons();
}

export function renderAll() {
  renderTracks();
  renderSubtitles();
  renderLibrary();
  if (state.homeLoaded) renderHome();
  renderSettings();
  renderTitlePage();
  updatePlayerPreferenceButtons();
  updateChapterButtons();
}

export const calendarUi = createCalendarView({
  root: $("#calendar-root"),
  getSeries: () => buildLibrarySeries(),
  getChapterList: (id, callback) => catalogChapterList(id, callback),
  openTitle: (event) => {
    if (event.seriesKey && buildLibrarySeries().some((series) => series.key === event.seriesKey))
      openLibrarySeries(event.seriesKey);
    else if (event.catalogId) openTitlePage({ id: event.catalogId, type: event.type === "movie" ? "movie" : "series" });
  },
});
$("#calendar-root")?.addEventListener("calendar-open-request", () => switchView("calendar"));

export const VIEW_ROUTES = Object.freeze({ home: "/home", watch: "/watch", library: "/library", calendar: "/calendar", settings: "/settings", title: "/title", ...clientFeatures.viewRoutes });
export const ROUTE_VIEWS = Object.freeze(Object.fromEntries(Object.entries(VIEW_ROUTES).map(([view, route]) => [route, view])));
export let watchRestoreReady = false;
export const floatingPrefs = {
  auto: localStorage.getItem(FLOAT_AUTO_KEY) !== "0",
  // One floating player: the pop-up window above other apps (LVL's borderless window with
  // the installed app; the browser's own pop-up otherwise). The player inside LVL is only
  // the fallback when neither can open.
  scope: "desktop",
};

// ---- The borderless pop-up player: LVL-Popup.exe shows this page (/watch?popup=<token>)
// in its own always-on-top window with no frame (backend/media/popup-window.js).
// LVL's window sends what is playing, pauses, and continues from the pop-up's position
// when it comes back. The pop-up window shows only the player and plays from there. It
// saves nothing itself: LVL's window keeps Continue Watching current from its reports.
export const popupPlayer = { available: false, open: false, id: null, pollTimer: null, warmed: false };
let popupDragStart = null;
let popupDragged = false;

export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return "SIZE UNKNOWN";
  if (value >= 1073741824) return `${(value / 1073741824).toFixed(2)} GB`;
  if (value >= 1048576) return `${(value / 1048576).toFixed(1)} MB`;
  return `${Math.ceil(value / 1024)} KB`;
}
export const episodeAutoSkip = {
  intro: localStorage.getItem("lvl-auto-skip-intro") === "1",
  outro: localStorage.getItem("lvl-auto-skip-ending") === "1",
  attemptedIntro: "", attemptedOutro: "",
};

/* ---------------------------------------------------------------- Library dialog: chapter list */

export const libraryDialogView = { key: "", season: null, open: new Set(), series: null, transientMeta: null };

/* ---------------------------------------------------------------- Title page */

// A show or movie on its own page: /title?id=tt…&type=series for catalog titles (in the Library
// or not), /title?key=… for a Library title without catalog data. Backdrop and facts, your
// progress, every chapter (or the movie's sources) with what the Library has, and the details.
export const TITLE_STATUS = "#title-status";
export const DEFAULT_DOCUMENT_TITLE = document.title;
export const titleView = { routeKey: "", id: "", type: "series", key: "", fromApp: false };
export const titleSeedMeta = new Map();
export const viewScroll = new Map();
export const libraryView = (() => {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(LIBRARY_VIEW_KEY) || "{}") || {}; } catch {}
  return {
    filter: ["all", "series", "movie", "anime", ...clientFeatures.libraryFilterIds].includes(saved.filter) ? saved.filter : "all",
    sort: ["recent", "added", "title", "title-desc", "watched", "unfinished", "progress"].includes(saved.sort) ? saved.sort : "recent",
    status: ["any", ...ANILIST_STATUS_FILTERS, "REPEATING"].includes(saved.status) ? saved.status : "any",
    query: "",
  };
})();

const animeBrowserInitialSeason = ["WINTER", "SPRING", "SUMMER", "FALL"][Math.floor(new Date().getMonth() / 3)];
export const animeBrowser = {
  filters: { year: String(new Date().getFullYear()), season: animeBrowserInitialSeason, sort: "POPULARITY_DESC", format: "TV", status: "", genre: "", search: "" },
  items: [], page: 0, hasNextPage: false, loading: false, loaded: false, error: "", requestId: 0, openRequestId: 0,
};
wireAnimeBrowserPrefetch();
$("#home-rows")?.addEventListener("submit", (event) => {
  if (event.target.id !== "anime-browser-form") return;
  event.preventDefault();
  const form = new FormData(event.target);
  for (const key of Object.keys(animeBrowser.filters)) animeBrowser.filters[key] = String(form.get(key) || "");
  void loadAnimeBrowser();
});
$("#home-rows")?.addEventListener("change", (event) => {
  const form = event.target.closest("#anime-browser-form");
  if (form && event.target.name !== "search") form.requestSubmit();
});
$("#home-rows")?.addEventListener("click", (event) => {
  const card = event.target.closest("[data-anime-id]");
  if (card) void openAnimeBrowserTitle(card.dataset.animeId);
  else if (event.target.closest("#anime-browser-more") && !animeBrowser.loading) void loadAnimeBrowser({ append: true });
});

// Your AniList list in the Library: a title per show (its seasons inside) and per movie, on its
// catalog page when one was found. Titles you added yourself only get your AniList status.
export const ANILIST_LIBRARY_KEY = "blackline-anilist-library-synced";

/* ---------------------------------------------------------------- Series details: chapter list */

// Series details list every chapter of the selected season. Sources are looked up per chapter,
// only when asked (Play or Sources): single-episode files first; from a pack only the chapter's
// own file is streamed, and the Library keeps just the picked chapters.
export const CHAPTER_PAGE = 60;

export function empty(title, copy) {
  return `<div class="empty-state"><strong>${escapeHtml(title)}</strong>${escapeHtml(copy)}</div>`;
}

wireLocalVideoInput();

$("#subtitle-input").addEventListener("change", (event) => handleSubtitleFiles([...event.target.files]));
$("#magnet-form").addEventListener("submit", resolveMagnet);
// Both entry points reuse the same non-modal live search panel and results.
$("#catalog-search-form").addEventListener("submit", searchCatalogTitles);
$("#catalog-search-input").addEventListener("input", queueCatalogSearch);
$("#home-search-title")?.addEventListener("click", () => openCatalogSearch("topbar"));
$("#section-search-title")?.addEventListener("click", () => openCatalogSearch("section"));
$("#catalog-search-shell")?.addEventListener("keydown", (event) => {
  const results = [...$("#catalog-results").querySelectorAll(".catalog-search-result")];
  if (event.key === "Escape") {
    event.preventDefault();
    closeCatalogSearch({ restoreFocus: true });
  } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    if (!results.length) return;
    event.preventDefault();
    const index = results.indexOf(document.activeElement);
    const next = event.key === "ArrowDown" ? (index + 1) % results.length : (index <= 0 ? results.length - 1 : index - 1);
    results[next].focus();
  }
});
document.addEventListener("pointerdown", (event) => {
  if (!catalogSearchIsOpen()) return;
  if (event.target.closest("#catalog-search-shell, #home-search-title, #section-search-title")) return;
  closeCatalogSearch();
});
$("#home-open-library")?.addEventListener("click", () => switchView("library"));
$("#section-open-library")?.addEventListener("click", () => switchView("library"));
$("#sidebar-brand-link")?.addEventListener("click", () => {
  if (viewActive("home")) window.scrollTo({ top: 0, behavior: "instant" });
  switchView("home");
});
const RANDOM_SOURCE_KEY = "lvl-random-source";
export let randomSource = localStorage.getItem(RANDOM_SOURCE_KEY) === "anything" ? "anything" : "recommended";
const randomSourceSetting = $("#settings-random-source");
if (randomSourceSetting) {
  randomSourceSetting.value = randomSource;
  randomSourceSetting.addEventListener("change", () => {
    randomSource = randomSourceSetting.value === "anything" ? "anything" : "recommended";
    localStorage.setItem(RANDOM_SOURCE_KEY, randomSource);
  });
}
export const randomPickPopover = $("#random-pick-popover");
wireRandomPick();
$("#view-home")?.addEventListener("click", handleCatalogCardAction);
$("#library-recommendations")?.addEventListener("click", handleCatalogCardAction);
recsUi.wire();
wireAniListAutoSettings();
bindTabs($("#home-tabs"), {
  onChange: (value) => {
    ++animeBrowser.openRequestId;
    window.clearTimeout(animeBrowserPrefetchTimer);
    homeBrowseCategory = typeof clientFeatures !== "undefined" && clientFeatures.homeCategoryIds.includes(value)
      ? value : normalizeHomeCategory(value);
    localStorage.setItem("blackline-home-filter", homeBrowseCategory);
    if (!viewActive("home")) switchView("home");
    else if (window.scrollY > ($("#home-hero")?.offsetHeight || 0) * 0.5) window.scrollTo({ top: 0 });
    renderHome();
  },
});
setActiveTab($("#home-tabs"), homeBrowseCategory);
installImageFallbacks();
installTips();
watchMediaStatus();
let homeTopbarFrame = 0;
window.addEventListener("scroll", () => {
  if (homeTopbarFrame) return;
  homeTopbarFrame = requestAnimationFrame(() => {
    homeTopbarFrame = 0;
    $("#home-topbar")?.classList.toggle("is-solid", window.scrollY > 24);
    $("#section-topbar")?.classList.toggle("is-solid", window.scrollY > 24);
  });
}, { passive: true });
document.addEventListener("keydown", (event) => {
  if (event.key !== "/" || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
  // Every view now has a Search control in its own topbar, so '/' works across
  // Calendar, Settings, learning tools and title pages as well as Home/Watch.
  if (!document.querySelector(".view.is-active") || document.querySelector("dialog[open]")) return;
  const target = event.target;
  if (target?.isContentEditable || ["input", "textarea", "select"].includes(target?.tagName?.toLowerCase())) return;
  event.preventDefault();
  openCatalogSearch(viewActive("home") ? "topbar" : "section");
});
$("#library-export")?.addEventListener("click", exportLibraryDatabase);
$("#library-import")?.addEventListener("click", () => {
  setToolStatus("#library-import-status", "");
  const button = $("#anilist-import-connected");
  if (button) button.hidden = !readAniListAccount(localStorage);
  $("#library-import-dialog")?.showModal();
});
$("#anilist-import-connected")?.addEventListener("click", async (event) => {
  const button = event.currentTarget;
  if (!readAniListAccount(localStorage)) {
    setToolStatus("#library-import-status", "Connect AniList under Settings → Tracking first.", true);
    return;
  }
  button.disabled = true;
  try {
    await syncAniListLibrary({ status: "#library-import-status" });
    void recsUi.load({ force: true }).catch(() => {});
  } catch (error) {
    setToolStatus("#library-import-status", error?.message || "AniList import failed", true);
  } finally { button.disabled = false; }
});
$("#library-db-file")?.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  try {
    if (!persistentAppStateReady) throw new Error("Your saved Library has not finished loading. Import after it reconnects.");
    if (file.size > 100 * 1024 * 1024) throw new Error("Library JSON is too large. Maximum is 100 MB.");
    const payload = JSON.parse(await file.text());
    const entries = Array.isArray(payload) ? payload : payload?.library;
    if (!Array.isArray(entries) || entries.length > 5000) throw new Error("Invalid or oversized Library backup.");
    const existing = new Set(state.library.map((entry) => String(entry.id)));
    const conflicts = entries.filter((entry) => entry?.id && existing.has(String(entry.id))).length;
    if (!(await confirmDialog({ title: `Import ${entries.length} title records?`, confirmLabel: "Import",
      text: `${conflicts} already exist and will keep their current data. Existing cards, progress, learning history and AniList links will not be replaced. The backup does not include clip video files.` }))) {
      setToolStatus("#library-import-status", "Import cancelled. Your Library is unchanged.");
      return;
    }
    const count = mergeImportedLibrary(payload);
    setToolStatus("#library-import-status", `Added ${count} title${count === 1 ? "" : "s"}; existing titles preserved`);
  } catch (error) {
    setToolStatus("#library-import-status", error.message || "Could not import that JSON file", true);
  }
});
$("#anilist-import-form")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const username = $("#anilist-username")?.value.trim();
  if (!username) return;
  const button = event.currentTarget.querySelector("button[type='submit']");
  const oldText = button?.textContent || "Import list";
  if (button) { button.disabled = true; button.textContent = "Importing…"; }
  try {
    // The same link as Settings › Recommendations: your scores also shape your Top picks.
    setToolStatus("#library-import-status", `Reading ${username}'s list on AniList…`);
    await postJson("/api/recs/anilist/link", { username });
    localStorage.removeItem(ANILIST_LIBRARY_KEY);
    await syncAniListLibrary({ status: "#library-import-status", skipAuthPull: true, skipScoreSync: true });
    void recsUi.load({ force: true }).catch(() => {});
  } catch (error) {
    const message = String(error?.message || "AniList import failed");
    const privateList = Number(error?.status ?? error?.httpStatus) === 404
      || /\bHTTP\s*404\b|(?:list is private|private (?:list|user))/i.test(message);
    setToolStatus("#library-import-status", privateList
      ? "That AniList username's list isn't publicly available. Check the username; to import your own private list, connect AniList under Settings → Tracking and choose Import my connected AniList."
      : message, true);
  } finally {
    if (button) { button.disabled = false; button.textContent = oldText; }
  }
});
$("#catalog-results")?.addEventListener("click", (event) => {
  const holder = event.target.closest(".catalog-search-result[data-title-id]");
  if (holder) openCatalogResult(holder.dataset.titleId);
});

$("#view-title")?.addEventListener("click", handleTitleAction);
$("#view-title")?.addEventListener("click", (event) => {
  const trailer = event.target.closest("a.title-trailer[data-trailer-id]");
  if (trailer && openTitleTrailer(trailer.dataset.trailerId, trailer.href)) event.preventDefault();
});
for (const eventName of ["pointerover", "focusin", "click"]) {
  $("#title-hero")?.addEventListener(eventName, (event) => {
    const wrap = event.target.closest?.(".title-rating-wrap");
    if (wrap) positionTitleRatingBreakdown(wrap);
  });
}
// Native details stay open after a click elsewhere; treat the score badges as
// one dismissible group. Pointerdown runs before an input blur saves its score.
document.addEventListener("pointerdown", (event) => {
  const scores = $("#title-hero .title-hero__scores");
  if (!scores || scores.contains(event.target)) return;
  scores.querySelectorAll(".title-rating-wrap[open]").forEach((wrap) => { wrap.open = false; });
});
$("#title-hero")?.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  const opened = event.currentTarget.querySelectorAll(".title-rating-wrap[open]");
  if (!opened.length) return;
  opened.forEach((wrap) => { wrap.open = false; });
  event.preventDefault();
});
$("#title-hero")?.addEventListener("toggle", (event) => {
  const wrap = event.target;
  if (!wrap.matches?.(".title-rating-wrap") || !wrap.open) return;
  keepTitleRatingExclusive(wrap);
  positionTitleRatingBreakdown(wrap);
}, true);
window.addEventListener("resize", () => {
  $("#title-hero")?.querySelectorAll(".title-rating-wrap[open]").forEach(positionTitleRatingBreakdown);
});
$("#title-progress")?.addEventListener("click", (event) => { void handleTitleAniListLink(event); });
$("#title-main")?.addEventListener("click", handleTitleMainClick);
$("#library-add-magnet").addEventListener("click", () => {
  openMagnetDialog();
});

wireFloatingPlayer();
// The borderless pop-up player window (its functions are with the floating player code).
if (POPUP_HANDOFF) {
  // The window hides itself if the page never says it's ready (it has no frame to close).
  popupHost({ type: "ready" });
  // Drag the video to move the window; from an edge, resize it. The window follows the
  // pointer while the left button is held.
  frame.addEventListener("pointerdown", (event) => {
    popupDragged = false;
    if (event.button !== 0 || event.target.closest?.("button, input, select, a, label, .floating-player-bottom, #player-subtitle-menu")) return;
    const edge = siteFloatEdge(frame.getBoundingClientRect(), event.clientX, event.clientY);
    if (edge) {
      event.preventDefault();
      popupDragged = true;
      popupHost({ type: "resize", edge });
      return;
    }
    popupDragStart = { x: event.clientX, y: event.clientY };
  }, true);
  window.addEventListener("pointermove", (event) => {
    if (popupDragStart && event.buttons & 1) {
      if (Math.hypot(event.clientX - popupDragStart.x, event.clientY - popupDragStart.y) < 4) return;
      popupDragStart = null;
      popupDragged = true;
      popupHost({ type: "move" });
      return;
    }
    if (event.buttons) return;
    const edge = siteFloatEdge(frame.getBoundingClientRect(), event.clientX, event.clientY);
    frame.style.cursor = edge === "n" || edge === "s" ? "ns-resize"
      : edge === "e" || edge === "w" ? "ew-resize"
      : edge === "nw" || edge === "se" ? "nwse-resize"
      : edge ? "nesw-resize" : "";
  });
  window.addEventListener("pointerup", () => { popupDragStart = null; });
  // A drag or resize that ends over the video isn't a click (play/pause).
  frame.addEventListener("click", (event) => {
    if (!popupDragged) return;
    popupDragged = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  // No fullscreen inside the pop-up.
  frame.addEventListener("dblclick", (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  // Escape closes the pop-up, as ✕ does.
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented || $("#player-subtitle-menu")?.hidden === false) return;
    event.preventDefault();
    finishPopupWindow("close");
  });
  video.addEventListener("loadedmetadata", () => {
    if (video.videoWidth > 0 && video.videoHeight > 0) popupHost({ type: "aspect", ratio: video.videoWidth / video.videoHeight });
  });
  video.addEventListener("ended", () => finishPopupWindow("ended"));
} else {
  // The first video played in LVL's window starts the pop-up program hidden.
  video.addEventListener("play", warmPopupPlayer);
}
video.addEventListener("durationchange", updateFloatingControls);
wireFloatingFrame();

wireWatchSidePanel();
// Capture before buttons/cards can consume the event. The episode panel is a
// permanent non-collapsible surface; only consume wheel deltas while the list
// really has further episodes to scroll in the requested direction.
$("#watch-chapters")?.addEventListener("wheel", (event) => {
  scrollWatchEpisodesOnWheel(event, $("#watch-chapters-body"));
}, { passive: false, capture: true });
$("#title-main")?.addEventListener("contextmenu", (event) => {
  const item = event.target.closest(".lib-chapter[data-chapter-code], .catalog-chapter[data-chapter-code]");
  // Edge's mouse contextmenu frequently reports detail=0. That value is NOT
  // proof of keyboard activation; a right mouse button is still a pointer.
  if (item) openTitleEpisodeContextMenu(event, item, { keyboard: event.button !== 2 && event.detail === 0 });
});
$("#title-main")?.addEventListener("keydown", (event) => {
  if (!(event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey))) return;
  const item = event.target.closest(".lib-chapter[data-chapter-code], .catalog-chapter[data-chapter-code]");
  if (item) openTitleEpisodeContextMenu(event, item, { keyboard: true });
});
$("#watch-chapters-body")?.addEventListener("contextmenu", (event) => {
  const item = event.target.closest(".watch-episode[data-watch-episode-code]");
  // Edge may report detail=0 for mouse right-clicks. button=2 remains a
  // pointer interaction and must place the menu at the clicked coordinates.
  if (item) openWatchEpisodeContextMenu(event, item, { keyboard: event.button !== 2 && event.detail === 0 });
});
wireWatchChapters();

wireStorageSettings();
[
  "#subtitle-style-font",
  "#subtitle-style-weight",
  "#subtitle-style-size",
  "#subtitle-style-shadow",
  "#subtitle-style-background",
  "#subtitle-style-position",
  "#subtitle-style-color",
  "#subtitle-style-romanization",
].forEach((selector) => {
  $(selector)?.addEventListener("input", readSubtitleStyleControls);
  $(selector)?.addEventListener("change", readSubtitleStyleControls);
});
$("#subtitle-style-reset").addEventListener("click", () => {
  state.subtitleStyle = { ...subtitleStyleDefaults };
  applySubtitleStyle({ save: true });
});
$("#subtitle-preview-rotate")?.addEventListener("click", () => {
  const preview = $("#subtitle-style-preview");
  if (!preview) return;
  preview.dataset.previewBackground = String((Number(preview.dataset.previewBackground || 0) + 1) % 5);
});
(() => {
  const page = $("#view-library");
  page?.addEventListener("click", handleLibraryCardAction);
  page?.addEventListener("contextmenu", (event) => {
    const target = event.target instanceof Element ? event.target : event.target?.parentElement;
    const holder = target?.closest("#library-list [data-series-key], #library-continue [data-series-key]");
    if (holder) openLibraryContextMenu(event, holder.dataset.seriesKey, { anchor: holder });
  });
  bindTabs($("#library-filter"), {
    onChange: (value) => {
      libraryView.filter = ["series", "movie", "anime", ...clientFeatures.libraryFilterIds].includes(value) ? value : "all";
      saveLibraryView();
      renderLibrary();
    },
  });
  $("#library-show-anilist")?.addEventListener("click", () => {
    // A saved Series/Movie/status filter can hide every newly imported Anime
    // title despite a successful sync. Make them discoverable in one click.
    libraryView.filter = "anime";
    libraryView.status = "any";
    libraryView.query = "";
    const search = $("#library-search");
    if (search) search.value = "";
    saveLibraryView();
    renderLibrary();
  });
  let searchTimer = 0;
  $("#library-search")?.addEventListener("input", (event) => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      libraryView.query = event.target.value.trim();
      renderLibrary();
    }, 120);
  });
  $("#library-sort")?.addEventListener("change", (event) => {
    libraryView.sort = ["recent", "added", "title", "title-desc", "watched", "unfinished", "progress"].includes(event.target.value) ? event.target.value : "recent";
    saveLibraryView();
    renderLibrary();
  });
  $("#library-status-filter")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-library-status]");
    if (!button || !["any", ...ANILIST_STATUS_FILTERS, "REPEATING"].includes(button.dataset.libraryStatus)) return;
    libraryView.status = button.dataset.libraryStatus;
    saveLibraryView();
    renderLibrary();
  });
  const moreButton = $("#library-more");
  const moreMenu = $("#library-more-menu");
  wirePopupMenu(moreMenu);
  wirePopupMenu($("#library-context-menu"));
  moreButton?.addEventListener("click", () => {
    if (openMenuState?.menu === moreMenu) closePopupMenu();
    else openPopupMenu(moreMenu, { anchor: moreButton });
  });
  moreMenu?.addEventListener("click", (event) => {
    if (event.target.closest('[role="menuitem"]')) closePopupMenu({ restoreFocus: false });
  });
  $("#library-open-file")?.addEventListener("click", () => $("#video-input")?.click());
})();

$("#settings-subdl-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const key = $("#settings-subdl-key").value.trim();
  const wyzieKey = $("#settings-wyzie-key")?.value.trim() || "";
  const subsourceKey = $("#settings-subsource-key")?.value.trim() || "";
  const baseLanguage = $("#settings-base-language").value;
  const targetLanguage = $("#settings-target-language").value;
  if (baseLanguage === targetLanguage) {
    setToolStatus("#settings-subdl-message", t("Base and target languages must be different."), true);
    return;
  }
  saveSubtitlePreferences(key, baseLanguage, targetLanguage, { wyzieKey, subsourceKey,
    baseLocale: $("#settings-base-locale").value, targetLocale: $("#settings-learning-locale").value,
    interfaceLanguage: $("#settings-interface-language").value });
  $("#subtitle-language").value = subtitleFinderLanguages();
  const providerCount = 1 + [state.subdlKey, state.wyzieKey, state.subsourceKey].filter(Boolean).length;
  setToolStatus("#settings-subdl-message", t("Saved: {count} subtitle sources", { count: providerCount }));
  renderSubtitleWorkspace();
});
$("#settings-subdl-clear").addEventListener("click", () => {
  saveSubtitlePreferences("", state.baseLanguage, state.targetLanguage, { wyzieKey: "", subsourceKey: "" });
  $("#settings-subdl-key").value = "";
  if ($("#settings-wyzie-key")) $("#settings-wyzie-key").value = "";
  if ($("#settings-subsource-key")) $("#settings-subsource-key").value = "";
  setToolStatus("#settings-subdl-message", t("Keys cleared. OpenSubtitles stays on."));
});
$("#find-subtitles-web").addEventListener("click", () => { void openSubtitleSearch({ auto: true }); });
$("#sync-subtitles")?.addEventListener("click", async () => {
  const tracks = currentSourceTracks().filter((track) => track.cues?.length);
  if (!tracks.length) {
    $("#media-status").textContent = "Add subtitles first";
    return;
  }
  if (audioSyncSource() && audioSyncTracks().length) {
    // Measure again from the audio; the current timing stays until a better match is found.
    audioSyncTracks().forEach((item) => { item.audioSync = { status: "syncing", windows: 0 }; });
    resetAudioSync();
    scheduleAudioSync(100);
    renderTracks();
    $("#media-status").textContent = "Syncing subtitles to the audio…";
    return;
  }
  if (tracks.length < 2) {
    $("#media-status").textContent = "Add another track to line them up";
    return;
  }
  $("#media-status").textContent = "Lining up tracks…";
  const { reference } = await alignCurrentSubtitleSet();
  $("#media-status").textContent = `Tracks lined up with ${reference?.label || "the best-timed track"}`;
  renderSubtitleWorkspace({ includeLearning: false });
});
$("#subtitle-add-file")?.addEventListener("click", () => $("#subtitle-input")?.click());
$("#subtitle-dock-style")?.addEventListener("click", () => openSubtitleStyleDialog());
(() => {
  const dock = $(".subtitle-dock");
  if (!dock) return;
  const hasFiles = (event) => [...(event.dataTransfer?.types || [])].includes("Files");
  dock.addEventListener("dragover", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dock.classList.add("is-drop-target");
  });
  dock.addEventListener("dragleave", (event) => {
    if (!dock.contains(event.relatedTarget)) dock.classList.remove("is-drop-target");
  });
  dock.addEventListener("drop", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dock.classList.remove("is-drop-target");
    const files = [...(event.dataTransfer?.files || [])].filter((file) => /\.(?:srt|vtt)$/i.test(file.name));
    if (!files.length) {
      $("#media-status").textContent = "Drop .srt or .vtt files";
      return;
    }
    handleSubtitleFiles(files).catch((error) => { $("#media-status").textContent = error.message || "Couldn't read that subtitle file"; });
  });
})();
$("#subtitle-web-form").addEventListener("submit", searchWebSubtitles);
$("#subtitle-language")?.addEventListener("input", syncSubtitleFinderLanguageChips);
$("#subtitle-web-dialog")?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-subtitle-lang-toggle]");
  if (!button) return;
  const selected = parseSubtitleFinderLanguages($("#subtitle-language").value) || [];
  const code = button.dataset.subtitleLangToggle;
  const next = selected.includes(code) ? selected.filter((value) => value !== code) : [...selected, code].slice(0, 4);
  $("#subtitle-language").value = next.join(",");
  syncSubtitleFinderLanguageChips();
});
$$('[data-close-dialog]').forEach((button) => button.addEventListener("click", () => $(`#${button.dataset.closeDialog}`).close()));
wireLibraryRemoveDialog();
$("#library-remove-entry")?.addEventListener("click", () => confirmLibraryRemoval());
$("#library-remove-chapters")?.addEventListener("click", () => confirmLibraryRemoval({ removeChapters: true }));

$("#library-context-menu").addEventListener("click", (event) => {
  const button = event.target.closest("[data-library-action]");
  if (!button || !libraryContextSeriesKey) return;
  const seriesKey = libraryContextSeriesKey;
  const series = buildLibrarySeries().find((item) => item.key === seriesKey);
  closeLibraryContextMenu();
  if (!series) return;
  if (button.dataset.libraryAction === "mark-watched") {
    setLibraryTitleWatched(series, !isLibraryTitleMarkedWatched(series));
    return;
  }
  if (button.dataset.libraryAction === "mark-season") {
    setLibrarySeasonWatched(series, Number(button.dataset.librarySeason), button.dataset.libraryWatched === "true");
    return;
  }
  if (button.dataset.libraryAction === "custom-image") {
    $("#library-custom-image-input").click();
    return;
  }
  if (button.dataset.libraryAction === "rename") {
    void promptDialog({ title: "Rename", label: "Title", value: series.title }).then((nextTitle) => {
      if (!nextTitle || nextTitle === series.title) return;
      updateLibrarySeriesEntries(seriesKey, (entry) => {
        entry.displayTitle = nextTitle;
        entry.updatedAt = Date.now();
      });
      renderLibrary();
      refreshTitlePage();
    });
    return;
  }
  if (button.dataset.libraryAction === "fetch-image") {
    void fetchArtworkForSeriesKey(seriesKey, { advance: true }).then((changed) => { if (changed) refreshTitlePage(); });
    return;
  }
  if (button.dataset.libraryAction === "delete") {
    openLibraryRemoveDialog(series);
  }
});

$("#library-custom-image-input").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  const seriesKey = libraryContextSeriesKey;
  event.target.value = "";
  if (!file || !seriesKey) return;
  try {
    const coverUrl = await customCoverDataUrl(file);
    updateLibrarySeriesEntries(seriesKey, (entry) => {
      entry.coverUrl = coverUrl;
      entry.artworkSource = "CUSTOM";
      entry.artworkPinned = true;
      entry.artworkIndex = 0;
      entry.updatedAt = Date.now();
    });
    renderLibrary();
    refreshTitlePage();
    artworkNotice("Poster saved");
  } catch (error) {
    artworkNotice(error.message || "Could not use that image", true);
  }
});

document.addEventListener("click", (event) => {
  // The click that opened a menu (on its button) reaches here too: keep that menu open.
  if (openMenuState && !openMenuState.menu.contains(event.target) && !openMenuState.anchor?.contains(event.target)) closePopupMenu({ restoreFocus: false });
  if (!event.target.closest(".player-popover, .player-speed, #player-source-switcher, #player-audio-switcher, #player-toggle-subs, #floating-player-captions")) closePlayerPopovers();
});
window.addEventListener("scroll", (event) => {
  if (openMenuState && !openMenuState.menu.contains(event.target)) closePopupMenu({ restoreFocus: false });
}, { passive: true, capture: true });
window.addEventListener("resize", () => closePopupMenu({ restoreFocus: false }));
window.addEventListener("resize", () => { if (viewActive("title")) fitTitleBackdrop(); }, { passive: true });

$("#sidebar-toggle").addEventListener("click", (event) => {
  event.preventDefault();
  const expand = !$(".app-shell").classList.contains("sidebar-expanded");
  setSidebarExpanded(expand);
  if (!expand) activeSidebarLauncher()?.focus();
});

for (const launcher of [$("#app-sidebar-toggle"), $("#section-sidebar-toggle")]) launcher?.addEventListener("click", (event) => {
  event.preventDefault();
  setSidebarExpanded(true);
  // Focus moves to the drawer's own collapse control, because the external
  // launcher is no longer displayed while the drawer is open.
  $("#sidebar-toggle")?.focus();
});

$("#section-home-button")?.addEventListener("click", () => switchView("home"));

$(".app-sidebar").addEventListener("click", (event) => {
  if (event.target.closest("button, input, #sidebar-toggle")) return;
  setSidebarExpanded(!$(".app-shell").classList.contains("sidebar-expanded"));
});

// The drawer overlays every desktop page. Clicking the scrim dismisses it,
// without activating controls behind the overlay (including the player).
$(".app-shell").addEventListener("click", (event) => {
  if (window.innerWidth <= 680
    || !$(".app-shell").classList.contains("sidebar-expanded")
    || event.target.closest(".app-sidebar, #app-sidebar-toggle")
    || event.target.closest("#section-sidebar-toggle")) return;
  setSidebarExpanded(false);
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape"
    || !$(".app-shell").classList.contains("sidebar-expanded")) return;
  setSidebarExpanded(false);
  activeSidebarLauncher()?.focus();
});

window.addEventListener("resize", () => {
  if (window.innerWidth <= 680) setSidebarExpanded(false, { persist: false });
});

frame.addEventListener("pointerenter", revealPlayerControls);
frame.addEventListener("pointermove", revealPlayerControls);
frame.addEventListener("pointerleave", hidePlayerControls);
frame.addEventListener("click", (event) => {
  if (event.target === video) {
    togglePlayback();
    hidePlayerControls();
    return;
  }
  if (event.target.closest("#compat-controls")) schedulePlayerControlsHide();
});

video.addEventListener("timeupdate", () => {
  if (typeof isNewSourceFramePending === "function" && isNewSourceFramePending()) return;
  // Preserve frame-accurate subtitles during decoder stalls; recover from a
  // stale frame only on explicit pause/resume and caption interactions.
  state.currentMs = (presentedSubtitleSeconds() ?? absolutePlaybackSeconds()) * 1000;
  if (state.pendingSeek?.priming) {
    updateCompatControls();
    return;
  }
  if (video.dataset.progressive === "1") {
    const end = progressiveBufferEndAroundCurrent();
    const current = Number(video.currentTime);
    if (Number.isFinite(end) && Number.isFinite(current)
      && end - current <= 1.5) continueProgressiveOrRecover();
  }
  refreshEpisodeSkipOptions();
  markPlaybackMotion();
  prefetchUpcomingChapter();
  // Embedded caption windows must keep loading in ordinary playback mode too.
  loadMoreEmbeddedSubtitles();
  renderSubtitles();
  updateCompatControls();
  checkAudioSyncCoverage();
  recordWatchProgress();
});
for (const eventName of ["waiting", "stalled"]) {
  video.addEventListener(eventName, () => {
    // A SourceBuffer can run out of decoded frames BEFORE its GOP metadata
    // end. There may be no final timeupdate/ended event in that case, so
    // retry the next verified GOP or move to the complete indexed MP4/native
    // source on actual decoder starvation. Never switch while user-paused.
    if (video.dataset.progressive === "1" && !video.paused && !state.pendingSeek)
      continueProgressiveOrRecover({ force: true });
  });
}
video.addEventListener("ended", () => {
  if (typeof isNewSourceFramePending === "function" && isNewSourceFramePending()) return;
  if (video.dataset.progressive === "1" && state.pendingSeek?.priming) {
    const pending = state.pendingSeek;
    // A standalone GOP can finish without reaching the requested frame.
    // Treat that as a bounded native fallback, never a terminal player error.
    void openTranscodeAt(pending.target, { wasPlaying: pending.wasPlaying, forceNative: true });
    return;
  }
  if (state.pendingSeek?.priming) {
    if (!state.pendingSeek.streamInstalled) return;
    if (typeof transcodeStartAttempt !== "undefined" && transcodeStartAttempt?.fallbackToNative?.()) return;
    cancelTranscodeStart();
    video.pause();
    setPlayerLoading(100, "Video synchronization unavailable",
      "The converted stream ended before the requested frame.", { error: true });
    return;
  }
  // A queued seek still displays the outgoing stream for its debounce period.
  // Its terminal event must not recover or auto-advance the episode.
  if (state.pendingSeek) return;
  if (video.dataset.progressive === "1") {
    // A verified GOP window is intentionally shorter than the episode. Its
    // natural EOF is not a media error nor permission to play the next title.
    if (absolutePlaybackSeconds() < state.mediaDurationMs / 1000 - 0.25)
      continueProgressiveOrRecover({ force: true, fromEnded: true });
    return;
  }
  // Transcoded streams represent a window beginning at an offset, so a premature
  // stream EOF is not the end of the actual movie.
  const duration = state.mediaDurationMs / 1000;
  if (duration > 0 && absolutePlaybackSeconds() < duration - Math.max(3, duration * 0.002)) {
    if (typeof fallbackActiveRemuxMseToNative === "function" && fallbackActiveRemuxMseToNative()) return;
    void recoverPlayback("early-eof");
    return;
  }
  stopRecoveryWatch();
  recordWatchProgress({ force: true });
  startAutoNext();
});
wirePlayerVideoEvents();
$("#compat-play").addEventListener("click", () => {
  togglePlayback();
});
export const compatProgress = $("#compat-progress");
let phoneTimelineScrub = null;
if (window.matchMedia?.("(hover: none) and (pointer: coarse)")?.matches) {
  // Touch ranges can send multiple pointer/input/change events for one drag.
  // Coalesce preview work and commit one seek; do not change desktop hovering.
  phoneTimelineScrub = createTimelineScrubController({
    range: compatProgress, frame: window,
    onPreview: (seconds) => { showScrubTime(seconds); updateCompatControls(); },
    onScrubbingChange: (scrubbing) => { state.scrubbing = scrubbing; },
    onHidePreview: () => {
      $("#player-scrub-time").hidden = true;
      updateCompatControls();
    },
    onCommit: (target) => seekPlayerTo(target),
  });
} else {
  compatProgress.addEventListener("pointerdown", () => { state.scrubbing = true; });
  compatProgress.addEventListener("pointermove", (event) => showScrubTime(state.scrubbing ? Number(compatProgress.value) : progressTimeAt(event.clientX)));
  compatProgress.addEventListener("pointerleave", () => { if (!state.scrubbing) $("#player-scrub-time").hidden = true; });
  compatProgress.addEventListener("input", () => {
    state.scrubbing = true;
    showScrubTime(Number(compatProgress.value));
    updateCompatControls();
  });
  compatProgress.addEventListener("change", (event) => {
    const target = Number(event.target.value) || 0;
    state.scrubbing = false;
    $("#player-scrub-time").hidden = true;
    seekPlayerTo(target);
  });
  // A press without a move fires no change event; release the thumb anyway.
  window.addEventListener("pointerup", () => window.setTimeout(endScrub, 60));
  window.addEventListener("pointercancel", endScrub);
  compatProgress.addEventListener("blur", endScrub);
}
$("#player-seek-back").addEventListener("click", () => seekPlayerBy(-10));
$("#player-seek-forward").addEventListener("click", () => seekPlayerBy(10));
$("#player-prev-chapter").addEventListener("click", () => { void playAdjacentChapter(-1); });
$("#player-next-chapter").addEventListener("click", () => { void playAdjacentChapter(1); });
$("#player-up-next-play").addEventListener("click", playAutoNextNow);
$("#player-up-next-cancel").addEventListener("click", cancelAutoNext);
$("#watch-skip-intro")?.addEventListener("click", () => setEpisodeAutoSkip("intro", !episodeAutoSkip.intro));
$("#watch-skip-credits")?.addEventListener("click", () => setEpisodeAutoSkip("outro", !episodeAutoSkip.outro));
export const autoNextToggle = $("#watch-autoplay-next");
export const autoNextInline = $("#watch-autoplay-inline");
if (autoNextToggle) {
  autoNextToggle.checked = autoNextEnabled;
  autoNextToggle.addEventListener("change", () => setAutoplayNextEnabled(autoNextToggle.checked));
}
if (autoNextInline) {
  autoNextInline.setAttribute("aria-pressed", String(autoNextEnabled));
  autoNextInline.addEventListener("click", () => setAutoplayNextEnabled(!autoNextEnabled));
}
wirePlayerSourceButtons();
$("#player-source-switcher")?.addEventListener("click", (event) => {
  event.stopPropagation();
  const menu = $("#player-source-menu");
  const willOpen = menu.hidden;
  closePlayerPopovers(menu);
  if (willOpen) renderPlayerSourceMenu();
  menu.hidden = !willOpen;
});
$("#player-audio-switcher")?.addEventListener("click", (event) => {
  event.stopPropagation();
  const menu = $("#player-audio-menu");
  const willOpen = menu.hidden;
  closePlayerPopovers(menu);
  if (willOpen) renderPlayerAudioMenu();
  menu.hidden = !willOpen;
});
$("#player-mute").addEventListener("click", () => {
  setPlayerMutePreference(!playerWantsMuted());
  updateCompatControls();
});
$("#player-volume").addEventListener("input", (event) => {
  video.volume = Math.max(0, Math.min(1, Number(event.target.value) || 0));
  setPlayerMutePreference(video.volume === 0);
  updateCompatControls();
});
$("#player-toggle-subs").addEventListener("click", togglePlayerSubtitleMenu);
$("#floating-player-captions")?.addEventListener("click", togglePlayerSubtitleMenu);
// Keep the original player menus as the only action owners. Phone controls
// manage touch dismissal and geometry without installing duplicate handlers.
const phonePlayerUi = installPhonePlayerControls({
  win: window,
  closePopovers: () => closePlayerPopovers(),
});
registerPhonePlayerLifecycle({
  cancelScrub: () => phoneTimelineScrub?.cancel?.(),
  onControlsHidden: () => phonePlayerUi?.onControlsHidden?.(),
});
registerPhonePlayerNavigationHook(() => {
  phoneTimelineScrub?.cancel?.();
  phonePlayerUi?.onNavigation?.();
});
$("#player-subtitle-menu")?.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.hasAttribute("data-caption-customize")) { openPlayerSubtitleManager(); return; }
  if (button.hasAttribute("data-caption-off")) {
    noteSubtitleVisibilityIntent();
    state.subtitlesVisible = false;
  } else if (button.hasAttribute("data-caption-track")) {
    const track = preferredSourceTracks().find((item) => item.id === button.dataset.captionTrack);
    if (!track) return;
    noteSubtitleVisibilityIntent();
    const enabled = state.subtitlesVisible && track.visible;
    if (!state.subtitlesVisible) currentSourceTracks().forEach((item) => { item.visible = false; });
    track.visible = !enabled;
    state.subtitlesVisible = true;
  } else if (button.hasAttribute("data-caption-embedded")) {
    const stream = Number(button.dataset.captionEmbedded);
    const embedded = (state.currentMediaProbe?.subtitleTracks || []).find((item) =>
      Number(item.streamIndex) === stream && item.textBased);
    if (!embedded) return;
    const imported = currentSourceTracks().find((item) => Number(item.embeddedStreamIndex) === stream);
    // Partial or still-streaming subtitles can already be visible. Hide/Show
    // must work immediately instead of starting another import and making the
    // current lines unexpectedly disappear or reappear.
    if (imported?.cues?.length) {
      noteSubtitleVisibilityIntent();
      const enabled = state.subtitlesVisible && imported.visible;
      if (!state.subtitlesVisible) currentSourceTracks().forEach((item) => { item.visible = false; });
      imported.visible = !enabled;
      state.subtitlesVisible = true;
    } else void importEmbeddedSubtitleTrack(embedded);
  } else return;
  refreshSubtitleClockForInteraction();
  renderSubtitleWorkspace({ includeLearning: false });
  renderPlayerSubtitleMenu();
  clearPlayerControlsHideTimer();
});
$("#subtitle-manager-close")?.addEventListener("click", () => $("#player-subtitle-dialog")?.close());
$("#player-subtitle-dialog")?.addEventListener("click", (event) => {
  const dialog = event.currentTarget;
  // A backdrop click is retargeted to <dialog> in Edge. Do not close when
  // clicking its actual contents or dragging a scrollbar inside the modal.
  if (event.target !== dialog) return;
  const rect = dialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right
    || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
});
$("#player-subtitle-dialog")?.addEventListener("close", () => {
  subtitleRenderMemo.key = "";
  renderSubtitleWorkspace({ includeLearning: false });
});
$("#player-loop-line").addEventListener("click", () => {
  state.loopLine = !state.loopLine;
  updatePlayerPreferenceButtons();
});
$("#player-swap-languages").addEventListener("click", () => {
  const oldBase = state.baseLanguage;
  saveSubtitlePreferences(state.subdlKey, state.targetLanguage, oldBase);
  $("#subtitle-language").value = subtitleFinderLanguages();
  renderSubtitleWorkspace();
});
// Ignore the old persistent theater preference: every new player starts in
// the default split layout, even if an earlier version stored theater=1.
setWatchTheaterMode(false);
$("#player-theater").addEventListener("click", () => {
  const entering = !$("#watch-player-layout").classList.contains("is-theater");
  setWatchTheaterMode(entering);
  revealPlayerControls();
  if (entering && typeof requestAnimationFrame === "function") requestAnimationFrame(() => {
    const target = $("#video-frame");
    const rect = target?.getBoundingClientRect();
    const sticky = window.innerWidth <= 680 ? 114 : 72;
    if (rect && (rect.top < sticky - 4 || rect.bottom > window.innerHeight - 6))
      target.scrollIntoView({ block: "start", behavior: "instant" });
  });
});
$("#player-fullscreen").addEventListener("click", async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await frame.requestFullscreen();
  } catch (error) {
    console.warn("Fullscreen unavailable:", error);
  }
});
$("#speed-select").addEventListener("click", () => {
  const menu = $("#player-speed-menu");
  const opening = menu.hidden;
  closePlayerPopovers(opening ? menu : null);
  menu.hidden = !opening;
  $("#speed-select").setAttribute("aria-expanded", String(opening));
  if (opening) menu.querySelector('[aria-checked="true"]')?.focus();
});
$("#player-speed-menu").addEventListener("click", (event) => {
  const option = event.target.closest("[data-speed]");
  if (!option) return;
  video.playbackRate = Number(option.dataset.speed);
  // Stream replacement must not reset the user's selected playback speed.
  video.defaultPlaybackRate = video.playbackRate;
  syncPlayerSpeed();
  closePlayerPopovers();
  $("#speed-select").focus();
});
$("#player-speed-menu").addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    closePlayerPopovers();
    $("#speed-select").focus();
  } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const options = [...event.currentTarget.querySelectorAll("[data-speed]")];
    const index = options.indexOf(document.activeElement);
    options[(index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length]?.focus();
  }
});
video.addEventListener("ratechange", syncPlayerSpeed);
$("#pause-after-cue").addEventListener("change", (event) => { state.pauseAfterCue = event.target.checked; });
$("#prev-cue").addEventListener("click", () => { const i = currentCueIndex(); const cues = allPrimaryCues(); const track = activeTrack(); if (i >= 0) seekTo(cuePlaybackMs(cues[Math.max(0, i - 1)], track)); });
$("#next-cue").addEventListener("click", () => { const i = currentCueIndex(); const cues = allPrimaryCues(); const track = activeTrack(); if (i >= 0) seekTo(cuePlaybackMs(cues[Math.min(cues.length - 1, i + 1)], track)); });
$("#repeat-cue").addEventListener("click", () => { const i = currentCueIndex(); const cues = allPrimaryCues(); const track = activeTrack(); if (i >= 0) seekTo(cuePlaybackMs(cues[i], track)); });

$$('.nav-btn').forEach((button) => button.addEventListener("click", () => {
  if (["library", "calendar"].includes(button.dataset.view) && viewActive("watch")) {
    void navigateWatchToLibrary(() => switchView(button.dataset.view));
  } else switchView(button.dataset.view);
}));
if ("scrollRestoration" in window.history) window.history.scrollRestoration = "manual";
window.addEventListener("popstate", () => switchView(viewFromLocation(), { historyMode: "none", restoreScroll: true }));
$("#dialog-close").addEventListener("click", () => $("#detail-dialog").close());

$("#settings-base-language").addEventListener("change", (event) => renderLocaleOptions("#settings-base-locale", event.target.value, ""));
$("#settings-target-language").addEventListener("change", (event) => renderLocaleOptions("#settings-learning-locale", event.target.value, ""));

document.addEventListener("keydown", (event) => {
  if (document.querySelector("dialog[open]")) return;
  const tag = event.target?.tagName?.toLowerCase();
  const typing = ["input", "textarea", "select"].includes(tag) || event.target?.isContentEditable;
  if (!typing && clientFeatures.handleKey(event)) return;
  if (playerArrowSeek(event, tag)) return;
  if (["input", "textarea", "select", "button"].includes(tag) || event.target?.isContentEditable) return;

  if ($("#view-watch").classList.contains("is-active") && frame.classList.contains("has-video")) {
    const key = event.key.toLowerCase();
    if (event.code === "Space") {
      event.preventDefault();
      togglePlayback();
      return;
    }
    if (key === "j") { event.preventDefault(); seekPlayerBy(-10); return; }
    if (key === "l") { event.preventDefault(); seekPlayerBy(10); return; }
    if (key === "m") { event.preventDefault(); setPlayerMutePreference(!playerWantsMuted()); updateCompatControls(); return; }
    if (key === "t" && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); $("#player-theater").click(); return; }
    if (key === "f") { event.preventDefault(); $("#player-fullscreen").click(); return; }
    if (key === "n") { event.preventDefault(); $("#player-next-chapter").click(); return; }
    if (key === "b") { event.preventDefault(); $("#player-prev-chapter").click(); return; }
  }

});

window.addEventListener("pagehide", () => {
  recordWatchProgress({ force: true });
});
// Android can suspend the WebView when the user leaves for Home, another app
// or the screen turns off, without delivering pagehide first.
document.addEventListener("visibilitychange", () => {
  if (document.hidden && window.LvlAndroid) recordWatchProgress({ force: true });
});

applyLanguagePreferencesToTracks();
$("#subtitle-language").value = subtitleFinderLanguages();
syncSubtitleFinderLanguageChips();
setSidebarExpanded(false);
applySubtitleStyle();
renderAll();

void hydratePersistentAppState().then(() => {
  watchRestoreReady = true;
  if (POPUP_HANDOFF) {
    void startPopupPlayback();
    return;
  }
  restoreLastWatchOnVisit();
  backfillAniListCommunityScores();
  if (viewActive("calendar")) calendarUi.refresh();
  else calendarUi.scanRecent();
  // Only run after the SQLite-backed Library has finished hydrating, otherwise
  // an account sync could mistakenly work from an empty fallback Library.
  if (anilistOAuthResponse) void completeAniListAuthorization();
  else if (readAniListAccount(localStorage)) {
    scheduleAniListAutoSync(1500);
    // A connected AniList account can have watched progress from another app
    // even when this LVL instance has never watched the title or opted in to
    // outbound writes. Import owner-verified history on startup in either case.
    void syncAniListLibrary({ quiet: true }).catch(() => {});
  }
}).catch((error) => {
  showAniListAutoStatus("Waiting for LVL Library hydration before AniList sync.", true);
  console.warn("AniList initialization deferred:", error?.message);
});
switchView(viewFromLocation(), { historyMode: "replace" });
if (!POPUP_HANDOFF) void refreshPopupAvailability();
window.addEventListener("online", () => scheduleAniListAutoSync(1000));
window.addEventListener("focus", () => {
  if (Date.now() - readAniListPreference(localStorage).lastPull >= 60 * 60_000) scheduleAniListAutoSync(1000);
});
setInterval(() => {
  if (Date.now() - readAniListPreference(localStorage).lastPull >= 60 * 60_000) scheduleAniListAutoSync(1000);
  if (anilistScoreSyncEnabled() && Date.now() - (Number(localStorage.getItem(ANILIST_LIBRARY_KEY)) || 0) >= 60 * 60_000)
    void syncAniListLibrary({ quiet: true }).catch(() => {});
}, 10 * 60_000);

setInterval(() => {
  if ($("#view-home")?.classList.contains("is-active")
      && state.homeLoaded
      && Date.now() - state.homeCatalogUpdatedAt >= HOME_CATALOG_REFRESH_MS) {
    void loadHomeCatalog({ force: true });
  }
}, 60 * 1000);
