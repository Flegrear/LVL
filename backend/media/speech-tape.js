// speech-tape.js: keeps the loudness of every 10 ms of audio that the playback transcode decodes
// anyway (a second FFmpeg output, 16 kHz mono), so subtitle sync can read any stretch that has
// been converted without decoding or downloading anything again. Node only (server.js).

import { SPEECH_FRAME_MS, SPEECH_SAMPLE_RATE, speechActivityFromLevels } from "../../shared/subtitles/subtitle-sync.js";

const FRAME_SAMPLES = Math.round((SPEECH_SAMPLE_RATE * SPEECH_FRAME_MS) / 1000);
const CHUNK_FRAMES = 6000; // one minute per chunk
const MAX_TAPES = 8;
const tapes = new Map();

class SpeechTape {
  constructor() {
    this.chunks = new Map(); // chunk index -> Float32Array (NaN = not heard yet)
    this.ranges = []; // [fromFrame, toFrame) runs, merged
    this.touchedAt = Date.now();
  }

  write(frame, value) {
    const chunkIndex = Math.floor(frame / CHUNK_FRAMES);
    let chunk = this.chunks.get(chunkIndex);
    if (!chunk) {
      chunk = new Float32Array(CHUNK_FRAMES).fill(Number.NaN);
      this.chunks.set(chunkIndex, chunk);
    }
    chunk[frame - chunkIndex * CHUNK_FRAMES] = value;
  }

  read(frame) {
    const chunkIndex = Math.floor(frame / CHUNK_FRAMES);
    const chunk = this.chunks.get(chunkIndex);
    return chunk ? chunk[frame - chunkIndex * CHUNK_FRAMES] : Number.NaN;
  }

  addRange(from, to) {
    if (!(to > from)) return;
    const merged = [];
    let next = [from, to];
    for (const range of this.ranges) {
      if (range[1] < next[0] - 1 || range[0] > next[1] + 1) merged.push(range);
      else next = [Math.min(range[0], next[0]), Math.max(range[1], next[1])];
    }
    merged.push(next);
    this.ranges = merged.sort((a, b) => a[0] - b[0]);
  }

  coverage() {
    return this.ranges.map(([from, to]) => ({ fromMs: from * SPEECH_FRAME_MS, toMs: to * SPEECH_FRAME_MS }));
  }

  coveredFraction(fromFrame, toFrame) {
    let covered = 0;
    for (const [from, to] of this.ranges) covered += Math.max(0, Math.min(to, toFrame) - Math.max(from, fromFrame));
    return toFrame > fromFrame ? covered / (toFrame - fromFrame) : 0;
  }
}

function tapeKey(sessionId, fileIndex, audio) {
  return `${sessionId}:${Number(fileIndex)}:${Number(audio) || 0}`;
}

function tapeFor(sessionId, fileIndex, audio, { create = false } = {}) {
  const key = tapeKey(sessionId, fileIndex, audio);
  let tape = tapes.get(key);
  if (!tape && create) {
    tape = new SpeechTape();
    tapes.set(key, tape);
    while (tapes.size > MAX_TAPES) {
      const oldest = [...tapes.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt)[0];
      tapes.delete(oldest[0]);
    }
  }
  if (tape) tape.touchedAt = Date.now();
  return tape || null;
}

/**
 * A writer for one FFmpeg run that starts at startSeconds: feed it s16le mono chunks as they come.
 */
export function speechTapeWriter(sessionId, fileIndex, audio, startSeconds) {
  const tape = tapeFor(sessionId, fileIndex, audio, { create: true });
  const startFrame = Math.max(0, Math.round((Number(startSeconds) || 0) * 1000 / SPEECH_FRAME_MS));
  let frame = startFrame;
  let rangeStart = startFrame;
  let carry = Buffer.alloc(0);
  let sum = 0;
  let count = 0;
  return {
    push(chunk) {
      const data = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const usable = data.length - (data.length % 2);
      for (let offset = 0; offset < usable; offset += 2) {
        const value = data.readInt16LE(offset) / 32768;
        sum += value * value;
        count += 1;
        if (count === FRAME_SAMPLES) {
          tape.write(frame, 10 * Math.log10(sum / FRAME_SAMPLES + 1e-10));
          frame += 1;
          sum = 0;
          count = 0;
        }
      }
      carry = data.subarray(usable);
      if (frame - rangeStart >= 100) {
        tape.addRange(rangeStart, frame);
        rangeStart = frame;
      }
      tape.touchedAt = Date.now();
    },
    end() {
      tape.addRange(rangeStart, frame);
    },
  };
}

export function speechTapeCoverage(sessionId, fileIndex, audio) {
  return tapeFor(sessionId, fileIndex, audio)?.coverage() || [];
}

/**
 * Speech activity for [startMs, startMs + durationMs) from the tape, or null when less than
 * minCovered of it has been heard. Gaps (a few frames between runs) take the window's quiet level.
 */
export function speechTapeActivity(sessionId, fileIndex, audio, startMs, durationMs, { minCovered = 0.95 } = {}) {
  const tape = tapeFor(sessionId, fileIndex, audio);
  if (!tape) return null;
  const from = Math.max(0, Math.round(startMs / SPEECH_FRAME_MS));
  const to = from + Math.max(1, Math.round(durationMs / SPEECH_FRAME_MS));
  if (tape.coveredFraction(from, to) < minCovered) return null;
  const levels = new Float64Array(to - from);
  const known = [];
  for (let index = 0; index < levels.length; index += 1) {
    const value = tape.read(from + index);
    levels[index] = value;
    if (Number.isFinite(value)) known.push(value);
  }
  known.sort((a, b) => a - b);
  const quiet = known.length ? known[Math.floor(known.length * 0.15)] : -100;
  for (let index = 0; index < levels.length; index += 1) if (!Number.isFinite(levels[index])) levels[index] = quiet;
  return speechActivityFromLevels(levels, { frameMs: SPEECH_FRAME_MS });
}

export function dropSpeechTapes(sessionId) {
  for (const key of [...tapes.keys()]) if (key.startsWith(`${sessionId}:`)) tapes.delete(key);
}
