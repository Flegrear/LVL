// Lines subtitles up with the audio, and the sync status chip.
import { syncTrackToSpeech } from "../../shared/subtitles/subtitle-sync.js";
import { audioSync, learningEnabled, pairedCueMemo, state, video } from "../../app.js";
import { saveLibrary } from "../app/saved-state.js";
import { $ } from "../app/dom.js";
import { fetchJson } from "../app/http.js";
import { currentSourceTracks, normalizeTrackLanguage } from "./player-tracks.js";
import { renderSubtitles, renderTracks, subtitleRenderMemo } from "./subtitle-display.js";
import { subtitleFingerprint, syncTrackToBestReference } from "./subtitle-timing.js";
import { refreshEpisodeCardPairs } from "./subtitle-pairing.js";
import { currentLibraryEpisode } from "../watch/watched-status.js";
import { saveCurrentEpisodeAnalysis } from "../learning/vocabulary-cards.js";

/* ---------------------------------------------------------------- Subtitle sync to the audio */

// Every downloaded or imported subtitle track is lined up with what is actually said in the video
// (subtitle-sync.js): short audio windows around the playhead as you watch, frame-rate
// mismatches and cuts included. Tracks from the file itself (embedded) are exact and stay as they
// are. Models are saved per episode and subtitle file, so a re-watch is synced right away.
const AUDIO_SYNC_WINDOW_S = 45;
const AUDIO_SYNC_MIN_WINDOW_S = 20;
const AUDIO_SYNC_MAX_WINDOWS = 24;

let playerSyncChipTimer = 0;
let playerSyncChipState = "";

export function audioSyncSource() {
  const source = state.currentSource;
  if (source?.kind !== "torrent" || !source.sessionId || source.fileIndex === null || source.fileIndex === undefined) return null;
  return { sessionId: source.sessionId, fileIndex: Number(source.fileIndex), audio: Math.max(0, Number(state.selectedAudioTrack) || 0) };
}

function audioSyncKey(source = audioSyncSource()) {
  return source ? `${source.sessionId}:${source.fileIndex}:${source.audio}` : "";
}

export function audioSyncTracks() {
  return currentSourceTracks().filter((track) => track.cues?.length && !track.exactMedia);
}

export function resetAudioSync() {
  window.clearTimeout(audioSync.timer);
  const previousKey = audioSync.key;
  const nextKey = audioSyncKey();
  // The same episode can have differently edited language dubs. An audio
  // model verified against dub A must not be reused for dub B. Preserve manual
  // shifts, saved caption text and embedded timestamps.
  if (previousKey && previousKey !== nextKey
    && previousKey.slice(0, previousKey.lastIndexOf(":")) === nextKey.slice(0, nextKey.lastIndexOf(":"))) {
    currentSourceTracks().filter((track) => !track.exactMedia).forEach((track) => {
      if (track.syncSource === "audio" || track.syncFollowsId) {
        // Keep last displayed positions provisionally while the new dub is
        // analysed. Clearing anchors makes all captions miss the playhead.
        // This is not a verified model for the new audio selection.
        track.syncSource = "provisional";
      }
      track.audioSync = { status: "waiting", windows: 0 };
      // Subtitle alignment is specific to the audio dub. Switching back to a
      // previously analysed dub must restore its own saved model immediately,
      // rather than showing no cues while speech analysis warms up again.
      applySavedSubtitleSync(track);
    });
    pairedCueMemo.clear();
    subtitleRenderMemo.key = "";
  }
  Object.assign(audioSync, { key: nextKey, generation: audioSync.generation + 1, windows: [], caches: new Map(), pending: false, timer: 0, timerDueAt: 0, failures: 0, lastCheckMs: -Infinity });
  state.tracks.forEach((track) => { delete track.syncFollowsId; });
  playerSyncChipState = "";
  updatePlayerSyncStatus();
}

