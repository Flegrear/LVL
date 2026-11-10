// A manga's own title page: /title?f=comics&item=anilist-…, for
// manga with no TV/web anime and for local titles. Core draws it like a video
// title (hero, "Chapters" heading, chips); the Manga block fills the chapters.
import { escapeHtml, toast } from "../ui/ui.js";
import { t } from "../ui/ui-i18n.js";
import { comicsApi } from "./comics-api.js";
import { comicKey, formatLabel, libraryEntry, loadLibrary } from "./comics-render.js";
import { bindComicAbout, comicAboutMarkup, mangaBlocks } from "./comics-manga.js";
import { chapterSortPreference, groupPreference, saveChapterSortPreference, saveGroupPreference } from "./comics-chapters.js";
import { pushScore } from "./comics-tracking.js";
import { mountMangaScore } from "./comics-score.js";
import { comicsEnabled } from "./comics-enabled.js";

let aboutFor = { id: "", comic: null };

const STATUS_TEXT = { RELEASING: "Releasing", FINISHED: "Finished", HIATUS: "On hiatus", CANCELLED: "Cancelled", NOT_YET_RELEASED: "Not yet released" };
// work id -> { state: "loading" | "ready" | "missing", comic, index, files, ratings }
export const comicTitles = new Map();

export function loadComicTitle(id, ctx) {
  const known = comicTitles.get(id);
  if (known) return known.pending || Promise.resolve(known);
  const entry = { state: "loading", comic: null, index: null, files: [], overall: null };
  comicTitles.set(id, entry);
  entry.pending = Promise.all([
    comicsApi.work(id),
    comicsApi.units(id).catch(() => ({ volumes: [] })),
    comicsApi.files(id).then((data) => data.files || []).catch(() => []),
    loadLibrary().catch(() => null),
    id.startsWith("anilist-") ? fetch(`/api/comics/work/${id}/ratings`).then((response) => (response.ok ? response.json() : null)).catch(() => null) : null,
  ]).then(([work, index, files, _library, ratings]) => {
    Object.assign(entry, { state: "ready", comic: work.comic, index, files, overall: Number(ratings?.overall) || null });
  }, () => { entry.state = "missing"; }).finally(() => {
    entry.pending = null;
    ctx.refreshTitlePage?.();
  });
  return entry.pending;
}

export function describeComic(comic, { index = null, inLibrary = false } = {}) {
  const chapters = index?.chapterCount || comic.chapters || 0;
  const volumes = (index?.volumes || []).filter((group) => group.volume).length || comic.volumes || 0;
  const credits = (comic.staff || []).filter((person) => /^(?:story|art|story & art|original (?:story|creator))\b/i.test(person.role || ""))
    .map((person) => person.name).filter(Boolean).slice(0, 2);
  return {
    comicsHero: true,
    kind: t(formatLabel(comic)),
    name: comic.title,
    subtitle: comic.aliases?.[0] && comic.aliases[0] !== comic.title ? comic.aliases[0] : "",
    poster: comic.cover || "",
    backdrop: comic.banner || comic.cover || "",
    description: String(comic.description || "").split(/\n{2,}/).filter(Boolean).join(" "),
    genres: (comic.genres || []).slice(0, 6).map((genre) => t(genre)),
    facts: [credits.join(", "), STATUS_TEXT[comic.status] ? t(STATUS_TEXT[comic.status]) : "",
      t(formatLabel(comic)), comic.year ? String(comic.year) : "",
      chapters ? t("{count} chapters", { count: chapters }) : volumes ? t("{count} volumes", { count: volumes }) : ""].filter(Boolean),
    scores: Number.isFinite(comic.score) && comic.score > 0 ? [{ provider: "AniList", value: comic.score }] : [],
    actions: [{ label: t("Resume"), icon: "play", attrs: { "data-comic-continue": comicKey(comic.local ? comic.id : comic) }, i18n: false }],
    inLibrary,
  };
}

export const comicTitleSubject = {
  id: "comics",
  describe(item, ctx) {
    const id = comicKey(item);
    if (!id || !comicsEnabled()) return { missing: true };
    const known = comicTitles.get(id);
    if (!known) { void loadComicTitle(id, ctx); return null; }
    if (known.state === "loading") return null;
    if (known.state === "missing" || !known.comic) return { missing: true };
    return { ...describeComic(known.comic, { index: known.index, inLibrary: Boolean(libraryEntry(id)) || known.comic.local }),
      aboutHtml: comicAboutMarkup(known.comic, known.files, known.index) };
  },
  // The hero's floating Resume control and LVL score. Library status now
  // belongs beside the Chapters / Sources tabs in the Manga section.
  mount(parts, item, ctx) {
    const id = comicKey(item);
    const known = comicTitles.get(id);
    if (!known?.comic || !parts.hero) return;
    aboutFor = { id, comic: known.comic };
    if (parts.about) bindComicAbout(parts.about, () => aboutFor, ctx);
    const rating = parts.hero.querySelector("#title-lvl-rating-slot");
    // Core's video rating renderer empties this slot on each draw; fill it again.
    if (rating && !rating.querySelector(".comic-manga-score") && !known.comic.local) {
      mountMangaScore(rating, { id, title: known.comic.title, index: known.index, volumeCount: Number(known.comic.volumes) || null }, { onSaved: (overall) => pushScore(id, overall, ctx) });
    }
    const menu = parts.hero.querySelector("[data-comic-title-sort]");
    if (menu) {
      const list = mangaBlocks.get(id)?.chapterList;
      const sort = list?.sort || chapterSortPreference(id);
      const grouped = list?.groupByVolume ?? groupPreference(id, { phone: window.matchMedia?.("(max-width:680px)")?.matches === true });
      for (const button of menu.querySelectorAll("[data-comic-sort-order]")) button.setAttribute("aria-pressed", String(button.dataset.comicSortOrder === sort));
      const toggle = menu.querySelector("[data-comic-group-volumes]");
      if (toggle) toggle.checked = grouped;
    }
    if (!parts.hero.dataset.comicsBound) {
      parts.hero.dataset.comicsBound = "1";
      parts.hero.addEventListener("click", (event) => {
        const order = event.target.closest("[data-comic-sort-order]");
        if (order) {
          const targetId = aboutFor.id;
          const value = order.dataset.comicSortOrder;
          saveChapterSortPreference(targetId, value);
          const block = mangaBlocks.get(targetId);
          if (block?.element.isConnected) block.chapterList?.setSort(value);
          for (const button of order.closest("[data-comic-title-sort]").querySelectorAll("[data-comic-sort-order]"))
            button.setAttribute("aria-pressed", String(button === order));
          order.closest("details").open = false;
          return;
        }
        const button = event.target.closest("[data-comic-continue]");
        if (!button) return;
        const block = mangaBlocks.get(button.dataset.comicContinue);
        if (block?.element.isConnected) { block.element.scrollIntoView({ block: "start", behavior: "smooth" }); void block.continueReading(); }
        else toast(t("The chapter list is still loading."));
      });
      parts.hero.addEventListener("change", (event) => {
        if (!event.target.matches("[data-comic-group-volumes]")) return;
        const targetId = aboutFor.id;
        saveGroupPreference(targetId, event.target.checked);
        const block = mangaBlocks.get(targetId);
        if (block?.element.isConnected) block.chapterList?.setGrouping(event.target.checked);
      });
    }
  },
};
