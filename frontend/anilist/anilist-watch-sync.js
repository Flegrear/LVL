// Pure AniList watched-progress planning. No fetching, storage, or writes.
//
// anilistInfo().seasons may contain several AniList media for one TV season
// (split cours), missing seasons, or non-TV specials. Never guess their offsets.

const TV_FORMATS = new Set(["TV", "TV_SHORT", "ONA"]);
const LATER_PART = /\b(?:(?:part|cour|split)\s*(?:2|ii|two|3|iii|three)|(?:2nd|3rd|second|third)\s+(?:part|cour))\b/i;
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const mediaIdOf = (value) => {
  const id = typeof value === "string" && /^(?:anilist:)?\d+$/i.test(value)
    ? Number(value.replace(/^anilist:/i, "")) : value;
  return positive(id) ? id : null;
};

/** A strict SxxExx chapter key; season 0, episode 0 and malformed strings do not sync. */
export function parseAniListEpisodeCode(code) {
  const matched = /^S(\d{2})E(\d{2,4})$/i.exec(String(code || "").trim());
  if (!matched) return null;
  const season = Number(matched[1]);
  const episode = Number(matched[2]);
  return season > 0 && episode > 0 ? { code: `S${matched[1]}E${matched[2]}`, season, episode } : null;
}

/**
 * Map an LVL chapter onto an unambiguous AniList season media entry.
 *
 * Input: { seasons: anilistInfo(show).seasons, episodeCode: "S02E03",
 *          type: "series", ranges?: [{ anilistId, season, start, end }] }.
 * Returns { mediaId, episode, episodeCount, code, season } or null.
 *
 * A single standard TV season uses its local 1-based episode number. For split
 * seasons, ALL same-season parts need explicit, non-overlapping ranges; each
 * range must exactly match that AniList part's episode count. This data is NOT
 * currently provided by anilistInfo(), so without explicit ranges split
 * seasons deliberately remain unmapped instead of corrupting remote progress.
 */
export function resolveAniListEpisode({ seasons = [], episodeCode, type = "series", ranges = [] } = {}) {
  const parsed = parseAniListEpisodeCode(episodeCode);
  if (!parsed || type !== "series" || !Array.isArray(seasons)) return null;
  const candidates = seasons.filter((item) => item?.season === parsed.season);
  if (!candidates.length || candidates.some((item) => !TV_FORMATS.has(item?.format)
    || !mediaIdOf(item.anilistId) || !positive(item.episodes))) return null;
  const ids = candidates.map((item) => mediaIdOf(item.anilistId));
  if (new Set(ids).size !== ids.length) return null;

  const specified = Array.isArray(ranges) ? ranges.filter((range) => range?.season === parsed.season) : [];
  let mapping;
  if (specified.length) {
    if (specified.length !== candidates.length) return null;
    const used = new Set();
    const sections = [];
    for (const item of candidates) {
      const mediaId = mediaIdOf(item.anilistId);
      const matches = specified.filter((range) => mediaIdOf(range.anilistId) === mediaId);
      if (matches.length !== 1) return null;
      const [range] = matches;
      if (!positive(range.start) || !positive(range.end) || range.end < range.start
        || range.end - range.start + 1 !== item.episodes || used.has(mediaId)) return null;
      used.add(mediaId);
      sections.push({ mediaId, episodeCount: item.episodes, start: range.start, end: range.end });
    }
    sections.sort((a, b) => a.start - b.start);
    if (sections.some((item, index) => index && item.start <= sections[index - 1].end)) return null;
    mapping = sections.find((item) => parsed.episode >= item.start && parsed.episode <= item.end);
  } else {
    if (candidates.length !== 1 || LATER_PART.test(candidates[0].title || "")) return null;
    mapping = { mediaId: ids[0], episodeCount: candidates[0].episodes, start: 1, end: candidates[0].episodes };
  }
  return mapping && parsed.episode >= mapping.start && parsed.episode <= mapping.end
    ? { mediaId: mapping.mediaId, episode: parsed.episode - mapping.start + 1,
      episodeCount: mapping.episodeCount, code: parsed.code, season: parsed.season }
    : null;
}

