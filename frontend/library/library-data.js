// Library entries, series and chapters, and their artwork.
import { toast } from "../ui/ui.js";
import { libraryCategory } from "../catalog/home-feed.js";
import { libraryFileScope } from "../../shared/media/series-sources.js";
import { readAniListAccount } from "../anilist/anilist-auto-client.js";
import { state } from "../../app.js";
import { persistentAppStateReady, saveLibrary } from "../app/saved-state.js";
import { $ } from "../app/dom.js";
import { fetchJson } from "../app/http.js";
import { episodeIdentity, normalizeCollectionTitle, sourceTagFor } from "../player/player-tracks.js";
import { verifiedVideoWorkKey } from "../../shared/sync/video-state.js";
import { episodeSortKey, partitionTorrentVideos, sortedVideoFiles } from "../player/torrent-playback.js";
import { renderLibrary, updateLibrarySummary } from "./library-page.js";
import { catalogResultYear, compareLibrarySourceRefsByPeers } from "../catalog/catalog-search.js";
import { autoLinkNewlyAddedAnime } from "../anilist/anilist-sync.js";

const artworkFetches = new Map();

export function libraryEntryById(id) {
  return state.library.find((entry) => entry.id === id);
}

export function normalizeLibrarySourceMeta(sourceMeta, existing = null) {
  const incoming = sourceMeta && typeof sourceMeta === "object" ? sourceMeta : {};
  const previous = existing && typeof existing === "object" ? existing : {};
  const providers = [...new Set([
    ...(Array.isArray(previous.providers) ? previous.providers : []),
    ...(Array.isArray(incoming.providers) ? incoming.providers : []),
    previous.provider,
    incoming.provider,
  ].filter(Boolean).map(String))];
  const audioLanguages = [...new Set([
    ...(Array.isArray(previous.audioLanguages) ? previous.audioLanguages : []),
    ...(Array.isArray(incoming.audioLanguages) ? incoming.audioLanguages : []),
  ].filter(Boolean).map(String))];
  const coveredEpisodes = [...new Set([
    ...(Array.isArray(previous.coveredEpisodes) ? previous.coveredEpisodes : []),
    ...(Array.isArray(incoming.coveredEpisodes) ? incoming.coveredEpisodes : []),
  ].map(Number).filter((value) => Number.isInteger(value) && value >= 1))].sort((a, b) => a - b);
  return {
    provider: String(incoming.provider || previous.provider || providers[0] || "MANUAL"),
    providers,
    releaseName: String(incoming.releaseName || previous.releaseName || "").slice(0, 800),
    quality: String(incoming.quality || previous.quality || "UNKNOWN"),
    codec: String(incoming.codec || previous.codec || "UNKNOWN"),
    peers: Number.isFinite(Number(incoming.peers)) ? Number(incoming.peers) : (Number(previous.peers) || 0),
    sizeBytes: Number.isFinite(Number(incoming.sizeBytes)) ? Number(incoming.sizeBytes) : (Number(previous.sizeBytes) || 0),
    audioLanguages,
    filename: String(incoming.filename || previous.filename || "").slice(0, 500),
    score: Number.isFinite(Number(incoming.score)) ? Number(incoming.score) : (Number(previous.score) || 0),
    sourceKind: String(incoming.sourceKind || previous.sourceKind || ""),
    packLabel: String(incoming.packLabel || previous.packLabel || "").slice(0, 60),
    coverage: Number.isInteger(Number(incoming.coverage)) ? Number(incoming.coverage) : (Number(previous.coverage) || coveredEpisodes.length || 1),
    totalSeasonEpisodes: Number.isInteger(Number(incoming.totalSeasonEpisodes)) ? Number(incoming.totalSeasonEpisodes) : (Number(previous.totalSeasonEpisodes) || 0),
    coveredEpisodes,
  };
}

