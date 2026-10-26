// Authenticated, score-only mutations. Never pass an LVL token to its Node
// server and never change AniList progress/status while scoring.
export const ANILIST_SCORE_ENTRY_QUERY = `query ($userId: Int!, $mediaId: Int!) {
  MediaList(userId: $userId, mediaId: $mediaId) {
    id mediaId scoreRaw score(format: POINT_10_DECIMAL) status progress
  }
}`;
export const ANILIST_SCORE_SAVE = `mutation ($id: Int!, $scoreRaw: Int!) {
  SaveMediaListEntry(id: $id, scoreRaw: $scoreRaw) {
    id mediaId scoreRaw score(format: POINT_10_DECIMAL)
  }
}`;

export const scoreRaw = (score) => score === null ? 0
  : Number.isFinite(score) && score >= 1 && score <= 10
    ? Math.round(score * 10) : null;

// Accept exactly one pre-existing list entry with a matching AniList media ID.
// Never create a new list entry just to assign a score.
export async function saveAniListScore({ account, mediaId, score, expectedRaw, graphql, stillConnected = () => true }) {
  const desired = scoreRaw(score);
  if (!Number.isSafeInteger(account?.userId) || account.userId <= 0 || !account.token
      || !Number.isSafeInteger(mediaId) || mediaId <= 0 || desired === null
      || !Number.isInteger(expectedRaw) || expectedRaw < 0 || expectedRaw > 100)
    throw new Error("Cannot sync this AniList score: the account, media, or score is not safely matched.");
  const check = (sent = false) => {
    if (!stillConnected()) throw new Error(sent
      ? "AniList account changed after a score update may have been sent. Refresh before retrying."
      : "AniList account changed; no score update was sent.");
  };
  check();
  const data = await graphql(account.token, ANILIST_SCORE_ENTRY_QUERY, { userId: account.userId, mediaId });
  check();
  if (!data || !Object.hasOwn(data, "MediaList")) throw new Error("AniList returned an incomplete score; nothing was changed.");
  const current = data.MediaList;
  if (!Number.isSafeInteger(current?.id) || current.id <= 0 || current.mediaId !== mediaId
      || !Number.isInteger(current.scoreRaw) || current.scoreRaw < 0 || current.scoreRaw > 100)
    throw new Error("This anime has no verifiable AniList list entry. Add it to your AniList list first.");
  if (current.scoreRaw !== expectedRaw) {
    if (current.scoreRaw === desired) return { mediaId, scoreRaw: desired, unchanged: true };
    throw new Error("AniList's score changed elsewhere. Refresh your list before editing again; your local score was saved.");
  }
  if (desired === expectedRaw) return { mediaId, scoreRaw: desired, unchanged: true };
  check();
  const saved = await graphql(account.token, ANILIST_SCORE_SAVE, { id: current.id, scoreRaw: desired });
  check(true);
  if (saved?.SaveMediaListEntry?.id !== current.id || saved.SaveMediaListEntry.mediaId !== mediaId
      || saved.SaveMediaListEntry.scoreRaw !== desired)
    throw new Error("AniList did not confirm the new score. Refresh before attempting another change.");
  const confirmed = await graphql(account.token, ANILIST_SCORE_ENTRY_QUERY, { userId: account.userId, mediaId });
  check(true);
  if (confirmed?.MediaList?.id !== current.id || confirmed.MediaList.mediaId !== mediaId
      || confirmed.MediaList.scoreRaw !== desired)
    throw new Error("AniList score update was sent, but its read-back could not be verified. Refresh before retrying.");
  return { mediaId, scoreRaw: desired, unchanged: false };
}

/** A season is uniquely writable only when there is exactly one matching
 * AniList part. A multi-part/cour show must not guess a target for a score.
 */
export function resolveAniListScorePart(info, season) {
  const parts = info?.seasons || [];
  const eligible = season === null
    ? (parts.length === 1 ? parts : [])
    : parts.filter((part) => part.season === season);
  return eligible.length === 1 && Number.isSafeInteger(eligible[0].anilistId) && eligible[0].anilistId > 0
    ? eligible[0] : null;
}

/**
 * Plan a manual, opt-in backfill of local ratings onto already-listed AniList
 * media. A shared media ID linked from different shows, or two different local
 * scores for the same destination, makes the entire destination ambiguous.
 * Planning never sends a request; every update still needs the fresh score=0
 * preflight and read-back in saveAniListScore().
 *
 * candidates: [{ seriesKey, season, score, part }]
 * part: the unique, account-scoped resolveAniListScorePart() result.
 */