export function scheduleAudioSync(delayMs = 500) {
  if (!audioSyncSource() || !audioSyncTracks().length) return;
  // Seeking/timeupdate may already have queued a near-term coverage check.
  // A later "playing" event must not push that check back by another 1.5 s.
  const dueAt = Date.now() + Math.max(0, delayMs);
  if (audioSync.timer && audioSync.timerDueAt && audioSync.timerDueAt <= dueAt) return;
  window.clearTimeout(audioSync.timer);
  audioSync.timerDueAt = dueAt;
  audioSync.timer = window.setTimeout(() => {
    audioSync.timer = 0;
    audioSync.timerDueAt = 0;
    void runAudioSyncStep();
  }, Math.max(0, delayMs));
}

// An explicit unwatch must survive timeupdate/pause events from a video that
// was already near its ending. A subsequent rewatch arms completion only
// after playback has returned to an earlier part of that episode.
export const explicitUnwatchCompletionArmed = new Set();

function trackSyncKey(track) {
  return String(track?.fingerprint || subtitleFingerprint(track?.cues || [])).slice(0, 400);
}

// A model saved for this episode and subtitle file (from an earlier viewing) applies at once.
export function applySavedSubtitleSync(track) {
  const store = currentLibraryEpisode()?.episode?.subtitleSync || {};
  const audioIndex = Math.max(0, Number(state.selectedAudioTrack) || 0);
  const fingerprint = trackSyncKey(track);
  // Older releases stored one model for every dub. Only audio zero can use
  // that legacy record; all new models are keyed by the selected audio track.
  const saved = store[`${fingerprint}:audio:${audioIndex}`]
    || (audioIndex === 0 ? store[fingerprint] : null);
  if (saved && Number(saved.audioIndex ?? 0) !== audioIndex) return false;
  if (!saved?.anchors?.length || track.exactMedia) return false;
  track.syncSource = "audio";
  track.syncMode = String(saved.mode || "constant");
  track.syncAnchors = saved.anchors.map((anchor) => ({ ...anchor }));
  track.syncRejected = false;
  track.audioSync = { status: "synced", saved: true, windows: 0 };
  return true;
}

function saveSubtitleSync(track, model) {
  const current = currentLibraryEpisode();
  if (!current) return;
  const store = current.episode.subtitleSync && typeof current.episode.subtitleSync === "object" ? current.episode.subtitleSync : {};
  const audioIndex = Math.max(0, Number(state.selectedAudioTrack) || 0);
  store[`${trackSyncKey(track)}:audio:${audioIndex}`] = {
    mode: model.mode, anchors: model.anchors, audioIndex, savedAt: Date.now(),
  };
  const keys = Object.keys(store);
  if (keys.length > 8) keys.sort((a, b) => (store[a].savedAt || 0) - (store[b].savedAt || 0)).slice(0, keys.length - 8).forEach((key) => delete store[key]);
  current.episode.subtitleSync = store;
  current.entry.updatedAt = Date.now();
  saveLibrary();
}

// Audio that can be analysed without downloading or decoding anything new: what the playback
// conversion has already turned into audio (kept by the server), or what the browser has
// buffered for direct play (already on disk).
export async function audioReadyRanges(source) {
  if (video.dataset.mode === "transcode") {
    try {
      const data = await fetchJson(`/api/torrents/${encodeURIComponent(source.sessionId)}/files/${source.fileIndex}/speech?coverage=1&audio=${source.audio}`);
      const ranges = (data.ranges || []).map((range) => ({ fromMs: Number(range.fromMs) || 0, toMs: Number(range.toMs) || 0, live: true }));
      if (ranges.length) return ranges;
    } catch {}
    // No kept audio (older server or unknown tracks): what already played here is on disk.
    const playedFrom = state.transcodeRequestedStartSeconds * 1000;
    return state.currentMs > playedFrom ? [{ fromMs: playedFrom, toMs: state.currentMs, live: false }] : [];
  }
  const ranges = [];
  for (let index = 0; index < (video.buffered?.length || 0); index += 1) {
    ranges.push({ fromMs: video.buffered.start(index) * 1000, toMs: video.buffered.end(index) * 1000, live: false });
  }
  return ranges;
}

