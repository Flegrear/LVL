import test from "node:test";
import assert from "node:assert/strict";
import { ANILIST_PENDING_SCORES_KEY, ANILIST_SCORE_ENTRY_QUERY, ANILIST_SCORE_SAVE, acknowledgeUnconfirmedAniListScore, planMissingAniListScores, readUnconfirmedAniListScore, scoreRaw, resolveAniListScorePart, saveAniListScore, stageUnconfirmedAniListScore } from "../frontend/anilist/anilist-score-sync.js";

const account = { userId: 42, token: "synthetic-test-only" };

function fixture({ remote = 75, mediaId = 123, fail = null, changedBy = 0 } = {}) {
  const calls = [];
  const entry = { id: 918, mediaId, scoreRaw: remote, status: "COMPLETED", progress: 12 };
  const graphql = async (token, query, vars) => {
    assert.equal(token, account.token);
    calls.push({ query, vars });
    if (fail === "network") throw new Error("Unavailable");
    if (query === ANILIST_SCORE_ENTRY_QUERY) {
      if (changedBy) entry.scoreRaw = changedBy;
      return { MediaList: { ...entry } };
    }
    if (query === ANILIST_SCORE_SAVE) {
      assert.deepEqual({ ...vars }, { id: 918, scoreRaw: 76 });
      entry.scoreRaw = vars.scoreRaw;
      return { SaveMediaListEntry: { ...entry } };
    }
    throw new Error("Unexpected GraphQL operation");
  };
  return { calls, entry, graphql };
}

test("Optional AniList scores are fixed 0–100 raw; local hundredths round to tenths", () => {
  assert.equal(scoreRaw(7.56), 76);
  assert.equal(scoreRaw(9.95), 100);
  assert.equal(scoreRaw(1), 10);
  assert.equal(scoreRaw(null), 0);
  for (const bad of [0, NaN, Infinity, 10.2, -2, "7.5", undefined]) assert.equal(scoreRaw(bad), null);
  assert.match(ANILIST_SCORE_ENTRY_QUERY, /MediaList\(userId: \$userId, mediaId: \$mediaId\)/);
  assert.match(ANILIST_SCORE_SAVE, /SaveMediaListEntry\(id: \$id, scoreRaw: \$scoreRaw\)/);
  assert.doesNotMatch(ANILIST_SCORE_SAVE, /\bprogress\b|\bstatus\b|mediaId\s*:/,
    "Score writes must never touch progress/status or create a new list entry by mediaId");
});

test("Only a unique, explicit AniList season may be rated; ambiguous split-cour or multi-season overall blocks", () => {
  const info = { seasons: [
    { anilistId: 12, season: 1, score: 6 },
    { anilistId: 13, season: 2, score: 7 },
  ] };
  assert.equal(resolveAniListScorePart(info, null), null);
  assert.equal(resolveAniListScorePart(info, 1)?.anilistId, 12);
  assert.equal(resolveAniListScorePart(info, 2)?.anilistId, 13);
  assert.equal(resolveAniListScorePart({ seasons: [info.seasons[0]] }, null)?.anilistId, 12);
  assert.equal(resolveAniListScorePart({ seasons: [{ ...info.seasons[0] }, { ...info.seasons[0], anilistId: 15 }] }, 1), null);
  assert.equal(resolveAniListScorePart({ seasons: [] }, null), null);
});

test("Bulk local-only score backfill requires account-listed unscored parts and rejects shared media destinations", () => {
  const part = (anilistId, score = null) => ({ anilistId, season: 1, status: "CURRENT", progress: 0, score });
  const plan = planMissingAniListScores([
    { seriesKey: "frieren", season: 1, score: 9.56, part: part(10) },
    { seriesKey: "frieren", season: 1, score: 9.56, part: part(10) }, // identical duplicate is harmless
    { seriesKey: "show-a", season: 1, score: 8, part: part(11) },
    { seriesKey: "show-b", season: 1, score: 9, part: part(11) }, // collision, never choose first
    { seriesKey: "watched", season: 1, score: 9, part: part(12, 7) }, // remote already has a score
    { seriesKey: "unlisted", season: 1, score: 8, part: { anilistId: 13, score: null, status: null, progress: null } },
    { seriesKey: "unsure", season: 1, score: 7, part: null },
  ]);
  assert.deepEqual(plan.updates, [{ seriesKey: "frieren", season: 1, mediaId: 10, score: 9.56, expectedRaw: 0 }]);
  assert.deepEqual(plan.skipped.map((row) => row.reason).sort(), ["already-scored", "ambiguous", "unverified", "unverified"]);
  assert.deepEqual(planMissingAniListScores([
    { seriesKey: "one", season: 1, score: 8, part: part(20) },
    { seriesKey: "two", season: 1, score: 8, part: part(20) },
  ]).updates, [], "Even equal scores cannot authorize two different Library titles linked to one media ID");
  assert.equal(planMissingAniListScores([
    { seriesKey: "a", season: 1, score: 8, part: part(21) },
    { seriesKey: "b", season: 1, score: 9, part: part(22) },
  ], { limit: 1 }).updates.length, 1);
});

test("Score update checks the current remote baseline, sends scoreRaw only, and verifies response plus readback", async () => {
  const f = fixture();
  const result = await saveAniListScore({ account, mediaId: 123, score: 7.56, expectedRaw: 75, graphql: f.graphql });
  assert.deepEqual(result, { mediaId: 123, scoreRaw: 76, unchanged: false });
  assert.equal(f.entry.progress, 12);
  assert.equal(f.entry.status, "COMPLETED");
  assert.equal(f.calls.length, 3, "Fresh prewrite read, mutation, and confirmation read");
  assert.ok(f.calls.every(({ vars }) => !JSON.stringify(vars).includes(account.token)), "Never place credentials in GraphQL variables");
});

