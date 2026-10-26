// Browser side of the recommendations: the "Top picks for you" rows on Home and in the Library,
// Settings › Recommendations and "Your rating" on title pages. The server does the work
// (recs-service.js); this module shows it. app.js passes in the few app functions it needs.
import { artworkFallback, badgeMarkup, bindShelves, buttonMarkup, emptyMarkup, escapeHtml, helpTipMarkup, icon, iconButtonMarkup, refreshImages, shelfMarkup, toast } from "../ui/ui.js";
import { metahubUrl, posterSrcset, sharperPoster } from "../catalog/home-feed.js";
import { resolveAniListScorePart } from "../anilist/anilist-score-sync.js";
import { lvlRatingSummary } from "./lvl-ratings.js";

// Pick posters: the catalog's (300–780 px, the browser takes the size the screen needs) when the
// pick has a catalog page, else AniList's large cover. The other one is the fallback.
const POSTER_SIZES = "(max-width: 680px) 34vw, 190px";
function pickPoster(pick) {
  const cover = sharperPoster(pick.cover);
  const catalog = metahubUrl("poster", "small", pick.imdbId);
  if (catalog) return { src: catalog, srcset: posterSrcset({ poster: catalog }), fallback: cover.image || "" };
  return { src: cover.image, srcset: "", fallback: cover.imageFallback };
}

const POLL_MS = 1500;
const FRESH_MS = 60_000;
export const STATUS_LABELS = Object.freeze({ COMPLETED: "Completed", CURRENT: "Watching", PAUSED: "Paused", DROPPED: "Dropped", PLANNING: "Plan to watch", REPEATING: "Rewatching", WATCHED: "Watched" });
const STATUS_TAKE = { COMPLETED: "you completed", CURRENT: "you're watching", REPEATING: "you're rewatching", WATCHED: "you watched", PAUSED: "you paused", DROPPED: "you dropped", PLANNING: "you plan to watch" };

const plural = (count, word, many = `${word}s`) => `${Number(count || 0).toLocaleString("en-US")} ${Number(count) === 1 ? word : many}`;
const listText = (items) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);
const slug = (value) => String(value || "").replace(/[^a-zA-Z0-9_-]+/g, "-");
// Display only scores on LVL's supported 1–10 scale. Unrated external entries
// may report zero; malformed, non-finite or out-of-range values are not scores.
const hasScore = (value) => value !== null && value !== undefined && value !== ""
  && Number.isFinite(Number(value)) && Number(value) >= 1 && Number(value) <= 10;
export const formatScore = (value) => (hasScore(value) ? Number(value).toFixed(2) : "");

/** "just now", "5 min ago", "3 h ago", "2 days ago", else the date. */
export function timeAgo(ms, now = Date.now()) {
  const value = Number(ms);
  if (!value) return "";
  const minutes = Math.round((now - value) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days} day${days === 1 ? "" : "s"} ago`;
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function timeUntil(ms, now = Date.now()) {
  const minutes = Math.max(0, Math.round((Number(ms) - now) / 60_000));
  if (minutes <= 1) return "in a minute";
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 36 ? `in ${hours} h` : `in ${Math.round(hours / 24)} days`;
}

/**
 * Public username imports are anonymous. For the SAME already-connected AniList
 * Viewer, use the authenticated, direct-browser list import instead: private
 * profiles legitimately return HTTP 404 to anonymous requests.
 * This function never receives a bearer token or sends one to LVL's server.
 */
export async function linkAniListUsername({ username, connectedUsername = "", importConnectedAniList = null, postJson }) {
  const ownProfile = Boolean(connectedUsername && String(username).trim().toLowerCase() === String(connectedUsername).trim().toLowerCase()
    && typeof importConnectedAniList === "function");
  if (ownProfile) return { data: await importConnectedAniList(), authenticated: true };
  try { return { data: await postJson("/api/recs/anilist/link", { username }), authenticated: false }; }
  catch (error) {
    if (/\b(?:HTTP|status|request failed)\s*\(?404\)?\b/i.test(error?.message || ""))
      throw new Error("AniList could not read that public profile. If this is your account, connect AniList below to import a private list.");
    throw error;
  }
}

const take = (from) => (hasScore(from.score) ? `you rated ${formatScore(from.score)}` : STATUS_TAKE[from.status] || "you watched");
function personalVsPublic(from) {
  if (!hasScore(from.score)) return "";
  const score = Number(from.score);
  const publicAverage = Number(from.publicScore);
  const ownAverage = Number(from.personalAverage);
  const publicPart = from.publicScore != null && publicAverage > 0 && publicAverage <= 100
    ? ` vs public average ${(publicAverage / 10).toFixed(2)} (${score >= publicAverage / 10 ? "+" : ""}${(score - publicAverage / 10).toFixed(2)})` : "";
  const ownPart = from.personalAverage != null && ownAverage >= 1 && ownAverage <= 10
    ? ` vs your usual average ${ownAverage.toFixed(2)} (${score >= ownAverage ? "+" : ""}${(score - ownAverage).toFixed(2)})` : "";
  return publicPart || ownPart ? `${publicPart}${publicPart && ownPart ? ";" : ""}${ownPart}` : "";
}

/** Separate personalized evidence from cautions and general information.
 * Public ratings and watch-list status must never be presented as reasons
 * someone with this particular taste would like a title.
 */
export function reasonGroups(pick = {}) {
  const matches = [];
  const cautions = [];
  const context = [];
  for (const reason of pick.reasons || []) {
    if (reason.kind === "fans") {
      for (const from of (reason.from || []).slice(0, 3)) {
        matches.push(Number(from.votes) > 0
          ? `Fans of ${from.title}, which ${take(from)}${personalVsPublic(from)}, recommend it (${plural(from.votes, "vote")})`
          : `TMDB recommends it to fans of ${from.title}, which ${take(from)}${personalVsPublic(from)}`);
      }
    } else if (reason.kind === "shared" && reason.names?.length)
      matches.push(`${listText(reason.names)}, categories associated with titles you rated higher`);
    else if (reason.kind === "studio" && reason.name)
      matches.push(reason.title ? `By ${reason.name}, who made ${reason.title}` : `By ${reason.name}`);
    else if (reason.kind === "caution" && reason.from?.length) {
      for (const from of reason.from) {
        cautions.push(`Fans of ${from.title} recommend it too, but ${hasScore(from.score) ? `your ${formatScore(from.score)} rating of ${from.title}` : `your reaction to ${from.title}`} counts against this match.`);
      }
    }
  }
  return { matches, cautions, context };
}

/** Flat plain sentences for accessibility and the existing recommendation tooltips. */
export function reasonLines(pick = {}) {
  const { matches, cautions, context } = reasonGroups(pick);
  return [...matches, ...cautions, ...context];
}

export function kindLabel(pick = {}) {
  if (pick.source === "anilist") return pick.type === "movie" ? "Anime movie" : "Anime";
  return pick.type === "movie" ? "Movie" : "Series";
}

/** Picks for a Home tab: Movies, TV shows (not anime) or Anime; All shows every pick. */
export function picksForCategory(picks = [], category = "all") {
  if (category === "movie") return picks.filter((pick) => pick.type === "movie");
  if (category === "tv") return picks.filter((pick) => pick.type !== "movie" && pick.source !== "anilist");
  if (category === "anime") return picks.filter((pick) => pick.source === "anilist");
  return picks;
}

export function pickCardMarkup(pick, place = "home") {
  const percent = Math.round((Number(pick.match) || 0) * 100);
  const title = String(pick.title || "Untitled");
  const meta = [pick.year ? String(pick.year) : "", kindLabel(pick)].filter(Boolean);
  const poster = pickPoster(pick);
  const image = poster.src;
  const src = image || artworkFallback(title, { ratio: "poster" });
  const lines = reasonLines(pick);
  const label = `${title}, ${percent}% match${pick.summary ? `. ${pick.summary}` : ""}${pick.imdbId ? "" : ". Opens on AniList"}`;
  const why = lines.length
    ? helpTipMarkup({
      id: `pick-why-${place}-${slug(pick.itemId)}`,
      label: `Why ${title} is here`,
      content: `<strong>Why it's here</strong><ul>${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul><p>${percent}% match: a personalized estimate from your ratings and fan connections, not a guarantee or measured probability.</p>`,
    })
    : "";
  return `<article class="ui-card ui-card--poster pick-card" data-pick-id="${escapeHtml(pick.itemId)}">`
    + `<button class="ui-card__hit" type="button" data-pick-action="open" aria-label="${escapeHtml(label)}">`
    + `<span class="ui-card__media"><img class="ui-card__img" src="${escapeHtml(src)}"${poster.srcset ? ` srcset="${escapeHtml(poster.srcset)}" sizes="${POSTER_SIZES}"` : ""} alt="" loading="lazy" decoding="async"${image ? ` data-fallback="poster" data-fallback-title="${escapeHtml(title)}"` : ""}${poster.fallback && poster.fallback !== image ? ` data-fallback-src="${escapeHtml(poster.fallback)}"` : ""} />`
    + `<span class="ui-card__shade" aria-hidden="true"></span><span class="ui-card__badge">${badgeMarkup(`${percent}% match`, { variant: "solid" })}</span></span>`
    + `<span class="ui-card__body"><span class="ui-card__title">${escapeHtml(title)}</span>`
    + `<span class="ui-card__meta"><span class="ui-meta">${meta.map((part) => `<span>${escapeHtml(part)}</span>`).join("")}</span></span></span>`
    + "</button>"
    + `<div class="ui-card__actions">${iconButtonMarkup({ icon: "close", label: `Not interested in ${title}`, variant: "glass", size: "sm", tooltip: "Not interested", tooltipPos: "bottom", tooltipAlign: "end", attrs: { "data-pick-action": "hide" } })}</div>`
    + (pick.summary || why ? `<div class="pick-card__why"><span class="pick-card__summary">${escapeHtml(pick.summary || "")}</span>${why}</div>` : "")
    + "</article>";
}

