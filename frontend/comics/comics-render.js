// Comics renderers for the Home "Comics" tab, the main Library (Comics filter
// and "All") and search. Every dynamic string is escaped.
import { bindShelves, buttonMarkup, cardMarkup, emptyMarkup, escapeHtml, refreshImages, shelfMarkup, skeletonShelfMarkup } from "../ui/ui.js";
import { t } from "../ui/ui-i18n.js";
import { comicsApi } from "./comics-api.js";
import { comicBrowserMarkup, featuredSlides, mountComicBrowser, showFeatured } from "./comics-browser.js";
import { providerBrowserMarkup, mountProviderBrowser } from "./comics-provider.js";
import { WORK_ID } from "../../shared/reading/ids.js";

export const STATUS_LABELS = Object.freeze({
  CURRENT: "Reading", PLANNING: "Planning", COMPLETED: "Completed", PAUSED: "Paused", DROPPED: "Dropped", REPEATING: "Rereading",
});

// Same translation table as the rest of the app (feature strings are registered there).
const tr = (_ctx, text, params) => t(text, params);
// Labels for chapters read from sources ("Chapter 12 · MangaDex"), shown in the reader bar.
export const readerNames = new Map();

// ---- Library cache (one request; refreshed after every change). Keys are
// "anilist-<id>" or "local-<hash>" (files without an AniList match).
const library = { entries: new Map(), loaded: false, pending: null };
export const comicKey = (value) => {
  if (typeof value === "string" && WORK_ID.test(value)) return value;
  const id = Number(value?.anilistId ?? value);
  return Number.isInteger(id) && id > 0 ? `anilist-${id}` : (typeof value?.id === "string" ? comicKey(value.id) : "");
};
export function loadLibrary({ force = false } = {}) {
  if (library.loaded && !force) return Promise.resolve(library.entries);
  if (!library.pending) {
    library.pending = comicsApi.library()
      .then((payload) => {
        library.entries = new Map((payload.entries || []).map((entry) => [comicKey(entry.id || entry), entry]));
        library.loaded = true;
        return library.entries;
      })
      .finally(() => { library.pending = null; });
  }
  return library.pending;
}
export const libraryEntry = (key) => library.entries.get(comicKey(key)) || null;
export const cachedEntries = () => (library.loaded ? [...library.entries.values()] : []);
export function rememberEntry(key, entry) {
  if (entry) library.entries.set(comicKey(key), entry);
  else library.entries.delete(comicKey(key));
}

export function formatLabel(comic) {
  if (comic?.format === "LOCAL") return "Local files";
  if (comic?.format === "COMIC") return "Comic";
  if (comic?.format === "ONE_SHOT") return "One-shot";
  return ({ KR: "Manhwa", CN: "Manhua", TW: "Manhua" })[comic?.country] || "Manga";
}

export function comicCardMarkup(comic, ctx, { badge = "", files = 0, read = 0 } = {}) {
  const key = comicKey(comic?.id && String(comic.id).startsWith("local-") ? comic.id : comic);
  if (!key) return "";
  // read: the highest chapter finished (Library Comics filter only). The chip replaces the
  // chapter count: "Ch. 48 of 224", or "Ch. 48" while the total isn't known.
  const total = Number(comic.chapters) || 0;
  const done = Math.max(0, Math.floor(Number(read) || 0));
  const chapterChip = done
    ? (total ? tr(ctx, "Ch. {read} of {total}", { read: done, total }) : tr(ctx, "Ch. {read}", { read: done }))
    : total ? tr(ctx, "{count} chapters", { count: total }) : "";
  const meta = [tr(ctx, formatLabel(comic)), comic.year ? String(comic.year) : "", chapterChip,
    files === 1 ? tr(ctx, "1 file") : files ? tr(ctx, "{count} files", { count: files }) : ""].filter(Boolean);
  const html = cardMarkup({
    title: comic.title, image: comic.cover, meta, badge,
    rating: Number.isFinite(comic.score) && comic.score > 0 ? comic.score.toFixed(1) : "",
    // At least 2%, so one chapter of 224 still shows as started.
    progress: done && total ? Math.min(1, Math.max(0.02, done / total)) : 0,
  }, { inLibrary: Boolean(libraryEntry(key)) });
  // No data-title-id / data-series-key: core's video card handlers ignore these cards.
  return html.replace("<article class=\"", `<article data-comic-id="${escapeHtml(key)}" class="`);
}

export const errorMarkup = (ctx, message) => emptyMarkup({
  icon: "alert", title: tr(ctx, "Couldn't load comics"), text: message, i18n: false,
  action: buttonMarkup({ label: "Try again", icon: "refresh", attrs: { "data-comics-action": "retry" } }),
});