export function upsertLibrarySession(session, magnet = "", {
  seriesKeyOverride = null,
  displayTitleOverride = "",
  coverUrlOverride = "",
  catalogId = "",
  catalogType = "",
  mediaKind = "",
  sourceMeta = null,
  aliases = [],
  fileIndexes = null,
  chapterLabels = null,
  render = true,
} = {}) {
  const id = String(session.infoHash || session.id || crypto.randomUUID()).toLowerCase();
  const existing = libraryEntryById(id);
  // Chapters added from a pack keep only the picked files; see libraryFileScope().
  const scope = libraryFileScope(existing, fileIndexes);
  const allFiles = session.files || [];
  const files = scope ? allFiles.filter((file) => scope.includes(Number(file.index))) : allFiles;
  const videos = sortedVideoFiles(files);
  if (!videos.length) return null;
  const { primary, extras } = partitionTorrentVideos(files);
  const labels = { ...(existing?.chapterLabels || {}), ...(chapterLabels || {}) };
  const collectionTitle = normalizeCollectionTitle(session.name, primary[0]?.name, videos[0]?.name);
  const qualifiedTarget = /^(?:catalog:|entry:|external:|provisional:|unresolved-entry:)/.test(String(seriesKeyOverride || ""));
  // Older source-reopen VM consumers provide only buildLibrarySeries; normal
  // UI calls use the shared unique-only resolver.
  const selectedAnchor = seriesKeyOverride
    ? (typeof findLibrarySeriesByKey === "function" ? findLibrarySeriesByKey(seriesKeyOverride)
      : buildLibrarySeries().find((item) => item.key === seriesKeyOverride)) : null;
  const workOf = (work) => /^tt\d{5,12}$/i.test(String(work?.catalogId || ""))
    && ["series", "movie"].includes(String(work?.catalogType || work?.type || "").toLowerCase())
    ? `${String(work.catalogType || work.type).toLowerCase()}:${String(work.catalogId).toLowerCase()}` : null;
  const declaredWork = workOf({ catalogId, catalogType });
  const selectedWork = workOf(selectedAnchor);
  const existingWork = workOf(existing);
  // A caller can supply only an IMDb ID or only its media kind. Comparing
  // exclusively complete (id, kind) pairs would miss those contradictions and
  // copy the selected title's watched mark onto a different verified work.
  // Treat every explicitly supplied identity component as an independent
  // constraint before inheriting any Library source/history from the anchor.
  const declaredId = String(catalogId || "").toLowerCase();
  const declaredKind = String(catalogType || "").toLowerCase();
  const conflictsDeclaredIdentity = (verifiedWork) => {
    if (!verifiedWork) return false;
    const [kind, id] = verifiedWork.split(":");
    return Boolean((declaredId && (!/^tt\d{5,12}$/.test(declaredId) || declaredId !== id))
      || (declaredKind && declaredKind !== kind));
  };
  // A title-only legacy alias is not a verified crosswalk. If the target is
  // known to be another IMDb work, import an independent source instead.
  const anchorConflict = selectedWork && (declaredWork && selectedWork !== declaredWork
    || existingWork && selectedWork !== existingWork
    || conflictsDeclaredIdentity(selectedWork));
  const anchorSeries = anchorConflict ? null : selectedAnchor;
  const requestedWork = workOf({ catalogId: catalogId || anchorSeries?.catalogId,
    catalogType: catalogType || anchorSeries?.catalogType });
  // Reimporting an already stored torrent hash cannot silently retarget its
  // watched chapters to a different known IMDb work or media kind.
  if (conflictsDeclaredIdentity(existingWork)
    || (existingWork && requestedWork && existingWork !== requestedWork)
    || (qualifiedTarget && anchorConflict)) return null;
  // An explicit Library target must still exist. Do not convert a vanished or
  // ambiguous route into a new title-only association after an await.
  if (qualifiedTarget && !anchorSeries) return null;
  const storedDisplayTitle = String(existing?.displayTitle || existing?.title || "").trim();
  const storedLooksLikeRelease = /\b(?:2160p|1080p|720p|576p|480p|4K|WEB[- .]?DL|WEBRip|BluRay|BDRip|HDTV|REMUX|DDP(?:5[. ]?1)?|E-?AC-?3|H[ ._-]?26[45]|x26[45])\b/i.test(storedDisplayTitle);
  const migratedDisplayTitle = storedLooksLikeRelease ? collectionTitle : storedDisplayTitle;
  const seriesTitle = displayTitleOverride || anchorSeries?.title || migratedDisplayTitle || collectionTitle;
  const previousEpisodes = new Map((existing?.episodes || []).map((episode) => [String(episode.fileIndex), episode]));
  const makeEpisode = (file, isExtra = false) => {
    const label = labels[String(file.index)];
    const identity = label?.code ? { code: label.code, title: label.title || label.code } : episodeIdentity(file.name);
    const previous = previousEpisodes.get(String(file.index));
    return {
      fileIndex: file.index,
      name: file.name,
      length: file.length,
      needsTranscode: Boolean(file.needsTranscode),
      code: identity.code,
      episodeTitle: identity.title,
      sourceTag: label?.code ? `${seriesTitle} · ${label.code}` : sourceTagFor(file, seriesTitle),
      extra: isExtra && !label?.code,
      // Reopening a legacy episode with no analysis must not synthesize a
      // metadata edit that would block an otherwise safe concurrent CAS.
      ...(previous ? (Object.hasOwn(previous, "analysis") ? { analysis: previous.analysis } : {})
        : { analysis: { words: [], phrases: [], updatedAt: null } }),
      // Saved per episode: subtitle sync models and where you stopped watching.
      ...(previous?.subtitleSync ? { subtitleSync: previous.subtitleSync } : {}),
      ...(previous?.progress ? { progress: previous.progress } : {}),
      ...(previous?.provisionalChapterId ? { provisionalChapterId: previous.provisionalChapterId } : {}),
    };
  };
  const entry = {
    id,
    magnet: magnet || existing?.magnet || "",
    title: collectionTitle,
    // Keep the historical display alias in persisted records; the stable
    // routing work key belongs to the derived Library series, not this alias.
    seriesKey: anchorSeries?.legacyKey || seriesKeyOverride || (storedLooksLikeRelease ? librarySeriesKey(collectionTitle) : existing?.seriesKey) || librarySeriesKey(existing?.title || collectionTitle),
    displayTitle: displayTitleOverride || anchorSeries?.title || migratedDisplayTitle || collectionTitle,
    coverUrl: (existing?.artworkPinned ? existing.coverUrl : "") || (anchorSeries?.artworkPinned ? anchorSeries.coverUrl : "") || coverUrlOverride || existing?.coverUrl || anchorSeries?.coverUrl || "",
    artworkIndex: Number.isInteger(existing?.artworkIndex) ? existing.artworkIndex : (Number.isInteger(anchorSeries?.artworkIndex) ? anchorSeries.artworkIndex : 0),
    artworkSource: existing?.artworkSource || anchorSeries?.artworkSource || "",
    artworkPinned: Boolean(existing?.artworkPinned || anchorSeries?.artworkPinned),
    rawName: session.name || existing?.rawName || collectionTitle,
    catalogId: catalogId || existing?.catalogId || anchorSeries?.catalogId || "",
    catalogType: catalogType || existing?.catalogType || anchorSeries?.catalogType || "",
    mediaKind: mediaKind || existing?.mediaKind || anchorSeries?.mediaKind || "",
    // A torrent refresh is not an AniList unlink. Keep account-scoped verified
    // season mappings and imported list metadata on the same stored source.
    ...(existing?.anilist ? { anilist: existing.anilist } : {}),
    ...(Array.isArray(existing?.anilistManualLinks) ? { anilistManualLinks: existing.anilistManualLinks } : {}),
    ...(Array.isArray(existing?.anilistAutoLinks) ? { anilistAutoLinks: existing.anilistAutoLinks } : {}),
    ...(existing?.anilistImported ? { anilistImported: true } : {}),
    ...(existing?.externalSource ? { externalSource: existing.externalSource } : {}),
    ...(existing?.externalId ? { externalId: existing.externalId } : {}),
    // Watched flags, their author and timestamp belong together. Source refresh
    // must preserve the recorded origin; absent legacy provenance stays unknown.
    watchedTitleAt: Number(existing?.watchedTitleAt
      ?? anchorSeries?.sources?.find((source) => Number(source?.watchedTitleAt) > 0)?.watchedTitleAt) || 0,
    watchedChapters: existing?.watchedChapters || {},
    ...(existing?.watchedChapterOrigins ? { watchedChapterOrigins: existing.watchedChapterOrigins } : {}),
    ...(existing?.watchedChapterUpdatedAt ? { watchedChapterUpdatedAt: existing.watchedChapterUpdatedAt } : {}),
    // Sync stamps and replicas are the causal identity of each watched choice.
    // They must survive a regular source reopen along with its value and origin.
    ...(existing?.watchedChapterSyncStamps ? { watchedChapterSyncStamps: existing.watchedChapterSyncStamps } : {}),
    ...(existing?.watchedChapterReplicas ? { watchedChapterReplicas: existing.watchedChapterReplicas } : {}),
    aliases: [...new Set([...(Array.isArray(existing?.aliases) ? existing.aliases : []), ...(Array.isArray(anchorSeries?.aliases) ? anchorSeries.aliases : []), ...(Array.isArray(aliases) ? aliases : [])].map((value) => String(value || "").trim()).filter(Boolean))].slice(0, 20),
    sourceMeta: normalizeLibrarySourceMeta(sourceMeta, existing?.sourceMeta),
    addedAt: existing?.addedAt || Date.now(),
    updatedAt: Date.now(),
    ...(existing?.lastPlayedAt ? { lastPlayedAt: existing.lastPlayedAt, lastPlayedFileIndex: existing.lastPlayedFileIndex } : {}),
    episodes: [...primary.map((file) => makeEpisode(file, false)), ...extras.map((file) => makeEpisode(file, true)),
      // A legacy no-index chapter has no provable mapping to the refreshed
      // torrent file list. Retain it separately, including its exact playhead,
      // rather than reassigning progress by matching its display name.
      ...(existing?.episodes || []).filter((episode) => episode?.fileIndex === null
        || episode?.fileIndex === undefined || !Number.isSafeInteger(Number(episode.fileIndex)))],
  };
  if (scope) entry.chapterFileIndexes = scope;
  const labelled = Object.fromEntries(Object.entries(labels).filter(([index]) => !scope || scope.includes(Number(index))));
  if (Object.keys(labelled).length) entry.chapterLabels = labelled;
  const index = state.library.findIndex((item) => item.id === id);
  if (index >= 0) state.library[index] = entry; else state.library.unshift(entry);
  saveLibrary();
  if (render && $("#view-library")?.classList.contains("is-active")) renderLibrary();
  else updateLibrarySummary();
  if (!entry.coverUrl) {
    // A display alias can become ambiguous (or start naming a different work)
    // between this import and the eventual image response.
    const artworkWorkKey = libraryWorkKey(entry);
    queueMicrotask(() => { void fetchArtworkForSeriesKey(artworkWorkKey, { quiet: true }); });
  }
  return entry;
}

