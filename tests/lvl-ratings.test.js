import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { lvlRatingSummary } from "../frontend/recommendations/lvl-ratings.js";
import { resolveAniListScorePart } from "../frontend/anilist/anilist-score-sync.js";
import { STATUS_LABELS } from "../frontend/recommendations/recs-ui.js";

const source = readFileSync(new URL("../frontend/recommendations/recs-ui.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../frontend/styles/styles.css", import.meta.url), "utf8");

test("LVL score is an unweighted mean of locally rated seasons, not the imported AniList score", () => {
  const result = lvlRatingSummary([
    { source: "app", season: null, score: 4, status: "PLANNING" },
    { source: "app", season: 1, score: 8.4 },
    { source: "app", season: 2, score: 9.2 },
    { source: "anilist", season: 2, score: 10 },
  ], [1, 2, 3]);
  assert.equal(result.score, 8.8);
  assert.equal(result.rated, 2);
  assert.equal(result.total, 3);
  assert.deepEqual(result.rows.map((row) => row.score), [8.4, 9.2, null]);
  assert.equal(result.legacyOverall, 4);
});

test("unrated, imported-only, duplicate seasons, and bad scores do not fabricate LVL ratings", () => {
  assert.equal(lvlRatingSummary([{ source: "anilist", season: 1, score: 9.4 }], [1, 2]).score, null);
  const result = lvlRatingSummary([
    { source: "app", season: 1, score: 0 },
    { source: "app", season: 2, score: 11 },
    { source: "app", season: 3, score: 7.55 },
    { source: "app", season: 4, score: Number.NaN },
  ], [1, 2, 3, 4, 4]);
  assert.equal(result.score, 7.55);
  assert.equal(result.rated, 1);
  assert.equal(result.total, 4);
});

test("movies and titles without catalog seasons retain their existing overall LVL score", () => {
  const result = lvlRatingSummary([{ source: "app", season: null, score: 7.56 }], []);
  assert.equal(result.score, 7.56);
  assert.equal(result.total, 0);
  assert.equal(lvlRatingSummary([], []).score, null);
});

function badgeHarness() {
  const from = source.indexOf("function titleLvlBadgeMarkup(");
  const to = source.indexOf("\n  function titleRatingMarkup(", from);
  assert.ok(from > 0 && to > from);
  const ctx = vm.createContext({
    lvlRatingSummary,
    escapeHtml: String,
    formatScore: (value) => value === null || value === undefined ? "" : Number(value).toFixed(2),
    STATUS_LABELS: { COMPLETED: "Completed", CURRENT: "Watching", PAUSED: "Paused", DROPPED: "Dropped", PLANNING: "Plan to watch" },
    icon: (name) => '<icon>' + name + '</icon>',
    $: () => null,
  });
  vm.runInContext(source.slice(from, to), ctx);
  return vm.runInContext("titleLvlBadgeMarkup", ctx);
}

