// subtitle-sync.js: sync subtitle tracks to the speech in the playing video, and pair lines across
// tracks. Pure JavaScript with no DOM or Node APIs: the server uses speechActivityFromPcm() on
// decoded audio and the browser (app.js) runs the correlation.
//
// Idea: a subtitle track says when people speak (cue intervals); the audio says when they
// actually do (speech activity). Sliding one over the other and finding the best match gives the
// track's offset at that point of the video. Several windows across the episode give a model:
// one constant offset, a slow drift (frame-rate mismatch) or jumps at cuts (recaps, ad breaks).
// Offsets map subtitle time to video time: videoMs = cueMs + offsetMs.

export const SPEECH_FRAME_MS = 10;
export const SPEECH_SAMPLE_RATE = 16000;

/**
 * Index the adjusted subtitle cue intervals once per timing revision rather
 * than recomputing every cue's drifting/cut-aware offset on each video frame.
 * Preserve .find() semantics for overlaps (earliest active cue wins) and for
 * cut models which can reorder adjusted start times.
 */
export function createSubtitleCueLookup(boundsForCue) {
  const cached = new WeakMap();
  return (track, currentMs) => {
    const cues = track?.cues;
    if (!Array.isArray(cues) || !cues.length || !Number.isFinite(currentMs)) return null;
    let index = cached.get(track);
    if (!index || index.cues !== cues || index.length !== cues.length
      || index.first !== cues[0] || index.last !== cues.at(-1)
      || index.anchors !== track.syncAnchors || index.anchorCount !== (track.syncAnchors?.length || 0)
      || index.offset !== track.offsetMs || index.mode !== track.syncMode
      || index.exact !== track.exactMedia) {
      const starts = new Float64Array(cues.length);
      const ends = new Float64Array(cues.length);
      const prefixEnds = new Float64Array(cues.length);
      let ordered = true;
      for (let i = 0; i < cues.length; i++) {
        const bounds = boundsForCue(cues[i], track);
        starts[i] = bounds.startMs;
        ends[i] = bounds.endMs;
        prefixEnds[i] = Math.max(i ? prefixEnds[i - 1] : -Infinity, ends[i]);
        if (i && starts[i] < starts[i - 1]) ordered = false;
      }
      index = { cues, length: cues.length, first: cues[0], last: cues.at(-1),
        anchors: track.syncAnchors, anchorCount: track.syncAnchors?.length || 0,
        offset: track.offsetMs, mode: track.syncMode, exact: track.exactMedia,
        starts, ends, prefixEnds, ordered };
      cached.set(track, index);
    }
    if (!index.ordered) {
      for (let i = 0; i < cues.length; i++) {
        if (index.starts[i] <= currentMs && currentMs <= index.ends[i]) return cues[i];
      }
      return null;
    }
    // Find the last cue that has started, then the earliest interval (even an
    // overlapping one) that hasn't yet ended. Both searches are logarithmic.
    let lo = 0;
    let hi = cues.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (index.starts[mid] <= currentMs) lo = mid + 1;
      else hi = mid;
    }
    const started = lo;
    lo = 0;
    hi = started;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (index.prefixEnds[mid] < currentMs) lo = mid + 1;
      else hi = mid;
    }
    return lo < started && currentMs <= index.ends[lo] ? cues[lo] : null;
  };
}

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = Float64Array.from(values).sort();
  const index = clamp(Math.round((sorted.length - 1) * fraction), 0, sorted.length - 1);
  return sorted[index];
}

function movingAverage(values, radius) {
  const output = new Float64Array(values.length);
  if (!values.length) return output;
  const prefix = new Float64Array(values.length + 1);
  for (let index = 0; index < values.length; index += 1) prefix[index + 1] = prefix[index] + values[index];
  for (let index = 0; index < values.length; index += 1) {
    const low = Math.max(0, index - radius);
    const high = Math.min(values.length, index + radius + 1);
    output[index] = (prefix[high] - prefix[low]) / (high - low);
  }
  return output;
}

/* ---------------------------------------------------------------- speech activity */

/**
 * Speech activity per 10 ms frame (0-255) from mono PCM (Int16Array or Float32Array in -1..1),
 * best fed with speech-band filtered audio. Loudness above the local noise floor marks activity;
 * syllabic modulation (the 3-10 Hz rise and fall of speech) weighs it up against steady music.
 */
export function speechActivityFromPcm(samples, { sampleRate = SPEECH_SAMPLE_RATE, frameMs = SPEECH_FRAME_MS } = {}) {
  return speechActivityFromLevels(frameLevelsFromPcm(samples, { sampleRate, frameMs }), { frameMs });
}

