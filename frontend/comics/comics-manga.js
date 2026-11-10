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
const STATUS_CHOICES = ["", ...STATUS_ORDER];
const statusBoundDocuments = new WeakSet();
// Blocks on screen by work id, so the hero's Continue reading can use the list.
export const mangaBlocks = new Map();

// Respect gaps created by explicit unread choices rather than assuming that
// every chapter before the furthest finished chapter is finished too.
export function continueReadingFromList(chapterList, { onEmpty = () => {}, onChapters = () => {} } = {}) {
  const chapters = chapterList?.readingOrder || [];
  if (!chapters.length) return onEmpty();
  const next = chapters.find((item) => !chapterList.isRead(item)) || chapters.at(-1);
  onChapters();
  return chapterList.read(next.chapter, next.volume ?? "");
}

const statusLabel = (status) => t(STATUS_LABELS[status] || "Not in Library");

export function statusSelectMarkup(current, { label = "Library status", workId = "" } = {}) {
  const selected = STATUS_CHOICES.includes(current) ? current : "";
  const name = statusLabel(selected);
  const options = STATUS_CHOICES.map((status) => `<button type="button" role="option" tabindex="-1" data-comics-status-choice="${status}" aria-selected="${status === selected}">`
    + `<span>${escapeHtml(statusLabel(status))}</span>${icon("check")}</button>`).join("");
  return `<div class="comic-status" data-comics-status-for="${escapeHtml(workId)}" data-comics-status-value="${selected}">`
    + `<button type="button" class="comic-status__trigger" data-comics-status-trigger aria-haspopup="listbox" aria-expanded="false" aria-label="${escapeHtml(t(label))}: ${escapeHtml(name)}">`
    + `<span data-comics-status-label>${escapeHtml(name)}</span>${icon("chevron-down")}</button>`
    + `<div class="comic-status__menu" data-comics-status-menu role="listbox" aria-label="${escapeHtml(t(label))}" hidden>${options}</div></div>`;
}

function closeStatusMenu(control, restoreFocus = false) {
  const menu = control.querySelector("[data-comics-status-menu]");
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  const trigger = control.querySelector("[data-comics-status-trigger]");
  trigger?.setAttribute("aria-expanded", "false");
  if (restoreFocus) trigger?.focus();
}

function openStatusMenu(control, first = "selected") {
  const trigger = control.querySelector("[data-comics-status-trigger]");
  const menu = control.querySelector("[data-comics-status-menu]");
  if (trigger?.disabled || !menu) return;
  menu.hidden = false;
  trigger.setAttribute("aria-expanded", "true");
  const options = [...menu.querySelectorAll("[data-comics-status-choice]")];
  const index = first === "first" ? 0 : first === "last" ? options.length - 1
    : Math.max(0, options.findIndex((option) => option.dataset.comicsStatusChoice === control.dataset.comicsStatusValue));
  options[index]?.focus();
}

function bindStatusDismissal(doc) {
  if (statusBoundDocuments.has(doc)) return;
  statusBoundDocuments.add(doc);
  for (const eventName of ["pointerdown", "focusin"]) {
    doc.addEventListener(eventName, (event) => {
      for (const control of doc.querySelectorAll("[data-comics-status-for]")) {
        if (!control.contains(event.target)) closeStatusMenu(control);
      }
    });
  }
}

function syncStatusChoice(workId, status) {
  for (const control of document.querySelectorAll("[data-comics-status-for]")) {
    if (control.dataset.comicsStatusFor !== workId) continue;
    control.dataset.comicsStatusValue = status;
    const trigger = control.querySelector("[data-comics-status-trigger]");
    const label = control.querySelector("[data-comics-status-label]");
    if (label) label.textContent = statusLabel(status);
    if (trigger) trigger.setAttribute("aria-label", `${t("Library status")}: ${statusLabel(status)}`);
    for (const option of control.querySelectorAll("[data-comics-status-choice]")) {
      option.setAttribute("aria-selected", String(option.dataset.comicsStatusChoice === status));
    }
    const badge = control.parentElement?.querySelector(".comic-block-library");
    if (badge) badge.hidden = !status;
  }
}

// Wait for the local Library write before showing a new status or syncing AniList.
export async function saveStatus(control, workId, ctx, requestedStatus) {
  const status = String(requestedStatus ?? "");
  if (!STATUS_CHOICES.includes(status) || control.dataset.comicsStatusSaving === "true") return false;
  if (control.dataset.comicsStatusValue === status) return true;
  control.dataset.comicsStatusSaving = "true";
  const trigger = control.querySelector("[data-comics-status-trigger]");
  if (trigger) trigger.disabled = true;
  control.setAttribute("aria-busy", "true");
  try {
    const entry = status ? (await comicsApi.setStatus(workId, status)).entry : (await comicsApi.remove(workId), null);
    const confirmed = entry?.status && STATUS_CHOICES.includes(entry.status) ? entry.status : status;
    rememberEntry(workId, entry);
    syncStatusChoice(workId, confirmed);
    if (confirmed) void pushStatus(workId, confirmed, ctx);
    ctx.refreshLibrary?.();
    return true;
  } catch (error) {
    toast(error?.message || t("Couldn't update Library status"));
    return false;
  } finally {
    control.dataset.comicsStatusSaving = "false";
    control.removeAttribute("aria-busy");
    if (trigger) trigger.disabled = false;
  }
}

