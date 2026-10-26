import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const start = app.indexOf("// While a seek is waiting, the player counts as playing");
const end = app.indexOf("\nfunction seekPlayerTo(", start);
assert.ok(start > 0 && end > start);

function resumeFixture(mode = "transcode") {
  let now = 1_000_000;
  const calls = [];
  const video = {
    dataset: { mode }, paused: true, src: "http://test.local/stream?start=120", currentTime: 12,
    play() { calls.push("play"); return Promise.resolve(); },
  };
  const state = {
    pendingSeek: null,
    transcodeContext: { baseUrl: "/api/transcode", audioIndex: 2 },
    transcodeBaseOffsetSeconds: 120,
  };
  const context = vm.createContext({
    state, video, Date: { now: () => now },
    recoveryPlaybackRequested: false, recoveryPauseSerial: 0,
    absolutePlaybackSeconds: () => state.transcodeBaseOffsetSeconds + video.currentTime,
    restartTranscodeAt: (seconds, options) => { calls.push(["restart", seconds, options.wasPlaying]); return Promise.resolve(true); },
    updateCompatControls() {},
    linePreview: { pending: false, active: false, preventBackgroundPlayback: false },
  });
  vm.runInContext(app.slice(start, end), context);
  const run = (code) => vm.runInContext(code, context);
  return { video, state, calls, run, advance: (delta) => { now += delta; } };
}

test("Seeked transcode reopens at precise paused timestamp after several minutes, just once", () => {
  const f = resumeFixture();
  f.run("noteTranscodePause()");
  f.advance(3 * 60_000);
  f.run("resumePlayback()");
  assert.deepEqual(f.calls, [["restart", 132, true]]);
  assert.equal(f.state.transcodeContext.audioIndex, 2, "selected audio track remains unchanged");
  f.run("resumePlayback()");
  assert.deepEqual(f.calls, [["restart", 132, true], "play"], "repeated play does not loop/restart");
});

test("Short pauses, already-buffered files, changed sources and pending seeks do not restart the player", () => {
  const brief = resumeFixture();
  brief.run("noteTranscodePause()");
  brief.advance(20_000);
  brief.run("resumePlayback()");
  assert.deepEqual(brief.calls, ["play"]);

  const direct = resumeFixture("torrent-direct");
  direct.run("noteTranscodePause()");
  direct.advance(5 * 60_000);
  direct.run("resumePlayback()");
  assert.deepEqual(direct.calls, ["play"]);

  const changed = resumeFixture();
  changed.run("noteTranscodePause()");
  changed.video.src = "/different.mp4";
  changed.advance(5 * 60_000);
  changed.run("resumePlayback()");
  assert.deepEqual(changed.calls, ["play"]);

  const seeking = resumeFixture();
  seeking.state.pendingSeek = { target: 200, wasPlaying: false };
  seeking.run("noteTranscodePause()");
  seeking.advance(5 * 60_000);
  seeking.run("resumePlayback()");
  assert.equal(seeking.state.pendingSeek.wasPlaying, true);
  assert.deepEqual(seeking.calls, []);
});

test("Browser/native play events use the same resume guard without rewinding a changed playhead", () => {
  const f = resumeFixture();
  f.run("noteTranscodePause()");
  f.video.currentTime = 27;
  f.advance(2 * 60_000);
  assert.equal(f.run("resyncTranscodeAfterLongPause()"), false);
  assert.deepEqual(f.calls, []);

  f.run("noteTranscodePause()");
  f.advance(2 * 60_000);
  assert.equal(f.run("resyncTranscodeAfterLongPause()"), true);
  assert.deepEqual(f.calls, [["restart", 147, true]]);
  assert.equal(f.run("resyncTranscodeAfterLongPause()"), false);
});
