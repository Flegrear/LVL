// The player: sources (direct, progressive, indexed, remux, transcode), loading, controls, recovery and transfer status.
import { formatTime } from "../../shared/subtitles/subtitle-text.js";
import { toast } from "../ui/ui.js";
import { logoUrl } from "../catalog/home-feed.js";
import { torrentSeekPieceStatus } from "./torrent-piece-wait.js";
import { notifyPhonePlayerControlsHidden } from "./phone-seek-lifecycle.js";
import { serverCanConvertVideo } from "./video-conversion-capability.js";
import { canUseEncodedH264Mse, canUseRemuxMse, createRemuxMseSession } from "./remux-mse.js";
import { normalizeAudioMode } from "../../shared/media/audio-policy.js";
import {
  changePlaybackRecoverySource, createPlaybackRecoveryState, failPlaybackRecoverySwitch,
  isPlaybackStallExpired, playbackRecoverySourceKey, playbackRetryStrategy, recordPlaybackProgress,
  requestPlaybackRecovery,
} from "./playback-recovery.js";
import { addRecoveryEvent, recoveryEpisodeCode } from "./playback-diagnostics.js";
import { classifyPlaybackStreamStatus } from "./stream-status.js";
import {
  audioSync, compatProgress, createProgressiveSeekController, createStandaloneProgressiveMseLoader,
  findProgressiveReadySegment, frame, normalizeProgressiveSeekStatus,
  playbackMetrics, popupPlayer, progressiveReadyRanges, progressiveSeekAvailable,
  renderSubtitleWorkspace, state, titleSeedMeta, video,
} from "../../app.js";
import { $, $$ } from "../app/dom.js";
import { fetchJson } from "../app/http.js";
import { viewActive } from "../app/navigation.js";
import { remuxMseCacheAllowed } from "../settings/storage-settings.js";
import { transcodeQuery } from "./player-tracks.js";
import { audioOutputMode } from "./player-menus.js";
import { renderSubtitles, subtitleRenderMemo } from "./subtitle-display.js";
import { refreshSubtitleTimelineFits } from "./subtitle-timing.js";
import { loadMoreEmbeddedSubtitles } from "./embedded-subtitles.js";
import { decodeBase64Bytes, scheduleAudioSync } from "./audio-sync.js";
import { episodeTimelineRanges, refreshEpisodeSkipOptions, renderEpisodeTimelineSegments } from "./episode-skips.js";
import { floatingDesktopPending, floatingDesktopWindow } from "./floating-player.js";
import { playbackLoadRequestId, playLibraryEpisode, watchPendingSelection } from "./torrent-playback.js";
import { updateChapterButtons, watchCatalogIdFor } from "../watch/watch-page.js";
import { recordWatchProgress } from "../watch/watched-status.js";
import { autoNextInterval, catalogChapterLists, clearAutoNext, movieArtRecords } from "../watch/episode-navigation.js";
import {
  buildLibrarySeries, currentChapterSources, libraryEntryById, librarySeriesKey,
} from "../library/library-data.js";
import { homeTitleIndex } from "../home/home-page.js";

let playerControlsHideTimer = null;

let indexedSeekReady = null;
let indexedSeekStatusAt = 0;
let indexedSeekStatusPending = false;
let progressiveSeekReady = null;
let progressiveSeekStatusAt = 0;
let progressiveSeekStatusPending = false;
let progressiveIndexStatus = "unknown";
let progressiveWaitingSince = 0;
let progressiveEventStream = null;
let progressiveEventKey = "";
let progressiveRefreshAfterPending = false;
let progressiveSeekController = null;
let progressiveMseLoader = null;
let progressiveSeekOriginalMute = null;
let progressiveContinueController = null;
let progressiveBoundaryAttempt = null;
let progressiveTimelineKey = "";
let progressiveTimelineRangesFingerprint = "";
let progressiveTimelineVersion = 0;
export function closeProgressiveEventStream() {
  progressiveEventStream?.close();
  progressiveEventStream = null;
  progressiveEventKey = "";
  progressiveRefreshAfterPending = false;
}
function ensureProgressiveEventStream(report, expected, context, source) {
  if (typeof window.EventSource !== "function" || !remuxMseCacheAllowed
    || !/^[a-f0-9]{64}$/i.test(String(report?.identityKey || ""))
    || !["waiting", "building", "partial-ready"].includes(report?.status)) {
    closeProgressiveEventStream(); return;
  }
  const key = `${report.identityKey}:${expected.generation}:${expected.sourceKey}:${expected.audioIndex}:${expected.audioMode}`;
  if (progressiveEventStream && progressiveEventKey === key) return;
  closeProgressiveEventStream();
  const url = `/api/torrents/${encodeURIComponent(context.sessionId)}/files/${context.fileIndex}/progressive/events?audio=${expected.audioIndex}&audioMode=${encodeURIComponent(expected.audioMode)}`;
  const stream = new window.EventSource(url);
  progressiveEventStream = stream;
  progressiveEventKey = key;
  stream.addEventListener("ready", () => {
    const live = progressiveSeekContext();
    if (progressiveEventStream !== stream
      || state.currentSource !== source || state.transcodeContext !== context
      || !live || live.generation !== expected.generation
      || live.audioIndex !== expected.audioIndex || live.audioMode !== expected.audioMode) {
      if (progressiveEventStream === stream) closeProgressiveEventStream();
      return;
    }
    // The SSE message is only an invalidation notification. Always refetch
    // atomically verified status rather than trusting event-supplied intervals.
    progressiveSeekStatusAt = 0;
    if (progressiveSeekStatusPending) progressiveRefreshAfterPending = true;
    else checkProgressiveSeekCache();
  });
}
function progressiveSeekContext() {
  const context = state.transcodeContext;
  if (!context?.sessionId || !Number.isInteger(context.fileIndex)
    || !(state.mediaDurationMs > 0) || !state.currentSource) return null;
  return {
    sourceKey: `torrent:${context.sessionId}:${context.fileIndex}`,
    generation: Number(playbackLoadRequestId) || 0,
    audioIndex: Number(context.audioIndex) || 0,
    audioMode: normalizeAudioMode(audioOutputMode),
    durationSeconds: state.mediaDurationMs / 1000,
    mediaToken: state.currentSource,
    mime: progressiveSeekReady?.report?.mime || '',
  };
}
function readyProgressiveWindow(target) {
  const selection = progressiveSeekReady;
  const expected = progressiveSeekContext();
  if (!remuxMseCacheAllowed || !expected || !selection?.snapshot
    || selection.context !== state.transcodeContext
    || selection.source !== state.currentSource
    || selection.generation !== expected.generation
    || selection.audioIndex !== expected.audioIndex
    || selection.audioMode !== expected.audioMode) return null;
  return findProgressiveReadySegment(selection.snapshot, target);
}
function checkProgressiveSeekCache() {
  // An older still-running server may serve app.js but not this new
  // optional frontend module. Never poll unsupported endpoints or paint ready
  // ranges when the decoder helper could not load.
  if (!progressiveSeekAvailable) return;
  // Server-sent `ready` events invalidate this cache immediately. Keep a much
  // slower safety poll only while that authenticated stream is OPEN; otherwise
  // use the bounded 3s fallback. This avoids stat'ing thousands of completed
  // GOP files on every timer tick for a 58-minute episode.
  const intervalMs = progressiveEventStream?.readyState === 1 ? 30000 : 3000;
  if (!remuxMseCacheAllowed || !state.currentSource || !state.transcodeContext
    || video.dataset.mode !== "transcode" || video.dataset.indexed === "1"
    || progressiveSeekStatusPending || Date.now() - progressiveSeekStatusAt < intervalMs)
    return;
  const context = state.transcodeContext, source = state.currentSource;
  const expected = progressiveSeekContext();
  if (!expected) return;
  const url = `/api/torrents/${encodeURIComponent(context.sessionId)}/files/${context.fileIndex}/progressive/status?audio=${expected.audioIndex}&audioMode=${encodeURIComponent(expected.audioMode)}&generation=${expected.generation}`;
  progressiveSeekStatusAt = Date.now();
  progressiveSeekStatusPending = true;
  void fetchJson(url, { signal: AbortSignal.timeout(4500) }).then(report => {
    const current = progressiveSeekContext();
    if (state.transcodeContext !== context || state.currentSource !== source
      || !current || !remuxMseCacheAllowed || current.generation !== expected.generation
      || current.audioIndex !== expected.audioIndex
      || current.audioMode !== expected.audioMode) return;
    const nextStatus = report?.kind === "indexed-video-segments"
      ? String(report.status || "unavailable") : "unavailable";
    progressiveWaitingSince = nextStatus === "waiting"
      ? (progressiveIndexStatus === "waiting" && progressiveWaitingSince
        ? progressiveWaitingSince : Date.now()) : 0;
    progressiveIndexStatus = nextStatus;
    // An async response is not proof of a new source: bind the response to
    // exactly the selected episode/audio and its load generation.
    const scoped = report && { ...report, mediaToken: source };
    const snapshot = normalizeProgressiveSeekStatus(scoped, current);
    progressiveSeekReady = snapshot
      ? { report: scoped, snapshot, context, source, generation: expected.generation,
        audioIndex: expected.audioIndex, audioMode: expected.audioMode }
      : null;
    const fingerprint = JSON.stringify(snapshot ? progressiveReadyRanges(snapshot) : []);
    if (fingerprint !== progressiveTimelineRangesFingerprint) {
      progressiveTimelineRangesFingerprint = fingerprint;
      progressiveTimelineVersion += 1;
    }
    if (typeof ensureProgressiveEventStream === "function")
      ensureProgressiveEventStream(report,expected,context,source);
    renderProgressiveSeekableRanges();
  }).catch(() => {
    if (state.transcodeContext === context && state.currentSource === source)
      progressiveIndexStatus = "unavailable";
  }).finally(() => {
    progressiveSeekStatusPending = false;
    if (progressiveRefreshAfterPending) {
      progressiveRefreshAfterPending = false;
      progressiveSeekStatusAt = 0;
      checkProgressiveSeekCache();
    }
  });
}
function renderProgressiveSeekableRanges() {
  const layer = $("#player-progress-progressive");
  if (!layer) return;
  const expected = progressiveSeekContext();
  // A verified FULL indexed MP4 is seekable across the entire episode. Its
  // authoritative ready overlay already paints the whole bar; don't leave
  // the narrower standalone-GOP safety gaps striped on top of that proof.
  const fullIndexedReady = video.dataset.indexed === "1" || readyIndexedVideo();
  const ranges = !fullIndexedReady && expected && readyProgressiveWindow
    ? (progressiveSeekReady?.context === state.transcodeContext
      && progressiveSeekReady?.source === state.currentSource
      && progressiveSeekReady?.generation === expected.generation
      && progressiveSeekReady?.audioIndex === expected.audioIndex
      && progressiveSeekReady?.audioMode === expected.audioMode
      ? progressiveReadyRanges(progressiveSeekReady.snapshot) : []) : [];
  const duration = expected?.durationSeconds || 0;
  // Avoid forcing layout during each timeupdate. ResizeObserver updates the
  // cached size when a phone rotates or the progress bar changes width.
  if (!layer.__lvlWidth || typeof ResizeObserver !== "function") {
    layer.__lvlWidth = layer.getBoundingClientRect?.().width || layer.clientWidth || 600;
    if (typeof ResizeObserver === "function" && !layer.__lvlWidthObserver) {
      layer.__lvlWidthObserver = new ResizeObserver((entries) => {
        const measured = entries[0]?.contentRect?.width;
        if (measured) { layer.__lvlWidth = measured; renderProgressiveSeekableRanges(); }
      });
      layer.__lvlWidthObserver.observe(layer);
    }
  }
  const width = Math.max(1,Math.min(16384,
    Math.ceil(layer.__lvlWidth
      * Math.min(3,window.devicePixelRatio || 1))));
  // The entire disjoint interval map is fingerprinted ONCE per verified
  // status response; ordinary timeupdate repaint checks use only its version.
  // A changed or revoked *interior* island must never remain falsely bright.
  const key = `${progressiveTimelineVersion}:${width}:${duration}:${fullIndexedReady}:`
    + String(progressiveSeekReady?.report?.identityKey || '');
  if (progressiveTimelineKey === key) return;
  progressiveTimelineKey = key;
  // Canvas keeps a 58-minute timeline with ~1,700 individually indexed GOPs
  // from allocating/reflowing thousands of span elements every status update.
  // The paint is intentionally only for independently verified *seekable*
  // positions, never torrent download percentages or unverified gap bytes.
  layer.width = width;
  layer.height = 2;
  const painter = layer.getContext?.('2d');
  if (!painter || !duration) return;
  painter.clearRect(0,0,width,2);
  painter.fillStyle = 'rgba(255,255,255,.4)';
  for (const {start,end} of ranges) {
    if (end <= start) continue;
    painter.fillRect(Math.max(0,start / duration * width),0,
      Math.max(0,(end-start) / duration * width),2);
  }
}
async function extendProgressivePlayback({ force = false } = {}) {
  const loader = progressiveMseLoader, win = loader?.currentWindow;
  const selection = progressiveSeekReady, context = progressiveSeekContext();
  if (progressiveContinueController || !win || !context || !selection?.snapshot
    || video.dataset.progressive !== "1" || state.pendingSeek
    || selection.source !== state.currentSource
    || selection.context !== state.transcodeContext
    || selection.generation !== context.generation
    || selection.audioIndex !== context.audioIndex
    || selection.audioMode !== context.audioMode) return false;
  const seconds = Number(video.currentTime);
  if (!force && (!Number.isFinite(seconds) || win.endSeconds - seconds > 1.5))
    return false;
  // Only a specifically verified NEXT GOP from the same source and exact init
  // may be appended; a downloaded hole or different audio/source is never
  // treated as continuous media. Keep the MSE buffer bounded.
  const next = selection.snapshot.segments.find(item => item.id !== win.id
    && item.initHash === win.initHash
    && item.startSeconds >= win.endSeconds - 0.15
    && item.startSeconds <= win.endSeconds + 0.15
    && item.endSeconds > win.endSeconds + 0.1);
  if (!next) return false;
  const controller = new AbortController();
  progressiveContinueController = controller;
  const source = state.currentSource, transcode = state.transcodeContext;
  const loadId = playbackLoadRequestId;
  const current = () => !controller.signal.aborted
    && progressiveMseLoader === loader && video.dataset.progressive === "1"
    && state.currentSource === source && state.transcodeContext === transcode
    && playbackLoadRequestId === loadId && remuxMseCacheAllowed;
  try {
    return await loader.appendNext({segment:next,
      context:{...context,mime:selection.report.mime},
      signal:controller.signal,isCurrent:current});
  } finally {
    if (progressiveContinueController === controller) progressiveContinueController = null;
  }
}
export function progressiveBufferEndAroundCurrent() {
  // MSE may expose fewer buffered frames than the verified GOP metadata end
  // (audio/video timestamp rounding and demux trimming). Recovery must use
  // what the browser can actually play, not a theoretical final timestamp.
  const movieEnd = Number(progressiveMseLoader?.currentWindow?.endSeconds);
  const now = Number(video.currentTime);
  if (!Number.isFinite(movieEnd) || !Number.isFinite(now)) return null;
  try {
    for (let i = 0; i < (video.buffered?.length || 0); i += 1) {
      const start = video.buffered.start(i), end = video.buffered.end(i);
      if (start <= now + 0.1 && end >= now - 0.2) {
        return Math.min(movieEnd, end);
      }
    }
  } catch { /* SourceBuffer might be removed while its video source changes. */ }
  // No actual TimeRange covers the playhead. Metadata's GOP end is NOT
  // evidence that an unbuffered seek can be played from this SourceBuffer.
  return null;
}
export function continueProgressiveOrRecover({ force = false, fromEnded = false } = {}) {
  if (progressiveBoundaryAttempt || video.dataset.progressive !== "1"
    || state.pendingSeek || state.scrubbing || !progressiveMseLoader) return false;
  const at = Number(video.currentTime);
  const end = progressiveBufferEndAroundCurrent() ?? (force || fromEnded ? at : NaN);
  if (!Number.isFinite(end) || !Number.isFinite(at)
    || (!force && end - at > 1.5) || (!fromEnded && video.paused)) return false;
  const source = state.currentSource, transcode = state.transcodeContext;
  const loadId = playbackLoadRequestId, loader = progressiveMseLoader;
  const wasPlaying = fromEnded || playerIsPlaying();
  const attempt = { source, transcode, loadId, loader };
  progressiveBoundaryAttempt = attempt;
  const current = () => progressiveBoundaryAttempt === attempt
    && state.currentSource === source && state.transcodeContext === transcode
    && playbackLoadRequestId === loadId && progressiveMseLoader === loader
    && video.dataset.progressive === "1" && !state.pendingSeek;
  void extendProgressivePlayback({ force: true }).then(continued => {
    if (continued || !current()) return;
    // A delayed section HTTP response may settle after the viewer pressed
    // Pause. The initial `wasPlaying` snapshot is no longer permission to
    // restart playback and produce phantom audio after an intentional pause.
    if (!fromEnded && video.paused) return;
    const endNow = progressiveBufferEndAroundCurrent() ?? (force || fromEnded ? at : NaN);
    const position = Number(video.currentTime);
    if (!Number.isFinite(endNow) || !Number.isFinite(position)
      || (!fromEnded && position < endNow - 0.15)) return;
    const target = Math.max(0, Math.min(position,
      Math.max(0, state.mediaDurationMs / 1000 - 0.05)));
    if (typeof beginQuietSourceSwitch === "function") beginQuietSourceSwitch();
    if (!readyIndexedVideo() || !openIndexedSeekAt(target, { wasPlaying }))
      void restartTranscodeAt(target, { wasPlaying, forceNative: true });
  }).catch(() => {
    if (!current()) return;
    if (!fromEnded && video.paused) return;
    const target = Math.max(0, Number(video.currentTime) || 0);
    if (typeof beginQuietSourceSwitch === "function") beginQuietSourceSwitch();
    if (!readyIndexedVideo() || !openIndexedSeekAt(target, { wasPlaying }))
      void restartTranscodeAt(target, { wasPlaying, forceNative: true });
  }).finally(() => {
    if (progressiveBoundaryAttempt === attempt) progressiveBoundaryAttempt = null;
  });
  return true;
}
function indexedCacheStatusUrl(context = state.transcodeContext) {
  if (!context?.sessionId || !Number.isInteger(context.fileIndex)) return null;
  const audioIndex = Number.isInteger(context.audioIndex) ? context.audioIndex : (state.selectedAudioTrack || 0);
  const audioMode = normalizeAudioMode(audioOutputMode);
  // sections=1: playback runs from prepared sections, so the server keeps preparing them.
  const sections = video.dataset.progressive === "1" ? "&sections=1" : "";
  return `/api/torrents/${encodeURIComponent(context.sessionId)}/files/${context.fileIndex}/indexed/status?audio=${audioIndex}&audioMode=${encodeURIComponent(audioMode)}${sections}`;
}
function readyIndexedVideo() {
  const cache = indexedSeekReady, context = state.transcodeContext;
  return Boolean(remuxMseCacheAllowed && cache?.url
    && cache.context === context && cache.source === state.currentSource
    && cache.audioIndex === context?.audioIndex && cache.audioMode === normalizeAudioMode(audioOutputMode));
}

