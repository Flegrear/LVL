import test from "node:test";
import assert from "node:assert/strict";
import {
  crossCorrelate,
  cueActivity,
  estimateSpeechOffset,
  isNonSpeechCue,
  offsetAt,
  pairedCues,
  speechActivityFromPcm,
  syncModelFromEstimates,
  syncTrackToSpeech,
} from "../shared/subtitles/subtitle-sync.js";

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

// A 30-minute track: lines of 0.8-4 s with pauses of 0.2-6 s.
function makeCues(seed = 1, durationMs = 30 * 60_000) {
  const next = random(seed);
  const cues = [];
  let at = 4_000;
  while (at < durationMs - 5_000) {
    const length = 800 + next() * 3_200;
    cues.push({ id: `c${cues.length}`, startMs: Math.round(at), endMs: Math.round(at + length), text: `Line ${cues.length}` });
    at += length + 200 + next() * 5_800;
  }
  return cues;
}

// What the audio looks like for a window when the track is offMs off: speech near the lines
// (edges jitter, some lines silent), plus music/effects bursts and noise.
function speechFor(cues, { offsetMs, startMs, durationMs, seed = 7, frameMs = 10, drop = 0.12, bursts = 1 }) {
  const next = random(seed);
  const frames = Math.round(durationMs / frameMs);
  const values = new Float64Array(frames);
  for (const cue of cues) {
    if (next() < drop) continue;
    const from = cue.startMs + offsetMs + (next() - 0.5) * 300;
    const to = cue.endMs + offsetMs + (next() - 0.5) * 400;
    for (let frame = Math.max(0, Math.floor((from - startMs) / frameMs)); frame < Math.min(frames, Math.ceil((to - startMs) / frameMs)); frame += 1) values[frame] = 0.85;
  }
  for (let burst = 0; burst < (bursts * durationMs) / 6_000; burst += 1) {
    const from = Math.floor(next() * frames);
    const length = Math.floor(50 + next() * 250);
    for (let frame = from; frame < Math.min(frames, from + length); frame += 1) values[frame] = Math.max(values[frame], 0.6);
  }
  return Uint8Array.from(values, (value) => Math.round(Math.min(1, Math.max(0, value + (next() - 0.5) * 0.3)) * 255));
}

test("cross-correlation matches the direct sum", () => {
  const next = random(3);
  const signal = Float64Array.from({ length: 37 }, () => next() - 0.5);
  const kernel = Float64Array.from({ length: 101 }, () => next() - 0.5);
  const fast = crossCorrelate(signal, kernel);
  assert.equal(fast.length, 65);
  for (const lag of [0, 1, 17, 64]) {
    let direct = 0;
    for (let index = 0; index < signal.length; index += 1) direct += signal[index] * kernel[index + lag];
    assert.ok(Math.abs(fast[lag] - direct) < 1e-9, `lag ${lag}`);
  }
});

test("sound effects, music and bracketed captions don't count as speech", () => {
  for (const text of ["(馬車の進行音)", "（笑）", "[door opens]", "♪～", "〜♪ opening song", "<i>(sighs)</i>", ""]) assert.equal(isNonSpeechCue(text), true, text);
  for (const text of ["Hello there", "(Laughs) I can't believe it", "何だって？", "- Wait!\n- No."]) assert.equal(isNonSpeechCue(text), false, text);
  const mask = cueActivity([{ startMs: 100, endMs: 300, text: "Hi" }, { startMs: 400, endMs: 600, text: "(music)" }], { fromMs: 0, frames: 70 });
  assert.equal(mask[15], 1);
  assert.equal(mask[50], 0, "bracketed caption left out");
  assert.equal(mask[5], 0);
});

test("a track's offset is recovered from a noisy 90-second window", () => {
  const cues = makeCues(11);
  for (const [offsetMs, startMs] of [[0, 300_000], [7_300, 600_000], [-42_150, 900_000], [95_000, 1_200_000]]) {
    const activity = speechFor(cues, { offsetMs, startMs, durationMs: 90_000, seed: offsetMs & 0xffff });
    const estimate = estimateSpeechOffset({ activity, activityStartMs: startMs, cues, searchMs: 120_000 });
    assert.ok(estimate.strong, `strong for ${offsetMs}: ${JSON.stringify({ ...estimate, peaks: undefined })}`);
    assert.ok(Math.abs(estimate.offsetMs - offsetMs) <= 150, `offset ${offsetMs} estimated as ${estimate.offsetMs}`);
    assert.ok(Math.abs(estimate.atMs - (startMs + 45_000 - offsetMs)) <= 200, "anchor sits at the window centre in subtitle time");
    assert.equal(estimate.peaks[0].offsetMs, estimate.offsetMs);
  }
});

