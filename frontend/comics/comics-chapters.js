// Chapter list: the index of every chapter, grouped by volume, in
// the same rows the title page uses for episodes (catalog-chapter*), so moving
// from "Season 1" to "Manga" looks the same. Pages load only when a chapter
// opens: one source opens straight away, several let the user pick.
import { buttonMarkup, escapeHtml, icon, metaMarkup, toast } from "../ui/ui.js";
import { t } from "../ui/ui-i18n.js";
import { comicsApi } from "./comics-api.js";
import { readerNameKey, readerNames } from "./comics-render.js";
import { unitKey } from "../../shared/reading/units.js";

const PAGE = 60;
const KIND_NAMES = { local: "Your file" };

// One chapter-list generation may own a reused container at a time. The
// previous generation's delegated listeners and pending pointer selection
// must not survive a work switch or a same-container rerender.
const chapterMounts = new WeakMap();
export function claimChapterMount(container) {
  chapterMounts.get(container)?.close();
  const controller = new AbortController();
  const owner = {
    signal: controller.signal,
    isCurrent: () => !controller.signal.aborted && chapterMounts.get(container) === owner,
    close() {
      if (controller.signal.aborted) return;
      controller.abort();
      if (chapterMounts.get(container) === owner) chapterMounts.delete(container);
    },
  };
  chapterMounts.set(container, owner);
  return owner;
}

// A chapter row is a short-lived DOM owner. Requests may resolve after sorting,
// refresh, a chapter list replacement, or a Sources panel dismissal. Only the
// current connected row/intent can publish hints, repaint, or start playback.
export function createChapterCandidateGate(container) {
  const serials = new WeakMap();
  return {
    issue(row) {
      const serial = (serials.get(row) || 0) + 1;
      serials.set(row, serial);
      return serial;
    },
    invalidate(row) { serials.set(row, (serials.get(row) || 0) + 1); },
    current(row, serial) {
      return serials.get(row) === serial && container.isConnected === true
        && row.isConnected === true && container.contains(row);
    },
  };
}

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
  // A list can restart chapter numbering in the next volume. When the
  // nearest numbered neighbour belongs to more than one explicit volume,
  // its number cannot prove where an unlabelled source extra belongs.
  const unambiguous = (item) => !item || new Set(indexItems
    .filter((candidate) => Number(candidate.chapter) === Number(item.chapter))
    .map((candidate) => String(candidate.volume ?? ""))).size === 1;
  if (!unambiguous(before) || (!before && !unambiguous(after))) return null;
  if (!before) return after?.volume || null;
  if (!after && Number.isInteger(value)) return null;
  return before.volume || null;
}