function normalizeCompletion(item) {
  const parsed = parseAniListEpisodeCode(item?.code);
  const mediaId = mediaIdOf(item?.mediaId);
  if (!parsed || !mediaId || !positive(item.episodeCount)
    || !positive(item.episode) || item.episode > item.episodeCount) return null;
  const seriesKey = typeof item.seriesKey === "string" ? item.seriesKey.slice(0, 300) : "";
  return { mediaId, episode: item.episode, episodeCount: item.episodeCount, code: parsed.code, seriesKey };
}

function remoteItems(remote) {
  if (Array.isArray(remote)) return remote;
  if (remote && typeof remote === "object") return Object.entries(remote).map(([key, value]) => ({ ...value, anilistId: key }));
  return [];
}

function remoteSnapshot(remote) {
  const snapshots = new Map();
  for (const item of remoteItems(remote)) {
    const id = mediaIdOf(item?.anilistId ?? item?.mediaId ?? item?.id);
    if (!id) continue;
    if (snapshots.has(id)) {
      // Conflicting remote entries are not reliable enough for a write.
      snapshots.set(id, null);
      continue;
    }
    // A malformed AniList record is not an absent record and is NEVER
    // interpreted as an empty (progress=0) watch list. It blocks writes.
    if (item?.progressKnown === false || !count(item?.progress)) {
      snapshots.set(id, null);
      continue;
    }
    const episodes = positive(item.episodes) ? item.episodes : null;
    snapshots.set(id, { progress: item.progress, status: item.status || null, episodes });
  }
  return snapshots;
}

/**
 * Reconcile unsent local completions and the latest VERIFIED remote snapshot.
 *
 * queue/completed: [{ mediaId, episode, episodeCount, code, seriesKey? }]
 * remote: null when offline; otherwise [{ anilistId, progress, status?,
 *   episodes?: number|null, progressKnown?: false }] or a by-ID object.
 * Invalid/missing remote progress blocks writes for that ID. A verified
 * remote episode total disagreeing with local mappings also blocks writes.
 *
 * Returns { queue, updates }, both new arrays. queue keeps every distinct
 * episode until remote *confirms* progress >= that episode; it is NOT cleared
 * merely because an update was planned. Updates advance only through a
 * contiguous run of locally completed AniList episodes after remote progress.
 * No score/rating is ever copied or changed. Status updates are opt-in and
 * limited to PLANNING -> CURRENT/COMPLETED or CURRENT -> COMPLETED.
 */
