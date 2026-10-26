import test from "node:test";
import assert from "node:assert/strict";
import {
  GENRE_GROUPS,
  HOME_CATEGORIES,
  MIN_ROW_ITEMS,
  boundedPosterUrl,
  backdropSrcset,
  backdropUrl,
  buildHomeFeed,
  catalogCardItem,
  catalogLists,
  formatRuntime,
  hashScore,
  heroSlideItem,
  interleave,
  largeAniListCover,
  libraryCategory,
  libraryRecommendations,
  logoUrl,
  metahubUrl,
  metahubVariant,
  normalizeHomeCategory,
  posterSrcset,
  preferredPosterArt,
  seededOrder,
  sharperPoster,
  titleRating,
  titleYear,
  typeLabel,
  uniqueById,
} from "../frontend/catalog/home-feed.js";

const GENRE_CYCLE = [
  ["Drama", "Crime"],
  ["Action", "Adventure"],
  ["Comedy"],
  ["Thriller", "Mystery"],
  ["Sci-Fi", "Fantasy"],
  ["Horror"],
  ["Romance", "Drama"],
  ["Biography", "History"],
];

function makeList(prefix, type, count, { idOffset = 0, anime = false } = {}) {
  return Array.from({ length: count }, (_, index) => {
    const number = idOffset + index;
    const id = `tt${String(1000000 + number).padStart(7, "0")}`;
    return {
      id,
      type,
      name: `${prefix} ${index + 1}`,
      poster: `https://images.metahub.space/poster/small/${id}/img`,
      background: `https://images.metahub.space/background/medium/${id}/img`,
      logo: `https://images.metahub.space/logo/medium/${id}/img`,
      releaseInfo: `${2026 - (index % 6)}${type === "series" ? "-" : ""}`,
      description: index % 7 === 3 ? "" : `Synopsis for ${prefix} ${index + 1}.`,
      genres: anime ? ["Animation", ...GENRE_CYCLE[index % GENRE_CYCLE.length]] : GENRE_CYCLE[index % GENRE_CYCLE.length],
      imdbRating: (6 + (index % 9) * 0.45).toFixed(1),
      runtime: type === "movie" ? `${90 + index} min` : "45 min",
    };
  });
}

const COUNT = 60;

function makeCatalog(count = COUNT) {
  return {
    movies: makeList("Movie", "movie", count, { idOffset: 0 }),
    series: makeList("Show", "series", count, { idOffset: 1000 }),
    anime: makeList("Anime", "series", count, { idOffset: 2000, anime: true }),
  };
}

const allIds = (feed) => feed.rows.flatMap((row) => row.items.map((item) => item.id || item.key));

test("home categories normalize to a known id with an All default", () => {
  assert.deepEqual(HOME_CATEGORIES.map((category) => category.id), ["all", "movie", "tv", "anime"]);
  assert.equal(normalizeHomeCategory("anime"), "anime");
  assert.equal(normalizeHomeCategory("tv"), "tv");
  assert.equal(normalizeHomeCategory("series"), "all");
  assert.equal(normalizeHomeCategory(null), "all");
  assert.equal(normalizeHomeCategory("nope", "movie"), "movie");
});

test("metadata parsing handles open ranges, bad ratings and runtime formats", () => {
  assert.equal(titleYear({ releaseInfo: "2026-" }), 2026);
  assert.equal(titleYear({ releaseInfo: "2011–2019" }), 2011);
  assert.equal(titleYear({ year: "1999" }), 1999);
  assert.equal(titleYear({ releaseInfo: "" }), null);
  assert.equal(titleYear(null), null);

  assert.equal(titleRating({ imdbRating: "8.24" }), 8.2);
  assert.equal(titleRating({ imdbRating: "0" }), null);
  assert.equal(titleRating({ imdbRating: "11" }), null);
  assert.equal(titleRating({ imdbRating: "abc" }), null);

  assert.equal(formatRuntime("101 min"), "1h 41m");
  assert.equal(formatRuntime("45 min"), "45m");
  assert.equal(formatRuntime("60 min"), "1h");
  assert.equal(formatRuntime("2h 10min"), "2h 10m");
  assert.equal(formatRuntime("90"), "1h 30m");
  assert.equal(formatRuntime(""), "");
  assert.equal(formatRuntime("TBA"), "");
  assert.equal(formatRuntime("99999 min"), "");
});

