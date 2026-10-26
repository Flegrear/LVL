import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CURVE, fitCurve, itemQuality, linkStrength, mergeRatings, ratingScale, ratingSignal, reasonSummary, recommend, roundScore } from "../backend/recommendations/recommend.js";

const anime = (id, extra = {}) => [`anilist:${id}`, { itemId: `anilist:${id}`, source: "anilist", title: `Anime ${id}`, format: "TV", score: 80, scoredBy: 50000, likedShare: 0.8, genres: ["Drama"], tags: [], studios: [], relations: [], ...extra }];

test("scores keep two decimals between 1 and 10; anything else is no score", () => {
  assert.equal(roundScore(7.556), 7.56);
  assert.equal(roundScore("9.5"), 9.5);
  assert.equal(roundScore(12), 10);
  assert.equal(roundScore(0.4), 1);
  assert.equal(roundScore(0), null);
  assert.equal(roundScore(""), null);
  assert.equal(roundScore("x"), null);
});

test("ratings are read on your own scale: 9.70 counts more than 9.00, a 5 pushes away", () => {
  const scale = ratingScale([9.7, 9, 8.5, 9.2]);
  assert.ok(scale.mean > 8.4 && scale.mean < 9, `mean ${scale.mean}`);
  const frieren = ratingSignal({ score: 9.7 }, scale);
  const jjk = ratingSignal({ score: 9 }, scale);
  const bad = ratingSignal({ score: 5 }, scale);
  assert.ok(frieren > jjk && jjk > 0, `${frieren} > ${jjk} > 0`);
  assert.ok(bad < -1, `dislike ${bad}`);
  assert.equal(ratingSignal({ status: "DROPPED" }, scale), -0.8);
  assert.equal(ratingSignal({ status: "PLANNING" }, scale), 0);
});

test("relative taste prioritizes a personal rating above its public average over the user's small deviation from their usual ratings", () => {
  const scale = ratingScale([9, 9.1, 8.9, 9.3, 8.7, 9]);
  const unusuallyLoved = ratingSignal({ score: 9.1 }, scale, { score: 80, scoredBy: 120000 });
  const ordinaryReception = ratingSignal({ score: 9.1 }, scale, { score: 91, scoredBy: 120000 });
  assert.ok(unusuallyLoved > ordinaryReception + 0.45, `public-deviation weight: ${unusuallyLoved} > ${ordinaryReception}`);
  assert.ok(unusuallyLoved > 0.45, `9.1 vs public 8.0 is a strong positive even with own average near 9: ${unusuallyLoved}`);
  assert.ok(ratingSignal({ score: 7.5 }, scale, { score: 94 }) < 0, "publicly acclaimed but personally underwhelming counts against the title");
  assert.equal(ratingSignal({ status: "PLANNING" }, scale, { score: 80 }), 0);
  assert.ok(ratingSignal({ score: 9.1 }, scale, {}) > 0, "missing public average preserves the legacy personal-scale fallback");
});

test("fan provenance exposes the real public score and observed personal mean without inventing either", () => {
  const items = new Map([
    anime(1, { title: "Frieren", score: 80 }),
    anime(2, { title: "Next watch", score: 85 }),
  ]);
  const links = new Map([["anilist:1", [{ to: "anilist:2", votes: 273 }]]]);
  const result = recommend({
    ratings: [{ itemId: "anilist:1", score: 9.1, title: "Frieren", source: "app" }],
    items, links,
  });
  const from = result.picks[0].reasons.find((reason) => reason.kind === "fans").from[0];
  assert.equal(from.score, 9.1);
  assert.equal(from.publicScore, 80);
  assert.equal(from.personalAverage, 9.1, "the display uses actual observed average, not the shrunk internal prior");
  assert.equal(from.votes, 273);
});

test("your own rating in the app beats AniList, which beats Letterboxd; a score beats a status", () => {
  const merged = mergeRatings([
    { itemId: "anilist:1", source: "anilist", score: 8 },
    { itemId: "anilist:1", source: "app", score: 9.5 },
    { itemId: "anilist:2", source: "app", score: null, status: "COMPLETED" },
    { itemId: "anilist:2", source: "anilist", score: 7 },
    { itemId: "tmdb:movie:3", source: "letterboxd", score: 8 },
  ]);
  const byId = Object.fromEntries(merged.map((rating) => [rating.itemId, rating]));
  assert.equal(byId["anilist:1"].score, 9.5);
  assert.equal(byId["anilist:2"].score, 7);
  assert.equal(byId["tmdb:movie:3"].source, "letterboxd");
});