export function reconcileAniListProgressQueue({
  queue = [], completed = [], remote = null, allowStatusUpdates = false,
} = {}) {
  const unique = new Map();
  const byLocalCode = new Map();
  const conflictingMedia = new Set();
  for (const item of [...(Array.isArray(queue) ? queue : []), ...(Array.isArray(completed) ? completed : [])]) {
    const row = normalizeCompletion(item);
    if (!row) continue;
    const key = `${row.seriesKey}\0${row.mediaId}\0${row.code}`;
    const codeKey = `${row.seriesKey}\0${row.code}`;
    const first = byLocalCode.get(codeKey);
    if (first && (first.mediaId !== row.mediaId || first.episode !== row.episode
      || first.episodeCount !== row.episodeCount)) {
      conflictingMedia.add(first.mediaId);
      conflictingMedia.add(row.mediaId);
    } else if (!first) byLocalCode.set(codeKey, row);
    // Identical duplicate watches are coalesced, but a contradictory queued
    // mapping remains visible and blocks that media's write until resolved.
    const prior = unique.get(key);
    if (!prior) unique.set(key, row);
    else if (prior.episode !== row.episode || prior.episodeCount !== row.episodeCount) {
      conflictingMedia.add(row.mediaId);
      unique.set(key + `:\0${row.episode}\0${row.episodeCount}`, row);
    }
  }
  const snapshots = remoteSnapshot(remote);
  const valid = [...unique.values()];
  const pending = valid.filter((item) => {
    const status = snapshots.get(item.mediaId);
    return !status || (status.episodes !== null && status.episodes !== item.episodeCount)
      || (status.episodes !== null && status.progress > status.episodes)
      || item.episode > status.progress;
  });
  const byMedia = new Map();
  for (const item of pending) {
    const rows = byMedia.get(item.mediaId) || [];
    rows.push(item);
    byMedia.set(item.mediaId, rows);
  }
  const updates = [];
  for (const [mediaId, items] of byMedia) {
    if (conflictingMedia.has(mediaId)) continue;
    const snapshot = snapshots.get(mediaId);
    if (!snapshot) continue;
    const totals = new Set(items.map((item) => item.episodeCount));
    if (totals.size !== 1) continue; // Contradictory local AniList metadata.
    const episodeCount = [...totals][0];
    if (snapshot.episodes !== null && (snapshot.episodes !== episodeCount
      || snapshot.progress > snapshot.episodes)) continue;
    const distinct = new Set(items.map((item) => item.episode));
    let progress = snapshot.progress;
    while (progress < episodeCount && distinct.has(progress + 1)) progress += 1;
    if (progress <= snapshot.progress) continue;
    const update = { mediaId, progress };
    if (allowStatusUpdates && (snapshot.status === "CURRENT" || snapshot.status === "PLANNING")) {
      // COMPLETED is irreversible-looking UI state; only emit it when
      // AniList has confirmed the same authoritative episode total.
      if (snapshot.episodes === episodeCount && progress === episodeCount) update.status = "COMPLETED";
      else if (snapshot.status === "PLANNING") update.status = "CURRENT";
    }
    updates.push(update);
  }
  return { queue: pending, updates };
}

/**
 * From the actual LVL Library shapes: completed episode source refs
 * [{code, progress:{finished:true}}] plus watchedChapters {SxxExx: timestamp}.
 * Does not treat partially watched chapters as complete.
 *
 * Includes unmapped codes for UI diagnostics; never invents media IDs.
 */
export function planAniListWatchSync({
  seasons = [], type = "series", episodes = [], watchedChapters = {},
  queue = [], remote = null, ranges = [], seriesKey = "", allowStatusUpdates = false,
} = {}) {
  const codes = new Set();
  for (const item of Array.isArray(episodes) ? episodes : []) {
    if (item?.progress?.finished === true || item?.finished === true) codes.add(String(item.code || ""));
  }
  if (Array.isArray(watchedChapters)) {
    for (const code of watchedChapters) codes.add(String(code || ""));
  } else if (watchedChapters && typeof watchedChapters === "object") {
    for (const [code, isWatched] of Object.entries(watchedChapters)) if (isWatched) codes.add(code);
  }
  const completed = [];
  const unmapped = [];
  for (const code of codes) {
    const found = resolveAniListEpisode({ seasons, episodeCode: code, type, ranges });
    if (found) completed.push({ ...found, seriesKey });
    else unmapped.push(code);
  }
  // A persisted completion may have been mapped against older AniList
  // metadata. Hold it for re-evaluation rather than sending it to a different
  // part/sequel, and never process queue entries from another local series.
  const verifiedQueue = [];
  const blockedQueue = [];
  for (const candidate of Array.isArray(queue) ? queue : []) {
    const row = normalizeCompletion(candidate);
    if (!row) continue;
    const resolved = resolveAniListEpisode({ seasons, episodeCode: row.code, type, ranges });
    if (row.seriesKey !== seriesKey || !resolved || row.mediaId !== resolved.mediaId
      || row.episode !== resolved.episode || row.episodeCount !== resolved.episodeCount) {
      blockedQueue.push(row);
    } else verifiedQueue.push(row);
  }
  const plan = reconcileAniListProgressQueue({ queue: verifiedQueue, completed, remote, allowStatusUpdates });
  return { ...plan, queue: [...plan.queue, ...blockedQueue], unmapped, blockedQueue };
}