// A snapshot for the Storage screen. Only the authenticated exact source,
// audio plan and generation can mark cached positions as available.
export function playerFastSeekAvailability() {
  const context = progressiveSeekContext();
  const selection = progressiveSeekReady;
  const fullIndexed = readyIndexedVideo();
  const exactRange = Boolean(context && selection?.snapshot
    && selection.source === state.currentSource && selection.context === state.transcodeContext
    && selection.generation === context.generation
    && selection.audioIndex === context.audioIndex
    && selection.audioMode === context.audioMode);
  return {
    fullIndexed,
    exactRange,
    ranges: fullIndexed && context?.durationSeconds
      ? [{ start: 0, end: context.durationSeconds }]
      : exactRange ? progressiveReadyRanges(selection.snapshot) : [],
    sourceMatches: Boolean(state.currentSource && (fullIndexed || exactRange)),
    audioMatches: Boolean(context && (fullIndexed || exactRange)),
    targetSeconds: absolutePlaybackSeconds(),
  };
}
function checkIndexedSeekCache() {
  // The server now atomically arbitrates the encoder slot in favor of
  // independently seekable GOP preparation before admitting the full-MP4
  // builder. Do not suppress ordinary indexed discovery here: paused players
  // may have no further timeupdate to revive a missed full-index request.
  if (!remuxMseCacheAllowed || video.dataset.mode !== "transcode"
    || video.dataset.indexed === "1" || !state.currentSource
    || !state.transcodeContext || indexedSeekStatusPending
    || Date.now() - indexedSeekStatusAt < 10000) return;
  const context = state.transcodeContext, source = state.currentSource;
  const audioIndex = context.audioIndex, audioMode = normalizeAudioMode(audioOutputMode);
  const url = indexedCacheStatusUrl(context);
  if (!url) return;
  indexedSeekStatusAt = Date.now();
  indexedSeekStatusPending = true;
  void fetchJson(url, { signal: AbortSignal.timeout(4500) }).then(report => {
    if (state.transcodeContext !== context || state.currentSource !== source
      || !remuxMseCacheAllowed || context.audioIndex !== audioIndex
      || normalizeAudioMode(audioOutputMode) !== audioMode) return;
    const prefix = `/api/torrents/${encodeURIComponent(context.sessionId)}/files/${context.fileIndex}/indexed?`;
    if (report?.status === "ready" && String(report.url || "").startsWith(prefix))
      indexedSeekReady = { context, source, audioIndex, audioMode, url: report.url };
    else indexedSeekReady = null;
    // A verified FULL indexed MP4 is more reliable than stitching tiny
    // independently verified progressive GOPs. Switching to it reloads the
    // video, which shows as a short pause with the loader, so do it now only
    // while paused. During playback the switch waits for the next seek or
    // section boundary, where the player changes source anyway.
    if (readyIndexedVideo() && video.dataset.mode === "transcode"
      && video.dataset.indexed !== "1" && !state.pendingSeek
      && !state.scrubbing && !video.ended && video.paused) {
      const at = absolutePlaybackSeconds();
      if (Number.isFinite(at) && at >= 0 && at < state.mediaDurationMs / 1000) {
        if (typeof beginQuietSourceSwitch === "function") beginQuietSourceSwitch();
        openIndexedSeekAt(at, { wasPlaying: false });
      }
    }
  }).catch(() => {}).finally(() => { indexedSeekStatusPending = false; });
}

// The player reveals the current show's logo gradually. The stage label is
// screen-reader text; titles without artwork use the same minimal progress fill.
export let playerLoadingLibraryId = "";
let playerLoadingArtworkRequest = 0;
let playerLoadingColorProgress = 0;
let playerLoadingArtworkPending = false;
function setPlayerLoadingArtwork(primary, fallback = "") {
  const brand = $("#video-loading-brand");
  const ghost = $("#video-loading-logo-ghost");
  const fill = $("#video-loading-logo-fill");
  if (!brand || !ghost || !fill) return;
  const key = `${primary || ""}\n${fallback || ""}`;
  if (brand.dataset.artworkKey === key) return;
  brand.dataset.artworkKey = key;
  const request = ++playerLoadingArtworkRequest;
  // An artwork request can finish long after the loading estimate jumps ahead.
  // Reveal every newly loaded logo from gray instead of starting fully colored.
  playerLoadingColorProgress = 0;
  drawPlayerLoadingProgress(playerLoadingVisualProgress);
  brand.hidden = true;
  playerLoadingArtworkPending = Boolean(primary);
  ghost.removeAttribute("src");
  fill.removeAttribute("src");
  if (!primary) return;
  const probe = new Image();
  const reveal = () => {
    if (request !== playerLoadingArtworkRequest) return;
    if (!probe.naturalWidth) return;
    playerLoadingArtworkPending = false;
    ghost.src = probe.src;
    fill.src = probe.src;
    brand.hidden = false;
    updatePlayerLoadingAnimation();
  };
  probe.onload = reveal;
  probe.onerror = () => {
    if (request !== playerLoadingArtworkRequest) return;
    if (fallback && probe.src !== fallback) probe.src = fallback;
    else playerLoadingArtworkPending = false;
  };
  probe.src = primary;
}
export function setPlayerLoadingTitle(entry = null, fallbackTitle = "") {
  playerLoadingLibraryId = entry?.id || "";
  // Local files without a verified catalog identity keep the minimal progress line.
  if (typeof document === "undefined") return;
  if (!entry) { setPlayerLoadingArtwork(""); return; }
  const series = buildLibrarySeries().find((item) => item.key === (entry.seriesKey || librarySeriesKey(entry.title)));
  const id = String(entry.catalogId || series?.catalogId || (series && watchCatalogIdFor(series)) || "");
  const raw = id
    ? String([catalogChapterLists.get(id)?.meta, movieArtRecords.get(id)?.meta, titleSeedMeta.get(id), homeTitleIndex.get(id)]
      .map((meta) => meta?.logo).find(Boolean) || "")
    : "";
  const primary = logoUrl({ id, logo: raw });
  setPlayerLoadingArtwork(primary, raw && raw !== primary ? raw : "");
}

// Loading stages arrive in bursts (e.g. 4%, then 68%). Interpolate the
// presentation independently, with a slow bounded advance between updates.
  // The reveal can never reach 100% before playback becomes ready.
let playerLoadingHideTimer = 0;
let playerLoadingVisualProgress = 0;
let playerLoadingVisualFrame = 0;
let playerLoadingVisualTime = 0;
function drawPlayerLoadingProgress(value) {
  const overlay = $("#video-loading");
  overlay?.style.setProperty("--load-fill", `${Number(value.toFixed(2))}%`);
  overlay?.style.setProperty("--logo-fill", `${Number(playerLoadingColorProgress.toFixed(2))}%`);
}
export function stopPlayerLoadingAnimation() {
  if (playerLoadingVisualFrame && typeof window.cancelAnimationFrame === "function")
    window.cancelAnimationFrame(playerLoadingVisualFrame);
  playerLoadingVisualFrame = 0;
  playerLoadingVisualTime = 0;
}
function animatePlayerLoadingProgress(time) {
  playerLoadingVisualFrame = 0;
  const overlay = $("#video-loading");
  if (!overlay || overlay.hidden || overlay.classList.contains("is-error")) return;
  const delta = playerLoadingVisualTime ? Math.min(0.08, Math.max(0, (time - playerLoadingVisualTime) / 1000)) : 1 / 60;
  playerLoadingVisualTime = time;
  const reported = state.loadingProgress;
  if (reported >= 100) {
    playerLoadingVisualProgress = Math.min(100, playerLoadingVisualProgress + 225 * delta);
  } else if (playerLoadingVisualProgress < reported) {
    playerLoadingVisualProgress = Math.min(reported, playerLoadingVisualProgress + 17 * delta);
  } else {
    const ceiling = Math.min(94, reported + 22);
    playerLoadingVisualProgress = Math.min(ceiling, playerLoadingVisualProgress + 0.85 * delta);
  }
  // Loading may spend minutes finding peers or preparing a decoder. Keep the
  // logo visibly active instead of freezing its color wipe around 70-92%.
  // The cycle is indeterminate: it does not claim a measured percentage.
  if (!$("#video-loading-brand")?.hidden) {
    playerLoadingColorProgress = reported >= 100
      ? Math.min(100, playerLoadingColorProgress + 48 * delta)
      : (playerLoadingColorProgress + 16 * delta) % 100;
  }
  drawPlayerLoadingProgress(playerLoadingVisualProgress);
  if ((playerLoadingVisualProgress < 100 || (reported >= 100 && playerLoadingColorProgress < 100))
    && typeof window.requestAnimationFrame === "function")
    playerLoadingVisualFrame = window.requestAnimationFrame(animatePlayerLoadingProgress);
}
function updatePlayerLoadingAnimation({ reset = false, error = false } = {}) {
  if (reset || error) stopPlayerLoadingAnimation();
  if (reset) { playerLoadingVisualProgress = 0; playerLoadingColorProgress = 0; }
  if (typeof window.requestAnimationFrame !== "function" || window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) {
    playerLoadingVisualProgress = state.loadingProgress;
    // Reduced-motion mode should show a steady gray logo while loading,
    // not a misleading half-colored pseudo-percentage frozen for minutes.
    playerLoadingColorProgress = state.loadingProgress >= 100 ? 100 : 0;
    drawPlayerLoadingProgress(playerLoadingVisualProgress);
    return;
  }
  if (reset || error) drawPlayerLoadingProgress(playerLoadingVisualProgress);
  if (!error && !playerLoadingVisualFrame)
    playerLoadingVisualFrame = window.requestAnimationFrame(animatePlayerLoadingProgress);
}
export function setPlayerLoading(percent, title = "Loading", detail = "", { error = false } = {}) {
  if (!error && Date.now() < quietSwitchUntil && $("#video-loading")?.hidden) {
    quietSwitchLoading = [percent, title, detail];
    if (!quietSwitchTimer) quietSwitchTimer = window.setTimeout(() => {
      quietSwitchTimer = 0;
      const args = quietSwitchLoading;
      quietSwitchLoading = null;
      if (args && state.pendingSeek) setPlayerLoading(...args);
    }, Math.max(0, quietSwitchUntil - Date.now()));
    return;
  }
  quietSwitchUntil = 0;
  quietSwitchLoading = null;
  window.clearTimeout(playerLoadingHideTimer);
  playerLoadingHideTimer = 0;
  const previousStage = Number(state.loadingProgress) || 0;
  const value = error ? Math.min(94, Math.max(0, Number(state.loadingProgress) || 0))
    : Math.max(0, Math.min(94, Math.round(Number(percent) || 0)));
  state.loadingProgress = value;
  state.loadingDetail = String(detail || "");
  const overlay = $("#video-loading");
  if (!overlay) return;
  const failed = error || recoveryDisplayPhase === "failed";
  const recovering = recoveryDisplayPhase === "recovering" && !failed;
  // The visual bar deliberately creeps *ahead* of the last reported stage.
  // Comparing a repeated stage against that visual estimate wrongly restarted
  // the logo wipe on every torrent status update, leaving it half-colored
  // throughout long peer/decoder waits. Reset only for an actual stage rewind.
  const reset = overlay.hidden || (!failed && value + 2 < previousStage);
  overlay.hidden = false;
  overlay.classList.toggle("is-error", failed);
  overlay.classList.toggle("is-recovering", recovering);
  const actions = $("#video-loading-actions");
  if (actions) actions.hidden = !failed || !currentRecoveryKey();
  const retryAction = $("#player-retry-source");
  if (retryAction) retryAction.textContent = typeof transcodeStartAttempt !== "undefined"
    && transcodeStartAttempt?.awaitingUserGesture ? "Play" : "Retry";
  overlay.style.setProperty("--progress", String(value));
  if ($("#video-loading-title")) $("#video-loading-title").textContent = recovering ? "Restoring playback" : failed && recoveryDisplayPhase === "failed" ? "Playback unavailable" : title;
  renderRecoveryOverlay();
  updatePlayerLoadingAnimation({ reset, error: failed });
}
// Automatic switches between sources of the same video (the next prepared
// section is missing, or the whole-episode file became ready) usually finish
// within a moment. During one, setPlayerLoading waits QUIET_SWITCH_MS and shows
// the loader only if the switch is still going, so a quick one doesn't flash it.
const QUIET_SWITCH_MS = 900;
let quietSwitchUntil = 0;
let quietSwitchTimer = 0;
let quietSwitchLoading = null;
function beginQuietSourceSwitch() {
  quietSwitchUntil = Date.now() + QUIET_SWITCH_MS;
}

function updateLoadingTransferDetail(payload) {
  const peers = Number(payload?.numPeers) || 0;
  const speed = Number(payload?.downloadSpeed) || 0;
  state.loadingTransferDetail = payload && (peers || speed)
    ? [speed ? `${formatTransferBytes(speed)}/s` : "", peers ? `${peers} peer${peers === 1 ? "" : "s"}` : ""].filter(Boolean).join(", ")
    : "";
}