// Home "Comics" tab, laid out like the anime section: a featured carousel, the
// discovery browser first (as the anime tab's), your rows (Continue reading, New
// chapters), then AniList rows. isCurrent() stops a slow response from painting over a page the user already left.
export async function renderComicsHome({ hero, rows }, ctx, { isCurrent = () => true, extraShelves = [] } = {}) {
  if (!rows) return;
  rows.setAttribute("aria-busy", "true");
  rows.innerHTML = "<div class=\"comics-home-body\">" + providerBrowserMarkup() + skeletonShelfMarkup() + skeletonShelfMarkup() + "</div>";
  const body = rows.querySelector(".comics-home-body");
  const provider = body.querySelector("[data-comic-provider]");
  mountProviderBrowser(provider, ctx);
  if (hero) hero.hidden = true;
  let data;
  try {
    [data] = await Promise.all([comicsApi.home(), loadLibrary().catch(() => null)]);
  } catch (error) {
    if (isCurrent()) {
      rows.removeAttribute("aria-busy");
      body.innerHTML = errorMarkup(ctx, error.message) + comicBrowserMarkup();
      body.prepend(provider);
      mountComicBrowser(body.querySelector("#comic-browser"), { inLibrary: (comic) => Boolean(libraryEntry(comic)) });
    }
    return undefined;
  }
  if (!isCurrent()) return undefined;
  const sections = data.sections || [];
  const inLibrary = (comic) => Boolean(libraryEntry(comic));
  const reading = [...library.entries.values()].filter((entry) => entry.status === "CURRENT" || entry.status === "REPEATING");
  const shelves = [comicBrowserMarkup()];
  if (reading.length) shelves.push(shelfMarkup({ id: "comics-reading", title: tr(ctx, "Continue reading"), cards: reading.map((entry) => libraryCard(entry, ctx)).filter(Boolean) }));
  for (const section of sections) {
    const cards = (section.items || []).map((comic) => comicCardMarkup(comic, ctx)).filter(Boolean);
    if (cards.length) shelves.push(shelfMarkup({ id: `comics-${section.id}`, title: tr(ctx, section.title), cards }));
  }
  rows.removeAttribute("aria-busy");
  body.innerHTML = shelves.join("");
  body.prepend(provider);
  showFeatured(hero, featuredSlides(sections, { inLibrary }));
  mountComicBrowser(body.querySelector("#comic-browser"), { inLibrary });
  bindShelves(body);
  refreshImages(body);
  for (const extra of extraShelves) {
    Promise.resolve(extra()).then((markup) => {
      if (!markup || !isCurrent() || !body.isConnected) return;
      const anchor = body.querySelector("#comics-reading") || body.querySelector("#comic-browser");
      if (anchor) anchor.insertAdjacentHTML("afterend", markup);
      else body.insertAdjacentHTML("afterbegin", markup);
      bindShelves(body);
      refreshImages(body);
    }).catch(() => {});
  }
  return undefined;
}

// Video Library sort values map to comics: title, title-desc, added; the rest by last change.
export function sortEntries(entries, sort = "recent") {
  const list = [...entries];
  const byTitle = (a, b) => String(a.work?.title || "").localeCompare(String(b.work?.title || ""), undefined, { sensitivity: "base", numeric: true });
  if (sort === "title") return list.sort(byTitle);
  if (sort === "title-desc") return list.sort((a, b) => byTitle(b, a));
  if (sort === "added") return list.sort((a, b) => b.addedAt - a.addedAt || byTitle(a, b));
  return list.sort((a, b) => b.updatedAt - a.updatedAt || byTitle(a, b));
}

export function filterEntries(entries, { query = "", status = "any" } = {}) {
  const needle = String(query || "").trim().toLowerCase();
  return entries.filter((entry) => (status === "any" || !status || entry.status === status)
    && (!needle || [entry.work?.title, ...(entry.work?.aliases || [])].some((name) => String(name || "").toLowerCase().includes(needle))));
}

// Status counts after the search but before the status filter, like the video Library.
export function statusCounts(entries) {
  const counts = { any: entries.length };
  for (const entry of entries) counts[entry.status] = (counts[entry.status] || 0) + 1;
  return counts;
}

// progress: the Library's Comics filter shows how far you've read (not "All" or Home).
const libraryCard = (entry, ctx, { progress = false } = {}) => comicCardMarkup(entry.local ? { ...entry.work, id: entry.id } : entry.work, ctx,
  { badge: tr(ctx, STATUS_LABELS[entry.status] || ""), files: entry.files || 0, read: progress ? entry.readChapters || 0 : 0 });

// Main Library "All": synchronous from the cache. The first call starts loading
// and reports through onLoaded so the Library redraws once the entries are in.
// A manga whose anime is in the Library is part of that anime's card (one card
// per franchise); the Comics filter still lists it.
export function libraryGroup(options = {}, ctx, onLoaded = () => {}, { joined = () => false } = {}) {
  if (!library.loaded) {
    if (!library.pending) loadLibrary().then(() => onLoaded()).catch(() => {});
    return { shown: 0, statuses: {}, html: "" };
  }
  const own = [...library.entries.values()].filter((entry) => !joined(entry));
  const searched = filterEntries(own, { query: options.query });
  const shown = sortEntries(filterEntries(searched, { status: options.status }), options.sort);
  return { shown: shown.length, statuses: statusCounts(searched), html: shown.map((entry) => libraryCard(entry, ctx)).join("") };
}

// Main Library "Comics" filter.
export async function renderComicsLibrary(list, ctx, { query = "", sort = "recent", status = "any", isCurrent = () => true } = {}) {
  if (!list) return;
  list.classList.remove("is-grouped");
  try {
    await loadLibrary({ force: true });
  } catch (error) {
    if (isCurrent()) list.innerHTML = errorMarkup(ctx, error.message);
    return;
  }
  if (!isCurrent()) return;
  const entries = sortEntries(filterEntries([...library.entries.values()], { query, status }), sort);
  list.innerHTML = entries.length
    ? entries.map((entry) => libraryCard(entry, ctx, { progress: true })).join("")
    : emptyMarkup({
      icon: "library", title: library.entries.size ? "No matches" : "No comics yet",
      action: library.entries.size ? "" : buttonMarkup({ label: "Browse comics", icon: "arrow-right", attrs: { "data-comics-action": "browse" } }),
    });
  refreshImages(list);
}
