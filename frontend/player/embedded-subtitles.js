// Subtitles inside the video file: listing, importing and loading more.
import { parseSubtitle } from "../../shared/subtitles/subtitle-text.js";
import { escapeHtml } from "../ui/ui.js";
import {
  completedWebVttText, EMBEDDED_WINDOW_SECONDS, embeddedExtractionError, embeddedSubtitleCoverageEnd,
  embeddedSubtitleCovers, embeddedSubtitleSeekStart, embeddedTrackMatchesSource,
  mergeSubtitleWindows, subtitleWindowStart,
} from "../../shared/subtitles/subtitle-stream.js";
import { defaultEmbeddedSubtitleTrack } from "./embedded-subtitle-default.js";
import { frame, renderSubtitleWorkspace, state, video } from "../../app.js";
import { $ } from "../app/dom.js";
import { absolutePlaybackSeconds, presentedSubtitleSeconds, updatePlayerPreferenceButtons } from "./player-core.js";
import {
  currentSourceTracks, normalizeTrackLanguage, preferredLanguagePair, syncSelectedTrackForSource,
} from "./player-tracks.js";
import { renderSubtitles, subtitleRenderMemo, trackLanguageName } from "./subtitle-display.js";
import { subtitleFingerprint } from "./subtitle-timing.js";
import { renderSubtitleStyleControls } from "./subtitle-style.js";
import { addSubtitleText } from "./subtitle-search.js";

export function embeddedSubtitleLabel(track, index) {
  const title = String(track?.title || "").trim();
  if (title) return title;
  const codec = String(track?.codec || "subtitle").toUpperCase();
  return `Embedded subtitle ${index + 1} (${codec})`;
}

export const embeddedSubtitleImports = new Map();
const embeddedSubtitleAttempts = new Map();
// Async imports can finish after a later Hide/Show or track switch. Only the
// most recent explicit caption choice is allowed to activate a loading track.
let subtitleVisibilityRevision = 0;
export function noteSubtitleVisibilityIntent() { subtitleVisibilityRevision += 1; }
export function embeddedSubtitleImportKey(source, streamIndex) {
  return `${source?.sessionId || ""}:${source?.fileIndex ?? ""}:${source?.sourceTag || ""}:${streamIndex}`;
}