test("When optional two-way AniList scores are enabled, refreshed AniList score overrides a stale local app score for the same item", () => {
  const values = [
    { itemId: "anilist:1", source: "app", score: 9.9 },
    { itemId: "anilist:1", source: "anilist", score: 7.3 },
    { itemId: "tmdb:movie:3", source: "app", score: 8.1 },
  ];
  const synced = mergeRatings(values, { preferAniListScores: true });
  assert.equal(synced.find((value) => value.itemId === "anilist:1").score, 7.3);
  assert.equal(synced.find((value) => value.itemId === "tmdb:movie:3").score, 8.1);
  assert.equal(mergeRatings(values).find((value) => value.itemId === "anilist:1").score, 9.9);
});

test("an explicit season rating beats a generic show rating mapped to the same item", () => {
  const entries = [
    { itemId: "anilist:1", source: "app", season: 1, score: 9.25, updatedAt: 100 },
    { itemId: "anilist:1", source: "app", season: null, score: 7.75, updatedAt: 200 },
  ];
  assert.equal(mergeRatings(entries)[0].score, 9.25);
  assert.equal(mergeRatings([...entries].reverse())[0].score, 9.25);
});

test("fan votes and TMDB positions become link strengths; community scores need voters", () => {
  assert.ok(Math.abs(linkStrength({ votes: 25 }) - 0.5) < 1e-9);
  assert.ok(linkStrength({ votes: 1191 }) > 0.97);
  assert.equal(linkStrength({ rank: 0 }), 0.85);
  assert.equal(linkStrength({}), 0);
  assert.ok(itemQuality({ score: 90, scoredBy: 200000, likedShare: 0.93 }) > 1);
  assert.ok(itemQuality({ score: 90, scoredBy: 10 }) < itemQuality({ score: 90, scoredBy: 100000 }));
  assert.equal(itemQuality({}), 0);
});

test("An excellent public rating alone and a negligible fan link cannot create a personalized match", () => {
  const items = new Map([
    anime(1, { title: "Barely liked source", score: 76, genres: ["Sports"] }),
    anime(2, { title: "Publicly acclaimed but unrelated", score: 100, scoredBy: 500000, likedShare: 1, genres: ["Fantasy"] }),
  ]);
  const links = new Map([["anilist:1", [{ to: "anilist:2", votes: 1 }]]]);
  const result = recommend({ ratings: [{ itemId: "anilist:1", title: "Barely liked source", score: 7.9, source: "app" }], items, links });
  assert.equal(result.candidates, 1, "fan-link discovery can still generate this candidate");
  assert.deepEqual(result.picks, [], "high public quality cannot elevate a negligible personal link past the match threshold");
  const strong = recommend({
    ratings: [{ itemId: "anilist:1", title: "Barely liked source", score: 9.8, source: "app" }],
    items, links: new Map([["anilist:1", [{ to: "anilist:2", votes: 500 }]]]),
  });
  assert.ok(strong.picks.length > 0, "strong personalized fan evidence still makes the high-quality title eligible");
  assert.ok(strong.picks[0].features.communityContribution <= 0.35 + 1e-9,
    "positive public contribution is explicitly bounded");
});