// A new episode can spend seconds resolving its torrent and codec plan. During
// that gap the old HTMLVideoElement retains its last decoded picture even while
// the branded loader already shows the NEW episode's artwork. Unload it before
// any asynchronous metadata work; release visibility only for the new decoder.
let sourceFrameGate = null;
function preserveCurrentFrameForTranscodeSeek() {
  const canvas = typeof document !== "undefined" ? document.getElementById("video-seek-freeze") : null;
  if (!canvas || !canvas.hidden || video.readyState < 2 || !video.videoWidth || !video.videoHeight
    || state.currentSource?.kind !== "torrent") return;
  try {
    const drawing = canvas.getContext("2d", { alpha: false });
    if (!drawing) return;
    drawing.fillStyle = "#000";
    drawing.fillRect(0, 0, canvas.width, canvas.height);
    // Preserve contain aspect ratio rather than stretching 4:3/21:9 frames.
    const scale = Math.min(canvas.width / video.videoWidth, canvas.height / video.videoHeight);
    const w = video.videoWidth * scale, h = video.videoHeight * scale;
    drawing.drawImage(video, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
    canvas.hidden = false;
  } catch { canvas.hidden = true; } // CORS/protected video: keep original black fallback.
}
function clearTranscodeSeekFrame() {
  const canvas = typeof document !== "undefined" ? document.getElementById("video-seek-freeze") : null;
  if (canvas) canvas.hidden = true;
}
function clearPreviousVideoFrame() {
  clearTranscodeSeekFrame();
  video.pause();
  video.style.visibility = "hidden";
  video.removeAttribute("src");
  video.load();
  sourceFrameGate = { src: "", source: null, loadId: null };
}
function expectNewVideoFrame() {
  if (!video.src) return;
  // Re-arm on EVERY decoder URL replacement, including retries and a same-
  // episode MSE -> native fallback after the first loadeddata cleared the
  // original episode-transition gate. Otherwise late errors from the old
  // decoder can be mistaken for the new stream's priming failure.
  video.style.visibility = "hidden";
  frame.classList.add("source-transition");
  sourceFrameGate = { src: video.src, source: state.currentSource, loadId: playbackLoadRequestId };
}
export function isNewSourceFramePending() {
  return Boolean(sourceFrameGate);
}
export function wireSourceFrameGate() {
  video.addEventListener("loadeddata", () => {
    const gate = sourceFrameGate;
    if (!gate?.src || state.currentSource !== gate.source
      || playbackLoadRequestId !== gate.loadId || video.src !== gate.src
      || video.currentSrc !== gate.src || video.readyState < 2) return;
    sourceFrameGate = null;
    // For copied keyframe seeks loadeddata can describe the preroll frame,
    // which is still hidden until the *requested* timestamp is presented.
    // Retain the last-picture backdrop through that hidden interval.
    if (!state.pendingSeek?.priming) clearTranscodeSeekFrame();
    video.style.visibility = "";
    frame.classList.remove("source-transition");
    if (!state.pendingSeek) finishPlayerLoading();
  });
}

export function beginSourceTransition() {
  closeRemuxMseSession();
  cancelTranscodeStart();
  clearAutoNext();
  // A user-selected new episode is a new incident; recovery-selected sources
  // retain the same bounded history across their asynchronous transition.
  if (!recoveryBusy) resetRecoveryDisplay();
  // The episode being left keeps where it stopped.
  if (frame.classList.contains("has-video") && video.src) recordWatchProgress({ force: true });
  frame.classList.add("source-transition");
  clearPreviousVideoFrame();
}

function finishPlayerLoading() {
  const overlay = $("#video-loading");
  if (typeof isNewSourceFramePending === "function" && isNewSourceFramePending()) return;
  frame.classList.remove("source-transition");
  // A late event from the old buffered media must not conceal a recovery/error
  // panel for the newly requested source.
  if (!overlay || overlay.hidden || overlay.classList.contains("is-error") || recoveryDisplayPhase === "recovering") return;
  state.loadingProgress = 100;
  overlay.style.setProperty("--progress", "100");
  updatePlayerLoadingAnimation();
  window.clearTimeout(playerLoadingHideTimer);
  // If playback was ready quickly, let the gray-to-color sweep visibly finish
  // instead of abruptly concealing the loader with only a few colored pixels.
  const quickHide = Boolean(window.LvlAndroid);
  let artworkWaitChecks = 0;
  const hideWhenRevealed = () => {
    if (state.loadingProgress !== 100 || overlay.hidden) { playerLoadingHideTimer = 0; return; }
    const brand = $("#video-loading-brand");
    // Artwork often arrives AFTER the first canplay/playing event. Previously
    // the loader disappeared during that image request and never showed a
    // gray-to-color transition at all. Allow one brief, bounded grace period
    // for the current show's logo, without holding an absent logo indefinitely.
    if (!quickHide && playerLoadingArtworkPending && artworkWaitChecks++ < 12) {
      playerLoadingHideTimer = window.setTimeout(hideWhenRevealed, 100);
      return;
    }
    if (!quickHide && brand && !brand.hidden && playerLoadingColorProgress < 99.5 && playerLoadingVisualFrame) {
      playerLoadingHideTimer = window.setTimeout(hideWhenRevealed, 100);
      return;
    }
    overlay.hidden = true;
    stopPlayerLoadingAnimation();
    playerLoadingHideTimer = 0;
  };
  playerLoadingHideTimer = window.setTimeout(hideWhenRevealed, quickHide ? 120 : 550);
}

export function clearPlayerControlsHideTimer() {
  if (playerControlsHideTimer) window.clearTimeout(playerControlsHideTimer);
  playerControlsHideTimer = null;
}

export function hidePlayerControls() {
  clearPlayerControlsHideTimer();
  if (!frame.classList.contains("has-video")) return;
  frame.classList.add("controls-hidden");
  notifyPhonePlayerControlsHidden();
}

export function schedulePlayerControlsHide() {
  clearPlayerControlsHideTimer();
  if (!frame.classList.contains("has-video")) return;
  playerControlsHideTimer = window.setTimeout(() => hidePlayerControls(), 3000);
}

export function revealPlayerControls() {
  if (!frame.classList.contains("has-video")) return;
  frame.classList.remove("controls-hidden");
  schedulePlayerControlsHide();
}

export function clearBufferingTimer() {
  if (state.bufferingTimer) window.clearTimeout(state.bufferingTimer);
  state.bufferingTimer = null;
}

let playbackRecovery = createPlaybackRecoveryState();
let recoveryWaitingSince = null;
let recoveryLastMotionAt = 0;
let recoveryLastPosition = -1;
export let recoveryBusy = false;
// A failed media load can leave paused=true even though the last user action
// was Play. Keep that intent until an actual user pause, so errors after resume
// still reach bounded recovery instead of being dismissed as idle.
let recoveryPlaybackRequested = false;
let recoveryPauseSerial = 0;
// The old decoder is intentionally paused while a recovery-selected Library
// source resolves. Controls must address that source's desired playback, not
// the temporary video.paused value. A newer load ID cannot inherit this token.
let recoveryAlternateIntent = null;
let recoveryWatchTimer = null;
let recoveryDisplayPhase = "";
let recoveryDisplayEvents = [];
let recoveryDisplayEpisode = "";
let recoveryStallDiagnosis = null;
let streamStatusHealth = null;
let streamStatusAt = 0;
let streamStatusGeneration = 0;
let streamStatusController = null;
let latestTorrentPieceSnapshot = null;
let waitingTorrentSeek = null;
let waitingTorrentSeekNudge = 0;
let waitingTorrentSeekNudging = false;

function currentTorrentSeekPieceStatus(target) {
  const snapshot = latestTorrentPieceSnapshot;
  if (!snapshot || snapshot.source !== state.currentSource || Date.now() - snapshot.at > 10_000) return "unknown";
  const context = state.transcodeContext;
  if (!context || snapshot.sessionId !== context.sessionId || snapshot.fileIndex !== context.fileIndex) return "unknown";
  if (snapshot.verifiedComplete === true) return "verified-complete";
  if (!snapshot.map) return "unknown";
  try {
    return torrentSeekPieceStatus({
      buckets: decodeBase64Bytes(snapshot.map),
      targetSeconds: target,
      durationSeconds: Number(state.mediaDurationMs) / 1000 || snapshot.durationSeconds,
      verifiedComplete: false,
    });
  } catch { return "unknown"; }
}

// A missing torrent position can be prioritized by rechecking its copy start;
// the verified probe response, not the approximate downloaded-piece bitmap,
// decides when an unusually slow read can resume.
async function nudgeWaitingTorrentSeek() {
  const waiting = waitingTorrentSeek;
  if (!waiting?.context?.sessionId || waitingTorrentSeekNudging) return;
  const target = Math.max(0, Number(waiting.target) || 0);
  if (!target) return;
  waitingTorrentSeekNudging = true;
  try {
    const result = await fetchJson(`/api/torrents/${encodeURIComponent(waiting.context.sessionId)}/files/${waiting.context.fileIndex}/transcode-start?start=${target.toFixed(3)}&video=copy`,
      { signal: AbortSignal.timeout(20_000) });
    if (waitingTorrentSeek !== waiting || result?.verified !== true) return;
    if (state.currentSource !== waiting.source || state.transcodeContext !== waiting.context) return;
    clearWaitingTorrentSeek();
    void openTranscodeAt(target, { wasPlaying: waiting.wasPlaying, forceNative: true });
  } catch { /* The torrent can still be downloading; retry on the next nudge. */ }
  finally { waitingTorrentSeekNudging = false; }
}

function clearWaitingTorrentSeek() {
  waitingTorrentSeek = null;
  if (waitingTorrentSeekNudge) clearInterval(waitingTorrentSeekNudge);
  waitingTorrentSeekNudge = 0;
}

function waitForMissingTorrentSeek(target, wasPlaying, { slowSeek = false } = {}) {
  // MediaError4 does not prove an HEVC decode failure: a missing BitTorrent
  // piece may make FFmpeg finish without a usable fMP4 atom after HTTP 200.
  // Do not repeatedly start a converter while the byte-range is still absent.
  const pieceStatus = currentTorrentSeekPieceStatus(target);
  const noConversion = !serverCanConvertVideo();
  const waitAnyway = noConversion && Number(target) > 0 && (pieceStatus === "unknown" || slowSeek);
  if (pieceStatus !== "missing" && !waitAnyway) return false;
  const source = state.currentSource;
  const context = state.transcodeContext;
  if (!source?.sessionId || !context) return false;
  cancelTranscodeStart();
  video.pause();
  waitingTorrentSeek = { source, context, target, wasPlaying, nudgeOnly: slowSeek };
  if (waitingTorrentSeekNudge) clearInterval(waitingTorrentSeekNudge);
  void nudgeWaitingTorrentSeek();
  waitingTorrentSeekNudge = setInterval(() => { void nudgeWaitingTorrentSeek(); }, 8000);
  const dataHere = pieceStatus === "likely-ready" || pieceStatus === "verified-complete";
  setPlayerLoading(90, dataHere ? "Loading this part of the video" : "Waiting for torrent data",
    dataHere ? "Reading this position is taking longer than usual. Playback will continue by itself; you can also choose another source."
      : "Video pieces near this position are still downloading. Playback will retry when available; you can also choose another source.",
    { error: true });
  return true;
}

function resumeWaitingTorrentSeek(payload, source) {
  const waiting = waitingTorrentSeek;
  if (!waiting) return;
  if (state.currentSource !== waiting.source || source !== waiting.source
    || state.transcodeContext !== waiting.context) {
    clearWaitingTorrentSeek();
    return;
  }
  if (waiting.nudgeOnly) return;
  // A verified complete file is safe immediately. Otherwise, the approximate
  // bucket must include the target AND its preceding possible keyframe window.
  if (currentTorrentSeekPieceStatus(waiting.target) === "missing") return;
  if (currentTorrentSeekPieceStatus(waiting.target) === "unknown") return;
  if (typeof clearWaitingTorrentSeek === "function") clearWaitingTorrentSeek();
  void openTranscodeAt(waiting.target, { wasPlaying: waiting.wasPlaying, forceNative: true });
}

function invalidateStreamStatus() {
  streamStatusGeneration += 1;
  streamStatusController?.abort();
  streamStatusController = null;
  streamStatusHealth = null;
  streamStatusAt = 0;
}

function clearStreamStatusLabel() {
  const node = $("#media-status");
  if (node && recoveryStallDiagnosis?.message === node.textContent) node.textContent = "READY";
}

function currentStreamDiagnosis() {
  if (!currentRecoveryKey() || !streamStatusHealth || Date.now() - streamStatusAt > 4_500) return null;
  const recovering = recoveryDisplayPhase === "recovering";
  return classifyPlaybackStreamStatus(streamStatusHealth, {
    stalled: (recovering || recoveryWaitingSince !== null) && (recovering || video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA),
    paused: video.paused && !(recovering && recoveryPlaybackRequested),
    seeking: Boolean(state.pendingSeek || video.seeking),
    ended: Boolean(video.ended),
  });
}

export function resetRecoveryDisplay() {
  recoveryDisplayPhase = "";
  recoveryDisplayEvents = [];
  recoveryDisplayEpisode = "";
  recoveryStallDiagnosis = null;
  $("#video-recovery-details")?.removeAttribute("open");
}

function recordRecoveryDisplay(type, reason = "") {
  if (!recoveryDisplayEpisode) recoveryDisplayEpisode = recoveryEpisodeCode(state.currentSource?.sourceTag || watchPendingSelection?.episode?.code);
  const plan = video.dataset.mode === "torrent-direct" ? "direct"
    : video.dataset.mode === "transcode" ? (state.transcodeContext?.copyVideo ? "remux" : "transcode") : "other";
  const attempt = type === "retry" ? playbackRecovery.retryCount
    : type === "switch" ? playbackRecovery.sourceSwitches : 0;
  recoveryDisplayEvents = addRecoveryEvent(recoveryDisplayEvents, {
    type, reason, plan, attempt, seconds: absolutePlaybackSeconds(),
  });
}

function renderRecoveryOverlay() {
  // During retries show only the regular LVL loading artwork, not a diagnostic
  // log. Preserve the bounded history for an actionable final failure.
  const shown = recoveryDisplayPhase === "failed";
  const diagnosis = recoveryStallDiagnosis || currentStreamDiagnosis();
  const message = $("#video-recovery-message");
  const meta = $("#video-recovery-meta");
  const details = $("#video-recovery-details");
  if (message) {
    const terminalDetail = recoveryDisplayPhase !== "failed" && $("#video-loading")?.classList.contains("is-error")
      ? String(state.loadingDetail || "").slice(0, 240) : "";
    message.hidden = !shown && !(recoveryDisplayPhase === "recovering" && diagnosis) && !terminalDetail;
    message.textContent = shown
      ? diagnosis?.message || "Couldn't resume this episode. Recovery attempts were unsuccessful."
      : terminalDetail || diagnosis?.message || "";
  }
  if (meta) {
    meta.hidden = !shown;
    const latestRetry = [...recoveryDisplayEvents].reverse().find((event) => event.label === "Retrying current source")?.attempt || 0;
    const count = recoveryDisplayPhase === "failed"
      ? `${playbackRecovery.attemptedSourceKeys.length} source${playbackRecovery.attemptedSourceKeys.length === 1 ? "" : "s"} attempted`
      : playbackRecovery.pendingSourceKey ? `Source switch ${playbackRecovery.sourceSwitches}`
        : `Retry ${Math.max(playbackRecovery.retryCount, latestRetry)}`;
    meta.textContent = `${recoveryDisplayEpisode || "Current video"} - ${formatTime(absolutePlaybackSeconds() * 1000)} - ${count}`;
  }
  if (details) {
    details.hidden = recoveryDisplayPhase !== "failed" || !recoveryDisplayEvents.length;
    if (!details.hidden) {
      const events = $("#video-recovery-events");
      if (events) {
        // Only predetermined labels and enum-derived reasons are logged.
        events.replaceChildren(...recoveryDisplayEvents.map((entry) => {
          const row = document.createElement("div");
          const time = new Date(entry.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
          row.textContent = `${time} - ${entry.label} - ${entry.plan}${entry.reason ? ` - ${entry.reason}` : ""}${entry.attempt ? ` - Attempt ${entry.attempt}` : ""}${entry.label === "Playback restored" ? ` - ${formatTime(entry.seconds * 1000)}` : ""}`;
          return row;
        }));
      }
    }
  }
}

function currentRecoveryKey() {
  const source = state.currentSource;
  return source?.kind === "torrent" ? playbackRecoverySourceKey(source.libraryId, source.fileIndex) : "";
}

// A new source starts its own recovery history (sourceGeneration: the load it belongs to).
export function changeRecoverySource(sourceGeneration) {
  playbackRecovery = changePlaybackRecoverySource(playbackRecovery, currentRecoveryKey(), { sourceGeneration });
  recoveryLastPosition = -1;
  recoveryLastMotionAt = Date.now();
  recoveryMotionAnchorRequired = true;
}

export function markPlaybackMotion() {
  const sourceKey = currentRecoveryKey();
  if (!sourceKey || state.pendingSeek || video.seeking || video.paused === true
    || playbackRecovery.sourceKey && playbackRecovery.sourceKey !== sourceKey
    || playbackRecovery.sourceGeneration != null
      && playbackRecovery.sourceGeneration !== playbackLoadRequestId) return;
  const now = Date.now();
  if (!recoveryPictureVisible(now)) return;
  const mediaClock = absolutePlaybackSeconds();
  // After buffering the audio/media clock can advance while the decoder keeps
  // presenting the same picture. Those clock-only updates must not disarm the
  // frozen-frame watchdog or replenish the bounded recovery retry budget.
  // The raw rVFC clock is tied to this source, unlike the cue display clock
  // which intentionally falls back to currentTime when video frames are late.
  const hasFrameClock = typeof video.requestVideoFrameCallback === "function";
  const presented = hasFrameClock ? presentedSubtitleSeconds() : null;
  if (hasFrameClock && (!Number.isFinite(presented) || Math.abs(presented - mediaClock) > 0.75)) {
    // Keep one uncredited baseline so the first subsequent real forward frame
    // can close Recovery; the baseline alone earns no motion or retry reset.
    if (recoveryLastPosition < 0 && Number.isFinite(mediaClock)) recoveryLastPosition = mediaClock;
    return;
  }
  const position = hasFrameClock ? presented : mediaClock;
  const previous = recoveryLastPosition;
  const movedBack = previous >= 0 && position < previous - 0.25;
  const movedForward = previous >= 0 && position >= previous + 0.3;
  if (movedForward || movedBack || previous < 0) {
    // A first decoded frame after a long observation gap is a new anchor, not
    // five seconds of continuous playback. Use the existing five-second policy
    // for that break; a backward/large seek also starts at its proven frame.
    const observationGap = previous >= 0 && now - recoveryLastMotionAt >= 5_000;
    const clockJump = movedForward && position - previous > 15;
    const reanchor = recoveryMotionAnchorRequired || previous < 0 || observationGap
      || movedBack || clockJump;
    const advanced = movedForward && !observationGap && !movedBack && !clockJump;
    recoveryMotionAnchorRequired = false;
    recoveryLastPosition = position;
    recoveryLastMotionAt = now;
    recoveryWaitingSince = null;
    playbackRecovery = recordPlaybackProgress(playbackRecovery, {
      sourceKey: currentRecoveryKey(), currentTimeSeconds: position,
      sourceGeneration: playbackLoadRequestId,
      reanchor,
    });
    if (advanced && recoveryDisplayPhase === "recovering" && !recoveryBusy) {
      recordRecoveryDisplay("restored");
      recoveryDisplayPhase = "";
      recoveryStallDiagnosis = null;
      renderRecoveryOverlay();
      finishPlayerLoading();
    }
  }
}

// Private observation state belongs to the active source's decoded timeline;
// a visible frame after a hidden interval or seek must establish a new anchor.
let recoveryFrameVisibilitySuspended = false;
let recoveryMotionAnchorRequired = false;
function recoveryPictureVisible(now = Date.now()) {
  // Hidden Chromium tabs can play audio while suppressing video callbacks.
  // Native and document PiP remain rendered when the parent document is hidden.
  const visible = document.hidden !== true || document.pictureInPictureElement === video
    || Boolean(window.documentPictureInPicture?.window);
  if (!visible) { recoveryFrameVisibilitySuspended = true; return false; }
  if (recoveryFrameVisibilitySuspended) {
    recoveryFrameVisibilitySuspended = false;
    recoveryLastMotionAt = now;
    recoveryLastPosition = -1;
    recoveryMotionAnchorRequired = true;
  }
  return true;
}

function beginRecoveryWatch() {
  recoveryWaitingSince = Date.now();
  recoveryLastMotionAt = Date.now();
  recoveryLastPosition = -1;
  if (typeof recoveryMotionAnchorRequired !== "undefined") recoveryMotionAnchorRequired = true;
  if (recoveryWatchTimer !== null) return;
  recoveryWatchTimer = window.setInterval(() => {
    // PiP remains the active viewing surface after navigating to Library or
    // Title. Hidden Watch without PiP must stay idle, but PiP still needs the
    // same bounded torrent-stall recovery as the full player.
    if (!currentRecoveryKey() || !frame.classList.contains("has-video")
      || (!viewActive("watch") && !$("#view-watch")?.classList.contains("is-floating")
        && document.pictureInPictureElement !== video && !window.documentPictureInPicture?.window)
      || recoveryBusy || state.pendingSeek || video.seeking || video.ended || video.paused) return;
    const now = Date.now();
    // Keep the watchdog's readyState-based buffering test independent of the
    // picture visibility check, including before frame observation starts.
    const hiddenPicture = typeof recoveryPictureVisible === "function"
      ? !recoveryPictureVisible(now)
      : document.hidden === true && document.pictureInPictureElement !== video
        && !window.documentPictureInPicture?.window;
    const stalled = isPlaybackStallExpired({
      waitingSinceMs: recoveryWaitingSince, nowMs: now,
      paused: video.paused,
      seeking: Boolean(state.pendingSeek || video.seeking),
      ended: video.ended,
      readyState: video.readyState,
    });
    const frozen = !hiddenPicture && !video.paused && recoveryLastMotionAt && now - recoveryLastMotionAt >= 16_000
      && (!state.mediaDurationMs || absolutePlaybackSeconds() < state.mediaDurationMs / 1000 - 3);
    if ((stalled || frozen) && waitOutTorrentBuffering(now)) return;
    if (stalled || frozen) void recoverPlayback("stall");
  }, 2000);
}

// On devices without a video encoder, repeatedly reconnecting a torrent that
// is still buffering loses useful downloaded data. Give a progressing buffer
// time to catch up while keeping a bounded timeout when growth stops.
const TORRENT_BUFFERING_IDLE_MS = 20_000;
const LOADED_VIDEO_STALL_MS = 60_000;
let torrentBufferingMark = null;
function waitOutTorrentBuffering(now = Date.now()) {
  if (serverCanConvertVideo() || !state.currentSource?.sessionId || video.error) return false;
  let bufferedEnd = 0;
  try { bufferedEnd = video.buffered?.length ? video.buffered.end(video.buffered.length - 1) : 0; } catch {}
  const mark = torrentBufferingMark;
  if (!mark || mark.src !== video.currentSrc || mark.at < recoveryLastMotionAt
    || bufferedEnd > mark.bufferedEnd + 0.25 || bufferedEnd < mark.bufferedEnd - 1) {
    torrentBufferingMark = { src: video.currentSrc, bufferedEnd, at: now };
    return true;
  }
  const loadedAhead = bufferedEnd - (Number(video.currentTime) || 0);
  return now - mark.at < (loadedAhead >= 5 ? LOADED_VIDEO_STALL_MS : TORRENT_BUFFERING_IDLE_MS);
}

export function stopRecoveryWatch() {
  if (recoveryWatchTimer !== null) window.clearInterval(recoveryWatchTimer);
  recoveryWatchTimer = null;
  recoveryWaitingSince = null;
}

async function forceCompatibilityTranscode() {
  const source = state.currentSource;
  if (!source?.sessionId || source.fileIndex === null || source.fileIndex === undefined) return false;
  const at = absolutePlaybackSeconds();
  const baseUrl = `/api/torrents/${encodeURIComponent(source.sessionId)}/files/${source.fileIndex}/transcode`;
  state.transcodeContext = { baseUrl, sessionId: source.sessionId, fileIndex: source.fileIndex, audioIndex: state.selectedAudioTrack || 0, forceH264: true };
  setPlayerLoading(15, "Recovering video", "Switching to compatible playback");
  const opened = await openTranscodeAt(at, { wasPlaying: true });
  if (!opened) return false;
  beginRecoveryWatch();
  return true;
}

function reloadDirectTorrentAt(seconds) {
  invalidateSubtitleFrameClock();
  if (typeof invalidateStreamStatus === "function") invalidateStreamStatus();
  const source = state.currentSource;
  if (!source?.sessionId) return false;
  const target = Math.max(0, Number(seconds) || 0);
  const fileIndex = source.fileIndex;
  const baseUrl = `/api/torrents/${encodeURIComponent(source.sessionId)}/files/${source.fileIndex}/stream`;
  const loadGeneration = (Number(video.__lvlLoadGeneration) || 0) + 1;
  video.__lvlLoadGeneration = loadGeneration;
  setPlayerLoading(18, "Reconnecting video", formatTime(target * 1000));
  video.src = baseUrl;
  video.load();
  if (target > 0) video.addEventListener("loadedmetadata", () => {
    if (video.__lvlLoadGeneration !== loadGeneration
      || state.currentSource?.sessionId !== source.sessionId || state.currentSource?.fileIndex !== fileIndex
      || video.src !== new URL(baseUrl, location.href).href) return;
    try { video.currentTime = target; } catch {}
  }, { once: true });
  void video.play().catch(() => {
    // A rejected playback promise can leave the element paused without a
    // `waiting`/`error` event. The stall watchdog ignores paused elements, so
    // forward this failure to the existing bounded recovery controller.
    if (video.__lvlLoadGeneration === loadGeneration && !state.pendingSeek
      && state.currentSource?.sessionId === source.sessionId
      && video.src === new URL(baseUrl, location.href).href && recoveryPlaybackRequested)
      void recoverPlayback("error");
  });
  beginRecoveryWatch();
  return true;
}

export async function recoverPlayback(reason = "error") {
  if (recoveryBusy || !currentRecoveryKey() || (video.ended && reason !== "early-eof") || state.pendingSeek) return;
  if (video.paused && state.loadingProgress >= 100 && !recoveryPlaybackRequested && reason !== "early-eof") return;
  // Media events can arrive after Home cancelled an unfinished load. Recovery
  // must not silently restart audio when there is no playback surface.
  if (!viewActive("watch") && !$("#view-watch")?.classList.contains("is-floating")
    && !floatingDesktopWindow && !floatingDesktopPending
    && document.pictureInPictureElement !== video && !window.documentPictureInPicture?.window) return;
  const key = currentRecoveryKey();
  const alternatives = currentChapterSources().map(({ entry, episode }) => ({
    key: playbackRecoverySourceKey(entry.id, episode.fileIndex), entry, episode,
  }));
  const next = requestPlaybackRecovery(playbackRecovery, {
    sourceKey: key, alternateSourceKeys: alternatives.map((item) => item.key), reason,
    sourceGeneration: playbackLoadRequestId,
  });
  playbackRecovery = next.state;
  const action = next.action;
  if (action.type === "none") return;
  // The Library target may advance playbackLoadRequestId before becoming an
  // active source. Only that observed attempt may carry the existing recovery
  // incident across a failed alternate, never a later manual source choice.
  let recoverySwitchOwner = playbackRecovery;
  let recoverySwitchLoadId = playbackLoadRequestId;
  let alternateIntent = null;
  const ownsRecoveryLoad = () => playbackRecovery === recoverySwitchOwner
    && playbackLoadRequestId === recoverySwitchLoadId
    && currentRecoveryKey() === key;
  const ownsFailedRecoverySwitch = () => ownsRecoveryLoad()
    && (!alternateIntent || recoveryAlternateIntent === alternateIntent
      && alternateIntent.wantsPlay && recoveryPlaybackRequested)
    && (viewActive("watch") || $("#view-watch")?.classList.contains("is-floating")
      || floatingDesktopWindow || floatingDesktopPending
      || document.pictureInPictureElement === video || window.documentPictureInPicture?.window);
  if (!recoveryStallDiagnosis) recoveryStallDiagnosis = currentStreamDiagnosis();
  if (recoveryDisplayPhase !== "recovering") {
    recoveryDisplayEvents = [];
    recoveryDisplayEpisode = "";
    recordRecoveryDisplay("problem", reason === "error" && !recoveryStallDiagnosis && [3, 4].includes(video.error?.code) ? "decode" : reason);
  }
  if (action.type === "give-up") {
    recordRecoveryDisplay("stopped", reason);
    recoveryDisplayPhase = "failed";
    stopRecoveryWatch();
    $("#media-status").textContent = "Playback stopped: sources did not recover";
    setPlayerLoading(100, "Playback unavailable", "Try another source or return to Library.", { error: true });
    toast("Playback couldn't recover. You can choose another source.", { tone: "error" });
    return;
  }
  recoveryBusy = true;
  recoveryDisplayPhase = "recovering";
  recordRecoveryDisplay(action.type === "retry-source" ? "retry" : "switch", reason);
  setPlayerLoading(18, "Reconnecting playback");
  try {
    if (action.type === "retry-source") {
      $("#media-status").textContent = "Recovering stalled video…";
      // A browser may report a decode/source error after torrent starvation.
      // Observed missing pieces cannot be fixed by changing the video codec.
      const strategy = playbackRetryStrategy(video.dataset.mode,
        (recoveryStallDiagnosis?.networkStarvation ? "stall" : reason), video.error?.code,
        { canConvert: serverCanConvertVideo() });
      if (strategy === "compatibility") {
        if (!await forceCompatibilityTranscode()) throw new Error("Compatibility playback could not start");
      } else if (strategy === "restart-direct") {
        if (!reloadDirectTorrentAt(absolutePlaybackSeconds())) throw new Error("Direct playback could not restart");
      }
      else if (strategy === "restart-transcode" && video.dataset.mode === "transcode") {
        const at = absolutePlaybackSeconds();
        // A progressive GOP is a short standalone MSE, not a resumable long
        // FFmpeg producer. After a long pause or MediaError4, don't re-enter
        // the same optional remux-MSE failure path. Prefer the separately
        // verified complete MP4; otherwise recover one-way through native.
        const fullIndexed = video.dataset.progressive === "1"
          && typeof readyIndexedVideo === "function" && readyIndexedVideo()
          && openIndexedSeekAt(at, { wasPlaying: true });
        if (!fullIndexed && !await restartTranscodeAt(at, {
          wasPlaying: true, forceNative: video.dataset.progressive === "1",
        }))
          throw new Error("Converted playback could not restart");
      }
    } else if (action.type === "switch-source") {
      const alternate = alternatives.find((item) => item.key === action.sourceKey);
      if (!alternate) throw new Error("Alternate source no longer exists");
      alternateIntent = { loadId: null, sourceKey: action.sourceKey, wantsPlay: recoveryPlaybackRequested || !video.paused, phase: "pending" };
      recoveryAlternateIntent = alternateIntent;
      recoveryStallDiagnosis = null; // The new source has no measured stall yet.
      const at = absolutePlaybackSeconds();
      setPlayerLoading(10, "Switching source", "The current video stopped responding");
      const switched = await playLibraryEpisode(alternate.entry.id, Number(alternate.episode.fileIndex), {
        resumeAtSeconds: at,
        onLoadRequest: (loadId) => { recoverySwitchLoadId = loadId; alternateIntent.loadId = loadId; },
        shouldAutoPlay: () => recoveryAlternateIntent === alternateIntent
          && playbackLoadRequestId === alternateIntent.loadId && alternateIntent.wantsPlay,
      });
      if (!switched) {
        if (!ownsRecoveryLoad() || recoveryAlternateIntent !== alternateIntent
          || playbackRecovery.pendingSourceKey !== action.sourceKey) return;
        playbackRecovery = failPlaybackRecoverySwitch(playbackRecovery, { sourceGeneration: recoverySwitchLoadId });
        recoverySwitchOwner = playbackRecovery;
        alternateIntent.phase = "failed";
        if (!alternateIntent.wantsPlay) return;
        throw new Error("The alternate source could not start.");
      }
      if (recoveryAlternateIntent === alternateIntent) alternateIntent.phase = "ready";
    }
    recoveryWaitingSince = Date.now();
    recoveryLastMotionAt = Date.now();
    recoveryLastPosition = -1;
  } catch (error) {
    if (action.type === "switch-source" && !ownsFailedRecoverySwitch()) return;
    recordRecoveryDisplay("failed", reason);
    renderRecoveryOverlay();
    console.warn("Playback recovery attempt failed:", error);
    recoveryWaitingSince = Date.now() - 7_000; // retry or move to another source at next watchdog check
    recoveryLastMotionAt = Date.now() - 15_000;
    // A failed restart (including a rejected seek-origin lookup) can leave the
    // video paused. The stall watchdog rightly ignores user pauses, but cannot
    // recover this internally failed attempt; advance the bounded controller
    // even if it was a same-source retry. Never wake a different source.
    window.setTimeout(() => {
      if (currentRecoveryKey() === key && recoveryDisplayPhase === "recovering"
        && (action.type !== "switch-source" || ownsFailedRecoverySwitch()))
        void recoverPlayback(action.type === "switch-source" ? "alternate-failed" : "error");
    }, 400);
  } finally {
    recoveryBusy = false;
  }
}

function scheduleBufferingIndicator() {
  clearBufferingTimer();
  if (video.paused) return;
  state.bufferingTimer = window.setTimeout(() => {
    state.bufferingTimer = null;
    if (video.paused || video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA
      || (video.seeking && isPlayerTimeBuffered(video.currentTime))) return;
    setPlayerLoading(Math.max(86, state.loadingProgress), "Buffering", formatTime(state.currentMs));
    $("#media-status").textContent = currentStreamDiagnosis()?.message || "TORRENT - BUFFERING";
  }, 320);
}

export function absolutePlaybackSeconds() {
  if (state.pendingSeek) return state.pendingSeek.target;
  return (video.dataset.mode === "transcode" ? state.transcodeBaseOffsetSeconds : 0) + (Number(video.currentTime) || 0);
}

// Browser-decoded/downloaded fMP4 TimeRanges are *local to the current
// conversion window*, not the whole torrent's movie timeline. In particular,
// do not color the gap from conversion origin to the first buffered frame, or
// join a stale previous range to a newer non-contiguous one.
function playerReadyRangeSeconds() {
  // A verified completed indexed rendition is seekable for the entire episode
  // even while the old native/MSE reader finishes playing until the first seek.
  // readyIndexedVideo() is source/audio/Settings-generation guarded and only
  // true after the backend has atomically published a complete Range MP4.
  if ((video.dataset.indexed === "1" || (typeof readyIndexedVideo === "function" && readyIndexedVideo()))
    && state.mediaDurationMs > 0)
    return { start: 0, end: state.mediaDurationMs / 1000 };
  const ranges = video.buffered;
  if (!ranges?.length) return null;
  const base = video.dataset.mode === "transcode" ? state.transcodeBaseOffsetSeconds : 0;
  const now = Number(video.currentTime) || 0;
  for (let index = 0; index < ranges.length; index += 1) {
    try {
      const start = ranges.start(index), end = ranges.end(index);
      if (Number.isFinite(start) && Number.isFinite(end)
        && start <= now + 0.1 && end >= now)
        return { start: start + base, end: end + base };
    } catch { /* Range may be invalidated by a simultaneous source reset. */ }
  }
  return null;
}

// Only browser-buffered frames are instant seeks. A torrent's downloaded disk
// pieces are not necessarily available to the media element yet; a transcode
// explicitly starts a new stream for every nontrivial seek.
function isPlayerTimeBuffered(seconds) {
  if (video.dataset.mode === "transcode" && video.dataset.indexed !== "1"
    && video.dataset.progressive !== "1") return false;
  const ranges = video.buffered;
  if (!ranges || !Number.isFinite(seconds)) return false;
  const duration = Number(video.duration);
  const lookAhead = Number.isFinite(duration) && seconds >= duration - 0.35 ? 0 : 0.25;
  // Sparse progressive MSE is NOT buffered even 0.01s before a new island's
  // first decoded frame. Do not seek into that gap using the old ±100ms slack.
  const startTolerance = video.dataset.progressive === "1" ? 0 : 0.1;
  for (let index = 0; index < ranges.length; index += 1) {
    if (ranges.start(index) <= seconds + startTolerance
      && ranges.end(index) >= seconds + lookAhead) return true;
  }
  return false;
}
function hideLoadingForBufferedSeek() {
  const overlay = $("#video-loading");
  if (!overlay || overlay.hidden || overlay.classList.contains("is-error")) return;
  window.clearTimeout(playerLoadingHideTimer);
  playerLoadingHideTimer = 0;
  overlay.hidden = true;
  stopPlayerLoadingAnimation();
}

// Downloaded parts of the playing file, drawn faintly under the timeline (bytes ≈ time).
function drawPlayerDownloadMap(fileMap) {
  const canvas = $("#player-progress-map");
  const legend = $("#player-saved-legend");
  if (!canvas) return;
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (!fileMap?.map) {
    if (legend) legend.hidden = true;
    return;
  }
  const values = decodeBase64Bytes(fileMap.map);
  const width = canvas.width / Math.max(1, values.length);
  for (let index = 0; index < values.length; index += 1) {
    if (!values[index]) continue;
    context.fillStyle = `rgba(255,255,255,${(0.1 + (values[index] / 255) * 0.28).toFixed(3)})`;
    context.fillRect(Math.floor(index * width), 0, Math.ceil(width), canvas.height);
  }
  if (legend) {
    legend.hidden = false;
    $("#player-saved-percent").textContent = `${Math.round((Number(fileMap.progress) || 0) * 100)}%`;
  }
}

// Status messages show briefly under the title; routine playback states are not shown at all.
const ROUTINE_STATUS = /^(?:READY|TORRENT(?: STREAM| [-·] (?:TRANSCODING|TRANSCODE PLAYING|AUDIO → AAC|SEEKING .*|PLAYING|BUFFERING))|LOCAL .*|LIBRARY [-·] RESOLVING .*)$/i;
let mediaStatusTimer = 0;
export function watchMediaStatus() {
  const node = $("#media-status");
  if (!node) return;
  new MutationObserver(() => {
    const text = node.textContent.trim();
    window.clearTimeout(mediaStatusTimer);
    const visible = Boolean(text) && !ROUTINE_STATUS.test(text);
    node.classList.toggle("is-visible", visible);
    if (visible) mediaStatusTimer = window.setTimeout(() => node.classList.remove("is-visible"), /fail|error|could|no |unsupported/i.test(text) ? 12_000 : 6_000);
  }).observe(node, { childList: true, characterData: true, subtree: true });
}

function formatTransferBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value >= 1073741824) return `${(value / 1073741824).toFixed(2)} GB`;
  if (value >= 1048576) return `${(value / 1048576).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(0)} KB`;
  return `${Math.round(value)} B`;
}

