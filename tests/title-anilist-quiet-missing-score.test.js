import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// Presentation-only release contract for Title. No network, AniList writes,
// runtime profiles, production code edits or real user Library are involved.
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const slice = (from, to) => {
  const start = app.indexOf(from);
  const end = app.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, `Could not locate title UI source section: ${from}`);
  return app.slice(start, end);
};
const escapeHtml = (value) => String(value).replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;").replaceAll('"', "&quot;");

function hero({ anime = true, rating = null } = {}) {
  const context = vm.createContext({
    titleView: { fromApp: false },
    seriesNextUp: () => null,
    titleFirstChapter: () => null,
    buttonMarkup: ({ label }) => `<button>${escapeHtml(label)}</button>`,
    iconButtonMarkup: ({ label }) => `<button>${escapeHtml(label)}</button>`,
    icon: () => "<svg></svg>",
    escapeHtml,
    metaMarkup: () => "",
    titleListText: (names) => names.join(", "),
    formatRuntime: (runtime) => runtime,
    posterSrcset: () => "",
    titleTrailerUrl: () => "",
    artworkFallback: () => "",
    eligibleForPublicAnimeRating: ({ mediaKind, genres, country }) =>
      mediaKind === "anime" || (genres?.includes("Animation") && country === "Japan"),
  });
  vm.runInContext(slice("function titleRatingBreakdownMarkup(", "\n// The rating popup lives"), context);
  vm.runInContext(slice("function titleRatingMarkup(", "\nfunction titleTrailerUrl("), context);
  vm.runInContext(slice("function savedTitleBadge(", "\n// Your progress with a Library title"), context);
  const info = {
    id: "tt1355642", name: "Fullmetal Alchemist: Brotherhood",
    poster: "", posterFallback: "", backdrop: "", backdropFallback: "", logo: "",
    releaseInfo: "2009", seasonCount: 1, chapterTotal: 64,
    runtime: "24 min", status: "Ended", rating: 9.1, imdbSeasons: [],
    trailers: [], genres: anime ? ["Animation"] : ["Drama"],
    country: anime ? "Japan" : "United States",
    description: "", cast: [],
  };
  const subject = { id: info.id, type: "series", series: {
    key: "fullmetal alchemist brotherhood", title: info.name,
    mediaKind: anime ? "anime" : "series", sources: [],
  } };
  return vm.runInContext("titleHeroMarkup", context)(subject, info, null, rating);
}

function progress({ linked = false, account = true, anime = true } = {}) {
  const series = {
    title: "Fullmetal Alchemist: Brotherhood", key: "fullmetal-alchemist-brotherhood",
    catalogId: "tt1355642",
    mediaKind: anime ? "anime" : "series", aliases: ["Fullmetal Alchemist: Brotherhood"],
    seasons: new Map([[1, []]]), sources: [],
  };
  const context = vm.createContext({
    readAniListAccount: () => account ? { userId: 42 } : null,
    localStorage: {},
    seriesAniList: () => linked ? { seasons: [{ season: 1, anilistId: 5114 }] } : null,
    catalogSeriesView: { meta: { id: "tt1355642" }, seasons: [{ season: 1 }] },
    anilistTitleLinkSearch: null,
    escapeHtml,
  });
  vm.runInContext(slice("function titleProgressMarkup(", "\nlet anilistTitleManualLinkSerial = 0;"), context);
  return vm.runInContext("titleProgressMarkup", context)(
    { id: "tt1355642", type: "series", series },
    { chapterTotal: 64 },
  );
}

test("Missing public AniList score reserves its normal hero rating placement without inventing a number", () => {
  const html = hero({ rating: null });
  const scoreGroup = html.match(/<div class="title-hero__scores">([\s\S]*?)<div id="title-lvl-rating-slot"/)?.[1];
  assert.ok(scoreGroup, "AniList and IMDb should live in the existing hero score row, ahead of the LVL input");
  assert.match(scoreGroup, /AniList/i,
    "Eligible anime should retain the AniList provider's empty badge/slot when no verified public score exists");
  assert.doesNotMatch(scoreGroup, /(?:^|>)\s*(?:0(?:\.0+)?|—|N\/A)\s*\/\s*10\b/,
    "Unavailable does not mean zero, a synthetic score, or an em dash as a rating");
  assert.doesNotMatch(html, /This anime season is not linked|not linked to AniList/i);
});

test("Verified AniList score still appears in the same hero rating row; nonanime gets no AniList placeholder", () => {
  const confirmed = hero({ rating: { score: 7.8, totalSeasons: 1, seasons: [
    { season: 1, score: 7.8, parts: [
      { id: 5114, title: "Fullmetal Alchemist: Brotherhood", score: 7.8 },
    ] },
  ] } });
  assert.match(confirmed, /data-title-rating-provider="AniList"/);
  assert.match(confirmed, /<strong>7\.8<\/strong><span>AniList<\/span>/);
  assert.doesNotMatch(hero({ anime: false }), /data-title-rating-provider="AniList"|title-rating[^"]*unavailable[^>]*AniList/i,
    "Never invent an anime provider score on an unrelated TV drama");
});

test("Unverified personal season mapping does not force a prominent notification or expanded search form", () => {
  const html = progress({ linked: false });
  assert.doesNotMatch(html,
    /This anime season is not linked to AniList|LVL cannot sync its watched episodes yet|Choose the correct AniList entry/i,
    "Unmatched account mapping must not turn the Title view into a warning panel");
  // An implementation may render the optional season/URL/ID input immediately
  // inside *closed* native details, or inject it after a compact button click.
  // Either is safe; a full form displayed by default is not.
  const containsFields = /id="title-anilist-link-(?:query|season|id|url)"/.test(html);
  const closedDetails = /<details\b(?![^>]*\bopen\b)[^>]*>[\s\S]*?<summary\b/i.test(html);
  assert.ok(!containsFields || closedDetails,
    "Manual AniList fields must be behind an explicit, initially closed affordance");
  assert.match(html, /(?:Link|Identify|Match|Connect|Find)[^<]{0,45}AniList|AniList[^<]{0,45}(?:Link|Identify|Match|Connect|Find)/i,
    "An unverified season should have a compact, opt-in AniList identity action");
  assert.match(html, /<(?:button|summary)\b/i,
    "The optional identity action should use a keyboard-accessible control");
  assert.doesNotMatch(progress({ linked: true }), /title-anilist-link|data-title-anilist-find|This anime season is not linked/i,
    "No manual fallback should appear after the season was verified");
  assert.equal(progress({ anime: false }), "", "Nonanime series should never see AniList linking controls");
});
