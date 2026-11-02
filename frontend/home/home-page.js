// Home: rows, hero and catalog loading.
import {
  bindHero, bindShelves, buttonMarkup, cardLibraryActionMarkup, cardMarkup, emptyMarkup,
  heroDetailsButtonMarkup, heroLibraryButtonMarkup, heroMarkup, refreshImages, setActiveTab,
  shelfMarkup, skeletonHeroMarkup, skeletonShelfMarkup, toast,
} from "../ui/ui.js";
import {
  buildHomeFeed, catalogCardItem, categoryNoun, heroSlideItem, libraryCategory,
  libraryRecommendations,
} from "../catalog/home-feed.js";
import { animeBrowser, clientFeatures, homeBrowseCategory, state } from "../../app.js";
import { $ } from "../app/dom.js";
import { fetchJson } from "../app/http.js";
import { renderWatchChapters } from "../watch/watch-page.js";
import { libraryArtCached } from "../watch/episode-navigation.js";
import {
  addCatalogPlaceholder, buildLibrarySeries, librarySeriesChapterCount, librarySeriesKey,
} from "../library/library-data.js";
import { libraryCardImage, renderLibrary } from "../library/library-page.js";
import { openHomeTitle, openLibrarySeries, savedTitleBadge } from "../title/title-page.js";
import { animeBrowserMarkup, loadAnimeBrowser, renderAnimeBrowserResults } from "./anime-browser.js";

export const HOME_CATALOG_REFRESH_MS = 10 * 60 * 1000;
let homeCatalogLoadPromise = null;

export let homeTitleIndex = new Map();
let homeHeroController = null;
let homeCatalogError = "";
let homeRenderedCategory = "";
let homeSavedPlace = null;

function rebuildHomeTitleIndex() {
  homeTitleIndex = new Map();
  [state.homeCatalog.series, state.homeCatalog.movies, state.homeCatalog.anime].forEach((list) => {
    (Array.isArray(list) ? list : []).forEach((meta) => {
      if (meta?.id && !homeTitleIndex.has(meta.id)) homeTitleIndex.set(meta.id, meta);
    });
  });
}

function homeLibraryMembership(librarySeries = buildLibrarySeries()) {
  const keys = new Set(librarySeries.map((series) => series.key));
  const ids = new Set(librarySeries.map((series) => series.catalogId).filter(Boolean));
  return (meta) => Boolean(meta) && (keys.has(librarySeriesKey(meta.name)) || Boolean(meta.id && ids.has(meta.id)));
}

function homeLibraryItems(librarySeries) {
  const animeIds = new Set((state.homeCatalog.anime || []).map((meta) => meta.id).filter(Boolean));
  return librarySeries.map((series) => {
    const chapters = librarySeriesChapterCount(series);
    const unit = series.type === "movie" ? "video" : "episode";
    return {
      key: series.key,
      title: series.title,
      ...libraryCardImage(series),
      type: series.type,
      mediaKind: libraryCategory(series, { animeIds, details: libraryArtCached(series) }),
      catalogId: series.catalogId || "",
      meta: [series.type === "movie" ? "Movie" : "Series", chapters ? `${chapters} ${unit}${chapters === 1 ? "" : "s"}` : "No sources yet"],
    };
  });
}

function homeRowMarkup(row, { category, isInLibrary }) {
  const id = `home-row-${row.id}`;
  if (row.variant === "library") {
    return shelfMarkup({
      id,
      title: row.title,
      subtitle: row.subtitle,
      cards: row.items.map((item) => cardMarkup(item, { actions: false, primaryAction: "library" })),
    });
  }
  return shelfMarkup({
    id,
    title: row.title,
    subtitle: row.subtitle,
    variant: row.variant,
    cards: row.items.map((meta, index) => cardMarkup(catalogCardItem(meta, { category, detailed: row.variant === "wide" }), {
      variant: row.variant,
      inLibrary: isInLibrary(meta),
      rank: row.ranked ? index + 1 : 0,
    })),
  });
}

