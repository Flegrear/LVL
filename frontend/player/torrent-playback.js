// Opening torrents and local files, and choosing their video files.
import { emptyMarkup, escapeHtml, icon, metaMarkup, toast } from "../ui/ui.js";
import { waitForStartupMediaProbe } from "./media-startup.js";
import { selectBrowserPlaybackWithCapabilities } from "./browser-media.js";
import { formatBytes, frame, playbackMetrics, popupPlayer, state, TITLE_STATUS, video } from "../../app.js";
import { $, setToolStatus } from "../app/dom.js";
import { fetchJson, postJson } from "../app/http.js";
import { rememberWatchSelection, switchView, viewActive } from "../app/navigation.js";
import { mayShareTorrentResource, playbackIntentOwner, playbackSessionReservationOwner } from "./playback-intent.js";
import { playerStorageLimit } from "../settings/storage-settings.js";
import {
  absolutePlaybackSeconds, beginSourceTransition, cancelTranscodeStart, changeRecoverySource,
  clearBufferingTimer, openTranscodeAt, recoveryBusy, resetRecoveryDisplay, restartTranscodeAt,
  revealPlayerControls, setMediaSource, setPlayerLoading, setPlayerLoadingTitle, startTransferStats,
  stopTransferStats, updateCompatControls, updateTransferStats,
} from "./player-core.js";
import {
  applyLanguagePreferencesToTracks, cleanMediaTitle, episodeIdentity, normalizeCollectionTitle,
  preferredAudioTrackIndex, releaseNeedsAudioTranscode, sourceTagFor, updatePlayerIdentity,
} from "./player-tracks.js";
import { audioOutputMode, renderPlayerAudioMenu, switchAudioTrack } from "./player-menus.js";
import { cancelPhoneTimelineScrub } from "./phone-seek-lifecycle.js";
import { serverCanConvertVideo } from "./video-conversion-capability.js";
import { refreshSubtitleTimelineFits } from "./subtitle-timing.js";
import { renderSubtitleStyleControls } from "./subtitle-style.js";
import {
  embeddedSubtitleImports, embeddedSubtitleProbePosition, enableDefaultEmbeddedSubtitles,
} from "./embedded-subtitles.js";
import { resetAudioSync } from "./audio-sync.js";
import { refreshEpisodeSkipOptions } from "./episode-skips.js";
import { dismissPopupPlayer, floatingDesktopPending, floatingDesktopWindow } from "./floating-player.js";
import { renderWatchChapters, setWatchTheaterMode } from "../watch/watch-page.js";
import {
  buildLibrarySeries, catalogMediaKind, libraryEntryById, librarySeriesKey, upsertLibrarySession,
} from "../library/library-data.js";
import { libraryChapterName, renderLibrary, updateLibrarySummary } from "../library/library-page.js";
import { renderHome } from "../home/home-page.js";
import { buttonText, catalogSeriesKey, librarySourceMetaFromStream, setButtonText } from "../catalog/catalog-search.js";

export function stopPlaybackIfHiddenAfterNavigation(destination) {
  if (destination === "watch" || !viewActive("watch")) return;
  // A source may still be resolving when Home is opened. The popup decision
  // was made before media could play: never let that old request start hidden
  // audio later unless an actual floating/PiP surface remains active.
  if ($("#view-watch")?.classList.contains("is-floating") || floatingDesktopWindow || (typeof popupPlayer !== "undefined" && popupPlayer.open)
    || floatingDesktopPending || document.pictureInPictureElement === video) return;
  playbackLoadRequestId += 1;
  const currentIntent = playbackIntentOwner.current();
  if (currentIntent?.phase === "pending")
    playbackIntentOwner.cancelCurrentForNavigation(currentIntent.token);
  pendingDirectTorrentSelection = null;
  flushAbandonedLibrarySessions();
  cancelTranscodeStart();
  libraryPlaybackResolveController?.abort("left player without floating playback");
  libraryPlaybackResolveController = null;
  libraryPlaybackPendingMagnet = "";
  video.pause();
  clearBufferingTimer();
  stopTransferStats();
  resetRecoveryDisplay();
}

export function episodeSortKey(name) {
  const match = String(name).match(/S(\d{1,2})E(\d{1,3})/i) || String(name).match(/(?:^|\D)(\d{1,2})x(\d{1,3})(?:\D|$)/i);
  if (!match) return null;
  return Number(match[1]) * 1000 + Number(match[2]);
}

export function sortedVideoFiles(files) {
  return files.filter((file) => file.video).sort((a, b) => {
    const aEpisode = episodeSortKey(a.name);
    const bEpisode = episodeSortKey(b.name);
    if (aEpisode !== null && bEpisode !== null) return aEpisode - bEpisode;
    if (aEpisode !== null) return -1;
    if (bEpisode !== null) return 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });
}

export function partitionTorrentVideos(files) {
  const videos = sortedVideoFiles(files);
  const bestByEpisode = new Map();
  videos.forEach((file) => {
    const key = episodeSortKey(file.name);
    if (key === null) return;
    const current = bestByEpisode.get(key);
    if (!current || Number(file.length || 0) > Number(current.length || 0)) bestByEpisode.set(key, file);
  });
  if (bestByEpisode.size < 2) return { primary: videos, extras: [] };
  const primaryIndexes = new Set([...bestByEpisode.values()].map((file) => file.index));
  return {
    primary: videos.filter((file) => primaryIndexes.has(file.index)),
    extras: videos.filter((file) => !primaryIndexes.has(file.index)),
  };
}

// Keep the intended title/episode visible in the normal split Watch layout
// while torrent discovery and media probing are still in progress.
export let watchPendingSelection = null;