/** Loudness (dB) of each 10 ms frame of mono PCM. */
export function frameLevelsFromPcm(samples, { sampleRate = SPEECH_SAMPLE_RATE, frameMs = SPEECH_FRAME_MS } = {}) {
  const frameSize = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
  const frames = Math.floor((samples?.length || 0) / frameSize);
  const scale = samples instanceof Int16Array ? 1 / 32768 : 1;
  const db = new Float64Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    const offset = frame * frameSize;
    for (let index = 0; index < frameSize; index += 1) {
      const value = samples[offset + index] * scale;
      sum += value * value;
    }
    db[frame] = 10 * Math.log10(sum / frameSize + 1e-10);
  }
  return db;
}

/**
 * Speech activity per frame (0-255) from frame levels (dB). The server keeps levels of the audio it
 * is already converting for playback, so any stretch that has played can be analysed at once.
 */
export function speechActivityFromLevels(levels, { frameMs = SPEECH_FRAME_MS } = {}) {
  const frames = levels?.length || 0;
  const activity = new Uint8Array(frames);
  if (!frames) return activity;
  const db = levels instanceof Float64Array ? levels : Float64Array.from(levels);
  // Noise floor and loud level per ~6 s neighbourhood, so a quiet scene after a loud one still works.
  const block = Math.max(1, Math.round(3000 / frameMs));
  const blocks = Math.ceil(frames / block);
  const floors = new Float64Array(blocks);
  const peaks = new Float64Array(blocks);
  for (let index = 0; index < blocks; index += 1) {
    const slice = db.subarray(Math.max(0, (index - 1) * block), Math.min(frames, (index + 2) * block));
    floors[index] = percentile(slice, 0.15);
    peaks[index] = percentile(slice, 0.95);
  }
  const fast = movingAverage(db, Math.round(30 / frameMs));
  const slow = movingAverage(db, Math.round(400 / frameMs));
  const modulation = movingAverage(fast.map((value, index) => Math.abs(value - slow[index])), Math.round(200 / frameMs));
  const soft = new Float64Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    const blockIndex = Math.floor(frame / block);
    const floor = floors[blockIndex];
    const range = Math.max(0, peaks[blockIndex] - floor);
    if (range < 6) continue; // silence or flat noise: no speech here
    const threshold = floor + Math.max(6, range * 0.35);
    const loud = 1 / (1 + Math.exp(-(db[frame] - threshold) / 2.5));
    const syllabic = clamp(modulation[frame] / Math.max(1.5, range * 0.12), 0.25, 1);
    soft[frame] = loud * syllabic;
  }
  const smooth = movingAverage(soft, Math.round(40 / frameMs));
  for (let frame = 0; frame < frames; frame += 1) activity[frame] = Math.round(clamp(smooth[frame], 0, 1) * 255);
  return activity;
}

/* ---------------------------------------------------------------- subtitle side */

// Sound effects, music and captions in brackets are not speech: leave them out of the match.
const NON_SPEECH = /^[\s\u3000]*(?:[(（[［【〈《].*[)）\]］】〉》]|[♪♫♬～〜].*)[\s\u3000]*$/su;

export function isNonSpeechCue(text) {
  const value = String(text || "").replace(/<[^>]+>/g, "").trim();
  return !value || NON_SPEECH.test(value);
}

// 1 inside dialogue cues, 0 elsewhere, for frames covering [fromMs, fromMs + frames * frameMs).
export function cueActivity(cues, { fromMs, frames, frameMs = SPEECH_FRAME_MS }) {
  const mask = new Float64Array(Math.max(0, frames));
  const endMs = fromMs + frames * frameMs;
  for (const cue of cues || []) {
    const start = Number(cue?.startMs);
    const end = Number(cue?.endMs);
    if (!(end > start) || end <= fromMs || start >= endMs || isNonSpeechCue(cue?.text)) continue;
    const first = clamp(Math.floor((start - fromMs) / frameMs), 0, frames);
    const last = clamp(Math.ceil((end - fromMs) / frameMs), 0, frames);
    for (let index = first; index < last; index += 1) mask[index] = 1;
  }
  return mask;
}

/* ---------------------------------------------------------------- FFT correlation */

