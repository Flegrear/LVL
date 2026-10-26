import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { resolveAniListScorePart } from "../frontend/anilist/anilist-score-sync.js";
import { formatScore, reasonGroups, reasonLines } from "../frontend/recommendations/recs-ui.js";

test("Recommendation explanation compares a rated seed to its actual public average and observed own average", () => {
  const lines = reasonLines({ reasons: [{ kind: "fans", from: [
    { title: "Frieren", score: 9.1, publicScore: 80, personalAverage: 9, votes: 273 },
  ] }] });
  assert.match(lines[0], /you rated 9\.10/);
  assert.match(lines[0], /public average 8\.00 \(\+1\.10\)/);
  assert.match(lines[0], /your usual average 9\.00 \(\+0\.10\)/);
  assert.match(lines[0], /273 votes/);
  const unknown = reasonLines({ reasons: [{ kind: "fans", from: [
    { title: "Unknown", score: 9.1, publicScore: null, personalAverage: null, votes: 12 },
  ] }] });
  assert.doesNotMatch(unknown[0], /public average|usual average/);
});
import { lvlRatingSummary } from "../frontend/recommendations/lvl-ratings.js";

const ui = readFileSync(new URL("../frontend/recommendations/recs-ui.js", import.meta.url), "utf8");

test("unrated, malformed and out-of-range provider values never appear as user scores", () => {
  for (const bad of [null, undefined, "", 0, -1, 10.01, 12, Number.NaN, Infinity, "not-a-number"])
    assert.equal(formatScore(bad), "", `Invalid score ${String(bad)} must not be presented as a valid 1–10 rating`);
  assert.equal(formatScore(7.35), "7.35");
  assert.equal(formatScore(10), "10.00");
  const lines = reasonLines({ reasons: [{ kind: "caution", from: [{ title: "Example", score: 0 }] }] });
  assert.deepEqual(lines, ["Fans of Example recommend it too, but your reaction to Example counts against this match."]);
});

test("Reason popup evidence distinguishes taste signals, low-rated fan counter-signals, and community context", () => {
  const groups = reasonGroups({ reasons: [
    { kind: "fans", from: [{ title: "JUJUTSU KAISEN", score: 9.4, votes: 212 }] },
    { kind: "shared", names: ["Drama", "Male Protagonist", "Coming of Age"] },
    { kind: "community", score: 84, scoredBy: 306826, source: "anilist" },
    { kind: "caution", from: [{ title: "My Hero Academia", score: 6 }] },
    { kind: "planned" },
  ] });
  assert.match(groups.matches[0], /Fans of JUJUTSU KAISEN/);
  assert.match(groups.matches[1], /categories associated with titles you rated higher/);
  assert.ok(groups.matches.every((line) => !/306,826|My Hero Academia|plan to watch/i.test(line)),
    "Neither community rating, low-scored source nor watchlist is a positive personal match reason");
  assert.match(groups.cautions[0], /your 6\.00 rating of My Hero Academia counts against this match/);
  assert.deepEqual(groups.context, [], "public/community rating and plan-to-watch are omitted from recommendation explanations");
  assert.doesNotMatch(groups.matches[1], / — /);
});

test("manual AniList identity without authenticated remote list score never hides a local rating", () => {
  const start = ui.indexOf("const scoreInput = (");
  const end = ui.indexOf("\n  // Re-render the block only when it changed", start);
  assert.ok(start >= 0 && end > start);
  const ctx = vm.createContext({
    escapeHtml: (text) => String(text), formatScore: (value) => value == null ? "" : Number(value).toFixed(2),
    hasScore: (score) => score != null, helpTipMarkup: () => "", badgeMarkup: () => "",
    buttonMarkup: () => "", iconButtonMarkup: () => "",
    STATUS_LABELS: { CURRENT: "Watching" }, resolveAniListScorePart,
    getAniListScoreSyncState: () => ({ enabled: true }), getAniListScorePending: () => null,
    titleCacheKey: () => "show", seasonsOpen: new Set(), lvlRatingSummary,
  });
  vm.runInContext(ui.slice(start, end), ctx);
  const record = { data: { ratings: [{ source: "app", score: 7.35, status: null, season: null }] } };
  const manual = { catalogId: "tt1234567", seriesKey: "show", title: "Example", kind: "anime", seasons: [1],
    anilist: { seasons: [{ season: 1, anilistId: 777, score: null, status: null, progress: null }] } };
  const local = ctx.titleRatingMarkup(manual, record);
  assert.match(local, /value="7\.35" data-rating-score=""/);
  const synced = { ...manual, anilist: { seasons: [{ season: 1, anilistId: 777, score: 8.9, status: "CURRENT", progress: 4 }] } };
  const remote = ctx.titleRatingMarkup(synced, record);
  assert.match(remote, /value="8\.90" data-rating-score=""/,
    "Verified list score supersedes local editor presentation only when remote entry exists");
});