export async function importEmbeddedSubtitleTrack(track, button = null, { startSeconds = null, automatic = false, activate = false, urgent = false, focused = false } = {}) {
  const source = state.currentSource || {};
  if (!source.sessionId || source.fileIndex === null || source.fileIndex === undefined || !Number.isInteger(Number(track?.streamIndex))) return false;
  if (!automatic) noteSubtitleVisibilityIntent();
  const key = embeddedSubtitleImportKey(source, Number(track.streamIndex));
  const existing = currentSourceTracks().find((item) => Number(item.embeddedStreamIndex) === Number(track.streamIndex) && embeddedTrackMatchesSource(item, source));
  if (!automatic && existing?.cues?.length && !existing.embeddedImportPartial && !existing.visible) {
    existing.visible = true;
    state.subtitlesVisible = true;
    syncSelectedTrackForSource();
    subtitleRenderMemo.key = "";
    renderSubtitleWorkspace();
    renderEmbeddedSubtitleControls();
    $("#media-status").textContent = "Embedded subtitles enabled";
    return true;
  }
  const seekPosition = startSeconds ?? absolutePlaybackSeconds();
  // A manual forward jump into the end of a three-minute window should not
  // scan its first 170s before reaching the requested subtitle. FFmpeg can
  // seek directly into MKV and keep the absolute VTT timestamps.
  const windowStart = focused ? embeddedSubtitleSeekStart(seekPosition) : subtitleWindowStart(seekPosition);
  const attemptKey = `${key}:${windowStart}`;
  const lastAttempt = embeddedSubtitleAttempts.get(attemptKey) || 0;
  // A standard 360s extraction and a 359s focused extraction address nearly
  // the same data. Count both toward the short explicit-seek retry guard.
  let lastNearbyAttempt = lastAttempt;
  if (urgent) {
    for (let delta = -10; delta <= 10; delta++) {
      lastNearbyAttempt = Math.max(lastNearbyAttempt,
        embeddedSubtitleAttempts.get(`${key}:${windowStart + delta}`) || 0);
    }
  }
  // Ordinary timeupdates should not hammer unavailable torrent pieces. An
  // explicit seek can retry a just-abandoned window after a short guard.
  if (automatic && Date.now() - (urgent ? lastNearbyAttempt : lastAttempt) < (urgent ? 1500 : 60_000)) return false;
  const inFlight = embeddedSubtitleImports.get(key);
  if (inFlight) {
    if (!automatic) {
      // Clicking a subtitle stream while it is already being extracted must
      // select that stream, not cancel the only request capable of providing
      // its cues. This also handles a manual selection racing default loading.
      inFlight.manualSelection = true;
      inFlight.visibilityRevision = subtitleVisibilityRevision;
      state.subtitlesVisible = true;
      if (existing?.cues?.length) existing.visible = true;
      subtitleRenderMemo.key = "";
      renderSubtitles();
      renderSubtitleWorkspace();
      renderEmbeddedSubtitleControls();
      return true;
    }
    // Timeupdates must not replace an extraction already covering the
    // playhead, even when its start is not on a 180s boundary. A genuinely
    // different explicit seek may replace it to avoid waiting for earlier
    // packets within that same window.
    const playback = absolutePlaybackSeconds();
    const coversPlayback = playback >= inFlight.windowStart
      && playback < inFlight.windowStart + EMBEDDED_WINDOW_SECONDS;
    const nearOriginalSeek = Math.abs(playback - inFlight.seekPosition) < 12;
    if (coversPlayback && (!urgent || nearOriginalSeek)) return false;
    // A speculative next-window prefetch must never evict an extraction
    // serving the current playhead.
    if (inFlight.windowStart === windowStart
      || (!urgent && subtitleWindowStart(playback) !== subtitleWindowStart(seekPosition))) return false;
    inFlight.abort("playback moved to a different subtitle window");
    embeddedSubtitleAttempts.delete(`${key}:${inFlight.windowStart}`);
  }
  embeddedSubtitleAttempts.set(attemptKey, Date.now());
  const controller = new AbortController();
  controller.windowStart = windowStart;
  controller.seekPosition = seekPosition;
  controller.manualSelection = !automatic;
  controller.visibilityRevision = subtitleVisibilityRevision;
  embeddedSubtitleImports.set(key, controller);
  const timer = window.setTimeout(() => controller.abort("timeout"), 50_000);
  let imported = existing || null;
  let received = "";
  let windowCueCount = 0;
  let renderAt = 0;
  let parsedAt = 0;
  let progressTimer = null;
  const label = embeddedSubtitleLabel(track, Number(track.order) || 0);
  // The same torrent/file/track can be reopened in a new playback generation
  // (A → B → A). Its string key matches, but an old already-buffered response
  // must never append cues to the new selection after abort.
  const sourceStillActive = () => state.currentSource === source
    && embeddedSubtitleImportKey(state.currentSource || {}, Number(track.streamIndex)) === key;
  const requestIsCurrent = () => !controller.signal.aborted
    && sourceStillActive() && embeddedSubtitleImports.get(key) === controller;
  const markWindowComplete = () => {
    if (focused) {
      // Never mark an aligned bucket complete when the beginning of that
      // bucket was skipped. These bounded intervals are merged with legacy
      // completed windows by embeddedSubtitleCovers().
      const ranges = Array.isArray(imported.embeddedCompletedRanges) ? imported.embeddedCompletedRanges : [];
      imported.embeddedCompletedRanges = [...ranges, {
        start: windowStart, end: windowStart + EMBEDDED_WINDOW_SECONDS,
      }].slice(-64);
    } else {
      imported.embeddedCompletedWindows = [...new Set([...(imported.embeddedCompletedWindows || []), windowStart])];
    }
  };
  const waitingHintTimer = window.setTimeout(() => {
    if (requestIsCurrent() && windowCueCount === 0 && !automatic) {
      $("#media-status").textContent = "Waiting for torrent pieces near your playback position… Find subtitles is available too.";
    }
  }, 12_000);
  const onProgress = (force = false) => {
    if (!requestIsCurrent()) return;
    const now = Date.now();
    if (!force && parsedAt && now - parsedAt < 550) {
      // A stream may stop producing chunks after a complete cue. Keep a
      // trailing parse so that the last cue appears without a playback event.
      if (progressTimer === null) progressTimer = window.setTimeout(() => {
        progressTimer = null;
        onProgress();
      }, 550 - (now - parsedAt));
      return;
    }
    if (progressTimer !== null) {
      window.clearTimeout(progressTimer);
      progressTimer = null;
    }
    parsedAt = now;
    const cues = parseSubtitle(completedWebVttText(received, force), imported?.id || "embedded-preview");
    if (!cues.length || (cues.length <= windowCueCount && !force)) return;
    windowCueCount = cues.length;
    if (!imported) {
      const added = addSubtitleText(completedWebVttText(received, force), label, normalizeTrackLanguage(track.language), {
        origin: "embedded", exactMedia: true, provider: "Embedded", release: source.fileName || "",
      });
      imported = added.track;
      imported.embeddedStreamIndex = Number(track.streamIndex);
    }
    imported.cues = mergeSubtitleWindows(imported.cues, cues, imported.id);
    imported.fingerprint = subtitleFingerprint(imported.cues);
    imported.exactMedia = true;
    imported.offsetMs = 0;
    imported.syncAnchors = [];
    imported.syncSource = "embedded";
    imported.timelineMismatch = false; // A fetched window isn't a different cut of the video.
    if (controller.manualSelection && controller.visibilityRevision === subtitleVisibilityRevision) {
      state.subtitlesVisible = true;
      imported.visible = true;
      syncSelectedTrackForSource();
    } else if (activate && state.subtitlesVisible && controller.visibilityRevision === subtitleVisibilityRevision && !currentSourceTracks().some((item) => item.id !== imported.id && item.visible && item.cues?.length)) {
      imported.visible = true;
      syncSelectedTrackForSource();
    } else if (!automatic && controller.visibilityRevision === subtitleVisibilityRevision) {
      state.subtitlesVisible = true;
      imported.visible = true;
      syncSelectedTrackForSource();
    }
    subtitleRenderMemo.key = ""; // Cue text can grow under an unchanged cue ID.
    // A fetch can deliver cues between video events. Use the presented frame
    // when known: currentTime can run ahead of the displayed frame on resume.
    state.currentMs = (presentedSubtitleSeconds() ?? absolutePlaybackSeconds()) * 1000;
    renderSubtitles();
    if (force || Date.now() - renderAt > 1500) {
      renderAt = Date.now();
      renderSubtitleWorkspace();
      if (!automatic) $("#media-status").textContent = `Embedded subtitles - ${imported.cues.length} lines available`;
    }
  };
  renderEmbeddedSubtitleControls();
  if (!automatic) {
    state.subtitlesVisible = true;
    renderSubtitleStyleControls();
    updatePlayerPreferenceButtons();
    $("#media-status").textContent = "Reading subtitles near the current playback position…";
  }
  try {
    const url = `/api/torrents/${encodeURIComponent(source.sessionId)}/files/${Number(source.fileIndex)}/subtitle?stream=${Number(track.streamIndex)}&progressive=1&start=${windowStart}`;
    const response = await fetch(url, { headers: { Accept: "text/vtt" }, signal: controller.signal });
    if (!response.ok) {
      let message = await response.text();
      try { message = JSON.parse(message)?.error || message; } catch {}
      const error = new Error(message || `Embedded subtitle extraction failed (${response.status})`);
      error.httpStatus = response.status;
      throw error;
    }
    if (!response.body) throw new Error("This browser cannot stream embedded subtitle extraction.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += decoder.decode(value, { stream: true });
      if (received.length > 2 * 1024 * 1024) throw new Error("Embedded subtitle track is too large");
      onProgress();
    }
    received += decoder.decode();
    onProgress(true);
    if (!requestIsCurrent()) return false;
    const partial = /NOTE LVL-EXTRACT-PARTIAL/.test(received);
    const extractionError = embeddedExtractionError(received);
    // A complete window may contain no dialogue. Preserve captions loaded from
    // earlier windows and remember this empty window instead of flagging the
    // entire track as partial (which makes auto-loading retry it forever).
    // A track picked by hand is added even when this part of the episode has
    // no lines in it (an opening, a quiet scene); later parts load as it plays.
    if (!windowCueCount && !partial && /NOTE LVL-EXTRACT-COMPLETE/.test(received) && (imported || !automatic)) {
      if (!imported) {
        imported = addSubtitleText("", label, normalizeTrackLanguage(track.language), {
          origin: "embedded", exactMedia: true, provider: "Embedded", release: source.fileName || "", allowEmpty: true,
        }).track;
        imported.embeddedStreamIndex = Number(track.streamIndex);
        imported.exactMedia = true;
        imported.offsetMs = 0;
        imported.syncAnchors = [];
        imported.syncSource = "embedded";
        imported.timelineMismatch = false;
        if (controller.visibilityRevision === subtitleVisibilityRevision) {
          state.subtitlesVisible = true;
          imported.visible = true;
          syncSelectedTrackForSource();
        }
        subtitleRenderMemo.key = "";
        renderSubtitles();
      }
      imported.embeddedImportPartial = false;
      markWindowComplete();

      if (!automatic) $("#media-status").textContent = imported.cues?.length
        ? "No new embedded subtitle lines near this playback position"
        : "This track has no lines in this part of the episode. They appear as it plays.";
      renderSubtitleWorkspace();
      return true;
    }
    if (!windowCueCount) throw new Error(partial
      ? `Subtitle extraction stopped: ${extractionError || "The video may still be downloading"}. Try again when more of the video has loaded, or use Find subtitles.`
      : "No subtitle lines were found near this playback position. Try another point in the episode.");
    imported.embeddedImportPartial = partial;
    if (!partial) markWindowComplete();

    renderSubtitleWorkspace();
    if (!automatic) $("#media-status").textContent = partial
      ? `${imported.cues.length} subtitle lines available. Extraction paused${extractionError ? `: ${extractionError}` : ""}. More can load as you watch.`
      : `${imported.cues.length} embedded subtitle lines available`;
    return true;
  } catch (error) {
    if (requestIsCurrent()) {
      // The two-worker subtitle cap can reject a request while other chapters
      // are extracting. A transient 429 should retry on a nearby playback
      // tick, not be treated like unavailable torrent pieces for 60 seconds.
      if (automatic && error?.httpStatus === 429) embeddedSubtitleAttempts.set(attemptKey, Date.now() - 57_000);
      if (imported) {
        imported.embeddedImportPartial = true;

      }
      const failed = controller.signal.aborted
        ? "Subtitle extraction stopped. " + (imported?.cues?.length ? `${imported.cues.length} lines are available.` : "Try Find subtitles or Add file.")
        : error.message || "Couldn't read that track from the video";
      if (!automatic) $("#media-status").textContent = failed;
      renderSubtitleWorkspace();
    }
    return Boolean(imported);
  } finally {
    if (progressTimer !== null) window.clearTimeout(progressTimer);
    window.clearTimeout(timer);
    window.clearTimeout(waitingHintTimer);
    if (embeddedSubtitleImports.get(key) === controller) embeddedSubtitleImports.delete(key);
    if (sourceStillActive()) renderEmbeddedSubtitleControls();
  }
}

