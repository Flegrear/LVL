import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

// Execute the actual server coalescing implementation with deterministic,
// signal-aware FFprobe promises; no live app, torrents or playback are touched.
const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
const from = server.indexOf("async function copiedSeekOrigin(");
const to = server.indexOf("\nasync function copiedSeekOriginEndpoint(", from);
assert.ok(from > 0 && to > from);

const verified = (seconds = 5.37) => ({ requestedStartSeconds: seconds,
  effectiveStartSeconds: 4, prerollSeconds: seconds - 4, verified: true });
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fixture({ rejectOnAbort = true } = {}) {
  const session = { id: "session-one", state: "ready", torrent: { files: [{ name: "episode.mkv", length: 4096 }] } };
  const sessions = new Map([[session.id, session]]);
  const pending = [];
  const context = vm.createContext({
    path, Date, Number, AbortController, port: 4173, ffprobePath: "ffprobe",
    VIDEO_EXTENSIONS: new Set([".mkv"]), MAX_TORRENT_VIDEO_BYTES: 20 * 1024 ** 3,
    MAX_COPIED_SEEK_PROBES: 2, MAX_COPIED_SEEK_SUBSCRIBERS: 16,
    MAX_COPIED_SEEK_CACHE_ENTRIES: 64, COPIED_SEEK_CACHE_TTL_MS: 600000,
    torrentSessions: sessions, getCachedMediaProbe: () => ({ durationSeconds: 300 }),
    probeCopiedSeekOrigin: ({ requestedStartSeconds, signal }) => new Promise((resolve, reject) => {
      const probe = { requestedStartSeconds, signal, resolve, reject, aborted: false };
      pending.push(probe);
      if (rejectOnAbort) {
        signal.addEventListener("abort", () => {
          probe.aborted = true;
          reject(Object.assign(new Error("cancelled"), { statusCode: 499 }));
        }, { once: true });
        if (signal.aborted) {
          probe.aborted = true;
          reject(Object.assign(new Error("cancelled"), { statusCode: 499 }));
        }
      } else signal.addEventListener("abort", () => { probe.aborted = true; }, { once: true });
    }),
  });
  vm.runInContext(`const copiedSeekOriginCache = new Map();
const copiedSeekOriginInflight = new Map(); let activeCopiedSeekProbes = 0;
${server.slice(from, to)}`, context);
  const invoke = vm.runInContext("copiedSeekOrigin", context);
  const state = () => ({
    active: vm.runInContext("activeCopiedSeekProbes", context),
    inflight: vm.runInContext("copiedSeekOriginInflight.size", context),
    cache: vm.runInContext("copiedSeekOriginCache.size", context),
  });
  return { session, sessions, pending, invoke: (seconds = 5.37, signal, source = session) => invoke(source, 0, seconds, signal), state };
}

test("three simultaneous same-key callers share one FFprobe, then use one verified cached result", async () => {
  const f = fixture();
  const calls = Array.from({ length: 3 }, () => f.invoke());
  assert.equal(f.pending.length, 1, "only one underlying probe for identical key");
  assert.deepEqual(f.state(), { active: 1, inflight: 1, cache: 0 });
  f.pending[0].resolve(verified());
  for (const result of await Promise.all(calls)) assert.deepEqual(result, verified());
  assert.deepEqual(f.state(), { active: 0, inflight: 0, cache: 1 });
  assert.deepEqual(await f.invoke(), verified());
  assert.equal(f.pending.length, 1, "positive result is cached, not re-probed");
});

test("one aborted caller rejects promptly but keeps shared probe alive for another", async () => {
  const f = fixture();
  const a = new AbortController(), b = new AbortController();
  const first = f.invoke(5.37, a.signal);
  const second = f.invoke(5.37, b.signal);
  a.abort();
  await assert.rejects(first, (error) => error.statusCode === 499);
  assert.equal(f.pending[0].signal.aborted, false, "one cancellation must not kill another caller's FFprobe");
  assert.equal(f.state().active, 1);
  f.pending[0].resolve(verified());
  assert.deepEqual(await second, verified());
  assert.equal(f.state().cache, 1);
  assert.deepEqual(f.state(), { active: 0, inflight: 0, cache: 1 });
});

