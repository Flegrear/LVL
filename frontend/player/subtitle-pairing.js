// Pairs the lines of two subtitle tracks (dual subtitles and cards).
import { pairedCues } from "../../shared/subtitles/subtitle-sync.js";
import { pairedCueMemo, state } from "../../app.js";
import { saveState } from "../app/saved-state.js";
import { currentSourceTracks, normalizeTrackLanguage } from "./player-tracks.js";
import { cuePlaybackBounds } from "./subtitle-timing.js";
import { audioSyncSource } from "./audio-sync.js";

export function trackTimingTrusted(track) {
  if (!track) return false;
  if (track.exactMedia || track.syncSource === "audio") return true;
  if (audioSyncSource() && track.audioSync?.status !== "failed") return false; // audio sync still running
  return !track.syncRejected;
}

export function videoCuesForTrack(track) {
  const key = `${track.id}|${track.cues.length}|${Number(track.offsetMs || 0)}|${track.syncMode}|${JSON.stringify(track.syncAnchors || [])}`;
  const cached = pairedCueMemo.get(track.id);
  if (cached?.key === key) return cached.cues;
  const cues = track.cues.map((cue) => ({ ...cue, ...cuePlaybackBounds(cue, track) }));
  pairedCueMemo.set(track.id, { key, cues });
  return cues;
}

export function pairedBaseLines(sourceTrack, cue) {
  const base = currentSourceTracks().find((track) => track.id !== sourceTrack?.id && track.cues?.length && normalizeTrackLanguage(track.language) === state.baseLanguage);
  if (!base || !sourceTrack || !cue) return null;
  const matches = pairedCues(cuePlaybackBounds(cue, sourceTrack), videoCuesForTrack(base));
  if (!matches.length) return null;
  return { text: matches.map((item) => String(item.text || "").trim()).filter(Boolean).join(" "), startMs: matches[0].startMs, endMs: matches.at(-1).endMs };
}

export function pairingReady() {
  const tracks = currentSourceTracks().filter((track) => track.cues?.length);
  const target = tracks.find((track) => normalizeTrackLanguage(track.language) === state.targetLanguage);
  const base = tracks.find((track) => normalizeTrackLanguage(track.language) === state.baseLanguage);
  return Boolean(target && trackTimingTrusted(target) && (!base || trackTimingTrusted(base)));
}
