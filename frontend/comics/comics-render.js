// Comics renderers for the Home "Comics" tab, the main Library (Comics filter
// and "All") and search. Every dynamic string is escaped.
import { bindShelves, buttonMarkup, cardMarkup, emptyMarkup, escapeHtml, markupSignature, refreshImages, shelfMarkup, skeletonShelfMarkup } from "../ui/ui.js";
import { t } from "../ui/ui-i18n.js";
import { comicsApi } from "./comics-api.js";
import { catalogArtworkMark, disposeCatalogArtwork, mountCatalogArtwork } from "./comics-artwork.js";
import { comicBrowserMarkup, featuredSlides, hasMountedFeatured, mountComicBrowser, showFeatured } from "./comics-browser.js";
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
  // A return from the reader may already be refreshing progress. A sort that
  // happens during that request must wait for it, not reuse the older cache.
  if (library.pending) return library.pending;
  if (library.loaded && !force) return Promise.resolve(library.entries);
  library.pending = comicsApi.library()
    .then((payload) => {
      library.entries = new Map((payload.entries || []).map((entry) => [comicKey(entry.id || entry), entry]));
      library.loaded = true;
      return library.entries;
    })
    .finally(() => { library.pending = null; });
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

export function comicCardMarkup(comic, ctx, { badge = "", files = 0, read = 0, catalogOnly = false } = {}) {
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
  let html = cardMarkup({
    title: comic.title, image: comic.cover, meta, badge,
    rating: Number.isFinite(comic.score) && comic.score > 0 ? comic.score.toFixed(1) : "",
    // At least 2%, so one chapter of 224 still shows as started.
    progress: done && total ? Math.min(1, Math.max(0.02, done / total)) : 0,
  }, { inLibrary: Boolean(libraryEntry(key)) });
  // Library and selected/local covers keep their own art. Catalog-only
  // portraits opt into a lazy check after the current AniList image decodes.
  const artwork = catalogOnly ? catalogArtworkMark(comic.anilistId, comic.cover) : null;
  if (artwork) html = html.replace('class="ui-card__img"', `class="ui-card__img" data-comics-art-id="${artwork.id}" data-comics-art-original="${escapeHtml(artwork.url)}"`);
  // No data-title-id / data-series-key: core's video card handlers ignore these cards.
  return html.replace("<article class=\"", `<article data-comic-id="${escapeHtml(key)}" class="`);
}

export const errorMarkup = (ctx, message) => emptyMarkup({
  icon: "alert", title: tr(ctx, "Couldn't load comics"), text: message, i18n: false,
  action: buttonMarkup({ label: "Try again", icon: "refresh", attrs: { "data-comics-action": "retry" } }),
});

// The Home tab is revisited after every Library navigation. Keep the mounted
// provider and shelves until real catalog data changes; replacing ~150 cards
// and their decoded covers on each visit stalls the Android WebView.
let mountedComicHome = null;
const extraMarkupByBody = new WeakMap();

