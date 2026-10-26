import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import {
  resolveAniListEpisode, planAniListWatchSync, reconcileAniListProgressQueue,
} from "../frontend/anilist/anilist-watch-sync.js";
import { anilistGraphql as directAniListGraphql, ANILIST_LIST_QUERY as actualListQuery,
  ANILIST_SINGLE_PROGRESS_QUERY as actualFreshQuery, ANILIST_SAVE_PROGRESS as actualSaveQuery,
  remoteAniListEntries } from "../frontend/anilist/anilist-auto-client.js";
import { seriesAniList as actualSeriesAniList } from "../frontend/anilist/anilist-library.js";

const source = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const start = source.indexOf("function anilistStoredQueue()");
const end = source.indexOf("\nasync function syncAniListAuto(", start);
assert.ok(start > 0 && end > start, "Locate real Watch-to-AniList integration functions");
const integrated = source.slice(start, end);

function fixture({ seasons, episodes = [], watchedChapters = {}, savedQueue = [], imported = true, manualLinks = [], autoLinks = [], accountId = 42 } = {}) {
  const key = "frieren";
  const entry = {
    id: "local-torrent", title: "Frieren", seriesKey: key,
    episodes: structuredClone(episodes), watchedChapters: structuredClone(watchedChapters),
    anilist: imported ? { showId: "account-verified:fixture", accountUserId: accountId,
      seasons: structuredClone(seasons || [{ anilistId: 100, season: 1, episodes: 12, format: "TV", progress: 0, status: "CURRENT" }]) } : null,
    anilistManualLinks: structuredClone(manualLinks),
    anilistAutoLinks: structuredClone(autoLinks),
  };
  const series = { key, catalogId: "tt2359704", type: "series", mediaKind: "anime", sources: [entry] };
  const store = { "lvl-anilist-sync-queue-v1": JSON.stringify(savedQueue) };
  let saves = 0;
  let renders = 0;
  const context = vm.createContext({
    ANILIST_SYNC_QUEUE: "lvl-anilist-sync-queue-v1",
    readStorageArray: (id) => JSON.parse(store[id] || "[]"),
    readAniListPreference: () => ({ threshold: 80 }),
    readAniListAccount: () => ({ userId: accountId }),
    localStorage: { setItem: (id, value) => { store[id] = value; } },
    buildLibrarySeries: () => [series],
    explicitlyUnwatchedChapter: (item, code) => item.sources.some((source) => source.watchedChapters?.[code] === false),
    seriesAniList: actualSeriesAniList,
    planAniListWatchSync,
    reconcileAniListProgressQueue,
    resolveAniListEpisode,
    state: { library: [entry] },
    saveLibrary: () => { saves++; },
    renderWatchChapters: () => { renders++; },
    renderLibrary: () => { renders++; },
    $: () => ({ classList: { contains: () => false } }),
    Date,
  });
  vm.runInContext(integrated, context, { filename: "app.js:anilist-watch-sync" });
  return {
    queue: vm.runInContext("gatherAniListWatchedQueue", context),
    importHistory: vm.runInContext("applyAniListRemoteWatchHistory", context),
    entry, series, store,
    get saves() { return saves; },
    get renders() { return renders; },
  };
}

test("80% threshold queues matching anime only and leaves local playback resume position unchanged", () => {
  const env = fixture({ episodes: [
    { code: "S01E01", progress: { positionMs: 800, durationMs: 1000, finished: false } },
    { code: "S01E02", progress: { positionMs: 500, durationMs: 1000, finished: false } },
  ] });
  const planned = env.queue();
  assert.equal(planned.queue.length, 1);
  assert.equal(planned.queue[0].mediaId, 100);
  assert.equal(planned.queue[0].episode, 1);
  assert.equal(env.entry.episodes[0].progress.finished, false);
  assert.equal(env.entry.episodes[0].progress.positionMs, 800);
});

test("an explicit false on either saved source blocks imported watched history and forward completion", () => {
  const env = fixture({ watchedChapters: { S01E02: false } });
  env.series.sources.push({ id: "duplicate", watchedChapters: { S01E02: 171 }, episodes: [
    { code: "S01E02", progress: { durationMs: 1000, positionMs: 1000, finished: true } },
  ] });
  const queued = env.queue();
  assert.equal(queued.queue.some((item) => item.code === "S01E02"), false,
    "A stale positive marker on another source must never override explicit false");
  env.importHistory(new Map([[100, { mediaId: 100, progress: 2, status: "CURRENT" }]]));
  assert.equal(env.entry.watchedChapters.S01E02, false, "Remote count must respect the local tombstone");
});

