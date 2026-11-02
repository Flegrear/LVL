// Subtitles on screen: cues, romanized text, word marks and the track list.
import { normalizeText, segmentText } from "../../learning/browser/core.js";
import { emptyMarkup, escapeHtml, icon } from "../ui/ui.js";
import { frame, learningEnabled, playbackMetrics, state, video } from "../../app.js";
import { $ } from "../app/dom.js";
import { postJson } from "../app/http.js";
import {
  absolutePlaybackSeconds, presentedSubtitleSeconds, refreshSubtitleClockForInteraction,
  seekPlayerTo,
} from "./player-core.js";
import {
  activeTrack, currentSourceTracks, normalizeTrackLanguage, preferredSourceTracks,
  selectSubtitleTrackForCards,
} from "./player-tracks.js";
import {
  allPrimaryCues, comparisonCueForTrack, cuePlaybackBounds, getActiveCue, nudgeSubtitleTracks,
} from "./subtitle-timing.js";
import { renderSubtitleStyleControls } from "./subtitle-style.js";
import { noteSubtitleVisibilityIntent } from "./embedded-subtitles.js";
import {
  cardKeySet, learningItemKey, learningRevision, masteredCardKeySet, recordCueExposure,
} from "../learning/index.js";

const cueTokenCache = new WeakMap();

export let subtitleRenderMemo = { key: "" };

export function isRomanizableLanguage(language) {
  return ["JA", "KO", "ZH", "RU"].includes(String(language || "").toUpperCase());
}

export async function ensureTrackRomanization(track) {
  if (!track?.cues?.length || !isRomanizableLanguage(track.language) || state.subtitleStyle.romanization === false) return;
  if (track.romanizationState === "ready" || track.romanizationState === "loading") return;
  track.romanizationState = "loading";
  try {
    let cursor = 0;
    while (cursor < track.cues.length) {
      const chunk = [];
      const indexes = [];
      let charCount = 0;
      while (cursor < track.cues.length && chunk.length < 60) {
        const text = String(track.cues[cursor]?.text || "");
        if (chunk.length && charCount + text.length > 8_000) break;
        chunk.push(text);
        indexes.push(cursor);
        charCount += text.length;
        cursor += 1;
      }
      const result = await postJson("/api/subtitles/romanize", { language: track.language, texts: chunk });
      (result.romanized || []).forEach((text, index) => {
        const cue = track.cues[indexes[index]];
        if (cue) cue.romanizedText = String(text || "").trim();
      });
    }
    track.romanizationState = "ready";
  } catch (error) {
    track.romanizationState = "error";
    track.romanizationError = error.message || "Romanization failed";
  }
  renderSubtitles();
}

export function ensureCurrentRomanization() {
  if (state.subtitleStyle.romanization === false) return;
  currentSourceTracks().filter((track) => isRomanizableLanguage(track.language)).forEach((track) => {
    void ensureTrackRomanization(track);
  });
}

async function ensureProcessedTrackTokens(track) {
  if (!track?.cues?.length || normalizeTrackLanguage(track.language) !== state.targetLanguage) return;
  if (["loading", "ready", "fallback"].includes(track.learningProcessState)) return;
  track.learningProcessState = "loading";
  try {
    const data = await postJson("/api/learning/subtitles/process", {
      track: {
        id: track.id,
        language: normalizeTrackLanguage(track.language),
        exactMedia: Boolean(track.exactMedia),
        cues: track.cues.map((cue) => ({ id: cue.id, text: cue.text, startMs: cue.startMs, endMs: cue.endMs })),
      },
    });
    const tokenMap = new Map();
    (Array.isArray(data?.artifact?.cues) ? data.artifact.cues : []).forEach((processedCue) => {
      const processedTokens = Array.isArray(processedCue?.tokens) ? processedCue.tokens : Array.isArray(processedCue?.segments) ? processedCue.segments : [];
      if (!processedCue?.id || !processedTokens.length) return;
      tokenMap.set(String(processedCue.id), processedTokens.map((token) => ({
        text: String(token?.text ?? ""),
        normalized: token?.isWord === false ? "" : normalizeText(token?.normalized || token?.text || ""),
        isWord: token?.isWord !== false && Boolean(normalizeText(token?.normalized || token?.text || "")),
      })));
    });
    track.processedLearningArtifact = data?.artifact || null;
    track.processedCueTokens = tokenMap;
    track.learningProcessState = data?.artifact ? "ready" : "fallback";
  } catch {
    track.learningProcessState = "fallback";
  }
  subtitleRenderMemo.key = "";
  renderSubtitles();
}

