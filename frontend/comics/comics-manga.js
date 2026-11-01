// The Manga block on title pages: the
// same block on an anime's page (behind the Manga chip) and on a manga's own
// page. Chapters / Sources, the manga's Library status, and a switch between the
// franchise's manga. On an anime's page the bar also has the manga's own scores
// (AniList, LVL Manga) and Continue reading, so the anime's hero stays the
// anime's. Core draws the "Chapters" heading and the
// chips; this fills the heading's slot (note, search, order) and the area below.
import { buttonMarkup, emptyMarkup, escapeHtml, icon, refreshImages, tabsMarkup, bindTabs, setActiveTab, toast } from "../ui/ui.js";
import { t } from "../ui/ui-i18n.js";
import { comicsApi } from "./comics-api.js";
import { STATUS_LABELS, comicKey, formatLabel, libraryEntry, loadLibrary, rememberEntry } from "./comics-render.js";
import { mountChapterList } from "./comics-chapters.js";
import { comicSourcesSection, sourceLanguages } from "./comics-sources.js";
import { pushScore, pushStatus } from "./comics-tracking.js";
import { mountMangaScore } from "./comics-score.js";

const STATUS_ORDER = ["CURRENT", "PLANNING", "COMPLETED", "PAUSED", "DROPPED", "REPEATING"];
// Blocks on screen by work id, so the hero's Continue reading can use the list.
export const mangaBlocks = new Map();

export function statusSelectMarkup(current, { label = "Library status" } = {}) {
  const options = [`<option value=""${current ? "" : " selected"}>${escapeHtml(t("Not in Library"))}</option>`]
    .concat(STATUS_ORDER.map((status) => `<option value="${status}"${status === current ? " selected" : ""}>${escapeHtml(t(STATUS_LABELS[status]))}</option>`));
  return `<label class="comic-status"><span class="ui-visually-hidden">${escapeHtml(t(label))}</span><select data-comics-status>${options.join("")}</select></label>`;
}

// Saving a status from any select on the page; core redraws the Library and the page.
export async function saveStatus(select, workId, ctx) {
  select.disabled = true;
  try {
    if (select.value) rememberEntry(workId, (await comicsApi.setStatus(workId, select.value)).entry);
    else { await comicsApi.remove(workId); rememberEntry(workId, null); }
    if (select.value) void pushStatus(workId, select.value, ctx);
    for (const other of document.querySelectorAll(`[data-comics-status-for="${CSS.escape(workId)}"]`)) if (other !== select) other.value = select.value;
    ctx.refreshLibrary?.();
  } catch (error) {
    toast(error.message);
  } finally {
    select.disabled = false;
  }
}

const unitLabel = (file) => {
  const range = (a, b) => (b && b !== a ? `${a}–${b}` : a);
  return [file.volume ? t("Volume {number}", { number: range(file.volume, file.volumeEnd) }) : "",
    file.chapter ? t("Chapter {number}", { number: range(file.chapter, file.chapterEnd) }) : ""].filter(Boolean).join(" · ");
};

// Files on disk, in reading order, each with Read / Continue.
export function filesMarkup(files) {
  if (!files?.length) return "";
  const rows = files.map((file) => {
    const progress = file.progress;
    const state = progress?.finished ? t("Read") : progress ? t("Page {page} of {pages}", { page: progress.page + 1, pages: progress.pages }) : t("{count} pages", { count: file.pages });
    const action = progress && !progress.finished ? "Continue" : "Read";
    return `<li class="comic-file${progress?.finished ? " is-read" : ""}"><span class="comic-file__unit">${escapeHtml(unitLabel(file) || file.name)}</span>`
      + `<span class="comic-file__name">${escapeHtml(file.name)}</span><span class="comic-file__state">${escapeHtml(state)}</span>`
      + buttonMarkup({ label: action, size: "sm", variant: action === "Continue" ? "primary" : "secondary", attrs: { "data-comics-read": file.id, "data-page": String(progress && !progress.finished ? progress.page : 0) } })
      + "</li>";
  }).join("");
  return `<section class="comic-block" aria-label="${escapeHtml(t("Your files"))}"><h3 class="comic-block__title">${escapeHtml(t("Your files"))}</h3><ol class="comic-files">${rows}</ol></section>`;
}

