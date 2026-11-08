// Subtitle timing: offsets, alignment between tracks and timeline fits.
import { createSubtitleCueLookup, offsetAt as syncOffsetAt } from "../../shared/subtitles/subtitle-sync.js";
import { audioSync, pairedCueMemo, state } from "../../app.js";
import { $ } from "../app/dom.js";
import { postJson } from "../app/http.js";
import { activeTrack, currentSourceTracks, normalizeTrackLanguage } from "./player-tracks.js";
import { renderSubtitles, renderTracks, subtitleRenderMemo } from "./subtitle-display.js";
import { playbackLoadRequestId } from "./torrent-playback.js";

export function allPrimaryCues() {
  return activeTrack()?.cues || [];
}

function trackAutoOffsetAt(track, atMs = 0) {
  const anchors = Array.isArray(track?.syncAnchors)
    ? track.syncAnchors.filter((anchor) => Number.isFinite(Number(anchor?.atMs)) && Number.isFinite(Number(anchor?.offsetMs)))
      .map((anchor) => ({ ...anchor, atMs: Number(anchor.atMs), offsetMs: Number(anchor.offsetMs) }))
      .sort((a, b) => a.atMs - b.atMs)
    : [];
  return anchors.length ? syncOffsetAt({ mode: String(track?.syncMode || "constant"), anchors }, Number(atMs) || 0) : 0;
}

export function trackEffectiveOffsetAt(track, atMs = 0) {
  if (track?.exactMedia) return 0; // Embedded tracks carry the video's own timestamps.
  return Number(track?.offsetMs || 0) + trackAutoOffsetAt(track, atMs);
}

export function cuePlaybackBounds(cue, track) {
  const offset = trackEffectiveOffsetAt(track, Number(cue?.startMs) || 0);
  return {
    startMs: Math.max(0, Number(cue?.startMs || 0) + offset),
    endMs: Math.max(0, Number(cue?.endMs || 0) + offset),
  };
}

const indexedActiveSubtitleCue = createSubtitleCueLookup(cuePlaybackBounds);

export function cueNearPlaybackMs(track, playbackMs, toleranceMs = 1200) {
  if (!track?.cues?.length || !Number.isFinite(Number(playbackMs))) return null;
  let nearest = null;
  let nearestDistance = Infinity;
  for (const cue of track.cues) {
    const bounds = cuePlaybackBounds(cue, track);
    if (playbackMs >= bounds.startMs - toleranceMs && playbackMs <= bounds.endMs + toleranceMs) return cue;
    const distance = Math.abs(bounds.startMs - playbackMs);
    if (distance < nearestDistance) {
      nearest = cue;
      nearestDistance = distance;
    }
    if (bounds.startMs > playbackMs && distance > nearestDistance) break;
  }
  return nearestDistance <= toleranceMs ? nearest : null;
}

export function getActiveCue(track, currentMs = state.currentMs) {
  return indexedActiveSubtitleCue(track, currentMs);
}

export function comparisonCueForTrack(track, primaryTrack, primaryCue) {
  const active = getActiveCue(track);
  if (active || !primaryTrack || !primaryCue || track.id === primaryTrack.id) return active;
  const primaryStart = cuePlaybackBounds(primaryCue, primaryTrack).startMs;
  let nearest = null;
  let nearestDistance = Infinity;
  for (const cue of track.cues || []) {
    const adjustedStart = cuePlaybackBounds(cue, track).startMs;
    const distance = Math.abs(adjustedStart - primaryStart);
    if (distance < nearestDistance) {
      nearest = cue;
      nearestDistance = distance;
    }
    if (adjustedStart > primaryStart && distance > nearestDistance) break;
  }
  return nearestDistance <= 2500 ? nearest : null;
}

function median(values) {
  const numbers = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!numbers.length) return 0;
  const middle = Math.floor(numbers.length / 2);
  return numbers.length % 2 ? numbers[middle] : (numbers[middle - 1] + numbers[middle]) / 2;
}

function sampledCueStarts(track, maxSamples = 140) {
  const cues = track?.cues || [];
  if (cues.length <= maxSamples) return cues.map((cue) => Number(cue.startMs) || 0);
  const samples = [];
  for (let index = 0; index < maxSamples; index += 1) {
    const ratio = index / Math.max(1, maxSamples - 1);
    samples.push(Number(cues[Math.min(cues.length - 1, Math.round(ratio * (cues.length - 1)))].startMs) || 0);
  }
  return samples;
}

