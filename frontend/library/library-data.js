// Library entries, series and chapters, and their artwork.
import { toast } from "../ui/ui.js";
import { libraryCategory } from "../catalog/home-feed.js";
import { libraryFileScope } from "../../shared/media/series-sources.js";
import { readAniListAccount } from "../anilist/anilist-auto-client.js";
import { state } from "../../app.js";
import { saveLibrary } from "../app/saved-state.js";
import { $ } from "../app/dom.js";
import { fetchJson } from "../app/http.js";
import { episodeIdentity, normalizeCollectionTitle, sourceTagFor } from "../player/player-tracks.js";
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
  const anchorSeries = seriesKeyOverride ? buildLibrarySeries().find((item) => item.key === seriesKeyOverride) : null;
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
      analysis: previous?.analysis || { words: [], phrases: [], updatedAt: null },
      // Saved per episode: subtitle sync models and where you stopped watching.
      ...(previous?.subtitleSync ? { subtitleSync: previous.subtitleSync } : {}),
      ...(previous?.progress ? { progress: previous.progress } : {}),
    };
  };
  const entry = {
    id,
    magnet: magnet || existing?.magnet || "",
    title: collectionTitle,
    seriesKey: seriesKeyOverride || (storedLooksLikeRelease ? librarySeriesKey(collectionTitle) : existing?.seriesKey) || librarySeriesKey(existing?.title || collectionTitle),
    displayTitle: displayTitleOverride || anchorSeries?.title || migratedDisplayTitle || collectionTitle,
    coverUrl: (existing?.artworkPinned ? existing.coverUrl : "") || (anchorSeries?.artworkPinned ? anchorSeries.coverUrl : "") || coverUrlOverride || existing?.coverUrl || anchorSeries?.coverUrl || "",
    artworkIndex: Number.isInteger(existing?.artworkIndex) ? existing.artworkIndex : (Number.isInteger(anchorSeries?.artworkIndex) ? anchorSeries.artworkIndex : 0),
    artworkSource: existing?.artworkSource || anchorSeries?.artworkSource || "",
    artworkPinned: Boolean(existing?.artworkPinned || anchorSeries?.artworkPinned),
    rawName: session.name || existing?.rawName || collectionTitle,
    catalogId: catalogId || existing?.catalogId || "",
    catalogType: catalogType || existing?.catalogType || "",
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
    watchedChapters: existing?.watchedChapters || {},
    ...(existing?.watchedChapterOrigins ? { watchedChapterOrigins: existing.watchedChapterOrigins } : {}),
    ...(existing?.watchedChapterUpdatedAt ? { watchedChapterUpdatedAt: existing.watchedChapterUpdatedAt } : {}),
    aliases: [...new Set([...(Array.isArray(existing?.aliases) ? existing.aliases : []), ...(Array.isArray(anchorSeries?.aliases) ? anchorSeries.aliases : []), ...(Array.isArray(aliases) ? aliases : [])].map((value) => String(value || "").trim()).filter(Boolean))].slice(0, 20),
    sourceMeta: normalizeLibrarySourceMeta(sourceMeta, existing?.sourceMeta),
    addedAt: existing?.addedAt || Date.now(),
    updatedAt: Date.now(),
    ...(existing?.lastPlayedAt ? { lastPlayedAt: existing.lastPlayedAt, lastPlayedFileIndex: existing.lastPlayedFileIndex } : {}),
    episodes: [...primary.map((file) => makeEpisode(file, false)), ...extras.map((file) => makeEpisode(file, true))],
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
    queueMicrotask(() => { void fetchArtworkForSeriesKey(entry.seriesKey, { quiet: true }); });
  }
  return entry;
}

function libraryChapterKey(episode, fallbackIndex = 0) {
  const code = String(episode?.code || "").toUpperCase();
  if (/^S\d{2}E\d{2,3}$/.test(code)) return code;
  const title = String(episode?.episodeTitle || episode?.name || "").trim().toLowerCase();
  return title || `chapter-${fallbackIndex}`;
}

