// A shared, synchronous ownership reservation around each asynchronous
// torrent directory operation. POST allocation and Storage orphan retirement
// must both call the same instance through torrent-sessions.js.
export function createTorrentDirectoryAdmission() {
  const operations = new Map();
  async function withFence(key, action) {
    while (operations.has(key)) await operations.get(key);
    let release;
    const held = new Promise(resolve => { release = resolve; });
    operations.set(key, held);
    try { return await action(); }
    finally {
      if (operations.get(key) === held) operations.delete(key);
      release();
    }
  }
  return { withFence, hasFence: key => operations.has(key) };
}

// Run the final borrower check inside the SAME synchronous turn as the
// retirement fence. The caller handles actual filesystem deletion under it.
export function canRetireTorrentBorrower(session, {
  expectedIncarnation = null, now = Date.now(), streamGapMs = 5 * 60_000,
} = {}) {
  if (!session || session.closing ||
      (expectedIncarnation && session.incarnation !== expectedIncarnation)) return false;
  if ((Number(session.openStreams) || 0) > 0) return false;
  if (session.leases instanceof Map) {
    for (const [token, expiry] of session.leases) {
      if (!Number.isFinite(expiry) || expiry <= now) session.leases.delete(token);
    }
    if (session.leases.size) return false;
  }
  const last = Number(session.lastStreamAt);
  return !(last > 0 && now - last >= 0 && now - last < streamGapMs);
}
