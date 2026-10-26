import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { ANILIST_PUBLIC_TITLE_QUERY, ANILIST_PUBLIC_SEQUELS_QUERY, eligibleForPublicAnimeRating, fetchPublicAniListTitle, fetchPublicAniListSequels,
  fetchMatchedPublicAniListSeasons, matchPublicAniListSeasons, publicCatalogSeasonCounts,
  verifiedPublicAniListLinks } from "../frontend/catalog/title-public-ratings.js";
import { escapeHtml, icon } from "../frontend/ui/ui.js";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../frontend/styles/styles.css", import.meta.url), "utf8");

const mediaPart = (id, episodes, score, sequel = null, title = "Season part", year = 2020) => ({
  id, episodes, averageScore: score, seasonYear: year, format: "TV",
  title: { english: title }, coverImage: { medium: `https://s4.anilist.co/file/${id}.jpg` },
  relations: { edges: sequel ? [{ relationType: "SEQUEL", node: { id: sequel } }] : [] },
});

const jojo = [
  mediaPart(14719, 26, 77, 20474, "JoJo's Bizarre Adventure (TV)", 2012),
  mediaPart(20474, 24, 79, 20799, "Stardust Crusaders", 2014),
  mediaPart(20799, 24, 83, 21450, "Stardust Crusaders: Battle in Egypt", 2015),
  mediaPart(21450, 39, 84, 102883, "Diamond is Unbreakable", 2016),
  mediaPart(102883, 39, 85, 131942, "Golden Wind", 2018),
  { ...mediaPart(131942, 12, 80, 146722, "STONE OCEAN", 2021), format: "ONA" },
  { ...mediaPart(146722, 26, 82, 190327, "STONE OCEAN Part 2", 2022), format: "ONA" },
  { ...mediaPart(190327, 1, 87, 210482, "STEEL BALL RUN 1st STAGE", 2026), format: "ONA" },
  { ...mediaPart(210482, 11, 85, null, "STEEL BALL RUN 2nd STAGE", 2026), format: "ONA" },
  { ...mediaPart(666, 6, 72, null, "JoJo's Bizarre Adventure", 1993), format: "OVA" },
];
const catalog = {
  title: "JoJo's Bizarre Adventure", year: 2012,
  seasons: [26, 48, 39, 39, 38, 12].map((count, i) => ({ season: i + 1, count })),
};

// Cinemeta splits Gintama's initial 201-episode AniList series into four
// complete catalog seasons. These are PUBLIC ratings, not sync identities.
const gintama = {
  title: "Gintama", year: 2005,
  seasons: [49, 50, 51, 51, 51, 13, 51, 12, 13, 26]
    .map((count, index) => ({ season: index + 1, count })),
};
const gintamaParts = [
  mediaPart(918, 201, 85, 9969, "Gintama", 2006),
  mediaPart(9969, 51, 89, 15417, "Gintama Season 2", 2011),
  { ...mediaPart(15417, 13, 89, 20996, "Gintama Season 2 Part 2", 2012),
    relations: { edges: [{ relationType: "SEQUEL", node: { id: 20996 } },
      { relationType: "SEQUEL", node: { id: 15335 } }] } },
  { ...mediaPart(15335, 1, 87, null, "Gintama Movie", 2013), format: "MOVIE" },
  mediaPart(20996, 51, 90, 97889, "Gintama Season 3", 2015),
  mediaPart(97889, 12, 89, 99714, "Gintama Season 4", 2017),
  mediaPart(99714, 13, 82, 100784, "Gintama: Slip Arc", 2017),
  mediaPart(100784, 12, 86, 101925, "Gintama: Silver Soul Arc", 2018),
  mediaPart(101925, 14, 88, null, "Gintama: Silver Soul Arc Part 2", 2018),
];

// Live public identity and release structure, 2026-10-25: Cinemeta IMDb
// tt7441658 treats the 170-episode original as season 1 and the 2026 sequel as
// season 2. AniList #195604 has a public score but episodes=null while airing.
const blackCloverOriginal = { ...mediaPart(97940, 170, 79, 195604, "Black Clover", 2017), status: "FINISHED" };
const blackCloverSequel = { ...mediaPart(195604, 13, 87, null, "Black Clover Season 2", 2026),
  episodes: null, status: "RELEASING" };
const blackCloverCatalog = {
  title: "Black Clover", year: 2017,
  seasons: [
    { season: 1, count: 170, episodes: [{ episode: 1, released: "2017-10-03" }] },
    { season: 2, count: 13, episodes: [{ episode: 1, released: "2026-10-03" }] },
  ],
};

const lord = {
  ...mediaPart(137667, 13, 85, null, "Lord of Mysteries", 2025),
  format: "ONA",
  title: { english: "Lord of Mysteries", romaji: "Guimi Zhi Zhu: Xiaochou Pian", native: "诡秘之主 小丑篇" },
  synonyms: ["Lord of the Mysteries", "LOTM", "Lord of Mysteries: The Clown"],
};