test("Changing score elsewhere causes conflict rather than overwriting; matching desired remote skips write", async () => {
  const f = fixture({ remote: 80 });
  await assert.rejects(saveAniListScore({ account, mediaId: 123, score: 7.56, expectedRaw: 75, graphql: f.graphql }), /changed elsewhere/);
  assert.equal(f.calls.filter((c) => c.query === ANILIST_SCORE_SAVE).length, 0);
  const g = fixture({ remote: 76 });
  const result = await saveAniListScore({ account, mediaId: 123, score: 7.56, expectedRaw: 75, graphql: g.graphql });
  assert.equal(result.unchanged, true);
  assert.equal(g.calls.filter((c) => c.query === ANILIST_SCORE_SAVE).length, 0);
});

test("Clear score writes raw zero on existing entry, never deletes it", async () => {
  const updates = [];
  let current = 50;
  const gql = async (_token, query, variables) => {
    if (query === ANILIST_SCORE_ENTRY_QUERY) return { MediaList: { id: 22, mediaId: 123, scoreRaw: current } };
    updates.push(variables);
    current = variables.scoreRaw;
    return { SaveMediaListEntry: { id: 22, mediaId: 123, scoreRaw: 0 } };
  };
  await saveAniListScore({ account, mediaId: 123, score: null, expectedRaw: 50, graphql: gql });
  assert.deepEqual(updates, [{ id: 22, scoreRaw: 0 }]);
});

test("Offline, missing entries, invalid baseline, and account switching never write", async () => {
  const f = fixture({ fail: "network" });
  await assert.rejects(saveAniListScore({ account, mediaId: 123, score: 7.56, expectedRaw: 75, graphql: f.graphql }), /Unavailable/);
  assert.equal(f.calls.length, 1);
  for (const remote of [null, { id: 918, mediaId: 123, scoreRaw: null }, { id: 999, mediaId: 900, scoreRaw: 75 }]) {
    let calls = 0;
    await assert.rejects(saveAniListScore({ account, mediaId: 123, score: 7.56, expectedRaw: 75, graphql: async () => { calls++; return { MediaList: remote }; } }), /no verifiable/);
    assert.equal(calls, 1);
  }
  const g = fixture();
  await assert.rejects(saveAniListScore({ account, mediaId: 123, score: 7.56, expectedRaw: 75, graphql: g.graphql, stillConnected: () => false }), /account changed/);
  assert.equal(g.calls.length, 0);
  let active = true;
  const h = fixture();
  await assert.rejects(saveAniListScore({ account, mediaId: 123, score: 7.56, expectedRaw: 75,
    stillConnected: () => active, graphql: async (...args) => { const value = await h.graphql(...args); active = false; return value; } }), /account changed/);
  assert.equal(h.calls.length, 1);
});

test("Failed or conflicting score writes retain account-scoped local changes for explicit retry", async () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  stageUnconfirmedAniListScore(storage, 42, 123, 7.56, 100);
  const conflict = fixture({ remote: 81 });
  await assert.rejects(saveAniListScore({ account, mediaId: 123, score: 7.56, expectedRaw: 75, graphql: conflict.graphql }), /changed elsewhere/);
  assert.deepEqual(readUnconfirmedAniListScore(storage, 42, 123), { score: 7.56, updatedAt: 100 });
  assert.equal(readUnconfirmedAniListScore(storage, 99, 123), null, "Another account must not see this score");
  assert.equal(readUnconfirmedAniListScore(storage, 42, 999), null, "Another anime must not see this score");
  assert.equal(values.get(ANILIST_PENDING_SCORES_KEY).includes(account.token), false, "No tokens stored with pending edits");

  // Rapid edits: acknowledging the first response must not lose the newer edit.
  stageUnconfirmedAniListScore(storage, 42, 123, 8.15, 101);
  assert.equal(acknowledgeUnconfirmedAniListScore(storage, 42, 123, 7.56), false);
  assert.equal(readUnconfirmedAniListScore(storage, 42, 123).score, 8.15);
  assert.equal(acknowledgeUnconfirmedAniListScore(storage, 42, 123, 8.15), true);
  assert.equal(readUnconfirmedAniListScore(storage, 42, 123), null);
});

test("Cleared scores remain unconfirmed as null, and corrupt pending storage never authorizes a write", () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  values.set(ANILIST_PENDING_SCORES_KEY, "invalid-json");
  assert.equal(readUnconfirmedAniListScore(storage, 42, 123), null);
  stageUnconfirmedAniListScore(storage, 42, 123, null, 200);
  assert.deepEqual(readUnconfirmedAniListScore(storage, 42, 123), { score: null, updatedAt: 200 });
  assert.equal(acknowledgeUnconfirmedAniListScore(storage, 42, 123, 7), false);
  assert.equal(acknowledgeUnconfirmedAniListScore(storage, 42, 123, null), true);
  assert.throws(() => stageUnconfirmedAniListScore(storage, 42, 123, 0), /unmatched/);
  assert.throws(() => stageUnconfirmedAniListScore(storage, 42, -1, 7), /unmatched/);
});

test("An account change after mutation is reported as unconfirmed, never misreported as no write", async () => {
  let connected = true;
  const f = fixture();
  const graphql = async (...args) => {
    const result = await f.graphql(...args);
    if (args[1] === ANILIST_SCORE_SAVE) connected = false;
    return result;
  };
  await assert.rejects(saveAniListScore({ account, mediaId: 123, score: 7.56, expectedRaw: 75,
    graphql, stillConnected: () => connected }), /may have been sent/);
  assert.equal(f.entry.scoreRaw, 76, "The mock remote was already changed; outcome must not claim the write never happened");
});
