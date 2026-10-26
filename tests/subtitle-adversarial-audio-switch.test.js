import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const functionSlice = (start, end) => {
  const from = app.indexOf(start);
  const to = app.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `Missing source seam: ${start}`);
  return app.slice(from, to);
};

test("switching to a separately timed audio dub invalidates prior audio-derived subtitle timing", () => {
  // The subtitle file is attached to a single video, but two different audio
  // tracks can contain different intros, leading silence or dialogue edits.
  // A +4s alignment to the first dub must not remain *verified to audio*
  // after choosing the second dub, before any audio analysis has completed.
  const track = {
    id: "external", exactMedia: false,
    syncSource: "audio", syncMode: "constant", offsetMs: -1_500,
    syncAnchors: [{ atMs: 8_000, offsetMs: 4_000, confidence: 0.98 }],
    audioSync: { status: "synced", windows: 3 },
    syncFollowsId: "other",
  };
  const embedded = { id: "exact-embedded", exactMedia: true, offsetMs: 0,
    syncSource: "embedded", syncAnchors: [], audioSync: { status: "synced" } };
  const state = { selectedAudioTrack: 1, tracks: [track, embedded] };
  const audioSync = { key: "session:0:0", windows: [1], caches: new Map(), timer: 0 };
  const ctx = vm.createContext({
    state, audioSync,
    window: { clearTimeout() {} },
    audioSyncKey: () => `session:0:${state.selectedAudioTrack}`,
    currentSourceTracks: () => state.tracks,
    pairedCueMemo: new Map(),
    subtitleRenderMemo: { key: "cached" },
    updatePlayerSyncStatus() {},
    playerSyncChipState: "Synced",
  });
  vm.runInContext(functionSlice("function resetAudioSync()", "\nfunction scheduleAudioSync("), ctx);
  vm.runInContext("resetAudioSync()", ctx);
  assert.equal(audioSync.key, "session:0:1", "audio analysis does use the newly selected track");
  assert.equal(track.audioSync?.status, "waiting",
    "the old dub's alignment cannot remain labeled 'synced' before analysis of the newly selected dub");
  assert.notEqual(track.syncSource, "audio",
    "old audio-derived anchors must not be treated as newly verified for an unrelated audio track");
  assert.equal(track.offsetMs, -1_500, "the user's manual SRT offset is independent of selected audio dub");
  assert.equal(embedded.syncSource, "embedded", "exact embedded-video subtitles are not invalidated by audio changes");
  assert.deepEqual(embedded.syncAnchors, []);
});

test("a saved subtitle model for audio track 0 cannot silently validate audio track 1", () => {
  const track = { fingerprint: "external-srt", exactMedia: false, syncMode: "constant", syncAnchors: [], offsetMs: 0 };
  const saved = { mode: "constant", anchors: [{ atMs: 10_000, offsetMs: 3500, confidence: 0.98 }], savedAt: 1, audioIndex: 0 };
  const ctx = vm.createContext({
    state: { selectedAudioTrack: 1 },
    trackSyncKey: () => "external-srt",
    currentLibraryEpisode: () => ({ episode: { subtitleSync: { "external-srt": saved } } }),
  });
  vm.runInContext(functionSlice("function applySavedSubtitleSync(", "\nfunction saveSubtitleSync("), ctx);
  const accepted = vm.runInContext("applySavedSubtitleSync", ctx)(track);
  assert.equal(accepted, false, "a previously verified model belongs to another audio track");
  assert.notEqual(track.syncSource, "audio");
});