function subtitleOffsetEstimate(referenceTrack, candidateTrack) {
  if (!referenceTrack?.cues?.length || !candidateTrack?.cues?.length || referenceTrack.id === candidateTrack.id) {
    return { offsetMs: 0, confidence: 0, spanRatio: 1 };
  }
  const referenceStarts = sampledCueStarts(referenceTrack).map((value) => value + trackEffectiveOffsetAt(referenceTrack, value));
  const candidateStarts = sampledCueStarts(candidateTrack);
  if (referenceStarts.length < 2 || candidateStarts.length < 2) {
    return {
      offsetMs: Math.round((referenceStarts[0] || 0) - (candidateStarts[0] || 0)),
      confidence: 0.2,
      spanRatio: 1,
    };
  }
  const bucketSize = 250;
  const maxDelta = 30_000;
  const buckets = new Map();
  for (const referenceStart of referenceStarts) {
    for (const candidateStart of candidateStarts) {
      const diff = referenceStart - candidateStart;
      if (Math.abs(diff) > maxDelta) continue;
      const bucket = Math.round(diff / bucketSize) * bucketSize;
      buckets.set(bucket, (buckets.get(bucket) || 0) + 1);
    }
  }
  let bestBucket = 0;
  let bestCount = 0;
  for (const [bucket, count] of buckets) {
    if (count > bestCount || (count === bestCount && Math.abs(bucket) < Math.abs(bestBucket))) {
      bestBucket = bucket;
      bestCount = count;
    }
  }
  const refined = [];
  for (const referenceStart of referenceStarts) {
    for (const candidateStart of candidateStarts) {
      const diff = referenceStart - candidateStart;
      if (Math.abs(diff - bestBucket) <= 500) refined.push(diff);
    }
  }
  const referenceSpan = Math.max(1, (referenceTrack.cues.at(-1)?.endMs || referenceTrack.cues.at(-1)?.startMs || 0) - (referenceTrack.cues[0]?.startMs || 0));
  const candidateSpan = Math.max(1, (candidateTrack.cues.at(-1)?.endMs || candidateTrack.cues.at(-1)?.startMs || 0) - (candidateTrack.cues[0]?.startMs || 0));
  const spanRatio = candidateSpan / referenceSpan;
  let confidence = bestCount / Math.max(1, Math.min(referenceStarts.length, candidateStarts.length));
  if (spanRatio < 0.9 || spanRatio > 1.1) confidence *= 0.35;
  const offsetMs = Math.max(-120000, Math.min(120000, Math.round(median(refined.length ? refined : [bestBucket]) / 10) * 10));
  return { offsetMs, confidence, spanRatio };
}

export function syncTrackToBestReference(track, { initial = false } = {}) {
  if (!track) return 0;
  if (track.exactMedia) return 0;
  if (track.syncSource === "audio") return trackEffectiveOffsetAt(track, track.cues?.[0]?.startMs || 0);
  const scoped = currentSourceTracks().filter((item) => item.id !== track.id && item.cues?.length);
  const ranked = scoped.slice().sort((a, b) => (Number(b.matchScore) || 0) - (Number(a.matchScore) || 0));
  const bestReleaseMatch = (Number(ranked[0]?.matchScore) || 0) > 0 ? ranked[0] : null;
  const reference = scoped.find((item) => item.exactMedia)
    || scoped.find((item) => item.syncSource === "audio")
    || bestReleaseMatch
    || scoped.find((item) => String(item.language || "").toUpperCase() === state.targetLanguage)
    || scoped.find((item) => item.id === state.selectedTrackId)
    || scoped[0];
  if (!reference) return track.offsetMs || 0;
  const estimate = subtitleOffsetEstimate(reference, track);
  track.syncConfidence = estimate.confidence;
  track.syncSpanRatio = estimate.spanRatio;
  track.syncReferenceId = reference.id;
  track.syncReferenceExact = Boolean(reference.exactMedia);
  const spanClose = estimate.spanRatio >= 0.92 && estimate.spanRatio <= 1.08;
  const strongEnough = estimate.confidence >= (reference.exactMedia ? 0.12 : 0.18) && spanClose;
  const offsetLimit = reference.exactMedia ? 60_000 : 30_000;
  if (!strongEnough || Math.abs(estimate.offsetMs) > offsetLimit) {
    track.syncRejected = true;
    return trackEffectiveOffsetAt(track, track.cues?.[0]?.startMs || 0);
  }
  track.syncRejected = false;
  track.offsetMs = 0;
  track.syncMode = "constant";
  track.syncAnchors = [{
    atMs: Math.round(Number(track.cues?.[Math.floor((track.cues?.length || 1) / 2)]?.startMs) || 0),
    offsetMs: estimate.offsetMs,
    confidence: estimate.confidence,
  }];
  return estimate.offsetMs;
}