const totalRatings = (overview) => Object.values(overview?.stats?.ratings || {}).reduce((sum, entry) => sum + (Number(entry.count) || 0), 0);

/** Progress of a running update as a whole percent (0–99 until it's done). */
export const runPercent = (running) => Math.max(0, Math.min(99, Math.round((Number(running?.progress) || 0) * 100)));

// While the first picks are found: the step it's on, a bar and placeholder posters. Only the
// step text and the bar change between polls (updateLoading), so the placeholders don't flicker.
function loadingMarkup(running) {
  const percent = runPercent(running);
  const posters = Array.from({ length: 8 }, () => `<li class="ui-shelf__item"><span class="ui-skeleton ui-skeleton--poster"></span><span class="ui-skeleton ui-skeleton--text" style="width:72%;margin-top:12px"></span><span class="ui-skeleton ui-skeleton--text" style="width:44%;margin-top:8px"></span></li>`).join("");
  return `<div class="recs-loading">`
    + `<div class="recs-loading__status"><div class="recs-loading__head"><strong>Finding your picks</strong><span class="recs-loading__step" data-recs-step aria-live="polite">${escapeHtml(`${running?.phase || "Starting"}…`)}</span><span class="recs-loading__percent" data-recs-percent>${percent}%</span></div>`
    + `<div class="ui-progress recs-loading__bar" data-recs-bar role="progressbar" aria-label="Finding your picks" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}" style="--ui-progress:${percent}%"><span></span></div></div>`
    + `<p class="recs-loading__note">The first time takes up to a minute. You can keep browsing; the picks appear here.</p>`
    + `<ul class="ui-shelf__track recs-loading__posters" role="presentation" aria-hidden="true">${posters}</ul>`
    + "</div>";
}

export function updateLoading(holder, running) {
  const percent = runPercent(running);
  const step = holder.querySelector("[data-recs-step]");
  const text = `${running?.phase || "Starting"}…`;
  if (step && step.textContent !== text) step.textContent = text;
  const label = holder.querySelector("[data-recs-percent]");
  if (label) label.textContent = `${percent}%`;
  const bar = holder.querySelector("[data-recs-bar]");
  if (bar) {
    bar.style.setProperty("--ui-progress", `${percent}%`);
    bar.setAttribute("aria-valuenow", String(percent));
  }
}

/**
 * The "Top picks for you" row. Home tabs other than All only show it when they have picks; All
 * and the Library show a short prompt until there are some.
 */
