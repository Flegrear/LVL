// Home › Comics discovery: the same layout as Home's anime
// browser (filters bar, results grid, Load more), for comics in general, from
// AniList through /api/comics/browse. Adult titles never appear. Cards open the
// comic like any comic card (data-comics-open). Also the featured carousel.
import { bindHero, buttonMarkup, escapeHtml, heroMarkup, refreshImages } from "../ui/ui.js";
import { t } from "../ui/ui-i18n.js";
import { comicsApi } from "./comics-api.js";
import { formatLabel } from "./comics-render.js";
import { sourceFilterMarkup } from "./comics-sources.js";
import { readSourceChoice, reconcileFavoriteSource, selectFavoriteSource, sourceChoice, sourceChoices, watchFavoriteSource } from "./comics-source-filter.js";

export const BROWSER_GENRES = Object.freeze(["Action", "Adventure", "Comedy", "Drama", "Ecchi", "Fantasy", "Horror", "Mahou Shoujo", "Mecha", "Music",
  "Mystery", "Psychological", "Romance", "Sci-Fi", "Slice of Life", "Sports", "Supernatural", "Thriller"]);
// Starts on this year's comics, as the anime browser starts on the current season.
const DEFAULT_FILTERS = Object.freeze({ q: "", type: "", sort: "POPULARITY_DESC", status: "", genre: "", year: String(new Date().getFullYear()) });
// Kept while the app is open, like the anime browser's filters.
const state = { filters: { ...DEFAULT_FILTERS }, items: [], page: 0, hasNextPage: false, loading: false, loaded: false, error: "", requestId: 0 };
const changed = (filters, selectedSource = readSourceChoice()) =>
  Object.keys(DEFAULT_FILTERS).some((key) => (filters[key] || "") !== DEFAULT_FILTERS[key]) || Boolean(selectedSource);

const select = (label, name, options, value) => `<label>${escapeHtml(t(label))}<select name="${name}">${options.map(([key, text]) =>
  `<option value="${escapeHtml(key)}"${String(value) === String(key) ? " selected" : ""}>${escapeHtml(t(text))}</option>`).join("")}</select></label>`;

export function comicBrowserMarkup(filters = state.filters, { year = new Date().getFullYear() } = {}) {
  const years = [["", "All years"], ...Array.from({ length: year + 1 - 1950 + 1 }, (_v, i) => [String(year + 1 - i), String(year + 1 - i)])];
  return `<section class="anime-browser comic-browser" id="comic-browser" aria-label="${escapeHtml(t("Comic discovery"))}">`
    + `<form class="anime-browser-filters" data-comic-browser role="search">`
    + `<label>${escapeHtml(t("Search"))}<input name="q" type="search" maxlength="100" autocomplete="off" placeholder="${escapeHtml(t("Comic title"))}" value="${escapeHtml(filters.q)}" /></label>`
    + select("Type", "type", [["", "All types"], ["manga", "Manga"], ["manhwa", "Manhwa"], ["manhua", "Manhua"], ["oneshot", "One-shot"]], filters.type)
    + select("Rank by", "sort", [["POPULARITY_DESC", "Most popular"], ["SCORE_DESC", "Highest rated"], ["TRENDING_DESC", "Trending"], ["START_DATE_DESC", "Newest"], ["FAVOURITES_DESC", "Most favorited"]], filters.sort)
    + select("Status", "status", [["", "Any status"], ["RELEASING", "Releasing"], ["FINISHED", "Finished"], ["HIATUS", "On hiatus"], ["CANCELLED", "Cancelled"], ["NOT_YET_RELEASED", "Not yet released"]], filters.status)
    + select("Genre", "genre", [["", "Any genre"], ...BROWSER_GENRES.map((genre) => [genre, genre])], filters.genre)
    + select("Year", "year", years, filters.year)
    // Source is a favorite-provider choice, not an AniList API parameter. It
    // lives inside this existing filter form so the phone's Filters disclosure
    // can display and reset it alongside Type, Genre and Year.
    + `<div class="comic-browser__source-filter" data-comic-browser-source-filter><input type="hidden" name="source" value="" /></div>`
    + buttonMarkup({ label: "Apply filters", variant: "primary", size: "sm", type: "submit" })
    + buttonMarkup({ label: "Reset", variant: "ghost", size: "sm", attrs: { "data-comic-browser-reset": "", hidden: !changed(filters) } })
    + `</form><p class="anime-browser-status" role="status" aria-live="polite"></p><div class="anime-browser-grid"></div>`
    + `<div class="anime-browser-footer">${buttonMarkup({ label: "Load more", attrs: { "data-comic-browser-more": "", hidden: true } })}</div></section>`;
}