// Manual matching: local titles pick an AniList entry; matched titles can be undone.
export function matchMarkup(comic, files) {
  if (comic.local) {
    return `<section class="comic-block comic-match" aria-label="${escapeHtml(t("Match to AniList"))}"><h3 class="comic-block__title">${escapeHtml(t("Match to AniList"))}</h3>`
      + `<form class="comics-search" data-comics-match><input class="ui-search__input" type="search" name="q" maxlength="100" value="${escapeHtml(comic.title)}" aria-label="${escapeHtml(t("Search comics"))}" />`
      + buttonMarkup({ label: "Search", type: "submit", variant: "primary" }) + `</form><div class="comic-match__results"></div></section>`;
  }
  if (!files?.length) return "";
  return `<div class="comic-block">${buttonMarkup({ label: "Not this series", size: "sm", attrs: { "data-comics-unmatch": "" } })}</div>`;
}

function matchResultsMarkup(items) {
  if (!items.length) return emptyMarkup({ icon: "search", title: "No results", compact: true });
  return `<ul class="comic-match__list">${items.slice(0, 8).map((comic) => `<li><button class="comic-match__pick" type="button" data-comics-match-pick="${Number(comic.anilistId)}">`
    + (comic.cover ? `<img src="${escapeHtml(comic.cover)}" alt="" loading="lazy" />` : "")
    + `<span><strong>${escapeHtml(comic.title)}</strong><span>${escapeHtml([t(formatLabel(comic)), comic.year || "", comic.volumes ? t("{count} volumes", { count: comic.volumes }) : ""].filter(Boolean).join(" · "))}</span></span></button></li>`).join("")}</ul>`;
}

function relationCard(item, kind) {
  const meta = [item.format === "MOVIE" ? t("Movie") : item.format ? item.format.replace(/_/g, " ").toLowerCase() : "", item.year || ""].filter(Boolean).join(" · ");
  return `<li><button class="comic-relation" type="button" data-comics-${kind}="${Number(item.anilistId)}" data-title="${escapeHtml(item.title)}">`
    + (item.cover ? `<img src="${escapeHtml(item.cover)}" alt="" loading="lazy" />` : "")
    + `<span><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(meta)}</span></span></button></li>`;
}

// AniList relations: the anime (opens its video title page) and related manga.
export function relationsMarkup(comic) {
  const relations = comic?.relations || [];
  const anime = relations.filter((item) => item.type === "ANIME" && ["ADAPTATION", "ALTERNATIVE", "SIDE_STORY", "SPIN_OFF", "SEQUEL", "PREQUEL"].includes(item.relation));
  const manga = relations.filter((item) => item.type === "MANGA" && ["PREQUEL", "SEQUEL", "SIDE_STORY", "SPIN_OFF", "ALTERNATIVE", "PARENT"].includes(item.relation) && item.format !== "NOVEL");
  const block = (title, items, kind) => (items.length ? `<section class="comic-block"><h3 class="comic-block__title">${escapeHtml(t(title))}</h3><ul class="comic-relations__list">${items.map((item) => relationCard(item, kind)).join("")}</ul></section>` : "");
  return block("Anime", anime, "anime") + block("Related manga", manga, "open");
}

const VIEWS = [{ value: "chapters", label: "Chapters" }, { value: "sources", label: "Sources" }];

