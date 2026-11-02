// Torrent sessions: magnets, manifests, the session list and its expiry.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { dropSpeechTapes } from "../media/speech-tape.js";
import { attachPeerManager } from "../media/peer-manager.js";
import {
  FALLBACK_TRACKERS, indexedVideoCache, internalReaderRoles, MAX_TORRENT_FILES,
  MAX_TORRENT_VIDEO_BYTES, mediaProbeCache, mime, port, progressiveIndexCache,
  progressiveIslandStarts, progressiveStarts, remuxSegmentCache, storage, streamHealth,
  TORRENT_SESSION_TTL_MS, torrentClient, torrentRoot, torrentSessions, VIDEO_EXTENSIONS,
} from "../../server.js";
import { json, readJsonBody } from "../app/http-helpers.js";
import { closeProgressiveReadyListeners } from "../streaming/torrent-stream.js";
import { getCachedMediaProbe } from "../media/torrent-probe.js";
import { invalidateSpeechWindowSession } from "../media/speech-activity.js";

const MAX_MAGNET_LENGTH = 16 * 1024;
const MAX_TORRENT_SESSIONS = 4;

const MAX_TORRENT_VIDEO_FILES = 64;
const MAX_TORRENT_TOTAL_BYTES = 80 * 1024 * 1024 * 1024;

const MAX_TORRENT_SIDECAR_BYTES = 64 * 1024 * 1024;
const MAX_TORRENT_PATH_LENGTH = 512;

const TORRENT_SLOW_METADATA_MS = 20 * 1000;

const DIRECT_VIDEO_EXTENSIONS = new Set([".mp4", ".m4v", ".webm", ".ogv", ".ogg"]);
const SAFE_TORRENT_SIDECAR_EXTENSIONS = new Set([
  ".srt", ".vtt", ".ass", ".ssa", ".sub", ".idx",
  ".jpg", ".jpeg", ".png", ".webp", ".gif",
  ".nfo", ".txt", ".sfv",
]);

export function internalTorrentSource(session, fileIndex, role) {
  const base = `http://127.0.0.1:${port}/api/torrents/${encodeURIComponent(session.id)}/files/${fileIndex}/stream`;
  const lease = internalReaderRoles.issue(session, fileIndex, role);
  return { url: lease?.urlFor(base) || base, release: () => lease?.release() };
}

function validateMagnet(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_MAGNET_LENGTH) return null;
  if (!value.startsWith("magnet:?")) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "magnet:") return null;
    const xt = parsed.searchParams.get("xt") || "";
    if (!/^urn:btih:[a-f0-9]{32,40}$/i.test(xt)) return null;
    return value;
  } catch {
    return null;
  }
}

function magnetInfoHash(value) {
  try {
    const xt = new URL(value).searchParams.get("xt") || "";
    return xt.replace(/^urn:btih:/i, "").toLowerCase();
  } catch {
    return "";
  }
}

function fallbackTrackersForMagnet(value) {
  try {
    const parsed = new URL(value);
    return parsed.searchParams.has("tr") ? undefined : FALLBACK_TRACKERS;
  } catch {
    return undefined;
  }
}

export function safeTorrentRelativePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_TORRENT_PATH_LENGTH) return false;
  if (value.includes("\0") || /[\u0000-\u001f]/.test(value)) return false;
  if (/^(?:[a-z]:[\\/]|[\\/]{1,2})/i.test(value)) return false;
  const parts = value.split(/[\\/]+/);
  return parts.every((part) => part && part !== "." && part !== "..");
}