export function updateTransferStats(payload = null) {
  // Series/season packs contain many files. Show the selected episode's
  // downloaded/total bytes, not the size of the entire pack. Upload accounting
  // remains torrent-wide because WebTorrent has no per-file upload total.
  const selectedFileIndex = Number(state.currentSource?.fileIndex);
  const hasSelectedFile = state.currentSource?.fileIndex != null && Number.isInteger(selectedFileIndex);
  const selectedFile = hasSelectedFile
    ? payload?.files?.find((file) => Number(file.index) === selectedFileIndex) : null;
  const down = Number(hasSelectedFile ? selectedFile?.downloaded : payload?.downloaded) || 0;
  const up = Number(payload?.uploaded) || 0;
  if ($("#player-downloaded")) $("#player-downloaded").textContent = `↓ ${formatTransferBytes(down)}`;
  if ($("#player-uploaded")) $("#player-uploaded").textContent = `↑ ${formatTransferBytes(up)}`;
  const target = $("#player-download-target");
  const totalBytes = Number(hasSelectedFile ? selectedFile?.length : payload?.length);
  const hasTotal = Boolean(payload) && Number.isFinite(totalBytes) && totalBytes > 0;
  if (target) target.textContent = `↓ ${formatTransferBytes(down)} / ${hasTotal ? formatTransferBytes(totalBytes) : "—"}`;
  const stats = $("#player-transfer-stats");
  if (stats) stats.setAttribute("aria-label",
    `Downloaded ${formatTransferBytes(down)}; total to download ${hasTotal ? formatTransferBytes(totalBytes) : "unknown"}`);
  if (stats) stats.hidden = !payload;
  updateLoadingTransferDetail(payload);
}

export function stopTransferStats() {
  if (state.transferStatsTimer) window.clearInterval(state.transferStatsTimer);
  state.transferStatsTimer = null;
  latestTorrentPieceSnapshot = null;
  if (typeof clearWaitingTorrentSeek === "function") clearWaitingTorrentSeek();
  invalidateStreamStatus();
}

export function startTransferStats(sessionId) {
  stopTransferStats();
  if (typeof playbackMetrics !== "undefined" && playbackMetrics && sessionId && state.currentSource?.sessionId === sessionId) {
    void playbackMetrics.trackTorrent(sessionId, state.currentSource.fileIndex);
  }
  updateTransferStats();
  if (!sessionId) { updateTransferStats(); return; }
  let inFlight = false;
  const refresh = async () => {
    if (inFlight) return;
    const source = state.currentSource;
    const generation = streamStatusGeneration;
    const loadGeneration = Number(video.__lvlLoadGeneration) || 0;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]);
    inFlight = true;
    streamStatusController = controller;
    try {
      if (source?.sessionId !== sessionId) return;
      const fileIndex = Number(source?.fileIndex);
      const query = Number.isInteger(fileIndex) && fileIndex >= 0 ? `?file=${fileIndex}` : "";
      const payload = await fetchJson(`/api/torrents/${encodeURIComponent(sessionId)}${query}`, { signal });
      if (signal.aborted || generation !== streamStatusGeneration || state.currentSource !== source
        || (Number(video.__lvlLoadGeneration) || 0) !== loadGeneration) return;
      const selectedFile = payload?.files?.find((item) => Number(item.index) === fileIndex);
      latestTorrentPieceSnapshot = {
        source, sessionId, fileIndex, at: Date.now(),
        map: payload.fileMap?.map || null,
        durationSeconds: Number(selectedFile?.durationSeconds) || 0,
        verifiedComplete: selectedFile?.verifiedComplete === true,
      };
      updateTransferStats(payload);
      drawPlayerDownloadMap(payload.fileMap || null);
      streamStatusHealth = payload.streamHealth || null;
      streamStatusAt = Date.now();
      const diagnosis = currentStreamDiagnosis();
      // Preserve a measured stall if Chromium emits pause before its error.
      // User pauses and seeks clear it below, while a media error can reuse it
      // to avoid mistaking network starvation for an unsupported codec.
      if (diagnosis) recoveryStallDiagnosis = diagnosis;
      if (recoveryDisplayPhase === "recovering" || recoveryDisplayPhase === "failed") renderRecoveryOverlay();
      else if (diagnosis && !$("#video-loading")?.hidden)
        $("#media-status").textContent = diagnosis.message;
      resumeWaitingTorrentSeek(payload, source);
      // The server prepares seekable sections when the player asks for their
      // status. A paused video fires no media events, so ask from this timer
      // too; both checks limit themselves to one request every few seconds.
      checkProgressiveSeekCache();
      checkIndexedSeekCache();
    } catch {} finally {
      if (streamStatusController === controller) streamStatusController = null;
      inFlight = false;
    }
  };
  void refresh();
  state.transferStatsTimer = window.setInterval(refresh, 1500);
}

export function setMediaSource({ src, title, status, objectUrl = null, mode = "local", durationMs = 0, startAtSeconds = 0 }, { preserveTranscodeStart = false } = {}) {
  if (typeof cancelIndexedSeekAttempt === "function") cancelIndexedSeekAttempt();
  progressiveSeekController?.cancel();
  progressiveContinueController?.abort();
  progressiveBoundaryAttempt = null;
  closeProgressiveEventStream();
  progressiveMseLoader?.close?.();
  progressiveSeekController = null;
  progressiveMseLoader = null;
  if (progressiveSeekOriginalMute !== null) {
    video.muted = progressiveSeekOriginalMute;
    progressiveSeekOriginalMute = null;
  }
  delete video.dataset.indexed;
  delete video.dataset.progressive;
  if (typeof remuxMseSession !== "undefined" && remuxMseSession
    && remuxMseSession.objectUrl !== src) closeRemuxMseSession();
  if (typeof invalidateStreamStatus === "function") invalidateStreamStatus();
  if (typeof playbackMetrics !== "undefined") playbackMetrics?.newSource({ playbackMode: mode, startSeconds: Number(startAtSeconds) || 0,
    seekReopen: mode === "transcode" && Number(startAtSeconds) > 0 });
  invalidateSubtitleFrameClock();
  const loadGeneration = (Number(video.__lvlLoadGeneration) || 0) + 1;
  video.__lvlLoadGeneration = loadGeneration;
  if (!preserveTranscodeStart) cancelTranscodeStart();
  clearAutoNext({ resetDismissal: true });
  if (mode === "torrent-direct" || mode === "transcode") beginRecoveryWatch();
  else stopRecoveryWatch();
  if (video.dataset.objectUrl) {
    URL.revokeObjectURL(video.dataset.objectUrl);
    delete video.dataset.objectUrl;
  }
  video.pause();
  transcodePauseSnapshot = null;
  video.dataset.mode = mode;
  window.clearTimeout(state.pendingSeek?.timer);
  state.pendingSeek = null;
  state.scrubbing = false;
  drawPlayerDownloadMap(null);
  progressiveSeekReady = null;
  progressiveSeekStatusAt = 0;
  progressiveIndexStatus = "unknown";
  progressiveWaitingSince = 0;
  progressiveTimelineKey = "";
  progressiveTimelineRangesFingerprint = "";
  progressiveTimelineVersion += 1;
  renderProgressiveSeekableRanges();
  if (mode !== "transcode") {
    state.transcodeBaseOffsetSeconds = 0;
    state.transcodeRequestedStartSeconds = 0;
    state.transcodeContext = null;
  }
  state.mediaDurationMs = Number(durationMs) > 0 ? Number(durationMs) : 0;
  video.controls = false;
  $("#compat-controls").hidden = false;
  $("#compat-progress").max = String(Math.max(1, state.mediaDurationMs / 1000));
  $("#compat-progress").value = "0";
  $("#compat-time").textContent = `00:00 / ${state.mediaDurationMs ? formatTime(state.mediaDurationMs) : "--:--"}`;
  video.src = src;
  if (typeof expectNewVideoFrame === "function") expectNewVideoFrame();
  if (objectUrl) video.dataset.objectUrl = objectUrl;
  frame.classList.add("has-video");
  revealPlayerControls();
  $("#media-title").textContent = title;
  $("#media-status").textContent = status;
  if (mode === "transcode") setPlayerLoading(Math.max(82, state.loadingProgress), "Starting stream");
  else if (mode === "torrent-direct") setPlayerLoading(Math.max(78, state.loadingProgress), "Buffering");
  else $("#video-loading").hidden = true;
  state.currentMs = Math.max(0, Number(startAtSeconds) || 0) * 1000;
  state.lastCueId = null;
  video.load();
  if (mode !== "transcode" && startAtSeconds > 0) {
    const expectedSrc = video.src;
    video.addEventListener("loadedmetadata", () => {
      if (video.src !== expectedSrc || video.__lvlLoadGeneration !== loadGeneration) return;
      try { video.currentTime = Math.max(0, Number(startAtSeconds) || 0); } catch {}
    }, { once: true });
  }
  updateChapterButtons();
  updatePlayerPreferenceButtons();
  renderSubtitleWorkspace();
}

export function updateCompatControls() {
  if (typeof checkProgressiveSeekCache === "function") checkProgressiveSeekCache();
  if (typeof checkIndexedSeekCache === "function") checkIndexedSeekCache();
  const currentMs = Math.max(0, absolutePlaybackSeconds() * 1000);
  const nativeDurationMs = Number.isFinite(video.duration) && video.duration > 0 ? video.duration * 1000 : 0;
  if (video.dataset.mode !== "transcode" && nativeDurationMs && Math.abs(state.mediaDurationMs - nativeDurationMs) > 250) {
    state.mediaDurationMs = nativeDurationMs;
    refreshSubtitleTimelineFits();
  }
  // FFmpeg's currently streamed fragment can report a tiny 13s duration for
  // a 24-minute movie before FFprobe metadata arrives. Never present that
  // fragment length as the actual episode or compress its entire timeline.
  const durationMs = state.mediaDurationMs || (video.dataset.mode === "transcode" ? 0 : nativeDurationMs);
  renderEpisodeTimelineSegments();
  const progress = $("#compat-progress");
  progress.max = String(Math.max(1, durationMs / 1000 || 1));
  const playing = playerIsPlaying();
  $("#compat-play")?.classList.toggle("is-playing", playing);
  $("#compat-play")?.setAttribute("aria-label", playing ? "Pause" : "Play");
  $("#compat-play")?.setAttribute("data-tooltip", playing ? "Pause" : "Play");
  // While the thumb is held, playback must not pull it back (that was the seek "ping-pong").
  const shownMs = state.scrubbing ? Number(progress.value) * 1000 : currentMs;
  if (!state.scrubbing) progress.value = String(Math.min(currentMs / 1000, durationMs / 1000 || currentMs / 1000));
  $("#compat-time").textContent = `${formatTime(shownMs)} / ${durationMs ? formatTime(durationMs) : "--:--"}`;
  const readyRange = playerReadyRangeSeconds();
  const percent = (seconds) => (durationMs ? Math.max(0, Math.min(100, (seconds * 1000 * 100) / durationMs)) : 0);
  $("#player-progress-played").style.width = `${percent(shownMs / 1000)}%`;
  $("#player-progress-ready").style.left = `${readyRange ? percent(readyRange.start) : 0}%`;
  $("#player-progress-ready").style.width = `${readyRange ? Math.max(0, percent(readyRange.end) - percent(readyRange.start)) : 0}%`;
  renderProgressiveSeekableRanges();
  const muted = (transcodeStartAttempt?.mutedForPreroll ? transcodeStartAttempt.wantedMuted : video.muted) || video.volume === 0;
  $("#player-mute")?.classList.toggle("is-muted", muted);
  $("#player-mute")?.setAttribute("aria-label", muted ? "Unmute" : "Mute");
  $("#player-mute")?.setAttribute("data-tooltip", muted ? "Unmute" : "Mute");
  $("#player-volume").value = String(muted ? 0 : video.volume);
}

