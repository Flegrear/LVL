import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import "./backend/torrents/tracker-cancellation.js";
import WebTorrent from "webtorrent";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import { createStorageManager } from "./backend/persistence/storage.js";
import { sourceProtectedCacheAllowance } from "./backend/persistence/source-cache-headroom.js";
import { readLegacyMediaUsage } from "./backend/persistence/legacy-media.js";
import { legacyBootstrapClaimApi, legacyBootstrapClaimSectionApi, legacyBootstrapClaimRestoreApi } from "./backend/persistence/legacy-bootstrap-claim-api.js";
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
import { createMediaResourceShutdown } from "./backend/media/media-shutdown.js";
import { createUpdatePolicy } from "./backend/app-updates/update-policy.js";
import { json, localRequestRejected, methodNotAllowed, readJsonBody } from "./backend/app/http-helpers.js";
import { addBuiltInAssets, PUBLIC_ASSETS, serveStatic } from "./backend/app/static-files.js";
import { handleApi } from "./backend/app/api-routes.js";
import {
  evictTorrentSessionIfIdle, internalTorrentSource, removeTorrentSession,
  retireOrphanTorrentDirectoryIfIdle, torrentSessionHasActiveBorrower,
} from "./backend/torrents/torrent-sessions.js";
import { emitProgressiveReady } from "./backend/streaming/torrent-stream.js";
import { isVideoConversionAvailable } from "./backend/streaming/transcode.js";
import { catalogSearchResults } from "./backend/catalog/catalog-api.js";
import { requestNativeUpdate } from "./backend/app-updates/updates-api.js";
import { enforcePlayerStorage, runStorageOperation } from "./backend/persistence/storage-api.js";

export const root = path.dirname(fileURLToPath(import.meta.url));
export const port = Number(process.env.PORT || 4173);
export const IS_ANDROID_RUNTIME = process.platform === "android";
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
export let appDatabase = null;
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
export let recsStore = null;
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
export let recs = null;
export const storage = createStorageManager({
  // The manager captures these accessors; they resolve only after this instance
  // owns the listen socket and has opened its schema-checked database.
  appDatabase: { getMeta: (...args) => appDatabase.getMeta(...args), setMeta: (...args) => appDatabase.setMeta(...args) },
  legacyMediaUsage: () => readLegacyMediaUsage(appDatabase.sqlite),
  sessionsRoot: torrentRoot,
  sharedRoot: torrentShareRoot,
  dataRoot: appDataRoot,
  ...(IS_ANDROID_RUNTIME ? {
    defaults: { playerBytes: 4 * 1024 ** 3 },
    keepsSessionFiles: true,
  } : {}),
  // Called later (torrentSessions is set up further down).
  sessions: () => [...torrentSessions.values()].map((session) => ({
    id: session.id,
    incarnation: session.incarnation,
    name: session.torrent?.name || session.displayName || "",
    lastUsedAt: Number(session.lastUsedAt) || 0,
    busy: torrentSessionHasActiveBorrower(session),
  })),
  removeSession: (id, incarnation) => evictTorrentSessionIfIdle(id, incarnation),
  retireOrphanDirectoryIfIdle: (id, removeDirectory) =>
    retireOrphanTorrentDirectoryIfIdle(id, removeDirectory),
});
// Every optional cache writer shares the same original-source headroom gate.
// All physical bytes are counted by storage.playerCacheAllowance's fresh
// filesystem scan; reserve only the not-yet-downloaded original selected
// source bytes, without counting each selected file more than once.
const optionalMediaCacheAllowance = async (additionalBytes, identity = null) => {
  return sourceProtectedCacheAllowance({
    sessions: torrentSessions.values(),
    identity,
    additionalBytes,
    allowance: reservation => storage.playerCacheAllowance(reservation),
    isVerifiedComplete: (torrent, fileIndex) => isTorrentFileFullyVerified(torrent, fileIndex),
  });
};
// Progressive remux outputs live beside (and are counted with) WebTorrent's
// per-session source bytes, never in a second unlimited storage pool.
export const remuxSegmentCache = createRemuxSegmentCache({
  sessionsRoot: torrentRoot,
  enabled: () => storage.limits().remuxCacheEnabled === true,
  allowance: (cacheBytes, identity) => optionalMediaCacheAllowance(cacheBytes, identity),
});
export const MAX_TORRENT_FILES = 128;
export const MAX_TORRENT_VIDEO_BYTES = 20 * 1024 * 1024 * 1024;
export const TORRENT_SESSION_TTL_MS = 30 * 60 * 1000;
export const MAX_TRANSCODE_JOBS = 2;
export const MAX_SUBTITLE_TEXT_BYTES = 2 * 1024 * 1024;
// Tests point this at a local stub; normally Cinemeta.
export const CINEMETA_ORIGIN = process.env.LANGUAGE_VIDEO_LEARNER_CINEMETA_URL || "https://v3-cinemeta.strem.io";
export const IMDB_SUGGEST_ORIGIN = process.env.LANGUAGE_VIDEO_LEARNER_IMDB_SUGGEST_URL || "https://v3.sg.media-imdb.com/suggestion";
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

