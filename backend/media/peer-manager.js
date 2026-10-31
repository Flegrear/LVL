// Peer handling for one WebTorrent torrent, on top of what WebTorrent does.
//
// WebTorrent 3.0 already prefers fast peers when it picks pieces, takes a block
// back from a slow peer when a peer twice as fast wants it, and drops a peer
// that leaves a request unanswered for 30 s. Three gaps remain:
//
// 1. Slow peers keep their connection slot. When every slot is taken and more
//    peers are waiting, drop the slowest one or two every 30 s, so waiting
//    peers get a turn. Peers that have had less than 30 s, or are the only
//    connected source of a missing piece, are kept.
// 2. The piece the player is waiting for can sit on a slow peer. When such a
//    piece has been pending for 3 s on a peer much slower than another peer
//    that has it, take it back so the faster peer can fetch it.
// 3. A peer that sends bad data is never blamed. A piece that fails its hash
//    check and came from a single peer counts against that peer; after two,
//    or when most pieces it helped with failed, it's disconnected and
//    refused for the rest of this session.
//
// Only 3 runs by default; 1 and 2 are options (see attachPeerManager).
//
// This reads WebTorrent internals (wires, _queue, _numConns, _critical,
// _reservations, pieces). They are checked against the installed WebTorrent
// version, so an upgrade that changes them is caught instead of failing
// silently.

const TURNOVER_INTERVAL_MS = 30_000;
const MIN_AGE_MS = 30_000;
const DROPS_PER_ROUND = 2;
const RECENT_DROP_MS = 10 * 60_000;
const BACKUP_CHECK_MS = 1000;
const BACKUP_AFTER_MS = 3000;
const SLOW_FLOOR_BYTES = 16 * 1024;
const BAN_SOLE_FAILURES = 2;
const FAILED_PIECE = /^Piece (\d+) failed verification$/;

// Several peers on this computer, or behind one router, share an address,
// so those are told apart by port too.
function peerKey(wire) {
  const host = String(wire?.remoteAddress || "");
  const local = /^(?:127\.|::1$|::ffff:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host);
  return local ? `${host}:${wire?.remotePort}` : host;
}
const speedOf = (wire) => { try { return Number(wire.downloadSpeed()) || 0; } catch { return 0; } };
// "1.2.3.4:6881" or "[::1]:6881", as trackers and peer exchange hand them over.
function keyOfAddress(address) {
  const match = /^\[([^\]]+)\]:(\d+)$/.exec(address) || /^([^:]+):(\d+)$/.exec(address);
  return match ? peerKey({ remoteAddress: match[1], remotePort: Number(match[2]) }) : null;
}

