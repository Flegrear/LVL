// Comics on series and movie pages.
// Pages without a Manga chip (Spider-Man, Avatar: The Last Airbender, an anime with
// no manga) get a "Comics" chip. Its block is the Manga block: Chapters and Sources.
// With no comic yet, the block is a draft named after the video and opens on Sources,
// searched by that name; the first entry added makes it a comic (server side). A comic
// shows on the page it was added on and on related titles (The Amazing Spider-Man
// shows the comics added on Spider-Man); "Hide here" hides it on one page.
import { buttonMarkup, emptyMarkup, refreshImages, toast } from "../ui/ui.js";
import { t } from "../ui/ui-i18n.js";
import { comicsApi } from "./comics-api.js";
import { mountMangaBlock } from "./comics-manga.js";
import { animeMangaState, pickVideoComic, pickedVideoComic } from "./comics-links.js";
import { comicsEnabled } from "./comics-enabled.js";

const LIST_MS = 60_000;
const lists = new Map(); // video id -> { at, value: { comics, hidden }, pending }

// The video a title-page payload is about, or null (a feature's own page, no catalog id).
export function videoOf(payload) {
  if (payload?.feature) return null;
  const subject = payload?.subject || {};
  const id = String(subject.id || "");
  if (!/^tt\d{5,12}$/.test(id)) return null;
  const title = String(payload?.info?.name || payload?.meta?.name || "").replace(/\s+/g, " ").trim();
  if (!title || title === "Untitled") return null;
  return { id, type: subject.type === "movie" ? "movie" : "series", title: title.slice(0, 200) };
}

// The page's comics for the chip count; loaded once a minute at most, then the chips redraw.
function listFor(video, ctx) {
  const known = lists.get(video.id);
  if (known?.value && Date.now() - known.at < LIST_MS) return known.value;
  if (!known?.pending) {
    const pending = comicsApi.videoComics(video, { draft: "0" })
      .then((value) => { lists.set(video.id, { at: Date.now(), value }); ctx.refreshTitle?.(); })
      .catch(() => { lists.set(video.id, { at: Date.now(), value: { comics: [], hidden: 0 } }); });
    lists.set(video.id, { ...known, pending });
  }
  return known?.value || null;
}

const actionButton = (label, attr, variant = "ghost") => buttonMarkup({ label, size: "sm", variant, attrs: { [attr]: "" } });

// adding: show a new draft (Add another comic) instead of the page's comics.
async function showSection(element, payload, ctx, video, { adding = false } = {}) {
  let data;
  try {
    data = await comicsApi.videoComics(video, adding ? { draft: "1" } : {});
  } catch (error) {
    if (element.isConnected) element.innerHTML = emptyMarkup({ icon: "alert", title: t("Couldn't load comics"), text: error.message, compact: true, i18n: false });
    return;
  }
  if (!element.isConnected) return;
  lists.set(video.id, { at: Date.now(), value: { comics: data.comics, hidden: data.hidden } });
  const comics = data.comics || [];
  const current = adding ? null : comics.find((item) => item.id === pickedVideoComic(video.id)) || comics[0] || null;
  const workId = current?.id || data.draft;
  if (!workId) { element.innerHTML = ""; return; }
  const [work, index, files] = await Promise.all([
    comicsApi.work(workId).then((payload) => payload.comic).catch(() => null),
    comicsApi.units(workId).catch(() => null),
    comicsApi.files(workId).then((result) => result.files || []).catch(() => []),
  ]);
  if (!element.isConnected) return;
  if (!work) { element.innerHTML = emptyMarkup({ icon: "alert", title: t("Couldn't load comics"), compact: true }); return; }
  const draft = !current;
  const actions = (draft ? "" : actionButton(t("Add another comic"), "data-video-comic-add") + actionButton(t("Hide here"), "data-video-comic-hide"))
    + (data.hidden ? actionButton(t("Show hidden ({count})", { count: data.hidden }), "data-video-comic-unhide") : "")
    + (draft && comics.length ? actionButton(t("Cancel"), "data-video-comic-cancel") : "");
  const note = draft ? t("Search your sources for comics of {title}. The first one you add shows here and on related titles.", { title: video.title })
    : current.origin && current.origin.id !== video.id ? t("Added on {title}", { title: current.origin.title }) : "";
  // A fresh holder per draw, so listeners from an earlier draw don't pile up.
  const holder = document.createElement("div");
  element.replaceChildren(holder);
  const redraw = (options) => showSection(element, payload, ctx, video, options);
  mountMangaBlock(holder, ctx, {
    workId, comic: draft ? { ...work, title: video.title } : work, index, files, head: payload.head || null,
    others: draft ? [] : comics.filter((item) => item !== current).map((item) => ({ id: item.id, title: item.title })),
    onSwitch: (target) => { pickVideoComic(video.id, target); void redraw(); },
    view: draft ? "sources" : "chapters", library: !draft, label: "Comic", actions, note,
    // A draft that got its first source (or joined a comic that had it) is now a comic here.
    onLinked: async (result) => {
      if (!draft && result.workId === workId) return;
      pickVideoComic(video.id, result.workId);
      await redraw();
      ctx.refreshTitle?.();
    },
  });
  holder.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-video-comic-add], [data-video-comic-hide], [data-video-comic-unhide], [data-video-comic-cancel]");
    if (!button) return;
    button.disabled = true;
    if (button.matches("[data-video-comic-add]")) return void redraw({ adding: true });
    if (button.matches("[data-video-comic-cancel]")) return void redraw();
    try {
      await comicsApi.hideVideoComic(video, button.matches("[data-video-comic-hide]") ? { workId } : { all: true });
    } catch (error) { button.disabled = false; toast(error.message); return; }
    void redraw().then(() => ctx.refreshTitle?.());
  });
  refreshImages(holder);
}

export const videoComicsSection = {
  id: "comics",
  label: "Comics",
  available(payload, ctx) {
    if (!comicsEnabled()) return null;
    const video = videoOf(payload);
    if (!video) return null;
    // An anime with a manga has the Manga chip instead; wait until that's known.
    const manga = animeMangaState(payload, ctx);
    if (manga === "manga" || manga === "pending") return null;
    return listFor(video, ctx)?.comics?.length || true;
  },
  render(element, payload, ctx) {
    const video = videoOf(payload);
    if (!video) { element.innerHTML = ""; return; }
    element.innerHTML = `<div class="ui-skeleton comic-volumes__loading"></div>`;
    void showSection(element, payload, ctx, video);
  },
};
