// Catalog search.
import { emptyMarkup, escapeHtml, refreshImages } from "../ui/ui.js";
import { catalogCardItem, rankCatalogSearchResults } from "./home-feed.js";
import { state, TITLE_STATUS } from "../../app.js";
import { $, setToolStatus } from "../app/dom.js";
import { fetchJson } from "../app/http.js";
import { importCatalogStream } from "../player/torrent-playback.js";
import { buildLibrarySeries, librarySeriesKey, normalizeLibrarySourceMeta } from "../library/library-data.js";
import { openHomeTitle, savedTitleBadge } from "../title/title-page.js";
import { homeTitleIndex } from "../home/home-page.js";
import { t } from "../ui/ui-i18n.js";
import { comicsApi } from "../comics/comics-api.js";
import { comicsEnabled } from "../comics/comics-enabled.js";
import { cachedEntries, comicKey, formatLabel } from "../comics/comics-render.js";

export function catalogSeriesKey(meta) {
  return librarySeriesKey(meta?.name || meta?.id || "untitled");
}

export function catalogResultYear(meta) {
  const match = String(meta?.releaseInfo || "").match(/\b(19|20)\d{2}\b/);
  return match?.[0] || "";
}

export function streamProviderBadges(stream) {
  const providers = (stream.providers || [stream.provider]).filter(Boolean);
  return providers.length ? `<span class="catalog-provider">${escapeHtml(providers.join(" and "))}</span>` : "";
}

// Buttons drawn by buttonMarkup keep their label in a <span> next to the icon.
export function buttonText(button) {
  return (button?.querySelector(":scope > span") || button)?.textContent || "";
}

export function setButtonText(button, text) {
  const label = button?.querySelector(":scope > span") || button;
  if (label) label.textContent = text;
}

// "EPISODES 01–12" → "Episodes 1–12", "SEASON PACK" → "Season pack".
export function catalogKindText(label) {
  const text = String(label || "").toLowerCase().replace(/\b0+(\d)/g, "$1");
  return text ? text[0].toUpperCase() + text.slice(1) : "";
}

export function compareStreamsByPeers(a, b) {
  return (Number(b?.peers) || 0) - (Number(a?.peers) || 0)
    || (Number(b?.score) || 0) - (Number(a?.score) || 0);
}

export function compareLibrarySourceRefsByPeers(a, b) {
  const aMeta = normalizeLibrarySourceMeta(a?.entry?.sourceMeta);
  const bMeta = normalizeLibrarySourceMeta(b?.entry?.sourceMeta);
  return (Number(bMeta.peers) || 0) - (Number(aMeta.peers) || 0)
    || (Number(bMeta.score) || 0) - (Number(aMeta.score) || 0);
}

export function librarySourceMetaFromStream(stream) {
  return normalizeLibrarySourceMeta({
    provider: stream.provider,
    providers: stream.providers || [stream.provider],
    releaseName: String(stream.title || "").split("\n")[0],
    quality: stream.quality,
    codec: stream.codec,
    peers: stream.peers,
    sizeBytes: stream.sizeBytes,
    audioLanguages: stream.audioLanguages || [],
    filename: stream.filename || "",
    score: stream.score,
    sourceKind: stream.sourceKind || ((stream.episodes || []).length > 1 ? "multi-episode-pack" : "episode"),
    coverage: Number(stream.coverage) || (Array.isArray(stream.episodes) ? stream.episodes.length : 1),
    totalSeasonEpisodes: Number(stream.totalSeasonEpisodes) || 0,
    coveredEpisodes: Array.isArray(stream.episodes) ? stream.episodes : [],
  });
}

