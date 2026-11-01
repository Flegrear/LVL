// Comic reader, laid out after the "PANEL" reference: chapters
// down the left, title and page count on top, the page in the middle, and
// progress, chapter buttons, page thumbnails and settings at the bottom.
// Pages come from api.pageUrl(id, n); progress is saved per page.
import { escapeHtml } from "../ui/ui.js";
import { t } from "../ui/ui-i18n.js";
import { atEnd, chapterNeighbours, clickAction, comfortFilter, CREDIT_STRIP_ROWS, creditStripRows, defaultMode, isNight, keyAction, normalizeComfort, normalizeMode, spreadOf, startPage, step, stripStep, wheelAction } from "./reader-core.js";

const COMFORT_KEY = "lvl-reader-comfort-v1";
const SIDEBAR_KEY = "lvl-reader-sidebar-v1";
// Page previews in the bottom bar can be turned off (they give away what's coming).
const PREVIEWS_KEY = "lvl-reader-previews-v1";
const modeKey = (workId) => `lvl-reader-mode-v1:${workId}`;
const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key) || "null") ?? fallback; } catch { return fallback; } };
const SAFE_IMAGE = /^(?:\/api\/comics\/[\w./-]+|https:\/\/[^\s"'()\\<>]+)$/;

// Reader-only icons, so the shared icon set stays as it is.
const ICONS = {
  back: '<path d="m14.5 6-6 6 6 6"/>',
  left: '<path d="m14.5 6-6 6 6 6"/>',
  right: '<path d="m9.5 6 6 6-6 6"/>',
  sidebar: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M9.5 4.5v15"/>',
  fullscreen: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  more: '<circle cx="6" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="1.5" fill="currentColor" stroke="none"/>',
  vertical: '<rect x="7" y="3.5" width="10" height="7.5" rx="1.2"/><rect x="7" y="13" width="10" height="7.5" rx="1.2"/>',
  double: '<rect x="3.5" y="5" width="8" height="14" rx="1.2"/><rect x="12.5" y="5" width="8" height="14" rx="1.2"/>',
  comfort: '<circle cx="12" cy="12" r="3.5"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"/>',
  direction: '<path d="M19 12H5M10 7l-5 5 5 5"/>',
  settings: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  previews: '<rect x="3" y="7" width="5" height="10" rx="1"/><rect x="9.5" y="7" width="5" height="10" rx="1"/><rect x="16" y="7" width="5" height="10" rx="1"/>',
  single: '<rect x="7" y="4.5" width="10" height="15" rx="1.2"/>',
  collapse: '<path d="m7 10 5 5 5-5"/>',
};
const svg = (name) => `<svg class="reader__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;
const iconButton = (name, label, extra = "") => `<button class="reader__icon-btn" type="button" data-reader="${name}" aria-label="${escapeHtml(t(label))}" title="${escapeHtml(t(label))}"${extra}>${svg(name)}</button>`;

function markup(comic, pages) {
  const cover = SAFE_IMAGE.test(comic.cover || "") ? `<img class="reader__series-cover" src="${escapeHtml(comic.cover)}" alt="" />` : "";
  const genres = (comic.genres || []).slice(0, 3).map((genre) => `<span class="reader__badge">${escapeHtml(t(genre))}</span>`).join("");
  const facts = [comic.year, comic.chapters ? t("{count} chapters", { count: comic.chapters }) : "", comic.volumes ? t("{count} volumes", { count: comic.volumes }) : ""].filter(Boolean).join(" · ");
  const synopsis = String(comic.description || "").split(/\n{2,}/).filter(Boolean).slice(0, 3).map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join("");
  const fits = [["height", "Fit height"], ["width", "Fit width"], ["original", "Original size"]];
  return `<svg class="reader__defs" width="0" height="0" aria-hidden="true"><filter id="reader-warm"><feColorMatrix type="matrix" values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 1 0"/></filter></svg>`
    + `<aside class="reader__side" aria-label="${escapeHtml(t("Chapters"))}">`
    + `<button class="reader__back" type="button" data-reader="close">${svg("back")}<span>${escapeHtml(t("Back to series"))}</span></button>`
    + `<div class="reader__series">${cover}<div><strong>${escapeHtml(comic.title || "")}</strong>${genres ? `<span class="reader__badges">${genres}</span>` : ""}</div></div>`
    + `<div class="reader__side-tabs" role="tablist"><button type="button" role="tab" data-side-tab="chapters" aria-selected="true">${escapeHtml(t("Chapters"))}</button>`
    + `<button type="button" role="tab" data-side-tab="details" aria-selected="false">${escapeHtml(t("Details"))}</button></div>`
    + `<ol class="reader__chapters" data-side-panel="chapters"><li class="reader__note">${escapeHtml(t("Loading…"))}</li></ol>`
    + `<div class="reader__details" data-side-panel="details" hidden>${facts ? `<p class="reader__facts">${escapeHtml(facts)}</p>` : ""}<p class="reader__facts" data-reader-from hidden></p>${synopsis}</div></aside>`
    + `<section class="reader__main">`
    + `<header class="reader__bar">${iconButton("sidebar", "Chapters", ' aria-expanded="true"')}`
    + `<div class="reader__heading"><strong>${escapeHtml(comic.title || "")}</strong><span class="reader__chapter-title"></span></div>`
    + `<div class="reader__pager">${iconButton("left", "Page to the left")}<span class="reader__count" aria-live="polite"></span>${iconButton("right", "Page to the right")}</div>`
    + `<div class="reader__tools">${iconButton("fullscreen", "Fullscreen")}`
    + `<select class="reader__select" data-reader="fit" aria-label="${escapeHtml(t("Page size"))}">${fits.map(([value, label]) => `<option value="${value}">${escapeHtml(t(label))}</option>`).join("")}</select>`
    + `${iconButton("more", "More", ' aria-expanded="false"')}</div></header>`
    + `<div class="reader__menu reader__pop" hidden>`
    + `<label data-reader-source-row hidden>${escapeHtml(t("Read from"))} <select class="reader__select" data-reader="source"></select></label>`
    + `<label>${escapeHtml(t("Direction"))} <select class="reader__select" data-reader="direction"><option value="rtl">${escapeHtml(t("Right to left"))}</option><option value="ltr">${escapeHtml(t("Left to right"))}</option></select></label>`
    + `<label class="reader__check"><input type="checkbox" data-reader="offset" /> ${escapeHtml(t("Shift spread"))}</label>`
    + `<p class="reader__hint">${escapeHtml(t("Click the middle of the page to hide the bars."))}</p></div>`
    + `<div class="reader__comfort reader__pop" hidden>`
    + `<label>${escapeHtml(t("Warm"))} <input type="range" min="0" max="100" data-comfort="warm" /></label>`
    + `<label>${escapeHtml(t("Dim"))} <input type="range" min="0" max="100" data-comfort="dim" /></label>`
    + `<label>${escapeHtml(t("Background"))} <select class="reader__select" data-comfort="theme"><option value="black">${escapeHtml(t("Black"))}</option><option value="dark">${escapeHtml(t("Dark"))}</option><option value="sepia">${escapeHtml(t("Sepia"))}</option><option value="white">${escapeHtml(t("White"))}</option></select></label>`
    + `<label class="reader__check"><input type="checkbox" data-comfort="night" /> ${escapeHtml(t("Warm at night (20:00–07:00)"))}</label></div>`
    + `<main class="reader__stage" tabindex="0"></main>`
    + `<footer class="reader__foot"><div class="reader__progress"><span class="reader__end-num" data-reader-start>1</span>`
    + `<input class="reader__slider" type="range" min="1" max="${Math.max(1, pages)}" aria-label="${escapeHtml(t("Page"))}" /><span class="reader__end-num" data-reader-last>${Math.max(1, pages)}</span></div>`
    + `<div class="reader__footrow"><button class="reader__chapter-btn" type="button" data-reader="prevChapter">${svg("left")}<span>${escapeHtml(t("Previous"))}</span></button>`
    + `<div class="reader__strip"><button class="reader__strip-toggle" type="button" data-reader="previews" aria-pressed="true">${svg("collapse")}<span data-previews-label>${escapeHtml(t("Hide pages"))}</span></button>`
    + `<div class="reader__thumbs" role="list" aria-label="${escapeHtml(t("Pages"))}"></div></div>`
    + `<button class="reader__chapter-btn" type="button" data-reader="nextChapter"><span>${escapeHtml(t("Next"))}</span>${svg("right")}</button>`
    + `<div class="reader__icons"><div class="reader__modes" role="group" aria-label="${escapeHtml(t("Reading mode"))}">${iconButton("single", "One page", ' aria-pressed="false"')}${iconButton("double", "Two pages", ' aria-pressed="false"')}${iconButton("vertical", "Cascade", ' aria-pressed="false"')}</div>`
    + `${iconButton("comfort", "Comfort", ' aria-expanded="false"')}${iconButton("direction", "Reading direction")}${iconButton("settings", "Reader settings", ' aria-expanded="false"')}</div></div></footer>`
    + `</section>`;
}

// options: { fileId, page, comic, api: { readerFile, saveProgress, pageUrl }, chapter, chapters (array or promise of
//   [{ chapter, volume, title, cover }]), source (name of what's open), sources() -> [{ readerId, name, lang, page }]
//   (this chapter elsewhere), onSource(readerId, page), onChapter(chapter), onClose(), onPage(fileId, page), onOpenFile(fileId) }
export async function openReader(host, { fileId, page = null, comic = {}, api, chapter = null, chapters = [], source = "", sources = null, onSource, onChapter, onClose, onPage, onOpenFile }) {
  const info = await api.readerFile(fileId);
  // Opened from its address alone: the server says which chapter and source this is.
  if (chapter === null || chapter === undefined) chapter = info.chapter ?? null;
  if (!source && info.source) source = info.source;
  const pages = Number(info.pages) || 0;
  let mode = normalizeMode(read(modeKey(info.workId), {}), defaultMode(comic, { wide: window.innerWidth >= 1280 && window.innerWidth > window.innerHeight * 1.3 }));
  let comfort = normalizeComfort(read(COMFORT_KEY, {}));
  let current = startPage(page, info.file?.progress, pages);
  let chapterList = Array.isArray(chapters) ? chapters : [];
  let saveTimer = 0;
  let wheelAt = 0;
  let zoom = 1;
  let closed = false;
  let bottomSince = 0;
  // Pages found to be wider than tall; two-page mode shows them alone.
  const wide = new Set();
  const pairing = () => ({ ...mode, wide });

  const root = document.createElement("div");
  root.className = "reader";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", t("Reader"));
  root.tabIndex = -1;
  root.innerHTML = markup(comic, pages);
  root.dataset.sidebar = read(SIDEBAR_KEY, window.innerWidth >= 1100) ? "open" : "closed";
  host.append(root);
  const stage = root.querySelector(".reader__stage");
  const count = root.querySelector(".reader__count");
  const slider = root.querySelector(".reader__slider");
  const thumbs = root.querySelector(".reader__thumbs");
  const matrix = root.querySelector("feColorMatrix");

  const url = (n) => api.pageUrl(fileId, n);
  // Sources that stamp a credit strip onto their page files (MangaFox): each page is
  // shown without it, cropped once in a canvas (pages come through LVL, same origin).
  const trim = info.trim === "credit-strip";
  const trimmed = new Map(); // page -> object URL of the cropped page
  const trimming = new Map(); // page -> Promise<object URL | null>
  const src = (n) => trimmed.get(n) || url(n);
  async function cropStrip(img) {
    const width = img.naturalWidth;
    const height = img.naturalHeight;
    const rows = Math.min(height, CREDIT_STRIP_ROWS);
    if (!width || rows < 40) return null;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = rows;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(img, 0, height - rows, width, rows, 0, 0, width, rows);
    const rgba = context.getImageData(0, 0, width, rows).data;
    const gray = new Uint8Array(width * rows);
    for (let i = 0, j = 0; j < gray.length; i += 4, j += 1) gray[j] = (rgba[i] * 299 + rgba[i + 1] * 587 + rgba[i + 2] * 114) / 1000;
    const cut = creditStripRows(gray, width, rows);
    if (!cut) return null;
    canvas.height = height - cut;
    context.drawImage(img, 0, 0);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.95));
    return blob ? URL.createObjectURL(blob) : null;
  }
  function trimPage(n, img) {
    if (!trim || closed || trimmed.has(n) || img.src.startsWith("blob:")) return;
    if (!trimming.has(n)) {
      trimming.set(n, cropStrip(img).catch(() => null).then((objectUrl) => {
        if (objectUrl && closed) { URL.revokeObjectURL(objectUrl); return null; }
        if (objectUrl) trimmed.set(n, objectUrl);
        return objectUrl;
      }));
    }
    void trimming.get(n).then((objectUrl) => {
      if (!objectUrl || closed) return;
      for (const page of stage.querySelectorAll(`.reader__page[data-page="${n}"]`)) if (!page.src.startsWith("blob:")) page.src = objectUrl;
      const thumb = thumbs.querySelector(`[data-reader-page="${n}"] img`);
      if (thumb) { thumb.dataset.src = objectUrl; if (thumb.getAttribute("src")) thumb.src = objectUrl; }
    });
  }
  const watchPage = (img) => { if (trim) img.addEventListener("load", () => trimPage(Number(img.dataset.page), img)); };
  const preload = (from) => {
    for (let n = from + 1; n <= from + 3 && n < pages; n += 1) {
      if (trimmed.has(n)) continue;
      const img = new Image();
      if (trim) img.addEventListener("load", () => trimPage(n, img), { once: true });
      img.src = url(n);
    }
  };
  thumbs.innerHTML = Array.from({ length: pages }, (_v, n) => `<button class="reader__thumb" type="button" role="listitem" data-reader-page="${n}" aria-label="${escapeHtml(t("Page {number}", { number: n + 1 }))}">`
    + `<img data-src="${escapeHtml(url(n))}" alt="" decoding="async" /><span>${n + 1}</span></button>`).join("");
  // Thumbnails are the pages themselves: load only the ones the strip shows,
  // and none while previews are off.
  let previews = read(PREVIEWS_KEY, true) !== false;
  const thumbObserver = "IntersectionObserver" in window ? new IntersectionObserver((entries) => {
    if (!previews) return;
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const img = entry.target.querySelector("img[data-src]");
      if (img) {
        img.addEventListener("load", () => noteSize(Number(entry.target.dataset.readerPage), img), { once: true });
        img.src = img.dataset.src;
        img.removeAttribute("data-src");
      }
      thumbObserver.unobserve(entry.target);
    }
  }, { root: thumbs, rootMargin: "0px 120px" }) : null;
  const watchThumbs = () => {
    for (const thumb of thumbs.children) {
      const img = thumb.querySelector("img[data-src]");
      if (!img) continue;
      if (thumbObserver) { thumbObserver.unobserve(thumb); thumbObserver.observe(thumb); } else if (previews) { img.src = img.dataset.src; img.removeAttribute("data-src"); }
    }
  };
  const applyPreviews = () => {
    root.dataset.previews = previews ? "on" : "off";
    const toggle = root.querySelector('button[data-reader="previews"]');
    toggle.setAttribute("aria-pressed", String(previews));
    toggle.querySelector("[data-previews-label]").textContent = t(previews ? "Hide pages" : "Show pages");
    if (previews) watchThumbs();
  };
  // The wheel scrolls the strip sideways.
  thumbs.addEventListener("wheel", (event) => {
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    event.preventDefault();
    event.stopPropagation();
    thumbs.scrollLeft += event.deltaY;
  }, { passive: false });


  function applyComfort() {
    const effective = comfort.night && isNight() ? { ...comfort, warm: Math.max(comfort.warm, 45) } : comfort;
    const filter = comfortFilter(effective);
    matrix.setAttribute("values", filter.matrix);
    root.style.filter = filter.active ? `url(#reader-warm) brightness(${filter.brightness})` : "";
    root.dataset.theme = comfort.theme;
    for (const input of root.querySelectorAll("[data-comfort]")) {
      if (input.type === "checkbox") input.checked = comfort[input.dataset.comfort];
      else input.value = String(comfort[input.dataset.comfort]);
    }
  }

  function saveSoon(immediate = false) {
    clearTimeout(saveTimer);
    const payload = { fileId, page: current, pages, finished: atEnd(current, pages, pairing()) };
    const send = () => api.saveProgress(payload).catch(() => {});
    if (immediate) return send();
    saveTimer = setTimeout(send, 800);
    return undefined;
  }

  // Local files go to the next file on disk; source chapters follow the chapter index.
  function chapterTargets() {
    if (/^f[0-9a-f]{16}$/.test(fileId) && (info.next || info.prev)) return { prev: info.prev ? { file: info.prev } : null, next: info.next ? { file: info.next } : null };
    const near = chapterNeighbours(chapterList, chapter);
    return { prev: near.prev ? { chapter: near.prev } : null, next: near.next ? { chapter: near.next } : null };
  }

  function paintChapters() {
    const list = root.querySelector(".reader__chapters");
    const entry = chapterList.find((item) => String(item.chapter) === String(chapter));
    root.querySelector(".reader__chapter-title").textContent = entry
      ? [t("Chapter {number}", { number: entry.chapter }), entry.title].filter(Boolean).join(" · ") : info.file?.name || "";
    const targets = chapterTargets();
    root.querySelector('[data-reader="prevChapter"]').disabled = !targets.prev;
    root.querySelector('[data-reader="nextChapter"]').disabled = !targets.next;
    if (!chapterList.length) { list.innerHTML = `<li class="reader__note">${escapeHtml(info.file?.name || t("No chapter list yet"))}</li>`; return; }
    list.innerHTML = chapterList.map((item) => `<li><button class="reader__ch" type="button" data-reader-chapter="${escapeHtml(item.chapter)}"${String(item.chapter) === String(chapter) ? ' aria-current="true"' : ""}>`
      + `<span class="reader__ch-number">${escapeHtml(item.chapter)}</span><span><strong>${escapeHtml(item.title || t("Chapter {number}", { number: item.chapter }))}</strong>`
      + `${item.volume ? `<span>${escapeHtml(t("Volume {number}", { number: item.volume }))}</span>` : ""}</span></button></li>`).join("");
    list.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "center" });
  }

  function render() {
    root.dataset.layout = mode.layout;
    root.dataset.direction = mode.direction;
    root.dataset.fit = mode.fit;
    root.querySelector('[data-reader="fit"]').value = mode.fit;
    root.querySelector('[data-reader="direction"]').value = mode.direction;
    const offset = root.querySelector('[data-reader="offset"]');
    offset.checked = mode.offset;
    offset.disabled = mode.layout !== "double";
    root.querySelector('button[data-reader="single"]').setAttribute("aria-pressed", String(mode.layout === "single"));
    root.querySelector('button[data-reader="vertical"]').setAttribute("aria-pressed", String(mode.layout === "vertical"));
    root.querySelector('button[data-reader="double"]').setAttribute("aria-pressed", String(mode.layout === "double"));
    zoom = 1;
    if (mode.layout === "vertical") {
      stage.innerHTML = Array.from({ length: pages }, (_v, n) => `<img class="reader__page" data-page="${n}" src="${escapeHtml(src(n))}" alt="${escapeHtml(t("Page {number}", { number: n + 1 }))}" loading="lazy" decoding="async" />`).join("");
      for (const img of stage.querySelectorAll(".reader__page")) watchPage(img);
      stage.querySelector(`[data-page="${current}"]`)?.scrollIntoView({ block: "start" });
    } else {
      const shown = mode.layout === "double" ? spreadOf(current, pages, pairing()) : [current];
      const ordered = mode.direction === "rtl" ? [...shown].reverse() : shown;
      stage.innerHTML = `<div class="reader__spread">${ordered.map((n) => `<img class="reader__page" data-page="${n}" src="${escapeHtml(src(n))}" alt="${escapeHtml(t("Page {number}", { number: n + 1 }))}" decoding="async" />`).join("")}</div>`;
      for (const img of stage.querySelectorAll(".reader__page")) { img.addEventListener("load", () => noteSize(Number(img.dataset.page), img), { once: true }); watchPage(img); }
      stage.scrollTop = 0;
      preload(Math.max(...shown));
    }
    updateCount();
  }

  // Wide pages (printed double-page spreads) stand alone in two-page mode.
  function noteSize(n, img) {
    if (closed || wide.has(n) || !(img.naturalWidth > img.naturalHeight * 1.1)) return;
    wide.add(n);
    if (mode.layout === "double" && spreadOf(current, pages, mode).includes(n)) render();
  }

  function updateCount() {
    const shown = mode.layout === "double" ? spreadOf(current, pages, pairing()) : [current];
    count.textContent = `${shown.map((n) => n + 1).join("–")} / ${pages}`;
    slider.value = String(current + 1);
    // Progress and previews read left to right in every mode; only pages turn right to left.
    for (const thumb of thumbs.querySelectorAll('[aria-current="true"]')) thumb.removeAttribute("aria-current");
    for (const n of shown) thumbs.children[n]?.setAttribute("aria-current", "true");
    const active = thumbs.children[shown[0]];
    if (active) thumbs.scrollLeft += active.getBoundingClientRect().left - thumbs.getBoundingClientRect().left - (thumbs.clientWidth - active.offsetWidth) / 2;
    onPage?.(fileId, current);
  }

  function showEnd() {
    const end = document.createElement("div");
    end.className = "reader__endcard";
    const next = chapterTargets().next;
    end.innerHTML = `<p>${escapeHtml(root.querySelector(".reader__chapter-title").textContent ? t("End of {name}", { name: root.querySelector(".reader__chapter-title").textContent }) : t("End"))}</p>`
      + (next ? `<button class="ui-btn ui-btn--primary" type="button" data-reader="nextChapter">${escapeHtml(t("Next chapter"))}</button>` : "")
      + `<button class="ui-btn ui-btn--secondary" type="button" data-reader="close">${escapeHtml(t("Back to series"))}</button>`;
    stage.querySelector(".reader__endcard")?.remove();
    stage.append(end);
  }

  function go(target) {
    const next = Math.max(0, Math.min(pages - 1, target));
    if (next === current) { if (atEnd(current, pages, pairing())) showEnd(); return; }
    current = next;
    render();
    saveSoon();
  }

  // Long strip: one image can be several screens tall (webtoons) and its neighbour can start
  // mid-scene, so Next/Previous move by a screen (a little overlap) instead of jumping to the
  // next image's top, which skipped whatever was between. The page count follows the scroll.
  function scrollStrip(direction) {
    const by = stripStep(stage, direction);
    if (by === "end") return showEnd();
    if (by) stage.scrollBy({ top: by, behavior: "smooth" });
    return undefined;
  }

  async function openTarget(target) {
    if (!target) return;
    saveSoon(true);
    if (target.file) { close({ keepUrl: true }); onOpenFile?.(target.file); return; }
    await onChapter?.(target.chapter);
  }

  function togglePop(selector, button) {
    for (const pop of root.querySelectorAll(".reader__pop")) if (!pop.matches(selector)) pop.hidden = true;
    const pop = root.querySelector(selector);
    pop.hidden = !pop.hidden;
    for (const name of ["more", "settings", "comfort"]) root.querySelector(`button[data-reader="${name}"]`)?.setAttribute("aria-expanded", "false");
    if (!pop.hidden) button?.setAttribute("aria-expanded", "true");
    if (!pop.hidden && selector === ".reader__menu") void loadSources();
  }

  // The same chapter on the other chosen sources (and files), asked for once.
  let sourcesLoaded = null;
  function loadSources() {
    if (!sources || sourcesLoaded) return sourcesLoaded;
    sourcesLoaded = Promise.resolve(sources()).then((list) => {
      const options = (list || []).filter((item) => item && item.readerId);
      if (closed || options.length < 2) return;
      const select = root.querySelector('[data-reader="source"]');
      select.innerHTML = options.map((item) => `<option value="${escapeHtml(item.readerId)}"${item.readerId === fileId ? " selected" : ""}>${escapeHtml([item.name, item.lang].filter(Boolean).join(" · "))}</option>`).join("");
      root.querySelector("[data-reader-source-row]").hidden = false;
    }).catch(() => {});
    return sourcesLoaded;
  }

  function setMode(patch) {
    mode = normalizeMode({ ...mode, ...patch }, mode);
    localStorage.setItem(modeKey(info.workId), JSON.stringify(mode));
    render();
  }

  const actions = {
    next: () => (mode.layout === "vertical" ? scrollStrip(1) : go(step(current, 1, pages, pairing()))),
    prev: () => (mode.layout === "vertical" ? scrollStrip(-1) : go(step(current, -1, pages, pairing()))),
    // Header arrows point at the side of the page they turn to.
    left: () => actions[mode.direction === "rtl" ? "next" : "prev"](),
    right: () => actions[mode.direction === "rtl" ? "prev" : "next"](),
    first: () => go(0),
    last: () => go(pages - 1),
    close: () => close(),
    fullscreen: () => (document.fullscreenElement ? document.exitFullscreen() : root.requestFullscreen?.())?.catch?.(() => {}),
    nextFile: () => openTarget(chapterTargets().next),
    prevFile: () => openTarget(chapterTargets().prev),
    nextChapter: () => openTarget(chapterTargets().next),
    prevChapter: () => openTarget(chapterTargets().prev),
    bars: () => root.classList.toggle("is-chrome-hidden"),
    sidebar: () => {
      root.dataset.sidebar = root.dataset.sidebar === "open" ? "closed" : "open";
      localStorage.setItem(SIDEBAR_KEY, JSON.stringify(root.dataset.sidebar === "open"));
      root.querySelector('button[data-reader="sidebar"]').setAttribute("aria-expanded", String(root.dataset.sidebar === "open"));
    },
    single: () => setMode({ layout: "single" }),
    vertical: () => setMode({ layout: "vertical" }),
    double: () => setMode({ layout: "double" }),
    previews: () => {
      previews = !previews;
      localStorage.setItem(PREVIEWS_KEY, JSON.stringify(previews));
      applyPreviews();
      if (previews) updateCount();
    },
    direction: () => setMode({ direction: mode.direction === "rtl" ? "ltr" : "rtl" }),
    more: (button) => togglePop(".reader__menu", button),
    settings: (button) => togglePop(".reader__menu", button),
    comfort: (button) => togglePop(".reader__comfort", button),
  };

  root.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-side-tab]");
    if (tab) {
      for (const item of root.querySelectorAll("[data-side-tab]")) item.setAttribute("aria-selected", String(item === tab));
      for (const panel of root.querySelectorAll("[data-side-panel]")) panel.hidden = panel.dataset.sidePanel !== tab.dataset.sideTab;
      return undefined;
    }
    const chapterButton = event.target.closest("[data-reader-chapter]");
    if (chapterButton) return String(chapterButton.dataset.readerChapter) === String(chapter) ? undefined : openTarget({ chapter: chapterButton.dataset.readerChapter });
    const thumb = event.target.closest("[data-reader-page]");
    if (thumb) return go(Number(thumb.dataset.readerPage));
    const control = event.target.closest("button[data-reader]");
    if (control) return actions[control.dataset.reader]?.(control);
    if (!event.target.closest(".reader__pop")) for (const pop of root.querySelectorAll(".reader__pop")) pop.hidden = true;
    if (!event.target.closest(".reader__stage")) return undefined;
    const box = stage.getBoundingClientRect();
    return actions[clickAction(event.clientX - box.left, box.width, mode)]?.();
  });
  root.addEventListener("change", (event) => {
    const name = event.target.dataset.reader;
    if (name === "source") return event.target.value !== fileId ? onSource?.(event.target.value, current) : undefined;
    if (name === "fit" || name === "direction") return setMode({ [name]: event.target.value });
    if (name === "offset") return setMode({ offset: event.target.checked });
    const key = event.target.dataset.comfort;
    if (key) {
      comfort = normalizeComfort({ ...comfort, [key]: event.target.type === "checkbox" ? event.target.checked : event.target.value });
      localStorage.setItem(COMFORT_KEY, JSON.stringify(comfort));
      applyComfort();
    }
    return undefined;
  });
  root.addEventListener("input", (event) => {
    if (event.target === slider) go(Number(slider.value) - 1);
    else if (event.target.dataset.comfort && event.target.type === "range") {
      comfort = normalizeComfort({ ...comfort, [event.target.dataset.comfort]: event.target.value });
      applyComfort();
    }
  });
  stage.addEventListener("wheel", (event) => {
    if (event.ctrlKey) {
      event.preventDefault();
      zoom = Math.max(1, Math.min(4, zoom * (event.deltaY < 0 ? 1.15 : 1 / 1.15)));
      stage.querySelector(".reader__spread")?.style.setProperty("--reader-zoom", String(zoom));
      return;
    }
    if (mode.layout === "vertical") {
      // Cascade: at the bottom of a chapter, scrolling on continues into the next one.
      const atBottom = stage.scrollHeight - stage.clientHeight - stage.scrollTop <= 2;
      if (!atBottom || event.deltaY <= 0) { bottomSince = 0; return; }
      if (!bottomSince) { bottomSince = Date.now(); return; }
      if (Date.now() - bottomSince > 450 && chapterTargets().next) { bottomSince = 0; void openTarget(chapterTargets().next); }
      return;
    }
    if (zoom > 1) return;
    // A page taller than the window scrolls first, then turns at its edge.
    const sideways = Math.abs(event.deltaX) > Math.abs(event.deltaY);
    const overflow = mode.fit !== "height" && stage.scrollHeight - stage.clientHeight > 2;
    if (overflow && !sideways) {
      const room = event.deltaY > 0 ? stage.scrollHeight - stage.clientHeight - stage.scrollTop : stage.scrollTop;
      if (room > 2) return;
    }
    event.preventDefault();
    if (Date.now() - wheelAt < 250) return;
    wheelAt = Date.now();
    const action = wheelAction(event, mode, { overflow });
    if (action) actions[action]();
  }, { passive: false });
  let touch = null;
  stage.addEventListener("touchstart", (event) => { touch = event.touches.length === 1 ? { x: event.touches[0].clientX, y: event.touches[0].clientY } : null; }, { passive: true });
  stage.addEventListener("touchend", (event) => {
    if (!touch || mode.layout === "vertical" || zoom > 1) return;
    const dx = event.changedTouches[0].clientX - touch.x;
    const dy = event.changedTouches[0].clientY - touch.y;
    touch = null;
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy)) return;
    actions[dx < 0 ? "right" : "left"]();
  });
  stage.addEventListener("scroll", () => {
    if (mode.layout !== "vertical") return;
    const top = stage.getBoundingClientRect().top;
    const visible = [...stage.querySelectorAll(".reader__page")].find((img) => img.getBoundingClientRect().bottom > top + 40);
    const n = Number(visible?.dataset.page);
    if (Number.isInteger(n) && n !== current) { current = n; updateCount(); saveSoon(); if (n >= pages - 1) showEnd(); }
  }, { passive: true });

  function close({ keepUrl = false } = {}) {
    if (closed) return;
    closed = true;
    thumbObserver?.disconnect();
    for (const objectUrl of trimmed.values()) URL.revokeObjectURL(objectUrl);
    trimmed.clear();
    saveSoon(true);
    if (document.fullscreenElement === root) document.exitFullscreen().catch(() => {});
    root.remove();
    if (!keepUrl) onClose?.();
  }

  applyComfort();
  applyPreviews();
  render();
  paintChapters();
  if (source) {
    const from = root.querySelector("[data-reader-from]");
    from.textContent = `${t("Read from")}: ${source}`;
    from.hidden = false;
  }
  if (!Array.isArray(chapters)) Promise.resolve(chapters).then((list) => { if (!closed && Array.isArray(list)) { chapterList = list; paintChapters(); } }).catch(() => {});
  root.focus();
  saveSoon();
  return {
    close,
    handleKey(event) {
      if (event.target?.closest?.(".reader__pop, .reader__select")) return false;
      const open = [...root.querySelectorAll(".reader__pop")].find((pop) => !pop.hidden);
      if (open && event.key === "Escape") { event.preventDefault(); open.hidden = true; return true; }
      const action = keyAction(event, mode);
      if (!action) return false;
      event.preventDefault();
      actions[action]();
      return true;
    },
  };
}