export async function releaseTorrentSession(lease, magnet = null, fromRetirement = false) {
  // A session ID alone has no deletion authority. A stale callback must never
  // be able to release a newer POST acquisition bearing the same ID.
  if (!lease?.id || !lease?.leaseToken || !lease?.incarnation || releasedTorrentLeases.has(lease)) return;
  if (!fromRetirement) {
    markAbandonedSession(lease, magnet);
    await flushAbandonedLibrarySessions();
    return;
  }
  if (torrentSessionHasConsumers(lease)) {
    markAbandonedSession(lease, magnet);
    return;
  }
  const existing = torrentLeaseReleasesInFlight.get(lease);
  if (existing) return existing;
  const request = (async () => {
    let response;
    try {
      const parameters = new URLSearchParams({ lease: lease.leaseToken, incarnation: lease.incarnation });
      response = await fetch(`/api/torrents/${encodeURIComponent(lease.id)}?${parameters}`, { method: "DELETE" });
    } catch { /* Network interruption is retryable; no completed tombstone. */ }
    if (response?.ok || response?.status === 404 || response?.status === 410) {
      releasedTorrentLeases.add(lease);
      return;
    }
    // 409 means another stream still holds the final lease; retain and retry
    // the exact token after that stream closes, rather than marking success.
    markAbandonedSession(lease, magnet);
    if (!torrentLeaseRetryTimers.has(lease)) {
      const retry = setTimeout(() => {
        torrentLeaseRetryTimers.delete(lease);
        void flushAbandonedLibrarySessions();
      }, 2000);
      retry.unref?.();
      torrentLeaseRetryTimers.set(lease, retry);
    }
  })();
  torrentLeaseReleasesInFlight.set(lease, request);
  try { await request; }
  finally { if (torrentLeaseReleasesInFlight.get(lease) === request) torrentLeaseReleasesInFlight.delete(lease); }
}

export async function importCatalogStream(meta, stream, { button = null, seriesKey = null, quiet = false, rerenderLibrary = true, signal } = {}) {
  if (!stream?.magnet) throw new Error("Selected source did not provide a usable torrent hash.");
  // Importing without playback still holds a metadata resource lease. Its POST
  // can reuse an unresolved Library session, independently of selection intent.
  const reservation = playbackSessionReservationOwner.begin(null, stream.magnet);
  let oldText = "Add";
  let session;
  try {
    oldText = buttonText(button) || "Add";
    if (button) { button.disabled = true; setButtonText(button, "Opening…"); }
    if (!quiet) setToolStatus(TITLE_STATUS, "Checking the source…");
    session = await resolveTorrentMagnet(stream.magnet, (current, elapsed) => {
      if (!quiet) setToolStatus(TITLE_STATUS, `Opening the torrent… ${elapsed} s${current.numPeers ? `, ${current.numPeers} peer${current.numPeers === 1 ? "" : "s"}` : ""}`);
    }, { timeoutMs: 25_000, preferredFileIndex: Number.isInteger(stream.fileIdx) ? stream.fileIdx : null,
      signal, releaseOnFailure: false, onSession: (resolved) => observePlaybackMetadataSession(reservation, resolved) });
    const entry = upsertLibrarySession(session, stream.magnet, {
      seriesKeyOverride: seriesKey || catalogSeriesKey(meta),
      displayTitleOverride: meta.name,
      coverUrlOverride: meta.poster || "",
      catalogId: meta.id,
      catalogType: meta.type,
      mediaKind: catalogMediaKind(meta),
      sourceMeta: librarySourceMetaFromStream(stream),
      aliases: meta.aliases || [],
      render: false,
    });
    if (!entry) throw new Error("That torrent has no supported video file.");
    if (button) { setButtonText(button, "Added"); button.dataset.done = "1"; }
    if (!quiet) setToolStatus(TITLE_STATUS, `${meta.name} added to your Library`);
    if (rerenderLibrary && $("#view-library")?.classList.contains("is-active")) renderLibrary();
    else updateLibrarySummary();
    if (rerenderLibrary && state.homeLoaded && $("#view-home")?.classList.contains("is-active")) renderHome();
    return entry;
  } finally {
    retirePlaybackMetadataReservation(reservation, { session, releaseIfUnused: true, magnet: stream.magnet });
    if (button && button.dataset.done !== "1") { button.disabled = false; setButtonText(button, oldText); }
  }
}

function torrentFileRow(file) {
  const ext = file.name.split(".").pop()?.toUpperCase() || "";
  const episode = episodeIdentity(file.name);
  const chapter = libraryChapterName({ code: episode.code }) || episode.code;
  const hasTitle = episode.title && episode.title.toUpperCase() !== episode.code;
  const displayName = episode.code === "VIDEO" ? cleanMediaTitle(file.name) : hasTitle ? `${chapter}: ${episode.title}` : chapter;
  const facts = [ext, formatBytes(file.length), file.needsTranscode ? "Converted while it plays" : "Plays directly"];
  return `<div class="magnet-file">
    <div class="magnet-file__copy"><strong title="${escapeHtml(file.name)}">${escapeHtml(displayName)}</strong>${metaMarkup(facts)}</div>
    <button class="ui-btn ui-btn--secondary ui-btn--sm torrent-file-play" type="button" data-file-index="${file.index}">${icon("play")}<span>Play</span></button>
  </div>`;
}

function renderMagnetFiles(session) {
  const container = $("#magnet-files");
  const videoFiles = sortedVideoFiles(session.files || []);
  if (!videoFiles.length) {
    container.innerHTML = emptyMarkup({ compact: true, title: "No video files in this torrent" });
    return;
  }
  const { primary, extras } = partitionTorrentVideos(session.files || []);
  const looksLikeEpisodePack = extras.length > 0 && primary.every((file) => episodeSortKey(file.name) !== null);
  const headline = looksLikeEpisodePack
    ? `${primary.length} episode${primary.length === 1 ? "" : "s"}`
    : `${videoFiles.length} video${videoFiles.length === 1 ? "" : "s"}`;
  const extrasMarkup = extras.length
    ? `<details class="magnet-extras"><summary>${extras.length} extra${extras.length === 1 ? "" : "s"} and other files ${icon("chevron-down")}</summary><div class="magnet-file-list">${extras.map(torrentFileRow).join("")}</div></details>`
    : "";
  container.innerHTML = `<h3 class="magnet-files__head">${headline}</h3><div class="magnet-file-list">${primary.map(torrentFileRow).join("")}</div>${extrasMarkup}`;
  container.querySelectorAll(".torrent-file-play").forEach((button) => button.addEventListener("click", () => {
    const file = session.files.find((item) => item.index === Number(button.dataset.fileIndex));
    if (file) void playTorrentFile(session, file);
  }));
}