export function comicBrowserCardMarkup(comic, { inLibrary = false } = {}) {
  const meta = [t(formatLabel(comic)), comic.year ? String(comic.year) : "", Number(comic.score) > 0 ? `${Number(comic.score).toFixed(1)}/10` : ""].filter(Boolean).join(" - ");
  return `<button class="anime-browser-card comic-browser-card" type="button" data-comics-open="${escapeHtml(String(comic.anilistId))}">`
    + `<span class="anime-browser-art">${comic.cover ? `<img src="${escapeHtml(comic.cover)}" alt="" loading="lazy" decoding="async" data-fallback="poster" data-fallback-title="${escapeHtml(comic.title)}" />` : ""}`
    + (inLibrary ? `<span class="comic-browser-badge">${escapeHtml(t("In Library"))}</span>` : "") + "</span>"
    + `<strong>${escapeHtml(comic.title)}</strong><span>${escapeHtml(meta)}</span></button>`;
}

function paintResults(section, inLibrary) {
  if (!section?.isConnected) return;
  const status = section.querySelector(".anime-browser-status");
  const grid = section.querySelector(".anime-browser-grid");
  const more = section.querySelector("[data-comic-browser-more]");
  status.textContent = state.error || (state.loading ? t("Loading comics from AniList…") : state.loaded ? t("{count} comics", { count: state.items.length }) : "");
  status.classList.toggle("is-error", Boolean(state.error));
  grid.innerHTML = state.items.map((comic) => comicBrowserCardMarkup(comic, { inLibrary: inLibrary(comic) })).join("")
    || (state.loaded && !state.loading ? `<p class="anime-browser-empty">${escapeHtml(t("No comics matched these filters."))}</p>` : "");
  more.hidden = !state.hasNextPage || Boolean(state.error);
  more.disabled = state.loading;
  more.querySelector("span").textContent = t(state.loading ? "Loading…" : "Load more");
  refreshImages(grid);
}

async function load(section, inLibrary, { append = false } = {}) {
  const token = ++state.requestId;
  const page = append ? state.page + 1 : 1;
  state.loading = true;
  state.error = "";
  if (!append) Object.assign(state, { items: [], page: 0, loaded: false, hasNextPage: false });
  paintResults(section, inLibrary);
  try {
    const data = await comicsApi.browse({ ...state.filters, page });
    if (token !== state.requestId) return;
    const known = new Set(state.items.map((item) => item.anilistId));
    state.items = append ? [...state.items, ...(data.items || []).filter((item) => !known.has(item.anilistId))] : data.items || [];
    Object.assign(state, { page, hasNextPage: Boolean(data.hasNextPage), loaded: true });
  } catch (error) {
    if (token === state.requestId) state.error = error.message || t("Couldn't load comics");
  } finally {
    if (token === state.requestId) { state.loading = false; paintResults(section, inLibrary); }
  }
}

