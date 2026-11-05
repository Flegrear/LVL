// Views and routes: switching views, the last Watch selection and the sidebar.
import { t } from "../ui/ui-i18n.js";
import {
  calendarUi, clientFeatures, DEFAULT_DOCUMENT_TITLE, learningEnabled, POPUP_HANDOFF, ROUTE_VIEWS,
  state, VIEW_ROUTES, viewScroll, watchRestoreReady,
} from "../../app.js";
import { $, $$ } from "./dom.js";
import { renderSettings } from "../settings/settings-page.js";
import { closeUpdateNotificationPopover, paintAppUpdateCard } from "../updates/app-updates.js";
import { startTransferStats } from "../player/player-core.js";
import { closePlayerPopovers } from "../player/player-menus.js";
import { clearManualFloating, updateFloatingPlayback } from "../player/floating-player.js";
import {
  playLibraryEpisode, stopPlaybackIfHiddenAfterNavigation, watchPendingSelection,
} from "../player/torrent-playback.js";
import { clearAutoNext } from "../watch/episode-navigation.js";
import { libraryEntryById } from "../library/library-data.js";
import { renderLibrary } from "../library/library-page.js";
import { renderTitlePage } from "../title/title-page.js";
import { loadHomeCatalog, saveHomePlace } from "../home/home-page.js";
import { refreshRandomPickIndicator } from "../home/random-pick.js";
import { catalogSearchIsOpen, closeCatalogSearch } from "../catalog/catalog-search.js";
import {
  browserCoachChecking, browserCoachStatus, coachProviders, linePreview, refreshBrowserCoachStatus,
  refreshCoachProviders, renderReview, renderStudyPage, renderTest, reviewMode,
} from "../learning/index.js";

export function viewActive(name) {
  return Boolean($(`#view-${name}`)?.classList.contains("is-active"));
}

const LAST_WATCH_SELECTION_KEY = "lvl-last-watch-selection-v1";

let watchRestoreStarted = false;

export function rememberWatchSelection(libraryId, fileIndex) {
  if (!libraryId || !Number.isInteger(Number(fileIndex))) return;
  try {
    localStorage.setItem(LAST_WATCH_SELECTION_KEY, JSON.stringify({ libraryId, fileIndex: Number(fileIndex) }));
  } catch (error) {
    console.warn("Could not save the last Watch selection:", error);
  }
}

function lastWatchSelection() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(LAST_WATCH_SELECTION_KEY) || "null"); } catch {}
  const candidates = [saved, ...state.library.filter((entry) => entry.lastPlayedAt)
    .sort((a, b) => Number(b.lastPlayedAt) - Number(a.lastPlayedAt))
    .map((entry) => ({ libraryId: entry.id, fileIndex: entry.lastPlayedFileIndex }))];
  for (const candidate of candidates) {
    const entry = libraryEntryById(candidate?.libraryId);
    if (candidate?.fileIndex === null || candidate?.fileIndex === undefined || candidate?.fileIndex === "") continue;
    const fileIndex = Number(candidate?.fileIndex);
    const episode = entry?.episodes?.find((item) => Number(item.fileIndex) === fileIndex);
    // Older Library snapshots may contain the source but no chapter listing.
    // Torrent resolution can still reopen the selected file by its saved index.
    if (entry?.magnet && Number.isInteger(fileIndex) && fileIndex >= 0)
      return { entry, episode: episode || { fileIndex } };
  }
  return null;
}

export function restoreLastWatchOnVisit() {
  if ((typeof POPUP_HANDOFF !== "undefined" && POPUP_HANDOFF) || !watchRestoreReady || watchRestoreStarted || !viewActive("watch")
    || state.currentSource?.kind !== "idle" || watchPendingSelection) return;
  const target = lastWatchSelection();
  if (!target) return;
  watchRestoreStarted = true;
  const progress = target.episode.progress;
  const atMs = !progress?.finished && Number(progress?.positionMs) < Number(progress?.durationMs) * 0.92
    ? Math.max(0, Number(progress?.positionMs) || 0) : 0;
  void playLibraryEpisode(target.entry.id, Number(target.episode.fileIndex), { resumeAtSeconds: atMs / 1000 });
}

export function viewFromLocation() {
  const pathname = window.location.pathname.replace(/\/$/, "") || "/";
  return ROUTE_VIEWS[pathname] || (pathname === "/tests" ? "test" : "home");
}

