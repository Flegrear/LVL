// Sources. Like Mihon: the user adds sources from the
// extension repositories in Settings › Comics; a comic's Sources tab searches
// each favorite for that comic and the user picks the right entry. Torrent
// indexers find packs to download.
import { buttonMarkup, emptyMarkup, escapeHtml, icon, iconButtonMarkup, toast } from "../ui/ui.js";
import { t } from "../ui/ui-i18n.js";
import { comicsApi } from "./comics-api.js";
import { filterSources, readSourceChoice, reconcileFavoriteSource, selectFavoriteSource, sourceChoice, sourceChoices, watchFavoriteSource } from "./comics-source-filter.js";
import { WORK_ID } from "../../shared/reading/ids.js";

const size = (bytes) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`);
const LANGUAGE_NAMES = { en: "English", es: "Español", "es-419": "Español (Latinoamérica)", ja: "日本語", ko: "한국어", zh: "中文", "pt-BR": "Português (Brasil)", pt: "Português", fr: "Français", de: "Deutsch", it: "Italiano", id: "Bahasa Indonesia", ru: "Русский", tr: "Türkçe", vi: "Tiếng Việt", ar: "العربية", th: "ไทย", pl: "Polski", all: "Multiple languages" };
// A language as its speakers write it: LVL's table, then the browser's own name for it
// ("fi" -> "Suomi"), else the code. "all" and "other" are keiyoushi's own codes.
const ownName = (code) => {
  try {
    const name = new Intl.DisplayNames([code], { type: "language" }).of(code);
    return name && name !== code ? name.charAt(0).toLocaleUpperCase(code) + name.slice(1) : "";
  } catch { return ""; }
};
const languageName = (code) => (code === "all" ? t("Multiple languages") : code === "other" ? t("Other") : LANGUAGE_NAMES[code] || ownName(code) || code);

// Search order (B7): app language, then English, then the original language.
export function sourceLanguages(prefs = {}, comic = {}) {
  const app = String(prefs.interfaceLanguage && prefs.interfaceLanguage !== "auto" ? prefs.interfaceLanguage : prefs.baseLanguage || "en").toLowerCase().slice(0, 2);
  const original = ({ JP: "ja", KR: "ko", CN: "zh", TW: "zh" })[comic.country] || "";
  return [...new Set([app, "en", original].filter(Boolean))];
}

// Favorites in the reading order: app language first, then English, then the rest.
export function orderFavorites(favorites, langs) {
  const rank = (lang) => { const at = langs.indexOf(String(lang).slice(0, 2).toLowerCase()); return at === -1 ? langs.length : at; };
  return [...favorites].sort((a, b) => rank(a.lang) - rank(b.lang) || a.name.localeCompare(b.name));
}

// Source IDs are stable across translated names and duplicate language entries.
// Even two providers with the same visible name/language/host are distinguishable
// by their exact ID; labels never become selection keys.
export function favoriteSourceLabels(favorites = []) {
  const options = sourceChoices(favorites);
  const descriptions = options.map((source) => [source.name, languageName(source.lang), source.host].filter(Boolean).join(" · "));
  const totals = new Map();
  for (const description of descriptions) totals.set(description, (totals.get(description) || 0) + 1);
  return new Map(options.map((source, index) => [String(source.id),
    descriptions[index] + (totals.get(descriptions[index]) > 1 ? ` · #${source.id}` : "")]));
}

export function sourceFilterMarkup(favorites = [], selected = "") {
  const options = sourceChoices(favorites);
  if (!options.length) return "";
  const choice = sourceChoice(selected, options);
  const labels = favoriteSourceLabels(options);
  const selectedLabel = labels.get(choice) || t("All sources");
  const radio = (id, label) => `<button type="button" role="radio" data-comics-source-choice="${escapeHtml(id)}" aria-checked="${id === choice}"><span>${escapeHtml(label)}</span><span class="comic-source-filter__radio" aria-hidden="true"></span></button>`;
  return `<details class="comic-source-filter" data-comics-source-filter><summary aria-label="${escapeHtml(t("Filter by source"))}"><span>${escapeHtml(t("Source"))}</span><strong>${escapeHtml(selectedLabel)}</strong>${icon("chevron-down")}</summary>`
    + `<div class="comic-source-filter__menu" role="radiogroup" aria-label="${escapeHtml(t("Filter by source"))}">`
    + radio("", t("All sources"))
    + options.map((source) => radio(String(source.id), labels.get(String(source.id)))).join("")
    + `</div></details>`;
}

export function sourceOptionsMarkup(sources = [], selected = "") {
  const choice = sourceChoice(selected, sources);
  const labels = favoriteSourceLabels(sources);
  return `<option value="">${escapeHtml(t("All sources"))}</option>`
    + sourceChoices(sources).map((source) => `<option value="${escapeHtml(source.id)}"${choice === String(source.id) ? " selected" : ""}>${escapeHtml(labels.get(String(source.id)))}</option>`).join("");
}

const torrentsMarkup = (items, workId) => `<ol class="comic-source__torrents">${items.map((item) => `<li><span class="comic-source__name">${escapeHtml(item.name)}</span>`
  + `<span class="comic-source__meta">${escapeHtml([size(item.size), t("{count} seeders", { count: item.seeders })].join(" · "))}</span>`
  + buttonMarkup({ label: "Download", size: "sm", attrs: { "data-comics-download": item.magnet, "data-name": item.name, "data-work": workId } }) + "</li>").join("")}</ol>`;

export function downloadsMarkup(downloads = []) {
  if (!downloads.length) return "";
  return `<ul class="comic-downloads">${downloads.map((item) => `<li><span class="comic-source__name">${escapeHtml(item.name)}</span>`
    + `<span class="comic-source__meta">${escapeHtml(item.state === "downloading" ? `${item.progress}% · ${t("{count} peers", { count: item.peers })}` : item.state === "failed" ? item.error || t("Failed") : t(({ metadata: "Starting", done: "Done", cancelled: "Cancelled" })[item.state] || item.state))}</span>`
    + (["metadata", "downloading"].includes(item.state) ? buttonMarkup({ label: "Cancel", size: "sm", attrs: { "data-comics-cancel": item.id } }) : "") + "</li>").join("")}</ul>`;
}

// One result card: cover, title, and its chapter count once known; clicking it opens the entry's details, where it can be added.
export function resultMarkup(source, item, { count } = {}) {
  const countText = count === undefined ? "" : count === null ? "…" : count.status === "ok" ? t("{count} chapters", { count: count.chapters }) : "";
  return `<li class="comic-hit${item.linked ? " is-linked" : ""}"><button class="comic-hit__open" type="button" data-hit-open="${escapeHtml(item.path)}" aria-haspopup="dialog" aria-label="${escapeHtml(t("Details of {title}", { title: item.title }))}">`
    + `<span class="comic-hit__cover">${item.cover ? `<img src="${escapeHtml(item.cover)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" />` : ""}`
    + (item.linked ? `<span class="comic-hit__badge">${escapeHtml(t("In use"))}</span>` : "") + "</span>"
    + `<span class="comic-hit__title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</span>`
    + (countText ? `<span class="comic-hit__count" data-hit-count>${escapeHtml(countText)}</span>` : "") + "</button></li>";
}

