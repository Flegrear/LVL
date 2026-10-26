import test from "node:test";
import assert from "node:assert/strict";
import { anilistInfo } from "../frontend/anilist/anilist-library.js";
import {
  parseAniListEpisodeCode, resolveAniListEpisode, reconcileAniListProgressQueue, planAniListWatchSync,
} from "../frontend/anilist/anilist-watch-sync.js";

const tv = (anilistId, season, episodes, title = `Season ${season}`) => ({
  anilistId, season, episodes, title, format: "TV", progress: 0, status: "PLANNING", score: 9.5,
});
const info = (seasons) => anilistInfo({ showId: "anilist:101", seasons });
const mark = (mediaId, code, episode, episodeCount, seriesKey = "some show") => ({
  mediaId, code, episode, episodeCount, seriesKey,
});
const remote = (id, progress, status = "CURRENT", score = 10) => ({
  anilistId: id, progress, status, score, userRating: 4.5,
});

test("strict chapter codes reject specials, missing episode, and non-video identifiers", () => {
  assert.deepEqual(parseAniListEpisodeCode("s01e03"), { code: "S01E03", season: 1, episode: 3 });
  for (const value of ["S00E01", "S01E00", "S1E01", "S01E1", "S01E01-E02", "movie", "S01E01junk", "S01E0"]) {
    assert.equal(parseAniListEpisodeCode(value), null, String(value));
  }
});

test("single exact TV/ONA season resolves per-season numbering, not cumulative episodes", () => {
  const seasons = info([tv(101, 1, 12), tv(102, 2, 13)]).seasons;
  assert.deepEqual(resolveAniListEpisode({ seasons, episodeCode: "S02E13" }), {
    mediaId: 102, episode: 13, episodeCount: 13, code: "S02E13", season: 2,
  });
  assert.equal(resolveAniListEpisode({ seasons, episodeCode: "S02E14" }), null);
  assert.equal(resolveAniListEpisode({ seasons, episodeCode: "S03E01" }), null);
  assert.equal(resolveAniListEpisode({ seasons, episodeCode: "S01E01", type: "movie" }), null);
  assert.equal(resolveAniListEpisode({ seasons, episodeCode: "S00E01" }), null);
  const ona = [{ ...tv(111, 1, 8), format: "ONA" }];
  assert.equal(resolveAniListEpisode({ seasons: ona, episodeCode: "S01E08" }).mediaId, 111);
});

test("split cours and standalone later parts are never silently mapped to the wrong AniList entry", () => {
  const seasons = info([
    tv(100, 1, 25, "Titan"),
    tv(200, 2, 12, "Titan Season 2"),
    tv(201, 2, 12, "Titan Season 2 Part 2"),
    { ...tv(401, null, 3, "Lost Girls"), format: "OVA" },
    { ...tv(402, null, 1, "Movie"), format: "MOVIE" },
  ]).seasons;
  for (const code of ["S02E01", "S02E10", "S02E13", "S02E24", "S02E25"]) {
    assert.equal(resolveAniListEpisode({ seasons, episodeCode: code }), null, code);
  }
  assert.equal(resolveAniListEpisode({ seasons: [tv(201, 2, 12, "Titan Season 2 Part 2")], episodeCode: "S02E01" }), null,
    "a list containing only Part 2 does not make it S02E01");
  assert.equal(resolveAniListEpisode({ seasons: [tv(301, 1, null)], episodeCode: "S01E01" }), null);
  assert.equal(resolveAniListEpisode({ seasons: [{ ...tv(301, 1, 12), format: "OVA" }], episodeCode: "S01E01" }), null);
  assert.equal(resolveAniListEpisode({ seasons: [{ ...tv(301, 1, 12), format: "MOVIE" }], episodeCode: "S01E01" }), null);
  assert.equal(resolveAniListEpisode({ seasons: [tv(301, 1, 12), tv(301, 1, 12)], episodeCode: "S01E01" }), null);
});

