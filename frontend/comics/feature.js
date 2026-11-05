// Comics, registered in frontend/features/registry.js. No sidebar
// section: comics live in Home's top bar, the main Library (Comics filter and
// "All"), Settings › Comics and title pages: a manga opens on its anime's title
// page with the Manga chip open, or on its own title page (/title?f=comics&item=…).
// /comic?id=…&read=<file>&page=<n> is the reader, over whichever page opened it.
import { toast } from "../ui/ui.js";
import { t } from "../ui/ui-i18n.js";
import { comicsApi, pageUrl } from "./comics-api.js";
import { COMICS_ES } from "./comics-i18n.js";
import { STATUS_LABELS, cachedEntries, comicCardMarkup, comicKey, libraryGroup, readerNames, rememberEntry, renderComicsHome, renderComicsLibrary } from "./comics-render.js";
import { renderComicsSettings } from "./comics-settings.js";
import { checkComicsEnabled, comicsEnabled, leaveComicsTab } from "./comics-enabled.js";
import { openReader } from "../reader/reader.js";
import { COMIC_SETTINGS_SECTIONS, COMIC_HOME_SECTIONS, COMIC_HOOKS, TITLE_SECTIONS } from "./comics-extensions.js";
import { sourceLanguages } from "./comics-sources.js";
import { flattenIndex, mergeSourceChapters } from "./comics-chapters.js";
import { knownAnimeCatalog, matchLibraryAnime, openComic as openComicTitle } from "./comics-links.js";
import { comicTitleSubject, comicTitles, loadComicTitle } from "./comics-title-subject.js";
import { joinedToVideo } from "../../shared/reading/franchise.js";

let renderId = 0;
let openedFrom = "home";
// What the reader needs about the comic: { id, comic, chaptersReady }.
const page = { id: null, data: null };
let reader = null;
let readerKey = "";
let readerPushed = false;
let readerRoute = null;
// The visible reader and the latest navigation intent have separate lifetimes:
// a rejected target must never invalidate the reader that was already open.
let readerGeneration = 0;
let navigationGeneration = 0;
let pendingReaderKey = "";
// reader.js calls saveSoon(true) synchronously inside close(). During an
// accepted handover reader already points to the *new* instance, so only the
// previous mounted instance may finish its last forced save in this window.
// Never grant this allowance to a detached/prepared/failed reader.
const finalProgressReaders = new WeakSet();
function closeMountedReader(instance) {
  if (!instance) return;
  finalProgressReaders.add(instance);
  try { instance.close({ keepUrl: true }); }
  finally { finalProgressReaders.delete(instance); }
}

export function parseComicQuery(search = "") {
  const params = new URLSearchParams(search);
  const id = comicKey(params.get("id") || "") || comicKey(Number(/^\d+$/.test(params.get("id") || "") ? params.get("id") : NaN));
  if (!id) return null;
  const read = /^(?:f[0-9a-f]{16}|ex-[0-9a-f]{20})$/.test(params.get("read") || "") ? params.get("read") : null;
  const tab = ["chapters", "details", "sources", "related"].includes(params.get("tab")) ? params.get("tab") : null;
  // page: null when the address has none (the reader then resumes the saved page).
  const page = /^\d{1,6}$/.test(params.get("page") || "") ? Math.min(100_000, Number(params.get("page"))) : null;
  return { id, read, page, back: params.get("back") === "1", tab };
}

// at: the page to open (null resumes the saved page).
const comicUrl = (id, read, at = null) => `?id=${encodeURIComponent(id)}${read ? `&read=${read}${at === null || at === undefined ? "" : `&page=${Number(at) || 0}`}` : ""}`;

function openComic(ctx, id, options) {
  openedFrom = ctx.viewActive("library") ? "library" : "home";
  return openComicTitle(ctx, id, options);
}