test("AniList-only scores remain visible in LVL with automatic score writes disabled", () => {
  const start = ui.indexOf("const scoreInput = (");
  const end = ui.indexOf("\n  // Re-render the block only when it changed", start);
  const ctx = vm.createContext({
    escapeHtml: (text) => String(text), formatScore: (value) => value == null ? "" : Number(value).toFixed(2),
    hasScore: (score) => score != null, helpTipMarkup: () => "", badgeMarkup: () => "",
    buttonMarkup: () => "", iconButtonMarkup: () => "",
    STATUS_LABELS: { PLANNING: "Plan to watch" }, resolveAniListScorePart,
    getAniListScoreSyncState: () => ({ enabled: false }), getAniListScorePending: () => null,
    titleCacheKey: () => "show", seasonsOpen: new Set(), lvlRatingSummary,
  });
  vm.runInContext(ui.slice(start, end), ctx);
  const subject = { catalogId: "tt1234567", seriesKey: "show", title: "Example", kind: "anime", seasons: [1],
    anilist: { seasons: [{ season: 1, anilistId: 777, score: 8.9, status: "PLANNING", progress: 0 }] } };
  const html = ctx.titleRatingMarkup(subject, { data: { ratings: [{ source: "anilist", season: 1, score: 8.9 }] } });
  assert.match(html, /value="8\.90" data-rating-score=""/);
  assert.doesNotMatch(html, /AniList score sync is on/);
});

test("status-only edits preserve the saved local score instead of copying or clearing the visible AniList score", async () => {
  const start = ui.indexOf("function queueTitleRating(");
  const end = ui.indexOf("\n  function retryTitleAniListScore(", start);
  assert.ok(start >= 0 && end > start);
  const titleNow = { catalogId: "tt1234567", seriesKey: "show", title: "Example", year: 2025, kind: "anime" };
  const record = { data: { ratings: [{ source: "app", season: null, score: 7.35, status: null }] } };
  const sent = [];
  let remoteSaves = 0;
  const context = vm.createContext({
    titleNow,
    titleCacheKey: (subject) => subject.catalogId,
    titleWrites: new Map(),
    titleRecord: () => record,
    postJson: async (_url, payload) => {
      sent.push(payload);
      record.data = { ratings: payload.score !== null || payload.status
        ? [{ source: "app", season: payload.season, score: payload.score, status: payload.status }] : [] };
      return { ratings: record.data.ratings };
    },
    onRatingSaved: async () => { remoteSaves++; return "AniList saved"; },
    showTitleRatingMessage: () => {},
    loadedAt: 0,
  });
  vm.runInContext(ui.slice(start, end), context);
  await context.saveTitleRating({}, null, { status: "CURRENT", statusOnly: true, syncScore: false });
  assert.equal(sent[0].score, 7.35, "Changing status cannot replace local 7.35 with displayed remote 8.9");
  assert.equal(sent[0].status, "CURRENT");
  assert.equal(remoteSaves, 0, "Status-only edit must not request a remote AniList score mutation");

  // The initial editor may only have a remote imported score; status-only must
  // not create a fabricated local rating using that displayed remote number.
  record.data = { ratings: [{ source: "anilist", score: 8.9, season: null }] };
  await context.saveTitleRating({}, null, { status: "PLANNING", statusOnly: true, syncScore: false });
  assert.equal(sent[1].score, null, "Remote imported score is not the user's local app score");
  assert.equal(remoteSaves, 0);
});

test("queued score edit followed by status change uses the just-saved score, never the earlier cached score", async () => {
  const start = ui.indexOf("function queueTitleRating(");
  const end = ui.indexOf("\n  function retryTitleAniListScore(", start);
  const subject = { catalogId: "tt1234567", seriesKey: "show", title: "Example", kind: "anime" };
  const record = { data: { ratings: [{ source: "app", season: null, score: 5.4 }] } };
  const calls = [];
  const context = vm.createContext({
    titleNow: subject, titleCacheKey: (item) => item.catalogId,
    titleWrites: new Map(), titleRecord: () => record,
    postJson: async (_url, payload) => {
      calls.push(payload);
      record.data = { ratings: [{ source: "app", score: payload.score, status: payload.status, season: null }] };
      return { ratings: record.data.ratings };
    },
    onRatingSaved: async () => "", showTitleRatingMessage: () => {}, loadedAt: 0,
  });
  vm.runInContext(ui.slice(start, end), context);
  const first = context.saveTitleRating({}, null, { score: 8.75, status: null, syncScore: true });
  const second = context.saveTitleRating({}, null, { status: "COMPLETED", statusOnly: true, syncScore: false });
  await Promise.all([first, second]);
  assert.equal(calls[0].score, 8.75);
  assert.equal(calls[1].score, 8.75, "Status change must not revert the previous score edit");
  assert.equal(calls[1].status, "COMPLETED");
});