function fft(re, im, inverse = false) {
  const size = re.length;
  for (let index = 1, swap = 0; index < size; index += 1) {
    let bit = size >> 1;
    for (; swap & bit; bit >>= 1) swap ^= bit;
    swap ^= bit;
    if (index < swap) {
      [re[index], re[swap]] = [re[swap], re[index]];
      [im[index], im[swap]] = [im[swap], im[index]];
    }
  }
  for (let length = 2; length <= size; length <<= 1) {
    const angle = ((inverse ? 2 : -2) * Math.PI) / length;
    const stepRe = Math.cos(angle);
    const stepIm = Math.sin(angle);
    for (let start = 0; start < size; start += length) {
      let wRe = 1;
      let wIm = 0;
      for (let index = 0; index < length / 2; index += 1) {
        const a = start + index;
        const b = a + length / 2;
        const tRe = re[b] * wRe - im[b] * wIm;
        const tIm = re[b] * wIm + im[b] * wRe;
        re[b] = re[a] - tRe;
        im[b] = im[a] - tIm;
        re[a] += tRe;
        im[a] += tIm;
        const nextRe = wRe * stepRe - wIm * stepIm;
        wIm = wRe * stepIm + wIm * stepRe;
        wRe = nextRe;
      }
    }
  }
  if (inverse) {
    for (let index = 0; index < size; index += 1) {
      re[index] /= size;
      im[index] /= size;
    }
  }
}

// c[k] = sum_n signal[n] * kernel[n + k] for k = 0 .. kernel.length - signal.length.
export function crossCorrelate(signal, kernel) {
  const lags = kernel.length - signal.length + 1;
  if (lags <= 0) return new Float64Array(0);
  let size = 1;
  while (size < kernel.length) size <<= 1;
  const aRe = new Float64Array(size);
  const aIm = new Float64Array(size);
  const bRe = new Float64Array(size);
  const bIm = new Float64Array(size);
  aRe.set(signal);
  bRe.set(kernel);
  fft(aRe, aIm);
  fft(bRe, bIm);
  for (let index = 0; index < size; index += 1) {
    // conj(A) * B
    const re = aRe[index] * bRe[index] + aIm[index] * bIm[index];
    const im = aRe[index] * bIm[index] - aIm[index] * bRe[index];
    aRe[index] = re;
    aIm[index] = im;
  }
  fft(aRe, aIm, true);
  return aRe.slice(0, lags);
}

/**
 * Offset of a subtitle track at one audio window.
 * activity: speech activity (0-255 per frame) starting at activityStartMs (video time).
 * Searches offsets in centerOffsetMs ± searchMs. Returns { offsetMs, correlation, peakRatio,
 * speechRatio, cueCount, atMs (subtitle time at the window centre), confident }.
 */