// The comic and its chapter index, for the reader.
function readerData(id, ctx) {
  if (page.id === id && page.data) return page.data;
  page.id = id;
  const loading = loadComicTitle(id, ctx).then(() => comicTitles.get(id));
  page.data = {
    id,
    loaded: loading,
    // The title page's list: the index plus chapters only the chosen sources have (0, 21.5).
    chaptersReady: loading.then(async (known) => {
      const items = flattenIndex(known?.index);
      try {
        const { chapters } = await comicsApi.availability(id, sourceLanguages(ctx.preferences?.() || {}, known?.comic || {}));
        return mergeSourceChapters(items, chapters || []);
      } catch { return items; }
    }),
    get comic() { return comicTitles.get(id)?.comic || {}; },
  };
  return page.data;
}

function closeReader() {
  ++navigationGeneration;
  ++readerGeneration;
  closeMountedReader(reader);
  reader = null;
  readerKey = "";
  readerRoute = null;
  pendingReaderKey = "";
}

const readerIdValid = (value) => typeof value === "string" && /^(?:f[0-9a-f]{16}|ex-[0-9a-f]{20})$/.test(value);
const sameUnit = (a, b) => a !== null && a !== undefined && a !== "" && b !== null && b !== undefined && b !== "" && Number(a) === Number(b);
const isUnvolumed = (value) => value === null || value === undefined || value === "";
const sameVolume = (a, b) => isUnvolumed(a) || isUnvolumed(b)
  ? isUnvolumed(a) && isUnvolumed(b)
  : sameUnit(a, b) || String(a).trim() === String(b).trim();
// D's reader passes an exact volume for Next/Previous/sidebar. `undefined`
// from older callers means unknown and is only safe for one matching chapter
// number. `null` is an explicit unvolumed row, not an unknown volume.
function indexedReaderUnit(list, chapter, requestedVolume = undefined, { allowUnlisted = false } = {}) {
  const matches = list.filter((item) => sameUnit(item.chapter, chapter));
  if (!matches.length && allowUnlisted) return { chapter: String(chapter), volume: requestedVolume, ambiguous: false };
  const exact = requestedVolume === undefined ? matches
    : matches.filter((item) => sameVolume(item.volume, requestedVolume));
  if (exact.length !== 1) throw Error("This chapter needs an unambiguous volume selection.");
  return { chapter: String(exact[0].chapter), volume: exact[0].volume ?? null, ambiguous: matches.length > 1 };
}
const routeAt = (route) => comicUrl(route.id, route.read, route.page);
const routeIsCurrent = (route) => {
  const now = window.location.pathname === "/comic" ? parseComicQuery(window.location.search) : null;
  return Boolean(now && now.id === route.id && now.read === route.read);
};

// A remote source's returned chapter ID has no chapter/volume in /chapter's
// candidate payload. Ask the *actual reader* endpoint to prove its identity.
// Never open a file from another work, an empty archive, or a wrong volume.
function verifyReaderInfo(route, info, target = null) {
  if (!readerIdValid(route.read) || info?.workId !== route.id || info.file?.id !== route.read || !(Number(info.pages) > 0))
    throw Error("The selected chapter could not be verified.");
  if (target?.chapter === null || target?.chapter === undefined || target?.chapter === "") return;
  if (route.read.startsWith("ex-")) {
    if (!sameUnit(info.chapter, target.chapter)) throw Error("The selected source returned a different chapter.");
  } else {
    const file = info.file || {};
    const chapterHit = file.chapter !== null && file.chapter !== undefined && file.chapter !== ""
      && Number(target.chapter) >= Number(file.chapter)
      && Number(target.chapter) <= Number(file.chapterEnd || file.chapter);
    const volumeHit = (file.chapter === null || file.chapter === undefined || file.chapter === "")
      && target.volume && file.volume && Number(target.volume) >= Number(file.volume)
      && Number(target.volume) <= Number(file.volumeEnd || file.volume);
    if (!chapterHit && !volumeHit) throw Error("The selected file belongs to a different chapter.");
  }
  const remote = route.read.startsWith("ex-");
  const actualVolume = remote ? info.volume : info.file?.volume;
  const hasActualVolume = remote ? Object.hasOwn(info, "volume") && info.volume !== undefined
    : Object.hasOwn(info.file || {}, "volume") && info.file.volume !== undefined;
  const volumeRange = !remote && !isUnvolumed(actualVolume) && !isUnvolumed(target.volume)
    && Number(target.volume) >= Number(info.file.volume)
    && Number(target.volume) <= Number(info.file.volumeEnd ?? info.file.volume);
  // An unlabelled source is safe for a genuinely unique chapter number, but
  // not when two volumes contain that same number. Explicit contradictory
  // nonempty metadata must always be refused, even for a unique number.
  if (target.ambiguous && (!hasActualVolume || (!sameVolume(target.volume, actualVolume) && !volumeRange)))
    throw Error("This chapter needs an exact matching volume to open safely.");
  if (hasActualVolume && !isUnvolumed(actualVolume) && target.volume !== undefined
    && !sameVolume(target.volume, actualVolume) && !volumeRange)
    throw Error("The selected source returned a different volume.");
}

