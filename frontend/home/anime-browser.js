// Home's anime browser.
import { artworkFallback, escapeHtml, refreshImages } from "../ui/ui.js";
import {
  animeCatalogCombinedSearchNames, animeCatalogRootSearchNames, animeCatalogSearchNames,
  animeCatalogSubtitleSearchNames, verifiedAnimeCatalogMatch, verifiedAnimeLibraryCatalogMatch,
} from "../catalog/anime-catalog-match.js";
import { animeBrowser, homeBrowseCategory } from "../../app.js";
import { $ } from "../app/dom.js";
import { fetchJson } from "../app/http.js";
import { viewActive } from "../app/navigation.js";
import { buildLibrarySeries } from "../library/library-data.js";
import { openTitlePage } from "../title/title-page.js";
import { homeTitleIndex } from "./home-page.js";

const animeBrowserTitleCache = new Map();
export let animeBrowserPrefetchTimer = null;

function animeBrowserExactCatalogMatch(media, candidates = []) {
  return verifiedAnimeCatalogMatch(media, candidates);
}

// AniList IDs are not IMDb IDs. Resolve only exact English/romaji aliases, reusing
// a known local catalog ID first and sharing pending lookups across hover and click.
export function resolveAnimeBrowserCatalog(media) {
  const key = Number(media.id);
  const cached = animeBrowserTitleCache.get(key);
  if (cached && cached.until > Date.now()) return cached.promise;
  const linkedLibrary = buildLibrarySeries();
  const local = verifiedAnimeLibraryCatalogMatch(media, linkedLibrary)
    || animeBrowserExactCatalogMatch(media, [
    ...homeTitleIndex.values(),
    ...linkedLibrary.filter((series) => series.catalogId).map((series) => ({
      id: series.catalogId, name: series.title,
      type: series.type === "movie" ? "movie" : "series",
    })),
  ]);
  if (local) {
    const promise = Promise.resolve(local);
    animeBrowserTitleCache.set(key, { promise, until: Date.now() + 10 * 60_000 });
    return promise;
  }
  const distinctNames = animeCatalogSearchNames(media);
  if (!distinctNames.length) return Promise.reject(new Error("This title has no searchable name."));
  // Search aliases concurrently and accept the earliest VERIFIED exact match.
  // Before this fix, two slow sequential searches took >8 seconds for one card.
  const searchNames = (names) => Promise.any(names.map(async (title) => {
    const response = await fetchJson(`/api/catalog/search?q=${encodeURIComponent(title)}`);
    const match = animeBrowserExactCatalogMatch(media, response.results || []);
    if (!match) throw new Error("no-exact-match");
    return match;
  }));
  const promise = searchNames(distinctNames).catch(async (originalError) => {
    const roots = animeCatalogRootSearchNames(media);
    // Some providers omit the original series from sequel-title searches.
    // Query the show's root only when both primary aliases failed.
    if (roots.length) {
      try { return await searchNames(roots); }
      catch (rootError) {
        originalError.errors = [...(originalError.errors || []), ...(rootError.errors || [])];
      }
    }
    // Cross-language combinations and shortened romanized subtitles can
    // retrieve the original IMDb series when provider token matching fails.
    // Neither search expression becomes a trusted identity alias.
    const alternateQueries = [...animeCatalogSubtitleSearchNames(media), ...animeCatalogCombinedSearchNames(media)];
    if (alternateQueries.length) {
      try { return await searchNames(alternateQueries); }
      catch (alternateError) {
        originalError.errors = [...(originalError.errors || []), ...(alternateError.errors || [])];
      }
    }
    if ((originalError?.errors || []).some((item) => item.message !== "no-exact-match")) {
      throw new Error("Catalog search is temporarily unavailable. Please retry.");
    }
    throw new Error("No verified LVL catalog match found for this anime.");
  });
  animeBrowserTitleCache.set(key, { promise, until: Date.now() + 10 * 60_000 });
  promise.catch(() => {
    if (animeBrowserTitleCache.get(key)?.promise === promise) animeBrowserTitleCache.delete(key);
  });
  if (animeBrowserTitleCache.size > 150) animeBrowserTitleCache.delete(animeBrowserTitleCache.keys().next().value);
  return promise;
}
const animeBrowserSelect = (label, name, values) => `<label>${label}<select name="${name}">${values.map(([value, title]) =>
  `<option value="${escapeHtml(value)}"${String(animeBrowser.filters[name]) === String(value) ? " selected" : ""}>${escapeHtml(title)}</option>`).join("")}</select></label>`;
