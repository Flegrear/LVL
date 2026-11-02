import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import WebTorrent from "webtorrent";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import { createAnkiStore } from "./learning/anki/anki-store.js";
import { createClipStore } from "./learning/clips.js";
import { createStorageManager } from "./backend/persistence/storage.js";
import { createRecsStore } from "./backend/recommendations/recs-store.js";
import { createRecsService } from "./backend/recommendations/recs-service.js";
import { createAniListClient } from "./backend/integrations/anilist.js";
import { createReleaseCalendarService } from "./backend/catalog/calendar-releases.js";
import { createAnimeDiscoveryService } from "./backend/catalog/anime-discovery.js";
import { createAppDatabase } from "./backend/persistence/app-db.js";
import { createServerFeatureHost } from "./backend/features/feature-host.js";
import { SERVER_FEATURES } from "./backend/features/registry.js";
import { createPlaybackTrace } from "./backend/media/performance-trace.js";
import { createStreamHealth } from "./backend/media/stream-health.js";
import { createInternalReaderRoles } from "./backend/media/internal-reader-roles.js";
import { createRemuxSegmentCache } from "./backend/media/remux-segment-cache.js";
import { createProgressiveIndexCache } from "./backend/media/progressive-index-cache.js";
import { createProgressiveVerifiedSource } from "./backend/media/progressive-verified-source.js";
import { isTorrentFileFullyVerified } from "./backend/media/verified-torrent-file.js";
import { createIndexedVideoCache } from "./backend/media/indexed-video-cache.js";
import { createPopupRoutes, createPopupWindow } from "./backend/media/popup-window.js";
import { createPopupProgram } from "./backend/media/popup-program.js";
import { createUpdatePolicy } from "./backend/app-updates/update-policy.js";
import { coachLiveSessionKey } from "./learning/coach-core.js";
import { json, localRequestRejected, methodNotAllowed, readJsonBody } from "./backend/app/http-helpers.js";
import { addBuiltInAssets, PUBLIC_ASSETS, serveStatic } from "./backend/app/static-files.js";
import { handleApi } from "./backend/app/api-routes.js";
import { internalTorrentSource, removeTorrentSession } from "./backend/torrents/torrent-sessions.js";
import { emitProgressiveReady } from "./backend/streaming/torrent-stream.js";
import { catalogSearchResults } from "./backend/catalog/catalog-api.js";
import { requestNativeUpdate } from "./backend/app-updates/updates-api.js";
import { enforcePlayerStorage } from "./backend/persistence/storage-api.js";
import { cleanVoiceCoachSessions, persistVoiceCoachSessions } from "./backend/learning/voice-coach.js";
import { collectClipGarbage } from "./backend/learning/learning-store.js";

export const root = path.dirname(fileURLToPath(import.meta.url));
export const port = Number(process.env.PORT || 4173);
export const APP_VERSION = (() => { try { return String(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version || ""); } catch { return ""; } })();
// Started by the Windows tray launcher (launcher/Launcher.cs), which stops the app by closing stdin.
export const STARTED_BY_LAUNCHER = process.env.LANGUAGE_VIDEO_LEARNER_LAUNCHER === "1";
// The installed alpha launcher generates this ephemeral loopback endpoint and
// per-launch secret. Browser clients never receive the secret or bridge address.
export const UPDATE_BRIDGE = (() => {
  if (!STARTED_BY_LAUNCHER) return null;
  const match = /^(\d{4,5}):([A-Za-z0-9+/]{43}=)$/.exec(process.env.LANGUAGE_VIDEO_LEARNER_UPDATE_BRIDGE || "");
  const bridgePort = match ? Number(match[1]) : 0;
  return bridgePort > 1024 && bridgePort <= 65535 ? { port: bridgePort, secret: match[2] } : null;
})();
// Installed LVL has its own temporary torrent namespace, independent of other
// LVL builds. Both may use port 4273 at different
// times; neither may clear the other's stale/downloaded torrent pieces.
// Within LVL, separate ports still have separate session directories.
const torrentShareRoot = path.join(os.tmpdir(), "lvl-public-torrents");
export const torrentRoot = path.join(torrentShareRoot, `port-${port}`);
const appDataRoot = process.env.LANGUAGE_VIDEO_LEARNER_DATA_ROOT
  ? path.resolve(process.env.LANGUAGE_VIDEO_LEARNER_DATA_ROOT)
  : path.join(root, "data");
