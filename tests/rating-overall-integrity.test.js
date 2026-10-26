import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { escapeHtml, icon } from "../frontend/ui/ui.js";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const start = app.indexOf("function titleRatingBreakdownMarkup(");
const end = app.indexOf("\nfunction titleTrailerUrl(", start);

function ratingMarkup() {
  assert.ok(start >= 0 && end > start);
  const context = vm.createContext({ icon, escapeHtml, Number });
  vm.runInContext(app.slice(start, end), context);
  return context.titleRatingMarkup;
}

test("IMDb series badge always displays the actual IMDb overall rating, even when all season averages exist", () => {
  const html = ratingMarkup()({ id: "tt1234567", rating: "8.6", imdbSeasons: [
    { season: 1, score: 5.2 }, { season: 2, score: 9.8 },
  ] });
  assert.match(html, /aria-label="IMDb 8\.6 out of 10/);
  assert.match(html, /<strong>8\.6<\/strong><span>IMDb<\/span>/);
  assert.match(html, /Season 1[\s\S]*5\.2\/10/);
  assert.match(html, /Season 2[\s\S]*9\.8\/10/);
  assert.match(html, /Overall series score/);
  assert.doesNotMatch(html, /Average of IMDb season scores/,
    "A mean of seasons is not the official IMDb title rating");
});

test("Unknown IMDb root rating is never invented from season averages", () => {
  const html = ratingMarkup()({ id: "tt1234567", rating: "", imdbSeasons: [
    { season: 1, score: 9 }, { season: 2, score: 10 },
  ] });
  assert.equal(html, "", "Do not label an inferred score as the IMDb overall rating");
});

test("public AniList rating remains visible during expiry refresh and transient failures", async () => {
  const start = app.indexOf("const publicTitleRatingCache = new Map();");
  const end = app.indexOf("\nfunction titleRatingBreakdownMarkup(", start);
  assert.ok(start >= 0 && end > start);
  const rating = { score: 8.7, seasons: [{ season: 1, score: 8.7 }], totalSeasons: 1 };
  let now = 10_000;
  let requests = 0;
  const context = vm.createContext({
    Date: { now: () => now }, Map,
    eligibleForPublicAnimeRating: () => true,
    publicCatalogSeasonCounts: (seasons) => seasons,
    fetchMatchedPublicAniListSeasons: async () => {
      requests++;
      if (requests === 1) return rating;
      throw new Error("AniList temporarily unavailable");
    },
    refreshTitlePage: () => {},
  });
  vm.runInContext(app.slice(start, end), context);
  const subject = { type: "series", series: { aliases: [] } };
  const meta = { id: "tt1234567", name: "Example", releaseInfo: "2025",
    seasons: [{ season: 1, count: 12 }], genres: ["Animation"], country: "Japan" };
  assert.equal(context.titleCommunityRating(subject, meta), null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(context.titleCommunityRating(subject, meta).score, 8.7);
  now += 6 * 60 * 60_000 + 1;
  assert.equal(context.titleCommunityRating(subject, meta).score, 8.7,
    "Keep the last verified rating on screen while fresh provider lookup is pending");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(context.titleCommunityRating(subject, meta).score, 8.7,
    "Temporary provider outage cannot erase the previously verified rating");
  assert.equal(requests, 2);
});
