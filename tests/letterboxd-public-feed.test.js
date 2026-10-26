import test from "node:test";
import assert from "node:assert/strict";
import { fetchLetterboxdFeed, parseLetterboxdRss } from "../backend/integrations/letterboxd.js";

const rss = `<?xml version="1.0"?><rss xmlns:letterboxd="https://letterboxd.com" xmlns:tmdb="https://themoviedb.org"><channel>
<item><letterboxd:filmTitle>Spirited Away</letterboxd:filmTitle><letterboxd:filmYear>2001</letterboxd:filmYear><tmdb:movieId>129</tmdb:movieId><letterboxd:watchedDate>2026-10-19</letterboxd:watchedDate><letterboxd:memberRating>4.5</letterboxd:memberRating></item>
<item><letterboxd:filmTitle>Unrated Film</letterboxd:filmTitle><letterboxd:filmYear>2024</letterboxd:filmYear></item>
</channel></rss>`;

test("public RSS parses real star scores and distinguishes unrated diary films", () => {
  const entries = parseLetterboxdRss(rss);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].score, 9);
  assert.equal(entries[0].itemId, "tmdb:movie:129");
  assert.equal(entries[1].score, null);
});

test("public profiles accept usernames, @handles and official profile URLs without other origins", async () => {
  const seen = [];
  const fetchImpl = async (url) => { seen.push(url); return { ok: true, status: 200, text: async () => rss }; };
  for (const input of ["viewer_1", "@viewer_1", "https://letterboxd.com/viewer_1/"]) {
    const result = await fetchLetterboxdFeed(input, { fetchImpl });
    assert.equal(result.username, "viewer_1");
    assert.equal(result.entries.length, 2);
  }
  assert.equal(seen.length, 3);
  assert.ok(seen.every((url) => url === "https://letterboxd.com/viewer_1/rss/"));
  await assert.rejects(fetchLetterboxdFeed("https://evil.example/viewer_1", { fetchImpl }), /user name/);
  assert.equal(seen.length, 3);
});

test("no diary films or an HTML challenge produces an actionable error instead of silent success", async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => "<rss><channel></channel></rss>" });
  await assert.rejects(fetchLetterboxdFeed("viewer_1", { fetchImpl }), /No recent films/);
  const challenged = async () => ({ ok: true, status: 200, text: async () => "<html>Challenge</html>" });
  await assert.rejects(fetchLetterboxdFeed("viewer_1", { fetchImpl: challenged }), /did not return a public RSS feed/);
});