const unidentifiedEpisodeKeys = new WeakMap();
let unidentifiedEpisodeSerial = 0;
function libraryChapterKey(episode, entry) {
  const code = String(episode?.code || "").toUpperCase();
  if (/^S\d{2}E\d{2,4}$/.test(code) && verifiedVideoWorkKey(entry)) return code;
  // Two files may display the identical name. Their existing immutable
  // Library entry + torrent file index is a stable provisional chapter key.
  const index = episode?.fileIndex;
  if (Number.isSafeInteger(Number(index)) && index !== null && index !== undefined && String(index).trim() !== "")
    return `file:${encodeURIComponent(String(entry?.id || ""))}:${Number(index)}`;
  // Older records may have an explicit episode identity but no file index.
  // Do not invent a positional identity that changes when files reorder.
  const known = String(episode?.id || episode?.sourceId || "");
  if (known) return `episode:${encodeURIComponent(String(entry?.id || ""))}:${encodeURIComponent(known)}`;
  if (episode?.provisionalChapterId) return `unresolved:${libraryWorkKey(entry)}:${encodeURIComponent(String(episode.provisionalChapterId))}`;
  // A legacy object without an immutable file index must remain visible and
  // distinct. The session-local key survives in-memory reordering and leaves
  // old saved progress untouched; no guessed identity is persisted on disk.
  if (!episode || typeof episode !== "object") return null;
  if (!unidentifiedEpisodeKeys.has(episode)) unidentifiedEpisodeKeys.set(episode, ++unidentifiedEpisodeSerial);
  return `unresolved:${encodeURIComponent(String(entry?.id || ""))}:${unidentifiedEpisodeKeys.get(episode)}`;
}

let legacyIdentitySaveScheduled = false;
/** Add opaque, non-correlating identifiers only after durable hydration.
 * No existing IDs/progress are overwritten, and CAS persists the extra fields
 * through the ordinary Library save contract, not a synthetic DB rewrite. */
