// Random picks and their reasons.
import { escapeHtml, toast } from "../ui/ui.js";
import {
  findSavedRandomTitle, libraryCategory, randomPickIdentity, randomPickMatchesCategory,
  randomSeriesAlreadySeen, verifiedRandomCatalogMatch,
} from "../catalog/home-feed.js";
import { reasonGroups } from "../recommendations/recs-ui.js";
import {
  clientFeatures, homeBrowseCategory, libraryView, randomPickPopover, randomSource, recsUi, state,
} from "../../app.js";
import { $ } from "../app/dom.js";
import { fetchJson, postJson } from "../app/http.js";
import { viewActive } from "../app/navigation.js";
import { libraryArtCached } from "../watch/episode-navigation.js";
import { buildLibrarySeries, libraryEntryById, librarySeriesKey } from "../library/library-data.js";
import { openHomeTitle, openLibrarySeries, openTitlePage, titleRoute, titleSubject } from "../title/title-page.js";
import { resolveAnimeBrowserCatalog } from "./anime-browser.js";

// restoreScroll: Back and Forward return to where the page was scrolled (the title page is
// opened at its top).
let lastRandomEntry = null;
let suppressRandomFocusPreview = false;

let previousRandomRecommendationId = "";
let randomRecommendationBusy = false;
let previousRandomAnimeId = 0;
let randomTitleScope = { id: "", category: "all" };

