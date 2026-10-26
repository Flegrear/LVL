import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const start = app.indexOf('const LAST_WATCH_SELECTION_KEY =');
const end = app.indexOf("\nfunction viewFromLocation()", start);
assert.ok(start >= 0 && end > start, "Watch restoration helpers are available");
const source = app.slice(start, end);

function setup(entries, { active = true, sourceKind = "idle" } = {}) {
  const values = new Map();
  const calls = [];
  const state = { library: entries, currentSource: { kind: sourceKind } };
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const context = vm.createContext({
    localStorage: storage, state, watchPendingSelection: null,
    libraryEntryById: (id) => entries.find((entry) => entry.id === id) ?? null,
    viewActive: (view) => view === "watch" && active,
    playLibraryEpisode: (...args) => { calls.push(args); return Promise.resolve(true); },
    console,
  });
  vm.runInContext(source, context);
  return { context, state, values, calls };
}

const episode = (fileIndex, positionMs = 120_000, finished = false) => ({
  fileIndex,
  progress: { positionMs, durationMs: 600_000, finished },
});

test("Last selected episode survives refresh and resumes from the saved position after hydration", () => {
  const entry = { id: "hash-1", magnet: "magnet:?xt=urn:btih:1", episodes: [episode(2), episode(5, 240_000)] };
  const first = setup([entry]);
  vm.runInContext('rememberWatchSelection("hash-1", 5)', first.context);
  const second = setup([entry]);
  second.values.set("lvl-last-watch-selection-v1", first.values.get("lvl-last-watch-selection-v1"));
  vm.runInContext('watchRestoreReady = true; restoreLastWatchOnVisit()', second.context);
  assert.equal(second.calls.length, 1);
  assert.equal(second.calls[0][0], "hash-1");
  assert.equal(second.calls[0][1], 5);
  assert.equal(second.calls[0][2].resumeAtSeconds, 240);
  vm.runInContext('restoreLastWatchOnVisit()', second.context);
  assert.equal(second.calls.length, 1, "Restore starts one resolution only");
});

test("Legacy progress provides a fallback; finished and deleted episodes are handled", () => {
  const older = { id: "old", magnet: "magnet:?xt=urn:btih:2", episodes: [episode(0)], lastPlayedAt: 100, lastPlayedFileIndex: 0 };
  const recent = { id: "new", magnet: "magnet:?xt=urn:btih:3", episodes: [episode(7, 590_000, true)], lastPlayedAt: 200, lastPlayedFileIndex: 7 };
  const found = setup([older, recent]);
  vm.runInContext('watchRestoreReady = true; restoreLastWatchOnVisit()', found.context);
  assert.equal(found.calls[0][0], "new");
  assert.equal(found.calls[0][2].resumeAtSeconds, 0, "Finished episodes restart from the beginning");
  const missing = setup([]);
  missing.values.set("lvl-last-watch-selection-v1", JSON.stringify({ libraryId: "gone", fileIndex: 1 }));
  vm.runInContext('watchRestoreReady = true; restoreLastWatchOnVisit()', missing.context);
  assert.equal(missing.calls.length, 0, "A removed Library source is never opened");
});

test("A saved torrent file remains restorable when its cached episode list is missing", () => {
  const entry = { id: "pending-metadata", magnet: "magnet:?xt=urn:btih:4", episodes: [] };
  const session = setup([entry]);
  session.values.set("lvl-last-watch-selection-v1", JSON.stringify({ libraryId: "pending-metadata", fileIndex: 8 }));
  vm.runInContext('watchRestoreReady = true; restoreLastWatchOnVisit()', session.context);
  assert.equal(session.calls.length, 1);
  assert.equal(session.calls[0][1], 8);
  assert.equal(session.calls[0][2].resumeAtSeconds, 0);
});

test("Incomplete saved indexes are ignored instead of becoming file zero", () => {
  const entry = { id: "pending-metadata", magnet: "magnet:?xt=urn:btih:4", episodes: [episode(0)] };
  const session = setup([entry]);
  session.values.set("lvl-last-watch-selection-v1", JSON.stringify({ libraryId: "pending-metadata", fileIndex: null }));
  vm.runInContext('watchRestoreReady = true; restoreLastWatchOnVisit()', session.context);
  assert.equal(session.calls.length, 0);
});

test("Restoration waits for hydration and does not replace a player already selected", () => {
  const entry = { id: "hash-1", magnet: "magnet:?xt=urn:btih:1", episodes: [episode(2)], lastPlayedAt: 5, lastPlayedFileIndex: 2 };
  const active = setup([entry]);
  vm.runInContext('restoreLastWatchOnVisit()', active.context);
  assert.equal(active.calls.length, 0);
  vm.runInContext('watchRestoreReady = true;', active.context);
  active.state.currentSource.kind = "torrent";
  vm.runInContext('restoreLastWatchOnVisit()', active.context);
  assert.equal(active.calls.length, 0);
});
