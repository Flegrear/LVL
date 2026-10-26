import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { planAniListUnwatch } from "../frontend/anilist/anilist-unwatch.js";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");

test("unwatching the last AniList episode safely reduces contiguous progress", () => {
  const result = planAniListUnwatch({ accountId: 10,
    mapped: { mediaId: 502, episode: 7, episodeCount: 13 },
    remote: { id: 450, mediaId: 502, progress: 7, status: "CURRENT", media: { episodes: 13 } } });
  assert.deepEqual(result, { mediaId: 502, listEntryId: 450, progress: 6,
    status: undefined, discardedFollowing: 0, previousProgress: 7 });
});

test("unwatching an interior episode warns that AniList's later-count progress will be reduced", () => {
  const result = planAniListUnwatch({ accountId: 10,
    mapped: { mediaId: 502, episode: 3, episodeCount: 13 },
    remote: { id: 450, mediaId: 502, progress: 13, status: "COMPLETED", media: { episodes: 13 } } });
  assert.equal(result.progress, 2);
  assert.equal(result.discardedFollowing, 10);
  assert.equal(result.status, "CURRENT");
  assert.match(app, /window\.confirm\(`AniList stores episode progress as one number/);
  assert.match(app, /row\.approvedProgress !== null && row\.approvedProgress !== planned\.previousProgress/);
});

test("unwatching episode one of a completed anime resets progress and status, not score", () => {
  const result = planAniListUnwatch({ accountId: 10,
    mapped: { mediaId: 502, episode: 1, episodeCount: 13 },
    remote: { id: 450, mediaId: 502, progress: 13, status: "COMPLETED", media: { episodes: 13 } } });
  assert.equal(result.progress, 0);
  assert.equal(result.status, "PLANNING");
  assert.match(app, /anilistGraphql\(account\.token, ANILIST_SAVE_PROGRESS,[\s\S]*?mediaId: row\.mediaId, progress: planned\.progress, \.\.\.\(planned\.status \? \{ status: planned\.status \} : \{\}\)/);
  const mismatchedStatus = planAniListUnwatch({ accountId: 10,
    mapped: { mediaId: 502, episode: 1, episodeCount: 13 },
    remote: { id: 450, mediaId: 502, progress: 0, status: "COMPLETED", media: { episodes: 13 } } });
  assert.equal(mismatchedStatus.alreadySynced, undefined, "Remote COMPLETE status must still be downgraded when progress is already 0");
  assert.equal(mismatchedStatus.status, "PLANNING");
});

test("ambiguous/missing/mismatched/protected account entries never authorize a rollback", () => {
  const params = { accountId: 10, mapped: { mediaId: 502, episode: 2, episodeCount: 13 },
    remote: { id: 450, mediaId: 502, progress: 7, status: "CURRENT", media: { episodes: 13 } } };
  assert.equal(planAniListUnwatch({ ...params, accountId: 0 }), null);
  assert.equal(planAniListUnwatch({ ...params, remote: null }), null);
  assert.equal(planAniListUnwatch({ ...params, remote: { ...params.remote, mediaId: 503 } }), null);
  assert.equal(planAniListUnwatch({ ...params, remote: { ...params.remote, media: { episodes: 12 } } }), null);
  assert.equal(planAniListUnwatch({ ...params, remote: { ...params.remote, status: "PAUSED" } }), null);
  assert.equal(planAniListUnwatch({ ...params, remote: { ...params.remote, status: "DROPPED" } }), null);
  assert.equal(planAniListUnwatch({ ...params, remote: { ...params.remote, status: "REPEATING" } }), null);
  assert.equal(planAniListUnwatch({ ...params, remote: { ...params.remote, progress: 0 } }).alreadySynced, true);
});

test("all episode surfaces expose reverse action and preserve an explicit unwatched marker against reimport", () => {
  for (const needle of ["Mark as not watched", "function markWatchEpisodeUnwatched", "data-watch-retry-anilist",
    "function toggleEpisodeWatched", "function syncExplicitAniListUnwatch", "function flushAniListUnwatches"]) {
    assert.ok(app.includes(needle), needle);
  }
  assert.match(app, /Object\.hasOwn\(watched, code\)/, "Remote import respects local intentional unwatch");
  assert.match(app, /queue: stored\.filter\(\(row\) => row\.seriesKey === series\.key && !unwatched\.has\(row\.code\)\)/);
  assert.match(app, /!explicitlyUnwatchedChapter\(series, code\)/);
  assert.match(app, /savePendingAniListUnwatches\(pendingAniListUnwatches\(\)\.filter/);
});

test("full browser-side unwatch cycle preflights, confirms, writes only progress/status and rereads", async () => {
  const from = app.indexOf('const ANILIST_UNWATCH_QUEUE_KEY = "lvl-anilist-unwatch-queue";');
  const to = app.indexOf("\nfunction toggleEpisodeWatched(", from);
  assert.ok(from >= 0 && to > from);
  const stored = new Map();
  const localStorage = { getItem: (key) => stored.get(key) || null,
    setItem: (key, value) => stored.set(key, value) };
  const account = { token: "MOCK-NOT-REAL", userId: 42 };
  const series = { key: "safe-show", type: "series" };
  const calls = [];
  let progress = 5;
  let status = "COMPLETED";
  const context = vm.createContext({
    localStorage, readAniListAccount: () => account, seriesAniList: () => ({ seasons: [{ season: 1 }] }),
    resolveAniListEpisode: () => ({ mediaId: 99, episode: 3, episodeCount: 13 }),
    planAniListUnwatch, anilistAutoRun: null, anilistAutoTimer: 0,
    buildLibrarySeries: () => [series], explicitlyUnwatchedChapter: () => true,
    ANILIST_SINGLE_PROGRESS_QUERY: "single", ANILIST_SAVE_PROGRESS: "save",
    clearTimeout: () => {}, toast: () => {}, writeAniListPreference: () => {},
    window: { confirm: (prompt) => { calls.push({ kind: "confirmation", prompt }); return true; } },
    anilistGraphql: async (_token, query, vars) => {
      calls.push({ kind: query, vars });
      if (query === "single") return { MediaList: { id: 7, mediaId: 99, progress, status, media: { episodes: 13 } } };
      assert.equal(query, "save");
      assert.deepEqual(JSON.parse(JSON.stringify(vars)), { mediaId: 99, progress: 2, status: "CURRENT" });
      progress = vars.progress; status = vars.status;
      return { SaveMediaListEntry: { id: 7, mediaId: 99, progress, status } };
    },
  });
  vm.runInContext(app.slice(from, to), context);
  await vm.runInContext('syncExplicitAniListUnwatch(series, "S01E03")', Object.assign(context, { series }));
  assert.deepEqual(calls.map((call) => call.kind), ["single", "confirmation", "save", "single"]);
  assert.match(calls[1].prompt, /reduces AniList's contiguous progress for 2 later episode/);
  assert.equal(progress, 2);
  assert.equal(status, "CURRENT");
  assert.deepEqual(JSON.parse(localStorage.getItem("lvl-anilist-unwatch-queue")), []);
});

test("two explicit unwatches requested during one remote preflight both complete, with separate approval", async () => {
  const from = app.indexOf('const ANILIST_UNWATCH_QUEUE_KEY = "lvl-anilist-unwatch-queue";');
  const to = app.indexOf("\nfunction toggleEpisodeWatched(", from);
  const store = new Map();
  const localStorage = { getItem: (key) => store.get(key) || null,
    setItem: (key, value) => store.set(key, value) };
  const account = { token: "DUMMY-LOCAL-ONLY", userId: 42 };
  const series = { key: "safe-show", type: "series" };
  let progress = 5;
  let reads = 0;
  let approvals = 0;
  let releaseFirst;
  let firstReadStarted;
  const firstRead = new Promise((resolve) => { firstReadStarted = resolve; });
  const ctx = vm.createContext({ localStorage, series, anilistAutoRun: null, anilistAutoTimer: 0,
    readAniListAccount: () => account, seriesAniList: () => ({ seasons: [{ season: 1 }] }),
    resolveAniListEpisode: ({ episodeCode }) => ({ mediaId: 99, episode: Number(episodeCode.slice(4)), episodeCount: 13 }),
    planAniListUnwatch, buildLibrarySeries: () => [series], explicitlyUnwatchedChapter: () => true,
    clearTimeout: () => {}, toast: () => {}, writeAniListPreference: () => {},
    ANILIST_SINGLE_PROGRESS_QUERY: "single", ANILIST_SAVE_PROGRESS: "save",
    window: { confirm: () => { approvals++; return true; } },
    anilistGraphql: async (_token, query, vars) => {
      if (query === "single") {
        if (++reads === 1) {
          firstReadStarted();
          await new Promise((resolve) => { releaseFirst = resolve; });
        }
        return { MediaList: { id: 7, mediaId: 99, progress, status: "CURRENT", media: { episodes: 13 } } };
      }
      assert.equal(query, "save");
      assert.equal(vars.mediaId, 99);
      assert.equal(Object.hasOwn(vars, "score"), false);
      progress = vars.progress;
      return { SaveMediaListEntry: { id: 7, mediaId: 99, progress, status: "CURRENT" } };
    },
  });
  vm.runInContext(app.slice(from, to), ctx);
  const first = vm.runInContext('syncExplicitAniListUnwatch(series, "S01E03")', ctx);
  await firstRead;
  const second = vm.runInContext('syncExplicitAniListUnwatch(series, "S01E02")', ctx);
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(progress, 1, "Both episode removals must reach the remote count safely");
  assert.equal(approvals, 2, "Each remote count reduction requires its own user approval");
  assert.deepEqual(JSON.parse(localStorage.getItem("lvl-anilist-unwatch-queue")), []);
});

test("previous AniList rollback approvals are invalidated on account reauthorization", () => {
  const from = app.indexOf('const ANILIST_UNWATCH_QUEUE_KEY = "lvl-anilist-unwatch-queue";');
  const to = app.indexOf("\nlet explicitAniListUnwatchRun = null;", from);
  const store = new Map();
  const localStorage = { getItem: (key) => store.get(key) || null,
    setItem: (key, value) => store.set(key, value) };
  const ctx = vm.createContext({ localStorage });
  vm.runInContext(app.slice(from, to), ctx);
  vm.runInContext('savePendingAniListUnwatches([{accountId:42,seriesKey:"safe-show",code:"S01E03",approvedProgress:5}]);invalidateAniListUnwatchApprovals();', ctx);
  const queued = JSON.parse(localStorage.getItem("lvl-anilist-unwatch-queue"));
  assert.equal(queued[0].approvedProgress, null, "Do not replay an old session's remote-reduction consent");
  assert.match(app, /const switchedAccount[\s\S]*?invalidateAniListUnwatchApprovals\(\)/);
});