function renderCatalogResults(results) {
  const container = $("#catalog-results");
  if (!results.length) {
    container.innerHTML = emptyMarkup({ compact: true, icon: "search", title: "No titles found", text: "Try another title, or its original name." });
    return;
  }
  const savedSeries = buildLibrarySeries();
  const ranked = rankCatalogSearchResults(results, $("#catalog-search-input")?.value || "");
  container.innerHTML = ranked.map((meta) => {
    const item = catalogCardItem(meta, { category: meta.type === "movie" ? "movie" : "tv" });
    const match = savedSeries.find((series) => (meta.id && series.catalogId === meta.id)
      || series.key === librarySeriesKey(meta.name));
    const details = item.meta.filter(Boolean).map(escapeHtml).join(" - ");
    const saved = match ? savedTitleBadge(match)?.label : "";
    return `<button class="catalog-search-result" type="button" data-title-id="${escapeHtml(meta.id)}" aria-label="Open ${escapeHtml(item.title)} in Library">
      <span class="catalog-search-result__art">${item.image ? `<img src="${escapeHtml(item.image)}" alt="" loading="lazy" decoding="async" data-fallback="poster" data-fallback-title="${escapeHtml(item.title)}">` : `<span aria-hidden="true">${escapeHtml(item.title.slice(0, 1))}</span>`}</span>
      <span class="catalog-search-result__info"><strong>${escapeHtml(item.title)}</strong><span>${details}</span></span>
      ${saved ? `<span class="catalog-search-result__saved">${escapeHtml(saved)}</span>` : ""}
      <svg class="ui-icon catalog-search-result__arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>
    </button>`;
  }).join("");
  refreshImages(container);
}

// The existing medium tabs determine which catalog the magnifier searches.
// Comics carry their own work IDs, opened by the Comics delegated route.
function currentCatalogSearchKind() {
  if (typeof comicsEnabled !== "function" || !comicsEnabled()) return "video";
  const home = $("#view-home");
  const library = $("#view-library");
  if ((home?.classList?.contains("is-active") && home.dataset?.featureCategory === "comics")
    || (library?.classList?.contains("is-active") && library.dataset?.featureFilter === "comics")) return "comics";
  return "video";
}

function searchText(key, params = {}) {
  return typeof t === "function" ? t(key, params) : key;
}

function setCatalogSearchLabels(kind) {
  const input = $("#catalog-search-input");
  const comics = kind === "comics";
  const placeholder = comics ? "Search comics" : "Search titles";
  const label = comics ? "Search comics" : "Search movies and series";
  input?.setAttribute("data-i18n-placeholder", placeholder);
  input?.setAttribute("data-i18n-aria-label", label);
  input?.setAttribute("aria-label", searchText(label));
  if (input) input.placeholder = searchText(placeholder);
  $("#catalog-results")?.setAttribute("aria-label", searchText(comics ? "Matching comics" : "Matching titles"));
}

function comicLocalMatches(query) {
  const needle = query.toLocaleLowerCase();
  return (typeof cachedEntries === "function" ? cachedEntries() : [])
    .map((entry) => ({ ...entry.work, id: entry.id || entry.work?.id }))
    .filter((comic) => comicKey(comic) && [comic.title, ...(comic.aliases || [])]
      .some((title) => String(title || "").toLocaleLowerCase().includes(needle)))
    .sort((a, b) => Number(!a.title?.toLocaleLowerCase().startsWith(needle)) - Number(!b.title?.toLocaleLowerCase().startsWith(needle)))
    .slice(0, 12);
}