// Open into an unmounted host. openReader() itself appends a DOM tree and calls
// onPage during its first render, *before* its promise resolves. Keeping its
// callbacks gated means the old route/page/reader survives metadata and render
// failures, and no staging progress is persisted.
async function prepareReader(section, ctx, route, isAllowed, target = null, targetName = null) {
  const data = readerData(route.id, ctx);
  await data.loaded;
  if (!isAllowed()) return null;
  const known = targetName || readerNames.get(route.read) || {};
  const info = await comicsApi.readerFile(route.read, {
    workId: route.id, name: known.label || "", describe: route.read.startsWith("ex-"),
  });
  if (!isAllowed()) return null;
  verifyReaderInfo(route, info, target);
  const currentChapter = known.chapter ?? info.chapter ?? info.file?.chapter ?? null;
  // `null` provided by a selected row means unvolumed. Only an absent volume
  // may fall back to reader metadata; never erase a known exact row identity.
  const currentVolume = known.volume !== undefined ? known.volume
    : route.read.startsWith("ex-") ? info.volume : info.file?.volume;
  const chaptersReady = Promise.resolve(data.chaptersReady).then((list) => list || []);
  const langs = sourceLanguages(ctx.preferences?.() || {}, data.comic);
  const key = `${route.id}|${route.read}`;
  const stage = document.createElement("div");
  let mounted = false;
  let instance = null;
  let born = -1;
  const owns = () => mounted && reader === instance && readerGeneration === born
    && readerKey === key && routeIsCurrent(route) && ctx.viewActive?.("comic") !== false;
  const next = async (nextId, at = null, unit = null, check = () => true) => {
    const serial = ++navigationGeneration;
    const valid = () => owns() && navigationGeneration === serial && check();
    if (!readerIdValid(nextId) || nextId === route.read || !valid()) return false;
    return handoverReader(section, ctx, { id: route.id, read: nextId, page: at }, valid, unit, null, true);
  };
  try {
    instance = await openReader(stage, {
      fileId: route.read, page: route.page, comic: data.comic,
      chapter: currentChapter, volume: currentVolume,
      chapters: chaptersReady,
      source: known.source || info.source || (route.read.startsWith("f") ? t("Your file") : ""),
      sources: currentChapter !== null || route.read.startsWith("ex-") ? async () => {
        if (!owns()) return [];
        const now = readerNames.get(route.read) || known;
        const chapter = now.chapter ?? currentChapter;
        if (chapter === null || chapter === undefined || chapter === "") return [];
        const list = await chaptersReady;
        if (!owns()) return [];
        let unit;
        try { unit = indexedReaderUnit(list, chapter, now.volume !== undefined ? now.volume : currentVolume, { allowUnlisted: true }); }
        catch { return []; } // No arbitrary sources for an ambiguous current unit.
        const result = await comicsApi.candidates(route.id, unit.chapter, unit.volume ?? "", langs);
        if (!owns()) return [];
        const candidates = Array.isArray(result?.candidates) ? result.candidates : [];
        return candidates.filter((item) => readerIdValid(item.readerId)).map((item) => ({ ...item, name: item.name || t("Your file") }));
      } : null,
      onSource: async (nextId, at) => {
        const serial = ++navigationGeneration;
        const valid = () => owns() && navigationGeneration === serial;
        try {
          const identity = readerNames.get(route.read) || known;
          const list = await chaptersReady;
          if (!valid()) return false;
          const chapter = identity.chapter ?? currentChapter;
          const volume = identity.volume !== undefined ? identity.volume : currentVolume;
          const unit = chapter !== null && chapter !== undefined && chapter !== ""
            ? indexedReaderUnit(list, chapter, volume, { allowUnlisted: true }) : null;
          if (!readerIdValid(nextId) || nextId === route.read) return false;
          return await handoverReader(section, ctx, { id: route.id, read: nextId, page: at }, valid, unit, null, true);
        } catch (error) { if (valid()) toast(error?.message || t("Cannot open the selected chapter.")); return false; }
      },
      onChapter: async (chapter, { volume = undefined, isCurrent } = {}) => {
        const serial = ++navigationGeneration;
        const valid = () => owns() && navigationGeneration === serial && (typeof isCurrent !== "function" || isCurrent());
        const list = await chaptersReady;
        if (!valid()) return false;
        const unit = indexedReaderUnit(list, chapter, volume);
        const response = await comicsApi.candidates(route.id, unit.chapter, unit.volume ?? "", langs);
        if (!valid()) return false;
        if (!Array.isArray(response?.candidates)) throw Error("Chapter sources could not be loaded.");
        const kind = route.read.startsWith("ex-") ? "ext" : "local";
        const currentSource = (readerNames.get(route.read) || known).source || info.source || "";
        const others = response.candidates.filter((entry) => readerIdValid(entry.readerId) && entry.readerId !== route.read
          && entry.kind === (entry.readerId.startsWith("ex-") ? "ext" : "local"));
        const choices = [
          ...others.filter((entry) => currentSource && entry.kind === kind && entry.name === currentSource),
          ...others.filter((entry) => entry.kind === kind), ...others,
        ];
        if (!choices.length) throw Error(t("No chosen source has this chapter yet."));
        let lastError = null;
        for (const choice of new Map(choices.map((entry) => [entry.readerId, entry])).values()) {
          if (!valid()) return false;
          const label = { label: `${data.comic?.title || ""} · ${t("Chapter {number}", { number: unit.chapter })}`, chapter: unit.chapter, volume: unit.volume, source: choice.name || "" };
          try {
            // A candidate's default page=0 means "no explicit position";
            // the reader then resumes an unfinished saved chapter page.
            const at = Number(choice.page) > 0 ? Number(choice.page) : null;
            const moved = await handoverReader(section, ctx, { id: route.id, read: choice.readerId, page: at }, valid, unit, label, true);
            if (moved || !valid()) return moved;
          } catch (error) { lastError = error; }
        }
        if (!valid()) return false;
        throw lastError || Error(t("No chosen source has this chapter yet."));
      },
      api: {
        readerFile: async (fileId) => fileId === route.read ? info : comicsApi.readerFile(fileId, { workId: route.id }),
        // Only a current mounted reader saves normally. A superseded mounted
        // reader may save its exact final page *only during its own close()*.
        // Staging, failed routes, and late callbacks cannot write progress.
        saveProgress: (progress) => mounted && progress?.fileId === route.read
          && (owns() || finalProgressReaders.has(instance))
          ? comicsApi.saveProgress({ ...progress, chapter: readerNames.get(progress.fileId)?.chapter ?? currentChapter,
            volume: readerNames.get(progress.fileId)?.volume !== undefined ? readerNames.get(progress.fileId).volume : currentVolume ?? null }, route.id)
          : Promise.resolve(),
        pageUrl,
      },
      onPage: (fileId, at) => {
        if (!owns() || fileId !== route.read) return;
        readerRoute.page = at;
        history.replaceState(history.state, "", `/comic${comicUrl(route.id, fileId, at)}`);
      },
      onOpenFile: (fileId) => next(fileId),
      onClose: () => {
        if (!owns()) return;
        mounted = false;
        ++readerGeneration;
        ++navigationGeneration;
        reader = null;
        readerKey = "";
        readerRoute = null;
        void COMIC_HOOKS.readerClosed?.(route.id, ctx, data.comic);
        leaveReader(ctx, route);
      },
    });
    if (!isAllowed()) { instance?.close({ keepUrl: true }); return null; }
    const root = stage.querySelector(".reader");
    if (!root) throw Error("The selected reader did not open.");
    return { instance, root, key, route, mounted: (generation) => { born = generation; mounted = true; } };
  } catch (error) {
    instance?.close({ keepUrl: true });
    // D's openReader now owns teardown of partial initialization failures.
    // This is only a defensive discarded-stage DOM guard, not partial-handle
    // cleanup; a normal close above is for a fully returned instance only.
    stage.querySelector(".reader")?.remove();
    throw error;
  }
}