test("seeded ordering is deterministic, complete and seed-dependent", () => {
  const items = makeList("Item", "movie", 30);
  const first = seededOrder(items, 7, "salt");
  const second = seededOrder(items, 7, "salt");
  assert.deepEqual(first.map((item) => item.id), second.map((item) => item.id));
  assert.deepEqual(new Set(first.map((item) => item.id)), new Set(items.map((item) => item.id)));
  assert.notDeepEqual(seededOrder(items, 8, "salt").map((item) => item.id), first.map((item) => item.id));
  assert.equal(hashScore("abc"), hashScore("abc"));
  assert.notEqual(hashScore("abc"), hashScore("abd"));
});

test("interleave and uniqueById merge lists without duplicates", () => {
  assert.deepEqual(interleave([1, 2, 3], ["a"], [true, false]), [1, "a", true, 2, false, 3]);
  const merged = uniqueById([{ id: "a" }, { id: "b" }, { id: "a" }, { name: "" }, null, { key: "k" }]);
  assert.deepEqual(merged.map((item) => item.id || item.key), ["a", "b", "k"]);
});

test("metahub artwork helpers only rewrite trusted metahub URLs", () => {
  const poster = "https://images.metahub.space/poster/small/tt1234567/img";
  assert.equal(metahubVariant(poster, "medium"), "https://images.metahub.space/poster/medium/tt1234567/img");
  assert.equal(metahubVariant("https://evil.example/poster/small/tt1234567/img", "medium"), "");
  assert.equal(metahubVariant(poster, "huge"), "");
  assert.equal(metahubUrl("background", "large", "tt1234567"), "https://images.metahub.space/background/large/tt1234567/img");
  assert.equal(metahubUrl("background", "large", "../etc"), "");
  assert.equal(metahubUrl("banner", "large", "tt1234567"), "");

  assert.equal(posterSrcset({ poster }), `${poster} 300w, https://images.metahub.space/poster/medium/tt1234567/img 500w, https://images.metahub.space/poster/large/tt1234567/img 780w`);
  assert.equal(posterSrcset({ poster: "https://cdn.example/p.jpg" }), "");

  const background = "https://images.metahub.space/background/medium/tt1234567/img";
  assert.equal(backdropUrl({ background }, "small"), "https://images.metahub.space/background/small/tt1234567/img");
  assert.equal(backdropUrl({ background: "https://cdn.example/b.jpg" }, "small"), "https://cdn.example/b.jpg");
  assert.equal(backdropUrl({ id: "tt1234567" }, "medium"), background);
  assert.equal(backdropUrl({ id: "not-an-id" }), "");
  assert.equal(backdropSrcset({ background }, ["small", "medium"]), "https://images.metahub.space/background/small/tt1234567/img 480w, https://images.metahub.space/background/medium/tt1234567/img 1920w", "the widths metahub really serves");
  assert.equal(backdropSrcset({ background }), "", "medium and large are the same 1920 px file: no choice to offer");
  assert.equal(backdropSrcset({ background: "https://cdn.example/b.jpg" }), "");
  assert.equal(logoUrl({ id: "tt1234567" }), "https://images.metahub.space/logo/medium/tt1234567/img");
});

test("automatic poster selection prefers sharp responsive catalog art without overriding a manual cover", () => {
  const saved = "https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx5114.jpg";
  const catalog = "https://images.metahub.space/poster/small/tt1234567/img";
  const upgraded = preferredPosterArt({ saved, catalog, artworkSource: "ANILIST" });
  assert.equal(upgraded.image, "https://images.metahub.space/poster/large/tt1234567/img");
  assert.equal(upgraded.fallback, saved);
  assert.match(upgraded.srcset, /poster\/small\/tt1234567\/img 300w/);
  assert.match(upgraded.srcset, /poster\/medium\/tt1234567\/img 500w/);
  assert.match(upgraded.srcset, /poster\/large\/tt1234567\/img 780w/);
  for (const manual of [
    { saved, catalog, pinned: true },
    { saved, catalog, artworkSource: "CUSTOM" },
    { saved, catalog, artworkSource: "TVMAZE" },
  ]) {
    assert.equal(preferredPosterArt(manual).image, saved, "explicit and legacy user selections win");
  }
  assert.equal(preferredPosterArt({ saved }).image, saved, "do not invent missing catalog art");
  assert.equal(preferredPosterArt({ catalog }).image, "https://images.metahub.space/poster/large/tt1234567/img");
  assert.equal(preferredPosterArt({ saved: "data:image/jpeg;base64,AAA", catalog }).image, "data:image/jpeg;base64,AAA");
  assert.equal(preferredPosterArt({ saved: "https://example.com/photo.jpg" }).srcset, "", "unrecognized image providers aren't rewritten");
});