function validateTorrentManifest(torrent, { preferredFileIndex = null } = {}) {
  const files = Array.isArray(torrent?.files) ? torrent.files : [];
  if (!files.length) return { ok: false, reason: "Torrent contains no files" };
  const targeted = Number.isInteger(preferredFileIndex) && preferredFileIndex >= 0;
  const maxFiles = targeted ? Math.max(MAX_TORRENT_FILES, 512) : MAX_TORRENT_FILES;
  if (files.length > maxFiles) {
    return { ok: false, reason: `Torrent has too many files (${files.length}; max ${maxFiles})` };
  }

  let totalBytes = 0;
  let videoFiles = 0;
  let sidecarFiles = 0;
  const preferredFile = targeted ? files[preferredFileIndex] : null;
  for (const file of files) {
    const filePath = String(file.path || file.name || "");
    if (!safeTorrentRelativePath(filePath)) {
      return { ok: false, reason: "Torrent contains an unsafe file path" };
    }
    const length = Number(file.length);
    if (!Number.isSafeInteger(length) || length <= 0) {
      return { ok: false, reason: `Torrent contains an invalid file size: ${path.basename(filePath)}` };
    }
    totalBytes += length;
    if (!Number.isSafeInteger(totalBytes)) {
      return { ok: false, reason: "Torrent size metadata is invalid" };
    }
    if (!targeted && totalBytes > MAX_TORRENT_TOTAL_BYTES) {
      return { ok: false, reason: `Torrent is too large (max ${Math.round(MAX_TORRENT_TOTAL_BYTES / 1024 / 1024 / 1024)} GB)` };
    }

    const ext = path.extname(filePath).toLowerCase();
    if (targeted) continue;
    if (VIDEO_EXTENSIONS.has(ext)) {
      videoFiles += 1;
      if (videoFiles > MAX_TORRENT_VIDEO_FILES) {
        return { ok: false, reason: `Torrent has too many video files (max ${MAX_TORRENT_VIDEO_FILES})` };
      }
      if (length > MAX_TORRENT_VIDEO_BYTES) {
        return { ok: false, reason: `A video file is too large (max ${Math.round(MAX_TORRENT_VIDEO_BYTES / 1024 / 1024 / 1024)} GB)` };
      }
      continue;
    }
    if (!SAFE_TORRENT_SIDECAR_EXTENSIONS.has(ext)) {
      return { ok: false, reason: `Unsupported file type in torrent: ${ext || "no extension"}` };
    }
    sidecarFiles += 1;
    if (length > MAX_TORRENT_SIDECAR_BYTES) {
      return { ok: false, reason: `A sidecar file is too large: ${path.basename(filePath)}` };
    }
  }

  if (targeted) {
    if (!preferredFile) return { ok: false, reason: "Requested torrent file was not found" };
    const preferredPath = String(preferredFile.path || preferredFile.name || "");
    const preferredExt = path.extname(preferredPath).toLowerCase();
    const preferredLength = Number(preferredFile.length);
    if (!VIDEO_EXTENSIONS.has(preferredExt)) return { ok: false, reason: "Requested torrent file is not a supported video" };
    if (!Number.isSafeInteger(preferredLength) || preferredLength <= 0 || preferredLength > MAX_TORRENT_VIDEO_BYTES) {
      return { ok: false, reason: `Requested video is too large (max ${Math.round(MAX_TORRENT_VIDEO_BYTES / 1024 / 1024 / 1024)} GB)` };
    }
    return { ok: true, fileCount: files.length, videoFiles: 1, sidecarFiles: 0, totalBytes, targeted: true, preferredFileIndex };
  }

  if (!videoFiles) return { ok: false, reason: "Torrent contains no supported video files" };
  return { ok: true, fileCount: files.length, videoFiles, sidecarFiles, totalBytes };
}

export async function removeTorrentSession(id) {
  const session = torrentSessions.get(id);
  if (!session) return;
  torrentSessions.delete(id);
  // Stop only the background conversion for this session; it may still be
  // reading selected pieces through an internal local HTTP stream.
  await indexedVideoCache.stopSession(id);
  await progressiveIndexCache.stopSession(id);
  for (const [key,attempt] of progressiveStarts) {
    if (attempt.sessionId===id) progressiveStarts.delete(key);
  }
  // Keys are SHA-256 cache identities. Session-scoped cleanup follows each
  // associated start; unused islands are bounded globally and on Settings OFF.
  if (!progressiveStarts.size) progressiveIslandStarts.clear();
  closeProgressiveReadyListeners(id);
  await remuxSegmentCache.dropSession(id).catch(() => {});
  invalidateSpeechWindowSession(session);
  streamHealth.clear(session);
  internalReaderRoles.clear(session);
  session.peerManager?.stop();
  dropSpeechTapes(id);
  for (const key of mediaProbeCache.keys()) {
    if (key.startsWith(`${id}:`)) mediaProbeCache.delete(key);
  }
  clearTimeout(session.expiryTimer);
  clearTimeout(session.slowTimer);
  try {
    if (session.torrent && !session.torrent.destroyed) {
      await session.torrent.destroy({ destroyStore: true });
    }
  } catch (error) {
    console.warn(`Failed to destroy torrent session ${id}:`, error.message);
  }
}

