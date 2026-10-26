import test from "node:test";
import assert from "node:assert/strict";
import { dropSpeechTapes, speechTapeActivity, speechTapeCoverage, speechTapeWriter } from "../backend/media/speech-tape.js";
import { SPEECH_SAMPLE_RATE, speechActivityFromPcm } from "../shared/subtitles/subtitle-sync.js";
import { heightFromQualityLabel, meetsSourceFloor, qualityLabel, releaseVideoHeight } from "../shared/media/series-sources.js";

// Speech-like test audio: 220 Hz bursts, 0.6 s on / 0.4 s off, modulated at ~5 Hz.
function speechLikePcm(seconds) {
  const samples = new Int16Array(Math.round(seconds * SPEECH_SAMPLE_RATE));
  for (let index = 0; index < samples.length; index += 1) {
    const t = index / SPEECH_SAMPLE_RATE;
    const on = (t % 1) < 0.6 ? 1 : 0.02;
    const syllable = 0.55 + 0.45 * Math.sin(2 * Math.PI * 5 * t);
    samples[index] = Math.round(Math.sin(2 * Math.PI * 220 * t) * 12000 * on * syllable);
  }
  return samples;
}

function toBuffer(samples) {
  const buffer = Buffer.alloc(samples.length * 2);
  samples.forEach((value, index) => buffer.writeInt16LE(value, index * 2));
  return buffer;
}

test("speech tape keeps levels from a stream and answers like a direct decode", () => {
  const pcm = speechLikePcm(50);
  const writer = speechTapeWriter("tape-test", 0, 0, 20);
  const bytes = toBuffer(pcm);
  // Odd chunk sizes, like pipe reads.
  for (let offset = 0; offset < bytes.length; offset += 7777) writer.push(bytes.subarray(offset, Math.min(bytes.length, offset + 7777)));
  writer.end();
  const coverage = speechTapeCoverage("tape-test", 0, 0);
  assert.equal(coverage.length, 1);
  assert.equal(coverage[0].fromMs, 20_000);
  assert.ok(Math.abs(coverage[0].toMs - 70_000) <= 10);
  const live = speechTapeActivity("tape-test", 0, 0, 25_000, 40_000);
  const direct = speechActivityFromPcm(pcm.subarray(5 * SPEECH_SAMPLE_RATE, 45 * SPEECH_SAMPLE_RATE));
  assert.equal(live.length, direct.length);
  let diff = 0;
  for (let index = 0; index < live.length; index += 1) diff = Math.max(diff, Math.abs(live[index] - direct[index]));
  assert.ok(diff <= 2, `max difference ${diff}`);
  assert.equal(speechTapeActivity("tape-test", 0, 0, 60_000, 40_000), null, "window mostly outside the heard audio");
  assert.equal(speechTapeActivity("tape-test", 0, 1, 25_000, 40_000), null, "other audio track");
  dropSpeechTapes("tape-test");
  assert.deepEqual(speechTapeCoverage("tape-test", 0, 0), []);
});

test("separate runs (after a seek) merge into one coverage when they meet", () => {
  const first = speechTapeWriter("tape-merge", 1, 0, 0);
  first.push(toBuffer(speechLikePcm(10)));
  first.end();
  const second = speechTapeWriter("tape-merge", 1, 0, 30);
  second.push(toBuffer(speechLikePcm(10)));
  second.end();
  assert.equal(speechTapeCoverage("tape-merge", 1, 0).length, 2);
  const bridge = speechTapeWriter("tape-merge", 1, 0, 10);
  bridge.push(toBuffer(speechLikePcm(20)));
  bridge.end();
  const merged = speechTapeCoverage("tape-merge", 1, 0);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].fromMs, 0);
  dropSpeechTapes("tape-merge");
});

test("release names give a video height, including odd ones like 810p", () => {
  assert.equal(releaseVideoHeight("[LostYears] Slime - 01v2 (WEB 810p x264 10-bit AAC).mkv"), 810);
  assert.equal(releaseVideoHeight("Show S01E01 1080p WEB-DL"), 1080);
  assert.equal(releaseVideoHeight("Movie 1920x1080 BluRay"), 1080);
  assert.equal(releaseVideoHeight("Movie 2019 UHD HDR x265"), 2160);
  assert.equal(releaseVideoHeight("Movie 4K"), 2160);
  assert.equal(releaseVideoHeight("Old Show DVDRip XviD"), 480);
  assert.equal(releaseVideoHeight("Episode x264 AAC"), null, "x264 is a codec, not a height");
  assert.equal(releaseVideoHeight("[EMBER] Slime (2019-2021) (Season 1+2) [BDRip] [1080p Dual Audio HEVC 10 bits]"), 1080);
  assert.equal(qualityLabel(810), "810p");
  assert.equal(qualityLabel(2160), "4K");
  assert.equal(qualityLabel(null), "");
  assert.equal(heightFromQualityLabel("SD"), 480);
  assert.equal(heightFromQualityLabel("UNKNOWN"), null);
});

test("source floor: 720p or better with at least two peers", () => {
  assert.equal(meetsSourceFloor({ height: 720, peers: 2 }), true);
  assert.equal(meetsSourceFloor({ quality: "1080p", peers: 1 }), false);
  assert.equal(meetsSourceFloor({ quality: "UNKNOWN", title: "Show 810p WEB", peers: 3 }), true);
  assert.equal(meetsSourceFloor({ quality: "SD", peers: 50 }), false);
  assert.equal(meetsSourceFloor({ peers: 50, title: "Show S01E01" }), false, "unknown quality is left out");
});