test("Manual watch markers survive with zero saved video sources and queue for sync", () => {
  const env = fixture({ watchedChapters: { S01E01: 1730000000 } });
  assert.equal(env.queue().queue[0].episode, 1);
  assert.deepEqual(env.entry.episodes, []);
});

test("JoJo not on the AniList list stays blocked until explicitly linked, then queues episode one", () => {
  const env = fixture({ imported: false, episodes: [
    { code: "S01E01", progress: { positionMs: 1291269, durationMs: 1444256, finished: false } },
  ] });
  const unknown = env.queue();
  assert.equal(unknown.queue.length, 0, "Never infer unlisted anime media IDs from the title");
  assert.equal(unknown.unmapped, 1, "Show a useful skipped-episode count rather than zero");
  env.entry.anilistManualLinks.push({ userId: 42, season: 1, anilistId: 14719, format: "TV", episodes: 26 });
  const linked = env.queue();
  assert.equal(linked.unmapped, 0);
  assert.equal(linked.queue.length, 1);
  assert.equal(linked.queue[0].episode, 1);
  assert.equal(linked.queue[0].mediaId, 14719);
  assert.equal(env.entry.episodes[0].progress.finished, false, "Resuming video stays independent from remote completed-episode progress");
});

test("Old queued mappings are held offline, never sent using a changed AniList ID", () => {
  const env = fixture({ watchedChapters: { S01E01: 1 }, savedQueue: [
    { mediaId: 999, episode: 1, episodeCount: 12, code: "S01E01", seriesKey: "frieren" },
  ] });
  const planned = env.queue();
  assert.deepEqual([...planned.queue].map((item) => item.mediaId), [100]);
  assert.deepEqual(JSON.parse(env.store["lvl-anilist-sync-queue-v1"]).map((item) => item.mediaId), [100, 999]);
  assert.equal(planned.unmapped, 1);
});

test("Remote episode count imports into local watched markers without overwriting video progress", () => {
  const env = fixture({ episodes: [
    { code: "S01E02", progress: { positionMs: 500, durationMs: 1000, finished: false } },
  ] });
  const remote = new Map([[100, { mediaId: 100, progress: 2, status: "CURRENT" }]]);
  assert.equal(env.importHistory(remote), true);
  assert.ok(env.entry.watchedChapters.S01E01);
  assert.ok(env.entry.watchedChapters.S01E02);
  assert.equal(env.entry.episodes[0].progress.positionMs, 500);
  assert.equal(env.entry.anilist.seasons[0].progress, 2);
  assert.equal(env.saves, 1);
  assert.equal(env.importHistory(remote), false, "Repeated pull does not touch already synced state");
});

test("Manual-only AniList links pull authenticated progress into Library without crossing accounts", () => {
  const manualLinks = [{ userId: 42, season: 1, anilistId: 14719, episodes: 26, format: "TV" }];
  const episodes = [{ code: "S01E02", progress: { positionMs: 500, durationMs: 1000, finished: false } }];
  const remote = new Map([[14719, { mediaId: 14719, progress: 2, status: "CURRENT" }]]);
  const linked = fixture({ imported: false, manualLinks, episodes });
  assert.equal(linked.importHistory(remote), true);
  assert.ok(linked.entry.watchedChapters.S01E01);
  assert.ok(linked.entry.watchedChapters.S01E02);
  assert.equal(linked.entry.episodes[0].progress.positionMs, 500);
  assert.equal(linked.entry.anilist, null, "Do not fabricate remote import metadata on a manual link");
  assert.equal(linked.importHistory(remote), false, "Re-reading must be idempotent");

  const other = fixture({ imported: false, manualLinks, episodes, accountId: 43 });
  assert.equal(other.importHistory(remote), false, "Other accounts cannot consume manual links");
  assert.deepEqual(other.entry.watchedChapters, {});
});

