import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../frontend/styles/styles.css", import.meta.url), "utf8");

function section(start, end) {
  const from = app.indexOf(start);
  const to = app.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `Missing ${start}`);
  return app.slice(from, to);
}

test("Learning-off Watch has no empty transport toolbar or oversized gap below skip actions", () => {
  assert.match(css, /html\[data-learning-mode="off"\] \.watch-transport,/);
  assert.match(css, /\.watch-skip-options \{[^}]*margin-top:6px;/);
  const skip = html.indexOf('class="watch-skip-options"');
  assert.ok(skip > html.indexOf('id="video-frame"'));
  assert.ok(skip < html.indexOf('class="transport-strip watch-transport"'));
});

test("Short buffered speech windows can start at 20 seconds instead of requiring 40", () => {
  const context = vm.createContext({
    AUDIO_SYNC_WINDOW_S: 45,
    AUDIO_SYNC_MIN_WINDOW_S: 20,
    AUDIO_SYNC_MAX_WINDOWS: 24,
    audioSync: { windows: [] },
    state: { currentMs: 22_000 },
    audioSyncTracks: () => [],
  });
  vm.runInContext(section("function analysedShare(", "\nfunction decodeBase64Bytes("), context);
  const next = vm.runInContext("nextAudioSyncWindow", context);
  assert.equal(next([{ fromMs: 0, toMs: 19_000, live: false }], 1_400_000), null);
  const ready = next([{ fromMs: 0, toMs: 23_000, live: false }], 1_400_000);
  assert.equal(ready.durationMs, 23_000);
  assert.equal(ready.startMs, 0);
  assert.match(app, /const AUDIO_SYNC_MIN_WINDOW_S = 20;/);
});

test("Pending subtitle matching explains missing audio and removes misleading Different cut and minute claim", () => {
  const context = vm.createContext({});
  vm.runInContext(section("function trackSyncExplanation(", "\n// Small chip on the player"), context);
  const summary = vm.runInContext("trackSyncSummary", context);
  const explain = vm.runInContext("trackSyncExplanation", context);
  assert.match(summary({ audioSync: { status: "waiting" } }), /Waiting for audio/);
  assert.match(explain({ audioSync: { status: "waiting" } }), /enough playable speech/);
  assert.doesNotMatch(section("function renderTracks(", "\nfunction trackTipId("), /Different cut\?/);
  assert.doesNotMatch(explain({ audioSync: { status: "syncing" } }), /minute of playback/);
  assert.match(app, /AbortSignal\.timeout\(52_000\)/);
  assert.match(server, /Timed out reading audio for subtitle sync"\), \{ statusCode: 504 \}\)\), 45_000/);
});

function syncHarness({ slot, response }) {
  const track = { cues: [{ startMs: 500, endMs: 1800 }], audioSync: { status: "syncing" } };
  const delays = [];
  let renders = 0;
  const context = vm.createContext({
    audioSync: { key: "session:0:0", pending: false, failures: 0, windows: [] },
    audioSyncSource: () => ({ sessionId: "session", fileIndex: 0, audio: 0 }),
    audioSyncKey: () => "session:0:0",
    audioSyncTracks: () => [track],
    state: { mediaDurationMs: 1400000 },
    $: () => ({ hidden: true }),
    audioReadyRanges: async () => [],
    nextAudioSyncWindow: () => slot,
    scheduleAudioSync: (delay) => { delays.push(delay); },
    renderTracks: () => { renders += 1; },
    updatePlayerSyncStatus() {},
    URLSearchParams,
    AbortSignal,
    fetch: async () => response,
  });
  vm.runInContext(section("async function runAudioSyncStep()", "\nfunction applyAudioSync()"), context);
  return { track, delays, context, getRenders: () => renders,
    run: () => vm.runInContext("runAudioSyncStep()", context) };
}

test("When no audio is ready, sync reports Waiting rather than an endless active match", async () => {
  const h = syncHarness({ slot: null });
  await h.run();
  assert.equal(h.track.audioSync.status, "waiting");
  assert.equal(h.getRenders(), 1);
  assert.deepEqual(h.delays, [3000]);
  await h.run();
  assert.equal(h.getRenders(), 1, "no repeated DOM renders while waiting");
});

test("A speech decode timeout fails clearly instead of retriggering many long downloads", async () => {
  const h = syncHarness({ slot: { startMs: 0, durationMs: 20000, live: false },
    response: { ok: false, status: 504, json: async () => ({ error: "Audio analysis timed out" }) } });
  await h.run();
  assert.equal(h.track.audioSync.status, "failed");
  assert.equal(h.context.audioSync.failures, 4);
  assert.deepEqual(h.delays, []);
});

test("Indeterminate logo fill stays animated while buffering instead of freezing at a fake percent", () => {
  const visual = section("function animatePlayerLoadingProgress(", "\nfunction updatePlayerLoadingAnimation(");
  assert.match(visual, /playerLoadingColorProgress \+ 16 \* delta\) % 100/);
  assert.doesNotMatch(visual, /ceiling = reported >= 100 \? 100 : 92/);
  assert.match(visual, /reported >= 100/);
});