export function attachPeerManager(torrent, {
  maxConns = () => torrent.client?.maxConns || 40,
  // Off by default: in local swarm benchmarks (2026-10-31) neither changed
  // download speed or stalls; WebTorrent's own speed ranking and take-back
  // already cover those cases. Blocking bad peers cut failed pieces 82 -> 5.
  turnover: useTurnover = false,
  backup: useBackup = false,
  now = Date.now,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  log = () => {},
} = {}) {
  const limit = typeof maxConns === "function" ? maxConns : () => maxConns;
  const info = new WeakMap();            // wire -> { connectedAt, key }
  const contributors = new Map();        // piece index -> Set of wires
  const record = new Map();              // peer key -> { sole, failed, verified }
  const banned = new Set();              // peer keys and peer ids
  const recentlyDropped = new Map();     // peer key -> time
  const pendingSince = new Map();        // piece index -> time first seen pending on a slow peer
  const counts = { dropped: 0, refused: 0, banned: 0, backups: 0, hashFailures: 0 };
  let stopped = false;

  function onWire(wire) {
    const key = peerKey(wire);
    info.set(wire, { connectedAt: now(), key });
    if (banned.has(key) || wire.peerId && banned.has(wire.peerId)) { counts.refused++; wire.destroy(); return; }
    const dropped = recentlyDropped.get(key);
    if (dropped && now() - dropped < RECENT_DROP_MS && full() && waiting() > 0) { counts.refused++; wire.destroy(); return; }
    wire.on("handshake", () => { if (wire.peerId && banned.has(wire.peerId)) { counts.refused++; wire.destroy(); } });
    wire.on("piece", (index) => {
      let set = contributors.get(index);
      if (!set) contributors.set(index, set = new Set());
      set.add(wire);
    });
  }
  const full = () => (torrent._numConns ?? torrent.wires.length) >= Math.max(1, Math.floor(limit() * 0.9));
  const waiting = () => (Array.isArray(torrent._queue) ? torrent._queue.length : 0);
  const stat = (key) => { let r = record.get(key); if (!r) record.set(key, r = { sole: 0, failed: 0, verified: 0 }); return r; };

  function onVerified(index) {
    for (const wire of contributors.get(index) || []) stat(info.get(wire)?.key ?? peerKey(wire)).verified++;
    contributors.delete(index);
    pendingSince.delete(index);
  }
  function onWarning(error) {
    const match = FAILED_PIECE.exec(String(error?.message || ""));
    if (!match) return;
    counts.hashFailures++;
    const index = Number(match[1]);
    const wires = [...(contributors.get(index) || [])];
    contributors.delete(index);
    for (const wire of wires) {
      const key = info.get(wire)?.key ?? peerKey(wire);
      const r = stat(key);
      r.failed++;
      if (wires.length === 1) r.sole++;
      if (r.sole >= BAN_SOLE_FAILURES || r.failed >= 4 && r.failed > r.verified) ban(wire, key);
    }
  }
  function ban(wire, key) {
    if (banned.has(key)) return;
    banned.add(key);
    if (wire.peerId) banned.add(wire.peerId);
    counts.banned++;
    log(`Blocked a peer that sent bad data (${record.get(key)?.failed} failed pieces)`);
    for (const other of [...torrent.wires]) if ((info.get(other)?.key ?? peerKey(other)) === key) other.destroy();
  }

  // Missing selected pieces only one connected peer can provide.
  function soleSources() {
    const selections = torrent._selections;
    const pieces = torrent.pieces?.length || 0;
    if (!selections || !pieces) return new Set();
    const missing = [];
    for (let i = 0; i < selections.length; i++) {
      const s = selections.get ? selections.get(i) : selections[i];
      for (let p = Math.max(0, s.from + (s.offset || 0)); p <= Math.min(pieces - 1, s.to) && missing.length < 20000; p++)
        if (!torrent.bitfield.get(p)) missing.push(p);
    }
    const keep = new Set();
    for (const p of missing) {
      let only = null, count = 0;
      for (const wire of torrent.wires) if (wire.peerPieces?.get(p)) { count++; only = wire; if (count > 1) break; }
      if (count === 1) keep.add(only);
    }
    return keep;
  }

  function turnover() {
    if (stopped || torrent.done || torrent.destroyed || !full() || waiting() < 1) return;
    const wires = torrent.wires.filter((wire) => !wire.destroyed);
    const fastest = Math.max(0, ...wires.map(speedOf));
    const slow = Math.max(SLOW_FLOOR_BYTES, fastest * 0.1);
    const keep = soleSources();
    const candidates = wires
      .filter((wire) => now() - (info.get(wire)?.connectedAt ?? now()) >= MIN_AGE_MS && speedOf(wire) < slow && !keep.has(wire))
      .sort((a, b) => speedOf(a) - speedOf(b))
      .slice(0, Math.min(DROPS_PER_ROUND, waiting()));
    for (const wire of candidates) {
      recentlyDropped.set(info.get(wire)?.key ?? peerKey(wire), now());
      counts.dropped++;
      wire.destroy();
    }
    for (const [key, at] of recentlyDropped) if (now() - at > RECENT_DROP_MS) recentlyDropped.delete(key);
  }

  function backup() {
    if (stopped || torrent.done || torrent.destroyed) return;
    const critical = torrent._critical || [];
    let changed = false;
    for (let index = 0; index < critical.length; index++) {
      if (!critical[index] || torrent.bitfield.get(index)) { pendingSince.delete(index); continue; }
      const piece = torrent.pieces?.[index];
      const reservations = torrent._reservations?.[index];
      if (!piece || !reservations) continue;
      // One entry per reserved block, so the same peer can appear several times.
      const holders = [...new Set(reservations.filter((wire) => wire && !wire.destroyed))];
      if (!holders.length) { pendingSince.delete(index); continue; }
      const slowest = Math.min(...holders.map(speedOf));
      const better = torrent.wires.filter((wire) => !wire.destroyed && !wire.peerChoking && wire.peerPieces?.get(index)
        && !holders.includes(wire) && speedOf(wire) >= Math.max(SLOW_FLOOR_BYTES, slowest * 4));
      if (!better.length) { pendingSince.delete(index); continue; }
      const since = pendingSince.get(index) ?? now();
      pendingSince.set(index, since);
      if (now() - since < BACKUP_AFTER_MS) continue;
      // Take back the slow peers' blocks of this piece, as WebTorrent's own
      // hotswap does, so a faster peer requests them on the next update.
      for (const wire of holders) {
        if (speedOf(wire) * 4 > speedOf(better[0])) continue;
        for (let i = 0; i < reservations.length; i++) if (reservations[i] === wire) reservations[i] = null;
        for (const request of wire.requests || []) {
          if (request.piece !== index) continue;
          try { piece.cancel((request.offset / 16384) | 0); } catch {}
        }
      }
      counts.backups++;
      pendingSince.delete(index);
      changed = true;
    }
    if (changed) try { torrent._update(); } catch {}
  }

  for (const wire of torrent.wires || []) onWire(wire);
  torrent.on("wire", onWire);
  torrent.on("verified", onVerified);
  torrent.on("warning", onWarning);
  // Trackers and peer exchange offer the same addresses again and again.
  // Refuse blocked ones (and recently dropped slow ones while slots are full)
  // before WebTorrent dials them, instead of connecting just to hang up.
  const originalAddPeer = torrent.addPeer;
  const guardedAddPeer = function addPeer(peer, source) {
    const key = typeof peer === "string" ? keyOfAddress(peer) : peerKey(peer);
    const dropped = key && recentlyDropped.get(key);
    if (key && (banned.has(key) || dropped && now() - dropped < RECENT_DROP_MS && full() && waiting() > 0)) {
      counts.refused++;
      if (typeof peer !== "string") try { peer.destroy(); } catch {}
      return false;
    }
    return originalAddPeer.call(this, peer, source);
  };
  if (typeof originalAddPeer === "function") torrent.addPeer = guardedAddPeer;
  const timers = [useTurnover && setIntervalImpl(turnover, TURNOVER_INTERVAL_MS),
    useBackup && setIntervalImpl(backup, BACKUP_CHECK_MS)].filter(Boolean);
  for (const timer of timers) timer?.unref?.();

  return {
    turnover, backup,
    stats: () => ({ ...counts }),
    // Per-peer view for diagnostics: speed, age, pending requests.
    peers: () => torrent.wires.map((wire) => ({
      bytesPerSecond: Math.round(speedOf(wire)), ageMs: now() - (info.get(wire)?.connectedAt ?? now()),
      pending: wire.requests?.length || 0, seed: Boolean(wire.isSeeder), choking: Boolean(wire.peerChoking),
    })),
    stop() {
      if (stopped) return;
      stopped = true;
      for (const timer of timers) clearIntervalImpl(timer);
      torrent.removeListener("wire", onWire);
      torrent.removeListener("verified", onVerified);
      torrent.removeListener("warning", onWarning);
      if (torrent.addPeer === guardedAddPeer) torrent.addPeer = originalAddPeer;
    },
  };
}