test("Automatic split-cour mapping pushes and pulls the correct AniList episode offsets", () => {
  const autoLinks = [
    { userId: 42, catalogId: "tt2359704", season: 2, anilistId: 20474, episodes: 24, format: "TV", title: "Stardust", start: 1, end: 24 },
    { userId: 42, catalogId: "tt2359704", season: 2, anilistId: 20799, episodes: 24, format: "TV", title: "Battle in Egypt", start: 25, end: 48 },
  ];
  const env = fixture({ imported: false, autoLinks,
    episodes: [{ code: "S02E25", progress: { positionMs: 900, durationMs: 1000, finished: false } }] });
  const queued = env.queue();
  assert.equal(queued.unmapped, 0);
  assert.deepEqual(queued.queue.map(({ mediaId, episode, code }) => [mediaId, episode, code]),
    [[20799, 1, "S02E25"]], "S02E25 maps to AniList part 2 episode 1");
  const remote = new Map([[20474, { progress: 24 }], [20799, { progress: 2 }]]);
  assert.equal(env.importHistory(remote), true);
  assert.ok(env.entry.watchedChapters.S02E24);
  assert.ok(env.entry.watchedChapters.S02E25);
  assert.ok(env.entry.watchedChapters.S02E26);
  assert.equal(env.entry.watchedChapters.S02E27, undefined);
  assert.equal(env.entry.episodes[0].progress.positionMs, 900);
  assert.equal(fixture({ imported: false, autoLinks, accountId: 43,
    episodes: [{ code: "S02E25", progress: { positionMs: 900, durationMs: 1000 } }] }).queue().queue.length, 0);
});

test("Unknown AniList progress never marks local episodes or overwrites imported metadata", () => {
  const env = fixture({ episodes: [{ code: "S01E02", progress: { positionMs: 250, durationMs: 1000 } }] });
  assert.equal(env.importHistory(new Map([[100, { mediaId: 100, progress: null, progressKnown: false, status: "CURRENT" }]])), false);
  assert.deepEqual(env.entry.watchedChapters, {});
  assert.equal(env.entry.anilist.seasons[0].progress, 0);
  assert.equal(env.entry.episodes[0].progress.positionMs, 250);
});

test("Ambiguous split seasons are neither queued nor imported into wrong AniList parts", () => {
  const env = fixture({
    seasons: [
      { season: 1, anilistId: 100, episodes: 12, format: "TV" },
      { season: 1, anilistId: 101, episodes: 12, format: "TV" },
    ],
    watchedChapters: { S01E13: 1 },
  });
  assert.equal(env.queue().queue.length, 0);
  assert.equal(env.queue().unmapped, 1);
  env.importHistory(new Map([[100, { progress: 12 }], [101, { progress: 12 }]]));
  assert.equal(JSON.stringify(env.entry.watchedChapters), '{"S01E13":1}', "ambiguous AniList parts never create local watched markers");
});

test("New login discards old authorized queue even if previous token expired and pauses account switches", () => {
  const complete = source.slice(source.indexOf("async function connectVerifiedAniListAccount("),
    source.indexOf("\nasync function completeAniListAuthorization()", source.indexOf("async function connectVerifiedAniListAccount(")));
  assert.match(complete, /readStorageObject\(ANILIST_OAUTH_STORAGE\)/,
    "Previous identity must be read independently of token validity/expiry");
  assert.match(complete, /const switchedAccount = oldUserId !== null && oldUserId !== viewer\.id/);
  assert.match(complete, /localStorage\.removeItem\(ANILIST_SYNC_QUEUE\)/,
    "Queue from previous authorization must not be uploaded to another account");
  assert.match(complete, /enabled: !switchedAccount/, "A different linked account must opt back in");
  assert.match(complete, /if \(oldUserId !== viewer\.id\) localStorage\.removeItem\(ANILIST_SYNC_QUEUE\)/,
    "Preserve pending watches when reauthorizing the SAME account");
});

test("Connect remains available while a stale token's sync request is running", () => {
  const start = source.indexOf("function renderAniListAutoSettings()");
  const end = source.indexOf("\nfunction anilistStoredQueue()", start);
  const body = source.slice(start, end);
  assert.match(body, /if \(connect\) connect\.disabled = false;/,
    "A revoked token must not block starting a new authorization");
});