export function groupLibraryChapters(refs) {
  const groups = new Map();
  refs.forEach((ref, index) => {
    const key = libraryChapterKey(ref.episode, index);
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
  return [...groups.values()].sort((a, b) => sortKey(a) - sortKey(b) || a.title.localeCompare(b.title));
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

export function catalogMediaKind(meta) {
  const animeIds = new Set((state.homeCatalog.anime || []).map((item) => item.id).filter(Boolean));
  return libraryCategory({ catalogId: meta?.id, type: meta?.type, kind: meta?.kind, genres: meta?.genres },
    { animeIds, details: meta }) === "anime" ? "anime" : "";
}

export function buildLibrarySeries() {
  const groups = new Map();
  state.library.forEach((entry) => {
    // A removed Library listing can retain its saved chapter/source records.
    // Re-adding the title unhides those records without losing watch history.
    if (entry.libraryHidden === true) return;
    const key = entry.seriesKey || librarySeriesKey(entry.title);
    const displayTitle = entry.displayTitle || entry.title;
    const group = groups.get(key) || {
      key,
      title: displayTitle,
      type: entry.catalogType === "movie" ? "movie" : "series",
      mediaKind: entry.mediaKind || "",
      coverUrl: entry.coverUrl || "",
      artworkIndex: Number.isInteger(entry.artworkIndex) ? entry.artworkIndex : 0,
      artworkSource: entry.artworkSource || "",
      artworkPinned: Boolean(entry.artworkPinned),
      catalogId: entry.catalogId || "",
      catalogType: entry.catalogType || "",
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
    if (!group.catalogId && entry.catalogId) group.catalogId = entry.catalogId;
    if (!group.catalogType && entry.catalogType) group.catalogType = entry.catalogType;
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
    (entry.episodes || []).forEach((episode) => {
      const ref = { entry, episode };
      const match = String(episode.code || "").match(/^S(\d{1,2})E(\d{1,3})$/i);
      if (episode.extra) {
        group.extras.push(ref);
        return;
      }
      const seasonNumber = match ? Number(match[1]) : 1;
      const season = group.seasons.get(seasonNumber) || [];
      season.push(ref);
      group.seasons.set(seasonNumber, season);
    });
    groups.set(key, group);
  });
  return [...groups.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.title.localeCompare(b.title));
}

export function addCatalogPlaceholder(meta, { aliases = [], externalSource = "CATALOG", externalId = "", render = true } = {}) {
  const name = String(meta?.name || aliases[0] || "Untitled").trim();
  if (!name) return null;
  const catalogType = meta?.type === "movie" ? "movie" : "series";
  const catalogId = /^tt\d{5,12}$/.test(String(meta?.id || "")) ? String(meta.id) : "";
  const id = catalogId
    ? `catalog:${catalogType}:${catalogId}`
    : `${String(externalSource || "external").toLowerCase()}:${String(externalId || name).toLowerCase()}`;
  const existing = state.library.find((item) => item.id === id);
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
  const index = state.library.findIndex((item) => item.id === id);
  // Explicitly re-adding a title restores chapters retained by "Remove entry".
  for (const item of state.library) {
    if ((item.seriesKey || librarySeriesKey(item.title)) === entry.seriesKey) delete item.libraryHidden;
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
  const series = buildLibrarySeries().find((item) => item.key === key);
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
  const currentKey = currentEpisode ? libraryChapterKey(currentEpisode) : "";
  const index = currentKey
    ? chapters.findIndex(({ episode }) => libraryChapterKey(episode) === currentKey)
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
  const series = buildLibrarySeries().find((item) => item.key === seriesKey);
  if (!series) return [];
  if (series.type === "movie") {
    return [...series.seasons.values()].flatMap((items) => items).concat(series.extras || []).sort(compareLibrarySourceRefsByPeers);
  }
  const wantedKey = libraryChapterKey(currentEpisode);
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
  let best = null;
  for (const query of queries) {
    try {
      const data = await fetchJson(`/api/catalog/search?q=${encodeURIComponent(query)}`);
      const matches = (data.results || []).filter((item) => item.type === (series.type === "movie" ? "movie" : "series"));
      matches.sort((a, b) => {
        const aYear = Number(catalogResultYear(a) || 0);
        const bYear = Number(catalogResultYear(b) || 0);
        const aPenalty = targetYear && aYear ? Math.abs(targetYear - aYear) : 0;
        const bPenalty = targetYear && bYear ? Math.abs(targetYear - bYear) : 0;
        return aPenalty - bPenalty;
      });
      if (matches[0]) { best = matches[0]; break; }
    } catch {}
  }
  if (!best) throw new Error("Could not match this imported title to stream metadata.");
  updateLibrarySeriesEntries(series.key, (entry) => {
    entry.catalogId = best.id;
    entry.catalogType = best.type;
    entry.coverUrl ||= best.poster || "";
    entry.releaseInfo ||= best.releaseInfo || "";
    entry.aliases = [...new Set([...(entry.aliases || []), best.name])];
    entry.updatedAt = Date.now();
  });
  return best;
}

export function updateLibrarySeriesEntries(seriesKey, updater) {
  let changed = false;
  state.library.forEach((entry) => {
    const key = entry.seriesKey || librarySeriesKey(entry.title);
    if (key !== seriesKey) return;
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
    const series = buildLibrarySeries().find((item) => item.key === seriesKey);
    if (!series) return false;
    if (!advance && (series.artworkPinned || ["CUSTOM", "TVMAZE", "MANUAL"].includes(String(series.artworkSource || "").toUpperCase()))) return false;
    const query = cleanArtworkQuery(series.title);
    if (!query) return false;
    const data = await fetchJson(`/api/images/search?q=${encodeURIComponent(query)}`);
    const candidates = Array.isArray(data.results) ? data.results.filter((item) => item?.url) : [];
    if (!candidates.length) {
      if (!quiet) artworkNotice(`No poster found for ${query}`, true);
      return false;
    }
    let index = Number.isInteger(series.artworkIndex) ? series.artworkIndex : 0;
    if (advance && series.coverUrl) index += 1;
    index = ((index % candidates.length) + candidates.length) % candidates.length;
    if (advance && candidates.length > 1 && candidates[index]?.url === series.coverUrl) index = (index + 1) % candidates.length;
    const candidate = candidates[index];
    updateLibrarySeriesEntries(seriesKey, (entry) => {
      entry.coverUrl = candidate.url;
      entry.artworkIndex = index;
      entry.artworkSource = candidate.source || "WEB";
      entry.artworkPinned = Boolean(advance);
      entry.updatedAt = Date.now();
    });
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