// Chapters saved from series details carry their catalog code and title (pack files can be
// numbered 1…148 across seasons), so those win over what the file name suggests.
function torrentFileIdentity(entry, file, collectionTitle) {
  const label = entry?.chapterLabels?.[String(file?.index)];
  if (label?.code) return { episode: { code: label.code, title: label.title || label.code }, sourceTag: `${collectionTitle} · ${label.code}` };
  return { episode: episodeIdentity(file?.name || ""), sourceTag: sourceTagFor(file, collectionTitle) };
}

function setCurrentTorrentSource(session, file) {
  cancelPhoneTimelineScrub();
  // Theater is a temporary viewing choice, not the default for a new chapter.
  setWatchTheaterMode(false);
  watchPendingSelection = null;
  state.loadingProgress = 0;
  for (const importJob of embeddedSubtitleImports.values()) importJob.abort("source changed");
  const libraryId = String(session.infoHash || "").toLowerCase();
  const entry = libraryEntryById(libraryId) || upsertLibrarySession(session);
  setPlayerLoadingTitle(entry, session.name);
  const collectionTitle = entry?.displayTitle || entry?.title || normalizeCollectionTitle(session.name, file.name);
  const { episode, sourceTag } = torrentFileIdentity(entry, file, collectionTitle);
  state.currentSource = {
    kind: "torrent",
    magnet: entry?.magnet || (session.infoHash ? `magnet:?xt=urn:btih:${session.infoHash}` : ""),
    title: collectionTitle,
    sourceTag,
    seriesKey: entry?.seriesKey || librarySeriesKey(collectionTitle),
    libraryId: entry?.id || libraryId,
    fileIndex: file.index,
    fileName: file.name,
    episode,
    aliases: Array.isArray(entry?.aliases) ? entry.aliases : [],
    sessionId: session.id,
    sessionLease: session.sessionLease || null,
    catalogId: entry?.catalogId || "",
    catalogType: entry?.catalogType || "",
  };
  rememberWatchSelection(state.currentSource.libraryId, file.index);
  changeRecoverySource(playbackLoadRequestId);
  applyLanguagePreferencesToTracks();
  resetAudioSync();
  updatePlayerIdentity(collectionTitle, episode);
  startTransferStats(session.id);
}

export let playbackLoadRequestId = 0;
let libraryPlaybackResolveController = null;
let libraryPlaybackPendingMagnet = "";
let pendingDirectTorrentSelection = null;
const abandonedLibrarySessions = new Set(); // Only actual outstanding acquisition handles.
const releasedTorrentLeases = new WeakSet(); // Stale callbacks retain their own idempotence.
const torrentLeaseReleasesInFlight = new WeakMap();
const torrentLeaseRetryTimers = new WeakMap();
let magnetDialogResolveController = null;
let magnetDialogListedSession = null;

function noteTorrentSessionAcquired(session) {
  if (!session?.id || !session.leaseToken || !session.incarnation) return;
  session.sessionLease ||= Object.freeze({
    id: session.id, leaseToken: session.leaseToken, incarnation: session.incarnation,
  });
}

function markAbandonedSession(lease) {
  if (lease?.id && lease.leaseToken && lease.incarnation && !releasedTorrentLeases.has(lease))
    abandonedLibrarySessions.add(lease);
}

function torrentSessionHasConsumers(lease) {
  if (!lease) return false;
  const active = libraryPlaybackResolveController;
  if (lease === state.currentSource?.sessionLease || lease === active?.sessionLease
    || lease === pendingDirectTorrentSelection?.sessionLease
    || lease === magnetDialogListedSession?.session.sessionLease) return true;
  return playbackSessionReservationOwner.hasLease(lease,
    (token) => playbackIntentOwner.owns(token));
}

// Release only after the exact pending resolver has retired. Its POST may have
// returned reused:false even when resolution failed before returning to caller.
export function retirePlaybackMetadataReservation(reservation, {
  session = null, releaseIfUnused = false, magnet = null,
} = {}) {
  if (!reservation) return;
  const resolved = session || playbackSessionReservationOwner.session(reservation);
  if (releaseIfUnused && resolved?.sessionLease) markAbandonedSession(resolved.sessionLease);
  playbackSessionReservationOwner.retire(reservation);
  // Do not hold a finished selection pending on a slow DELETE response.
  // Cleanup is already tracked by the orphan ledger; all rejections settle.
  void flushAbandonedLibrarySessions();
}

// A catalog/neighbor root starts before it knows any magnet. Refine that
// *same* reservation as each candidate is chosen so an unrelated old session
// can be released even while the new candidate's POST is still outstanding.
export function refinePlaybackMetadataReservation(reservation, magnet) {
  if (playbackSessionReservationOwner.setMagnet(reservation, magnet))
    void flushAbandonedLibrarySessions();
}

export function observePlaybackMetadataSession(reservation, session) {
  noteTorrentSessionAcquired(session);
  playbackSessionReservationOwner.observe(reservation, session);
  // Once a POST identifies a different session, an unrelated fresh orphan can
  // be retired immediately, rather than waiting for metadata polling to finish.
  void flushAbandonedLibrarySessions();
}

// Genuine selections claim synchronously, before their first fetch. Nested
// catalog/Library starts inherit the exact parent token, but keep their own
// numeric request generation for existing async media and recovery checks.
export function claimPlaybackIntent(kind, { parentIntent = null, magnet = null } = {}) {
  if (parentIntent !== null && !playbackIntentOwner.canContinue(parentIntent)) return null;
  const intent = parentIntent || playbackIntentOwner.begin(kind);
  // Publish B's metadata reservation BEFORE aborting A. Even if B's POST is
  // not yet answered, it may reuse exactly the fresh session A would delete.
  const metadataReservation = ["library", "catalog", "catalog-source", "neighbor"].includes(kind)
    ? playbackSessionReservationOwner.begin(intent, magnet) : null;
  playbackSessionReservationOwner.retireStale((token) => playbackIntentOwner.owns(token));
  const requestId = ++playbackLoadRequestId;
  libraryPlaybackResolveController?.abort("another playback selection started");
  libraryPlaybackResolveController = null;
  libraryPlaybackPendingMagnet = "";
  pendingDirectTorrentSelection = null;
  // The next Library/Direct owner installs its own reservation before flushing
  // abandoned sessions; no earlier POST may delete an unreported reused B.
  return { intent, requestId, root: parentIntent === null, metadataReservation };
}

