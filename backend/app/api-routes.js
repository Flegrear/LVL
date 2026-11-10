// Routes /api/* requests to their handlers.
import fs from "node:fs";
import path from "node:path";
import {
  animeDiscovery, APP_VERSION, handlePopupApi, playbackTrace, recsStore, releaseCalendar, root,
  STARTED_BY_LAUNCHER, streamHealth, torrentSessions,
} from "../../server.js";
import { json, localRequestRejected, methodNotAllowed, readJsonBody } from "./http-helpers.js";
import { appStateBootstrapEndpoint, appStateEndpoint } from "./app-state.js";
import {
  cancelTorrentAcquisition, createTorrentSession, fileDownloadMap, getTorrentSession,
  releaseTorrentSessionLease, sessionPayload,
} from "../torrents/torrent-sessions.js";
import {
  copiedSeekOriginEndpoint, serveIndexedSeek, serveProgressiveSeek, serveRemuxWarmWindow,
  streamTorrentFile,
} from "../streaming/torrent-stream.js";
import { isVideoConversionAvailable, transcodeTorrentFile } from "../streaming/transcode.js";
import { getCachedMediaProbe, probeTorrentFile } from "../media/torrent-probe.js";
import { speechActivityWindow } from "../media/speech-activity.js";
import { extractTorrentSubtitle } from "../subtitles/embedded-subtitles.js";
import { downloadSubtitle, searchSubtitles } from "../subtitles/subtitle-search.js";
import { romanizeSubtitles } from "../subtitles/romanize.js";
import { searchLibraryArtwork, serveOptimizedPoster } from "../catalog/artwork.js";
import { catalogMeta, homeCatalog, searchCatalog } from "../catalog/catalog-api.js";
import { searchStreams } from "../catalog/streams.js";
import { appUpdatesEndpoint } from "../app-updates/updates-api.js";
import { alignSubtitleTracks, processSubtitleTrack } from "../subtitles/subtitle-alignment.js";
import { handleStorageApi } from "../persistence/storage-api.js";
import { handleRecsApi } from "../recommendations/recs-api.js";
import { attachAndroidHealthProof } from "./server-identity.js";

// Requests only LVL's own page may send. Requests sent by other sites (a page you visit can
// post to 127.0.0.1) and under other host names (DNS rebinding) are refused, so no other
// site can change your saved data or start a torrent.
const LOCAL_ONLY_PATHS = new Set([
  "/api/app-state", "/api/diagnostics/playback", "/api/browser-coach/status", "/api/browser-coach/decision",
  "/api/browser-coach/voice-correction", "/api/browser-coach/open-extension-folder", "/api/images/poster",
  "/api/torrents", "/api/recs", "/api/calendar/releases", "/api/ratings", "/api/health", "/api/clips", "/api/storage",
]);
const LOCAL_ONLY_PREFIXES = [
  "/api/app-state/", "/api/app-updates/", "/api/popup/", "/api/coach/", "/api/torrents/", "/api/recs/",
  "/api/torrent-acquisitions/",
  "/api/anki/", "/api/ankiweb/", "/api/clips/", "/api/storage/",
  "/api/subtitles/", "/api/learning/subtitles/",
];
const localOnly = (pathname) => LOCAL_ONLY_PATHS.has(pathname) || LOCAL_ONLY_PREFIXES.some((prefix) => pathname.startsWith(prefix));

const startsWith = (prefix) => (pathname) => pathname.startsWith(prefix);

// A route that only takes POST; anything else is answered with 405.
const postOnly = (handler) => async (req, res) => {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  await handler(req, res);
  return true;
};

async function playbackDiagnosticsEndpoint(req, res, url) {
  if (req.method !== "GET" && req.method !== "POST") return methodNotAllowed(res, ["GET", "POST"]);
  const input = req.method === "POST" ? await readJsonBody(req, 1024) : null;
  const id = req.method === "GET" ? url.searchParams.get("session") : input?.session;
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id) || !torrentSessions.has(id)) {
    json(res, 404, { error: "Playback session unavailable" });
    return true;
  }
  const session = torrentSessions.get(id);
  const fileIndex = req.method === "GET" ? playbackTrace.snapshot(id)?.fileIndex : Number(input?.fileIndex);
  if (req.method === "POST") {
    if (input?.action === "stop") playbackTrace.stop(id);
    else if (input?.action === "start" && Number.isInteger(fileIndex) && fileIndex >= 0 && session.torrent?.files?.[fileIndex]) playbackTrace.start(id, fileIndex);
    else { json(res, 400, { error: "Invalid playback trace request" }); return true; }
  }
  const trace = playbackTrace.snapshot(id, {
    torrent: session.torrent, file: session.torrent?.files?.[fileIndex], fileIndex,
  });
  json(res, 200, trace || { enabled: false });
  return true;
}