export function cueSegments(cue, track) {
  const processed = track?.processedCueTokens?.get(String(cue?.id));
  if (processed?.length) return processed;
  const language = normalizeTrackLanguage(track?.language || state.targetLanguage);
  const cached = cueTokenCache.get(cue);
  if (cached?.language === language && cached?.text === cue?.text) return cached.segments;
  const segments = segmentText(cue?.text || "", language);
  cueTokenCache.set(cue, { language, text: cue?.text || "", segments });
  return segments;
}

function learningClassForWord(normalized) {
  if (!normalized) return "";
  const key = learningItemKey(state.targetLanguage, "word", normalized);
  if (state.known.has(key) || masteredCardKeySet().has(key)) return "learning-known";
  if (cardKeySet().has(key)) return "learning-review";
  const rank = state.learningPreset?.language === state.targetLanguage && state.learningPreset?.status === "ready"
    ? state.learningPreset.wordRank?.get(normalized)
    : null;
  if (rank && rank <= 100) return "learning-common-100";
  if (rank && rank <= 1000) return "learning-common-1000";
  if (rank && rank <= 5000) return "learning-common-5000";
  return "";
}

function appendLearningCue(line, cue, track) {
  if (!state.wordColoring) {
    line.textContent = cue.text;
    return;
  }
  cueSegments(cue, track).forEach((segment) => {
    if (!segment.isWord) {
      line.append(document.createTextNode(segment.text));
      return;
    }
    const span = document.createElement("span");
    const learningClass = learningClassForWord(segment.normalized);
    if (learningClass) span.className = `subtitle-word ${learningClass}`;
    span.textContent = segment.text;
    line.append(span);
  });
}

export function cuePlaybackMs(cue, track = activeTrack()) {
  return cuePlaybackBounds(cue, track).startMs;
}

export function currentCueIndex() {
  const track = activeTrack();
  const cues = allPrimaryCues();
  if (!cues.length) return -1;
  const index = cues.findIndex((cue) => {
    const bounds = cuePlaybackBounds(cue, track);
    return state.currentMs >= bounds.startMs && state.currentMs <= bounds.endMs;
  });
  if (index >= 0) return index;
  return Math.max(0, cues.findLastIndex((cue) => cuePlaybackBounds(cue, track).startMs <= state.currentMs));
}

export function seekTo(ms) {
  state.currentMs = Math.max(0, ms);
  if (frame.classList.contains("has-video")) {
    if (video.dataset.mode === "transcode") seekPlayerTo(state.currentMs / 1000);
    else if (Number.isFinite(video.duration)) seekPlayerTo(state.currentMs / 1000);
  }
  renderSubtitles();
}