// An episode edit invalidates only the catalog/neighbor lookup it belongs to.
// Another direct/Library/local owner is never cancelled by an old edit.
export function invalidatePlaybackIntentForEpisodeEdit(token) {
  if (!playbackIntentOwner.owns(token) || playbackIntentOwner.current()?.phase !== "cancel-requested") return false;
  playbackLoadRequestId += 1;
  libraryPlaybackResolveController?.abort("episode changed while selecting a catalog source");
  libraryPlaybackResolveController = null;
  libraryPlaybackPendingMagnet = "";
  pendingDirectTorrentSelection = null;
  flushAbandonedLibrarySessions();
  return true;
}

// An aborted Library POST can own a fresh session before the replacement POST
// has reported whether it reuses that very session. Defer deletion until the
// current selection's reservation is known, and never delete a pending player.
function flushAbandonedLibrarySessions() {
  const pendingReleases = [];
  for (const lease of abandonedLibrarySessions) {
    if (torrentSessionHasConsumers(lease) || torrentLeaseRetryTimers.has(lease)) continue;
    abandonedLibrarySessions.delete(lease);
    pendingReleases.push(releaseTorrentSession(lease, null, true));
  }
  return Promise.allSettled(pendingReleases);
}

async function playTorrentFile(session, file, { startAtSeconds = 0, requestId = null, parentIntent = null, shouldAutoPlay = () => true } = {}) {
  const directRoot = requestId === null;
  const claim = directRoot ? claimPlaybackIntent("direct")
    : parentIntent && playbackIntentOwner.canContinue(parentIntent) ? { intent: parentIntent, requestId } : null;
  if (!claim) return false; // A supplied stale parent may never claim a new root.
  const intent = claim.intent;
  const loadId = claim.requestId;
  const finishPreflight = (result) => {
    if (directRoot) playbackIntentOwner.settle(intent, result ? "accepted" : "failed");
    return result;
  };
  // Another video in LVL's window: the pop-up player closes.
  try {
    if (typeof dismissPopupPlayer === "function") dismissPopupPlayer();
  } catch (error) {
    finishPreflight(false);
    throw error;
  }
  const directSelection = directRoot ? Object.freeze({ loadId, sessionId: session.id, sessionLease: session.sessionLease, intent }) : null;
  if (directSelection) {
    pendingDirectTorrentSelection = directSelection;
    flushAbandonedLibrarySessions();
  }
  const clearDirectSelection = () => {
    if (directSelection && pendingDirectTorrentSelection === directSelection) {
      pendingDirectTorrentSelection = null;
      flushAbandonedLibrarySessions();
    }
  };
  let storageLimit;
  try {
    storageLimit = await playerStorageLimit();
  } catch (error) {
    clearDirectSelection();
    finishPreflight(false);
    throw error;
  }
  if (loadId !== playbackLoadRequestId || !playbackIntentOwner.canContinue(intent)) {
    clearDirectSelection();
    return finishPreflight(false);
  }
  if (storageLimit && Number(file?.length) > storageLimit) {
    clearDirectSelection();
    const message = `This video is ${(Number(file.length) / 1024 ** 3).toFixed(1)} GB, more than the ${Math.round(storageLimit / 1024 ** 3)} GB set for player storage. Raise it in Settings, Storage.`;
    if (!$("#video-loading")?.hidden) setPlayerLoading(100, "Not enough player storage", message, { error: true });
    toast(message, { tone: "error", timeout: 8000 });
    return finishPreflight(false);
  }
  const previousSessionLease = state.currentSource?.kind === "torrent" ? state.currentSource.sessionLease : null;
  let directAccepted = false;
  try {
  try {
    beginSourceTransition();
    setCurrentTorrentSource(session, file);
  } finally {
    clearDirectSelection();
  }
  $("#magnet-dialog")?.close();
  switchView("watch");
  renderWatchChapters();
  frame.classList.add("has-video");
  setPlayerLoading(Math.max(62, state.loadingProgress), "Preparing video");
  state.currentMediaProbe = null;
  state.selectedAudioTrack = 0;
  const currentEntry = state.currentSource?.libraryId ? libraryEntryById(state.currentSource.libraryId) : null;
  const audioReleaseHint = [
    file.name,
    session?.name,
    currentEntry?.rawName,
    currentEntry?.sourceMeta?.releaseName,
    currentEntry?.sourceMeta?.filename,
  ].filter(Boolean).join(" ");
  const filenameNeedsAudioTranscode = releaseNeedsAudioTranscode(audioReleaseHint);
  let probedMedia = null;
  const metadataUrl = file.metadataUrl || `/api/torrents/${encodeURIComponent(session.id)}/files/${file.index}/metadata`;
  const metadataRequest = fetchJson(metadataUrl);
  setPlayerLoading(Math.max(68, state.loadingProgress), "Reading media");
  try {
    // Without video conversion, wait longer for codec details so an unknown
    // format does not immediately select an unavailable encoder.
    const canConvertVideo = serverCanConvertVideo();
    probedMedia = await waitForStartupMediaProbe(metadataRequest, canConvertVideo ? undefined : { timeoutMs: 15_000 });
    if (loadId !== playbackLoadRequestId || state.currentSource?.sessionId !== session.id || Number(state.currentSource?.fileIndex) !== Number(file.index)) return false;
    if (probedMedia) {
      state.currentMediaProbe = probedMedia;
      state.selectedAudioTrack = preferredAudioTrackIndex(probedMedia);
      // Resume/next-chapter playback can begin late inside a 180s bucket.
      // Extract near that actual playhead instead of scanning unavailable old pieces.
      enableDefaultEmbeddedSubtitles(probedMedia, startAtSeconds, { urgent: startAtSeconds >= 12 });
      renderSubtitleStyleControls();
      const resolvedDurationMs = Number(probedMedia.durationMs) || Math.round(Number(probedMedia.durationSeconds || 0) * 1000);
      if (resolvedDurationMs) {
        file.durationMs = resolvedDurationMs;
        file.durationSeconds = resolvedDurationMs / 1000;
        state.mediaDurationMs = resolvedDurationMs;
        refreshSubtitleTimelineFits();
        refreshEpisodeSkipOptions();
        updateCompatControls();
      }
    }
    setPlayerLoading(Math.max(78, state.loadingProgress), "Starting playback");
  } catch (error) {
    console.warn("Could not read media metadata before playback startup:", error);
  }
  const playbackDecision = await selectBrowserPlaybackWithCapabilities({
    file, media: probedMedia, canPlayType: (mime) => video.canPlayType(mime),
    audioTrackOrder: state.selectedAudioTrack, audioMode: audioOutputMode,
    decodingInfo: window.navigator?.mediaCapabilities?.decodingInfo?.bind(window.navigator.mediaCapabilities),
    canConvert: serverCanConvertVideo(),
  });
  if (loadId !== playbackLoadRequestId || state.currentSource?.sessionId !== session.id || Number(state.currentSource?.fileIndex) !== Number(file.index)) return false;
  // The fallback conversion exists for HEVC/HDR files when the OS lacks the
  // decoder; native play is preferable when Edge advertises compatible support.
  const needsTranscode = !playbackDecision.direct || (filenameNeedsAudioTranscode && !probedMedia);
  if (!serverCanConvertVideo() && needsTranscode && !playbackDecision.copyVideo) {
    setPlayerLoading(100, "This video can't play here yet",
      "Its video format needs converting, which LVL on this device can't do yet. Try another source.", { error: true });
    return false;
  }
  if (typeof playbackMetrics !== "undefined") playbackMetrics?.selection({ playbackMode: needsTranscode ? (playbackDecision.mode === "remux" ? "remux" : "transcode") : "direct",
    playbackReason: filenameNeedsAudioTranscode && !probedMedia ? "audio-unknown" : playbackDecision.reason });
  const action = needsTranscode ? "transcode" : "stream";
  const baseUrl = `/api/torrents/${encodeURIComponent(session.id)}/files/${file.index}/${action}`;
  state.transcodeContext = needsTranscode ? { baseUrl, sessionId: session.id, fileIndex: file.index, audioIndex: state.selectedAudioTrack, copyVideo: playbackDecision.mode === "remux" } : null;
  const episode = torrentFileIdentity(currentEntry, file, state.currentSource.title).episode;
  let durationMs = Number(file.durationMs) || state.mediaDurationMs || 0;
  state.transcodeBaseOffsetSeconds = needsTranscode ? Math.max(0, Number(startAtSeconds) || 0) : 0;
  setPlayerLoading(needsTranscode ? 84 : 76, needsTranscode
    ? (filenameNeedsAudioTranscode && !file.needsTranscode ? "Converting audio" : "Starting stream")
    : "Buffering");
  const sourceOptions = {
    title: state.currentSource.title,
    status: needsTranscode ? (playbackDecision.mode === "remux" ? "TORRENT - REMUXING" : filenameNeedsAudioTranscode && !file.needsTranscode ? "TORRENT - AUDIO → AAC" : "TORRENT - TRANSCODING") : "TORRENT STREAM",
    mode: needsTranscode ? "transcode" : "torrent-direct",
    durationMs,
    startAtSeconds,
  };
  if (needsTranscode) {
    const opened = await openTranscodeAt(startAtSeconds, { wasPlaying: shouldAutoPlay(), initialize: sourceOptions });
    if (!opened || loadId !== playbackLoadRequestId) return false;
    if (!shouldAutoPlay()) {
      if (state.pendingSeek) state.pendingSeek.wasPlaying = false;
      video.pause();
    }
  } else {
    setMediaSource({ ...sourceOptions, src: baseUrl });
  }
  updatePlayerIdentity(state.currentSource.title, episode);
  // The player no longer reads the previous torrent: free its slot (the server allows 4 sessions).
  if (previousSessionLease && previousSessionLease !== session.sessionLease)
    void releaseTorrentSession(previousSessionLease);
  if (!needsTranscode && shouldAutoPlay()) {
    void video.play().then(() => {
      // Play promises can settle after the user paused a still-loading B.
      // Its source/load identity must also still be the one we installed.
      if (!shouldAutoPlay() && loadId === playbackLoadRequestId
        && state.currentSource?.sessionId === session.id) video.pause();
    }).catch((error) => {
      if (error?.name !== "NotAllowedError" || video.muted
        || loadId !== playbackLoadRequestId || state.currentSource?.sessionId !== session.id
        || video.dataset.mode !== "torrent-direct" || !shouldAutoPlay()) return;
      // Same browser policy, but the direct torrent path has no FFmpeg attempt.
      video.muted = true;
      updateCompatControls();
      void video.play().then(() => {
        if (!shouldAutoPlay() && loadId === playbackLoadRequestId
          && state.currentSource?.sessionId === session.id) video.pause();
        if (loadId === playbackLoadRequestId && shouldAutoPlay())
          toast("Your browser blocked automatic sound. Video is playing muted; use the speaker control to enable audio.", { timeout: 5500 });
      }).catch(() => {});
    });
  } else if (!needsTranscode) video.pause();
  window.setTimeout(async () => {
    try {
      // Reuse the still-running probe rather than starting another 20s FFprobe
      // simply because the foreground grace period elapsed.
      const media = probedMedia || await metadataRequest.catch(() => fetchJson(metadataUrl));
      if (loadId !== playbackLoadRequestId || state.currentSource?.sessionId !== session.id || Number(state.currentSource?.fileIndex) !== Number(file.index)) return;
      state.currentMediaProbe = media;
      const subtitlePosition = typeof embeddedSubtitleProbePosition === "function"
        ? embeddedSubtitleProbePosition(startAtSeconds) : startAtSeconds;
      enableDefaultEmbeddedSubtitles(media, subtitlePosition,
        { urgent: subtitlePosition >= 12 });
      if (!probedMedia && state.selectedAudioTrack === 0) {
        const wantedIndex = preferredAudioTrackIndex(media);
        if (wantedIndex > 0) await switchAudioTrack(wantedIndex);
      }
      // A pending audio-track switch can yield while the user changes titles.
      // Never let late metadata from source A replace B's duration/skip marks.
      if (loadId !== playbackLoadRequestId || state.currentSource?.sessionId !== session.id
        || Number(state.currentSource?.fileIndex) !== Number(file.index)) return;
      renderSubtitleStyleControls();
      const resolvedDurationMs = Number(media.durationMs) || Math.round(Number(media.durationSeconds || 0) * 1000);
      if (resolvedDurationMs) {
        file.durationMs = resolvedDurationMs;
        file.durationSeconds = resolvedDurationMs / 1000;
        state.mediaDurationMs = resolvedDurationMs;
        refreshSubtitleTimelineFits();
      }
      refreshEpisodeSkipOptions();
      renderPlayerAudioMenu();
      if (!probedMedia && video.dataset.mode === "transcode" && state.transcodeContext && !state.transcodeContext.copyVideo && !state.transcodeContext.forceH264) {
        const refined = await selectBrowserPlaybackWithCapabilities({
          file, media, canPlayType: (mime) => video.canPlayType(mime),
          audioTrackOrder: state.selectedAudioTrack, audioMode: audioOutputMode,
          decodingInfo: window.navigator?.mediaCapabilities?.decodingInfo?.bind(window.navigator.mediaCapabilities),
        });
        if (loadId !== playbackLoadRequestId || state.currentSource?.sessionId !== session.id || Number(state.currentSource?.fileIndex) !== Number(file.index)) return;
        if (refined.mode === "remux") {
          // Metadata arrived after initial playback began: restore the full
          // HEVC/HDR bitstream rather than continuing an avoidable conversion.
          state.transcodeContext.copyVideo = true;
          await restartTranscodeAt(absolutePlaybackSeconds(), { wasPlaying: !video.paused });
        }
      }
      if (video.dataset.mode === "torrent-direct") {
        const refined = await selectBrowserPlaybackWithCapabilities({
          file, media, canPlayType: (mime) => video.canPlayType(mime),
          audioTrackOrder: state.selectedAudioTrack, audioMode: audioOutputMode,
          decodingInfo: window.navigator?.mediaCapabilities?.decodingInfo?.bind(window.navigator.mediaCapabilities),
        });
        if (loadId !== playbackLoadRequestId || state.currentSource?.sessionId !== session.id || Number(state.currentSource?.fileIndex) !== Number(file.index)) return;
        if (!refined.direct) await switchAudioTrack(state.selectedAudioTrack, { force: true });
      }
      updateCompatControls();
    } catch (error) {
      console.warn("Could not read media metadata after playback startup:", error);
    }
  }, probedMedia ? 0 : 450);
  directAccepted = true;
  return true;
  } finally {
    if (directRoot) playbackIntentOwner.settle(intent, directAccepted ? "accepted" : "failed");
  }
}

