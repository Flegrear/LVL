// Chapter list: the index of every chapter, grouped by volume, in
// the same rows the title page uses for episodes (catalog-chapter*), so moving
// from "Season 1" to "Manga" looks the same. Pages load only when a chapter
// opens: one source opens straight away, several let the user pick.
import { buttonMarkup, escapeHtml, icon, metaMarkup, toast } from "../ui/ui.js";
import { t } from "../ui/ui-i18n.js";
import { comicsApi } from "./comics-api.js";
import { readerNames } from "./comics-render.js";

const PAGE = 60;
const KIND_NAMES = { local: "Your file" };

// Flat, ordered chapters from the index: [{ chapter, volume, title, volumeTitle, cover }]
export function flattenIndex(index) {
  return (index?.volumes || []).flatMap((group) => group.chapters.map((item) => ({ chapter: item.chapter, volume: group.volume, title: item.title || "", volumeTitle: group.title || "", cover: group.cover || "" })));
}

// The volume of a chapter the index doesn't list (sources add chapter 0, parts like
// 21.5 and extras), from the index's chapters around it: before the first chapter, the
// first chapter's volume (chapter 0 is in volume 1); otherwise the volume of the
// chapter before it (21.5 follows 21). Past the index's last chapter, a whole number
// is a new chapter not collected yet (no volume); a part keeps the last one's volume.
export function neighbourVolume(indexItems, chapter) {
  const value = Number(chapter);
  if (!Number.isFinite(value)) return null;
  let before = null;
  let after = null;
  for (const item of indexItems) {
    const number = Number(item.chapter);
    if (!Number.isFinite(number)) continue;
    if (number < value && (!before || number > Number(before.chapter))) before = item;
    if (number > value && (!after || number < Number(after.chapter))) after = item;
  }
  if (!before) return after?.volume || null;
  if (!after && Number.isInteger(value)) return null;
  return before.volume || null;
}

// The index plus what the chosen sources add: titles for the index's chapters (the
// index has numbers only), and chapters only the sources have (a manga with no index,
// like Berserk, chapters newer than it, chapter 0, parts like 21.5). Sorted by volume
// (none last), then number. A source chapter goes in its volume only when the index
// has no volumes of its own; otherwise it joins its neighbours' volume (neighbourVolume).
export function mergeSourceChapters(indexItems, extra = []) {
  const titles = new Map(extra.filter((item) => item?.chapter && item.title).map((item) => [item.chapter, item.title]));
  const known = new Set(indexItems.map((item) => item.chapter));
  const indexHasVolumes = indexItems.some((item) => item.volume);
  const titled = titles.size ? indexItems.map((item) => (item.title || !titles.has(item.chapter) ? item : { ...item, title: titles.get(item.chapter) })) : indexItems;
  const added = extra.filter((item) => item?.chapter && !known.has(item.chapter)).map((item) => ({
    chapter: item.chapter, volume: indexHasVolumes ? neighbourVolume(indexItems, item.chapter) : item.volume || null, title: item.title || "", volumeTitle: "", cover: "", fromSource: true,
  }));
  if (!added.length) return titled;
  const rank = (item) => (item.volume === null || item.volume === undefined || item.volume === "" ? Number.POSITIVE_INFINITY : Number(item.volume));
  return [...titled, ...added].sort((a, b) => rank(a) - rank(b) || Number(a.chapter) - Number(b.chapter));
}

// A chapter row: number, title and facts, then Read and Sources. No images
//: chapters read as a list.
export function chapterRowMarkup(item, { read, available, onDisk } = {}) {
  const label = t("Chapter {number}", { number: item.chapter });
  // The number is on the left and the volume in its heading; the facts say only what's not shown.
  const facts = read ? metaMarkup([t("Read")]) : "";
  const sourcesLabel = available === 1 ? t("1 source") : available ? t("{count} sources", { count: available }) : t("Sources");
  return `<li class="catalog-chapter comic-chapter-row${read ? " is-watched" : ""}${onDisk ? " is-saved" : ""}" data-chapter="${escapeHtml(item.chapter)}" data-volume="${escapeHtml(item.volume || "")}">`
    + `<div class="catalog-chapter-row"><span class="comic-chapter-number" aria-hidden="true">${escapeHtml(item.chapter)}</span>`
    + `<div class="catalog-chapter-copy"><strong>${escapeHtml(item.title || label)}</strong>${facts ? `<span class="catalog-chapter-code">${facts}</span>` : ""}</div>`
    + `<div class="catalog-chapter-actions"><button class="ui-btn ui-btn--primary ui-btn--sm" type="button" data-comic-read-chapter="${escapeHtml(item.chapter)}">${icon("play")}<span>${escapeHtml(t("Read"))}</span></button>`
    + `<button class="ui-btn ui-btn--ghost ui-btn--sm catalog-chapter-toggle" type="button" data-comic-chapter-sources aria-expanded="false"><span>${escapeHtml(sourcesLabel)}</span>${icon("chevron-down")}</button></div></div>`
    + `<div class="catalog-chapter-sources" hidden></div></li>`;
}

