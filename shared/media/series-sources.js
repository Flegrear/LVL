// series-sources.js: pure helpers for a series' per-chapter sources. Used by app.js (browser)
// and tests/series-sources.test.js (Node); no DOM access.
//
// A provider result for one chapter is either an *episode file* (the torrent holds only this
// chapter) or a *pack* (a season, an episode range or the whole series, where this chapter is one
// file). Episode files come first. A pack is still usable: the backend streams only the chosen
// file, and Library entries created from a pack keep only the chapters the user picked.

const VIDEO_EXTENSION = /\.(?:mkv|mp4|m4v|avi|mov|webm|ts|m2ts|wmv|flv)$/i;
// Provider stats lines: 👤 peers, 💾 size, ⚙️ origin, 📺 quality, 🌐 languages, and flag emoji.
const STATS_LINE = /^(?:\u{1F464}|\u{1F4BE}|\u2699|\u{1F4FA}|\u{1F310}|\u{1F50A}|[\u{1F1E6}-\u{1F1FF}])/u;

export const PACK_LABELS = Object.freeze({
  season: "SEASON PACK",
  "multi-season": "MULTI-SEASON PACK",
  series: "COMPLETE SERIES PACK",
  "episode-range": "EPISODE RANGE",
  pack: "PACK",
});

/**
 * Vertical resolution named in a release or file name: 1080p, 810p, 1920x1080, 4K/UHD, DVD.
 * Returns a number of lines or null when the name doesn't say.
 */
export function releaseVideoHeight(value) {
  const text = String(value || "");
  const size = text.match(/(?<![0-9])(\d{3,4}) ?[x×] ?(\d{3,4})(?![0-9])/);
  if (size) {
    const height = Number(size[2]);
    if (height >= 240 && height <= 4320) return height;
  }
  const lines = [...text.matchAll(/(?<![0-9a-z])(\d{3,4}) ?[pi](?![a-z0-9])/gi)]
    .map((match) => Number(match[1]))
    .filter((height) => height >= 240 && height <= 4320);
  if (lines.length) return Math.max(...lines);
  if (/(?<![a-z0-9])(?:8k)(?![a-z0-9])/i.test(text)) return 4320;
  if (/(?<![a-z0-9])(?:4k|uhd|2160)(?![a-z0-9])/i.test(text)) return 2160;
  if (/(?<![a-z0-9])fhd(?![a-z0-9])/i.test(text)) return 1080;
  if (/(?<![a-z0-9])(?:dvd(?:rip|5|9)?|sdtv)(?![a-z0-9])/i.test(text)) return 480;
  return null;
}

/** Short quality label for a height: "4K", "1080p", "810p"; "" when unknown. */
export function qualityLabel(height) {
  const value = Number(height);
  if (!Number.isFinite(value) || value <= 0) return "";
  if (value >= 2000) return value >= 4000 ? "8K" : "4K";
  return `${Math.round(value)}p`;
}

/** Height for a stored quality label ("1080p", "4K", "SD"), for older records. */
export function heightFromQualityLabel(label) {
  const text = String(label || "").trim();
  if (!text || /^unknown$/i.test(text)) return null;
  if (/^sd$/i.test(text)) return 480;
  return releaseVideoHeight(text);
}

/** Sources worth listing when fetching every magnet: at least minHeight lines and minPeers peers. */
export function meetsSourceFloor(stream, { minHeight = 720, minPeers = 2 } = {}) {
  const height = Number(stream?.height) || heightFromQualityLabel(stream?.quality) || releaseVideoHeight(String(stream?.title || ""));
  return Boolean(height && height >= minHeight && (Number(stream?.peers) || 0) >= minPeers);
}

export function chapterCode(season, episode) {
  const s = Math.max(0, Math.trunc(Number(season)) || 0);
  const e = Math.max(0, Math.trunc(Number(episode)) || 0);
  return `S${String(s).padStart(2, "0")}E${String(e).padStart(2, "0")}`;
}

// Absolute number of a chapter across regular seasons (anime releases often count 1…148).
// seasons: [{ season, count }]. Specials (season 0) have no absolute number.
export function absoluteEpisodeNumber(seasons, season, episode) {
  const target = Math.trunc(Number(season));
  const number = Math.trunc(Number(episode));
  if (!(target >= 1) || !(number >= 1)) return null;
  let before = 0;
  for (const item of Array.isArray(seasons) ? seasons : []) {
    const value = Math.trunc(Number(item?.season));
    if (value >= 1 && value < target) before += Math.max(0, Math.trunc(Number(item?.count)) || 0);
  }
  return before + number;
}