export function migrateLegacyLibraryIdentities() {
  if (typeof persistentAppStateReady === "undefined" || !persistentAppStateReady
    || (typeof POPUP_HANDOFF !== "undefined" && POPUP_HANDOFF)
    || !Array.isArray(state.library)) return false;
  let changed = false;
  for (const entry of state.library || []) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const hasDurableSourceId = typeof entry.id === "string" && entry.id.length > 0
      || typeof entry.id === "number" && Number.isSafeInteger(entry.id);
    if (!hasDurableSourceId && !entry.provisionalWorkId && !verifiedVideoWorkKey(entry)
      && !(entry.externalSource && entry.externalId)) {
      entry.provisionalWorkId = crypto.randomUUID();
      changed = true;
    }
    // Old or partially migrated records can contain a non-array episodes
    // payload. Preserve the original value for recovery; never iterate or
    // rewrite it as though it were a verified chapter list.
    for (const episode of Array.isArray(entry.episodes) ? entry.episodes : []) {
      if (!episode || typeof episode !== "object" || episode.provisionalChapterId
        || episode.id || episode.sourceId || verifiedVideoWorkKey(entry)
          && /^S\d{2}E\d{2,4}$/i.test(String(episode.code || ""))) continue;
      const index = episode.fileIndex;
      if (index !== null && index !== undefined && String(index).trim() !== ""
        && Number.isSafeInteger(Number(index))) continue;
      episode.provisionalChapterId = crypto.randomUUID();
      changed = true;
    }
  }
  if (changed && !legacyIdentitySaveScheduled) {
    legacyIdentitySaveScheduled = true;
    queueMicrotask(() => {
      legacyIdentitySaveScheduled = false;
      if (persistentAppStateReady) saveLibrary();
    });
  }
  return changed;
}

export function groupLibraryChapters(refs) {
  const groups = new Map();
  refs.forEach((ref) => {
    const key = libraryChapterKey(ref.episode, ref.entry);
    if (!key) return;
    const current = groups.get(key) || {
      key,
      code: ref.episode.code || "VIDEO",
      title: ref.episode.episodeTitle || ref.episode.name || "Untitled chapter",
      sources: [],
    };
    current.sources.push(ref);
    groups.set(key, current);
  });
  // The chapter code wins over the file name: files from a pack can be numbered 1…148 across seasons.
  const sortKey = (group) => episodeSortKey(group.code) ?? episodeSortKey(group.sources[0]?.episode?.name) ?? 999999;
  return [...groups.values()].sort((a, b) => sortKey(a) - sortKey(b)
    || (a.key.startsWith("file:") && b.key.startsWith("file:")
      ? (Number(a.sources[0]?.episode?.fileIndex) || 0) - (Number(b.sources[0]?.episode?.fileIndex) || 0) : 0)
    || a.key.localeCompare(b.key));
}

export function librarySourceDetails(entry, episode) {
  const meta = normalizeLibrarySourceMeta(entry.sourceMeta);
  const releaseText = `${meta.releaseName || ""} ${entry.rawName || ""} ${episode.name || ""}`;
  const inferredQuality = /\b(?:2160p|4k)\b/i.test(releaseText) ? "4K"
    : /\b1080p\b/i.test(releaseText) ? "1080p"
      : /\b720p\b/i.test(releaseText) ? "720p"
        : /\b(?:480p|576p)\b/i.test(releaseText) ? "SD" : "UNKNOWN";
  const inferredCodec = /\b(?:x265|h\.?265|hevc)\b/i.test(releaseText) ? "HEVC"
    : /\b(?:x264|h\.?264|avc)\b/i.test(releaseText) ? "H264"
      : /\bav1\b/i.test(releaseText) ? "AV1" : "UNKNOWN";
  const inferredVoices = [];
  if (/\b(?:english|eng)\b/i.test(releaseText)) inferredVoices.push("English");
  if (/\b(?:spanish|spa|castellano|latino)\b/i.test(releaseText)) inferredVoices.push("Spanish");
  if (/\b(?:french|fre|fra|vff|vfq)\b/i.test(releaseText)) inferredVoices.push("French");
  if (/\b(?:italian|ita)\b/i.test(releaseText)) inferredVoices.push("Italian");
  if (/\b(?:german|ger|deu)\b/i.test(releaseText)) inferredVoices.push("German");
  if (/\b(?:japanese|jpn)\b/i.test(releaseText)) inferredVoices.push("Japanese");
  if (meta.quality === "UNKNOWN") meta.quality = inferredQuality;
  if (meta.codec === "UNKNOWN") meta.codec = inferredCodec;
  if (!meta.audioLanguages.length && inferredVoices.length) meta.audioLanguages = inferredVoices;
  const providers = meta.providers.length ? meta.providers.join(" + ") : (meta.provider || "MANUAL");
  const voices = meta.audioLanguages.length ? meta.audioLanguages.join(" / ") : "Unknown voice";
  const releaseName = meta.releaseName || entry.rawName || episode.name || "Torrent source";
  const inferredStoredKind = (entry.episodes || []).filter((item) => !item.extra).length > 1 ? "season-pack" : "episode";
  const sourceKind = meta.sourceKind === "season-pack" ? "season-pack"
    : meta.sourceKind === "multi-episode-pack" ? "multi-episode-pack"
      : meta.sourceKind === "pack-file" ? "pack-file"
        : inferredStoredKind;
  const sourceKindLabel = entry.catalogType === "movie" ? "MOVIE SOURCE"
    : sourceKind === "pack-file" ? `FROM ${meta.packLabel || "PACK"}${episode.code ? ` - ${episode.code}` : ""}`
      : sourceKind === "season-pack" ? "SEASON PACK"
        : sourceKind === "multi-episode-pack" ? "MULTI-EPISODE PACK"
          : `EPISODE SOURCE${episode.code ? ` - ${episode.code}` : ""}`;
  const coverageLabel = sourceKind === "episode" || sourceKind === "pack-file" ? ""
    : meta.totalSeasonEpisodes
      ? `COVERS ${meta.coverage || meta.coveredEpisodes.length} / ${meta.totalSeasonEpisodes} CHAPTERS`
      : `COVERS ${meta.coverage || meta.coveredEpisodes.length} CHAPTERS`;
  return { ...meta, providers, voices, releaseName, sourceKind, sourceKindLabel, coverageLabel };
}