async function handoverReader(section, ctx, route, valid, unit = null, targetName = null, replaceUrl = false) {
  const previous = reader;
  const previousKey = readerKey;
  const previousRoute = readerRoute ? { ...readerRoute } : null;
  const previousPage = { id: page.id, data: page.data };
  const previousGeneration = readerGeneration;
  const key = `${route.id}|${route.read}`;
  pendingReaderKey = key;
  let prepared = null;
  let committed = false;
  try {
    prepared = await prepareReader(section, ctx, route, valid, unit, targetName);
    if (!prepared || !valid()) { prepared?.instance.close({ keepUrl: true }); return false; }
    section.append(prepared.root);
    reader = prepared.instance;
    readerKey = key;
    readerRoute = { ...route };
    const newGeneration = ++readerGeneration;
    try {
      if (replaceUrl) {
        const accepted = ctx.switchView("comic", { query: routeAt(route), historyMode: "replace" });
        if (accepted === false) throw Error("The selected chapter route was rejected.");
      }
      if (!routeIsCurrent(route)) throw Error("The selected reader route was not accepted.");
    } catch (error) {
      reader = previous;
      readerKey = previousKey;
      readerRoute = previousRoute;
      readerGeneration = previousGeneration;
      prepared.instance.close({ keepUrl: true });
      if (previousRoute && !routeIsCurrent(previousRoute)) {
        try { ctx.switchView("comic", { query: routeAt(previousRoute), historyMode: "replace" }); } catch { /* retain original reader */ }
      }
      throw error;
    }
    // Do not allow the new reader to persist until its route is accepted;
    // its initial render already called onPage/saveSoon while unmounted.
    prepared.mounted(newGeneration);
    committed = true;
    closeMountedReader(previous);
    if (targetName) readerNames.set(route.read, targetName);
    else if (!readerNames.get(route.read)?.chapter && unit?.chapter)
      readerNames.set(route.read, { chapter: String(unit.chapter), volume: unit.volume ?? null, source: "" });
    const pageNumber = Number(prepared.root.querySelector(".reader__slider")?.value);
    if (Number.isInteger(pageNumber) && pageNumber > 0) {
      readerRoute.page = pageNumber - 1;
      history.replaceState(history.state, "", `/comic${routeAt(readerRoute)}`);
    }
    prepared.root.focus({ preventScroll: true });
    return true;
  } catch (error) {
    if (prepared && !committed) prepared.instance.close({ keepUrl: true });
    // A failed old request must NEVER roll back a newer Back/route intent.
    // Restore work metadata only when this request is still the current one.
    if (valid() && previous && previous === reader && previousRoute) {
      page.id = previousPage.id;
      page.data = previousPage.data;
      if (!routeIsCurrent(previousRoute)) {
        try { ctx.switchView("comic", { query: routeAt(previousRoute), historyMode: "replace" }); } catch { /* retain original reader */ }
      }
    }
    throw error;
  } finally {
    if (pendingReaderKey === key) pendingReaderKey = "";
  }
}