export function renderSubtitles() {
  const overlay = $("#subtitle-overlay");
  if (!state.subtitlesVisible) {
    if (subtitleRenderMemo.key !== "hidden") overlay.innerHTML = "";
    subtitleRenderMemo.key = "hidden";
    return;
  }
  const visibleTracks = preferredSourceTracks().filter((track) => track.visible);
  const orderedTracks = visibleTracks.slice().sort((a, b) => {
    const aLanguage = String(a.language || "").toUpperCase();
    const bLanguage = String(b.language || "").toUpperCase();
    const aRank = aLanguage === state.baseLanguage ? 0 : aLanguage === state.targetLanguage ? 1 : 2;
    const bRank = bLanguage === state.baseLanguage ? 0 : bLanguage === state.targetLanguage ? 1 : 2;
    return aRank - bRank;
  });
  const selectedTrack = activeTrack();
  const activeCues = new Map(visibleTracks.map((track) => [track.id, getActiveCue(track)]));
  const primaryTrack = visibleTracks.find((track) => activeCues.get(track.id)) || selectedTrack;
  const primaryCue = primaryTrack ? activeCues.get(primaryTrack.id) || getActiveCue(primaryTrack) : null;
  const rendered = orderedTracks.map((track) => ({ track, cue: comparisonCueForTrack(track, primaryTrack, primaryCue) }));
  const selectedCue = selectedTrack ? activeCues.get(selectedTrack.id) || getActiveCue(selectedTrack) : null;
  if (state.pauseAfterCue && state.lastCueId && selectedCue && selectedCue.id !== state.lastCueId && !video.paused) video.pause();
  state.lastCueId = selectedCue?.id || state.lastCueId;
  const targetPair = rendered.find(({ track, cue }) => cue && normalizeTrackLanguage(track.language) === state.targetLanguage);
  if (targetPair && learningEnabled) {
    recordCueExposure(targetPair.track, targetPair.cue);
    if (state.wordColoring && !["loading", "ready", "fallback"].includes(targetPair.track.learningProcessState)) void ensureProcessedTrackTokens(targetPair.track);
  }
  const renderKey = `${state.subtitlesVisible}|${state.targetLanguage}|${state.subtitleStyle.romanization}|${state.wordColoring}|${learningRevision}|${rendered.map(({ track, cue }) => `${track.id}:${cue?.id || "-"}:${cue?.romanizedText || ""}`).join("|")}`;
  if (subtitleRenderMemo.key === renderKey) return;
  if (typeof playbackMetrics !== "undefined" && playbackMetrics) playbackMetrics.record("subtitle-cue-change", {
    playbackSeconds: absolutePlaybackSeconds(),
    visibleTracks: visibleTracks.length,
    activeCues: rendered.filter(({ cue }) => Boolean(cue)).length,
    selectedTrackOffsetMs: Number.isFinite(Number(selectedTrack?.offsetMs)) ? Number(selectedTrack.offsetMs) : null,
    presentedClockSeconds: presentedSubtitleSeconds(),
  });
  subtitleRenderMemo.key = renderKey;
  overlay.innerHTML = "";
  rendered.forEach(({ track, cue }) => {
    if (!cue) return;
    const line = document.createElement("div");
    // Learning shows the target-language line as the one being studied (full
    // size, word tools, romanized) and other languages smaller. Without
    // Learning, every shown line uses the size and settings from Appearance,
    // so switching or adding a track never changes how subtitles look.
    const isTarget = normalizeTrackLanguage(track.language) === state.targetLanguage;
    const isMain = !learningEnabled || isTarget;
    line.className = `subtitle-line${isMain ? "" : " secondary"}`;
    if (isTarget && learningEnabled) appendLearningCue(line, cue, track); else line.textContent = cue.text;
    overlay.append(line);
    if (isMain && state.subtitleStyle.romanization !== false && isRomanizableLanguage(track.language)) {
      if (!cue.romanizedText && track.romanizationState !== "loading") void ensureTrackRomanization(track);
      if (cue.romanizedText && cue.romanizedText !== cue.text) {
        const romanized = document.createElement("div");
        romanized.className = "subtitle-line romanized";
        romanized.textContent = cue.romanizedText;
        overlay.append(romanized);
      }
    }
  });
}

export function trackLanguageName(code) {
  const value = String(code || "").trim();
  if (!/^[a-z]{2,3}$/i.test(value)) return value || "Unknown language";
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(value.toLowerCase()) || value.toUpperCase();
  } catch {
    return value.toUpperCase();
  }
}