export function updatePlayerPreferenceButtons() {
  const loop = $("#player-loop-line");
  loop.classList.toggle("is-active", state.loopLine);
  loop.setAttribute("aria-pressed", String(state.loopLine));
  const subs = $("#player-toggle-subs");
  subs.classList.toggle("is-active", state.subtitlesVisible);
  subs.setAttribute("aria-pressed", String(state.subtitlesVisible));
  subs.setAttribute("data-tooltip", "Captions");
  subs.setAttribute("aria-label", "Captions");
  const swap = $("#player-swap-languages");
  swap?.setAttribute("data-tooltip", `Swap ${state.targetLanguage} / ${state.baseLanguage} subtitles`);
  swap?.setAttribute("aria-label", `Swap ${state.targetLanguage} and ${state.baseLanguage} subtitles`);
}

// A copied video fragment begins at the keyframe preceding the requested
// timestamp. The server verifies that frame's original movie time before we
// open it. Keep the requested position in the controls while silently playing
// the preroll, then reveal/unmute only after the requested frame is presented.
export let transcodeStartAttempt = null;
let transcodeStartSerial = 0;
let remuxMseSession = null;
let indexedSeekAttempt = null;
let indexedGapSeekRequest = null;
function cancelIndexedSeekAttempt() {
  const attempt = indexedSeekAttempt;
  if (!attempt) return;
  indexedSeekAttempt = null;
  attempt.cancel();
  if (state.pendingSeek === attempt.pending) state.pendingSeek = null;
}
function closeProgressiveForIndexedSeek() {
  // Full indexed MP4 owns the video element after this point. A former MSE
  // window, its append request, and the muted progressive rVFC callback must
  // never race the newly installed indexed source or leave playback muted.
  progressiveContinueController?.abort();
  progressiveContinueController = null;
  progressiveBoundaryAttempt = null;
  progressiveSeekController?.close();
  progressiveSeekController = null;
  progressiveMseLoader?.close?.();
  progressiveMseLoader = null;
  if (progressiveSeekOriginalMute !== null) {
    video.muted = progressiveSeekOriginalMute;
    progressiveSeekOriginalMute = null;
  }
  delete video.dataset.progressive;
}
function openIndexedSeekAt(target, { wasPlaying = !video.paused } = {}) {
  if (!readyIndexedVideo()) return false;
  const cache = indexedSeekReady;
  const source = state.currentSource, context = state.transcodeContext;
  const loadId = playbackLoadRequestId;
  if (typeof cancelIndexedSeekAttempt === "function") cancelIndexedSeekAttempt();
  closeProgressiveForIndexedSeek();
  closeRemuxMseSession();
  cancelTranscodeStart();
  invalidateSubtitleFrameClock();
  if (!video.paused) video.pause();
  state.transcodeBaseOffsetSeconds = 0;
  state.transcodeRequestedStartSeconds = target;
  const pending = { target, wasPlaying, priming: true };
  state.pendingSeek = pending;
  const url = cache.url;
  video.dataset.indexed = "1";
  video.dataset.mode = "transcode";
  state.currentMs = target * 1000;
  setPlayerLoading(18, "Preparing seekable video", formatTime(target * 1000));
  renderSubtitles();
  const previousObjectUrl = video.dataset.objectUrl;
  if (previousObjectUrl) {
    URL.revokeObjectURL(previousObjectUrl);
    delete video.dataset.objectUrl;
  }
  let watchdog = 0, frameId = null, stopped = false, prerollStarted = false;
  const originalMute = video.muted;
  video.muted = true; // Frame decoder must advance, never leak an early audio cue.
  const valid = () => !stopped && indexedSeekAttempt?.pending === pending
    && state.currentSource === source && state.transcodeContext === context
    && playbackLoadRequestId === loadId && video.dataset.indexed === "1";
  const cancel = () => {
    stopped = true;
    video.muted = originalMute;
    window.clearTimeout(watchdog);
    video.removeEventListener("loadedmetadata", onMetadata);
    video.removeEventListener("loadeddata", onFrameReady);
    video.removeEventListener("seeked", onFrameReady);
    video.removeEventListener("error", onFailure);
    if (frameId !== null && video.cancelVideoFrameCallback)
      video.cancelVideoFrameCallback(frameId);
  };
  const fail = () => {
    if (!valid()) return;
    cancelIndexedSeekAttempt();
    delete video.dataset.indexed;
    void openTranscodeAt(target, { wasPlaying, forceNative: true });
  };
  const onPresentedFrame = (_now, metadata) => {
    frameId = null;
    if (!valid()) return;
    if (Math.abs(Number(metadata?.mediaTime) - target) <= 0.65
      && video.readyState >= 2 && !video.error) {
      const resume = pending.wasPlaying;
      cancelIndexedSeekAttempt();
      if (!resume) video.pause();
      clearTranscodeSeekFrame();
      // A verified frame can arrive before the native loadeddata handler
      // clears its source gate. Do not leave the now-proven source obscured
      // behind the black transition/logo indefinitely.
      // This callback is already owned by the current source, load generation
      // and actual decoder frame. It is stronger evidence than loadeddata,
      // which can miss or arrive before an exact requested frame. A residual
      // transition from a different earlier decoder must not mask this video.
      sourceFrameGate = null;
      video.style.visibility = "";
      frame.classList.remove("source-transition");
      subtitlePresentedFrame = { src: video.src, base: 0, seconds: Number(metadata.mediaTime) };
      state.currentMs = target * 1000;
      renderSubtitles();
      // A full indexed MP4 has just presented the exact target frame. Do not
      // hold an unnecessary 550ms branded-loader reveal after seek completion.
      hideLoadingForBufferedSeek();
      schedulePresentedSubtitleFrame();
      updateCompatControls();
      if (resume && video.paused) void video.play().catch(error => {
        if (error?.name !== "NotAllowedError") void recoverPlayback("error");
      });
      return;
    }
    if (valid()) frameId = video.requestVideoFrameCallback(onPresentedFrame);
  };
  const onFrameReady = () => {
    if (!valid() || video.seeking || video.readyState < 2 || frameId !== null) return;
    if (!prerollStarted) {
      prerollStarted = true;
      void video.play().catch(fail); // muted decode through the exact first frame
    }
    frameId = video.requestVideoFrameCallback(onPresentedFrame);
  };
  const onMetadata = () => {
    if (!valid()) return;
    try { video.currentTime = target; } catch { fail(); }
    onFrameReady();
  };
  const onFailure = () => fail();
  indexedSeekAttempt = { pending, cancel };
  video.addEventListener("loadedmetadata", onMetadata);
  video.addEventListener("loadeddata", onFrameReady);
  video.addEventListener("seeked", onFrameReady);
  video.addEventListener("error", onFailure);
  watchdog = window.setTimeout(fail, 12000);
  video.src = url;
  if (typeof expectNewVideoFrame === "function") expectNewVideoFrame();
  video.load();
  updateCompatControls();
  return true;
}
function seekGapViaVerifiedIndexedOrNative(target, { wasPlaying = playerIsPlaying() } = {}) {
  // A target outside standalone GOPs is NOT an MSE seek. Before starting a
  // fresh native FFmpeg (which can compete with optional index producers),
  // refresh the COMPLETE MP4 status. The existing 10s poll may not yet have
  // discovered an already-committed Range MP4, even after torrent completion.
  const context = state.transcodeContext, source = state.currentSource;
  if (video.dataset.mode !== "transcode" || video.dataset.progressive !== "1"
    || !context?.sessionId
    || !state.currentSource || !remuxMseCacheAllowed) return false;
  const url = indexedCacheStatusUrl(context);
  if (!url) return false;
  indexedGapSeekRequest?.controller.abort();
  const audioIndex = context.audioIndex, audioMode = normalizeAudioMode(audioOutputMode);
  const loadId = playbackLoadRequestId;
  const controller = new AbortController();
  const pending = { target, wasPlaying: Boolean(wasPlaying), gapIndexedLookup: true };
  const attempt = { controller, pending };
  indexedGapSeekRequest = attempt;
  window.clearTimeout(state.pendingSeek?.timer);
  state.pendingSeek = pending;
  if (!video.paused) video.pause();
  state.currentMs = target * 1000;
  setPlayerLoading(18, "Finding verified seekable video", formatTime(state.currentMs));
  renderSubtitles();
  updateCompatControls();
  const current = () => indexedGapSeekRequest === attempt && !controller.signal.aborted
    && playbackLoadRequestId === loadId && state.currentSource === source
    && state.transcodeContext === context && state.pendingSeek === pending
    && context.audioIndex === audioIndex && normalizeAudioMode(audioOutputMode) === audioMode;
  const nativeFallback = () => {
    if (!current()) return;
    // Clear only our own queued lookup, leaving the user's play/pause intent
    // intact for the existing bounded native seek/retry pathway.
    scheduleTranscodeSeek(target, { forceNative: true });
  };
  void fetchJson(url, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(4000)]) })
    .then(report => {
      if (!current()) return;
      const prefix = `/api/torrents/${encodeURIComponent(context.sessionId)}/files/${context.fileIndex}/indexed?`;
      if (report?.status === "ready" && String(report.url || "").startsWith(prefix)) {
        indexedSeekReady = { context, source, audioIndex, audioMode, url: report.url };
        if (readyIndexedVideo() && openIndexedSeekAt(target, { wasPlaying: pending.wasPlaying })) {
          loadMoreEmbeddedSubtitles({ seeked: true });
          return;
        }
      }
      nativeFallback();
    }).catch(() => nativeFallback()).finally(() => {
      if (indexedGapSeekRequest === attempt) indexedGapSeekRequest = null;
    });
  return true;
}
function openProgressiveSeekAt(target, { wasPlaying = !video.paused } = {}) {
  const section = readyProgressiveWindow(target);
  const snapshot = progressiveSeekReady;
  const context = progressiveSeekContext();
  if (!section || !snapshot || !context
    || !window.MediaSource?.isTypeSupported?.(snapshot.report.mime)
    || typeof video.requestVideoFrameCallback !== "function") return false;
  const previousUserMute = progressiveSeekOriginalMute;
  progressiveSeekController?.close();
  progressiveContinueController?.abort();
  progressiveBoundaryAttempt = null;
  progressiveMseLoader?.close?.();
  if (typeof cancelIndexedSeekAttempt === "function") cancelIndexedSeekAttempt();
  closeRemuxMseSession();
  cancelTranscodeStart();
  invalidateSubtitleFrameClock();
  const source = state.currentSource, transcode = state.transcodeContext;
  const loadId = playbackLoadRequestId;
  const oldMute = previousUserMute === null ? video.muted : previousUserMute;
  progressiveSeekOriginalMute = oldMute;
  video.pause();
  video.muted = true;
  video.style.visibility = "";
  state.transcodeBaseOffsetSeconds = 0;
  state.transcodeRequestedStartSeconds = target;
  state.currentMs = target * 1000;
  const pending = { target, wasPlaying, priming: true, streamInstalled: true };
  state.pendingSeek = pending;
  video.dataset.progressive = "1";
  video.dataset.mode = "transcode";
  setPlayerLoading(18, "Seeking verified video section", formatTime(target * 1000));
  const current = () => state.currentSource === source
    && state.transcodeContext === transcode
    && playbackLoadRequestId === loadId && state.pendingSeek === pending
    && video.dataset.progressive === "1";
  const sameProgressiveSource = () => state.currentSource === source
    && state.transcodeContext === transcode && playbackLoadRequestId === loadId
    && video.dataset.progressive === "1"
    && (!state.pendingSeek || state.pendingSeek === pending);
  const requestWindow = async ({ segment, context: selected, signal }) => {
    if (!sameProgressiveSource() || selected.sourceKey !== context.sourceKey
      || selected.generation !== context.generation || signal.aborted)
      throw Error("Progressive source changed");
    const url = `/api/torrents/${encodeURIComponent(transcode.sessionId)}/files/${transcode.fileIndex}/progressive/window/${segment.id}?audio=${context.audioIndex}&audioMode=${encodeURIComponent(context.audioMode)}`;
    // A stalled HTTP body (not just MSE append/updateend) must have a finite
    // deadline. Otherwise appendNext awaits forever, keeping the single-flight
    // boundary recovery lock occupied after a long paused browser session.
    const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
    const response = await fetch(url, { signal: boundedSignal, cache: "no-store" });
    const bytes = Number(response.headers.get("Content-Length"));
    if (!response.ok || response.headers.get("Content-Type") !== "video/mp4"
      || response.headers.get("X-LVL-Progressive-Source") !== transcode.sessionId
      || bytes !== segment.bytes || bytes > 64 * 1024 * 1024)
      throw Error("Verified section unavailable");
    const start = Number(response.headers.get("X-LVL-Progressive-Start-Seconds"));
    const end = Number(response.headers.get("X-LVL-Progressive-End-Seconds"));
    if (Math.abs(start - segment.startSeconds) > 0.003
      || Math.abs(end - segment.endSeconds) > 0.003)
      throw Error("Section timeline changed");
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (!sameProgressiveSource() || signal.aborted || buffer.byteLength !== bytes)
      throw Error("Incomplete indexed section");
    return { segmentId: segment.id, sourceKey: context.sourceKey,
      generation: context.generation, audioIndex: context.audioIndex,
      audioMode: context.audioMode, startSeconds: start, endSeconds: end,
      // Standalone fMP4 fragment timestamps are the original movie clock.
      mediaStartSeconds: segment.mediaStartSeconds ?? segment.startSeconds,
      initHash: segment.initHash, contentType: selected.mime,
      complete: true, verified: true, initVerified: true, bytes: buffer };
  };
  const loader = createStandaloneProgressiveMseLoader({ video, requestWindow });
  const controller = createProgressiveSeekController({
    video, getContext: progressiveSeekContext, loadWindow: loader,
    isVisible: () => video.style.visibility !== "hidden",
    // Begin muted decode ONLY after the verified new MSE source/section has
    // been attached; priming the old media before the window GET completed
    // could leave the new SourceBuffer paused with no presented-frame event.
    seekVideo: async ({ video: element, localSeconds, signal }) => {
      if (signal.aborted) throw Error("Progressive seek cancelled");
      element.currentTime = localSeconds;
      await element.play();
    },
  });
  progressiveMseLoader = loader;
  progressiveSeekController = controller;
  void controller.seek(snapshot.report, target).then(result => {
    if (!current() || progressiveSeekController !== controller) {
      // A different title/source can be selected before its new video URL is
      // installed. Never leave the outgoing muted preroll poisoning that next
      // source. Do not change a successor's pendingSeek or playback intent.
      if (progressiveSeekController === controller && video.dataset.progressive === "1") {
        controller.close(); loader.close();
        progressiveSeekController = null; progressiveMseLoader = null;
        delete video.dataset.progressive;
        if (progressiveSeekOriginalMute !== null) {
          video.muted = progressiveSeekOriginalMute;
          progressiveSeekOriginalMute = null;
        }
      }
      return;
    }
    if (!result?.ok) {
      controller.close(); loader.close();
      progressiveSeekController = null; progressiveMseLoader = null;
      video.muted = oldMute;
      progressiveSeekOriginalMute = null;
      if (!readyIndexedVideo() || !openIndexedSeekAt(target, { wasPlaying: pending.wasPlaying }))
        void openTranscodeAt(target, { wasPlaying: pending.wasPlaying, forceNative: true });
      return;
    }
    state.pendingSeek = null;
    state.currentMs = target * 1000;
    video.muted = oldMute;
    progressiveSeekOriginalMute = null;
    sourceFrameGate = null;
    video.style.visibility = "";
    frame.classList.remove("source-transition");
    clearTranscodeSeekFrame();
    subtitlePresentedFrame = { src: video.src, base: 0, seconds: result.absoluteSeconds };
    hideLoadingForBufferedSeek();
    renderSubtitles();
    schedulePresentedSubtitleFrame();
    updateCompatControls();
    if (!pending.wasPlaying) video.pause();
    else if (video.paused) void video.play().catch(() => void recoverPlayback("error"));
    if (pending.wasPlaying) continueProgressiveOrRecover({ force: true });
  }).catch(() => {
    if (!current()) {
      if (progressiveSeekController === controller && video.dataset.progressive === "1") {
        controller.close(); loader.close();
        progressiveSeekController = null; progressiveMseLoader = null;
        delete video.dataset.progressive;
        if (progressiveSeekOriginalMute !== null) {
          video.muted = progressiveSeekOriginalMute;
          progressiveSeekOriginalMute = null;
        }
      }
      return;
    }
    video.muted = oldMute;
    progressiveSeekOriginalMute = null;
    controller.close(); loader.close();
    progressiveSeekController = null; progressiveMseLoader = null;
    if (!readyIndexedVideo() || !openIndexedSeekAt(target, { wasPlaying: pending.wasPlaying }))
      void openTranscodeAt(target, { wasPlaying: pending.wasPlaying, forceNative: true });
  });
  // The controller primes the freshly attached MSE source while muted and
  // restores the user's original play/pause intent after real frame proof.
  loadMoreEmbeddedSubtitles({ seeked: true });
  return true;
}
let remuxMseWarmSeek = null;

function cancelRemuxMseWarmSeek() {
  const warm = remuxMseWarmSeek;
  remuxMseWarmSeek = null;
  if (!warm) return;
  if (warm.frameId !== null && typeof video.cancelVideoFrameCallback === "function")
    video.cancelVideoFrameCallback(warm.frameId);
  window.clearTimeout(warm.timer);
  frame.classList.remove("is-sync-preroll");
  if (warm.overlay) {
    if (warm.previousOverlayAriaHidden === null) warm.overlay.removeAttribute("aria-hidden");
    else warm.overlay.setAttribute("aria-hidden", warm.previousOverlayAriaHidden);
  }
  if (warm.pending === state.pendingSeek) state.pendingSeek = null;
  if (warm.src === video.src) video.muted = warm.wantedMuted;
}

function closeRemuxMseSession() {
  cancelRemuxMseWarmSeek();
  const previous = remuxMseSession;
  remuxMseSession = null;
  previous?.close();
}

export function fallbackActiveRemuxMseToNative({ wasPlaying = !video.paused } = {}) {
  const mse = remuxMseSession;
  // This is an error from the CURRENT MSE media element, not a cached seek
  // miss, an old source, or a user-directed pause. Never reopen unrelated media.
  if (!mse || video.dataset.mode !== "transcode" || video.src !== mse.objectUrl
    || !state.transcodeContext?.baseUrl || state.currentSource?.kind !== "torrent") return false;
  const position = absolutePlaybackSeconds();
  void openTranscodeAt(position, { wasPlaying, forceNative: true });
  return true;
}

// An idle session can expire while the browser/tab is suspended, even though
// the old decoded frame is still displayed. Retrying its stale session ID
// cannot repair that source. Resolve the SAME saved magnet/file only when the
// backend specifically reports session expiry; no arbitrary 404 retries.
function isExpiredTorrentPlaybackSession(error) {
  return [404, 410].includes(Number(error?.httpStatus ?? error?.status))
    && /(?:torrent session not found or expired|source session has expired)/i.test(String(error?.message || ""));
}

function reconnectExpiredTorrentPlayback(error, { source, target, isCurrent, wasPlaying, onPreflightFailure } = {}) {
  if (!isExpiredTorrentPlaybackSession(error) || !isCurrent?.()
    || !wasPlaying || onPreflightFailure
    || source?.kind !== "torrent" || !Number.isInteger(Number(source.fileIndex))
    || !libraryEntryById(source.libraryId)?.magnet) return false;
  cancelTranscodeStart();
  recoveryPlaybackRequested = true;
  setPlayerLoading(18, "Reconnecting playback");
  // playLibraryEpisode always starts a NEW load generation and obtains a
  // current session from the saved magnet. Its own bounded error UI handles
  // genuine lack of peers without looping through the expired ID again.
  void playLibraryEpisode(source.libraryId, Number(source.fileIndex), { resumeAtSeconds: target });
  return true;
}

