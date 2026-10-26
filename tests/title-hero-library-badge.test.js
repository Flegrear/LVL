import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { heroLibraryButtonMarkup } from "../frontend/ui/ui.js";
import { posterSrcset } from "../frontend/catalog/home-feed.js";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../frontend/styles/styles.css", import.meta.url), "utf8");

function render(saved, updates = {}, type = "series") {
  const start = app.indexOf("function savedTitleBadge(");
  const end = app.indexOf("\n// Your progress with a Library title", start);
  assert.ok(start >= 0 && end > start);
  const context = vm.createContext({
    titleView: { fromApp: false },
    seriesNextUp: () => null,
    titleFirstChapter: () => null,
    buttonMarkup: ({ label }) => `<button>${label}</button>`,
    iconButtonMarkup: ({ label }) => `<button>${label}</button>`,
    icon: () => '<svg aria-hidden="true"></svg>',
    escapeHtml: (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;"),
    t: (key) => key,
    metaMarkup: () => "",
    titleListText: (names) => names.join(", "),
    formatRuntime: (runtime) => runtime,
    titleRatingMarkup: () => "",
    titleAniListRatingMarkup: () => "",
    eligibleForPublicAnimeRating: ({ mediaKind, genres = [], country }) => mediaKind === "anime"
      || (genres.includes("Animation") && country === "Japan"),
    posterSrcset,
  });
  vm.runInContext(app.slice(start, end), context);
  const info = { id: "tt2359704", name: "JoJo's Bizarre Adventure", poster: "https://example.org/poster.jpg",
    backdrop: "", logo: "", releaseInfo: "2012", seasonCount: 6, chapterTotal: 202,
    trailers: [], genres: [], cast: [], description: "", runtime: "24 min", status: "Continuing", ...updates };
  return vm.runInContext("titleHeroMarkup", context)(
    { id: info.id, type, series: saved ? { key: "jojo", title: info.name,
      sources: saved === "torrent" ? [{ magnet: "magnet:?xt=test", episodes: [{ fileIndex: 0 }] }]
        : [{ id: "catalog:series:tt2359704", episodes: [] }] } : null }, info, null);
}

test("saved torrent label describes a reusable source, not falsely downloaded files", () => {
  const markup = render("torrent");
  const poster = markup.indexOf('class="title-hero__poster-wrap"');
  const image = markup.indexOf('class="title-hero__poster"');
  const badge = markup.indexOf('class="title-hero__poster-saved"');
  const copy = markup.indexOf('class="title-hero__copy"');
  assert.ok(poster >= 0 && image > poster && badge > image && copy > badge,
    "Saved indicator belongs to the image wrapper, before the title/text column");
  assert.match(markup, /<span>Torrent saved<\/span>/);
  assert.match(markup, /title="Torrent source saved in your Library"/);
  assert.doesNotMatch(markup, /<span>In Library<\/span>/);
  assert.doesNotMatch(markup, /title-hero__badges/);
});

test("anime hides starring while TV and films retain it, and watch status follows Magnet", () => {
  const anime = render("catalog", { genres: ["Animation"], country: "Japan", cast: ["Actor"] });
  assert.doesNotMatch(anime, /Starring/);
  assert.ok(anime.indexOf("Magnet link") < anime.indexOf('id="title-watch-status-slot"'));
  assert.ok(anime.indexOf('id="title-watch-status-slot"') < anime.indexOf('data-title-action="menu"')
    || anime.indexOf('id="title-watch-status-slot"') < anime.indexOf("More for"));
  assert.match(render("catalog", { genres: ["Drama"], country: "United States", cast: ["Actor"] }), /Starring/);
  assert.match(render("catalog", { genres: ["Drama"], country: "United States", cast: ["Actor"] }, "movie"), /Starring/);
});

test("catalog-only and AniList-only placeholders say On your list, not torrent saved", () => {
  const markup = render("catalog");
  assert.match(markup, /<span>On your list<\/span>/);
  assert.doesNotMatch(markup, /Torrent saved/);
});

test("Home's already-saved torrent button also uses the source-specific label", () => {
  assert.match(heroLibraryButtonMarkup(true, "Torrent saved"), /Torrent saved<\/span>/);
  assert.match(app, /heroLibraryButtonMarkup\(isInLibrary\(meta\), savedTitleBadge\(match\)\?\.label\)/);
});

test("catalog titles not saved in the Library do not show a saved indicator", () => {
  const markup = render(false);
  assert.match(markup, /title-hero__poster-wrap/);
  assert.doesNotMatch(markup, /title-hero__poster-saved|In Library<\/span>/);
});

test("poster overlay remains inside the cover at desktop and mobile sizes", () => {
  assert.match(styles, /\.title-hero__poster-wrap\s*\{[^}]*position:relative;[^}]*width:clamp\(160px, 15vw, 240px\)/);
  assert.match(styles, /\.title-hero__poster-saved\s*\{[^}]*position:absolute;[^}]*top:9px; right:9px;/);
  assert.match(styles, /\.title-hero__poster-saved\s*\{[^}]*pointer-events:none/);
  assert.match(styles, /@media \(max-width:680px\)[\s\S]*?\.title-hero__poster-wrap\s*\{\s*width:112px/);
});
