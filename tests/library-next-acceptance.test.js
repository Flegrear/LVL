import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");

function extract(start, end) {
  const from = app.indexOf(start);
  const to = app.indexOf(end, from);
  assert.ok(from !== -1 && to > from, `Could not extract ${start}`);
  return app.slice(from, to);
}

test("Finding a catalog match does not redirect after the user leaves the title", async () => {
  let completeLookup;
  const pending = new Promise((resolve) => { completeLookup = resolve; });
  let activeTitle = "series-b";
  const navigations = [];
  const ctx = vm.createContext({
    TITLE_STATUS: "#title-status",
    setToolStatus() {},
    resolveCatalogMetaForLibrarySeries: () => pending,
    titleSubject: () => ({ series: { key: activeTitle } }),
    viewActive: (view) => view === "title",
    openTitlePage: (route) => navigations.push(route),
  });
  vm.runInContext(extract("async function titleFindCatalogMatch(", "\n// One click handler for the page body"), ctx);
  activeTitle = "series-a";
  const request = vm.runInContext("titleFindCatalogMatch", ctx)({ key: "series-a", title: "A" }, null);
  activeTitle = "series-b";
  completeLookup({ id: "tt1234567", type: "series" });
  await request;
  assert.equal(navigations.length, 0, "A late result must not replace title B with title A");
});

test("Marking a completed chapter unwatched does not resume it near the credits", () => {
  const episode = { code: "S01E01", fileIndex: 0,
    progress: { positionMs: 3_580_000, durationMs: 3_600_000, finished: true, updatedAt: 100 } };
  const entry = { id: "source-1", title: "Example", seriesKey: "example", episodes: [episode], watchedChapters: {} };
  const series = { key: "example", type: "series", sources: [entry], seasons: new Map([[1, [{ entry, episode }]]]), extras: [] };
  const ctx = vm.createContext({
    state: { library: [entry], currentSource: { libraryId: "source-1" } },
    explicitUnwatchCompletionArmed: new Set(),
    explicitlyUnwatchedChapter: (_series, code) => entry.watchedChapters[code] === false,
    librarySeriesKey: (value) => value.toLowerCase(),
    anilistStoredQueue: () => [],
    persistAniListQueue() {},
    saveLibrary() {},
    libraryOrderedChapters: () => [{ code: episode.code, ref: { entry, episode }, sources: [{ entry, episode }] }],
    Date,
  });
  vm.runInContext(extract("function markWatchEpisodeUnwatched(", "\nconst ANILIST_UNWATCH_QUEUE_KEY"), ctx);
  vm.runInContext(extract("function seriesResumePoint(", "\n// Every saved chapter in watching order"), ctx);
  vm.runInContext(extract("function libraryChapterName(", "\nfunction seriesActivityAt("), ctx);
  assert.equal(vm.runInContext("markWatchEpisodeUnwatched", ctx)(series, "S01E01"), true);
  const next = vm.runInContext("seriesNextUp", ctx)(series);
  assert.ok(next.atMs < episode.progress.durationMs * 0.8,
    `An explicit unwatch should replay enough to re-arm completion; got ${next.atMs} ms`);
});

test("An unfinished chapter retains its resume point after another chapter is finished", () => {
  const first = { code: "S01E01", fileIndex: 0,
    progress: { positionMs: 3_600_000, durationMs: 3_600_000, finished: true, updatedAt: 200 } };
  const second = { code: "S01E02", fileIndex: 1,
    progress: { positionMs: 1_800_000, durationMs: 3_600_000, finished: false, updatedAt: 100 } };
  const entry = { id: "source", title: "Example", seriesKey: "example", episodes: [first, second] };
  const series = { key: "example", type: "series", sources: [entry], seasons: new Map(), extras: [] };
  const ctx = vm.createContext({
    explicitlyUnwatchedChapter: () => false,
    libraryOrderedChapters: () => [first, second].map((episode) => ({ code: episode.code,
      ref: { entry, episode }, sources: [{ entry, episode }] })),
  });
  vm.runInContext(extract("function seriesResumePoint(", "\n// Every saved chapter in watching order"), ctx);
  vm.runInContext(extract("function libraryChapterName(", "\nfunction seriesActivityAt("), ctx);
  const next = vm.runInContext("seriesNextUp", ctx)(series);
  assert.equal(next.episode.code, "S01E02");
  assert.ok(next.atMs >= 1_700_000,
    `Episode 2 should resume around 30 minutes, not restart at ${next.atMs} ms`);
});

