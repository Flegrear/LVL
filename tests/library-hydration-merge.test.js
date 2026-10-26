import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
function piece(start, end) {
  const from = app.indexOf(start);
  const to = app.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `Missing production seam: ${start}`);
  return app.slice(from, to);
}
const mergeSource = piece("function reconcileEarlyLibraryEntries(", "\nconst artworkFetches");

test("early Library additions merge into fresh SQLite contents without restoring stale deleted browser items", () => {
  const ctx = vm.createContext({});
  vm.runInContext(mergeSource, ctx);
  const merge = vm.runInContext("reconcileEarlyLibraryEntries", ctx);
  const initial = [{ id: "old-removed", updatedAt: 1 }, { id: "kept", updatedAt: 100, title: "Old browser copy" }];
  const disk = [{ id: "kept", updatedAt: 200, title: "Newer disk copy" }, { id: "disk-only", updatedAt: 300 }];
  const current = [...initial, { id: "newly-added", updatedAt: 400 }];
  const result = merge(disk, initial, current);
  assert.deepEqual(Array.from(result, item => item.id), ["kept", "disk-only", "newly-added"]);
  assert.equal(result[0].title, "Newer disk copy");
});

test("an edited Library entry with a newer timestamp survives hydration but stale edits do not clobber disk", () => {
  const ctx = vm.createContext({});
  vm.runInContext(mergeSource, ctx);
  const merge = vm.runInContext("reconcileEarlyLibraryEntries", ctx);
  const before = [{ id: "same", updatedAt: 100, title: "Before" }];
  assert.equal(merge([{ id: "same", updatedAt: 200, title: "Disk" }], before,
    [{ id: "same", updatedAt: 150, title: "Stale edit" }])[0].title, "Disk");
  assert.equal(merge([{ id: "same", updatedAt: 200, title: "Disk" }], before,
    [{ id: "same", updatedAt: 300, title: "New edit" }])[0].title, "New edit");
});

test("in-flight initial hydration preserves new additions and commits them against SQLite's real CAS revision", async () => {
  const stored = new Map([
    ["blackline-db-migrated-v1", "1"],
    ["blackline-db-preferences-v2", "1"],
  ]);
  const localStorage = {
    getItem: key => stored.get(key) ?? null,
    setItem: (key, val) => stored.set(key, String(val)),
    removeItem: key => stored.delete(key),
  };
  const state = { library: [{ id: "cached-deleted", updatedAt: 10 }] };
  const writes = [];
  const warnings = [];
  let firstBootstrap = true;
  const ctx = vm.createContext({
    localStorage, state, Number, Date, JSON,
    APP_DB_DIRTY_SECTIONS_KEY: "blackline-db-dirty-sections-v1",
    APP_DB_MIGRATION_KEY: "blackline-db-migrated-v1",
    APP_DB_PREFERENCES_MIGRATION_KEY: "blackline-db-preferences-v2",
    PERSISTENT_CAS_SECTIONS: new Set(["library"]),
    persistentAppWriteGenerations: new Map(),
    persistentAppWriteTimers: new Map(),
    persistentAppWriteChains: new Map(),
    persistentAppSectionRevisions: new Map(),
    persistentAppStateReady: false,
    localCopyUnloaded: new Set(),
    persistentAppSnapshot: () => ({ library: state.library }),
    applyPersistentAppState: (snapshot) => { state.library = snapshot.library; },
    postJson: async (route, body) => {
      if (route === "/api/app-state/bootstrap" && firstBootstrap) {
        firstBootstrap = false;
        // User clicks Add while bootstrap request is waiting for the server.
        state.library = [...state.library, { id: "added-before-hydration", updatedAt: 500 }];
        vm.runInContext("persistAppSection", ctx)("library", state.library);
        return { initialized: true, revisions: { library: 17 } };
      }
      writes.push({ route, body });
      return { updatedAt: 18 };
    },
    fetchJson: async () => ({ state: { library: [{ id: "disk-only", updatedAt: 300 }] }, revisions: { library: 17 } }),
    renderAll() {}, applySubtitleStyle() {}, migrateLearningState() {},
    backfillPersistedChapterAutoCards() {},
    learningEnabled: false,
    console: { warn: (...args) => { warnings.push(args.map(String).join(" ")); } },
    setTimeout, clearTimeout,
  });
  vm.runInContext(piece("function persistentDirtySections(", "\nconst artworkFetches"), ctx);
  vm.runInContext(piece("function persistAppSection(", "\nfunction persistPreferences("), ctx);
  vm.runInContext(piece("async function hydratePersistentAppState(", "\nconst SPEECH_LOCALES"), ctx);
  await vm.runInContext("hydratePersistentAppState", ctx)();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(warnings, [], "Hydration should not encounter backend or stub errors");
  assert.deepEqual(Array.from(state.library, item => item.id), ["disk-only", "added-before-hydration"]);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].route, "/api/app-state/library");
  assert.equal(writes[0].body.expectedUpdatedAt, 17);
  assert.deepEqual(Array.from(writes[0].body.value, item => item.id), ["disk-only", "added-before-hydration"]);
});