export function planMissingAniListScores(candidates = [], { limit = 25 } = {}) {
  const groups = new Map();
  const skipped = [];
  for (const candidate of candidates) {
    const { seriesKey, season = null, score, part } = candidate || {};
    const mediaId = part?.anilistId;
    const desiredRaw = scoreRaw(score);
    const identity = JSON.stringify([String(seriesKey || "").trim(), season]);
    if (!String(seriesKey || "").trim() || !(season === null || (Number.isInteger(season) && season > 0))
        || !Number.isSafeInteger(mediaId) || mediaId <= 0 || desiredRaw === null || desiredRaw === 0
        || !(part?.status || (Number.isInteger(part?.progress) && part.progress >= 0))
        || !Object.hasOwn(part, "score")
        || !(part.score === null || (Number.isFinite(part.score) && part.score >= 0 && part.score <= 10))) {
      skipped.push({ seriesKey, season, mediaId: mediaId || null, reason: "unverified" });
      continue;
    }
    if (!groups.has(mediaId)) groups.set(mediaId, []);
    groups.get(mediaId).push({ seriesKey, season, mediaId, score, desiredRaw, identity, part });
  }
  const updates = [];
  for (const [mediaId, rows] of groups) {
    const destinations = new Set(rows.map((row) => `${row.identity}:${row.desiredRaw}`));
    if (destinations.size !== 1) {
      skipped.push({ mediaId, reason: "ambiguous" });
      continue;
    }
    const row = rows[0];
    // One stale Library source must not hide a score recorded by another.
    if (rows.some(({ part }) => part.score !== null && part.score !== undefined && part.score !== 0)) {
      skipped.push({ mediaId, reason: "already-scored" });
      continue;
    }
    if (updates.length >= Math.max(0, Math.min(25, Number(limit) || 0))) {
      skipped.push({ mediaId, reason: "limit" });
      continue;
    }
    updates.push({ seriesKey: row.seriesKey, season: row.season, mediaId, score: row.score, expectedRaw: 0 });
  }
  return { updates, skipped };
}

// A local edit must stay visible when its AniList write fails. Keep only the
// score and AniList media/account IDs here (never credentials or list status).
// No automatic retries: the owner must explicitly retry after a conflict.
export const ANILIST_PENDING_SCORES_KEY = "lvl-anilist-unconfirmed-scores-v1";
const scoreKey = (userId, mediaId) => Number.isSafeInteger(userId) && userId > 0
  && Number.isSafeInteger(mediaId) && mediaId > 0 ? `${userId}:${mediaId}` : null;
function pendingScores(storage) {
  try {
    const data = JSON.parse(storage.getItem(ANILIST_PENDING_SCORES_KEY) || "{}");
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch { return {}; }
}
export function readUnconfirmedAniListScore(storage, userId, mediaId) {
  const key = scoreKey(userId, mediaId);
  if (!key) return null;
  const row = pendingScores(storage)[key];
  return row && scoreRaw(row.score) !== null
    ? { score: row.score, updatedAt: Number(row.updatedAt) || 0 } : null;
}
export function stageUnconfirmedAniListScore(storage, userId, mediaId, score, now = Date.now()) {
  const key = scoreKey(userId, mediaId);
  if (!key || scoreRaw(score) === null) throw new Error("Cannot store an unmatched AniList score.");
  const rows = pendingScores(storage);
  rows[key] = { score, updatedAt: now };
  // Limit persisted edits in case many years of abandoned conflicts accumulate.
  const recent = Object.entries(rows).sort((a, b) => (Number(b[1]?.updatedAt) || 0) - (Number(a[1]?.updatedAt) || 0)).slice(0, 200);
  storage.setItem(ANILIST_PENDING_SCORES_KEY, JSON.stringify(Object.fromEntries(recent)));
}
export function acknowledgeUnconfirmedAniListScore(storage, userId, mediaId, score) {
  const key = scoreKey(userId, mediaId);
  if (!key) return false;
  const rows = pendingScores(storage);
  if (!Object.hasOwn(rows, key) || rows[key]?.score !== score) return false;
  delete rows[key];
  storage.setItem(ANILIST_PENDING_SCORES_KEY, JSON.stringify(rows));
  return true;
}