export const appDatabase = createAppDatabase(path.join(appDataRoot, "language-video-learner.sqlite3"));
// The borderless pop-up player window (LVL-Popup.exe, WebView2) and its own browser profile.
// An installed LVL reuses the pinned program release (patches can't carry programs).
const popupProgram = createPopupProgram({
  root, dataRoot: appDataRoot,
  installed: fs.existsSync(path.join(root, "installed-app.json")),
});
const popupWindow = createPopupWindow({
  resolveHome: () => popupProgram.home(),
  profileDir: path.join(appDataRoot, "runtime", "popup"),
  boundsFile: path.join(appDataRoot, "runtime", "popup-bounds.json"),
});
export const handlePopupApi = createPopupRoutes({ popup: popupWindow, program: popupProgram, port, json, readJsonBody, methodNotAllowed });
setTimeout(() => { void popupProgram.ensure(); }, 5000).unref();
export const ankiStore = createAnkiStore({ db: appDatabase.sqlite, mediaRoot: path.join(appDataRoot, "anki-media") });
export const recsStore = createRecsStore({ db: appDatabase.sqlite, getMeta: appDatabase.getMeta, setMeta: appDatabase.setMeta });
export const releaseCalendar = createReleaseCalendarService({
  getTmdbKey: () => recsStore.settings().tmdbKey,
  anilistEndpoint: process.env.LANGUAGE_VIDEO_LEARNER_ANILIST_URL || undefined,
  tvmazeEndpoint: process.env.LANGUAGE_VIDEO_LEARNER_TVMAZE_SCHEDULE_URL || undefined,
  tmdbEndpoint: process.env.LANGUAGE_VIDEO_LEARNER_TMDB_URL || undefined,
});
export const animeDiscovery = createAnimeDiscoveryService({ endpoint: process.env.LANGUAGE_VIDEO_LEARNER_ANILIST_URL || undefined });
// One AniList client (one request queue and rate limit) for recommendations and features.
const anilistClient = createAniListClient(process.env.LANGUAGE_VIDEO_LEARNER_ANILIST_URL ? { endpoint: process.env.LANGUAGE_VIDEO_LEARNER_ANILIST_URL, minGapMs: 0 } : {});
// Picks are matched to catalog titles with the same search the Add a title dialog uses.
export const recs = createRecsService({
  store: recsStore,
  anilist: anilistClient,
  searchCatalog: (query) => catalogSearchResults(query),
});
export const clipStore = createClipStore({
  db: appDatabase.sqlite,
  root: path.join(appDataRoot, "clips"),
  ffmpegPath,
  sourceUrl: (sessionId, fileIndex) => `http://127.0.0.1:${port}/api/torrents/${encodeURIComponent(sessionId)}/files/${fileIndex}/stream`,
});
export const storage = createStorageManager({
  appDatabase,
  sessionsRoot: torrentRoot,
  sharedRoot: torrentShareRoot,
  dataRoot: appDataRoot,
  // Called later (torrentSessions is set up further down).
  sessions: () => [...torrentSessions.values()].map((session) => ({
    id: session.id,
    name: session.torrent?.name || session.displayName || "",
    lastUsedAt: Number(session.lastUsedAt) || 0,
    busy: (Number(session.openStreams) || 0) > 0,
  })),
  removeSession: (id) => removeTorrentSession(id),
  clipStore,
  ankiStore,
});
// Progressive remux outputs live beside (and are counted with) WebTorrent's
// per-session source bytes, never in a second unlimited storage pool.
export const remuxSegmentCache = createRemuxSegmentCache({
  sessionsRoot: torrentRoot,
  enabled: () => storage.limits().remuxCacheEnabled === true,
  allowance: async (cacheBytes, identity) => {
    // Reserve ALL not-yet-downloaded bytes for active selected source files.
    // Without this, a remux duplicate could starve a 12 GB torrent before its
    // remaining pieces arrive, despite passing a momentary 20 GB usage check.
    let sourceHeadroom = 0;
    for (const active of torrentSessions.values()) {
      if (active.id !== identity.sessionId && (Number(active.openStreams) || 0) < 1) continue;
      // One torrent session may stream several episode files concurrently;
      // reserving only its preferred index lets optional cache output starve
      // another in-flight source. Deduplicate tracked file indices, including
      // the conversion currently requesting this allowance.
      const fileIndices = new Set(active.activeStreamFiles?.keys() || []);
      if (active.id === identity.sessionId) fileIndices.add(identity.fileIndex);
      if (!fileIndices.size && Number.isInteger(active.preferredFileIndex))
        fileIndices.add(active.preferredFileIndex);
      for (const index of fileIndices) {
        const file = Number.isInteger(index) ? active.torrent?.files?.[index] : null;
        if (file) sourceHeadroom += Math.max(0, Number(file.length) - (Number(file.downloaded) || 0));
      }
    }
    const gate = await storage.playerCacheAllowance({
      additionalBytes: cacheBytes, reservedSourceBytes: sourceHeadroom,
    });
    return { allowed: gate.allowed, availableBytes: gate.availableBytes };
  },
});
export const MAX_TORRENT_FILES = 128;
export const MAX_TORRENT_VIDEO_BYTES = 20 * 1024 * 1024 * 1024;
export const TORRENT_SESSION_TTL_MS = 30 * 60 * 1000;
export const MAX_TRANSCODE_JOBS = 2;
export const MAX_SUBTITLE_TEXT_BYTES = 2 * 1024 * 1024;
// Tests point this at a local stub; normally Cinemeta.
export const CINEMETA_ORIGIN = process.env.LANGUAGE_VIDEO_LEARNER_CINEMETA_URL || "https://v3-cinemeta.strem.io";
export const IMDB_SUGGEST_ORIGIN = process.env.LANGUAGE_VIDEO_LEARNER_IMDB_SUGGEST_URL || "https://v3.sg.media-imdb.com/suggestion";
export const BROWSER_COACH_EXTENSION_DIR = path.resolve(root, "browser-extension");
export const DEFAULT_COACH_PROVIDER_ID = "chatgpt-browser";
export const COACH_PROVIDERS = new Map([
  [DEFAULT_COACH_PROVIDER_ID, {
    id: DEFAULT_COACH_PROVIDER_ID,
    label: "ChatGPT in your browser",
    kind: "browser-subscription",
    model: "account-selected",
    transport: "signed-in-chatgpt-browser",
    enabled: true,
    supports: {
      conversation: true,
      liveVoice: true,
      liveTranscriptSync: true,
      structuredOutput: true,
      textInput: true,
      imageInput: false,
      audioInput: false,
      audioOutput: false,
    },
  }],
]);
export const VIDEO_EXTENSIONS = new Set([".mp4", ".m4v", ".webm", ".ogv", ".ogg", ".mkv", ".avi", ".mov"]);
export const FALLBACK_TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://tracker.openbittorrent.com:6969/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://open.stealth.si:80/announce",
];

