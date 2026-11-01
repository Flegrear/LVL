// "LVL Manga": the manga's LVL score in a title page's
// hero, next to LVL's own score. It shows the overall score: your score for the
// whole manga if you gave one, else the average of your volume scores. Its
// dropdown rates the whole manga and each volume (no chapter ratings, user
// decision 2026-10-29). It uses the same look as the LVL score dropdown.
import { escapeHtml, icon, toast } from "../ui/ui.js";
import { t } from "../ui/ui-i18n.js";
import { comicsApi } from "./comics-api.js";

const state = new Map(); // work id -> { ratings, volumes, message, error }
const format = (value) => (value === null || value === undefined ? "" : String(Math.round(Number(value) * 100) / 100));
const shown = (value) => (value === null || value === undefined ? "—" : (Math.round((Number(value) + Number.EPSILON) * 10) / 10).toFixed(1));

// Score text from 1 to 10 ("7,5" accepted); null clears; undefined when invalid.
export function readMangaScore(text) {
  const value = String(text ?? "").trim().replace(",", ".");
  if (!value) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 1 && number <= 10 ? Math.round(number * 100) / 100 : undefined;
}

export function mangaScoreMarkup({ ratings = null, volumes = [], message = "", error = false } = {}, { title = "", open = false, retry = false } = {}) {
  const current = ratings || { volumes: {}, override: null, average: null, overall: null };
  const rated = Object.keys(current.volumes || {}).length;
  const field = (key, value, label) => `<span class="title-lvl-score-value"><input type="text" inputmode="decimal" autocomplete="off" spellcheck="false" maxlength="5"`
    + ` value="${escapeHtml(format(value))}" data-manga-score="${escapeHtml(key)}" aria-label="${escapeHtml(label)}" /><span>/10</span>`
    + (value !== null && value !== undefined ? `<button type="button" class="title-lvl-score-clear" data-manga-clear="${escapeHtml(key)}" aria-label="${escapeHtml(t("Clear"))}" title="${escapeHtml(t("Clear"))}">×</button>` : "")
    + "</span>";
  const row = (label, key, value, aria) => `<div class="title-rating-season title-lvl-score-row"><div class="title-rating-season__head"><span>${escapeHtml(label)}</span>${field(key, value, aria)}</div></div>`;
  const hint = current.override !== null ? t("Your score for the whole manga. Clear it to use your volumes' average ({average}).", { average: current.average === null ? "—" : shown(current.average) })
    : rated ? t("Average of the {count} volumes you rated", { count: rated }) : t("Rate the whole manga, or its volumes to get an average");
  return `<details class="title-rating-wrap title-lvl-rating-wrap comic-manga-score"${open ? " open" : ""} data-title-rating-provider="LVL Manga">`
    + `<summary class="title-rating" aria-label="${escapeHtml(t("LVL Manga {score} out of 10; rate {title}", { score: shown(current.overall), title }))}">`
    + `${icon("star")}<strong>${escapeHtml(shown(current.overall))}</strong><span>LVL Manga</span>${icon("chevron-down")}</summary>`
    + `<div class="title-rating-breakdown"><div class="title-rating-breakdown__heading"><strong>${escapeHtml(t("Your manga ratings"))}</strong></div>`
    + `<p class="title-rating-breakdown__hint">${escapeHtml(hint)}</p><div class="title-lvl-score-list">`
    + row(t("Whole manga"), "", current.override, t("Your score for the whole manga, from 1 to 10"))
    + volumes.map((volume) => row(t("Volume {number}", { number: volume }), volume, current.volumes?.[volume] ?? null, t("Your score for volume {number}, from 1 to 10", { number: volume }))).join("")
    + "</div>"
    + (message ? `<p class="title-lvl-save-message${error ? " is-error" : ""}" role="status">${escapeHtml(message)}`
      + (retry ? ` <button type="button" class="ui-btn ui-btn--ghost ui-btn--sm" data-manga-retry><span>${escapeHtml(t("Try again"))}</span></button>` : "") + "</p>" : "")
    + "</div></details>";
}

const volumeList = (index) => [...new Set((index?.volumes || []).map((group) => group.volume).filter((volume) => volume !== null && volume !== undefined && volume !== "").map(String))].slice(0, 300);
const countList = (count) => (Number.isInteger(count) && count > 0 ? Array.from({ length: Math.min(count, 300) }, (_, i) => String(i + 1)) : []);
const hosts = new Map(); // work id -> Set of elements showing it