function candidatesMarkup(candidates, canChoose) {
  if (!candidates.length) {
    return `<p class="title-note">${escapeHtml(t("No chosen source has this chapter yet."))}</p>${canChoose ? buttonMarkup({ label: "Choose sources", size: "sm", attrs: { "data-comic-choose-sources": "" } }) : ""}`;
  }
  return `<ol class="comic-candidates">${candidates.map((item) => `<li><span class="comic-candidates__name">${escapeHtml(item.name || t(KIND_NAMES[item.kind] || item.kind))}</span>`
    + `<span class="comic-source__meta">${escapeHtml([item.lang, item.detail].filter(Boolean).join(" · "))}</span>`
    + buttonMarkup({ label: "Read", size: "sm", attrs: { "data-comics-pick": item.readerId, "data-page": String(item.page || 0) } }) + "</li>").join("")}</ol>`;
}

const toolsMarkup = () => `<div class="comic-chapter-tools"><input class="ui-search__input" type="search" placeholder="${escapeHtml(t("Search chapters"))}" aria-label="${escapeHtml(t("Search chapters"))}" data-chapter-search />`
  + `<select class="comic-chapter-sort" data-chapter-sort aria-label="${escapeHtml(t("Order"))}"><option value="asc">${escapeHtml(t("Ascending"))}</option><option value="desc">${escapeHtml(t("Descending"))}</option></select></div>`;

// Whether a volume's chapters are hidden: volumes start closed, "Not in a volume yet"
// (key "") starts open; opened: the user's choices (key -> true/false). A list with
// no volumes has no headings, so nothing is hidden.
export function volumeCollapsed(key, opened, volumeCount) {
  if (!(volumeCount > 0)) return false;
  return opened.has(key) ? !opened.get(key) : key !== "";
}