test("explicit fully verified split ranges map correct part and episode offsets", () => {
  const seasons = [tv(200, 2, 12), tv(201, 2, 12, "Season 2 Part 2")];
  const ranges = [
    { anilistId: 200, season: 2, start: 1, end: 12 },
    { anilistId: 201, season: 2, start: 13, end: 24 },
  ];
  assert.deepEqual(resolveAniListEpisode({ seasons, episodeCode: "S02E16", ranges }), {
    mediaId: 201, episode: 4, episodeCount: 12, code: "S02E16", season: 2,
  });
  assert.equal(resolveAniListEpisode({ seasons, episodeCode: "S02E25", ranges }), null);
  for (const bad of [
    ranges.slice(0, 1),
    [ranges[0], { ...ranges[1], start: 12, end: 23 }],
    [ranges[0], { ...ranges[1], start: 13, end: 25 }],
    [ranges[0], { ...ranges[1], anilistId: 200 }],
  ]) {
    assert.equal(resolveAniListEpisode({ seasons, episodeCode: "S02E16", ranges: bad }), null);
  }
  assert.equal(resolveAniListEpisode({ seasons: [tv(201, 2, 12, "Season 2 Part 2")], episodeCode: "S02E16",
    ranges: [ranges[1]] }).episode, 4, "an explicit bounded part alone is safe");
});

test("queue reconciliation advances only through contiguous watched episodes from verified remote progress", () => {
  const result = reconcileAniListProgressQueue({
    completed: [mark(200, "S02E04", 4, 12), mark(200, "S02E06", 6, 12), mark(200, "S02E05", 5, 12)],
    remote: [remote(200, 3)],
  });
  assert.deepEqual(result.updates, [{ mediaId: 200, progress: 6 }]);
  assert.deepEqual(result.queue.map((row) => row.code).sort(), ["S02E04", "S02E05", "S02E06"]);
  const confirmed = reconcileAniListProgressQueue({ queue: result.queue, remote: [remote(200, 6)] });
  assert.deepEqual(confirmed.queue, [], "remote confirmation, not optimistic send, acknowledges local completions");
  assert.deepEqual(confirmed.updates, []);
});

test("one high-number episode cannot imply missing earlier episodes were watched", () => {
  const result = reconcileAniListProgressQueue({
    completed: [mark(10, "S01E03", 3, 12), mark(10, "S01E05", 5, 12)],
    remote: [remote(10, 0)],
  });
  assert.deepEqual(result.updates, []);
  assert.equal(result.queue.length, 2, "keep distinct completed episodes for later reconciliation");
  const ahead = reconcileAniListProgressQueue({ queue: result.queue, remote: [remote(10, 4)] });
  assert.deepEqual(ahead.updates, [{ mediaId: 10, progress: 5 }]);
  assert.deepEqual(ahead.queue.map((item) => item.code), ["S01E05"]);
});

test("ahead or completed remote state never decreases progress, changes score, or duplicates updates", () => {
  const record = remote(101, 9, "COMPLETED", 9.7);
  const rows = [mark(101, "S01E07", 7, 12), mark(101, "S01E08", 8, 12)];
  const before = structuredClone(record);
  assert.deepEqual(reconcileAniListProgressQueue({ completed: rows, remote: [record], allowStatusUpdates: true }),
    { queue: [], updates: [] });
  assert.deepEqual(record, before, "never mutate remote ratings or status");
  const duplicate = reconcileAniListProgressQueue({
    queue: [mark(101, "S01E10", 10, 12), mark(101, "S01E10", 10, 12)],
    completed: [mark(101, "S01E10", 10, 12), mark(101, "S01E11", 11, 12)],
    remote: [record],
  });
  assert.equal(duplicate.queue.length, 2);
  assert.deepEqual(duplicate.updates, [{ mediaId: 101, progress: 11 }]);
  assert.ok(!("score" in duplicate.updates[0]));
  assert.ok(!("status" in duplicate.updates[0]));
});

test("offline/unknown remote progress never means zero and keeps separate queued episodes", () => {
  const queue = [mark(7, "S01E01", 1, 10), mark(7, "S01E03", 3, 10)];
  for (const offline of [null, [], [{ anilistId: 7, status: "CURRENT" }]]) {
    const result = reconcileAniListProgressQueue({ queue, remote: offline });
    assert.deepEqual(result.updates, []);
    assert.equal(result.queue.length, 2);
    assert.notEqual(result.queue[0], queue[0], "reconciliation does not mutate the queued object");
  }
  assert.deepEqual(queue, [mark(7, "S01E01", 1, 10), mark(7, "S01E03", 3, 10)]);
  const backOnline = reconcileAniListProgressQueue({ queue, remote: { 7: { progress: 0, status: "CURRENT" } } });
  assert.deepEqual(backOnline.updates, [{ mediaId: 7, progress: 1 }]);
  assert.equal(backOnline.queue.length, 2);
});