test("last cancellation aborts underlying probe and clears in-flight slot without stale cache", async () => {
  const f = fixture();
  const a = new AbortController(), b = new AbortController();
  const first = f.invoke(5.37, a.signal);
  const second = f.invoke(5.37, b.signal);
  a.abort();
  const rejected = assert.rejects(first, (error) => error.statusCode === 499);
  assert.equal(f.pending[0].signal.aborted, false);
  b.abort();
  await rejected;
  await assert.rejects(second, (error) => error.statusCode === 499);
  assert.equal(f.pending[0].signal.aborted, true, "all subscribers abandoned; kill the shared process");
  await tick();
  assert.deepEqual(f.state(), { active: 0, inflight: 0, cache: 0 });
  const retry = f.invoke();
  assert.equal(f.pending.length, 2, "fresh attempt must not join cancelled work");
  f.pending[1].resolve(verified());
  assert.deepEqual(await retry, verified());
});

test("late result from abandoned probe cannot poison fresh identical-key cache", async () => {
  const f = fixture({ rejectOnAbort: false });
  const abort = new AbortController();
  const old = f.invoke(5.37, abort.signal);
  abort.abort();
  await assert.rejects(old, (error) => error.statusCode === 499);
  assert.equal(f.pending[0].signal.aborted, true);
  assert.equal(f.state().inflight, 0);
  // The old mock intentionally ignores abort and resolves later. The returned
  // result must not overwrite the result of a new verified FFprobe.
  f.pending[0].resolve({ ...verified(), effectiveStartSeconds: 1 });
  await tick();
  const fresh = f.invoke();
  assert.equal(f.pending.length, 2);
  f.pending[1].resolve(verified());
  assert.deepEqual(await fresh, verified());
  assert.deepEqual(await f.invoke(), verified());
  assert.deepEqual(f.state(), { active: 0, inflight: 0, cache: 1 });
});

test("distinct seek keys still count against two-job budget while duplicates join existing job", async () => {
  const f = fixture();
  const first = f.invoke(5.37), second = f.invoke(8.19);
  assert.equal(f.pending.length, 2);
  await assert.rejects(f.invoke(9.45), (error) => error.statusCode === 429);
  const duplicate = f.invoke(5.37);
  assert.equal(f.pending.length, 2, "duplicate should join even while global probe budget is exhausted");
  f.pending[0].resolve(verified());
  f.pending[1].resolve(verified(8.19));
  assert.deepEqual(await first, verified());
  assert.deepEqual(await duplicate, verified());
  assert.deepEqual(await second, verified(8.19));
  assert.deepEqual(f.state(), { active: 0, inflight: 0, cache: 2 });
});

test("per-key subscription cap rejects excess followers without cancelling supported callers", async () => {
  const f = fixture();
  const callers = Array.from({ length: 16 }, () => f.invoke());
  assert.equal(f.pending.length, 1);
  await assert.rejects(f.invoke(), (error) => error.statusCode === 429);
  assert.equal(f.pending[0].signal.aborted, false);
  f.pending[0].resolve(verified());
  for (const value of await Promise.all(callers)) assert.deepEqual(value, verified());
  assert.deepEqual(f.state(), { active: 0, inflight: 0, cache: 1 });
});

test("one failed underlying probe rejects all joined callers and leaves capacity for retry", async () => {
  const f = fixture();
  const first = f.invoke(), second = f.invoke();
  f.pending[0].reject(Object.assign(new Error("no keyframe"), { statusCode: 422 }));
  await assert.rejects(first, (error) => error.statusCode === 422);
  await assert.rejects(second, (error) => error.statusCode === 422);
  assert.deepEqual(f.state(), { active: 0, inflight: 0, cache: 0 });
  const retry = f.invoke();
  assert.equal(f.pending.length, 2);
  f.pending[1].resolve(verified());
  assert.deepEqual(await retry, verified());
});

test("changed session identity cannot join stale source's in-flight job", async () => {
  const f = fixture();
  const first = f.invoke();
  const replacement = { ...f.session, torrent: { files: [{ name: "new.mkv", length: 5000 }] } };
  f.sessions.set(f.session.id, replacement);
  await assert.rejects(f.invoke(5.37, undefined, replacement), (error) => [410, 429].includes(error.statusCode));
  assert.equal(f.pending.length, 1, "stale job cannot be joined by a different torrent instance");
  f.pending[0].resolve(verified());
  await assert.rejects(first, (error) => error.statusCode === 410);
  assert.deepEqual(f.state(), { active: 0, inflight: 0, cache: 0 });
});