export function librarySeriesKey(title) {
  return String(title || "Untitled series").replace(/\s+\[(?:BDRip|BluRay|WEB[- .]?DL|WEBRip|HDTV|DVDRip)\]\s*$/i, "").trim().toLowerCase();
}

/** Stable work identity, independent of name, Library insertion order and display aliases. */
const unidentifiedWorkKeys = new WeakMap();
let unidentifiedWorkSerial = 0;
export function libraryWorkKey(entry = {}) {
  // A malformed old source-id object is not a durable owner. Stringifying it
  // would merge unrelated records under entry:%5Bobject%20Object%5D.
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const verified = verifiedVideoWorkKey(entry);
  if (verified) return `catalog:${verified}`;
  const provider = String(entry.externalSource || "").toUpperCase();
  const externalId = String(entry.externalId || "").trim();
  const kind = entry.catalogType === "movie" ? "movie" : "series";
  if (provider === "ANILIST" && /^[1-9]\d*$/.test(externalId))
    return `external:anilist:${kind}:${externalId}`;
  if (provider === "TMDB" && /^(?:(?:movie|tv):)?[1-9]\d*$/.test(externalId))
    return `external:tmdb:${kind}:${externalId}`;
  // Existing stored entry.id is durable across source refresh and move within
  // the Library; unknown same-name sources must never silently join.
  if ((typeof entry.id === "string" && entry.id.length > 0)
    || (typeof entry.id === "number" && Number.isSafeInteger(entry.id)))
    return `entry:${encodeURIComponent(String(entry.id))}`;
  if (typeof entry.provisionalWorkId === "string" && entry.provisionalWorkId)
    return `provisional:${encodeURIComponent(entry.provisionalWorkId)}`;
  // Avoid grouping two historical ID-less records by the empty string. This
  // identity is intentionally temporary until each source is explicitly saved.
  if (!unidentifiedWorkKeys.has(entry)) unidentifiedWorkKeys.set(entry, ++unidentifiedWorkSerial);
  return `unresolved-entry:${unidentifiedWorkKeys.get(entry)}`;
}

/** Old title-only deep links remain readable only while they identify one work. */
export function findLibrarySeriesByKey(rawKey, items = buildLibrarySeries()) {
  const key = String(rawKey || "");
  const exact = items.find((series) => series.key === key || series.routeKey === key);
  if (exact) return exact;
  const bySource = items.filter((series) => (series.routeAliases || []).includes(key));
  if (bySource.length === 1) return bySource[0];
  // A typed route is a claimed work/source owner, not a display alias. If its
  // owner disappeared, never resolve it to a foreign series via legacyKey.
  if (/^(?:catalog:|entry:|external:|provisional:|unresolved-entry:)/.test(key)) return null;
  const previousLegacy = key.startsWith("legacy:") ? key.slice("legacy:".length) : key;
  const legacy = items.filter((series) => series.legacyKey === previousLegacy);
  return legacy.length === 1 ? legacy[0] : null;
}

// An already selected torrent always belongs to its exact saved source, not
// to another translated title sharing its historical seriesKey display alias.
export function librarySeriesForEntry(entry, items = buildLibrarySeries()) {
  if (!entry || typeof entry !== "object") return null;
  const hasId = (typeof entry.id === "string" && entry.id.length > 0)
    || (typeof entry.id === "number" && Number.isSafeInteger(entry.id));
  const matches = items.filter((series) => (series.sources || []).some((source) =>
    hasId ? source.id === entry.id : source === entry));
  return matches.length === 1 ? matches[0] : null;
}

// Catalog-backed badges, search results and Discover exclusion require an
// exact catalog ID and media kind. A display title is not verified ownership.
export function librarySeriesForCatalog(meta, items = buildLibrarySeries()) {
  const id = String(meta?.id || meta?.catalogId || "");
  if (!/^tt\d{5,12}$/i.test(id)) return null;
  const type = meta?.type === "movie" ? "movie" : "series";
  const matches = items.filter((series) => series.catalogId?.toLowerCase() === id.toLowerCase()
    && series.type === type);
  return matches.length === 1 ? matches[0] : null;
}

export function catalogMediaKind(meta) {
  const animeIds = new Set((state.homeCatalog.anime || []).map((item) => item.id).filter(Boolean));
  return libraryCategory({ catalogId: meta?.id, type: meta?.type, kind: meta?.kind, genres: meta?.genres },
    { animeIds, details: meta }) === "anime" ? "anime" : "";
}

