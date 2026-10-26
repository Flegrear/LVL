// Read-only release schedule. Public title matches are display-only and do not
// authorize progress writes; airing dates do not imply playable streams.
import { artworkFallback, escapeHtml, icon } from "../ui/ui.js";
import { renderCalendarSurface } from "./calendar-surface.js";

const CALENDAR_PANEL_WIDTH_KEY = "lvl-calendar-panel-width-v1";
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const day = (value) => new Date(value.getFullYear(), value.getMonth(), value.getDate(), 12);
export const calendarDateKey = (value) => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
export function validCalendarDate(value) {
  if (!datePattern.test(String(value || ""))) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function calendarWeekStart(value) {
  const date = day(value);
  date.setDate(date.getDate() - (date.getDay() + 6) % 7);
  return date;
}
export function calendarAddDays(value, count) {
  const date = day(value);
  date.setDate(date.getDate() + count);
  return date;
}
const asDay = (dateKey) => {
  const [year, month, date] = dateKey.split("-").map(Number);
  return new Date(year, month - 1, date, 12);
};
const chapterCode = (season, episode) => `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
const episodeWatched = (series, code) => {
  const marks = (series.sources || []).map((entry) => entry.watchedChapters?.[code]);
  if (marks.includes(false)) return false; // Manual undo has priority.
  if (marks.includes(true)) return true;
  return (series.sources || []).some((entry) => (entry.episodes || []).some((episode) =>
    String(episode.code || "").toUpperCase() === code && episode.progress?.finished === true));
};

/** Catalog metadata has a trustworthy date but normally NO airing hour. */
export function calendarLibraryEvents(seriesList = [], chapterLists = new Map()) {
  const events = new Map();
  for (const series of seriesList) {
    if (series.type === "movie" || !/^tt\d{5,12}$/.test(String(series.catalogId || ""))) continue;
    const list = chapterLists.get(series.catalogId);
    const specials = (list?.seasons || []).filter((item) => item.season === 0)
      .flatMap((item) => (item.episodes || []).map((episode) => ({ ...episode, season: 0 })));
    for (const episode of [...(list?.chapters || []), ...specials]) {
      if (!validCalendarDate(episode.released) || !Number.isInteger(episode.season) || episode.season < 0
        || !Number.isInteger(episode.episode) || episode.episode < 1) continue;
      const code = chapterCode(episode.season, episode.episode);
      const key = `${series.catalogId}:${code}`;
      if (events.has(key)) continue;
      events.set(key, {
        id: key, catalogId: series.catalogId, seriesKey: series.key, title: series.title,
        episodeTitle: String(episode.name || "").slice(0, 180), code,
        date: episode.released, time: null, artwork: series.coverUrl || "",
        thumbnail: episode.thumbnail || "", type: series.mediaKind === "anime" ? "anime" : "series",
        source: "Catalog air date", verifiedTime: false, watched: episodeWatched(series, code),
        preview: false,
      });
    }
  }
  return [...events.values()].sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
}

const comparableTitle = (title) => String(title || "").normalize("NFKD").toLowerCase()
  .replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

export function calendarAniListIds(library = []) {
  const ids = new Set();
  for (const series of library) for (const source of [series, ...(series.sources || [])]) {
    if (String(source.externalSource || "").toUpperCase() === "ANILIST") ids.add(String(source.externalId || ""));
    if (source.anilistId) ids.add(String(source.anilistId));
    if (source.anilist?.anilistId) ids.add(String(source.anilist.anilistId));
    for (const season of source.anilist?.seasons || []) if (season.anilistId) ids.add(String(season.anilistId));
    for (const link of [...(source.anilistManualLinks || []), ...(source.anilistAutoLinks || [])])
      if (link.anilistId) ids.add(String(link.anilistId));
  }
  return [...ids].filter((id) => /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id)))
    .map(Number).sort((a, b) => a - b).slice(0, 300);
}

/** Use verified ids first; an exact title/year match is display-only and never syncs progress. */
export function calendarMatchLibrary(events = [], library = []) {
  const byCatalog = new Map();
  const byAnime = new Map();
  const byTmdb = new Map();
  const byTitleYear = new Map();
  const assign = (map, key, series) => {
    if (!key) return;
    if (map.has(key) && map.get(key)?.key !== series.key) map.set(key, null);
    else if (!map.has(key)) map.set(key, series);
  };
  for (const series of library) {
    const animeIds = new Set();
    const tmdbIds = new Set();
    const sources = [series, ...(series.sources || [])];
    for (const source of sources) {
      if (String(source.externalSource || "").toUpperCase() === "ANILIST") animeIds.add(String(source.externalId || ""));
      if (source.anilistId) animeIds.add(String(source.anilistId));
      if (String(source.externalSource || "").toUpperCase() === "TMDB") tmdbIds.add(String(source.externalId || "").replace(/^movie:/, ""));
      if (source.anilist?.anilistId) animeIds.add(String(source.anilist.anilistId));
      for (const season of source.anilist?.seasons || []) if (season.anilistId) animeIds.add(String(season.anilistId));
      for (const link of [...(source.anilistManualLinks || []), ...(source.anilistAutoLinks || [])])
        if (link.anilistId) animeIds.add(String(link.anilistId));
      if (source.tmdbId) tmdbIds.add(String(source.tmdbId));
    }
    assign(byCatalog, series.catalogId, series);
    for (const id of animeIds) assign(byAnime, id, series);
    for (const id of tmdbIds) assign(byTmdb, id, series);
    const year = Number(String(series.releaseInfo || "").match(/\b(?:19|20)\d{2}\b/)?.[0]) || null;
    if (year) for (const title of [series.title, ...(series.aliases || [])]) {
      const normalized = comparableTitle(title);
      if (normalized) assign(byTitleYear, `${series.type === "movie" ? "movie" : "series"}:${year}:${normalized}`, series);
    }
  }
  return events.map((event) => {
    const family = [...new Set((event.source === "AniList" && Array.isArray(event.linkedAniListIds)
      ? event.linkedAniListIds : []).map((id) => byAnime.get(String(id))).filter(Boolean))];
    const match = (event.catalogId && byCatalog.get(event.catalogId))
      || (event.source === "AniList" && byAnime.get(String(event.providerId)))
      || (family.length === 1 && family[0])
      || (event.source === "TMDb" && byTmdb.get(String(event.providerId)))
      || byTitleYear.get(`${event.type === "movie" ? "movie" : "series"}:${event.date.slice(0, 4)}:${comparableTitle(event.title)}`);
    const compatible = match && (event.type === "movie" ? match.type === "movie"
      : match.type !== "movie" && (event.type !== "anime" || match.mediaKind === "anime"));
    if (!compatible) return { ...event, inMyList: false };
    const code = String(event.code || "");
    return { ...event, inMyList: true, title: event.source === "AniList" ? event.title || match.title : match.title || event.title,
      type: match.type === "movie" ? "movie" : match.mediaKind === "anime" ? "anime" : "series",
      artwork: event.source === "AniList" ? event.artwork || match.coverUrl : match.coverUrl || event.artwork,
      fallbackArtwork: event.source === "AniList" ? match.coverUrl || "" : event.artwork || "",
      seriesKey: match.key,
      catalogId: match.catalogId || event.catalogId || "",
      watched: /^S\d{2}E\d{2,3}$/.test(code) ? episodeWatched(match, code) : false };
  });
}

// Only exact IMDb title/chapter identities can be used for a torrent lookup.
// AniList's EP N numbering can differ from a catalog season, so it remains unknown.
export function calendarTorrentLookup(event) {
  const catalogId = String(event?.catalogId || "");
  if (!/^tt\d{5,12}$/.test(catalogId)) return null;
  if (event.type === "movie") return { type: "movie", id: catalogId };
  const code = /^S(\d{2,3})E(\d{2,4})$/i.exec(String(event.code || ""));
  if (!code) return null;
  return { type: "series", id: `${catalogId}:${Number(code[1])}:${Number(code[2])}` };
}

export function calendarTorrentSummary(payload) {
  const providers = Array.isArray(payload?.providers) ? payload.providers : [];
  if (providers.length && !providers.some((provider) => provider.ok)) return "Torrent providers unavailable";
  const streams = Array.isArray(payload?.streams) ? payload.streams : [];
  if (!streams.length) return "No torrents found by the configured providers";
  const peers = Math.max(0, ...streams.map((stream) => Number(stream?.peers) || 0));
  return `${streams.length} torrent source${streams.length === 1 ? "" : "s"} - up to ${peers} reported peer${peers === 1 ? "" : "s"}`;
}

/** Stream providers sort peers-first; show the best real report without guessing peers. */
export function calendarBestSource(payload) {
  const providers = Array.isArray(payload?.providers) ? payload.providers : [];
  if (providers.length && !providers.some((provider) => provider.ok)) return "Torrent providers unavailable";
  const streams = Array.isArray(payload?.streams) ? payload.streams : [];
  if (!streams.length) return "No torrent sources found";
  const [best] = [...streams].sort((a, b) =>
    (Number(b?.peers) || 0) - (Number(a?.peers) || 0) || (Number(b?.score) || 0) - (Number(a?.score) || 0));
  const rawName = String(best?.title || best?.label || best?.provider || "Torrent source")
    .split("\n")[0].replace(/\s+/g, " ").trim();
  const name = rawName.length > 42 ? `${rawName.slice(0, 41).trimEnd()}…` : rawName || "Torrent source";
  const peers = Number(best?.peers);
  return `Best source: ${name} - ${Number.isFinite(peers) && peers >= 0 ? `${Math.floor(peers)} reported peers` : "Peers unavailable"}`;
}

// Keep decoded poster nodes alive while schedule updates replace their cards.
// Matching on the original artwork URL also preserves a successfully loaded
// fallback after the primary image failed.
export function paintCalendarSurface(root, markup, doc = typeof document === "undefined" ? null : document) {
  if (!doc?.createElement || !root?.replaceChildren || !root.querySelectorAll) {
    root.innerHTML = markup;
    return;
  }
  const template = doc.createElement("template");
  template.innerHTML = markup;
  const imageKey = (img) => `${img.dataset.calendarImageKey}\0${img.dataset.calendarImageSource}\0${img.parentElement?.className || ""}`;
  const oldImages = new Map();
  for (const img of root.querySelectorAll("img[data-calendar-image-key]")) {
    const key = imageKey(img);
    if (!oldImages.has(key)) oldImages.set(key, []);
    oldImages.get(key).push(img);
  }
  for (const img of template.content.querySelectorAll("img[data-calendar-image-key]")) {
    const previous = oldImages.get(imageKey(img))?.shift();
    if (previous) img.replaceWith(previous);
  }
  root.replaceChildren(template.content);
}

export function createCalendarView({
  root, getSeries, getChapterList, openTitle, storage = localStorage,
  now = () => new Date(),
  checkTorrentAvailability = async ({ type, id }) => {
    const response = await fetch(`/api/streams?type=${type}&id=${encodeURIComponent(id)}`);
    if (!response.ok) throw new Error(`Torrent lookup failed (${response.status})`);
    return response.json();
  },
  fetchReleases = async ({ from, to, force = false, anilistIds = [], scope = "list" }) => {
    const response = await fetch(`/api/calendar/releases?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&scope=${scope}${force ? "&refresh=1" : ""}${scope === "list" && anilistIds.length ? `&anilistIds=${anilistIds.join(",")}` : ""}`);
    if (!response.ok) throw new Error(`Calendar request failed (${response.status})`);
    return response.json();
  },
}) {
  let mode = "month";
  let type = "all";
  const scope = "list";
  let anchor = day(now());
  let selected = "";
  let selectedDay = calendarDateKey(anchor);
  let hourFocus = "";
  let agendaLimit = 80;
  let active = false;
  let realEvents = [];
  let publicEvents = [];
  let coverage = {};
  let releaseState = "idle";
  let releaseUpdatedAt = "";
  let publicRange = "";
  let requestSerial = 0;
  let libraryPending = false;
  let trackedSeriesCount = 0;
  let indexedSeriesCount = 0;
  let panelWidth = 340;
  let lastTimelineKey = "";
  let draggingPanel = null;
  let librarySeries = [];
  let mergedEvents = [];
  const torrentCache = new Map();
  let sourceDetailKey = "";
  let lastMarkup = "";
  let hoveredTorrentId = "";
  let hoverTimer = null;
  const chapterQueue = [];
  const queuedChapters = new Set();
  const pendingChapters = new Set();
  const attemptedChapters = new Map();
  let chapterRefreshTimer = null;
  try { panelWidth = Math.max(240, Math.min(520, Number(storage.getItem(CALENDAR_PANEL_WIDTH_KEY)) || 340)); } catch {}
  const lists = new Map();
  const rebuildMerged = () => {
    const matchedLocal = new Set();
    const sourced = calendarMatchLibrary(publicEvents, librarySeries)
      .filter((event) => event.inMyList)
      .map((event) => {
        const dated = event.timestamp ? { ...event, date: calendarDateKey(new Date(event.timestamp)) } : event;
        if (calendarTorrentLookup(dated)) return dated;
        // A catalog date uniquely identifying one saved chapter can resolve
        // AniList's absolute EP numbering without guessing a season mapping.
        const candidates = realEvents.filter((local) => local.catalogId && local.catalogId === dated.catalogId
          && local.date === dated.date);
        if (candidates.length !== 1) return dated;
        const chapter = candidates[0];
        matchedLocal.add(chapter.id);
        return { ...dated, code: chapter.code, episodeTitle: chapter.episodeTitle || dated.episodeTitle };
      });
    const seen = new Set(sourced.map((event) => `${comparableTitle(event.title)}:${event.code}:${event.date}`));
    const local = realEvents.filter((event) => {
      if (matchedLocal.has(event.id)) return false;
      const key = `${comparableTitle(event.title)}:${event.code}:${event.date}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).map((event) => ({ ...event, inMyList: true }));
    mergedEvents = [...sourced, ...local]
      .sort((a, b) => a.date.localeCompare(b.date) || (a.timestamp || 0) - (b.timestamp || 0));
  };
  const updateLocalEvents = (paint = true) => {
    indexedSeriesCount = librarySeries.filter((item) => item.type !== "movie"
      && /^tt\d{5,12}$/.test(item.catalogId || "") && lists.has(item.catalogId)).length;
    libraryPending = indexedSeriesCount < trackedSeriesCount;
    realEvents = calendarLibraryEvents(librarySeries, lists);
    rebuildMerged();
    if (active && paint) render();
  };
  const scheduleChapterRefresh = () => {
    if (chapterRefreshTimer !== null) return;
    chapterRefreshTimer = setTimeout(() => {
      chapterRefreshTimer = null;
      updateLocalEvents();
    }, 100);
    chapterRefreshTimer.unref?.();
  };
  // Catalog metadata is requested in a bounded queue: one completed title no
  // longer triggers another full scan and DOM rebuild for every saved title.
  const pumpChapters = () => {
    while (pendingChapters.size < 6 && chapterQueue.length) {
      const id = chapterQueue.shift();
      queuedChapters.delete(id);
      if (lists.has(id)) continue;
      pendingChapters.add(id);
      attemptedChapters.set(id, Date.now());
      const timeout = setTimeout(() => {
        if (pendingChapters.delete(id)) pumpChapters();
      }, 30_000);
      timeout.unref?.();
      const onReady = (record) => {
        clearTimeout(timeout);
        pendingChapters.delete(id);
        if (record) lists.set(id, record);
        scheduleChapterRefresh();
        pumpChapters();
      };
      try {
        const record = getChapterList(id, onReady);
        if (record) onReady(record);
      } catch { onReady(null); }
    }
  };
  const visible = () => mergedEvents.filter((event) => type === "all" || event.type === type);
  const range = () => {
    const from = mode === "week" ? calendarWeekStart(anchor)
      : calendarWeekStart(new Date(anchor.getFullYear(), anchor.getMonth(), 1, 12));
    const to = mode === "week" ? calendarAddDays(from, 6)
      : calendarAddDays(calendarWeekStart(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0, 12)), 6);
    return { from, to, first: calendarDateKey(from), last: calendarDateKey(to) };
  };
  const inRange = (event, value = range()) => event.date >= value.first && event.date <= value.last;
  const refreshReal = ({ limit = 128 } = {}) => {
    librarySeries = getSeries();
    const series = librarySeries.filter((item) => item.type !== "movie" && /^tt\d{5,12}$/.test(item.catalogId || ""));
    trackedSeriesCount = series.length;
    for (const item of series.slice(0, limit)) {
      const id = item.catalogId;
      if (lists.has(id)) continue;
      if (queuedChapters.has(id) || pendingChapters.has(id)
        || Date.now() - (attemptedChapters.get(id) || 0) < 60_000) continue;
      chapterQueue.push(id);
      queuedChapters.add(id);
    }
    pumpChapters();
    updateLocalEvents(false);
  };
  const refreshPublic = (force = false) => {
    if (!librarySeries.length) {
      ++requestSerial;
      publicRange = "";
      publicEvents = [];
      coverage = {};
      releaseState = "ready";
      rebuildMerged();
      render();
      return;
    }
    const { first, last } = range();
    const anilistIds = calendarAniListIds(librarySeries);
    const key = `${scope}:${first}:${last}:${anilistIds.join(",")}`;
    if (!force && publicRange === key && releaseState !== "error") return;
    publicRange = key;
    const serial = ++requestSerial;
    releaseState = "loading";
    const segments = [{ from: first, to: last, force, anilistIds, scope }];
    Promise.allSettled(segments.map((segment) => fetchReleases(segment))).then((responses) => {
      if (serial !== requestSerial) return;
      const successes = responses.filter((result) => result.status === "fulfilled").map((result) => result.value);
      const rows = new Map();
      coverage = {};
      for (const result of successes) {
        for (const event of result?.events || []) if (event?.id && validCalendarDate(event.date)) rows.set(event.id, event);
        for (const [provider, info] of Object.entries(result?.coverage || {})) {
          const existing = coverage[provider]?.status;
          const status = info?.status || "unavailable";
          coverage[provider] = { status: existing && existing !== status
            ? existing === "needs_key" || status === "needs_key" ? "needs_key" : "partial" : status };
        }
      }
      publicEvents = [...rows.values()];
      rebuildMerged();
      releaseUpdatedAt = successes.find((result) => result?.updatedAt)?.updatedAt || "";
      if (successes.length < segments.length) {
        for (const provider of Object.keys(coverage)) if (coverage[provider].status === "ok") coverage[provider].status = "partial";
      }
      releaseState = successes.length ? "ready" : "error";
      render();
    });
  };
  const render = () => {
    if (!root) return;
    const oldTimeline = root.querySelector?.(".calendar-timeline-scroll");
    const oldWeek = root.querySelector?.(".calendar-week-view");
    const oldAgenda = root.querySelector?.(".calendar-agenda-list");
    const timelineScroll = oldTimeline?.scrollTop || 0;
    const weekScroll = oldWeek?.scrollLeft || 0;
    const agendaScroll = oldAgenda?.scrollTop || 0;
    const timelineKey = `${mode}:${calendarDateKey(mode === "week" ? calendarWeekStart(anchor) : anchor)}`;
    const sameTimeline = lastTimelineKey === timelineKey;
    const focused = typeof document !== "undefined" && root.contains?.(document.activeElement)
      ? document.activeElement?.dataset.calendarEvent : null;
    const dates = range();
    const period = visible().filter((event) => inRange(event, dates));
    if (selected && !period.some((event) => event.id === selected)) selected = "";
    const selectedEvent = period.find((event) => event.id === selected);
    const lookup = calendarTorrentLookup(selectedEvent);
    const detailKey = lookup ? `${lookup.type}:${lookup.id}` : "";
    const sourceDetail = sourceDetailKey === detailKey ? torrentCache.get(detailKey)?.best || null : null;
    const markup = renderCalendarSurface({
      mode, anchor, today: now(), type, scope, events: period, selected, selectedDay,
      agendaLimit, hourFocus, coverage, releaseState, releaseUpdatedAt,
      libraryPending, indexedSeriesCount, trackedSeriesCount, savedTitleCount: librarySeries.length, panelWidth,
      sourceDetail, sourceAvailable: Boolean(lookup),
    });
    // Avoid tearing down the calendar for unchanged results (including images
    // and the focused/hovered card).
    if (markup === lastMarkup && root.querySelector?.(".calendar-growie")) return;
    paintCalendarSurface(root, markup);
    lastMarkup = markup;
    const newTimeline = root.querySelector?.(".calendar-timeline-scroll");
    const newWeek = root.querySelector?.(".calendar-week-view");
    const newAgenda = root.querySelector?.(".calendar-agenda-list");
    if (newTimeline) {
      if (newWeek) {
        newWeek.scrollLeft = sameTimeline ? weekScroll : 0;
        const scrollbarWidth = Math.max(0, (newTimeline.offsetWidth || 0) - (newTimeline.clientWidth || 0));
        newWeek.style?.setProperty?.("--calendar-week-gutter", `${scrollbarWidth}px`);
      }
      if (sameTimeline) newTimeline.scrollTop = timelineScroll;
      else {
        const nowDate = now();
        const todayVisible = mode === "week"
          && calendarDateKey(calendarWeekStart(anchor)) === calendarDateKey(calendarWeekStart(nowDate));
        const firstTimed = period.find((event) => event.timestamp);
        const initialHour = todayVisible ? nowDate.getHours() - 2
          : firstTimed ? new Date(firstTimed.timestamp).getHours() - 2 : 7;
        newTimeline.scrollTop = Math.max(0, initialHour) * 60;
      }
    }
    lastTimelineKey = timelineKey;
    hoveredTorrentId = "";
    if (newAgenda) newAgenda.scrollTop = agendaScroll;
    if (focused) [...(root.querySelectorAll?.("[data-calendar-event]") || [])]
      .find((button) => button.dataset.calendarEvent === focused)?.focus({ preventScroll: true });
  };
  const refresh = () => {
    if (active) { refreshReal(); refreshPublic(); }
    render();
  };
  const changePeriod = () => { if (active) refreshPublic(); render(); };
  const setPanelWidth = (width) => {
    panelWidth = Math.max(240, Math.min(520, Math.round(width)));
    root?.querySelector?.(".calendar-growie")?.style.setProperty("--calendar-panel-width", `${panelWidth}px`);
    root?.querySelector?.("[data-calendar-resize]")?.setAttribute("aria-valuenow", String(panelWidth));
  };
  const showTorrentTooltip = (button, event, message) => {
    const tip = root?.querySelector?.(".calendar-torrent-tooltip");
    if (!tip || hoveredTorrentId !== event.id) return;
    tip.textContent = `${event.title} - ${event.code || "Premiere"}: ${message}`;
    tip.hidden = false;
    const rect = button.getBoundingClientRect?.();
    if (rect && typeof window !== "undefined") {
      tip.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 310))}px`;
      tip.style.top = `${rect.bottom + 10 + 90 < window.innerHeight ? rect.bottom + 8 : Math.max(8, rect.top - 68)}px`;
    }
  };
  const torrentResult = (lookup) => {
    const key = `${lookup.type}:${lookup.id}`;
    const cached = torrentCache.get(key);
    if (cached?.expiresAt > Date.now()) return Promise.resolve(cached);
    if (cached?.promise) return cached.promise;
    const promise = Promise.resolve().then(() => checkTorrentAvailability(lookup))
      .then((payload) => ({ message: calendarTorrentSummary(payload), best: calendarBestSource(payload),
        expiresAt: Date.now() + 3 * 60_000 }))
      .catch(() => ({ message: "Torrent lookup unavailable", best: "Torrent lookup unavailable",
        expiresAt: Date.now() + 30_000 }))
      .then((result) => { torrentCache.set(key, result); return result; });
    torrentCache.set(key, { promise });
    if (torrentCache.size > 100) torrentCache.delete(torrentCache.keys().next().value);
    return promise;
  };
  const inspectTorrent = (button) => {
    const event = visible().find((item) => item.id === button?.dataset?.calendarEvent);
    if (!event) return;
    hoveredTorrentId = event.id;
    const lookup = calendarTorrentLookup(event);
    if (!lookup) { showTorrentTooltip(button, event, "Exact stream ID unavailable"); return; }
    const key = `${lookup.type}:${lookup.id}`;
    const cached = torrentCache.get(key);
    if (cached?.expiresAt > Date.now()) {
      showTorrentTooltip(button, event, cached.message);
      return;
    }
    showTorrentTooltip(button, event, "Checking torrent availability…");
    void torrentResult(lookup).then(({ message }) => {
      if (hoveredTorrentId === event.id) showTorrentTooltip(button, event, message);
    });
  };
  const hideTorrentTooltip = () => {
    clearTimeout(hoverTimer);
    hoveredTorrentId = "";
    const tip = root?.querySelector?.(".calendar-torrent-tooltip");
    if (tip) tip.hidden = true;
  };
  root?.addEventListener("pointerover", (event) => {
    const button = event.target.closest?.("[data-calendar-event]");
    if (!button || button.contains?.(event.relatedTarget)) return;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => inspectTorrent(button), 220);
  });
  root?.addEventListener("pointerout", (event) => {
    const button = event.target.closest?.("[data-calendar-event]");
    if (button && !button.contains?.(event.relatedTarget)) hideTorrentTooltip();
  });
  root?.addEventListener("focusin", (event) => {
    const button = event.target.closest?.("[data-calendar-event]");
    if (button) inspectTorrent(button);
  });
  root?.addEventListener("focusout", (event) => {
    if (event.target.closest?.("[data-calendar-event]")) hideTorrentTooltip();
  });
  root?.addEventListener("pointerdown", (event) => {
    if (!event.target.closest?.("[data-calendar-resize]") || event.button !== 0) return;
    draggingPanel = { start: event.clientX, width: panelWidth };
    event.preventDefault();
  });
  if (typeof window !== "undefined") {
    window.addEventListener("pointermove", (event) => {
      if (draggingPanel) setPanelWidth(draggingPanel.width + event.clientX - draggingPanel.start);
    });
    window.addEventListener("pointerup", () => {
      if (!draggingPanel) return;
      draggingPanel = null;
      try { storage.setItem(CALENDAR_PANEL_WIDTH_KEY, String(panelWidth)); } catch {}
    });
  }
  root?.addEventListener("keydown", (event) => {
    if (!event.target.closest?.("[data-calendar-resize]")) return;
    const offsets = { ArrowLeft: -24, ArrowRight: 24 };
    if (!(event.key in offsets) && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    setPanelWidth(event.key === "Home" ? 240 : event.key === "End" ? 520 : panelWidth + offsets[event.key]);
    try { storage.setItem(CALENDAR_PANEL_WIDTH_KEY, String(panelWidth)); } catch {}
  });
  root?.addEventListener("click", (e) => {
    const button = e.target.closest("button");
    if (!button) return;
    if (button.hasAttribute?.("data-calendar-best-source")) {
      const event = visible().find((item) => item.id === selected);
      const lookup = calendarTorrentLookup(event);
      if (!lookup) return;
      const key = `${lookup.type}:${lookup.id}`;
      sourceDetailKey = key;
      const result = root?.querySelector?.("[data-calendar-source-result]");
      if (result) result.textContent = "Checking best source…";
      void torrentResult(lookup).then(({ best }) => {
        if (sourceDetailKey === key && visible().some((item) => item.id === selected && item.id === event.id)) {
          const target = root?.querySelector?.("[data-calendar-source-result]");
          if (target) target.textContent = best;
        }
      });
      return;
    }
    if (button.dataset.calendarMode) {
      if (!["week", "month"].includes(button.dataset.calendarMode)) return;
      mode = button.dataset.calendarMode; selected = ""; hourFocus = ""; agendaLimit = 80;
      changePeriod(); return;
    }
    if (button.dataset.calendarType) { type = button.dataset.calendarType; selected = ""; hourFocus = ""; agendaLimit = 80; render(); return; }
    if (button.dataset.calendarOpenDay) {
      const key = button.dataset.calendarOpenDay;
      if (!validCalendarDate(key)) return;
      mode = "week"; anchor = asDay(key); selectedDay = key; selected = ""; hourFocus = ""; agendaLimit = 80;
      changePeriod(); return;
    }
    if (button.dataset.calendarHour) {
      const [key, hour] = button.dataset.calendarHour.split(":");
      if (!validCalendarDate(key) || !(hour === "unknown" || /^(?:[0-9]|1[0-9]|2[0-3])$/.test(hour))) return;
      mode = "week"; anchor = asDay(key); selectedDay = key; selected = ""; hourFocus = hour; agendaLimit = 80;
      changePeriod(); return;
    }
    if (button.dataset.calendarDate) {
      const key = button.dataset.calendarDate;
      if (!validCalendarDate(key)) return;
      anchor = asDay(key); selectedDay = key; selected = ""; hourFocus = ""; agendaLimit = 80;
      if (mode === "month") mode = "week";
      changePeriod(); return;
    }
    if (button.hasAttribute("data-calendar-clear-hour")) { hourFocus = ""; agendaLimit = 80; render(); return; }
    if (button.hasAttribute("data-calendar-more")) { agendaLimit += 80; render(); return; }
    if (button.hasAttribute("data-calendar-close-detail")) { selected = ""; render(); return; }
    if (button.hasAttribute("data-calendar-retry")) {
      publicRange = "";
      refreshPublic(true);
      render();
      return;
    }
    if (button.dataset.calendarNav) {
      const action = button.dataset.calendarNav;
      if (action === "today") anchor = day(now());
      else if (mode === "week") anchor = calendarAddDays(anchor, 7 * (action === "next" ? 1 : -1));
      else anchor = new Date(anchor.getFullYear(), anchor.getMonth() + (action === "next" ? 1 : -1), 1, 12);
      selected = ""; selectedDay = calendarDateKey(anchor); hourFocus = ""; agendaLimit = 80; changePeriod(); return;
    }
    if (button.dataset.calendarEvent) { selected = button.dataset.calendarEvent; render(); return; }
    if (button.hasAttribute("data-calendar-open-title")) {
      const event = visible().find((row) => row.id === selected);
      if (event?.seriesKey || event?.catalogId) openTitle(event);
    }
  });
  root?.addEventListener("error", (e) => {
    const img = e.target;
    if (img?.tagName !== "IMG" || !img.dataset.calendarImageTitle || img.dataset.calendarImageFallback === "final") return;
    const stage = img.dataset.calendarImageFallback || "";
    const alternate = stage === "" ? img.dataset.calendarImageAlternate : stage === "alternate" ? img.dataset.calendarImageLast : "";
    if (/^https:\/\//.test(alternate || "") && img.src !== alternate) {
      img.dataset.calendarImageFallback = stage === "" ? "alternate" : "last";
      img.src = alternate;
    } else {
      img.dataset.calendarImageFallback = "final";
      img.src = artworkFallback(img.dataset.calendarImageTitle);
    }
  }, true);
  return {
    activate() { active = true; refresh(); },
    deactivate() { active = false; },
    refresh,
    scanRecent() { if (!active) refreshReal({ limit: 12 }); },
    getState: () => ({ mode, sourceMode: scope, type, selected, selectedDay, panelWidth, count: realEvents.length, publicCount: publicEvents.length, releaseState }),
  };
}