function preparePlayerForLibraryLoad(entry, episode, { resumeAtSeconds = 0, onPrepared = null } = {}) {
  cancelTranscodeStart();
  setWatchTheaterMode(false);
  const pendingSelection = { libraryId: entry.id, fileIndex: episode?.fileIndex ?? null, episode };
  watchPendingSelection = pendingSelection;
  onPrepared?.(pendingSelection);
  if (episode) rememberWatchSelection(entry.id, episode.fileIndex);
  state.loadingProgress = 0;
  beginSourceTransition();
  video.pause();
  state.transcodeBaseOffsetSeconds = 0;
  state.transcodeRequestedStartSeconds = 0;
  state.transcodeContext = null;
  state.currentMediaProbe = null;
  state.mediaDurationMs = 0;
  state.currentMs = Math.max(0, Number(resumeAtSeconds) || 0) * 1000;
  frame.classList.add("has-video");
  $("#compat-controls").hidden = false;
  revealPlayerControls();
  updatePlayerIdentity(entry.displayTitle || entry.title || "Library source", episode ? { code: episode.code, title: episode.episodeTitle || episode.code } : null);
  setPlayerLoadingTitle(entry);
  $("#media-status").textContent = "LIBRARY - RESOLVING SOURCE";
  setPlayerLoading(4, "Connecting");
  switchView("watch");
  renderWatchChapters();
  // The outgoing decoder is intentionally detached while the next episode is
  // resolved. Display its selected resume point (and unknown total) immediately.
  updateCompatControls();
  return pendingSelection;
}