function homeHeroSlides(hero, isInLibrary) {
  const savedSeries = buildLibrarySeries();
  return hero.map((meta) => {
    const match = savedSeries.find((series) => (meta?.id && series.catalogId === meta.id)
      || series.key === librarySeriesKey(meta.name));
    return {
      ...heroSlideItem(meta),
      actions: [heroLibraryButtonMarkup(isInLibrary(meta), savedTitleBadge(match)?.label), heroDetailsButtonMarkup()],
    };
  });
}

function addHomeTitleToLibrary(meta) {
  const entry = addCatalogPlaceholder(meta, { aliases: [meta.name], externalSource: "HOME" });
  if (!entry) return;
  markHomeTitleInLibrary(meta);
  toast(`${meta.name} added to your Library`);
  if ($("#view-library")?.classList.contains("is-active")) renderLibrary();
}

// Flip every card and hero button for this title to the saved state without re-rendering rows.
export function markHomeTitleInLibrary(meta) {
  if (!meta?.id) return;
  document.querySelectorAll(`[data-title-id="${CSS.escape(meta.id)}"]`).forEach((holder) => {
    holder.classList.add("is-in-library");
    const slot = holder.querySelector('[data-ui-slot="library"]');
    if (slot) {
      const hadFocus = slot.contains(document.activeElement);
      slot.innerHTML = cardLibraryActionMarkup(meta.name, true);
      if (hadFocus) slot.querySelector("button")?.focus();
    }
    const heroButton = holder.querySelector('[data-ui-slot="hero-library"]');
    if (heroButton) {
      const hadFocus = heroButton === document.activeElement;
      heroButton.outerHTML = heroLibraryButtonMarkup(true);
      if (hadFocus) holder.querySelector('[data-ui-slot="hero-library"]')?.focus();
    }
  });
}

// One delegated handler for Home and "Recommended next": cards, hero buttons and retry.
export function handleCatalogCardAction(event) {
  const trigger = event.target.closest("[data-ui-action]");
  if (!trigger || !event.currentTarget.contains(trigger)) return;
  const action = trigger.dataset.uiAction;
  if (action === "retry") {
    void loadHomeCatalog({ force: true });
    return;
  }
  const holder = trigger.closest("[data-title-id], [data-series-key]");
  if (!holder) return;
  if (!holder.dataset.titleId) {
    openLibrarySeries(holder.dataset.seriesKey);
    return;
  }
  const meta = homeTitleIndex.get(holder.dataset.titleId);
  if (!meta) return;
  if (action === "add") addHomeTitleToLibrary(meta);
  else openHomeTitle(meta);
}

export function renderLibraryRecommendations(seriesGroups = buildLibrarySeries()) {
  const section = $("#library-recommendations");
  if (!section) return;
  if (!state.homeLoaded) {
    section.innerHTML = homeCatalogError
      ? shelfMarkup({
        id: "library-recommended",
        title: "Recommended next",
        empty: emptyMarkup({ title: "Recommendations unavailable", text: "The catalog could not be loaded. Try again from Home.", compact: true }),
      })
      : skeletonShelfMarkup({ count: 8 });
    return;
  }
  const isInLibrary = homeLibraryMembership(seriesGroups);
  const picks = libraryRecommendations(state.homeCatalog, { seed: state.homeCatalog.seed, isInLibrary });
  section.innerHTML = shelfMarkup({
    id: "library-recommended",
    title: "Recommended next",
    cards: picks.map((meta) => cardMarkup(catalogCardItem(meta), { inLibrary: false })),
    empty: emptyMarkup({ title: "No new recommendations", compact: true }),
  });
  bindShelves(section);
  refreshImages(section);
}

function renderHomeLoading(hero, rows) {
  homeHeroController?.destroy();
  homeHeroController = null;
  homeRenderedCategory = "";
  hero.hidden = false;
  hero.innerHTML = skeletonHeroMarkup();
  rows.setAttribute("aria-busy", "true");
  rows.innerHTML = `<p class="ui-visually-hidden">Loading the catalog…</p>${skeletonShelfMarkup()}${skeletonShelfMarkup()}${skeletonShelfMarkup()}`;
}