export function estimateSpeechOffset({ activity, activityStartMs, cues, frameMs = SPEECH_FRAME_MS, searchMs = 120_000, centerOffsetMs = 0 }) {
  const frames = activity?.length || 0;
  const result = { offsetMs: 0, correlation: 0, peakRatio: 0, speechRatio: 0, cueCount: 0, atMs: 0, confident: false };
  if (frames < Math.round(15_000 / frameMs)) return result;
  const signal = new Float64Array(frames);
  let mean = 0;
  let active = 0;
  for (let index = 0; index < frames; index += 1) {
    signal[index] = activity[index] / 255;
    mean += signal[index];
    if (signal[index] > 0.5) active += 1;
  }
  mean /= frames;
  let signalNorm = 0;
  for (let index = 0; index < frames; index += 1) {
    signal[index] -= mean;
    signalNorm += signal[index] * signal[index];
  }
  signalNorm = Math.sqrt(signalNorm);
  result.speechRatio = active / frames;
  if (signalNorm < 1e-6) return result;

  const searchFrames = Math.round(searchMs / frameMs);
  const regionStartMs = activityStartMs - centerOffsetMs - searchFrames * frameMs;
  const kernel = cueActivity(cues, { fromMs: regionStartMs, frames: frames + 2 * searchFrames, frameMs });
  const correlation = crossCorrelate(signal, kernel);
  // Normalise by the kernel's local spread, so busy stretches of subtitles don't win by volume.
  const prefix = new Float64Array(kernel.length + 1);
  for (let index = 0; index < kernel.length; index += 1) prefix[index + 1] = prefix[index] + kernel[index];
  const scores = new Float64Array(correlation.length);
  for (let lag = 0; lag < correlation.length; lag += 1) {
    const ones = prefix[lag + frames] - prefix[lag];
    const variance = ones - (ones * ones) / frames; // binary mask: sum(m^2) = sum(m)
    scores[lag] = variance > 1 ? correlation[lag] / (signalNorm * Math.sqrt(variance)) : 0;
  }
  let best = 0;
  let sum = 0;
  let sumSquares = 0;
  for (let lag = 0; lag < scores.length; lag += 1) {
    if (scores[lag] > scores[best]) best = lag;
    sum += scores[lag];
    sumSquares += scores[lag] * scores[lag];
  }
  const meanScore = sum / scores.length;
  const spreadScore = Math.sqrt(Math.max(1e-12, sumSquares / scores.length - meanScore * meanScore));
  const guard = Math.round(1500 / frameMs);
  let second = 0;
  for (let lag = 0; lag < scores.length; lag += 1) if (Math.abs(lag - best) > guard && scores[lag] > second) second = scores[lag];
  // The best few distinct matches: another window may confirm one that isn't this window's top.
  const lagToOffset = (lag) => Math.round(centerOffsetMs + searchFrames * frameMs - lag * frameMs);
  const peaks = [];
  const taken = [];
  for (let round = 0; round < 5; round += 1) {
    let pick = -1;
    for (let lag = 0; lag < scores.length; lag += 1) {
      if (scores[lag] <= 0 || (pick >= 0 && scores[lag] <= scores[pick])) continue;
      if (taken.some((used) => Math.abs(used - lag) <= guard)) continue;
      pick = lag;
    }
    if (pick < 0) break;
    taken.push(pick);
    peaks.push({ offsetMs: lagToOffset(pick), score: Math.round(scores[pick] * 1000) / 1000 });
  }
  let refined = best;
  if (best > 0 && best < scores.length - 1) {
    const left = scores[best - 1];
    const middle = scores[best];
    const right = scores[best + 1];
    const curve = left - 2 * middle + right;
    if (curve < 0) refined = best + clamp((left - right) / (2 * curve), -0.5, 0.5);
  }
  const offsetMs = Math.round(centerOffsetMs + searchFrames * frameMs - refined * frameMs);
  const windowEndMs = activityStartMs + frames * frameMs;
  result.cueCount = (cues || []).filter((cue) => !isNonSpeechCue(cue?.text)
    && Number(cue.endMs) + offsetMs > activityStartMs && Number(cue.startMs) + offsetMs < windowEndMs).length;
  result.offsetMs = offsetMs;
  result.correlation = Math.round(scores[best] * 1000) / 1000;
  result.peakRatio = Math.round((scores[best] / Math.max(0.01, second)) * 100) / 100;
  result.zScore = Math.round(((scores[best] - meanScore) / spreadScore) * 10) / 10;
  result.atMs = Math.round(activityStartMs + (frames * frameMs) / 2 - offsetMs);
  result.videoCenterMs = Math.round(activityStartMs + (frames * frameMs) / 2);
  result.durationMs = frames * frameMs;
  if (peaks.length) peaks[0].offsetMs = offsetMs;
  result.peaks = peaks;
  const enoughSignal = result.speechRatio >= 0.05 && result.cueCount >= 6;
  // strong: trustworthy on its own. confident: worth using when another window agrees.
  result.strong = enoughSignal && result.correlation >= 0.45 && result.peakRatio >= 1.35;
  result.confident = enoughSignal && result.correlation >= 0.2;
  return result;
}

/* ---------------------------------------------------------------- sync model */

function weightedMedian(items) {
  const sorted = items.slice().sort((a, b) => a.offsetMs - b.offsetMs);
  const total = sorted.reduce((sum, item) => sum + item.weight, 0);
  let running = 0;
  for (const item of sorted) {
    running += item.weight;
    if (running >= total / 2) return item.offsetMs;
  }
  return sorted.at(-1)?.offsetMs || 0;
}

// Where a cut between two anchors most likely is: the longest pause between cues there.
function cutBetween(cues, fromMs, toMs) {
  let bestGap = -1;
  let boundary = (fromMs + toMs) / 2;
  const inside = (cues || []).filter((cue) => Number(cue.endMs) >= fromMs && Number(cue.startMs) <= toMs)
    .sort((a, b) => a.startMs - b.startMs);
  for (let index = 1; index < inside.length; index += 1) {
    const gap = Number(inside[index].startMs) - Number(inside[index - 1].endMs);
    if (gap > bestGap) {
      bestGap = gap;
      boundary = (Number(inside[index].startMs) + Number(inside[index - 1].endMs)) / 2;
    }
  }
  return Math.round(boundary);
}