// One card per subtitle track: language, name, a switch to show it on the video,
// its line count and sync state, the track cards are made from, and a manual timing shift.
export function renderTracks() {
  const list = $("#track-list");
  const scopedTracks = preferredSourceTracks();
  $("#track-count").textContent = scopedTracks.length;
  if (!scopedTracks.length) {
    list.innerHTML = emptyMarkup({
      compact: true,
      icon: "subtitles",
      title: "No subtitles yet",
      text: frame.classList.contains("has-video") ? "Find them online, or drop an .srt or .vtt file here." : "Play something, then find subtitles for it.",
    });
    return;
  }
  list.innerHTML = scopedTracks.map((track) => {
    const language = normalizeTrackLanguage(track.language) || String(track.language || "?").toUpperCase();
    const label = escapeHtml(track.label);
    const trackShown = track.visible && state.subtitlesVisible;
    const role = state.selectedTrackId === track.id;
    const syncing = track.audioSync?.status === "syncing" && track.syncSource !== "audio";
    return `<article class="track-card${track.visible ? " is-visible" : ""}" data-track-id="${escapeHtml(track.id)}">
      <div class="track-card-head">
        <span class="track-lang" title="${escapeHtml(trackLanguageName(language))}">${escapeHtml(language)}</span>
        <span class="track-name" title="${label}">${label}</span>
        <label class="ui-switch track-switch" title="Toggle this subtitle track"><span class="track-visibility-label">${trackShown ? "Showing" : track.visible ? "Captions off" : "Hidden"}</span><input class="track-visible" type="checkbox" ${track.visible ? "checked" : ""} aria-label="${track.visible ? "Hide" : "Show"} ${label} on the video"><span class="ui-switch__track" aria-hidden="true"></span></label>
      </div>
      <div class="track-meta">
        <span class="track-line-count">${track.cues.length.toLocaleString()} lines</span>
        <button type="button" class="track-sync-state ui-tip-text${syncing ? " is-busy" : ""}" data-ui-tip="${escapeHtml(trackTipId(track))}" aria-describedby="${escapeHtml(trackTipId(track))}">${escapeHtml(trackSyncSummary(track))}</button>
        <span id="${escapeHtml(trackTipId(track))}" class="ui-tip-content" hidden>${trackSyncExplanation(track)}</span>
      </div>
      <div class="track-controls">
        <button class="ui-chip track-role" type="button" aria-pressed="${role}" title="Words, phrases and cards come from this track">${role ? `${icon("check")}Used for cards` : "Use for cards"}</button>
        ${track.exactMedia ? "" : `<span class="track-shift" role="group" aria-label="Shift ${label}">
          <button class="ui-btn ui-btn--ghost ui-btn--sm offset-minus" type="button" aria-label="Show ${label} 0.5 seconds earlier">−0.5 s</button>
          <button class="ui-btn ui-btn--ghost ui-btn--sm offset-plus" type="button" aria-label="Show ${label} 0.5 seconds later">+0.5 s</button>
        </span>`}
      </div>
    </article>`;
  }).join("");

  list.querySelectorAll(".track-card").forEach((card) => {
    const track = state.tracks.find((item) => item.id === card.dataset.trackId);
    card.querySelector(".track-visible").addEventListener("change", (event) => {
      noteSubtitleVisibilityIntent();
      refreshSubtitleClockForInteraction();
      track.visible = event.target.checked;
      if (track.visible && !state.subtitlesVisible) {
        state.subtitlesVisible = true;
        renderSubtitleStyleControls();
      }
      card.classList.toggle("is-visible", track.visible);
      card.querySelector(".track-visibility-label").textContent = track.visible ? "Showing" : "Hidden";
      event.target.setAttribute("aria-label", `${track.visible ? "Hide" : "Show"} ${track.label} on the video`);
      subtitleRenderMemo.key = "";
      renderSubtitles();
    });
    card.querySelector(".track-role").addEventListener("click", () => {
      selectSubtitleTrackForCards(track);
    });
    card.querySelector(".offset-minus")?.addEventListener("click", () => nudgeSubtitleTracks(-500, [track]));
    card.querySelector(".offset-plus")?.addEventListener("click", () => nudgeSubtitleTracks(500, [track]));
  });
}

function trackTipId(track) {
  return `tip-${String(track?.id || "track").replace(/[^a-zA-Z0-9_-]+/g, "-")}`;
}

