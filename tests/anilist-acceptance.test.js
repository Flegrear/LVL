// Independent, deterministic AniList acceptance checks. No network, browser,
// account credentials, or real account mutations. Outstanding regressions are
// TODO so the existing test baseline stays green until the source is fixed.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

import { seriesAniList } from "../frontend/anilist/anilist-library.js";
import { resolveAniListEpisode, reconcileAniListProgressQueue, planAniListWatchSync } from "../frontend/anilist/anilist-watch-sync.js";
import { planAniListUnwatch } from "../frontend/anilist/anilist-unwatch.js";
import { resolveAniListScorePart, ANILIST_SCORE_SAVE, saveAniListScore } from "../frontend/anilist/anilist-score-sync.js";
import { matchPublicAniListSeasons, verifiedPublicAniListLinks } from "../frontend/catalog/title-public-ratings.js";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const part = (anilistId, season = 1) => ({ anilistId, season, format: "TV", episodes: 12,
  title: "Identical Title", status: "CURRENT", progress: 0, score: 7.5 });
const imported = (anilistId) => ({ showId: `anilist:${anilistId}`, seasons: [part(anilistId)] });

function foreignOwnedSeries() {
  return { key: "same display name", type: "series", catalogId: "tt1234567",
    sources: [{ id: "saved-video", anilist: imported(777),
      watchedChapters: { S01E01: 100 }, episodes: [] }] };
}

test("anonymous public AniList community scores never certify an authenticated write", () => {
  const root = { id: 777, format: "TV", episodes: 12, seasonYear: 2025,
    averageScore: 86, title: { english: "Identical Title", romaji: "Other Title" },
    synonyms: ["Another local alias"], relations: { edges: [] } };
  const match = matchPublicAniListSeasons({ media: [root], title: "Another local alias",
    year: 2025, seasons: [{ season: 1, count: 12 }], allowSynonyms: true });
  assert.equal(match.score, 8.6);
  assert.equal(match.displayOnly, true);
  assert.deepEqual(verifiedPublicAniListLinks(match,
    { userId: 200, year: 2025, catalogId: "tt1234567" }), []);
});

test("forward reconciliation never converts an unconfirmed hole into remote progress", () => {
  const rows = [3, 5].map((episode) => ({ mediaId: 777, episode, episodeCount: 12,
    code: `S01E${String(episode).padStart(2, "0")}`, seriesKey: "show" }));
  const plan = reconcileAniListProgressQueue({ completed: rows,
    remote: [{ anilistId: 777, progress: 1, episodes: 12, status: "CURRENT" }] });
  assert.deepEqual(plan.updates, []);
  assert.deepEqual(plan.queue.map((item) => item.episode), [3, 5]);
});

test("rollback of a middle episode needs explicit acknowledgment of every truncated later episode", () => {
  const mapped = { mediaId: 777, episode: 2, episodeCount: 12 };
  const remote = { id: 50, mediaId: 777, progress: 7, status: "COMPLETED", media: { episodes: 12 } };
  const change = planAniListUnwatch({ mapped, remote, accountId: 200 });
  assert.deepEqual({ target: change.progress, later: change.discardedFollowing, status: change.status },
    { target: 1, later: 5, status: "CURRENT" });
  assert.doesNotMatch(ANILIST_SCORE_SAVE, /\bprogress\b|\bstatus\b/,
    "score writes must remain independent from episode progress");
});

test("a local negative marker must fence every forward mutation for its mapped AniList media", () => {
  const series = { key: "show", type: "series", sources: [
    { watchedChapters: { S01E02: false }, anilistManualLinks: [
      { userId: 200, season: 1, anilistId: 777, format: "TV", episodes: 12 }] },
    { watchedChapters: { S01E06: 100, S01E07: 100 } },
  ] };
  const start = app.indexOf("function blockedAniListForwardMedia(");
  const end = app.indexOf("\nfunction verifiedAniListCreationKeys(", start);
  assert.ok(start > 0 && end > start, "Test actual app.js forward gate, not an imitation");
  const context = vm.createContext({ buildLibrarySeries: () => [series], seriesAniList, resolveAniListEpisode, Set, Number });
  vm.runInContext(app.slice(start, end), context);
  const blocked = vm.runInContext("blockedAniListForwardMedia(200)", context);
  assert.equal(blocked.has(777), true, "E2 unwatch must block uploading later E6/E7 on same media");
  assert.equal(blocked.has(999), false);
});