test("invalid or missing remote progress blocks every write while preserving queued completions", () => {
  const row = mark(100, "S01E01", 1, 12, "frieren");
  for (const value of [null, undefined, "0", -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, {}]) {
    const result = reconcileAniListProgressQueue({
      queue: [row],
      remote: [{ anilistId: 100, progress: value, status: "CURRENT", episodes: 12 }],
      allowStatusUpdates: true,
    });
    assert.deepEqual(result.updates, [], `Unsafe progress ${String(value)} must never cause AniList writes`);
    assert.deepEqual(result.queue, [row], "Offline/invalid progress cannot acknowledge a pending episode");
  }
  const unsafeFlag = reconcileAniListProgressQueue({
    queue: [row],
    remote: [{ anilistId: 100, progress: 0, progressKnown: false, episodes: 12 }],
  });
  assert.deepEqual(unsafeFlag.updates, []);
  assert.deepEqual(unsafeFlag.queue, [row]);
});

test("authoritative remote episode total mismatch blocks both status and progress updates", () => {
  const queue = Array.from({ length: 12 }, (_, index) => mark(100, `S01E${String(index + 1).padStart(2, "0")}`, index + 1, 12));
  const result = reconcileAniListProgressQueue({
    queue, remote: [{ anilistId: 100, progress: 0, status: "CURRENT", episodes: 24 }],
    allowStatusUpdates: true,
  });
  assert.deepEqual(result.updates, [], "A 12-episode local season must not complete a 24-episode AniList media");
  assert.equal(result.queue.length, 12, "Known mapping mismatch cannot acknowledge or drop local completions");
  const ahead = reconcileAniListProgressQueue({
    queue, remote: [{ anilistId: 100, progress: 12, status: "CURRENT", episodes: 24 }],
    allowStatusUpdates: true,
  });
  assert.deepEqual(ahead.updates, []);
  assert.equal(ahead.queue.length, 12, "Mismatched remote counts must not silently clear queued entries");
});

test("unknown authoritative episode total cannot send COMPLETED, but verified progress can advance", () => {
  const two = mark(100, "S01E02", 2, 2);
  const unknowns = [null, undefined, 0, -1, "2", 1.5, Number.NaN];
  for (const episodes of unknowns) {
    const plan = reconcileAniListProgressQueue({
      queue: [two], remote: [{ anilistId: 100, progress: 1, episodes, status: "CURRENT" }],
      allowStatusUpdates: true,
    });
    assert.deepEqual(plan.updates, [{ mediaId: 100, progress: 2 }],
      `Unknown remote episode total ${String(episodes)} cannot signal completed`);
  }
  const verified = reconcileAniListProgressQueue({
    queue: [two], remote: [{ anilistId: 100, progress: 1, episodes: 2, status: "CURRENT" }],
    allowStatusUpdates: true,
  });
  assert.deepEqual(verified.updates, [{ mediaId: 100, progress: 2, status: "COMPLETED" }]);
});

test("no remote score/status writes; optional status transitions only for safe current/completed", () => {
  const q = [mark(9, "S01E02", 2, 2)];
  for (const status of ["PAUSED", "DROPPED", "REPEATING", "COMPLETED"]) {
    const plan = reconcileAniListProgressQueue({ queue: q, remote: [remote(9, 1, status)], allowStatusUpdates: true });
    assert.deepEqual(plan.updates, [{ mediaId: 9, progress: 2 }], `preserve ${status}`);
  }
  const current = reconcileAniListProgressQueue({ queue: q, remote: [{ ...remote(9, 1, "CURRENT"), episodes: 2 }], allowStatusUpdates: true });
  assert.deepEqual(current.updates, [{ mediaId: 9, progress: 2, status: "COMPLETED" }]);
  const planning = reconcileAniListProgressQueue({
    queue: [mark(9, "S01E01", 1, 2)], remote: [remote(9, 0, "PLANNING")], allowStatusUpdates: true,
  });
  assert.deepEqual(planning.updates, [{ mediaId: 9, progress: 1, status: "CURRENT" }]);
});

