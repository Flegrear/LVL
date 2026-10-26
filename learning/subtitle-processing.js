import crypto from "node:crypto";

export const LEARNING_SUBTITLE_SCHEMA_VERSION = 1;
export const LEARNING_ALIGNMENT_VERSION = 2;
export const MAX_LEARNING_TRACKS = 4;
export const MAX_LEARNING_CUES_PER_TRACK = 12_000;
export const MAX_LEARNING_TOTAL_CUES = 30_000;

const MAX_CUE_TEXT_CHARS = 4_000;
const MAX_MEDIA_MS = 12 * 60 * 60 * 1000;
const MAX_OFFSET_MS = 120_000;
const SAMPLE_LIMIT = 140;
const OFFSET_BUCKET_MS = 250;
const PAIR_TOLERANCE_MS = 1_200;
const LOCAL_ALIGNMENT_MIN_CUES = 24;
const LOCAL_ALIGNMENT_SEGMENT_CUES = 24;
const LOCAL_ALIGNMENT_MAX_SEGMENTS = 9;
const LOCAL_ALIGNMENT_SEARCH_MS = 90_000;
const LOCAL_ALIGNMENT_JUMP_MS = 1_800;
const LOCAL_ALIGNMENT_CONSTANT_SPREAD_MS = 700;
const LOCAL_ALIGNMENT_ISOLATED_OUTLIER_MS = 15_000;

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[“”‘’]/g, "'")
    .replace(/[^\p{L}\p{N}'\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function sampledCueStarts(track, maxSamples = SAMPLE_LIMIT) {
  const cues = track.cues;
  if (cues.length <= maxSamples) return cues.map((cue) => cue.startMs);
  const values = [];
  for (let index = 0; index < maxSamples; index += 1) {
    const ratio = index / Math.max(1, maxSamples - 1);
    values.push(cues[Math.min(cues.length - 1, Math.round(ratio * (cues.length - 1)))].startMs);
  }
  return values;
}

function trackSpan(track) {
  const first = track.cues[0];
  const last = track.cues.at(-1);
  return Math.max(1, (last?.endMs || last?.startMs || 0) - (first?.startMs || 0));
}

function overlapMs(aStart, aEnd, bStart, bEnd) {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

function pairTracks(reference, candidate, offsetMs) {
  const pairs = [];
  const used = new Set();
  let cursor = 0;
  const candidateCues = candidate.cues;
  for (let referenceIndex = 0; referenceIndex < reference.cues.length; referenceIndex += 1) {
    const referenceCue = reference.cues[referenceIndex];
    while (cursor < candidateCues.length) {
      const adjustedEnd = candidateCues[cursor].endMs + offsetMs;
      if (adjustedEnd >= referenceCue.startMs - PAIR_TOLERANCE_MS) break;
      cursor += 1;
    }
    let best = null;
    for (let candidateIndex = Math.max(0, cursor - 2); candidateIndex < Math.min(candidateCues.length, cursor + 7); candidateIndex += 1) {
      if (used.has(candidateIndex)) continue;
      const cue = candidateCues[candidateIndex];
      const start = cue.startMs + offsetMs;
      const end = cue.endMs + offsetMs;
      if (start > referenceCue.endMs + PAIR_TOLERANCE_MS) break;
      const overlap = overlapMs(referenceCue.startMs, referenceCue.endMs, start, end);
      const startDistance = Math.abs(start - referenceCue.startMs);
      if (!overlap && startDistance > PAIR_TOLERANCE_MS) continue;
      const score = overlap * 4 - startDistance;
      if (!best || score > best.score) best = { candidateIndex, overlap, startDistance, score };
    }
    if (!best) continue;
    used.add(best.candidateIndex);
    pairs.push({
      referenceIndex,
      candidateIndex: best.candidateIndex,
      overlapMs: best.overlap,
      startDistanceMs: best.startDistance,
    });
  }
  return pairs;
}

function estimateConstantOffset(reference, candidate) {
  const referenceStarts = sampledCueStarts(reference);
  const candidateStarts = sampledCueStarts(candidate);
  const buckets = new Map();
  for (const referenceStart of referenceStarts) {
    for (const candidateStart of candidateStarts) {
      const diff = referenceStart - candidateStart;
      if (Math.abs(diff) > MAX_OFFSET_MS) continue;
      const bucket = Math.round(diff / OFFSET_BUCKET_MS) * OFFSET_BUCKET_MS;
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
  const offsetMs = Math.max(-MAX_OFFSET_MS, Math.min(MAX_OFFSET_MS, Math.round(median(refined.length ? refined : [bestBucket]) / 10) * 10));
  const spanRatio = trackSpan(candidate) / trackSpan(reference);
  const pairs = pairTracks(reference, candidate, offsetMs);
  const bucketConfidence = bestCount / Math.max(1, Math.min(referenceStarts.length, candidateStarts.length));
  const pairCoverage = pairs.length / Math.max(1, Math.min(reference.cues.length, candidate.cues.length));
  const spanPenalty = spanRatio >= 0.9 && spanRatio <= 1.1 ? 1 : 0.35;
  const confidence = Math.max(0, Math.min(1, (bucketConfidence * 0.35 + pairCoverage * 0.65) * spanPenalty));
  return { offsetMs, spanRatio, confidence, pairs };
}

function localOffsetAnchors(reference, candidate, baselineOffsetMs) {
  if (reference.cues.length < LOCAL_ALIGNMENT_MIN_CUES || candidate.cues.length < LOCAL_ALIGNMENT_MIN_CUES) return [];
  const segmentCount = Math.max(3, Math.min(
    LOCAL_ALIGNMENT_MAX_SEGMENTS,
    Math.ceil(candidate.cues.length / LOCAL_ALIGNMENT_SEGMENT_CUES),
  ));
  const anchors = [];
  for (let segment = 0; segment < segmentCount; segment += 1) {
    const startIndex = Math.floor((segment * candidate.cues.length) / segmentCount);
    const endIndex = Math.max(startIndex + 1, Math.floor(((segment + 1) * candidate.cues.length) / segmentCount));
    const candidateCues = candidate.cues.slice(startIndex, endIndex);
    if (candidateCues.length < 4) continue;
    const candidateStart = candidateCues[0].startMs;
    const candidateEnd = candidateCues.at(-1).endMs;
    const referenceStart = candidateStart + baselineOffsetMs - LOCAL_ALIGNMENT_SEARCH_MS;
    const referenceEnd = candidateEnd + baselineOffsetMs + LOCAL_ALIGNMENT_SEARCH_MS;
    const referenceCues = reference.cues.filter((cue) => cue.endMs >= referenceStart && cue.startMs <= referenceEnd);
    if (referenceCues.length < 4) continue;
    const estimate = estimateConstantOffset({ ...reference, cues: referenceCues }, { ...candidate, cues: candidateCues });
    if (Math.abs(estimate.offsetMs - baselineOffsetMs) > LOCAL_ALIGNMENT_SEARCH_MS) continue;
    const pairs = pairTracks({ ...reference, cues: referenceCues }, { ...candidate, cues: candidateCues }, estimate.offsetMs);
    const coverage = pairs.length / Math.max(1, Math.min(referenceCues.length, candidateCues.length));
    if (pairs.length < 3 || coverage < 0.1) continue;
    anchors.push({
      atMs: Math.round(median(candidateCues.map((cue) => cue.startMs))),
      offsetMs: estimate.offsetMs,
      confidence: Math.max(estimate.confidence, coverage),
      matchedPairs: pairs.length,
    });
  }
  const sorted = anchors.sort((a, b) => a.atMs - b.atMs);
  if (sorted.length < 3) return sorted;
  return sorted.filter((anchor, index) => {
    if (index === 0 || index === sorted.length - 1) return true;
    const previous = sorted[index - 1];
    const next = sorted[index + 1];
    const neighborsAgree = Math.abs(previous.offsetMs - next.offsetMs) <= LOCAL_ALIGNMENT_ISOLATED_OUTLIER_MS;
    const disagreesWithBoth = Math.abs(anchor.offsetMs - previous.offsetMs) > LOCAL_ALIGNMENT_ISOLATED_OUTLIER_MS
      && Math.abs(anchor.offsetMs - next.offsetMs) > LOCAL_ALIGNMENT_ISOLATED_OUTLIER_MS;
    return !(neighborsAgree && disagreesWithBoth);
  });
}

function alignmentModeForAnchors(anchors) {
  if (anchors.length < 2) return "constant";
  const offsets = anchors.map((anchor) => anchor.offsetMs);
  const spread = Math.max(...offsets) - Math.min(...offsets);
  if (spread <= LOCAL_ALIGNMENT_CONSTANT_SPREAD_MS) return "constant";
  let maxJump = 0;
  for (let index = 1; index < anchors.length; index += 1) {
    maxJump = Math.max(maxJump, Math.abs(anchors[index].offsetMs - anchors[index - 1].offsetMs));
  }
  return maxJump >= LOCAL_ALIGNMENT_JUMP_MS ? "piecewise-step" : "linear-drift";
}

function normalizedAlignmentAnchors(anchors, fallbackOffsetMs) {
  if (!anchors.length) return [{ atMs: 0, offsetMs: fallbackOffsetMs, confidence: 0 }];
  const mode = alignmentModeForAnchors(anchors);
  if (mode === "constant") {
    return [{
      atMs: Math.round(median(anchors.map((anchor) => anchor.atMs))),
      offsetMs: Math.round(median(anchors.map((anchor) => anchor.offsetMs)) / 10) * 10,
      confidence: median(anchors.map((anchor) => anchor.confidence)),
    }];
  }
  return anchors;
}

function alignmentOffsetAt(anchors, mode, atMs) {
  if (!anchors.length) return 0;
  if (anchors.length === 1 || mode === "constant") return anchors[0].offsetMs;
  if (mode === "piecewise-step") {
    let nearest = anchors[0];
    let distance = Math.abs(atMs - nearest.atMs);
    for (let index = 1; index < anchors.length; index += 1) {
      const nextDistance = Math.abs(atMs - anchors[index].atMs);
      if (nextDistance < distance) {
        nearest = anchors[index];
        distance = nextDistance;
      }
    }
    return nearest.offsetMs;
  }
  if (atMs <= anchors[0].atMs) return anchors[0].offsetMs;
  if (atMs >= anchors.at(-1).atMs) return anchors.at(-1).offsetMs;
  for (let index = 1; index < anchors.length; index += 1) {
    const right = anchors[index];
    if (atMs > right.atMs) continue;
    const left = anchors[index - 1];
    const ratio = (atMs - left.atMs) / Math.max(1, right.atMs - left.atMs);
    return Math.round(left.offsetMs + (right.offsetMs - left.offsetMs) * ratio);
  }
  return anchors.at(-1).offsetMs;
}

function adjustedTrack(track, anchors, mode) {
  return {
    ...track,
    cues: track.cues.map((cue) => {
      const offsetMs = alignmentOffsetAt(anchors, mode, cue.startMs);
      return {
        ...cue,
        startMs: Math.max(0, cue.startMs + offsetMs),
        endMs: Math.max(0, cue.endMs + offsetMs),
      };
    }),
  };
}

function affineAlignmentCandidate(reference, candidate) {
  if (reference.cues.length < 4 || candidate.cues.length < 4) return null;
  const referenceFirst = reference.cues[0];
  const referenceLast = reference.cues.at(-1);
  const candidateFirst = candidate.cues[0];
  const candidateLast = candidate.cues.at(-1);
  const candidateSpan = candidateLast.startMs - candidateFirst.startMs;
  const referenceSpan = referenceLast.startMs - referenceFirst.startMs;
  if (candidateSpan <= 0 || referenceSpan <= 0) return null;
  const scale = referenceSpan / candidateSpan;
  if (scale < 0.92 || scale > 1.08) return null;
  const intercept = referenceFirst.startMs - candidateFirst.startMs * scale;
  const offsetAt = (atMs) => (scale * atMs + intercept) - atMs;
  const anchors = [
    { atMs: candidateFirst.startMs, offsetMs: Math.round(offsetAt(candidateFirst.startMs)), confidence: 0 },
    { atMs: candidateLast.startMs, offsetMs: Math.round(offsetAt(candidateLast.startMs)), confidence: 0 },
  ];
  const adjusted = adjustedTrack(candidate, anchors, "linear-drift");
  const pairs = pairTracks(reference, adjusted, 0);
  const coverage = pairs.length / Math.max(1, Math.min(reference.cues.length, candidate.cues.length));
  anchors.forEach((anchor) => { anchor.confidence = coverage; });
  return { scale, anchors, adjusted, pairs, coverage };
}

function artifactFingerprint(track) {
  const hash = crypto.createHash("sha256");
  hash.update(track.language);
  for (const cue of track.cues) hash.update(`\n${cue.startMs}:${cue.endMs}:${cue.normalizedText}`);
  return hash.digest("hex").slice(0, 24);
}

export function processCueArtifact(input, fallbackId = "track-1") {
  if (!input || typeof input !== "object" || !Array.isArray(input.cues)) throw Object.assign(new Error("A cue artifact with a cues array is required"), { statusCode: 400 });
  if (!input.cues.length || input.cues.length > MAX_LEARNING_CUES_PER_TRACK) {
    throw Object.assign(new Error(`Cue artifacts must contain 1-${MAX_LEARNING_CUES_PER_TRACK} cues`), { statusCode: 413 });
  }
  const id = String(input.id || fallbackId).trim().slice(0, 120) || fallbackId;
  const language = String(input.language || "").trim().toUpperCase().slice(0, 16);
  const cues = input.cues.map((rawCue, index) => {
    const startMs = Number(rawCue?.startMs);
    const endMs = Number(rawCue?.endMs);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs < startMs || endMs > MAX_MEDIA_MS) {
      throw Object.assign(new Error(`Invalid cue timing at index ${index}`), { statusCode: 400 });
    }
    const text = String(rawCue?.text || "").trim().slice(0, MAX_CUE_TEXT_CHARS);
    if (!text) throw Object.assign(new Error(`Cue ${index} has no text`), { statusCode: 400 });
    return {
      id: String(rawCue?.id || `${id}-${index + 1}`).slice(0, 160),
      startMs: Math.round(startMs),
      endMs: Math.round(endMs),
      text,
      normalizedText: normalizeText(rawCue?.normalizedText || text),
    };
  }).sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.id.localeCompare(b.id));
  const artifact = {
    schemaVersion: LEARNING_SUBTITLE_SCHEMA_VERSION,
    id,
    language,
    exactMedia: Boolean(input.exactMedia),
    cues,
    cueCount: cues.length,
    durationMs: cues.at(-1)?.endMs || 0,
  };
  artifact.fingerprint = artifactFingerprint(artifact);
  return artifact;
}

export function alignCueArtifacts(inputTracks, { referenceTrackId = "" } = {}) {
  if (!Array.isArray(inputTracks) || inputTracks.length < 2 || inputTracks.length > MAX_LEARNING_TRACKS) {
    throw Object.assign(new Error(`Alignment requires 2-${MAX_LEARNING_TRACKS} cue artifacts`), { statusCode: 400 });
  }
  const tracks = inputTracks.map((track, index) => processCueArtifact(track, `track-${index + 1}`));
  if (new Set(tracks.map((track) => track.id)).size !== tracks.length) {
    throw Object.assign(new Error("Cue artifact ids must be unique within an alignment request"), { statusCode: 400 });
  }
  const totalCues = tracks.reduce((sum, track) => sum + track.cues.length, 0);
  if (totalCues > MAX_LEARNING_TOTAL_CUES) throw Object.assign(new Error(`Alignment accepts at most ${MAX_LEARNING_TOTAL_CUES} cues total`), { statusCode: 413 });

  const requested = String(referenceTrackId || "");
  const reference = tracks.find((track) => track.id === requested)
    || tracks.find((track) => track.exactMedia)
    || tracks.slice().sort((a, b) => b.cues.length - a.cues.length)[0];
  const alignments = new Map();
  alignments.set(reference.id, {
    trackId: reference.id,
    offsetMs: 0,
    confidence: 1,
    spanRatio: 1,
    rejected: false,
    matchedPairs: reference.cues.length,
    mode: "constant",
    anchors: [{ atMs: 0, offsetMs: 0, confidence: 1 }],
    pairs: reference.cues.map((_, index) => ({ referenceIndex: index, candidateIndex: index, overlapMs: 0, startDistanceMs: 0 })),
  });

  for (const track of tracks) {
    if (track.id === reference.id) continue;
    const estimate = estimateConstantOffset(reference, track);
    const localAnchors = localOffsetAnchors(reference, track, estimate.offsetMs);
    const anchors = normalizedAlignmentAnchors(localAnchors, estimate.offsetMs);
    const mode = alignmentModeForAnchors(anchors);
    let selectedAnchors = anchors;
    let selectedMode = mode;
    let adjusted = adjustedTrack(track, selectedAnchors, selectedMode);
    let pairs = pairTracks(reference, adjusted, 0);
    let pairCoverage = pairs.length / Math.max(1, Math.min(reference.cues.length, track.cues.length));
    const affine = affineAlignmentCandidate(reference, track);
    if (affine && Math.abs(affine.scale - 1) >= 0.0025 && affine.coverage >= 0.35 && affine.coverage > pairCoverage + 0.08) {
      selectedAnchors = affine.anchors;
      selectedMode = "linear-drift";
      adjusted = affine.adjusted;
      pairs = affine.pairs;
      pairCoverage = affine.coverage;
    }
    const adaptiveSpanRatio = trackSpan(adjusted) / trackSpan(reference);
    const anchorConfidence = median(selectedAnchors.map((anchor) => Number(anchor.confidence) || 0));
    const confidence = Math.max(0, Math.min(1, pairCoverage * 0.8 + Math.max(estimate.confidence, anchorConfidence) * 0.2));
    const rejected = confidence < 0.08 || adaptiveSpanRatio < 0.75 || adaptiveSpanRatio > 1.25;
    alignments.set(track.id, {
      trackId: track.id,
      offsetMs: Math.round(median(selectedAnchors.map((anchor) => anchor.offsetMs)) / 10) * 10,
      confidence: Math.round(confidence * 1000) / 1000,
      spanRatio: Math.round(adaptiveSpanRatio * 1000) / 1000,
      rejected,
      matchedPairs: pairs.length,
      mode: selectedMode,
      anchors: selectedAnchors.map((anchor) => ({
        atMs: Math.round(anchor.atMs),
        offsetMs: Math.round(anchor.offsetMs),
        confidence: Math.round((Number(anchor.confidence) || 0) * 1000) / 1000,
      })),
      pairs,
    });
  }

  const pairMaps = new Map();
  for (const track of tracks) {
    if (track.id === reference.id) continue;
    const alignment = alignments.get(track.id);
    if (alignment.rejected) continue;
    pairMaps.set(track.id, new Map(alignment.pairs.map((pair) => [pair.referenceIndex, pair.candidateIndex])));
  }
  const timeline = reference.cues.map((referenceCue, referenceIndex) => {
    const items = [{
      trackId: reference.id,
      cueId: referenceCue.id,
      language: reference.language,
      text: referenceCue.text,
      startMs: referenceCue.startMs,
      endMs: referenceCue.endMs,
    }];
    for (const track of tracks) {
      if (track.id === reference.id) continue;
      const candidateIndex = pairMaps.get(track.id)?.get(referenceIndex);
      if (candidateIndex === undefined) continue;
      const cue = track.cues[candidateIndex];
      const alignment = alignments.get(track.id);
      const offsetMs = alignmentOffsetAt(alignment.anchors, alignment.mode, cue.startMs);
      items.push({
        trackId: track.id,
        cueId: cue.id,
        language: track.language,
        text: cue.text,
        startMs: Math.max(0, cue.startMs + offsetMs),
        endMs: Math.max(0, cue.endMs + offsetMs),
      });
    }
    return {
      startMs: referenceCue.startMs,
      endMs: referenceCue.endMs,
      referenceCueId: referenceCue.id,
      items,
    };
  });

  return {
    schemaVersion: LEARNING_SUBTITLE_SCHEMA_VERSION,
    alignmentVersion: LEARNING_ALIGNMENT_VERSION,
    alignmentModel: {
      type: tracks.some((track) => alignments.get(track.id)?.mode !== "constant") ? "adaptive-offset" : "constant-offset",
      drift: tracks.some((track) => alignments.get(track.id)?.mode === "linear-drift") ? "linear" : null,
      cutJumps: tracks.some((track) => alignments.get(track.id)?.mode === "piecewise-step"),
    },
    referenceTrackId: reference.id,
    tracks: tracks.map((track) => {
      const { pairs, ...alignment } = alignments.get(track.id);
      return {
        id: track.id,
        language: track.language,
        exactMedia: track.exactMedia,
        fingerprint: track.fingerprint,
        cueCount: track.cueCount,
        ...alignment,
      };
    }),
    timeline,
  };
}