export let torrentClient = null;
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
export const ffprobePath = ffprobeStatic?.path || null;
// Full-file browser-range cache is strictly optional. Background conversions
// consume one of the same two FFmpeg slots as foreground playback, and never
// start unless there is no active foreground conversion.
export const indexedVideoCache = createIndexedVideoCache({
  sessionsRoot: torrentRoot, ffmpegPath, ffprobePath,
  // A complete indexed MP4 duplicates the source episode. The phone's small
  // storage budget must instead preserve downloaded pieces for the next play.
  enabled: () => !IS_ANDROID_RUNTIME && storage.limits().remuxCacheEnabled === true,
  canEncode: isVideoConversionAvailable,
  allowance: bytes => optionalMediaCacheAllowance(bytes),
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
  allowance:bytes=>optionalMediaCacheAllowance(bytes),
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
  // Keep per-play streaming/remux recording available, but do not continuously
  // produce duplicate GOP sections on resource-constrained phones.
  enabled: () => !IS_ANDROID_RUNTIME && storage.limits().remuxCacheEnabled === true,
  canEncode: isVideoConversionAvailable,
  allowance: bytes => optionalMediaCacheAllowance(bytes),
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
// Automatic updates wait until no video is open; see backend/app-updates/update-policy.js.
export let updatePolicy = null;

// Optional features (reader, franchises, reading sources) plug in through
// backend/features/registry.js; core routes always take precedence.
const serverFeatures = createServerFeatureHost(SERVER_FEATURES, { coreAssets: PUBLIC_ASSETS });
for (const [route, asset] of serverFeatures.assets) PUBLIC_ASSETS.set(route, asset);
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    if (url.pathname.startsWith("/api/")) {
      if (url.pathname === "/api/app-state/bootstrap-claim"
        || url.pathname === "/api/app-state/bootstrap-claim/section"
        || url.pathname === "/api/app-state/bootstrap-claim/restore") {
        // This narrow additive endpoint is Core-owned. It takes the same
        // local-origin guard as every existing mutable /api route before
        // offering or consuming an account/profile bootstrap claim.
        if (!localRequestRejected(req, res))
          await (url.pathname.endsWith("/section")
            ? legacyBootstrapClaimSectionApi
            : url.pathname.endsWith("/restore")
              ? legacyBootstrapClaimRestoreApi : legacyBootstrapClaimApi)(req, res, {
            appDatabase, json, readJsonBody, methodNotAllowed,
          });
        return;
      }
      let handled = await handleApi(req, res, url);
      if (!handled && !res.headersSent && !res.writableEnded && !res.destroyed)
        handled = await serverFeatures.handleApi(req, res, url);
      if (!handled && !res.headersSent && !res.writableEnded && !res.destroyed)
        json(res, 404, { error: "API route not found" });
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") return methodNotAllowed(res, ["GET", "HEAD"]);
    serveStatic(req, res, url);
  } catch (error) {
    console.error(error);
    if (!res.headersSent && !res.writableEnded && !res.destroyed)
      json(res, error.statusCode || 500, { error: error.message || "Internal server error" });
    else if (!res.writableEnded && !res.destroyed) res.destroy();
  }
});