// options: { workId, comic, index, files, langs, head (element for the note and tools; else a heading is drawn),
//   onRead(readerId, page, chapter), onChooseSources() }
export function mountChapterList(container, options) {
  const { workId, comic, index, files = [], langs = ["en"], onRead, onChooseSources, head = null } = options;
  const indexItems = flattenIndex(index);
  let all = indexItems;
  const countVolumes = () => new Set(all.map((item) => item.volume).filter(Boolean)).size;
  let volumeCount = countVolumes();
  // Volumes start closed; "Not in a volume yet" (the newest
  // chapters) starts open. What the user opens or closes is kept per comic.
  const volumesKey = `lvl-comics-volumes-v2:${workId}`;
  const savedVolumes = (() => { try { const value = JSON.parse(localStorage.getItem(volumesKey) || "{}"); return value && typeof value === "object" && !Array.isArray(value) ? value : {}; } catch { return {}; } })();
  const state = { query: "", sort: "asc", shown: PAGE, read: new Set(), volumesRead: new Set(), available: {}, opened: new Map(Object.entries(savedVolumes).map(([key, open]) => [String(key), open === true])) };
  const isCollapsed = (key) => volumeCollapsed(key, state.opened, volumeCount);
  const setVolumeOpen = (key, open) => {
    state.opened.set(key, open);
    try { localStorage.setItem(volumesKey, JSON.stringify(Object.fromEntries(state.opened))); } catch {}
  };
  const onDisk = new Set();
  for (const file of files) {
    if (file.chapter) for (let n = Math.ceil(Number(file.chapter)); n <= Number(file.chapterEnd || file.chapter); n += 1) onDisk.add(String(n));
  }
  const volumesOnDisk = new Set(files.filter((file) => !file.chapter && file.volume).map((file) => String(file.volume)));
  const note = `<p class="catalog-chapters-note" data-chapter-note></p>`;
  if (head) head.innerHTML = note + (all.length > 12 ? toolsMarkup() : "");
  container.innerHTML = (head ? "" : `<div class="title-section__head"><h2 class="title-section__title">${escapeHtml(t("Chapters"))}</h2>${note}${all.length > 12 ? toolsMarkup() : ""}</div>`)
    + `<div class="comic-chapter-body"></div>`;
  const scope = head || container;
  const body = container.querySelector(".comic-chapter-body");

  function list() {
    const needle = state.query.trim().toLowerCase().replace(/^(?:ch\.?|chapter|cap[ií]tulo)\s*/, "");
    const filtered = all.filter((item) => !needle || item.chapter === needle || item.title.toLowerCase().includes(needle));
    return state.sort === "desc" ? filtered.reverse() : filtered;
  }

  function paint() {
    const items = list();
    const readCount = all.filter((item) => state.read.has(item.chapter) || (item.volume && state.volumesRead.has(item.volume))).length;
    scope.querySelector("[data-chapter-note]").innerHTML = escapeHtml(t("{count} chapters", { count: all.length }))
      + (volumeCount ? `<span>${escapeHtml(t("{count} volumes", { count: volumeCount }))}</span>` : "")
      + (readCount ? `<span>${escapeHtml(t("{count} read", { count: readCount }))}</span>` : "");
    const isRead = (item) => state.read.has(item.chapter) || Boolean(item.volume && state.volumesRead.has(item.volume));
    // Volumes in list order, each with its chapters; a collapsed one shows only its heading.
    const groups = [];
    for (const item of items) {
      const key = item.volume ?? "";
      if (groups.at(-1)?.key !== key) groups.push({ key, volume: item.volume, title: item.volumeTitle, items: [] });
      groups.at(-1).items.push(item);
    }
    const searching = Boolean(state.query.trim());
    let budget = state.shown;
    let hidden = 0;
    const rows = groups.map((group) => {
      const collapsed = !searching && isCollapsed(group.key);
      const read = group.items.filter(isRead).length;
      const heading = volumeCount ? `<li class="comic-volume-head"><button type="button" data-volume-toggle="${escapeHtml(group.key)}" aria-expanded="${!collapsed}">${icon("chevron-down")}`
        + `<span class="comic-volume-head__name">${escapeHtml(group.volume ? t("Volume {number}", { number: group.volume }) : t("Not in a volume yet"))}</span>`
        + (group.title ? `<span class="comic-source__meta">${escapeHtml(group.title)}</span>` : "")
        + `<span class="comic-volume-head__count">${escapeHtml(t("{count} chapters", { count: group.items.length }))}${read ? ` · ${escapeHtml(t("{count} read", { count: read }))}` : ""}</span></button></li>` : "";
      if (collapsed) return heading;
      const take = group.items.slice(0, Math.max(0, budget));
      hidden += group.items.length - take.length;
      budget -= take.length;
      if (!take.length) return heading;
      return heading + take.map((item) => {
        const local = onDisk.has(item.chapter) || (item.volume && volumesOnDisk.has(String(item.volume)));
        return chapterRowMarkup(item, { read: isRead(item), available: (state.available[item.chapter] || 0) + (local ? 1 : 0), onDisk: local });
      }).join("");
    }).join("");
    body.innerHTML = (all.length ? `<ol class="catalog-chapter-list comic-chapter-list">${rows || `<li class="title-note">${escapeHtml(t("No chapters match"))}</li>`}</ol>`
      : `<div class="comic-chapters-empty"><p class="title-note">${escapeHtml(t("LVL has no chapter list for this manga yet. Choose a source and its chapters appear here."))}</p>`
        + (onChooseSources ? buttonMarkup({ label: "Choose sources", size: "sm", attrs: { "data-comic-choose-sources": "" } }) : "") + "</div>")
      + (hidden ? `<button class="ui-btn ui-btn--ghost catalog-chapters-more" type="button" data-chapters-more><span>${escapeHtml(t("Show {count} more", { count: Math.min(PAGE, hidden) }))}</span></button>` : "");
  }

  function toggleVolume(key) {
    setVolumeOpen(key, isCollapsed(key));
    paint();
    body.querySelector(`[data-volume-toggle="${CSS.escape(key)}"]`)?.focus();
  }

  async function candidatesFor(row) {
    const { candidates } = await comicsApi.candidates(workId, row.dataset.chapter, row.dataset.volume, langs);
    for (const item of candidates) readerNames.set(item.readerId, { label: `${comic.title} · ${t("Chapter {number}", { number: row.dataset.chapter })}`, chapter: row.dataset.chapter, volume: row.dataset.volume || null, source: item.name });
    return candidates;
  }

  function setOpen(row, open) {
    row.classList.toggle("is-open", open);
    row.querySelector("[data-comic-chapter-sources]").setAttribute("aria-expanded", String(open));
    row.querySelector(".catalog-chapter-sources").hidden = !open;
  }

  async function openPanel(row, candidates = null) {
    const panel = row.querySelector(".catalog-chapter-sources");
    setOpen(row, true);
    panel.innerHTML = `<p class="catalog-chapter-sources-status" role="status">${escapeHtml(t("Finding sources…"))}</p>`;
    try { panel.innerHTML = candidatesMarkup(candidates || await candidatesFor(row), Boolean(onChooseSources)); } catch (error) { panel.innerHTML = `<p class="comic-source__error">${escapeHtml(error.message)}</p>`; }
  }

  scope.addEventListener("input", (event) => {
    if (!event.target.matches("[data-chapter-search]")) return;
    state.query = event.target.value;
    state.shown = PAGE;
    paint();
  });
  scope.addEventListener("change", (event) => {
    if (!event.target.matches("[data-chapter-sort]")) return;
    state.sort = event.target.value;
    paint();
  });
  container.addEventListener("click", async (event) => {
    if (event.target.closest("[data-chapters-more]")) { state.shown += PAGE; return paint(); }
    const volumeToggle = event.target.closest("[data-volume-toggle]");
    if (volumeToggle) return toggleVolume(volumeToggle.dataset.volumeToggle);
    if (event.target.closest("[data-comic-choose-sources]")) return onChooseSources?.();
    const row = event.target.closest(".comic-chapter-row");
    if (!row) return undefined;
    const pick = event.target.closest("[data-comics-pick]");
    if (pick) return onRead(pick.dataset.comicsPick, Number(pick.dataset.page) || 0, row.dataset.chapter);
    if (event.target.closest("[data-comic-chapter-sources]")) return row.classList.contains("is-open") ? setOpen(row, false) : openPanel(row);
    const read = event.target.closest("[data-comic-read-chapter]");
    if (!read) return undefined;
    read.disabled = true;
    try {
      const candidates = await candidatesFor(row);
      if (candidates.length === 1) return onRead(candidates[0].readerId, candidates[0].page || 0, row.dataset.chapter);
      return openPanel(row, candidates);
    } catch (error) { return toast(error.message); } finally { read.disabled = false; }
  });

  paint();
  const loadAvailability = () => comicsApi.availability(workId, langs).then((result) => {
    state.available = result.counts || {};
    all = mergeSourceChapters(indexItems, result.chapters || []);
    volumeCount = countVolumes();
    if (all.length > 12 && !scope.querySelector("[data-chapter-search]")) scope.querySelector("[data-chapter-note]")?.insertAdjacentHTML("afterend", toolsMarkup());
    if (container.isConnected) paint();
  }).catch(() => {});
  // Read marks and availability arrive after the list is on screen.
  comicsApi.read(workId).then((summary) => {
    state.read = new Set(summary.readChapters || []);
    state.volumesRead = new Set(summary.readVolumes || []);
    if (container.isConnected) paint();
  }).catch(() => {});
  void loadAvailability();
  return {
    get chapters() { return all; },
    refresh: loadAvailability,
    readChapters: () => state.read,
    // Opens a chapter as a click on its Read button would.
    async read(chapter) {
      const target = all.find((item) => item.chapter === chapter);
      const key = target?.volume ?? "";
      if (isCollapsed(key)) setVolumeOpen(key, true);
      const at = list().filter((item) => !isCollapsed(item.volume ?? "")).findIndex((item) => item.chapter === chapter);
      if (at >= state.shown) state.shown = at + 1;
      paint();
      const row = body.querySelector(`.comic-chapter-row[data-chapter="${CSS.escape(chapter)}"]`);
      row?.scrollIntoView({ block: "nearest" });
      row?.querySelector("[data-comic-read-chapter]")?.click();
    },
  };
}
