// Routes /api/* requests to their handlers.
import { default as fs } from "node:fs";
import { default as path } from "node:path";
import {
  animeDiscovery, APP_VERSION, handlePopupApi, playbackTrace, recsStore, releaseCalendar, root,
  STARTED_BY_LAUNCHER, streamHealth, torrentSessions,
} from "../../server.js";
import { json, localRequestRejected, methodNotAllowed, readJsonBody } from "./http-helpers.js";
import { appStateBootstrapEndpoint, appStateEndpoint } from "./app-state.js";
import {
  createTorrentSession, fileDownloadMap, getTorrentSession, removeTorrentSession, sessionPayload,
} from "../torrents/torrent-sessions.js";
import {
  copiedSeekOriginEndpoint, serveIndexedSeek, serveProgressiveSeek, serveRemuxWarmWindow,
  streamTorrentFile,
} from "../streaming/torrent-stream.js";
import { transcodeTorrentFile } from "../streaming/transcode.js";
import { getCachedMediaProbe, probeTorrentFile } from "../media/torrent-probe.js";
import { speechActivityWindow } from "../media/speech-activity.js";
import { extractTorrentSubtitle } from "../subtitles/embedded-subtitles.js";
import { downloadSubtitle, searchSubtitles } from "../subtitles/subtitle-search.js";
import { romanizeSubtitles } from "../subtitles/romanize.js";
import { searchLibraryArtwork, serveOptimizedPoster } from "../catalog/artwork.js";
import { catalogMeta, homeCatalog, searchCatalog } from "../catalog/catalog-api.js";
import { searchStreams } from "../catalog/streams.js";
import { appUpdatesEndpoint } from "../app-updates/updates-api.js";
import { handleStorageApi } from "../persistence/storage-api.js";
import { handleRecsApi } from "../recommendations/recs-api.js";
import {
  browserCoachDecisionEndpoint, browserCoachLiveControl, browserCoachLiveTranscript,
  browserCoachPair, browserCoachPoll, browserCoachResult, browserCoachStatus,
  openBrowserCoachExtensionFolder,
} from "../learning/browser-coach.js";
import {
  browserVoiceCorrection, coachLiveSessionCloseEndpoint, coachLiveSessionStartEndpoint,
  coachLiveSessionTouchEndpoint, coachLiveTranscriptEnrichEndpoint, coachProvidersEndpoint,
  coachUsageEndpoint, coachVoiceTurnEndpoint,
} from "../learning/voice-coach.js";
import {
  alignLearningSubtitles, exportAnkiDeck, handleLearningStoreApi, importAnkiDeck,
  learningPresetByPath, learningPresets, processLearningSubtitle,
} from "../learning/learning-store.js";