function renderComicSearchResults(results) {
  const container = $("#catalog-results");
  if (!results.length) {
    container.innerHTML = emptyMarkup({
      compact: true, icon: "search", title: searchText("No results"),
      text: searchText("Try another title, or its original name."),
    });
    return;
  }
  container.innerHTML = results.map((comic) => {
    const id = comicKey(comic);
    if (!id || !/^(?:anilist-[1-9]\d{0,9}|local-[0-9a-f]{12})$/.test(id)) return "";
    const title = String(comic.title || "");
    const detail = [searchText(formatLabel(comic)), comic.year || ""].filter(Boolean).join(" · ");
    const artwork = comic.cover
      ? `<img src="${escapeHtml(comic.cover)}" alt="" loading="lazy" decoding="async" data-fallback="poster" data-fallback-title="${escapeHtml(title)}">`
      : `<span aria-hidden="true">${escapeHtml(title.slice(0, 1))}</span>`;
    return `<button class="catalog-search-result" type="button" data-comics-open="${escapeHtml(id)}" aria-label="${escapeHtml(searchText("Open {title} in Comics", { title }))}">
      <span class="catalog-search-result__art">${artwork}</span>
      <span class="catalog-search-result__info"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span></span>
      <svg class="ui-icon catalog-search-result__arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>
    </button>`;
  }).join("");
  refreshImages(container);
}

export function openCatalogResult(id) {
  if (catalogSearchKindActive !== "video") return;
  const meta = state.catalogResults.find((item) => item.id === id);
  if (!meta) return;
  closeCatalogSearch();
  // The title page is the Library's per-show section, even for a title not yet saved.
  openHomeTitle(meta);
}

let catalogSearchTimer = null;
let catalogSearchRequest = null;
let catalogSearchVersion = 0;
let catalogSearchKindActive = "video";
const catalogSearchCache = new Map();

function searchCacheKey(kind, query) { return `${kind}:${query.toLocaleLowerCase()}`; }
function rememberCatalogSearch(kind, query, results) {
  const key = searchCacheKey(kind, query);
  catalogSearchCache.delete(key);
  catalogSearchCache.set(key, { results, savedAt: Date.now() });
  if (catalogSearchCache.size > 16) catalogSearchCache.delete(catalogSearchCache.keys().next().value);
}

function catalogLocalMatches(query) {
  const needle = query.toLocaleLowerCase();
  const found = new Map();
  for (const meta of homeTitleIndex.values()) {
    if (meta?.id && String(meta.name || "").toLocaleLowerCase().includes(needle)) found.set(meta.id, meta);
  }
  for (const series of buildLibrarySeries()) {
    const id = series.catalogId;
    if (!/^tt\d{5,12}$/.test(String(id || "")) || found.has(id) || !String(series.title || "").toLocaleLowerCase().includes(needle)) continue;
    found.set(id, { id, name: series.title, type: series.type === "movie" ? "movie" : "series", poster: series.coverUrl || "" });
  }
  return [...found.values()].sort((a, b) =>
    Number(!String(a.name || "").toLocaleLowerCase().startsWith(needle)) - Number(!String(b.name || "").toLocaleLowerCase().startsWith(needle)))
    .slice(0, 12);
}

function cancelCatalogSearch() {
  window.clearTimeout(catalogSearchTimer);
  catalogSearchTimer = null;
  catalogSearchRequest?.abort();
  catalogSearchRequest = null;
  catalogSearchVersion += 1;
}

export function catalogSearchIsOpen() {
  return !$("#catalog-search-shell").hidden;
}

export function closeCatalogSearch({ restoreFocus = false } = {}) {
  if (!catalogSearchIsOpen()) return;
  const shell = $("#catalog-search-shell");
  const host = shell.parentElement?.id;
  shell.hidden = true;
  $("#catalog-search-panel").hidden = true;
  $("#catalog-search-input")?.setAttribute("aria-expanded", "false");
  $("#home-search-title").hidden = false;
  $("#section-search-title").hidden = false;
  $("#home-search-title")?.setAttribute("aria-expanded", "false");
  $("#section-search-title")?.setAttribute("aria-expanded", "false");
  cancelCatalogSearch();
  state.catalogResults = [];
  catalogSearchKindActive = "video";
  if (restoreFocus) $(({ "topbar-catalog-search-host": "#home-search-title", "section-catalog-search-host": "#section-search-title" })[host] || "#section-search-title")?.focus();
}