/**
 * Turns window estimates into a sync model: { mode: "constant" | "linear-drift" | "piecewise-step",
 * anchors: [{ atMs, offsetMs, confidence, untilMs? }] } (atMs in subtitle time), or null.
 * A strong window stands on its own. A weaker one counts only when one of its best matches agrees
 * with another window (their top match, or the line through strong windows): two windows agreeing
 * by chance on an offset within ±2 minutes is very unlikely, one window alone can be fooled.
 */
export function syncModelFromEstimates(estimates, { cues = [], agreeMs = 300 } = {}) {
  const windows = (estimates || []).filter((item) => item?.confident && Array.isArray(item.peaks) && item.peaks.length);
  const place = (item, offsetMs, confidence, strong) => ({
    atMs: Math.round((Number.isFinite(item.videoCenterMs) ? item.videoCenterMs : Number(item.atMs) + Number(item.offsetMs)) - offsetMs),
    offsetMs,
    confidence,
    strong,
  });
  const strongPicks = windows.filter((item) => item.strong).map((item) => place(item, item.peaks[0].offsetMs, item.peaks[0].score, true));
  const predicted = (centerMs) => {
    if (strongPicks.length < 2) return [];
    const sorted = strongPicks.slice().sort((a, b) => a.atMs - b.atMs);
    const values = [];
    for (let index = 1; index < sorted.length; index += 1) {
      const left = sorted[index - 1];
      const right = sorted[index];
      const leftCenter = left.atMs + left.offsetMs;
      const rightCenter = right.atMs + right.offsetMs;
      if (centerMs < leftCenter || centerMs > rightCenter) continue;
      const ratio = (centerMs - leftCenter) / Math.max(1, rightCenter - leftCenter);
      values.push(left.offsetMs + (right.offsetMs - left.offsetMs) * ratio);
    }
    return values;
  };
  let anchors = [...strongPicks];
  const span = (item) => [Number(item.videoCenterMs) - (item.durationMs || 90_000) / 2, Number(item.videoCenterMs) + (item.durationMs || 90_000) / 2];
  const independent = (a, b) => {
    const [aStart, aEnd] = span(a);
    const [bStart, bEnd] = span(b);
    return aEnd <= bStart || bEnd <= aStart; // overlapping windows share audio: not separate evidence
  };
  for (const item of windows) {
    if (item.strong) continue;
    // Another weak window only vouches when one of the two stands out clearly (z ≥ 3.8): two
    // unrelated windows agree by chance too often otherwise.
    const references = [
      ...windows.filter((other) => other !== item && other.strong && independent(item, other)).map((other) => other.peaks[0].offsetMs),
      ...windows.filter((other) => other !== item && !other.strong && independent(item, other) && Math.max(Number(item.zScore) || 0, Number(other.zScore) || 0) >= 3.8)
        .map((other) => other.peaks[0].offsetMs),
      ...predicted(item.videoCenterMs),
    ];
    const top = item.peaks[0].score;
    const candidate = item.peaks.slice(0, 3)
      .filter((peak) => peak.score >= top * 0.6 && references.some((reference) => Math.abs(reference - peak.offsetMs) <= agreeMs))
      .sort((a, b) => b.score - a.score)[0];
    if (candidate) anchors.push(place(item, candidate.offsetMs, candidate.score, false));
  }
  anchors.sort((a, b) => a.atMs - b.atMs);
  if (!anchors.length) return null;
  if (anchors.length >= 3) {
    anchors = anchors.filter((anchor, index) => {
      const neighbours = [anchors[index - 1], anchors[index + 1]].filter(Boolean);
      const agrees = neighbours.some((item) => Math.abs(item.offsetMs - anchor.offsetMs) <= 1500);
      const neighboursAgree = neighbours.length === 2 && Math.abs(neighbours[0].offsetMs - neighbours[1].offsetMs) <= 1500;
      return agrees || !neighboursAgree;
    });
  }
  const weighted = anchors.map((anchor) => ({ ...anchor, weight: Math.max(0.05, anchor.confidence) }));
  anchors = anchors.map(({ strong, ...anchor }) => anchor);
  const offsets = anchors.map((anchor) => anchor.offsetMs);
  if (Math.max(...offsets) - Math.min(...offsets) <= 300) {
    return { mode: "constant", anchors: [{ atMs: anchors[Math.floor(anchors.length / 2)].atMs, offsetMs: weightedMedian(weighted), confidence: Math.max(...anchors.map((anchor) => anchor.confidence)) }] };
  }
  if (anchors.length >= 3) {
    // Frame-rate drift: offsets on one straight line.
    const total = weighted.reduce((sum, item) => sum + item.weight, 0);
    const meanT = weighted.reduce((sum, item) => sum + item.weight * item.atMs, 0) / total;
    const meanO = weighted.reduce((sum, item) => sum + item.weight * item.offsetMs, 0) / total;
    const covariance = weighted.reduce((sum, item) => sum + item.weight * (item.atMs - meanT) * (item.offsetMs - meanO), 0);
    const spread = weighted.reduce((sum, item) => sum + item.weight * (item.atMs - meanT) ** 2, 0);
    const slope = spread > 0 ? covariance / spread : 0;
    const fits = anchors.every((anchor) => Math.abs(meanO + slope * (anchor.atMs - meanT) - anchor.offsetMs) <= 250);
    if (fits && Math.abs(slope) <= 0.06) {
      const first = anchors[0].atMs;
      const last = anchors.at(-1).atMs;
      return {
        mode: "linear-drift",
        anchors: [first, last].map((atMs) => ({ atMs, offsetMs: Math.round(meanO + slope * (atMs - meanT)), confidence: Math.min(...anchors.map((anchor) => anchor.confidence)) })),
      };
    }
  }
  // Jumps: merge neighbours that agree, then place each step in the longest pause between them.
  const segments = [];
  for (const anchor of anchors) {
    const last = segments.at(-1);
    if (last && Math.abs(last.offsetMs - anchor.offsetMs) <= 300) {
      last.members.push(anchor);
      last.offsetMs = weightedMedian(last.members.map((item) => ({ ...item, weight: Math.max(0.05, item.confidence) })));
      last.lastAtMs = anchor.atMs;
    } else {
      segments.push({ members: [anchor], offsetMs: anchor.offsetMs, firstAtMs: anchor.atMs, lastAtMs: anchor.atMs });
    }
  }
  return {
    mode: "piecewise-step",
    anchors: segments.map((segment, index) => ({
      atMs: Math.round((segment.firstAtMs + segment.lastAtMs) / 2),
      offsetMs: segment.offsetMs,
      confidence: Math.max(...segment.members.map((item) => item.confidence)),
      ...(index < segments.length - 1 ? { untilMs: cutBetween(cues, segment.lastAtMs, segments[index + 1].firstAtMs) } : {}),
    })),
  };
}