function analysedShare(fromMs, toMs) {
  let covered = 0;
  for (const item of audioSync.windows) covered += Math.max(0, Math.min(toMs, item.startMs + item.durationMs) - Math.max(fromMs, item.startMs));
  return toMs > fromMs ? Math.min(1, covered / (toMs - fromMs)) : 1;
}

function nextAudioSyncWindow(ranges, durationMs) {
  const windowMs = AUDIO_SYNC_WINDOW_S * 1000;
  const minMs = AUDIO_SYNC_MIN_WINDOW_S * 1000;
  if (audioSync.windows.length >= AUDIO_SYNC_MAX_WINDOWS) return null;
  const now = state.currentMs;
  const candidates = [];
  for (const range of ranges) {
    const fromMs = Math.max(0, range.fromMs);
    const toMs = Math.min(durationMs || range.toMs, range.toMs);
    if (toMs - fromMs < minMs) continue;
    // Tile the ready stretch; the window holding the playhead (ending up to 30 s past it) first.
    const anchor = Math.min(Math.max(fromMs, now - windowMs + 30_000), Math.max(fromMs, toMs - windowMs));
    const starts = new Set([anchor]);
    for (let start = anchor - windowMs + 10_000; start > fromMs - windowMs; start -= windowMs - 10_000) starts.add(Math.max(fromMs, start));
    for (let start = anchor + windowMs - 10_000; start < toMs - minMs; start += windowMs - 10_000) starts.add(start);
    for (const start of starts) {
      const end = Math.min(toMs, start + windowMs);
      if (end - start < minMs || analysedShare(start, end) > 0.5) continue;
      const distance = now >= start && now <= end + 30_000 ? 0 : Math.min(Math.abs(now - start), Math.abs(now - end));
      candidates.push({ startMs: Math.round(start), durationMs: Math.round(end - start), live: range.live, distance });
    }
  }
  candidates.sort((a, b) => a.distance - b.distance);
  if (candidates.length) return candidates[0];
  // A track jumped between two windows (a cut): fill the gap between them to place the cut, only
  // behind the playhead (already downloaded; decoded on the server if it didn't play here).
  const lastStart = Math.max(0, durationMs - windowMs);
  for (const track of audioSyncTracks()) {
    if (track.syncMode !== "piecewise-step") continue;
    const anchors = (track.syncAnchors || []).slice().sort((a, b) => a.atMs - b.atMs);
    for (let index = 1; index < anchors.length; index += 1) {
      if (anchors[index - 1].located) continue;
      const fromMs = anchors[index - 1].atMs + anchors[index - 1].offsetMs;
      const toMs = anchors[index].atMs + anchors[index].offsetMs;
      for (let startMs = Math.max(0, fromMs); startMs < toMs; startMs += windowMs) {
        const start = Math.min(lastStart, startMs);
        if (start + windowMs > now + 30_000) break;
        if (analysedShare(start, start + windowMs) < 0.9) return { startMs: start, durationMs: windowMs, live: false, distance: 0 };
      }
    }
  }
  return null;
}

