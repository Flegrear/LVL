import test from "node:test";
import assert from "node:assert/strict";
import {
  ICON_NAMES,
  artworkFallback,
  badgeMarkup,
  bindHero,
  buttonMarkup,
  cardLibraryActionMarkup,
  cardMarkup,
  emptyMarkup,
  escapeHtml,
  formatRatingValue,
  heroLibraryButtonMarkup,
  heroMarkup,
  icon,
  iconButtonMarkup,
  metaMarkup,
  shelfMarkup,
  skeletonHeroMarkup,
  skeletonShelfMarkup,
  tabsMarkup,
  toast,
} from "../frontend/ui/ui.js";

const HOSTILE = `<img src=x onerror="alert(1)">'&`;

function assertNoRawHostile(html) {
  assert.ok(!html.includes("<img src=x"), "raw tag leaked");
  assert.ok(!html.includes(`onerror="alert`), "raw attribute leaked");
}

test("escapeHtml escapes every HTML-significant character", () => {
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(42), "42");
});

test("icons are decorative SVGs and unknown names render nothing", () => {
  assert.ok(ICON_NAMES.length >= 20);
  for (const name of ["play", "pause", "plus", "check", "search", "shuffle"]) assert.ok(ICON_NAMES.includes(name), name);
  const svg = icon("plus");
  assert.match(svg, /^<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">/);
  assert.equal(icon("does-not-exist"), "");
});

test("fallback artwork is an escaped inline SVG with initials", () => {
  const url = artworkFallback("Breaking Bad", { label: "Series" });
  assert.match(url, /^data:image\/svg\+xml;charset=utf-8,/);
  const svg = decodeURIComponent(url.split(",")[1]);
  assert.match(svg, />BB<\/text>/);
  assert.match(svg, />SERIES<\/text>/);
  const hostile = decodeURIComponent(artworkFallback(HOSTILE).split(",")[1]);
  assert.ok(!hostile.includes("<img"), "title is escaped inside the SVG");
  assert.match(decodeURIComponent(artworkFallback("", { ratio: "wide" }).split(",")[1]), /viewBox="0 0 320 180"/);
});

test("buttons escape labels and attribute values and drop invalid attribute names", () => {
  const html = buttonMarkup({ label: HOSTILE, variant: "primary", size: "lg", icon: "plus", attrs: { "data-x": `a"b`, "bad name": "1", disabled: true, hidden: false } });
  assertNoRawHostile(html);
  assert.match(html, /^<button class="ui-btn ui-btn--primary ui-btn--lg" type="button"/);
  assert.match(html, / data-x="a&quot;b"/);
  assert.match(html, / disabled[ >]/);
  assert.ok(!html.includes("bad name"));
  assert.ok(!html.includes(" hidden"), "false boolean attributes are omitted");
});

test("icon buttons always carry an accessible name and optional pressed/tooltip state", () => {
  const html = iconButtonMarkup({ icon: "shuffle", label: "Shuffle picks", tooltip: "Shuffle", tooltipPos: "bottom", tooltipAlign: "end", pressed: false });
  assert.match(html, /aria-label="Shuffle picks"/);
  assert.match(html, /aria-pressed="false"/);
  assert.match(html, /data-ui-tooltip="Shuffle"/);
  assert.match(html, /data-ui-tooltip-pos="bottom"/);
  assert.match(html, /data-ui-tooltip-align="end"/);
  assert.ok(!iconButtonMarkup({ icon: "plus", label: "Add" }).includes("aria-pressed"));
});

test("meta lines format ratings and skip empty parts", () => {
  assert.equal(formatRatingValue("8.24"), "8.2");
  assert.equal(formatRatingValue(0), "");
  assert.equal(formatRatingValue("11"), "");
  const html = metaMarkup(["2026", "", "Series"], { rating: 8 });
  assert.equal((html.match(/<span>/g) || []).length, 2);
  assert.match(html, /IMDb rating <\/span>8\.0<\/span>/);
  assert.equal(metaMarkup([], { rating: "n/a" }), "");
  assertNoRawHostile(metaMarkup([HOSTILE]));
});

test("tabs follow the ARIA tabs pattern with a roving tabindex", () => {
  const items = [{ value: "all", label: "All" }, { value: "movie", label: "Movies", count: 12 }];
  const html = tabsMarkup(items, { active: "movie", label: "Browse by type", controls: "panel", idPrefix: "home-tab" });
  assert.match(html, /^<div class="ui-tabs" role="tablist" aria-label="Browse by type">/);
  assert.match(html, /id="home-tab-all" data-value="all" aria-selected="false" aria-controls="panel" tabindex="-1"/);
  assert.match(html, /id="home-tab-movie" data-value="movie" aria-selected="true" aria-controls="panel" tabindex="0"/);
  assert.match(html, /<span class="ui-tab__count">12<\/span>/);
  assert.match(tabsMarkup(items, { active: "unknown" }), /data-value="all" aria-selected="true"/);
});

test("poster cards escape content, describe themselves and expose the right actions", () => {
  const item = {
    id: "tt1234567",
    title: HOSTILE,
    image: "https://images.metahub.space/poster/small/tt1234567/img",
    imageSrcset: "https://images.metahub.space/poster/small/tt1234567/img 300w",
    imageFallback: "https://images.metahub.space/poster/small/tt1234567/img",
    meta: ["2026", "Series"],
    rating: "8.4",
  };
  const html = cardMarkup(item);
  assertNoRawHostile(html);
  assert.match(html, /^<article class="ui-card ui-card--poster" data-title-id="tt1234567">/);
  assert.match(html, /data-ui-action="details" aria-label="[^"]*, 2026, Series, rated 8\.4"/);
  assert.match(html, /data-ui-action="add"/);
  assert.match(html, /sizes="\(max-width: 680px\) 34vw, 190px"/);
  assert.match(html, /data-fallback="poster"/);
  assert.ok(!html.includes("data-fallback-src"), "no retry when the fallback equals the primary URL");
  assert.match(html, /loading="lazy"/);

  const saved = cardMarkup(item, { inLibrary: true });
  assert.match(saved, /class="ui-card ui-card--poster is-in-library"/);
  assert.match(saved, /data-ui-action="library"/);
  assert.ok(!saved.includes('data-ui-action="add"'));
  assert.ok(!cardMarkup(item, { actions: false }).includes("ui-card__actions"));
  assert.match(cardMarkup(item, { primaryAction: "library" }), /class="ui-card__hit" type="button" data-ui-action="library"/);
});

test("optional poster/body actions are independent accessible buttons without affecting other cards", () => {
  const split = cardMarkup({ title: "JoJo's Bizarre Adventure", key: "jojo", meta: ["S1 E1", "2 min left"] },
    { primaryAction: "resume", bodyAction: "library", actions: false });
  assert.match(split, /<button class="ui-card__hit" type="button" data-ui-action="resume" aria-label="Resume JoJo/);
  assert.match(split, /<\/button><button class="ui-card__hit ui-card__body" type="button" data-ui-action="library"/);
  assert.equal((split.match(/<button /g) || []).length, 2);
  assert.equal((split.match(/<\/button>/g) || []).length, 2);
  assert.ok(!split.includes("<button class=\"ui-card__hit\" type=\"button\" data-ui-action=\"resume\"><span class=\"ui-card__body\""));

  const defaultCard = cardMarkup({ title: "JoJo", key: "jojo" }, { primaryAction: "library", actions: false });
  assert.equal((defaultCard.match(/<button /g) || []).length, 1, "Ordinary Library posters remain a single click target");
  assert.match(defaultCard, /<span class="ui-card__body">/);
});

test("cards without artwork use the inline fallback and skip the retry hooks", () => {
  const html = cardMarkup({ title: "No Art" });
  assert.match(html, /src="data:image\/svg\+xml;charset=utf-8,/);
  assert.ok(!html.includes("data-fallback="), "nothing to fall back from");
  assert.ok(!html.includes("srcset"));
});

test("ranked poster cards carry a small rank tag; wide cards render their variant parts", () => {
  const ranked = cardMarkup({ id: "tt1", title: HOSTILE, image: "https://images.metahub.space/poster/small/tt1/img", meta: ["2026", "Series"], rating: 8.1, badge: "New" }, { rank: 7 });
  assertNoRawHostile(ranked);
  assert.match(ranked, /^<article class="ui-card ui-card--poster" data-title-id="tt1">/);
  assert.match(ranked, /<span class="ui-card__rank" aria-hidden="true">7<\/span><span class="ui-card__badge">/, "the tag sits on the artwork, before any badge");
  assert.match(ranked, /aria-label="Number 7: [^"]+, 2026, Series, rated 8\.1"/);
  assert.match(ranked, /data-ui-action="add"/);
  for (const rank of [0, -3, "x", undefined]) {
    const plain = cardMarkup({ title: "Plain" }, { rank });
    assert.ok(!plain.includes("ui-card__rank"), `no tag for rank ${rank}`);
    assert.match(plain, /aria-label="Plain"/);
  }
  assert.match(cardMarkup({ title: "Saved" }, { rank: 1, inLibrary: true }), /class="ui-card ui-card--poster is-in-library"[\s\S]*ui-card__rank" aria-hidden="true">1<[\s\S]*data-ui-action="library"/);
  assert.ok(!cardMarkup({ title: "x" }, { variant: "ranked" }).includes("ui-card__rank"), "there is no ranked variant, only the rank option");
  assert.match(shelfMarkup({ id: "c", title: "Chart", variant: "chart", cards: ["a"] }), /class="ui-shelf ui-shelf--poster"/, "the chart shelf variant is gone");

  const wide = cardMarkup({
    id: "tt2",
    title: "Wide",
    backdrop: "https://images.metahub.space/background/small/tt2/img",
    backdropFallback: "https://images.metahub.space/background/medium/tt2/img",
    logo: "https://images.metahub.space/logo/medium/tt2/img",
    logoFallback: "https://live.metahub.space/logo/medium/tt2/img",
    description: "A synopsis.",
  }, { variant: "wide" });
  assert.match(wide, /ui-card--wide/);
  assert.match(wide, /class="ui-card__logo" src="https:\/\/images\.metahub\.space\/logo\/medium\/tt2\/img"/);
  assert.match(wide, /data-fallback-src="https:\/\/images\.metahub\.space\/background\/medium\/tt2\/img"/);
  assert.match(wide, /data-fallback-src="https:\/\/live\.metahub\.space\/logo\/medium\/tt2\/img"/);
  assert.match(wide, /<span class="ui-card__text">A synopsis\.<\/span>/);
  assert.match(cardMarkup({ title: "x" }, { variant: "unknown" }), /ui-card--poster/);
});

test("library action markup toggles between add and saved states", () => {
  assert.match(cardLibraryActionMarkup("Dune", false), /data-ui-action="add" aria-label="Add Dune to your Library"|aria-label="Add Dune to your Library"[^>]*data-ui-action="add"/);
  assert.match(cardLibraryActionMarkup("Dune", true), /aria-label="Dune is in your Library"/);
  assert.match(heroLibraryButtonMarkup(false), /data-ui-action="add" data-ui-slot="hero-library"/);
  assert.match(heroLibraryButtonMarkup(true), /<span(?: data-i18n="In Library")?>In Library<\/span>/);
});

test("shelves sanitize ids, label their region and fall back to an empty state", () => {
  const html = shelfMarkup({ id: "Top 10 / TV!", title: "Top 10 TV shows", subtitle: "Updated", cards: ["<i>a</i>", "<i>b</i>"] });
  assert.match(html, /^<section class="ui-shelf ui-shelf--poster" id="top-10-tv" aria-labelledby="top-10-tv-title" data-ui-shelf>/);
  assert.match(html, /<h2 class="ui-shelf__title" id="top-10-tv-title">Top 10 TV shows<\/h2>/);
  assert.equal((html.match(/<li class="ui-shelf__item">/g) || []).length, 2);
  assert.match(html, /data-ui-shelf-prev="" disabled|data-ui-shelf-prev disabled/);
  assert.match(html, /aria-label="Scroll Top 10 TV shows forward"/);

  const empty = shelfMarkup({ id: "x", title: "Nothing", cards: [] });
  assert.match(empty, /class="ui-empty ui-empty--compact"/);
  assert.ok(!empty.includes("ui-shelf__nav"), "no arrows without cards");
  assert.match(shelfMarkup({ id: "!!!", title: "t", variant: "ranked", cards: ["c"] }), /ui-shelf--poster" id="shelf"/);
});

test("the hero renders one active slide, inert siblings and carousel controls", () => {
  const slides = [
    { id: "tt1", title: "First", backdrop: "https://images.metahub.space/background/medium/tt1/img", logo: "https://images.metahub.space/logo/medium/tt1/img", description: "One.", actions: [buttonMarkup({ label: "Go" })] },
    { id: "tt2", title: HOSTILE, eyebrow: { badge: "Movie", text: "#2 in movies" }, meta: ["2024"], rating: 7.9 },
    { id: "tt3", title: "Third" },
  ];
  const html = heroMarkup(slides);
  assertNoRawHostile(html);
  assert.equal((html.match(/class="ui-hero__slide/g) || []).length, 3);
  assert.equal((html.match(/class="ui-hero__slide is-active"/g) || []).length, 1);
  assert.equal((html.match(/aria-hidden="true" inert/g) || []).length, 2);
  assert.match(html, /aria-roledescription="slide" aria-label="1 of 3: First"/);
  assert.match(html, /fetchpriority="high"/);
  assert.equal((html.match(/data-ui-hero-go="/g) || []).length, 3);
  assert.match(html, /data-ui-hero-toggle="" hidden|data-ui-hero-toggle hidden/);
  assert.match(html, /<span class="ui-hero__title-text">First<\/span>/);
  assert.doesNotMatch(html, /ui-hero__eyebrow|#2 in movies|ui-badge--solid">Movie/,
    "category and popularity labels no longer appear above featured titles");
  assert.match(html, /<button class="ui-btn ui-btn--secondary" type="button"><span>Go<\/span><\/button>/);

  const single = heroMarkup([slides[0]]);
  assert.ok(!single.includes("ui-hero__controls"), "a single slide has nothing to rotate");
  assert.equal(heroMarkup([]), "");
  assert.match(skeletonHeroMarkup(), /aria-hidden="true"/);
});

test("empty states and skeletons are safe and hidden from assistive tech where decorative", () => {
  const html = emptyMarkup({ icon: "alert", title: HOSTILE, text: HOSTILE, action: buttonMarkup({ label: "Retry" }) });
  assertNoRawHostile(html);
  assert.match(html, /<div class="ui-empty__action"><button class="ui-btn/);
  assert.match(emptyMarkup({ compact: true }), /ui-empty--compact/);
  const skeleton = skeletonShelfMarkup({ variant: "wide", count: 3 });
  assert.match(skeleton, /aria-hidden="true"/);
  assert.equal((skeleton.match(/ui-skeleton--wide/g) || []).length, 3);
  assert.match(badgeMarkup("1080p", { variant: "outline" }), /^<span class="ui-badge ui-badge--outline">1080p<\/span>$/);
});

test("DOM behaviors are inert outside a browser", () => {
  const controller = bindHero(null);
  assert.equal(typeof controller.go, "function");
  assert.doesNotThrow(() => controller.destroy());
  const handle = toast("Saved");
  assert.doesNotThrow(() => handle.dismiss());
});
