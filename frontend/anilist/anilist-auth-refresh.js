// Browser-independent scheduling policy for authenticated, read-only refreshes.
// The actual bearer, account verification and CAS stay in anilist-sync.js.
export const AUTHENTICATED_READ_INTERVAL = 60 * 60_000;
export const AUTHENTICATED_READ_RETRY = 10 * 60_000;

export function authenticatedAniListReadDue({ userId, generation, syncedAt, now,
  lastAttempt = { userId: null, generation: null, at: 0 } } = {}) {
  return Number.isSafeInteger(userId) && userId > 0
    && Number.isFinite(now) && now - (Number(syncedAt) || 0) >= AUTHENTICATED_READ_INTERVAL
    && !(lastAttempt.userId === userId && lastAttempt.generation === generation
      && now - lastAttempt.at < AUTHENTICATED_READ_RETRY);
}
