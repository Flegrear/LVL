import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const start = app.indexOf('const LAST_WATCH_SELECTION_KEY =');
const end = app.indexOf("\nfunction viewFromLocation()", start);
assert.ok(start >= 0 && end > start, "Watch restoration code is present");

function setup(entries) {
  const stored = new Map();
  const calls = [];
  let onWatch = true;
  const state = { currentSource: { kind: "idle" }, library: entries };
  const context = vm.createContext({
    state,
    localStorage: {
      getItem: (key) => stored.get(key) ?? null,
      setItem: (key, value) => stored.set(key, value),
    },
    libraryEntryById: (id) => state.library.find((entry) => entry.id === id),
    viewActive: (view) => view === "watch" && onWatch,
    watchPendingSelection: null,
    playLibraryEpisode: async (id, index, options) => { calls.push({ id, index, seconds: options.resumeAtSeconds }); },
    console,
  });
  vm.runInContext(app.slice(start, end), context);
  return {
    stored, calls, state, context,
    ready: () => vm.runInContext("watchRestoreReady = true", context),
    setView: (value) => { onWatch = value; },
    remember: vm.runInContext("rememberWatchSelection", context),
    restore: vm.runInContext("restoreLastWatchOnVisit", context),
  };
}

test("Watch restores the selected episode at its saved position only after Library hydration", () => {
  const episode = { fileIndex: 2, progress: { positionMs: 155_000, durationMs: 1_400_000, finished: false } };
  const entry = { id: "source-a", magnet: "magnet:?xt=urn:btih:123", episodes: [episode] };
  const session = setup([entry]);
  session.remember(entry.id, episode.fileIndex);
  assert.deepEqual(JSON.parse(session.stored.get("lvl-last-watch-selection-v1")), { libraryId: "source-a", fileIndex: 2 });
  session.restore();
  assert.equal(session.calls.length, 0, "Never load from the partial pre-hydration Library");
  session.ready();
  session.restore();
  assert.equal(session.calls.length, 1);
  assert.equal(session.calls[0].id, "source-a");
  assert.equal(session.calls[0].index, 2);
  assert.equal(session.calls[0].seconds, 155);
  session.restore();
  assert.equal(session.calls.length, 1, "Repeated Watch renders do not start duplicate streams");
});

test("Watch falls back to the latest Library history and does not autoplay from other views", () => {
  const first = { id: "first", magnet: "magnet:first", lastPlayedAt: 100, lastPlayedFileIndex: 0,
    episodes: [{ fileIndex: 0, progress: { positionMs: 890_000, durationMs: 900_000, finished: true } }] };
  const last = { id: "last", magnet: "magnet:last", lastPlayedAt: 200, lastPlayedFileIndex: 3,
    episodes: [{ fileIndex: 3, progress: { positionMs: 230_000, durationMs: 900_000, finished: false } }] };
  const session = setup([first, last]);
  session.stored.set("lvl-last-watch-selection-v1", JSON.stringify({ libraryId: "removed", fileIndex: 4 }));
  session.ready();
  session.setView(false);
  session.restore();
  assert.equal(session.calls.length, 0);
  session.setView(true);
  session.restore();
  assert.equal(session.calls[0].id, "last");
  assert.equal(session.calls[0].seconds, 230);
});