export function decodeBase64Bytes(value) {
  const binary = atob(String(value || ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function runAudioSyncStep() {
  const source = audioSyncSource();
  if (!source) return;
  const key = audioSyncKey(source);
  if (audioSync.key !== key) resetAudioSync();
  if (audioSync.pending || !audioSyncTracks().length) return;
  // Resetting for a new audio dub releases the old slot. A stale async step
  // must not release or alter the newer dub's in-flight sync request.
  const generation = audioSync.generation;
  const durationMs = Number(state.mediaDurationMs) || 0;
  if (!durationMs || !$("#video-loading")?.hidden) {
    scheduleAudioSync(3000);
    return;
  }
  audioSync.pending = true;
  let slot = null;
  try {
    const ranges = await audioReadyRanges(source);
    if (audioSync.generation !== generation || audioSyncKey() !== key) return;
    slot = nextAudioSyncWindow(ranges, durationMs);
  } finally {
    if (audioSync.generation === generation) audioSync.pending = false;
  }
  if (!slot) {
    // A valid audio range may not exist yet. Don't show "Syncing" forever
    // while no analysis is actually running (e.g. stalled peers or an intro).
    let waiting = false;
    audioSyncTracks().forEach((track) => {
      if (track.syncSource !== "audio" && track.audioSync?.status !== "failed"
        && track.audioSync?.status !== "waiting") {
        track.audioSync = { ...(track.audioSync || {}), status: "waiting" };
        waiting = true;
      }
    });
    if (waiting) renderTracks();
    if (audioSyncTracks().some((track) => track.syncSource !== "audio")) scheduleAudioSync(3000);
    updatePlayerSyncStatus();
    return;
  }
  audioSync.pending = true;
  audioSyncTracks().forEach((track) => {
    if (!track.audioSync || ["failed", "waiting"].includes(track.audioSync.status)) track.audioSync = { ...(track.audioSync || {}), status: track.syncSource === "audio" ? "synced" : "syncing" };
  });
  renderTracks();
  updatePlayerSyncStatus();
  try {
    const params = new URLSearchParams({ start: (slot.startMs / 1000).toFixed(2), duration: (slot.durationMs / 1000).toFixed(2), audio: String(source.audio) });
    if (slot.live) params.set("live", "only");
    const response = await fetch(`/api/torrents/${encodeURIComponent(source.sessionId)}/files/${source.fileIndex}/speech?${params}`, { signal: AbortSignal.timeout(52_000) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data.error || `Audio analysis failed (${response.status})`), { status: response.status });
    if (audioSync.generation !== generation || audioSyncKey() !== key) return;
    audioSync.windows.push({ startMs: Number(data.startMs) || 0, durationMs: Number(data.durationMs) || 0, activity: decodeBase64Bytes(data.activity) });
    audioSync.failures = 0;
    applyAudioSync();
    scheduleAudioSync(2500);
  } catch (error) {
    if (audioSync.generation !== generation || audioSyncKey() !== key) return;
    audioSync.failures += 1;
    // No playable audio or a timed-out torrent cannot be fixed by immediately
    // repeating the same expensive FFmpeg request. Surface an actionable state.
    if ([400, 404, 422, 504].includes(error?.status) || error?.name === "TimeoutError")
      audioSync.failures = 4;
    if (audioSync.failures < 4) {
      scheduleAudioSync(error.status === 429 ? 3000 : 6000 * audioSync.failures);
    } else {
      audioSyncTracks().forEach((track) => {
        if (track.syncSource !== "audio") track.audioSync = { status: "failed", error: error.message };
      });
      renderTracks();
    }
  } finally {
    if (audioSync.generation === generation) audioSync.pending = false;
  }
}

function applyAudioSync() {
  let changed = false;
  for (const track of audioSyncTracks()) {
    const cacheKey = `${track.id}:${trackSyncKey(track)}`;
    if (!audioSync.caches.has(cacheKey)) audioSync.caches.set(cacheKey, new Map());
    const fit = syncTrackToSpeech(audioSync.windows, track.cues, { cache: audioSync.caches.get(cacheKey) });
    const model = fit?.model;
    const tried = audioSync.windows.length;
    if (model) {
      const before = JSON.stringify([track.syncMode, track.syncAnchors]);
      track.syncSource = "audio";
      track.syncMode = model.mode;
      track.syncAnchors = model.anchors;
      track.syncRejected = false;
      track.syncConfidence = Math.max(...model.anchors.map((anchor) => Number(anchor.confidence) || 0));
      track.audioSync = { status: "synced", windows: tried };
      if (before !== JSON.stringify([track.syncMode, track.syncAnchors])) {
        changed = true;
        saveSubtitleSync(track, model);
      }
    } else {
      // Keep looking while windows are left; after a few without a match, say so.
      track.audioSync = { status: tried >= 3 && track.syncSource !== "audio" ? "failed" : (track.syncSource === "audio" ? "synced" : "syncing"), windows: tried };
    }
  }
  // A track without its own match yet follows one that has it (line-by-line alignment), so the
  // second language doesn't drift off screen while its sync is still being worked out.
  const reference = audioSyncTracks().find((track) => track.syncSource === "audio");
  if (reference) {
    for (const track of audioSyncTracks()) {
      if (track.syncSource === "audio" || track.syncFollowsId === `${reference.id}:${JSON.stringify(reference.syncAnchors)}`) continue;
      const before = JSON.stringify([track.syncMode, track.syncAnchors]);
      syncTrackToBestReference(track);
      track.syncFollowsId = `${reference.id}:${JSON.stringify(reference.syncAnchors)}`;
      if (!track.syncRejected) track.syncFollowing = normalizeTrackLanguage(reference.language) || "other track";
      if (before !== JSON.stringify([track.syncMode, track.syncAnchors])) changed = true;
    }
  }
  renderTracks();
  updatePlayerSyncStatus();
  if (!changed) return;
  pairedCueMemo.clear();
  subtitleRenderMemo.key = "";
  renderSubtitles();
  const repaired = learningEnabled ? refreshEpisodeCardPairs() : 0;
  if (learningEnabled) saveCurrentEpisodeAnalysis();
  const synced = audioSyncTracks().filter((track) => track.syncSource === "audio").length;
  $("#media-status").textContent = `Subtitles synced to audio${synced > 1 ? ` (${synced} tracks)` : ""}${repaired ? `; ${repaired} card${repaired === 1 ? "" : "s"} re-paired` : ""}`;
}

// Called from timeupdate: a playhead away from every analysed window gets its own window.
export function checkAudioSyncCoverage() {
  if (!audioSync.key || audioSync.pending || Math.abs(state.currentMs - audioSync.lastCheckMs) < 5000) return;
  audioSync.lastCheckMs = state.currentMs;
  const covered = audioSync.windows.some((item) => state.currentMs >= item.startMs - 30_000 && state.currentMs <= item.startMs + item.durationMs + 60_000);
  const jumped = audioSyncTracks().some((track) => track.syncMode === "piecewise-step" && (track.syncAnchors || []).some((anchor, index, list) => index < list.length - 1 && !anchor.located));
  if (!covered || jumped) scheduleAudioSync(800);
}

// Small chip on the player: shown while subtitles are being synced, briefly once they are.
export function updatePlayerSyncStatus() {
  const chip = $("#player-sync-status");
  if (!chip) return;
  const tracks = audioSyncSource() ? audioSyncTracks() : [];
  const synced = tracks.filter((track) => track.syncSource === "audio");
  const waiting = tracks.filter((track) => track.syncSource !== "audio" && track.audioSync?.status === "syncing");
  const failed = tracks.filter((track) => track.syncSource !== "audio" && track.audioSync?.status === "failed");
  const stateKey = !tracks.length ? "none" : waiting.length ? `busy:${synced.length}:${waiting.length}` : failed.length && !synced.length ? "failed" : synced.length ? "done" : "none";
  if (stateKey === playerSyncChipState) return;
  playerSyncChipState = stateKey;
  window.clearTimeout(playerSyncChipTimer);
  const busy = stateKey.startsWith("busy");
  chip.classList.toggle("is-busy", busy);
  if (stateKey === "none") {
    chip.hidden = true;
    return;
  }
  chip.textContent = busy ? (synced.length ? `Syncing subtitles, ${waiting.length} left` : "Syncing subtitles")
    : stateKey === "failed" ? "Subtitles not synced"
      : "Subtitles synced";
  chip.hidden = false;
  if (!busy) playerSyncChipTimer = window.setTimeout(() => { chip.hidden = true; }, stateKey === "failed" ? 8000 : 4000);
}