test("an unrelated track or a silent window is not trusted", () => {
  const cues = makeCues(21);
  const windows = [600_000, 1_000_000].map((startMs, index) => estimateSpeechOffset({
    activity: speechFor(makeCues(99 + index), { offsetMs: 0, startMs, durationMs: 90_000, seed: 5 + index }),
    activityStartMs: startMs,
    cues,
  }));
  windows.forEach((estimate) => assert.equal(estimate.strong, false));
  assert.equal(syncModelFromEstimates(windows), null, "two unrelated windows don't agree on an offset");
  assert.equal(estimateSpeechOffset({ activity: new Uint8Array(9_000), activityStartMs: 600_000, cues }).confident, false);
  assert.equal(estimateSpeechOffset({ activity: new Uint8Array(500), activityStartMs: 0, cues }).confident, false, "too short");
});

test("weak windows count when another window agrees", () => {
  const cues = makeCues(31);
  const weak = [400_000, 900_000].map((startMs, index) => estimateSpeechOffset({
    activity: speechFor(cues, { offsetMs: 12_400, startMs, durationMs: 90_000, seed: 40 + index, drop: 0.35, bursts: 3 }),
    activityStartMs: startMs,
    cues,
  }));
  const model = syncModelFromEstimates(weak.map((estimate) => ({ ...estimate, strong: false })), { cues });
  assert.ok(model, "agreeing weak windows give a model");
  assert.ok(Math.abs(offsetAt(model, 600_000) - 12_400) <= 300, `offset ${offsetAt(model, 600_000)}`);
  assert.equal(syncModelFromEstimates([{ ...weak[0], strong: false }], { cues }), null, "one weak window alone is not enough");
});

test("window estimates become a constant, drifting or cut-aware model", () => {
  const est = (atMs, offsetMs, { score = 0.5, strong = true, confident = true } = {}) => ({ confident, strong, peaks: [{ offsetMs, score }], videoCenterMs: atMs + offsetMs, atMs, offsetMs });
  const constant = syncModelFromEstimates([est(100_000, 1_210), est(700_000, 1_180, { score: 0.6 }), est(900_000, 40_000, { score: 0.1, strong: false })]);
  assert.equal(constant.mode, "constant");
  assert.ok(Math.abs(offsetAt(constant, 5_000_000) - 1_200) <= 30);

  // 25 fps release against 23.976 fps video: the offset grows along the episode.
  const drift = syncModelFromEstimates([0, 1, 2, 3].map((index) => est(200_000 + index * 400_000, Math.round(0.042 * (200_000 + index * 400_000)))));
  assert.equal(drift.mode, "linear-drift");
  assert.ok(Math.abs(offsetAt(drift, 600_000) - 25_200) <= 60);

  // A recap cut: +2 s before the pause at ~12:05, +33 s after it.
  const cues = [
    { startMs: 600_000, endMs: 602_000 }, { startMs: 700_000, endMs: 702_000 },
    { startMs: 703_000, endMs: 705_000 }, { startMs: 745_000, endMs: 747_000 }, { startMs: 760_000, endMs: 762_000 },
  ];
  const cut = syncModelFromEstimates([est(300_000, 2_000), est(650_000, 2_050), est(900_000, 33_000)], { cues });
  assert.equal(cut.mode, "piecewise-step");
  assert.equal(cut.anchors.length, 2);
  assert.equal(cut.anchors[0].untilMs, 725_000, "the step sits in the longest pause between the anchors");
  assert.ok(Math.abs(offsetAt(cut, 720_000) - 2_025) <= 30);
  assert.equal(offsetAt(cut, 730_000), 33_000);

  const outlier = syncModelFromEstimates([est(100_000, 500), est(400_000, 61_000, { score: 0.3 }), est(700_000, 520)]);
  assert.equal(outlier.mode, "constant", "one disagreeing window between two agreeing ones is dropped");
  assert.equal(syncModelFromEstimates([est(1, 9, { confident: false })]), null);
});

test("a line pairs with every line of the other track that overlaps it enough", () => {
  const base = [
    { startMs: 9_800, endMs: 11_000, text: "Where are you going" },
    { startMs: 11_100, endMs: 12_600, text: "at this hour?" },
    { startMs: 13_000, endMs: 14_000, text: "Home." },
    { startMs: 20_000, endMs: 21_000, text: "Later." },
  ];
  assert.deepEqual(pairedCues({ startMs: 10_000, endMs: 12_500 }, base).map((cue) => cue.text), ["Where are you going", "at this hour?"]);
  assert.deepEqual(pairedCues({ startMs: 12_900, endMs: 13_300 }, base).map((cue) => cue.text), ["Home."]);
  assert.deepEqual(pairedCues({ startMs: 16_000, endMs: 17_000 }, base), []);
  assert.deepEqual(pairedCues({ startMs: 19_600, endMs: 19_900 }, base).map((cue) => cue.text), ["Later."], "a line starting right after still pairs");
});