// All owned asynchronous work and scheduled callbacks are acquired only after listen.
let shuttingDown = false;
const stopOwnedMedia = createMediaResourceShutdown({
  popupWindow, popupProgram, activeTranscodes, torrentSessions,
  removeTorrentSession, timeoutMs: 2200,
});
const ownedTimers = new Set();
const ownedWork = new Set();
function trackOwned(work, label) {
  const promise = Promise.resolve(work).catch((error) => {
    if (!shuttingDown) console.warn(`${label}:`, error?.message || error);
  });
  ownedWork.add(promise);
  void promise.finally(() => ownedWork.delete(promise));
  return promise;
}
function timerOwned(callback, delay, interval = false) {
  const timer = interval ? setInterval(callback, delay) : setTimeout(() => {
    ownedTimers.delete(timer);
    callback();
  }, delay);
  timer.unref?.();
  ownedTimers.add(timer);
  return timer;
}
async function closeListener() {
  if (!server.listening) return;
  await new Promise((resolve) => {
    let finished = false;
    const finish = () => { if (finished) return; finished = true; clearTimeout(deadline); resolve(); };
    const deadline = setTimeout(() => { server.closeAllConnections?.(); finish(); }, 1800);
    deadline.unref?.();
    try {
      server.close(finish);
      server.closeIdleConnections?.();
    } catch { finish(); }
  });
}
// stopScheduler snapshots both the active recommendation refresh and the
// independent library import before fencing their last possible SQLite writes.
// Its bounded drain is the only supported shutdown contract after stopping.
function drainRecommendations(timeoutMs = 5200) {
  if (!recs) return Promise.resolve(true);
  return Promise.resolve(recs.stopScheduler({ timeoutMs }))
    .then(result => result?.drained === true, () => false);
}
async function boundedSettled(tasks, timeoutMs) {
  let deadline;
  try {
    return await Promise.race([
      Promise.allSettled(tasks).then(() => true),
      new Promise(resolve => {
        deadline = setTimeout(() => resolve(false), timeoutMs);
        deadline.unref?.();
      }),
    ]);
  } finally { clearTimeout(deadline); }
}
async function shutdown({ exitCode = 0 } = {}) {
  if (shuttingDown) return;
  shuttingDown = true;
  const forced = setTimeout(() => process.exit(exitCode || 0), 8000);
  forced.unref?.();
  // Any failure before a drain completes must retain the database handle;
  // a stopped scheduler's status.running alone doesn't include libraryRun.
  let recsDrained = !recs;
  let ownedWorkDrained = false;
  let recommendations = Promise.resolve(true);
  // Acquire the media owner before the first await so every new admission sees
  // its closed fence, including requests already suspended in an async route.
  const mediaShutdown = stopOwnedMedia();
  try {
    for (const timer of ownedTimers) { clearInterval(timer); clearTimeout(timer); }
    ownedTimers.clear();
    recommendations = drainRecommendations();
    // server.close immediately stops accepting requests. Close keepalive sockets
    // before tearing down services that could still be serving requests.
    await closeListener();
    const services = serverFeatures.stop({ timeoutMs: 1500 });
    const caches = boundedSettled([
      indexedVideoCache.stopAll?.(),
      progressiveIndexCache.stopAll?.(),
      ...ownedWork,
    ], 1600);
    await services;
    ownedWorkDrained = await caches;
    if (!ownedWorkDrained) { console.warn("LVL shutdown: cache work exceeded drain deadline"); exitCode = 1; }
    // Media's owner handles child close confirmation, pop-up disposal and
    // exact-incarnation torrent retirement. Calling it once preserves its
    // singleton contract if another stop path has already begun.
    const media = await mediaShutdown;
    if (!media.complete) { console.warn("LVL shutdown: media resources did not all close"); exitCode = 1; }
    if (torrentClient) await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 800);
      timeout.unref?.();
      try { torrentClient.destroy(() => { clearTimeout(timeout); resolve(); }); }
      catch { clearTimeout(timeout); resolve(); }
    });
    recsDrained = await recommendations;
    if (!recsDrained) { console.warn("LVL shutdown: recommendation refresh is still draining"); exitCode = 1; }
  } catch (error) {
    console.error("LVL shutdown:", error);
    exitCode = 1;
  } finally {
    // Never close a SQLite connection beneath an in-flight recommendations
    // writer. On deadline expiry, leave its handle for process teardown.
    if (recsDrained && ownedWorkDrained && !recs?.status?.().running) {
      try { appDatabase?.close(); } catch (error) { console.warn("Database close:", error); exitCode = 1; }
    } else exitCode = 1;
    clearTimeout(forced);
    process.exit(exitCode);
  }
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