async function syncReader(section, ctx, route) {
  if (!route.read) return closeReader();
  const key = `${route.id}|${route.read}`;
  if (reader && readerKey === key) return true;
  // Reentrant activations supersede a previous pending attempt, even if its
  // target ID matches; the previous callback may now have been cancelled.
  const serial = ++navigationGeneration;
  const valid = () => navigationGeneration === serial && routeIsCurrent(route) && ctx.viewActive?.("comic") !== false;
  try {
    return await handoverReader(section, ctx, route, valid);
  } catch (error) {
    if (navigationGeneration !== serial) return false;
    if (reader && readerRoute && routeIsCurrent(readerRoute)) {
      toast(t(error?.message || "Cannot open the selected chapter."));
      return false;
    }
    if (!valid()) return false;
    if (reader) { toast(t(error?.message || "Cannot open the selected chapter.")); return false; }
    // Explicit first-open links retain their historic source fallback. Failed
    // Next/Previous and other handovers NEVER call leaveReader or go Home.
    failedReaders.add(route.read);
    const opened = readerNames.get(route.read) || {};
    const other = opened.chapter ? await otherReader(route, opened, ctx).catch(() => null) : null;
    if (!valid()) return false;
    if (other && readerIdValid(other.readerId)) {
      toast(t("{source} couldn't open this chapter. Opening it from {other}.", { source: opened.source || t("This source"), other: other.name }));
      readerNames.set(other.readerId, { ...opened, source: other.name });
      ctx.switchView("comic", { query: comicUrl(route.id, other.readerId, other.page ?? null), historyMode: "replace" });
      return false;
    }
    toast(t(error?.message || "Cannot open the selected chapter."));
    leaveReader(ctx, route);
    return false;
  }
}