export async function resolveTorrentMagnet(magnet, onProgress, { timeoutMs = 0, preferredFileIndex = null, signal, releaseOnFailure = true, onSession } = {}) {
  signal?.throwIfAborted();
  // The ID exists before the POST, independently of the backend's opaque
  // per-borrower token. If navigation aborts a response body after the server
  // has created a lease, the frontend can still cancel that exact acquisition.
  // This preserves immediate transport cancellation of the initial POST.
  const acquisitionId = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : (() => {
    // Older Chromium WebViews have getRandomValues even when randomUUID is
    // unavailable outside a secure context. Never fall back to Math.random.
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  })();
  let acquiredLease = null;
  let cancellation = null;
  const cancelUnknownAcquisition = () => {
    if (acquiredLease || cancellation) return cancellation;
    cancellation = (async () => {
      let lastFailure = "no response";
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const response = await fetch(`/api/torrent-acquisitions/${encodeURIComponent(acquisitionId)}`, {
            method: "DELETE", signal: AbortSignal.timeout(4_000),
          });
          if (response.status === 204) return true;
          lastFailure = `HTTP ${response.status}`;
          if (![409, 429, 500, 502, 503, 504].includes(response.status)) break;
        } catch (error) {
          lastFailure = error?.message || String(error);
        }
      }
      // Unknown or interrupted acknowledgments fall back to the backend's
      // finite lease TTL; never DELETE by shared torrent/session ID alone.
      console.warn(`Torrent acquisition cancellation unconfirmed (${lastFailure}); server expiry remains active.`);
      return false;
    })();
    return cancellation;
  };
  const onAcquisitionAbort = () => { void cancelUnknownAcquisition(); };
  signal?.addEventListener("abort", onAcquisitionAbort, { once: true });
  let session;
  try {
    session = await postJson("/api/torrents", {
      magnet, acquisitionId,
      ...(Number.isInteger(preferredFileIndex) && preferredFileIndex >= 0 ? { preferredFileIndex } : {}),
    }, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) });
  } catch (error) {
    signal?.removeEventListener("abort", onAcquisitionAbort);
    void cancelUnknownAcquisition();
    throw error;
  }
  signal?.removeEventListener("abort", onAcquisitionAbort);
  noteTorrentSessionAcquired(session);
  if (!session?.sessionLease) {
    void cancelUnknownAcquisition();
    throw new Error("Torrent acquisition response did not include a valid session lease.");
  }
  // Status GETs report the shared backend resource, not the acquiring POST's
  // private token. Keep this immutable acquisition through every poll.
  acquiredLease = session.sessionLease;
  let observerCompleted = false;
  try {
    // A failed observer did not record the POST's private lease. Even callers
    // that normally own cleanup cannot release an acquisition they never saw.
    onSession?.(session);
    observerCompleted = Boolean(onSession);
    signal?.throwIfAborted();
    const startedAt = Date.now();
    // Sessions restored from disk usually need little more than an initial poll.
    let polls = 0;
    while (session.state !== "ready" && session.state !== "error") {
      onProgress?.(session, Math.floor((Date.now() - startedAt) / 1000));
      if (timeoutMs > 0 && Date.now() - startedAt >= timeoutMs)
        throw new Error("Torrent metadata timed out. Trying another source may work.");
      const delay = polls === 0 ? 150 : polls === 1 ? 400 : 1500;
      polls += 1;
      await new Promise((resolve, reject) => {
        const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, delay);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
      session = await fetchJson(`/api/torrents/${encodeURIComponent(session.id)}`, { signal });
      if (acquiredLease) session.sessionLease = acquiredLease;
    }
    if (session.state === "error")
      throw new Error(session.error || "Torrent metadata could not be resolved.");
    return session;
  } catch (error) {
    // The observer/caller handles a failed acquisition only when it actually
    // received the immutable handle; otherwise retire it here.
    if (acquiredLease && (releaseOnFailure || !observerCompleted))
      await releaseTorrentSession(acquiredLease);
    throw error;
  }
}