// Wires a freshly drawn browser; shows what's loaded and loads the first page once.
export function mountComicBrowser(section, { inLibrary = () => false } = {}) {
  if (!section) return;
  const form = section.querySelector("[data-comic-browser]");
  let favorites = [];
  let favoritesLoaded = false;
  let selectedSource = readSourceChoice();
  let favoriteRevision = 0;
  const localListeners = new AbortController();
  const sourceArea = form.querySelector("[data-comic-browser-source-filter]");
  const sourceInput = sourceArea?.querySelector('input[name="source"]');
  const paintSourceFilter = () => {
    if (!sourceArea || !section.isConnected) return;
    const selected = sourceChoice(selectedSource, favorites);
    sourceArea.querySelector("[data-comics-source-filter]")?.remove();
    // Keep the phone summary's hidden input across updates, without rendering
    // a second native source selector or changing AniList's request filters.
    sourceArea.insertAdjacentHTML("beforeend", sourceFilterMarkup(favorites, selected));
    if (sourceInput) {
      sourceInput.value = selected;
      sourceInput.dataset.sourceLabel = sourceArea.querySelector("[data-comics-source-filter] summary strong")?.textContent || "";
      sourceInput.dispatchEvent(new Event("input", { bubbles: true }));
    }
    if (!favorites.length && favoritesLoaded && !sourceArea.querySelector("[data-comic-no-favorites]")) {
      sourceArea.insertAdjacentHTML("beforeend", `<p class="comic-source__meta" data-comic-no-favorites>${escapeHtml(t("Add favorite sources in Settings › Comics."))}</p>`);
    } else if (favorites.length) sourceArea.querySelector("[data-comic-no-favorites]")?.remove();
    const reset = form.querySelector("[data-comic-browser-reset]");
    if (reset) reset.hidden = !changed(state.filters, selectedSource);
  };
  const initialFavoritesRevision = favoriteRevision;
  comicsApi.favorites().then(({ favorites: values = [] }) => {
    if (!sourceLifecycle.isActive() || initialFavoritesRevision !== favoriteRevision) return;
    favorites = sourceChoices(values);
    favoritesLoaded = true;
    selectedSource = reconcileFavoriteSource(favorites);
    paintSourceFilter();
  }).catch(() => {
    if (!sourceLifecycle.isActive()) return;
    sourceArea?.insertAdjacentHTML("beforeend", `<p class="comic-source__error" role="alert">${escapeHtml(t("Couldn't load sources."))}</p>`);
  });
  const onSourceChange = (event) => {
    if (Array.isArray(event.detail?.favorites)) {
      ++favoriteRevision;
      favorites = sourceChoices(event.detail.favorites);
      favoritesLoaded = true;
    }
    selectedSource = sourceChoice(event.detail?.sourceId, favorites);
    if (favoritesLoaded) paintSourceFilter();
  };
  const sourceLifecycle = watchFavoriteSource(section, onSourceChange, () => {
    localListeners.abort();
    if (state.loading) {
      ++state.requestId;
      state.loading = false;
      state.loaded = false;
    }
  });
  const read = () => {
    const data = new FormData(form);
    for (const key of Object.keys(DEFAULT_FILTERS)) state.filters[key] = String(data.get(key) || "").trim();
    const reset = form.querySelector("[data-comic-browser-reset]");
    if (reset) reset.hidden = !changed(state.filters, selectedSource);
  };
  form.addEventListener("submit", (event) => { event.preventDefault(); read(); void load(section, inLibrary); }, { signal: localListeners.signal });
  form.addEventListener("change", (event) => {
    if (event.target.name !== "q" && event.target.name !== "source") form.requestSubmit();
  }, { signal: localListeners.signal });
  section.addEventListener("click", (event) => {
    const sourceButton = event.target.closest("[data-comics-source-choice]");
    if (sourceButton && form.contains(sourceButton) && favoritesLoaded) {
      selectedSource = selectFavoriteSource(sourceButton.dataset.comicsSourceChoice, favorites);
      sourceArea.querySelector("[data-comics-source-filter] summary")?.focus({ preventScroll: true });
      return;
    }
    if (event.target.closest("[data-comic-browser-more]") && !state.loading) void load(section, inLibrary, { append: true });
    if (event.target.closest("[data-comic-browser-reset]")) {
      sourceLifecycle.dispose();
      selectedSource = "";
      selectFavoriteSource("", favorites);
      state.filters = { ...DEFAULT_FILTERS };
      Object.assign(state, { requestId: state.requestId + 1, items: [], page: 0, loaded: false, loading: false, hasNextPage: false });
      const fresh = document.createElement("div");
      fresh.innerHTML = comicBrowserMarkup();
      section.replaceWith(fresh.firstElementChild);
      mountComicBrowser(document.querySelector("#comic-browser"), { inLibrary });
    }
  }, { signal: localListeners.signal });
  form.addEventListener("keydown", (event) => {
    const disclosure = event.target.closest("[data-comics-source-filter]");
    if (!disclosure) return;
    if (event.key === "Escape" && disclosure.open) {
      disclosure.open = false;
      disclosure.querySelector("summary")?.focus();
      event.preventDefault();
    } else if (["ArrowDown", "ArrowUp"].includes(event.key) && event.target.matches("[data-comics-source-choice]")) {
      const buttons = [...disclosure.querySelectorAll("[data-comics-source-choice]")];
      const at = buttons.indexOf(event.target);
      buttons[(at + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length]?.focus();
      event.preventDefault();
    }
  }, { signal: localListeners.signal });
  if (state.loaded || state.loading) paintResults(section, inLibrary);
  else void load(section, inLibrary);
}

// Featured comics: a carousel like Home's, from the trending and new rows (only titles with a banner).
let heroController = null;
let heroWatch = null;
export function featuredSlides(sections, { limit = 6, inLibrary = () => false } = {}) {
  const pool = ["trending", "new"].flatMap((id) => sections.find((section) => section.id === id)?.items || []);
  const seen = new Set();
  return pool.filter((comic) => comic.banner && !seen.has(comic.anilistId) && seen.add(comic.anilistId)).slice(0, limit).map((comic) => ({
    title: comic.title, backdrop: comic.banner,
    meta: [t(formatLabel(comic)), comic.year ? String(comic.year) : "", ...(comic.genres || []).slice(0, 2).map((genre) => t(genre))].filter(Boolean),
    rating: Number(comic.score) > 0 ? Number(comic.score).toFixed(1) : "",
    description: comic.description ? comic.description.split("\n")[0].slice(0, 280) : "",
    actions: [buttonMarkup({ label: inLibrary(comic) ? "Open" : "Details", variant: "primary", size: "lg", icon: inLibrary(comic) ? "play" : "info", attrs: { "data-comics-open": String(comic.anilistId) } })],
  }));
}
export function showFeatured(hero, slides) {
  heroController?.destroy();
  heroController = null;
  heroWatch?.disconnect();
  heroWatch = null;
  if (!hero) return;
  hero.innerHTML = slides.length ? heroMarkup(slides, { label: t("Featured comics") }) : "";
  hero.hidden = !slides.length;
  if (!slides.length) return;
  heroController = bindHero(hero);
  refreshImages(hero);
  // Home's other tabs draw their own carousel here: stop this one when its slides are replaced.
  const viewport = hero.querySelector(".ui-hero__viewport");
  heroWatch = new MutationObserver(() => {
    if (hero.contains(viewport)) return;
    heroController?.destroy();
    heroController = null;
    heroWatch?.disconnect();
    heroWatch = null;
  });
  heroWatch.observe(hero, { childList: true });
}