test("Lord of Mysteries donghua is eligible despite China rather than Japan, without including Western cartoons", () => {
  assert.equal(eligibleForPublicAnimeRating({ genres: ["Animation", "Action"], country: "China" }), true);
  assert.equal(eligibleForPublicAnimeRating({ genres: ["Animation"], country: "Japan" }), true);
  assert.equal(eligibleForPublicAnimeRating({ mediaKind: "anime" }), true);
  assert.equal(eligibleForPublicAnimeRating({ genres: ["Animation"], country: "United States" }), false);
  assert.equal(eligibleForPublicAnimeRating({ genres: ["Drama"], country: "China" }), false);
  assert.match(app, /eligibleForPublicAnimeRating\(\{ mediaKind: subject\.series\?\.mediaKind,/);
  assert.match(app.slice(app.indexOf("function titleRatingSubject("), app.indexOf("\nfunction renderTitlePage(", app.indexOf("function titleRatingSubject("))),
    /eligibleForPublicAnimeRating\(\{ mediaKind: subject\.series\?\.mediaKind,/,
    "Chinese anime must also be classified as anime in the personal rating editor; actual remote writes remain mapping-gated");
  assert.match(app, /fetchMatchedPublicAniListSeasons\(\{ title: name, aliases, year, seasons \}\)/);
});

test("Lord of the Mysteries synonym has the correct 2025, 13-episode community rating, while auto-links stay strict", () => {
  const input = { title: "Lord of the Mysteries", year: 2025, seasons: [{ season: 1, count: 13 }], media: [lord] };
  assert.equal(matchPublicAniListSeasons(input), null, "Default matching must not broaden authenticated auto-links");
  const result = matchPublicAniListSeasons({ ...input, allowSynonyms: true });
  assert.equal(result.score, 8.5);
  assert.deepEqual(result.seasons[0].parts.map((part) => part.id), [137667]);
  assert.equal(matchPublicAniListSeasons({ ...input, seasons: [{ season: 1, count: 12 }], allowSynonyms: true }), null);
  assert.equal(matchPublicAniListSeasons({ ...input, year: 2022, allowSynonyms: true }), null);
  assert.equal(matchPublicAniListSeasons({ ...input, media: [lord, { ...lord, id: 222 }],
    allowSynonyms: true }), null, "Two plausible roots must not be arbitrarily selected");
  assert.equal(matchPublicAniListSeasons({ ...input, title: "Not the same anime", allowSynonyms: true }), null);
});

test("Public lookup retries alternate catalog names without sending tokens or changing AniList progress", async () => {
  const lookedUp = [];
  const match = await fetchMatchedPublicAniListSeasons({
    title: "Mysteries of Klein", aliases: ["Lord of the Mysteries", "Lord of Mysteries"],
    year: 2025, seasons: [{ season: 1, count: 13 }],
  }, { fetchTitle: async (name) => {
    lookedUp.push(name);
    return name === "Lord of the Mysteries" ? [lord] : [];
  } });
  assert.deepEqual(lookedUp, ["Mysteries of Klein", "Lord of the Mysteries", "Lord of Mysteries"]);
  assert.equal(match.score, 8.5);
  assert.equal(await fetchMatchedPublicAniListSeasons({
    title: "Mysteries of Klein", aliases: ["Lord of the Mysteries"],
    year: 2025, seasons: [{ season: 1, count: 12 }],
  }, { fetchTitle: async () => [lord] }), null, "Alias alone cannot bypass episode validation");
});

test("A later alias can supply a renamed sequel rather than locking the public badge to season one", async () => {
  const first = mediaPart(101, 12, 80, 102, "Alpha", 2025);
  const second = mediaPart(102, 12, 90, null, "Othername: Continuation", 2026);
  const searched = [];
  const result = await fetchMatchedPublicAniListSeasons({
    title: "Alpha", aliases: ["Alpha alternate name"],
    year: 2025, seasons: [{ season: 1, count: 12 }, { season: 2, count: 12 }],
  }, { fetchTitle: async (name) => {
    searched.push(name);
    return name === "Alpha" ? [first] : [second];
  }, fetchSequels: async () => { throw Error("All parts already found"); } });
  assert.deepEqual(searched, ["Alpha", "Alpha alternate name"]);
  assert.equal(result.seasons.length, 2);
  assert.equal(result.score, 8.5);
  assert.deepEqual(verifiedPublicAniListLinks(result, { userId: 42, year: 2025, catalogId: "tt1234567" }), [],
    "Fuzzy synonym/alias discovery is public display only");
});

test("Another title alias revealing a second matching root must block guessing a score", async () => {
  const first = mediaPart(201, 13, 82, null, "Alpha", 2025);
  const second = mediaPart(202, 13, 95, null, "Beta", 2025);
  const result = await fetchMatchedPublicAniListSeasons({
    title: "Alpha", aliases: ["Beta"], year: 2025, seasons: [{ season: 1, count: 13 }],
  }, { fetchTitle: async (name) => name === "Alpha" ? [first] : [second] });
  assert.equal(result, null);
});

test("First catalog season may be two verified AniList cours for display, never for guessed auto-progress", () => {
  const first = mediaPart(301, 12, 80, 302, "Split First Season", 2025);
  const second = mediaPart(302, 12, 90, null, "Split First Season Part 2", 2025);
  const args = { title: "Split First Season", year: 2025, seasons: [{ season: 1, count: 24 }],
    media: [first, second] };
  assert.equal(matchPublicAniListSeasons(args), null, "Authenticated default still demands an exact first entry");
  const display = matchPublicAniListSeasons({ ...args, allowSynonyms: true });
  assert.equal(display.score, 8.5);
  assert.deepEqual(display.seasons[0].parts.map((part) => part.id), [301, 302]);
  assert.deepEqual(verifiedPublicAniListLinks(display, { userId: 42, year: 2025, catalogId: "tt1234567" }), []);
  assert.equal(matchPublicAniListSeasons({ ...args, media: [first, { ...second, episodes: 10 }],
    allowSynonyms: true }), null, "A missing two episodes never counts as a verified season");
});

test("CJK-only aliases resolve exactly, and unseen branches cannot be treated as unique sequels", () => {
  const original = mediaPart(401, 12, 83, null, "Other show", 2025);
  original.title = { native: "诡秘之主" };
  assert.equal(matchPublicAniListSeasons({ media: [original], title: "诡秘之主",
    year: 2025, seasons: [{ season: 1, count: 12 }], allowSynonyms: true }).score, 8.3);
  assert.equal(matchPublicAniListSeasons({ media: [original], title: "别的动漫",
    year: 2025, seasons: [{ season: 1, count: 12 }], allowSynonyms: true }), null);
  const branched = mediaPart(402, 12, 80, null, "Branching Show", 2025);
  branched.relations.edges = [{ relationType: "SEQUEL", node: { id: 403 } },
    { relationType: "SEQUEL", node: { id: 404 } }];
  const known = mediaPart(403, 12, 90, null, "Only fetched branch", 2026);
  const match = matchPublicAniListSeasons({ media: [branched, known], title: "Branching Show",
    year: 2025, seasons: [{ season: 1, count: 12 }, { season: 2, count: 12 }],
    allowSynonyms: true });
  assert.equal(match.seasons.length, 1, "An unseen alternate branch prevents misleading season two");
});

test("Public title spellings match &/and and roman sequel numerals without weakening auto-link defaults", () => {
  const item = mediaPart(410, 13, 88, null, "Sword & Spell II", 2024);
  const params = { media: [item], title: "Sword and Spell 2",
    year: 2024, seasons: [{ season: 1, count: 13 }] };
  assert.equal(matchPublicAniListSeasons(params), null);
  assert.equal(matchPublicAniListSeasons({ ...params, allowSynonyms: true }).score, 8.8);
  assert.equal(matchPublicAniListSeasons({ ...params, title: "Sword and Spell 3", allowSynonyms: true }), null);
});

test("Catalog episode duplicates are removed only for a complete, numbered display metadata list", () => {
  const seasons = publicCatalogSeasonCounts([
    { season: 0, count: 2, episodes: [{ episode: 1 }, { episode: 2 }] },
    { season: 1, count: 4, episodes: [{ episode: 1 }, { episode: 2 }, { episode: 2 }, { episode: 3 }] },
    { season: 2, count: 5, episodes: [{ episode: 1 }, { episode: 2 }] },
    { season: 3, count: 2, episodes: [{ episode: 1 }, { episode: null }] },
    { season: 4, count: 4, episodes: [{ episode: 1 }, { episode: 3 }, { episode: 3 }, { episode: 4 }] },
  ]);
  assert.deepEqual(seasons.map((s) => s.count), [2, 3, 5, 2, 4],
    "A duplicate does not prove a valid smaller catalog count if another episode number is missing");
  assert.match(app, /publicCatalogSeasonCounts\(meta\.seasons\)/);
  assert.match(app, /existing\.rating\?\.score && existing\.rating\?\.seasons\?\.length === existing\.rating\?\.totalSeasons/,
    "Unmatched public ratings should recheck sooner than successful cached ratings");
});

test("Anonymous sequel-by-ID lookup expands missing sequel records and enforces request bounds", async () => {
  assert.match(ANILIST_PUBLIC_SEQUELS_QUERY, /media\(id_in: \$ids, type: ANIME\)/);
  const root = mediaPart(501, 12, 79, 502, "Another series", 2024);
  const sequel = mediaPart(502, 12, 87, null, "Completely different sequel name", 2025);
  const requests = [];
  const result = await fetchMatchedPublicAniListSeasons({
    title: "Another series", year: 2024,
    seasons: [{ season: 1, count: 12 }, { season: 2, count: 12 }],
  }, {
    fetchTitle: async () => [root],
    fetchSequels: async (ids) => { requests.push([...ids]); return [sequel]; },
  });
  assert.deepEqual(requests, [[502]]);
  assert.equal(result.seasons.length, 2);
  assert.equal(result.score, 8.3);
  const fetched = [];
  const records = await fetchPublicAniListSequels([501, 501, -1, 502], { fetchImpl: async (url, init) => {
    fetched.push({ url, init: JSON.parse(init.body), headers: init.headers });
    return { ok: true, json: async () => ({ data: { Page: { media: [sequel] } } }) };
  } });
  assert.equal(records[0].id, 502);
  assert.deepEqual(fetched[0].init.variables.ids, [501, 502]);
  assert.equal(fetched[0].url, "https://graphql.anilist.co");
  assert.deepEqual(fetched[0].headers, { "Content-Type": "application/json", Accept: "application/json" });
  assert.ok(!/SaveMediaListEntry|Viewer|MediaListCollection/.test(fetched[0].init.query));
});

test("When anonymous sequel detail requests fail, confirmed season one remains visible but partial", async () => {
  const root = mediaPart(701, 12, 80, 702, "Public Partial", 2025);
  const result = await fetchMatchedPublicAniListSeasons({
    title: "Public Partial", year: 2025,
    seasons: [{ season: 1, count: 12 }, { season: 2, count: 12 }],
  }, {
    fetchTitle: async () => [root],
    fetchSequels: async () => { throw new Error("Rate limited"); },
  });
  assert.equal(result.seasons.length, 1);
  assert.equal(result.totalSeasons, 2);
  assert.equal(result.score, 8);
});

test("Long renamed sequel chains can cover all six catalog seasons under bounded anonymous lookups", async () => {
  const root = { ...jojo[0], relations: { edges: [{ relationType: "SEQUEL", node: { id: jojo[1].id } }] } };
  const fetched = [];
  const result = await fetchMatchedPublicAniListSeasons(catalog, {
    fetchTitle: async () => [root],
    fetchSequels: async (ids) => {
      fetched.push(ids[0]);
      return jojo.filter((part) => ids.includes(part.id));
    },
  });
  assert.ok(result);
  assert.equal(result.seasons.length, 6);
  assert.deepEqual(result.seasons.map((s) => s.parts.map((part) => part.id)),
    [[14719], [20474, 20799], [21450], [102883], [131942, 146722], [190327, 210482]]);
  assert.equal(fetched.length, 8, "Eight unique relation hops retrieve nine parts");
  assert.equal(Number(result.score.toFixed(1)), 8.2);
});

test("Gintama public score spans 201 episodes across four catalog seasons without inventing distinct AniList entries", async () => {
  const matched = matchPublicAniListSeasons({ ...gintama, media: gintamaParts, allowSynonyms: true });
  assert.ok(matched);
  assert.equal(matched.totalSeasons, 10);
  assert.equal(matched.seasons.length, 10);
  assert.deepEqual(matched.seasons.slice(0, 4).map((row) => row.parts[0].id), [918, 918, 918, 918]);
  assert.deepEqual(matched.seasons.slice(0, 4).map((row) => row.sharedSeasons),
    Array.from({ length: 4 }, () => [1, 2, 3, 4]));
  assert.deepEqual(matched.seasons.slice(4).map((row) => row.parts.map((part) => part.id)),
    [[9969], [15417], [20996], [97889], [99714], [100784, 101925]]);
  assert.ok(matched.score > 8 && matched.score < 9);
  assert.equal(matchPublicAniListSeasons({ ...gintama, media: gintamaParts }), null,
    "Authenticated automatic mapping must still reject differing season boundaries");
  assert.deepEqual(verifiedPublicAniListLinks(matched, { userId: 42, year: 2005, catalogId: "tt0988818" }), [],
    "Public Gintama mapping cannot authorize a write to AniList");
  const ctx = vm.createContext({ icon, escapeHtml, Number });
  const from = app.indexOf("function titleRatingBreakdownMarkup(");
  const to = app.indexOf("\nfunction titleTrailerUrl(", from);
  vm.runInContext(app.slice(from, to), ctx);
  const rendered = vm.runInContext("titleAniListRatingMarkup", ctx)(matched);
  assert.match(rendered, /data-title-rating-provider="AniList"/);
  assert.match(rendered, /Seasons 1–4[\s\S]*8\.5\/10/);
  assert.match(rendered, /One AniList series covers all 4 catalog seasons \(201 episodes\)/);
  assert.equal((rendered.match(/class="title-rating-season"/g) || []).length, 7,
    "Gintama's ten catalog seasons include one shared four-season row and six later season rows");
  assert.equal((rendered.match(/<span>Gintama<\/span>/g) || []).length, 1,
    "The single 201-episode root AniList artwork and score must not repeat four times");
  assert.doesNotMatch(rendered, /catalog seasons · Scroll for more|Mean of rated seasons|LVL Season/);
  assert.match(rendered, /Season 5[\s\S]*8\.9\/10/);
  assert.match(rendered, /Season 10[\s\S]*Silver Soul Arc Part 2/);
});

test("Black Clover's airing 2026 sequel with unknown episode total gets a separate public Season 2 rating", async () => {
  const requested = [];
  const result = await fetchMatchedPublicAniListSeasons(blackCloverCatalog, {
    fetchTitle: async () => [blackCloverOriginal],
    fetchSequels: async (ids) => { requested.push([...ids]); return [blackCloverSequel]; },
  });
  assert.deepEqual(requested, [[195604]], "Only the original's explicit sequel is looked up");
  assert.equal(result.displayOnly, true);
  assert.equal(result.totalSeasons, 2);
  assert.deepEqual(result.seasons.map((item) => [item.season, item.score, item.parts[0].id]),
    [[1, 7.9, 97940], [2, 8.7, 195604]]);
  assert.equal(result.seasons[1].parts[0].episodes, null, "Unknown total must not be invented as 13");
  assert.equal(Number(result.score.toFixed(1)), 8.3);
  assert.deepEqual(verifiedPublicAniListLinks(result, { userId: 42, year: 2017, catalogId: "tt7441658" }), [],
    "Public airing scores must never authorize AniList progress links");
  const ctx = vm.createContext({ icon, escapeHtml, Number });
  const from = app.indexOf("function titleRatingBreakdownMarkup(");
  const to = app.indexOf("\nfunction titleTrailerUrl(", from);
  vm.runInContext(app.slice(from, to), ctx);
  const html = vm.runInContext("titleAniListRatingMarkup", ctx)(result);
  assert.match(html, /Season 1[\s\S]*Black Clover[\s\S]*7\.9\/10/);
  assert.match(html, /Season 2[\s\S]*Black Clover Season 2[\s\S]*8\.7\/10/);
});

test("An unannounced episode total never justifies a sequel in the wrong catalog season or year", () => {
  const verified = matchPublicAniListSeasons({ ...blackCloverCatalog,
    media: [blackCloverOriginal, blackCloverSequel], allowSynonyms: true });
  assert.deepEqual(verified.seasons.map((item) => item.season), [1, 2]);
  const onlyFirst = (seasons, sequel = blackCloverSequel, original = blackCloverOriginal) => {
    const match = matchPublicAniListSeasons({ ...blackCloverCatalog, seasons,
      media: [original, sequel], allowSynonyms: true });
    assert.ok(match);
    assert.deepEqual(match.seasons.map((item) => item.season), [1]);
  };
  onlyFirst([{ season: 1, count: 170 }, { season: 2, count: 13 }],
    blackCloverSequel, blackCloverOriginal);
  onlyFirst([{ season: 1, count: 170 },
    { season: 2, count: 13, episodes: [{ episode: 1, released: "2018-10-03" }] }]);
  onlyFirst(blackCloverCatalog.seasons, { ...blackCloverSequel, status: "NOT_YET_RELEASED" });
  onlyFirst(blackCloverCatalog.seasons, { ...blackCloverSequel, seasonYear: 2025 });
  onlyFirst(blackCloverCatalog.seasons, { ...blackCloverSequel, format: "MOVIE" });
  onlyFirst(blackCloverCatalog.seasons, blackCloverSequel,
    { ...blackCloverOriginal, relations: { edges: [] } });
  const strict = matchPublicAniListSeasons({ ...blackCloverCatalog,
    media: [blackCloverOriginal, blackCloverSequel] });
  assert.deepEqual(strict.seasons.map((item) => item.season), [1],
    "Strict auto-link matching must not accept an unknown episode count");
});

test("Black Clover's 2018-style original split stays separate from the 2026 sequel", () => {
  const seasons = [51, 51, 52, 16, 13].map((count, index) => ({
    season: index + 1, count,
    episodes: [{ episode: 1, released: index === 4 ? "2026-10-03" : `${2017 + index}-10-03` }],
  }));
  const result = matchPublicAniListSeasons({ ...blackCloverCatalog, seasons,
    media: [blackCloverOriginal, blackCloverSequel], allowSynonyms: true });
  assert.deepEqual(result.seasons.map((item) => item.season), [1, 2, 3, 4, 5]);
  assert.deepEqual(result.seasons.slice(0, 4).map((item) => item.sharedSeasons),
    Array.from({ length: 4 }, () => [1, 2, 3, 4]));
  assert.deepEqual(result.seasons.map((item) => item.parts[0].id), [97940, 97940, 97940, 97940, 195604]);
  const ambiguous = matchPublicAniListSeasons({ ...blackCloverCatalog,
    media: [{ ...blackCloverOriginal, relations: { edges: [
      { relationType: "SEQUEL", node: { id: 195604 } },
      { relationType: "SEQUEL", node: { id: 888888 } },
    ] } }, blackCloverSequel,
    { ...blackCloverSequel, id: 888888, title: { english: "Alternate TV sequel" } }],
    allowSynonyms: true });
  assert.deepEqual(ambiguous.seasons.map((item) => item.season), [1],
    "Two valid TV sequels are ambiguous even when both are currently airing");
});

test("rating popovers choose visible viewport space and their hero does not clip long Gintama lists", () => {
  const start = app.indexOf("function positionTitleRatingBreakdown(");
  const end = app.indexOf("\nfunction titleRatingMarkup(", start);
  assert.ok(start >= 0 && end > start);
  const ctx = vm.createContext({ window: { innerHeight: 650, innerWidth: 766 },
    document: { documentElement: { clientWidth: 766 } } });
  vm.runInContext(app.slice(start, end), ctx);
  const state = { below: null, available: "" };
  const badge = { getBoundingClientRect: () => ({ top: 30, bottom: 60, left: 650, right: 760 }) };
  const popup = { getBoundingClientRect: () => ({ width: 392 }), style: { setProperty: (name, value) => {
    assert.equal(name, "--rating-available-height"); state.available = value;
  } } };
  const wrap = {
    dataset: { titleRatingProvider: "IMDb" },
    querySelector: (selector) => selector === "summary" ? badge : popup,
    classList: { toggle: (name, enabled) => {
      assert.equal(name, "is-below"); state.below = enabled;
    } },
  };
  ctx.positionTitleRatingBreakdown(wrap);
  assert.equal(state.below, true);
  assert.equal(state.available, "578px");
  assert.equal(popup.style.left, "-292px", "Rightmost badges must not push their dropdown beyond the viewport");
  assert.equal(popup.style.right, "auto");
  badge.getBoundingClientRect = () => ({ top: 580, bottom: 612, left: 24, right: 134 });
  ctx.positionTitleRatingBreakdown(wrap);
  assert.equal(state.below, false);
  assert.equal(state.available, "568px");
  assert.equal(popup.style.left, "0px", "Leftmost badges keep their normal aligned position");
  badge.getBoundingClientRect = () => ({ top: 580, bottom: 612, left: 400, right: 510 });
  popup.getBoundingClientRect = () => ({ width: 365 });
  wrap.dataset.titleRatingProvider = "LVL";
  ctx.positionTitleRatingBreakdown(wrap);
  assert.equal(popup.style.left, "-255px", "LVL popup anchors to the right edge of its badge");
  assert.match(css, /\.title-hero\s*\{[^}]*overflow:visible;/,
    "Hero must not crop the rating popover at its top boundary");
  assert.match(css, /\.title-hero__media\s*\{[^}]*overflow:hidden;/,
    "Backdrop artwork must stay clipped even while popovers escape the hero");
  assert.match(css, /\.title-rating-wrap\.is-below > \.title-rating-breakdown/);
  assert.match(css, /max-height:min\(420px,var\(--rating-available-height,65vh\)\)/);
});

test("IMDb, AniList and LVL rating popovers share a black surface and cannot remain open together", () => {
  const start = app.indexOf("function keepTitleRatingExclusive(");
  const end = app.indexOf("\nfunction titleRatingMarkup(", start);
  assert.ok(start >= 0 && end > start);
  const ctx = vm.createContext({});
  vm.runInContext(app.slice(start, end), ctx);
  const wraps = [{ open: true }, { open: true }, { open: true }];
  const container = { querySelectorAll: (selector) => {
    assert.equal(selector, ".title-rating-wrap[open]");
    return wraps.filter((wrap) => wrap.open);
  } };
  wraps.forEach((wrap) => { wrap.closest = (selector) => {
    assert.equal(selector, ".title-hero__scores");
    return container;
  }; });
  ctx.keepTitleRatingExclusive(wraps[1]);
  assert.deepEqual(wraps.map((wrap) => wrap.open), [false, true, false]);
  wraps[2].open = true;
  ctx.keepTitleRatingExclusive(wraps[2]);
  assert.deepEqual(wraps.map((wrap) => wrap.open), [false, false, true]);
  assert.match(app, /addEventListener\("toggle", \(event\) => \{[\s\S]*?keepTitleRatingExclusive\(wrap\);[\s\S]*?\}, true\)/);
  assert.match(css, /\.title-rating-breakdown\s*\{[^}]*background:#000;/);
  assert.match(css, /\.title-rating-breakdown__heading\s*\{[^}]*background:#000;/);
  assert.match(css, /\.title-hero__scores:has\(\.title-rating-wrap\[open\]\)[^\{]*\{ visibility:hidden; opacity:0; pointer-events:none; \}/);
});

test("a pointer outside ratings and Escape close the open dropdown without dismissing clicks inside it", () => {
  const from = app.indexOf("// Native details stay open after a click elsewhere;");
  const to = app.indexOf('$("#title-hero")?.addEventListener("toggle",', from);
  assert.ok(from > 0 && to > from);
  const events = {};
  const wraps = [{ open: true }, { open: false }];
  const inside = {};
  const scores = { contains: (target) => target === inside,
    querySelectorAll: () => wraps.filter((wrap) => wrap.open) };
  const hero = { addEventListener: (name, handler) => { events[name] = handler; },
    querySelectorAll: () => wraps.filter((wrap) => wrap.open) };
  vm.runInNewContext(app.slice(from, to), {
    document: { addEventListener: (name, handler) => { events[name] = handler; } },
    $: (selector) => selector.includes(".title-hero__scores") ? scores : hero,
  });
  events.pointerdown({ target: inside });
  assert.equal(wraps[0].open, true);
  events.pointerdown({ target: {} });
  assert.equal(wraps[0].open, false);
  wraps[1].open = true;
  let prevented = false;
  events.keydown({ key: "Escape", currentTarget: hero, preventDefault: () => { prevented = true; } });
  assert.equal(wraps[1].open, false);
  assert.equal(prevented, true);
  assert.match(css, /\.title-rating-wrap\[open\] > \.title-rating-breakdown \{ visibility:visible;/);
});

test("Gintama read-only GraphQL expansion skips verified movie branches but stops on ambiguous TV continuations", async () => {
  const fetched = [];
  const result = await fetchMatchedPublicAniListSeasons(gintama, {
    fetchTitle: async () => [gintamaParts[0], gintamaParts[1], gintamaParts[2], gintamaParts[4], gintamaParts[5], gintamaParts[6]],
    fetchSequels: async (ids) => {
      fetched.push([...ids]);
      return gintamaParts.filter((part) => ids.includes(part.id));
    },
  });
  assert.ok(result);
  assert.equal(result.seasons.length, 10);
  assert.ok(fetched.some((ids) => ids.includes(15335)), "Must inspect a movie branch before excluding it");
  assert.ok(fetched.some((ids) => ids.includes(101925)), "Fetches finale cour by exact explicit relation");
  const alternate = { ...gintamaParts[3], id: 888888, format: "TV", episodes: 51 };
  const ambiguous = { ...gintamaParts[2], relations: { edges: [
    { relationType: "SEQUEL", node: { id: 20996 } }, { relationType: "SEQUEL", node: { id: alternate.id } },
  ] } };
  const rejected = matchPublicAniListSeasons({ ...gintama,
    media: [...gintamaParts.filter((part) => part.id !== 15417), ambiguous, alternate], allowSynonyms: true });
  assert.equal(rejected.seasons.length, 6, "Multiple plausible TV sequels must never extend public scores by guessing");
});

test("a mismatched long Gintama run cannot be divided across partial catalog seasons", () => {
  const bad = matchPublicAniListSeasons({ ...gintama,
    seasons: [{ season: 1, count: 49 }, { season: 2, count: 49 }, { season: 3, count: 51 },
      { season: 4, count: 51 }, ...gintama.seasons.slice(4) ],
    media: gintamaParts, allowSynonyms: true });
  assert.equal(bad, null, "A 201-episode root does not align with a 200-episode catalog prefix");
});

test("a 201-episode run must not span catalog seasons with missing or duplicate season numbers", () => {
  const rootOnly = [gintamaParts[0]];
  const withGap = matchPublicAniListSeasons({ ...gintama,
    seasons: [{ season: 1, count: 49 }, { season: 3, count: 50 },
      { season: 4, count: 51 }, { season: 5, count: 51 }],
    media: rootOnly, allowSynonyms: true });
  assert.equal(withGap, null, "Season 2 is missing, so 49+50+51+51 is not one verified 201-episode run");
  const duplicate = matchPublicAniListSeasons({ ...gintama,
    seasons: [{ season: 1, count: 49 }, { season: 1, count: 50 },
      { season: 2, count: 51 }, { season: 3, count: 51 }],
    media: rootOnly, allowSynonyms: true });
  assert.equal(duplicate, null, "Duplicate season 1 must not count as the second season of a run");
});

test("an unavailable middle catalog season stops public sequel assignment before later numbered seasons", () => {
  const first = mediaPart(801, 12, 80, 802, "Incomplete Catalog", 2025);
  const second = mediaPart(802, 12, 90, null, "Continuation", 2026);
  const mapped = matchPublicAniListSeasons({ media: [first, second],
    title: "Incomplete Catalog", year: 2025,
    seasons: [{ season: 1, count: 12 }, { season: 3, count: 12 }],
    allowSynonyms: true });
  assert.deepEqual(mapped.seasons.map((row) => row.season), [1],
    "A sequel for season 2 must not be relabeled as season 3");
  assert.equal(mapped.totalSeasons, 2);
  assert.equal(matchPublicAniListSeasons({ media: [first], title: "Incomplete Catalog", year: 2025,
    seasons: [{ season: 2, count: 12 }], allowSynonyms: true }), null,
  "A catalog starting at season 2 cannot identify the original AniList season 1");
});

test("Partial part ratings cannot falsely count as a completely scored catalog season", () => {
  const first = mediaPart(601, 12, 90, 602, "Ratings With A Missing Cour", 2025);
  const second = mediaPart(602, 12, null, null, "Part 2", 2025);
  const mapped = matchPublicAniListSeasons({ media: [first, second],
    title: "Ratings With A Missing Cour", year: 2025,
    seasons: [{ season: 1, count: 24 }], allowSynonyms: true });
  assert.equal(mapped.seasons[0].parts[0].score, 9);
  assert.equal(mapped.seasons[0].parts[1].score, null);
  assert.equal(mapped.seasons[0].score, null);
  assert.equal(mapped.score, null);
});

test("public JoJo AniList scores map verified sequel parts to 6 catalog seasons without double-weighting a split cour", () => {
  const mapped = matchPublicAniListSeasons({ ...catalog, media: jojo });
  assert.ok(mapped);
  assert.equal(mapped.totalSeasons, 6);
  assert.equal(mapped.ratedSeasons, 6);
  assert.deepEqual(mapped.seasons.map((row) => row.parts.map((part) => part.id)),
    [[14719], [20474, 20799], [21450], [102883], [131942, 146722], [190327, 210482]]);
  assert.deepEqual(mapped.seasons.map((row) => Number(row.score.toFixed(1))), [7.7, 8.1, 8.4, 8.5, 8.1, 8.6]);
  assert.equal(Number(mapped.score.toFixed(1)), 8.2, "Equal weight per catalog season, not per AniList cour");
  assert.ok(mapped.seasons[0].parts[0].cover.includes("14719"));
});

test("automatic progress links need the complete verified chain and carry exact split-cour offsets", () => {
  const match = matchPublicAniListSeasons({ ...catalog, media: jojo });
  const links = verifiedPublicAniListLinks(match, { userId: 42, year: 2012, catalogId: "tt2359704" });
  assert.equal(links.length, 9);
  assert.deepEqual(links.filter((link) => link.season === 2).map((link) => [link.anilistId, link.start, link.end]),
    [[20474, 1, 24], [20799, 25, 48]]);
  assert.deepEqual(links.filter((link) => link.season === 6).map((link) => [link.start, link.end]), [[1, 1], [2, 12]]);
  assert.deepEqual(verifiedPublicAniListLinks(match, { userId: 42, year: 2013, catalogId: "tt2359704" }), []);
  assert.deepEqual(verifiedPublicAniListLinks(match, { userId: 0, year: 2012, catalogId: "tt2359704" }), []);
  assert.deepEqual(verifiedPublicAniListLinks(match, { userId: 42, year: 2012, catalogId: "bad" }), []);
  assert.deepEqual(verifiedPublicAniListLinks(matchPublicAniListSeasons({ ...catalog, media: jojo.slice(0, 2) }),
    { userId: 42, year: 2012, catalogId: "tt2359704" }), []);
  const corrupted = structuredClone(match);
  corrupted.seasons[1].parts[1].id = corrupted.seasons[0].parts[0].id;
  assert.deepEqual(verifiedPublicAniListLinks(corrupted, { userId: 42, year: 2012, catalogId: "tt2359704" }), []);
});

test("never guess public ratings from unrelated OVAs, no valid root, ambiguous roots, or mismatched sequel lengths", () => {
  assert.equal(matchPublicAniListSeasons({ ...catalog, media: [jojo.at(-1)] }), null);
  assert.equal(matchPublicAniListSeasons({ ...catalog, media: [jojo[0], { ...jojo[0], id: 9999 }] }), null);
  assert.equal(matchPublicAniListSeasons({ ...catalog, media: [{ ...jojo[0], episodes: 24 }] }), null);
  assert.equal(matchPublicAniListSeasons({ ...catalog, media: [jojo[0]], year: 2022 }), null);
  assert.equal(matchPublicAniListSeasons({ ...catalog, media: [{ ...jojo[0], title: { english: "Other anime" } }] }), null);
  const partial = matchPublicAniListSeasons({ ...catalog, media: [jojo[0], jojo[1]] });
  assert.equal(partial.totalSeasons, 6);
  assert.equal(partial.seasons.length, 1);
  assert.equal(partial.seasons[0].season, 1);
});

test("unknown community scores stay unavailable, distinct from personal MediaList scores", () => {
  const parsed = matchPublicAniListSeasons({ ...catalog, media: [{ ...jojo[0], averageScore: null, personalScore: 10 }, jojo[1], jojo[2]] });
  assert.equal(parsed.seasons[0].score, null);
  assert.equal(Number(parsed.seasons[1].score.toFixed(1)), 8.1);
  assert.equal(parsed.ratedSeasons, 1);
  assert.equal(Number(parsed.score.toFixed(1)), 8.1);
  assert.equal(matchPublicAniListSeasons({ ...catalog, media: [{ ...jojo[0], averageScore: null }] }).score, null);
});

test("public AniList search stays browser-direct, anonymous, and read-only", async () => {
  assert.match(ANILIST_PUBLIC_TITLE_QUERY, /averageScore/);
  assert.match(ANILIST_PUBLIC_TITLE_QUERY, /status/);
  assert.match(ANILIST_PUBLIC_TITLE_QUERY, /synonyms/);
  assert.match(ANILIST_PUBLIC_TITLE_QUERY, /title \{ english romaji native \}/);
  const searches = [];
  const media = await fetchPublicAniListTitle("JoJo's Bizarre Adventure", { fetchImpl: async (url, init) => {
    searches.push({ url, init });
    return { ok: true, json: async () => ({ data: { Page: { media: jojo } } }) };
  } });
  assert.equal(media.length, jojo.length);
  assert.equal(searches.length, 1);
  assert.equal(searches[0].url, "https://graphql.anilist.co");
  assert.equal(searches[0].init.method, "POST");
  assert.equal(searches[0].init.credentials, "omit");
  assert.equal(searches[0].init.referrerPolicy, "no-referrer");
  assert.ok(!Object.keys(searches[0].init.headers).some((header) => /authorization|token/i.test(header)));
  assert.ok(!/SaveMediaListEntry|MediaListCollection|Viewer/.test(searches[0].init.body));
});

test("IMDb overall score stays 8.6 when per-season IMDb scores are missing, with honest season hover rows", () => {
  const start = app.indexOf("function titleRatingBreakdownMarkup(");
  const end = app.indexOf("\nfunction titleTrailerUrl(", start);
  assert.ok(start >= 0 && end > start);
  const ctx = vm.createContext({ icon, escapeHtml, Number });
  vm.runInContext(app.slice(start, end), ctx);
  const imdb = vm.runInContext("titleRatingMarkup", ctx)({ id: "tt2359704", rating: "8.6",
    imdbSeasons: [1, 2, 3, 4, 5, 6].map((season) => ({ season, score: null })) });
  assert.match(imdb, /data-title-rating-provider="IMDb"/);
  assert.match(imdb, /<strong>8\.6<\/strong>/);
  assert.match(imdb, /Season 1[\s\S]*Unavailable/);
  assert.match(imdb, /Season 6[\s\S]*Unavailable/);
  assert.match(imdb, /IMDb season scores are not supplied/);
  assert.match(imdb, /<details[^>]+>[\s\S]*<summary/);
  assert.match(imdb, /https:\/\/www\.imdb\.com\/title\/tt2359704/);
  assert.equal((imdb.match(/<\/summary>/g) || []).length, 1);

  const withAllSeasonScores = vm.runInContext("titleRatingMarkup", ctx)({ id: "tt1", rating: "8.6",
    imdbSeasons: [{ season: 1, score: 8 }, { season: 2, score: 9 }] });
  assert.match(withAllSeasonScores, /<strong>8\.6<\/strong>/,
    "IMDb's published series rating is not the mean of individual seasons' independent ratings");
});

test("AniList popup shows season averages plus distinct season/part covers with keyboard and touch access", () => {
  const start = app.indexOf("function titleRatingBreakdownMarkup(");
  const end = app.indexOf("\nfunction titleTrailerUrl(", start);
  const ctx = vm.createContext({ icon, escapeHtml, Number });
  vm.runInContext(app.slice(start, end), ctx);
  const mapped = matchPublicAniListSeasons({ ...catalog, media: jojo });
  const html = vm.runInContext("titleAniListRatingMarkup", ctx)(mapped);
  assert.match(html, /data-title-rating-provider="AniList"/);
  assert.match(html, /<strong>8\.2<\/strong>/);
  assert.match(html, /Season 2[\s\S]*8\.1\/10/);
  assert.match(html, /Stardust Crusaders[\s\S]*7\.9\/10/);
  assert.match(html, /s4\.anilist\.co\/file\/20474\.jpg/);
  assert.doesNotMatch(html, /Mean of rated seasons|LVL Season|community averages \(not your personal AniList ratings\)/);
  assert.match(html, /class="title-rating-season__head"><span>Season 2<\/span>/,
    "AniList season heading should not include the old left-hand film icon");
  assert.doesNotMatch(css, /\.title-rating-wrap:hover > \.title-rating-breakdown/);
  assert.doesNotMatch(css, /\.title-rating-wrap:focus-within > \.title-rating-breakdown/);
  assert.match(css, /\.title-rating-wrap\[open\] > \.title-rating-breakdown/);
  assert.ok(!html.includes("onclick="));
});