export function buildLibrarySeries() {
  migrateLegacyLibraryIdentities();
  const groups = new Map();
  // A retained legacy Library snapshot may include null/non-record slots.
  // Ignore them in the derived view without deleting their persisted bytes.
  (Array.isArray(state.library) ? state.library : []).forEach((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
    // A removed Library listing can retain its saved chapter/source records.
    // Re-adding the title unhides those records without losing watch history.
    if (entry.libraryHidden === true) return;
    const key = typeof entry.seriesKey === "string" && entry.seriesKey
      ? entry.seriesKey : librarySeriesKey(entry.title);
    const displayTitle = String(entry.displayTitle || entry.title || "Untitled series");
    const catalogId = typeof entry.catalogId === "string" ? entry.catalogId : "";
    const groupId = libraryWorkKey(entry);
    const group = groups.get(groupId) || {
      // Legacy key remains available to older Watch/player consumers. Cards,
      // routes and new Library actions use routeKey, which is immutable.
      key: groupId,
      legacyKey: key,
      routeKey: groupId,
      routeAliases: [],
      title: displayTitle,
      type: entry.catalogType === "movie" ? "movie" : "series",
      mediaKind: entry.mediaKind || "",
      coverUrl: entry.coverUrl || "",
      artworkIndex: Number.isInteger(entry.artworkIndex) ? entry.artworkIndex : 0,
      artworkSource: entry.artworkSource || "",
      artworkPinned: Boolean(entry.artworkPinned),
      catalogId,
      catalogType: ["movie", "series"].includes(entry.catalogType) ? entry.catalogType : "",
      aliases: Array.isArray(entry.aliases) ? entry.aliases.slice() : [],
      releaseInfo: entry.releaseInfo || "",
      externalSource: entry.externalSource || "",
      externalId: entry.externalId || "",
      updatedAt: entry.updatedAt || entry.addedAt || 0,
      sources: [],
      seasons: new Map(),
      extras: [],
    };
    group.sources.push(entry);
    if ((typeof entry.id === "string" && entry.id.length > 0)
      || (typeof entry.id === "number" && Number.isSafeInteger(entry.id))) {
      const sourceRoute = `entry:${encodeURIComponent(String(entry.id))}`;
      if (!group.routeAliases.includes(sourceRoute)) group.routeAliases.push(sourceRoute);
    }
    if (!group.catalogId && catalogId) group.catalogId = catalogId;
    if (!group.catalogType && ["movie", "series"].includes(entry.catalogType)) group.catalogType = entry.catalogType;
    if (!group.releaseInfo && entry.releaseInfo) group.releaseInfo = entry.releaseInfo;
    if (!group.externalSource && entry.externalSource) group.externalSource = entry.externalSource;
    if (!group.externalId && entry.externalId) group.externalId = entry.externalId;
    group.aliases = [...new Set([...(group.aliases || []), ...(Array.isArray(entry.aliases) ? entry.aliases : [])])].slice(0, 20);
    if (entry.catalogType === "movie") group.type = "movie";
    if (entry.mediaKind === "anime") group.mediaKind = "anime";
    if (!group.coverUrl && entry.coverUrl) {
      group.coverUrl = entry.coverUrl;
      group.artworkIndex = Number.isInteger(entry.artworkIndex) ? entry.artworkIndex : 0;
      group.artworkSource = entry.artworkSource || "";
      group.artworkPinned = Boolean(entry.artworkPinned);
    }
    if ((entry.updatedAt || 0) >= group.updatedAt) {
      group.updatedAt = entry.updatedAt || group.updatedAt;
      group.title = displayTitle || group.title;
    }
    (Array.isArray(entry.episodes) ? entry.episodes : []).forEach((episode) => {
      if (!episode || typeof episode !== "object" || Array.isArray(episode)) return;
      const ref = { entry, episode };
      const match = String(episode.code || "").match(/^S(\d{2})E(\d{2,4})$/i);
      if (episode.extra) {
        group.extras.push(ref);
        return;
      }
      const seasonNumber = match ? Number(match[1]) : 1;
      const season = group.seasons.get(seasonNumber) || [];
      season.push(ref);
      group.seasons.set(seasonNumber, season);
    });
    groups.set(groupId, group);
  });
  // Every new card/action key remains a stable work ID even if another title
  // with the same display alias is added. Older keys resolve only when unique.
  return [...groups.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.title.localeCompare(b.title));
}

export function addCatalogPlaceholder(meta, { aliases = [], externalSource = "CATALOG", externalId = "", render = true } = {}) {
  if (!Array.isArray(state.library)) return null;
  const name = String(meta?.name || aliases[0] || "Untitled").trim();
  if (!name) return null;
  const catalogType = meta?.type === "movie" ? "movie" : "series";
  const catalogId = /^tt\d{5,12}$/.test(String(meta?.id || "")) ? String(meta.id) : "";
  const provider = String(externalSource || "").toUpperCase();
  const providerId = String(externalId || "").trim();
  const verifiedProvider = provider === "ANILIST" && /^[1-9]\d*$/.test(providerId)
    || provider === "TMDB" && /^(?:(?:movie|tv):)?[1-9]\d*$/.test(providerId);
  // An unknown provider ID or display name cannot identify a work. Give each
  // separately added provisional entry its own durable identity.
  const id = catalogId
    ? `catalog:${catalogType}:${catalogId}`
    : verifiedProvider
      // AniList imports already persist anilist:<id>, which the sync planner
      // also uses for kept/remove membership. Preserve that durable identity
      // rather than manufacturing a second placeholder for the same media.
      ? (provider === "ANILIST" ? `anilist:${providerId}`
        : `external:tmdb:${catalogType}:${providerId}`)
      : `provisional:${crypto.randomUUID()}`;
  const existing = state.library.find((item) => item && typeof item === "object" && !Array.isArray(item) && item.id === id);
  const entry = {
    ...(existing || {}),
    id,
    magnet: existing?.magnet || "",
    title: existing?.title || name,
    seriesKey: existing?.seriesKey || librarySeriesKey(name),
    displayTitle: name,
    coverUrl: String(existing?.coverUrl || meta?.poster || ""),
    artworkIndex: Number.isInteger(existing?.artworkIndex) ? existing.artworkIndex : 0,
    artworkSource: existing?.artworkSource || (meta?.poster ? externalSource : ""),
    artworkPinned: Boolean(existing?.artworkPinned),
    rawName: existing?.rawName || name,
    catalogId: catalogId || existing?.catalogId || "",
    catalogType,
    mediaKind: catalogMediaKind(meta) || existing?.mediaKind || (String(externalSource).toUpperCase() === "ANILIST" ? "anime" : ""),
    aliases: [...new Set([name, ...(Array.isArray(existing?.aliases) ? existing.aliases : []), ...aliases].map((value) => String(value || "").trim()).filter(Boolean))].slice(0, 20),
    releaseInfo: String(meta?.releaseInfo || existing?.releaseInfo || ""),
    externalSource: externalSource || existing?.externalSource || "",
    externalId: String(externalId || existing?.externalId || ""),
    catalogOnly: true,
    addedAt: existing?.addedAt || Date.now(),
    updatedAt: Date.now(),
    episodes: Array.isArray(existing?.episodes) ? existing.episodes : [],
  };
  const index = state.library.findIndex((item) => item && typeof item === "object" && !Array.isArray(item) && item.id === id);
  // Explicitly re-adding a work restores only that work's retained chapters.
  // Same-name reboots preserve their independent hidden state and watch marks.
  for (const item of state.library) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    if (libraryWorkKey(item) === libraryWorkKey(entry)) delete item.libraryHidden;
  }
  delete entry.libraryHidden;
  if (index >= 0) state.library[index] = entry; else state.library.unshift(entry);
  if (render) {
    saveLibrary();
    if ($("#view-library")?.classList.contains("is-active")) renderLibrary();
    else updateLibrarySummary();
    // Catalog-only anime need a verified AniList identity *before* any watch
    // history exists. A read-only, nonblocking match does not start remote sync.
    if (catalogId && catalogType === "series" && String(externalSource).toUpperCase() !== "ANILIST") {
      const account = readAniListAccount(localStorage);
      if (account) void autoLinkNewlyAddedAnime({ catalogId, seriesKey: entry.seriesKey,
        entryId: entry.id, account }).catch((error) => console.warn("AniList association deferred:", error?.message));
    }
  }
  return entry;
}

