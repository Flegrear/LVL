import test from "node:test";
import assert from "node:assert/strict";
import { fetchMatchedPublicAniListSeasons, matchPublicAniListSeasons,
  verifiedPublicAniListLinks } from "../frontend/catalog/title-public-ratings.js";

const tv = (id, title, episodes, year, sequel = null, prequel = null, score = 85) => ({
  id, format: "TV", episodes, seasonYear: year,
  status: episodes == null ? "RELEASING" : "FINISHED", averageScore: score,
  title: { english: title }, relations: { edges: [
    ...(sequel == null ? [] : [{ relationType: "SEQUEL", node: { id: sequel } }]),
    ...(prequel == null ? [] : [{ relationType: "PREQUEL", node: { id: prequel } }]),
  ] },
});

const apothecary = {
  title: "The Apothecary Diaries", year: 2023,
  aliases: ["Kusuriya no Hitorigoto"],
  seasons: [24, 24, 24].map((count, index) => ({ season: index + 1, count })),
};

test("Japanese romaji and English titles resolve to one legitimate Season 3 split cour", async () => {
  const original = tv(161645, "The Apothecary Diaries", 24, 2023, 176301, null, 90);
  const second = tv(176301, "The Apothecary Diaries Season 2", 24, 2025, 195516, 161645, 88);
  const third = tv(195516, "The Apothecary Diaries Season 3", 12, 2026, 215516, 176301, 85);
  third.title.romaji = "Kusuriya no Hitorigoto 3rd Season";
  const partTwo = tv(215516, "", 12, 2027, null, 195516, null);
  partTwo.title.romaji = "Kusuriya no Hitorigoto 3rd Season Part 2";

  const result = await fetchMatchedPublicAniListSeasons(apothecary, {
    fetchTitle: async (name) => name === "The Apothecary Diaries" ? [original, third] : [second],
    fetchSequels: async (ids) => ids.includes(215516) ? [partTwo] : [],
  });
  assert.ok(result);
  assert.deepEqual(result.seasons.map(({ parts }) => parts.map(({ id }) => id)),
    [[161645], [176301], [195516, 215516]]);
  assert.deepEqual(result.seasons[2].parts.map(({ score }) => score), [8.5, null]);
  assert.equal(result.seasons[2].score, null, "An unreleased cour cannot produce a whole-season score");
  assert.equal(result.displayOnly, true);
  assert.deepEqual(verifiedPublicAniListLinks(result, {
    userId: 10, year: 2023, catalogId: "tt0001234",
  }), [], "Public display aliases cannot authorize personal AniList writes");
});

test("an AniList entry whose PREQUEL points to another title cannot be assigned as a sequel", () => {
  const original = tv(100, "The Apothecary Diaries", 12, 2023, 200);
  const unrelated = tv(200, "Kusuriya no Hitorigoto 2nd Season", 12, 2024, null, 900);
  const result = matchPublicAniListSeasons({ title: "The Apothecary Diaries", year: 2023,
    seasons: [{ season: 1, count: 12 }, { season: 2, count: 12 }],
    media: [original, unrelated], allowSynonyms: true });
  assert.deepEqual(result.seasons.map(({ season }) => season), [1],
    "A matching episode count and SEQUEL edge do not override contradictory upstream identity");
});

test("a proposed sequel cannot air before the predecessor it supposedly continues", () => {
  const original = tv(220, "Original", 12, 2025, 221);
  const older = tv(221, "Original: Supposed Part 2", 12, 2023, null, 220);
  const result = matchPublicAniListSeasons({ title: "Original", year: 2025,
    seasons: [{ season: 1, count: 12 }, { season: 2, count: 12 }],
    media: [original, older], allowSynonyms: true });
  assert.deepEqual(result.seasons.map(({ season }) => season), [1]);
});

test("a releasing cour without a known episode count cannot count as zero episodes in a later season", () => {
  const first = tv(300, "Example", 12, 2024, 301);
  const unknown = tv(301, "Example: Part 2", null, 2025, 302, 300);
  const unrelated = tv(302, "Example: Part 3", 12, 2025, null, 301);
  const result = matchPublicAniListSeasons({ title: "Example", year: 2024,
    seasons: [{ season: 1, count: 12 }, { season: 2, count: 12 }],
    media: [first, unknown, unrelated], allowSynonyms: true });
  assert.deepEqual(result.seasons.map(({ season }) => season), [1],
    "Unknown-length cour must not be added to another cour to fabricate a complete season");
});