test("LVL badge follows AniList and offers editable individual season scores inside its black dropdown", () => {
  const render = badgeHarness();
  const badge = render({ seasons: [1, 2] }, { data: { ratings: [
    { source: "app", season: 1, score: 8.65 },
    { source: "app", season: 2, score: 9.25 },
    { source: "anilist", season: 1, score: 2 },
  ] } });
  assert.match(badge, /data-title-rating-provider="LVL"/);
  assert.match(badge, /<strong>9\.0<\/strong><span>LVL<\/span>/);
  assert.match(badge, /Season 1[\s\S]*value="8\.65" data-rating-score="1"/);
  assert.match(badge, /Season 2[\s\S]*value="9\.25" data-rating-score="2"/);
  assert.match(badge, /2 of 2 seasons rated/);
  assert.match(badge, /data-rating-clear="1"/);
  assert.match(badge, /class="title-rating-season title-lvl-score-row"/);
  assert.match(badge, /<span>\/10<\/span>/);
  assert.doesNotMatch(badge, /data-rating-status/, "Status should live by Magnet, outside the score popup");
  assert.doesNotMatch(badge, /data-lvl-edit-ratings/);
  assert.match(app, /\$\{titleRatingMarkup\(info\)\}\$\{titleAniListRatingMarkup\(communityRating, \{ eligible:/,
    "A missing public AniList score must be represented in its normal hero location for anime only");
  assert.match(app, /id="title-lvl-rating-slot"/);
  assert.match(css, /\.title-lvl-rating-slot/);
  assert.match(css, /\.title-lvl-rating-wrap \.title-rating-breakdown\s*\{[^}]*background:#000;/);
  assert.match(css, /\.title-lvl-rating-wrap \.title-rating-breakdown__heading\s*\{[^}]*background:#000;/);
  const empty = render({ seasons: [1, 2] }, { data: { ratings: [] } });
  assert.match(empty, /<strong>—<\/strong><span>LVL<\/span>/);
  assert.match(empty, /data-rating-score="1"/);
  assert.match(empty, /placeholder="" value="" data-rating-score="1"/, "Empty scores should have no visible dash or underscore placeholder");
  assert.doesNotMatch(empty, /data-rating-clear="1"/);
  const importedOnly = render({ seasons: [1] }, { data: { ratings: [{ source: "anilist", season: 1, score: 10 }] } });
  assert.match(importedOnly, /placeholder="" value="" data-rating-score="1"/, "AniList score must not populate LVL input");
  const precise = render({ seasons: [1, 2] }, { data: { ratings: [
    { source: "app", season: 1, score: 7.54 },
    { source: "app", season: 2, score: 10 },
  ] } });
  assert.match(precise, /value="7\.54" data-rating-score="1"/);
  assert.match(precise, /value="10\.00" data-rating-score="2"/);
});

test("the previous separate rating editor is hidden while keeping the existing saved-rating and AniList integration", () => {
  assert.match(source, /class="title-lvl-editor-bar"/);
  assert.match(source, /class="recs-rating-editor" data-rating-editor/);
  assert.match(source, /summary\.rated \+ '\/' \+ summary\.total/);
  assert.match(source, /scoreInput\(season, bySeason\.get\(season\)/);
  assert.match(source, /class="recs-imported-fold"/);
  assert.match(css, /#title-your-rating\s*\{\s*display:none!important;/);
  assert.match(source, /wireTitleRating\(\$\("#title-hero"\)\)/);
  assert.doesNotMatch(source, /data-lvl-edit-ratings/);
  assert.match(source, /onRatingSaved\(subject, season, score\)/);
});

test("LVL popup rating inputs have no box, underline or row separator even while focused", () => {
  const input = css.match(/\.title-lvl-score-value input\s*\{([^}]+)\}/)?.[1];
  assert.ok(input, "The season-score input has a scoped style");
  assert.match(input, /\bborder:0;/);
  assert.doesNotMatch(input, /border-bottom/);
  assert.match(input, /caret-color:#fff;/, "Editing remains visible through the text caret");
  const focus = css.match(/\.title-lvl-score-value input:focus,\.title-lvl-score-value input:focus-visible\s*\{([^}]+)\}/)?.[1];
  assert.ok(focus, "Only these rating fields lose the default focus ring");
  assert.match(focus, /\boutline:0;/);
  assert.match(focus, /\bbox-shadow:none;/);
  assert.match(css, /\.title-lvl-rating-wrap \.title-lvl-score-row\s*\{\s*border-top:0;/,
    "The unrelated gray row separator is removed only inside the LVL score popup");
  assert.match(css, /\.title-watch-status-slot select:focus-visible\s*\{\s*outline:2px solid #fff;/,
    "Other focusable controls keep their visible keyboard focus style");
});

test("watch status sits alongside Magnet and defaults to the linked AniList status until locally edited", () => {
  const from = source.indexOf("function titleWatchStatusMarkup(");
  const to = source.indexOf("\n  function paintTitleLvlBadge(", from);
  assert.ok(from > 0 && to > from);
  const context = vm.createContext({ STATUS_LABELS, escapeHtml: String });
  vm.runInContext(source.slice(from, to), context);
  const render = context.titleWatchStatusMarkup;
  const subject = { title: "Apothecary Diaries", anilist: { seasons: [
    { season: 1, status: "CURRENT" }, { season: 2, status: "CURRENT" },
  ] } };
  assert.match(render(subject, { data: { ratings: [] } }), /value="CURRENT" selected>Watching/);
  assert.match(render(subject, { data: { ratings: [{ source: "app", season: null, status: "COMPLETED" }] } }),
    /value="COMPLETED" selected>Completed/);
  assert.match(render({ ...subject, anilist: { seasons: [{ status: "CURRENT" }, { status: "PAUSED" }] } },
    { data: { ratings: [] } }), /value="" selected>Watch status/);
  assert.match(app, /id="title-watch-status-slot"/);
  assert.match(css, /\.title-watch-status-slot select\s*\{[^}]*height:42px/);
  assert.match(source, /wireTitleRating\(\$\("#title-hero"\)\)/);
});

test("LVL season editor does not populate local scores from imported AniList entries", () => {
  const start = source.indexOf("const scoreInput = (");
  const end = source.indexOf("\n  // Re-render the block only when it changed", start);
  const ctx = vm.createContext({
    lvlRatingSummary,
    resolveAniListScorePart,
    escapeHtml: String,
    formatScore: (score) => score === null || score === undefined ? "" : Number(score).toFixed(2),
    hasScore: (score) => score !== null && score !== undefined && Number.isFinite(Number(score)) && Number(score) >= 1 && Number(score) <= 10,
    helpTipMarkup: () => "",
    badgeMarkup: (text) => '<span>' + text + '</span>',
    buttonMarkup: () => '<button>Clear</button>',
    iconButtonMarkup: () => '<button>Clear</button>',
    STATUS_LABELS: { PLANNING: "Plan to watch", CURRENT: "Watching" },
    getAniListScoreSyncState: () => ({ enabled: true }),
    getAniListScorePending: () => null,
    titleCacheKey: () => "example",
    seasonsOpen: new Set(),
  });
  vm.runInContext(source.slice(start, end), ctx);
  const record = { data: { ratings: [
    { source: "app", season: 1, score: 7.25 },
    { source: "anilist", season: 2, score: 9.8, title: "Example Second Season" },
  ] } };
  const html = ctx.titleRatingMarkup({
    catalogId: "tt1111111", title: "Example", kind: "anime", seasons: [1, 2],
    anilist: { seasons: [{ season: 2, anilistId: 5, score: 9.8, status: "CURRENT", progress: 1 }] },
  }, record);
  assert.match(html, /7\.25\/10/);
  assert.match(html, /value="7\.25" data-rating-score="1"/);
  assert.match(html, /value="" data-rating-score="2"/, "Remote-only score does not become a local season rating");
  assert.match(html, /1\/2 seasons rated/);
  assert.match(html, /data-rating-editor/);
  assert.doesNotMatch(html, /data-rating-editor open/);
  assert.match(html, /On your lists \(1\)/);
});