function renderHomeError(hero, rows, message) {
  homeHeroController?.destroy();
  homeHeroController = null;
  homeRenderedCategory = "";
  hero.hidden = true;
  hero.innerHTML = "";
  rows.removeAttribute("aria-busy");
  const detail = String(message || "The catalog service did not respond.").trim();
  rows.innerHTML = emptyMarkup({
    icon: "alert",
    title: "Couldn't load the catalog",
    text: /[.!?]$/.test(detail) ? detail : `${detail}.`,
    action: buttonMarkup({ label: "Try again", icon: "refresh", attrs: { "data-ui-action": "retry" } }),
  });
}

// Re-renders of the same category (background refresh, sources added from search) should not
// throw the viewer back to the start of every row or to the first hero slide.
function captureHomePlace(hero, rows) {
  const saved = homeSavedPlace;
  homeSavedPlace = null;
  const place = { tracks: new Map(), heroTitleId: "", focus: null };
  if (homeRenderedCategory !== homeBrowseCategory) return place;
  rows.querySelectorAll(".ui-shelf[id] > .ui-shelf__track").forEach((track) => {
    if (track.scrollLeft > 0) place.tracks.set(track.parentElement.id, track.scrollLeft);
  });
  // Hiding the view (display: none) resets row scroll, so use the snapshot taken on leave.
  if (!place.tracks.size && saved) saved.tracks.forEach((left, id) => place.tracks.set(id, left));
  place.heroTitleId = hero.querySelector(".ui-hero__slide.is-active")?.dataset.titleId || saved?.heroTitleId || "";
  const active = document.activeElement;
  const holder = active?.closest?.("[data-title-id], [data-series-key]");
  if (holder && (rows.contains(active) || hero.contains(active))) {
    place.focus = {
      shelfId: active.closest(".ui-shelf[id]")?.id || "",
      titleId: holder.dataset.titleId || "",
      seriesKey: holder.dataset.seriesKey || "",
      action: active.dataset.uiAction || "",
    };
  }
  return place;
}

// Remember where Home is before another view replaces it.
export function saveHomePlace() {
  homeSavedPlace = captureHomePlace($("#home-hero"), $("#home-rows"));
}

function restoreHomePlace(place, hero, feed) {
  if (place.heroTitleId && homeHeroController) {
    const index = feed.hero.findIndex((meta) => meta.id === place.heroTitleId);
    if (index > 0) homeHeroController.go(index);
  }
  place.tracks.forEach((left, id) => {
    const track = document.getElementById(id)?.querySelector(":scope > .ui-shelf__track");
    if (track) track.scrollLeft = left;
  });
  const focus = place.focus;
  if (!focus) return;
  const scope = focus.shelfId ? document.getElementById(focus.shelfId) : hero;
  const selector = focus.titleId ? `[data-title-id="${CSS.escape(focus.titleId)}"]` : `[data-series-key="${CSS.escape(focus.seriesKey)}"]`;
  const holder = scope?.querySelector(selector);
  const target = holder?.querySelector(`[data-ui-action="${CSS.escape(focus.action)}"]`)
    || holder?.querySelector("[data-ui-action]");
  target?.focus({ preventScroll: true });
}