test("conflicting old mappings block both media writes without throwing away queued local episodes", () => {
  const result = reconcileAniListProgressQueue({
    queue: [mark(200, "S02E01", 1, 12, "titan")],
    completed: [mark(201, "S02E01", 1, 12, "titan")],
    remote: [remote(200, 0), remote(201, 0)],
  });
  assert.deepEqual(result.updates, []);
  assert.equal(result.queue.length, 2, "both conflicting queued mappings remain visible");
  const sameMediaDifferentOffset = reconcileAniListProgressQueue({
    queue: [mark(200, "S02E01", 1, 12, "titan")],
    completed: [mark(200, "S02E01", 2, 12, "titan")],
    remote: [remote(200, 0)],
  });
  assert.deepEqual(sameMediaDifferentOffset.updates, []);
  assert.equal(sameMediaDifferentOffset.queue.length, 2);
  const duplicateRemote = reconcileAniListProgressQueue({
    queue: [mark(200, "S02E01", 1, 12, "titan")],
    remote: [remote(200, 0), remote(200, 0), remote(200, 0)],
  });
  assert.deepEqual(duplicateRemote.updates, [], "duplicate remote rows are not a trustworthy progress snapshot");
  assert.equal(duplicateRemote.queue.length, 1);
});

test("planner merges manual marks, source completions and queued retries, not partial progress", () => {
  const seasons = info([tv(101, 1, 4), tv(102, 2, 10)]).seasons;
  const result = planAniListWatchSync({
    seasons, seriesKey: "frieren",
    episodes: [
      { code: "S01E01", progress: { finished: true } },
      { code: "S01E02", progress: { finished: false } },
      { code: "S01E01", progress: { finished: true } },
      { code: "S02E02", progress: { finished: true } },
    ],
    watchedChapters: { S01E02: 1234, S02E01: 1235, S00E01: 1236 },
    queue: [mark(101, "S01E03", 3, 4, "frieren")],
    remote: [remote(101, 0), remote(102, 0)],
  });
  assert.deepEqual(result.updates, [{ mediaId: 101, progress: 3 }, { mediaId: 102, progress: 2 }]);
  assert.deepEqual(result.unmapped, ["S00E01"]);
  assert.deepEqual(result.blockedQueue, []);
  assert.equal(result.queue.length, 5, "episode codes are deduped but distinct watched chapters remain");
});

test("planner validates old queued mappings against current series and holds another series' queue", () => {
  const seasons = [tv(201, 2, 12)];
  const mismapped = mark(200, "S02E01", 1, 12, "titan");
  const otherSeries = mark(999, "S01E02", 2, 8, "other show");
  const legitimate = mark(201, "S02E01", 1, 12, "titan");
  const plan = planAniListWatchSync({
    seasons,
    seriesKey: "titan",
    episodes: [{ code: "S02E01", finished: true }],
    queue: [mismapped, otherSeries, legitimate],
    remote: [remote(200, 0), remote(201, 0), remote(999, 1)],
  });
  assert.deepEqual(plan.updates, [{ mediaId: 201, progress: 1 }], "cannot update old or unrelated media IDs");
  assert.deepEqual(plan.blockedQueue, [mismapped, otherSeries]);
  assert.equal(plan.queue.length, 3, "blocked queue is preserved for later reconciliation");
  assert.notEqual(plan.blockedQueue[0], mismapped);
});

test("planner cannot sync movies, specials, ambiguously split seasons or unknown metadata", () => {
  const seasons = [tv(200, 2, 12), tv(201, 2, 12, "Season 2 Part 2")];
  for (const scenario of [
    { type: "movie", seasons: [tv(500, 1, 1)], episodes: [{ code: "S01E01", finished: true }] },
    { seasons, episodes: [{ code: "S02E14", finished: true }] },
    { seasons: [], episodes: [{ code: "S02E01", finished: true }] },
  ]) {
    const result = planAniListWatchSync({ remote: [remote(200, 0), remote(500, 0)], ...scenario });
    assert.deepEqual(result.updates, []);
    assert.equal(result.queue.length, 0);
    assert.equal(result.unmapped.length, 1);
  }
});

