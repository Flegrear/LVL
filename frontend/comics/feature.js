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
  reader?.close({ keepUrl: true });
  reader = null;
  readerKey = "";
}

async function syncReader(section, ctx, route) {
  if (!route.read) return closeReader();
  const key = `${route.id}|${route.read}`;
  if (reader && readerKey === key) return undefined;
  closeReader();
  readerKey = key;
  try {
    const data = readerData(route.id, ctx);
    await data.loaded;
    if (readerKey !== key) return undefined;
    const chaptersReady = Promise.resolve(data.chaptersReady).then((list) => list || []);
    const opened = readerNames.get(route.read) || {};
    const langs = sourceLanguages(ctx.preferences?.() || {}, data.comic);
    reader = await openReader(section, {
      fileId: route.read, page: route.page, comic: data.comic,
      chapter: opened.chapter ?? null,
      chapters: chaptersReady,
      source: opened.source || (route.read.startsWith("f") ? t("Your file") : ""),
      // This chapter on the other chosen sources, for "Read from" (its chapter may come from the server).
      sources: opened.chapter || route.read.startsWith("ex-") ? async () => {
        const now = readerNames.get(route.read) || opened;
        if (!now.chapter) return [];
        const { candidates } = await comicsApi.candidates(route.id, now.chapter, now.volume || "", langs);
        for (const item of candidates) readerNames.set(item.readerId, { ...now, source: item.name });
        return candidates.map((item) => ({ ...item, name: item.name || t("Your file") }));
      } : null,
      onSource: (readerId, at) => ctx.switchView("comic", { query: comicUrl(route.id, readerId, at), historyMode: "replace" }),
      // Another chapter: the same kind of source as this one if it has it, else the first that does.
      onChapter: async (chapter) => {
        const list = await chaptersReady;
        const item = list.find((entry) => String(entry.chapter) === String(chapter));
        try {
          const { candidates } = await comicsApi.candidates(route.id, chapter, item?.volume || "", langs);
          const kind = route.read.startsWith("ex-") ? "ext" : "local";
          const current = readerNames.get(route.read)?.source || "";
          const others = candidates.filter((entry) => entry.readerId !== route.read);
          const pick = others.find((entry) => current && entry.kind === kind && entry.name === current) || others.find((entry) => entry.kind === kind) || others[0];
          if (!pick) return candidates.length ? undefined : toast(t("No chosen source has this chapter yet."));
          readerNames.set(pick.readerId, { label: `${page.data?.comic?.title || ""} · ${t("Chapter {number}", { number: chapter })}`, chapter: String(chapter), volume: item?.volume || null, source: pick.name });
          return ctx.switchView("comic", { query: comicUrl(route.id, pick.readerId, pick.page || null), historyMode: "replace" });
        } catch (error) { return toast(error.message); }
      },
      api: {
        // A chapter opened from its address alone (a reload, a shared link): the server says which
        // chapter it is, so the chapter list, Previous/Next chapter and saved progress know it.
        readerFile: async (fileId) => {
          const known = readerNames.get(fileId);
          const info = await comicsApi.readerFile(fileId, { workId: route.id, name: known?.label || "", describe: !known?.chapter && fileId.startsWith("ex-") });
          if (!known?.chapter && info.chapter) {
            readerNames.set(fileId, { label: `${data.comic?.title || ""} · ${t("Chapter {number}", { number: info.chapter })}`, chapter: String(info.chapter), volume: info.volume || null, source: info.source || "" });
          }
          return info;
        },
        saveProgress: (progress) => comicsApi.saveProgress({ ...progress, chapter: readerNames.get(progress.fileId)?.chapter ?? null, volume: readerNames.get(progress.fileId)?.volume ?? null }, route.id),
        pageUrl,
      },
      onPage: (fileId, at) => history.replaceState(history.state, "", `/comic${comicUrl(route.id, fileId, at)}`),
      onOpenFile: (fileId) => ctx.switchView("comic", { query: comicUrl(route.id, fileId), historyMode: "replace" }),
      onClose: () => {
        reader = null;
        readerKey = "";
        void COMIC_HOOKS.readerClosed?.(route.id, ctx, page.data?.comic);
        // Progress shows on the title page when it draws again.
        leaveReader(ctx, route);
      },
    });
  } catch (error) {
    readerKey = "";
    // A chapter this source can't open (no pages, site error): the same chapter on another
    // chosen source, else back to the page the reader was opened from, instead of a black screen.
    failedReaders.add(route.read);
    const opened = readerNames.get(route.read) || {};
    const other = opened.chapter ? await otherReader(route, opened, ctx).catch(() => null) : null;
    if (other) {
      toast(t("{source} couldn't open this chapter. Opening it from {other}.", { source: opened.source || t("This source"), other: other.name }));
      readerNames.set(other.readerId, { ...opened, source: other.name });
      return void ctx.switchView("comic", { query: comicUrl(route.id, other.readerId, other.page || null), historyMode: "replace" });
    }
    toast(t(error.message));
    leaveReader(ctx, route);
  }
  return undefined;
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
      if (route.back) readerPushed = true;
      void syncReader(section, ctx, route);
      COMIC_HOOKS.activate?.(ctx);
      return undefined;
    },
    deactivate() {
      closeReader();
      page.id = null;
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