export function scheduleSessionExpiry(session) {
  clearTimeout(session.expiryTimer);
  session.expiryTimer = setTimeout(() => {
    // A slow stream/transcode may run longer than the inactivity TTL without
    // issuing another status request. Do not tear down an actively playing file.
    if ((Number(session.openStreams) || 0) > 0) {
      scheduleSessionExpiry(session);
      return;
    }
    void removeTorrentSession(session.id);
  }, TORRENT_SESSION_TTL_MS);
  session.expiryTimer.unref?.();
}

// How much of each stretch of one file is downloaded: 120 buckets over the file's bytes, 0-255 each.
// The player draws it under the timeline (bytes map roughly linearly to time).
export function fileDownloadMap(session, fileIndex, buckets = 120) {
  const torrent = session.torrent;
  const file = torrent?.files?.[fileIndex];
  const pieceLength = Number(torrent?.pieceLength) || 0;
  if (!file || !pieceLength || !torrent.bitfield || !(Number(file.length) > 0)) return null;
  const values = new Uint8Array(buckets);
  const offset = Number(file.offset) || 0;
  const length = Number(file.length);
  for (let bucket = 0; bucket < buckets; bucket += 1) {
    const from = offset + Math.floor((length * bucket) / buckets);
    const to = offset + Math.max(Math.floor((length * (bucket + 1)) / buckets) - 1, Math.floor((length * bucket) / buckets));
    const firstPiece = Math.floor(from / pieceLength);
    const lastPiece = Math.floor(to / pieceLength);
    let have = 0;
    for (let piece = firstPiece; piece <= lastPiece; piece += 1) if (torrent.bitfield.get(piece)) have += 1;
    values[bucket] = Math.round((have / (lastPiece - firstPiece + 1)) * 255);
  }
  return { buckets, progress: Number(file.progress) || 0, map: Buffer.from(values).toString("base64") };
}

export function sessionPayload(session) {
  const torrent = session.torrent;
  return {
    id: session.id,
    state: session.state,
    error: session.error || null,
    infoHash: torrent.infoHash || session.infoHash,
    name: torrent.name || session.displayName || "Resolving torrent…",
    length: torrent.length || 0,
    preferredFileIndex: Number.isInteger(session.preferredFileIndex) ? session.preferredFileIndex : null,
    numPeers: torrent.numPeers || 0,
    progress: torrent.progress || 0,
    downloaded: Number(torrent.downloaded) || (torrent.files || []).reduce((sum, file) => sum + (Number(file.downloaded) || 0), 0),
    uploaded: Number(torrent.uploaded) || 0,
    downloadSpeed: Number(torrent.downloadSpeed) || 0,
    uploadSpeed: Number(torrent.uploadSpeed) || 0,
    streamHealth: streamHealth.snapshot(session, { torrent }),
    peerChanges: session.peerManager?.stats() || null,
    safety: session.safety || null,
    files: (torrent.files || []).map((file, index) => {
      const ext = path.extname(file.name).toLowerCase();
      const cachedProbe = getCachedMediaProbe(session.id, index);
      const needsTranscode = cachedProbe?.compatibility?.defaultNeedsTranscode
        ?? (!DIRECT_VIDEO_EXTENSIONS.has(ext) || /(?:h\.?265|hevc|x265)/i.test(file.name));
      return {
        index,
        name: file.name,
        path: file.path,
        length: file.length,
        downloaded: file.downloaded,
        progress: file.progress,
        // Unlike downloaded/progress (which can include partial, not-yet-
        // verified piece bytes), done is WebTorrent's hash-verified file EOF.
        verifiedComplete: file.done === true && Number(file.downloaded) === Number(file.length),
        video: VIDEO_EXTENSIONS.has(ext),
        needsTranscode,
        type: file.type || mime[ext] || "application/octet-stream",
        streamUrl: `/api/torrents/${session.id}/files/${index}/stream`,
        transcodeUrl: `/api/torrents/${session.id}/files/${index}/transcode`,
        metadataUrl: `/api/torrents/${session.id}/files/${index}/metadata`,
        durationSeconds: cachedProbe?.durationSeconds ?? null,
        durationMs: cachedProbe?.durationMs ?? null,
        media: cachedProbe || null,
      };
    }),
  };
}

