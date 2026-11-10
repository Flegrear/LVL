// storage.js: how much disk the app may use, and keeping it there.
// - Player storage: the torrent files the player downloads while you watch (WebTorrent writes
//   them to a temporary folder). A session's files are deleted when you switch away from it,
//   after 30 minutes unused, or when the space is needed for the video you're watching.
// - Saved lines: the audio + still-frame clips of subtitle lines (clips.js).
// Limits live in the app database (app_meta "storage_limits"). Node only (server.js).

import fs from "node:fs/promises";
import path from "node:path";

const GB = 1024 ** 3;
export const STORAGE_DEFAULTS = Object.freeze({ playerBytes: 20 * GB, clipBytes: 2 * GB, remuxCacheEnabled: true });
export const STORAGE_RANGES = Object.freeze({
  playerBytes: { min: 2 * GB, max: 1000 * GB },
  clipBytes: { min: 0.25 * GB, max: 200 * GB },
});
const UUID_DIR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEFTOVER_IDLE_MS = 30 * 60 * 1000;
// Space checks are advisory while separate FFmpeg cache writers and torrent
// stores can grow concurrently. Keep a small unallocated budget margin rather
// than claiming bytes another in-flight writer may already be committing.
const PLAYER_CACHE_INFLIGHT_MARGIN_BYTES = 32 * 1024 ** 2;

/** Bytes and newest modification time of everything under a folder (missing folder: zero). */
// Space a file takes on disk. A torrent writes a piece wherever it falls, so a file it has only
// partly downloaded (or a deselected file that shares a piece with a wanted one) can be sparse:
// an 8 GB movie next to the sample being played reported 8 GB while using a few MB, and player
// storage then removed the other downloads to make room. Its allocated blocks count instead
// (never more than its size). Where files take their full size anyway (Windows' NTFS fills the
// gap), the count is the same as before; with no block count reported, the size is used.
export function diskBytes(stat) {
  const size = Number(stat?.size) || 0;
  const blocks = Number(stat?.blocks);
  return Number.isFinite(blocks) && blocks >= 0 ? Math.min(size, blocks * 512) : size;
}

export async function folderUsage(folder) {
  let bytes = 0;
  let files = 0;
  let newest = 0;
  let entries;
  try {
    entries = await fs.readdir(folder, { withFileTypes: true, recursive: true });
  } catch (error) {
    if (error.code === "ENOENT") return { bytes, files, newest };
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    try {
      const stat = await fs.stat(path.join(entry.parentPath || entry.path || folder, entry.name));
      bytes += diskBytes(stat);
      files += 1;
      newest = Math.max(newest, stat.mtimeMs);
    } catch {}
  }
  return { bytes, files, newest };
}

function clampLimit(key, value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  const { min, max } = STORAGE_RANGES[key];
  return Math.round(Math.max(min, Math.min(max, number)));
}

/** Free and total bytes of the drive a folder is on (the nearest folder that exists); null if unknown. */
export async function diskSpace(folder) {
  let current = path.resolve(folder);
  for (let step = 0; step < 8; step += 1) {
    try {
      const stats = await fs.statfs(current);
      return { freeBytes: Number(stats.bavail) * Number(stats.bsize), totalBytes: Number(stats.blocks) * Number(stats.bsize) };
    } catch (error) {
      const parent = path.dirname(current);
      if (error.code !== "ENOENT" || parent === current) return null;
      current = parent;
    }
  }
  return null;
}

/**
 * Suggested sizes. Player storage: 20 GB (any 1080p movie, or a few episodes at once), less when
 * the drive is nearly full so a quarter of its free space at most. Saved fragments: 2 GB, or twice
 * what card clips use now so they have room to grow, at most a tenth of the free space.
 */
export function recommendedLimits({ playerFreeBytes = null, playerUsedBytes = 0, dataFreeBytes = null, cardClipBytes = 0, clipCount = 0, clipBytes = 0,
  playerDefaultBytes = STORAGE_DEFAULTS.playerBytes } = {}) {
  const step = (bytes, size) => Math.floor(bytes / size) * size;
  let player = clampLimit("playerBytes", playerDefaultBytes, STORAGE_DEFAULTS.playerBytes);
  if (Number.isFinite(playerFreeBytes)) player = Math.min(player, step((playerFreeBytes + playerUsedBytes) * 0.25, GB));
  player = Math.max(STORAGE_RANGES.playerBytes.min, player);
  let clip = Math.max(STORAGE_DEFAULTS.clipBytes, Math.ceil((cardClipBytes * 2) / (0.5 * GB)) * 0.5 * GB);
  if (Number.isFinite(dataFreeBytes)) clip = Math.min(clip, step((dataFreeBytes + clipBytes) * 0.1, 0.25 * GB));
  clip = Math.min(STORAGE_RANGES.clipBytes.max, Math.max(STORAGE_RANGES.clipBytes.min, clip));
  // About how many saved lines fit in one GB (an average line's audio and frame).
  const lineBytes = clipCount >= 20 ? clipBytes / clipCount : 90 * 1024;
  return { playerBytes: player, clipBytes: clip, linesPerGB: Math.max(1, Math.round(GB / Math.max(1, lineBytes))) };
}

