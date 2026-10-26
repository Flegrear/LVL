import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { seriesAniList } from "../frontend/anilist/anilist-library.js";
import { ANILIST_SCORE_ENTRY_QUERY, ANILIST_SCORE_SAVE, resolveAniListScorePart, saveAniListScore } from "../frontend/anilist/anilist-score-sync.js";

// Exercise the actual title-page and score-save handlers without a browser,
// credentials, localhost writes or AniList requests.
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
function section(from, to) {
  const a = app.indexOf(from);
  const b = app.indexOf(to, a + from.length);
  assert.ok(a >= 0 && b > a, `Missing real app.js seam ${from}`);
  return app.slice(a, b);
}

function seriesFor(userId, mediaId) {
  return { key: "identical anime", catalogId: "tt1234567", sources: [{ id: "saved", anilist: {
    showId: "authenticated:list", accountUserId: userId,
    seasons: [{ anilistId: mediaId, season: 1, episodes: 12, score: 8.5, format: "TV" }],
  } }] };
}

test("title rating uses current authenticated owner's AniList association, not the old account's display metadata", () => {
  const previousAccountLibrary = seriesFor(100, 777);
  const context = vm.createContext({
    seriesAniList, readAniListAccount: () => ({ userId: 200 }), localStorage: {},
    buildLibrarySeries: () => [previousAccountLibrary],
    eligibleForPublicAnimeRating: () => true,
  });
  vm.runInContext(section("function authenticatedTitleAniList(", "\nasync function saveUserAniListScore("), context);
  vm.runInContext(section("function titleRatingSubject(", "\nfunction renderTitlePage("), context);
  const subject = { id: "tt1234567", key: previousAccountLibrary.key, type: "series", series: previousAccountLibrary };
  const meta = { seasons: [{ season: 1, count: 12 }] };
  const rating = context.titleRatingSubject(subject,
    { name: "Identical anime", genres: ["Animation"], country: "Japan" }, meta);
  assert.equal(rating.anilist, null, "Previous user's imported list cannot be the new user's score editor source");
});

test("score-save revalidates ownership against current Library, not stale title subject, before staging a write", async () => {
  const original = seriesFor(100, 777);
  const rendered = { catalogId: original.catalogId, seriesKey: original.key,
    kind: "anime", anilist: seriesAniList(original) };
  const account = { userId: 200, token: "mock" };
  const calls = [];
  let live = [original];
  const context = vm.createContext({
    anilistScoreSyncEnabled: () => true, anilistAutoDevTestRun: null,
    readAniListAccount: () => account, localStorage: {},
    buildLibrarySeries: () => live, seriesAniList, resolveAniListScorePart,
    stageUnconfirmedAniListScore: () => calls.push("stage"),
    saveAniListScore: async () => { calls.push("remote"); return { scoreRaw: 90 }; },
    anilistGraphql: () => { throw new Error("Unexpected network"); },
    anilistScoreRuns: new Map(), acknowledgeUnconfirmedAniListScore: () => calls.push("ack"),
    saveLibrary: () => calls.push("library"), recsUi: { invalidateRatings: () => {} },
    syncAniListLibrary: async () => {}, showAniListAutoStatus: () => {}, toast: () => {},
    console: { warn() {} },
  });
  vm.runInContext(section("function authenticatedTitleAniList(", "\nasync function saveUserAniListScore("), context);
  vm.runInContext(section("async function saveUserAniListScore(", "\n// Authenticated AniList"), context);
  await assert.rejects(context.saveUserAniListScore(rendered, 1, 9), /safely identify|account|mapping/i);
  assert.deepEqual(calls, [], "Foreign account metadata must never stage or send score updates");

  // Account 200 now links this title explicitly, but to another media ID;
  // the previously rendered editor must not silently redirect a stale edit.
  live = [seriesFor(200, 888)];
  await assert.rejects(context.saveUserAniListScore(rendered, 1, 9), /safely identify|account|mapping/i);
  assert.deepEqual(calls, []);

  const current = { ...rendered, anilist: seriesAniList(live[0], 200) };
  const result = await context.saveUserAniListScore(current, 1, 9);
  assert.match(result, /Saved to AniList/);
  assert.deepEqual(calls, ["stage", "remote", "ack", "library"]);
});