function seekInsideRemuxMse(target) {
  const session = remuxMseSession;
  const base = state.transcodeBaseOffsetSeconds;
  const local = target - base;
  // A second drag or seek button may supersede a still-awaiting presented
  // frame from THIS exact MSE source. It is safe to cancel that old frame
  // callback and retarget the same SourceBuffer. A real decoder replacement
  // or unrelated priming attempt must still take the normal restart path.
  const currentWarm = remuxMseWarmSeek;
  const supersedingOwnWarm = currentWarm && currentWarm.session === session
    && currentWarm.src === video.src && state.pendingSeek === currentWarm.pending
    && currentWarm.pending?.priming;
  if (!session || video.dataset.mode !== "transcode" || !session.contains(local)
    || (state.pendingSeek?.priming && !supersedingOwnWarm) || !Number.isFinite(local)) return false;
  const wasPlaying = supersedingOwnWarm ? currentWarm.pending.wasPlaying : playerIsPlaying();
  cancelRemuxMseWarmSeek();
  invalidateSubtitleFrameClock();
  const source = state.currentSource;
  const context = state.transcodeContext;
  const loadId = playbackLoadRequestId;
  const src = video.src;
  const pending = { target, wasPlaying, priming: true, streamInstalled: true };
  const overlay = $("#subtitle-overlay");
  const warm = { session, pending, src, frameId: null, timer: 0,
    wantedMuted: playerWantsMuted(), overlay,
    previousOverlayAriaHidden: overlay?.getAttribute("aria-hidden") ?? null };
  remuxMseWarmSeek = warm;
  state.pendingSeek = pending;
  state.currentMs = target * 1000;
  frame.classList.add("is-sync-preroll");
  overlay?.setAttribute("aria-hidden", "true");
  video.muted = true;
  const current = () => remuxMseWarmSeek === warm && remuxMseSession === session
    && state.pendingSeek === pending && state.currentSource === source
    && state.transcodeContext === context && playbackLoadRequestId === loadId
    && video.src === src;
  const finish = mediaTime => {
    if (!current() || video.seeking || !Number.isFinite(mediaTime)
      || mediaTime + 0.12 < local) return false;
    subtitlePresentedFrame = { src, base, seconds: base + mediaTime };
    cancelRemuxMseWarmSeek();
    state.currentMs = (base + mediaTime) * 1000;
    renderSubtitles();
    if (!pending.wasPlaying) video.pause();
    finishPlayerLoading();
    updateCompatControls();
    schedulePresentedSubtitleFrame();
    if (audioSync.key) scheduleAudioSync(400);
    return true;
  };
  const nextFrame = () => {
    if (!current()) return;
    warm.frameId = video.requestVideoFrameCallback((_now, metadata) => {
      warm.frameId = null;
      if (!current()) return;
      if (!finish(Number(metadata?.mediaTime))) nextFrame();
    });
  };
  // This exact position is already in the MSE SourceBuffer. Frame-gate the
  // subtitles/audio, but never show the logo for a genuine warm seek.
  hideLoadingForBufferedSeek();
  renderSubtitles();
  updateCompatControls();
  nextFrame();
  try { video.currentTime = local; }
  catch { cancelRemuxMseWarmSeek(); return false; }
  warm.timer = window.setTimeout(() => {
    if (!current()) return;
    cancelRemuxMseWarmSeek();
    scheduleTranscodeSeek(target, { forceNative: true });
  }, 10_000);
  if (pending.wasPlaying) void video.play().catch(() => {
    if (!current()) return;
    cancelRemuxMseWarmSeek();
    scheduleTranscodeSeek(target, { forceNative: true });
  });
  return true;
}

export function cancelTranscodeStart({ preservePending = false } = {}) {
  transcodeStartSerial += 1;
  const attempt = transcodeStartAttempt;
  transcodeStartAttempt = null;
  if (!attempt) return;
  attempt.controller.abort("new playback request");
  if (attempt.frameId !== null && typeof video.cancelVideoFrameCallback === "function")
    video.cancelVideoFrameCallback(attempt.frameId);
  if (attempt.watchdog) window.clearTimeout(attempt.watchdog);
  if (attempt.retryTimer) window.clearTimeout(attempt.retryTimer);
  if (attempt.timeupdate) video.removeEventListener("timeupdate", attempt.timeupdate);
  if (attempt.loadeddata) video.removeEventListener("loadeddata", attempt.loadeddata);
  frame.classList.remove("is-sync-preroll");
  if (attempt.overlay) {
    if (attempt.previousOverlayAriaHidden === null) attempt.overlay.removeAttribute("aria-hidden");
    else attempt.overlay.setAttribute("aria-hidden", attempt.previousOverlayAriaHidden);
  }
  if (attempt.mutedForPreroll) video.muted = attempt.wantedMuted;
  if (!preservePending && state.pendingSeek === attempt.pending) state.pendingSeek = null;
}

export function setPlayerMutePreference(muted) {
  if (transcodeStartAttempt?.mutedForPreroll) {
    transcodeStartAttempt.wantedMuted = Boolean(muted);
    video.muted = true;
  } else if (remuxMseWarmSeek) {
    remuxMseWarmSeek.wantedMuted = Boolean(muted);
    video.muted = true;
  } else video.muted = Boolean(muted);
}

// Caption time follows the frame actually presented, not an HTMLMediaElement
// clock that may run ahead of its decoder after a long pause or copied seek.
let subtitlePresentedFrame = null;
let subtitleFrameRequestId = null;
let subtitleFrameGeneration = 0;
let subtitleLastPaintMs = -Infinity;
function invalidateSubtitleFrameClock() {
  subtitleFrameGeneration += 1;
  subtitlePresentedFrame = null;
  subtitleLastPaintMs = -Infinity;
  if (subtitleFrameRequestId !== null && typeof video.cancelVideoFrameCallback === "function")
    video.cancelVideoFrameCallback(subtitleFrameRequestId);
  subtitleFrameRequestId = null;
}
export function presentedSubtitleSeconds() {
  const presented = subtitlePresentedFrame;
  if (!presented || state.pendingSeek || video.seeking || presented.src !== video.src
    || presented.base !== (video.dataset.mode === "transcode" ? state.transcodeBaseOffsetSeconds : 0)) return null;
  return presented.seconds;
}
function visibleSubtitleClockSeconds() {
  const playing = absolutePlaybackSeconds();
  const presented = presentedSubtitleSeconds();
  // Chromium may suppress frame callbacks across pause/resume, tab backgrounding
  // or audio-track replacement even as playback/timeupdate advances. Never keep
  // an old cue clock indefinitely when it has diverged from audible playback.
  return presented !== null && Math.abs(presented - playing) <= 1.25 ? presented : playing;
}
export function refreshSubtitleClockForInteraction() {
  state.currentMs = visibleSubtitleClockSeconds() * 1000;
  subtitleRenderMemo.key = "";
}
function schedulePresentedSubtitleFrame() {
  if (subtitleFrameRequestId !== null || state.pendingSeek?.priming || typeof video.requestVideoFrameCallback !== "function") return;
  const generation = subtitleFrameGeneration;
  const src = video.src;
  const base = video.dataset.mode === "transcode" ? state.transcodeBaseOffsetSeconds : 0;
  const id = video.requestVideoFrameCallback((_now, metadata) => {
    if (subtitleFrameRequestId !== id) return;
    subtitleFrameRequestId = null;
    if (generation !== subtitleFrameGeneration || src !== video.src || state.pendingSeek?.priming) return;
    const mediaTime = Number(metadata?.mediaTime);
    if (Number.isFinite(mediaTime) && mediaTime >= 0) {
      const seconds = base + mediaTime;
      subtitlePresentedFrame = { src, base, seconds };
      if (!state.pendingSeek && Math.abs(seconds * 1000 - subtitleLastPaintMs) >= 80) {
        subtitleLastPaintMs = seconds * 1000;
        state.currentMs = seconds * 1000;
        renderSubtitles();
      }
    }
    schedulePresentedSubtitleFrame();
  });
  subtitleFrameRequestId = id;
}

export function playerWantsMuted() {
  return transcodeStartAttempt?.mutedForPreroll ? transcodeStartAttempt.wantedMuted
    : remuxMseWarmSeek ? remuxMseWarmSeek.wantedMuted : video.muted;
}

export async function openTranscodeAt(seconds, { wasPlaying = !video.paused, initialize = null, seekRetry = 0,
  onPreflightFailure = null, forceNative = false, verifySession = false } = {}) {
  const context = state.transcodeContext;
  if (!context?.baseUrl) return false;
  if (typeof cancelIndexedSeekAttempt === "function") cancelIndexedSeekAttempt();
  delete video.dataset.indexed;
  if (video.dataset.progressive === "1") {
    progressiveContinueController?.abort();
    progressiveBoundaryAttempt = null;
    progressiveSeekController?.cancel();
    progressiveMseLoader?.close?.();
    progressiveSeekController = null;
    progressiveMseLoader = null;
    if (progressiveSeekOriginalMute !== null) {
      video.muted = progressiveSeekOriginalMute;
      progressiveSeekOriginalMute = null;
    }
    delete video.dataset.progressive;
  }
  if (!initialize && typeof preserveCurrentFrameForTranscodeSeek === "function")
    preserveCurrentFrameForTranscodeSeek();
  if (typeof clearWaitingTorrentSeek === "function") clearWaitingTorrentSeek();
  closeRemuxMseSession();
  cancelTranscodeStart();
  transcodePauseSnapshot = null;
  const serial = transcodeStartSerial;
  const source = state.currentSource;
  const loadId = playbackLoadRequestId;
  const durationSeconds = state.mediaDurationMs > 0 ? state.mediaDurationMs / 1000 : 0;
  const target = Math.max(0, durationSeconds ? Math.min(Number(seconds) || 0, Math.max(0, durationSeconds - 0.25)) : Number(seconds) || 0);
  const audioIndex = Number.isInteger(context.audioIndex) ? context.audioIndex : state.selectedAudioTrack || 0;
  const query = transcodeQuery(target, audioIndex);
  // A known HEVC Main10 SDR -> H264 stream can use a bounded MSE SourceBuffer
  // to make frames already transcoded in THIS session genuinely seekable.
  // Existing copy/HDR/other codec paths remain unchanged. Failed MSE startup
  // always falls back one-way to the original native FFmpeg pipeline.
  if (!context.copyVideo && String(state.currentMediaProbe?.video?.codec || '').toLowerCase() === 'hevc'
    && !state.currentMediaProbe?.compatibility?.video?.hdr
    && !state.currentMediaProbe?.compatibility?.video?.hdrKind
    && !state.currentMediaProbe?.video?.dolbyVision && !state.currentMediaProbe?.video?.hdrKind
    && !['smpte2084','arib-std-b67'].includes(String(state.currentMediaProbe?.video?.colorTransfer || '').toLowerCase()))
    query.set('video', 'h264');
  const copySeek = target > 0 && query.get("video") === "copy";
  const controller = new AbortController();
  const pending = { target, wasPlaying: Boolean(wasPlaying), timer: 0, priming: true,
    streamInstalled: false };
  const attempt = { serial, controller, pending, frameId: null, watchdog: 0,
    seekRetry, retryTimer: 0, retryScheduled: false,
    timeupdate: null, mutedForPreroll: false, wantedMuted: video.muted,
    overlay: null, previousOverlayAriaHidden: null };
  transcodeStartAttempt = attempt;
  state.pendingSeek = pending;
  if (!video.paused) video.pause();
  state.currentMs = target * 1000;
  setPlayerLoading(18, "Seeking", formatTime(state.currentMs));
  renderSubtitles();
  updateCompatControls();
  const current = () => transcodeStartAttempt === attempt && transcodeStartSerial === serial
    && !controller.signal.aborted && playbackLoadRequestId === loadId
    && state.transcodeContext === context && state.currentSource === source;
  // A seek may briefly overlap the old FFmpeg window or an in-flight seek
  // probe. Retrying a *current* window here is safer than surfacing a terminal
  // error that vanishes after one manual Retry. Keep the branded loader and
  // requested playback intent, but never loop or revive an obsolete seek.
  const retryTransient = (reason, { onlyWhenBusy = false } = {}) => {
    if (!current()) return false;
    // The audio menu must not treat a merely scheduled retry as an installed
    // dub, or persist that choice before the preflight has succeeded. For
    // audio switching, fail back to the old playable stream instead.
    if (onPreflightFailure) return false;
    if (attempt.retryScheduled) return true;
    if (attempt.seekRetry >= 2) return false;
    if (onlyWhenBusy && reason?.httpStatus !== 429
      && !/\b(?:429|busy|too many)\b/i.test(String(reason?.message || ""))) return false;
    attempt.retryScheduled = true;
    setPlayerLoading(20, "Preparing video", formatTime(target * 1000));
    const delay = attempt.seekRetry ? 1400 : 700;
    attempt.retryTimer = window.setTimeout(() => {
      if (!current()) return;
      void openTranscodeAt(target, {
        wasPlaying: pending.wasPlaying, initialize, seekRetry: attempt.seekRetry + 1,
        forceNative,
      });
    }, delay);
    return true;
  };
  attempt.retryTransient = retryTransient;
  if (verifySession && context.sessionId) {
    try {
      await fetchJson(`/api/torrents/${encodeURIComponent(context.sessionId)}`,
        { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8_000)]) });
    } catch (error) {
      if (!current()) return false;
      if (reconnectExpiredTorrentPlayback(error, { source, target, isCurrent: current,
        wasPlaying: pending.wasPlaying, onPreflightFailure })) return true;
      // A temporary connectivity failure must not become a speculative
      // source switch; allow the existing stream fallback to make progress.
      if (isExpiredTorrentPlaybackSession(error)) {
        cancelTranscodeStart();
        setPlayerLoading(100, "Source expired", "Choose another source or retry this episode.", { error: true });
        return false;
      }
    }
  }
  let effectiveStart = target;
  if (copySeek) {
    try {
      const url = `/api/torrents/${encodeURIComponent(context.sessionId)}/files/${context.fileIndex}/transcode-start?start=${target.toFixed(3)}&video=copy`;
      const result = await fetchJson(url, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]) });
      if (!current()) return false;
      effectiveStart = Number(result?.effectiveStartSeconds);
      if (result?.verified !== true || !Number.isFinite(effectiveStart)
        || effectiveStart < 0 || effectiveStart > target + 0.001
        || Math.abs(Number(result.requestedStartSeconds) - target) > 0.003)
        throw new Error("Could not verify the copied video start timestamp");
    } catch (error) {
      if (!current()) return false;
      if (reconnectExpiredTorrentPlayback(error, { source, target, isCurrent: current,
        wasPlaying: pending.wasPlaying, onPreflightFailure })) return true;
      if (retryTransient(error, { onlyWhenBusy: true })) return true;
      const slowSeek = !serverCanConvertVideo()
        && (Number(error?.httpStatus) === 504 || error?.name === "TimeoutError");
      if (!onPreflightFailure && typeof waitForMissingTorrentSeek === "function"
        && ([502, 503, 504].includes(Number(error?.httpStatus)) || slowSeek)
        && waitForMissingTorrentSeek(target, pending.wasPlaying, { slowSeek })) return true;
      // Audio switching may still be able to play the prior URL. Report the
      // latest user intent BEFORE cancelling the seek's pending state.
      onPreflightFailure?.({ wasPlaying: pending.wasPlaying });
      cancelTranscodeStart();
      video.pause();
      setPlayerLoading(100, "Video synchronization unavailable",
        error?.message || "Could not verify this video seek", { error: true });
      return false;
    }
  }
  if (!current()) return false;
  invalidateSubtitleFrameClock();
  state.transcodeBaseOffsetSeconds = effectiveStart;
  let src = `${context.baseUrl}?${query}`;
  let mse = null;
  const mseAvailable = !forceNative && typeof remuxMseCacheAllowed !== "undefined" && remuxMseCacheAllowed;
  const copiedMse = mseAvailable && query.get("video") === "copy"
    && canUseRemuxMse({ video, media: state.currentMediaProbe, context });
  const encodedMse = mseAvailable && canUseEncodedH264Mse({ video, media: state.currentMediaProbe, context, query });
  if (copiedMse || encodedMse) {
    mse = createRemuxMseSession({
      // Opt-in hint for a bounded same-producer FFmpeg run-ahead buffer.
      // It never changes the exact conversion plan or the warm cache identity.
      // The backend independently verifies every piece is already downloaded.
      video, url: `${src}&mse=1`,
      windowUrl: copiedMse
        ? `/api/torrents/${encodeURIComponent(context.sessionId)}/files/${context.fileIndex}/remux-cache/window`
        : null,
      allowEncodedH264: encodedMse,
      isCurrent: () => remuxMseSession === mse && state.currentSource === source
        && state.transcodeContext === context && playbackLoadRequestId === loadId
        && video.src === mse?.objectUrl,
      onFailure: () => {
        if (remuxMseSession !== mse || state.currentSource !== source
          || state.transcodeContext !== context || playbackLoadRequestId !== loadId) return;
        const fallbackAt = state.pendingSeek ? target : absolutePlaybackSeconds();
        const fallbackPlaying = playerIsPlaying();
        void openTranscodeAt(fallbackAt, {
          wasPlaying: fallbackPlaying, initialize, forceNative: true,
        });
      },
    });
    if (mse) {
      remuxMseSession = mse;
      src = mse.objectUrl;
    }
  }
  // A decoder/source-buffer failure is not an FFmpeg busy retry. One-way
  // fallback to the existing native stream, never repeat a broken MSE startup
  // twice before showing an unrecoverable synchronization error.
  attempt.fallbackToNative = () => {
    if (!mse || remuxMseSession !== mse || !current()) return false;
    void openTranscodeAt(target, {
      wasPlaying: pending.wasPlaying, initialize, forceNative: true,
    });
    return true;
  };
  if (initialize) {
    // setMediaSource clears any earlier pending seek; restore this attempt's
    // marker before its media events can release the branded loading overlay.
    setMediaSource({ ...initialize, src, objectUrl: mse?.objectUrl || null,
      mode: "transcode", startAtSeconds: target },
      { preserveTranscodeStart: true });
    state.pendingSeek = pending;
  } else {
    if (video.dataset.objectUrl) {
      URL.revokeObjectURL(video.dataset.objectUrl);
      delete video.dataset.objectUrl;
    }
    video.src = src;
    if (typeof expectNewVideoFrame === "function") expectNewVideoFrame();
    if (mse) video.dataset.objectUrl = mse.objectUrl;
    video.load();
  }
  // Keyframe preflight runs while the previous fragment is still attached to
  // the video element. Its late ended/error events cannot describe the new
  // media window before this assignment completes.
  pending.streamInstalled = true;
  if (!current()) return false;
  state.transcodeRequestedStartSeconds = target;
  video.dataset.mode = "transcode";
  const prerollSeconds = Math.max(0, target - effectiveStart);
  const complete = (presentedMediaTime = null) => {
    if (!current()) return;
    const keepPlaying = pending.wasPlaying;
    if (presentedMediaTime !== null && Number.isFinite(presentedMediaTime)) {
      subtitlePresentedFrame = { src: video.src, base: effectiveStart, seconds: effectiveStart + presentedMediaTime };
    }
    cancelTranscodeStart();
    clearTranscodeSeekFrame();
    state.currentMs = (presentedSubtitleSeconds() ?? absolutePlaybackSeconds()) * 1000;
    renderSubtitles();
    updateCompatControls();
    if (!keepPlaying) video.pause();
    finishPlayerLoading();
    schedulePresentedSubtitleFrame();
    if (audioSync.key) scheduleAudioSync(400);
  };
  // Autoplay policy denial isn't corrupt video. Keep the verified media window
  // and ask for a *synchronous* user gesture, instead of spawning 3 fresh
  // FFmpeg streams (and eventually misreporting video synchronization).
  const deferBlockedPlay = (error, { afterUserClick = false } = {}) => {
    if (error?.name !== "NotAllowedError" || !current()) return false;
    if (attempt.watchdog) window.clearTimeout(attempt.watchdog);
    attempt.watchdog = 0;
    // Chromium/Brave may reject sound autoplay when the initial Library click
    // has already been consumed by asynchronous torrent/FFprobe work. Muted
    // playback is permitted: first keep the SAME stream and start silently,
    // rather than forcing a second Play click or relaunching FFmpeg. Never
    // silently undo a user's intentional mute preference.
    if (!afterUserClick && pending.wasPlaying && !video.muted && !attempt.mutedAutoplayTried) {
      attempt.mutedAutoplayTried = true;
      video.muted = true;
      updateCompatControls();
      setPlayerLoading(18, "Starting muted playback");
      Promise.resolve(video.play()).then(() => {
        if (!current()) return;
        if (prerollSeconds <= 0.025) complete();
        else attempt.armWatchdog?.();
        toast("Your browser blocked automatic sound. Video is playing muted; use the speaker control to enable audio.", { timeout: 5500 });
      }).catch((mutedError) => {
        if (!current()) return;
        if (deferBlockedPlay(mutedError)) return;
        if (attempt.fallbackToNative?.() || retryTransient(mutedError)) return;
        cancelTranscodeStart();
        video.pause();
        setPlayerLoading(100, "Video synchronization unavailable",
          mutedError?.message || "Could not begin playback", { error: true });
      });
      return true;
    }
    attempt.awaitingUserGesture = true;
    attempt.resumeAfterGesture = () => {
      if (!current() || !attempt.awaitingUserGesture) return false;
      attempt.awaitingUserGesture = false;
      setPlayerLoading(18, "Starting playback");
      // video.play() must run inside the Retry/Play button's click call stack;
      // a fresh asynchronous Library torrent resolution loses user activation.
      const playing = video.play();
      Promise.resolve(playing).then(() => {
        if (!current()) return;
        if (prerollSeconds <= 0.025) complete();
        else attempt.armWatchdog?.();
      }).catch((nextError) => {
        if (!current() || deferBlockedPlay(nextError, { afterUserClick: true })) return;
        if (attempt.fallbackToNative?.() || retryTransient(nextError)) return;
        cancelTranscodeStart();
        video.pause();
        setPlayerLoading(100, "Video synchronization unavailable",
          nextError?.message || "Could not begin playback", { error: true });
      });
      return true;
    };
    const mediaErrorCode = Number(video.error?.code) || 0;
    setPlayerLoading(100, afterUserClick ? "Playback could not start" : "Playback needs a click",
      afterUserClick
        ? `Play was rejected again${mediaErrorCode ? ` (media error ${mediaErrorCode})` : ""}. The video may be unavailable, or the browser may be blocking playback. Try another source if it persists.`
        : "Your browser blocked automatic playback. Select Play to continue.", { error: true });
    return true;
  };
  if (prerollSeconds <= 0.025) {
    // An exact-keyframe start has no hidden GOP to consume, but the new
    // fragment can still be rejected (notably when a previous FFmpeg job
    // has not relinquished its slot). Do not declare it loaded while play()
    // is still pending or silently swallow that rejection.
    attempt.armWatchdog = () => { attempt.watchdog = window.setTimeout(() => {
      if (!current() || attempt.retryScheduled) return;
      if (attempt.fallbackToNative()) return;
      if (retryTransient(new Error("Video is still preparing"))) return;
      cancelTranscodeStart();
      video.pause();
      setPlayerLoading(100, "Video synchronization unavailable",
        "The new video stream did not become ready.", { error: true });
    }, 45_000); };
    if (!pending.wasPlaying) {
      // Setting src and calling load() does not establish that the requested
      // frame has decoded. A paused seek can otherwise clear its priming
      // error handler before media bytes arrive, then report opaque error 4
      // when Play is pressed later. Wait for this source's actual loadeddata.
      const assignedSrc = video.src;
      attempt.loadeddata = () => {
        if (!current() || video.currentSrc !== assignedSrc || video.readyState < 2) return;
        if (!pending.wasPlaying) {
          complete();
          return;
        }
        // The user may press Play while that paused seek was still loading.
        // Honor that newer intent without losing source/error ownership.
        void Promise.resolve().then(() => video.play()).then(() => {
          if (current()) complete();
        }).catch((error) => {
          if (!current() || deferBlockedPlay(error)) return;
          if (attempt.fallbackToNative?.() || retryTransient(error)) return;
          cancelTranscodeStart();
          video.pause();
          setPlayerLoading(100, "Video synchronization unavailable",
            error?.message || "Could not begin playback", { error: true });
        });
      };
      video.addEventListener("loadeddata", attempt.loadeddata);
      attempt.armWatchdog();
      if (video.readyState >= 2 && video.currentSrc === assignedSrc) attempt.loadeddata();
      return true;
    }
    attempt.armWatchdog();
    try {
      await video.play();
    } catch (error) {
      if (!current()) return false;
      if (deferBlockedPlay(error)) return true;
      if (attempt.fallbackToNative()) return true;
      if (retryTransient(error)) return true;
      cancelTranscodeStart();
      video.pause();
      setPlayerLoading(100, "Video synchronization unavailable",
        error?.message || "Could not begin playback", { error: true });
      return false;
    }
    if (!current()) return false;
    if (attempt.retryScheduled) return true;
    complete();
    return true;
  }
  attempt.mutedForPreroll = true;
  attempt.wantedMuted = video.muted;
  frame.classList.add("is-sync-preroll");
  attempt.overlay = $("#subtitle-overlay");
  if (attempt.overlay) {
    attempt.previousOverlayAriaHidden = attempt.overlay.getAttribute("aria-hidden");
    attempt.overlay.setAttribute("aria-hidden", "true");
  }
  video.muted = true;
  const ready = (mediaTime) => {
    if (!current() || !Number.isFinite(mediaTime)) return;
    if (effectiveStart + mediaTime + 0.012 >= target) complete(mediaTime);
  };
  if (typeof video.requestVideoFrameCallback === "function") {
    const nextFrame = () => {
      if (!current()) return;
      attempt.frameId = video.requestVideoFrameCallback((_at, metadata) => {
        attempt.frameId = null;
        if (!current()) return;
        ready(Number(metadata?.mediaTime));
        nextFrame();
      });
    };
    nextFrame();
  } else {
    attempt.timeupdate = () => ready(Number(video.currentTime));
    video.addEventListener("timeupdate", attempt.timeupdate);
  }
  // A missing torrent keyframe must never leave a silent hidden player stuck
  // indefinitely or release its preroll into visible/audible playback.
  attempt.armWatchdog = () => { attempt.watchdog = window.setTimeout(() => {
    if (!current()) return;
    if (attempt.fallbackToNative()) return;
    if (retryTransient(new Error("Video is still preparing"))) return;
    cancelTranscodeStart();
    video.pause();
    setPlayerLoading(100, "Video synchronization unavailable",
      "Couldn't reach the requested frame. Retry the seek when more video is available.", { error: true });
  }, 45_000); };
  attempt.armWatchdog();
  void video.play().catch((error) => {
    if (!current()) return;
    if (deferBlockedPlay(error)) return;
    if (attempt.fallbackToNative()) return;
    if (retryTransient(error)) return;
    cancelTranscodeStart();
    setPlayerLoading(100, "Video synchronization unavailable",
      error?.message || "Could not begin synchronized playback", { error: true });
  });
  return true;
}