function shouldRetryErroredTorrentSession(session, preferredFileIndex) {
  return session?.state === "error"
    && (preferredFileIndex !== null || session.safety?.ok !== false);
}

function selectPreferredTorrentDownload(session) {
  // WebTorrent's file.createReadStream() selects only its active byte range,
  // then DESELECTS that range when a seek/error closes the reader. Without an
  // ordinary file selection, a stalled/failed player leaves no demand for its
  // remaining episode pieces even if dozens of peers are connected.
  // Select exactly the validated, playable episode, never an entire pack.
  if (session?.state !== "ready" || session.safety?.ok !== true) return;
  const files = session.torrent?.files || [];
  const index = Number.isInteger(session.preferredFileIndex)
    ? session.preferredFileIndex : -1;
  const next = files[index];
  const valid = Boolean(next && VIDEO_EXTENSIONS.has(path.extname(next.name).toLowerCase())
    && Number(next.length) > 0 && Number(next.length) <= MAX_TORRENT_VIDEO_BYTES
    && Number(next.length) <= storage.limits().playerBytes);
  const desired = valid ? index : null;
  if (session.downloadSelectionIndex === desired) return;
  const previous = session.downloadSelectionIndex;
  if (Number.isInteger(previous)) files[previous]?.deselect();
  session.downloadSelectionIndex = null;
  if (desired === null) return;
  next.select();
  session.downloadSelectionIndex = desired;
}

