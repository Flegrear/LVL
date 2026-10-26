import test from "node:test";
import assert from "node:assert/strict";
import { ANILIST_MANUAL_ID_VERIFY, parseManualAniListId,
  planVerifiedManualAniListSeason } from "../frontend/anilist/anilist-manual-season-link.js";

const meta = { id: "tt1355642", name: "Fullmetal Alchemist: Brotherhood", releaseInfo: "2009–2010",
  seasons: [{ season: 0, count: 20 }, { season: 1, count: 64,
    episodes: [{ episode: 1, released: "2009-04-05" }] }] };
const series = { key: "fma brotherhood", catalogId: "tt1355642" };
const fmab = { id: 5114, format: "TV", episodes: 64, seasonYear: 2009,
  title: { english: "Fullmetal Alchemist: Brotherhood", romaji: "Hagane no Renkinjutsushi: FULLMETAL ALCHEMIST" },
  relations: { edges: [] } };

test("paste accepts exact AniList anime URLs and numeric media IDs, never foreign URLs or scripts", () => {
  for (const text of ["5114", "0005114", "https://anilist.co/anime/5114",
    "anilist.co/anime/5114", "www.anilist.co/anime/5114/Fullmetal-Alchemist-Brotherhood",
    "https://www.anilist.co/anime/5114/Fullmetal-Alchemist-Brotherhood/",
    "http://anilist.co/anime/5114?ref=test#summary"]) assert.equal(parseManualAniListId(text), 5114);
  for (const text of ["", "0", "2147483648", "5114x", "-1", "5114/5", "javascript:alert(1)",
    "https://anilist.co.evil.test/anime/5114", "https://evil.test/anime/5114",
    "https://anilist.co/manga/5114", "https://anilist.co/anime/nope",
    "https://user:pass@anilist.co/anime/5114", "https://anilist.co:8099/anime/5114",
    "https://anilist.co/anime/5114/other/5115"])
    assert.equal(parseManualAniListId(text), null, `Unsafe URL or media ID must be rejected: ${text}`);
  assert.match(ANILIST_MANUAL_ID_VERIFY, /Media\(id: \$id, type: ANIME\)/);
  assert.match(ANILIST_MANUAL_ID_VERIFY, /relations.*edges.*relationType/s);
  assert.doesNotMatch(ANILIST_MANUAL_ID_VERIFY, /SaveMediaListEntry|Mutation|Viewer|MediaListCollection/);
});

test("FMA Brotherhood direct 2009 season maps to exact AniList TV 5114 without changing any personal list", () => {
  const link = planVerifiedManualAniListSeason({ media: fmab, meta, series, accountId: 42, season: 1 });
  assert.deepEqual(link, { userId: 42, season: 1, anilistId: 5114, episodes: 64,
    format: "TV", title: "Fullmetal Alchemist: Brotherhood" });
  for (const candidate of [
    { ...fmab, id: 5115, title: { english: "Fullmetal Alchemist" } },
    { ...fmab, seasonYear: 2003 },
    { ...fmab, episodes: 63 },
    { ...fmab, episodes: null },
    { ...fmab, format: "OVA" },
    { ...fmab, title: { english: "Fullmetal Alchemist: Brotherhood Part 2" } },
  ]) assert.equal(planVerifiedManualAniListSeason({ media: candidate, meta, series, accountId: 42, season: 1 }), null);
  assert.equal(planVerifiedManualAniListSeason({ media: fmab, meta, series, accountId: 42,
    season: 1, linked: { seasons: [{ season: 1, anilistId: 5114 }] } }), null,
  "A linked season must not be overwritten by a pasted ID");
});

test("later complete seasons require a previous trusted link and explicit AniList PREQUEL", () => {
  const catalog = { id: "tt1234567", name: "Next Anime", releaseInfo: "2020–",
    seasons: [{ season: 1, count: 12 }, { season: 2, count: 13,
      episodes: [{ episode: 1, released: "2023-01-01" }] }] };
  const local = { catalogId: "tt1234567" };
  const media = { id: 102, format: "TV", episodes: 13, seasonYear: 2023,
    title: { english: "Another Subtitle" }, relations: { edges: [
      { relationType: "PREQUEL", node: { id: 101, type: "ANIME", format: "TV" } },
    ] } };
  const linked = { seasons: [{ season: 1, anilistId: 101, episodes: 12 }] };
  assert.equal(planVerifiedManualAniListSeason({ media, meta: catalog, series: local,
    accountId: 2, season: 2, linked })?.anilistId, 102);
  for (const [part, prior] of [
    [media, null], [media, { seasons: [{ season: 1, anilistId: 999 }] }],
    [{ ...media, episodes: 12 }, linked],
    [{ ...media, seasonYear: 2018 }, linked],
    [{ ...media, relations: { edges: [] } }, linked],
    [{ ...media, relations: { edges: [
      { relationType: "PREQUEL", node: { id: 101, type: "ANIME", format: "TV" } },
      { relationType: "PREQUEL", node: { id: 103, type: "ANIME", format: "TV" } },
    ] } }, linked],
  ]) assert.equal(planVerifiedManualAniListSeason({ media: part, meta: catalog, series: local,
    accountId: 2, season: 2, linked: prior }), null);
});

test("partial cour, unknown catalog and invalid season/account cannot authorize watched episode mapping", () => {
  const split = { ...meta, seasons: [{ season: 1, count: 48 }] };
  assert.equal(planVerifiedManualAniListSeason({ media: { ...fmab, episodes: 24 }, meta: split,
    series, accountId: 42, season: 1 }), null);
  assert.equal(planVerifiedManualAniListSeason({ media: fmab, meta, series,
    accountId: 0, season: 1 }), null);
  assert.equal(planVerifiedManualAniListSeason({ media: fmab, meta, series,
    accountId: 42, season: 2 }), null);
  assert.equal(planVerifiedManualAniListSeason({ media: fmab, meta: { ...meta, id: "tt0123456" },
    series, accountId: 42, season: 1 }), null);
  assert.equal(planVerifiedManualAniListSeason({ media: fmab, meta: { ...meta,
    seasons: [{ season: 2, count: 64 }] }, series, accountId: 42, season: 1 }), null);
});