let initialEmbeddedSubtitleSource = "";
let initialEmbeddedSubtitleRequestSerial = 0;
export function enableDefaultEmbeddedSubtitles(media, playbackSeconds = 0, { urgent = false } = {}) {
  const source = state.currentSource;
  if (source?.kind !== "torrent") return;
  const key = `${source.sessionId}:${source.fileIndex}:${source.sourceTag}`;
  const candidate = defaultEmbeddedSubtitleTrack({ media, attached: currentSourceTracks(),
    captionsEnabled: state.subtitlesVisible, languages: preferredLanguagePair(), normalizeLanguage: normalizeTrackLanguage });
  if (!candidate) return;
  if (initialEmbeddedSubtitleSource === key) {
    const inFlight = embeddedSubtitleImports.get(embeddedSubtitleImportKey(source, Number(candidate.streamIndex)));
    if (!inFlight || (inFlight.windowStart <= playbackSeconds
      && playbackSeconds < inFlight.windowStart + EMBEDDED_WINDOW_SECONDS
      && (!urgent || Math.abs(playbackSeconds - inFlight.seekPosition) < 12))) return;
  }
  initialEmbeddedSubtitleSource = key;
  const requestSerial = ++initialEmbeddedSubtitleRequestSerial;
  void importEmbeddedSubtitleTrack(candidate, null, { automatic: true, activate: true, startSeconds: playbackSeconds,
    urgent, focused: urgent }).then((loaded) => {
    // Missing torrent pieces or an empty window must not disable automatic
    // attempts for the remainder of playback. An aborted old-window request
    // must not reset a newer seek's default-track extraction.
    if (!loaded && requestSerial === initialEmbeddedSubtitleRequestSerial
      && initialEmbeddedSubtitleSource === key) initialEmbeddedSubtitleSource = "";
  });
}