test("never-watched anime safely queues episodes 1, 2, 3 and retains each until remote confirmation", () => {
  const mediaId = 7701;
  const seasons = [tv(mediaId, 1, 12, "Never Watched")];
  const watchedChapters = {};
  const savedProgress = { anilistId: mediaId, progress: 0, status: "PLANNING", episodes: null };
  let queue = [];
  // The initial zero here is a MOCK of explicitly verified absence in a complete
  // user list. It is NOT a fallback for an unavailable/failed AniList request.
  assert.deepEqual(reconcileAniListProgressQueue({
    queue: [mark(mediaId, "S01E01", 1, 12, "never-watched")], remote: null,
  }).updates, [], "unknown/offline must not be mistaken for never-watched");

  for (const episode of [1, 2, 3]) {
    watchedChapters[`S01E0${episode}`] = episode;
    const originalQueue = structuredClone(queue);
    const plan = planAniListWatchSync({
      seasons, seriesKey: "never-watched", watchedChapters,
      queue, remote: [savedProgress], allowStatusUpdates: true,
    });
    assert.deepEqual(plan.unmapped, []);
    assert.deepEqual(plan.blockedQueue, []);
    assert.deepEqual(plan.updates, [{
      mediaId, progress: episode, ...(episode === 1 ? { status: "CURRENT" } : {}),
    }], "only verified, contiguous new progress is sent");
    assert.equal(plan.queue.length, 1, "do not acknowledge an episode before SaveMediaListEntry confirms it");
    assert.deepEqual(queue, originalQueue, "pure planner cannot silently mutate the caller's saved queue");
    assert.deepEqual(reconcileAniListProgressQueue({
      queue: plan.queue, remote: [savedProgress],
    }).queue, plan.queue, "a lost or rejected mutation preserves the retry");

    // Simulate the provider's successful read-after-write confirmation.
    savedProgress.progress = episode;
    savedProgress.status = "CURRENT";
    savedProgress.episodes = 12;
    const acknowledged = reconcileAniListProgressQueue({ queue: plan.queue, remote: [savedProgress] });
    assert.deepEqual(acknowledged.updates, []);
    assert.deepEqual(acknowledged.queue, [], "verified remote progress safely clears the pending queue");
    queue = acknowledged.queue;
  }
  assert.equal(savedProgress.progress, 3);
  assert.equal(savedProgress.status, "CURRENT", "3 of 12 episodes must not complete the show");
});

test("ordinary watched sync never resets progress; deleting a list entry is different from clearing the local queue", () => {
  const mediaId = 7702;
  const seasons = [tv(mediaId, 1, 12, "Reset Is Not Delete")];
  const completed = mark(mediaId, "S01E01", 1, 12, "reset-is-not-delete");
  const remoteAtThree = [{ anilistId: mediaId, progress: 3, status: "CURRENT", episodes: 12 }];
  const olderLocal = reconcileAniListProgressQueue({
    completed: [completed], remote: remoteAtThree, allowStatusUpdates: true,
  });
  assert.deepEqual(olderLocal, { queue: [], updates: [] },
    "a local watched count of 1 cannot lower remote progress 3 to 1 or 0");

  const cleanedLocal = planAniListWatchSync({
    seasons, seriesKey: "reset-is-not-delete", episodes: [], watchedChapters: {},
    queue: [], remote: remoteAtThree, allowStatusUpdates: true,
  });
  assert.deepEqual(cleanedLocal.queue, []);
  assert.deepEqual(cleanedLocal.updates, [], "removing LVL watch markers never requests an AniList reset");

  // A separate remote DELETE would make the entry absent from the next list.
  // This pure planner has no DeleteMediaListEntry operation, and does not infer
  // an intentional deletion or execute a remote mutation.
  const afterExternalDelete = planAniListWatchSync({
    seasons, seriesKey: "reset-is-not-delete",
    watchedChapters: {}, queue: [], remote: [],
  });
  assert.deepEqual(afterExternalDelete.queue, []);
  assert.deepEqual(afterExternalDelete.updates, [], "empty local state cannot recreate an intentionally deleted entry");

  const staleLocalAfterDelete = planAniListWatchSync({
    seasons, seriesKey: "reset-is-not-delete",
    watchedChapters: { S01E01: 1 }, queue: [], remote: [],
  });
  assert.equal(staleLocalAfterDelete.updates.length, 0,
    "without verified zero there is no write, even with retained local marks");
  assert.equal(staleLocalAfterDelete.queue.length, 1,
    "old local completions remain eligible if a caller later synthesizes verified absence");
  assert.deepEqual(reconcileAniListProgressQueue({
    queue: staleLocalAfterDelete.queue,
    remote: [{ anilistId: mediaId, progress: 0, status: "PLANNING", episodes: null }],
  }).updates, [{ mediaId, progress: 1 }],
  "GAP: a caller that synthesizes zero from verified absence can recreate the entry unless local marks/queue are cleared");
});