export function picksShelfMarkup(overview, { place = "home", category = "all" } = {}) {
  if (!overview) return "";
  const all = overview.picks || [];
  const picks = picksForCategory(all, category);
  const running = overview.status?.running;
  const lastRun = overview.status?.lastRun;
  const id = `${place}-picks-shelf`;
  const title = "Top picks for you";
  const subtitle = running ? "Updating…" : overview.updatedAt ? `Updated ${timeAgo(overview.updatedAt)}` : "";
  if (picks.length) return shelfMarkup({ id, title, subtitle, cards: picks.map((pick) => pickCardMarkup(pick, place)) });
  const action = (label, value, variant = "secondary") => buttonMarkup({ label, variant, size: "sm", attrs: { "data-pick-action": value } });
  // Movies and TV shows need TMDB: say so on those tabs instead of showing nothing.
  if (all.length && (category === "movie" || category === "tv") && !overview.settings?.tmdb?.linked) {
    return shelfMarkup({ id, title, cards: [], empty: emptyMarkup({ icon: "sparkle", title: "Your picks are anime for now", text: `Add a free TMDB key to get ${category === "movie" ? "movies" : "TV shows"} too.`, action: action("Add a key", "tmdb"), compact: true }) });
  }
  if (all.length || category !== "all") return "";
  let empty;
  if (running) empty = loadingMarkup(running);
  else if (!totalRatings(overview)) empty = emptyMarkup({ icon: "sparkle", title: "Get picks made for you", text: "Link AniList, or rate shows and movies on their pages.", action: action("Set up", "setup"), compact: true });
  else if (lastRun?.status === "failed") empty = emptyMarkup({ icon: "alert", title: "Couldn't update your picks", text: lastRun.error || "", action: action("Try again", "refresh"), compact: true });
  else if (!lastRun) empty = emptyMarkup({ icon: "sparkle", title: "Your ratings are ready", text: "Picks take up to a minute the first time.", action: action("Get picks", "refresh", "primary"), compact: true });
  else empty = emptyMarkup({ icon: "sparkle", title: "No picks yet", text: "Rate a few more titles, then update.", action: action("Update now", "refresh"), compact: true });
  return shelfMarkup({ id, title, subtitle, cards: [], empty });
}


/**
 * hooks: { $, fetchJson, postJson, setToolStatus, openTitlePage, openSettings, isViewActive,
 *          homeCategory, onHomeChange, onTitleChange }
 */