// Readers that failed to open this session, so a fallback never goes back to one.
const failedReaders = new Set();
async function otherReader(route, opened, ctx) {
  const langs = sourceLanguages(ctx.preferences?.() || {}, page.data?.comic || {});
  const { candidates } = await comicsApi.candidates(route.id, opened.chapter, opened.volume || "", langs);
  return candidates.find((item) => item.readerId !== route.read && !failedReaders.has(item.readerId)) || null;
}

function leaveReader(ctx, route) {
  comicTitles.delete(route.id);
  page.id = null;
  if (readerPushed) { readerPushed = false; history.back(); }
  else void openComic(ctx, route.id, { historyMode: "replace" });
}

// One delegated listener for comic cards and controls anywhere in the app.
function installEvents(ctx) {
  void checkComicsEnabled(ctx);
  if (installEvents.done) return;
  installEvents.done = true;
  document.addEventListener("click", async (event) => {
    const opener = event.target.closest("[data-comics-open]");
    if (opener) return openComic(ctx, opener.dataset.comicsOpen);
    const control = event.target.closest("[data-comics-action]");
    if (control) {
      const action = control.dataset.comicsAction;
      // Our own Home tab: goes through core's tab handling like a click would.
      if (action === "browse") return document.querySelector("#home-tab-comics")?.click();
      if (action === "retry") return ctx.switchView(ctx.viewActive("comic") ? "comic" : ctx.viewActive("library") ? "library" : "home", { historyMode: "replace" });
      return undefined;
    }
    const card = event.target.closest("[data-comic-id]");
    if (!card) return undefined;
    const id = card.dataset.comicId;
    if (event.target.closest("[data-ui-action]")?.dataset.uiAction !== "add" || !id.startsWith("anilist-")) return openComic(ctx, id);
    event.preventDefault();
    try {
      const { entry } = await comicsApi.setStatus(id, "PLANNING");
      rememberEntry(id, entry);
      card.outerHTML = comicCardMarkup(entry.work, ctx);
      ctx.refreshLibrary();
    } catch (error) {
      toast(error.message);
    }
    return undefined;
  });
}