test("speech activity is high in speech-like audio and low in silence or steady noise", () => {
  const rate = 16_000;
  const next = random(4);
  const samples = new Int16Array(rate * 12);
  for (let index = 0; index < samples.length; index += 1) {
    const t = index / rate;
    const noise = (next() - 0.5) * 300;
    const speaking = (t >= 2 && t < 5) || (t >= 8 && t < 10);
    // Voiced sound with a syllable-rate (5 Hz) envelope.
    const syllables = 0.5 + 0.5 * Math.sin(2 * Math.PI * 5 * t);
    const voice = speaking ? syllables * (Math.sin(2 * Math.PI * 180 * t) + 0.5 * Math.sin(2 * Math.PI * 720 * t)) * 9000 : 0;
    samples[index] = Math.round(noise + voice);
  }
  const activity = speechActivityFromPcm(samples, { sampleRate: rate });
  assert.equal(activity.length, 1_200);
  const mean = (from, to) => activity.slice(from / 10, to / 10).reduce((sum, value) => sum + value, 0) / ((to - from) / 10);
  assert.ok(mean(2_200, 4_800) > 110, `speech ${mean(2_200, 4_800)}`);
  assert.ok(mean(8_200, 9_800) > 110);
  assert.ok(mean(5_500, 7_500) < 40, `pause ${mean(5_500, 7_500)}`);
  assert.ok(mean(10_500, 11_900) < 40);
  assert.equal(speechActivityFromPcm(new Int16Array(0)).length, 0);
});


test("subtitles made for another frame rate are recognised and rescaled", () => {
  const video = makeCues(51);
  // A 25 fps release on a 23.976 fps video: subtitle time runs 4.3% short.
  const scale = 25 / 23.976;
  const track = video.map((cue) => ({ ...cue, startMs: Math.round(cue.startMs / scale), endMs: Math.round(cue.endMs / scale) }));
  const windows = [300_000, 700_000, 1_100_000].map((startMs, index) => ({
    startMs,
    activity: speechFor(video, { offsetMs: 0, startMs, durationMs: 90_000, seed: 60 + index }),
  }));
  const fit = syncTrackToSpeech(windows, track);
  assert.ok(fit, "a model");
  assert.ok(Math.abs(fit.scale - scale) < 1e-9, `scale ${fit.scale}`);
  for (const cue of track.filter((_, index) => index % 40 === 0)) {
    const expected = Math.round(cue.startMs * scale) - cue.startMs;
    assert.ok(Math.abs(offsetAt(fit.model, cue.startMs) - expected) <= 250, `at ${cue.startMs}: ${offsetAt(fit.model, cue.startMs)} vs ${expected}`);
  }
  const plainWindows = windows.map((item, index) => ({ ...item, activity: speechFor(video, { offsetMs: 3_000, startMs: item.startMs, durationMs: 90_000, seed: 70 + index }) }));
  assert.equal(syncTrackToSpeech(plainWindows, video).scale, 1, "a plain offset stays unscaled");
});

test("a cut is placed at the line where the offset changes", () => {
  // The video has 60 s at 10:00 that the subtitle file doesn't: later lines are 60 s early.
  const video = makeCues(61);
  const cutAt = 600_000;
  const track = video.filter((cue) => cue.startMs < cutAt || cue.startMs >= cutAt + 60_000)
    .map((cue) => (cue.startMs >= cutAt ? { ...cue, startMs: cue.startMs - 60_000, endMs: cue.endMs - 60_000 } : cue));
  const windows = [440_000, 530_000, 620_000, 710_000].map((startMs, index) => ({
    startMs,
    activity: speechFor(video, { offsetMs: 0, startMs, durationMs: 90_000, seed: 80 + index }),
  }));
  const fit = syncTrackToSpeech(windows, track);
  assert.equal(fit.model.mode, "piecewise-step");
  const boundary = fit.model.anchors[0].untilMs;
  assert.ok(Math.abs(boundary - cutAt) <= 8_000, `cut placed at ${boundary}`);
  const wrong = track.filter((cue) => Math.abs(offsetAt(fit.model, cue.startMs) - (cue.startMs >= cutAt ? 60_000 : 0)) > 500);
  assert.ok(wrong.length <= 2, `${wrong.length} lines on the wrong side`);
});

test("windows that share audio don't vouch for each other", () => {
  const cues = makeCues(71);
  const activity = speechFor(makeCues(72), { offsetMs: 0, startMs: 500_000, durationMs: 140_000, seed: 3 });
  const first = estimateSpeechOffset({ activity: activity.slice(0, 9_000), activityStartMs: 500_000, cues });
  const second = estimateSpeechOffset({ activity: activity.slice(5_000, 14_000), activityStartMs: 550_000, cues });
  assert.equal(syncModelFromEstimates([{ ...first, strong: false }, { ...second, strong: false }]), null);
});