// What a track's sync status means, in plain words (shown on hover, focus or tap).
function trackSyncExplanation(track) {
  const seconds = (ms) => `${(Math.abs(ms) / 1000).toFixed(1)} s`;
  const direction = (ms) => (ms < 0 ? "earlier" : "later");
  const manual = Number(track?.offsetMs || 0);
  const manualNote = manual ? `<p>You also moved it ${seconds(manual)} ${direction(manual)} by hand.</p>` : "";
  if (track?.exactMedia) return `<strong>Timing from the video file</strong><p>This track is stored inside the video, so it already matches it and isn't changed.</p>${manualNote}`;
  const offsets = (Array.isArray(track?.syncAnchors) ? track.syncAnchors : []).map((anchor) => Number(anchor?.offsetMs) || 0);
  const low = offsets.length ? Math.min(...offsets) : 0;
  const high = offsets.length ? Math.max(...offsets) : 0;
  if (track?.syncSource === "audio") {
    const shape = track.syncMode === "linear-drift"
      ? `<p>The file runs at a slightly different speed (another frame rate), so the shift changes from ${seconds(low)} to ${seconds(high)} over the episode.</p>`
      : track.syncMode === "piecewise-step"
        ? `<p>The file was made for a different cut of the video (for example without a recap), so the shift jumps at the cut: between ${seconds(low)} and ${seconds(high)}.</p>`
        : `<p>Its lines are shown ${seconds(low)} ${direction(low)} than the file says.</p>`;
    const origin = track.audioSync?.saved
      ? "<p>Saved from an earlier viewing of this episode.</p>"
      : track.audioSync?.windows ? `<p>Measured from ${track.audioSync.windows} stretch${track.audioSync.windows === 1 ? "" : "es"} of audio that already played.</p>` : "";
    return `<strong>Matched to the speech</strong>${shape}${origin}${manualNote}`;
  }
  if (track?.audioSync?.status === "syncing" && track.syncFollowing && !track.syncRejected) {
    return `<strong>Following the ${escapeHtml(track.syncFollowing)} track</strong><p>This track isn't matched to the audio yet. Until it is, it follows the timing of the track that is, so both languages stay on screen together.</p>${manualNote}`;
  }
  if (track?.audioSync?.status === "waiting") return `<strong>Waiting for audio</strong><p>Audio matching starts when enough playable speech is available. Keep the episode playing, or try a different subtitle release if timing is far off.</p>${manualNote}`;
  if (track?.audioSync?.status === "syncing") return `<strong>Matching to the speech</strong><p>Checking short stretches of available audio. A match is not guaranteed when subtitles were made for a different release.</p>${manualNote}`;
  if (track?.audioSync?.status === "failed") return `<strong>Couldn't match the audio</strong><p>Audio may be unavailable or the subtitles may belong to another release. Try a different subtitle file, or use ±0.5 s for small timing errors.</p>${manualNote}`;
  if (offsets.length && !track?.syncRejected) return `<strong>Lined up with another track</strong><p>Matched line by line to the other subtitle track: ${seconds(low)} ${direction(low)} than the file says.</p>${manualNote}`;
  return `<strong>Not synced</strong><p>Matching to the speech works for videos played from a torrent; this track keeps the file's own timing. Use ±0.5 s or <kbd>G</kbd> <kbd>H</kbd> to move it.</p>${manualNote}`;
}

function trackSyncSummary(track) {
  const seconds = (ms) => `${ms >= 0 ? "+" : "−"}${(Math.abs(ms) / 1000).toFixed(1)} s`;
  const manual = Number(track?.offsetMs || 0);
  const shift = manual ? `, shifted ${seconds(manual)}` : "";
  if (track?.exactMedia) return "From the video file";
  const offsets = (Array.isArray(track?.syncAnchors) ? track.syncAnchors : []).map((anchor) => Number(anchor?.offsetMs) || 0);
  const range = offsets.length
    ? (Math.max(...offsets) - Math.min(...offsets) <= 100 ? seconds(offsets[0]) : `${seconds(Math.min(...offsets))} to ${seconds(Math.max(...offsets))}`)
    : "";
  if (track?.syncSource === "audio") return `Synced to audio ${range}${shift}`;
  if (track?.audioSync?.status === "syncing" && track?.syncFollowing && !track?.syncRejected) return `Following ${track.syncFollowing}, syncing…${shift}`;
  if (track?.audioSync?.status === "syncing") return `Syncing to audio…${shift}`;
  if (track?.audioSync?.status === "waiting") return `Waiting for audio…${shift}`;
  if (track?.audioSync?.status === "failed") return `Couldn't sync to audio${range ? ` (${range})` : ""}${shift}`;
  if (offsets.length && !track?.syncRejected) return `Matched to another track ${range}${shift}`;
  return manual ? `Shifted ${seconds(manual)}` : "Not synced";
}
