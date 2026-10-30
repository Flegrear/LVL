import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
// Use the real deferred metadata completion body. The metadata API and audio
// selection are fake: this checks cancellation of stale A work without a
// browser, torrent, FFprobe process, or even a running backend.
const after = app.indexOf("const media = probedMedia || await metadataRequest.catch(() => fetchJson(metadataUrl));");
const start = app.lastIndexOf("window.setTimeout(async () => {", after);
const endMarker = "}, probedMedia ? 0 : 450);";
const end = app.indexOf(endMarker, after) + endMarker.length;
assert.ok(after > 0 && start >= 0 && end > start, "deferred playback metadata callback exists");
const delayedMetadataCallback = app.slice(start, end);

test("late audio-track choice for file A cannot assign A's duration or chapter probe to file B", async () => {
  let scheduled;
  let resolveAudioSwitch;
  let audioSwitchEntered;
  const audioStarted = new Promise((resolve) => { audioSwitchEntered = resolve; });
  const audioGate = new Promise((resolve) => { resolveAudioSwitch = resolve; });
  const errors = [];
  const writes = [];
  const state = {
    currentSource: { sessionId: "session-A", fileIndex: 2 },
    currentMediaProbe: null, selectedAudioTrack: 0, mediaDurationMs: 1440000,
    transcodeContext: null,
  };
  const file = { index: 2 };
  const context = vm.createContext({
    state, file, session: { id: "session-A" }, startAtSeconds: 0,
    probedMedia: null,
    metadataRequest: Promise.resolve({
      durationMs: 1440000, durationSeconds: 1440,
      embeddedSkipMarkers: { intro: { start_ms: 60_000, end_ms: 150_000, match: "exact", confidence: 1, source: "embedded-chapter" }, outro: null },
    }),
    metadataUrl: "/api/torrents/session-A/files/2/metadata",
    video: { dataset: { mode: "test-mode" } },
    window: { setTimeout(callback) { scheduled = callback; } },
    fetchJson() { throw new Error("probe must be reused; no extra fetch is permitted"); },
    preferredAudioTrackIndex: () => 1,
    async switchAudioTrack() {
      audioSwitchEntered();
      await audioGate;
    },
    enableDefaultEmbeddedSubtitles() {},
    renderSubtitleStyleControls() { writes.push("style"); },
    refreshSubtitleTimelineFits() { writes.push("timeline"); },
    renderPlayerAudioMenu() { writes.push("audio"); },
    updateCompatControls() { writes.push("compat"); },
    console: { warn(...args) { errors.push(args); } },
  });
  vm.runInContext(`let playbackLoadRequestId = 7; const loadId = 7; ${delayedMetadataCallback}`, context);
  assert.equal(typeof scheduled, "function");
  const operation = scheduled();
  await audioStarted;
  assert.equal(state.currentMediaProbe?.durationSeconds, 1440, "A's metadata arrived before audio selection");
  // Simulate starting source B while the asynchronous A audio selection is
  // still pending, as happens with a quick source/episode switch.
  state.currentSource = { sessionId: "session-B", fileIndex: 7 };
  state.currentMediaProbe = null;
  state.mediaDurationMs = 1800000;
  vm.runInContext("playbackLoadRequestId = 8", context);
  const beforeWrites = writes.length;
  resolveAudioSwitch();
  await operation;

  assert.equal(errors.length, 0, "stale work should return quietly rather than throw");
  assert.equal(state.currentMediaProbe, null, "old embedded OP must never be attached to B");
  assert.equal(state.mediaDurationMs, 1800000, "old duration cannot replace B's selected-file duration");
  assert.equal(writes.length, beforeWrites, "old callback cannot render B's player UI after the generation changes");
});