/**
 * appDatabase: getMeta/setMeta. sessionsRoot: this server's session folders (one per torrent
 * session). sharedRoot: the parent temp folder, where older versions and other ports keep theirs.
 * sessions(): [{ id, incarnation, lastUsedAt, busy }] for live sessions.
 * busy includes unexpired acquisition leases as well as active/recent streams.
 * removeSession(id, incarnation) is an atomic backend authority check: return
 * false if a new borrower entered; persistent file deletion stays behind its
 * per-infohash disposal fence before the same Android directory can be reused.
 */
// defaults: other starting limits (LVL's Android app has less room). remuxCacheAvailable: false
// keeps the seek cache off whatever was saved (its conversions need an H.264 encoder).
// keepsSessionFiles: a session's torrent files stay when it ends (LVL's Android app keeps
// downloads between launches), so evicting a live download also deletes its folder.
export function createStorageManager({ appDatabase, sessionsRoot, sharedRoot, dataRoot = "", sessions, removeSession, clipStore, ankiStore, legacyMediaUsage,
  defaults: defaultChanges = {}, remuxCacheAvailable = true, keepsSessionFiles = false }) {
  const defaults = Object.freeze({ ...STORAGE_DEFAULTS, ...defaultChanges });
  function limits() {
    let saved = {};
    try { saved = JSON.parse(appDatabase.getMeta("storage_limits") || "{}") || {}; } catch {}
    return {
      playerBytes: clampLimit("playerBytes", saved.playerBytes, defaults.playerBytes),
      clipBytes: clampLimit("clipBytes", saved.clipBytes, defaults.clipBytes),
      remuxCacheEnabled: remuxCacheAvailable && (typeof saved.remuxCacheEnabled === "boolean" ? saved.remuxCacheEnabled : defaults.remuxCacheEnabled),
    };
  }

  function setLimits(changes = {}) {
    const current = limits();
    const next = {
      playerBytes: changes.playerBytes === undefined ? current.playerBytes : clampLimit("playerBytes", changes.playerBytes, current.playerBytes),
      clipBytes: changes.clipBytes === undefined ? current.clipBytes : clampLimit("clipBytes", changes.clipBytes, current.clipBytes),
      remuxCacheEnabled: remuxCacheAvailable && (typeof changes.remuxCacheEnabled === "boolean" ? changes.remuxCacheEnabled : current.remuxCacheEnabled),
    };
    appDatabase.setMeta("storage_limits", JSON.stringify(next));
    return next;
  }

  async function playerUsage() {
    const live = new Map(sessions().map((session) => [session.id, session]));
    const rows = [];
    let usedBytes = 0;
    let names = [];
    try { names = await fs.readdir(sessionsRoot); } catch {}
    for (const name of names) {
      const usage = await folderUsage(path.join(sessionsRoot, name));
      usedBytes += usage.bytes;
      const session = live.get(name);
      rows.push({ id: name, bytes: usage.bytes, live: Boolean(session), busy: Boolean(session?.busy),
        incarnation: session?.incarnation || null, name: session?.name || "", lastUsedAt: session?.lastUsedAt || usage.newest });
    }
    return { usedBytes, sessions: rows };
  }

  /**
   * Advisory, conservative space gate for a progressive remux writer. Cached
   * browser-playable fragments live inside sessionsRoot and are therefore
   * counted in EXACTLY the same cap as WebTorrent's original pieces. Never
   * reserve the last 256 MiB of physical disk for optional remux cache work.
   * Concurrent torrent downloads can grow between checks; the writer must
   * re-check periodically and stop cleanly when the allowance reaches zero.
   * reservedSourceBytes protects the not-yet-downloaded parts of videos that
   * are actively streaming, so optional remux output cannot consume space
   * needed for the original torrent to finish downloading.
   */
  async function playerCacheAllowance({ additionalBytes = 0, reservedSourceBytes = 0 } = {}) {
    const max = limits();
    const requested = Number(additionalBytes);
    const reserved = Number(reservedSourceBytes);
    if (!Number.isSafeInteger(requested) || requested < 0 || !Number.isSafeInteger(reserved) || reserved < 0)
      return { allowed: false, availableBytes: 0, usedBytes: 0, limitBytes: max.playerBytes };
    const [usage, drive] = await Promise.all([playerUsage(), diskSpace(sharedRoot)]);
    const budgetFree = Math.max(0, max.playerBytes - usage.usedBytes - reserved - PLAYER_CACHE_INFLIGHT_MARGIN_BYTES);
    const diskFree = drive ? Math.max(0, drive.freeBytes - 256 * 1024 ** 2) : 0;
    const availableBytes = max.remuxCacheEnabled ? Math.max(0, Math.min(budgetFree, diskFree)) : 0;
    return {
      allowed: max.remuxCacheEnabled && requested <= availableBytes && availableBytes > 0,
      availableBytes,
      usedBytes: usage.usedBytes,
      limitBytes: max.playerBytes,
    };
  }

  // Only legacy UUID folders are eligible for orphan cleanup. Another port's
  // download folder can belong to a live app whose open streams do not update
  // filesystem mtimes for an hour. Never delete another LVL instance's cache.
  async function leftovers({ now = Date.now() } = {}) {
    const found = [];
    let names = [];
    try { names = await fs.readdir(sharedRoot, { withFileTypes: true }); } catch {}
    const own = path.resolve(sessionsRoot);
    for (const entry of names) {
      if (!entry.isDirectory()) continue;
      const folder = path.join(sharedRoot, entry.name);
      if (path.resolve(folder) === own) continue;
      if (!UUID_DIR.test(entry.name)) continue;
      const usage = await folderUsage(folder);
      let stat = null;
      try { stat = await fs.stat(folder); } catch {}
      const lastActivity = Math.max(usage.newest, stat?.mtimeMs || 0);
      if (now - lastActivity < LEFTOVER_IDLE_MS) continue;
      found.push({ folder, bytes: usage.bytes, lastActivity });
    }
    return { bytes: found.reduce((sum, item) => sum + item.bytes, 0), folders: found };
  }

  async function clearLeftovers() {
    const { folders } = await leftovers();
    let freed = 0;
    let removed = 0;
    for (const item of folders) {
      try {
        await fs.rm(item.folder, { recursive: true, force: true, maxRetries: 2 });
        freed += item.bytes;
        removed += 1;
      } catch {}
    }
    return { removed, freedBytes: freed };
  }

  // This server's own folders with no live session: left by a crash or a forced stop.
  async function clearOrphans() {
    // Persistent download folders are deliberately not tied to active sessions.
    if (keepsSessionFiles) return 0;
    const live = new Set(sessions().map((session) => session.id));
    let names = [];
    try { names = await fs.readdir(sessionsRoot); } catch {}
    let removed = 0;
    for (const name of names) {
      if (live.has(name) || sessions().some((session) => session.id === name)) continue;
      try {
        await fs.rm(path.join(sessionsRoot, name), { recursive: true, force: true, maxRetries: 2 });
        removed += 1;
      } catch {}
    }
    return removed;
  }

  /**
   * Keeps player storage under its limit: removes downloads you aren't watching, least recently
   * used first. The video that's playing (busy, or used in the last minute) is never removed.
   */
  async function enforcePlayer({ now = Date.now(), limitBytes = null } = {}) {
    const limit = Number(limitBytes) > 0 ? Number(limitBytes) : limits().playerBytes;
    const usage = await playerUsage();
    const evicted = [];
    if (usage.usedBytes <= limit) return { evicted, usedBytes: usage.usedBytes, limitBytes: limit };
    let usedBytes = usage.usedBytes;
    const idle = usage.sessions
      .filter((row) => !row.busy && (!row.live || now - Number(row.lastUsedAt || 0) > 60_000))
      .sort((a, b) => Number(a.lastUsedAt || 0) - Number(b.lastUsedAt || 0));
    for (const row of idle) {
      if (usedBytes <= limit) break;
      // Snapshot data can be stale after an awaited disk scan. Re-read the
      // live borrower and incarnation immediately before calling removal.
      const current = sessions().find((session) => session.id === row.id);
      if (current?.busy || (!row.live && current)
        || (row.live && (current?.incarnation || null) !== row.incarnation)
        || (current && now - Number(current.lastUsedAt || 0) <= 60_000)) continue;
      if (row.live && !current) continue; // Gone or being replaced; never delete its new folder.
      if (row.live && await removeSession(row.id, row.incarnation) === false) continue;
      // For persistent Android sessions, the backend removes files inside
      // its disposal fence, before a new session may use the same directory.
      if (!row.live && !sessions().some((session) => session.id === row.id))
        await fs.rm(path.join(sessionsRoot, row.id), { recursive: true, force: true, maxRetries: 2 }).catch(() => {});
      // An abandoned store or locked file may survive the attempted deletion.
      // Count only disk bytes actually gone; otherwise a failed eviction
      // falsely reports the cache as within its configured limit.
      const remaining = (await folderUsage(path.join(sessionsRoot, row.id))).bytes;
      usedBytes = Math.max(0, usedBytes - Math.max(0, row.bytes - remaining));
      if (remaining === 0) evicted.push(row.id);
    }
    return { evicted, usedBytes: (await playerUsage()).usedBytes, limitBytes: limit };
  }

  async function clearPlayer() {
    const usage = await playerUsage();
    for (const row of usage.sessions) {
      if (row.busy || (row.live && Date.now() - Number(row.lastUsedAt || 0) < 60_000)) continue;
      const current = sessions().find((session) => session.id === row.id);
      if (current?.busy || (!row.live && current)
        || (row.live && (current?.incarnation || null) !== row.incarnation)
        || (current && Date.now() - Number(current.lastUsedAt || 0) < 60_000)) continue;
      if (row.live && !current) continue;
      if (row.live && await removeSession(row.id, row.incarnation) === false) continue;
      if (!row.live && !sessions().some((session) => session.id === row.id))
        await fs.rm(path.join(sessionsRoot, row.id), { recursive: true, force: true, maxRetries: 2 }).catch(() => {});
    }
    // Report bytes actually gone, not an assumed sum when deletion fails.
    return { freedBytes: Math.max(0, usage.usedBytes - (await playerUsage()).usedBytes) };
  }

  function enforceClips(referencedIds) {
    return clipStore?.collectGarbage(referencedIds, { maxBytes: limits().clipBytes })
      ?? { demoted: 0, removed: 0 };
  }

  async function report() {
    const [player, leftover, playerDisk, dataDisk] = await Promise.all([playerUsage(), leftovers(), diskSpace(sharedRoot), dataRoot ? diskSpace(dataRoot) : null]);
    const legacy = legacyMediaUsage?.();
    const clips = clipStore?.stats() || legacy?.clips || {};
    const decks = ankiStore?.listDecks() || [];
    const clipBytes = (clips.card?.bytes || 0) + (clips.dictation?.bytes || 0);
    return {
      limits: limits(),
      defaults,
      remuxCacheAvailable,
      ranges: STORAGE_RANGES,
      recommended: recommendedLimits({
        playerDefaultBytes: defaults.playerBytes,
        playerFreeBytes: playerDisk?.freeBytes ?? null,
        playerUsedBytes: player.usedBytes,
        dataFreeBytes: dataDisk?.freeBytes ?? null,
        cardClipBytes: clips.card?.bytes || 0,
        clipCount: (clips.card?.count || 0) + (clips.dictation?.count || 0),
        clipBytes,
      }),
      disk: { playerFreeBytes: playerDisk?.freeBytes ?? null, dataFreeBytes: dataDisk?.freeBytes ?? null },
      player: {
        usedBytes: player.usedBytes,
        videos: player.sessions.filter((row) => row.bytes > 0).length,
        leftoverBytes: leftover.bytes,
        leftoverFolders: leftover.folders.length,
      },
      clips: {
        cardCount: clips.card?.count || 0,
        cardBytes: clips.card?.bytes || 0,
        dictationCount: clips.dictation?.count || 0,
        dictationBytes: clips.dictation?.bytes || 0,
        usedBytes: (clips.card?.bytes || 0) + (clips.dictation?.bytes || 0),
      },
      decks: legacy?.decks || { count: decks.length, mediaBytes: decks.reduce((sum, deck) => sum + (Number(deck.mediaBytes) || 0), 0) },
    };
  }

  return { limits, setLimits, playerUsage, playerCacheAllowance, leftovers, clearLeftovers, clearOrphans, enforcePlayer, clearPlayer, enforceClips, report };
}