export async function handleApi(req, res, url) {
  // Routes only the app's own page uses. Requests sent by other sites (a page you visit can
  // post to 127.0.0.1) and under other host names (DNS rebinding) are refused, so no other
  // site can send prompts through your ChatGPT, change your saved data or start a torrent.
  // The helper extension's own routes (pair, poll, result, live-control, live-transcript)
  // stay outside this check: they carry the helper's token instead.
  const appOnlyRoute = url.pathname === "/api/app-state" || url.pathname.startsWith("/api/app-state/")
    || url.pathname === "/api/diagnostics/playback"
    || url.pathname.startsWith("/api/app-updates/")
    || url.pathname.startsWith("/api/popup/")
    || url.pathname.startsWith("/api/coach/")
    || url.pathname === "/api/browser-coach/status"
    || url.pathname === "/api/browser-coach/decision"
    || url.pathname === "/api/browser-coach/voice-correction"
    || url.pathname === "/api/browser-coach/open-extension-folder"
    || url.pathname === "/api/images/poster"
    || url.pathname === "/api/torrents" || url.pathname.startsWith("/api/torrents/")
    || url.pathname === "/api/recs" || url.pathname.startsWith("/api/recs/")
    || url.pathname === "/api/calendar/releases"
    || url.pathname === "/api/ratings"
    || url.pathname === "/api/health";
  if (appOnlyRoute && localRequestRejected(req, res)) return true;
  if (url.pathname === "/api/diagnostics/playback") {
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
  if (url.pathname === "/api/health") {
    if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
    json(res, 200, {
      app: "language-video-learner",
      appId: fs.existsSync(path.join(root, "installed-app.json")) ? "lvl-public" : null,
      version: APP_VERSION, pid: process.pid, launcher: STARTED_BY_LAUNCHER,
    });
    return true;
  }
  if (url.pathname.startsWith("/api/app-updates/")) return appUpdatesEndpoint(req, res, url);
  if (url.pathname.startsWith("/api/popup/")) return handlePopupApi(req, res, url);
  if (url.pathname === "/api/recs" || url.pathname.startsWith("/api/recs/") || url.pathname === "/api/ratings") return handleRecsApi(req, res, url);
  if (url.pathname === "/api/calendar/releases") {
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
  if (url.pathname === "/api/app-state/bootstrap") return appStateBootstrapEndpoint(req, res);
  if (url.pathname === "/api/app-state" || url.pathname.startsWith("/api/app-state/")) return appStateEndpoint(req, res, url);
  if (url.pathname === "/api/coach/providers") return coachProvidersEndpoint(req, res);
  if (url.pathname === "/api/coach/usage") return coachUsageEndpoint(req, res);
  if (url.pathname === "/api/coach/voice-turn") return coachVoiceTurnEndpoint(req, res);
  if (url.pathname === "/api/coach/live-session/start") return coachLiveSessionStartEndpoint(req, res);
  if (url.pathname === "/api/coach/live-session/close") return coachLiveSessionCloseEndpoint(req, res);
  if (url.pathname === "/api/coach/live-session/touch") return coachLiveSessionTouchEndpoint(req, res);
  if (url.pathname === "/api/coach/live-transcript/enrich") return coachLiveTranscriptEnrichEndpoint(req, res);
  if (url.pathname === "/api/browser-coach/status") return browserCoachStatus(req, res);
  if (url.pathname === "/api/browser-coach/decision") return browserCoachDecisionEndpoint(req, res);
  if (url.pathname === "/api/browser-coach/pair") return browserCoachPair(req, res);
  if (url.pathname === "/api/browser-coach/poll") return browserCoachPoll(req, res);
  if (url.pathname === "/api/browser-coach/result") return browserCoachResult(req, res);
  if (url.pathname === "/api/browser-coach/live-control") return browserCoachLiveControl(req, res);
  if (url.pathname === "/api/browser-coach/live-transcript") return browserCoachLiveTranscript(req, res);
  if (url.pathname === "/api/browser-coach/open-extension-folder") return openBrowserCoachExtensionFolder(req, res);

  if (url.pathname === "/api/browser-coach/voice-correction") {
    if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
    await browserVoiceCorrection(req, res);
    return true;
  }

  if (url.pathname === "/api/learning/presets") {
    return learningPresets(req, res, url);
  }

  const learningPresetMatch = /^\/api\/learning\/presets\/([a-z_-]{2,8})\/(words|phrases)\/(\d{1,5})$/i.exec(url.pathname);
  if (learningPresetMatch) {
    return learningPresetByPath(req, res, url, learningPresetMatch[1], learningPresetMatch[2], learningPresetMatch[3]);
  }

  if (url.pathname === "/api/learning/subtitles/process") {
    if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
    await processLearningSubtitle(req, res);
    return true;
  }

  if (url.pathname === "/api/learning/subtitles/align") {
    if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
    await alignLearningSubtitles(req, res);
    return true;
  }

  const learningStoreRoute = url.pathname.startsWith("/api/anki/") || url.pathname.startsWith("/api/ankiweb/") || url.pathname === "/api/clips" || url.pathname.startsWith("/api/clips/");
  const storageRoute = url.pathname === "/api/storage" || url.pathname.startsWith("/api/storage/");
  if ((learningStoreRoute || storageRoute) && localRequestRejected(req, res)) return true;
  if (storageRoute) return (await handleStorageApi(req, res, url)) || false;

  if (url.pathname === "/api/anki/import") {
    if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
    await importAnkiDeck(req, res);
    return true;
  }

  if (learningStoreRoute) {
    if (url.pathname !== "/api/anki/export" && await handleLearningStoreApi(req, res, url)) return true;
  }

  if (url.pathname === "/api/anki/export") {
    if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
    await exportAnkiDeck(req, res);
    return true;
  }

  if (url.pathname === "/api/torrents") {
    if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
    await createTorrentSession(req, res);
    return true;
  }

  const torrentMatch = /^\/api\/torrents\/([0-9a-f-]+)(?:\/files(?:\/(\d+)\/(stream|transcode|transcode-start|metadata|subtitle|speech|indexed|indexed\/status|progressive\/status|progressive\/events|progressive\/window\/[a-f0-9]{64}|remux-cache\/window))?)?$/.exec(url.pathname);
  if (torrentMatch) {
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
      // A second Watch/PiP window can still be streaming this same session.
      // Closing one view must not destroy media actively held by another.
      if ((Number(session.openStreams) || 0) > 0) {
        json(res, 409, { error: "torrent_session_in_use", message: "This video is still playing in another view. Its download was preserved." });
        return true;
      }
      await removeTorrentSession(id);
      res.writeHead(204);
      res.end();
      return true;
    }
    return methodNotAllowed(res, ["GET", "DELETE"]);
  }

  if (url.pathname === "/api/subtitles/search") {
    if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
    await searchSubtitles(req, res);
    return true;
  }

  if (url.pathname === "/api/subtitles/download") {
    if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
    await downloadSubtitle(req, res);
    return true;
  }

  if (url.pathname === "/api/subtitles/romanize") {
    if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
    await romanizeSubtitles(req, res);
    return true;
  }

  if (url.pathname === "/api/images/search") {
    return searchLibraryArtwork(req, res, url);
  }

  if (url.pathname === "/api/images/poster") {
    return serveOptimizedPoster(req, res, url);
  }

  if (url.pathname === "/api/catalog/search") {
    return searchCatalog(req, res, url);
  }

  if (url.pathname === "/api/catalog/home") {
    return homeCatalog(req, res, url);
  }

  if (url.pathname === "/api/catalog/meta") {
    return catalogMeta(req, res, url);
  }

  if (url.pathname === "/api/streams") {
    return searchStreams(req, res, url);
  }
  if (url.pathname === "/api/anime/discover") {
    if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
    try {
      const result = await animeDiscovery.discover(url.searchParams);
      json(res, 200, result, { "Cache-Control": "private, max-age=60" });
    } catch (error) {
      json(res, 503, { error: error.message || "AniList discovery is temporarily unavailable" });
    }
    return true;
  }

  return false;
}