// Redraws every element on screen that shows this work.
function repaint(id) {
  for (const host of hosts.get(id) || []) {
    if (!host.isConnected || host.dataset.mangaScoreFor !== id) { hosts.get(id).delete(host); continue; }
    paintScore(host);
  }
}

// Ratings are local and quick; volumes may wait for the chapter index (built on first visit).
function load(id, { index = null, volumeCount = null } = {}) {
  const known = state.get(id) || {};
  const entry = { ...known, loading: true, failed: false };
  if (index) entry.volumes = volumeList(index);
  if (!entry.volumes?.length && volumeCount) entry.volumes = countList(volumeCount);
  state.set(id, entry);
  const ratings = fetch(`/api/comics/work/${id}/ratings`, { signal: AbortSignal.timeout(15_000) })
    .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
    .then((value) => { state.set(id, { ...state.get(id), ratings: value }); repaint(id); }, () => { state.set(id, { ...state.get(id), failed: true }); });
  const volumes = index ? Promise.resolve() : comicsApi.units(id).then((units) => {
    const list = volumeList(units);
    if (list.length) state.set(id, { ...state.get(id), volumes: list });
  }, () => {});
  void Promise.all([ratings, volumes]).then(() => { state.set(id, { ...state.get(id), loading: false, loadedAt: Date.now() }); repaint(id); });
}

function paintScore(host) {
  const id = host.dataset.mangaScoreFor;
  const open = host.querySelector(".comic-manga-score")?.open || false;
  const known = state.get(id) || {};
  const message = known.message || (known.failed ? t("Couldn't load your ratings.") : !known.ratings && known.loading ? t("Loading your ratings…") : "");
  host.innerHTML = mangaScoreMarkup({ ...known, message, error: known.error || known.failed }, { title: host.dataset.mangaScoreTitle || "", open, retry: known.failed });
}

// Draws the element into host and keeps it current. index: the page's chapter
// index when it has one (volumes without another request); volumeCount: AniList's
// volume count, used when the index has no volumes. onSaved(overall) runs after a change.
export function mountMangaScore(host, { id, title = "", index = null, volumeCount = null }, { onSaved = () => {} } = {}) {
  if (!host || !id) return;
  const paint = () => paintScore(host);
  host.dataset.mangaScoreFor = id;
  host.dataset.mangaScoreTitle = title;
  host.mangaScoreSaved = onSaved;
  if (!hosts.has(id)) hosts.set(id, new Set());
  hosts.get(id).add(host);
  const known = state.get(id);
  // Not loaded yet, failed (tried again after 5 s), or the page now has volumes this lacks.
  if (!known || (known.failed && !known.loading && Date.now() - (known.loadedAt || 0) > 5000)) load(id, { index, volumeCount });
  else if (index && !known.volumes?.length && volumeList(index).length) { state.set(id, { ...known, volumes: volumeList(index) }); }
  else if (!known.volumes?.length && volumeCount) state.set(id, { ...known, volumes: countList(volumeCount) });
  paint();
  if (host.dataset.mangaScoreBound) return;
  host.dataset.mangaScoreBound = "1";
  const save = async (key, score) => {
    const work = host.dataset.mangaScoreFor;
    try {
      const response = await fetch(`/api/comics/work/${work}/ratings`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ volume: key, score }), signal: AbortSignal.timeout(10_000) });
      const next = await response.json();
      if (!response.ok) throw new Error(next.error || t("Couldn't save the score"));
      state.set(work, { ...state.get(work), ratings: next, failed: false, message: t("Saved"), error: false });
      repaint(work);
      await host.mangaScoreSaved?.(next.overall);
    } catch (error) {
      state.set(work, { ...state.get(work), message: error.message, error: true });
      repaint(work);
      toast(error.message);
    }
  };
  host.addEventListener("change", (event) => {
    const input = event.target.closest("[data-manga-score]");
    if (!input) return;
    const score = readMangaScore(input.value);
    if (score === undefined) {
      const known = state.get(host.dataset.mangaScoreFor) || {};
      state.set(host.dataset.mangaScoreFor, { ...known, message: t("Scores go from 1 to 10"), error: true });
      paint();
      return;
    }
    void save(input.dataset.mangaScore, score);
  });
  host.addEventListener("keydown", (event) => { if (event.key === "Enter" && event.target.matches("[data-manga-score]")) event.target.blur(); });
  host.addEventListener("click", (event) => {
    const clear = event.target.closest("[data-manga-clear]");
    if (clear) void save(clear.dataset.mangaClear, null);
    if (event.target.closest("[data-manga-retry]")) { load(host.dataset.mangaScoreFor, { volumeCount }); repaint(host.dataset.mangaScoreFor); }
  });
}

