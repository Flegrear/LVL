import test from "node:test";
import assert from "node:assert/strict";
import { watchSidebarPicks } from "../frontend/catalog/watch-discovery.js";

test("Watch sidebar picks are different, genre-related, exclude current and respect limits", () => {
  const catalog = {
    anime: [
      { id: "a", name: "Current", type: "series", genres: ["Mystery"] },
      { id: "b", name: "Shared", type: "series", genres: ["Mystery", "Action"] },
      { id: "b", name: "Duplicate", type: "series", genres: ["Mystery"] },
    ],
    series: [
      { id: "c", name: "Other", type: "series", genres: ["Comedy"] },
      { id: "d", name: "Another", type: "series", genres: ["Mystery"] },
    ],
    movies: [{ id: "e", name: "Movie", type: "movie", genres: ["Mystery"] }],
  };
  const result = watchSidebarPicks(catalog, { id: "a", type: "series", genres: ["Mystery"] }, { relatedLimit: 2, recommendedLimit: 2 });
  assert.deepEqual(result.related.map((item) => item.id), ["b", "d"]);
  assert.deepEqual(result.recommended.map((item) => item.id), ["c", "e"]);
  assert.equal(new Set([...result.related, ...result.recommended].map((item) => item.id)).size, 4);
});

test("Watch sidebar handles empty catalogs, genres and exclusions", () => {
  assert.deepEqual(watchSidebarPicks({}, { id: "abc" }), { related: [], recommended: [] });
  const result = watchSidebarPicks({ series: [{ id: "a", name: "A" }, { id: "b", name: "B" }] },
    { id: "other" }, { excluded: ["a"] });
  assert.equal(result.related.length, 0);
  assert.equal(result.recommended[0].id, "b");
});