// Home "Comics" tab, laid out like the anime section: a featured carousel, the
// discovery browser first (as the anime tab's), your rows (Continue reading, New
// chapters), then AniList rows. isCurrent() stops a slow response from painting over a page the user already left.
export async function renderComicsHome({ hero, rows }, ctx, { isCurrent = () => true, extraShelves = [] } = {}) {
  if (!rows || !isCurrent()) return;
  rows.setAttribute("aria-busy", "true");
  let body = rows.querySelector(":scope > .comics-home-body");
  const reused = Boolean(body?.querySelector("#comic-browser") && mountedComicHome?.body === body);
  if (!reused) {
    mountedComicHome?.watch?.disconnect();
    if (mountedComicHome?.body && mountedComicHome.body !== body) disposeCatalogArtwork(mountedComicHome.body);
    if (body) disposeCatalogArtwork(body);
    rows.innerHTML = "<div class=\"comics-home-body\">" + providerBrowserMarkup() + skeletonShelfMarkup() + skeletonShelfMarkup() + "</div>";
    body = rows.querySelector(".comics-home-body");
    mountProviderBrowser(body.querySelector("[data-comic-provider]"), ctx);
  }
  const provider = body.querySelector("[data-comic-provider]");
  // Keep a valid Comics hero visible while the existing shelves refresh.
  // If the user just switched from All/Anime, conceal that unrelated hero.
  if (hero && !hasMountedFeatured(hero)) hero.hidden = true;
  let data;
  try {
    [data] = await Promise.all([comicsApi.home(), loadLibrary().catch(() => null)]);
  } catch (error) {
    if (isCurrent()) {
      rows.removeAttribute("aria-busy");
      if (reused) {
        const oldNotice = body.querySelector("[data-comics-catalog-error]");
        oldNotice?.remove();
        const notice = document.createElement("div");
        notice.dataset.comicsCatalogError = "true";
        notice.innerHTML = errorMarkup(ctx, error.message);
        provider.after(notice);
      } else {
        disposeCatalogArtwork(body);
        body.innerHTML = errorMarkup(ctx, error.message) + comicBrowserMarkup();
        body.prepend(provider);
        mountComicBrowser(body.querySelector("#comic-browser"), { inLibrary: (comic) => Boolean(libraryEntry(comic)) });
      }
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
    const cards = (section.items || []).map((comic) => comicCardMarkup(comic, ctx, { catalogOnly: true })).filter(Boolean);
    if (cards.length) shelves.push(shelfMarkup({ id: `comics-${section.id}`, title: tr(ctx, section.title), cards }));
  }
  rows.removeAttribute("aria-busy");
  const nextMarkup = shelves.join("");
  const signature = markupSignature(nextMarkup);
  body.querySelector("[data-comics-catalog-error]")?.remove();
  const unchanged = reused && mountedComicHome?.signature === signature;
  if (!unchanged) {
    mountedComicHome?.watch?.disconnect();
    disposeCatalogArtwork(body);
    body.innerHTML = nextMarkup;
    body.prepend(provider);
    mountComicBrowser(body.querySelector("#comic-browser"), { inLibrary });
    bindShelves(body);
    refreshImages(body);
    mountCatalogArtwork(body);
    // A parent Home/Anime tab can replace `rows` without calling this renderer.
    // Observe only that known root's direct replacement, then release its art.
    const watch = typeof MutationObserver === "function" ? new MutationObserver(() => {
      if (!body.isConnected) { disposeCatalogArtwork(body); watch.disconnect(); }
    }) : null;
    watch?.observe(rows, { childList: true });
    mountedComicHome = { body, signature, watch };
    extraMarkupByBody.delete(body);
  }
  // The shared hero can have been overwritten by All/Anime independently of
  // Comics shelves. Always reconcile it, even for unchanged shelf markup.
  showFeatured(hero, featuredSlides(sections, { inLibrary }));
  for (const extra of extraShelves) {
    Promise.resolve().then(extra).then((markup) => {
      if (!isCurrent() || !body.isConnected) return;
      // Extra shelves have their own live data; update those without replacing
      // a user's active filters, scrolling positions or unrelated card rows.
      const template = document.createElement("template");
      template.innerHTML = markup || "";
      const shelf = template.content.firstElementChild;
      const key = shelf?.id || "comics-new";
      const existing = body.querySelector(`#${CSS.escape(key)}`);
      const previous = extraMarkupByBody.get(body) || new Map();
      if (!markup) {
        if (existing) disposeCatalogArtwork(existing);
        existing?.remove();
        previous.delete(key);
        extraMarkupByBody.set(body, previous);
        return;
      }
      const extraSignature = markupSignature(markup);
      if (existing && previous.get(key) === extraSignature) return;
      if (!shelf) return;
      if (existing) { disposeCatalogArtwork(existing); existing.replaceWith(shelf); }
      else {
      const anchor = body.querySelector("#comics-reading") || body.querySelector("#comic-browser");
        if (anchor) anchor.after(shelf);
        else body.prepend(shelf);
      }
      previous.set(key, extraSignature);
      extraMarkupByBody.set(body, previous);
      bindShelves(body);
      refreshImages(body);
      mountCatalogArtwork(body);
    }).catch(() => {});
  }
  return undefined;
}

// Keep the shared Library sort values. Source-specific readChapters is the
// highest finished chapter, not a percentage or an AniList chapter count.
export function sortEntries(entries, sort = "recent") {
  const list = [...entries];
  const compareText = (a, b) => String(a || "").localeCompare(String(b || ""), undefined, { sensitivity: "base", numeric: true });
  const byId = (a, b) => compareText(a.id || a.work?.id, b.id || b.work?.id);
  const byTitle = (a, b) => compareText(a.work?.title, b.work?.title) || byId(a, b);
  // Missing dates/read positions remain unknown and come after known values.
  const known = (value, { positive = false } = {}) => {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) && (positive ? number > 0 : number >= 0) ? number : null;
  };
  const byNumber = (a, b, getter, ascending = false) => {
    const left = known(getter(a));
    const right = known(getter(b));
    if (left === null) return right === null ? byTitle(a, b) : 1;
    if (right === null) return -1;
    return (ascending ? left - right : right - left) || byTitle(a, b);
  };
  const date = (entry, field) => known(entry[field], { positive: true });
  if (sort === "title") return list.sort(byTitle);
  if (sort === "title-desc") return list.sort((a, b) => compareText(b.work?.title, a.work?.title) || byId(a, b));
  if (sort === "added") return list.sort((a, b) => byNumber(a, b, (item) => date(item, "addedAt")));
  if (["progress", "unfinished"].includes(sort) && list.some((item) => known(item.readChapters) !== null))
    return list.sort((a, b) => byNumber(a, b, (item) => item.readChapters, sort === "unfinished"));
  // No last-read timestamp exists in the Comics Library payload. In All,
  // "Recently watched" falls back to the last Comics update, like Recent.
  return list.sort((a, b) => byNumber(a, b, (item) => date(item, "updatedAt") ?? date(item, "addedAt")));
}