export const comicsFeature = Object.freeze({
  id: "comics",
  styles: ["/frontend/comics/comics.css", "/frontend/reader/reader.css"],
  translations: { es: COMICS_ES },
  views: [{
    id: "comic", route: "/comic", label: "Comic", keepQuery: true, nav: false,
    navHighlight: () => openedFrom,
    mount(section, ctx) {
      installEvents(ctx);
      section.innerHTML = "<div class=\"comics-page\"></div>";
    },
    activate(section, ctx) {
      const route = parseComicQuery(window.location.search);
      if (!route || !comicsEnabled()) return void ctx.switchView("home", { historyMode: "replace" });
      // Comics open on title pages now; old /comic?id=… links land there.
      if (!route.read) return void openComic(ctx, route.id, { historyMode: "replace" });
      ++renderId;
      // Opened from a title page's chapters: closing the reader goes back there.
      if (route.back && !reader) readerPushed = true;
      void syncReader(section, ctx, route);
      COMIC_HOOKS.activate?.(ctx);
      return undefined;
    },
    deactivate() {
      closeReader();
      page.id = null;
      readerPushed = false;
    },
    onKey: (event) => Boolean(reader?.handleKey(event)),
  }],
  homeCategories: [{
    id: "comics", label: "Comics",
    render({ hero, rows }, ctx) {
      installEvents(ctx);
      if (!comicsEnabled()) {
        for (const target of [hero, rows]) if (target) target.innerHTML = "";
        return void leaveComicsTab("#view-home", "#home-tab-all");
      }
      const id = ++renderId;
      const home = document.querySelector("#view-home");
      void renderComicsHome({ hero, rows }, ctx, {
        isCurrent: () => id === renderId && home?.dataset.featureCategory === "comics" && home.classList.contains("is-active"),
        extraShelves: COMIC_HOME_SECTIONS.map((section) => () => section(ctx)),
      });
    },
  }],
  libraryFilters: [{
    id: "comics", label: "Comics",
    // "My lists" says Reading and Rereading here (core hook C0.8).
    statusLabels: { CURRENT: STATUS_LABELS.CURRENT, REPEATING: STATUS_LABELS.REPEATING },
    render(list, ctx, options = {}) {
      installEvents(ctx);
      if (!comicsEnabled()) {
        if (list) list.innerHTML = "";
        return void leaveComicsTab("#view-library", "#library-filter-all");
      }
      const id = ++renderId;
      const library = document.querySelector("#view-library");
      void renderComicsLibrary(list, ctx, { ...options, isCurrent: () => id === renderId && library?.dataset.featureFilter === "comics" });
    },
    // Counts for this filter's own list, which also has the manga shown on an anime's card in "All".
    statuses: (options, ctx) => (comicsEnabled() ? libraryGroup(options, ctx, () => ctx.refreshLibrary()).statuses : {}),
    // Synchronous, from the cached Library; the first call loads it and redraws.
    // A manga whose anime is in the Library shares that anime's card.
    allGroup(options, ctx) {
      if (!comicsEnabled()) { void checkComicsEnabled(ctx); return null; }
      installEvents(ctx);
      const ids = ctx.libraryTitleIds?.() || null;
      const group = libraryGroup(options, ctx, () => ctx.refreshLibrary(), { joined: (entry) => joinedToVideo(entry, ids, knownAnimeCatalog) });
      matchLibraryAnime(cachedEntries(), ctx);
      return group;
    },
  }],
  settingsTabs: [{
    id: "comics", label: "Comics",
    render: (panel, ctx) => renderComicsSettings(panel, ctx, { extraSections: COMIC_SETTINGS_SECTIONS.map((section) => (holder) => section(holder, ctx)) }),
  }],
  titleSections: TITLE_SECTIONS,
  titleSubjects: [comicTitleSubject],
});
