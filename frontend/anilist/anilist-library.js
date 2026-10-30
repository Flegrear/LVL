// Your AniList list in the Library (browser, and Node for tests). The server groups the list into
// shows (recs-service anilistLibrary); this decides what the Library does with them: which titles
// to add, which of your own titles get their AniList status, and which earlier imports go.

export const ANILIST_STATUS_LABELS = Object.freeze({
  CURRENT: "Watching", REPEATING: "Rewatching", COMPLETED: "Completed", PAUSED: "Paused", DROPPED: "Dropped", PLANNING: "Plan to watch",
});
export const ANILIST_STATUS_FILTERS = Object.freeze(["CURRENT", "COMPLETED", "PLANNING", "PAUSED", "DROPPED"]);

// On-demand, browser-direct lookup for titles not already on a user's list.
// Never equate search rank with a verified media/season match: the user chooses
// a result and the app re-reads its ID before saving the explicit link.
export const ANILIST_LINK_SEARCH = `query ($search: String!) {
  Page(perPage: 12) { media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
    id format episodes seasonYear title { romaji english }
  } }
}`;
export const ANILIST_LINK_VERIFY = `query ($id: Int!) {
  Media(id: $id, type: ANIME) { id format episodes seasonYear title { romaji english } }
}`;
const laterAniListPart = /\b(?:(?:part|cour|split)\s*(?:2|ii|two|3|iii|three)|(?:2nd|3rd|second|third)\s+(?:part|cour))\b/i;
export const canLinkAniListTv = (media) => Number.isSafeInteger(media?.id) && media.id > 0
  && ["TV", "TV_SHORT", "ONA"].includes(media?.format)
  && Number.isSafeInteger(media?.episodes) && media.episodes > 0
  && ![media?.title?.english, media?.title?.romaji, media?.title].some((title) => typeof title === "string" && laterAniListPart.test(title));

/** What a Library entry keeps about its AniList show. */
export function anilistInfo(show = {}) {
  return {
    showId: show.showId || "",
    // Only an authenticated, viewer-verified import may set this. Public
    // username searches and historical imported metadata remain display-only.
    accountUserId: Number.isSafeInteger(show.accountUserId) && show.accountUserId > 0 ? show.accountUserId : null,
    anilistId: Number(show.anilistId) || null,
    averageScore: Number(show.averageScore) > 0 && Number(show.averageScore) <= 100 ? Number(show.averageScore) : null,
    url: show.url || "",
    status: show.status || null,
    cover: show.cover || "",
    updatedAt: Number(show.updatedAt) || null,
    seasons: (show.seasons || []).map(({ anilistId, season, title, format, episodes, status, progress, score }) => ({
      anilistId: Number(anilistId) || null, season: Number.isInteger(season) ? season : null, title: title || "", format: format || null,
      episodes: Number.isInteger(episodes) ? episodes : null, status: status || null, progress: Number.isInteger(progress) ? progress : null,
      score: Number.isFinite(score) ? score : null,
    })),
  };
}

/** Backfill only public AniList averages on existing Library entries. Never change
 * a user's status, personal score, season links, or imported titles. */
export function fillMissingAniListAverages(entries = [], shows = []) {
  const averages = new Map((shows || [])
    .filter((show) => show?.showId && Number(show.averageScore) > 0 && Number(show.averageScore) <= 100)
    .map((show) => [String(show.showId), Number(show.averageScore)]));
  let changed = 0;
  for (const entry of entries || []) {
    const info = entry?.anilist;
    if (!info?.showId || Number(info.averageScore) > 0) continue;
    const average = averages.get(String(info.showId));
    if (average === undefined) continue;
    info.averageScore = average;
    changed += 1;
  }
  return changed;
}

/** The id addCatalogPlaceholder gives an imported show (catalog page if known, else the AniList id). */
export function importedEntryId(show) {
  return show.imdbId
    ? `catalog:${show.type === "movie" ? "movie" : "series"}:${show.imdbId}`
    : `anilist:${String(show.anilistId || show.showId || "").replace(/^anilist:/, "").toLowerCase()}`;
}

