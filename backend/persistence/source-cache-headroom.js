// Conservative headroom for the ORIGINAL selected torrent files, not cache
// outputs. A fresh storage.playerCacheAllowance() counts physical bytes;
// this calculation reserves only bytes still needed for each selected source.
// Do not infer selection from a title, filename, or a stale cache manifest.
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const denied = reason => ({ ok: false, reason, reservedSourceBytes: 0 });
const readySession = session => session && !session.closing
  && session.torrent?.destroyed !== true && Array.isArray(session.torrent?.files);

/**
 * @param {Iterable<object>} sessions Live torrent session values (one storage root).
 * @param {object} options identity: optional exactly-bound requesting source
 *   (remux supplies it; other caches use the complete currently selected set).
 * @param {Function} options.isVerifiedComplete Full piece-bitfield proof function.
 * No filesystem scan or network work; storage does its own fresh scan afterwards.
 */
export function selectedSourceHeadroom(sessions, { identity = null, isVerifiedComplete = () => false } = {}) {
  if (!sessions || typeof sessions[Symbol.iterator] !== "function"
    || typeof isVerifiedComplete !== "function") return denied("invalid-headroom-input");

  const byId = new Map();
  const snapshot = [];
  for (const session of sessions) {
    if (!session || typeof session.id !== "string" || !session.id || byId.has(session.id))
      return denied("ambiguous-session-identity");
    byId.set(session.id, session);
    snapshot.push(session);
  }
  if (identity !== null) {
    if (!identity || typeof identity.sessionId !== "string"
      || !nonnegative(identity.fileIndex)) return denied("unverified-request-source");
    const owner = byId.get(identity.sessionId);
    const file = owner?.torrent?.files?.[identity.fileIndex];
    if (!readySession(owner) || !file
      || typeof owner.infoHash !== "string" || !/^[a-f0-9]{40}$/i.test(owner.infoHash)
      || (identity.infoHash !== undefined && String(identity.infoHash).toLowerCase() !== owner.infoHash.toLowerCase())
      || (identity.sourceLength !== undefined && identity.sourceLength !== file.length)
      || (identity.fileLength !== undefined && identity.fileLength !== file.length)
      || (identity.sourceName !== undefined && identity.sourceName !== file.name)
      || (identity.fileName !== undefined && identity.fileName !== file.name))
      return denied("stale-request-source");
  }

  let reservedSourceBytes = 0;
  let selectedFileCount = 0;
  for (const session of snapshot) {
    if (!readySession(session)) continue; // a destroyed source is not a future download
    const indices = new Set();
    const tracked = session.activeStreamFiles;
    if (tracked && typeof tracked.keys === "function") {
      for (const index of tracked.keys()) {
        if (!nonnegative(index)) return denied("invalid-stream-selection");
        indices.add(index);
      }
    }
    // This index was actually selected using WebTorrent file.select().
    if (nonnegative(session.downloadSelectionIndex)) indices.add(session.downloadSelectionIndex);
    // Preserve the original episode when the player has an open reader and
    // the tracked map has not yet been populated, or the selection is pending.
    if (nonnegative(session.preferredFileIndex)
      && (session.state === "ready" || (Number(session.openStreams) || 0) > 0))
      indices.add(session.preferredFileIndex);
    if (identity?.sessionId === session.id) indices.add(identity.fileIndex);
    if (Number(session.openStreams) > 0 && indices.size === 0)
      return denied("untracked-active-original");
    for (const index of indices) {
      const file = session.torrent.files[index];
      if (!file || !nonnegative(file.length) || !nonnegative(file.downloaded)
        || file.downloaded > file.length)
        return denied("unmeasured-original-source");
      selectedFileCount += 1;
      if (!Number.isSafeInteger(selectedFileCount)) return denied("source-count-overflow");
      // The scan below already includes current physically downloaded bytes.
      // Count only the still-needed remainder ONCE per session/fileIndex.
      const remaining = file.length - file.downloaded;
      if (remaining === 0 && file.length > 0) {
        // file.downloaded may include pieces that have not passed the torrent
        // hash bitfield. Refuse optional cache work until the original is
        // verified instead of double-counting existing physical bytes.
        if (file.done !== true || !isVerifiedComplete(session.torrent, index))
          return denied("unverified-complete-length");
      }
      if (!nonnegative(remaining) || reservedSourceBytes > Number.MAX_SAFE_INTEGER - remaining)
        return denied("source-byte-overflow");
      reservedSourceBytes += remaining;
    }
  }
  return { ok: true, reservedSourceBytes, selectedFileCount };
}

// The only shared optional-cache admission path. The supplied allowance must
// perform its own fresh physical scan; this helper never substitutes cached
// usage or treats source headroom as already allocated disk bytes.
export async function sourceProtectedCacheAllowance({
  sessions, allowance, additionalBytes, identity = null, isVerifiedComplete,
} = {}) {
  if (typeof allowance !== "function"
    || !Number.isSafeInteger(additionalBytes) || additionalBytes < 0)
    return { allowed: false, availableBytes: 0, reason: "invalid-cache-request" };
  const headroom = selectedSourceHeadroom(sessions, { identity, isVerifiedComplete });
  if (!headroom.ok)
    return { allowed: false, availableBytes: 0, reason: headroom.reason };
  const gate = await allowance({
    additionalBytes, reservedSourceBytes: headroom.reservedSourceBytes,
  });
  const available = Number.isSafeInteger(gate?.availableBytes) && gate.availableBytes >= 0
    ? gate.availableBytes : 0;
  return {
    allowed: gate?.allowed === true && additionalBytes <= available && available > 0,
    availableBytes: available,
  };
}
