import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const app = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");

function sourceBetween(first, last) {
  const a = app.indexOf(first);
  const b = app.indexOf(last, a + first.length);
  assert.ok(a >= 0 && b > a, `Could not find ${first}`);
  return app.slice(a, b);
}

function controlledPoll() {
  const pending = [];
  const received = [];
  const timers = new Map();
  let nextTimer = 0;
  const context = vm.createContext({
    AbortController, AbortSignal, Date,
    window: {
      clearInterval(id) { timers.delete(id); },
      setInterval(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
    },
    state: {
      currentSource: { kind: "torrent", sessionId: "session-a", fileIndex: 2 }, transferStatsTimer: null,
    },
    video: { __lvlLoadGeneration: 1 },
    updateTransferStats(payload) { if (payload) received.push(payload.label); },
    drawPlayerDownloadMap() {},
    fetchJson(url, { signal }) {
      return new Promise(resolve => pending.push({ url, signal, resolve }));
    },
    currentStreamDiagnosis() { return null; },
    renderRecoveryOverlay() {},
    recoveryDisplayPhase: "",
    $: () => ({ hidden: true }),
  });
  vm.runInContext(`let streamStatusHealth = null, streamStatusAt = 0,
    streamStatusGeneration = 0, streamStatusController = null;`, context);
  vm.runInContext(sourceBetween("function invalidateStreamStatus() {", "\nfunction currentStreamDiagnosis()"), context);
  vm.runInContext(sourceBetween("function stopTransferStats() {", "\nfunction setMediaSource("), context);
  return { context, pending, received, timers,
    run: expression => vm.runInContext(expression, context) };
}

const data = (label) => ({ label, streamHealth: {
  peers: 0, activeReaderCount: 1,
  readers: [{ ageMs: 9000, nextPiecePresent: false }],
} });

test("torrent status polling cancels old source and seek generations, ignores late fetch responses", async () => {
  const p = controlledPoll();
  p.run('startTransferStats("session-a")');
  assert.equal(p.pending.length, 1);
  assert.match(p.pending[0].url, /\/api\/torrents\/session-a\?file=2$/);
  assert.equal(p.timers.size, 1, "reuses one existing 1500ms poller");
  p.run('stopTransferStats()');
  assert.equal(p.pending[0].signal.aborted, true, "stopping Watch cancels in-flight work");
  p.context.state.currentSource = { kind: "torrent", sessionId: "session-b", fileIndex: 1 };
  p.run('startTransferStats("session-b")');
  assert.match(p.pending[1].url, /\/api\/torrents\/session-b\?file=1$/);
  p.pending[0].resolve(data("old-source"));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(p.received, [], "a completed old response cannot update the new transfer label");
  p.pending[1].resolve(data("new-source"));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(p.received, ["new-source"]);
  assert.equal(p.run('streamStatusHealth.peers'), 0);

  for (const tick of [...p.timers.values()]) tick();
  assert.equal(p.pending.length, 3);
  p.context.video.__lvlLoadGeneration += 1;
  p.run('invalidateStreamStatus()');
  assert.equal(p.pending[2].signal.aborted, true, "new seek/source load cancels stale snapshot");
  p.pending[2].resolve(data("before-seek"));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(p.received, ["new-source"]);
  assert.equal(p.run('streamStatusHealth'), null);
});

test("backend without streamHealth leaves diagnosis unknown", async () => {
  const p = controlledPoll();
  p.run('startTransferStats("session-a")');
  p.pending[0].resolve({ label: "old-backend", numPeers: 0 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(p.run('streamStatusHealth'), null);
  assert.deepEqual(p.received, ["old-backend"]);
});