test("only trusted TVMaze original portraits use the bounded WebP endpoint", () => {
  const original = "https://static.tvmaze.com/uploads/images/original_untouched/626/1566363.jpg";
  assert.equal(boundedPosterUrl(original), `/api/images/poster?src=${encodeURIComponent(original)}`);
  for (const url of [
    "https://images.metahub.space/poster/large/tt1234567/img",
    "https://static.tvmaze.com/uploads/images/medium_portrait/626/1566363.jpg",
    "https://static.tvmaze.com/uploads/images/original_untouched/626/1566363.jpg?tracking=1",
    "https://evil.example/uploads/images/original_untouched/626/1566363.jpg",
    "data:image/jpeg;base64,AAAA",
  ]) assert.equal(boundedPosterUrl(url), url);
});

test("AniList covers are asked for at their large size; the saved one is the fallback", () => {
  const medium = "https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx5114-KJTQz9AIm6Wk.jpg";
  const large = "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx5114-KJTQz9AIm6Wk.jpg";
  assert.equal(largeAniListCover(medium), large);
  assert.equal(largeAniListCover("https://s4.anilist.co/file/anilistcdn/media/anime/cover/small/b206-x.png"), "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/b206-x.png");
  assert.equal(largeAniListCover(large), "", "already large");
  assert.equal(largeAniListCover("https://evil.example/file/anilistcdn/media/anime/cover/medium/bx1.jpg"), "", "only AniList's own host");
  assert.deepEqual(sharperPoster(medium), { image: large, imageFallback: medium });
  assert.deepEqual(sharperPoster("https://images.metahub.space/poster/small/tt1/img"), { image: "https://images.metahub.space/poster/small/tt1/img", imageFallback: "" });
  assert.deepEqual(sharperPoster(""), { image: "", imageFallback: "" });
});

test("catalog lists are tagged with category and popularity rank", () => {
  const lists = catalogLists({ movies: [{ id: "tt0000001", name: "A" }, { name: "no id" }], series: [{ id: "tt0000002", name: "B" }], anime: null });
  assert.deepEqual(lists.movie.map(({ id, kind, rank }) => ({ id, kind, rank })), [{ id: "tt0000001", kind: "movie", rank: 1 }]);
  assert.deepEqual(lists.tv.map(({ kind, rank }) => ({ kind, rank })), [{ kind: "tv", rank: 1 }]);
  assert.deepEqual(lists.anime, []);
});