let subtitleAlignmentRequestSerial = 0;
export async function alignCurrentSubtitleSet() {
  // Even identical selections can issue overlapping alignments. The latest
  // invocation owns publication, including when it needs no HTTP request.
  const requestSerial = ++subtitleAlignmentRequestSerial;
  const scoped = currentSourceTracks();
  const tracks = scoped.filter((track) => track.cues?.length);
  if (tracks.length < 2) return { reference: tracks[0] || null, offsets: [], backend: false };
  const reference = tracks.find((track) => track.exactMedia)
    || tracks.find((track) => track.syncSource === "audio")
    || tracks.find((track) => normalizeTrackLanguage(track.language) === state.targetLanguage)
    || tracks.find((track) => track.id === state.selectedTrackId)
    || tracks[0];
  // Keep the request owned by the existing playback/audio selection and the
  // exact subtitle set. A later episode can reuse track IDs or even objects.
  const source = state.currentSource;
  const sourceIdentity = (item) => JSON.stringify([
    item?.kind, item?.libraryId, item?.sessionId, item?.fileIndex,
    item?.fileName, item?.sourceTag, item?.episode?.code, item?.title,
  ]);
  const sourceKey = sourceIdentity(source);
  const loadId = playbackLoadRequestId;
  const audioIndex = state.selectedAudioTrack;
  const audioGeneration = audioSync.generation;
  const audioKey = audioSync.key;
  const selectedTrackId = state.selectedTrackId;
  const targetLanguage = state.targetLanguage;
  const allTracks = state.tracks;
  const updatedByThisRequest = new Set();
  const selectedSet = scoped.map((track) => ({
    track, id: track.id, sourceTag: track.sourceTag, visible: track.visible,
    language: track.language, exactMedia: track.exactMedia, syncSource: track.syncSource,
    offsetMs: track.offsetMs, syncMode: track.syncMode,
    anchors: track.syncAnchors, anchorCount: track.syncAnchors?.length,
    cues: track.cues, cueCount: track.cues?.length,
    firstCue: track.cues?.[0], lastCue: track.cues?.at(-1),
  }));
  const current = () => {
    if (requestSerial !== subtitleAlignmentRequestSerial
      || state.currentSource !== source || sourceIdentity(state.currentSource) !== sourceKey
      || playbackLoadRequestId !== loadId || state.selectedAudioTrack !== audioIndex
      || audioSync.generation !== audioGeneration || audioSync.key !== audioKey
      || state.selectedTrackId !== selectedTrackId || state.targetLanguage !== targetLanguage
      || state.tracks !== allTracks) return false;
    const live = currentSourceTracks();
    return live.length === selectedSet.length && live.every((track, index) => {
      const saved = selectedSet[index];
      return track === saved.track && track.id === saved.id && track.sourceTag === saved.sourceTag
        && track.visible === saved.visible && track.language === saved.language
        && track.exactMedia === saved.exactMedia
        && (updatedByThisRequest.has(track) || (track.syncSource === saved.syncSource
          && track.offsetMs === saved.offsetMs && track.syncMode === saved.syncMode
          && track.syncAnchors === saved.anchors && track.syncAnchors?.length === saved.anchorCount))
        && track.cues === saved.cues && track.cues?.length === saved.cueCount
        && track.cues?.[0] === saved.firstCue && track.cues?.at(-1) === saved.lastCue;
    });
  };
  const discarded = () => ({ reference: null, offsets: [], backend: false, stale: true });
  try {
    const data = await postJson("/api/subtitles/align", {
      referenceTrackId: reference.id,
      tracks: tracks.map((track) => ({
        id: track.id,
        language: normalizeTrackLanguage(track.language),
        exactMedia: Boolean(track.exactMedia),
        cues: track.cues.map((cue) => {
          const bounds = track.id === reference.id ? cuePlaybackBounds(cue, track) : null;
          return {
            id: cue.id,
            text: cue.text,
            startMs: bounds ? bounds.startMs : cue.startMs,
            endMs: bounds ? bounds.endMs : cue.endMs,
          };
        }),
      })),
    });
    if (!current()) return discarded();
    const alignedById = new Map((Array.isArray(data?.tracks) ? data.tracks : []).map((item) => [String(item.id), item]));
    const offsets = [];
    for (const track of tracks) {
      if (!current()) return discarded();
      const aligned = alignedById.get(String(track.id));
      if (!aligned) continue;
      if (track.syncSource === "audio" && track.id !== reference.id) {
        offsets.push("AUDIO");
        continue;
      }
      track.syncConfidence = Number(aligned.confidence) || 0;
      track.syncSpanRatio = Number(aligned.spanRatio) || 0;
      track.syncRejected = Boolean(aligned.rejected);
      track.syncReferenceId = data?.referenceTrackId || reference.id;
      track.syncReferenceExact = Boolean(reference.exactMedia);
      updatedByThisRequest.add(track);
      if (track.id === reference.id) {
        track.syncRejected = false;
        continue;
      }
      if (!track.syncRejected) {
        const anchors = Array.isArray(aligned.anchors) ? aligned.anchors
          .filter((anchor) => Number.isFinite(Number(anchor?.atMs)) && Number.isFinite(Number(anchor?.offsetMs)))
          .map((anchor) => ({
            atMs: Number(anchor.atMs),
            offsetMs: Number(anchor.offsetMs),
            confidence: Number(anchor.confidence) || 0,
          })) : [];
        track.offsetMs = 0;
        track.syncMode = String(aligned.mode || "constant");
        track.syncAnchors = anchors.length
          ? anchors
          : Number.isFinite(Number(aligned.offsetMs))
            ? [{ atMs: 0, offsetMs: Number(aligned.offsetMs), confidence: track.syncConfidence }]
            : [];
      }
      if (track.id !== reference.id) {
        if (track.syncRejected) {
          offsets.push("REJECTED");
        } else {
          const anchorOffsets = (track.syncAnchors || []).map((anchor) => Number(anchor.offsetMs) || 0);
          const low = anchorOffsets.length ? Math.min(...anchorOffsets) : 0;
          const high = anchorOffsets.length ? Math.max(...anchorOffsets) : low;
          offsets.push(low === high
            ? `${low >= 0 ? "+" : ""}${low}ms`
            : `${low >= 0 ? "+" : ""}${low}→${high >= 0 ? "+" : ""}${high}ms`);
        }
      }
    }
    if (!current()) return discarded();
    state.alignedSubtitleTimeline = Array.isArray(data?.timeline) ? data.timeline : [];
    state.alignedSubtitleSourceKey = [source?.libraryId || source?.sourceTag || source?.title || source?.kind || "source", source?.fileIndex ?? source?.fileName ?? "file"].join("|");

    return { reference, offsets, backend: true };
  } catch {
    if (!current()) return discarded();
    state.alignedSubtitleTimeline = [];
    state.alignedSubtitleSourceKey = "";
    const offsets = [];
    for (const track of tracks) {
      if (!current()) return discarded();
      if (track.id === reference.id) continue;
      const offset = syncTrackToBestReference(track, { initial: true });
      updatedByThisRequest.add(track);
      offsets.push(`${offset >= 0 ? "+" : ""}${offset}ms`);
    }

    return { reference, offsets, backend: false };
  }
}