export function switchView(view, { historyMode = "push", restoreScroll = false, query } = {}) {
  if (!learningEnabled && ["study", "review", "test"].includes(view)) view = "home";
  if (view === "watch" && (linePreview.active || linePreview.pending)) return;
  if (catalogSearchIsOpen()) closeCatalogSearch();
  if (view === "watch") linePreview.preventBackgroundPlayback = false;
  if (view === "watch") clearManualFloating();
  if (!VIEW_ROUTES[view]) view = "home";
  updateFloatingPlayback(view);
  stopPlaybackIfHiddenAfterNavigation(view);
  // The hidden, paused Watch view must not keep refreshing the torrent's
  // 30-minute server TTL. Resume the heartbeat only while Watch is visible;
  // floating playback is deliberately exempt from the hidden-page pause.
  if (view === "watch" && state.currentSource?.sessionId && !state.transferStatsTimer)
    startTransferStats(state.currentSource.sessionId);
  if (view !== "watch") {
    clearAutoNext();
    closePlayerPopovers();
    if ($("#player-subtitle-dialog")?.open) $("#player-subtitle-dialog").close();
    phonePlayerNavigationHook?.();
  }
  if (lastViewKey) viewScroll.set(lastViewKey, window.scrollY);
  if (view !== "home" && state.homeLoaded && $("#view-home")?.classList.contains("is-active")) {
    saveHomePlace();
  }
  $$(".view").forEach((element) => element.classList.toggle("is-active", element.id === `view-${view}`));
  paintAppUpdateCard();
  const topbarLabel = $("#app-topbar-view-label");
  if (topbarLabel) topbarLabel.textContent = t(({ home: "Home", watch: "Watch", library: "Library", calendar: "Calendar", study: "Study", review: "Review", test: "Tests", settings: "Settings", title: "Library" })[view] || clientFeatures.viewLabel(view));
  if ($(".app-shell")?.classList.contains("sidebar-expanded")) setSidebarExpanded(false, { persist: false });
  if (view !== "title") {
    const navView = clientFeatures.navFor(view) || view;
    $$(".nav-btn").forEach((button) => button.classList.toggle("is-active", button.dataset.view === navView));
  }
  // Feature views with keepQuery: a sidebar click (push without a query) opens
  // the bare route, internal navigation passes { query }, reload and Back keep it.
  const featureQuery = clientFeatures.keepsQuery(view)
    ? (typeof query === "string" ? (query && !query.startsWith("?") ? `?${query}` : query)
      : historyMode === "push" ? "" : window.location.search)
    : null;
  const keepQuery = view === "title" || featureQuery !== null;
  const route = keepQuery ? `${VIEW_ROUTES[view]}${view === "title" ? window.location.search : featureQuery}` : VIEW_ROUTES[view];
  const here = keepQuery ? `${window.location.pathname}${window.location.search}` : window.location.pathname;
  if (historyMode === "replace") window.history.replaceState({ view }, "", route);
  else if (historyMode === "push" && here !== route) window.history.pushState({ view }, "", route);
  if (view === "title") renderTitlePage();
  else if (document.title !== DEFAULT_DOCUMENT_TITLE) document.title = DEFAULT_DOCUMENT_TITLE;
  if (typeof refreshRandomPickIndicator === "function") refreshRandomPickIndicator();
  const previousKey = lastViewKey;
  lastViewKey = keepQuery ? `${view}${window.location.search}` : view;
  if (restoreScroll) {
    const top = viewScroll.get(lastViewKey) || 0;
    requestAnimationFrame(() => window.scrollTo({ top, behavior: "instant" }));
  } else if (previousKey && previousKey !== lastViewKey) {
    window.scrollTo({ top: 0, behavior: "instant" });
  }
  if (view === "study") renderStudyPage();
  if (view === "review") renderReview();
  if (view === "test") renderTest();
  if (view === "library") {
    renderLibrary();
    void loadHomeCatalog();
  }
  if (view === "calendar") calendarUi.activate();
  else calendarUi.deactivate();
  clientFeatures.showView(view);
  if (view === "settings") {
    renderSettings();
    if (learningEnabled) {
      if (!coachProviders.length) void refreshCoachProviders();
      if (!browserCoachStatus && !browserCoachChecking) void refreshBrowserCoachStatus();
    }
  }
  if (view === "review" && reviewMode === "voice" && !coachProviders.length) void refreshCoachProviders();
  if (view === "home") void loadHomeCatalog();
  if (view === "watch") restoreLastWatchOnVisit();
}

// The phone popover state lives in the app shell, not the router. Register its
// dismissal hook at startup rather than importing app.js into navigation.
let phonePlayerNavigationHook = null;
export function registerPhonePlayerNavigationHook(callback) {
  phonePlayerNavigationHook = typeof callback === "function" ? callback : null;
}

export let lastViewKey = "";

export async function navigateWatchToLibrary(openDestination) {
  // Keep the originating click active for desktop PiP if the user selected it.
  openDestination();
}

export function setSidebarExpanded(expanded, { persist = false } = {}) {
  const allowExpand = window.innerWidth > 680;
  const next = Boolean(expanded && allowExpand);
  // The popover belongs to the expanded sidebar. Its fixed positioning would
  // otherwise leave an orphaned menu visible after the drawer is collapsed.
  if (!next) closeUpdateNotificationPopover();
  $(".app-shell").classList.toggle("sidebar-expanded", next);
  const label = next ? "Collapse navigation" : "Expand navigation";
  // Keep the translation annotations and the live label in sync. Otherwise
  // changing language can announce "Expand" while the drawer is already open.
  for (const toggle of [$("#sidebar-toggle"), $("#app-sidebar-toggle"), $("#section-sidebar-toggle")]) {
    if (!toggle) continue;
    toggle.setAttribute("aria-expanded", String(next));
    toggle.setAttribute("data-i18n-aria-label", label);
    toggle.setAttribute("data-i18n-title", label);
    toggle.setAttribute("aria-label", t(label));
    toggle.title = t(label);
  }
  // Drawer expansion is intentionally session-only. Persisting it in either
  // localStorage or SQLite made a refresh reopen the drawer over the player.
  // Keep the option for existing callers, but never write UI visibility.
  void persist;
}

export function activeSidebarLauncher() {
  return $("#view-home")?.classList?.contains("is-active") === false
    ? ($("#section-sidebar-toggle") || $("#app-sidebar-toggle")) : $("#app-sidebar-toggle");
}