export function normalizeReleaseText(value) {
  return String(value || "")
    .replace(VIDEO_EXTENSION, "")
    .replace(/[._]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleLines(title) {
  return String(title || "").split("\n").map((line) => line.trim()).filter(Boolean);
}

// The file inside the torrent, when the provider shows one that differs from the torrent name.
function innerFile(lines, filename) {
  const name = normalizeReleaseText(lines[0] || "").toLowerCase();
  const candidates = [lines[1] && !STATS_LINE.test(lines[1]) ? lines[1] : "", String(filename || "")];
  for (const candidate of candidates) {
    const base = normalizeReleaseText(String(candidate).split("/").pop()).toLowerCase();
    if (base && base !== name) return String(candidate);
  }
  return "";
}

const plausibleEpisode = (value) => Number.isInteger(value) && value >= 0 && value < 1900;

// JavaScript's \b only knows ASCII words, so season words in other scripts need these.
const WORD_START = "(?<![\\p{L}\\p{N}])";
const WORD_END = "(?![\\p{L}\\p{N}])";
const SEASON_WORDS = "(?:seasons?|saisons?|temporadas?|staffeln?|stagion[ei]|сезоны?)";
const MULTI_SEASON_WORDS = new RegExp(`${WORD_START}${SEASON_WORDS}:? ?(\\d{1,2}) ?(?:-|~|&|,|to|y|and|и) ?(\\d{1,2})${WORD_END}`, "iu");
const MULTI_SEASON_LIST = new RegExp(`${WORD_START}${SEASON_WORDS} \\d{1,2}(?: \\d{1,2}){2,}${WORD_END}`, "iu");
const SEASON_WORD = new RegExp(`${WORD_START}${SEASON_WORDS}${WORD_END}`, "iu");
const ARCHIVE = /\.(?:rar|zip|7z|tar|gz|iso|exe|pdf|epub|cb[rz])$/i;
const VIDEO_TOKENS = /\b(?:2160p|1080p|720p|576p|480p|4k|web-?dl|webrip|web|bluray|blu-ray|bdrip|brrip|bd|hdtv|dvdrip|remux|x26[45]|h ?26[45]|hevc|avc|av1|xvid)\b/i;

/**
 * Reads the markers in a release name.
 * Returns { single: { season?, episode } | null, range: [from, to] | null, scope: "season" |
 * "multi-season" | "series" | "episode-range" | null }.
 */
export function parseReleaseName(value) {
  const text = normalizeReleaseText(value);
  const result = { single: null, range: null, scope: null };

  const sxe = text.match(/\bS(\d{1,2}) ?E(\d{1,4})(?: ?(?:-|~|\+|E) ?E?(\d{1,4}))?(?!\d)/i);
  if (sxe) {
    const season = Number(sxe[1]);
    const episode = Number(sxe[2]);
    const end = sxe[3] === undefined ? null : Number(sxe[3]);
    if (end !== null && end > episode) {
      result.range = [episode, end];
      result.scope = "episode-range";
    } else {
      result.single = { season, episode };
    }
  } else {
    const nxn = text.match(/\b(\d{1,2})x(\d{2,3})\b/i);
    if (nxn) result.single = { season: Number(nxn[1]), episode: Number(nxn[2]) };
  }

  const multiSeason = /\bS(\d{1,2}) ?(?:-|~|&|to) ?S?(\d{1,2})\b(?! ?E\d)/i.test(text)
    || MULTI_SEASON_WORDS.test(text)
    || MULTI_SEASON_LIST.test(text);
  const seriesWords = /\b(?:complete series|full series|the complete series|integrale|intégrale|all seasons|complete collection)\b/i.test(text);
  const seasonMarker = /\bS\d{1,2}\b(?! ?E\d)/i.test(text) || SEASON_WORD.test(text);
  const packWords = /\b(?:complete|batch|collection|pack)\b/i.test(text);

  if (!result.range && !result.single) {
    const range = text.match(/(?:^|[\s(\[#])(?:ep(?:isodes?)? ?|e)?(\d{1,4}) ?(?:-|~|to) ?(?:ep ?|e)?(\d{1,4})(?=$|[\s)\]/])/i);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (plausibleEpisode(from) && plausibleEpisode(to) && to > from) {
        result.range = [from, to];
        result.scope = "episode-range";
      }
    }
  }
  if (!result.single && !result.range) {
    const absolute = text.match(/(?:^| )- (\d{1,4})(?:v\d)?(?=$| |\[|\()/)
      || text.match(/\b(?:ep|eps|episode) ?(\d{1,4})\b(?! ?(?:-|~|to) ?\d)/i)
      || text.match(/第(\d{1,4})[話话集]/);
    if (absolute && plausibleEpisode(Number(absolute[1]))) result.single = { episode: Number(absolute[1]) };
  }

  if (multiSeason) result.scope = "multi-season";
  else if (seriesWords) result.scope = "series";
  else if (!result.scope && seasonMarker && !result.single) result.scope = "season";
  else if (!result.scope && packWords && !result.single) result.scope = seasonMarker ? "season" : "series";
  if (result.single && result.scope) result.single = null;
  return result;
}

function matchesTarget(single, { season, episode, absoluteEpisode } = {}) {
  if (!single) return false;
  if (single.season !== undefined) return single.season === Number(season) && single.episode === Number(episode);
  return single.episode === Number(episode) || (absoluteEpisode !== null && absoluteEpisode !== undefined && single.episode === Number(absoluteEpisode));
}

/**
 * Classifies one provider result for the requested chapter.
 * target: { season, episode, absoluteEpisode? }
 * Returns { kind: "episode" | "pack", exact, confident, playable, scope, range, label, file }.
 * confident: the release looks like a video (resolution, source, codec or a video extension);
 * playable: false for archives and documents, which the player can never open.
 */
export function classifyChapterSource(stream, target = {}) {
  const lines = titleLines(stream?.title);
  const name = lines[0] || String(stream?.filename || "");
  const info = parseReleaseName(name);
  const file = innerFile(lines, stream?.filename);
  const exact = matchesTarget(info.single, target);
  // A provider can return another explicit episode for the requested ID. Without a distinct
  // inner file for our chapter this is not a valid chapter source, regardless of peer count.
  const mismatch = Boolean(info.single && !exact && !file && !info.scope);
  const names = [name, file, String(stream?.filename || "")].filter(Boolean);
  const playable = !names.some((value) => ARCHIVE.test(String(value).trim()));
  const confident = names.some((value) => VIDEO_EXTENSION.test(String(value).trim()) || VIDEO_TOKENS.test(normalizeReleaseText(value)))
    || (Boolean(stream?.quality) && stream.quality !== "UNKNOWN");
  let kind;
  let scope = info.scope;
  if (info.single && !info.range && !info.scope) {
    // Named after one chapter. A different chapter's name plus an inner file means a pack.
    kind = !exact && file ? "pack" : "episode";
    if (kind === "pack") scope = "pack";
  } else if (info.range || info.scope) {
    kind = "pack";
  } else if (file) {
    kind = "pack";
    scope = "pack";
  } else {
    kind = "episode"; // a single-file release the provider matched to this chapter
  }
  const range = kind === "pack" && scope === "episode-range" ? info.range : null;
  const label = kind === "episode"
    ? (exact ? "EPISODE FILE" : "SINGLE FILE")
    : range
      ? `EPISODES ${String(range[0]).padStart(2, "0")}–${String(range[1]).padStart(2, "0")}`
      : PACK_LABELS[scope] || PACK_LABELS.pack;
  return { kind, exact: kind === "episode" && exact, confident, playable, mismatch, scope: kind === "pack" ? scope || "pack" : "episode", range, label, file };
}

const byPeers = (a, b) => (Number(b?.peers) || 0) - (Number(a?.peers) || 0) || (Number(b?.score) || 0) - (Number(a?.score) || 0);

/**
 * Splits a chapter's results into:
 * - episodeFiles: single-chapter releases that look like video, exact matches first, then by peers;
 * - packs: releases that hold more chapters, by peers (only this chapter's file is streamed);
 * - others: single matches that don't look like video (often provider mismatches), by peers.
 * Explicitly different episodes are dropped and counted in `nonmatching`; archives and
 * documents are dropped and counted in `unplayable`.
 */
export function groupChapterSources(streams, target = {}) {
  const annotated = (Array.isArray(streams) ? streams : [])
    .filter((stream) => stream && typeof stream === "object")
    .map((stream) => ({ ...stream, chapterSource: classifyChapterSource(stream, target) }));
  const playable = annotated.filter((stream) => stream.chapterSource.playable && !stream.chapterSource.mismatch);
  const episodeFiles = playable
    .filter((stream) => stream.chapterSource.kind === "episode" && stream.chapterSource.confident)
    .sort((a, b) => Number(b.chapterSource.exact) - Number(a.chapterSource.exact) || byPeers(a, b));
  const packs = playable.filter((stream) => stream.chapterSource.kind === "pack").sort(byPeers);
  const others = playable.filter((stream) => stream.chapterSource.kind === "episode" && !stream.chapterSource.confident).sort(byPeers);
  return {
    episodeFiles, packs, others,
    unplayable: annotated.filter((stream) => !stream.chapterSource.playable).length,
    nonmatching: annotated.filter((stream) => stream.chapterSource.mismatch).length,
  };
}

/**
 * The order "Play" tries sources in: single-episode files with enough peers, then packs with
 * enough peers (only the chapter's file is streamed), then the rest in the same order.
 */
export function chapterPlayOrder(groups, { minPeers = 5, limit = 4 } = {}) {
  const healthy = (stream) => (Number(stream?.peers) || 0) >= minPeers;
  const episodeFiles = groups?.episodeFiles || [];
  const packs = groups?.packs || [];
  return [
    ...episodeFiles.filter(healthy),
    ...packs.filter(healthy),
    ...episodeFiles.filter((stream) => !healthy(stream)),
    ...packs.filter((stream) => !healthy(stream)),
    ...(groups?.others || []),
  ].slice(0, Math.max(1, limit));
}

function uniqueIndexes(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(Number).filter((value) => Number.isInteger(value) && value >= 0))].sort((a, b) => a - b);
}

/**
 * Which files of a torrent belong in its Library entry.
 * - existing entry without a file list: it already holds the whole torrent, keep it (null).
 * - existing entry with a file list: add the newly picked files to it.
 * - new entry: the picked files, or null (every video) when nothing was picked.
 */
export function libraryFileScope(existing, picked) {
  const incoming = Array.isArray(picked) ? uniqueIndexes(picked) : null;
  if (existing) {
    if (!Array.isArray(existing.chapterFileIndexes)) return null;
    return uniqueIndexes([...existing.chapterFileIndexes, ...(incoming || [])]);
  }
  return incoming && incoming.length ? incoming : null;
}

/**
 * Finds the chapter's file in a resolved torrent when the provider gave no file index.
 * files: [{ index, name, video }]. Returns an index or null when it cannot tell.
 */
export function chapterFileIndex(files, { season, episode, absoluteEpisode = null } = {}) {
  const videos = (Array.isArray(files) ? files : []).filter((file) => file?.video);
  if (videos.length === 1) return Number(videos[0].index);
  const matches = videos.filter((file) => {
    const info = parseReleaseName(String(file.name || "").split("/").pop());
    return matchesTarget(info.single, { season, episode, absoluteEpisode });
  });
  return matches.length === 1 ? Number(matches[0].index) : null;
}


const EXTRA_FOLDER = /(?:^|[^a-z])(?:extras?|specials?|sps?|ova|oad|ncop|nced|nc ?(?:op|ed)?|creditless|menus?|bonus|featurettes?|trailers?|previews?|pv|cm|scans?|fonts?|samples?)(?:$|[^a-z])/i;

function seasonFromText(value) {
  const text = normalizeReleaseText(value);
  const match = text.match(/(?:^|[^a-z0-9])(?:season|saison|temporada|staffel|s)[ ._-]?(\d{1,2})(?![0-9]|x\d)(?! ?e\d)/i)
    || text.match(/(?:^|[^a-z0-9])(\d{1,2})(?:st|nd|rd|th) season(?![a-z])/i);
  return match ? Number(match[1]) : null;
}

/**
 * Places each video file of a pack on a catalog chapter, so a pack added to the Library lists all
 * of its chapters. files: [{ index, name, path?, video }]; seasons: [{ season, count?, episodes? }].
 * Rules, strongest first: SxxEyy in the name; a season folder or "2nd Season" plus an episode
 * number; an absolute number across regular seasons. Extras folders are skipped, and when two
 * files land on one chapter the one with the stronger evidence (then the main folder) wins.
 * Returns Map(fileIndex -> { season, episode }).
 */
export function packChapterMap(files, seasons) {
  const counts = new Map();
  for (const item of Array.isArray(seasons) ? seasons : []) {
    const season = Math.trunc(Number(item?.season));
    const count = Math.trunc(Number(item?.count)) || (Array.isArray(item?.episodes) ? item.episodes.length : 0);
    if (season >= 0 && count > 0) counts.set(season, count);
  }
  const regular = [...counts.keys()].filter((season) => season >= 1).sort((a, b) => a - b);
  const fromAbsolute = (number) => {
    let before = 0;
    for (const season of regular) {
      const count = counts.get(season);
      if (number <= before + count) return { season, episode: number - before };
      before += count;
    }
    return null;
  };
  const exists = (season, episode) => counts.has(season) && episode >= 1 && episode <= counts.get(season);
  const candidates = [];
  for (const file of (Array.isArray(files) ? files : []).filter((item) => item?.video)) {
    const parts = String(file.path || file.name || "").split(/[\\/]+/).filter(Boolean);
    const base = parts.pop() || "";
    const folders = parts.slice(1); // parts[0] is the torrent's own folder (its name often says "OVA", "Season 1+2")
    const folderKey = parts.join("/");
    if (folders.some((folder) => EXTRA_FOLDER.test(normalizeReleaseText(folder))) || /(?:^|[^a-z])(?:ncop|nced|creditless|trailer|preview|sample)(?:$|[^a-z])/i.test(normalizeReleaseText(base))) continue;
    const info = parseReleaseName(base);
    const single = info.single;
    if (!single) continue;
    let placed = null;
    let evidence = 0;
    if (single.season !== undefined) {
      if (exists(single.season, single.episode)) { placed = { season: single.season, episode: single.episode }; evidence = 3; }
    } else {
      const seasonHint = seasonFromText(base) ?? [...folders].reverse().map(seasonFromText).find((value) => value !== null) ?? null;
      if (seasonHint !== null && seasonHint >= 1) {
        if (exists(seasonHint, single.episode)) placed = { season: seasonHint, episode: single.episode };
        else {
          const absolute = fromAbsolute(single.episode);
          if (absolute?.season === seasonHint) placed = absolute;
        }
        evidence = placed ? 2 : 0;
      } else {
        placed = fromAbsolute(single.episode);
        evidence = placed ? 1 : 0;
      }
    }
    if (placed) candidates.push({ index: Number(file.index), placed, evidence, folderKey, length: Number(file.length) || 0 });
  }
  const folderVotes = new Map();
  candidates.forEach((item) => folderVotes.set(item.folderKey, (folderVotes.get(item.folderKey) || 0) + 1));
  const mainFolder = [...folderVotes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
  const byChapter = new Map();
  for (const item of candidates) {
    const key = `${item.placed.season}:${item.placed.episode}`;
    const current = byChapter.get(key);
    const better = !current
      || item.evidence > current.evidence
      || (item.evidence === current.evidence && item.folderKey === mainFolder && current.folderKey !== mainFolder);
    if (better) byChapter.set(key, item);
  }
  const result = new Map();
  [...byChapter.values()].sort((a, b) => a.index - b.index).forEach((item) => result.set(item.index, item.placed));
  return result;
}
// Summarize the same chapter across multiple saved torrent sources. A completed
// copy wins over incomplete ones, and partial progress uses the most recently
// updated resume point.
export function chapterWatchStatus(refs = []) {
  const progress = refs.map((ref) => ref?.episode?.progress).filter((item) => item?.durationMs > 0);
  const watched = progress.some((item) => item.finished);
  const resume = progress.filter((item) => !item.finished && item.positionMs > 0)
    .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))[0] || null;
  const percent = watched ? 100 : resume
    ? Math.round(Math.max(0, Math.min(1, resume.positionMs / resume.durationMs)) * 100) : 0;
  return { watched, percent, resume, saved: refs.length > 0 };
}
