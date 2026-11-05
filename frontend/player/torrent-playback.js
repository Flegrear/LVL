// Opening torrents and local files, and choosing their video files.
import { emptyMarkup, escapeHtml, icon, metaMarkup, toast } from "../ui/ui.js";
import { waitForStartupMediaProbe } from "./media-startup.js";
import { selectBrowserPlaybackWithCapabilities } from "./browser-media.js";
import { formatBytes, frame, playbackMetrics, popupPlayer, state, TITLE_STATUS, video } from "../../app.js";
import { $, setToolStatus } from "../app/dom.js";
import { fetchJson, postJson } from "../app/http.js";
import { rememberWatchSelection, switchView, viewActive } from "../app/navigation.js";
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

export async function releaseTorrentSession(sessionId) {
  // Adding a chapter can resolve the torrent that is already playing (same pack): keep that one.
  if (!sessionId || sessionId === state.currentSource?.sessionId) return;
  try {
    await fetch(`/api/torrents/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
  } catch {}
}

export async function importCatalogStream(meta, stream, { button = null, seriesKey = null, quiet = false, rerenderLibrary = true } = {}) {
  if (!stream?.magnet) throw new Error("Selected source did not provide a usable torrent hash.");
  const oldText = buttonText(button) || "Add";
  if (button) { button.disabled = true; setButtonText(button, "Opening…"); }
  if (!quiet) setToolStatus(TITLE_STATUS, "Checking the source…");
  let session;
  try {
    session = await resolveTorrentMagnet(stream.magnet, (current, elapsed) => {
      if (!quiet) setToolStatus(TITLE_STATUS, `Opening the torrent… ${elapsed} s${current.numPeers ? `, ${current.numPeers} peer${current.numPeers === 1 ? "" : "s"}` : ""}`);
    }, { timeoutMs: 25_000, preferredFileIndex: Number.isInteger(stream.fileIdx) ? stream.fileIdx : null });
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
    if (session?.id) await releaseTorrentSession(session.id);
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
    title: collectionTitle,
    sourceTag,
    seriesKey: entry?.seriesKey || librarySeriesKey(collectionTitle),
    libraryId: entry?.id || libraryId,
    fileIndex: file.index,
    fileName: file.name,
    episode,
    aliases: Array.isArray(entry?.aliases) ? entry.aliases : [],
    sessionId: session.id,
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

async function playTorrentFile(session, file, { startAtSeconds = 0, requestId = null } = {}) {
  // Another video in LVL's window: the pop-up player closes.
  if (typeof dismissPopupPlayer === "function") dismissPopupPlayer();
  // A direct torrent selection supersedes a pending Library resolution too.
  // Do not abort the Library request that just handed us this same load ID.
  if (requestId === null) {
    libraryPlaybackResolveController?.abort("another source selected");
    libraryPlaybackResolveController = null;
    libraryPlaybackPendingMagnet = "";
  }
  const loadId = requestId ?? ++playbackLoadRequestId;
  const storageLimit = await playerStorageLimit();
  if (loadId !== playbackLoadRequestId) return false;
  if (storageLimit && Number(file?.length) > storageLimit) {
    const message = `This video is ${(Number(file.length) / 1024 ** 3).toFixed(1)} GB, more than the ${Math.round(storageLimit / 1024 ** 3)} GB set for player storage. Raise it in Settings, Storage.`;
    if (!$("#video-loading")?.hidden) setPlayerLoading(100, "Not enough player storage", message, { error: true });
    toast(message, { tone: "error", timeout: 8000 });
    return false;
  }
  const previousSessionId = state.currentSource?.kind === "torrent" ? state.currentSource.sessionId : null;
  beginSourceTransition();
  setCurrentTorrentSource(session, file);
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
    const opened = await openTranscodeAt(startAtSeconds, { wasPlaying: true, initialize: sourceOptions });
    if (!opened || loadId !== playbackLoadRequestId) return false;
  } else {
    setMediaSource({ ...sourceOptions, src: baseUrl });
  }
  updatePlayerIdentity(state.currentSource.title, episode);
  // The player no longer reads the previous torrent: free its slot (the server allows 4 sessions).
  if (previousSessionId && previousSessionId !== session.id) void releaseTorrentSession(previousSessionId);
  if (!needsTranscode) {
    void video.play().catch((error) => {
      if (error?.name !== "NotAllowedError" || video.muted
        || loadId !== playbackLoadRequestId || state.currentSource?.sessionId !== session.id
        || video.dataset.mode !== "torrent-direct") return;
      // Same browser policy, but the direct torrent path has no FFmpeg attempt.
      video.muted = true;
      updateCompatControls();
      void video.play().then(() => {
        if (loadId === playbackLoadRequestId)
          toast("Your browser blocked automatic sound. Video is playing muted; use the speaker control to enable audio.", { timeout: 5500 });
      }).catch(() => {});
    });
  }
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
  return true;
}

function preparePlayerForLibraryLoad(entry, episode, { resumeAtSeconds = 0 } = {}) {
  cancelTranscodeStart();
  setWatchTheaterMode(false);
  watchPendingSelection = { libraryId: entry.id, fileIndex: episode?.fileIndex ?? null, episode };
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
}

export async function resolveTorrentMagnet(magnet, onProgress, { timeoutMs = 0, preferredFileIndex = null, signal, releaseOnFailure = true, onSession } = {}) {
  signal?.throwIfAborted();
  let session = await postJson("/api/torrents", {
    magnet,
    ...(Number.isInteger(preferredFileIndex) && preferredFileIndex >= 0 ? { preferredFileIndex } : {}),
  }, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : undefined });
  // Poll payloads don't preserve `reused`; remember whether this caller owns
  // the newly created session before considering cleanup on timeout/error.
  const ownedSession = session.reused === false;
  onSession?.(session);
  signal?.throwIfAborted();
  const startedAt = Date.now();
  // Sessions restored from disk usually need little more than an initial poll.
  let polls = 0;
  while (session.state !== "ready" && session.state !== "error") {
    onProgress?.(session, Math.floor((Date.now() - startedAt) / 1000));
    if (timeoutMs > 0 && Date.now() - startedAt >= timeoutMs) {
      if (releaseOnFailure && ownedSession) await releaseTorrentSession(session.id);
      throw new Error("Torrent metadata timed out. Trying another source may work.");
    }
    const delay = polls === 0 ? 150 : polls === 1 ? 400 : 1500;
    polls += 1;
    await new Promise((resolve, reject) => {
      const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, delay);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
    session = await fetchJson(`/api/torrents/${encodeURIComponent(session.id)}`, { signal });
  }
  if (session.state === "error") {
    // Free the slot now; an errored session would otherwise count against the limit until it expires.
    if (releaseOnFailure && ownedSession) await releaseTorrentSession(session.id);
    throw new Error(session.error || "Torrent metadata could not be resolved.");
  }
  return session;
}

export async function playLibraryEpisode(libraryId, fileIndex, { resumeAtSeconds = 0 } = {}) {
  const entry = libraryEntryById(libraryId);
  if (!entry?.magnet) return false;
  libraryPlaybackResolveController?.abort("another library episode selected");
  const controller = new AbortController();
  libraryPlaybackResolveController = controller;
  libraryPlaybackPendingMagnet = entry.magnet;
  let reservedSession = null;
  const loadId = ++playbackLoadRequestId;
  const buttonSource = entry.episodes?.find((episode) => Number(episode.fileIndex) === Number(fileIndex));
  preparePlayerForLibraryLoad(entry, buttonSource, { resumeAtSeconds });
  try {
    $("#media-status").textContent = `LIBRARY - RESOLVING ${buttonSource?.code || "VIDEO"}`;
    const session = await resolveTorrentMagnet(entry.magnet, (current, elapsed) => {
      if (loadId !== playbackLoadRequestId) return;
      const peerBoost = current.numPeers ? 16 : 0;
      const slowPenalty = current.state === "resolving-slow" ? 4 : 0;
      const percent = Math.min(58, 10 + peerBoost + Math.min(32, elapsed * 4) - slowPenalty);
      setPlayerLoading(percent, current.numPeers ? "Reading source" : "Finding peers", current.numPeers
        ? `${current.numPeers} peer${current.numPeers === 1 ? "" : "s"}`
        : "");
    }, { preferredFileIndex: Number.isInteger(fileIndex) ? fileIndex : null, timeoutMs: recoveryBusy ? 25_000 : 60_000,
      signal: controller.signal, onSession: (session) => { reservedSession = session; controller.sessionId = session.id; } });
    if (loadId !== playbackLoadRequestId) return false;
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
    return (await playTorrentFile(session, file, { startAtSeconds: resumeAtSeconds, requestId: loadId })) !== false;
  } catch (error) {
    if (loadId !== playbackLoadRequestId || controller.signal.aborted) return false;
    $("#media-status").textContent = "Couldn't open this source";
    setPlayerLoading(100, "Couldn't open this source", error.message || "", { error: true });
    console.error(error);
    return false;
  } finally {
    if (libraryPlaybackResolveController === controller) {
      libraryPlaybackResolveController = null;
      libraryPlaybackPendingMagnet = "";
    }
    // Release only a newly owned abandoned torrent, not a reused session, an
    // active player session, or one the replacement request may still reuse.
    if (controller.signal.aborted && reservedSession?.reused === false
      && libraryPlaybackPendingMagnet !== entry.magnet) await releaseTorrentSession(reservedSession.id);
  }
}

export async function resolveMagnet(event) {
  event.preventDefault();
  const magnet = $("#magnet-input").value.trim();
  if (!magnet) return;
  setToolStatus("#magnet-status", "Reading the torrent…");
  $("#magnet-files").innerHTML = "";
  try {
    const session = await resolveTorrentMagnet(magnet, (current, elapsed) => {
      const peerCopy = current.numPeers ? `, ${current.numPeers} peer${current.numPeers === 1 ? "" : "s"}` : "";
      setToolStatus("#magnet-status", `${current.state === "resolving-slow" ? "Still reading the torrent" : "Reading the torrent"}… ${elapsed} s${peerCopy}`);
    });
    const targetSeriesKey = state.pendingMagnetSeriesKey;
    const entry = upsertLibrarySession(session, magnet, { seriesKeyOverride: targetSeriesKey });
    state.pendingMagnetSeriesKey = null;
    const videoCount = (session.files || []).filter((file) => file.video).length;
    const normalizedTitle = normalizeCollectionTitle(session.name, session.files?.find((file) => file.video)?.name);
    const where = targetSeriesKey && entry ? `, added to ${entry.displayTitle || entry.title}` : ", added to your Library";
    setToolStatus("#magnet-status", `${normalizedTitle}: ${videoCount} video${videoCount === 1 ? "" : "s"}${where}`);
    renderMagnetFiles(session);
  } catch (error) {
    setToolStatus("#magnet-status", error.message, true);
  }
}

export function openMagnetDialog({ seriesKey = null } = {}) {
  state.pendingMagnetSeriesKey = seriesKey;
  $("#magnet-input").value = "";
  $("#magnet-files").innerHTML = "";
  const series = seriesKey ? buildLibrarySeries().find((item) => item.key === seriesKey) : null;
  $("#magnet-title").textContent = series ? `Add a magnet to ${series.title}` : "Open a magnet link";
  setToolStatus("#magnet-status", "");
  $("#magnet-dialog").showModal();
  queueMicrotask(() => $("#magnet-input")?.focus());
}


export function wireLocalVideoInput() {
  $("#video-input").addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    cancelPhoneTimelineScrub();
    const abandonedSessionId = state.currentSource?.sessionId;
    // Local selection supersedes any torrent resolve/metadata response that
    // could otherwise install the old source after the file is chosen.
    playbackLoadRequestId += 1;
    libraryPlaybackResolveController?.abort("local file selected");
    libraryPlaybackResolveController = null;
    libraryPlaybackPendingMagnet = "";
    setWatchTheaterMode(false);
    watchPendingSelection = null;
    event.target.value = "";
    const url = URL.createObjectURL(file);
    const title = normalizeCollectionTitle(file.name);
    setPlayerLoadingTitle(null, title);
    state.currentSource = { kind: "local", title, sourceTag: title, libraryId: null, fileIndex: null };
    state.currentMediaProbe = null;
    state.selectedAudioTrack = 0;
    resetAudioSync();
    if (abandonedSessionId) void releaseTorrentSession(abandonedSessionId);
    stopTransferStats();
    updateTransferStats();
    applyLanguagePreferencesToTracks();
    updatePlayerIdentity(title, { code: "VIDEO", title });
    setMediaSource({ src: url, title, status: "LOCAL MEDIA", objectUrl: url });
    // "Play a video file" is in the Library's More menu: go to the player.
    switchView("watch");
    renderWatchChapters();
  });
}