export async function restartTranscodeAt(seconds, { wasPlaying = !video.paused,
  forceNative = false, verifySession = false } = {}) {
  return openTranscodeAt(seconds, { wasPlaying, forceNative, verifySession });
}

// A converted stream is re-opened at the new time. Seeks that arrive close together (holding the
// ±10 s button, dragging) are merged into one restart, so the player doesn't bounce between them.
function bufferedRemuxSeekTarget(target) {
  // Only shorten the input debounce for a *ready, currently decoded* copy-video
  // fragment. Its TimeRanges are local to the verified copy keyframe origin,
  // not absolute movie seconds. We still reopen FFmpeg and reverify the
  // destination keyframe; fMP4 does not support dependable native seeks.
  if (video.dataset.mode !== "transcode" || !state.transcodeContext?.copyVideo
    || state.transcodeContext.forceH264 || video.readyState < 3
    || video.seeking || state.scrubbing || state.pendingSeek) return false;
  const local = Number(target) - Number(state.transcodeBaseOffsetSeconds);
  if (!Number.isFinite(local) || local < 0) return false;
  const ranges = video.buffered;
  if (!ranges?.length) return false;
  try {
    for (let i = 0; i < ranges.length; i += 1) {
      // Do not treat edge-of-buffer / almost-expired fragments as warm.
      if (local >= ranges.start(i) + 0.1 && local <= ranges.end(i) - 0.25) return true;
    }
  } catch {}
  return false;
}

function scheduleTranscodeSeek(target, { forceNative = false } = {}) {
  if (typeof clearWaitingTorrentSeek === "function") clearWaitingTorrentSeek();
  if (typeof invalidateStreamStatus === "function") invalidateStreamStatus();
  const warmCopySeek = bufferedRemuxSeekTarget(target);
  const wasPlaying = state.pendingSeek ? state.pendingSeek.wasPlaying : !video.paused;
  const source = state.currentSource;
  const context = state.transcodeContext;
  const mse = remuxMseSession;
  mse?.cancelRestore();
  const mayRestoreMseWindow = !forceNative && mse
    && target >= state.transcodeBaseOffsetSeconds;
  // Capture before pause/debounce: waiting until the cold source replacement
  // can lose the old frame (readyState, expired producer, or GPU backing).
  // Warm MSE restores have their own decoder and should never show a freeze.
  if (!mayRestoreMseWindow && typeof preserveCurrentFrameForTranscodeSeek === "function")
    preserveCurrentFrameForTranscodeSeek();
  const audioIndex = context?.audioIndex;
  const loadId = playbackLoadRequestId;
  cancelTranscodeStart();
  window.clearTimeout(state.pendingSeek?.timer);
  // Set before pausing, so the old stream's pause event knows a seek is waiting.
  state.pendingSeek = { target, wasPlaying, timer: 0 };
  const queued = state.pendingSeek;
  if (!video.paused) video.pause();
  state.currentMs = target * 1000;
  if (mayRestoreMseWindow) hideLoadingForBufferedSeek();
  else setPlayerLoading(18, "Seeking", formatTime(target * 1000));
  renderSubtitles();
  updateCompatControls();
  queued.timer = window.setTimeout(async () => {
    if (state.pendingSeek !== queued) return;
    // A newer Watch source, audio selection or navigation can supersede this
    // timer without a second seek event. Never restart their newer stream.
    if (state.currentSource !== source || state.transcodeContext !== context
      || context?.audioIndex !== audioIndex || playbackLoadRequestId !== loadId) {
      if (state.pendingSeek === queued) state.pendingSeek = null;
      return;
    }
    if (mayRestoreMseWindow && remuxMseSession === mse) {
      let restored = false;
      try { restored = await mse.restoreWindow(queued.target, state.transcodeBaseOffsetSeconds); }
      catch { restored = false; }
      if (state.pendingSeek !== queued || state.currentSource !== source
        || state.transcodeContext !== context || playbackLoadRequestId !== loadId) return;
      if (restored && seekInsideRemuxMse(queued.target)) return;
    }
    if (state.pendingSeek !== queued) return;
    state.pendingSeek = null;
    if (mayRestoreMseWindow) setPlayerLoading(18, "Seeking", formatTime(queued.target * 1000));
    if (forceNative) void openTranscodeAt(queued.target, {
      wasPlaying: queued.wasPlaying, forceNative: true,
    });
    else void restartTranscodeAt(queued.target, { wasPlaying: queued.wasPlaying });
  }, warmCopySeek ? 180 : 280);
}

// While a seek is waiting, the player counts as playing if it will play once the seek lands.
export function playerIsPlaying() {
  return state.pendingSeek ? Boolean(state.pendingSeek.wasPlaying) : !video.paused;
}

// FFmpeg's fragmented MP4 stream is a long-lived live encoder, not a stable
// seekable MP4 file. After a long pause the browser can retain stale audio and
// video decode queues even when its reported currentTime still looks correct.
// Recreate ONLY transcoded playback at the exact paused movie timestamp; keep
// directly buffered/local files untouched and preserve the selected audio track.
let transcodePauseSnapshot = null;
function noteTranscodePause() {
  transcodePauseSnapshot = video.dataset.mode === "transcode"
    && video.dataset.indexed !== "1"
    && !state.pendingSeek && state.transcodeContext?.baseUrl
    ? { at: Date.now(), src: video.src, position: absolutePlaybackSeconds(),
      source: state.currentSource, context: state.transcodeContext,
      generation: playbackLoadRequestId,
      progressive: video.dataset.progressive === "1" } : null;
}
function nativeTranscodeHasBufferedContinuation() {
  // Native fragmented MP4 can still have several decoded/buffered seconds
  // available after a long pause. A 30-second wall clock timeout alone is NOT
  // evidence that these frames expired or that the decoder needs replacing.
  // MSE producers are managed separately because a stale SourceBuffer can
  // report buffered TimeRanges even after its producer has ended.
  if ((typeof remuxMseSession !== "undefined" && remuxMseSession)
    || video.dataset.mode !== "transcode" || video.seeking
    || video.error || video.readyState < 3 || !Number.isFinite(video.currentTime)) return false;
  const buffered = video.buffered;
  if (!buffered?.length) return false;
  try {
    for (let i = 0; i < buffered.length; i += 1) {
      if (video.currentTime >= buffered.start(i) - 0.05
        && video.currentTime + 0.75 < buffered.end(i)) return true;
    }
  } catch {}
  return false;
}
function resyncTranscodeAfterLongPause() {
  if (video.dataset.indexed === "1") return false;
  const snapshot = transcodePauseSnapshot;
  if (!snapshot) return false;
  transcodePauseSnapshot = null;
  if (Date.now() - snapshot.at < 30_000 || video.dataset.mode !== "transcode"
    || state.pendingSeek || video.src !== snapshot.src || !state.transcodeContext?.baseUrl) return false;
  if (snapshot.source !== state.currentSource
    || snapshot.context !== state.transcodeContext
    || snapshot.generation !== playbackLoadRequestId) return false;
  const position = absolutePlaybackSeconds();
  // Never rewind to an earlier position if the user sought while paused.
  if (!Number.isFinite(position) || Math.abs(position - snapshot.position) > 0.5) return false;
  if (snapshot.progressive && video.dataset.progressive === "1") {
    // A standalone GOP is finite. After a long pause its SourceBuffer can
    // still report a buffered *frame* although the next GOP request timed out
    // and no new frame can be presented. Prefer the already verified complete
    // MP4, which refreshes the decoder at precisely the same movie timestamp.
    if (readyIndexedVideo() && openIndexedSeekAt(position,{wasPlaying:true})) return true;
    // Without a complete indexed file, retain genuinely usable frames, but
    // do not attempt to play from an absent or expired SourceBuffer range.
    const bufferEnd = progressiveBufferEndAroundCurrent();
    if (Number.isFinite(bufferEnd) && bufferEnd - Number(video.currentTime) > 0.75
      && video.readyState >= 3 && !video.error) return false;
    void restartTranscodeAt(position,{wasPlaying:true,forceNative:true,verifySession:true});
    return true;
  }
  const mse = typeof remuxMseSession !== "undefined" ? remuxMseSession : null;
  const expiredProducer = Boolean(mse?.ended || mse?.needsResumeRefresh);
  if (mse?.contains(position - state.transcodeBaseOffsetSeconds) && !expiredProducer)
    return false; // A LIVE MSE still retains this exact decoded timeline.
  if (!mse && nativeTranscodeHasBufferedContinuation()) return false;
  // A stale native FFmpeg response should not spawn another expensive worker
  // if a separately verified complete indexed MP4 has finished while paused.
  if (readyIndexedVideo() && openIndexedSeekAt(position,{wasPlaying:true})) return true;
  // A SourceBuffer TimeRange is NOT proof the FFmpeg producer survived a long
  // idle pause. Stale/ended MSE must reopen one-way in native playback.
  void restartTranscodeAt(position, {
    wasPlaying: true, forceNative: expiredProducer, verifySession: true,
  });
  return true;
}

export function resumePlayback() {
  // The pop-up player has the video; LVL's window takes it back first.
  if (typeof popupPlayer !== "undefined" && popupPlayer.open) return;
  const alternate = recoveryAlternateIntent;
  if (alternate && alternate.loadId === playbackLoadRequestId) {
    // A real Resume belongs to this Library load even after B became ready or
    // its recovery overlay cleared. Retain the token: deferred startup still
    // consults its shouldAutoPlay() callback and late play events check it.
    alternate.wantsPlay = true;
    if (alternate.phase !== "ready") {
      // B is still pending (or failed before adoption): never play old A.
      // Only this owned incident can resume its bounded C continuation.
      recoveryPlaybackRequested = true;
      recoveryPauseSerial += 1;
      if (state.pendingSeek && state.currentSource?.kind === "torrent"
        && playbackRecoverySourceKey(state.currentSource.libraryId, state.currentSource.fileIndex) === alternate.sourceKey)
        state.pendingSeek.wasPlaying = true;
      if (alternate.phase === "failed") {
        recoveryAlternateIntent = null;
        void recoverPlayback("alternate-failed");
      }
      updateCompatControls();
      return;
    }
  }
  if (state.pendingSeek) {
    state.pendingSeek.wasPlaying = true;
    updateCompatControls();
    return;
  }
  // A failed play() promise can reject before a media 'play' event fires.
  // The user still requested Resume; let the resulting media error enter the
  // bounded recovery path instead of treating it as an idle paused player.
  recoveryPauseSerial += 1;
  recoveryPlaybackRequested = true;
  // A paused Watch can miss a newly completed full-MP4 status notification.
  // Rediscover it before reopening an expired progressive GOP or FFmpeg
  // producer; the authenticated ready callback may promote the same source.
  if (video.dataset?.mode === "transcode" && video.dataset.indexed !== "1"
    && typeof checkIndexedSeekCache === "function") checkIndexedSeekCache();
  if (resyncTranscodeAfterLongPause()) return;
  const source = state.currentSource;
  const loadId = playbackLoadRequestId;
  const src = video.src;
  video.play().catch((error) => {
    if (state.currentSource !== source || playbackLoadRequestId !== loadId
      || video.src !== src || !recoveryPlaybackRequested) return;
    // A buffered but disconnected MSE can reject Play without emitting a
    // media error; prefer its one-way native fallback to a dead source.
    if (fallbackActiveRemuxMseToNative({ wasPlaying: true })) return;
    if (error?.name !== "NotAllowedError") void recoverPlayback("error");
  });
}

export function togglePlayback() {
  const alternate = recoveryAlternateIntent;
  if (alternate && alternate.loadId === playbackLoadRequestId
    && recoveryDisplayPhase === "recovering") {
    // Frame, Space, floating and all Play/Pause buttons share this handler.
    // During recovery B, paused means the *old decoder* was stopped, not that
    // the user asked to Resume A. Toggle the B intent without playing A.
    alternate.wantsPlay = !alternate.wantsPlay;
    recoveryPlaybackRequested = alternate.wantsPlay;
    recoveryPauseSerial += 1;
    if (state.currentSource?.kind === "torrent"
      && playbackRecoverySourceKey(state.currentSource.libraryId, state.currentSource.fileIndex) === alternate.sourceKey
      && state.pendingSeek) state.pendingSeek.wasPlaying = alternate.wantsPlay;
    if (!alternate.wantsPlay) video.pause();
    else if (alternate.phase === "ready") resumePlayback();
    else if (alternate.phase === "failed") {
      recoveryAlternateIntent = null;
      void recoverPlayback("alternate-failed");
    }
    updateCompatControls();
    return;
  }
  if (state.pendingSeek) {
    state.pendingSeek.wasPlaying = !state.pendingSeek.wasPlaying;
    updateCompatControls();
    return;
  }
  if (video.paused) resumePlayback();
  else {
    // Ready B keeps its load-owned intent even after the recovery display
    // clears. A normal Pause must revoke it so late play events stay paused.
    if (alternate && alternate.loadId === playbackLoadRequestId)
      alternate.wantsPlay = false;
    recoveryPlaybackRequested = false;
    recoveryPauseSerial += 1;
    video.pause();
  }
}