export async function createTorrentSession(req, res) {
  const body = await readJsonBody(req);
  const magnet = validateMagnet(body.magnet);
  if (!magnet) {
    json(res, 400, { error: "A valid BitTorrent magnet URI is required" });
    return;
  }
  const preferredFileIndex = Number.isInteger(body.preferredFileIndex) && body.preferredFileIndex >= 0
    ? body.preferredFileIndex
    : null;

  const infoHash = magnetInfoHash(magnet);
  let existingSession = [...torrentSessions.values()].find((session) =>
    session.infoHash === infoHash || session.torrent?.infoHash?.toLowerCase() === infoHash,
  );
  // Retry transient tracker/network failures even for magnet-only playback.
  // Keep deterministic safety rejections cached unless a different file was requested.
  if (shouldRetryErroredTorrentSession(existingSession, preferredFileIndex)) {
    await removeTorrentSession(existingSession.id);
    existingSession = null;
  }
  if (existingSession) {
    if (preferredFileIndex !== null) existingSession.preferredFileIndex = preferredFileIndex;
    selectPreferredTorrentDownload(existingSession);
    scheduleSessionExpiry(existingSession);
    json(res, 200, { ...sessionPayload(existingSession), reused: true });
    return;
  }

  if (torrentSessions.size >= MAX_TORRENT_SESSIONS) {
    json(res, 429, { error: `Maximum of ${MAX_TORRENT_SESSIONS} active torrent sessions reached` });
    return;
  }

  // A previous failed request can leave a WebTorrent instance registered even
  // when our session map no longer knows about it. Remove that orphan so a
  // retry of the same magnet does not fail as a duplicate torrent.
  const orphan = torrentClient.torrents.find((candidate) => candidate.infoHash?.toLowerCase() === infoHash);
  if (orphan) {
    try {
      await orphan.destroy({ destroyStore: true });
    } catch {}
  }

  const id = crypto.randomUUID();
  fs.mkdirSync(torrentRoot, { recursive: true });

  let torrent;
  try {
    torrent = torrentClient.add(magnet, {
      path: path.join(torrentRoot, id),
      addUID: true,
      deselect: true,
      destroyStoreOnDestroy: true,
      announce: fallbackTrackersForMagnet(magnet),
    });
  } catch (error) {
    json(res, 500, { error: error.message || "Unable to create torrent session" });
    return;
  }

  const displayName = (() => {
    try { return new URL(magnet).searchParams.get("dn") || ""; } catch { return ""; }
  })();
  const session = {
    id,
    torrent,
    infoHash,
    displayName,
    state: "resolving",
    error: null,
    preferredFileIndex,
    expiryTimer: null,
    slowTimer: null,
    // Slow-peer turnover, playhead backup requests and bad-data blocking.
    peerManager: attachPeerManager(torrent, { maxConns: () => torrentClient.maxConns }),
  };
  torrentSessions.set(id, session);
  scheduleSessionExpiry(session);

  const markReady = () => {
    if (session.state === "ready" || session.state === "error") return;
    clearTimeout(session.slowTimer);
    session.slowTimer = null;
    for (const file of torrent.files || []) file.deselect();
    const safety = validateTorrentManifest(torrent, { preferredFileIndex: session.preferredFileIndex });
    session.safety = safety;
    if (!safety.ok) {
      session.state = "error";
      session.error = `Torrent rejected: ${safety.reason}`;
      return;
    }
    session.state = "ready";
    session.error = null;
    selectPreferredTorrentDownload(session);
  };
  torrent.once("metadata", markReady);
  torrent.once("ready", markReady);
  torrent.once("error", (error) => {
    clearTimeout(session.slowTimer);
    session.slowTimer = null;
    session.state = "error";
    session.error = error.message || "Torrent error";
  });
  session.slowTimer = setTimeout(() => {
    if (session.state === "resolving") session.state = "resolving-slow";
  }, TORRENT_SLOW_METADATA_MS);
  session.slowTimer.unref?.();

  // Metadata may already be available for a cached/very fast torrent before
  // the listeners above are attached.
  if ((torrent.files || []).length) markReady();

  json(res, 202, { ...sessionPayload(session), reused: false });
}

export function getTorrentSession(id) {
  const session = torrentSessions.get(id);
  if (!session) return null;
  session.lastUsedAt = Date.now();
  scheduleSessionExpiry(session);
  return session;
}

// While a stream or conversion is open, the session counts as playing (never evicted for space).
export function trackOpenStream(session, res, fileIndex = null) {
  session.openStreams = (Number(session.openStreams) || 0) + 1;
  const tracksFile = Number.isSafeInteger(fileIndex) && fileIndex >= 0;
  if (tracksFile) {
    session.activeStreamFiles ||= new Map();
    session.activeStreamFiles.set(fileIndex, (session.activeStreamFiles.get(fileIndex) || 0) + 1);
  }
  res.once("close", () => {
    session.openStreams = Math.max(0, (Number(session.openStreams) || 0) - 1);
    if (tracksFile) {
      const remaining = (session.activeStreamFiles?.get(fileIndex) || 0) - 1;
      if (remaining > 0) session.activeStreamFiles.set(fileIndex, remaining);
      else session.activeStreamFiles?.delete(fileIndex);
    }
    session.lastUsedAt = Date.now();
  });
}

// A video bigger than the player storage limit can't be kept while it plays.
export function rejectOversizeVideo(res, file) {
  const limit = storage.limits().playerBytes;
  if (Number(file?.length) <= limit) return false;
  json(res, 507, { error: `This video is ${(Number(file.length) / 1024 ** 3).toFixed(1)} GB, more than the ${Math.round(limit / 1024 ** 3)} GB of player storage. Raise the limit in Settings, Storage.`, code: "player_storage_too_small" });
  return true;
}