// Offset (ms) of a model at subtitle time atMs.
export function offsetAt(model, atMs) {
  const anchors = (model?.anchors || []).filter((anchor) => Number.isFinite(Number(anchor?.offsetMs)));
  if (!anchors.length) return 0;
  const at = Number(atMs) || 0;
  if (anchors.length === 1 || model.mode === "constant") return Number(anchors[0].offsetMs);
  if (model.mode === "piecewise-step") {
    if (anchors.some((anchor) => Number.isFinite(Number(anchor.untilMs)))) {
      for (const anchor of anchors) if (!Number.isFinite(Number(anchor.untilMs)) || at <= Number(anchor.untilMs)) return Number(anchor.offsetMs);
      return Number(anchors.at(-1).offsetMs);
    }
    let nearest = anchors[0];
    for (const anchor of anchors) if (Math.abs(at - anchor.atMs) < Math.abs(at - nearest.atMs)) nearest = anchor;
    return Number(nearest.offsetMs);
  }
  if (at <= anchors[0].atMs) return Number(anchors[0].offsetMs);
  if (at >= anchors.at(-1).atMs) return Number(anchors.at(-1).offsetMs);
  for (let index = 1; index < anchors.length; index += 1) {
    const right = anchors[index];
    if (at > right.atMs) continue;
    const left = anchors[index - 1];
    const ratio = (at - left.atMs) / Math.max(1, right.atMs - left.atMs);
    return Math.round(Number(left.offsetMs) + (Number(right.offsetMs) - Number(left.offsetMs)) * ratio);
  }
  return Number(anchors.at(-1).offsetMs);
}

/* ---------------------------------------------------------------- cut boundaries */

// All analysed windows as one timeline (video time); frames no window covered are -1.
export function mergeActivity(windows, frameMs = SPEECH_FRAME_MS) {
  const list = (windows || []).filter((item) => item?.activity?.length);
  if (!list.length) return null;
  const startMs = Math.min(...list.map((item) => item.startMs));
  const endMs = Math.max(...list.map((item) => item.startMs + item.activity.length * frameMs));
  const merged = new Int16Array(Math.round((endMs - startMs) / frameMs)).fill(-1);
  for (const item of list) {
    const offset = Math.round((item.startMs - startMs) / frameMs);
    for (let index = 0; index < item.activity.length; index += 1) merged[offset + index] = Math.max(merged[offset + index], item.activity[index]);
  }
  return { startMs, frameMs, activity: merged };
}

