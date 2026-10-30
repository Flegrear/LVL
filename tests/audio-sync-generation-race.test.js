import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const start = source.indexOf("async function runAudioSyncStep() {");
const end = source.indexOf("\nfunction applyAudioSync()", start);
assert.ok(start > 0 && end > start);

function deferred() {
  let resolve;
  const promise = new Promise((finish) => { resolve = finish; });
  return { promise, resolve };
}

test("Old dub audio-sync completion cannot unlock a newer in-flight analysis", async () => {
  let dub = 0;
  const oldRead = deferred();
  const newRead = deferred();
  const audioSync = { key: "src:1:0", generation: 1, pending: false, windows: [], failures: 0 };
  const calls = [];
  const ctx = vm.createContext({
    audioSync, state: { mediaDurationMs: 600_000 },
    audioSyncSource: () => ({ sessionId: "src", fileIndex: 1, audio: dub }),
    audioSyncKey: (s) => `src:1:${s ? s.audio : dub}`,
    resetAudioSync: () => { audioSync.generation++; audioSync.key = `src:1:${dub}`; audioSync.pending = false; },
    audioSyncTracks: () => [{ syncSource: "audio" }],
    $: () => ({ hidden: true }),
    audioReadyRanges: async (s) => { calls.push(s.audio); return s.audio === 0 ? oldRead.promise : newRead.promise; },
    nextAudioSyncWindow: () => null,
    scheduleAudioSync() {}, updatePlayerSyncStatus() {}, renderTracks() {},
  });
  vm.runInContext(source.slice(start, end), ctx);
  const first = ctx.runAudioSyncStep();
  assert.equal(audioSync.pending, true);
  dub = 1;
  const second = ctx.runAudioSyncStep();
  assert.equal(audioSync.generation, 2);
  assert.equal(audioSync.pending, true);
  oldRead.resolve([]);
  await first;
  assert.equal(audioSync.pending, true, "stale original dub may not clear the new dub's pending slot");
  await ctx.runAudioSyncStep();
  assert.deepEqual(calls, [0, 1], "a timeupdate cannot duplicate the pending new-dub request");
  newRead.resolve([]);
  await second;
  assert.equal(audioSync.pending, false);
});