function currentSeriesChapters() {
  const source = state.currentSource;
  if (!source?.libraryId || source.fileIndex === null || source.fileIndex === undefined) return [];
  const entry = libraryEntryById(source.libraryId);
  if (!entry) return [];
  const key = entry.seriesKey || librarySeriesKey(entry.title);
  const series = buildLibrarySeries().find((item) => item.sources.includes(entry));
  if (!series) return [];
  const chapters = [];
  [...series.seasons.entries()]
    .sort((a, b) => a[0] - b[0])
    .forEach(([seasonNumber, refs]) => {
      groupLibraryChapters(refs).forEach((chapter) => {
        const preferred = chapter.sources.slice().sort(compareLibrarySourceRefsByPeers)[0];
        if (preferred) chapters.push({ ...preferred, seasonNumber });
      });
    });
  return chapters;
}

export function librarySeriesChapterCount(series) {
  return [...series.seasons.values()].reduce((total, refs) => total + groupLibraryChapters(refs).length, 0);
}

export function currentChapterNavigation() {
  const chapters = currentSeriesChapters();
  const source = state.currentSource;
  const currentEntry = source?.libraryId ? libraryEntryById(source.libraryId) : null;
  const currentEpisode = currentEntry?.episodes?.find((episode) => Number(episode.fileIndex) === Number(source?.fileIndex));
  const currentKey = currentEpisode ? libraryChapterKey(currentEpisode, currentEntry) : "";
  const index = currentKey
    ? chapters.findIndex(({ entry, episode }) => libraryChapterKey(episode, entry) === currentKey)
    : -1;
  return {
    chapters,
    index,
    previous: index > 0 ? chapters[index - 1] : null,
    next: index >= 0 && index < chapters.length - 1 ? chapters[index + 1] : null,
  };
}

export function currentChapterSources() {
  const source = state.currentSource;
  if (!source?.libraryId || source.fileIndex === null || source.fileIndex === undefined) return [];
  const currentEntry = libraryEntryById(source.libraryId);
  const currentEpisode = currentEntry?.episodes?.find((episode) => Number(episode.fileIndex) === Number(source.fileIndex));
  if (!currentEntry || !currentEpisode) return [];
  const seriesKey = currentEntry.seriesKey || librarySeriesKey(currentEntry.title);
  const series = buildLibrarySeries().find((item) => item.sources.includes(currentEntry));
  if (!series) return [];
  if (series.type === "movie") {
    return [...series.seasons.values()].flatMap((items) => items).concat(series.extras || []).sort(compareLibrarySourceRefsByPeers);
  }
  const wantedKey = libraryChapterKey(currentEpisode, currentEntry);
  const refs = [...series.seasons.values()].flatMap((items) => items).concat(series.extras || []);
  const chapter = groupLibraryChapters(refs).find((item) => item.key === wantedKey);
  return (chapter?.sources || []).slice().sort(compareLibrarySourceRefsByPeers);
}