test("Disconnect prevents late Viewer verification from restoring an AniList bearer token", async () => {
  const start = source.indexOf("async function connectVerifiedAniListAccount(");
  const end = source.indexOf("\nasync function completeAniListAuthorization()", start);
  assert.ok(start > 0 && end > start);
  let resolveViewer;
  const store = { token: "previous-token", userId: 1 };
  const localStorage = { setItem: (key, value) => { store[key] = value; }, removeItem: (key) => { delete store[key]; } };
  const context = vm.createContext({
    anilistAutoAuthGeneration: 1, localStorage,
    ANILIST_OAUTH_STORAGE: "token", ANILIST_SYNC_QUEUE: "queue",
    ANILIST_VIEWER_QUERY: "Viewer", readStorageObject: () => store,
    anilistGraphql: () => new Promise((resolve) => { resolveViewer = resolve; }),
    writeAniListPreference: () => ({}),
    showAniListAutoStatus: () => {}, renderAniListAutoSettings: () => {},
  });
  vm.runInContext(source.slice(start, end), context);
  const login = vm.runInContext("connectVerifiedAniListAccount({token:'new-token'}, 1)", context);
  vm.runInContext("anilistAutoAuthGeneration++", context); // user clicked Disconnect
  localStorage.removeItem("token");
  resolveViewer({ Viewer: { id: 1, name: "test" } });
  await login;
  assert.equal(store.token, undefined, "A stale response must not restore bearer storage");
});

test("In-flight sync checks the current bearer before and after each awaited mutation", () => {
  const start = source.indexOf("async function syncAniListAuto(");
  const end = source.indexOf("\nfunction scheduleAniListAutoSync(", start);
  const body = source.slice(start, end);
  assert.ok(body.includes("ANILIST_SINGLE_PROGRESS_QUERY"), "Every update must re-read current progress");
  assert.match(body, /const actual = await anilistGraphql\(account\.token, ANILIST_SAVE_PROGRESS, freshUpdate\);\s*\/\/[^\n]*\n[^\n]*\n\s*if \(readAniListAccount\(localStorage\)\?\.token !== account\.token\) return;/,
    "After a pending AniList mutation, never reinsert another session's queue");
});

function syncFixture({ freshProgress = 3, freshEpisodes = 12, onPreflight = () => {}, initialList,
  blockedMedia = () => new Set(), onMutation = () => ({
  SaveMediaListEntry: { mediaId: 100, progress: 3, status: "CURRENT" },
}) } = {}) {
  const start = source.indexOf("async function syncAniListAuto(");
  const end = source.indexOf("\nfunction scheduleAniListAutoSync(", start);
  const pending = [{ mediaId: 100, episode: 3, episodeCount: 12, code: "S01E03", seriesKey: "series" }];
  const storage = { oauth: { token: "old-token", userId: 1, username: "Viewer" } };
  const history = [];
  let mutationCount = 0;
  const context = vm.createContext({
    persistentAppStateReady: true, anilistAutoRun: null, explicitAniListUnwatchRun: null,
    anilistAutoDevTestRun: false, anilistAutoRetryAfter: 0,
    anilistAutoLastQueueSnapshot: null, anilistAutoImportWarning: "",
    ANILIST_LIST_QUERY: "list", ANILIST_SINGLE_PROGRESS_QUERY: "fresh", ANILIST_SAVE_PROGRESS: "mutation",
    localStorage: storage,
    readAniListAccount: () => storage.oauth,
    readAniListPreference: () => ({ enabled: true, lastPull: 0 }),
    writeAniListPreference: () => ({}),
    autoLinkAniListWatchedSeries: async () => 0,
    verifiedAniListCreationKeys: () => new Set(),
    blockedAniListForwardMedia: blockedMedia,
    gatherAniListWatchedQueue: () => ({ queue: structuredClone(pending), blocked: [], unmapped: 0 }),
    applyAniListRemoteWatchHistory: () => false,
    remoteAniListEntries, reconcileAniListProgressQueue,
    persistAniListQueue: (queue) => history.push(structuredClone(queue)),
    renderAniListAutoSettings: () => {}, showAniListAutoStatus: () => {}, toast: () => {},
    anilistGraphql: async (_token, query) => {
      if (query === "list") return initialList === undefined ? {
        Viewer: { id: 1 }, MediaListCollection: { lists: [{ entries: [
          { mediaId: 100, progress: 2, status: "CURRENT", media: { episodes: 12 } },
        ] }] },
      } : initialList;
      if (query === "fresh") {
        onPreflight();
        return { MediaList: { mediaId: 100, progress: freshProgress,
          status: "CURRENT", media: { episodes: freshEpisodes } } };
      }
      mutationCount++;
      return onMutation();
    },
  });
  vm.runInContext(source.slice(start, end), context);
  return {
    run: () => vm.runInContext("syncAniListAuto({manual:true})", context),
    storage, history, context, get mutationCount() { return mutationCount; },
  };
}