export function bindStatusMenu(control, workId, ctx) {
  if (!control) return;
  bindStatusDismissal(control.ownerDocument);
  const trigger = control.querySelector("[data-comics-status-trigger]");
  const menu = control.querySelector("[data-comics-status-menu]");
  if (!trigger || !menu) return;
  trigger.addEventListener("click", () => menu.hidden ? openStatusMenu(control) : closeStatusMenu(control));
  trigger.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      openStatusMenu(control, event.key === "ArrowDown" ? "first" : "last");
    } else if (event.key === "Escape") {
      closeStatusMenu(control, true);
    }
  });
  menu.addEventListener("keydown", (event) => {
    const options = [...menu.querySelectorAll("[data-comics-status-choice]")];
    const index = options.indexOf(control.ownerDocument.activeElement);
    if (event.key === "Escape") { event.preventDefault(); closeStatusMenu(control, true); }
    else if (event.key === "Tab") closeStatusMenu(control);
    else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
        : (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
      options[next]?.focus();
    }
  });
  menu.addEventListener("click", (event) => {
    const choice = event.target.closest("[data-comics-status-choice]");
    if (!choice || !menu.contains(choice)) return;
    closeStatusMenu(control, true);
    void saveStatus(control, workId, ctx, choice.dataset.comicsStatusChoice);
  });
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

// The real Add handler calls this only after the server confirms its linked
// work. Switching tabs is immediate; the chapter fetch is awaited so failures
// can be shown in that chapter panel (with retry) rather than losing context.
export async function showLinkedChapters({ show, refresh, onLinked, result }) {
  show("chapters");
  const availability = await refresh?.();
  await onLinked?.(result);
  return availability;
}

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
  const hasStatus = library && !(comic.local && !comic.sourceOnly);
  const status = hasStatus ? statusSelectMarkup(entry?.status || "", { workId: id }) : "";
  const membership = library && (hasStatus || (comic.local && !comic.sourceOnly))
    ? `<span class="comic-block-library" title="${escapeHtml(t("In Library"))}"${hasStatus && !entry ? " hidden" : ""}>${icon("check")}<span>${escapeHtml(t("In Library"))}</span></span>` : "";
  const anilist = Number(comic.score) > 0 ? `<span class="title-rating comic-block-score" title="${escapeHtml(t("AniList score for the manga"))}">${icon("star")}<strong>${escapeHtml(Number(comic.score).toFixed(1))}</strong><span>AniList</span></span>` : "";
  const scoreBar = scores && !comic.local ? `<div class="comic-block-scores">${anilist}<div class="comic-manga-score-slot"></div></div>` : "";
  const continueButton = scores ? buttonMarkup({ label: "Continue reading", icon: "play", size: "sm", attrs: { "data-manga-continue": "" } }) : "";
  element.innerHTML = `<div class="comic-block-bar">${tabsMarkup(VIEWS.map((item) => ({ ...item, label: t(item.label) })), { active: view, label: t(label), idPrefix: `manga-${id}` })}`
    + `<div class="comic-block-status">${membership}${status}</div><div class="comic-block-bar__end">${switcher}${scoreBar}${continueButton}${actions}</div></div>`
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
  const data = {
    comic, id, files, index,
    refreshChapters: () => block.chapterList?.refresh(),
    onLinked: (result) => showLinkedChapters({
      show, refresh: () => block.chapterList?.refresh(), onLinked, result,
    }),
    onDifferentWork: async (target, result) => {
      // Video Comics drafts can be adopted by an existing work. Let that
      // section update its chosen work and redraw the real Chapters tab,
      // instead of sending the user to an unrelated copy of the title.
      if (onLinked) return onLinked(result);
      return ctx.openFeatureTitle({ feature: "comics", item: target, historyMode: "replace" });
    },
  };
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
  block.continueReading = () => continueReadingFromList(block.chapterList, {
    onEmpty: () => show("sources"),
    onChapters: () => show("chapters"),
  });
  show(view);
  bindTabs(element.querySelector(".ui-tabs"), { onChange: (value) => show(value) });
  bindStatusMenu(element.querySelector("[data-comics-status-for]"), id, ctx);
  element.querySelector("[data-manga-continue]")?.addEventListener("click", () => { void block.continueReading(); });
  element.addEventListener("change", (event) => {
    if (event.target.matches("[data-manga-switch]") && event.target.value !== id) onSwitch?.(event.target.value);
    return undefined;
  });
  mangaBlocks.set(id, block);
  refreshImages(element);
  return block;
}