test("An early Library save gets a valid SQLite revision once hydration completes", async () => {
  const stored = new Map([
    ["blackline-db-migrated-v1", "1"],
    ["blackline-db-preferences-v2", "1"],
  ]);
  const localStorage = {
    getItem: (key) => stored.get(key) || null,
    setItem: (key, value) => stored.set(key, value),
    removeItem: (key) => stored.delete(key),
  };
  let releaseBootstrap;
  const bootstrap = new Promise((resolve) => { releaseBootstrap = resolve; });
  const state = { library: [] };
  let diskLibrary = [{ id: "already-on-disk", title: "Existing title", updatedAt: 10 }];
  let revision = 17;
  const requests = [];
  const ctx = vm.createContext({
    localStorage,
    state,
    APP_DB_MIGRATION_KEY: "blackline-db-migrated-v1",
    APP_DB_PREFERENCES_MIGRATION_KEY: "blackline-db-preferences-v2",
    PERSISTENT_CAS_SECTIONS: new Set(["library"]),
    APP_DB_DIRTY_SECTIONS_KEY: "blackline-db-dirty-sections-v1",
    persistentAppSectionRevisions: new Map(),
    persistentAppWriteGenerations: new Map(),
    persistentAppWriteTimers: new Map(),
    persistentAppWriteChains: new Map(),
    persistentAppStateReady: false,
    LOCAL_COPY_SECTIONS: {}, localCopyUnloaded: new Set(),
    persistentAppSnapshot: () => ({ library: state.library }),
    persistentPreferencesSnapshot: () => ({}),
    applyPersistentAppState: (snapshot) => { state.library = snapshot.library; },
    postJson: async (route, body) => {
      if (route === "/api/app-state/bootstrap") return bootstrap;
      requests.push({ route, body });
      assert.equal(route, "/api/app-state/library");
      if (body.expectedUpdatedAt !== revision) throw new Error("HTTP 409 app_state_conflict");
      diskLibrary = body.value;
      revision += 1;
      return { updatedAt: revision };
    },
    fetchJson: async (route) => {
      assert.equal(route, "/api/app-state");
      return { state: { library: diskLibrary }, revisions: { library: revision } };
    },
    migrateLearningState() {}, backfillPersistedChapterAutoCards() {},
    renderAll() {}, applySubtitleStyle() {}, storeLocalCopy() {},
    learningEnabled: false,
    console: { warn() {} },
    clearTimeout, setTimeout,
  });
  vm.runInContext(extract("function persistentDirtySections(", "\nconst artworkFetches"), ctx);
  vm.runInContext(extract("function persistAppSection(", "\nfunction persistPreferences"), ctx);
  vm.runInContext(extract("async function hydratePersistentAppState(", "\nconst SPEECH_LOCALES"), ctx);
  const hydration = vm.runInContext("hydratePersistentAppState", ctx)();
  state.library.push({ id: "new-title", title: "Added during startup", updatedAt: 20 });
  vm.runInContext("persistAppSection", ctx)("library", state.library);
  assert.equal(requests.length, 0, "The title was added while bootstrap was pending");
  releaseBootstrap({ initialized: true, state: { library: diskLibrary }, revisions: { library: revision } });
  await hydration;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.expectedUpdatedAt, 17,
    "The first post-hydration save must use the authoritative SQLite revision");
  assert.deepEqual(new Set(state.library.map((item) => item.id)), new Set(["already-on-disk", "new-title"]));
  assert.deepEqual(new Set(diskLibrary.map((item) => item.id)), new Set(["already-on-disk", "new-title"]),
    "Both the existing title and the new title must persist to SQLite");
});