// Competing far-ahead readers can delay the foreground torrent range on slow
// swarms. Yield ONLY an optional next subtitle window while current captions
// have enough verified coverage. Unknown video buffers fail open, and urgent
// seeks/current-window imports are never held back by this heuristic.
function shouldDeferSpeculativeEmbeddedLookahead({ seeked = false, coverageEnd, seconds } = {}) {
  if (seeked || typeof video === "undefined" || video.paused || video.seeking
    || state.pendingSeek || !Number.isFinite(coverageEnd) || coverageEnd - seconds <= 8) return false;
  if (Number.isFinite(video.readyState) && video.readyState < 3) return true;
  const ranges = video.buffered;
  if (!ranges?.length || !Number.isFinite(Number(video.currentTime))) return false;
  try {
    const now = Number(video.currentTime);
    for (let index = 0; index < ranges.length; index++) {
      if (ranges.start(index) <= now + 0.05 && ranges.end(index) >= now - 0.05)
        return ranges.end(index) - now < 3;
    }
  } catch {}
  return false;
}

export function loadMoreEmbeddedSubtitles({ seeked = false } = {}) {
  if (!frame.classList.contains("has-video") || !state.currentMediaProbe?.subtitleTracks?.length) return;
  const seconds = absolutePlaybackSeconds();
  // Retry the preferred embedded track after a failed initial extraction;
  // importEmbeddedSubtitleTrack already rate-limits attempts per window.
  enableDefaultEmbeddedSubtitles(state.currentMediaProbe, seconds, { urgent: seeked });
  currentSourceTracks().filter((item) => item.origin === "embedded" && item.visible && Number.isInteger(item.embeddedStreamIndex))
    .forEach((track) => {
      const coveredNow = embeddedSubtitleCovers(track, seconds);
      const coveredAhead = embeddedSubtitleCovers(track, seconds + 25);
      if (coveredNow && coveredAhead) return;
      const coverageEnd = coveredNow ? embeddedSubtitleCoverageEnd(track, seconds) : null;
      if (coveredNow && shouldDeferSpeculativeEmbeddedLookahead({ seeked, coverageEnd, seconds })) return;
      const start = coveredNow ? (coverageEnd ?? seconds + 25) : seconds;
      // Existing aligned intervals keep using 180s windows. After a focused
      // seek, extend the covered range from its end instead of re-extracting
      // almost the same three minutes from an old bucket boundary.
      const focused = (seeked && !coveredNow)
        || Boolean(track.embeddedCompletedRanges?.length);
      const meta = state.currentMediaProbe.subtitleTracks.find((item) => Number(item.streamIndex) === track.embeddedStreamIndex);
      if (meta) {
        void importEmbeddedSubtitleTrack(meta, null, { startSeconds: start, automatic: true, urgent: seeked, focused });
      }
    });
}
export function embeddedSubtitleProbePosition(startAtSeconds = 0) {
  // FFprobe can finish seconds after Watch starts. If the user has already
  // sought while it was pending, extracting captions at the ORIGINAL startup
  // position can leave a paused target silent until another timeupdate.
  const pending = state.pendingSeek;
  const target = pending && Number(pending.target);
  if (pending && Number.isFinite(target) && target >= 0) return target;
  const shown = Number(state.currentMs) / 1000;
  return Number.isFinite(shown) && shown >= 0 ? shown : Math.max(0, Number(startAtSeconds) || 0);
}