// The Windows launcher checks this before starting the app, so it never starts a second copy.
function healthEndpoint(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  // Desktop and legacy callers still receive the same JSON. Only a child with
  // the private per-spawn environment key can sign an explicit Android probe.
  attachAndroidHealthProof(req, res, process.env.LVL_ANDROID_CHILD_SECRET);
  json(res, 200, {
    app: "language-video-learner",
    appId: fs.existsSync(path.join(root, "installed-app.json")) ? "lvl-public" : null,
    version: APP_VERSION, pid: process.pid, launcher: STARTED_BY_LAUNCHER,
    videoConversion: isVideoConversionAvailable(),
  });
  return true;
}

async function calendarReleasesEndpoint(req, res, url) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  const from = url.searchParams.get("from") || "";
  const to = url.searchParams.get("to") || "";
  const scope = url.searchParams.get("scope") || "list";
  const importedIds = recsStore.ratings()
    .filter((entry) => entry.source === "anilist" && /^anilist:\d+$/.test(String(entry.itemId || "")))
    .map((entry) => Number(entry.itemId.slice("anilist:".length)));
  // Browser Library can also contain manually linked titles absent from the
  // connected account. Both sources identify saved seasons for sequel lookup.
  const listedIds = String(url.searchParams.get("anilistIds") || "").slice(0, 3000)
    .split(",").filter((value) => /^[1-9]\d*$/.test(value)).map(Number);
  const anilistIds = [...importedIds, ...listedIds];
  const payload = await releaseCalendar.releases(from, to, {
    force: url.searchParams.get("refresh") === "1", anilistIds, scope,
  });
  json(res, 200, payload);
  return true;
}

async function animeDiscoverEndpoint(req, res, url) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  try {
    const result = await animeDiscovery.discover(url.searchParams);
    json(res, 200, result, { "Cache-Control": "private, max-age=60" });
  } catch (error) {
    json(res, 503, { error: error.message || "AniList discovery is temporarily unavailable" });
  }
  return true;
}

async function torrentEndpoint(req, res, url, torrentMatch) {
  const [, id, fileIndex, fileAction] = torrentMatch;
  const session = getTorrentSession(id);
  if (!session) {
    json(res, 404, { error: "Torrent session not found or expired" });
    return true;
  }
  if (fileIndex !== undefined) {
    if (req.method !== "GET" && req.method !== "HEAD") return methodNotAllowed(res, ["GET", "HEAD"]);
    if (fileAction === "indexed" || fileAction === "indexed/status") {
      await serveIndexedSeek(req, res, session, Number(fileIndex), url, fileAction === "indexed/status");
      return true;
    }
    if (fileAction === "progressive/status" || fileAction === "progressive/events"
      || fileAction?.startsWith("progressive/window/")) {
      await serveProgressiveSeek(req, res, session, Number(fileIndex), url, fileAction === "progressive/status");
      return true;
    }
    if (fileAction === "remux-cache/window") {
      await serveRemuxWarmWindow(req,res,session,Number(fileIndex),url);
      return true;
    }
    if (fileAction === "transcode-start") {
      await copiedSeekOriginEndpoint(req, res, session, Number(fileIndex), url);
      return true;
    }
    if (fileAction === "metadata") {
      if (req.method === "HEAD") {
        const cached = getCachedMediaProbe(session.id, Number(fileIndex));
        res.writeHead(cached ? 200 : 404, {
          "Cache-Control": "no-store",
          ...(cached?.durationSeconds ? { "X-Media-Duration-Seconds": String(cached.durationSeconds) } : {}),
        });
        res.end();
      } else {
        const media = await probeTorrentFile(session, Number(fileIndex));
        json(res, 200, media, media?.durationSeconds ? { "X-Media-Duration-Seconds": String(media.durationSeconds) } : {});
      }
      return true;
    }
    if (fileAction === "subtitle") {
      await extractTorrentSubtitle(req, res, session, Number(fileIndex), url);
      return true;
    }
    if (fileAction === "speech") {
      await speechActivityWindow(req, res, session, Number(fileIndex), url);
      return true;
    }
    if (fileAction === "transcode") {
      if (req.method === "HEAD") {
        const cached = getCachedMediaProbe(session.id, Number(fileIndex));
        res.writeHead(200, {
          "Content-Type": "video/mp4",
          "Accept-Ranges": "none",
          "Cache-Control": "no-store",
          ...(cached?.durationSeconds ? { "X-Media-Duration-Seconds": String(cached.durationSeconds) } : {}),
        });
        res.end();
      } else {
        await transcodeTorrentFile(req, res, session, Number(fileIndex), url);
      }
    } else {
      streamTorrentFile(req, res, session, Number(fileIndex), url);
    }
    return true;
  }
  if (req.method === "GET") {
    const mapFile = url.searchParams.get("file");
    const payload = sessionPayload(session);
    if (mapFile !== null && /^\d{1,4}$/.test(mapFile)) {
      const index = Number(mapFile);
      payload.fileMap = fileDownloadMap(session, index);
      // The client may name a byte offset, but only an actual open Range
      // reader covering that position qualifies for a piece observation.
      const requested = url.searchParams.get("offset");
      const offset = requested !== null && /^\d{1,16}$/.test(requested)
        && Number.isSafeInteger(Number(requested)) ? Number(requested) : null;
      payload.streamHealth = streamHealth.snapshot(session, {
        torrent: session.torrent, fileIndex: index, offset,
      });
    }
    json(res, 200, payload);
    return true;
  }
  if (req.method === "DELETE") {
    const authority = await releaseTorrentSessionLease(id,
      url.searchParams.get("lease"), url.searchParams.get("incarnation"));
    if (authority.status !== 204) json(res, authority.status, { error: authority.error });
    else { res.writeHead(204); res.end(); }
    return true;
  }
  return methodNotAllowed(res, ["GET", "DELETE"]);
}