test("authenticated score mutation is restricted to an existing exact AniList entry", async () => {
  const sent = [];
  const graphql = async (_token, query, vars) => {
    sent.push({ query, vars });
    return { MediaList: null };
  };
  const account = { userId: 200, token: "synthetic-mock-only" };
  await assert.rejects(saveAniListScore({ account, mediaId: 777, score: 8.2,
    expectedRaw: 75, graphql }), /no verifiable AniList list entry/i);
  assert.equal(sent.length, 1, "No remote SaveMediaListEntry without verified existing list entry");
  assert.notEqual(sent[0].query, ANILIST_SCORE_SAVE);
});

test("new authenticated account must not inherit an old account's unscoped imported media mapping", () => {
  const series = foreignOwnedSeries();
  const forOtherAccount = seriesAniList(series, 200);
  assert.equal(forOtherAccount, null, "Legacy imported metadata lacks an owner and cannot authorize writes");
  // Current bug: seriesAniList returns the same unscoped imported record for every userId.
  const mapped = resolveAniListEpisode({ seasons: forOtherAccount?.seasons, episodeCode: "S01E01" });
  assert.equal(mapped, null);
});

test("current-account verified manual association must not be made ambiguous by foreign imported metadata", () => {
  const series = foreignOwnedSeries();
  series.sources[0].anilistManualLinks = [{ userId: 200, season: 1, anilistId: 888,
    format: "TV", episodes: 12, title: "Identical Title" }];
  const authenticated = seriesAniList(series, 200);
  assert.deepEqual(authenticated.seasons.map((item) => item.anilistId), [888]);
  assert.equal(resolveAniListEpisode({ seasons: authenticated.seasons, episodeCode: "S01E01" }).mediaId, 888);
  assert.equal(resolveAniListScorePart(authenticated, 1).anilistId, 888);
});

test("actual browser queue collector must not schedule foreign imported metadata for a newly connected account", () => {
  const series = foreignOwnedSeries();
  const start = app.indexOf("function gatherAniListWatchedQueue(");
  const end = app.indexOf("\nfunction blockedAniListForwardMedia(", start);
  assert.ok(start > 0 && end > start);
  const persisted = [];
  const context = vm.createContext({
    localStorage: {},
    readAniListPreference: () => ({ threshold: 80 }), anilistStoredQueue: () => [],
    readAniListAccount: () => ({ userId: 200 }), buildLibrarySeries: () => [series],
    seriesAniList, planAniListWatchSync, reconcileAniListProgressQueue,
    persistAniListQueue: (queue) => persisted.push(queue),
    chapterCode: (season, episode) => `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`,
  });
  vm.runInContext(app.slice(start, end), context);
  const actual = vm.runInContext("gatherAniListWatchedQueue()", context);
  assert.deepEqual(actual.queue, [], "No owner-validated AniList link exists for user 200");
  assert.ok(persisted.every((queue) => queue.length === 0), "Never persist foreign-owned writes in a new user's retry queue");
});

test("current account's remote progress must not be imported through another account's unscoped link", () => {
  const series = foreignOwnedSeries();
  const source = series.sources[0];
  source.watchedChapters = {};
  const start = app.indexOf("function applyAniListRemoteWatchHistory(");
  const end = app.indexOf("\nasync function syncAniListAuto(", start);
  assert.ok(start > 0 && end > start);
  let saves = 0;
  const state = { library: [source] };
  const context = vm.createContext({
    state, readAniListAccount: () => ({ userId: 200 }), buildLibrarySeries: () => [series],
    seriesAniList, resolveAniListEpisode, explicitlyUnwatchedChapter: () => false,
    saveLibrary: () => { saves++; }, $: () => null,
  });
  vm.runInContext(app.slice(start, end), context);
  const changed = vm.runInContext('applyAniListRemoteWatchHistory(new Map([[777, { mediaId: 777, progress: 3, status: "CURRENT" }]]), 200)', context);
  assert.equal(changed, false, "A fresh remote list alone does not establish ownership of the old local association");
  assert.deepEqual(source.watchedChapters, {});
  assert.equal(saves, 0);
});