test("card and hero items expose display-ready metadata", () => {
  const lists = catalogLists(makeCatalog(12));
  const movie = lists.movie[0];
  const anime = lists.anime[1];
  assert.equal(typeLabel(anime, "all"), "Anime");
  assert.equal(typeLabel(anime, "anime"), "Series");
  assert.equal(typeLabel(movie, "anime"), "Film");

  const card = catalogCardItem(movie, { detailed: true });
  assert.equal(card.title, "Movie 1");
  assert.deepEqual(card.meta, ["2026", "Movie", "1h 30m"]);
  assert.equal(card.rating, 6);
  assert.match(card.imageSrcset, /300w, .*500w, .*780w$/);
  assert.equal(card.backdropFallback, movie.background);
  assert.equal(card.logoFallback, movie.logo);
  assert.equal(catalogCardItem(anime).meta[1], "Anime");
  assert.ok(!catalogCardItem(anime, { detailed: true }).meta.includes("Animation"), "Animation is implied for anime");

  const hero = heroSlideItem(anime);
  assert.equal(hero.eyebrow, undefined, "all featured categories omit the banner above the title");
  assert.ok(!hero.meta[2].includes("Animation"));
  assert.equal(hero.backdropSrcset, "", "medium and large are one 1920 px file, so the hero just uses it");
  assert.match(hero.backdrop, /\/background\/medium\//);
  assert.equal(heroSlideItem({ ...movie, genres: [] }).eyebrow, undefined);
});

test("the All feed mixes categories into hero, Top 10 and popular rows", () => {
  const feed = buildHomeFeed(makeCatalog(), { category: "all", seed: 3, currentYear: 2026 });
  assert.equal(feed.category, "all");
  assert.equal(feed.total, COUNT * 3);
  assert.ok(feed.hero.length >= 3 && feed.hero.length <= 5);
  assert.equal(new Set(feed.hero.map((meta) => meta.id)).size, feed.hero.length);
  assert.deepEqual(new Set(feed.hero.map((meta) => meta.kind)), new Set(["tv", "movie", "anime"]));

  const ids = feed.rows.map((row) => row.id);
  assert.deepEqual(ids.slice(0, 4), ["top-tv", "popular-movies", "popular-anime", "popular-tv"]);
  assert.ok(!ids.includes("library"), "no Library row without saved titles");
  const top = feed.rows[0];
  assert.equal(top.variant, "poster");
  assert.equal(top.ranked, true);
  assert.equal(top.title, "Top 10 TV shows");
  assert.equal(top.items.length, 10);
  assert.deepEqual(top.items.map((meta) => meta.rank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.ok(feed.rows.find((row) => row.id === "popular-tv").items.every((meta) => meta.rank > 10), "popular TV continues after the Top 10");
  assert.equal(feed.rows.filter((row) => row.ranked).length, 1, "only the Top 10 row is ranked");
  feed.rows.forEach((row) => {
    const rowIds = row.items.map((item) => item.id);
    assert.equal(new Set(rowIds).size, rowIds.length, `${row.id} has duplicates`);
  });
});

test("Top row does not claim rankings are from this week when a 504 serves saved or partial catalog data", () => {
  const source = makeCatalog();
  for (const status of [{ stale: true, cached: true }, { partial: true }, {}]) {
    const feed = buildHomeFeed({ ...source, ...status }, { category: "tv", currentYear: 2026 });
    const top = feed.rows.find((row) => row.id === "top-tv");
    assert.equal(top.subtitle, "Catalog ranking");
    assert.ok(!/this week|today|updated/i.test(top.subtitle));
    assert.equal(top.items.length, 10, "the existing ranked catalog selection is preserved");
  }
});

test("category feeds only contain titles from that category", () => {
  for (const category of ["movie", "tv", "anime"]) {
    const feed = buildHomeFeed(makeCatalog(), { category, seed: 1, currentYear: 2026 });
    assert.equal(feed.rows[0].id, `top-${category}`);
    assert.equal(feed.rows[0].variant, "poster");
    assert.equal(feed.rows[0].ranked, true);
    assert.ok(feed.hero.every((meta) => meta.kind === category), `${category} hero`);
    feed.rows.forEach((row) => row.items.forEach((meta) => assert.equal(meta.kind, category, `${category}/${row.id}`)));
  }
  assert.equal(buildHomeFeed(makeCatalog(), { category: "movie" }).rows[0].title, "Top 10 movies");
  assert.equal(buildHomeFeed(makeCatalog(), { category: "tv" }).rows[0].title, "Top 10 TV shows");
  const small = makeCatalog();
  small.anime = small.anime.slice(0, 6);
  assert.equal(buildHomeFeed(small, { category: "anime" }).rows[0].title, "Top 6 anime", "the title never promises more than it shows");
  assert.equal(buildHomeFeed(makeCatalog(), { category: "bogus" }).category, "all");
});

test("date, rating and genre rows follow their rules", () => {
  const feed = buildHomeFeed(makeCatalog(), { category: "movie", seed: 2, currentYear: 2026 });
  const byId = Object.fromEntries(feed.rows.map((row) => [row.id, row]));

  const fresh = byId.new.items.map((meta) => titleYear(meta));
  assert.ok(fresh.every((year) => year >= 2025 && year <= 2027));
  assert.deepEqual(fresh, [...fresh].sort((a, b) => b - a), "newest first");

  const ratings = byId.acclaimed.items.map((meta) => titleRating(meta));
  assert.ok(ratings.every((rating) => rating >= 7.5));
  assert.deepEqual(ratings, [...ratings].sort((a, b) => b - a), "best rated first");

  assert.ok(byId.spotlight.items.every((meta) => meta.description), "spotlight needs a synopsis");
  const heroIds = new Set(feed.hero.map((meta) => meta.id));
  assert.ok(byId.spotlight.items.every((meta) => !heroIds.has(meta.id)), "spotlight skips hero titles");

  const genreRows = feed.rows.filter((row) => row.id.startsWith("genre-"));
  assert.ok(genreRows.length >= 5);
  genreRows.forEach((row) => {
    const group = GENRE_GROUPS.find((item) => `genre-${item.id}` === row.id);
    assert.ok(row.items.length >= MIN_ROW_ITEMS, `${row.id} is too short`);
    assert.ok(row.items.every((meta) => meta.genres.some((genre) => group.genres.includes(genre))), `${row.id} genre mismatch`);
  });
});

test("anime rows ignore the implied Animation genre", () => {
  const feed = buildHomeFeed(makeCatalog(), { category: "anime", seed: 0, currentYear: 2026 });
  const family = feed.rows.find((row) => row.id === "genre-family");
  assert.equal(family, undefined, "every anime is Animation, so a Family & animation row would just repeat the catalog");
});

test("Library titles get their own row and are left out of Discover", () => {
  const catalog = makeCatalog();
  const saved = new Set(catalog.movies.slice(24, 34).map((meta) => meta.id));
  const library = [
    { key: "saved movie", title: "Saved movie", type: "movie", catalogId: catalog.movies[0].id },
    { key: "saved anime", title: "Saved anime", type: "series", catalogId: catalog.anime[0].id },
    { key: "saved show", title: "Saved show", type: "series", catalogId: "" },
  ];
  const all = buildHomeFeed(catalog, { category: "all", library, isInLibrary: (meta) => saved.has(meta.id) });
  const libraryRow = all.rows.find((row) => row.id === "library");
  assert.equal(libraryRow.variant, "library");
  assert.equal(libraryRow.items.length, 3);
  const discover = all.rows.find((row) => row.id === "discover");
  assert.ok(discover.items.every((meta) => !saved.has(meta.id)));

  const anime = buildHomeFeed(catalog, { category: "anime", library });
  assert.deepEqual(anime.rows.find((row) => row.id === "library").items.map((item) => item.key), ["saved anime"]);
  const tv = buildHomeFeed(catalog, { category: "tv", library });
  assert.deepEqual(tv.rows.find((row) => row.id === "library").items.map((item) => item.key), ["saved show"]);
});

test("Library categories separate TV series, films and anime without duplicates", () => {
  const animeIds = new Set(["tt001", "tt002"]);
  const cases = [
    [{ type: "series", catalogId: "tt003", sources: [] }, "series"],
    [{ type: "movie", catalogId: "tt004", sources: [] }, "movie"],
    [{ type: "series", catalogId: "tt001", sources: [] }, "anime"],
    [{ type: "movie", catalogId: "tt002", sources: [] }, "anime"],
    [{ type: "series", sources: [{ anilist: { showId: "anilist:77" } }] }, "anime"],
    [{ type: "movie", sources: [{ externalSource: "ANILIST", anilistImported: true }] }, "anime"],
    [{ type: "series", mediaKind: "anime", sources: [] }, "anime"],
    [{ type: "series", sources: [], genres: ["Anime"] }, "anime"],
    [{ type: "series", sources: [], genres: ["Animation"] }, "series"],
    [{ type: "movie", sources: [] }, "movie"],
  ];
  for (const [title, expected] of cases) {
    assert.equal(libraryCategory(title, { animeIds }), expected);
  }
  const totals = { series: 0, movie: 0, anime: 0 };
  for (const [title] of cases) totals[libraryCategory(title, { animeIds })] += 1;
  assert.deepEqual(totals, { series: 2, movie: 2, anime: 6 });
});

test("Animation plus Japanese origin is anime, while western animation stays in Series", () => {
  const film = { type: "movie", catalogId: "tt100", sources: [] };
  assert.equal(libraryCategory(film, { details: { genres: ["Animation"], country: "Japan" } }), "anime");
  assert.equal(libraryCategory(film, { details: { genres: ["Animation"], country: "United States" } }), "movie");
});

test("feeds are stable for a seed and rotate when the seed changes", () => {
  const catalog = makeCatalog();
  const one = buildHomeFeed(catalog, { seed: 10, currentYear: 2026 });
  const again = buildHomeFeed(catalog, { seed: 10, currentYear: 2026 });
  assert.deepEqual(allIds(one), allIds(again));
  assert.deepEqual(one.hero.map((meta) => meta.id), again.hero.map((meta) => meta.id));
  const other = buildHomeFeed(catalog, { seed: 11, currentYear: 2026 });
  assert.notDeepEqual(allIds(other), allIds(one));
});

test("an empty or missing catalog yields an empty feed instead of throwing", () => {
  for (const catalog of [{}, null, { movies: [], series: [], anime: [] }]) {
    const feed = buildHomeFeed(catalog, { category: "all" });
    assert.deepEqual(feed.hero, []);
    assert.deepEqual(feed.rows, []);
    assert.equal(feed.total, 0);
  }
});

test("Library recommendations come from the less popular tail and skip saved titles", () => {
  const catalog = makeCatalog();
  const saved = new Set([catalog.movies[30].id, catalog.series[30].id]);
  const picks = libraryRecommendations(catalog, { seed: 4, isInLibrary: (meta) => saved.has(meta.id) });
  assert.ok(picks.length > 0 && picks.length <= 24);
  assert.ok(picks.every((meta) => meta.rank > 24), "popular titles are already on Home");
  assert.ok(picks.every((meta) => !saved.has(meta.id)));
  assert.ok(picks.every((meta) => meta.kind === "movie" || meta.kind === "tv"));
  assert.equal(new Set(picks.map((meta) => meta.id)).size, picks.length);
});