test("picks follow what fans of your favorites recommend, with reasons; seen, hidden and sequels are left out", () => {
  const items = new Map([
    anime(1, { title: "Frieren", genres: ["Adventure", "Fantasy"], tags: [{ name: "Travel", weight: 96 }], studios: ["MADHOUSE"] }),
    anime(2, { title: "JJK", genres: ["Action"], studios: ["MAPPA"] }),
    anime(3, { title: "Violet Evergarden", genres: ["Drama", "Fantasy"], tags: [{ name: "Travel", weight: 70 }], studios: ["MADHOUSE"], score: 85 }),
    anime(4, { title: "Chainsaw Man", genres: ["Action"], score: 82 }),
    anime(5, { title: "Low match", genres: ["Romance"], score: 55, likedShare: 0.3 }),
    anime(6, { title: "Hidden one", genres: ["Fantasy"] }),
    anime(7, { title: "Frieren season 2", relations: [{ type: "PREQUEL", id: "anilist:1" }] }),
    anime(8, { title: "Disliked", genres: ["Ecchi"] }),
    anime(9, { title: "Similar to disliked", genres: ["Ecchi"], score: 75 }),
  ]);
  const links = new Map([
    ["anilist:1", [{ to: "anilist:3", votes: 1191 }, { to: "anilist:5", votes: 3 }, { to: "anilist:6", votes: 500 }, { to: "anilist:7", votes: 900 }, { to: "anilist:2", votes: 50 }]],
    ["anilist:2", [{ to: "anilist:4", votes: 800 }]],
    ["anilist:8", [{ to: "anilist:9", votes: 400 }]],
  ]);
  const ratings = [
    { itemId: "anilist:1", title: "Frieren", score: 9.7, source: "anilist" },
    { itemId: "anilist:2", title: "JJK", score: 9, source: "app" },
    { itemId: "anilist:8", title: "Disliked", score: 4, source: "app" },
  ];
  const result = recommend({ ratings, items, links, hidden: new Set(["anilist:6"]) });
  const ids = result.picks.map((pick) => pick.itemId);
  assert.equal(ids[0], "anilist:3", `top pick ${ids.join(", ")}`);
  assert.ok(ids.includes("anilist:4"));
  for (const left of ["anilist:2", "anilist:6", "anilist:7", "anilist:9"]) assert.ok(!ids.includes(left), `${left} should be left out`);
  const top = result.picks[0];
  assert.ok(top.match > 0.8, `match ${top.match}; bounded public quality is no longer a dominant reason`);
  assert.equal(top.summary, "Because you rated Frieren 9.70");
  assert.deepEqual(top.reasons.find((reason) => reason.kind === "fans").from.map((from) => from.votes), [1191]);
  assert.ok(top.reasons.find((reason) => reason.kind === "shared").names.includes("Fantasy"));
  assert.equal(top.reasons.find((reason) => reason.kind === "studio").name, "MADHOUSE");
  const low = result.picks.find((pick) => pick.itemId === "anilist:5");
  assert.ok(!low || low.match < top.match);
});

test("one pick per show, and planned titles are marked", () => {
  const items = new Map([
    anime(1, { title: "Seed", genres: ["Drama"] }),
    anime(2, { title: "Show season 1", franchiseId: "anilist:2", genres: ["Drama"] }),
    anime(3, { title: "Show movie", franchiseId: "anilist:2", format: "MOVIE", genres: ["Drama"], score: 70 }),
  ]);
  const links = new Map([["anilist:1", [{ to: "anilist:2", votes: 300 }, { to: "anilist:3", votes: 100 }]]]);
  const result = recommend({ ratings: [{ itemId: "anilist:1", title: "Seed", score: 9.5, source: "app" }, { itemId: "anilist:2", status: "PLANNING", source: "anilist" }], items, links });
  assert.deepEqual(result.picks.map((pick) => pick.itemId), ["anilist:2"]);
  assert.ok(result.picks[0].reasons.some((reason) => reason.kind === "planned"));
});

test("the match curve is refitted to your own results once there are enough of them", () => {
  assert.equal(fitCurve([{ raw: 1, liked: true }]).fitted, 1);
  assert.equal(fitCurve([{ raw: 1, liked: true }]).scale, 1);
  // Picks scored high that you then disliked: the curve becomes less confident.
  const outcomes = Array.from({ length: 12 }, (_, index) => ({ raw: 2 + (index % 3) * 0.2, liked: index % 3 === 0 }));
  const curve = fitCurve(outcomes);
  assert.equal(curve.fitted, 12);
  const before = 1 / (1 + Math.exp(-2.2));
  const after = 1 / (1 + Math.exp(-(curve.scale * 2.2 + curve.shift)));
  assert.ok(after < before, `${after} < ${before}`);
  assert.equal(curve.link, DEFAULT_CURVE.link);
});

test("summaries name status-only favorites too", () => {
  assert.equal(reasonSummary([{ kind: "fans", from: [{ title: "A", score: 9.5 }, { title: "B", score: null }] }]), "Because you rated A 9.50 and watched B");
  assert.equal(reasonSummary([{ kind: "shared", names: ["Drama", "Fantasy"] }]), "Drama, Fantasy, like your favorites");
});