export const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".mp4": "video/mp4",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
  ".avi": "video/x-msvideo",
};

addBuiltInAssets();

export const torrentClient = new WebTorrent({ maxConns: 40 });
export const torrentSessions = new Map();
export const playbackTrace = createPlaybackTrace();
export const streamHealth = createStreamHealth();
export const internalReaderRoles = createInternalReaderRoles({ port });
export const activeTranscodes = new Set();
// Background encoders are tracked separately from the foreground players.
// An already-admitted background process must not see its OWN shared slot as
// a new foreground conflict. Admission is bounded separately before spawn;
// when a new player actually needs a slot transcodeTorrentFile preempts caches.
const indexedActiveProcesses = new Set();
export const progressiveActiveProcesses = new Set();
export const activeForegroundTranscodeCount = () => Math.max(0,activeTranscodes.size
  - indexedActiveProcesses.size - progressiveActiveProcesses.size);
export const mediaProbeCache = new Map();
export const remoteSubtitleDownloads = new Map();
export const voiceCoachSessions = new Map(
  (appDatabase.readSection("coachSessions") || []).map((session) => [
    coachLiveSessionKey(session.chatId, session.nativeVoice),
    session,
  ]),
);
if (cleanVoiceCoachSessions()) persistVoiceCoachSessions();
export const browserCoachToken = crypto.randomBytes(24).toString("base64url");
export const ffprobePath = ffprobeStatic?.path || null;
// Full-file browser-range cache is strictly optional. Background conversions
// consume one of the same two FFmpeg slots as foreground playback, and never
// start unless there is no active foreground conversion.
export const indexedVideoCache = createIndexedVideoCache({
  sessionsRoot: torrentRoot, ffmpegPath, ffprobePath,
  enabled: () => storage.limits().remuxCacheEnabled === true,
  allowance: bytes => storage.playerCacheAllowance({ additionalBytes: bytes }),
  isCurrent: identity => {
    const session = torrentSessions.get(identity.sessionId);
    const file = session?.torrent?.files?.[identity.fileIndex];
    return session?.infoHash?.toLowerCase() === identity.infoHash
      && file?.done === true && file.downloaded === identity.sourceLength
      && file.length === identity.sourceLength && file.name === identity.sourceName
      && isTorrentFileFullyVerified(session.torrent, identity.fileIndex);
  },
  sourceUrl: identity => {
    const session = torrentSessions.get(identity.sessionId);
    if (!session || !session.torrent?.files?.[identity.fileIndex]) return null;
    return internalTorrentSource(session, identity.fileIndex, "conversion");
  },
  // At most one background conversion alongside the one active player. A
  // new foreground request cancels the background first (below) so the
  // two-slot hard limit never starves interactive playback.
  foregroundBusy: () => activeForegroundTranscodeCount() >= MAX_TRANSCODE_JOBS,
  onSpawn: child => { activeTranscodes.add(child); indexedActiveProcesses.add(child); },
  onClose: child => {
    if (child) { activeTranscodes.delete(child); indexedActiveProcesses.delete(child); }
  },
});
export const progressiveStarts = new Map();
export const progressiveIslandStarts = new Map();
export const progressiveVerifiedSource = createProgressiveVerifiedSource({
  sessionsRoot:torrentRoot,ffprobePath,
  allowance:bytes=>storage.playerCacheAllowance({additionalBytes:bytes}),
  isCurrent:identity=>{
    const session=torrentSessions.get(identity.sessionId);
    const file=session?.torrent?.files?.[identity.fileIndex];
    return session?.infoHash?.toLowerCase()===identity.infoHash
      && session.torrent?.destroyed!==true
      && file?.name===identity.fileName
      && file?.length===identity.fileLength
      && file?.offset===identity.fileOffset
      && session.torrent?.pieceLength===identity.pieceLength;
  },
});
export const progressiveIndexCache = createProgressiveIndexCache({
  sessionsRoot: torrentRoot, ffmpegPath, ffprobePath,
  verifiedSource:progressiveVerifiedSource,
  enabled: () => storage.limits().remuxCacheEnabled === true,
  allowance: bytes => storage.playerCacheAllowance({ additionalBytes: bytes }),
  isCurrent: identity => {
    const session = torrentSessions.get(identity.sessionId);
    const file = session?.torrent?.files?.[identity.fileIndex];
    const sameSource=session?.infoHash?.toLowerCase() === identity.infoHash
      && session?.torrent?.destroyed!==true
      && file?.length === identity.sourceLength && file.name === identity.sourceName;
    if (!sameSource) return false;
    if (identity.sourceMode === 'verified-prefix') {
      // The cache checks the hash bitfield for each exact per-GOP source span;
      // never require file.done for an individually verified offline snapshot.
      return file.offset >= 0 && typeof session.torrent?.bitfield?.get === 'function';
    }
    return file.done === true && file.downloaded === identity.sourceLength
      && isTorrentFileFullyVerified(session.torrent, identity.fileIndex);
  },
  foregroundBusy: () => activeForegroundTranscodeCount() >= MAX_TRANSCODE_JOBS,
  onSpawn: child => { activeTranscodes.add(child); progressiveActiveProcesses.add(child); },
  onClose: child => {
    if (child) { activeTranscodes.delete(child); progressiveActiveProcesses.delete(child); }
  },
  onReady: emitProgressiveReady,
});
// A Windows cache file can remain locked by an in-flight HTTP reader when the
// user disables retention. Retry safe indexed-only cleanup on next startup;
// never touch selected torrent source pieces or other player data.
if (storage.limits().remuxCacheEnabled === false)
  void indexedVideoCache.purgeAll().catch(error => console.warn("Indexed-cache cleanup:", error?.message || error));