export function nudgeSubtitleTracks(deltaMs, tracks = currentSourceTracks().filter((track) => track.visible && !track.exactMedia)) {
  if (!tracks.length) return;
  tracks.forEach((track) => { track.offsetMs = Number(track.offsetMs || 0) + deltaMs; });
  pairedCueMemo.clear();
  subtitleRenderMemo.key = "";
  renderSubtitles();
  renderTracks();
  const shown = Number(tracks[0].offsetMs || 0) / 1000;
  $("#media-status").textContent = `Subtitle timing ${shown >= 0 ? "+" : ""}${shown.toFixed(1)} s`;
}

export function subtitleFingerprint(cues) {
  if (!Array.isArray(cues) || !cues.length) return "";
  const picks = [0, Math.floor(cues.length / 3), Math.floor((cues.length * 2) / 3), cues.length - 1]
    .map((index) => cues[Math.max(0, Math.min(cues.length - 1, index))])
    .map((cue) => `${Math.round((Number(cue?.startMs) || 0) / 100)}:${String(cue?.normalizedText || cue?.text || "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 120)}`)
    .join("|");
  return `${cues.length}|${Math.round((Number(cues.at(-1)?.endMs) || 0) / 100)}|${picks}`;
}

export function subtitleTimelineFit(cues) {
  if (!state.mediaDurationMs || !cues?.length) return { ratio: null, severeMismatch: false };
  const lastCueMs = Math.max(...cues.map((cue) => Number(cue.endMs) || 0));
  const ratio = lastCueMs / state.mediaDurationMs;
  return { ratio, severeMismatch: ratio > 1.1 || ratio < 0.65 };
}

export function refreshSubtitleTimelineFits() {
  currentSourceTracks().forEach((track) => {
    if (track.exactMedia) {
      track.timelineMismatch = false;
      track.timelineRatio = null;
      return;
    }
    const fit = subtitleTimelineFit(track.cues);
    track.timelineRatio = fit.ratio;
    track.timelineMismatch = fit.severeMismatch;
  });
}
