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

// Flat mode is chronological across mixed, missing or ambiguous volumes; it
// never deduplicates repeated chapter numbers and does not rewrite metadata.
// Stable ties retain their original source/index order, including duplicate
// chapter labels that belong to different volumes.
export function chapterPresentation(items, { grouped = true, descending = false } = {}) {
  const ordered = grouped ? [...items] : [...items].sort((a, b) => {
    const na = Number(a.chapter), nb = Number(b.chapter);
    const direction = descending ? -1 : 1;
    if (Number.isFinite(na) && Number.isFinite(nb)) return (na - nb) * direction;
    if (Number.isFinite(na)) return -direction;
    if (Number.isFinite(nb)) return direction;
    return 0;
  });
  // The old grouped descending list reverses its complete row order. Flat
  // mode instead reverses only chapter-number ordering, preserving the stable
  // relative order of duplicate numbers from separate volumes.
  if (grouped && descending) ordered.reverse();
  const groups = [];
  for (const item of ordered) {
    const key = grouped ? String(item.volume ?? "") : "";
    if (groups.at(-1)?.key !== key) groups.push({ key, volume: grouped ? item.volume : null, title: grouped ? item.volumeTitle : "", items: [] });
    groups.at(-1).items.push(item);
  }
  return groups;
}

// A chapter row: number, title and facts, then Read and Sources. No images
//: chapters read as a list.
export function chapterRowMarkup(item, { read, readPending = false, available, onDisk, flat = false, selectable = false, selected = false, selecting = false, key = "" } = {}) {
  const label = t("Chapter {number}", { number: item.chapter });
  // The number is on the left and the volume in its heading; the facts say only what's not shown.
  const facts = flat && item.volume || read
    ? metaMarkup([...(flat && item.volume ? [t("Volume {number}", { number: item.volume })] : []), ...(read ? [t("Read")] : [])]) : "";
  const sourcesLabel = available === 1 ? t("1 source") : available ? t("{count} sources", { count: available }) : t("Sources");
  return `<li class="catalog-chapter comic-chapter-row${read ? " is-watched" : ""}${onDisk ? " is-saved" : ""}" data-chapter="${escapeHtml(item.chapter)}" data-volume="${escapeHtml(item.volume || "")}"${selecting ? ` data-chapter-key="${escapeHtml(key)}"` : ""}>`
    + `<div class="catalog-chapter-row">${selecting ? `<input type="checkbox" data-chapter-select aria-label="${escapeHtml(t("Select chapter {number}", { number: item.chapter }))}"${selected ? " checked" : ""}${selectable ? "" : " disabled"} />` : ""}<span class="comic-chapter-number" aria-hidden="true">${escapeHtml(item.chapter)}</span>`
    + `<div class="catalog-chapter-copy"><strong>${escapeHtml(item.title || label)}</strong>${facts ? `<span class="catalog-chapter-code">${facts}</span>` : ""}<span class="comic-chapter-state ${read === null || read === undefined ? "is-unknown" : read ? "is-read" : "is-unread"}">${escapeHtml(t(read === null || read === undefined ? readPending ? "Checking…" : "Status unknown" : read ? "Read" : "Unread"))}</span></div>`
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

const GROUP_STORAGE_PREFIX = "lvl-comics-group-volumes-v1:";
export function groupPreference(workId, { store, phone = false } = {}) {
  try {
    const saved = (store === undefined ? globalThis.localStorage : store)?.getItem(GROUP_STORAGE_PREFIX + workId);
    return saved === "1" ? true : saved === "0" ? false : !phone;
  } catch { return !phone; }
}
export function saveGroupPreference(workId, grouped, store) {
  try { (store === undefined ? globalThis.localStorage : store)?.setItem(GROUP_STORAGE_PREFIX + workId, grouped ? "1" : "0"); } catch {}
}
const groupMarkup = (grouped) => `<label class="comic-chapter-group" data-chapter-group-field><input type="checkbox" data-chapter-group${grouped ? " checked" : ""} />`
  + `<span>${escapeHtml(t("Group by volume"))}</span></label>`;
const selectionMarkup = () => `<div class="comic-chapter-selection" data-chapter-selection-toolbar>
  ${buttonMarkup({ label: "Select chapters", size: "sm", variant: "ghost", attrs: { "data-chapter-select-mode": "" } })}
  <span class="comic-chapter-selection__actions" data-chapter-selection-actions hidden>
  <span data-chapter-selection-count aria-live="polite"></span>
  ${buttonMarkup({ label: "Select shown", size: "sm", variant: "ghost", attrs: { "data-chapter-select-shown": "" } })}
  ${buttonMarkup({ label: "Mark read", size: "sm", variant: "secondary", attrs: { "data-chapter-mark": "read" } })}
  ${buttonMarkup({ label: "Mark unread", size: "sm", variant: "secondary", attrs: { "data-chapter-mark": "unread" } })}
  </span></div>`;

// Whether a volume's chapters are hidden: volumes start closed, "Not in a volume yet"
// (key "") starts open; opened: the user's choices (key -> true/false). A list with
// no volumes has no headings, so nothing is hidden.
export function volumeCollapsed(key, opened, volumeCount) {
  if (!(volumeCount > 0)) return false;
  return opened.has(key) ? !opened.get(key) : key !== "";
}

// Progress is unknown until /read resolves. Failed refreshes preserve the last
// *confirmed* marks; a later bulk mark supersedes an older in-flight GET.
export function createChapterReadSummaryController(state, fetchSummary, repaint = () => {}) {
  let revision = 0;
  const apply = (summary) => {
    ++revision;
    state.read = new Set(summary.readChapters || []);
    state.volumesRead = new Set(summary.readVolumes || []);
    state.unitStates = new Map((summary.unitStates || []).map((unit) => [unit.id, unit.read]));
    state.exactRead = Array.isArray(summary.unitStates);
    state.readConfirmed = true;
    state.readPending = false;
    state.readError = "";
    repaint();
  };
  const load = async () => {
    const request = ++revision;
    state.readPending = true;
    state.readError = "";
    repaint();
    try {
      const summary = await fetchSummary();
      if (request !== revision) return false;
      apply(summary);
      return true;
    } catch (error) {
      if (request !== revision) return false;
      state.readPending = false;
      state.readError = String(error?.message || t("Couldn't load reading progress."));
      repaint();
      return false;
    }
  };
  return { apply, load };
}

// options: { workId, comic, index, files, langs, head (element for the note and tools; else a heading is drawn),
//   onRead(readerId, page, chapter), onChooseSources() }
export function mountChapterList(container, options) {
  const { workId, comic, index, files = [], langs = ["en"], onRead, onChooseSources, head = null } = options;
  const indexItems = flattenIndex(index);
  let all = indexItems;
  const countVolumes = () => new Set(all.map((item) => item.volume).filter(Boolean)).size;
  let volumeCount = countVolumes();
  const phoneQuery = globalThis.matchMedia?.("(max-width:680px)") || null;
  let groupByVolume = groupPreference(workId, { phone: phoneQuery?.matches === true });
  const grouped = () => groupByVolume;
  // Volumes start closed; "Not in a volume yet" (the newest
  // chapters) starts open. What the user opens or closes is kept per comic.
  const volumesKey = `lvl-comics-volumes-v2:${workId}`;
  const savedVolumes = (() => { try { const value = JSON.parse(localStorage.getItem(volumesKey) || "{}"); return value && typeof value === "object" && !Array.isArray(value) ? value : {}; } catch { return {}; } })();
  const state = { query: "", sort: "asc", shown: PAGE, read: new Set(), volumesRead: new Set(), unitStates: new Map(), exactRead: false,
    readConfirmed: false, readPending: true, readError: "", units: [],
    selecting: false, selected: new Set(), saving: false, available: {},
    availabilityError: "", failedSources: [], opened: new Map(Object.entries(savedVolumes).map(([key, open]) => [String(key), open === true])) };
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
  if (head) head.innerHTML = note + groupMarkup(groupByVolume) + selectionMarkup() + (all.length > 12 ? toolsMarkup() : "");
  container.innerHTML = (head ? "" : `<div class="title-section__head"><h2 class="title-section__title">${escapeHtml(t("Chapters"))}</h2>${note}${groupMarkup(groupByVolume)}${selectionMarkup()}${all.length > 12 ? toolsMarkup() : ""}</div>`)
    + `<div class="comic-chapter-body"></div>`;
  const scope = head || container;
  const body = container.querySelector(".comic-chapter-body");

  function list() {
    const needle = state.query.trim().toLowerCase().replace(/^(?:ch\.?|chapter|cap[ií]tulo)\s*/, "");
    const filtered = all.filter((item) => !needle || item.chapter === needle || item.title.toLowerCase().includes(needle));
    return chapterPresentation(filtered, { grouped: grouped(), descending: state.sort === "desc" }).flatMap((group) => group.items);
  }

  const keyOf = (item) => `${item.chapter}\n${item.volume ?? ""}`;
  const unitsFor = (item) => {
    const matches = state.units.filter((unit) => unit.chapter === item.chapter);
    const volume = String(item.volume ?? "");
    const exact = matches.filter((unit) => String(unit.volume ?? "") === volume);
    // A source missing volume metadata maps to the row only when the chapter
    // number appears once. Duplicated chapter labels need explicit volumes.
    const ambiguous = all.filter((candidate) => candidate.chapter === item.chapter).length > 1;
    return exact.length ? exact : ambiguous ? [] : matches;
  };
  const chapterRead = (item) => {
    if (!state.readConfirmed) return null;
    if (!state.exactRead) return state.read.has(item.chapter) || Boolean(item.volume && state.volumesRead.has(item.volume));
    const units = unitsFor(item);
    if (units.length) return units.some((unit) => state.unitStates.get(unit.id) === true);
    if (all.filter((candidate) => candidate.chapter === item.chapter).length > 1) return false;
    return state.read.has(item.chapter) || Boolean(item.volume && state.volumesRead.has(item.volume));
  };

  function paint() {
    const items = list();
    const readCount = state.readConfirmed ? all.filter(chapterRead).length : 0;
    scope.querySelector("[data-chapter-note]").innerHTML = escapeHtml(t("{count} chapters", { count: all.length }))
      + (volumeCount ? `<span>${escapeHtml(t("{count} volumes", { count: volumeCount }))}</span>` : "")
      + (readCount ? `<span>${escapeHtml(t("{count} read", { count: readCount }))}</span>` : "")
      + (!state.readConfirmed && state.readPending ? `<span role="status">${escapeHtml(t("Checking reading progress…"))}</span>` : "");
    const isRead = chapterRead;
    const actions = scope.querySelector("[data-chapter-selection-actions]");
    if (actions) {
      actions.hidden = !state.selecting;
      const counter = actions.querySelector("[data-chapter-selection-count]");
      if (counter) counter.textContent = t("{count} selected", { count: state.selected.size });
      for (const button of actions.querySelectorAll("[data-chapter-mark]")) button.disabled = !state.selected.size || state.saving;
    }
    const selectButton = scope.querySelector("[data-chapter-select-mode]");
    if (selectButton) selectButton.querySelector("span").textContent = t(state.selecting ? "Cancel selection" : "Select chapters");
    // Explicit flat mode never makes volume headings, even when metadata has
    // conflicting or missing numbers. Desktop retains its previous grouping.
    const groups = chapterPresentation(items, { grouped: grouped() });
    const searching = Boolean(state.query.trim());
    let budget = state.shown;
    let hidden = 0;
    const rows = groups.map((group) => {
      const collapsed = grouped() && !searching && isCollapsed(group.key);
      const read = group.items.filter(isRead).length;
      const heading = grouped() && volumeCount ? `<li class="comic-volume-head"><button type="button" data-volume-toggle="${escapeHtml(group.key)}" aria-expanded="${!collapsed}">${icon("chevron-down")}`
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
        return chapterRowMarkup(item, { read: isRead(item), readPending: state.readPending, available: (state.available[item.chapter] || 0) + (local ? 1 : 0), onDisk: local, flat: !grouped(),
          selecting: state.selecting, selectable: unitsFor(item).length > 0, selected: state.selected.has(keyOf(item)), key: keyOf(item) });
      }).join("");
    }).join("");
    const status = state.availabilityError || state.failedSources.length
      ? `<div class="comic-chapter-availability" role="alert"><p>${escapeHtml(state.availabilityError || t("Some sources couldn't load chapters."))}</p>`
        + `${state.failedSources.length ? `<small>${escapeHtml(state.failedSources.join(" · "))}</small>` : ""}`
        + `${buttonMarkup({ label: "Try again", size: "sm", attrs: { "data-chapter-retry": "" } })}</div>` : "";
    const readStatus = state.readError
      ? `<div class="comic-chapter-availability" role="alert"><p>${escapeHtml(t("Reading progress unavailable."))} ${escapeHtml(state.readError)}</p>${buttonMarkup({ label: "Try again", size: "sm", attrs: { "data-chapter-read-retry": "" } })}</div>` : "";
    body.innerHTML = readStatus + status + (all.length ? `<ol class="catalog-chapter-list comic-chapter-list">${rows || `<li class="title-note">${escapeHtml(t("No chapters match"))}</li>`}</ol>`
      : `<div class="comic-chapters-empty"><p class="title-note">${escapeHtml(t("LVL has no chapter list for this manga yet. Choose a source and its chapters appear here."))}</p>`
        + (onChooseSources ? buttonMarkup({ label: "Choose sources", size: "sm", attrs: { "data-comic-choose-sources": "" } }) : "") + "</div>")
      + (hidden ? `<button class="ui-btn ui-btn--ghost catalog-chapters-more" type="button" data-chapters-more><span>${escapeHtml(t("Show {count} more", { count: Math.min(PAGE, hidden) }))}</span></button>` : "");
  }

  const readSummary = createChapterReadSummaryController(state, () => comicsApi.read(workId), () => {
    if (container.isConnected) paint();
  });

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
  container.addEventListener("change", (event) => {
    if (!event.target.matches("[data-chapter-select]")) return;
    const key = event.target.closest("[data-chapter-key]")?.dataset.chapterKey;
    if (!key) return;
    if (event.target.checked) state.selected.add(key); else state.selected.delete(key);
    paint();
    const next = [...body.querySelectorAll("[data-chapter-key]")].find((row) => row.dataset.chapterKey === key);
    next?.querySelector("[data-chapter-select]")?.focus();
  });
  scope.addEventListener("change", (event) => {
    if (event.target.matches("[data-chapter-group]")) {
      // Keep the chapter whose Sources panel is open visible across a layout
      // change, even when its volume would normally start collapsed.
      const current = body.querySelector(".comic-chapter-row.is-open");
      const selected = current ? { chapter: current.dataset.chapter, volume: current.dataset.volume } : null;
      groupByVolume = Boolean(event.target.checked);
      saveGroupPreference(workId, groupByVolume);
      if (grouped() && selected?.volume) setVolumeOpen(selected.volume, true);
      state.shown = PAGE;
      paint();
      if (selected) {
        const target = [...body.querySelectorAll(".comic-chapter-row")]
          .find((row) => row.dataset.chapter === selected.chapter && row.dataset.volume === selected.volume);
        if (target) { target.scrollIntoView({ block: "nearest" }); void openPanel(target); }
      }
      return;
    }
    if (!event.target.matches("[data-chapter-sort]")) return;
    state.sort = event.target.value;
    paint();
  });
  const selectionClick = async (event) => {
    if (event.target.closest("[data-chapter-select-mode]")) {
      state.selecting = !state.selecting;
      state.selected.clear();
      return paint();
    }
    if (event.target.closest("[data-chapter-select-shown]")) {
      for (const row of body.querySelectorAll(".comic-chapter-row[data-chapter-key]")) {
        const item = all.find((candidate) => keyOf(candidate) === row.dataset.chapterKey);
        if (item && unitsFor(item).length) state.selected.add(keyOf(item));
      }
      return paint();
    }
    const mark = event.target.closest("[data-chapter-mark]");
    if (mark && state.selected.size && !state.saving) {
      const ids = [...new Set(all.filter((item) => state.selected.has(keyOf(item))).flatMap((item) => unitsFor(item).map((unit) => unit.id)))];
      if (!ids.length) return;
      state.saving = true;
      paint();
      try {
        // Server verifies every requested unit against this comic's live linked
        // sources before changing anything.
        const response = await comicsApi.markChapters(workId, ids, mark.dataset.chapterMark === "read");
        readSummary.apply(response);
        state.selected.clear();
        state.selecting = false;
      } catch (error) { toast(error.message); }
      finally { state.saving = false; paint(); }
      return;
    }
    return undefined;
  };
  scope.addEventListener("click", selectionClick);
  container.addEventListener("click", async (event) => {
    if (scope === container && event.target.closest("[data-chapter-selection-toolbar]")) return;
    if (event.target.closest("[data-chapter-read-retry]")) return void readSummary.load();
    if (event.target.closest("[data-chapter-retry]")) return void loadAvailability();
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
  let availabilityRequest = 0;
  const loadAvailability = async () => {
    const request = ++availabilityRequest;
    try {
      const result = await comicsApi.availability(workId, langs);
      if (request !== availabilityRequest) return { ok: false, superseded: true };
      state.availabilityError = "";
      state.failedSources = (result.sources || []).filter((source) => source.error).map((source) => source.name || source.sourceId || t("Source")).slice(0, 8);
      state.available = result.counts || {};
      all = mergeSourceChapters(indexItems, result.chapters || []);
      state.units = result.units || [];
      volumeCount = countVolumes();
      if (all.length > 12 && !scope.querySelector("[data-chapter-search]")) scope.querySelector("[data-chapter-group-field]")?.insertAdjacentHTML("afterend", toolsMarkup());
      if (container.isConnected) paint();
      return { ok: true, chapters: all.length, failedSources: [...state.failedSources] };
    } catch (error) {
      if (request !== availabilityRequest) return { ok: false, superseded: true };
      state.availabilityError = String(error?.message || t("Couldn't load chapters."));
      if (container.isConnected) paint();
      return { ok: false, error: state.availabilityError };
    }
  };
  // Read marks and availability arrive after the list is on screen.
  void readSummary.load();
  void loadAvailability();
  return {
    get chapters() { return all; },
    get readingOrder() { return chapterPresentation(all, { grouped: grouped() }).flatMap((group) => group.items); },
    refresh: loadAvailability,
    retryReadSummary: readSummary.load,
    get readStatus() { return { confirmed: state.readConfirmed, pending: state.readPending, error: state.readError }; },
    readChapters: () => state.read,
    isRead: chapterRead,
    // Opens a chapter as a click on its Read button would.
    async read(chapter, volume = null) {
      const target = all.find((item) => item.chapter === chapter && (volume === null || String(item.volume ?? "") === String(volume)))
        || all.find((item) => item.chapter === chapter);
      if (!target) return;
      // Continue reading and programmatic chapter navigation must not fail
      // just because an old chapter-search query currently hides the target.
      if (!list().some((item) => item.chapter === target.chapter && String(item.volume ?? "") === String(target.volume ?? ""))) {
        state.query = "";
        const search = scope.querySelector("[data-chapter-search]");
        if (search) search.value = "";
      }
      const key = target?.volume ?? "";
      if (grouped() && isCollapsed(key)) setVolumeOpen(key, true);
      const at = list().filter((item) => !grouped() || !isCollapsed(item.volume ?? ""))
        .findIndex((item) => item.chapter === target.chapter && String(item.volume ?? "") === String(target.volume ?? ""));
      if (at >= state.shown) state.shown = at + 1;
      paint();
      const row = [...body.querySelectorAll(".comic-chapter-row")]
        .find((item) => item.dataset.chapter === target.chapter && item.dataset.volume === String(target.volume ?? ""));
      row?.scrollIntoView({ block: "nearest" });
      row?.querySelector("[data-comic-read-chapter]")?.click();
    },
  };
}