export async function playLibraryEpisode(libraryId, fileIndex, {
  resumeAtSeconds = 0, onLoadRequest = null, onIntentStarted = null,
  parentIntent = null, shouldAutoPlay = null,
} = {}) {
  const entry = libraryEntryById(libraryId);
  if (!entry?.magnet) return false;
  const claim = claimPlaybackIntent("library", { parentIntent, magnet: entry.magnet });
  if (!claim) return false;
  const { intent, requestId: loadId, root } = claim;
  const controller = new AbortController();
  libraryPlaybackResolveController = controller;
  libraryPlaybackPendingMagnet = entry.magnet;
  // A Library intent supersedes a direct selection even if its storage check
  // never settles. Install B's controller first so cleanup waits for B's POST.
  flushAbandonedLibrarySessions();
  let reservedSession = null;
  let playAccepted = false;
  const buttonSource = entry.episodes?.find((episode) => Number(episode.fileIndex) === Number(fileIndex));
  let pendingSelection = null;
  try {
    // Capture the exact owner before prepare reenters switchView("watch").
    // Callback and preparation errors must also reach the root's finally.
    onIntentStarted?.(intent);
    onLoadRequest?.(loadId);
    pendingSelection = preparePlayerForLibraryLoad(entry, buttonSource, {
      resumeAtSeconds, onPrepared: (selection) => { pendingSelection = selection; },
    });
    $("#media-status").textContent = `LIBRARY - RESOLVING ${buttonSource?.code || "VIDEO"}`;
    const session = await resolveTorrentMagnet(entry.magnet, (current, elapsed) => {
      if (loadId !== playbackLoadRequestId || !playbackIntentOwner.canContinue(intent)) return;
      const peerBoost = current.numPeers ? 16 : 0;
      const slowPenalty = current.state === "resolving-slow" ? 4 : 0;
      const percent = Math.min(58, 10 + peerBoost + Math.min(32, elapsed * 4) - slowPenalty);
      setPlayerLoading(percent, current.numPeers ? "Reading source" : "Finding peers", current.numPeers
        ? `${current.numPeers} peer${current.numPeers === 1 ? "" : "s"}`
        : "");
    }, { preferredFileIndex: Number.isInteger(fileIndex) ? fileIndex : null, timeoutMs: recoveryBusy ? 25_000 : 60_000,
      // This caller owns cleanup in finally, AFTER its reservation retires.
      // The resolver cannot DELETE while a replacement's POST is still unknown.
      signal: controller.signal, releaseOnFailure: false, onSession: (session) => {
        reservedSession = session;
        observePlaybackMetadataSession(claim.metadataReservation, session);
        controller.sessionId = session.id;
        controller.sessionLease = session.sessionLease;
        if (libraryPlaybackResolveController === controller) flushAbandonedLibrarySessions();
      } });
    if (loadId !== playbackLoadRequestId || !playbackIntentOwner.canContinue(intent)) return false;
    setPlayerLoading(62, "Source ready");
    upsertLibrarySession(session, entry.magnet, {
      seriesKeyOverride: entry.seriesKey,
      displayTitleOverride: entry.displayTitle || entry.title,
      coverUrlOverride: entry.coverUrl || "",
      catalogId: entry.catalogId || "",
      catalogType: entry.catalogType || "",
      sourceMeta: entry.sourceMeta || null,
      aliases: entry.aliases || [],
    });
    const file = session.files.find((item) => Number(item.index) === Number(fileIndex))
      || session.files.find((item) => item.name === buttonSource?.name);
    if (!file) throw new Error("That file is no longer present in this torrent.");
    const played = await playTorrentFile(session, file, {
      startAtSeconds: resumeAtSeconds, requestId: loadId, parentIntent: intent,
      shouldAutoPlay: () => typeof shouldAutoPlay === "function" ? Boolean(shouldAutoPlay(loadId)) : true,
    });
    playAccepted = played !== false && loadId === playbackLoadRequestId
      && playbackIntentOwner.canContinue(intent) && !controller.signal.aborted;
    return playAccepted;
  } catch (error) {
    if (loadId !== playbackLoadRequestId || !playbackIntentOwner.canContinue(intent) || controller.signal.aborted) return false;
    $("#media-status").textContent = "Couldn't open this source";
    setPlayerLoading(100, "Couldn't open this source", error.message || "", { error: true });
    console.error(error);
    return false;
  } finally {
    // An unsuccessful request may retire its own pending Watch header, but
    // must never erase a newer manual selection or its request/controller.
    if (!playAccepted && pendingSelection?.libraryId && watchPendingSelection === pendingSelection)
      watchPendingSelection = null;
    if (libraryPlaybackResolveController === controller) {
      libraryPlaybackResolveController = null;
      libraryPlaybackPendingMagnet = "";
    }
    // Resolver timeout/error also needs cleanup, not just cancellation. Its
    // early release was protected by this controller's own reservation. Queue
    // once after retiring that reservation; a newer owner still wins.
    if (!playAccepted && reservedSession?.sessionLease)
      markAbandonedSession(reservedSession.sessionLease);
    playbackSessionReservationOwner.retire(claim.metadataReservation);
    flushAbandonedLibrarySessions();
    if (root) playbackIntentOwner.settle(intent, playAccepted ? "accepted" : "failed");
  }
}