// One entry's details in a popup: language, how many chapters and which, the
// newest, how much of the index it covers, groups; Add (or Remove) and Open on the site.
export function hitDetailsMarkup(source, item, preview, indexNumbers) {
  const head = `<div class="comic-hit-details__head">${item.cover ? `<img src="${escapeHtml(item.cover)}" alt="" referrerpolicy="no-referrer" />` : ""}<div>`
    + `<h2 class="app-dialog__title comic-hit-details__title" id="comic-hit-dialog-title">${escapeHtml(item.title)}</h2>`
    + `<span class="comic-source__meta">${escapeHtml([source.name, languageName(source.lang)].filter(Boolean).join(" · "))}</span></div></div>`;
  const link = JSON.stringify({ kind: "ext", sourceId: source.id, mangaId: item.path, name: source.name, title: item.title, lang: source.lang });
  const add = item.linked ? buttonMarkup({ label: "Remove", attrs: { "data-comics-unlink": `ext:${source.id}:${item.path}` } })
    : buttonMarkup({ label: "Add", variant: "primary", icon: "plus", attrs: { "data-comics-link": link } });
  const site = (url) => (/^https?:\/\//.test(url || "") ? `<a class="ui-btn ui-btn--ghost" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"><span>${escapeHtml(t("Open on the site"))}</span></a>` : "");
  if (!preview) return `${head}<div class="ui-skeleton comic-hit-details__loading"></div><div class="app-dialog__actions">${add}</div>`;
  if (preview.status !== "ok") return `${head}<p class="comic-source__error">${escapeHtml(t(preview.error || "The site didn't answer."))}</p><div class="app-dialog__actions">${add}</div>`;
  const when = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toLocaleDateString(globalThis.document?.documentElement?.lang || undefined, { year: "numeric", month: "short", day: "numeric" }) : "");
  const covered = indexNumbers.size ? preview.numbers.filter((number) => indexNumbers.has(number)).length : 0;
  const rows = [
    ["Language", languageName(source.lang)],
    ["Chapters", preview.chapters ? `${preview.chapters}${preview.first && preview.last && preview.first !== preview.last ? ` (${t("Chapter {number}", { number: preview.first })}–${preview.last})` : ""}` : t("None yet")],
    ["Volumes", preview.volumes ? String(preview.volumes) : ""],
    ["In the chapter list", indexNumbers.size ? t("{covered} of {total}", { covered, total: indexNumbers.size }) : ""],
    ["Newest", preview.latest ? [preview.latest.name, when(preview.latest.date)].filter(Boolean).join(" · ") : ""],
    ["Since", when(preview.oldestDate)],
    ["Groups", (preview.groups || []).join(", ")],
  ].filter(([, value]) => value);
  return head + `<dl class="title-facts comic-hit-details__facts">${rows.map(([label, value]) => `<div><dt>${escapeHtml(t(label))}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>`
    + `<div class="app-dialog__actions">${site(preview.siteUrl)}${add}</div>`;
}

export function sourceResultMarkup(source, result, counts = new Map()) {
  const head = `<h3 class="comic-ext__name">${escapeHtml(source.name)} <span class="comic-source__meta">${escapeHtml([languageName(source.lang), source.host].filter(Boolean).join(" · "))}</span></h3>`;
  if (!result) return `<section class="comic-ext" data-ext-source="${escapeHtml(source.id)}">${head}<div class="ui-skeleton comic-ext__loading" role="status" aria-label="${escapeHtml(t("Loading source results"))}"></div></section>`;
  const body = result.status === "unsupported" ? `<p class="comic-source__meta">${escapeHtml(t("LVL can't read this source yet."))}</p>`
    : result.status === "blocked" ? `<p class="comic-source__meta">${escapeHtml(t(result.checkOpen ? "A window is open for the site's check. LVL searches again when it's done." : "This site asks for a browser check before LVL can read it."))}</p>`
      + `<div class="comic-ext__actions">${result.checkOpen ? "" : buttonMarkup({ label: "Verify", variant: "primary", size: "sm", attrs: { "data-ext-check": source.id } })}${buttonMarkup({ label: "Search again", size: "sm", attrs: { "data-ext-retry": source.id } })}</div>`
      : result.status === "error" ? `<p class="comic-source__error" role="alert">${escapeHtml(result.error ? t(result.error) : t("The site didn't answer."))}</p>`
        + `<div class="comic-ext__actions">${buttonMarkup({ label: "Search again", size: "sm", attrs: { "data-ext-retry": source.id } })}</div>`
        : !result.items.length ? `<p class="comic-source__meta">${escapeHtml(t("Not found on this source"))}</p>`
          : `<ol class="comic-hits" tabindex="0" aria-label="${escapeHtml(t("{source} results", { source: source.name }))}">${result.items.map((item) => resultMarkup(source, item, { count: counts.has(`${source.id}\n${item.path}`) ? counts.get(`${source.id}\n${item.path}`) : undefined })).join("")}</ol>`;
  return `<section class="comic-ext" data-ext-source="${escapeHtml(source.id)}">${head}${body}</section>`;
}

const chosenMarkup = (linked) => (linked.length
  ? `<ol class="comic-source__torrents">${linked.map((link) => `<li><span class="comic-source__name">${escapeHtml(link.name)}</span><span class="comic-source__meta">${escapeHtml([link.title, languageName(link.lang)].filter(Boolean).join(" · "))}</span>`
    + buttonMarkup({ label: "Remove", size: "sm", attrs: { "data-comics-unlink": link.key } }) + "</li>").join("")}</ol>`
  : "");

// A POST /linked can finish on a different work when a draft is reused.
// Only navigate after the server confirms the exact string64 source and path.
export async function finishSourceAdd({ response, choice, workId, onLinked, onDifferentWork }) {
  const target = String(response?.workId || "");
  const key = ["ext", String(choice?.sourceId), String(choice?.mangaId)].join(":");
  if (!WORK_ID.test(target) || !Array.isArray(response?.linked) ||
    !response.linked.some((item) => item.key === key && item.kind === "ext" &&
      item.sourceId === String(choice.sourceId) && item.mangaId === String(choice.mangaId))) {
    throw new Error("The source was not confirmed for this comic. Try again.");
  }
  if (target !== workId) {
    if (typeof onDifferentWork !== "function") throw new Error("The linked comic changed. Open its title to see chapters.");
    await onDifferentWork(target);
    return { target, changedWork: true };
  }
  await onLinked?.(response);
  return { target, changedWork: false };
}

// Verify: a popup that follows the site's check window. LVL closes the window once
// the site shows its own page; then searchAgain(source) runs.
async function verifyFlow(source, searchAgain) {
  if (!source) return;
  for (const old of document.querySelectorAll(".comic-verify-dialog")) old.remove();
  const box = document.createElement("dialog");
  box.className = "detail-dialog app-dialog comic-verify-dialog";
  box.setAttribute("aria-labelledby", "comic-verify-title");
  const paintBox = (text, { done = false } = {}) => {
    box.innerHTML = `<button class="dialog-close" type="button" data-verify-close aria-label="${escapeHtml(t("Close"))}">×</button><div class="app-dialog__body">`
      + `<h2 class="app-dialog__title" id="comic-verify-title">${escapeHtml(t("Verify {source}", { source: source.name }))}</h2>`
      + `<p class="settings-hint">${escapeHtml(text)}</p>`
      + (done ? "" : `<div class="ui-skeleton comic-verify__wait"></div>`) + "</div>";
  };
  paintBox(t("A window opened with the site. Pass its check there (for example, tick the box). LVL closes the window by itself when it's done."));
  document.body.append(box);
  let cancelled = false;
  box.addEventListener("click", (event) => { if (event.target === box || event.target.closest("[data-verify-close]")) { cancelled = true; box.close(); } });
  box.addEventListener("close", () => { cancelled = true; box.remove(); });
  box.showModal();
  const started = Date.now();
  let state = { open: true };
  while (!cancelled && Date.now() - started < 10 * 60_000) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    state = await comicsApi.verifyState().catch(() => state);
    if (!state.open) break;
    if (state.passed) paintBox(t("Check passed. Closing the window…"));
  }
  if (!state.open) {
    const passed = Boolean(state.passed);
    if (cancelled) return;
    paintBox(t("Checking whether {source} can be read now…", { source: source.name }), { done: true });
    const result = await searchAgain(source).catch((error) => ({ status: "error", error: error.message }));
    if (cancelled || !box.open) return;
    if (result?.status === "ok") {
      // The successful source request proves that its session works; pressing
      // Done, or the native screen merely loading a non-challenge title, does not.
      paintBox(t("{source} is verified and its chapters can be searched.", { source: source.name }), { done: true });
      setTimeout(() => box.open && box.close(), 1100);
    } else {
      paintBox(result?.status === "blocked" || !passed
        ? t("The site is still asking for verification. Finish the check in its window, then try Verify again.")
        : t("The check was completed, but the site rejected the next request. Try verification again."), { done: true });
    }
  }
}

// Sources tab: in use for this comic; the favorites searched for it; packs.
export async function comicSourcesSection(holder, data, ctx) {
  const { comic, id } = data;
  const section = document.createElement("section");
  section.className = "comic-sources";
  section.innerHTML = `<div class="ui-skeleton comic-ext__loading" role="status" aria-label="${escapeHtml(t("Loading source results"))}"></div>`;
  holder.append(section);
  const langs = sourceLanguages(ctx.preferences?.() || {}, comic);
  let linked = [];
  let favorites = [];
  let favoritesError = "";
  let selectedSource = readSourceChoice();
  let favoriteRevision = 0;
  let initialized = false;
  let poll = 0;
  const localListeners = new AbortController();
  const results = new Map();
  const revisions = new Map();
  const loadLinked = async () => { linked = (await comicsApi.linked(id).catch(() => ({ linked: [] }))).linked || []; };
  const paintFavorites = () => {
    const holderEl = section.querySelector(".comic-sources__favorites");
    if (!holderEl) return;
    const visible = filterSources(favorites, selectedSource);
    holderEl.innerHTML = favoritesError
      ? `<p class="comic-source__error" role="alert">${escapeHtml(favoritesError)}</p>${buttonMarkup({ label: "Try again", size: "sm", attrs: { "data-comics-favorites-retry": "" } })}`
      : visible.length ? visible.map((source) => sourceResultMarkup(source, results.get(source.id), counts)).join("")
      : emptyMarkup({ icon: "plus", title: "No favorite sources yet", text: "Add sources in Settings › Comics. Their results for this comic appear here.", compact: true,
        action: buttonMarkup({ label: "Choose sources", attrs: { "data-comics-open-settings": "" } }) });
  };
  const paint = () => {
    if (!favoritesError) selectedSource = sourceChoice(selectedSource, favorites);
    const current = favorites.find((source) => String(source.id) === selectedSource);
    const selectedLabel = current ? favoriteSourceLabels(favorites).get(selectedSource) : "";
    section.innerHTML = (linked.length ? `<div class="title-section__head"><h2 class="title-section__title">${escapeHtml(t("In use"))}</h2></div>${chosenMarkup(linked)}` : "")
      + `<div class="title-section__head"><h2 class="title-section__title">${escapeHtml(t("Favorite sources"))}</h2>`
      + (favorites.length ? iconButtonMarkup({ icon: "refresh", label: "Search again", size: "sm", attrs: { "data-comics-research": "" } }) : "") + "</div>"
      // Source choice is in Home › Comics filters and Settings › Browse
      // sources. This title uses that same source ID, not a third standalone
      // picker. Clearing here remains available without losing saved reading
      // source/chapter provenance.
      + (current ? `<div class="comic-sources__selected" role="status"><span>${escapeHtml(t("Showing source"))}: <strong>${escapeHtml(selectedLabel)}</strong></span>${buttonMarkup({ label: "All sources", size: "sm", variant: "ghost", attrs: { "data-comics-source-clear": "" } })}</div>` : "")
      + `<div class="comic-sources__favorites" aria-live="polite"></div>`
      + `<div class="title-section__head"><h2 class="title-section__title">${escapeHtml(t("Packs to download"))}</h2>${buttonMarkup({ label: "Search packs", icon: "search", size: "sm", attrs: { "data-comics-find": "" } })}</div>`
      + `<div class="comic-sources__results" aria-live="polite"></div><div class="comic-sources__downloads"></div>`;
    paintFavorites();
  };
  // Each favorite is searched on its own, so fast sites show up first.
  // Entry details (chapter counts on the cards, the popup) are kept while the tab lives.
  const previews = new Map();
  const counts = new Map(); // "sourceId\npath" -> null (loading) or the preview
  const COUNTED = 4;
  const sourceCard = (source) => Object.assign(document.createElement("div"), { innerHTML: sourceResultMarkup(source, results.get(source.id) || null, counts) }).firstElementChild;
  const repaintSource = (source) => {
    if (!section.isConnected) return;
    const old = section.querySelector(`[data-ext-source="${CSS.escape(source.id)}"]`);
    if (!old) return;
    const oldRow = old.querySelector(".comic-hits");
    const scroll = oldRow?.scrollLeft || 0;
    const focused = oldRow?.contains(document.activeElement) ? document.activeElement?.dataset.hitOpen : null;
    const next = sourceCard(source);
    old.replaceWith(next);
    const row = next.querySelector(".comic-hits");
    if (row) row.scrollLeft = scroll;
    if (focused !== null) {
      const target = [...(next.querySelectorAll("[data-hit-open]") || [])].find((item) => item.dataset.hitOpen === focused);
      target?.focus({ preventScroll: true });
    }
  };
  // Verify a protected site, then search it again.
  // Always ask the site again after verification. A cached search hit could
  // otherwise claim success for hours while Cloudflare still rejects requests.
  const verifyAndSearch = (source) => verifyFlow(source, (item) => searchOne(item, { fresh: true }));
  async function loadCounts(source, result) {
    if (!sourceLifecycle.isActive() || result?.status !== "ok") return;
    const items = result.items.slice(0, COUNTED);
    for (const item of items) { const key = `${source.id}\n${item.path}`; if (!counts.has(key)) counts.set(key, previews.get(key) || null); }
    repaintSource(source);
    for (const item of items) {
      const key = `${source.id}\n${item.path}`;
      if (counts.get(key)) continue;
      const preview = await comicsApi.extPreview(id, source.id, item.path).catch((error) => ({ status: "error", error: error.message }));
      if (!sourceLifecycle.isActive() || results.get(source.id) !== result) return; // searched again meanwhile
      counts.set(key, preview);
      if (preview.status === "ok") previews.set(key, preview);
      repaintSource(source);
    }
  }
  const searchOne = async (source, { fresh = false } = {}) => {
    if (!sourceLifecycle.isActive()) return null;
    const revision = (revisions.get(source.id) || 0) + 1;
    revisions.set(source.id, revision);
    results.delete(source.id);
    repaintSource(source);
    const result = await comicsApi.extSearch(id, source.id, { fresh }).catch((error) => ({ status: "error", error: error.message, items: [] }));
    if (!sourceLifecycle.isActive() || revisions.get(source.id) !== revision) return null;
    results.set(source.id, result);
    repaintSource(source);
    void loadCounts(source, result);
    return result;
  };
  const searchFavorites = async () => {
    if (!sourceLifecycle.isActive()) return;
    for (const source of filterSources(favorites, selectedSource)) results.delete(source.id);
    paintFavorites();
    await Promise.all(filterSources(favorites, selectedSource).map(searchOne));
  };
  async function refreshFavoriteList() {
    const revision = favoriteRevision;
    try {
      const fresh = orderFavorites((await comicsApi.favorites()).favorites || [], langs);
      if (!sourceLifecycle.isActive() || revision !== favoriteRevision) return;
      favorites = fresh;
      favoritesError = "";
    } catch (error) {
      if (!sourceLifecycle.isActive() || revision !== favoriteRevision) return;
      favoritesError = String(error.message || t("Couldn't load sources."));
    }
  }
  const onSourceChanged = (event) => {
    if (Array.isArray(event.detail?.favorites)) {
      ++favoriteRevision;
      favorites = orderFavorites(sourceChoices(event.detail.favorites), langs);
      favoritesError = "";
    }
    selectedSource = sourceChoice(event.detail?.sourceId, favorites);
    if (!initialized) return;
    paint();
    void Promise.all(filterSources(favorites, selectedSource).filter((source) => !results.has(source.id)).map(searchOne));
  };
  const sourceLifecycle = watchFavoriteSource(section, onSourceChanged, () => {
    localListeners.abort();
    clearInterval(poll);
    poll = 0;
  });
  await loadLinked();
  if (!sourceLifecycle.isActive()) return;
  await refreshFavoriteList();
  if (!sourceLifecycle.isActive()) return;
  if (!favoritesError) selectedSource = reconcileFavoriteSource(favorites);
  initialized = true;
  paint();
  if (!favoritesError) void searchFavorites();
  // Entry details open in a popup.
  const indexNumbers = new Set((data.index?.volumes || []).flatMap((group) => (group.chapters || []).map((item) => item.chapter)).filter(Boolean));
  let dialog = null;
  let shown = null; // { source, item, key }
  const dialogBody = () => dialog.querySelector(".app-dialog__body");
  const paintDialog = () => { if (dialog && shown) dialogBody().innerHTML = hitDetailsMarkup(shown.source, shown.item, previews.get(shown.key), indexNumbers); };
  function ensureDialog() {
    if (dialog?.isConnected) return dialog;
    for (const old of document.querySelectorAll(".comic-hit-dialog")) old.remove();
    dialog = document.createElement("dialog");
    dialog.className = "detail-dialog app-dialog comic-hit-dialog";
    dialog.setAttribute("aria-labelledby", "comic-hit-dialog-title");
    dialog.innerHTML = `<button class="dialog-close" type="button" data-hit-close aria-label="${escapeHtml(t("Close"))}">×</button><div class="app-dialog__body"></div>`;
    document.body.append(dialog);
    // A click on the backdrop (outside the box) closes it, like the app's other popups.
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog || event.target.closest("[data-hit-close]")) { dialog.close(); return; }
      void handleClick(event);
    });
    dialog.addEventListener("close", () => { shown = null; });
    return dialog;
  }
  async function openHit(button) {
    const sectionEl = button.closest("[data-ext-source]");
    const source = favorites.find((item) => item.id === sectionEl?.dataset.extSource);
    const item = results.get(source?.id)?.items.find((entry) => entry.path === button.dataset.hitOpen);
    if (!source || !item) return;
    const key = `${source.id}\n${item.path}`;
    shown = { source, item, key };
    ensureDialog();
    paintDialog();
    if (!dialog.open) dialog.showModal();
    if (!previews.has(key)) {
      const preview = await comicsApi.extPreview(id, source.id, item.path).catch((error) => ({ status: "error", error: error.message }));
      if (preview.status === "ok") previews.set(key, preview);
      if (shown?.key === key) dialogBody().innerHTML = hitDetailsMarkup(source, item, preview, indexNumbers);
    }
  }
  // After Add or Remove, the popup and the cards show the new state.
  const markLinked = () => {
    const keys = new Set(linked.map((link) => link.key));
    for (const [sourceId, result] of results) for (const item of result.items || []) item.linked = keys.has(`ext:${sourceId}:${item.path}`);
    paint();
    paintDialog();
  };
  const refreshDownloads = async () => {
    if (!section.isConnected) return clearInterval(poll);
    const { downloads } = await comicsApi.downloads().catch(() => ({ downloads: [] }));
    if (!sourceLifecycle.isActive()) return;
    const mine = downloads.filter((item) => item.workId === id);
    const holderEl = section.querySelector(".comic-sources__downloads");
    if (holderEl) holderEl.innerHTML = downloadsMarkup(mine);
    if (!mine.some((item) => ["metadata", "downloading"].includes(item.state))) { clearInterval(poll); poll = 0; }
    return undefined;
  };
  const startPolling = () => { if (!poll) poll = setInterval(refreshDownloads, 2000); };
  void refreshDownloads();
  const searchPacks = async () => {
    const resultsEl = section.querySelector(".comic-sources__results");
    resultsEl.innerHTML = `<div class="ui-skeleton comic-volumes__loading"></div>`;
    const payload = await comicsApi.workSources(id, langs);
    if (!sourceLifecycle.isActive()) return;
    resultsEl.innerHTML = payload.sources.map((source) => {
      const body = source.status === "error" ? `<p class="comic-source__error">${escapeHtml(source.error)}</p>`
        : !source.items.length ? `<p class="comic-source__meta">${escapeHtml(t("No packs found"))}</p>` : torrentsMarkup(source.items, id);
      return `<section class="comic-source"><h3>${escapeHtml(source.name)}</h3>${body}</section>`;
    }).join("") || `<p class="comic-source__meta">${escapeHtml(t("No torrent sources are on."))}</p>`;
  };
  async function handleClick(event) {
    const button = event.target.closest("button");
    if (!button) return;
    try {
      if (button.matches("[data-comics-favorites-retry]")) {
        button.disabled = true;
        await refreshFavoriteList();
        if (!favoritesError) selectedSource = reconcileFavoriteSource(favorites);
        paint();
        if (!favoritesError) void searchFavorites();
        return;
      }
      if (button.matches("[data-comics-find]")) { button.disabled = true; await searchPacks(); button.disabled = false; return; }
      if (button.matches("[data-comics-research]")) { await searchFavorites(); return; }
      if (button.matches("[data-comics-source-clear]")) {
        selectedSource = selectFavoriteSource("", favorites);
        return;
      }
      if (button.dataset.extRetry) { const source = favorites.find((item) => item.id === button.dataset.extRetry); if (source) await searchOne(source); return; }
      if (button.dataset.hitOpen !== undefined) { await openHit(button); return; }
      if (button.dataset.extCheck) {
        button.disabled = true;
        const source = favorites.find((item) => item.id === button.dataset.extCheck);
        await comicsApi.openSourceCheck(button.dataset.extCheck);
        await verifyAndSearch(source);
        button.disabled = false;
        return;
      }
      if (button.dataset.comicsLink) {
        button.disabled = true;
        dialogBody()?.querySelector(".comic-hit-details__error")?.remove();
        const choice = JSON.parse(button.dataset.comicsLink);
        // The cover goes with it: a comic made from this entry shows it in the Library.
        const hit = results.get(choice.sourceId)?.items.find((item) => item.path === choice.mangaId);
        const result = await comicsApi.link(id, { ...choice, cover: hit?.cover || "" });
        const route = await finishSourceAdd({
          response: result, choice, workId: id,
          onLinked: async () => {
            linked = result.linked;
            markLinked();
            if (dialog?.open) dialog.close();
            await data.onLinked?.(result);
          },
          onDifferentWork: async (target) => {
            if (!data.onDifferentWork) throw new Error("The linked comic changed. Open its title to see chapters.");
            await data.onDifferentWork(target, result);
            if (dialog?.open) dialog.close();
          },
        });
        if (!route.changedWork) toast(t("{source} added. Its chapters open from the list.", { source: choice.name }));
        return;
      }
      if (button.dataset.comicsUnlink) {
        button.disabled = true;
        linked = (await comicsApi.unlink(id, button.dataset.comicsUnlink)).linked;
        markLinked();
        data.refreshChapters?.();
        return;
      }
      if (button.matches("[data-comics-open-settings]")) {
        ctx.switchView("settings");
        return void setTimeout(() => document.querySelector("#settings-tab-comics")?.click(), 50);
      }
      if (button.dataset.comicsDownload) {
        button.disabled = true;
        await comicsApi.download({ magnet: button.dataset.comicsDownload, name: button.dataset.name, workId: id });
        toast(t("Downloading into your comics folder"));
        await refreshDownloads();
        startPolling();
        return;
      }
      if (button.dataset.comicsCancel) { await comicsApi.cancelDownload(button.dataset.comicsCancel); await refreshDownloads(); }
    } catch (error) {
      if (button.dataset.comicsLink && dialog?.open) {
        const warning = document.createElement("p");
        warning.className = "comic-source__error comic-hit-details__error";
        warning.setAttribute("role", "alert");
        warning.textContent = String(error?.message || t("Couldn't add this source."));
        dialogBody()?.append(warning);
      }
      toast(error.message);
      button.disabled = false;
    }
  }
  section.addEventListener("click", (event) => { void handleClick(event); }, { signal: localListeners.signal });
}

// ---- Settings › Comics (cards, fields and switches like core Settings)
const KIND_LABELS = { piratebay: "Torrent search (comics)", torznab: "Torznab indexer", "mihon-repo": "Extension repository" };
const rowText = (title, facts, { mono = false } = {}) => `<span class="comics-row__text"><strong${mono ? ' class="comics-row__mono"' : ""}>${escapeHtml(title)}</strong>`
  + (facts ? `<small>${escapeHtml(facts)}</small>` : "") + "</span>";
export const cardMarkup = ({ title, badge = "", action = "", hint = "", body = "", attrs = "" }) => `<section class="settings-card comics-card"${attrs}>`
  + `<div class="settings-card__head"><h2>${escapeHtml(title)}</h2>${badge ? `<span class="ui-badge ui-badge--outline">${escapeHtml(badge)}</span>` : ""}${action}</div>`
  + (hint ? `<p class="settings-hint">${escapeHtml(hint)}</p>` : "") + body + "</section>";

function sourceRow(source) {
  const detail = source.kind === "torznab" ? `${source.config.url}${source.config.apiKey ? ` · ${t("API key set")}` : ""}`
    : source.kind === "mihon-repo" ? source.config.url : t(KIND_LABELS[source.kind] || "");
  return `<li class="comics-row"><label class="ui-switch comics-row__switch"><input type="checkbox" data-source-toggle="${escapeHtml(source.id)}"${source.enabled ? " checked" : ""} />`
    + `<span class="ui-switch__track" aria-hidden="true"></span>${rowText(source.name, detail)}</label>`
    + buttonMarkup({ label: "Remove", variant: "ghost", size: "sm", attrs: { "data-source-remove": source.id } }) + "</li>";
}

const starMarkup = (source, label) => iconButtonMarkup({ icon: "check", label: source.favorite ? "Remove from favorites" : "Add to favorites", size: "sm", pressed: Boolean(source.favorite),
  className: "comics-star", tooltip: label || "", attrs: { "data-favorite": source.id, "data-on": source.favorite ? "1" : "0" } });

const SPEEDS = [["normal", "Normal"], ["slow", "Slow (one request every 1.5 s)"], ["slower", "Slower (one request every 4 s)"]];
const BROWSER = [["auto", "When the site asks for a check"], ["always", "Always"], ["never", "Never"]];
const options = (list, value) => list.map(([key, label]) => `<option value="${key}"${key === value ? " selected" : ""}>${escapeHtml(t(label))}</option>`).join("");

// A favorite's own settings: its address, the browser for protected sites and speed.
// They apply to the two sources LVL reads itself (MangaFox, Kagane); a source that runs
// its extension takes its address and requests from the extension.
export function siteSettingsMarkup(source) {
  if (source.viaExtension) {
    return `<p class="settings-hint comics-site-note">${escapeHtml(t("This source runs its own extension, which keeps its address and requests up to date with the repository. A site check opens LVL's browser as usual."))}</p>`;
  }
  const settings = source.settings || {};
  const field = (label, control) => `<label class="settings-field"><span>${escapeHtml(t(label))}</span>${control}</label>`;
  return `<form class="comics-site-form" data-site-settings="${escapeHtml(source.id)}" novalidate><div class="settings-grid two">`
    + field("Site address", `<input name="baseUrl" type="url" inputmode="url" spellcheck="false" autocomplete="off" maxlength="200" placeholder="${escapeHtml(source.repoBaseUrl || source.baseUrl || "")}" value="${escapeHtml(settings.baseUrl || "")}" />`)
    + field("Speed", `<select name="speed">${options(SPEEDS, settings.speed || "normal")}</select>`)
    + field("Browser for protected sites", `<select name="browser">${options(BROWSER, settings.browser || "auto")}</select>`)
    + "</div>"
    + `<p class="settings-hint">${escapeHtml(t("Leave the address empty to use the repository's ({address}). Use your own when the site has moved.", { address: source.repoBaseUrl || source.baseUrl || "" }))}</p>`
    + `<div class="settings-actions">${buttonMarkup({ label: "Save", size: "sm", type: "submit" })}${buttonMarkup({ label: "Reset", variant: "ghost", size: "sm", attrs: { "data-site-reset": source.id } })}`
    + `<p class="tool-status settings-status" role="status" aria-live="polite"></p></div></form>`;
}

function favoriteRow(source, { open = false } = {}) {
  const state = source.supported ? "" : t("LVL can't read this source yet");
  const own = Object.keys(source.settings || {}).length ? t("Own settings") : "";
  let moved = "";
  try { moved = source.movedTo && !source.settings?.baseUrl ? t("Moved to {host}", { host: new URL(source.movedTo).host }) : ""; } catch {}
  const facts = [languageName(source.lang), source.host, moved, source.viaBrowser ? t("Through the browser") : "", source.viaExtension ? t("Runs its extension") : "", own, state].filter(Boolean).join(" · ");
  return `<li class="comics-row comics-fav${source.supported ? "" : " is-muted"}" data-fav="${escapeHtml(source.id)}">${rowText(source.name, facts)}`
    + `<span class="comics-row__actions">${buttonMarkup({ label: "Site settings", variant: "ghost", size: "sm", attrs: { "data-site-toggle": source.id, "aria-expanded": open ? "true" : "false" } })}`
    + `${starMarkup({ id: source.id, favorite: true })}</span>`
    + `<div class="comics-row__panel"${open ? "" : " hidden"}>${siteSettingsMarkup(source)}</div></li>`;
}

// Browse sources: one row per extension. One source: an Add button. Several (one per
// language): a chip per language under the name, the first few shown, then "+N".
// Pressed (added) chips and buttons show a star. Every toggle carries data-favorite.
const PREVIEW_CHIPS = 6;
const favoriteName = (on, name) => t(on ? "Remove {name} from favorites" : "Add {name} to favorites", { name });

function addToggleMarkup(source, name) {
  const on = Boolean(source.favorite);
  return `<button class="ui-btn ui-btn--secondary ui-btn--sm comics-add-toggle" type="button" data-favorite="${escapeHtml(source.id)}" data-on="${on ? "1" : "0"}" data-name="${escapeHtml(name)}"`
    + ` aria-pressed="${on}" aria-label="${escapeHtml(favoriteName(on, name))}"><span class="comics-toggle__off">${icon("plus")}${escapeHtml(t("Add"))}</span>`
    + `<span class="comics-toggle__on">${icon("check")}${escapeHtml(t("Added"))}</span></button>`;
}

function languageChipMarkup(source, label, name, extra) {
  const on = Boolean(source.favorite);
  return `<button class="ui-chip comics-lang-chip${extra ? " is-extra" : ""}" type="button" data-favorite="${escapeHtml(source.id)}" data-on="${on ? "1" : "0"}" data-name="${escapeHtml(name)}"`
    + ` aria-pressed="${on}" aria-label="${escapeHtml(favoriteName(on, name))}"><span class="comics-toggle__off" aria-hidden="true">${icon("plus")}</span><span class="comics-toggle__on" aria-hidden="true">${icon("check")}</span><span>${escapeHtml(label)}</span></button>`;
}

// Chip order: added ones, then the interface language and English, then "all", then by name.
function orderedLanguageSources(ext, preferred) {
  const labels = ext.sources.map((source) => (source.lang === "all" ? t("All languages") : languageName(source.lang)));
  const counts = labels.reduce((map, label) => map.set(label, (map.get(label) || 0) + 1), new Map());
  const rank = (source) => (source.favorite ? 0 : preferred.includes(source.lang) ? 1 + preferred.indexOf(source.lang) : source.lang === "all" ? 10 : 20);
  return ext.sources.map((source, index) => {
    // Two sources in one language: tell them apart by their own name, else their site.
    const label = counts.get(labels[index]) > 1 ? `${labels[index]} · ${source.name && source.name !== ext.name ? source.name : source.host}` : labels[index];
    return { source, label };
  }).sort((a, b) => rank(a.source) - rank(b.source) || a.label.localeCompare(b.label));
}

export function extensionRowMarkup(ext, { preferred = ["en"] } = {}) {
  const rating = ext.rating === "mixed" ? t("May include adult titles") : ext.rating === "adult" ? t("Adult") : "";
  const support = ext.supported === false ? t("LVL can't read it yet") : "";
  const logo = ext.icon ? `<img class="comics-ext__icon" src="${escapeHtml(ext.icon)}" alt="" loading="lazy" decoding="async" />` : `<span class="comics-ext__icon"></span>`;
  const single = ext.sources.length === 1 ? ext.sources[0] : null;
  const hosts = [...new Set(ext.sources.map((source) => source.host).filter(Boolean))];
  const languages = single ? (single.lang === "all" ? t("Multiple languages") : languageName(single.lang)) : t("{count} languages", { count: ext.sources.length });
  const facts = [languages, hosts.length === 1 ? hosts[0] : "", rating, support].filter(Boolean).join(" · ");
  const open = `<li class="comics-row comics-ext${ext.supported === false ? " is-muted" : ""}${single ? "" : " has-langs"}">${logo}${rowText(ext.name, facts)}`;
  if (single) return `${open}<span class="comics-row__actions">${addToggleMarkup(single, ext.name)}</span></li>`;
  const ordered = orderedLanguageSources(ext, preferred);
  const hidden = Math.max(0, ordered.length - PREVIEW_CHIPS);
  const chips = ordered.map(({ source, label }, index) => languageChipMarkup(source, label, `${ext.name} · ${label}`, index >= PREVIEW_CHIPS && !source.favorite)).join("");
  const more = hidden ? `<button class="ui-chip comics-lang-more" type="button" data-ext-more aria-expanded="false">${escapeHtml(t("+{count} more", { count: ordered.slice(PREVIEW_CHIPS).filter((item) => !item.source.favorite).length }))}</button>` : "";
  return `${open}<div class="ui-chip-row comics-ext__langs" role="group" aria-label="${escapeHtml(t("Languages of {name}", { name: ext.name }))}">${chips}${more}</div></li>`;
}

export async function sourcesSettingsSection(container) {
  // Its own box: redrawing the sources keeps the sections after it (AniList).
  const holder = document.createElement("div");
  holder.className = "comics-settings__group";
  container.append(holder);
  const openSettings = new Set(); // favorites whose settings are open
  let selectedBrowseSource = readSourceChoice();
  let availableBrowseSources = [];
  const favoritesBody = (favorites) => (favorites.length ? `<ul class="comics-rows">${favorites.map((source) => favoriteRow(source, { open: openSettings.has(source.id) })).join("")}</ul>`
    : `<p class="settings-hint">${escapeHtml(t("Add sources below. A comic's Sources tab searches them for it."))}</p>`);
  const favoritesCard = (favorites) => cardMarkup({ title: t("Favorite sources"), badge: favorites.length ? String(favorites.length) : "",
    hint: favorites.length ? t("A comic's Sources tab searches these for it. Each site can have its own settings.") : "", body: favoritesBody(favorites), attrs: " data-favorites-section" });
  const render = async () => {
    const [{ sources, downloads }, cache, favoriteReply, prefs] = await Promise.all([comicsApi.sources(), comicsApi.cache().catch(() => null),
      comicsApi.favorites().catch(() => null), comicsApi.settings().catch(() => ({ showAdult: false }))]);
    const favorites = favoriteReply?.favorites || [];
    if (favoriteReply) {
      availableBrowseSources = sourceChoices(favorites);
      selectedBrowseSource = reconcileFavoriteSource(availableBrowseSources);
    } else selectedBrowseSource = ""; // No verified favorites; leave the saved ID intact until a successful refresh.
    const field = (label, control) => `<label class="settings-field"><span>${escapeHtml(t(label))}</span>${control}</label>`;
    holder.innerHTML = favoritesCard(favorites)
      + cardMarkup({ title: t("Browse sources"), attrs: " data-extensions-section", hint: t("Add the sources you read from. A comic's Sources tab searches them for it."), body: `<div class="comics-repos"></div>`
        + `<form class="comics-filters" data-extension-search><div class="comics-filters__row">`
        + field("Search sources", `<input type="search" name="q" autocomplete="off" placeholder="${escapeHtml(t("Name or site"))}" />`)
        + field("Language", `<select name="lang"><option value="">${escapeHtml(t("All languages"))}</option></select>`)
        + (favoriteReply ? sourceFilterMarkup(availableBrowseSources, selectedBrowseSource)
          : `<p class="comic-source__error" role="alert">${escapeHtml(t("Couldn't load sources."))}</p>`)
        + "</div></form>"
        + `<ul class="comics-rows comics-extensions"></ul>` })
      + cardMarkup({ title: t("Content"), body: `<label class="ui-switch settings-switch-row"><input type="checkbox" data-show-adult${prefs.showAdult ? " checked" : ""} />`
        + `<span class="ui-switch__track" aria-hidden="true"></span><span class="settings-learning-copy"><strong>${escapeHtml(t("Show adult content"))}</strong>`
        + `<small>${escapeHtml(t("Adult titles and sources appear in Home, search and the sources list. Off by default."))}</small></span></label>` })
      + cardMarkup({ title: t("Repositories and torrents"), hint: t("Extension repositories list the sources above; torrent searches find volume packs to download."),
        body: `<ul class="comics-rows">${sources.map(sourceRow).join("")}</ul>`
          + `<form class="comics-add" data-add-repo>${field("Extension repository URL", `<input name="url" type="url" spellcheck="false" autocomplete="off" placeholder="https://…/repo" />`)}${buttonMarkup({ label: "Add repository", size: "sm", type: "submit" })}</form>`
          + `<form class="comics-add" data-add-torznab><div class="settings-grid two">${field("Torznab URL", `<input name="url" spellcheck="false" autocomplete="off" placeholder="http://127.0.0.1:9696/1/api" />`)}`
          + `${field("API key", `<input name="apiKey" autocomplete="off" spellcheck="false" />`)}</div>${buttonMarkup({ label: "Add Torznab", size: "sm", type: "submit" })}</form>` })
      + (downloads.length ? cardMarkup({ title: t("Downloads"), hint: t("Downloaded files are kept. LVL shares a torrent while it downloads and stops once it's complete."), body: downloadsMarkup(downloads) }) : "")
      + (cache ? cardMarkup({ title: t("Online reading cache"), action: buttonMarkup({ label: "Clear", variant: "ghost", size: "sm", attrs: { "data-cache-clear": "" } }),
        body: `<p class="settings-hint">${escapeHtml(t("{size} of {max}", { size: size(cache.bytes), max: size(cache.maxBytes) }))}</p>` }) : "");
    languagesFilled = false;
  };
  const paintFavorites = (favorites) => {
    const section = holder.querySelector("[data-favorites-section]");
    if (section) section.outerHTML = favoritesCard(favorites);
    const filter = holder.querySelector("[data-extension-search] [data-comics-source-filter]");
    if (filter || holder.querySelector("[data-extension-search]")) {
      const before = selectedBrowseSource;
      availableBrowseSources = sourceChoices(favorites);
      selectedBrowseSource = reconcileFavoriteSource(availableBrowseSources);
      filter?.insertAdjacentHTML("beforebegin", sourceFilterMarkup(availableBrowseSources, selectedBrowseSource));
      filter?.remove();
      if (!filter && availableBrowseSources.length) holder.querySelector("[data-extension-search] .comics-filters__row")
        ?.insertAdjacentHTML("beforeend", sourceFilterMarkup(availableBrowseSources, selectedBrowseSource));
      if (before !== selectedBrowseSource) void listExtensions();
      // Refresh other connected Comics filter surfaces when the favorite list
      // changes, including removal of an ID they previously offered.
      selectFavoriteSource(selectedBrowseSource, availableBrowseSources);
    }
  };
  let languagesFilled = false;
  let extensionRequest = 0;
  const listExtensions = async ({ more = false } = {}) => {
    const request = ++extensionRequest;
    const list = holder.querySelector(".comics-extensions");
    const form = holder.querySelector("[data-extension-search]");
    if (!list || !form) return;
    const offset = more ? list.querySelectorAll("li.comics-ext").length : 0;
    if (!more) list.innerHTML = `<li class="comic-source__meta">${escapeHtml(t("Loading…"))}</li>`;
    try {
      const result = await comicsApi.extensionIndex({ q: form.q.value.trim(), lang: form.lang.value,
        source: selectedBrowseSource, offset: String(offset) });
      if (request !== extensionRequest || !list.isConnected) return;
      holder.querySelector(".comics-repos").innerHTML = result.repos.map((repo) => `<p class="comics-repo">`
        + `<span${repo.fingerprint ? ` title="${escapeHtml(t("Signing key"))}: ${escapeHtml(repo.fingerprint)}"` : ""}>${escapeHtml(repo.name)}</span>`
        + `<span>${escapeHtml(repo.error && !repo.count ? repo.error : t("{count} extensions", { count: Number(repo.count || 0).toLocaleString(document.documentElement.lang || undefined) }))}</span>`
        + (repo.fingerprintMatches === false ? `<span class="is-error">${escapeHtml(t("Signing keys don't match"))}</span>` : "") + "</p>").join("");
      if (!languagesFilled && result.languages.length) {
        form.lang.insertAdjacentHTML("beforeend", result.languages.map((item) => `<option value="${escapeHtml(item.code)}">${escapeHtml(languageName(item.code))} (${item.count})</option>`).join(""));
        languagesFilled = true;
      }
      const ui = String(document.documentElement.lang || "en").slice(0, 2).toLowerCase();
      const rows = result.extensions.map((ext) => extensionRowMarkup(ext, { preferred: [...new Set([ui, "en"])] })).join("");
      list.querySelector("[data-extensions-more]")?.closest("li").remove();
      if (more) list.insertAdjacentHTML("beforeend", rows); else list.innerHTML = rows || `<li class="comic-source__meta">${escapeHtml(t("No sources found"))}</li>`;
      const shown = list.querySelectorAll("li.comics-ext").length;
      if (result.total > shown) list.insertAdjacentHTML("beforeend", `<li>${buttonMarkup({ label: t("Show more ({shown} of {total})", { shown, total: result.total }), size: "sm", attrs: { "data-extensions-more": "" } })}</li>`);
    } catch (error) { if (request === extensionRequest && list.isConnected) list.innerHTML = `<li class="comic-source__error">${escapeHtml(error.message)}</li>`; }
  };
  let searchTimer = 0;
  const siteValues = (form) => ({ baseUrl: form.baseUrl.value.trim(), speed: form.speed.value, browser: form.browser.value });
  async function saveSite(form, settings) {
    const status = form.querySelector(".settings-status");
    const id = form.dataset.siteSettings;
    try {
      const result = await comicsApi.saveSiteSettings(id, settings);
      openSettings.add(id);
      paintFavorites(result.favorites);
      const saved = holder.querySelector(`[data-site-settings="${CSS.escape(id)}"] .settings-status`);
      if (saved) saved.textContent = t("Saved. Searches on this site start fresh.");
    } catch (error) {
      status?.classList.add("is-error");
      if (status) status.textContent = error.message;
    }
  }
  holder.addEventListener("input", (event) => {
    if (!event.target.closest("[data-extension-search]") || event.target.name !== "q") return;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => listExtensions(), 250);
  });
  holder.addEventListener("change", async (event) => {
    if (event.target.closest("[data-site-settings]")) return undefined;
    if (event.target.matches("[data-show-adult]")) {
      const box = event.target;
      box.disabled = true;
      try { await comicsApi.saveSettings({ showAdult: box.checked }); } catch (error) { box.checked = !box.checked; toast(error.message); }
      box.disabled = false;
      return listExtensions();
    }
    if (event.target.closest("[data-extension-search]")) {
      return listExtensions();
    }
    const toggle = event.target.closest("[data-source-toggle]");
    if (!toggle) return undefined;
    await comicsApi.updateSource(toggle.dataset.sourceToggle, { enabled: toggle.checked }).catch((error) => toast(error.message));
    return listExtensions();
  });
  holder.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target;
    if (form.matches("[data-site-settings]")) return saveSite(form, siteValues(form));
    try {
      if (form.matches("[data-extension-search]")) return listExtensions();
      if (form.matches("[data-add-torznab]")) await comicsApi.addSource({ kind: "torznab", url: form.url.value, apiKey: form.apiKey.value });
      else if (form.matches("[data-add-repo]")) await comicsApi.addSource({ kind: "mihon-repo", url: form.url.value });
      await render();
      return listExtensions();
    } catch (error) { return toast(error.message); }
  });
  holder.addEventListener("click", async (event) => {
    const choice = event.target.closest("[data-extension-search] [data-comics-source-choice]");
    if (choice) {
      selectedBrowseSource = selectFavoriteSource(choice.dataset.comicsSourceChoice, availableBrowseSources);
      const filter = holder.querySelector("[data-extension-search] [data-comics-source-filter]");
      filter?.insertAdjacentHTML("beforebegin", sourceFilterMarkup(availableBrowseSources, selectedBrowseSource));
      filter?.remove();
      holder.querySelector("[data-extension-search] [data-comics-source-filter] summary")?.focus({ preventScroll: true });
      void listExtensions();
      return;
    }
    const button = event.target.closest("button");
    if (!button || button.type === "submit") return;
    try {
      if (button.dataset.siteToggle) {
        const row = button.closest("[data-fav]");
        const panel = row?.querySelector(".comics-row__panel");
        if (!panel) return;
        panel.hidden = !panel.hidden;
        button.setAttribute("aria-expanded", String(!panel.hidden));
        if (panel.hidden) openSettings.delete(button.dataset.siteToggle); else { openSettings.add(button.dataset.siteToggle); panel.querySelector("input, select")?.focus(); }
        return;
      }
      if (button.dataset.siteReset) { await saveSite(button.closest("form"), {}); return; }
      if (button.matches("[data-ext-more]")) {
        const row = button.closest(".comics-ext");
        row?.classList.add("is-open");
        button.remove();
        row?.querySelector(".comics-lang-chip.is-extra")?.focus();
        return;
      }
      if (button.dataset.favorite) {
        const on = button.dataset.on !== "1";
        button.disabled = true;
        const result = await comicsApi.setFavorite(button.dataset.favorite, on);
        // Every toggle for this source (favorites list and the browse list) follows.
        for (const toggle of holder.querySelectorAll(`[data-favorite="${CSS.escape(button.dataset.favorite)}"]`)) {
          toggle.dataset.on = on ? "1" : "0";
          toggle.setAttribute("aria-pressed", String(on));
          toggle.setAttribute("aria-label", toggle.dataset.name ? favoriteName(on, toggle.dataset.name) : t(on ? "Remove from favorites" : "Add to favorites"));
        }
        button.disabled = false;
        paintFavorites(result.favorites);
        if (on && result.favorite && !result.favorite.supported) toast(result.favorite.error || t("LVL can't read {source} yet. It stays in your favorites.", { source: result.favorite.name }));
        return;
      }
      if (button.dataset.sourceRemove) { await comicsApi.removeSource(button.dataset.sourceRemove); await render(); await listExtensions(); return; }
      if (button.matches("[data-extensions-more]")) { button.disabled = true; await listExtensions({ more: true }); return; }
      if (button.dataset.comicsCancel) { await comicsApi.cancelDownload(button.dataset.comicsCancel); await render(); await listExtensions(); return; }
      if (button.matches("[data-cache-clear]")) { await comicsApi.clearCache(); await render(); await listExtensions(); }
    } catch (error) { toast(error.message); button.disabled = false; }
  });
  holder.addEventListener("keydown", (event) => {
    const filter = event.target.closest("[data-extension-search] [data-comics-source-filter]");
    if (!filter) return;
    if (event.key === "Escape" && filter.open) {
      filter.open = false;
      filter.querySelector("summary")?.focus();
      event.preventDefault();
    } else if (["ArrowDown", "ArrowUp"].includes(event.key) && event.target.matches("[data-comics-source-choice]")) {
      const buttons = [...filter.querySelectorAll("[data-comics-source-choice]")];
      const at = buttons.indexOf(event.target);
      buttons[(at + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length]?.focus();
      event.preventDefault();
    }
  });
  await render();
  await listExtensions();
}
