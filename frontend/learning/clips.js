// Learning: saved lines (clips).
import { normalizeText } from "../../learning/browser/core.js";
import { isNonSpeechCue } from "../../shared/subtitles/subtitle-sync.js";
import { learningEnabled, state } from "../../app.js";
import { saveState } from "../app/saved-state.js";
import { $ } from "../app/dom.js";
import { currentSourceTracks, normalizeTrackLanguage } from "../player/player-tracks.js";
import { pairedBaseLines, trackTimingTrusted, videoCuesForTrack } from "../player/subtitle-pairing.js";
import { audioReadyRanges, audioSyncSource } from "../player/audio-sync.js";
import { currentLibraryEpisode } from "../watch/watched-status.js";
import { dictation } from "./study-page.js";

/* ---------------------------------------------------------------- Saved lines (clips) */

// A torrent's downloaded pieces are deleted when its session ends, so a card that only pointed at
// a timestamp could not be heard again later. While an episode plays, the lines of its cards (and
// up to 40 other lines, for dictation) are cut from the stretch that already played: audio and a
// still frame, saved in the data folder. Card clips stay as long as the card does.
const CLIP_DICTATION_PER_EPISODE = 40;
const clipPlanner = { key: "", done: new Set(), failed: new Map(), pending: false, timer: 0, saveTimer: 0 };

function clipEpisodeLabel() {
  const current = currentLibraryEpisode();
  return {
    series: String(current?.entry?.displayTitle || current?.entry?.title || state.currentSource?.title || "").slice(0, 200),
    chapter: String(current?.episode?.code || "").slice(0, 40),
  };
}

function clipCandidates() {
  const source = state.currentSource;
  const tracks = currentSourceTracks().filter((track) => track.cues?.length);
  const target = tracks.find((track) => normalizeTrackLanguage(track.language) === state.targetLanguage);
  if (!source?.libraryId || !target || !trackTimingTrusted(target)) return [];
  const base = tracks.find((track) => normalizeTrackLanguage(track.language) === state.baseLanguage);
  const baseTrusted = Boolean(base && trackTimingTrusted(base));
  const cues = videoCuesForTrack(target).filter((cue) => !isNonSpeechCue(cue.text) && cue.endMs - cue.startMs >= 600 && cue.endMs - cue.startMs <= 12_000);
  if (!cues.length) return [];
  const items = new Map();
  const add = (cue, kind, cardId = null) => {
    const key = `${cue.startMs}:${cue.endMs}`;
    const item = items.get(key) || { key, cue, kind, cardIds: [] };
    if (kind === "card") item.kind = "card";
    if (cardId) item.cardIds.push(cardId);
    items.set(key, item);
  };
  const clean = (text) => normalizeText(String(text || "")).replace(/\s+/g, " ").trim();
  for (const card of state.cards) {
    if (card.clipId || !card.context || String(card.sourceLibraryId) !== String(source.libraryId) || String(card.sourceFileIndex) !== String(source.fileIndex)) continue;
    const wanted = clean(card.context);
    let best = null;
    for (const cue of cues) {
      if (clean(cue.text) !== wanted) continue;
      const distance = Math.abs(cue.startMs - Number(card.timestampMs || 0));
      if (!best || distance < best.distance) best = { cue, distance };
    }
    if (best) add(best.cue, "card", card.id);
  }
  const lines = cues.filter((cue) => [...String(cue.text).trim()].length >= 4 && [...String(cue.text).trim()].length <= 90);
  const step = Math.max(1, Math.floor(lines.length / CLIP_DICTATION_PER_EPISODE));
  for (let index = 0; index < lines.length && items.size < CLIP_DICTATION_PER_EPISODE + 200; index += step) add(lines[index], "dictation");
  return [...items.values()].map((item) => ({
    ...item,
    text: String(item.cue.text || "").replace(/\s+/g, " ").trim(),
    baseText: baseTrusted ? pairedBaseLines(target, cues.find((cue) => cue.startMs === item.cue.startMs) || item.cue)?.text || "" : "",
  })).sort((a, b) => (a.kind === b.kind ? a.cue.startMs - b.cue.startMs : a.kind === "card" ? -1 : 1));
}

export function scheduleClipStep(delayMs = 6000) {
  if (!learningEnabled) return;
  window.clearTimeout(clipPlanner.timer);
  clipPlanner.timer = window.setTimeout(() => { void runClipStep(); }, delayMs);
}

async function runClipStep() {
  if (!learningEnabled) return;
  const source = audioSyncSource();
  if (!source || !state.currentSource?.libraryId || !/^[a-f0-9]{40}$/i.test(String(state.currentSource.libraryId))) return;
  const key = `${state.currentSource.libraryId}:${source.fileIndex}:${source.audio}`;
  if (clipPlanner.key !== key) Object.assign(clipPlanner, { key, done: new Set(), failed: new Map() });
  if (clipPlanner.pending || state.pendingSeek || !$("#video-loading")?.hidden) { scheduleClipStep(4000); return; }
  const items = clipCandidates().filter((item) => !clipPlanner.done.has(item.key) && (clipPlanner.failed.get(item.key) || 0) < 2);
  if (!items.length) { scheduleClipStep(15_000); return; }
  clipPlanner.pending = true;
  let delay = 6000;
  let attempted = null;
  try {
    const ranges = await audioReadyRanges(source);
    if (!learningEnabled) return;
    const ready = items.find((item) => ranges.some((range) => range.fromMs <= item.cue.startMs - 300 && range.toMs >= item.cue.endMs + 400));
    if (!ready) return;
    attempted = ready;
    const label = clipEpisodeLabel();
    const response = await fetch("/api/clips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: source.sessionId, libraryId: state.currentSource.libraryId, fileIndex: source.fileIndex, audio: source.audio,
        startMs: Math.round(ready.cue.startMs), endMs: Math.round(ready.cue.endMs), kind: ready.kind,
        lang: state.targetLanguage, baseLang: state.baseLanguage, text: ready.text, baseText: ready.baseText, ...label,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const clip = await response.json().catch(() => ({}));
    if (!learningEnabled) return;
    if (response.status === 429) { delay = 8000; return; }
    if (!response.ok) throw new Error(clip.error || `Clip failed (${response.status})`);
    clipPlanner.done.add(ready.key);
    delay = 1500;
    if (ready.cardIds.length) {
      const ids = new Set(ready.cardIds);
      state.cards = state.cards.map((card) => (ids.has(card.id) ? { ...card, clipId: clip.id, clipImage: Boolean(clip.imageUrl) } : card));
      window.clearTimeout(clipPlanner.saveTimer);
      clipPlanner.saveTimer = window.setTimeout(() => saveState(), 1500);
    }
    if (dictation.loadedFor === state.targetLanguage && !dictation.clips.some((item) => item.id === clip.id)) dictation.clips.push(clip);
  } catch {
    if (attempted) clipPlanner.failed.set(attempted.key, (clipPlanner.failed.get(attempted.key) || 0) + 1);
    delay = 10_000;
  } finally {
    clipPlanner.pending = false;
    if (learningEnabled && audioSyncSource() && clipPlanner.key === key) scheduleClipStep(delay);
  }
}
