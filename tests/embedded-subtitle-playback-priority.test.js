import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const from = app.indexOf("function shouldDeferSpeculativeEmbeddedLookahead(");
const fallbackFrom = app.indexOf("function loadMoreEmbeddedSubtitles(");
const to = app.indexOf("\nfunction renderEmbeddedSubtitleControls(", fallbackFrom);
assert.ok(fallbackFrom >= 0 && to > fallbackFrom);

function fixture({ readyState = 2, bufferEnd = 5, coverageEnd = 90, seeked = false } = {}) {
  const calls = [];
  const track = { origin: "embedded", visible: true, embeddedStreamIndex: 4 };
  const current = { streamIndex: 4, textBased: true };
  const video = { paused: false, seeking: false, readyState, currentTime: 5,
    buffered: {length: 1, start: () => 0, end: () => bufferEnd} };
  const state = { pendingSeek: null, currentMediaProbe: { subtitleTracks: [current] } };
  const context = vm.createContext({
    state, video, frame: {classList: {contains: () => true}},
    absolutePlaybackSeconds: () => video.currentTime,
    currentSourceTracks: () => [track],
    enableDefaultEmbeddedSubtitles: () => {},
    embeddedSubtitleCovers: (_track, at) => at < coverageEnd,
    embeddedSubtitleCoverageEnd: () => coverageEnd,
    importEmbeddedSubtitleTrack: (_meta, _target, options) => { calls.push(options); return Promise.resolve(true); },
  });
  vm.runInContext(app.slice(from >= 0 ? from : fallbackFrom, to), context);
  return {video, state, calls, run: () => vm.runInContext("loadMoreEmbeddedSubtitles", context)({seeked})};
}

test("speculative far-ahead subtitle extraction yields to video rebuffering", () => {
  const f = fixture({readyState: 2, bufferEnd: 5.1, coverageEnd: 29});
  f.run();
  assert.equal(f.calls.length, 0, "current captions are covered; don't request another torrent range during low video buffer");
  f.video.readyState = 4;
  f.video.buffered.end = () => 25;
  f.run();
  assert.equal(f.calls.length, 1, "lookahead resumes as soon as video buffer recovers");
});

test("urgent seek and nearly exhausted subtitles bypass speculative deferral", () => {
  const urgent = fixture({readyState: 2, bufferEnd: 5.1, coverageEnd: 29, seeked: true});
  urgent.run();
  assert.equal(urgent.calls.length, 1, "seek-critical subtitles are not delayed");
  const near = fixture({readyState: 2, bufferEnd: 5.1, coverageEnd: 11});
  near.run();
  assert.equal(near.calls.length, 1, "next captions cannot be starved when current coverage is almost finished");
});

test("no false buffering inference when the browser exposes no known ranges", () => {
  const f = fixture({readyState: 4, bufferEnd: 50, coverageEnd: 29});
  f.video.buffered = {length: 0};
  f.run();
  assert.equal(f.calls.length, 1, "unknown buffer state must not be treated as proof of a video stall");
});
