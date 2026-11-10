// One session-local owner for content selections. Navigation and individual
// playback requests can invalidate their own work without becoming selections.
// The last token stays current after settlement so obsolete async work cannot
// regain authority even if the next selection has the same series/file key.
export function createPlaybackIntentOwner() {
  let epoch = 0;
  let record = null;

  const owns = (token) => Boolean(token && record?.token === token);
  const current = () => record && Object.freeze({ token: record.token, phase: record.phase });
  const canContinue = (token) => owns(token) && record.phase === "pending";

  return Object.freeze({
    begin(kind) {
      if (!kind || typeof kind !== "string") throw new TypeError("Playback intent kind is required");
      const token = Object.freeze({ epoch: ++epoch, kind });
      record = { token, phase: "pending" };
      return token;
    },
    owns,
    current,
    canContinue,
    hasPendingSelection() {
      return record?.phase === "pending" || record?.phase === "cancel-requested";
    },
    cancelCurrentForNavigation(token) {
      if (!canContinue(token)) return false;
      record.phase = "cancel-requested";
      return true;
    },
    settle(token, outcome) {
      if (!owns(token)) return false;
      if (record.phase === "adopted" || record.phase === "settled") return false;
      // A cancelled attempt cannot accept after navigation, even if its source
      // promise falsely reports success. Its real media/request guards remain.
      record.phase = outcome === "accepted" && record.phase === "pending" ? "adopted" : "settled";
      return true;
    },
  });
}

export const playbackIntentOwner = createPlaybackIntentOwner();

// Match the backend's validateMagnet/magnetInfoHash reuse identity. The
// metadata endpoint validates xt as 32-40 hexadecimal characters, then uses
// its lowercase btih value; display names and trackers do not identify a
// separate session. An unrecognized URI cannot establish disjoint resources.
export function torrentResourceKey(magnet) {
  if (typeof magnet !== "string" || magnet.length > 16 * 1024 || !magnet.startsWith("magnet:?")) return null;
  try {
    const parsed = new URL(magnet);
    if (parsed.protocol !== "magnet:") return null;
    const xt = parsed.searchParams.get("xt") || "";
    if (!/^urn:btih:[a-f0-9]{32,40}$/i.test(xt)) return null;
    return xt.slice("urn:btih:".length).toLowerCase();
  } catch {
    return null;
  }
}

export function mayShareTorrentResource(first, second) {
  const a = torrentResourceKey(first);
  const b = torrentResourceKey(second);
  return !a || !b || a === b;
}

// Torrent metadata POSTs can return an existing session, even when the newer
// selection has not received a session ID yet. Track that *resource* lifetime
// separately from playback selection and request generations. A known different
// magnet (or a different returned session ID) never blocks safe orphan cleanup.
export function createPlaybackSessionReservationOwner() {
  const pending = new Set();
  return Object.freeze({
    begin(intent, magnet = null) {
      const record = { intent, magnet: magnet || null, session: null };
      pending.add(record);
      return record;
    },
    observe(record, session) {
      if (!record || !session?.id) return false;
      record.session = session; // Preserve provenance even if the work was superseded.
      return pending.has(record);
    },
    setMagnet(record, magnet) {
      if (!pending.has(record) || record.session?.id) return false;
      record.magnet = magnet || null;
      return true;
    },
    session(record) { return record?.session || null; },
    hasLease(lease, owns) {
      if (!lease) return false;
      for (const record of pending) {
        if (record.intent && !owns(record.intent)) continue;
        if (record.session?.sessionLease === lease) return true;
      }
      return false;
    },
    retire(record) { return pending.delete(record); },
    retireStale(owns) {
      for (const record of pending) {
        if (record.intent && !owns(record.intent)) pending.delete(record);
      }
    },
    mayReuse(sessionId, magnet, owns) {
      for (const record of pending) {
        if (record.intent && !owns(record.intent)) continue;
        if (record.session?.id) {
          if (record.session.id === sessionId) return true;
          continue;
        }
        if (mayShareTorrentResource(record.magnet, magnet)) return true;
      }
      return false;
    },
  });
}

export const playbackSessionReservationOwner = createPlaybackSessionReservationOwner();