export function animeBrowserMarkup() {
  const year = new Date().getFullYear();
  const years = [["all", "All years"], ...Array.from({ length: year - 1940 + 2 }, (_, index) => [String(year + 1 - index), String(year + 1 - index)])];
  const seasons = [["", "All seasons"], ...["WINTER", "SPRING", "SUMMER", "FALL"].map((season) => [season, season[0] + season.slice(1).toLowerCase()])];
  return `<section class="anime-browser" id="anime-browser" aria-label="Anime discovery">
    <form id="anime-browser-form" class="anime-browser-filters" role="search">
      <label>Search <input name="search" type="search" placeholder="Anime title" maxlength="90" value="${escapeHtml(animeBrowser.filters.search)}" /></label>
      ${animeBrowserSelect("Year", "year", years)}
      ${animeBrowserSelect("Season", "season", seasons)}
      ${animeBrowserSelect("Rank by", "sort", [["POPULARITY_DESC", "Most popular"], ["SCORE_DESC", "Highest rated"], ["TRENDING_DESC", "Trending"], ["START_DATE_DESC", "Newest"]])}
      ${animeBrowserSelect("Format", "format", [["", "All formats"], ...["TV", "TV_SHORT", "MOVIE", "OVA", "ONA", "SPECIAL"].map((value) => [value, value.replace("_", " ")])])}
      ${animeBrowserSelect("Status", "status", [["", "Any status"], ["RELEASING", "Airing"], ["FINISHED", "Finished"], ["NOT_YET_RELEASED", "Upcoming"], ["HIATUS", "Hiatus"]])}
      ${animeBrowserSelect("Genre", "genre", [["", "Any genre"], ...["Action", "Adventure", "Comedy", "Drama", "Fantasy", "Horror", "Mahou Shoujo", "Mecha", "Music", "Mystery", "Psychological", "Romance", "Sci-Fi", "Slice of Life", "Sports", "Supernatural", "Thriller"].map((genre) => [genre, genre])])}
      <button type="submit" class="ui-btn ui-btn--primary ui-btn--sm">Apply filters</button>
    </form>
    <p id="anime-browser-status" class="anime-browser-status" role="status" aria-live="polite"></p>
    <div id="anime-browser-results" class="anime-browser-grid"></div>
    <div class="anime-browser-footer"><button id="anime-browser-more" type="button" class="ui-btn ui-btn--secondary" hidden>Load more</button></div>
  </section>`;
}
export function renderAnimeBrowserResults() {
  if (!viewActive("home") || homeBrowseCategory !== "anime") return;
  const grid = $("#anime-browser-results");
  const status = $("#anime-browser-status");
  const more = $("#anime-browser-more");
  if (!grid || !status || !more) return;
  status.textContent = animeBrowser.error || (animeBrowser.loading ? "Loading anime from AniList…" : animeBrowser.loaded ? `${animeBrowser.items.length} anime` : "");
  status.classList.toggle("is-error", Boolean(animeBrowser.error));
  grid.innerHTML = animeBrowser.items.map((item) => `<button class="anime-browser-card" type="button" data-anime-id="${item.id}">
    <span class="anime-browser-art"><img src="${escapeHtml(item.cover || artworkFallback(item.title))}" alt="" loading="lazy" decoding="async" data-fallback="poster" data-fallback-title="${escapeHtml(item.title)}"${item.coverFallback && item.coverFallback !== item.cover ? ` data-fallback-src="${escapeHtml(item.coverFallback)}"` : ""} /></span>
    <strong>${escapeHtml(item.title)}</strong>
    <span>${escapeHtml([item.year, item.season && item.season[0] + item.season.slice(1).toLowerCase(), item.format, Number(item.score) > 0 && Number(item.score) <= 100 ? `${(Number(item.score) / 10).toFixed(1)}/10` : ""].filter(Boolean).join(" - "))}</span>
  </button>`).join("") || (animeBrowser.loaded && !animeBrowser.loading ? '<p class="anime-browser-empty">No anime matched these filters.</p>' : "");
  more.hidden = !animeBrowser.hasNextPage || Boolean(animeBrowser.error);
  more.disabled = animeBrowser.loading;
  more.textContent = animeBrowser.loading ? "Loading…" : "Load more";
  refreshImages(grid);
}
export async function loadAnimeBrowser({ append = false } = {}) {
  const token = ++animeBrowser.requestId;
  ++animeBrowser.openRequestId;
  const page = append ? animeBrowser.page + 1 : 1;
  animeBrowser.loading = true;
  animeBrowser.error = "";
  if (!append) { animeBrowser.items = []; animeBrowser.page = 0; animeBrowser.loaded = false; animeBrowser.hasNextPage = false; }
  renderAnimeBrowserResults();
  try {
    const params = new URLSearchParams({ ...animeBrowser.filters, page: String(page) });
    const data = await fetchJson(`/api/anime/discover?${params}`);
    if (token !== animeBrowser.requestId) return;
    animeBrowser.items = append ? [...animeBrowser.items, ...(data.items || []).filter((item) => !animeBrowser.items.some((existing) => existing.id === item.id))] : data.items || [];
    animeBrowser.page = page;
    animeBrowser.hasNextPage = Boolean(data.hasNextPage);
    animeBrowser.loaded = true;
  } catch (error) {
    if (token !== animeBrowser.requestId) return;
    animeBrowser.error = error.message || "Could not load AniList anime";
  } finally {
    if (token === animeBrowser.requestId) {
      animeBrowser.loading = false;
      renderAnimeBrowserResults();
    }
  }
}
export async function openAnimeBrowserTitle(id) {
  const media = animeBrowser.items.find((item) => item.id === Number(id));
  if (!media) return;
  const token = ++animeBrowser.openRequestId;
  const status = $("#anime-browser-status");
  const card = [...($("#anime-browser-results")?.querySelectorAll("[data-anime-id]") || [])]
    .find((item) => Number(item.dataset.animeId) === media.id);
  card?.classList.add("is-resolving");
  card?.setAttribute("aria-busy", "true");
  if (status) {
    status.classList.remove("is-error");
    status.textContent = `Finding ${media.title} in the LVL catalog…`;
  }
  try {
    const match = await resolveAnimeBrowserCatalog(media);
    if (token !== animeBrowser.openRequestId || !viewActive("home") || homeBrowseCategory !== "anime") return;
    openTitlePage({ id: match.id, type: match.type, meta: match });
  } catch (error) {
    if (token === animeBrowser.openRequestId && status?.isConnected) {
      status.textContent = error.message || "Could not open anime";
      status.classList.add("is-error");
    }
  } finally {
    card?.classList.remove("is-resolving");
    card?.removeAttribute("aria-busy");
  }
}
// Prefetch only after the pointer settles on a card; keyboard focus works too.
function queueAnimeBrowserPrefetch(event) {
  if (event.type === "pointerover" && !["mouse", "pen"].includes(event.pointerType)) return;
  const card = event.target.closest?.("[data-anime-id]");
  if (!card || !viewActive("home") || homeBrowseCategory !== "anime") return;
  window.clearTimeout(animeBrowserPrefetchTimer);
  animeBrowserPrefetchTimer = window.setTimeout(() => {
    animeBrowserPrefetchTimer = null;
    const media = animeBrowser.items.find((item) => item.id === Number(card.dataset.animeId));
    if (media && card.isConnected) void resolveAnimeBrowserCatalog(media).catch(() => {});
  }, 220);
}
export function wireAnimeBrowserPrefetch() {
  $("#home-rows")?.addEventListener("pointerover", queueAnimeBrowserPrefetch);
  $("#home-rows")?.addEventListener("focusin", queueAnimeBrowserPrefetch);
  $("#home-rows")?.addEventListener("pointerout", (event) => {
    const card = event.target.closest?.("[data-anime-id]");
    if (card && !card.contains(event.relatedTarget)) {
      window.clearTimeout(animeBrowserPrefetchTimer);
      animeBrowserPrefetchTimer = null;
    }
  });
}