test("Live prewrite progress read avoids overwriting a newer AniList episode count", async () => {
  const ctx = syncFixture({ freshProgress: 3 });
  await ctx.run();
  assert.equal(ctx.mutationCount, 0, "Another client's newer progress must win");
  assert.deepEqual(ctx.history.at(-1), [], "Confirmed episodes should clear from pending queue");
});

test("Auto-sync refuses a missing or incomplete authenticated collection before any writes", async () => {
  for (const collection of [null, { lists: [{}] }, { lists: [{ entries: [null] }] }]) {
    const ctx = syncFixture({ initialList: { Viewer: { id: 1 }, MediaListCollection: collection } });
    const result = await ctx.run();
    assert.equal(result?.ok, false, "Incomplete remote snapshots must fail closed");
    assert.equal(ctx.mutationCount, 0, "An incomplete snapshot cannot authorize SaveMediaListEntry");
  }
});

test("an explicit unwatch blocks same-season automatic forward progress even with later episodes queued", async () => {
  let blockAfterRead = false;
  const ctx = syncFixture({ freshProgress: 2, onPreflight: () => { blockAfterRead = true; },
    blockedMedia: () => blockAfterRead ? new Set([100]) : new Set() });
  await ctx.run();
  assert.equal(ctx.mutationCount, 0, "No stale forward SaveMediaListEntry after unwatch during preflight");
  assert.ok(ctx.history.some((rows) => rows.length), "Deferred forward completions stay queued");
});

test("automatic progress waits for an active explicit rollback before starting", async () => {
  let release;
  const ctx = syncFixture({ freshProgress: 2 });
  ctx.context.explicitAniListUnwatchRun = new Promise((resolve) => { release = resolve; });
  const task = ctx.run();
  await Promise.resolve();
  assert.equal(ctx.mutationCount, 0);
  release();
  await task;
  assert.equal(ctx.mutationCount, 1, "Forward sync resumes only after the explicit rollback completes");
});

test("JoJo absent from AniList list: actual 404 preflight permits safe mock creation of S01E01 progress 1", async () => {
  const start = source.indexOf("async function syncAniListAuto(");
  const end = source.indexOf("\nfunction scheduleAniListAutoSync(", start);
  const account = { token: "not-a-real-token", userId: 42, username: "Mock" };
  const progress = [{ mediaId: 14719, episode: 1, episodeCount: 26,
    code: "S01E01", seriesKey: "jojo's bizarre adventure" }];
  const queueHistory = [];
  const requests = [];
  const status = [];
  const mockFetch = async (_url, options) => {
    const { query, variables } = JSON.parse(options.body);
    requests.push({ query, variables });
    assert.equal(options.headers.Authorization, `Bearer ${account.token}`);
    assert.equal(options.credentials, "omit");
    if (query === actualListQuery) return { ok: true, status: 200, json: async () => ({
      data: { Viewer: { id: account.userId }, MediaListCollection: { lists: [{ entries: [] }] } },
    }) };
    if (query === actualFreshQuery) return { ok: false, status: 404, json: async () => ({
      data: { MediaList: null }, errors: [{ status: 404, message: "Not Found." }],
    }) };
    if (query === actualSaveQuery) return { ok: true, status: 200, json: async () => ({
      data: { SaveMediaListEntry: { id: 25, mediaId: 14719, progress: 1, status: "CURRENT" } },
    }) };
    throw new Error(`Unexpected query: ${query.slice(0, 60)}`);
  };
  const context = vm.createContext({
    persistentAppStateReady: true, anilistAutoRun: null, explicitAniListUnwatchRun: null,
    anilistAutoDevTestRun: false,
    anilistAutoRetryAfter: 0, anilistAutoLastQueueSnapshot: null, anilistAutoImportWarning: "",
    ANILIST_LIST_QUERY: actualListQuery, ANILIST_SINGLE_PROGRESS_QUERY: actualFreshQuery,
    ANILIST_SAVE_PROGRESS: actualSaveQuery, ANILIST_LIBRARY_KEY: "last-import",
    localStorage: { getItem: () => String(Date.now()) },
    readAniListAccount: () => account, readAniListPreference: () => ({ enabled: true, lastPull: 0 }),
    writeAniListPreference: () => ({}), autoLinkAniListWatchedSeries: async () => 0,
    verifiedAniListCreationKeys: () => new Set(["jojo's bizarre adventure\0" + 14719]),
    blockedAniListForwardMedia: () => new Set(),
    gatherAniListWatchedQueue: () => ({ queue: structuredClone(progress), blocked: [], unmapped: 0 }),
    applyAniListRemoteWatchHistory: () => false,
    remoteAniListEntries, reconcileAniListProgressQueue,
    persistAniListQueue: (items) => queueHistory.push(structuredClone(items)),
    showAniListAutoStatus: (message, error) => status.push({ message, error }),
    renderAniListAutoSettings: () => {}, toast: () => {},
    anilistGraphql: (token, query, vars) => directAniListGraphql(token, query, vars, mockFetch),
  });
  vm.runInContext(source.slice(start, end), context);
  const result = await vm.runInContext("syncAniListAuto({manual:true})", context);
  assert.equal(result?.ok, true);
  assert.equal(result?.sent, 1);
  assert.deepEqual(requests.map((call) => call.query), [actualListQuery, actualFreshQuery, actualSaveQuery]);
  assert.deepEqual(requests.at(-1).variables, { mediaId: 14719, progress: 1, status: "CURRENT" });
  assert.deepEqual(queueHistory.at(-1), [], "Confirmed first episode leaves no pending queue");
  assert.match(status.at(-1)?.message, /1 update sent/);
});