const randomPickTriggers = ["#home-refresh-picks", "#section-random-pick"];
function isCurrentRandomEntry() {
  if (!lastRandomEntry || !viewActive("title")) return false;
  const route = titleRoute();
  return Boolean((route.id && route.id === lastRandomEntry.id)
    || (!route.id && route.key && route.key === lastRandomEntry.key));
}
export function refreshRandomPickIndicator() {
  const active = isCurrentRandomEntry();
  randomPickTriggers.forEach((selector) => {
    const button = $(selector);
    if (!button) return;
    button.classList.toggle("is-random-entry", active);
    button.setAttribute("aria-label", active && lastRandomEntry?.markup
      ? "Show why this title was recommended" : active ? "Randomly chosen title" : "Open a random title");
    if (active) button.removeAttribute("data-ui-tooltip");
    else button.setAttribute("data-ui-tooltip", "Random title");
  });
  if (!active) closeRandomPickPopover();
}
function rememberRandomEntry({ mode, markup = "" } = {}) {
  const route = titleRoute();
  lastRandomEntry = { id: route.id, key: route.key, mode, markup };
  refreshRandomPickIndicator();
}
function previewLastRandomReason() {
  if (!isCurrentRandomEntry() || !lastRandomEntry?.markup || !randomPickPopover?.hidden) return;
  showRandomPickPopover(lastRandomEntry.markup);
}
function randomActiveCategory() {
  if (viewActive("home")) return typeof clientFeatures !== "undefined" && clientFeatures.homeCategoryIds.includes(homeBrowseCategory)
    ? "all" : homeBrowseCategory;
  if (viewActive("library")) return libraryView.filter === "series" ? "tv"
    : clientFeatures.libraryFilterIds.includes(libraryView.filter) ? "all" : libraryView.filter;
  if (viewActive("title")) {
    if (titleRoute().id && titleRoute().id === randomTitleScope.id) return randomTitleScope.category;
    const subject = titleSubject();
    if (subject.series) {
      const category = libraryCategory(subject.series, {
        animeIds: new Set((state.homeCatalog.anime || []).map((meta) => meta.id)),
        details: libraryArtCached(subject.series),
      });
      return category === "series" ? "tv" : category;
    }
    if (subject.id && (state.homeCatalog.anime || []).some((meta) => meta.id === subject.id)) return "anime";
    return subject.type === "movie" ? "movie" : "tv";
  }
  if (viewActive("watch")) {
    const active = state.currentSource?.libraryId ? libraryEntryById(state.currentSource.libraryId) : null;
    const series = active && buildLibrarySeries().find((item) => item.key === (active.seriesKey || librarySeriesKey(active.title)));
    if (series) {
      const category = libraryCategory(series, { animeIds: new Set((state.homeCatalog.anime || []).map((meta) => meta.id)) });
      return category === "series" ? "tv" : category;
    }
  }
  return "all";
}
function randomSeen(series) {
  return randomSeriesAlreadySeen(series, { activeLibraryId: state.currentSource?.libraryId || "" });
}
function visibleRandomPickTrigger() {
  return $(viewActive("home") ? randomPickTriggers[0] : randomPickTriggers[1]);
}
function positionRandomPickPopover() {
  if (!randomPickPopover || randomPickPopover.hidden) return;
  const anchor = visibleRandomPickTrigger();
  if (!anchor) return;
  const rect = anchor.getBoundingClientRect();
  const width = randomPickPopover.getBoundingClientRect().width;
  const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width));
  randomPickPopover.style.left = `${left}px`;
  randomPickPopover.style.top = `${Math.max(8, Math.min(window.innerHeight - randomPickPopover.offsetHeight - 8, rect.bottom + 10))}px`;
  const above = rect.top - randomPickPopover.offsetHeight - 10;
  if (randomPickPopover.getBoundingClientRect().bottom > window.innerHeight - 8 && above >= 8)
    randomPickPopover.style.top = `${above}px`;
}
function showRandomPickPopover(markup) {
  if (!randomPickPopover) return;
  randomPickPopover.innerHTML = markup;
  randomPickPopover.hidden = false;
  randomPickTriggers.forEach((selector) => $(selector)?.setAttribute("aria-expanded", "true"));
  positionRandomPickPopover();
}
function closeRandomPickPopover({ restoreFocus = false } = {}) {
  if (!randomPickPopover || randomPickPopover.hidden) return;
  randomPickPopover.hidden = true;
  randomPickTriggers.forEach((selector) => $(selector)?.setAttribute("aria-expanded", "false"));
  if (restoreFocus) {
    suppressRandomFocusPreview = true;
    visibleRandomPickTrigger()?.focus({ preventScroll: true });
  }
}
function showRandomPickReason(pick) {
  const groups = reasonGroups(pick);
  if (!groups.matches.length && pick.summary) groups.matches.push(pick.summary);
  const section = (heading, lines, name) => lines.length
    ? `<section class="random-pick-evidence random-pick-evidence--${name}">
        <h3>${escapeHtml(heading)}</h3>
        <ul class="random-pick-reasons">${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>
      </section>`
    : "";
  requestAnimationFrame(() => {
    const markup = `${section("Why it matches your taste", groups.matches, "matches")}
      ${!groups.matches.length ? '<p class="random-pick-evidence-empty">This saved pick has no documented personal match reason. Refresh recommendations to recalculate its evidence.</p>' : ""}
      ${section("Counter-signals", groups.cautions, "cautions")}
      <button class="random-pick-dismiss" type="button" data-random-mode="close">Dismiss</button>`;
    rememberRandomEntry({ mode: "recommended", markup });
    showRandomPickPopover(markup);
    randomPickPopover?.focus({ preventScroll: true });
  });
}
async function openRandomRecommendedPick(pick, saved, category = "all") {
  const series = findSavedRandomTitle(saved, {
    imdbId: pick.imdbId, title: pick.title, titleAlt: pick.titleAlt,
    anilistId: pick.source === "anilist" ? Number(String(pick.url || "").match(/\/anime\/(\d+)/)?.[1]) : 0,
  });
  if (randomSeen(series)) return false;
  if (/^tt\d{5,12}$/.test(String(pick.imdbId || ""))) {
    randomTitleScope = { id: pick.imdbId, category };
    openHomeTitle({
      id: pick.imdbId, type: pick.type, name: pick.title, poster: pick.cover || "",
      description: pick.description || "", genres: pick.genres || [],
      releaseInfo: pick.year ? String(pick.year) : "",
    });
    return true;
  }
  if (series?.catalogId) {
    randomTitleScope = { id: series.catalogId, category };
    openLibrarySeries(series.key);
    return true;
  }
  if (pick.source === "anilist" && /^https:\/\/anilist\.co\/anime\/\d+/.test(pick.url || "")) {
    const id = Number(pick.url.match(/\/anime\/(\d+)/)?.[1]);
    try {
      const match = await resolveAnimeBrowserCatalog({
        id, title: pick.title, titleAlt: pick.titleAlt || "",
        format: pick.type === "movie" ? "MOVIE" : "TV", year: pick.year,
      });
      if (randomSeen(findSavedRandomTitle(saved, { imdbId: match.id, title: pick.title, titleAlt: pick.titleAlt, anilistId: id }))) return false;
      randomTitleScope = { id: match.id, category };
      openTitlePage({ id: match.id, type: match.type, meta: match });
      return true;
    } catch {
      // Do not fall back to an external tab: Random must open an LVL title.
      return false;
    }
  }
  if (pick.source === "tmdb" && pick.title && !pick.imdbId) {
    // TMDB picks can lack an IMDb identifier. Open a local LVL title only
    // when the catalog independently confirms a unique title/year/type match.
    const params = new URLSearchParams({ q: pick.title });
    try {
      const searched = await fetchJson(`/api/catalog/search?${params}`);
      const match = verifiedRandomCatalogMatch(pick, searched?.results);
      if (!match || randomSeen(findSavedRandomTitle(saved, {
        imdbId: match.id, title: pick.title, titleAlt: pick.titleAlt,
      }))) return false;
      randomTitleScope = { id: match.id, category };
      openHomeTitle(match);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}
async function openRandomRecommendation({ category = randomActiveCategory() } = {}) {
  if (randomRecommendationBusy) return;
  closeRandomPickPopover();
  randomRecommendationBusy = true;
  randomPickTriggers.forEach((selector) => { const trigger = $(selector); if (trigger) trigger.disabled = true; });
  try {
    let result = await recsUi.load();
    // On first use, an imported AniList profile may already contain scores
    // while personalized picks have never been generated. A Random click is
    // explicit user intent to create/open a recommendation, so bootstrap that
    // first run rather than treating an empty cache as an empty preference.
    const hasRatingSeeds = Number(result?.settings?.anilist?.scored || 0) > 0
      || Object.values(result?.stats?.ratings || {}).some((group) => Number(group?.scored) > 0);
    const noGeneratedPicks = !result?.picks?.length;
    const running = Boolean(result?.status?.running);
    const lastRun = result?.status?.lastRun;
    // The backend records a 'running' lastRun as soon as a refresh begins.
    // Don't misinterpret that as a finished empty recommendations list.
    const needsInitialRun = !lastRun || lastRun.status === "failed" || Boolean(result?.status?.ratingsChanged);
    if (noGeneratedPicks && (running || (needsInitialRun && hasRatingSeeds))) {
      if (!running) {
        toast("Preparing your personalized recommendations…");
        await postJson("/api/recs/refresh", {});
      }
      // The backend generates recommendations asynchronously. Wait briefly
      // for its initial result; never hang Random indefinitely on a provider.
      for (let attempt = 0; attempt < 12; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        result = await recsUi.load({ force: true });
        if (result?.picks?.length || !result?.status?.running) break;
      }
      if (!result?.picks?.length && result?.status?.running) {
        toast("Your recommendations are still being generated. Try Random again once they finish.");
        return;
      }
    }
    const saved = buildLibrarySeries();
    const candidates = (result?.picks || []).filter((pick) => ["movie", "series"].includes(String(pick.type || "").toLowerCase())
      && randomPickMatchesCategory(pick, category)
      && (/^tt\d{5,12}$/.test(String(pick.imdbId || ""))
        || (pick.source === "anilist" && /^https:\/\/anilist\.co\/anime\/\d+/.test(pick.url || ""))
        || (pick.source === "tmdb" && Boolean(pick.title))))
      .filter((pick) => !randomSeen(findSavedRandomTitle(saved, {
        imdbId: pick.imdbId, title: pick.title, titleAlt: pick.titleAlt,
        anilistId: pick.source === "anilist" ? Number(String(pick.url || "").match(/\/anime\/(\d+)/)?.[1]) : 0,
      })));
    const unique = [...new Map(candidates.map((pick) => [randomPickIdentity(pick), pick])).values()];
    if (!unique.length) {
      const categoryName = category === "tv" ? "TV" : category;
      const message = !(result?.picks || []).length
        ? "Your recommendations have no eligible picks yet. Try refreshing them in Tracking."
        : `No unseen ${category === "all" ? "" : categoryName + " "}recommendations in your picks. Try another category or choose Anything in Settings → Random titles.`;
      toast(message);
      return;
    }
    const alternatives = unique.length > 1 ? unique.filter((pick) => randomPickIdentity(pick) !== previousRandomRecommendationId) : unique;
    const available = alternatives.length ? alternatives : unique;
    const offset = Math.floor(Math.random() * available.length);
    const ordered = [...available.slice(offset), ...available.slice(0, offset)];
    for (const pick of ordered) {
      if (!await openRandomRecommendedPick(pick, saved, category)) continue;
      previousRandomRecommendationId = randomPickIdentity(pick);
      showRandomPickReason(pick);
      return;
    }
    toast("None of these recommendations has an available, verified LVL title page yet.");
  } catch (error) {
    toast(error.message || "Couldn't open a recommendation", { tone: "error" });
  } finally {
    randomRecommendationBusy = false;
    randomPickTriggers.forEach((selector) => { const trigger = $(selector); if (trigger) trigger.disabled = false; });
  }
}
let previousRandomCatalogId = "";
async function openRandomAnimeAnything({ category = randomActiveCategory() } = {}) {
  if (randomRecommendationBusy) return;
  closeRandomPickPopover();
  randomRecommendationBusy = true;
  randomPickTriggers.forEach((selector) => { const trigger = $(selector); if (trigger) trigger.disabled = true; });
  try {
    const saved = buildLibrarySeries();
    if (category === "anime") {
      // Use AniList discovery rather than the personalized recommendation list.
      const year = 1940 + Math.floor(Math.random() * (new Date().getFullYear() - 1939));
      const sort = ["POPULARITY_DESC", "SCORE_DESC", "TRENDING_DESC", "START_DATE_DESC"][Math.floor(Math.random() * 4)];
      const pages = [{ year: String(year), page: String(1 + Math.floor(Math.random() * 2)), sort },
        { year: "all", page: String(1 + Math.floor(Math.random() * 12)), sort }];
      const pools = [];
      for (const params of pages) {
        const response = await fetchJson(`/api/anime/discover?${new URLSearchParams(params)}`);
        pools.push(...(response.items || []));
        if (pools.length >= 8) break;
      }
      const eligible = [...new Map(pools.filter((media) => media.id && media.status !== "NOT_YET_RELEASED")
        .filter((media) => !randomSeen(findSavedRandomTitle(saved, {
          anilistId: media.id, title: media.title, titleAlt: media.titleAlt,
        }))).map((media) => [media.id, media])).values()];
      for (let i = eligible.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [eligible[i], eligible[j]] = [eligible[j], eligible[i]];
      }
      if (eligible.length > 1) eligible.sort((a, b) => Number(a.id === previousRandomAnimeId) - Number(b.id === previousRandomAnimeId));
      for (const media of eligible) {
        try {
          const match = await resolveAnimeBrowserCatalog(media);
          if (randomSeen(findSavedRandomTitle(saved, {
            imdbId: match.id, anilistId: media.id, title: media.title, titleAlt: media.titleAlt,
          }))) continue;
          previousRandomAnimeId = media.id;
          randomTitleScope = { id: match.id, category };
          openTitlePage({ id: match.id, type: match.type, meta: match });
          rememberRandomEntry({ mode: "anything" });
          return;
        } catch (error) {
          // An unverified name match cannot be opened as the wrong title.
          if (/temporarily unavailable/.test(error.message || "")) throw error;
        }
      }
      toast("No unseen anime could be matched to an LVL title in this sample. Try Random again.");
      return;
    }
    // For Movies / TV / All, select from the general catalog feed, not from
    // personalized picks. This also supports random access outside Home.
    const catalog = state.homeLoaded ? state.homeCatalog : await fetchJson("/api/catalog/home");
    const animeIds = new Set((catalog.anime || []).map((meta) => meta.id));
    const list = category === "movie" ? (catalog.movies || []).filter((meta) => !animeIds.has(meta.id))
      : category === "tv" ? (catalog.series || []).filter((meta) => !animeIds.has(meta.id))
        : [...(catalog.movies || []), ...(catalog.series || []), ...(catalog.anime || [])];
    const eligible = [...new Map(list.filter((meta) => /^tt\d{5,12}$/.test(String(meta.id || ""))
      && !randomSeen(findSavedRandomTitle(saved, { imdbId: meta.id, title: meta.name || meta.title })))
      .map((meta) => [meta.id, meta])).values()];
    if (!eligible.length) {
      toast("No unseen titles available in the current catalog sample.");
      return;
    }
    const alternatives = eligible.length > 1 ? eligible.filter((meta) => meta.id !== previousRandomCatalogId) : eligible;
    const pool = alternatives.length ? alternatives : eligible;
    const chosen = pool[Math.floor(Math.random() * pool.length)];
    previousRandomCatalogId = chosen.id;
    randomTitleScope = { id: chosen.id, category };
    openHomeTitle(chosen);
    rememberRandomEntry({ mode: "anything" });
  } catch (error) {
    toast(error.message || "Could not find a random title", { tone: "error" });
  } finally {
    randomRecommendationBusy = false;
    randomPickTriggers.forEach((selector) => { const trigger = $(selector); if (trigger) trigger.disabled = false; });
  }
}
export function wireRandomPick() {
  randomPickTriggers.forEach((selector) => $(selector)?.addEventListener("click", () => {
    if (randomRecommendationBusy) return;
    closeRandomPickPopover();
    const category = randomActiveCategory();
    if (randomSource === "anything") void openRandomAnimeAnything({ category });
    else void openRandomRecommendation({ category });
  }));
  randomPickTriggers.forEach((selector) => {
    $(selector)?.addEventListener("pointerenter", previewLastRandomReason);
    $(selector)?.addEventListener("focus", () => {
      if (suppressRandomFocusPreview) { suppressRandomFocusPreview = false; return; }
      previewLastRandomReason();
    });
  });
  randomPickPopover?.addEventListener("click", (event) => {
    const action = event.target.closest("[data-random-mode]")?.dataset.randomMode;
    if (!action) return;
    if (action === "close") { closeRandomPickPopover({ restoreFocus: true }); return; }
  });
  document.addEventListener("pointerdown", (event) => {
    if (!randomPickPopover?.hidden && !event.target.closest("#random-pick-popover, .random-pick-trigger")) closeRandomPickPopover();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !randomPickPopover?.hidden) { event.preventDefault(); closeRandomPickPopover({ restoreFocus: true }); }
  });
  window.addEventListener("resize", positionRandomPickPopover);
  window.addEventListener("scroll", positionRandomPickPopover, { passive: true });
}