export async function resolveCatalogMetaForLibrarySeries(series) {
  if (series.catalogId) {
    return {
      id: series.catalogId,
      type: series.catalogType === "movie" ? "movie" : "series",
      name: series.title,
      poster: series.coverUrl || "",
      releaseInfo: series.releaseInfo || "",
      aliases: series.aliases || [],
    };
  }
  const queries = [series.title, ...(series.aliases || [])].filter(Boolean).slice(0, 5);
  const targetYear = Number(String(series.releaseInfo || "").match(/\b(19|20)\d{2}\b/)?.[0] || 0);
  const normalized = (value) => String(value || "").normalize("NFKD").replace(/\p{M}/gu, "")
    .toLocaleLowerCase().replace(/['’]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
  const knownNames = new Set(queries.map(normalized).filter(Boolean));
  const candidates = new Map();
  for (const query of queries) {
    try {
      const data = await fetchJson(`/api/catalog/search?q=${encodeURIComponent(query)}`);
      for (const item of data.results || []) {
        if (!/^tt\d{5,12}$/i.test(String(item?.id || ""))
          || item.type !== (series.type === "movie" ? "movie" : "series")) continue;
        const candidateNames = [item.name, item.title, ...(Array.isArray(item.aliases) ? item.aliases : [])];
        if (!candidateNames.some((name) => knownNames.has(normalized(name)))) continue;
        if (targetYear && Number(catalogResultYear(item) || 0) !== targetYear) continue;
        candidates.set(String(item.id).toLowerCase(), item);
      }
    } catch {}
  }
  // An exact display title is not itself unique when remakes or TV/movies
  // share translations. All alias queries must agree on ONE verified work.
  if (candidates.size !== 1)
    throw new Error("Catalog match is missing or ambiguous. Verify the title and year before linking sources.");
  const best = candidates.values().next().value;
  const route = series.routeKey || series.key;
  const current = findLibrarySeriesByKey(route);
  if (!current || current.catalogId || !current.sources.some((source) =>
    (series.sources || []).some((original) => original.id === source.id)))
    throw new Error("The Library title changed during catalog lookup. Reopen it before linking.");
  const changed = updateLibrarySeriesEntries(route, (entry) => {
    entry.catalogId = best.id;
    entry.catalogType = best.type;
    entry.coverUrl ||= best.poster || "";
    entry.releaseInfo ||= best.releaseInfo || "";
    entry.aliases = [...new Set([...(entry.aliases || []), best.name])];
    entry.updatedAt = Date.now();
  });
  if (!changed) throw new Error("The Library title could not be linked safely.");
  return best;
}

export function updateLibrarySeriesEntries(seriesKey, updater) {
  let changed = false;
  const wanted = String(seriesKey || "");
  const records = Array.isArray(state.library)
    ? state.library.filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry)) : [];
  // Exact work keys always win over historical display aliases, including a
  // legacy record whose seriesKey happens to contain another work's route.
  // Unknown typed routes must never become writable name-based fallbacks.
  const exactExists = records.some((entry) => libraryWorkKey(entry) === wanted);
  const typedRoute = /^(?:catalog:|entry:|external:|provisional:|unresolved-entry:)/.test(wanted);
  const legacyWanted = wanted.startsWith("legacy:") ? wanted.slice("legacy:".length) : wanted;
  const distinctLegacy = new Map();
  if (!exactExists && !typedRoute) {
    for (const item of records) {
      if ((item.seriesKey || librarySeriesKey(item.title)) === legacyWanted)
        distinctLegacy.set(libraryWorkKey(item), true);
    }
  }
  const allowUniqueLegacy = !exactExists && !typedRoute && distinctLegacy.size === 1;
  records.forEach((entry) => {
    const exact = libraryWorkKey(entry) === wanted;
    const legacy = (entry.seriesKey || librarySeriesKey(entry.title)) === legacyWanted;
    if (!exact && !(allowUniqueLegacy && legacy)) return;
    updater(entry);
    changed = true;
  });
  if (changed) saveLibrary();
  return changed;
}

function cleanArtworkQuery(title) {
  return String(title || "")
    .replace(/\s+\[[^\]]+\]\s*$/g, "")
    .replace(/\b(?:1080p|720p|2160p|4K|BluRay|BDRip|WEB[- .]?DL|WEBRip|HDTV|HEVC|x26[45]|H\.?26[45])\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Poster messages show as a toast.
export function artworkNotice(message, error = false) {
  toast(message, { tone: error ? "error" : "default" });
}

export async function fetchArtworkForSeriesKey(seriesKey, { advance = false, quiet = false, rerender = true } = {}) {
  if (artworkFetches.has(seriesKey)) return artworkFetches.get(seriesKey);
  const task = (async () => {
    const series = findLibrarySeriesByKey(seriesKey);
    if (!series) return false;
    const workKey = series.routeKey || series.key;
    if (!advance && (series.artworkPinned || ["CUSTOM", "TVMAZE", "MANUAL"].includes(String(series.artworkSource || "").toUpperCase()))) return false;
    const query = cleanArtworkQuery(series.title);
    if (!query) return false;
    const data = await fetchJson(`/api/images/search?q=${encodeURIComponent(query)}`);
    const candidates = Array.isArray(data.results) ? data.results.filter((item) => item?.url) : [];
    if (!candidates.length) {
      if (!quiet) artworkNotice(`No poster found for ${query}`, true);
      return false;
    }
    // The original alias may now refer to another same-name work. Apply the
    // response only while its captured canonical owner still exists.
    if (!findLibrarySeriesByKey(workKey)) return false;
    let index = Number.isInteger(series.artworkIndex) ? series.artworkIndex : 0;
    if (advance && series.coverUrl) index += 1;
    index = ((index % candidates.length) + candidates.length) % candidates.length;
    if (advance && candidates.length > 1 && candidates[index]?.url === series.coverUrl) index = (index + 1) % candidates.length;
    const candidate = candidates[index];
    const changed = updateLibrarySeriesEntries(workKey, (entry) => {
      entry.coverUrl = candidate.url;
      entry.artworkIndex = index;
      entry.artworkSource = candidate.source || "WEB";
      entry.artworkPinned = Boolean(advance);
      entry.updatedAt = Date.now();
    });
    if (!changed) return false;
    if (rerender && $("#view-library")?.classList.contains("is-active")) renderLibrary();
    if (!quiet) artworkNotice(`New poster for ${series.title}`);
    return true;
  })().catch((error) => {
    if (!quiet) artworkNotice(error.message || "The poster search failed", true);
    return false;
  }).finally(() => artworkFetches.delete(seriesKey));
  artworkFetches.set(seriesKey, task);
  return task;
}