export function seekPlayerTo(seconds) {
  const durationSeconds = state.mediaDurationMs > 0 ? state.mediaDurationMs / 1000 : (Number.isFinite(video.duration) ? video.duration : 0);
  const target = Math.max(0, durationSeconds ? Math.min(seconds, durationSeconds) : seconds);
  if (video.dataset.indexed === "1" && !remuxMseCacheAllowed) {
    delete video.dataset.indexed;
    void restartTranscodeAt(target, { wasPlaying: playerIsPlaying(), forceNative: true });
    return true;
  }
  if (video.dataset.indexed === "1" && Math.abs(target - absolutePlaybackSeconds()) > 0.2) {
    if (!state.pendingSeek) {
      // Indexed faststart MP4 supports standard HTTP byte-range seeking even
      // outside video.buffered; the browser fetches the needed moov/mdat.
      video.currentTime = target;
      state.currentMs = target * 1000;
      loadMoreEmbeddedSubtitles({ seeked: true });
      renderSubtitles();
      updateCompatControls();
      return true;
    }
  }
  if (video.dataset.progressive === "1" && !state.pendingSeek
    && isPlayerTimeBuffered(target)) {
    hideLoadingForBufferedSeek();
    video.currentTime = target;
    state.currentMs = target * 1000;
    loadMoreEmbeddedSubtitles({ seeked: true });
    renderSubtitles();
    updateCompatControls();
    return true;
  }
  if (video.dataset.progressive === "1" && !isPlayerTimeBuffered(target)) {
    // Even a 50ms seek can cross a decoded GOP boundary into a real MSE gap.
    // Do NOT let the generic <200ms path write video.currentTime into sparse
    // SourceBuffer time. Preserve the selected audio/source and play intent,
    // and use an actually verified completed MP4, independent GOP, or bounded
    // native fallback with a fresh explicit movie-clock seek.
    const wasPlaying = playerIsPlaying();
    if (readyIndexedVideo() && openIndexedSeekAt(target, { wasPlaying })) {
      loadMoreEmbeddedSubtitles({ seeked: true });
      return true;
    }
    if (openProgressiveSeekAt(target, { wasPlaying })) return true;
    if (!seekGapViaVerifiedIndexedOrNative(target, { wasPlaying }))
      scheduleTranscodeSeek(target, { forceNative: true });
    loadMoreEmbeddedSubtitles({ seeked: true });
    return true;
  }
  if (video.dataset.mode === "transcode" && Math.abs(target - absolutePlaybackSeconds()) > 0.2
    && typeof readyIndexedVideo === "function" && readyIndexedVideo()
    && openIndexedSeekAt(target, { wasPlaying: playerIsPlaying() })) {
    loadMoreEmbeddedSubtitles({ seeked: true });
    return true;
  }
  if (video.dataset.mode === "transcode" && Math.abs(target - absolutePlaybackSeconds()) > 0.2
    && openProgressiveSeekAt(target, { wasPlaying: playerIsPlaying() })) return true;
  if (video.dataset.mode === "transcode" && Math.abs(target - absolutePlaybackSeconds()) > 0.2
    && typeof seekInsideRemuxMse === "function" && seekInsideRemuxMse(target)) {
    loadMoreEmbeddedSubtitles({ seeked: true });
    return true;
  }
  if (video.dataset.mode === "transcode" && Math.abs(target - absolutePlaybackSeconds()) > 0.2
    && seekGapViaVerifiedIndexedOrNative(target, { wasPlaying: playerIsPlaying() })) {
    loadMoreEmbeddedSubtitles({ seeked: true });
    return true;
  }
  // Fragmented transcodes are intentionally treated as timestamped windows,
  // not as one ever-growing seekable file. Native seeking inside a generated
  // fragment is browser-dependent and was the source of the broken +/-10s
  // behavior. Re-open the transcode at the absolute movie timestamp instead.
  if (video.dataset.mode === "transcode" && Math.abs(target - absolutePlaybackSeconds()) > 0.2) {
    scheduleTranscodeSeek(target);
    // A transcode seek replaces the URL rather than dispatching native
    // seeking/timeupdate on the old video. Request the new subtitle window
    // immediately, including when the user seeks while paused.
    loadMoreEmbeddedSubtitles({ seeked: true });
    return true;
  }
  if (Math.abs(target - absolutePlaybackSeconds()) > 0.2 && frame.classList.contains("has-video")) {
    if (isPlayerTimeBuffered(target)) {
      clearBufferingTimer();
      hideLoadingForBufferedSeek();
    } else {
      setPlayerLoading(18, "Seeking", formatTime(target * 1000));
    }
  }
  video.currentTime = video.dataset.mode === "transcode" ? Math.max(0, target - state.transcodeBaseOffsetSeconds) : target;
  state.currentMs = target * 1000;
  renderSubtitles();
  updateCompatControls();
  return true;
}

export function seekPlayerBy(deltaSeconds) {
  return seekPlayerTo(absolutePlaybackSeconds() + deltaSeconds);
}

// ← and → seek 10 seconds, like the Back and Forward buttons. They also work right after a
// player control was used: on a focused player button, and on the position bar (its own arrow
// step would move it a tenth of a second). Elsewhere, focused fields and buttons keep their keys.
export function playerArrowSeek(event, tag) {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return false;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
  if (!$("#view-watch")?.classList.contains("is-active") || !frame.classList.contains("has-video")) return false;
  const target = event.target;
  const playerControl = frame.contains(target) && (tag === "button" || target.id === "compat-progress") && !target.closest?.('[role="menu"]');
  if (!playerControl && (["input", "textarea", "select", "button"].includes(tag) || target?.isContentEditable)) return false;
  event.preventDefault();
  seekPlayerBy(event.key === "ArrowLeft" ? -10 : 10);
  return true;
}

// While the pop-up has the video, nothing in LVL's window may start it again: its frame is
// hidden, Chromium pauses hidden muted video "to save power", and a seek or recovery still
// in progress then ended in a "Video synchronization unavailable" error. Same as a pause
// by the user, plus any pending start or seek is dropped.
export function suspendPlayerForPopup() {
  cancelTranscodeStart();
  recoveryPlaybackRequested = false;
  recoveryPauseSerial += 1;
  video.pause();
  clearBufferingTimer();
}

export function wirePlayerVideoEvents() {
  // Detect tab hide/show even when Chromium throttles both video callbacks
  // and interval timers for the entire background interval.
  document.addEventListener?.("visibilitychange", () => recoveryPictureVisible());
  video.addEventListener("seeking", () => {
    if (typeof isNewSourceFramePending === "function" && isNewSourceFramePending()) return;
    if (typeof clearStreamStatusLabel === "function") clearStreamStatusLabel();
    if (typeof invalidateStreamStatus === "function") invalidateStreamStatus();
    if (typeof recoveryDisplayPhase !== "undefined" && recoveryDisplayPhase !== "recovering") recoveryStallDiagnosis = null;
    invalidateSubtitleFrameClock();
    // Native seeking while paused can dispatch no timeupdate. The subtitle
    // timeline must jump to the new playhead immediately.
    state.currentMs = absolutePlaybackSeconds() * 1000;
    if (!state.pendingSeek?.priming) loadMoreEmbeddedSubtitles({ seeked: true });
    clearAutoNext();
    recoveryWaitingSince = null;
    if (isPlayerTimeBuffered(video.currentTime)) {
      clearBufferingTimer();
      hideLoadingForBufferedSeek();
    } else if (video.dataset.mode !== "transcode" && frame.classList.contains("has-video") && $("#video-loading")?.hidden) {
      setPlayerLoading(18, "Seeking", formatTime(video.currentTime * 1000));
    }
    renderSubtitles();
    // Check the new playhead promptly, even if playback remains paused. Already
    // matched subtitle anchors stay valid; only missing local speech coverage is sought.
    if (audioSync.key) scheduleAudioSync(400);
  });
  video.addEventListener("loadedmetadata", updateCompatControls);
  video.addEventListener("loadstart", invalidateSubtitleFrameClock);
  video.addEventListener("seeked", schedulePresentedSubtitleFrame);
  video.addEventListener("loadedmetadata", refreshEpisodeSkipOptions);
  video.addEventListener("durationchange", updateCompatControls);
  video.addEventListener("durationchange", refreshEpisodeSkipOptions);
  video.addEventListener("progress", updateCompatControls);
  video.addEventListener("canplay", () => {
    if (typeof isNewSourceFramePending === "function" && isNewSourceFramePending()) return;
    schedulePresentedSubtitleFrame();
    markPlaybackMotion();
    clearBufferingTimer();
    if (video.dataset.indexed === "1" && !state.pendingSeek && video.readyState >= 3) {
      frame.classList.remove("source-transition");
      hideLoadingForBufferedSeek();
    }
    if (!state.pendingSeek) finishPlayerLoading();
    updateCompatControls();
  });
  video.addEventListener("playing", () => {
    if (typeof isNewSourceFramePending === "function" && isNewSourceFramePending()) return;
    if (typeof clearStreamStatusLabel === "function") clearStreamStatusLabel();
    if (typeof invalidateStreamStatus === "function") invalidateStreamStatus();
    recoveryStallDiagnosis = null;
    if (recoveryDisplayPhase === "recovering") renderRecoveryOverlay();
    schedulePresentedSubtitleFrame();
    if (!state.pendingSeek?.priming) {
      refreshSubtitleClockForInteraction();
      renderSubtitles();
    }
    if (autoNextInterval !== null) clearAutoNext();
    if (currentRecoveryKey() && recoveryWatchTimer === null) beginRecoveryWatch();
    clearBufferingTimer();
    markPlaybackMotion();
    if (video.dataset.indexed === "1" && !state.pendingSeek && video.readyState >= 3) {
      frame.classList.remove("source-transition");
      hideLoadingForBufferedSeek();
    }
    recoveryWaitingSince = null;
    if (!state.pendingSeek) finishPlayerLoading();
    if (video.dataset.mode === "transcode") $("#media-status").textContent = "TORRENT - TRANSCODE PLAYING";
    else if (video.dataset.mode === "torrent-direct") $("#media-status").textContent = "TORRENT - PLAYING";
    updateCompatControls();
    scheduleAudioSync(1500);
  });
  video.addEventListener("play", () => {
    const alternate = recoveryAlternateIntent;
    if (alternate && alternate.loadId === playbackLoadRequestId && !alternate.wantsPlay) {
      // A delayed play() or decoder start from B must not undo a real Pause.
      video.pause();
      return;
    }
    if (typeof isNewSourceFramePending === "function" && isNewSourceFramePending()) return;
    recoveryPauseSerial += 1;
    recoveryPlaybackRequested = true;
    // Also cover browser media-key or native play calls bypassing resumePlayback.
    // restartTranscodeAt clears the snapshot before starting the replacement,
    // preventing recursive reloads.
    // An explicit Play after a previous exhausted failure is a fresh attempt.
    // Replace the stale red error panel with the normal branded loader instead
    // of carrying the old recovery incident into pause/resume.
    if (recoveryDisplayPhase === "failed" && !state.pendingSeek) {
      resetRecoveryDisplay();
      setPlayerLoading(28, "Resuming playback");
    }
    resyncTranscodeAfterLongPause();
  });
  video.addEventListener("pause", () => {
    if (typeof isNewSourceFramePending === "function" && isNewSourceFramePending()) return;
    if (!recoveryPlaybackRequested && typeof clearStreamStatusLabel === "function") clearStreamStatusLabel();
    if (typeof invalidateStreamStatus === "function") invalidateStreamStatus();
    if (!recoveryPlaybackRequested) recoveryStallDiagnosis = null;
    if (!state.pendingSeek?.priming) {
      refreshSubtitleClockForInteraction();
      renderSubtitles();
    }
    if (state.pendingSeek?.priming && transcodeStartAttempt?.mutedForPreroll
      && !video.error) {
      // Browser/media-key Pause during silent preroll changes desired playback
      // intent. Continue only the hidden/muted preroll, then remain paused at
      // the requested frame instead of stranding the seek.
      state.pendingSeek.wasPlaying = false;
      void video.play().catch(() => {});
      updateCompatControls();
      return;
    }
    // Browser media failures can emit pause BEFORE populating video.error. Our
    // own Pause controls clear intent immediately; native/media-key pauses clear
    // it after a short grace period for the matching error event to arrive.
    const pauseSerial = ++recoveryPauseSerial;
    if (!video.error && recoveryPlaybackRequested) window.setTimeout(() => {
      if (pauseSerial === recoveryPauseSerial && video.paused && !video.error
        && !state.pendingSeek && !(recoveryBusy && playbackRecovery.pendingSourceKey)) {
        // Source replacement pauses the old decoder before Library metadata
        // resolves. Its synthetic Pause must not cancel the already-requested
        // recovery after one second; explicit Pause clears intent immediately.
        recoveryPlaybackRequested = false;
        if (recoveryDisplayPhase !== "recovering") {
          if (typeof clearStreamStatusLabel === "function") clearStreamStatusLabel();
          recoveryStallDiagnosis = null;
        }
      }
    }, 1000);
    noteTranscodePause();
    clearBufferingTimer();
    recoveryWaitingSince = null;
    if (recoveryDisplayPhase === "recovering" && !state.pendingSeek && state.loadingProgress >= 100) resetRecoveryDisplay();
    // The old stream pauses while a merged seek waits: keep "Seeking" up until the new one plays.
    if (!state.pendingSeek && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && $("#video-loading")) $("#video-loading").hidden = true;
    if (!state.pendingSeek) recordWatchProgress({ force: true });
    updateCompatControls();
  });
  video.addEventListener("waiting", () => {
    if (typeof isNewSourceFramePending === "function" && isNewSourceFramePending()) return;
    if (currentRecoveryKey() && recoveryWaitingSince === null) recoveryWaitingSince = Date.now();
    if (video.dataset.mode === "transcode" || video.dataset.mode === "torrent-direct") scheduleBufferingIndicator();
  });
  video.addEventListener("stalled", () => {
    if (typeof isNewSourceFramePending === "function" && isNewSourceFramePending()) return;
    if (currentRecoveryKey() && recoveryWaitingSince === null) recoveryWaitingSince = Date.now();
    scheduleBufferingIndicator();
  });
  video.addEventListener("error", () => {
    // Unloading A while B resolves can dispatch an old media error after the
    // branded B loader is already visible. New B errors are still handled once
    // B's assigned currentSrc is actively loading.
    if (typeof isNewSourceFramePending === "function" && isNewSourceFramePending() && (!sourceFrameGate?.src
      || video.currentSrc !== sourceFrameGate.src || !video.error)) return;
    if (state.pendingSeek?.priming) {
      if (!state.pendingSeek.streamInstalled) return;
      if (typeof transcodeStartAttempt !== "undefined" && transcodeStartAttempt?.fallbackToNative?.()) return;
      // MediaError hides HTTP statuses from <video>. Resource Timing may expose
      // the same-origin status of its *existing* request; inspect it without
      // launching another FFmpeg conversion or replaying a stale source URL.
      const mediaCode = Number(video.error?.code) || 0;
      const mediaKind = video.currentSrc?.startsWith("blob:") ? "MSE" : "native";
      let responseStatus = 0;
      try {
        if (typeof performance !== "undefined" && /^https?:\/\//.test(String(video.currentSrc || ""))) {
          const matches = performance.getEntriesByName(video.currentSrc, "resource");
          const latest = matches?.at(-1);
          const observed = Number(latest?.responseStatus);
          if (Number.isInteger(observed) && observed >= 100 && observed <= 599) responseStatus = observed;
        }
      } catch { /* Timing details are optional; never affect playback. */ }
      if (typeof waitForMissingTorrentSeek === "function"
        && mediaKind === "native" && mediaCode === 4
        && (!responseStatus || responseStatus === 200)
        && waitForMissingTorrentSeek(Number(state.pendingSeek.target) || 0,
          Boolean(state.pendingSeek.wasPlaying))) return;
      // A device can advertise HEVC/AV1 support but reject its actual remuxed
      // fMP4 after a seek. If Resource Timing confirms a successful HTTP 200,
      // do not waste two FFmpeg slots retrying the same unsupported codec.
      // When the HTTP status is unavailable, retain bounded transient retries
      // before ONE compatibility fallback. Never silently tone-map HDR, repeat
      // a downgrade, or disguise an observed HTTP 429/5xx as a decoder issue.
      const probeVideo = state.currentMediaProbe?.video || {};
      const probeCompatibility = state.currentMediaProbe?.compatibility?.video || {};
      const inputCodec = String(probeVideo.codec || "").toLowerCase();
      const failedCopy = state.transcodeContext?.copyVideo
        && !state.transcodeContext?.forceH264 && mediaKind === "native";
      const isHdr = Boolean(probeCompatibility.hdr || probeCompatibility.hdrKind
        || probeVideo.dolbyVision || ["smpte2084", "arib-std-b67"].includes(String(probeVideo.colorTransfer || "").toLowerCase()));
      const tryCompatibleVideoFallback = ({ requireHttpSuccess = false } = {}) => {
        if (mediaCode !== 4 || !failedCopy || isHdr || !serverCanConvertVideo()
          || !["hevc", "h265", "av1"].includes(inputCodec)
          || (responseStatus !== 0 && responseStatus !== 200)
          || (requireHttpSuccess && responseStatus !== 200)) return false;
        const target = Number(state.pendingSeek.target) || 0;
        const wasPlaying = Boolean(state.pendingSeek.wasPlaying);
        state.transcodeContext.forceH264 = true;
        void openTranscodeAt(target, { wasPlaying, forceNative: true });
        return true;
      };
      if (tryCompatibleVideoFallback({ requireHttpSuccess: true })) return;
      if (transcodeStartAttempt?.retryTransient?.(video.error || new Error("The media window closed"))) return;
      if (tryCompatibleVideoFallback()) return;
      const details = ["The converted stream failed before the requested frame.",
        mediaCode ? `Media error ${mediaCode} (${mediaKind}).` : "",
        responseStatus ? `HTTP ${responseStatus}.` : ""].filter(Boolean).join(" ");
      cancelTranscodeStart();
      video.pause();
      setPlayerLoading(100, "Video synchronization unavailable",
        details, { error: true });
      return;
    }
    if (typeof fallbackActiveRemuxMseToNative === "function" && fallbackActiveRemuxMseToNative()) return;
    if (video.paused && state.loadingProgress >= 100 && !state.pendingSeek && !recoveryPlaybackRequested) return;
    if (currentRecoveryKey() && !recoveryBusy) {
      void recoverPlayback("error");
      return;
    }
    frame.classList.remove("source-transition");
    $("#video-loading").hidden = true;
    if (video.dataset.mode === "torrent-direct") $("#media-status").textContent = "This video's format can't play directly. Try another source.";
    if (video.dataset.mode === "transcode") $("#media-status").textContent = "Converting this video failed. Try another source.";
  });
}

export function progressTimeAt(clientX) {
  const rect = compatProgress.getBoundingClientRect();
  const ratio = rect.width ? Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) : 0;
  return ratio * (Number(compatProgress.max) || 0);
}
export function showScrubTime(seconds) {
  const bubble = $("#player-scrub-time");
  const max = Number(compatProgress.max) || 0;
  if (!bubble || !max) return;
  bubble.hidden = false;
  const segment = episodeTimelineRanges().find((range) => seconds >= range.start && seconds < range.end);
  bubble.textContent = `${formatTime(seconds * 1000)}${segment ? ` - ${segment.label}` : ""}`;
  const ratio = Math.max(0, Math.min(1, seconds / max));
  const width = compatProgress.getBoundingClientRect().width;
  // Longer chapter labels must not be clipped at either rounded video edge.
  const margin = bubble.offsetWidth / 2 + 6;
  bubble.style.left = width
    ? `${Math.max(Math.min(margin, width / 2), Math.min(width - Math.min(margin, width / 2), ratio * width))}px`
    : `${ratio * 100}%`;
}
export function endScrub() {
  if (!state.scrubbing) return;
  state.scrubbing = false;
  $("#player-scrub-time").hidden = true;
  updateCompatControls();
}

export function wirePlayerSourceButtons() {
  $("#player-retry-source")?.addEventListener("click", () => {
    if (transcodeStartAttempt?.awaitingUserGesture && transcodeStartAttempt.resumeAfterGesture?.()) return;
    const source = state.currentSource;
    if (source?.kind !== "torrent") return;
    const at = absolutePlaybackSeconds();
    resetRecoveryDisplay();
    playbackRecovery = createPlaybackRecoveryState();
    void playLibraryEpisode(source.libraryId, Number(source.fileIndex), { resumeAtSeconds: at });
  });
  $("#player-choose-source")?.addEventListener("click", () => {
    resetRecoveryDisplay();
    $("#video-loading").hidden = true;
    $("#player-source-switcher")?.click();
  });
}

export function syncPlayerSpeed() {
  const rate = Number(video.playbackRate) || 1;
  const label = `${Number(rate.toFixed(2))}×`;
  const trigger = $("#speed-select");
  if (trigger) {
    trigger.textContent = label;
    trigger.setAttribute("aria-label", `Playback speed: ${label}`);
  }
  $$("#player-speed-menu [data-speed]").forEach((button) => {
    button.setAttribute("aria-checked", String(Number(button.dataset.speed) === rate));
  });
}
