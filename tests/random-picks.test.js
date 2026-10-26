import test from "node:test";
import assert from "node:assert/strict";
import { findSavedRandomTitle, randomPickIdentity, randomPickMatchesCategory, randomSeriesAlreadySeen, verifiedRandomCatalogMatch } from "../frontend/catalog/home-feed.js";

test("Random rejects even one locally started episode, manually watched chapter, and playback history", () => {
  const series = (entry) => ({ key: "apothecary", title: "The Apothecary Diaries", catalogId: "tt1234567", sources: [entry] });
  const started = series({ id: "ep1", episodes: [{ progress: { positionMs: 1400, finished: false } }] });
  assert.equal(randomSeriesAlreadySeen(started), true, "short local progress is enough");
  assert.equal(randomSeriesAlreadySeen(series({ id: "ep1", lastPlayedAt: 180 })), true);
  assert.equal(randomSeriesAlreadySeen(series({ id: "ep1", watchedChapters: { S01E01: true } })), true);
  assert.equal(randomSeriesAlreadySeen(series({ id: "ep1", watchedChapters: { S01E01: 1720000000000 } })), true,
    "the real chapter mark is a timestamp, not a boolean");
  assert.equal(randomSeriesAlreadySeen(series({ id: "ep1", watchedChapters: { S01E01: false } })), false,
    "explicitly unwatched chapter overrides cannot make a title seen");
  assert.equal(randomSeriesAlreadySeen(series({ id: "ep1", episodes: [{ progress: { finished: true, positionMs: 0 } }] })), true);
  assert.equal(randomSeriesAlreadySeen(series({ id: "ep1" }), { activeLibraryId: "ep1" }), true);
  assert.equal(randomSeriesAlreadySeen(series({ id: "ep1" })), false, "saved but never played is still eligible");
});

test("Random honors explicit local tracking plus AniList statuses/progress, but leaves planning accessible", () => {
  const entry = (extra) => ({ title: "Show", ...extra });
  for (const status of ["CURRENT", "PAUSED", "DROPPED", "COMPLETED", "REPEATING"]) {
    assert.equal(randomSeriesAlreadySeen({ sources: [entry({ trackingStatus: status })] }), true);
    assert.equal(randomSeriesAlreadySeen({ sources: [entry({ anilist: { status } })] }), true);
  }
  assert.equal(randomSeriesAlreadySeen({ sources: [entry({ anilist: { status: "PLANNING", seasons: [{ progress: 2 }] } })] }), true);
  assert.equal(randomSeriesAlreadySeen({ sources: [entry({ anilist: { status: "PLANNING", seasons: [{ progress: 0 }] } })] }), false);
});

test("Random detects the same saved title by IMDb, alternate name, or AniList season identifier", () => {
  const saved = [{ key: "apothecary", title: "The Apothecary Diaries", catalogId: "tt1234567", aliases: ["Kusuriya no Hitorigoto"],
    sources: [{ anilist: { anilistId: 123, seasons: [{ anilistId: 553 }] } }] }];
  assert.equal(findSavedRandomTitle(saved, { title: "Kusuriya no Hitorigoto" }), saved[0]);
  assert.equal(findSavedRandomTitle(saved, { imdbId: "tt1234567" }), saved[0]);
  assert.equal(findSavedRandomTitle(saved, { anilistId: 553 }), saved[0]);
  assert.equal(findSavedRandomTitle(saved, { anilistId: 9999 }), null);
});

test("Random prioritizes a watched duplicate when a planning placeholder has the same title", () => {
  const planning = { key: "planned", title: "Frieren: Beyond Journey's End", sources: [{ trackingStatus: "PLANNING" }] };
  const watched = { key: "imported", title: "Frieren Beyond Journeys End", sources: [
    { watchedChapters: { S01E01: 1730000000000 } },
  ] };
  assert.equal(findSavedRandomTitle([planning, watched], { title: "Frieren: Beyond Journey's End" }), watched);
  assert.equal(findSavedRandomTitle([planning, watched], { title: "Frieren Beyond Journeys End" }), watched);
});

test("Anime TV and film recommendations stay in Anime while non-anime Movies and TV are scoped separately", () => {
  const anime = { source: "anilist", type: "movie" };
  const movie = { source: "tmdb", type: "movie" };
  const tv = { source: "tmdb", type: "series" };
  assert.equal(randomPickMatchesCategory(anime, "anime"), true);
  assert.equal(randomPickMatchesCategory(anime, "movie"), false);
  assert.equal(randomPickMatchesCategory(movie, "movie"), true);
  assert.equal(randomPickMatchesCategory(tv, "tv"), true);
  assert.equal(randomPickMatchesCategory(movie, "tv"), false);
  assert.equal(randomPickMatchesCategory(anime, "all"), true);
});

test("Unlinked TMDB recommendation resolves only to a unique IMDb title with matching name, type, and year", () => {
  const pick = { title: "The Office", titleAlt: "The Office (US)", type: "series", year: 2005 };
  const us = { id: "tt0386676", name: "The Office", type: "series", releaseInfo: "2005" };
  const uk = { id: "tt0290978", name: "The Office", type: "series", releaseInfo: "2001" };
  const movie = { id: "tt0775596", name: "The Office", type: "movie", releaseInfo: "2005" };
  assert.equal(verifiedRandomCatalogMatch(pick, [uk, movie, us]), us);
  assert.equal(verifiedRandomCatalogMatch(pick, [us, { ...us, id: "tt1234567" }]), null,
    "two different candidates with the same year cannot be selected by guesswork");
  assert.equal(verifiedRandomCatalogMatch(pick, [uk]), null);
  assert.equal(verifiedRandomCatalogMatch(pick, [movie]), null);
  assert.equal(verifiedRandomCatalogMatch(pick, [{ ...us, name: "The Office: Extended" }]), null);
  assert.equal(verifiedRandomCatalogMatch(pick, [{ ...us, id: "tmdb:123" }]), null);
});

test("Random identity deduplicates different providers' entries with the same verified IMDb ID", () => {
  assert.equal(randomPickIdentity({ itemId: "anilist:1", imdbId: "tt4567891" }),
    randomPickIdentity({ itemId: "tmdb:tv:2", imdbId: "tt4567891" }));
  assert.equal(randomPickIdentity({ source: "anilist", url: "https://anilist.co/anime/1234", itemId: "first" }),
    randomPickIdentity({ source: "anilist", url: "https://anilist.co/anime/1234/some-show", itemId: "second" }));
});
