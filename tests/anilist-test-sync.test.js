import test from "node:test";
import assert from "node:assert/strict";
import {
  ANILIST_SMOKE_CANDIDATES, ANILIST_SMOKE_ADVANCE, ANILIST_SMOKE_DELETE,
  runAniListReversibleSmoke,
} from "../frontend/anilist/anilist-test-sync.js";
import { ANILIST_LIST_QUERY, ANILIST_SINGLE_PROGRESS_QUERY, ANILIST_SAVE_PROGRESS } from "../frontend/anilist/anilist-auto-client.js";

const account = { token: "synthetic-mock-only", userId: 77, username: "viewer" };

function fixture({ existing = false, failOnAdvance = false, externalEditAtCleanup = false } = {}) {
  const actions = [];
  const entries = new Map();
  if (existing) entries.set(101, { id: 987, mediaId: 101, progress: 4, status: "CURRENT", media: { episodes: 12 } });
  let lookups = 0;
  const graphql = async (token, query, variables = {}) => {
    assert.equal(token, account.token);
    assert.doesNotMatch(JSON.stringify(variables), /synthetic-mock-only/, "Bearer never enters mutation variables");
    actions.push({ query, variables: structuredClone(variables) });
    if (query === ANILIST_LIST_QUERY) return { Viewer: { id: 77 }, MediaListCollection: { lists: [{ entries: [
      ...(existing ? [{ ...entries.get(101) }] : [{ mediaId: 101, progress: 6, status: "CURRENT", media: { episodes: 12 } }]),
    ] }] } };
    if (query === ANILIST_SMOKE_CANDIDATES) return { Page: { media: [
      { id: 101, episodes: 12, title: { english: "Already listed" } },
      { id: 202, episodes: 12, title: { english: "Unlisted Test" } },
    ] } };
    if (query === ANILIST_SINGLE_PROGRESS_QUERY) {
      lookups++;
      const row = entries.get(variables.mediaId);
      if (externalEditAtCleanup && lookups === 5 && row) {
        row.status = "PAUSED"; // Another client edited the item; test must NOT delete it.
      }
      return { MediaList: row ? { ...row } : null };
    }
    if (query === ANILIST_SAVE_PROGRESS) {
      assert.deepEqual({ ...variables }, { mediaId: 202, progress: 1, status: "CURRENT" });
      const row = { id: 900, mediaId: 202, progress: 1, status: "CURRENT", media: { episodes: 12 } };
      entries.set(202, row);
      return { SaveMediaListEntry: { ...row } };
    }
    if (query === ANILIST_SMOKE_ADVANCE) {
      assert.equal(variables.id, 900);
      if (failOnAdvance && variables.progress === 2) throw new Error("Mock temporary outage");
      const row = entries.get(202);
      row.progress = variables.progress;
      return { SaveMediaListEntry: { ...row } };
    }
    if (query === ANILIST_SMOKE_DELETE) {
      assert.equal(variables.id, 900, "Only the new list-entry ID may be deleted");
      entries.delete(202);
      return { DeleteMediaListEntry: { deleted: true } };
    }
    throw new Error("Unexpected mock query");
  };
  return { graphql, actions, entries };
}

test("Browser-only smoke test creates an absent anime, advances three chapters and deletes only its own list entry", async () => {
  const f = fixture({ existing: true });
  const steps = [];
  const result = await runAniListReversibleSmoke({ account, graphql: f.graphql, onStep: (message) => steps.push(message) });
  assert.deepEqual(result, { mediaId: 202, name: "Unlisted Test", episodesTested: 3, deleted: true });
  assert.deepEqual([...f.entries.keys()], [101], "Never delete a pre-existing anime");
  assert.equal(f.entries.get(101).progress, 4);
  assert.deepEqual(f.actions.filter((action) => action.query === ANILIST_SMOKE_ADVANCE).map((action) => action.variables.progress), [2, 3]);
  assert.equal(f.actions.filter((action) => action.query === ANILIST_SMOKE_DELETE).length, 1);
  assert.ok(steps.at(-1).includes("temporary entry removed"));
});

test("If advancing fails, the test still removes its newly created entry", async () => {
  const f = fixture({ failOnAdvance: true });
  await assert.rejects(() => runAniListReversibleSmoke({ account, graphql: f.graphql }), /Mock temporary outage/);
  assert.equal(f.entries.has(202), false, "Rollback must occur even after an intermediate write failure");
  assert.equal(f.actions.filter((action) => action.query === ANILIST_SMOKE_DELETE).length, 1);
});

test("Concurrent external edit blocks deletion and surfaces required manual cleanup", async () => {
  const f = fixture({ externalEditAtCleanup: true });
  await assert.rejects(() => runAniListReversibleSmoke({ account, graphql: f.graphql }), /refusing to delete/);
  assert.equal(f.entries.get(202).status, "PAUSED");
  assert.equal(f.actions.filter((action) => action.query === ANILIST_SMOKE_DELETE).length, 0);
});

test("Revoked connection or incomplete initial list prevents any test mutation", async () => {
  const f = fixture();
  await assert.rejects(() => runAniListReversibleSmoke({ account, graphql: f.graphql, stillConnected: () => false }), /connection changed/);
  assert.equal(f.actions.length, 0);
  const invalid = await assert.rejects(() => runAniListReversibleSmoke({ account, graphql: async (_token, query) => (
    query === ANILIST_LIST_QUERY ? { Viewer: { id: 77 }, MediaListCollection: null } : {}
  ) }), /complete list/);
  assert.equal(invalid, undefined);
});