export async function resolveMagnet(event) {
  event.preventDefault();
  const magnet = $("#magnet-input").value.trim();
  if (!magnet) return;
  const reservation = playbackSessionReservationOwner.begin(null, magnet);
  magnetDialogResolveController?.abort("another magnet was submitted");
  const controller = new AbortController();
  magnetDialogResolveController = controller;
  if (magnetDialogListedSession) {
    const listed = magnetDialogListedSession;
    magnetDialogListedSession = null;
    markAbandonedSession(listed.session.sessionLease);
    void flushAbandonedLibrarySessions();
  }
  let session = null;
  let listed = false;
  try {
    setToolStatus("#magnet-status", "Reading the torrent…");
    $("#magnet-files").innerHTML = "";
    session = await resolveTorrentMagnet(magnet, (current, elapsed) => {
      const peerCopy = current.numPeers ? `, ${current.numPeers} peer${current.numPeers === 1 ? "" : "s"}` : "";
      setToolStatus("#magnet-status", `${current.state === "resolving-slow" ? "Still reading the torrent" : "Reading the torrent"}… ${elapsed} s${peerCopy}`);
    }, { signal: controller.signal, releaseOnFailure: false,
      onSession: (resolved) => observePlaybackMetadataSession(reservation, resolved) });
    if (controller.signal.aborted || magnetDialogResolveController !== controller) return;
    const targetSeriesKey = state.pendingMagnetSeriesKey;
    const entry = upsertLibrarySession(session, magnet, { seriesKeyOverride: targetSeriesKey });
    state.pendingMagnetSeriesKey = null;
    const videoCount = (session.files || []).filter((file) => file.video).length;
    const normalizedTitle = normalizeCollectionTitle(session.name, session.files?.find((file) => file.video)?.name);
    const where = targetSeriesKey && entry ? `, added to ${entry.displayTitle || entry.title}` : ", added to your Library";
    setToolStatus("#magnet-status", `${normalizedTitle}: ${videoCount} video${videoCount === 1 ? "" : "s"}${where}`);
    renderMagnetFiles(session);
    magnetDialogListedSession = { session, magnet };
    listed = true;
  } catch (error) {
    if (!controller.signal.aborted && magnetDialogResolveController === controller)
      setToolStatus("#magnet-status", error.message, true);
  } finally {
    if (magnetDialogResolveController === controller) magnetDialogResolveController = null;
    // A listed session belongs to the dialog for file choice until expiry or
    // playback; failed metadata work has no such consumer.
    const reported = session || playbackSessionReservationOwner.session(reservation);
    retirePlaybackMetadataReservation(reservation, { session: reported, releaseIfUnused: !listed, magnet });
  }
}

export function openMagnetDialog({ seriesKey = null } = {}) {
  state.pendingMagnetSeriesKey = seriesKey;
  $("#magnet-input").value = "";
  $("#magnet-files").innerHTML = "";
  const series = seriesKey ? buildLibrarySeries().find((item) => item.key === seriesKey) : null;
  $("#magnet-title").textContent = series ? `Add a magnet to ${series.title}` : "Open a magnet link";
  setToolStatus("#magnet-status", "");
  const dialog = $("#magnet-dialog");
  dialog.addEventListener("close", () => {
    magnetDialogResolveController?.abort("magnet dialog closed");
    magnetDialogResolveController = null;
    const listed = magnetDialogListedSession;
    magnetDialogListedSession = null;
    if (listed) {
      markAbandonedSession(listed.session.sessionLease);
      void flushAbandonedLibrarySessions();
    }
  }, { once: true });
  dialog.showModal();
  queueMicrotask(() => $("#magnet-input")?.focus());
}


export function wireLocalVideoInput() {
  $("#video-input").addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const claim = claimPlaybackIntent("local");
    let accepted = false;
    let url = null;
    let installed = false;
    try {
    cancelPhoneTimelineScrub();
    const abandonedSessionLease = state.currentSource?.sessionLease;
    // Local selection supersedes any torrent resolve/metadata response that
    // could otherwise install the old source after the file is chosen.
    flushAbandonedLibrarySessions();
    setWatchTheaterMode(false);
    watchPendingSelection = null;
    event.target.value = "";
    url = URL.createObjectURL(file);
    const title = normalizeCollectionTitle(file.name);
    setPlayerLoadingTitle(null, title);
    state.currentSource = { kind: "local", title, sourceTag: title, libraryId: null, fileIndex: null };
    state.currentMediaProbe = null;
    state.selectedAudioTrack = 0;
    resetAudioSync();
    if (abandonedSessionLease) void releaseTorrentSession(abandonedSessionLease);
    stopTransferStats();
    updateTransferStats();
    applyLanguagePreferencesToTracks();
    updatePlayerIdentity(title, { code: "VIDEO", title });
    setMediaSource({ src: url, title, status: "LOCAL MEDIA", objectUrl: url });
    installed = true;
    // "Play a video file" is in the Library's More menu: go to the player.
    switchView("watch");
    renderWatchChapters();
    accepted = true;
    } finally {
      if (url && !installed) URL.revokeObjectURL?.(url);
      playbackIntentOwner.settle(claim.intent, accepted ? "accepted" : "failed");
    }
  });
}