/** Entries this sync manages: imported by it, or by the earlier importer (one entry per season, id "anilist:<id>"). */
export function isAniListImport(entry = {}) {
  return Boolean(entry.anilistImported) || (entry.externalSource === "ANILIST" && /^anilist:\d+$/.test(String(entry.id || "")));
}

/** A username/title match is display-only. Authenticated progress is owned
 * by the saved title only after its catalog or explicit AniList ID agrees.
 */
export function verifiedAniListLibraryIdentity(series, show) {
  const catalog = String(show?.imdbId || "");
  if (/^tt\d{5,12}$/.test(catalog) && catalog === String(series?.catalogId || "")) return true;
  const mediaId = Number(show?.anilistId);
  return Number.isSafeInteger(mediaId) && mediaId > 0 && (series?.sources || []).some((entry) =>
    String(entry.externalSource || "").toUpperCase() === "ANILIST"
    && Number(entry.externalId) === mediaId);
}

/**
 * series: the Library's titles ({ key, catalogId, aliases, sources: entries }); shows: the server's
 * list; keyOf: the Library's name → key rule. Returns { add: [{ show, info }], annotate: [{ series, info }],
 * remove: [entry ids], clear: [entry ids] }.
 */
export function planAniListLibrary({ series = [], shows = [], keyOf = (name) => String(name || "").trim().toLowerCase() } = {}) {
  const byCatalog = new Map();
  const byKey = new Map();
  for (const item of series) {
    if (item.catalogId && !byCatalog.has(item.catalogId)) byCatalog.set(item.catalogId, item);
    if (!byKey.has(item.key)) byKey.set(item.key, item);
    for (const alias of item.aliases || []) if (!byKey.has(keyOf(alias))) byKey.set(keyOf(alias), item);
  }
  // A title made only of imported entries is the sync's own; one with anything else is yours.
  const importedOnly = (item) => item.sources.length > 0 && item.sources.every((entry) => isAniListImport(entry) && !(entry.episodes || []).length);
  const plan = { add: [], annotate: [], remove: [], clear: [] };
  const kept = new Set();
  const annotated = new Set();
  for (const show of shows) {
    const info = anilistInfo(show);
    const keys = [show.title, show.titleAlt].filter(Boolean).map(keyOf);
    const existing = (show.imdbId && byCatalog.get(show.imdbId)) || keys.map((key) => byKey.get(key)).find(Boolean) || null;
    if (existing && !importedOnly(existing)) {
      // A title you added yourself stays as it is, with your AniList status on it. An earlier
      // import inside it (no videos) adds nothing, and its small AniList cover could win over
      // your title's poster, so it goes.
      plan.annotate.push({ series: existing, info });
      existing.sources.forEach((entry) => {
        if (isAniListImport(entry) && !(entry.episodes || []).length) return;
        annotated.add(entry.id);
        kept.add(entry.id);
      });
      continue;
    }
    plan.add.push({ show, info });
    kept.add(importedEntryId(show));
  }
  // Earlier imports of shows no longer on your list (or saved under another id now, like the
  // earlier importer's one entry per season) go, unless they have videos; your own titles lose
  // a status that's no longer on your list.
  for (const item of series) {
    for (const entry of item.sources) {
      const imported = isAniListImport(entry);
      if (imported && !(entry.episodes || []).length && !kept.has(entry.id)) plan.remove.push(entry.id);
      else if (entry.anilist && !imported && !annotated.has(entry.id)) plan.clear.push(entry.id);
    }
  }
  return plan;
}

/** Imported list entries plus account-scoped verified season associations.
 * A manual selection or an exact complete public sequel/episode-count chain
 * can associate an unlisted series without pretending its MediaList exists.
 */
