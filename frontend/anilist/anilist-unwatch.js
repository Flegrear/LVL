// Explicit unwatch requests are different from monotonic automatic progress.
// They must be tied to an exact authenticated media entry and only ever change
// AniList's contiguous episode count (plus COMPLETED status if applicable).
const protectedStatuses = new Set(["DROPPED", "PAUSED", "REPEATING"]);

export function planAniListUnwatch({ mapped, remote, accountId } = {}) {
  if (!Number.isSafeInteger(accountId) || accountId < 1 || !mapped
    || !Number.isSafeInteger(mapped.mediaId) || mapped.mediaId < 1
    || !Number.isInteger(mapped.episode) || mapped.episode < 1
    || !Number.isInteger(mapped.episodeCount) || mapped.episodeCount < mapped.episode
    || !remote || !Number.isSafeInteger(remote.id) || remote.id <= 0
    || Number(remote.mediaId) !== mapped.mediaId
    || !Number.isInteger(remote.progress) || remote.progress < 0
    || (Number.isInteger(remote.media?.episodes) && remote.media.episodes !== mapped.episodeCount)
    || protectedStatuses.has(remote.status)) return null;
  const progress = Math.min(remote.progress, mapped.episode - 1);
  const status = remote.status === "COMPLETED"
    ? progress === 0 ? "PLANNING" : "CURRENT" : undefined;
  if (progress === remote.progress && !status)
    return { alreadySynced: true, progress, mediaId: mapped.mediaId };
  return { mediaId: mapped.mediaId, listEntryId: remote.id, progress, status,
    discardedFollowing: Math.max(0, remote.progress - mapped.episode),
    previousProgress: remote.progress };
}