export function openCatalogSearch(source = "topbar") {
  const shell = $("#catalog-search-shell");
  const host = $(({ library: "#library-catalog-search-host", section: "#section-catalog-search-host" })[source] || "#topbar-catalog-search-host");
  if (!host || !shell) return;
  const kind = currentCatalogSearchKind();
  if (!shell.hidden && shell.parentElement === host && catalogSearchKindActive === kind) {
    $("#catalog-search-input")?.focus();
    return;
  }
  cancelCatalogSearch();
  state.catalogResults = [];
  catalogSearchKindActive = kind;
  setCatalogSearchLabels(kind);
  host.appendChild(shell);
  shell.hidden = false;
  $("#catalog-search-panel").hidden = true;
  $("#catalog-search-input")?.setAttribute("aria-expanded", "false");
  $("#home-search-title").hidden = source === "topbar";
  $("#section-search-title").hidden = source === "section";
  $("#catalog-search-input").value = "";
  $("#catalog-results").innerHTML = "";
  setToolStatus("#catalog-status", "");
  $("#home-search-title")?.setAttribute("aria-expanded", source === "topbar" ? "true" : "false");
  $("#section-search-title")?.setAttribute("aria-expanded", source === "section" ? "true" : "false");
  $("#catalog-search-input")?.focus();
}

async function performCatalogSearch(query) {
  if (!catalogSearchIsOpen()) return;
  cancelCatalogSearch();
  const requestVersion = catalogSearchVersion;
  const requestKind = catalogSearchKindActive;
  const controller = new AbortController();
  catalogSearchRequest = controller;
  if (!state.catalogResults.length) setToolStatus("#catalog-status", requestKind === "comics" ? searchText("Loading…") : "Searching…");
  try {
    const data = requestKind === "comics"
      ? await comicsApi.search({ q: query }, { signal: controller.signal })
      : await fetchJson(`/api/catalog/search?q=${encodeURIComponent(query)}`, { signal: controller.signal });
    if (requestVersion !== catalogSearchVersion || controller.signal.aborted || !catalogSearchIsOpen()
      || currentCatalogSearchKind() !== requestKind || catalogSearchKindActive !== requestKind
      || $("#catalog-search-input").value.trim() !== query) return;
    state.catalogResults = requestKind === "comics"
      ? (Array.isArray(data.items) ? data.items : []) : (Array.isArray(data.results) ? data.results : []);
    rememberCatalogSearch(requestKind, query, state.catalogResults);
    setToolStatus("#catalog-status", requestKind === "comics"
      ? (state.catalogResults.length ? searchText("{count} titles", { count: state.catalogResults.length }) : searchText("No results"))
      : (state.catalogResults.length ? `${state.catalogResults.length} titles found` : `Nothing found for "${query}"`));
    if (requestKind === "comics") renderComicSearchResults(state.catalogResults);
    else renderCatalogResults(state.catalogResults);
  } catch (error) {
    if (requestVersion !== catalogSearchVersion || controller.signal.aborted || !catalogSearchIsOpen()
      || currentCatalogSearchKind() !== requestKind || catalogSearchKindActive !== requestKind) return;
    const message = error.message || "Title search failed";
    setToolStatus("#catalog-status", requestKind === "comics" ? searchText("Couldn't load comics") : message, true);
    $("#catalog-results").innerHTML = requestKind === "comics"
      ? emptyMarkup({ compact: true, icon: "alert", title: searchText("Couldn't load comics"), text: String(message) })
      : emptyMarkup({ compact: true, icon: "alert", title: "Couldn't search titles", text: `${message}. Check your connection and try Search again.` });
  } finally {
    if (catalogSearchRequest === controller) catalogSearchRequest = null;
  }
}

