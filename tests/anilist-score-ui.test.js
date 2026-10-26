import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const ui = readFileSync(new URL("../frontend/recommendations/recs-ui.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

test("Two-way score sync is separate, off by default, account-scoped, and survives only until disconnect", () => {
  assert.match(html, /id="anilist-score-sync-enabled" type="checkbox"/);
  assert.match(html, /Sync anime ratings both ways/);
  assert.match(app, /prefs\?\.userId === account\.userId && prefs\.enabled === true/);
  assert.match(app, /if \(scoreEnabled\) scoreEnabled\.disabled = !account/);
  assert.match(app, /localStorage\.removeItem\(ANILIST_SCORE_SYNC_KEY\)/);
  assert.match(app, /stillConnected: \(\) => \{/);
  assert.match(app, /Boolean\(anilistScoreSyncEnabled\(\)\) && latest\?\.token === account\.token/);
  assert.match(app, /resolveAniListScorePart\(authenticatedTitleAniList\(subject, latest\), season\)\?\.anilistId === part\.anilistId/,
    "Every authenticated score write rechecks the current Library mapping through the network round trip");
});

test("LVL season editor is independent of imported scores, but verified season changes can sync to AniList", () => {
  assert.match(ui, /scoreInput\(season, bySeason\.get\(season\)/);
  assert.match(ui, /lvlRatingSummary\(ratings, seasons\)/);
  assert.match(ui, /shownRating\(null, overall\)/);
  assert.match(ui, /if \(syncScore\) \{/);
  assert.match(ui, /await onRatingSaved\(subject, season, score\)/);
  assert.match(ui, /syncScore: Boolean\(input\)/);
  assert.match(ui, /syncScore: true/);
  assert.match(app, /resolveAniListScorePart\(authenticatedTitleAniList\(subject, account\), season\)/,
    "Score writes resolve the current owner's exact Library association, not a stale display-only mapping");
  assert.match(app, /rendered\?\.anilistId !== part\.anilistId/,
    "An editor opened before a mapping or account change must not redirect writes");
  assert.match(app, /anilistScoreRuns\.set\(key, current\)/);
  assert.match(app, /Saved to AniList/);
  assert.doesNotMatch(ui, /postJson\([^\n]+access_token|postJson\([^\n]+auth\.token/);
});

test("Connected AniList score imports refresh title editor and recommendations, independently of watch progress", () => {
  assert.match(app, /scoreSyncEnabled: anilistScoreSyncEnabled\(\)/);
  assert.match(app, /recsUi\.invalidateRatings\(\)/);
  assert.match(app, /if \(anilistScoreSyncEnabled\(\)\) void syncAniListLibrary/);
  assert.match(ui, /function invalidateRatings\(\)/);
});

test("Failed score updates remain visible, account-scoped, and retry never touches progress or local status", () => {
  assert.match(app, /stageUnconfirmedAniListScore\(localStorage, account\.userId, part\.anilistId, score\)/);
  assert.match(app, /acknowledgeUnconfirmedAniListScore\(localStorage, account\.userId, part\.anilistId, score\)/);
  assert.match(app, /getAniListScorePending: \(subject, season\)/);
  assert.match(ui, /if \(pending\) return \{ \.\.\.local, score: pending\.score \}/);
  assert.match(ui, /data-rating-retry/);
  assert.match(ui, /retryTitleAniListScore\(node, season\)/);
  assert.match(ui, /await onRatingSaved\(subject, season, pending\.score\)/);
  assert.match(ui, /titleCacheKey\(titleNow\) === titleCacheKey\(subject\)/, "Refreshes do not discard the result message");
  assert.match(ui, /const previous = titleWrites\.get\(key\) \|\| Promise\.resolve\(\)/);
  assert.match(ui, /return queueTitleRating\(subject, \(\) => performSaveTitleRating\(node, subject, season, changes\)\)/);
  assert.match(ui, /return queueTitleRating\(subject, \(\) => performRetryTitleAniListScore\(node, subject, season\)\)/);
});