function meanActivity(coverage, fromMs, toMs) {
  const first = Math.floor((fromMs - coverage.startMs) / coverage.frameMs);
  const last = Math.ceil((toMs - coverage.startMs) / coverage.frameMs);
  if (first < 0 || last > coverage.activity.length || last <= first) return null;
  let sum = 0;
  for (let index = first; index < last; index += 1) {
    if (coverage.activity[index] < 0) return null;
    sum += coverage.activity[index];
  }
  return sum / (last - first);
}

/**
 * Where a track switches from one offset to another (a cut), in subtitle time: every line before
 * it fits beforeOffsetMs better, every line after fits afterOffsetMs. A line fits an offset when
 * the audio under it is speech and the pauses next to it are quiet. Only lines whose audio was
 * analysed under both offsets count. Returns null when too few lines can tell.
 */
export function refineCutBoundary(coverage, cues, { fromMs, toMs, beforeOffsetMs, afterOffsetMs }) {
  if (!coverage) return null;
  const sorted = (cues || []).filter((cue) => !isNonSpeechCue(cue?.text)).sort((a, b) => a.startMs - b.startMs);
  const contrast = (index, offset) => {
    const cue = sorted[index];
    const inside = meanActivity(coverage, cue.startMs + offset, cue.endMs + offset);
    if (inside === null) return null;
    const margins = [];
    const previousEnd = index > 0 ? Number(sorted[index - 1].endMs) : -Infinity;
    const nextStart = index < sorted.length - 1 ? Number(sorted[index + 1].startMs) : Infinity;
    const before = Math.min(500, Number(cue.startMs) - previousEnd);
    const after = Math.min(500, nextStart - Number(cue.endMs));
    if (before >= 150) margins.push(meanActivity(coverage, cue.startMs - before + offset, cue.startMs + offset));
    if (after >= 150) margins.push(meanActivity(coverage, cue.endMs + offset, cue.endMs + after + offset));
    const quiet = margins.filter((value) => value !== null);
    return quiet.length ? inside - quiet.reduce((sum, value) => sum + value, 0) / quiet.length : inside * 0.5;
  };
  const scored = [];
  for (let index = 0; index < sorted.length; index += 1) {
    const cue = sorted[index];
    if (Number(cue.startMs) < fromMs || Number(cue.startMs) > toMs) continue;
    const before = contrast(index, beforeOffsetMs);
    const after = contrast(index, afterOffsetMs);
    if (before === null || after === null) continue;
    scored.push({ cue, diff: after - before });
  }
  if (scored.length < 6) return null;
  // Boundary before line k: lines before it should favour "before", lines after it "after".
  // Maximising sum(after-side diffs) - sum(before-side diffs) = minimising the prefix sum.
  let prefix = 0;
  let bestPrefix = 0;
  let bestIndex = 0;
  for (let index = 0; index < scored.length; index += 1) {
    prefix += scored[index].diff;
    if (prefix < bestPrefix) {
      bestPrefix = prefix;
      bestIndex = index + 1;
    }
  }
  if (bestIndex === 0 || bestIndex === scored.length) return null;
  const left = scored[bestIndex - 1].cue;
  const right = scored[bestIndex].cue;
  return Math.round((Number(left.endMs) + Number(right.startMs)) / 2);
}

/* ---------------------------------------------------------------- frame-rate mismatch */

// Subtitles timed for another frame rate run slowly off: a 25 fps release on a 23.976 fps video
// ends ~60 s late. Each ratio is video/subtitle time: 23.976 fps video with 25 fps subtitles → 25/23.976.
export const FRAME_RATE_SCALES = Object.freeze([
  1,
  25 / 23.976, 23.976 / 25,
  25 / 24, 24 / 25,
  24 / 23.976, 23.976 / 24,
  30 / 29.97, 29.97 / 30,
  25 / 29.97, 29.97 / 25,
]);

function scaledCues(cues, scale) {
  return scale === 1 ? cues : cues.map((cue) => ({ ...cue, startMs: cue.startMs * scale, endMs: cue.endMs * scale }));
}

/**
 * Sync model for a track from speech windows, trying common frame-rate ratios. Returns
 * { model, scale } (anchors already include the scaling: offsetAt(model, t) = t * (scale - 1) + b)
 * or null. cache (a Map, optional) keeps estimates between calls as windows are added.
 */