if (storage.limits().remuxCacheEnabled === false)
  void progressiveIndexCache.purgeAll().catch(error => console.warn("Progressive-index cleanup:", error?.message || error));

torrentClient.on("error", (error) => {
  console.error("WebTorrent client error:", error);
});

// Automatic updates wait until no video is open; see backend/app-updates/update-policy.js.
export const updatePolicy = UPDATE_BRIDGE ? createUpdatePolicy({
  request: requestNativeUpdate,
  prefsFile: path.join(appDataRoot, "app-update-policy.json"),
  isBusy: () => torrentSessions.size > 0 || activeTranscodes.size > 0,
  patchCapable: () => fs.existsSync(path.join(root, "runtime", "update-apply.mjs")),
  log: (message) => console.log(`Updates: ${message}`),
}) : null;
setTimeout(collectClipGarbage, 30_000).unref?.();
setInterval(collectClipGarbage, 6 * 60 * 60 * 1000).unref?.();
setInterval(() => { void enforcePlayerStorage(); }, 30_000).unref?.();

// Optional features (reader, franchises, reading sources) plug in through
// backend/features/registry.js; core routes always take precedence.
const serverFeatures = createServerFeatureHost(SERVER_FEATURES, { coreAssets: PUBLIC_ASSETS });
for (const [route, asset] of serverFeatures.assets) PUBLIC_ASSETS.set(route, asset);
serverFeatures.init({
  db: appDatabase.sqlite, getMeta: appDatabase.getMeta, setMeta: appDatabase.setMeta,
  dataRoot: appDataRoot, port, root, json, readJsonBody, methodNotAllowed,
  rejectNonLocal: localRequestRejected, anilist: anilistClient,
  // Sync reads and writes these like another LVL window would.
  appState: { readSection: appDatabase.readSection, sectionUpdatedAt: appDatabase.sectionUpdatedAt, compareAndSwapSection: appDatabase.compareAndSwapSection },
  recs: recsStore,
});

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    if (url.pathname.startsWith("/api/")) {
      let handled = await handleApi(req, res, url);
      if (!handled && !res.headersSent) handled = await serverFeatures.handleApi(req, res, url);
      if (!handled) json(res, 404, { error: "API route not found" });
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") return methodNotAllowed(res, ["GET", "HEAD"]);
    serveStatic(req, res, url);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) json(res, error.statusCode || 500, { error: error.message || "Internal server error" });
    else res.destroy();
  }
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  // Downloads are deleted on the way out; never hang there.
  setTimeout(() => process.exit(0), 8000).unref();
  popupWindow.stop();
  await serverFeatures.stop();
  for (const ffmpeg of activeTranscodes) {
    if (!ffmpeg.killed) ffmpeg.kill();
  }
  for (const id of [...torrentSessions.keys()]) await removeTorrentSession(id);
  torrentClient.destroy(() => process.exit(0));
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
// Windows can't send Ctrl+C to a process without a console, so the launcher holds our stdin
// open and closes it to stop the app. If the launcher itself goes away, stdin closes too, so
// the app never keeps running on its own.
if (STARTED_BY_LAUNCHER) {
  process.stdin.on("end", () => void shutdown());
  process.stdin.on("error", () => void shutdown());
  process.stdin.resume();
}

server.listen(port, "127.0.0.1", () => {
  console.log(`LVL running at http://127.0.0.1:${port}`);
  // Only after listening: a second copy on the same port fails to start and never gets here.
  storage.clearOrphans()
    .then((removed) => { if (removed) console.log(`Player storage: removed ${removed} download folder(s) left by an earlier run`); })
    .catch((error) => console.warn("Startup cleanup failed:", error.message));
  // Automatic recommendation updates (only when switched on in Settings).
  recs.startScheduler();
  if (updatePolicy) {
    setTimeout(() => { void updatePolicy.tick(); }, 5_000).unref?.();
    setInterval(() => { void updatePolicy.tick(); }, 30_000).unref?.();
  }
  void serverFeatures.start();
});