test("only account-verified source associations authorize creating missing AniList entries", () => {
  const from = source.indexOf("function verifiedAniListCreationKeys(");
  const to = source.indexOf("\nfunction applyAniListRemoteWatchHistory(", from);
  assert.ok(from >= 0 && to > from);
  const sources = [
    { id: "metadata-only", anilistAutoLinks: [{
      userId: 42, catalogId: "tt2359704", season: 1, anilistId: 14719,
      format: "TV", episodes: 26, start: 1, end: 26,
    }] },
    { id: "episode-source", episodes: [{ code: "S01E01" }],
      anilist: { showId: "public:unverified", seasons: [{ anilistId: 123, season: 2 }] } },
  ];
  const ctx = vm.createContext({
    buildLibrarySeries: () => [{ key: "jojo's bizarre adventure", catalogId: "tt2359704",
      type: "series", sources }], canLinkAniListTv: () => true,
  });
  vm.runInContext(source.slice(from, to), ctx);
  const keys = vm.runInContext("verifiedAniListCreationKeys", ctx);
  assert.ok(keys(42).has("jojo's bizarre adventure\0" + 14719));
  assert.equal(keys(42).has("jojo's bizarre adventure\0" + 123), false,
    "An unverified public imported title cannot authorize a new entry");
  assert.equal(keys(43).size, 0, "A different OAuth account cannot create entries from this association");
  sources[0].anilistAutoLinks[0].catalogId = "tt0000000";
  assert.equal(keys(42).size, 0, "A changed catalog identity invalidates automatic creation permission");
});

test("Live prewrite mismatch in authoritative episode total blocks a dangerous COMPLETED update", async () => {
  const ctx = syncFixture({ freshProgress: 2, freshEpisodes: 24 });
  await ctx.run();
  assert.equal(ctx.mutationCount, 0);
  assert.equal(ctx.history.at(-1)?.length, 1, "Uncertain mapping must remain queued for review");
});

test("An in-flight mutation cannot resurrect the old account's queue after disconnect", async () => {
  let release;
  let started;
  const hasStarted = new Promise((resolve) => { started = resolve; });
  const ctx = syncFixture({ freshProgress: 2, onMutation: () => {
    started();
    return new Promise((resolve) => { release = resolve; });
  } });
  const running = ctx.run();
  await hasStarted;
  ctx.storage.oauth = null; // Disconnect happened during the POST request
  const storedBefore = ctx.history.length;
  release({ SaveMediaListEntry: { mediaId: 100, progress: 3, status: "CURRENT" } });
  await running;
  assert.equal(ctx.history.length, storedBefore, "Old OAuth session may not rewrite the pending queue");
});