test("two LVL catalog seasons sharing one AniList media ID never overwrite each other's remote score", async () => {
  const original = seriesFor(200, 777);
  original.sources[0].anilist.seasons.push({
    anilistId: 777, season: 2, episodes: 12, score: 8.5, format: "TV",
  });
  const calls = [];
  const account = { userId: 200, token: "mock" };
  const context = vm.createContext({
    anilistScoreSyncEnabled: () => true, anilistAutoDevTestRun: null,
    readAniListAccount: () => account, localStorage: {},
    buildLibrarySeries: () => [original], seriesAniList, resolveAniListScorePart,
    stageUnconfirmedAniListScore: () => calls.push("stage"),
    saveAniListScore: async () => { calls.push("remote"); return { scoreRaw: 91 }; },
    anilistScoreRuns: new Map(), saveLibrary: () => calls.push("library"),
    recsUi: { invalidateRatings: () => {} }, syncAniListLibrary: async () => {},
    showAniListAutoStatus: () => {}, toast: () => {}, console: { warn() {} },
  });
  vm.runInContext(section("function authenticatedTitleAniList(", "\nasync function saveUserAniListScore("), context);
  vm.runInContext(section("async function saveUserAniListScore(", "\n// Authenticated AniList"), context);
  const subject = {
    catalogId: original.catalogId, seriesKey: original.key, kind: "anime",
    anilist: seriesAniList(original, 200),
  };
  await assert.rejects(context.saveUserAniListScore(subject, 1, 8.4), /multiple LVL seasons/);
  await assert.rejects(context.saveUserAniListScore(subject, 2, 9.1), /multiple LVL seasons/);
  assert.deepEqual(calls, [], "Neither season can stage or transmit an ambiguous AniList update");
});

test("an in-flight AniList score edit cannot write a formerly linked media ID after Library relink", async () => {
  let live = [seriesFor(200, 777)];
  const subject = { catalogId: live[0].catalogId, seriesKey: live[0].key,
    kind: "anime", anilist: seriesAniList(live[0], 200) };
  const account = { userId: 200, token: "mock-only" };
  const writes = [];
  let releasePreflight;
  const preflightGate = new Promise((resolve) => { releasePreflight = resolve; });
  let preflightStarted;
  const started = new Promise((resolve) => { preflightStarted = resolve; });
  const context = vm.createContext({
    localStorage: {}, anilistScoreSyncEnabled: () => true,
    anilistAutoDevTestRun: null, readAniListAccount: () => account,
    buildLibrarySeries: () => live, seriesAniList, resolveAniListScorePart,
    stageUnconfirmedAniListScore: () => {}, acknowledgeUnconfirmedAniListScore: () => writes.push("ack"),
    saveAniListScore,
    anilistGraphql: async (_token, query) => {
      if (query === ANILIST_SCORE_ENTRY_QUERY) {
        preflightStarted();
        await preflightGate;
        return { MediaList: { id: 88, mediaId: 777, scoreRaw: 85 } };
      }
      if (query === ANILIST_SCORE_SAVE) writes.push("mutation");
      throw new Error("Should not write a relinked anime");
    },
    anilistScoreRuns: new Map(), saveLibrary: () => writes.push("library"),
    recsUi: { invalidateRatings: () => {} }, syncAniListLibrary: async () => {},
    showAniListAutoStatus() {}, toast() {}, console: { warn() {} },
  });
  vm.runInContext(section("function authenticatedTitleAniList(", "\nasync function saveUserAniListScore("), context);
  vm.runInContext(section("async function saveUserAniListScore(", "\n// Authenticated AniList"), context);
  const edit = context.saveUserAniListScore(subject, 1, 9.2);
  await started;
  live = [seriesFor(200, 999)];
  releasePreflight();
  await assert.rejects(edit, /account changed/i);
  assert.deepEqual(writes, [], "No AniList score mutation or confirmation after an account-scoped mapping changes");
});