// The routes, in order. The first one whose path matches answers, and its answer is final,
// except for a route marked `next`: when it doesn't take the request, the routes after it
// still may. A string path is the whole path, a function tests it, and a regular
// expression's match is passed to the handler.
const API_ROUTES = [
  { path: "/api/diagnostics/playback", handle: playbackDiagnosticsEndpoint },
  { path: "/api/health", handle: healthEndpoint },
  { path: startsWith("/api/app-updates/"), handle: appUpdatesEndpoint },
  { path: startsWith("/api/popup/"), handle: (req, res, url) => handlePopupApi(req, res, url) },
  { path: (p) => p === "/api/recs" || p.startsWith("/api/recs/") || p === "/api/ratings", handle: handleRecsApi },
  { path: "/api/calendar/releases", handle: calendarReleasesEndpoint },
  { path: "/api/app-state/bootstrap", handle: appStateBootstrapEndpoint },
  { path: (p) => p === "/api/app-state" || p.startsWith("/api/app-state/"), handle: appStateEndpoint },
  { path: (p) => p === "/api/storage" || p.startsWith("/api/storage/"),
    handle: async (req, res, url) => (await handleStorageApi(req, res, url)) || false },
  { path: "/api/torrents", handle: postOnly(createTorrentSession) },
  { path: /^\/api\/torrent-acquisitions\/([^/]+)$/, handle: async (req, res, _url, match) => {
    if (req.method !== "DELETE") return methodNotAllowed(res, ["DELETE"]);
    const result = await cancelTorrentAcquisition(match[1]);
    if (result.status === 204) { res.writeHead(204); res.end(); }
    else json(res, result.status, { error: result.error });
    return true;
  } },
  { path: /^\/api\/torrents\/([0-9a-f-]+)(?:\/files(?:\/(\d+)\/(stream|transcode|transcode-start|metadata|subtitle|speech|indexed|indexed\/status|progressive\/status|progressive\/events|progressive\/window\/[a-f0-9]{64}|remux-cache\/window))?)?$/,
    handle: torrentEndpoint },
  { path: "/api/subtitles/process", handle: postOnly(processSubtitleTrack) },
  { path: "/api/subtitles/align", handle: postOnly(alignSubtitleTracks) },
  // Older open player windows may still use these subtitle URLs after an update.
  { path: "/api/learning/subtitles/process", handle: postOnly(processSubtitleTrack) },
  { path: "/api/learning/subtitles/align", handle: postOnly(alignSubtitleTracks) },
  { path: "/api/subtitles/search", handle: postOnly(searchSubtitles) },
  { path: "/api/subtitles/download", handle: postOnly(downloadSubtitle) },
  { path: "/api/subtitles/romanize", handle: postOnly(romanizeSubtitles) },
  { path: "/api/images/search", handle: searchLibraryArtwork },
  { path: "/api/images/poster", handle: serveOptimizedPoster },
  { path: "/api/catalog/search", handle: searchCatalog },
  { path: "/api/catalog/home", handle: homeCatalog },
  { path: "/api/catalog/meta", handle: catalogMeta },
  { path: "/api/streams", handle: searchStreams },
  { path: "/api/anime/discover", handle: animeDiscoverEndpoint },
];

export async function handleApi(req, res, url) {
  if (localOnly(url.pathname) && localRequestRejected(req, res)) return true;
  for (const route of API_ROUTES) {
    const match = typeof route.path === "string" ? route.path === url.pathname
      : route.path instanceof RegExp ? route.path.exec(url.pathname) : route.path(url.pathname);
    if (!match) continue;
    const answer = await route.handle(req, res, url, match);
    if (!route.next) return answer;
    if (answer) return true;
  }
  return false;
}