export function filterEntries(entries, { query = "", status = "any" } = {}) {
  // Fold Latin accents for searching, while preserving Japanese voiced kana
  // (their combining marks must not be mistaken for removable accents).
  const fold = (value) => String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const needle = fold(query).trim();
  return entries.filter((entry) => (status === "any" || !status || entry.status === status)
    && (!needle || [entry.work?.title, ...(Array.isArray(entry.work?.aliases) ? entry.work.aliases : [])]
      .some((name) => fold(name).includes(needle))));
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
const previousComicsLibraryView = new WeakMap();
export async function renderComicsLibrary(list, ctx, { query = "", sort = "recent", status = "any", isCurrent = () => true } = {}) {
  if (!list) return;
  const previous = previousComicsLibraryView.get(list);
  const sortOnly = previous && previous.query === query && previous.status === status
    && previous.sort !== sort && list.closest?.("#view-library")?.dataset?.featureFilter === "comics";
  list.classList.remove("is-grouped");
  try {
    // Sorting an already-visible list changes order only; returning from the
    // reader or changing filters still refreshes the source's live state.
    await loadLibrary({ force: !sortOnly });
  } catch (error) {
    if (isCurrent()) list.innerHTML = errorMarkup(ctx, error.message);
    return;
  }
  if (!isCurrent()) return;
  previousComicsLibraryView.set(list, { query, sort, status });
  const entries = sortEntries(filterEntries([...library.entries.values()], { query, status }), sort);
  list.innerHTML = entries.length
    ? entries.map((entry) => libraryCard(entry, ctx, { progress: true })).join("")
    : emptyMarkup({
      icon: "library", title: library.entries.size ? "No matches" : "No comics yet",
      action: library.entries.size ? "" : buttonMarkup({ label: "Browse comics", icon: "arrow-right", attrs: { "data-comics-action": "browse" } }),
    });
  refreshImages(list);
}