export function seriesAniList(series, userId = null) {
  const sources = series?.sources || [];
  const imported = sources.map((entry) => entry.anilist).find((info) => info?.showId) || null;
  if (!Number.isSafeInteger(userId) || userId <= 0) return imported;
  const ownedImported = imported?.accountUserId === userId ? imported : null;
  const manual = sources.flatMap((entry) => Array.isArray(entry.anilistManualLinks) ? entry.anilistManualLinks : [])
    .filter((part) => part?.userId === userId && Number.isInteger(part.season) && part.season > 0
      && canLinkAniListTv({ id: part.anilistId, episodes: part.episodes, format: part.format }))
    .map((part) => ({ anilistId: part.anilistId, season: part.season, episodes: part.episodes,
      format: part.format, title: part.title || "", status: null, progress: null, score: null }));
  const automatic = sources.flatMap((entry) => Array.isArray(entry.anilistAutoLinks) ? entry.anilistAutoLinks : [])
    .filter((part) => part?.userId === userId && Number.isInteger(part.season) && part.season > 0
      && Number.isSafeInteger(part.anilistId) && part.anilistId > 0
      && ["TV", "TV_SHORT", "ONA"].includes(part.format)
      && Number.isSafeInteger(part.episodes) && part.episodes > 0
      && Number.isSafeInteger(part.start) && part.start > 0
      && Number.isSafeInteger(part.end) && part.end === part.start + part.episodes - 1
      && part.catalogId === series.catalogId)
    .map((part) => ({ anilistId: part.anilistId, season: part.season, episodes: part.episodes,
      format: part.format, title: part.title || "", status: null, progress: null, score: null,
      start: part.start, end: part.end }));
  if (!manual.length && !automatic.length) return ownedImported;
  const mapped = [...(ownedImported?.seasons || [])].map((part) => ({ ...part }));
  const seen = new Set(mapped.map((part) => `${part.season}:${part.anilistId}`));
  for (const part of [...manual, ...automatic]) {
    const key = `${part.season}:${part.anilistId}`;
    if (seen.has(key)) {
      const saved = mapped.find((entry) => entry.season === part.season && entry.anilistId === part.anilistId);
      if (saved && Number.isInteger(part.start) && Number.isInteger(part.end)) {
        saved.start = part.start;
        saved.end = part.end;
      }
      continue;
    }
    seen.add(key);
    mapped.push(part);
  }
  const ranges = automatic.map((part) => ({ anilistId: part.anilistId, season: part.season,
    start: part.start, end: part.end }));
  return ownedImported ? { ...ownedImported, seasons: mapped, ranges }
    : { showId: `verified:${userId}`, anilistId: null, status: null, seasons: mapped, ranges };
}

/** Also show prior episode progress for completed and paused series. */
export function anilistProgressText(info) {
  const seasons = info?.seasons || [];
  const season = seasons.find((item) => (item.status === "CURRENT" || item.status === "REPEATING") && Number.isInteger(item.progress))
    || seasons.find((item) => item.status === "COMPLETED" && Number.isInteger(item.progress))
    || seasons.find((item) => Number.isInteger(item.progress) && item.progress > 0);
  if (!season || !Number.isInteger(season.progress)) return "";
  const where = Number.isInteger(season.season) ? `S${season.season} ` : "";
  return `${where}E${season.progress}${Number.isInteger(season.episodes) ? ` of ${season.episodes}` : ""}`;
}

/** Read-only presentation: no fake local video/watched entries. */
export function anilistWatchedSummary(info) {
  const seasons = info?.seasons || [];
  const watched = seasons.reduce((sum, season) => sum + (Number.isInteger(season.progress) && season.progress > 0 ? season.progress : 0), 0);
  const totalKnown = seasons.length > 0 && seasons.every((season) => Number.isInteger(season.episodes) && season.episodes > 0);
  const total = totalKnown ? seasons.reduce((sum, season) => sum + season.episodes, 0) : null;
  return { watched, total };
}

export function anilistRatingText(info) {
  const ratings = (info?.seasons || []).filter((season) => Number.isFinite(season.score) && season.score > 0);
  if (!ratings.length) return "";
  const score = ratings.reduce((sum, season) => sum + season.score, 0) / ratings.length;
  return `Your rating: ${Number(score.toFixed(1))}/10`;
}

/** Status key used by the Library's status filter (rewatching counts as watching). */
export function anilistStatusKey(info) {
  const status = info?.status || "";
  return status === "REPEATING" ? "CURRENT" : status;
}