// About a manga, for the bottom of its own title page (like a video title's
// About): facts, staff, your files, matching, and related anime and manga.
export function comicAboutMarkup(comic, files = [], index = null) {
  // Story and art credits only (AniList also lists assistants and translators).
  const credits = (comic.staff || []).filter((person) => /^(?:story|art|story & art|original (?:story|creator)|original character design)\b/i.test(person.role || "") && !/\(/.test(person.role || ""));
  const roles = (credits.length ? credits : (comic.staff || []).slice(0, 2)).slice(0, 4).map((person) => [person.role || "Staff", person.name]);
  const chapters = index?.chapterCount || comic.chapters || 0;
  const volumes = (index?.volumes || []).filter((group) => group.volume).length || comic.volumes || 0;
  const rows = [
    ["Genres", (comic.genres || []).map((genre) => t(genre)).join(", ")],
    ...roles,
    ["Format", t(formatLabel(comic))],
    ["Started", comic.year ? String(comic.year) : ""],
    ["Chapters", [volumes ? t("{count} volumes", { count: volumes }) : "", chapters ? t("{count} chapters", { count: chapters }) : ""].filter(Boolean).join(", ")],
    ["Also known as", (comic.aliases || []).slice(0, 3).join(" · ")],
  ].filter(([, value]) => value);
  const synopsis = String(comic.description || "");
  return `<h2 class="title-section__title" id="title-about-heading">${escapeHtml(t("About"))}</h2>`
    + (synopsis.length > 260 ? `<p class="title-about__synopsis">${escapeHtml(synopsis)}</p>` : "")
    + (rows.length ? `<dl class="title-facts">${rows.map(([label, value]) => `<div><dt>${escapeHtml(t(label))}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>` : "")
    + `<div class="comic-about">${filesMarkup(files)}${matchMarkup(comic, files)}${relationsMarkup(comic)}</div>`;
}

// The About area's controls: open a file, open a related anime, match a local title.
export function bindComicAbout(container, current, ctx) {
  if (container.dataset.comicsAbout) return;
  container.dataset.comicsAbout = "1";
  // A page only for a resume point; without one the reader resumes the saved page itself.
  const open = (readerId, page) => ctx.switchView("comic", { query: `?id=${encodeURIComponent(current().id)}&read=${encodeURIComponent(readerId)}${Number(page) > 0 ? `&page=${Number(page)}` : ""}&back=1` });
  container.addEventListener("click", async (event) => {
    const { id } = current();
    if (!id) return undefined;
    const read = event.target.closest("[data-comics-read]");
    if (read) { event.preventDefault(); return open(read.dataset.comicsRead, Number(read.dataset.page) || 0); }
    const anime = event.target.closest("[data-comics-anime]");
    if (anime) {
      anime.disabled = true;
      try { await ctx.openAnimeTitle({ anilistId: Number(anime.dataset.comicsAnime), title: anime.dataset.title, section: "manga" }); } catch (error) { toast(error?.message || t("Couldn't find this anime in the catalog")); }
      anime.disabled = false;
      return undefined;
    }
    const pick = event.target.closest("[data-comics-match-pick]");
    if (pick) {
      pick.disabled = true;
      try {
        const { workId: target } = await comicsApi.rematch(id, Number(pick.dataset.comicsMatchPick));
        await loadLibrary({ force: true });
        return ctx.openFeatureTitle({ feature: "comics", item: target, historyMode: "replace" });
      } catch (error) { pick.disabled = false; return toast(error.message); }
    }
    if (event.target.closest("[data-comics-unmatch]")) {
      try {
        const { workId: target } = await comicsApi.rematch(id, null);
        await loadLibrary({ force: true });
        return ctx.openFeatureTitle({ feature: "comics", item: target, historyMode: "replace" });
      } catch (error) { return toast(error.message); }
    }
    return undefined;
  });
  container.addEventListener("submit", async (event) => {
    if (!event.target.matches("[data-comics-match]")) return;
    event.preventDefault();
    const results = container.querySelector(".comic-match__results");
    results.innerHTML = `<div class="ui-skeleton comic-volumes__loading"></div>`;
    try {
      const { items } = await comicsApi.search({ q: event.target.q.value.trim() || current().comic?.title || "" });
      results.innerHTML = matchResultsMarkup(items || []);
      refreshImages(results);
    } catch (error) { results.innerHTML = emptyMarkup({ icon: "alert", title: error.message, compact: true, i18n: false }); }
  });
}

// options: { workId, comic, index, files, head, others: [{ anilistId, title } or { id, title }], onSwitch(workId), view,
//   scores: show the manga's scores and Continue reading in the bar (an anime's page, whose hero is the anime's),
//   library: show the Library status (off for a draft), label: the block's name ("Manga", "Comic"),
//   actions: extra bar markup (the video page's Add another comic, Hide here), note: a line under the bar }
export function mountMangaBlock(element, ctx, { workId, comic, index, files = [], head = null, others = [], onSwitch = null, view = "chapters", scores = false,
  library = true, label = "Manga", actions = "", note = "", onLinked = null } = {}) {
  const id = comicKey(workId);
  const langs = sourceLanguages(ctx.preferences?.() || {}, comic);
  const entry = libraryEntry(id);
  const keyOf = (item) => item.id || comicKey(item.anilistId);
  const switcher = others.length && onSwitch
    ? `<label class="comic-status"><span class="ui-visually-hidden">${escapeHtml(t(label))}</span><select data-manga-switch>${[{ id, title: comic.title }, ...others]
      .map((item) => `<option value="${escapeHtml(keyOf(item))}"${keyOf(item) === id ? " selected" : ""}>${escapeHtml(item.title)}</option>`).join("")}</select></label>` : "";
  // Local files have no Library status; a comic read from sources does.
  const status = !library || (comic.local && !comic.sourceOnly) ? "" : statusSelectMarkup(entry?.status || "").replace("<select data-comics-status>", `<select data-comics-status data-comics-status-for="${escapeHtml(id)}">`);
  const anilist = Number(comic.score) > 0 ? `<span class="title-rating comic-block-score" title="${escapeHtml(t("AniList score for the manga"))}">${icon("star")}<strong>${escapeHtml(Number(comic.score).toFixed(1))}</strong><span>AniList</span></span>` : "";
  const scoreBar = scores && !comic.local ? `<div class="comic-block-scores">${anilist}<div class="comic-manga-score-slot"></div></div>` : "";
  const continueButton = scores ? buttonMarkup({ label: "Continue reading", icon: "play", size: "sm", attrs: { "data-manga-continue": "" } }) : "";
  element.innerHTML = `<div class="comic-block-bar">${tabsMarkup(VIEWS.map((item) => ({ ...item, label: t(item.label) })), { active: view, label: t(label), idPrefix: `manga-${id}` })}`
    + `<div class="comic-block-bar__end">${switcher}${scoreBar}${status}${continueButton}${actions}</div></div>`
    + (note ? `<p class="title-note comic-block-note">${escapeHtml(note)}</p>` : "")
    + `<div class="comic-block-view" data-manga-view="chapters"></div><div class="comic-block-view" data-manga-view="sources" hidden></div>`;
  const scoreSlot = element.querySelector(".comic-manga-score-slot");
  if (scoreSlot) mountMangaScore(scoreSlot, { id, title: comic.title || "", index, volumeCount: Number(comic.volumes) || null }, { onSaved: (overall) => pushScore(id, overall, ctx) });
  // The heading's slot: the chapter count, search and order (chapters only).
  const tools = document.createElement("div");
  tools.className = "comic-head-tools";
  if (head) { head.innerHTML = ""; head.append(tools); }
  const viewOf = (name) => element.querySelector(`[data-manga-view="${name}"]`);
  const block = { workId: id, comic, chapterList: null, element };
  const data = { comic, id, files, index, refreshChapters: () => block.chapterList?.refresh(), onLinked: onLinked || null };
  const loaded = new Set();
  const open = (readerId, page) => ctx.switchView("comic", { query: `?id=${encodeURIComponent(id)}&read=${encodeURIComponent(readerId)}${Number(page) > 0 ? `&page=${Number(page)}` : ""}&back=1` });
  function show(name) {
    for (const item of VIEWS) viewOf(item.value).hidden = item.value !== name;
    setActiveTab(element.querySelector(".ui-tabs"), name);
    tools.hidden = name !== "chapters";
    if (loaded.has(name)) return;
    loaded.add(name);
    if (name === "sources") void comicSourcesSection(viewOf("sources"), data, ctx);
  }
  block.show = show;
  block.chapterList = mountChapterList(viewOf("chapters"), {
    workId: id, comic, index, files, langs, head: head ? tools : null,
    onRead: open,
    onChooseSources: () => show("sources"),
  });
  // First unread chapter after the furthest one read, resolved like any chapter.
  block.continueReading = () => {
    const chapters = block.chapterList?.chapters || [];
    if (!chapters.length) return show("sources");
    const read = block.chapterList.readChapters();
    let last = -1;
    chapters.forEach((item, at) => { if (read.has(item.chapter)) last = at; });
    const next = chapters[last + 1] || chapters[chapters.length - 1];
    show("chapters");
    return block.chapterList.read(next.chapter);
  };
  show(view);
  bindTabs(element.querySelector(".ui-tabs"), { onChange: (value) => show(value) });
  element.querySelector("[data-manga-continue]")?.addEventListener("click", () => { void block.continueReading(); });
  element.addEventListener("change", (event) => {
    if (event.target.matches("[data-comics-status]")) return void saveStatus(event.target, id, ctx);
    if (event.target.matches("[data-manga-switch]") && event.target.value !== id) onSwitch?.(event.target.value);
    return undefined;
  });
  mangaBlocks.set(id, block);
  refreshImages(element);
  return block;
}