function initializeOwnedRuntime() {
  // No application database, recommendation schema migration or cache mutation
  // can occur in the losing process when another LVL owns this port.
  appDatabase = createAppDatabase(path.join(appDataRoot, "language-video-learner.sqlite3"));
  recsStore = createRecsStore({ db: appDatabase.sqlite, getMeta: appDatabase.getMeta, setMeta: appDatabase.setMeta });
  recs = createRecsService({
    store: recsStore,
    anilist: anilistClient,
    searchCatalog: (query) => catalogSearchResults(query),
  });
  torrentClient = new WebTorrent({ maxConns: 40 });
  torrentClient.on("error", (error) => console.error("WebTorrent client error:", error));
  updatePolicy = UPDATE_BRIDGE ? createUpdatePolicy({
    request: requestNativeUpdate,
    prefsFile: path.join(appDataRoot, "app-update-policy.json"),
    isBusy: () => torrentSessions.size > 0 || activeTranscodes.size > 0,
    patchCapable: () => fs.existsSync(path.join(root, "runtime", "update-apply.mjs")),
    log: (message) => console.log(`Updates: ${message}`),
  }) : null;
  serverFeatures.init({
    db: appDatabase.sqlite, getMeta: appDatabase.getMeta, setMeta: appDatabase.setMeta,
    dataRoot: appDataRoot, port, root, json, readJsonBody, methodNotAllowed,
    rejectNonLocal: localRequestRejected, anilist: anilistClient,
    // Sync reads and writes these like another LVL window would.
    appState: { readSection: appDatabase.readSection, sectionUpdatedAt: appDatabase.sectionUpdatedAt, compareAndSwapSection: appDatabase.compareAndSwapSection },
    recs: recsStore,
  });
}

server.on("error", (error) => {
  console.error(`LVL could not listen on 127.0.0.1:${port}:`, error?.message || error);
  void shutdown({ exitCode: 1 });
});
server.listen(port, "127.0.0.1", () => {
  if (shuttingDown) return;
  try {
    initializeOwnedRuntime();
    console.log(`LVL running at http://127.0.0.1:${port}`);
    timerOwned(() => { if (!shuttingDown) trackOwned(popupProgram.ensure(), "Pop-up program"); }, 5000);
    if (IS_ANDROID_RUNTIME || storage.limits().remuxCacheEnabled === false) {
      trackOwned(indexedVideoCache.purgeAll(), "Indexed-cache cleanup");
      trackOwned(progressiveIndexCache.purgeAll(), "Progressive-index cleanup");
    }
    // Android retains verified download pieces; desktop reclaims only its own
    // orphaned session directories, after ownership has been proven.
    if (IS_ANDROID_RUNTIME) {
      trackOwned(runStorageOperation(() => storage.enforcePlayer()).then(({ evicted }) => {
        if (evicted.length) console.log(`Player storage: trimmed ${evicted.length} older download(s) over the limit`);
      }), "Startup cleanup");
    } else {
      trackOwned(runStorageOperation(() => storage.clearOrphans()).then(removed => {
        if (removed) console.log(`Player storage: removed ${removed} download folder(s) left by an earlier run`);
      }), "Startup cleanup");
    }
    recs.startScheduler();
    timerOwned(() => { if (!shuttingDown) trackOwned(enforcePlayerStorage(), "Scheduled storage check"); }, 30_000, true);
    if (updatePolicy) {
      timerOwned(() => { if (!shuttingDown) trackOwned(updatePolicy.tick(), "Update policy"); }, 5000);
      timerOwned(() => { if (!shuttingDown) trackOwned(updatePolicy.tick(), "Update policy"); }, 30_000, true);
    }
    trackOwned(serverFeatures.start(), "Feature startup");
  } catch (error) {
    console.error("LVL startup failed:", error);
    void shutdown({ exitCode: 1 });
  }
});