// The index plus what the chosen sources add: titles for the index's chapters (the
// index has numbers only), and chapters only the sources have (a manga with no index,
// like Berserk, chapters newer than it, chapter 0, parts like 21.5). Sorted by volume
// (none last), then number. A source chapter goes in its volume only when the index
// has no volumes of its own. A source-provided volume remains authoritative;
// only a chapter with no volume is placed alongside its neighbours.
export function mergeSourceChapters(indexItems, extra = []) {
  const keyOf = (item) => unitKey(item);
  const known = new Set(indexItems.map(keyOf));
  const indexByNumber = new Map();
  for (const item of indexItems) indexByNumber.set(item.chapter, (indexByNumber.get(item.chapter) || 0) + 1);
  const titles = new Map(extra.filter((item) => item?.chapter && item.title).map((item) => [keyOf(item), item.title]));
  const indexHasVolumes = indexItems.some((item) => item.volume);
  const titled = titles.size ? indexItems.map((item) => {
    if (item.title) return item;
    const exact = titles.get(keyOf(item));
    const unlabelled = indexByNumber.get(item.chapter) === 1 ? titles.get(unitKey({ chapter: item.chapter })) : null;
    return exact || unlabelled ? { ...item, title: exact || unlabelled } : item;
  }) : indexItems;
  const added = [];
  for (const item of extra) {
    if (!item?.chapter) continue;
    // An unlabelled source record cannot introduce a second volume for a
    // number already in the index. Equally, an explicit V2C1 must not be
    // swallowed just because the index has V1C1.
    if (!item.volume && indexByNumber.has(item.chapter)) continue;
    const volume = item.volume || (indexHasVolumes ? neighbourVolume(indexItems, item.chapter) : null);
    const key = unitKey({ chapter: item.chapter, volume });
    if (known.has(key)) continue;
    known.add(key);
    added.push({ chapter: item.chapter, volume, title: item.title || "", volumeTitle: "", cover: "", fromSource: true });
  }
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

// The whole chapter row opens the selected chapter; only its Sources control
// uses a separate action. Read state is reflected in the chapter typography.
export function chapterRowMarkup(item, { read, available, onDisk, flat = false, selectable = false, selected = false, selecting = false, key = "" } = {}) {
  const label = t("Chapter {number}", { number: item.chapter });
  const details = flat && item.volume ? [t("Volume {number}", { number: item.volume })] : [];
  const facts = details.length ? metaMarkup(details) : "";
  const sourcesLabel = available === 1 ? t("1 source") : available ? t("{count} sources", { count: available }) : t("Sources");
  return `<li class="catalog-chapter comic-chapter-row${read ? " is-watched" : ""}${onDisk ? " is-saved" : ""}" data-chapter="${escapeHtml(item.chapter)}" data-volume="${escapeHtml(item.volume || "")}" data-chapter-key="${escapeHtml(key)}">`
    + `<div class="catalog-chapter-row">${selecting ? `<button class="comic-chapter-open" type="button" data-comic-select-chapter aria-label="${escapeHtml(t("Select chapter {number}", { number: item.chapter }))}" aria-pressed="${selected}"${selectable ? "" : " disabled"}></button><input type="checkbox" data-chapter-select aria-label="${escapeHtml(t("Select chapter {number}", { number: item.chapter }))}"${selected ? " checked" : ""}${selectable ? "" : " disabled"} />` : `<button class="comic-chapter-open" type="button" data-comic-open-chapter aria-label="${escapeHtml(t("Read") + " " + (item.title || label) + (read ? " · " + t("Read") : ""))}"></button>`}<span class="comic-chapter-number" aria-hidden="true">${escapeHtml(item.chapter)}</span>`
    + `<div class="catalog-chapter-copy"><strong>${escapeHtml(item.title || label)}</strong>${facts ? `<span class="catalog-chapter-code">${facts}</span>` : ""}</div>`
    + `<div class="catalog-chapter-actions">`
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

const GROUP_STORAGE_PREFIX = "lvl-comics-group-volumes-v1:";
const SORT_STORAGE_PREFIX = "lvl-comics-chapter-sort-v1:";
export function chapterSortPreference(workId, store = globalThis.localStorage) {
  try { return store?.getItem(SORT_STORAGE_PREFIX + workId) === "desc" ? "desc" : "asc"; } catch { return "asc"; }
}
export function saveChapterSortPreference(workId, order, store = globalThis.localStorage) {
  try { store?.setItem(SORT_STORAGE_PREFIX + workId, order === "desc" ? "desc" : "asc"); } catch {}
}
export function groupPreference(workId, { store, phone = false } = {}) {
  try {
    const saved = (store === undefined ? globalThis.localStorage : store)?.getItem(GROUP_STORAGE_PREFIX + workId);
    return saved === "1" ? true : saved === "0" ? false : !phone;
  } catch { return !phone; }
}
export function saveGroupPreference(workId, grouped, store) {
  try { (store === undefined ? globalThis.localStorage : store)?.setItem(GROUP_STORAGE_PREFIX + workId, grouped ? "1" : "0"); } catch {}
}
const selectionMarkup = () => `<div class="comic-chapter-selection" data-chapter-selection-toolbar hidden>
  <span class="comic-chapter-selection__actions" data-chapter-selection-actions>
  <span data-chapter-selection-count aria-live="polite"></span>
  ${buttonMarkup({ label: "Select shown", size: "sm", variant: "ghost", attrs: { "data-chapter-select-shown": "" } })}
  ${buttonMarkup({ label: "Mark read", size: "sm", variant: "secondary", attrs: { "data-chapter-mark": "read" } })}
  ${buttonMarkup({ label: "Mark unread", size: "sm", variant: "secondary", attrs: { "data-chapter-mark": "unread" } })}
  ${buttonMarkup({ label: "Cancel", size: "sm", variant: "ghost", attrs: { "data-chapter-selection-cancel": "" } })}
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
  const mountOwner = claimChapterMount(container);
  const isCurrentMount = () => mountOwner.isCurrent();
  const candidateGate = createChapterCandidateGate(container);
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
  const state = { sort: chapterSortPreference(workId), shown: PAGE, read: new Set(), volumesRead: new Set(), unitStates: new Map(), exactRead: false,
    readConfirmed: false, readPending: true, readError: "", units: [],
    selecting: false, selected: new Set(), saving: false, available: {}, availableByUnit: null,
    availabilityError: "", failedSources: [], opened: new Map(Object.entries(savedVolumes).map(([key, open]) => [String(key), open === true])) };
  const isCollapsed = (key) => volumeCollapsed(key, state.opened, volumeCount);
  const setVolumeOpen = (key, open) => {
    state.opened.set(key, open);
    try { localStorage.setItem(volumesKey, JSON.stringify(Object.fromEntries(state.opened))); } catch {}
  };
  const inRange = (first, last, value) => first != null && value != null
    && Number(value) >= Number(first) && Number(value) <= Number(last || first);
  const duplicated = (chapter) => all.filter((item) => item.chapter === chapter).length > 1;
  const onDisk = (item) => files.some((file) => {
    if (file.chapter) {
      if (!inRange(file.chapter, file.chapterEnd, item.chapter)) return false;
      if (file.volume) return inRange(file.volume, file.volumeEnd, item.volume);
      return !duplicated(item.chapter);
    }
    return inRange(file.volume, file.volumeEnd, item.volume);
  });
  const note = `<p class="catalog-chapters-note" data-chapter-note></p>`;
  if (head) head.innerHTML = note;
  container.innerHTML = (head ? "" : `<div class="title-section__head"><h2 class="title-section__title">${escapeHtml(t("Chapters"))}</h2>${note}</div>`)
    + selectionMarkup() + `<div class="comic-chapter-body"></div>`;
  const scope = head || container;
  const body = container.querySelector(".comic-chapter-body");

  function list() {
    return chapterPresentation(all, { grouped: grouped(), descending: state.sort === "desc" }).flatMap((group) => group.items);
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
    const ambiguous = duplicated(item.chapter);
    // Old readChapters is number-only. Do not paint both V1C1 and V2C1 as
    // read because the historical aggregate says that chapter 1 was finished.
    if (!state.exactRead && ambiguous) return false;
    if (!state.exactRead) return state.read.has(item.chapter) || Boolean(item.volume && state.volumesRead.has(item.volume));
    const units = unitsFor(item);
    if (units.length) return units.some((unit) => state.unitStates.get(unit.id) === true);
    if (ambiguous) return false;
    return state.read.has(item.chapter) || Boolean(item.volume && state.volumesRead.has(item.volume));
  };

  function paint() {
    if (!isCurrentMount()) return;
    const items = list();
    const readCount = state.readConfirmed ? all.filter(chapterRead).length : 0;
    scope.querySelector("[data-chapter-note]").innerHTML = escapeHtml(t("{count} chapters", { count: all.length }))
      + (volumeCount ? `<span>${escapeHtml(t("{count} volumes", { count: volumeCount }))}</span>` : "")
      + (readCount ? `<span>${escapeHtml(t("{count} read", { count: readCount }))}</span>` : "")
      + (!state.readConfirmed && state.readPending ? `<span role="status">${escapeHtml(t("Checking reading progress…"))}</span>` : "");
    const isRead = chapterRead;
    const toolbar = container.querySelector("[data-chapter-selection-toolbar]");
    if (toolbar) {
      toolbar.hidden = !state.selecting;
      const counter = toolbar.querySelector("[data-chapter-selection-count]");
      if (counter) counter.textContent = t("{count} selected", { count: state.selected.size });
      for (const button of toolbar.querySelectorAll("[data-chapter-mark]")) button.disabled = !state.selected.size || state.saving;
    }
    // Explicit flat mode never makes volume headings, even when metadata has
    // conflicting or missing numbers. Desktop retains its previous grouping.
    // 'items' is already ordered. Re-sorting it here forced flat lists back to
    // ascending every time the title bar requested descending order.
    const groups = grouped() ? chapterPresentation(items, { grouped: true })
      : [{ key: "", volume: null, title: "", items }];
    let budget = state.shown;
    let hidden = 0;
    const rows = groups.map((group) => {
      const collapsed = grouped() && isCollapsed(group.key);
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
        const local = onDisk(item);
        const sourceCount = state.availableByUnit
          ? (state.availableByUnit[unitKey(item)]
            ?? (duplicated(item.chapter) ? 0 : state.availableByUnit[unitKey({ chapter: item.chapter })])
            ?? 0)
          : (duplicated(item.chapter) ? 0 : state.available[item.chapter] || 0);
        return chapterRowMarkup(item, { read: isRead(item), readPending: state.readPending, available: sourceCount + (local ? 1 : 0), onDisk: local, flat: !grouped(),
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

  async function candidatesFor(row, serial) {
    const { candidates } = await comicsApi.candidates(workId, row.dataset.chapter, row.dataset.volume, langs);
    if (!candidateGate.current(row, serial)) return [];
    for (const item of candidates) readerNames.set(readerNameKey(workId, item.readerId), { label: `${comic.title} · ${t("Chapter {number}", { number: row.dataset.chapter })}`, chapter: row.dataset.chapter, volume: row.dataset.volume || null, source: item.name, sourceId: item.sourceId || "" });
    return candidates;
  }

  function setOpen(row, open) {
    if (!open) candidateGate.invalidate(row);
    row.classList.toggle("is-open", open);
    row.querySelector("[data-comic-chapter-sources]").setAttribute("aria-expanded", String(open));
    row.querySelector(".catalog-chapter-sources").hidden = !open;
  }

  async function openPanel(row, candidates = null) {
    const serial = candidateGate.issue(row);
    const panel = row.querySelector(".catalog-chapter-sources");
    setOpen(row, true);
    panel.innerHTML = `<p class="catalog-chapter-sources-status" role="status">${escapeHtml(t("Finding sources…"))}</p>`;
    try {
      const found = candidates || await candidatesFor(row, serial);
      if (candidateGate.current(row, serial) && row.classList.contains("is-open"))
        panel.innerHTML = candidatesMarkup(found, Boolean(onChooseSources));
    } catch (error) {
      if (candidateGate.current(row, serial) && row.classList.contains("is-open"))
        panel.innerHTML = `<p class="comic-source__error">${escapeHtml(error.message)}</p>`;
    }
  }

  const setSort = (order) => {
    if (!isCurrentMount()) return;
    state.sort = order === "desc" ? "desc" : "asc";
    saveChapterSortPreference(workId, state.sort);
    state.shown = PAGE;
    paint();
  };
  const setGrouping = (enabled) => {
    if (!isCurrentMount()) return;
    if (groupByVolume === Boolean(enabled)) return;
    groupByVolume = Boolean(enabled);
    saveGroupPreference(workId, groupByVolume);
    state.shown = PAGE;
    paint();
  };
  container.addEventListener("change", (event) => {
    if (!event.target.matches("[data-chapter-select]")) return;
    const key = event.target.closest("[data-chapter-key]")?.dataset.chapterKey;
    if (!key) return;
    if (event.target.checked) state.selected.add(key); else state.selected.delete(key);
    paint();
    const next = [...body.querySelectorAll("[data-chapter-key]")].find((row) => row.dataset.chapterKey === key);
    next?.querySelector("[data-chapter-select]")?.focus();
  }, { signal: mountOwner.signal });
  async function markUnits(ids, read) {
    if (!isCurrentMount() || state.saving || !ids.length) return false;
    state.saving = true;
    paint();
    try {
      // Server verifies unit IDs against the current sources and returns the
      // authoritative read summary. A failed request leaves the old mark intact.
      const response = await comicsApi.markChapters(workId, ids, read);
      if (!isCurrentMount() || !container.isConnected) return false;
      readSummary.apply(response);
      return true;
    } catch (error) {
      if (isCurrentMount()) toast(error.message);
      return false;
    } finally {
      state.saving = false;
      if (isCurrentMount() && container.isConnected) paint();
    }
  }

  const selectionClick = async (event) => {
    if (event.target.closest("[data-chapter-selection-cancel]")) {
      state.selecting = false;
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
      if (await markUnits(ids, mark.dataset.chapterMark === "read")) {
        state.selected.clear();
        state.selecting = false;
        paint();
      }
      return;
    }
    return undefined;
  };
  container.addEventListener("click", selectionClick, { signal: mountOwner.signal });
  // Holding a chapter selects it. Cancel the timer as soon as the gesture
  // becomes a scroll so a slow swipe never enters selection mode.
  let press = null;
  let suppressClickUntil = 0;
  const cancelPress = () => {
    if (press?.timer !== undefined) clearTimeout(press.timer);
    press = null;
  };
  mountOwner.signal.addEventListener("abort", cancelPress, { once: true });
  const startSelection = (key) => {
    const item = all.find((candidate) => keyOf(candidate) === key);
    if (!item || state.saving) return;
    state.selecting = true;
    state.selected.clear();
    if (unitsFor(item).length) state.selected.add(key);
    suppressClickUntil = Date.now() + 900;
    paint();
  };
  container.addEventListener("pointerdown", (event) => {
    cancelPress();
    if (state.selecting || event.isPrimary === false || (event.pointerType === "mouse" && event.button !== 0)) return;
    const opener = event.target.closest?.("[data-comic-open-chapter]");
    const row = opener?.closest(".comic-chapter-row");
    if (!row) return;
    const key = row.dataset.chapterKey;
    const x = event.clientX, y = event.clientY;
    const timer = setTimeout(() => {
      press = null;
      if (isCurrentMount() && container.isConnected) startSelection(key);
    }, 470);
    press = { pointerId: event.pointerId, x, y, timer };
  }, { signal: mountOwner.signal });
  container.addEventListener("pointermove", (event) => {
    if (press && event.pointerId === press.pointerId &&
        (Math.abs(event.clientX - press.x) > 12 || Math.abs(event.clientY - press.y) > 12)) cancelPress();
  }, { signal: mountOwner.signal });
  for (const eventName of ["pointerup", "pointercancel", "lostpointercapture"])
    container.addEventListener(eventName, cancelPress, { signal: mountOwner.signal });
  container.addEventListener("contextmenu", (event) => {
    if (event.target.closest?.("[data-comic-open-chapter]")) {
      const key = event.target.closest(".comic-chapter-row")?.dataset.chapterKey;
      if (key) { event.preventDefault(); cancelPress(); startSelection(key); }
    }
  }, { signal: mountOwner.signal });
  container.addEventListener("click", (event) => {
    if (Date.now() < suppressClickUntil && event.target.closest?.(".comic-chapter-row")) {
      event.preventDefault();
      event.stopImmediatePropagation();
      suppressClickUntil = 0;
    }
  }, { capture: true, signal: mountOwner.signal });
  container.addEventListener("click", async (event) => {
    if (event.target.closest("[data-chapter-selection-toolbar]")) return;
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
    if (event.target.closest("[data-comic-select-chapter]")) {
      const key = row.dataset.chapterKey;
      if (state.selected.has(key)) state.selected.delete(key);
      else if (unitsFor(all.find((item) => keyOf(item) === key) || {}).length) state.selected.add(key);
      return paint();
    }
    const read = event.target.closest("[data-comic-open-chapter]");
    if (!read) return undefined;
    const serial = candidateGate.issue(row);
    read.disabled = true;
    try {
      const candidates = await candidatesFor(row, serial);
      if (!candidateGate.current(row, serial)) return undefined;
      if (candidates.length === 1) return onRead(candidates[0].readerId, candidates[0].page || 0, row.dataset.chapter);
      return openPanel(row, candidates);
    } catch (error) {
      if (candidateGate.current(row, serial)) return toast(error.message);
    } finally {
      if (read.isConnected) read.disabled = false;
    }
  }, { signal: mountOwner.signal });

  paint();
  let availabilityRequest = 0;
  const loadAvailability = async () => {
    if (!isCurrentMount()) return { ok: false, superseded: true };
    const request = ++availabilityRequest;
    try {
      const result = await comicsApi.availability(workId, langs);
      if (request !== availabilityRequest || !isCurrentMount()) return { ok: false, superseded: true };
      state.availabilityError = "";
      state.failedSources = (result.sources || []).filter((source) => source.error).map((source) => source.name || source.sourceId || t("Source")).slice(0, 8);
      state.available = result.counts || {};
      state.availableByUnit = result.countsByUnit || null;
      all = mergeSourceChapters(indexItems, result.chapters || []);
      state.units = result.units || [];
      volumeCount = countVolumes();
      if (container.isConnected && isCurrentMount()) paint();
      return { ok: true, chapters: all.length, failedSources: [...state.failedSources] };
    } catch (error) {
      if (request !== availabilityRequest || !isCurrentMount()) return { ok: false, superseded: true };
      state.availabilityError = String(error?.message || t("Couldn't load chapters."));
      if (container.isConnected && isCurrentMount()) paint();
      return { ok: false, error: state.availabilityError };
    }
  };
  // Read marks and availability arrive after the list is on screen.
  void readSummary.load();
  void loadAvailability();
  return {
    dispose: mountOwner.close,
    get chapters() { return all; },
    get readingOrder() { return chapterPresentation(all, { grouped: grouped() }).flatMap((group) => group.items); },
    get sort() { return state.sort; },
    get groupByVolume() { return groupByVolume; },
    setSort,
    setGrouping,
    cancelSelection() {
      if (!isCurrentMount()) return;
      state.selecting = false;
      state.selected.clear();
      paint();
    },
    refresh: loadAvailability,
    retryReadSummary: () => isCurrentMount() ? readSummary.load() : Promise.resolve(false),
    get readStatus() { return { confirmed: state.readConfirmed, pending: state.readPending, error: state.readError }; },
    readChapters: () => state.read,
    isRead: chapterRead,
    // Opens the chapter using the same control as tapping its row.
    async read(chapter, volume = null) {
      if (!isCurrentMount() || !container.isConnected) return;
      const matches = all.filter((item) => item.chapter === chapter);
      // An explicit volume must never fall through to another volume. With an
      // unknown volume, a duplicate chapter number needs an explicit choice.
      const target = volume === null
        ? (matches.length === 1 ? matches[0] : null)
        : matches.find((item) => String(item.volume ?? "") === String(volume));
      if (!target) return;
      const key = target?.volume ?? "";
      if (grouped() && isCollapsed(key)) setVolumeOpen(key, true);
      const at = list().filter((item) => !grouped() || !isCollapsed(item.volume ?? ""))
        .findIndex((item) => item.chapter === target.chapter && String(item.volume ?? "") === String(target.volume ?? ""));
      if (at >= state.shown) state.shown = at + 1;
      paint();
      const row = [...body.querySelectorAll(".comic-chapter-row")]
        .find((item) => item.dataset.chapter === target.chapter && item.dataset.volume === String(target.volume ?? ""));
      row?.scrollIntoView({ block: "nearest" });
      row?.querySelector("[data-comic-open-chapter]")?.click();
    },
  };
}