export function syncTrackToSpeech(windows, cues, { searchMs = 120_000, cache = null } = {}) {
  const fits = [];
  for (const scale of FRAME_RATE_SCALES) {
    const scaled = scaledCues(cues, scale);
    const estimates = (windows || []).map((item) => {
      const key = `${item.startMs}:${scale}`;
      if (cache?.has(key)) return cache.get(key);
      const value = estimateSpeechOffset({ activity: item.activity, activityStartMs: item.startMs, cues: scaled, searchMs });
      cache?.set(key, value);
      return value;
    });
    const model = syncModelFromEstimates(estimates, { cues: scaled });
    // A frame-rate fix must explain every window with one offset; anything else is not that.
    if (!model || (scale !== 1 && model.mode !== "constant")) continue;
    const score = estimates.filter((item) => item.confident)
      .reduce((sum, item) => sum + (model.anchors.some((anchor) => Math.abs(anchor.offsetMs - item.peaks[0].offsetMs) <= 300) ? item.peaks[0].score : 0), 0);
    fits.push({ scale, model, score });
    if (scale === 1 && model.mode === "constant" && estimates.filter((item) => item.strong).length >= 2) break; // clean unscaled fit
  }
  if (!fits.length) return null;
  const plain = fits.find((fit) => fit.scale === 1);
  const best = fits.filter((fit) => fit.scale !== 1).sort((a, b) => b.score - a.score)[0];
  // Two windows that disagree fit both a cut and a frame-rate drift; a drift of exactly a known
  // frame-rate ratio is far likelier than a cut of that exact size.
  const useScaled = best && (!plain
    || best.score >= plain.score * 1.25
    || (plain.model.mode !== "constant" && best.score >= plain.score * 0.9));
  if (!useScaled) {
    const model = plain.model;
    if (model.mode === "piecewise-step" && model.anchors.length > 1) {
      const coverage = mergeActivity(windows);
      model.anchors = model.anchors.map((anchor, index) => {
        const next = model.anchors[index + 1];
        if (!next) return anchor;
        const boundary = refineCutBoundary(coverage, cues, { fromMs: anchor.atMs, toMs: next.atMs, beforeOffsetMs: anchor.offsetMs, afterOffsetMs: next.offsetMs });
        return boundary === null ? anchor : { ...anchor, untilMs: boundary, located: true };
      });
    }
    return { model, scale: 1 };
  }
  const b = best.model.anchors[0].offsetMs;
  const starts = cues.map((cue) => Number(cue.startMs)).filter(Number.isFinite);
  const first = Math.min(...starts);
  const last = Math.max(...starts);
  return {
    scale: best.scale,
    model: {
      mode: "linear-drift",
      anchors: [first, last].map((atMs) => ({ atMs, offsetMs: Math.round(atMs * (best.scale - 1) + b), confidence: best.model.anchors[0].confidence })),
    },
  };
}

/* ---------------------------------------------------------------- pairing */

/**
 * Lines of another track that belong with one cue, both in video time: every cue that overlaps it
 * enough (one long line often splits into two shorter ones in another language).
 * cue: { startMs, endMs } in video time; others: [{ startMs, endMs, text, ... }] in video time.
 */
export function pairedCues(cue, others) {
  const start = Number(cue?.startMs);
  const end = Number(cue?.endMs);
  if (!(end > start)) return [];
  const matches = [];
  for (const other of others || []) {
    const otherStart = Number(other?.startMs);
    const otherEnd = Number(other?.endMs);
    if (!(otherEnd > otherStart) || otherEnd < start - 200 || otherStart > end + 200) continue;
    const overlap = Math.max(0, Math.min(end, otherEnd) - Math.max(start, otherStart));
    const shorter = Math.min(end - start, otherEnd - otherStart);
    const middle = (otherStart + otherEnd) / 2;
    if (overlap >= shorter * 0.35 || (middle >= start - 150 && middle <= end + 150)) matches.push(other);
  }
  if (!matches.length) {
    // No overlap at all: a line that starts within half a second still belongs to it.
    let nearest = null;
    for (const other of others || []) {
      const distance = Math.abs(Number(other?.startMs) - start);
      if (distance <= 500 && (!nearest || distance < Math.abs(Number(nearest.startMs) - start))) nearest = other;
    }
    if (nearest) matches.push(nearest);
  }
  return matches.sort((a, b) => Number(a.startMs) - Number(b.startMs));
}