export function searchCatalogTitles(event) {
  event.preventDefault();
  const first = $("#catalog-results .catalog-search-result");
  if (first && catalogSearchKindActive === "comics" && first.dataset.comicsOpen) first.click();
  else if (first && catalogSearchKindActive === "video") openCatalogResult(first.dataset.titleId);
  else {
    const query = $("#catalog-search-input").value.trim();
    if (query.length >= 2) void performCatalogSearch(query);
  }
}

export function queueCatalogSearch() {
  cancelCatalogSearch();
  const kind = currentCatalogSearchKind();
  if (catalogSearchKindActive !== kind) {
    catalogSearchKindActive = kind;
    setCatalogSearchLabels(kind);
  }
  const query = $("#catalog-search-input").value.trim();
  state.catalogResults = [];
  $("#catalog-results").innerHTML = "";
  const panel = $("#catalog-search-panel");
  panel.hidden = !query;
  $("#catalog-search-input")?.setAttribute("aria-expanded", query ? "true" : "false");
  setToolStatus("#catalog-status", "");
  if (!query) return;
  const cached = catalogSearchCache.get(searchCacheKey(kind, query));
  if (cached && cached.savedAt > Date.now() - 5 * 60_000) {
    state.catalogResults = cached.results;
    if (kind === "comics") {
      renderComicSearchResults(cached.results);
      setToolStatus("#catalog-status", cached.results.length ? searchText("{count} titles", { count: cached.results.length }) : searchText("No results"));
    } else {
      renderCatalogResults(cached.results);
      setToolStatus("#catalog-status", cached.results.length ? `${cached.results.length} titles found` : "No titles found");
    }
    return;
  }
  // Use titles already present in Home and Library immediately, then replace
  // them with full catalog matches. No additional network calls are needed.
  const local = kind === "comics" ? comicLocalMatches(query) : catalogLocalMatches(query);
  if (local.length) {
    state.catalogResults = local;
    if (kind === "comics") renderComicSearchResults(local);
    else renderCatalogResults(local);
  } else setToolStatus("#catalog-status", kind === "comics"
    ? searchText("Loading…") : (query.length < 2 ? "Keep typing…" : "Searching…"));
  if (query.length < 2) return;
  // Shorter than the old 350 ms delay, while avoiding a request for every keystroke.
  catalogSearchTimer = window.setTimeout(() => void performCatalogSearch(query), 220);
}

export async function addBestCatalogMovie(meta, button, { seriesKey = null } = {}) {
  const label = button?.querySelector("span") || button;
  const oldText = label?.textContent || "Add the best source";
  if (button) { button.disabled = true; label.textContent = "Finding…"; }
  setToolStatus(TITLE_STATUS, `Finding the best source for ${meta.name}…`);
  try {
    const data = await fetchJson(`/api/streams?type=movie&id=${encodeURIComponent(meta.id)}`);
    const candidates = (data.streams || []).slice().sort(compareStreamsByPeers).slice(0, 8);
    if (!candidates.length) throw new Error("No sources found.");
    let added = null;
    let lastError = null;
    for (let index = 0; index < candidates.length; index += 1) {
      const stream = candidates[index];
      setToolStatus(TITLE_STATUS, `Trying source ${index + 1} of ${candidates.length}: ${stream.quality && stream.quality !== "UNKNOWN" ? stream.quality : "torrent"} from ${streamProviderBadgesText(stream)}`);
      try {
        added = await importCatalogStream(meta, stream, { quiet: true, seriesKey });
        if (added) break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!added) throw lastError || new Error("No source passed the torrent check.");
    if (button?.isConnected) label.textContent = "Added";
    setToolStatus(TITLE_STATUS, `${meta.name} added to your Library`);
  } catch (error) {
    setToolStatus(TITLE_STATUS, error.message || "Could not add this title", true);
    if (button?.isConnected) { button.disabled = false; label.textContent = oldText; }
  }
}

function streamProviderBadgesText(stream) {
  return (stream.providers || [stream.provider]).filter(Boolean).join(" + ") || "STREAM SOURCE";
}
