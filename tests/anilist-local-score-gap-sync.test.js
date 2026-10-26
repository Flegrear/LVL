import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { planMissingAniListScores, resolveAniListScorePart } from "../frontend/anilist/anilist-score-sync.js";

const source = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const start = source.indexOf("async function syncMissingLocalAniListScores(");
const end = source.indexOf("\nfunction syncAniListLibrary(", start);
assert.ok(start > 0 && end > start);

function fixture({ enabled = true, mapped = true, existingScore = null, score = 8.35,
  duplicateTitle = false, extraRatings = [] } = {}) {
  const account = { userId: 7, username: "tester", token: "test-only-token" };
  const series = { key: "anime", title: "Example anime", mediaKind: "anime", catalogId: "tt1234567", sources: [] };
  const duplicate = { key: "other-anime", title: "Different anime", mediaKind: "anime", catalogId: "tt7654321", sources: [] };
  const info = { seasons: mapped ? [{ season: 1, anilistId: 42, episodes: 12, status: "CURRENT", progress: 2, score: existingScore }] : [] };
  const calls = [];
  const context = vm.createContext({
    URLSearchParams,
    localStorage: {},
    console: { warn: () => {} },
    readAniListAccount: () => account,
    anilistScoreSyncEnabled: () => enabled,
    buildLibrarySeries: () => duplicateTitle ? [series, duplicate] : [series],
    seriesAniList: () => info,
    resolveAniListScorePart,
    planMissingAniListScores,
    anilistGraphql: async () => ({}),
    fetchJson: async (url) => {
      assert.match(url, /\/api\/ratings\?/);
      if (new URL(`http://localhost${url}`).searchParams.get("seriesKey") === duplicate.key)
        return { ratings: [{ source: "app", season: 1, score: 9.5, title: duplicate.title }] };
      return { ratings: [{ source: "app", season: 1, score, title: series.title }, ...extraRatings] };
    },
    saveAniListScore: async ({ account: owner, mediaId, score: value, expectedRaw, stillConnected }) => {
      assert.equal(owner, account);
      assert.equal(mediaId, 42);
      assert.equal(expectedRaw, 0, "only a verified missing remote score may be filled");
      assert.equal(stillConnected(), true);
      calls.push(value);
    },
  });
  vm.runInContext(source.slice(start, end), context);
  return { run: (owner = account) => context.syncMissingLocalAniListScores(owner), calls };
}

test("manual two-way sync fills a missing remote score only with the exact mapped list entry", async () => {
  const { run, calls } = fixture();
  const result = await run();
  assert.deepEqual({ ...result }, { sent: 1, skipped: 0 });
  assert.deepEqual(calls, [8.35]);
});

test("missing/ambiguous mapping, existing AniList score, and disabled opt-in cause no writes", async () => {
  for (const options of [{ enabled: false }, { mapped: false }, { existingScore: 9.2 }]) {
    const { run, calls } = fixture(options);
    await run();
    assert.equal(calls.length, 0, JSON.stringify(options));
  }
});

test("manual backfill rejects colliding AniList destinations across titles and season scopes", async () => {
  for (const options of [
    { duplicateTitle: true },
    { extraRatings: [{ source: "app", season: null, score: 7.5 }] },
  ]) {
    const { run, calls } = fixture(options);
    const result = await run();
    assert.equal(result.sent, 0);
    assert.deepEqual(calls, [], "an ambiguous batch must not write the first score it sees");
    assert.ok(result.skipped >= 1);
  }
});

test("manual Sync now is the only automatic historical local-to-AniList score backfill trigger", () => {
  assert.match(source, /syncAniListAuto\(\{ manual: true \}\)[\s\S]*?syncMissingLocalAniListScores\(account\)/);
  assert.match(source.slice(start, end), /planMissingAniListScores\(candidates, \{ limit: 25 \}\)/);
  assert.match(source.slice(start, end), /expectedRaw: update\.expectedRaw/);
  assert.doesNotMatch(source.slice(start, end), /ANILIST_SAVE_PROGRESS|SaveMediaListEntry\(mediaId/);
});