export function renderEmbeddedSubtitleControls() {
  const container = $("#embedded-subtitle-tracks");
  const section = $("#embedded-subtitle-section");
  if (!container || !section) return;
  const tracks = (state.currentMediaProbe?.subtitleTracks || []).filter((track) => track?.textBased && track.streamIndex !== null && track.streamIndex !== undefined && Number.isInteger(Number(track.streamIndex)));
  section.hidden = !tracks.length;
  if (!tracks.length) {
    container.innerHTML = "";
    return;
  }
  const count = $("#embedded-subtitle-count");
  if (count) count.textContent = `${tracks.length}`;
  container.innerHTML = tracks.map((track, index) => {
    const pending = embeddedSubtitleImports.has(embeddedSubtitleImportKey(state.currentSource, Number(track.streamIndex)));
    const existing = currentSourceTracks().find((item) => Number(item.embeddedStreamIndex) === Number(track.streamIndex));
    const attached = Boolean(existing?.cues?.length);
    const incomplete = Boolean(existing?.embeddedImportPartial);
    const hidden = attached && !existing.visible;
    const language = normalizeTrackLanguage(track.language);
    return `
    <div class="embedded-subtitle-row">
      <div><strong>${escapeHtml(embeddedSubtitleLabel(track, index))}</strong><small>${escapeHtml([language ? trackLanguageName(language) : "", String(track.codec || "text").toUpperCase()].filter(Boolean).join(", "))}</small></div>
      <button class="ui-btn ui-btn--${pending || attached ? "ghost" : "secondary"} ui-btn--sm embedded-subtitle-add" type="button" data-embedded-stream="${Number(track.streamIndex)}" ${attached && !pending && !incomplete && !hidden ? "disabled" : ""}>${pending ? "Cancel import" : incomplete ? "Retry" : hidden ? "Show" : attached ? "Added" : "Add"}</button>
    </div>`;
  }).join("");
  container.querySelectorAll(".embedded-subtitle-add").forEach((button) => button.addEventListener("click", () => {
    const track = tracks.find((item) => Number(item.streamIndex) === Number(button.dataset.embeddedStream));
    if (track) void importEmbeddedSubtitleTrack(track, button);
  }));
}