export function createRecsUi(hooks) {
  const { $, fetchJson, postJson, setToolStatus, openTitlePage, openSettings, isViewActive, homeCategory, onHomeChange, onTitleChange, showHomePicks = () => {}, onAniListChange = () => {}, onOverview = () => {}, refreshAniList = () => postJson("/api/recs/anilist/sync", {}), getConnectedAniListUsername = () => "", importConnectedAniList = null, getAniListScoreSyncState = () => ({ enabled: false }), getAniListScorePending = () => null, onRatingSaved = async () => "" } = hooks;
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const openPicks = () => { void Promise.resolve(showHomePicks()).catch(() => {}); };
  let overview = null;
  let loadedAt = 0;
  let loading = null;
  let pollTimer = 0;
  let announce = false;
  const rendered = new WeakMap();

  function load({ force = false } = {}) {
    if (!force && overview && Date.now() - loadedAt < FRESH_MS) return Promise.resolve(overview);
    if (loading) return loading;
    loading = fetchJson("/api/recs")
      .then((data) => { apply(data); return data; })
      .finally(() => { loading = null; });
    return loading;
  }
  const ensure = () => { if (!overview || Date.now() - loadedAt >= FRESH_MS) void load().catch(() => {}); };

  // While an update runs, ask for its progress every 1.5 s. A failed check (the app busy or
  // restarting) is retried instead of leaving the row on "Finding your picks" for good.
  function poll() {
    void load({ force: true }).catch(() => {
      if (!overview?.status?.running) return;
      clearTimeout(pollTimer);
      pollTimer = setTimeout(poll, POLL_MS * 3);
    });
  }

  function apply(data) {
    const wasRunning = Boolean(overview?.status?.running);
    overview = data;
    loadedAt = Date.now();
    clearTimeout(pollTimer);
    if (data.status?.running) pollTimer = setTimeout(poll, POLL_MS);
    else if (wasRunning && announce) {
      announce = false;
      const last = data.status?.lastRun;
      const where = isViewActive("home") || isViewActive("library") ? "" : " on Home";
      if (last?.status === "failed") toast(`Couldn't update your picks${last.error ? `: ${last.error}` : ""}`, { tone: "error" });
      else toast(data.picks?.length ? `${plural(data.picks.length, "pick")} ready${where}` : "No picks yet. Rate a few more titles.");
    }
    // Keep personalized picks for the random-title control and Settings,
    // without injecting a "Top picks for you" shelf into Home or Library.
    paintSettings();
    onOverview(data);
  }

  // Replace a picks row only when it changed, keeping its scroll position. While the first
  // picks load, only the step and the bar move.
  function setShelf(holder, markup) {
    if (!holder) return;
    if (rendered.get(holder) === markup) return;
    const running = overview?.status?.running;
    if (running && markup.includes('class="recs-loading"') && holder.querySelector(".recs-loading")) {
      updateLoading(holder, running);
      rendered.set(holder, markup);
      return;
    }
    const scroll = holder.querySelector(".ui-shelf__track")?.scrollLeft || 0;
    rendered.set(holder, markup);
    holder.innerHTML = markup;
    holder.hidden = !markup;
    const track = holder.querySelector(".ui-shelf__track");
    if (track && scroll) track.scrollLeft = scroll;
    bindShelves(holder);
    refreshImages(holder);
  }

  /** Markup for the Home row (app.js places it among the catalog rows). */
  function homePicksMarkup(category = "all") {
    ensure();
    const shelf = picksShelfMarkup(overview, { place: "home", category });
    return shelf ? `<div id="home-picks" class="recs-picks">${shelf}</div>` : "";
  }

  function paintHome() {
    if (!isViewActive("home")) return;
    const holder = $("#home-picks");
    const shelf = picksShelfMarkup(overview, { place: "home", category: homeCategory() });
    if (holder && shelf) {
      setShelf(holder, shelf);
      return;
    }
    // Add or drop the row with the rest of Home, once its catalog rows are on screen.
    if ((holder || shelf) && $("#home-rows")?.querySelector("[data-ui-shelf]")) onHomeChange();
  }

  const hasPicks = () => Boolean(overview?.picks?.length);

  /** The Library shows your picks instead of "Recommended next" once there are some. */
  function paintLibrary() {
    const holder = $("#library-picks");
    if (!holder || !isViewActive("library")) return;
    ensure();
    setShelf(holder, picksShelfMarkup(overview, { place: "library" }));
    const others = $("#library-recommendations");
    if (others) others.hidden = hasPicks();
  }

  function openPick(itemId) {
    const pick = overview?.picks?.find((entry) => entry.itemId === itemId);
    if (!pick) return;
    if (pick.imdbId) {
      openTitlePage({
        id: pick.imdbId,
        type: pick.type,
        meta: { id: pick.imdbId, type: pick.type, name: pick.title, poster: pick.cover || "", description: pick.description || "", genres: pick.genres || [], releaseInfo: pick.year ? String(pick.year) : "" },
      });
    } else if (pick.url) window.open(pick.url, "_blank", "noopener");
  }

  async function hidePick(itemId, card) {
    const items = [...(card?.closest(".ui-shelf__track")?.children || [])];
    const index = items.findIndex((item) => item.contains(card));
    const holder = card?.closest(".recs-picks");
    card?.classList.add("is-leaving");
    try {
      apply(await postJson("/api/recs/hide", { itemId }));
      toast("Hidden from your picks");
      const next = holder?.querySelectorAll(".pick-card .ui-card__hit");
      if (next?.length) next[Math.min(index, next.length - 1)]?.focus();
    } catch (error) {
      card?.classList.remove("is-leaving");
      toast(error.message || "Couldn't hide it", { tone: "error" });
    }
  }

  async function refresh() {
    announce = true;
    try {
      apply(await postJson("/api/recs/refresh", {}));
    } catch (error) {
      announce = false;
      toast(error.message || "Couldn't start the update", { tone: "error" });
    }
  }

  function handlePicksClick(event) {
    const trigger = event.target.closest("[data-pick-action]");
    if (!trigger || !event.currentTarget.contains(trigger)) return;
    const action = trigger.dataset.pickAction;
    const card = trigger.closest("[data-pick-id]");
    if (action === "open" && card) openPick(card.dataset.pickId);
    else if (action === "hide" && card) void hidePick(card.dataset.pickId, card);
    else if (action === "refresh") void refresh();
    else if (action === "setup") openSettings();
    else if (action === "tmdb") {
      openSettings();
      requestAnimationFrame(() => $("#recs-tmdb-key")?.focus());
    }
  }


  /* ------------------------------------------------------------ Settings › Recommendations */

  const setText = (selector, value) => { const node = $(selector); if (node && node.textContent !== value) node.textContent = value; };
  const show = (selector, visible) => { const node = $(selector); if (node) node.hidden = !visible; };
  const settingsVisible = () => isViewActive("settings") && $("#settings-panel-recs") && !$("#settings-panel-recs").hidden;

  function paintSettings() {
    if (!overview || !settingsVisible()) return;
    const { settings, stats, status } = overview;
    const total = totalRatings(overview);
    setText("#recs-rated-count", total ? plural(total, "rating") : "None yet");

    const anilist = settings.anilist;
    show("#recs-anilist-form", !anilist);
    show("#recs-anilist-linked", Boolean(anilist));
    setText("#recs-anilist-usage", anilist ? `Ratings linked: ${anilist.username}` : "Not linked");
    setText("#recs-anilist-note", anilist ? `${plural(anilist.count, "anime", "anime")}, ${plural(anilist.scored, "with a score", "with a score")}, synced ${timeAgo(anilist.syncedAt)}` : "");

    const letterboxd = settings.letterboxd;
    const feed = Boolean(letterboxd?.username);
    show("#recs-letterboxd-form", !feed);
    show("#recs-letterboxd-linked", Boolean(letterboxd));
    show("#recs-letterboxd-sync", feed);
    setText("#recs-letterboxd-unlink", feed ? "Unlink" : "Remove films");
    setText("#recs-letterboxd-usage", feed ? `Linked as ${letterboxd.username}` : letterboxd ? "Imported" : "Not linked");
    const films = [
      feed ? `${plural(letterboxd.count, "recent film")}${letterboxd.scored == null ? "" : `, ${plural(letterboxd.scored, "rated")}`}, synced ${timeAgo(letterboxd.syncedAt)}` : "",
      letterboxd?.importedAt ? `${plural(letterboxd.imported, "film")} imported ${timeAgo(letterboxd.importedAt)}` : "",
    ].filter(Boolean);
    setText("#recs-letterboxd-note", films.join(", "));

    const tmdb = settings.tmdb || {};
    setText("#recs-tmdb-state", tmdb.linked ? "On" : "Off");
    setText("#recs-tmdb-usage", tmdb.linked ? `Key saved${tmdb.checkedAt ? `, checked ${timeAgo(tmdb.checkedAt)}` : ""}` : "Not set");
    show("#recs-tmdb-remove", Boolean(tmdb.linked));
    const keyInput = $("#recs-tmdb-key");
    if (keyInput) keyInput.placeholder = tmdb.linked ? "Paste a new key to replace it" : "API key or read access token";

    const running = status.running;
    const button = $("#recs-refresh");
    if (button) {
      button.disabled = Boolean(running);
      button.textContent = running ? "Updating…" : "Update now";
    }
    const last = status.lastRun;
    let line = "Not updated yet";
    if (running) line = `Updating, ${runPercent(running)}%: ${running.phase || "starting"}…`;
    else if (last?.status === "failed") line = `The last update failed: ${last.error || "unknown error"}`;
    else if (last) line = `Updated ${timeAgo(last.finishedAt || last.startedAt)}, ${plural(overview.picks.length, "recommendation")}`;
    if (!running && status.nextRunAt) line += `. Next automatic refresh ${status.nextRunAt - Date.now() <= 10 * 60_000 ? "soon" : timeUntil(status.nextRunAt)}`;
    if (!running && overview.calibratedWith) line += `. Match tuned with ${plural(overview.calibratedWith, "of your ratings", "of your ratings")}`;
    setText("#recs-run", line);
    show("#recs-see-picks", !running && overview.picks.length > 0);

    const saved = [
      stats.anime ? plural(stats.anime, "anime", "anime") : "",
      stats.titles ? plural(stats.titles, "movie or series", "movies and series") : "",
      stats.links ? plural(stats.links, "fan link") : "",
    ].filter(Boolean);
    setText("#recs-data-usage", saved.length ? `${listText(saved)} saved on this computer${stats.newestSnapshot > 1 ? `, newest from ${timeAgo(stats.newestSnapshot)}` : ""}` : "Nothing saved yet");
    const unhide = $("#recs-unhide");
    if (unhide) {
      unhide.disabled = !stats.hidden;
      unhide.textContent = stats.hidden ? `Show ${plural(stats.hidden, "hidden title")} again` : "No hidden titles";
    }
  }

  // One request from a Settings button: busy state, the card's status line, then the new figures.
  async function act(button, request, { status, busy = "", done = "" } = {}) {
    if (button) button.disabled = true;
    if (status) setToolStatus(status, busy);
    try {
      const data = await request();
      titleCache.clear();
      apply(data);
      if (status) setToolStatus(status, typeof done === "function" ? done(data) : done);
      return data;
    } catch (error) {
      if (status) setToolStatus(status, error.message || "Something went wrong", true);
      return null;
    } finally {
      if (button) button.disabled = false;
      paintSettings();
    }
  }

  function showSettings() {
    paintSettings();
    void load({ force: true }).catch((error) => setToolStatus("#recs-updates-status", error.message || "Couldn't read your picks", true));
  }

  function wireSettings() {
    const ratingsStatus = "#recs-ratings-status";
    $("#recs-anilist-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const username = $("#recs-anilist-name")?.value.trim() || "";
      if (!username) return setToolStatus(ratingsStatus, "Enter your AniList user name", true);
      // A private AniList list is invisible to the anonymous username API.
      // When this is already the connected Viewer, use the existing direct-
      // browser authenticated importer instead of a guaranteed public 404.
      // Never use the connected token to read a DIFFERENT username's list.
      const connected = String(getConnectedAniListUsername() || "").trim();
      const useViewer = Boolean(connected && connected.toLowerCase() === username.toLowerCase()
        && typeof importConnectedAniList === "function");
      void act(event.submitter, async () => {
        const { data } = await linkAniListUsername({ username,
          connectedUsername: connected, importConnectedAniList, postJson });
        // The server has linked the list, but the Library import may still take
        // time to match catalog titles. Wait before reporting completion.
        await onAniListChange(true, ratingsStatus, { skipAuthPull: true });
        return data;
      }, { status: ratingsStatus,
        busy: useViewer ? "Importing your connected AniList list into the Library…" : "Reading AniList and importing titles into the Library…",
        done: (data) => `Linked and imported: ${plural(data.settings.anilist?.count, "anime", "anime")}` });
    });
    $("#recs-anilist-sync")?.addEventListener("click", (event) => void act(event.currentTarget, async () => {
      const data = await refreshAniList();
      await onAniListChange(true, ratingsStatus, { skipAuthPull: true });
      return data;
    }, { status: ratingsStatus, busy: "Refreshing AniList titles in your Library…", done: "AniList Library synced" }));
    $("#recs-anilist-unlink")?.addEventListener("click", (event) => {
      if (!window.confirm("Unlink AniList? Its ratings leave this app, and so do its titles in your Library unless you added videos to them. Nothing changes on AniList.")) return;
      void act(event.currentTarget, () => postJson("/api/recs/anilist/unlink", {}), { status: ratingsStatus, done: "AniList unlinked" })
        .then((data) => { if (data) onAniListChange(false, ratingsStatus); });
    });
    $("#recs-letterboxd-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const username = $("#recs-letterboxd-name")?.value.trim() || "";
      if (!username) return setToolStatus(ratingsStatus, "Enter your Letterboxd user name", true);
      void act(event.submitter, () => postJson("/api/recs/letterboxd/link", { username }), {
        status: ratingsStatus, busy: "Reading your Letterboxd profile…",
        done: (data) => {
          const feed = data.settings.letterboxd;
          return feed.scored
            ? `Linked: ${plural(feed.scored, "rating")} from ${plural(feed.count, "recent film")}. Update picks to use them.`
            : `Linked ${plural(feed.count, "recent film")}, but none have ratings. Import your Letterboxd export (.zip) for your full scores.`;
        },
      });
    });
    $("#recs-letterboxd-sync")?.addEventListener("click", (event) => {
      const username = overview?.settings?.letterboxd?.username;
      if (username) void act(event.currentTarget, () => postJson("/api/recs/letterboxd/link", { username }), {
        status: ratingsStatus, busy: "Reading your Letterboxd profile…",
        done: (data) => data.settings.letterboxd?.scored
          ? `Synced ${plural(data.settings.letterboxd.scored, "recent rating")}. Update picks to use them.`
          : "No ratings in recent public films. Use Import your export for full history.",
      });
    });
    $("#recs-letterboxd-unlink")?.addEventListener("click", (event) => {
      if (!window.confirm("Remove your Letterboxd films from this app? Nothing changes on Letterboxd.")) return;
      void act(event.currentTarget, () => postJson("/api/recs/letterboxd/unlink", {}), { status: ratingsStatus, done: "Letterboxd films removed" });
    });
    $("#recs-letterboxd-import")?.addEventListener("click", () => $("#recs-letterboxd-file")?.click());
    $("#recs-letterboxd-file")?.addEventListener("change", (event) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;
      void act($("#recs-letterboxd-import"), async () => {
        const response = await fetch("/api/recs/letterboxd/import", { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || `The import failed (${response.status})`);
        return data;
      }, { status: ratingsStatus, busy: `Reading ${file.name}…`, done: (data) => `Imported ${plural(data.settings.letterboxd?.imported, "film")}` });
    });

    const tmdbStatus = "#recs-tmdb-status";
    $("#recs-tmdb-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const input = $("#recs-tmdb-key");
      const key = input?.value.trim() || "";
      if (!key) return setToolStatus(tmdbStatus, "Paste your TMDB key first", true);
      void act(event.submitter, () => postJson("/api/recs/tmdb", { key }), { status: tmdbStatus, busy: "Checking the key with TMDB…", done: () => { if (input) input.value = ""; return "Key saved"; } });
    });
    $("#recs-tmdb-remove")?.addEventListener("click", (event) => void act(event.currentTarget, () => postJson("/api/recs/tmdb", { key: "" }), { status: tmdbStatus, done: "Key removed" }));

    const updatesStatus = "#recs-updates-status";
    $("#recs-refresh")?.addEventListener("click", () => { setToolStatus(updatesStatus, ""); void refresh(); });
    $("#recs-see-picks")?.addEventListener("click", () => openPicks());

    const dataStatus = "#recs-data-status";
    $("#recs-unhide")?.addEventListener("click", (event) => void act(event.currentTarget, () => postJson("/api/recs/unhide-all", {}), { status: dataStatus, done: "Hidden titles can be picked again" }));
    $("#recs-clear")?.addEventListener("click", (event) => {
      if (!window.confirm("Clear the saved details and fan links? Your ratings, hidden titles and settings stay; the next update reads everything again.")) return;
      void act(event.currentTarget, () => postJson("/api/recs/clear-cache", {}), { status: dataStatus, done: "Cleared" });
    });
  }

  /* ------------------------------------------------------------ "Your rating" on a title page */

  const titleCache = new Map();
  const titleWrites = new Map();
  const seasonsOpen = new Set();
  let titleNow = null;

  const titleCacheKey = (subject) => `${subject.catalogId}|${subject.seriesKey}|${subject.title}`;

  function titleRecord(subject) {
    const key = titleCacheKey(subject);
    let record = titleCache.get(key);
    if (record) return record;
    if (titleCache.size > 60) titleCache.clear();
    record = { data: null, pending: true, error: "", message: "", messageError: false };
    titleCache.set(key, record);
    const params = new URLSearchParams();
    if (subject.catalogId) params.set("catalogId", subject.catalogId);
    if (subject.seriesKey) params.set("key", subject.seriesKey);
    if (subject.title) params.set("title", subject.title);
    if (subject.year) params.set("year", String(subject.year));
    fetchJson(`/api/ratings?${params}`)
      .then((data) => { record.data = data; })
      .catch((error) => { record.error = error.message || "Couldn't read your ratings"; })
      .finally(() => { record.pending = false; onTitleChange(); });
    return record;
  }

  const scoreInput = (season, rating, label) => `<span class="recs-score"><input type="text" inputmode="decimal" autocomplete="off" spellcheck="false" maxlength="5" placeholder="e.g. 7.5" value="${escapeHtml(formatScore(rating?.score))}" data-rating-score="${season ?? ""}" aria-label="${escapeHtml(label)}" /></span>`;
  const sourceName = (source) => ({ anilist: "AniList", letterboxd: "Letterboxd" })[source] || source;

  function titleLvlBadgeMarkup(subject, record) {
    const ratings = record.data?.ratings || [];
    const result = lvlRatingSummary(ratings, subject.seasons);
    const score = result.score === null ? "—" : (Math.round((result.score + Number.EPSILON) * 10) / 10).toFixed(1);
    const scoreField = (season, value, label) => '<span class="title-lvl-score-value"><input type="text" inputmode="decimal"'
      + ' autocomplete="off" spellcheck="false" maxlength="5" placeholder="" value="' + (value === null ? "" : formatScore(value))
      + '" data-rating-score="' + (season ?? "") + '" aria-label="' + escapeHtml(label) + '" /><span>/10</span>'
      + (value !== null ? '<button type="button" class="title-lvl-score-clear" data-rating-clear="' + (season ?? "")
        + '" aria-label="Clear ' + (season === null ? 'overall' : 'season ' + season) + ' LVL rating" title="Clear rating">×</button>' : '')
      + '</span>';
    const rows = result.rows.length
      ? result.rows.map((row) => '<div class="title-rating-season title-lvl-score-row"><div class="title-rating-season__head"><span>Season '
        + row.season + '</span>' + scoreField(row.season, row.score, 'Your LVL rating, season ' + row.season + ', from 1 to 10')
        + '</div></div>').join("")
      : '<div class="title-rating-season title-lvl-score-row"><div class="title-rating-season__head"><span>Overall LVL score</span>'
        + scoreField(null, result.legacyOverall, 'Your overall LVL rating from 1 to 10') + '</div></div>';
    const legacy = result.rows.length && result.legacyOverall !== null
      ? '<p class="title-lvl-legacy">Previous overall score: ' + formatScore(result.legacyOverall)
        + '/10 (not included in the season average)</p>' : '';
    const message = record.message || record.error || "";
    const coverage = result.total ? result.rated + " of " + result.total + " seasons rated" : "Your local LVL score";
    return '<details class="title-rating-wrap title-lvl-rating-wrap" data-title-rating-provider="LVL">'
      + '<summary class="title-rating" aria-label="LVL ' + escapeHtml(score) + ' out of 10; show your season ratings">'
      + icon("star") + '<strong>' + score + '</strong><span>LVL</span>' + icon("chevron-down") + '</summary>'
      + '<div class="title-rating-breakdown"><div class="title-rating-breakdown__heading"><strong>Your LVL ratings</strong></div>'
      + '<p class="title-rating-breakdown__hint">' + escapeHtml(coverage) + '</p>'
      + '<div class="title-lvl-score-list">' + rows + '</div>' + legacy
      + (message ? '<p class="title-lvl-save-message' + (record.messageError ? ' is-error' : '') + '" role="status">'
        + escapeHtml(message) + '</p>' : '')
      + '</div></details>';
  }

  function titleWatchStatusMarkup(subject, record) {
    const own = (record.data?.ratings || []).find((rating) => rating.source === "app" && !Number.isInteger(rating.season));
    const linked = subject.anilist?.status || (() => {
      const values = (subject.anilist?.seasons || []).map((part) => part.status).filter(Boolean);
      return values.length && values.every((value) => value === values[0]) ? values[0] : "";
    })();
    const status = own?.status || (linked === "REPEATING" ? "CURRENT" : linked) || "";
    const options = ["CURRENT", "COMPLETED", "PLANNING", "PAUSED", "DROPPED"]
      .map((value) => '<option value="' + value + '"' + (status === value ? ' selected' : '')
        + '>' + STATUS_LABELS[value] + '</option>').join("");
    return '<select data-rating-status aria-label="Watch status for ' + escapeHtml(subject.title || 'this title')
      + '" title="LVL watch status; AniList status is shown when no local status is set">'
      + '<option value=""' + (!status ? ' selected' : '') + '>Watch status</option>' + options + '</select>';
  }

  function paintTitleLvlBadge(subject, record) {
    const slot = $("#title-lvl-rating-slot");
    const statusSlot = $("#title-watch-status-slot");
    if (statusSlot) {
      const statusMarkup = subject ? titleWatchStatusMarkup(subject, record) : "";
      if (statusSlot.dataset.rendered !== statusMarkup) {
        const focused = statusSlot.contains(document.activeElement);
        statusSlot.innerHTML = statusMarkup;
        statusSlot.dataset.rendered = statusMarkup;
        if (focused) statusSlot.querySelector("[data-rating-status]")?.focus({ preventScroll: true });
      }
    }
    if (!slot) return;
    if (!subject) { slot.innerHTML = ""; delete slot.dataset.rendered; return; }
    const markup = titleLvlBadgeMarkup(subject, record);
    if (slot.dataset.rendered !== markup) {
      const opened = slot.querySelector(".title-lvl-rating-wrap")?.open;
      const active = slot.contains(document.activeElement) ? document.activeElement : null;
      const field = active?.hasAttribute("data-rating-score") ? active.dataset.ratingScore : null;
      slot.innerHTML = markup;
      slot.dataset.rendered = markup;
      if (opened) slot.querySelector(".title-lvl-rating-wrap").open = true;
      if (field !== null) {
        const selector = `[data-rating-score="${field}"]`;
        slot.querySelector(selector)?.focus({ preventScroll: true });
      }
    }
  }

  function titleRatingMarkup(subject, record) {
    if (record.pending && !record.data) return "";
    const ratings = record.data?.ratings || [];
    const mine = ratings.filter((rating) => rating.source === "app");
    const overall = mine.find((rating) => !Number.isInteger(rating.season));
    const bySeason = new Map(mine.filter((rating) => Number.isInteger(rating.season)).map((rating) => [rating.season, rating]));
    const syncScores = getAniListScoreSyncState().enabled && ["anime", "anime-movie"].includes(subject.kind);
    const pendingScore = (season) => syncScores ? getAniListScorePending(subject, season) : null;
    const shownRating = (season, local) => {
      const part = resolveAniListScorePart(subject.anilist, season);
      if (!part) return local;
      const remoteScore = Number.isFinite(part.score) && part.score > 0 ? part.score : null;
      // Remote-only scores are already recorded as AniList-sourced signals in
      // recommendations. Display them in the editor even when automatic writes
      // are OFF, without inventing a second local app rating.
      if (!syncScores) return Number.isFinite(local?.score) ? local
        : remoteScore !== null ? { ...local, score: remoteScore } : local;
      // A failed/conflicting score write leaves a real local change. Do not
      // hide it beneath the previous imported score after a Library refresh.
      const pending = pendingScore(season);
      if (pending) return { ...local, score: pending.score };
      // A manual/automatic link can know the media ID without the anime being
      // present on the signed-in user's AniList list. Such a link has no remote
      // score authority: don't erase the user's saved local app rating.
      if (!part.status && !Number.isInteger(part.progress)) return local;
      // The authenticated list is canonical for this score when two-way sync
      // is enabled; leave local status unchanged. Avoid stale 'app' display.
      // If AniList has no score yet, keep a local rating visible until the
      // explicit, verified missing-score reconciliation has succeeded.
      return { ...local, score: remoteScore ?? local?.score ?? null };
    };
    const imported = ratings.filter((rating) => rating.source !== "app");
    const name = subject.title || "this title";
    const tip = helpTipMarkup({ id: "tip-title-your-rating", label: "About LVL ratings", content: "<strong>LVL ratings</strong><p>Rate each season from 1 to 10. Your LVL title score is the arithmetic mean of the seasons you rated, without importing other websites' scores. Optional AniList syncing sends verified individual season scores rounded to one decimal; the LVL mean is never sent as a season score.</p>" });
    const statusOptions = ["COMPLETED", "CURRENT", "PAUSED", "DROPPED", "PLANNING"]
      .map((value) => `<option value="${value}"${overall?.status === value ? " selected" : ""}>${STATUS_LABELS[value]}</option>`).join("");
    const clear = overall ? buttonMarkup({ label: "Clear", variant: "ghost", size: "sm", attrs: { "data-rating-clear": "" } }) : "";
    const retry = (season) => pendingScore(season)
      ? buttonMarkup({ label: "Retry AniList", variant: "ghost", size: "sm", attrs: { "data-rating-retry": season ?? "" } }) : "";
    const importedMarkup = imported.length
      ? `<div class="recs-imported"><span class="recs-imported__label">On your lists</span>${imported.map((rating) => {
        const label = rating.seasonNumber > 1 ? `Season ${rating.seasonNumber}` : rating.itemTitle || rating.title;
        const value = hasScore(rating.score) ? formatScore(rating.score) : STATUS_LABELS[rating.status] || "";
        return `<span class="recs-imported__item">${badgeMarkup(sourceName(rating.source), { variant: "outline" })}<span>${escapeHtml(label)}</span>${value ? `<strong>${escapeHtml(value)}</strong>` : ""}</span>`;
      }).join("")}</div>`
      : "";
    const seasons = subject.seasons || [];
    const key = titleCacheKey(subject);
    const summary = lvlRatingSummary(ratings, seasons);
    const average = summary.score === null ? "—" : summary.score.toFixed(2) + "/10";
    const seasonMarkup = seasons.length ? '<div class="recs-seasons__list">' + seasons.map((season) =>
      '<div class="recs-season"><span class="recs-season__label">Season ' + season + '</span>'
      + scoreInput(season, bySeason.get(season), 'Your LVL rating of ' + name + ' season ' + season + ', 1 to 10')
      + retry(season)
      + (bySeason.has(season) ? iconButtonMarkup({ icon: "close", label: 'Clear LVL rating of season ' + season, size: "sm", attrs: { "data-rating-clear": String(season) } }) : "")
      + '</div>').join("") + '</div>' : "";
    // Historical overall entries remain available without being counted as
    // artificial season scores. Imported list scores are never LVL ratings.
    const legacyMarkup = !seasons.length || overall || seasons.length === 1
      ? '<div class="recs-overall-legacy"><label>'
        + (seasons.length ? "Previous overall score (not part of season average)" : "Overall LVL score")
        + scoreInput(null, shownRating(null, overall), 'Overall LVL rating of ' + name + ', 1 to 10')
        + '</label>' + clear + retry(null) + '</div>' : "";
    const importedFold = importedMarkup ? '<details class="recs-imported-fold"><summary>On your lists ('
      + imported.length + ')</summary>' + importedMarkup + '</details>' : "";
    const message = record.message || record.error || (pendingScore(null) || seasons.some((season) => pendingScore(season)) ? "A local AniList score change is not yet confirmed. Use Retry AniList to try again; remote changes are never overwritten automatically." : "");
    return '<div class="title-lvl-editor-bar"><div class="title-lvl-editor-identity">'
      + '<h2 id="title-your-rating-heading">LVL rating</h2><span>'
      + (seasons.length ? summary.rated + '/' + summary.total + ' seasons rated' : 'Local rating')
      + '</span><strong aria-label="LVL score">' + average + '</strong></div>'
      + '<div class="settings-field recs-status-select"><select data-rating-status aria-label="Your status for '
      + escapeHtml(name) + '"><option value="">No status</option>' + statusOptions + '</select></div>' + tip + '</div>'
      + '<details class="recs-rating-editor" data-rating-editor' + (seasonsOpen.has(key) ? ' open' : '') + '>'
      + '<summary>' + (seasons.length ? 'Edit season ratings' : 'Edit LVL rating') + '</summary>'
      + '<div class="recs-rating-editor__body">' + seasonMarkup + legacyMarkup
      + (syncScores ? '<p class="recs-row__note">AniList sync is enabled. Only verified individual season scores can sync (one decimal). Your LVL average stays local.</p>' : '')
      + '</div></details>' + importedFold
      + '<p class="title-your-rating__status' + (record.messageError || (!record.message && record.error) ? ' is-error' : '')
      + '" role="status" aria-live="polite">' + escapeHtml(message || "") + '</p>';
  }

  // Re-render the block only when it changed, keeping focus on the same field.
  function setTitleNode(node, markup) {
    if (rendered.get(node) === markup) return;
    const active = node.contains(document.activeElement) ? document.activeElement : null;
    const focusKey = active?.dataset.ratingScore !== undefined ? `[data-rating-score="${active.dataset.ratingScore}"]` : active?.hasAttribute("data-rating-status") ? "[data-rating-status]" : "";
    rendered.set(node, markup);
    node.innerHTML = markup;
    node.hidden = !markup;
    if (focusKey) node.querySelector(focusKey)?.focus();
  }

  /** subject: { catalogId, seriesKey, title, year, kind, seasons: [1, 2, …] } or null. */
  function renderTitleRating(node, subject) {
    if (!node) return;
    titleNow = subject && (subject.catalogId || subject.seriesKey) && subject.title ? subject : null;
    if (!titleNow) {
      setTitleNode(node, "");
      paintTitleLvlBadge(null);
      return;
    }
    const record = titleRecord(titleNow);
    setTitleNode(node, titleRatingMarkup(titleNow, record));
    paintTitleLvlBadge(titleNow, record);
  }

  function readScore(input) {
    const raw = String(input?.value || "").trim().replace(",", ".");
    if (!raw) return { score: null };
    if (!/^\d{1,2}(?:\.\d*)?$/.test(raw)) return { error: "Enter a number from 1 to 10, like 7.56" };
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 1 || value > 10) return { error: "A rating is from 1 to 10" };
    return { score: Math.round(value * 100) / 100 };
  }

  function showTitleRatingMessage(node, subject, message, messageError = false) {
    // AniList imports invalidate the rating cache during an async save. Use
    // the current record, not a detached record from before the refresh.
    const record = titleRecord(subject);
    record.message = message;
    record.messageError = messageError;
    const sameTitle = () => titleNow && titleCacheKey(titleNow) === titleCacheKey(subject);
    if (sameTitle()) renderTitleRating(node, titleNow);
    clearTimeout(record.timer);
    record.timer = setTimeout(() => { record.message = ""; if (sameTitle()) renderTitleRating(node, titleNow); }, 4000);
  }

  function queueTitleRating(subject, action) {
    // HTTP responses can complete out of order. Serialize edits on the same
    // title in user-event order, including local saves and AniList round trips.
    const key = titleCacheKey(subject);
    const previous = titleWrites.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    titleWrites.set(key, next);
    void next.finally(() => { if (titleWrites.get(key) === next) titleWrites.delete(key); }).catch(() => {});
    return next;
  }

  function saveTitleRating(node, season, changes) {
    const subject = titleNow; // Capture before navigation or async changes.
    if (!subject) return Promise.resolve();
    return queueTitleRating(subject, () => performSaveTitleRating(node, subject, season, changes));
  }

  async function performSaveTitleRating(node, subject, season, { score: inputScore, status, syncScore = false, statusOnly = false }) {
    const record = titleRecord(subject);
    // A status-only edit must not copy the score shown in the editor when that
    // score came from AniList. Resolve the saved app score only when this queued
    // action actually runs, after any preceding score edit has been committed.
    const local = statusOnly ? (record.data?.ratings || []).find((rating) => rating.source === "app"
      && (Number.isInteger(rating.season) ? rating.season : null) === season) : null;
    const score = statusOnly ? (local?.score ?? null) : inputScore;
    let message = "";
    let messageError = false;
    try {
      const data = await postJson("/api/ratings", { catalogId: subject.catalogId, seriesKey: subject.seriesKey, season, title: subject.title, kind: subject.kind, year: subject.year, score, status });
      record.data = { ratings: data.ratings || [] };
      message = score === null && !status ? "Rating cleared" : "Saved";
      loadedAt = 0;
      if (syncScore) {
        try {
          const result = await onRatingSaved(subject, season, score);
          if (result) message = result;
        } catch (error) {
          message = error.message || "Saved locally, but AniList score sync failed.";
          messageError = true;
        }
      }
    } catch (error) {
      message = error.message || "Couldn't save your rating";
      messageError = true;
    }
    showTitleRatingMessage(node, subject, message, messageError);
  }

  function retryTitleAniListScore(node, season) {
    const subject = titleNow;
    if (!subject) return Promise.resolve();
    return queueTitleRating(subject, () => performRetryTitleAniListScore(node, subject, season));
  }

  async function performRetryTitleAniListScore(node, subject, season) {
    const pending = getAniListScorePending(subject, season);
    if (!pending) return;
    try {
      const message = await onRatingSaved(subject, season, pending.score);
      showTitleRatingMessage(node, subject, message || "AniList score checked");
    } catch (error) {
      showTitleRatingMessage(node, subject, error.message || "AniList score is not confirmed.", true);
    }
  }

  function wireTitleRating(node) {
    if (!node) return;
    node.addEventListener("change", (event) => {
      // The badge in the hero edits the same local rating record as the
      // historical editor. Always re-render through the actual editor node,
      // never replace the entire hero with form markup.
      const saveNode = $("#title-your-rating") || node;
      const input = event.target.closest("[data-rating-score]");
      const select = event.target.closest("[data-rating-status]");
      const overallInput = node.querySelector('[data-rating-score=""]');
      const statusSelect = node.querySelector("[data-rating-status]");
      if (!input && !select) return;
      const season = input && input.dataset.ratingScore !== "" ? Number(input.dataset.ratingScore) : null;
      const read = select && !input ? { score: null } : readScore(input || overallInput);
      if (read.error) {
        const record = titleNow ? titleRecord(titleNow) : null;
        if (record) { record.message = read.error; record.messageError = true; renderTitleRating(saveNode, titleNow); }
        return;
      }
      void saveTitleRating(saveNode, season, { score: read.score, status: season === null ? statusSelect?.value || null : null,
        syncScore: Boolean(input), statusOnly: Boolean(select && !input) });
    });
    node.addEventListener("click", (event) => {
      const saveNode = $("#title-your-rating") || node;
      const retry = event.target.closest("[data-rating-retry]");
      if (retry) {
        const season = retry.dataset.ratingRetry === "" ? null : Number(retry.dataset.ratingRetry);
        void retryTitleAniListScore(saveNode, season); // No local status/progress edit on retry.
        return;
      }
      const button = event.target.closest("[data-rating-clear]");
      if (!button) return;
      const season = button.dataset.ratingClear === "" ? null : Number(button.dataset.ratingClear);
      void saveTitleRating(saveNode, season, { score: null, status: null, syncScore: true });
    });
    node.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && event.target.matches?.("[data-rating-score]")) {
        event.preventDefault();
        event.target.blur();
      }
    });
    node.addEventListener("toggle", (event) => {
      if (!event.target.matches?.("[data-rating-editor]") || !titleNow) return;
      const key = titleCacheKey(titleNow);
      if (event.target.open) seasonsOpen.add(key); else seasonsOpen.delete(key);
    }, true);
  }

  function wire() {
    $("#view-home")?.addEventListener("click", handlePicksClick);
    $("#library-picks")?.addEventListener("click", handlePicksClick);
    wireSettings();
    wireTitleRating($("#title-your-rating"));
    wireTitleRating($("#title-hero"));
    void load().catch(() => {});
  }

  function invalidateRatings() {
    titleCache.clear();
    if (titleNow) onTitleChange();
  }
  return { wire, load, openPick, homePicksMarkup, paintLibrary, hasPicks, showSettings, renderTitleRating, refresh, invalidateRatings };
}