export function renderHome() {
  const hero = $("#home-hero");
  const rows = $("#home-rows");
  if (!hero || !rows) return;
  // Every route back to Home (switchView → loadHomeCatalog) renders it, so skip hidden renders.
  // They would also lose row scroll positions, which can't be restored on a hidden view.
  if (!$("#view-home")?.classList.contains("is-active")) return;
  setActiveTab($("#home-tabs"), homeBrowseCategory);
  $("#home-panel")?.setAttribute("aria-labelledby", `home-tab-${homeBrowseCategory}`);
  $("#home-topbar")?.classList.toggle("is-solid", window.scrollY > 24);
  // A feature category (Comics…) renders its own hero and rows, without the video catalog.
  const homePage = $("#view-home");
  if (typeof clientFeatures !== "undefined" && clientFeatures.homeCategoryIds.includes(homeBrowseCategory)) {
    homeHeroController?.destroy();
    homeHeroController = null;
    rows.removeAttribute("aria-busy");
    if (homePage) homePage.dataset.featureCategory = homeBrowseCategory;
    clientFeatures.showHomeCategory(homeBrowseCategory, { hero, rows });
    homeRenderedCategory = homeBrowseCategory;
    return;
  }
  if (homePage) delete homePage.dataset.featureCategory;
  if (!state.homeLoaded) {
    if (homeCatalogError) renderHomeError(hero, rows, homeCatalogError);
    else renderHomeLoading(hero, rows);
    return;
  }
  const place = captureHomePlace(hero, rows);
  const librarySeries = buildLibrarySeries();
  const isInLibrary = homeLibraryMembership(librarySeries);
  const feed = buildHomeFeed(state.homeCatalog, {
    category: homeBrowseCategory,
    seed: state.homeCatalog.seed,
    isInLibrary,
    library: homeLibraryItems(librarySeries),
  });
  homeHeroController?.destroy();
  hero.innerHTML = heroMarkup(homeHeroSlides(feed.hero, isInLibrary));
  hero.hidden = feed.hero.length === 0;
  homeHeroController = feed.hero.length ? bindHero(hero) : null;
  rows.removeAttribute("aria-busy");
  const rowMarkup = feed.rows.map((row) => homeRowMarkup(row, { category: feed.category, isInLibrary }));
  if (feed.category === "anime") {
    const topIndex = feed.rows.findIndex((row) => row.id === "top-anime");
    if (topIndex >= 0) rowMarkup[topIndex] = animeBrowserMarkup();
    else rowMarkup.unshift(animeBrowserMarkup());
  }
  rows.innerHTML = feed.rows.length || feed.category === "anime"
    ? rowMarkup.join("")
    : emptyMarkup({
      icon: "film",
      title: `No ${categoryNoun(feed.category)} to show`,
      text: "The catalog came back empty. Try again in a moment.",
      action: buttonMarkup({ label: "Try again", icon: "refresh", attrs: { "data-ui-action": "retry" } }),
    });
  bindShelves(rows);
  refreshImages(hero);
  refreshImages(rows);
  restoreHomePlace(place, hero, feed);
  homeRenderedCategory = feed.category;
  if (feed.category === "anime") {
    renderAnimeBrowserResults();
    if (!animeBrowser.loaded && !animeBrowser.loading) void loadAnimeBrowser();
  }
}

export async function loadHomeCatalog({ force = false, rotate = false } = {}) {
  if (state.homeLoaded && rotate) {
    state.homeCatalog.seed = (Number(state.homeCatalog.seed) || 0) + 1;
    renderHome();
    if ($("#view-library")?.classList.contains("is-active")) renderLibraryRecommendations();
    toast("Fresh picks shuffled in");
    return;
  }
  const fresh = state.homeLoaded && Date.now() - state.homeCatalogUpdatedAt < HOME_CATALOG_REFRESH_MS;
  if (fresh && !force) {
    renderHome();
    if ($("#view-library")?.classList.contains("is-active")) renderLibraryRecommendations();
    return;
  }
  if (homeCatalogLoadPromise) {
    if (!state.homeLoaded) renderHome();
    return homeCatalogLoadPromise;
  }
  if (!state.homeLoaded) {
    homeCatalogError = "";
    renderHome();
  }
  homeCatalogLoadPromise = (async () => {
    try {
      const data = await fetchJson("/api/catalog/home");
      state.homeCatalog = {
        movies: data.movies || [],
        series: data.series || [],
        anime: data.anime || [],
        seed: Number(data.seed) || Math.floor(Date.now() / HOME_CATALOG_REFRESH_MS),
        stale: Boolean(data.stale),
        partial: Boolean(data.partial),
        generatedAt: Number(data.generatedAt) || 0,
      };
      rebuildHomeTitleIndex();
      homeCatalogError = "";
      state.homeLoaded = true;
      state.homeCatalogUpdatedAt = Date.now();
      renderHome();
      if ($("#view-watch")?.classList.contains("is-active")) renderWatchChapters();
      if ($("#view-library")?.classList.contains("is-active")) renderLibrary();
    } catch (error) {
      if (state.homeLoaded) {
        toast(error.message || "Could not refresh the Home catalog", { tone: "error" });
      } else {
        homeCatalogError = error.message || "Could not load the Home catalog.";
        renderHome();
        if ($("#view-library")?.classList.contains("is-active")) renderLibraryRecommendations();
      }
    }
  })().finally(() => {
    homeCatalogLoadPromise = null;
  });
  return homeCatalogLoadPromise;
}
