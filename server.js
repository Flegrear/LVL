import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import WebTorrent from "webtorrent";
import AdmZip from "adm-zip";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import KuroshiroModule from "kuroshiro";
import KuromojiAnalyzer from "kuroshiro-analyzer-kuromoji";
import { pinyin } from "pinyin-pro";
import hangulRomanization from "hangul-romanization";
import { searchSubtitles as searchWyzieSubtitles } from "wyzie-lib";
import { learningPresetBundle, learningPresetCatalog, learningPresetSlice } from "./learning/presets.js";
import { alignCueArtifacts, processCueArtifact } from "./learning/subtitle-processing.js";
import { SPEECH_FRAME_MS, SPEECH_SAMPLE_RATE, speechActivityFromPcm } from "./shared/subtitles/subtitle-sync.js";
import { assToWebVtt as parseAssToWebVtt } from "./shared/subtitles/ass-events.js";
import { dropSpeechTapes, speechTapeActivity, speechTapeCoverage, speechTapeWriter } from "./backend/media/speech-tape.js";
import { probeCopiedSeekOrigin } from "./backend/media/transcode-start.js";
import { heightFromQualityLabel, qualityLabel, releaseVideoHeight } from "./shared/media/series-sources.js";
import { buildAnkiPackage, buildAnkiText, htmlToText, readAnkiCollection, readAnkiPackage, readAnkiText } from "./learning/anki/anki.js";
import { createAnkiStore } from "./learning/anki/anki-store.js";
import { downloadSharedDeck, searchSharedDecks, sharedDeckInfo } from "./learning/anki/ankiweb.js";
import { PRESET_WORD_SIZES, loadGlosses, presetDeck } from "./learning/preset-decks.js";
import { createClipStore } from "./learning/clips.js";
import { normalizeLearningLocale } from "./shared/settings/language-settings.js";
import { createStorageManager } from "./backend/persistence/storage.js";
import { catalogTitleDetails } from "./backend/catalog/catalog-details.js";
import { createRecsStore } from "./backend/recommendations/recs-store.js";
import { createRecsService } from "./backend/recommendations/recs-service.js";
import { createAniListClient } from "./backend/integrations/anilist.js";
import { createReleaseCalendarService } from "./backend/catalog/calendar-releases.js";
import { createAnimeDiscoveryService } from "./backend/catalog/anime-discovery.js";
import { exportRecsData, ratingsCsv } from "./backend/recommendations/recs-export.js";
import { APP_STATE_SECTIONS, createAppDatabase } from "./backend/persistence/app-db.js";
import { createServerFeatureHost } from "./backend/features/feature-host.js";
import { SERVER_FEATURES } from "./backend/features/registry.js";
import { createTranscodePlan, inspectMediaCompatibility, transcodeVideoFilter } from "./shared/media/media-compat.js";
import { dolbyVisionFromProbe } from "./shared/media/video-profile.js";
import { normalizeEmbeddedChapterMarkers } from "./shared/media/embedded-chapter-markers.js";
import { detectHardwareH264Encoder, hardwareVideoEncodingArgs } from "./backend/media/hardware-transcode.js";
import { createPlaybackTrace } from "./backend/media/performance-trace.js";
import { createStreamHealth } from "./backend/media/stream-health.js";
import { attachPeerManager } from "./backend/media/peer-manager.js";
import { createInternalReaderRoles } from "./backend/media/internal-reader-roles.js";
import { createRemuxSegmentCache } from "./backend/media/remux-segment-cache.js";
import { createProgressiveIndexCache } from "./backend/media/progressive-index-cache.js";
import { createProgressiveVerifiedSource } from "./backend/media/progressive-verified-source.js";
import { verifyTorrentFileByteRange } from "./backend/media/verified-torrent-range.js";
import { pruneExitedTranscodes } from "./backend/media/transcode-slot-lifecycle.js";
import { pipeRemuxAhead } from "./backend/media/remux-run-ahead.js";
import { isTorrentFileFullyVerified } from "./backend/media/verified-torrent-file.js";
import { evaluateEncodedH264CacheEligibility } from "./backend/media/transcode-cache-eligibility.js";
import { createIndexedVideoCache, indexedCacheEligibility } from "./backend/media/indexed-video-cache.js";
import { createUpdatePolicy } from "./backend/app-updates/update-policy.js";
import {
  COACH_LIVE_IDLE_TIMEOUT_MS,
  buildVoiceCoachRepairPrompt,
  buildLiveTranscriptEnrichmentPrompt,
  buildNativeLiveVoicePrompt,
  buildVoiceCoachPrompt,
  coachOutputMissingRequiredFields,
  coachLiveSessionKey,
  isReusableCoachLiveSession,
  normalizeCoachAssistanceMode,
  normalizeCoachLivePreset,
  normalizeCoachTurnInput,
  normalizeCoachTurnOutput,
} from "./learning/coach-core.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4173);
const APP_VERSION = (() => { try { return String(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version || ""); } catch { return ""; } })();
// Only the optional, short, verified SDR encoded-output cache needs a precise
// FFmpeg binary identity. Hash its real bytes lazily, once, with bounded
// streaming memory; ordinary playback must not pay this startup cost.
let ffmpegBinaryFingerprintPromise = null;
async function exactFfmpegFingerprint() {
  if (!ffmpegPath) return null;
  if (!ffmpegBinaryFingerprintPromise) {
    ffmpegBinaryFingerprintPromise = (async () => {
      const digest = crypto.createHash("sha256");
      for await (const chunk of fs.createReadStream(ffmpegPath, { highWaterMark: 1024 * 1024 })) digest.update(chunk);
      return digest.digest("hex");
    })().catch(() => null);
  }
  return ffmpegBinaryFingerprintPromise;
}
// Started by the Windows tray launcher (launcher/Launcher.cs), which stops the app by closing stdin.
const STARTED_BY_LAUNCHER = process.env.LANGUAGE_VIDEO_LEARNER_LAUNCHER === "1";
// The installed alpha launcher generates this ephemeral loopback endpoint and
// per-launch secret. Browser clients never receive the secret or bridge address.
const UPDATE_BRIDGE = (() => {
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
const torrentRoot = path.join(torrentShareRoot, `port-${port}`);
const appDataRoot = process.env.LANGUAGE_VIDEO_LEARNER_DATA_ROOT
  ? path.resolve(process.env.LANGUAGE_VIDEO_LEARNER_DATA_ROOT)
  : path.join(root, "data");
const appDatabase = createAppDatabase(path.join(appDataRoot, "language-video-learner.sqlite3"));
const ankiStore = createAnkiStore({ db: appDatabase.sqlite, mediaRoot: path.join(appDataRoot, "anki-media") });
const recsStore = createRecsStore({ db: appDatabase.sqlite, getMeta: appDatabase.getMeta, setMeta: appDatabase.setMeta });
const releaseCalendar = createReleaseCalendarService({
  getTmdbKey: () => recsStore.settings().tmdbKey,
  anilistEndpoint: process.env.LANGUAGE_VIDEO_LEARNER_ANILIST_URL || undefined,
  tvmazeEndpoint: process.env.LANGUAGE_VIDEO_LEARNER_TVMAZE_SCHEDULE_URL || undefined,
  tmdbEndpoint: process.env.LANGUAGE_VIDEO_LEARNER_TMDB_URL || undefined,
});
const animeDiscovery = createAnimeDiscoveryService({ endpoint: process.env.LANGUAGE_VIDEO_LEARNER_ANILIST_URL || undefined });
// One AniList client (one request queue and rate limit) for recommendations and features.
const anilistClient = createAniListClient(process.env.LANGUAGE_VIDEO_LEARNER_ANILIST_URL ? { endpoint: process.env.LANGUAGE_VIDEO_LEARNER_ANILIST_URL, minGapMs: 0 } : {});
// Picks are matched to catalog titles with the same search the Add a title dialog uses.
const recs = createRecsService({
  store: recsStore,
  anilist: anilistClient,
  searchCatalog: (query) => catalogSearchResults(query),
});
const clipStore = createClipStore({
  db: appDatabase.sqlite,
  root: path.join(appDataRoot, "clips"),
  ffmpegPath,
  sourceUrl: (sessionId, fileIndex) => `http://127.0.0.1:${port}/api/torrents/${encodeURIComponent(sessionId)}/files/${fileIndex}/stream`,
});
const storage = createStorageManager({
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
const remuxSegmentCache = createRemuxSegmentCache({
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
const APP_STATE_CAS_SECTIONS = new Set(["cards", "known", "library", "preferences"]);

const MAX_BODY_BYTES = 64 * 1024;
const MAX_APP_STATE_BODY_BYTES = 48 * 1024 * 1024;
const MAX_LEARNING_ARTIFACT_BODY_BYTES = 2 * 1024 * 1024;
const MAX_LEARNING_ALIGNMENT_BODY_BYTES = 4 * 1024 * 1024;
const MAX_MAGNET_LENGTH = 16 * 1024;
const MAX_TORRENT_SESSIONS = 4;
const MAX_TORRENT_FILES = 128;
const MAX_TORRENT_VIDEO_FILES = 64;
const MAX_TORRENT_TOTAL_BYTES = 80 * 1024 * 1024 * 1024;
const MAX_TORRENT_VIDEO_BYTES = 20 * 1024 * 1024 * 1024;
const MAX_TORRENT_SIDECAR_BYTES = 64 * 1024 * 1024;
const MAX_TORRENT_PATH_LENGTH = 512;
const TORRENT_SESSION_TTL_MS = 30 * 60 * 1000;
const TORRENT_SLOW_METADATA_MS = 20 * 1000;
const MAX_TRANSCODE_JOBS = 2;
const MAX_EMBEDDED_SUBTITLE_JOBS = 2;
const MAX_PROBE_JOBS = 2;
const MAX_PROBE_CACHE_ENTRIES = 32;
const MEDIA_PROBE_TIMEOUT_MS = 20 * 1000;
const MEDIA_PROBE_CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_PROBE_OUTPUT_BYTES = 256 * 1024;
const MAX_COPIED_SEEK_PROBES = 2;
const MAX_COPIED_SEEK_SUBSCRIBERS = 16;
const MAX_COPIED_SEEK_CACHE_ENTRIES = 64;
const COPIED_SEEK_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_SUBTITLE_DOWNLOAD_BYTES = 12 * 1024 * 1024;
const MAX_SUBTITLE_FILES = 20;
const MAX_SUBTITLE_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_ROMANIZATION_LINES = 80;
const MAX_ROMANIZATION_TEXT_BYTES = 40 * 1024;
const MAX_ARTWORK_QUERY_LENGTH = 180;
const MAX_ARTWORK_RESULTS = 12;
const ARTWORK_CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_CATALOG_QUERY_LENGTH = 180;
const MAX_CATALOG_RESULTS = 24;
const CATALOG_CACHE_TTL_MS = 10 * 60 * 1000;
const STREAM_CACHE_TTL_MS = 10 * 60 * 1000;
const STREAM_UPSTREAM_TIMEOUT_MS = 12 * 1000;
const MAX_STREAM_RESULTS = 200;
// The chapter list is metadata only, so it can list long anime seasons in full.
const MAX_SEASON_LIST_EPISODES = 2000;
const SUBDL_API_ORIGIN = "https://api.subdl.com";
const SUBDL_DOWNLOAD_ORIGIN = "https://dl.subdl.com";
const OPENSUBTITLES_STREMIO_ORIGIN = "https://opensubtitles-v3.strem.io";
const SUBSOURCE_API_ORIGIN = "https://api.subsource.net/api/v1";
const TVMAZE_API_ORIGIN = "https://api.tvmaze.com";
const TVMAZE_IMAGE_ORIGIN = "https://static.tvmaze.com";
// Tests point this at a local stub; normally Cinemeta.
const CINEMETA_ORIGIN = process.env.LANGUAGE_VIDEO_LEARNER_CINEMETA_URL || "https://v3-cinemeta.strem.io";
const IMDB_SUGGEST_ORIGIN = process.env.LANGUAGE_VIDEO_LEARNER_IMDB_SUGGEST_URL || "https://v3.sg.media-imdb.com/suggestion";
const STREAM_PROVIDERS = [
  { id: "torrentio", name: "Torrentio", origin: "https://torrentio.strem.fun" },
  { id: "tpbplus", name: "TPB+", origin: "https://thepiratebay-plus.strem.fun" },
];
const BROWSER_COACH_CLIENT = "language-video-learner-browser-extension";
const BROWSER_COACH_REQUEST_TIMEOUT_MS = 125 * 1000;
// MV3 service workers are intentionally allowed to sleep when the helper tab has not
// been created yet. Our fallback alarm wakes the extension roughly every 30 seconds,
// so a 12-second presence window incorrectly flaps the UI to OFFLINE while the
// extension is healthy but idle. Keep enough margin to tolerate one delayed alarm.
const BROWSER_COACH_PRESENCE_MS = 75 * 1000;
const VOICE_USAGE_WINDOW_MS = 24 * 60 * 60 * 1000;
const VOICE_USAGE_REFERENCE_LIMIT_MS = 3 * 60 * 60 * 1000;
const VOICE_USAGE_ACTIVE_STALE_MS = 2 * 60 * 1000;
const BROWSER_COACH_EXTENSION_DIR = path.resolve(root, "browser-extension");
// The helper is deliberately absent from the media-only Alpha. Retain its
// last protocol version for legacy route/test compatibility until Learning
// and its separately reviewed extension return.
const BROWSER_COACH_EXTENSION_VERSION = "0.1.30";
const DEFAULT_COACH_PROVIDER_ID = "chatgpt-browser";
const COACH_PROVIDERS = new Map([
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
const VIDEO_EXTENSIONS = new Set([".mp4", ".m4v", ".webm", ".ogv", ".ogg", ".mkv", ".avi", ".mov"]);
const DIRECT_VIDEO_EXTENSIONS = new Set([".mp4", ".m4v", ".webm", ".ogv", ".ogg"]);
const SAFE_TORRENT_SIDECAR_EXTENSIONS = new Set([
  ".srt", ".vtt", ".ass", ".ssa", ".sub", ".idx",
  ".jpg", ".jpeg", ".png", ".webp", ".gif",
  ".nfo", ".txt", ".sfv",
]);
const FALLBACK_TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://tracker.openbittorrent.com:6969/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://open.stealth.si:80/announce",
];

const mime = {
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

const PUBLIC_ASSETS = new Map([
  ["/", { file: "index.html", cacheControl: "no-store" }],
  ["/index.html", { file: "index.html", cacheControl: "no-store" }],
  ["/home", { file: "index.html", cacheControl: "no-store" }],
  ["/watch", { file: "index.html", cacheControl: "no-store" }],
  ["/library", { file: "index.html", cacheControl: "no-store" }],
  ["/calendar", { file: "index.html", cacheControl: "no-store" }],
  ["/title", { file: "index.html", cacheControl: "no-store" }],
  ["/study", { file: "index.html", cacheControl: "no-store" }],
  ["/review", { file: "index.html", cacheControl: "no-store" }],
  ["/test", { file: "index.html", cacheControl: "no-store" }],
  ["/tests", { file: "index.html", cacheControl: "no-store" }],
  ["/settings", { file: "index.html", cacheControl: "no-store" }],
  // AniList OAuth implicit grant returns its bearer token in a URL fragment;
  // the SPA consumes it entirely in the browser. Node never receives it.
  ["/anilist/callback", { file: "index.html", cacheControl: "no-store" }],
  ["/app.js", { file: "app.js", cacheControl: "no-cache" }],
  ["/lvl-ratings.js", { file: "frontend/recommendations/lvl-ratings.js", cacheControl: "no-cache" }],
  ["/frontend/recommendations/lvl-ratings.js", { file: "frontend/recommendations/lvl-ratings.js", cacheControl: "no-cache" }],
  ["/anime-catalog-match.js", { file: "frontend/catalog/anime-catalog-match.js", cacheControl: "no-cache" }],
  ["/calendar-view.js", { file: "frontend/calendar/calendar-view.js", cacheControl: "no-cache" }],
  ["/calendar-surface.js", { file: "frontend/calendar/calendar-surface.js", cacheControl: "no-cache" }],
  ["/frontend/calendar/calendar-view.js", { file: "frontend/calendar/calendar-view.js", cacheControl: "no-cache" }],
  ["/frontend/calendar/calendar-surface.js", { file: "frontend/calendar/calendar-surface.js", cacheControl: "no-cache" }],
  ["/anilist-auto-client.js", { file: "frontend/anilist/anilist-auto-client.js", cacheControl: "no-cache" }],
  ["/anilist-score-sync.js", { file: "frontend/anilist/anilist-score-sync.js", cacheControl: "no-cache" }],
  ["/title-public-ratings.js", { file: "frontend/catalog/title-public-ratings.js", cacheControl: "no-cache" }],
  ["/anilist-watch-sync.js", { file: "frontend/anilist/anilist-watch-sync.js", cacheControl: "no-cache" }],
  ["/anilist-unwatch.js", { file: "frontend/anilist/anilist-unwatch.js", cacheControl: "no-cache" }],
  ["/anilist-test-sync.js", { file: "frontend/anilist/anilist-test-sync.js", cacheControl: "no-cache" }],
  ["/browser-media.js", { file: "frontend/player/browser-media.js", cacheControl: "no-cache" }],
  ["/audio-policy.js", { file: "shared/media/audio-policy.js", cacheControl: "no-cache" }],
  ["/video-profile.js", { file: "shared/media/video-profile.js", cacheControl: "no-cache" }],
  ["/playback-recovery.js", { file: "frontend/player/playback-recovery.js", cacheControl: "no-cache" }],
  ["/playback-diagnostics.js", { file: "frontend/player/playback-diagnostics.js", cacheControl: "no-cache" }],
  ["/core.js", { file: "learning/browser/core.js", cacheControl: "no-cache" }],
  ["/review-scheduler.js", { file: "learning/browser/review-scheduler.js", cacheControl: "no-cache" }],
  ["/styles.css", { file: "frontend/styles/styles.css", cacheControl: "no-cache" }],
  ["/calendar.css", { file: "frontend/calendar/calendar.css", cacheControl: "no-cache" }],
  ["/frontend/calendar/calendar.css", { file: "frontend/calendar/calendar.css", cacheControl: "no-cache" }],
  ["/ui.css", { file: "frontend/styles/ui.css", cacheControl: "no-cache" }],
  ["/ui.js", { file: "frontend/ui/ui.js", cacheControl: "no-cache" }],
  ["/home-feed.js", { file: "frontend/catalog/home-feed.js", cacheControl: "no-cache" }],
  ["/series-sources.js", { file: "shared/media/series-sources.js", cacheControl: "no-cache" }],
  ["/subtitle-sync.js", { file: "shared/subtitles/subtitle-sync.js", cacheControl: "no-cache" }],
  ["/subtitle-stream.js", { file: "shared/subtitles/subtitle-stream.js", cacheControl: "no-cache" }],
  ["/watch-discovery.js", { file: "frontend/catalog/watch-discovery.js", cacheControl: "no-cache" }],
  ["/learn.js", { file: "learning/browser/learn.js", cacheControl: "no-cache" }],
  ["/recs-ui.js", { file: "frontend/recommendations/recs-ui.js", cacheControl: "no-cache" }],
  ["/frontend/recommendations/recs-ui.js", { file: "frontend/recommendations/recs-ui.js", cacheControl: "no-cache" }],
  ["/anilist-library.js", { file: "frontend/anilist/anilist-library.js", cacheControl: "no-cache" }],
  ["/language-settings.js", { file: "shared/settings/language-settings.js", cacheControl: "no-cache" }],
  ["/ui-i18n.js", { file: "frontend/ui/ui-i18n.js", cacheControl: "no-cache" }],
  ["/vocabulary-meanings.js", { file: "learning/browser/vocabulary-meanings.js", cacheControl: "no-cache" }],
  ["/favicon.ico", { file: "assets/platform/favicon.ico", cacheControl: "no-cache" }],
  ["/icon.svg", { file: "assets/platform/icon.svg", cacheControl: "no-cache" }],
  ["/apple-touch-icon.png", { file: "assets/platform/apple-touch-icon.png", cacheControl: "no-cache" }],
  ["/site.webmanifest", { file: "assets/platform/site.webmanifest", cacheControl: "no-cache" }],
  ["/frontend/catalog/anime-catalog-match.js", { file: "frontend/catalog/anime-catalog-match.js", cacheControl: "no-cache" }],
  ["/frontend/anilist/anilist-auto-client.js", { file: "frontend/anilist/anilist-auto-client.js", cacheControl: "no-cache" }],
  ["/frontend/anilist/anilist-auto-association.js", { file: "frontend/anilist/anilist-auto-association.js", cacheControl: "no-cache" }],
  ["/frontend/anilist/anilist-manual-season-link.js", { file: "frontend/anilist/anilist-manual-season-link.js", cacheControl: "no-cache" }],
  ["/frontend/anilist/anilist-score-sync.js", { file: "frontend/anilist/anilist-score-sync.js", cacheControl: "no-cache" }],
  ["/frontend/catalog/title-public-ratings.js", { file: "frontend/catalog/title-public-ratings.js", cacheControl: "no-cache" }],
  ["/frontend/anilist/anilist-watch-sync.js", { file: "frontend/anilist/anilist-watch-sync.js", cacheControl: "no-cache" }],
  ["/frontend/anilist/anilist-unwatch.js", { file: "frontend/anilist/anilist-unwatch.js", cacheControl: "no-cache" }],
  ["/frontend/anilist/anilist-test-sync.js", { file: "frontend/anilist/anilist-test-sync.js", cacheControl: "no-cache" }],
  ["/frontend/player/browser-media.js", { file: "frontend/player/browser-media.js", cacheControl: "no-cache" }],
  ["/frontend/player/remux-mse.js", { file: "frontend/player/remux-mse.js", cacheControl: "no-cache" }],
  ["/frontend/player/embedded-subtitle-default.js", { file: "frontend/player/embedded-subtitle-default.js", cacheControl: "no-cache" }],
  ["/frontend/player/media-startup.js", { file: "frontend/player/media-startup.js", cacheControl: "no-cache" }],
  ["/shared/media/audio-policy.js", { file: "shared/media/audio-policy.js", cacheControl: "no-cache" }],
  ["/shared/media/video-profile.js", { file: "shared/media/video-profile.js", cacheControl: "no-cache" }],
  ["/frontend/player/playback-recovery.js", { file: "frontend/player/playback-recovery.js", cacheControl: "no-cache" }],
  ["/frontend/player/playback-diagnostics.js", { file: "frontend/player/playback-diagnostics.js", cacheControl: "no-cache" }],
  ["/learning/browser/core.js", { file: "learning/browser/core.js", cacheControl: "no-cache" }],
  ["/learning/browser/review-scheduler.js", { file: "learning/browser/review-scheduler.js", cacheControl: "no-cache" }],
  ["/frontend/styles/styles.css", { file: "frontend/styles/styles.css", cacheControl: "no-cache" }],
  ["/frontend/styles/ui.css", { file: "frontend/styles/ui.css", cacheControl: "no-cache" }],
  ["/frontend/ui/ui.js", { file: "frontend/ui/ui.js", cacheControl: "no-cache" }],
  ["/frontend/catalog/home-feed.js", { file: "frontend/catalog/home-feed.js", cacheControl: "no-cache" }],
  ["/shared/media/series-sources.js", { file: "shared/media/series-sources.js", cacheControl: "no-cache" }],
  ["/shared/subtitles/subtitle-sync.js", { file: "shared/subtitles/subtitle-sync.js", cacheControl: "no-cache" }],
  ["/shared/subtitles/subtitle-stream.js", { file: "shared/subtitles/subtitle-stream.js", cacheControl: "no-cache" }],
  ["/frontend/catalog/watch-discovery.js", { file: "frontend/catalog/watch-discovery.js", cacheControl: "no-cache" }],
  ["/learning/browser/learn.js", { file: "learning/browser/learn.js", cacheControl: "no-cache" }],
  ["/frontend/anilist/anilist-library.js", { file: "frontend/anilist/anilist-library.js", cacheControl: "no-cache" }],
  ["/shared/settings/language-settings.js", { file: "shared/settings/language-settings.js", cacheControl: "no-cache" }],
  ["/frontend/ui/ui-i18n.js", { file: "frontend/ui/ui-i18n.js", cacheControl: "no-cache" }],
  ["/frontend/features/feature-host.js", { file: "frontend/features/feature-host.js", cacheControl: "no-cache" }],
  ["/frontend/features/registry.js", { file: "frontend/features/registry.js", cacheControl: "no-cache" }],
  ["/frontend/player/performance-trace.js", { file: "frontend/player/performance-trace.js", cacheControl: "no-cache" }],
  ["/frontend/player/stream-status.js", { file: "frontend/player/stream-status.js", cacheControl: "no-cache" }],
  ["/frontend/player/progressive-seek.js", { file: "frontend/player/progressive-seek.js", cacheControl: "no-cache" }],
  ["/frontend/player/torrent-piece-wait.js", { file: "frontend/player/torrent-piece-wait.js", cacheControl: "no-cache" }],
  ["/frontend/updates/update-view.js", { file: "frontend/updates/update-view.js", cacheControl: "no-cache" }],
  ["/learning/browser/vocabulary-meanings.js", { file: "learning/browser/vocabulary-meanings.js", cacheControl: "no-cache" }],
]);

// The only public /brand/* files are the fixed, vetted icon/wordmark exports.
// No arbitrary filesystem paths are made available by this directory.
for (const theme of ["dark", "light"]) {
  const brandNames = [
    ...[180, 192, 256, 512].map((size) => `app_icon_${theme}_${size}.png`),
    `favicon_${theme}.ico`,
    ...[16, 32, 48, 64, 128, 256].map((size) => `favicon_${theme}_${size}.png`),
    ...["app_icon", "favicon", "favicon_circle"].flatMap((name) => ["svg", "png"].map((ext) => `lvl_${name}_${theme}.${ext}`)),
    ...["wordmark", "wordmark_with_name"].flatMap((name) => ["svg", "png"].map((ext) => `lvl_${name}_${theme}_bg.${ext}`)),
  ];
  for (const name of brandNames) PUBLIC_ASSETS.set(`/brand/${name}`, { file: `assets/brand/${theme}/${name}`, cacheControl: "no-cache" });
}
for (const ink of ["black", "white"]) {
  for (const ext of ["svg", "png"]) {
    const name = `lvl_v_mark_${ink}_transparent.${ext}`;
    PUBLIC_ASSETS.set(`/brand/${name}`, { file: `assets/brand/marks/${name}`, cacheControl: "no-cache" });
  }
}

const torrentClient = new WebTorrent({ maxConns: 40 });
const torrentSessions = new Map();
const playbackTrace = createPlaybackTrace();
const streamHealth = createStreamHealth();
const internalReaderRoles = createInternalReaderRoles({ port });
function internalTorrentSource(session, fileIndex, role) {
  const base = `http://127.0.0.1:${port}/api/torrents/${encodeURIComponent(session.id)}/files/${fileIndex}/stream`;
  const lease = internalReaderRoles.issue(session, fileIndex, role);
  return { url: lease?.urlFor(base) || base, release: () => lease?.release() };
}
const activeTranscodes = new Set();
// Background encoders are tracked separately from the foreground players.
// An already-admitted background process must not see its OWN shared slot as
// a new foreground conflict. Admission is bounded separately before spawn;
// when a new player actually needs a slot transcodeTorrentFile preempts caches.
const indexedActiveProcesses = new Set();
const progressiveActiveProcesses = new Set();
const activeForegroundTranscodeCount = () => Math.max(0,activeTranscodes.size
  - indexedActiveProcesses.size - progressiveActiveProcesses.size);
const activeEmbeddedSubtitleJobs = new Set();
let preferredHardwareEncoderPromise = null;
let failedHardwareEncoder = "";
async function videoTranscodeEncoder() {
  if (!preferredHardwareEncoderPromise) preferredHardwareEncoderPromise = detectHardwareH264Encoder(ffmpegPath);
  const encoder = await preferredHardwareEncoderPromise;
  return encoder && encoder !== failedHardwareEncoder ? encoder : "libx264";
}
const mediaProbeCache = new Map();
const copiedSeekOriginCache = new Map();
const copiedSeekOriginInflight = new Map();
const artworkSearchCache = new Map();
const catalogSearchCache = new Map();
const streamSearchCache = new Map();
const homeCatalogCache = new Map();
const HOME_CATALOG_META_KEY = "home_catalog_v1";
let homeCatalogRestoredFromDisk = false;
const remoteSubtitleDownloads = new Map();
const voiceCoachSessions = new Map(
  (appDatabase.readSection("coachSessions") || []).map((session) => [
    coachLiveSessionKey(session.chatId, session.nativeVoice),
    session,
  ]),
);
if (cleanVoiceCoachSessions()) persistVoiceCoachSessions();
const browserCoachRequests = new Map();
const browserCoachToken = crypto.randomBytes(24).toString("base64url");
let browserCoachExtension = { lastSeenAt: 0, version: null, origin: null };
const browserCoachInstances = new Map();
let activeProbeJobs = 0;
let activeCopiedSeekProbes = 0;
const ffprobePath = ffprobeStatic?.path || null;
// Full-file browser-range cache is strictly optional. Background conversions
// consume one of the same two FFmpeg slots as foreground playback, and never
// start unless there is no active foreground conversion.
const indexedVideoCache = createIndexedVideoCache({
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
// Independently verified fMP4/IDR windows become readable while the next GOP
// is still converting. This is separate from the existing complete MP4 index.
// It uses local, fully bitfield-verified source bytes only: no optional cache
// worker may download missing torrent pieces or consume both FFmpeg slots.
// A committed GOP is announced as soon as its complete MP4 + FFprobe proof
// hits the atomic index. Browser readiness therefore need not wait for the
// next three-second poll; subscribers still fetch the authenticated status
// before drawing a new bright interval.
const progressiveReadyListeners = new Map();
const progressiveStarts = new Map();
const progressiveIslandStarts = new Map();
function startProgressiveWhenNewPieces(params, status) {
  if (storage.limits().remuxCacheEnabled !== true || !status?.identityKey
    || activeTranscodes.size >= MAX_TRANSCODE_JOBS || fullIndexFirstActive(params)
    || !['waiting','partial'].includes(status.status)) return false;
  const size = status.sourceFullyVerified === true
    && Number.isSafeInteger(status.sourceFileBytes) && status.sourceFileBytes > 0
    ? `whole:${status.sourceFileBytes}`
    : `prefix:${Number(status.verifiedSourceBytes) || 0}`;
  const previous = progressiveStarts.get(status.identityKey);
  // A stopped/failed partial conversion must NOT re-encode a 58-minute prefix
  // every time the UI checks status. Newly hash-verified source bytes, however,
  // grant exactly one new attempt; new GOPs can be published before torrent EOF.
  if ((status.status === 'waiting'
    || status.status === 'partial' && status.canContinue === true)
    && previous?.bytes !== size) {
    if (progressiveStarts.size >= 256)
      progressiveStarts.delete(progressiveStarts.keys().next().value);
    progressiveStarts.set(status.identityKey,{bytes:size,sessionId:params.session.id});
    void progressiveIndexCache.start(params);
    return true;
  }
  if (status.sourceMode !== 'verified-prefix') return false;
  // A hash-verified remote MKV Cluster can be independently reconstructed
  // from its verified EBML header plus a complete, verified later Cluster.
  // The cache must still decode it, prove IDR/AAC and recover original movie
  // PTS before publication. An arbitrary downloaded island is NOT bright.
  const evidence = progressiveVerifiedSource.inspect(params);
  if (!evidence?.eligible || !evidence.islands?.length) return false;
  let attempts = progressiveIslandStarts.get(status.identityKey);
  if (!attempts) {
    if (progressiveIslandStarts.size >= 64)
      progressiveIslandStarts.delete(progressiveIslandStarts.keys().next().value);
    attempts = new Set();
    progressiveIslandStarts.set(status.identityKey,attempts);
  }
  for (const island of evidence.islands) {
    const priorClusters=(status.ranges||[]).filter(item=>
      item.sourceKind==='isolated-cluster'
      && Number.isSafeInteger(item.sourceClusterStart)
      && item.sourceClusterStart>=island.start
      && item.sourceClusterStart<=island.end);
    const afterStartBytes=priorClusters.length
      ?Math.max(...priorClusters.map(item=>item.sourceClusterStart))+1
      :island.start;
    const signature=`${island.start}:${island.end}:${afterStartBytes}`;
    if (attempts.has(signature)) continue;
    if (attempts.size>=8192)return false;
    attempts.add(signature); // one attempt per verified island/cluster horizon
    void progressiveIndexCache.start(params,{sourceKind:'island',afterStartBytes});
    return true;
  }
  return false;
}
// Once a file is fully downloaded and verified, video that is copied (not
// re-encoded) becomes seekable from start to end in one FFmpeg pass: about
// 30 s for a 24-minute 1080p episode. Preparing the same episode section by
// section takes about 9 minutes, because every section gets its own check
// and index update. So a complete, copyable source builds the whole-episode
// file first; sections already prepared stay usable meanwhile. If that build
// hasn't started within 20 s (quota, a busy converter), or the player starts
// playing from sections, the section job is started again: a stopped job on a
// complete file doesn't restart by itself.
const fullIndexFirst = new Map(); // `${sessionId}:${fileIndex}` -> { since, gaveUp, stopped, ... }
const FULL_INDEX_FIRST_GRACE_MS = 20_000;
function fullIndexFirstChoice(params) {
  if (storage.limits().remuxCacheEnabled !== true) return null;
  const key = `${params.session?.id}:${params.fileIndex}`;
  const known = fullIndexFirst.get(key);
  if (known) return known.gaveUp ? null : known;
  const info = indexedCacheEligibility({ ...params, enabled: true });
  if (!info.eligible || info.identity?.videoStrategy !== 'copy') return null;
  if (fullIndexFirst.size >= 64) fullIndexFirst.delete(fullIndexFirst.keys().next().value);
  const entry = { since: Date.now(), gaveUp: false };
  fullIndexFirst.set(key, entry);
  return entry;
}
function fullIndexFirstActive(params) {
  const entry = fullIndexFirst.get(`${params.session?.id}:${params.fileIndex}`);
  return Boolean(entry && !entry.gaveUp && !entry.playerUsesSections);
}
function giveUpFullIndexFirst(entry, params) {
  entry.gaveUp = true;
  resumeStoppedSections(entry, params);
}
// The section cache skips sections it already has, so this continues where it stopped.
function resumeStoppedSections(entry, params) {
  if (!entry.stopped) return;
  entry.stopped = false;
  for (const [key, value] of progressiveStarts) if (value.sessionId === params.session?.id) progressiveStarts.delete(key);
  const inputPath = localVerifiedTorrentInputPath(params.session, params.fileIndex);
  if (inputPath) void progressiveIndexCache.start({ ...params, inputPath });
}
function emitProgressiveReady(event) {
  const clients = progressiveReadyListeners.get(event?.identityKey);
  if (!clients?.size) return;
  const payload = `event: ready\ndata: ${JSON.stringify({id:event.id})}\n\n`;
  for (const entry of [...clients]) {
    try {
      if (entry.res.destroyed || entry.res.writableEnded) clients.delete(entry);
      else entry.res.write(payload);
    } catch { clients.delete(entry); }
  }
  if (!clients.size) progressiveReadyListeners.delete(event.identityKey);
}
function closeProgressiveReadyListeners(sessionId = null) {
  for (const [key, clients] of progressiveReadyListeners) {
    for (const entry of [...clients]) {
      if (sessionId && entry.sessionId !== sessionId) continue;
      clients.delete(entry);
      if (!entry.res.destroyed && !entry.res.writableEnded) entry.res.end();
    }
    if (!clients.size) progressiveReadyListeners.delete(key);
  }
}
const progressiveVerifiedSource = createProgressiveVerifiedSource({
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
const progressiveIndexCache = createProgressiveIndexCache({
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
let kuroshiroPromise = null;

torrentClient.on("error", (error) => {
  console.error("WebTorrent client error:", error);
});

function json(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

function methodNotAllowed(res, allowed) {
  json(res, 405, { error: "Method not allowed" }, { Allow: allowed.join(", ") });
  return true;
}

function validBrowserCoachInstanceId(value) {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{8,120}$/.test(value);
}

function browserCoachVersionCompatible(version) {
  return !BROWSER_COACH_EXTENSION_VERSION || String(version || "") === BROWSER_COACH_EXTENSION_VERSION;
}

function rejectBrowserCoachVersionMismatch(res, version) {
  if (browserCoachVersionCompatible(version)) return false;
  json(res, 426, {
    error: "extension_version_mismatch",
    message: `Reload the Language Coach extension. Expected ${BROWSER_COACH_EXTENSION_VERSION}, received ${String(version || "unknown")}.`,
    expectedExtensionVersion: BROWSER_COACH_EXTENSION_VERSION,
    extensionVersion: String(version || "") || null,
  });
  return true;
}

function browserCoachInstanceCompatible(instanceId = null) {
  if (validBrowserCoachInstanceId(instanceId)) {
    const instance = browserCoachInstances.get(instanceId);
    return Boolean(instance && browserCoachVersionCompatible(instance.version));
  }
  if ([...browserCoachInstances.values()].some((instance) =>
    Date.now() - Number(instance?.lastSeenAt || 0) <= BROWSER_COACH_PRESENCE_MS && browserCoachVersionCompatible(instance?.version))) return true;
  return browserCoachVersionCompatible(browserCoachExtension.version);
}

function browserCoachPresent(instanceId = null) {
  if (validBrowserCoachInstanceId(instanceId)) {
    const instance = browserCoachInstances.get(instanceId);
    return Date.now() - Number(instance?.lastSeenAt || 0) <= BROWSER_COACH_PRESENCE_MS;
  }
  if ([...browserCoachInstances.values()].some((instance) => Date.now() - Number(instance?.lastSeenAt || 0) <= BROWSER_COACH_PRESENCE_MS)) return true;
  return Date.now() - Number(browserCoachExtension.lastSeenAt || 0) <= BROWSER_COACH_PRESENCE_MS;
}

function browserCoachAuthorised(req) {
  const auth = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
  return auth === `Bearer ${browserCoachToken}`;
}

function touchBrowserCoach(req, version = null, instanceId = null) {
  browserCoachExtension.lastSeenAt = Date.now();
  browserCoachExtension.version = version || browserCoachExtension.version;
  browserCoachExtension.origin = typeof req.headers.origin === "string" ? req.headers.origin : browserCoachExtension.origin;
  if (validBrowserCoachInstanceId(instanceId)) {
    const previous = browserCoachInstances.get(instanceId) || {};
    browserCoachInstances.set(instanceId, {
      lastSeenAt: Date.now(),
      version: version || previous.version || null,
      origin: typeof req.headers.origin === "string" ? req.headers.origin : previous.origin || null,
    });
  }
}

function cleanBrowserCoachRequests() {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [id, request] of browserCoachRequests) {
    if (request.createdAt < cutoff) {
      clearTimeout(request.timer);
      request.reject(Object.assign(new Error("The browser coach request expired."), { statusCode: 504 }));
      browserCoachRequests.delete(id);
    }
  }
}

async function browserCoachPair(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";
  if (origin && !origin.startsWith("chrome-extension://") && !origin.startsWith("moz-extension://")) {
    json(res, 403, { error: "Browser extension pairing is only available to extension contexts." });
    return true;
  }
  const body = await readJsonBody(req);
  if (body.client !== BROWSER_COACH_CLIENT) {
    json(res, 403, { error: "Unknown browser coach client." });
    return true;
  }
  const instanceId = validBrowserCoachInstanceId(body.instanceId) ? body.instanceId : null;
  const version = typeof body.version === "string" ? body.version.slice(0, 40) : null;
  touchBrowserCoach(req, version, instanceId);
  if (rejectBrowserCoachVersionMismatch(res, version)) return true;
  json(res, 200, { token: browserCoachToken, heartbeatMs: 2000, protocol: 1, instanceId });
  return true;
}

async function browserCoachPoll(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  if (!browserCoachAuthorised(req)) {
    json(res, 401, { error: "unauthorised" });
    return true;
  }
  const body = await readJsonBody(req);
  const instanceId = validBrowserCoachInstanceId(body.instanceId) ? body.instanceId : null;
  const version = typeof body.version === "string" ? body.version.slice(0, 40) : null;
  touchBrowserCoach(req, version, instanceId);
  if (rejectBrowserCoachVersionMismatch(res, version)) return true;
  cleanBrowserCoachRequests();
  const now = Date.now();
  const next = [...browserCoachRequests.values()]
    .sort((a, b) => a.createdAt - b.createdAt)
    .find((entry) => (!entry.instanceId || entry.instanceId === instanceId) && (!entry.claimedAt || now - entry.claimedAt > 15_000));
  if (!next) {
    json(res, 200, { request: null });
    return true;
  }
  next.claimedAt = now;
  next.attempts += 1;
  json(res, 200, {
    request: {
      id: next.id,
      prompt: next.prompt,
      conversationId: next.conversationId,
      completionMode: next.completionMode,
      attempt: next.attempts,
    },
  });
  return true;
}

async function browserCoachResult(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  if (!browserCoachAuthorised(req)) {
    json(res, 401, { error: "unauthorised" });
    return true;
  }
  const body = await readJsonBody(req);
  const instanceId = validBrowserCoachInstanceId(body.instanceId) ? body.instanceId : null;
  const version = typeof body.version === "string" ? body.version.slice(0, 40) : null;
  touchBrowserCoach(req, version, instanceId);
  if (rejectBrowserCoachVersionMismatch(res, version)) return true;
  const id = typeof body.id === "string" ? body.id : "";
  const pending = browserCoachRequests.get(id);
  if (!pending) {
    json(res, 404, { error: "request_not_found" });
    return true;
  }
  if (pending.instanceId && pending.instanceId !== instanceId) {
    json(res, 409, { error: "wrong_browser_instance" });
    return true;
  }
  browserCoachRequests.delete(id);
  clearTimeout(pending.timer);
  if (body.error) {
    pending.reject(Object.assign(new Error(String(body.error).slice(0, 1000)), { statusCode: 503 }));
    json(res, 200, { ok: true });
    return true;
  }
  const text = typeof body.text === "string" ? body.text.trim().slice(0, 16_000) : "";
  if (!text) {
    pending.reject(Object.assign(new Error("The ChatGPT browser helper returned an empty response."), { statusCode: 503 }));
    json(res, 200, { ok: true });
    return true;
  }
  pending.resolve({
    text,
    conversationId: typeof body.conversationId === "string" ? body.conversationId.slice(0, 200) : null,
  });
  json(res, 200, { ok: true });
  return true;
}

async function browserCoachLiveTranscript(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  if (!browserCoachAuthorised(req)) {
    json(res, 401, { error: "unauthorised" });
    return true;
  }
  const body = await readJsonBody(req);
  const instanceId = validBrowserCoachInstanceId(body.instanceId) ? body.instanceId : null;
  const version = typeof body.version === "string" ? body.version.slice(0, 40) : null;
  touchBrowserCoach(req, version, instanceId);
  if (rejectBrowserCoachVersionMismatch(res, version)) return true;
  const chatId = typeof body.chatId === "string" && /^[0-9a-f-]{20,64}$/i.test(body.chatId)
    ? body.chatId
    : null;
  const conversationId = typeof body.conversationId === "string" && /^[0-9a-f-]{8,64}$/i.test(body.conversationId)
    ? body.conversationId
    : null;
  const entries = Array.isArray(body.entries) ? body.entries.slice(0, 20).map((entry) => ({
    id: String(entry?.id || "").slice(0, 200),
    role: entry?.role === "assistant" ? "assistant" : entry?.role === "user" ? "user" : "",
    text: String(entry?.text || "").trim().slice(0, 4000),
  })).filter((entry) => entry.id && entry.role && entry.text) : [];
  if (!chatId || !conversationId || !entries.length) {
    json(res, 400, { error: "A valid live transcript batch is required." });
    return true;
  }

  cleanVoiceCoachSessions();
  const session = [...voiceCoachSessions.values()].find((candidate) =>
    candidate?.chatId === chatId && candidate?.nativeVoice === true && candidate?.conversationId === conversationId,
  );
  if (!session) {
    json(res, 409, { error: "live_session_not_found" });
    return true;
  }
  if (session.providerInstanceId && instanceId && session.providerInstanceId !== instanceId) {
    json(res, 409, { error: "wrong_browser_instance" });
    return true;
  }
  if (!session.providerInstanceId && instanceId) session.providerInstanceId = instanceId;

  const now = Date.now();
  session.updatedAt = now;
  persistVoiceCoachSessions();
  const usage = appDatabase.readSection("coachUsage") || { segments: [], active: null };
  if (usage.active?.chatId === chatId && usage.active?.conversationId === conversationId) {
    usage.active.updatedAt = now;
    appDatabase.writeSection("coachUsage", usage);
  }
  const transcripts = appDatabase.readSection("coachTranscripts") || [];
  const previous = transcripts.find((transcript) => transcript?.id === chatId) || null;
  const incomingMessages = entries.map((entry, index) => ({
    role: entry.role,
    mode: "live",
    text: entry.text,
    targetText: entry.role === "assistant" ? entry.text : "",
    romanized: "",
    baseText: "",
    providerEntryId: entry.id,
    createdAt: now + index,
  }));
  const nextTranscript = {
    ...(previous || {}),
    id: chatId,
    mode: "live",
    providerId: session.providerId || DEFAULT_COACH_PROVIDER_ID,
    providerInstanceId: session.providerInstanceId || instanceId || "",
    conversationId,
    targetLanguage: session.targetLanguage || previous?.targetLanguage || "EN",
    baseLanguage: session.baseLanguage || previous?.baseLanguage || "EN",
    presetId: session.presetId || previous?.presetId || "",
    presetLabel: session.presetLabel || previous?.presetLabel || "",
    messages: [...(Array.isArray(previous?.messages) ? previous.messages : []), ...incomingMessages],
    updatedAt: now,
  };
  appDatabase.writeSection("coachTranscripts", [
    ...transcripts.filter((transcript) => transcript?.id !== chatId),
    nextTranscript,
  ]);
  json(res, 200, { ok: true, persisted: entries.length, chatId, conversationId });
  return true;
}

function coachUsagePayload(now = Date.now()) {
  const usage = appDatabase.readSection("coachUsage") || { segments: [], active: null };
  if (usage.active && now - Number(usage.active.updatedAt || usage.active.startedAt || 0) > VOICE_USAGE_ACTIVE_STALE_MS) {
    const confirmedEndAt = Math.max(Number(usage.active.startedAt) || 0, Number(usage.active.updatedAt) || 0);
    if (confirmedEndAt > Number(usage.active.startedAt || 0)) {
      usage.segments = [...(Array.isArray(usage.segments) ? usage.segments : []), {
        startAt: Number(usage.active.startedAt),
        endAt: confirmedEndAt,
      }];
    }
    usage.active = null;
    appDatabase.writeSection("coachUsage", usage);
  }
  const windowStart = now - VOICE_USAGE_WINDOW_MS;
  const completedMs = (Array.isArray(usage.segments) ? usage.segments : []).reduce((total, segment) => {
    const startAt = Math.max(Number(segment?.startAt) || 0, windowStart);
    const endAt = Math.min(Number(segment?.endAt) || 0, now);
    return endAt > startAt ? total + (endAt - startAt) : total;
  }, 0);
  const activeStart = usage.active?.startedAt ? Math.max(Number(usage.active.startedAt) || 0, windowStart) : 0;
  const activeMs = activeStart > 0 && now > activeStart ? now - activeStart : 0;
  const usedMs = Math.max(0, completedMs + activeMs);
  return {
    windowMs: VOICE_USAGE_WINDOW_MS,
    limitMs: VOICE_USAGE_REFERENCE_LIMIT_MS,
    usedMs,
    remainingMs: Math.max(0, VOICE_USAGE_REFERENCE_LIMIT_MS - usedMs),
    active: usage.active || null,
    asOf: now,
  };
}

async function coachUsageEndpoint(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") return methodNotAllowed(res, ["GET", "HEAD"]);
  json(res, 200, coachUsagePayload());
  return true;
}

async function browserCoachLiveControl(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  if (!browserCoachAuthorised(req)) {
    json(res, 401, { error: "unauthorised" });
    return true;
  }
  const body = await readJsonBody(req);
  const instanceId = validBrowserCoachInstanceId(body.instanceId) ? body.instanceId : null;
  const version = typeof body.version === "string" ? body.version.slice(0, 40) : null;
  touchBrowserCoach(req, version, instanceId);
  if (rejectBrowserCoachVersionMismatch(res, version)) return true;
  const action = body.action === "start" ? "start" : body.action === "stop" ? "stop" : body.action === "touch" ? "touch" : "";
  const chatId = typeof body.chatId === "string" && /^[0-9a-f-]{20,64}$/i.test(body.chatId) ? body.chatId : null;
  const conversationId = typeof body.conversationId === "string" && /^[0-9a-f-]{8,64}$/i.test(body.conversationId)
    ? body.conversationId
    : null;
  if (!action || !chatId || !conversationId) {
    json(res, 400, { error: "A valid Live Voice control event is required." });
    return true;
  }

  const now = Date.now();
  const usage = appDatabase.readSection("coachUsage") || { segments: [], active: null };
  const segments = Array.isArray(usage.segments) ? [...usage.segments] : [];
  let active = usage.active || null;
  if (action === "start" || action === "touch") {
    cleanVoiceCoachSessions();
    const session = [...voiceCoachSessions.values()].find((candidate) =>
      candidate?.chatId === chatId && candidate?.nativeVoice === true && candidate?.conversationId === conversationId,
    );
    if (!session) {
      json(res, 409, { error: "live_session_not_found" });
      return true;
    }
    if (session.providerInstanceId && instanceId && session.providerInstanceId !== instanceId) {
      json(res, 409, { error: "wrong_browser_instance" });
      return true;
    }
    if (!session.providerInstanceId && instanceId) session.providerInstanceId = instanceId;
    session.updatedAt = now;
    persistVoiceCoachSessions();
    if (action === "start" && active && (active.chatId !== chatId || active.conversationId !== conversationId)) {
      const previousStart = Number(active.startedAt) || 0;
      if (previousStart > 0 && now > previousStart) segments.push({ startAt: previousStart, endAt: now });
      active = null;
    }
    if (!active && action === "start") {
      active = {
        chatId,
        conversationId,
        providerId: session.providerId || DEFAULT_COACH_PROVIDER_ID,
        providerInstanceId: session.providerInstanceId || instanceId || "",
        startedAt: now,
        updatedAt: now,
      };
    } else if (active?.chatId === chatId && active?.conversationId === conversationId) {
      active.updatedAt = now;
    } else if (action === "touch") {
      // A confirmed provider heartbeat after an app/server reload can arrive before the
      // local app replays its start state. Resume accounting from this confirmation rather
      // than leaving the timer permanently inactive.
      active = {
        chatId,
        conversationId,
        providerId: session.providerId || DEFAULT_COACH_PROVIDER_ID,
        providerInstanceId: session.providerInstanceId || instanceId || "",
        startedAt: now,
        updatedAt: now,
      };
    }
  } else if (active?.chatId === chatId && active?.conversationId === conversationId) {
    const startedAt = Number(active.startedAt) || 0;
    if (startedAt > 0 && now > startedAt) segments.push({ startAt: startedAt, endAt: now });
    active = null;
  }
  appDatabase.writeSection("coachUsage", { segments, active });
  json(res, 200, { ok: true, action, usage: coachUsagePayload(now) });
  return true;
}

async function browserCoachStatus(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") return methodNotAllowed(res, ["GET", "HEAD"]);
  const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  const requestedInstanceId = validBrowserCoachInstanceId(url.searchParams.get("instanceId")) ? url.searchParams.get("instanceId") : null;
  const instance = requestedInstanceId ? browserCoachInstances.get(requestedInstanceId) : null;
  const activeInstances = [...browserCoachInstances.entries()]
    .filter(([, entry]) => Date.now() - Number(entry?.lastSeenAt || 0) <= BROWSER_COACH_PRESENCE_MS)
    .map(([instanceId, entry]) => ({
      instanceId,
      version: entry?.version || null,
      lastSeenAt: entry?.lastSeenAt || null,
    }));
  json(res, 200, {
    available: browserCoachPresent(requestedInstanceId),
    extensionVersion: instance?.version || browserCoachExtension.version,
    expectedExtensionVersion: BROWSER_COACH_EXTENSION_VERSION || null,
    lastSeenAt: instance?.lastSeenAt || browserCoachExtension.lastSeenAt || null,
    instanceId: requestedInstanceId,
    activeInstances,
    extensionPath: BROWSER_COACH_EXTENSION_DIR,
    transport: "signed-in-chatgpt-browser",
    authMode: "existing-browser-session",
    credentialsRequired: [],
  });
  return true;
}

async function openBrowserCoachExtensionFolder(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  if (!fs.existsSync(BROWSER_COACH_EXTENSION_DIR)) {
    throw Object.assign(new Error("The browser coach extension has not been built yet."), { statusCode: 503 });
  }
  const body = await readJsonBody(req).catch(() => ({}));
  const command = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(command, [BROWSER_COACH_EXTENSION_DIR], { detached: true, stdio: "ignore", windowsHide: false });
  child.unref();
  let extensionsPageOpened = false;
  if (process.platform === "win32") {
    const requested = ["edge", "chrome", "brave"].includes(body.browser) ? body.browser : null;
    const candidates = requested === "edge"
      ? [
          path.join(process.env["ProgramFiles(x86)"] || "", "Microsoft", "Edge", "Application", "msedge.exe"),
          path.join(process.env.ProgramFiles || "", "Microsoft", "Edge", "Application", "msedge.exe"),
        ]
      : requested === "chrome"
        ? [
            path.join(process.env.ProgramFiles || "", "Google", "Chrome", "Application", "chrome.exe"),
            path.join(process.env["ProgramFiles(x86)"] || "", "Google", "Chrome", "Application", "chrome.exe"),
            path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
          ]
        : requested === "brave"
          ? [
              path.join(process.env.ProgramFiles || "", "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
              path.join(process.env["ProgramFiles(x86)"] || "", "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
              path.join(process.env.LOCALAPPDATA || "", "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
            ]
        : [];
    const executable = candidates.find((candidate) => candidate && fs.existsSync(candidate));
    if (executable) {
      const url = requested === "edge" ? "edge://extensions/" : requested === "brave" ? "brave://extensions/" : "chrome://extensions/";
      const browser = spawn(executable, [url], { detached: true, stdio: "ignore", windowsHide: false });
      browser.unref();
      extensionsPageOpened = true;
    }
  }
  json(res, 200, { opened: true, extensionsPageOpened, path: BROWSER_COACH_EXTENSION_DIR });
  return true;
}

async function extensionBrowserCoachDecision(prompt, conversationId = null, completionMode = "text", instanceId = null) {
  if (browserCoachPresent(instanceId) && !browserCoachInstanceCompatible(instanceId)) {
    throw Object.assign(new Error(`Language Coach extension version mismatch. Reload the unpacked extension; expected ${BROWSER_COACH_EXTENSION_VERSION}.`), { statusCode: 426 });
  }
  if (!browserCoachPresent(instanceId)) {
    // After a local server restart the MV3 worker can still be asleep until its next
    // scheduled wake-up. Give it a short grace period to re-pair instead of rejecting
    // the learner's first turn even though the extension is installed and healthy.
    const wakeDeadline = Date.now() + 35_000;
    while (!browserCoachPresent(instanceId) && Date.now() < wakeDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!browserCoachPresent(instanceId)) {
      throw Object.assign(new Error("Language Coach browser extension is not connected in this app browser. Load the extension in the same browser that is running the app and keep ChatGPT signed in there."), { statusCode: 503 });
    }
  }
  if (!browserCoachInstanceCompatible(instanceId)) {
    throw Object.assign(new Error(`Language Coach extension version mismatch. Reload the unpacked extension; expected ${BROWSER_COACH_EXTENSION_VERSION}.`), { statusCode: 426 });
  }
  cleanBrowserCoachRequests();
  const id = crypto.randomUUID();
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      browserCoachRequests.delete(id);
      reject(Object.assign(new Error("ChatGPT browser helper timed out."), { statusCode: 504 }));
    }, BROWSER_COACH_REQUEST_TIMEOUT_MS);
    browserCoachRequests.set(id, {
      id,
      prompt: String(prompt || "").slice(0, 16_000),
      conversationId: typeof conversationId === "string" ? conversationId.slice(0, 200) : null,
      completionMode: completionMode === "voice-json" ? "voice-json" : "text",
      instanceId: validBrowserCoachInstanceId(instanceId) ? instanceId : null,
      createdAt: Date.now(),
      claimedAt: 0,
      attempts: 0,
      timer,
      resolve,
      reject,
    });
  });
}

async function browserCoachDecision(prompt, conversationId = null, completionMode = "text", instanceId = null) {
  const result = await extensionBrowserCoachDecision(prompt, conversationId, completionMode, instanceId);
  return { ...result, transport: "signed-in-chatgpt-browser" };
}

async function browserCoachDecisionEndpoint(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  const body = await readJsonBody(req);
  const prompt = String(body.prompt || "").trim().slice(0, 16_000);
  if (!prompt) throw Object.assign(new Error("The language-coach prompt is empty."), { statusCode: 400 });
  const conversationId = typeof body.conversationId === "string" ? body.conversationId.slice(0, 200) : null;
  const instanceId = validBrowserCoachInstanceId(body.instanceId) ? body.instanceId : null;
  const result = await browserCoachDecision(prompt, conversationId, "text", instanceId);
  json(res, 200, result);
  return true;
}

function cleanVoiceCoachSessions() {
  const cutoff = Date.now() - COACH_LIVE_IDLE_TIMEOUT_MS;
  let changed = false;
  for (const [id, session] of voiceCoachSessions) {
    if (Number(session.updatedAt || 0) <= cutoff) {
      voiceCoachSessions.delete(id);
      changed = true;
    }
  }
  while (voiceCoachSessions.size > 24) {
    const oldest = [...voiceCoachSessions.entries()].sort((a, b) => Number(a[1]?.updatedAt || 0) - Number(b[1]?.updatedAt || 0))[0]?.[0];
    if (!oldest) break;
    voiceCoachSessions.delete(oldest);
    changed = true;
  }
  return changed;
}

function persistVoiceCoachSessions() {
  appDatabase.writeSection("coachSessions", [...voiceCoachSessions.values()].map((session) => ({
    chatId: session.chatId,
    mode: "live",
    providerId: session.providerId,
    providerInstanceId: session.providerInstanceId || "",
    conversationId: session.conversationId || null,
    targetLanguage: session.targetLanguage || "EN",
    baseLanguage: session.baseLanguage || "EN",
    targetLocale: normalizeLearningLocale(session.targetLanguage, session.targetLocale),
    baseLocale: normalizeLearningLocale(session.baseLanguage, session.baseLocale),
    liveSeeded: Boolean(session.liveSeeded),
    nativeVoice: Boolean(session.nativeVoice),
    presetId: session.presetId || "",
    presetLabel: session.presetLabel || "",
    presetContext: session.presetContext || "",
    assistanceMode: normalizeCoachAssistanceMode(session.assistanceMode),
    updatedAt: Number(session.updatedAt) || Date.now(),
  })));
}

function coachProviderPublic(provider) {
  return {
    id: provider.id,
    label: provider.label,
    kind: provider.kind,
    model: provider.model,
    transport: provider.transport,
    enabled: Boolean(provider.enabled),
    supports: { ...provider.supports },
  };
}

async function coachProvidersEndpoint(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") return methodNotAllowed(res, ["GET", "HEAD"]);
  json(res, 200, {
    defaultProviderId: DEFAULT_COACH_PROVIDER_ID,
    idleTimeoutMs: COACH_LIVE_IDLE_TIMEOUT_MS,
    providers: [...COACH_PROVIDERS.values()].map(coachProviderPublic),
  });
  return true;
}

async function coachLiveSessionStartEndpoint(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  const body = await readJsonBody(req);
  const chatId = typeof body.chatId === "string" && /^[0-9a-f-]{20,64}$/i.test(body.chatId)
    ? body.chatId
    : crypto.randomUUID();
  const providerId = String(body.providerId || DEFAULT_COACH_PROVIDER_ID).trim().slice(0, 80) || DEFAULT_COACH_PROVIDER_ID;
  const provider = COACH_PROVIDERS.get(providerId);
  if (!provider || !provider.enabled || !provider.supports?.liveVoice) {
    throw Object.assign(new Error(`Coach provider ${providerId} does not support native live voice.`), { statusCode: 400 });
  }
  if (provider.id !== "chatgpt-browser") {
    throw Object.assign(new Error(`Native live voice is not implemented for ${provider.id} yet.`), { statusCode: 501 });
  }
  const providerInstanceId = validBrowserCoachInstanceId(body.providerInstanceId) ? body.providerInstanceId : "";
  const targetLanguage = String(body.targetLanguage || "EN").toUpperCase().slice(0, 8);
  const baseLanguage = String(body.baseLanguage || "EN").toUpperCase().slice(0, 8);
  const requestedAssistanceMode = normalizeCoachAssistanceMode(body.assistanceMode);
  const targetLocale = normalizeLearningLocale(targetLanguage, body.targetLocale);
  const baseLocale = normalizeLearningLocale(baseLanguage, body.baseLocale);
  const requestedPreset = normalizeCoachLivePreset(body);
  cleanVoiceCoachSessions();
  const sessionKey = coachLiveSessionKey(chatId, true);
  const previous = voiceCoachSessions.get(sessionKey);
  const reusable = isReusableCoachLiveSession({
    session: previous,
    nativeVoice: true,
    providerId: provider.id,
    providerInstanceId,
    targetLanguage,
    baseLanguage,
    assistanceMode: requestedAssistanceMode,
    targetLocale,
    baseLocale,
  });
  let conversationId = reusable ? previous.conversationId : null;
  const sessionAssistanceMode = reusable
    ? normalizeCoachAssistanceMode(previous.assistanceMode)
    : requestedAssistanceMode;
  let sessionPreset = reusable
    ? {
        presetId: previous.presetId || "",
        presetLabel: previous.presetLabel || "",
        presetContext: previous.presetContext || "",
      }
    : requestedPreset;
  if (!conversationId) {
    const prompt = buildNativeLiveVoicePrompt({
      targetLanguage,
      baseLanguage,
      targetLocale,
      baseLocale,
      assistanceMode: sessionAssistanceMode,
      ...requestedPreset,
    });
    const result = await browserCoachDecision(prompt, null, "text", providerInstanceId || null);
    conversationId = result.conversationId || null;
    if (!conversationId) throw Object.assign(new Error("ChatGPT did not create a live coach conversation."), { statusCode: 503 });
    sessionPreset = requestedPreset;
  }
  voiceCoachSessions.set(sessionKey, {
    chatId,
    mode: "live",
    providerId: provider.id,
    providerInstanceId,
    conversationId,
    targetLanguage,
    baseLanguage,
    liveSeeded: true,
    nativeVoice: true,
    assistanceMode: sessionAssistanceMode,
    targetLocale,
    baseLocale,
    ...sessionPreset,
    updatedAt: Date.now(),
  });
  cleanVoiceCoachSessions();
  persistVoiceCoachSessions();
  json(res, 200, {
    chatId,
    mode: "live",
    idleTimeoutMs: COACH_LIVE_IDLE_TIMEOUT_MS,
    provider: coachProviderPublic(provider),
    session: { conversationId, reused: reusable, assistanceMode: sessionAssistanceMode },
  });
  return true;
}

async function coachLiveSessionCloseEndpoint(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  const body = await readJsonBody(req);
  const chatId = typeof body.chatId === "string" && /^[0-9a-f-]{20,64}$/i.test(body.chatId)
    ? body.chatId
    : null;
  if (!chatId) throw Object.assign(new Error("A valid live coach chatId is required."), { statusCode: 400 });
  const providerId = typeof body.providerId === "string" ? body.providerId.trim().slice(0, 80) : "";
  const providerInstanceId = typeof body.providerInstanceId === "string" ? body.providerInstanceId.trim().slice(0, 120) : "";
  const nativeVoiceFilter = typeof body.nativeVoice === "boolean" ? body.nativeVoice : null;
  cleanVoiceCoachSessions();
  let closed = false;
  for (const [key, session] of voiceCoachSessions) {
    if (session.chatId !== chatId) continue;
    if (providerId && session.providerId !== providerId) continue;
    if (providerInstanceId && String(session.providerInstanceId || "") !== providerInstanceId) continue;
    if (nativeVoiceFilter !== null && Boolean(session.nativeVoice) !== nativeVoiceFilter) continue;
    voiceCoachSessions.delete(key);
    closed = true;
  }
  persistVoiceCoachSessions();
  json(res, 200, { ok: true, chatId, closed });
  return true;
}

async function coachLiveSessionTouchEndpoint(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  const body = await readJsonBody(req);
  const chatId = typeof body.chatId === "string" && /^[0-9a-f-]{20,64}$/i.test(body.chatId)
    ? body.chatId
    : null;
  if (!chatId) throw Object.assign(new Error("A valid live coach chatId is required."), { statusCode: 400 });
  if (body.nativeVoice !== true) {
    throw Object.assign(new Error("Live session touch requires nativeVoice: true."), { statusCode: 400 });
  }
  const providerId = typeof body.providerId === "string" ? body.providerId.trim().slice(0, 80) : "";
  const providerInstanceId = typeof body.providerInstanceId === "string" ? body.providerInstanceId.trim().slice(0, 120) : "";
  const cleaned = cleanVoiceCoachSessions();
  const now = Date.now();
  let touched = false;
  for (const session of voiceCoachSessions.values()) {
    if (session.chatId !== chatId || session.mode !== "live" || session.nativeVoice !== true) continue;
    if (providerId && session.providerId !== providerId) continue;
    if (providerInstanceId && String(session.providerInstanceId || "") !== providerInstanceId) continue;
    session.updatedAt = now;
    touched = true;
  }
  if (cleaned || touched) persistVoiceCoachSessions();
  json(res, 200, { ok: true, touched, idleTimeoutMs: COACH_LIVE_IDLE_TIMEOUT_MS });
  return true;
}

async function coachLiveTranscriptEnrichEndpoint(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  const body = await readJsonBody(req);
  const providerId = String(body.providerId || DEFAULT_COACH_PROVIDER_ID).trim().slice(0, 80) || DEFAULT_COACH_PROVIDER_ID;
  const provider = COACH_PROVIDERS.get(providerId);
  if (!provider || !provider.enabled) {
    throw Object.assign(new Error(`Unknown or unavailable coach provider: ${providerId}`), { statusCode: 400 });
  }
  if (provider.id !== "chatgpt-browser") {
    throw Object.assign(new Error(`Transcript enrichment is not implemented for ${provider.id} yet.`), { statusCode: 501 });
  }
  const items = Array.isArray(body.items) ? body.items.slice(0, 40).map((item) => ({
    id: String(item?.id || "").slice(0, 200),
    text: String(item?.text || "").slice(0, 4000),
  })).filter((item) => item.id && item.text) : [];
  if (!items.length) throw Object.assign(new Error("No live transcript items were supplied."), { statusCode: 400 });
  const targetLanguage = String(body.targetLanguage || "EN").toUpperCase().slice(0, 8);
  const baseLanguage = String(body.baseLanguage || "EN").toUpperCase().slice(0, 8);
  const providerInstanceId = validBrowserCoachInstanceId(body.providerInstanceId) ? body.providerInstanceId : null;
  const prompt = buildLiveTranscriptEnrichmentPrompt({ targetLanguage, baseLanguage, items });
  const result = await browserCoachDecision(prompt, null, "text", providerInstanceId);
  const raw = String(result.text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  let parsed;
  try {
    parsed = JSON.parse(start >= 0 && end > start ? raw.slice(start, end + 1) : raw);
  } catch {
    throw Object.assign(new Error("The coach provider returned invalid transcript enrichment JSON."), { statusCode: 503 });
  }
  const allowedIds = new Set(items.map((item) => item.id));
  const enriched = (Array.isArray(parsed?.items) ? parsed.items : []).slice(0, 40).map((item) => ({
    id: String(item?.id || "").slice(0, 200),
    targetText: String(item?.targetText || "").slice(0, 4000),
    romanized: String(item?.romanized || "").slice(0, 4000),
    baseText: String(item?.baseText || "").slice(0, 4000),
  })).filter((item) => allowedIds.has(item.id));
  json(res, 200, { provider: coachProviderPublic(provider), items: enriched });
  return true;
}

function appStatePayload() {
  return {
    schemaVersion: appDatabase.schemaVersion(),
    initialized: appDatabase.isCoreInitialized(),
    databasePath: appDatabase.path,
    state: appDatabase.readAll(),
    revisions: Object.fromEntries(APP_STATE_SECTIONS.map((section) => [section, appDatabase.sectionUpdatedAt(section)])),
  };
}

async function appStateBootstrapEndpoint(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  const body = await readJsonBody(req, MAX_APP_STATE_BODY_BYTES);
  const legacyState = body?.legacyState && typeof body.legacyState === "object" && !Array.isArray(body.legacyState)
    ? body.legacyState
    : null;
  // Bootstrap migration is only for an *uninitialized* database. A different
  // browser profile can still have old localStorage with a removed Library
  // title; merging it into the already-initialized shared SQLite database
  // would resurrect deletions in the app window.
  if (legacyState && !appDatabase.isCoreInitialized()) appDatabase.mergeLegacyState(legacyState);
  json(res, 200, appStatePayload());
  return true;
}

async function appStateEndpoint(req, res, url) {
  if (url.pathname === "/api/app-state") {
    if (req.method !== "GET" && req.method !== "HEAD") return methodNotAllowed(res, ["GET", "HEAD"]);
    json(res, 200, appStatePayload());
    return true;
  }
  const match = /^\/api\/app-state\/([A-Za-z][A-Za-z0-9]*)$/.exec(url.pathname);
  if (!match) return false;
  const section = match[1];
  if (!APP_STATE_SECTIONS.includes(section)) {
    json(res, 404, { error: "Unknown app-state section" });
    return true;
  }
  if (req.method === "GET" || req.method === "HEAD") {
    json(res, 200, {
      section,
      value: appDatabase.readSection(section) ?? null,
      updatedAt: appDatabase.sectionUpdatedAt(section),
    });
    return true;
  }
  if (req.method !== "PUT" && req.method !== "POST") return methodNotAllowed(res, ["GET", "PUT", "POST"]);
  const body = await readJsonBody(req, MAX_APP_STATE_BODY_BYTES);
  if (!("value" in body)) {
    json(res, 400, { error: "App-state update requires a value" });
    return true;
  }
  const merge = body.merge === true;
  if (!merge && APP_STATE_CAS_SECTIONS.has(section)) {
    if (body.expectedUpdatedAt == null) {
      json(res, 428, {
        error: "app_state_revision_required",
        message: `Persistent ${section} replacement requires the current section revision.`,
        section,
        currentUpdatedAt: appDatabase.sectionUpdatedAt(section),
      });
      return true;
    }
    const rawExpectedUpdatedAt = Number(body.expectedUpdatedAt);
    if (!Number.isFinite(rawExpectedUpdatedAt) || rawExpectedUpdatedAt < 0) {
      json(res, 400, { error: "Invalid app-state section revision", section });
      return true;
    }
    const expectedUpdatedAt = Math.floor(rawExpectedUpdatedAt);
    const result = appDatabase.compareAndSwapSection(section, body.value, expectedUpdatedAt);
    if (!result.ok) {
      json(res, 409, {
        error: "app_state_conflict",
        message: `Persistent ${section} changed in another app session.`,
        section,
        expectedUpdatedAt,
        currentUpdatedAt: result.currentUpdatedAt,
      });
      return true;
    }
    json(res, 200, { ok: true, section, updatedAt: result.updatedAt });
    return true;
  }
  const updatedAt = merge && typeof appDatabase.mergeSection === "function"
    ? appDatabase.mergeSection(section, body.value)
    : appDatabase.writeSection(section, body.value);
  json(res, 200, { ok: true, section, updatedAt });
  return true;
}

async function runCoachProvider(turn, previous = null) {
  const provider = COACH_PROVIDERS.get(turn.providerId);
  if (!provider || !provider.enabled) {
    throw Object.assign(new Error(`Unknown or unavailable coach provider: ${turn.providerId}`), { statusCode: 400 });
  }
  if (provider.id !== "chatgpt-browser") {
    throw Object.assign(new Error(`Coach provider ${provider.id} is not implemented yet.`), { statusCode: 501 });
  }
  const continuingLiveSession = turn.mode === "live" && isReusableCoachLiveSession({
    session: previous,
    nativeVoice: false,
    providerId: provider.id,
    providerInstanceId: turn.providerInstanceId || "",
    targetLanguage: turn.languages.target,
    baseLanguage: turn.languages.base,
    targetLocale: turn.locales.target,
    baseLocale: turn.locales.base,
  });
  const prompt = buildVoiceCoachPrompt(turn, { continuation: continuingLiveSession });
  const conversationId = continuingLiveSession ? previous.conversationId : null;
  let result = await browserCoachDecision(prompt, conversationId || null, "voice-json", turn.providerInstanceId || null);
  let normalized = normalizeCoachTurnOutput({
    turn,
    provider,
    rawText: result.text,
    conversationId: result.conversationId || conversationId || null,
    transport: result.transport || provider.transport,
    continued: continuingLiveSession,
  });
  if (turn.mode === "practice" && coachOutputMissingRequiredFields(turn, normalized.output)) {
    const repairPrompt = buildVoiceCoachRepairPrompt(turn, result.text);
    const repair = await browserCoachDecision(
      repairPrompt,
      result.conversationId || conversationId || null,
      "voice-json",
      turn.providerInstanceId || null,
    );
    result = repair;
    normalized = normalizeCoachTurnOutput({
      turn,
      provider,
      rawText: repair.text,
      conversationId: repair.conversationId || conversationId || null,
      transport: repair.transport || provider.transport,
      continued: true,
    });
    if (coachOutputMissingRequiredFields(turn, normalized.output)) {
      throw Object.assign(new Error("The coach response was missing required target, romaji, or base-language fields after one repair attempt."), { statusCode: 502 });
    }
  }
  return normalized;
}

async function processCoachVoiceTurn(body) {
  const turn = normalizeCoachTurnInput(body, DEFAULT_COACH_PROVIDER_ID);
  if (!turn.chatId) turn.chatId = crypto.randomUUID();
  if (!turn.input.transcript) throw Object.assign(new Error("No learner input transcript was provided."), { statusCode: 400 });
  cleanVoiceCoachSessions();
  const sessionKey = coachLiveSessionKey(turn.chatId, false);
  const previous = turn.mode === "live" ? voiceCoachSessions.get(sessionKey) : null;
  const normalized = await runCoachProvider(turn, previous);
  if (turn.mode === "live") {
    voiceCoachSessions.set(sessionKey, {
      chatId: turn.chatId,
      mode: "live",
      providerId: normalized.provider.id,
      providerInstanceId: turn.providerInstanceId || "",
      conversationId: normalized.session.conversationId || null,
      targetLanguage: turn.languages.target,
      baseLanguage: turn.languages.base,
      targetLocale: turn.locales.target,
      baseLocale: turn.locales.base,
      liveSeeded: true,
      nativeVoice: false,
      updatedAt: Date.now(),
    });
    cleanVoiceCoachSessions();
    persistVoiceCoachSessions();
  }
  return normalized;
}

async function coachVoiceTurnEndpoint(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  const normalized = await processCoachVoiceTurn(await readJsonBody(req));
  json(res, 200, normalized);
  return true;
}

async function browserVoiceCorrection(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  const normalized = await processCoachVoiceTurn(await readJsonBody(req));
  // Compatibility response for older app builds. New clients should use /api/coach/voice-turn.
  json(res, 200, {
    chatId: normalized.chatId,
    ...normalized.output,
    provider: normalized.provider,
    transport: normalized.provider.transport,
    acousticScoring: normalized.capabilities.acousticScoring,
  });
  return true;
}

async function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error("Request body too large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Invalid JSON body");
    error.statusCode = 400;
    throw error;
  }
}

function getSubdlApiKey(req, body = {}) {
  const headerKey = req.headers["x-subdl-api-key"];
  const auth = req.headers.authorization;
  const bearerKey = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const bodyKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  const environmentKey = typeof process.env.SUBDL_API_KEY === "string" ? process.env.SUBDL_API_KEY.trim() : "";
  const key = (Array.isArray(headerKey) ? headerKey[0] : headerKey) || bearerKey || bodyKey || environmentKey;
  if (!key || key.length > 512) {
    const error = new Error("A SubDL API key is required in the app or SUBDL_API_KEY environment variable");
    error.statusCode = 401;
    throw error;
  }
  return key;
}

function optionalProviderKey(body, bodyField, environmentField) {
  const bodyKey = typeof body?.[bodyField] === "string" ? body[bodyField].trim() : "";
  const environmentKey = typeof process.env[environmentField] === "string" ? process.env[environmentField].trim() : "";
  const key = bodyKey || environmentKey;
  return key && key.length <= 512 ? key : "";
}

function pruneRemoteSubtitleDownloads() {
  const now = Date.now();
  for (const [token, record] of remoteSubtitleDownloads) {
    if (!record || record.expiresAt <= now) remoteSubtitleDownloads.delete(token);
  }
  while (remoteSubtitleDownloads.size > 300) remoteSubtitleDownloads.delete(remoteSubtitleDownloads.keys().next().value);
}

function isPrivateOrReservedIp(address) {
  const normalized = String(address || "").trim().toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  const family = net.isIP(normalized);
  if (family === 4) {
    const [a, b, c] = normalized.split(".").map(Number);
    return a === 0
      || a === 10
      || a === 127
      || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 0 && (c === 0 || c === 2))
      || (a === 192 && b === 168)
      || (a === 192 && b === 88 && c === 99)
      || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113);
  }
  if (family === 6) {
    return normalized.startsWith("::")
      || /^f[cd]/.test(normalized)
      || /^fe[89ab]/.test(normalized)
      || /^fe[c-f]/.test(normalized)
      || normalized.startsWith("ff")
      || normalized.startsWith("2001:db8:");
  }
  return false;
}

function parseRemoteSubtitleUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || "")); } catch { return null; }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || String(value).length > 2048) return null;
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || isPrivateOrReservedIp(hostname)) return null;
  return parsed;
}

async function assertPublicRemoteSubtitleTarget(url) {
  const parsed = parseRemoteSubtitleUrl(url);
  if (!parsed) throw Object.assign(new Error("Subtitle provider returned an unsafe download URL"), { statusCode: 502 });
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(hostname)) return parsed;
  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw Object.assign(new Error("Subtitle download host could not be resolved"), { statusCode: 502 });
  }
  if (!addresses.length || addresses.some((record) => isPrivateOrReservedIp(record.address))) {
    throw Object.assign(new Error("Subtitle download host resolved to a private or reserved address"), { statusCode: 502 });
  }
  return parsed;
}

async function fetchRemoteSubtitleDownload(remote) {
  const original = await assertPublicRemoteSubtitleTarget(remote.url);
  const originalOrigin = original.origin;
  let current = original;
  const signal = AbortSignal.timeout(15_000);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    current = await assertPublicRemoteSubtitleTarget(current);
    const response = await fetch(current, {
      headers: current.origin === originalOrigin ? remote.headers : {},
      redirect: "manual",
      signal,
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return { response, finalUrl: current };
    const location = response.headers.get("location");
    if (!location) return { response, finalUrl: current };
    if (redirects >= 3) {
      await response.body?.cancel().catch(() => {});
      throw Object.assign(new Error("Subtitle download redirected too many times"), { statusCode: 502 });
    }
    let next;
    try { next = new URL(location, current); } catch {
      await response.body?.cancel().catch(() => {});
      throw Object.assign(new Error("Subtitle provider returned an invalid redirect URL"), { statusCode: 502 });
    }
    await response.body?.cancel().catch(() => {});
    current = next;
  }
  throw Object.assign(new Error("Subtitle download redirected too many times"), { statusCode: 502 });
}

function registerRemoteSubtitleDownload({ url, headers = {}, label = "subtitle.srt", language = "", provider = "REMOTE" }) {
  const parsed = parseRemoteSubtitleUrl(url);
  if (!parsed) return null;
  pruneRemoteSubtitleDownloads();
  const token = crypto.randomBytes(18).toString("hex");
  remoteSubtitleDownloads.set(token, {
    url: parsed.toString(),
    headers: Object.fromEntries(Object.entries(headers).filter(([key, value]) => typeof key === "string" && typeof value === "string")),
    label: String(label || "subtitle.srt").slice(0, 500),
    language: normalizeSubtitleLanguage(language),
    provider: String(provider || "REMOTE").slice(0, 80),
    expiresAt: Date.now() + 20 * 60 * 1000,
  });
  return `remote:${token}`;
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

function safeTorrentRelativePath(value) {
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

async function removeTorrentSession(id) {
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

function scheduleSessionExpiry(session) {
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
function fileDownloadMap(session, fileIndex, buckets = 120) {
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

function sessionPayload(session) {
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

async function createTorrentSession(req, res) {
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

function getTorrentSession(id) {
  const session = torrentSessions.get(id);
  if (!session) return null;
  session.lastUsedAt = Date.now();
  scheduleSessionExpiry(session);
  return session;
}

// While a stream or conversion is open, the session counts as playing (never evicted for space).
function trackOpenStream(session, res, fileIndex = null) {
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
function rejectOversizeVideo(res, file) {
  const limit = storage.limits().playerBytes;
  if (Number(file?.length) <= limit) return false;
  json(res, 507, { error: `This video is ${(Number(file.length) / 1024 ** 3).toFixed(1)} GB, more than the ${Math.round(limit / 1024 ** 3)} GB of player storage. Raise the limit in Settings, Storage.`, code: "player_storage_too_small" });
  return true;
}

function parseRange(rangeHeader, length) {
  if (!rangeHeader) return null;
  const requested = rangeHeader.trim();
  // Multipart responses are not implemented. HTTP permits ignoring a valid
  // multiple-range request and returning the entire representation as 200.
  if (/^bytes=(?:\d+-\d*|-\d+)(?:\s*,\s*(?:\d+-\d*|-\d+))+$/i.test(requested)) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(requested);
  if (!match) return false;

  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return false;
    start = Math.max(0, length - suffix);
    end = length - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : length - 1;
  }

  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= length) return false;
  return { start, end: Math.min(end, length - 1) };
}

// WebTorrent's addUID:true store is NOT <session>/<file.path>. It writes
// <session>/<torrent.name> - <infohash8>/<file.path>. HTTP stream readers
// resolve this internally, but optional *local-only* FFmpeg index inputs must
// use the exact same physical path. Never fall back to a network reader here.
function localVerifiedTorrentInputPath(session, fileIndex) {
  const torrent=session?.torrent, file=torrent?.files?.[fileIndex];
  const relative=String(file?.path||file?.name||"");
  const hash=String(torrent?.infoHash||session?.infoHash||"").toLowerCase();
  if(!safeTorrentRelativePath(relative)||!/^[a-f0-9]{40}$/.test(hash)
    ||typeof session?.id!=="string"||!/^[a-f0-9-]{36}$/i.test(session.id))return null;
  const root=path.resolve(torrentRoot,session.id);
  const uid=torrent.addUID===true ? `${String(torrent.name||"")} - ${hash.slice(0,8)}` : "";
  if(uid&&!safeTorrentRelativePath(uid))return null;
  const input=path.resolve(root,uid,relative);
  return input.startsWith(root+path.sep)?input:null;
}

// Only a completed, verified, plan-matched indexed file may answer Range.
// Partials are not addressable. The browser never sees filesystem paths.
function equivalentIndexedAudioMode(media,audioIndex,audioMode) {
  // The finished MP4 is already exactly stereo when the selected track has
  // <=2 channels. Auto and Stereo yield identical AAC output in that case;
  // a mode-only cache-key difference must not hide an existing full-episode
  // indexed MP4 and send the player back into short progressive GOPs.
  const channels=Number(media?.audioTracks?.[audioIndex]?.channels);
  return audioMode === "auto" && Number.isSafeInteger(channels)
    && channels >= 1 && channels <= 2 ? "stereo" : audioMode;
}
async function serveIndexedSeek(req, res, session, fileIndex, url, statusOnly = false) {
  const file = session.torrent?.files?.[fileIndex];
  if (!file || !VIDEO_EXTENSIONS.has(path.extname(file.name).toLowerCase())) {
    json(res, 404, { error: "Video not found" }); return;
  }
  const audioIndex = Number(url.searchParams.get("audio") ?? 0);
  const audioMode = String(url.searchParams.get("audioMode") || "stereo");
  const media = getCachedMediaProbe(session.id, fileIndex);
  const params = { session, fileIndex, media, audioIndex,
    audioMode: equivalentIndexedAudioMode(media,audioIndex,audioMode) };
  let startFullIndex = statusOnly && req.method === "GET";
  const first = startFullIndex ? fullIndexFirstChoice(params) : null;
  if (first) {
    // The player sends sections=1 while it plays from prepared sections; then
    // it needs them to keep coming, and both jobs run side by side instead.
    first.playerUsesSections = url.searchParams.get("sections") === "1";
    const full = await indexedVideoCache.status(params, { start: false });
    if (full.status === "ready") {
      if (!first.readyLogged) {
        first.readyLogged = true;
        console.log(`Seek cache: whole episode seekable ${Math.round((Date.now() - first.since) / 1000)} s after the download finished`);
      }
    } else if (full.status !== "building" && Date.now() - first.since > FULL_INDEX_FIRST_GRACE_MS) {
      giveUpFullIndexFirst(first, params);
      console.log(`Seek cache: the whole-episode file didn't start (${full.status}; ${activeTranscodes.size} converters running, ${activeForegroundTranscodeCount()} for playback); preparing sections again`);
    } else if (first.playerUsesSections) {
      resumeStoppedSections(first, params);
    } else {
      // Free the converter slot the section job holds; its ready sections stay.
      if (!first.stopLogged) { first.stopLogged = true; console.log("Seek cache: download finished; making the whole episode seekable first"); }
      first.stopped = true;
      await progressiveIndexCache.stopSession(session.id);
    }
  }
  if (startFullIndex && !fullIndexFirstActive(params) && storage.limits().remuxCacheEnabled === true) {
    // SERVER-SIDE priority matters: merely ordering two async fetch() calls
    // in the browser cannot guarantee the progressive worker claims the spare
    // FFmpeg slot first. A full-episode builder can occupy that slot until
    // EOF and prevent the first early GOP from ever becoming seek-ready.
    const inputPath=localVerifiedTorrentInputPath(session,fileIndex);
    if (inputPath) {
      const progressiveParams = { ...params,
        inputPath };
      const progressive = await progressiveIndexCache.status(progressiveParams);
      if (progressive.status === "waiting" || progressive.status === "building"
        || progressive.status === "partial" && progressive.canContinue === true) {
        // The optional cache itself rechecks exact source identity, verified
        // pieces, local path and foreground slot admission before spawning.
        const admittedProgressive = startProgressiveWhenNewPieces(progressiveParams, progressive);
        // When the progressive producer has already CLAIMED one slot and no
        // foreground player uses the other slot, a full-index optimization
        // may run concurrently. Once a player appears the normal preemption
        // path cancels optional producers before admitting user playback.
        // Never let a full index race a progressive job while its first
        // verified GOP is still only `waiting` admission.
        startFullIndex = activeTranscodes.size < MAX_TRANSCODE_JOBS
          && (progressive.status === 'building'
            ? progressiveActiveProcesses.size > 0
            : !admittedProgressive);
        // A progressive attempt can fail before spawning its child (local
        // path, quota or FFprobe admission). Its same-source retry memo then
        // prevents CPU churn; it MUST NOT indefinitely block the older
        // complete-MP4 indexed optimization in this valid source/session.
      }
    }
  }
  // Never admit a third FFmpeg even if a stale index poll arrived after the
  // converter became busy. Existing ready manifests remain readable.
  if (activeTranscodes.size >= MAX_TRANSCODE_JOBS) startFullIndex = false;
  const state = await indexedVideoCache.status(params, { start: startFullIndex });
  if (statusOnly) {
    const headers = { "Cache-Control": "no-store" };
    json(res, 200, {
      status: state.status, bytes: state.bytes || 0,
      duration: state.duration || 0,
      ...(state.status === "ready" ? { url: `/api/torrents/${encodeURIComponent(session.id)}/files/${fileIndex}/indexed?audio=${audioIndex}&audioMode=${audioMode}` } : {}),
    }, headers);
    return;
  }
  if (state.status !== "ready") { json(res, 404, { error: "Indexed video is not ready", status: state.status }); return; }
  const saved = await indexedVideoCache.finished(state.info);
  if (!saved) { json(res, 404, { error: "Indexed video unavailable" }); return; }
  // Open the exact verified output BEFORE writing a 200/206 header. Storage
  // cleanup can remove a manifest/file between finished() and open(); if so,
  // return a recoverable 404 rather than a seemingly valid zero-byte video.
  let handle;
  try {
    handle = await fs.promises.open(saved.file, "r");
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== saved.bytes) throw new Error("Indexed rendition changed");
  } catch {
    await handle?.close().catch(() => {});
    if (!res.destroyed && !res.writableEnded) json(res, 404, { error: "Indexed video unavailable" });
    return;
  }
  if (res.destroyed || res.writableEnded) { await handle.close().catch(() => {}); return; }
  const range = req.method === "HEAD" ? null : parseRange(req.headers.range, saved.bytes);
  if (range === false) {
    await handle.close().catch(() => {});
    res.writeHead(416, { "Accept-Ranges": "bytes", "Content-Range": `bytes */${saved.bytes}` });
    res.end(); return;
  }
  const common = { "Content-Type": "video/mp4", "Accept-Ranges": "bytes",
    "Cache-Control": "no-store", "X-LVL-Indexed-Seek": "verified-h264-aac-v1",
    "X-Media-Duration-Seconds": String(saved.duration) };
  if (req.method === "HEAD") {
    await handle.close().catch(() => {});
    res.writeHead(200, { ...common, "Content-Length": saved.bytes }); res.end(); return;
  }
  const size = range ? range.end - range.start + 1 : saved.bytes;
  const stream = handle.createReadStream(range || undefined);
  stream.on("error", () => res.destroy());
  res.on("close", () => stream.destroy());
  trackOpenStream(session, res, fileIndex);
  res.writeHead(range ? 206 : 200, { ...common, "Content-Length": size,
    ...(range ? { "Content-Range": `bytes ${range.start}-${range.end}/${saved.bytes}` } : {}) });
  stream.pipe(res);
}

async function serveProgressiveSeek(req, res, session, fileIndex, url, statusOnly = false) {
  const file = session.torrent?.files?.[fileIndex];
  if (!file || !VIDEO_EXTENSIONS.has(path.extname(file.name).toLowerCase())) {
    json(res, 404, { error: "Video not found" }); return;
  }
  // An optional background conversion must never read via WebTorrent HTTP:
  // that would silently fetch missing torrent pieces. Both the source's
  // complete verified bitfield and the local path are independently checked
  // again by the cache before spawning FFmpeg and before publication.
  const inputPath=localVerifiedTorrentInputPath(session,fileIndex);
  if (!inputPath) {
    json(res, 404, { error: "Video path unavailable" }); return;
  }
  const audioIndex = Number(url.searchParams.get("audio") ?? 0);
  const audioMode = String(url.searchParams.get("audioMode") || "auto");
  const media = getCachedMediaProbe(session.id, fileIndex);
  const params = { session, fileIndex, audioIndex, audioMode, media,
    inputPath };
  if (url.pathname.endsWith('/progressive/events')) {
    const status = await progressiveIndexCache.status(params);
    if (req.method !== 'GET' || !status.identityKey
      || storage.limits().remuxCacheEnabled !== true) {
      json(res, 404, {error:'Progressive events unavailable'}); return;
    }
    const key = status.identityKey;
    let clients = progressiveReadyListeners.get(key);
    if (!clients) { clients = new Set(); progressiveReadyListeners.set(key,clients); }
    if (clients.size >= 8 || progressiveReadyListeners.size > 64) {
      json(res, 429, {error:'Too many active progressive viewers'}); return;
    }
    res.writeHead(200, {'Content-Type':'text/event-stream; charset=utf-8',
      'Cache-Control':'no-store', 'Connection':'keep-alive',
      'X-Content-Type-Options':'nosniff'});
    // An authenticated paused Watch may retain this notification connection
    // without an active video Range reader. Keep its torrent UUID alive while
    // this bounded EventSource is open; close releases the normal TTL lease.
    trackOpenStream(session,res,fileIndex);
    const entry={sessionId:session.id,res};
    clients.add(entry);
    res.write(': verified-sections\n\n');
    const remove=()=>{
      clients.delete(entry);
      if (!clients.size) progressiveReadyListeners.delete(key);
    };
    req.once('aborted',remove);
    res.once('close',remove);
    return;
  }
  if (statusOnly) {
    const status = await progressiveIndexCache.status(params);
    // HEAD must remain read-only; GET explicitly opts into the bounded local
    // producer. A cache miss cannot prevent the original playback response.
    // Partial means a previous producer stopped/faulted but its individually
    // verified GOPs remain safe. Do NOT restart 58 minutes of FFmpeg on every
    // three-second status poll; an explicit later retry must be separately
    // bounded and admitted. 'building' is already single-flight.
    if (req.method === "GET")
      startProgressiveWhenNewPieces(params,status);
    const duration = Number(media?.durationSeconds) || 0;
    const generation = Number(url.searchParams.get("generation"));
    const readable = status.ranges?.length > 0 && duration > 0;
    const codecStrings = new Set((status.ranges || []).map(item => item.videoCodecString));
    const videoCodec = codecStrings.size === 1 ? [...codecStrings][0] : null;
    const mime = /^avc1\.[0-9a-f]{6}$/i.test(String(videoCodec || ""))
      ? `video/mp4; codecs="${videoCodec}, mp4a.40.2"` : "";
    json(res, 200, {
      kind: "indexed-video-segments",
      status: readable ? (status.complete ? "ready" : "partial-ready") : status.status,
      identityKey: status.identityKey || "",
      ranges: status.ranges || [],
      readyRanges: status.readyRanges || [],
      sourceKey: `torrent:${session.id}:${fileIndex}`,
      generation: Number.isSafeInteger(generation) && generation >= 0 ? generation : 0,
      audioIndex, audioMode, durationSeconds: duration,
      videoCodec: "h264", audioCodec: "aac", container: "fmp4",
      mime, sourceVerified: readable && Boolean(mime), initVerified: readable && Boolean(mime),
      // Bright readiness is based on independently committed and FFprobe-
      // verified decoded samples; no bytes-downloaded estimate participates.
      segments: (status.ranges || []).map(item => ({
        id: item.id, startSeconds: item.start, endSeconds: item.end,
        mediaStartSeconds: item.mediaStart, initHash: item.initHash,
        timelineOffsetSeconds: item.timelineOffsetSeconds ?? 0,
        bytes: item.bytes, complete: true, verified: true,
        independentlyDecodable: true, keyframeStart: true,
        movieClockVerified: true,
      })),
    }, { "Cache-Control": "no-store" });
    return;
  }
  const id = /\/progressive\/window\/([a-f0-9]{64})$/.exec(url.pathname)?.[1];
  if (!id) { json(res, 400, { error: "Invalid progressive video window" }); return; }
  const reader = await progressiveIndexCache.open(params, id);
  if (!reader) { json(res, 404, { error: "Verified video window unavailable" }); return; }
  try {
    // Cache.open() validates its pin, but a source switch or Settings OFF can
    // occur after that async validation and before the HTTP response starts.
    // Never serve an old section using a replaced session/disabled generation.
    if (req.aborted || res.destroyed || res.writableEnded) return;
    const proof = reader.sourceKind === 'isolated-cluster'
      && Array.isArray(reader.sourceRanges) && reader.sourceRanges.length === 2
      ? reader.sourceRanges.every(({start,end})=>
          verifyTorrentFileByteRange(session.torrent,fileIndex,{start,end}).verified === true)
      : Number.isSafeInteger(reader.sourceByteEnd)
        ? verifyTorrentFileByteRange(session.torrent,fileIndex,
            {start:0,end:reader.sourceByteEnd}).verified === true
        : isTorrentFileFullyVerified(session.torrent,fileIndex);
    if (torrentSessions.get(session.id) !== session
      || storage.limits().remuxCacheEnabled !== true || !proof) {
      json(res, 404, { error: "Verified video window unavailable" });
      return;
    }
    const headers = {
      "Content-Type": "video/mp4", "Content-Length": String(reader.bytes),
      "Cache-Control": "no-store", "Accept-Ranges": "none",
      "X-Content-Type-Options": "nosniff",
      "X-LVL-Progressive-Start-Seconds": String(reader.start),
      "X-LVL-Progressive-End-Seconds": String(reader.end),
      "X-LVL-Progressive-Source": session.id,
    };
    if (req.method === "HEAD") { res.writeHead(200, headers); res.end(); return; }
    trackOpenStream(session, res, fileIndex);
    const stream = reader.handle.createReadStream({ autoClose: false });
    res.once("close", () => stream.destroy());
    res.writeHead(200, headers);
    await pipeline(stream, res);
  } catch { if (!res.destroyed) res.destroy(); }
  finally { await reader.release(); }
}

function streamTorrentFile(req, res, session, fileIndex, requestUrl = null) {
  if (session.state !== "ready") {
    json(res, 425, { error: "Torrent metadata is still resolving" });
    return;
  }
  const file = session.torrent.files[fileIndex];
  if (!file) {
    json(res, 404, { error: "Torrent file not found" });
    return;
  }
  if (!VIDEO_EXTENSIONS.has(path.extname(file.name).toLowerCase())) {
    json(res, 415, { error: "Only video files can be streamed from torrent sessions" });
    return;
  }
  if (Number(file.length) > MAX_TORRENT_VIDEO_BYTES) {
    json(res, 413, { error: `Selected video is too large (max ${Math.round(MAX_TORRENT_VIDEO_BYTES / 1024 / 1024 / 1024)} GB)` });
    return;
  }
  if (rejectOversizeVideo(res, file)) return;

  // HEAD describes the full resource, independently of any Range header.
  const range = req.method === "HEAD" ? null : parseRange(req.headers.range, file.length);
  if (range === false) {
    res.writeHead(416, { "Content-Range": `bytes */${file.length}` });
    res.end();
    return;
  }

  const type = file.type || mime[path.extname(file.name).toLowerCase()] || "application/octet-stream";
  const commonHeaders = {
    "Accept-Ranges": "bytes",
    "Content-Type": type,
    "Cache-Control": "no-store",
    "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(path.basename(file.name))}`,
  };

  if (req.method === "HEAD") {
    res.writeHead(200, { ...commonHeaders, "Content-Length": file.length });
    res.end();
    return;
  }

  // WebTorrent can throw during iterator creation. Open it before committing
  // response headers so a failed Range cannot claim a successful partial 206.
  let stream;
  try {
    stream = range ? file.createReadStream(range) : file.createReadStream();
  } catch {
    json(res, 503, { error: "Torrent reader unavailable" });
    return;
  }

  const pipeTorrentReader = () => {
    // Only server-issued, scoped opaque tags identify LVL-owned FFmpeg/FFprobe
    // readers. Anonymous browser/direct readers remain unknown. This role is
    // diagnostic data, NEVER authorization or torrent scheduling priority.
    const observedRange = range || { start: 0, end: file.length - 1 };
    const role = typeof internalReaderRoles === "undefined" ? "unknown"
      : internalReaderRoles.classify(session, fileIndex, requestUrl?.searchParams?.get("lvl_reader"));
    const healthReader = typeof streamHealth !== "undefined"
      ? streamHealth.begin(session, { fileIndex, ...observedRange, role }) : null;
    if (healthReader) {
      stream.on("data", (chunk) => healthReader.progress(chunk?.length));
      stream.once("end", () => healthReader.end("complete"));
      stream.once("error", () => healthReader.end("error"));
      stream.once("close", () => healthReader.end("cancel"));
    }
    const traceReader = typeof playbackTrace !== "undefined" && playbackTrace.enabled(session.id)
      ? playbackTrace.reader(session.id, fileIndex, observedRange) : null;
    if (traceReader) {
      stream.once("data", () => traceReader.firstByte());
      stream.once("end", () => traceReader.end("complete"));
      stream.once("error", () => traceReader.end("error"));
      stream.once("close", () => traceReader.end("cancel"));
    }
    trackOpenStream(session, res, fileIndex);
    // A browser changing src closes the response, but an already-complete GET
    // request need not emit 'aborted'. Tear down its WebTorrent piece reader so
    // old paused/seeked positions stop competing with the new stream.
    const stop = () => {
      // The HTTP response may close before WebTorrent's Readable emits its
      // own close/end (notably a slow swarm after the requested Range ends).
      // Release observational state when this actual request closes; keep the
      // destroy call that cancels the WebTorrent piece iterator.
      healthReader?.end(res.writableFinished ? "complete" : "cancel");
      traceReader?.end(res.writableFinished ? "complete" : "cancel");
      stream.destroy();
      detach();
    };
    const detach = () => {
      req.off("aborted", stop);
      res.off("close", stop);
    };
    req.once("aborted", stop);
    res.once("close", stop);
    stream.once("end", detach);
    stream.once("close", detach);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  };

  if (range) {
    res.writeHead(206, {
      ...commonHeaders,
      "Content-Length": range.end - range.start + 1,
      "Content-Range": `bytes ${range.start}-${range.end}/${file.length}`,
    });
    res.flushHeaders?.();
    pipeTorrentReader();
    return;
  }

  res.writeHead(200, { ...commonHeaders, "Content-Length": file.length });
  res.flushHeaders?.();
  pipeTorrentReader();
}

function probeCacheKey(sessionId, fileIndex) {
  return `${sessionId}:${fileIndex}`;
}

// Preflight for a copy-video fMP4 stream: FFmpeg seeks to a preceding video
// keyframe, not to the requested timestamp. Only verified *decoded* timestamps
// may be used as the absolute movie clock by the client. Never guess on errors.
async function copiedSeekOrigin(session, fileIndex, startSeconds, signal) {
  if (session.state !== "ready") throw Object.assign(new Error("Torrent metadata is not ready"), { statusCode: 425 });
  const file = session.torrent?.files?.[fileIndex];
  if (!file) throw Object.assign(new Error("Torrent file not found"), { statusCode: 404 });
  if (!VIDEO_EXTENSIONS.has(path.extname(file.name).toLowerCase()))
    throw Object.assign(new Error("Only supported video files can be copied"), { statusCode: 415 });
  if (Number(file.length) > MAX_TORRENT_VIDEO_BYTES)
    throw Object.assign(new Error("Torrent video exceeds size limit"), { statusCode: 413 });
  if (!Number.isFinite(startSeconds) || startSeconds < 0 || startSeconds > 24 * 60 * 60)
    throw Object.assign(new Error("Invalid seek start time"), { statusCode: 400 });
  const knownDuration = Number(getCachedMediaProbe(session.id, fileIndex)?.durationSeconds) || 0;
  if (knownDuration && startSeconds > Math.max(0, knownDuration - 0.25))
    throw Object.assign(new Error("Seek is beyond playable video duration"), { statusCode: 422 });
  if (signal?.aborted) throw Object.assign(new Error("Seek origin request cancelled"), { statusCode: 499 });
  if (startSeconds === 0) return { requestedStartSeconds: 0, effectiveStartSeconds: 0, prerollSeconds: 0, verified: true };
  const key = `${session.id}:${fileIndex}:${startSeconds}`;
  const cached = copiedSeekOriginCache.get(key);
  if (cached && cached.session === session && cached.expiresAt > Date.now()) return cached.result;
  const shared = copiedSeekOriginInflight.get(key);
  if (shared) {
    if (shared.session !== session || shared.controller.signal.aborted || shared.finished)
      throw Object.assign(new Error("Copied-video source changed during lookup"), { statusCode: 410 });
    return subscribeCopiedSeekOrigin(shared, signal);
  }
  if (activeCopiedSeekProbes >= MAX_COPIED_SEEK_PROBES)
    throw Object.assign(new Error("Copied-video seek probe is busy"), { statusCode: 429 });
  const flight = { key, session, controller: new AbortController(), subscribers: new Set(), finished: false };
  activeCopiedSeekProbes += 1;
  copiedSeekOriginInflight.set(key, flight);
  const subscribed = subscribeCopiedSeekOrigin(flight, signal);
  // The task catches all errors and settles each subscriber itself. No detached
  // rejected promise can escape into an unhandled-rejection event.
  void (async () => {
    let result;
    let failure;
    const tagged = typeof internalTorrentSource === "function"
      ? internalTorrentSource(session, fileIndex, "probe") : null;
    const source = tagged?.url || `http://127.0.0.1:${port}/api/torrents/${encodeURIComponent(session.id)}/files/${fileIndex}/stream`;
    try {
      if (flight.controller.signal.aborted) throw Object.assign(new Error("Seek origin request cancelled"), { statusCode: 499 });
      result = await probeCopiedSeekOrigin({ source, requestedStartSeconds: startSeconds,
        executable: ffprobePath, signal: flight.controller.signal });
      // An abandoned probe can complete despite cancellation. Its result must
      // never enter the cache or overwrite a subsequent fresh probe's result.
      if (flight.controller.signal.aborted)
        throw Object.assign(new Error("Seek origin request cancelled"), { statusCode: 499 });
      if (torrentSessions.get(session.id) !== session || session.state !== "ready")
        throw Object.assign(new Error("Copied-video source changed during lookup"), { statusCode: 410 });
      if (flight.subscribers.size) {
        for (const [itemKey, item] of copiedSeekOriginCache) if (item.expiresAt <= Date.now()) copiedSeekOriginCache.delete(itemKey);
        if (copiedSeekOriginCache.size >= MAX_COPIED_SEEK_CACHE_ENTRIES) copiedSeekOriginCache.delete(copiedSeekOriginCache.keys().next().value);
        copiedSeekOriginCache.set(key, { result, session, expiresAt: Date.now() + COPIED_SEEK_CACHE_TTL_MS });
      }
    } catch (error) {
      failure = error;
    } finally {
      tagged?.release();
      flight.finished = true;
      if (copiedSeekOriginInflight.get(key) === flight) copiedSeekOriginInflight.delete(key);
      activeCopiedSeekProbes -= 1;
      for (const subscriber of flight.subscribers) {
        subscriber.signal?.removeEventListener("abort", subscriber.cancel);
        if (failure) subscriber.reject(failure);
        else subscriber.resolve(result);
      }
      flight.subscribers.clear();
    }
  })();
  return subscribed;
}

// Each client has its own AbortSignal, while all clients seeking the same source
// frame share a single FFprobe. Cancelling one consumer must not cancel another.
function subscribeCopiedSeekOrigin(flight, signal) {
  if (signal?.aborted) return Promise.reject(Object.assign(new Error("Seek origin request cancelled"), { statusCode: 499 }));
  if (flight.subscribers.size >= MAX_COPIED_SEEK_SUBSCRIBERS)
    return Promise.reject(Object.assign(new Error("Too many callers are awaiting this copied-video seek"), { statusCode: 429 }));
  return new Promise((resolve, reject) => {
    const subscriber = { resolve, reject, signal, cancel: null };
    const cancel = () => {
      if (!flight.subscribers.delete(subscriber)) return;
      signal?.removeEventListener("abort", cancel);
      reject(Object.assign(new Error("Seek origin request cancelled"), { statusCode: 499 }));
      if (!flight.subscribers.size && !flight.finished) {
        // Remove abandoned work from the coalescing map immediately. The job
        // slot remains occupied until the underlying FFprobe promise settles.
        if (copiedSeekOriginInflight.get(flight.key) === flight) copiedSeekOriginInflight.delete(flight.key);
        flight.controller.abort();
      }
    };
    subscriber.cancel = cancel;
    flight.subscribers.add(subscriber);
    signal?.addEventListener("abort", cancel, { once: true });
    // An abort can race adding the listener after the first check.
    if (signal?.aborted) cancel();
  });
}

async function copiedSeekOriginEndpoint(req, res, session, fileIndex, url) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  if (localRequestRejected(req, res)) return;
  // Read-only nevertheless expensive: third-party pages must not be able to
  // trigger FFprobe/torrent-piece work using cross-site image/fetch requests.
  const requestSite = String(req.headers["sec-fetch-site"] || "").toLowerCase();
  const origin = String(req.headers.origin || "").toLowerCase();
  const host = String(req.headers.host || "").toLowerCase();
  if ((requestSite && requestSite !== "same-origin" && requestSite !== "none")
    || (origin && origin !== `http://${host}`)) {
    json(res, 403, { error: "Copied-video seek probes are available only to the local player" });
    return;
  }
  if (url.searchParams.get("video") !== "copy" || !/^\d{1,6}(?:\.\d{1,6})?$/.test(url.searchParams.get("start") || "")) {
    json(res, 400, { error: "video=copy and a finite, nonnegative start are required" });
    return;
  }
  const start = Number(url.searchParams.get("start"));
  const controller = new AbortController();
  const cancel = () => controller.abort();
  req.once("aborted", cancel);
  res.once("close", cancel);
  try {
    const result = await copiedSeekOrigin(session, fileIndex, start, controller.signal);
    if (!controller.signal.aborted && !res.destroyed && !res.writableEnded) json(res, 200, result);
  } catch (error) {
    if (!controller.signal.aborted && !res.destroyed && !res.writableEnded)
      json(res, error?.statusCode && error.statusCode !== 499 ? error.statusCode : 422,
        { error: String(error?.message || "Could not verify copied-video seek origin").slice(0, 300) });
  } finally {
    req.off("aborted", cancel);
    res.off("close", cancel);
  }
}

function pruneMediaProbeCache() {
  const now = Date.now();
  for (const [key, entry] of mediaProbeCache) {
    if (!entry.promise && entry.expiresAt <= now) mediaProbeCache.delete(key);
  }
  if (mediaProbeCache.size < MAX_PROBE_CACHE_ENTRIES) return;

  const evictable = [...mediaProbeCache.entries()]
    .filter(([, entry]) => !entry.promise)
    .sort((a, b) => a[1].lastAccess - b[1].lastAccess);
  while (mediaProbeCache.size >= MAX_PROBE_CACHE_ENTRIES && evictable.length) {
    mediaProbeCache.delete(evictable.shift()[0]);
  }
}

function getCachedMediaProbe(sessionId, fileIndex) {
  const key = probeCacheKey(sessionId, fileIndex);
  const entry = mediaProbeCache.get(key);
  if (!entry || entry.promise) return null;
  if (entry.expiresAt <= Date.now()) {
    mediaProbeCache.delete(key);
    return null;
  }
  entry.lastAccess = Date.now();
  return entry.value;
}

function parseFrameRate(value) {
  if (typeof value !== "string" || !value) return null;
  const [numerator, denominator = "1"] = value.split("/");
  const rate = Number(numerator) / Number(denominator);
  return Number.isFinite(rate) && rate > 0 ? Math.round(rate * 1000) / 1000 : null;
}

function runFfprobe(sourceUrl, file, { includeChapters = false } = {}) {
  if (!ffprobePath) {
    const error = new Error("Bundled FFprobe binary is unavailable");
    error.statusCode = 503;
    return Promise.reject(error);
  }

  const args = [
    "-v", "error",
    "-rw_timeout", "18000000",
    // The torrent stream endpoint supports byte ranges. Let FFprobe seek so
    // MP4/MOV files with metadata near the end can expose their real duration
    // without reading the movie sequentially from byte zero.
    "-seekable", "1",
    "-probesize", "2097152",
    "-analyzeduration", "3000000",
    // Chapter enumeration is OPTIONAL and may seek into the missing tail of
    // an unfinished MKV. Never make cold-swarm *playback metadata* depend on
    // this optional chapter lookup; inspect chapters only for hash-verified files.
    ...(includeChapters ? ["-show_chapters"] : []),
    "-show_entries", "format=duration,format_name,bit_rate:stream=index,codec_type,codec_name,profile,pix_fmt,bits_per_raw_sample,width,height,avg_frame_rate,r_frame_rate,duration,channels,channel_layout,sample_rate,bit_rate,color_range,color_space,color_transfer,color_primaries:stream_disposition=default,forced:stream_side_data_list=side_data_type,dv_profile,dv_bl_signal_compatibility_id:stream_tags=language,title"
      + (includeChapters ? ":chapter=start_time,end_time:chapter_tags=title" : ""),
    "-of", "json",
    sourceUrl,
  ];

  return new Promise((resolve, reject) => {
    const probe = spawn(ffprobePath, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };

    const timer = setTimeout(() => {
      if (!probe.killed) probe.kill();
      const error = new Error("Timed out probing media metadata");
      error.statusCode = 504;
      finish(error);
    }, MEDIA_PROBE_TIMEOUT_MS);
    timer.unref?.();

    probe.stdout.on("data", (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_PROBE_OUTPUT_BYTES) {
        if (!probe.killed) probe.kill();
        const error = new Error("Media probe returned too much metadata");
        error.statusCode = 502;
        finish(error);
        return;
      }
      stdout += chunk.toString("utf8");
    });
    probe.stderr.on("data", (chunk) => {
      if (stderr.length < 16 * 1024) stderr += chunk.toString("utf8");
    });
    probe.once("error", (error) => finish(Object.assign(error, { statusCode: 500 })));
    probe.once("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        const error = new Error(stderr.trim().slice(-1200) || `FFprobe exited with code ${code}`);
        error.statusCode = 502;
        finish(error);
        return;
      }

      let payload;
      try {
        payload = JSON.parse(stdout);
      } catch {
        const error = new Error("FFprobe returned invalid metadata");
        error.statusCode = 502;
        finish(error);
        return;
      }

      const streams = Array.isArray(payload.streams) ? payload.streams : [];
      const video = streams.find((stream) => stream.codec_type === "video") || null;
      const audioStreams = streams.filter((stream) => stream.codec_type === "audio");
      const subtitleStreams = streams.filter((stream) => stream.codec_type === "subtitle");
      const audio = audioStreams[0] || null;
      const durationCandidates = [payload.format?.duration, ...streams.map((stream) => stream.duration)]
        .map(Number)
        .filter((value) => Number.isFinite(value) && value > 0);
      const duration = durationCandidates.length ? Math.max(...durationCandidates) : NaN;
      if (!Number.isFinite(duration) || duration <= 0) {
        const error = new Error("Media duration is unavailable from the torrent file");
        error.statusCode = 422;
        finish(error);
        return;
      }

      const durationSeconds = Math.round(duration * 1000) / 1000;
      const media = {
        durationSeconds,
        durationMs: Math.round(duration * 1000),
        // Only strict, unambiguous OP/ED chapters from this exact probed file.
        // Never expose arbitrary embedded titles or guess missing cut markers.
        embeddedSkipMarkers: normalizeEmbeddedChapterMarkers(payload.chapters, durationSeconds),
        format: payload.format?.format_name || path.extname(file.name).slice(1).toLowerCase() || null,
        bitRate: Number.isFinite(Number(payload.format?.bit_rate)) ? Number(payload.format.bit_rate) : null,
        video: video ? {
          codec: video.codec_name || null,
          profile: video.profile || null,
          pixelFormat: video.pix_fmt || null,
          bitsPerRawSample: Number.isFinite(Number(video.bits_per_raw_sample)) && Number(video.bits_per_raw_sample) > 0 ? Number(video.bits_per_raw_sample) : null,
          width: Number.isFinite(Number(video.width)) ? Number(video.width) : null,
          height: Number.isFinite(Number(video.height)) ? Number(video.height) : null,
          frameRate: parseFrameRate(video.avg_frame_rate || video.r_frame_rate),
          colorRange: video.color_range || null,
          colorSpace: video.color_space || null,
          colorTransfer: video.color_transfer || null,
          colorPrimaries: video.color_primaries || null,
          dolbyVision: dolbyVisionFromProbe(video),
        } : null,
        audio: audio ? {
          codec: audio.codec_name || null,
          profile: audio.profile || null,
          channels: Number.isFinite(Number(audio.channels)) ? Number(audio.channels) : null,
          channelLayout: audio.channel_layout || null,
          sampleRate: Number.isFinite(Number(audio.sample_rate)) ? Number(audio.sample_rate) : null,
          bitRate: Number.isFinite(Number(audio.bit_rate)) ? Number(audio.bit_rate) : null,
          language: audio.tags?.language || null,
          title: audio.tags?.title || null,
        } : null,
        audioTracks: audioStreams.map((stream, order) => ({
          order,
          streamIndex: Number.isFinite(Number(stream.index)) ? Number(stream.index) : null,
          codec: stream.codec_name || null,
          profile: stream.profile || null,
          channels: Number.isFinite(Number(stream.channels)) ? Number(stream.channels) : null,
          channelLayout: stream.channel_layout || null,
          sampleRate: Number.isFinite(Number(stream.sample_rate)) ? Number(stream.sample_rate) : null,
          bitRate: Number.isFinite(Number(stream.bit_rate)) ? Number(stream.bit_rate) : null,
          language: stream.tags?.language || null,
          title: stream.tags?.title || null,
        })),
        subtitleTracks: subtitleStreams.map((stream, order) => {
          const codec = String(stream.codec_name || "").toLowerCase();
          return {
            order,
            streamIndex: Number.isFinite(Number(stream.index)) ? Number(stream.index) : null,
            codec: codec || null,
            language: stream.tags?.language || null,
            title: stream.tags?.title || null,
            // Preserve FFprobe's track intent. Forced-only captions usually
            // cover signs or foreign speech, not the entire dialogue track.
            disposition: {
              default: Number(stream.disposition?.default) === 1 ? 1 : 0,
              forced: Number(stream.disposition?.forced) === 1 ? 1 : 0,
            },
            textBased: ["subrip", "srt", "ass", "ssa", "webvtt", "mov_text", "text"].includes(codec),
          };
        }),
      };
      media.compatibility = inspectMediaCompatibility(media, { fileName: file.name });
      finish(null, media);
    });
  });
}

async function runFfprobeWithRetry(sourceUrl, file, { includeChapters = false } = {}) {
  try {
    return await runFfprobe(sourceUrl, file, { includeChapters });
  } catch (error) {
    if (error.statusCode !== 502 && error.statusCode !== 504) throw error;
    await new Promise((resolve) => setTimeout(resolve, 250));
    // A failed optional chapter scan must not be repeated during startup.
    return runFfprobe(sourceUrl, file, { includeChapters: false });
  }
}

async function probeTorrentFile(session, fileIndex) {
  if (session.state !== "ready") {
    const error = new Error("Torrent metadata is still resolving");
    error.statusCode = 425;
    throw error;
  }
  const file = session.torrent.files[fileIndex];
  if (!file) {
    const error = new Error("Torrent file not found");
    error.statusCode = 404;
    throw error;
  }
  if (!VIDEO_EXTENSIONS.has(path.extname(file.name).toLowerCase())) {
    const error = new Error("Selected torrent file is not a supported video file");
    error.statusCode = 415;
    throw error;
  }
  if (Number(file.length) > MAX_TORRENT_VIDEO_BYTES) {
    const error = new Error(`Selected video is too large (max ${Math.round(MAX_TORRENT_VIDEO_BYTES / 1024 / 1024 / 1024)} GB)`);
    error.statusCode = 413;
    throw error;
  }

  const key = probeCacheKey(session.id, fileIndex);
  const cached = getCachedMediaProbe(session.id, fileIndex);
  if (cached) return cached;
  const pending = mediaProbeCache.get(key)?.promise;
  if (pending) return pending;

  pruneMediaProbeCache();
  if (mediaProbeCache.size >= MAX_PROBE_CACHE_ENTRIES) {
    const error = new Error("Media probe cache is busy");
    error.statusCode = 429;
    throw error;
  }
  if (activeProbeJobs >= MAX_PROBE_JOBS) {
    const error = new Error("Too many media files are being probed right now");
    error.statusCode = 429;
    throw error;
  }

  const tagged = typeof internalTorrentSource === "function"
    ? internalTorrentSource(session, fileIndex, "probe") : null;
  const sourceUrl = tagged?.url || `http://127.0.0.1:${port}/api/torrents/${encodeURIComponent(session.id)}/files/${fileIndex}/stream`;
  activeProbeJobs += 1;
  // Hash-verified completion is the only safe admission for the optional
  // chapter scan; the ordinary codec probe remains the original short path.
  const includeChapters = isTorrentFileFullyVerified(session.torrent, fileIndex);
  const promise = runFfprobeWithRetry(sourceUrl, file, { includeChapters })
    .then((value) => {
      mediaProbeCache.set(key, {
        value,
        promise: null,
        expiresAt: Date.now() + MEDIA_PROBE_CACHE_TTL_MS,
        lastAccess: Date.now(),
      });
      return value;
    })
    .catch((error) => {
      mediaProbeCache.delete(key);
      throw error;
    })
    .finally(() => {
      tagged?.release();
      activeProbeJobs -= 1;
    });
  mediaProbeCache.set(key, {
    value: null,
    promise,
    expiresAt: Date.now() + MEDIA_PROBE_CACHE_TTL_MS,
    lastAccess: Date.now(),
  });
  return promise;
}

async function extractTorrentSubtitle(req, res, session, fileIndex, url) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  if (!ffmpegPath) {
    json(res, 503, { error: "Bundled FFmpeg binary is unavailable" });
    return;
  }
  const streamIndex = boundedInteger(url.searchParams.get("stream"), 0, 9999);
  if (streamIndex === undefined) {
    json(res, 400, { error: "A valid embedded subtitle stream index is required" });
    return;
  }
  // Metadata can take a long time on a torrent. Listen for disconnects BEFORE
  // awaiting it; otherwise a closed request can spawn an orphan FFmpeg later.
  let clientClosed = Boolean(res.destroyed || res.writableEnded || req.aborted);
  const markClientClosed = () => { clientClosed = true; };
  req.once("aborted", markClientClosed);
  res.once("close", markClientClosed);
  let media;
  try { media = await probeTorrentFile(session, fileIndex); }
  finally {
    req.off("aborted", markClientClosed);
    res.off("close", markClientClosed);
  }
  if (clientClosed || res.destroyed || res.writableEnded || req.aborted) return;
  const subtitle = (media.subtitleTracks || []).find((track) => Number(track.streamIndex) === streamIndex);
  if (!subtitle) {
    json(res, 404, { error: "Embedded subtitle track was not found" });
    return;
  }
  if (!subtitle.textBased) {
    json(res, 415, { error: `Embedded ${subtitle.codec || "subtitle"} track is image-based and cannot be converted to text` });
    return;
  }
  // An ASS stream in MKV is interleaved with the whole movie. Waiting for EOF
  // before responding means a torrent may not yield any subtitles for minutes.
  // Progressive callers can use cues immediately and continue importing as
  // pieces arrive. Normal callers keep the original atomic response.
  const progressive = url.searchParams.get("progressive") === "1";
  const requestedStart = Number(url.searchParams.get("start") || 0);
  if (!Number.isFinite(requestedStart) || requestedStart < 0 || requestedStart > media.durationSeconds) {
    json(res, 400, { error: "Subtitle window start is outside the video" });
    return;
  }
  const windowStart = Math.floor(requestedStart);
  const windowSeconds = progressive ? 180 : 0;
  // Each extractor has its own HTTP torrent-piece reader. Cap them separately
  // from video transcoding so rapid seeks don't launch unbounded FFmpeg jobs.
  if (activeEmbeddedSubtitleJobs.size >= MAX_EMBEDDED_SUBTITLE_JOBS) {
    json(res, 429, { error: "Too many embedded subtitle windows are being extracted" });
    return;
  }
  const tagged = typeof internalTorrentSource === "function"
    ? internalTorrentSource(session, fileIndex, "subtitle") : null;
  const sourceUrl = tagged?.url || `http://127.0.0.1:${port}/api/torrents/${encodeURIComponent(session.id)}/files/${fileIndex}/stream`;
  const args = [
    "-v", "error",
    "-rw_timeout", "18000000",
    // Byte-range seeking with -ss + -copyts + -t silently returns zero cues
    // on seeked MKVs (FFmpeg even exits 0). Seek without -copyts, then
    // restore absolute playback timestamps via output_ts_offset.
    ...(progressive && windowStart > 0 ? ["-ss", String(windowStart)] : []),
    "-i", sourceUrl,
    "-map", `0:${streamIndex}`,
    ...(progressive ? ["-t", String(windowSeconds)] : []),
    ...(progressive && windowStart > 0 ? ["-output_ts_offset", String(windowStart)] : []),
    "-f", "webvtt",
    "pipe:1",
  ];
  const ffmpeg = spawn(ffmpegPath, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  activeEmbeddedSubtitleJobs.add(ffmpeg);
  const releaseSubtitleJob = () => { tagged?.release(); activeEmbeddedSubtitleJobs.delete(ffmpeg); };
  ffmpeg.once("close", releaseSubtitleJob);
  ffmpeg.once("error", releaseSubtitleJob);
  const chunks = [];
  let size = 0;
  let stderr = "";
  let settled = false;
  let streaming = false;
  const beginStreaming = () => {
    if (streaming) return;
    streaming = true;
    res.writeHead(200, {
      "Content-Type": "text/vtt; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Subtitle-Progressive": "1",
      "X-Subtitle-Language": String(subtitle.language || ""),
      "X-Subtitle-Start": String(windowStart),
      "X-Subtitle-Window-Seconds": String(windowSeconds),
    });
    res.flushHeaders?.();
  };
  const finish = (status, body, headers = {}) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (!ffmpeg.killed) ffmpeg.kill();
    if (progressive && streaming) {
      if (!res.destroyed) res.end(status === 200
        ? "\n\nNOTE LVL-EXTRACT-COMPLETE\n"
        : `\n\nNOTE LVL-EXTRACT-PARTIAL: ${String(body || "Extraction interrupted").replace(/[\r\n]/g, " ").slice(0, 200)}\n`);
    } else if (status === 200) {
      res.writeHead(200, {
        "Content-Type": "text/vtt; charset=utf-8",
        "Cache-Control": "no-store",
        ...headers,
      });
      res.end(body);
    } else {
      json(res, status, { error: String(body || "Embedded subtitle extraction failed") });
    }
  };
  const timer = setTimeout(() => finish(504, "Timed out reading video. Some torrent pieces may still be missing."), progressive ? 42_000 : 20_000);
  timer.unref?.();
  ffmpeg.stdout.on("data", (chunk) => {
    size += chunk.length;
    if (size > MAX_SUBTITLE_TEXT_BYTES) {
      finish(413, "Embedded subtitle track is too large");
      return;
    }
    if (progressive) {
      beginStreaming();
      if (!res.write(chunk)) {
        ffmpeg.stdout.pause();
        res.once("drain", () => ffmpeg.stdout.resume());
      }
    } else chunks.push(chunk);
  });
  ffmpeg.stderr.on("data", (chunk) => {
    if (stderr.length < 16 * 1024) stderr += chunk.toString("utf8");
  });
  ffmpeg.once("error", (error) => finish(500, error.message));
  ffmpeg.once("close", (code) => {
    if (settled) return;
    if (code !== 0) {
      finish(502, stderr.trim().slice(-1200) || `FFmpeg exited with code ${code}`);
      return;
    }
    const text = progressive ? "" : Buffer.concat(chunks).toString("utf8");
    if (progressive && streaming) return finish(200, "");
    if (!text.trim()) {
      finish(422, "Embedded subtitle track was empty");
      return;
    }
    finish(200, text, {
      "X-Subtitle-Language": String(subtitle.language || ""),
      "X-Subtitle-Title": encodeURIComponent(String(subtitle.title || "Embedded subtitle").slice(0, 200)),
    });
  });
  res.once("close", () => {
    if (!settled) {
      settled = true;
      clearTimeout(timer);
      if (!ffmpeg.killed) ffmpeg.kill();
    }
  });
}

// Speech activity of one audio window, for syncing subtitles to what is actually said. Decodes only
// that stretch (input seeking), as 16 kHz mono speech-band audio, and returns activity per 10 ms.
const SPEECH_WINDOW_MAX_SECONDS = 120;
const MAX_SPEECH_JOBS = 2;
const MAX_SPEECH_WINDOW_WAITERS = 16;
const speechWindowCache = new Map();
const speechMetadataWaiters = new WeakMap();
// In-flight entries are scoped to the actual session object (not its ID).
// Only successful completed windows enter the small time-bounded result cache.
const speechWindowInflight = new WeakMap();
// A child whose termination could not be confirmed after a bounded kill
// escalation still reserves one slot until its actual 'close' event arrives.
const speechUnclosedChildren = new Set();
let activeSpeechJobs = 0;

function invalidateSpeechWindowSession(session) {
  const probing = speechMetadataWaiters.get(session);
  if (probing) {
    speechMetadataWaiters.delete(session);
    for (const wake of probing) wake({ status: 410 });
    probing.clear();
  }
  const flights = speechWindowInflight.get(session);
  if (flights) {
    speechWindowInflight.delete(session);
    for (const flight of flights.values()) {
      flight.controller.abort();
      // The client may still be connected. Null means the client disconnected;
      // session removal needs a terminal HTTP response instead of a hanging GET.
      for (const subscriber of flight.subscribers)
        subscriber.resolve({ status: 410, message: "Audio source changed; request a fresh window" });
      flight.subscribers.clear();
    }
    flights.clear();
  }
  for (const [key, entry] of speechWindowCache) {
    if (entry.session === session) speechWindowCache.delete(key);
  }
}

async function speechActivityWindow(req, res, session, fileIndex, url) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  const audioOrder = boundedInteger(url.searchParams.get("audio") ?? "0", 0, 63);
  if (audioOrder === undefined) {
    json(res, 400, { error: "audio must be a track number" });
    return;
  }
  // What the playback transcode has already converted (and so can be analysed at once).
  if (url.searchParams.get("coverage") === "1") {
    json(res, 200, { frameMs: SPEECH_FRAME_MS, ranges: speechTapeCoverage(session.id, fileIndex, audioOrder) });
    return;
  }
  const start = Number(url.searchParams.get("start"));
  const duration = Number(url.searchParams.get("duration"));
  if (!Number.isFinite(start) || start < 0 || !Number.isFinite(duration) || duration < 10 || duration > SPEECH_WINDOW_MAX_SECONDS) {
    json(res, 400, { error: `start (s), duration (10-${SPEECH_WINDOW_MAX_SECONDS} s) and audio are required` });
    return;
  }
  const live = speechTapeActivity(session.id, fileIndex, audioOrder, Math.round(start * 1000), Math.round(duration * 1000));
  if (live) {
    json(res, 200, {
      startMs: Math.round(start * 1000),
      frameMs: SPEECH_FRAME_MS,
      durationMs: live.length * SPEECH_FRAME_MS,
      audio: audioOrder,
      live: true,
      activity: Buffer.from(live).toString("base64"),
    });
    return;
  }
  if (url.searchParams.get("live") === "only") {
    json(res, 409, { error: "That stretch has not played yet" });
    return;
  }
  if (!ffmpegPath) {
    json(res, 503, { error: "Bundled FFmpeg binary is unavailable" });
    return;
  }
  let clientClosed = Boolean(req.aborted || res.destroyed || res.writableEnded);
  let cancelSubscriber = null;
  let stopMetadata = null;
  const onClientClose = () => {
    clientClosed = true;
    stopMetadata?.(null);
    cancelSubscriber?.();
  };
  // The metadata probe may be long. A disconnected caller must not start a
  // speech FFmpeg once that probe eventually returns.
  req.once("aborted", onClientClose);
  res.once("close", onClientClose);
  const currentSession = () => torrentSessions.get(session.id) === session && session.state === "ready";
  try {
    if (clientClosed) return;
    if (!currentSession()) {
      json(res, 410, { error: "Audio source changed; request a fresh window" });
      return;
    }
    let metadataWaiters = speechMetadataWaiters.get(session);
    if (!metadataWaiters) {
      metadataWaiters = new Set();
      speechMetadataWaiters.set(session, metadataWaiters);
    }
    if (metadataWaiters.size >= MAX_SPEECH_WINDOW_WAITERS) {
      json(res, 429, { error: "Too many callers are waiting for audio metadata" });
      return;
    }
    let media;
    try {
      const interrupted = new Promise((resolve) => {
        stopMetadata = resolve;
        metadataWaiters.add(resolve);
      });
      // Observe both outcomes even when the HTTP waiter disconnects: shared
      // FFprobe continues for others, but its later rejection is always caught.
      const probeTask = Promise.resolve().then(() => probeTorrentFile(session, fileIndex))
        .then((value) => ({ media: value }), (error) => ({ error }));
      const metadata = await Promise.race([probeTask, interrupted]);
      if (!metadata || clientClosed || req.aborted || res.destroyed || res.writableEnded) return;
      if (metadata.status === 410) {
        json(res, 410, { error: "Audio source changed; request a fresh window" });
        return;
      }
      if (metadata.error) throw metadata.error;
      media = metadata.media;
    } finally {
      metadataWaiters.delete(stopMetadata);
      if (!metadataWaiters.size && speechMetadataWaiters.get(session) === metadataWaiters)
        speechMetadataWaiters.delete(session);
      stopMetadata = null;
    }
    if (clientClosed || req.aborted || res.destroyed || res.writableEnded) return;
    if (!currentSession()) {
      json(res, 410, { error: "Audio source changed; request a fresh window" });
      return;
    }
    const audioTracks = Array.isArray(media?.audioTracks) ? media.audioTracks : [];
    if (!audioTracks.length) {
      json(res, 422, { error: "This video has no audio track" });
      return;
    }
    const order = audioOrder < audioTracks.length ? audioOrder : 0;
    const total = Number(media?.durationSeconds) || 0;
    const startSeconds = Math.round((total ? Math.min(start, Math.max(0, total - 10)) : start) * 100) / 100;
    const seconds = Math.round((total ? Math.min(duration, Math.max(10, total - startSeconds)) : duration) * 100) / 100;
    const key = `${fileIndex}:${order}:${startSeconds}:${seconds}`;
    const cacheKey = `${session.id}:${key}`;
    for (const [entryKey, entry] of speechWindowCache) if (entry.expiresAt < Date.now() || entry.session?.state !== "ready"
      || torrentSessions.get(entry.session?.id) !== entry.session) speechWindowCache.delete(entryKey);
    const cached = speechWindowCache.get(cacheKey);
    if (cached?.session === session) {
      json(res, 200, cached.value);
      return;
    }
    let flights = speechWindowInflight.get(session);
    let flight = flights?.get(key);
    if (!flight) {
      if (activeSpeechJobs + speechUnclosedChildren.size >= MAX_SPEECH_JOBS) {
        json(res, 429, { error: "Audio analysis is busy; try again shortly" });
        return;
      }
      if (!flights) {
        flights = new Map();
        speechWindowInflight.set(session, flights);
      }
      flight = { controller: new AbortController(), subscribers: new Set(), done: false };
      flights.set(key, flight);
      activeSpeechJobs += 1;
      const producer = flight;
      const ownerFlights = flights;
      // Queue the worker after this HTTP request subscribes, so a synchronous
      // disconnect can cancel it without spawning another decoder.
      queueMicrotask(() => {
        void (async () => {
          let result = null;
          try {
            if (producer.controller.signal.aborted) return;
            const pcm = await decodeSpeechAudio(session, fileIndex, {
              startSeconds, seconds, order, signal: producer.controller.signal,
            });
            if (producer.controller.signal.aborted) return;
            if (pcm.length < SPEECH_SAMPLE_RATE * 5) {
              result = { status: 422, message: "No audio was decoded in this range" };
            } else {
              const activity = speechActivityFromPcm(pcm, { sampleRate: SPEECH_SAMPLE_RATE });
              const value = {
                startMs: Math.round(startSeconds * 1000),
                frameMs: SPEECH_FRAME_MS,
                durationMs: activity.length * SPEECH_FRAME_MS,
                audio: order,
                activity: Buffer.from(activity).toString("base64"),
              };
              if (currentSession() && producer.subscribers.size && !producer.controller.signal.aborted) {
                if (speechWindowCache.size >= 60) speechWindowCache.delete(speechWindowCache.keys().next().value);
                speechWindowCache.set(cacheKey, { session, value, expiresAt: Date.now() + TORRENT_SESSION_TTL_MS });
              }
              result = { value };
            }
          } catch (error) {
            result = { error };
          } finally {
            producer.done = true;
            if (ownerFlights.get(key) === producer) ownerFlights.delete(key);
            if (!ownerFlights.size && speechWindowInflight.get(session) === ownerFlights)
              speechWindowInflight.delete(session);
            activeSpeechJobs -= 1;
            for (const subscriber of producer.subscribers) subscriber.resolve(result);
            producer.subscribers.clear();
          }
        })();
      });
    }
    if (flight.subscribers.size >= MAX_SPEECH_WINDOW_WAITERS) {
      json(res, 429, { error: "Too many callers are waiting for audio analysis" });
      return;
    }
    const pending = flight;
    const result = await new Promise((resolve) => {
      const subscriber = { resolve };
      pending.subscribers.add(subscriber);
      cancelSubscriber = () => {
        if (!pending.subscribers.delete(subscriber)) return;
        resolve(null);
        if (!pending.subscribers.size && !pending.done) {
          if (flights.get(key) === pending) flights.delete(key);
          pending.controller.abort();
        }
      };
      if (clientClosed) cancelSubscriber();
    });
    cancelSubscriber = null;
    if (!result || clientClosed || req.aborted || res.destroyed || res.writableEnded) return;
    if (!currentSession()) {
      json(res, 410, { error: "Audio source changed; request a fresh window" });
      return;
    }
    if (result.status) {
      json(res, result.status, { error: result.message });
      return;
    }
    if (result.error) throw result.error;
    json(res, 200, result.value);
  } finally {
    req.off("aborted", onClientClose);
    res.off("close", onClientClose);
  }
}

function decodeSpeechAudio(session, fileIndex, { startSeconds, seconds, order, signal }) {
  if (signal?.aborted) return Promise.reject(Object.assign(new Error("Audio analysis cancelled"), { statusCode: 499 }));
  const tagged = typeof internalTorrentSource === "function"
    ? internalTorrentSource(session, fileIndex, "speech") : null;
  const sourceUrl = tagged?.url || `http://127.0.0.1:${port}/api/torrents/${encodeURIComponent(session.id)}/files/${fileIndex}/stream`;
  const args = [
    "-hide_banner", "-loglevel", "error", "-nostdin",
    "-rw_timeout", "30000000",
    ...(startSeconds > 0 ? ["-ss", String(startSeconds)] : []),
    "-i", sourceUrl,
    "-t", String(seconds),
    "-map", `0:a:${order}`,
    "-vn", "-sn", "-dn",
    "-ac", "1", "-ar", String(SPEECH_SAMPLE_RATE),
    "-af", "highpass=f=120,lowpass=f=4000",
    "-f", "s16le", "pipe:1",
  ];
  const maxBytes = Math.ceil(seconds * SPEECH_SAMPLE_RATE * 2) + 64 * 1024;
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(ffmpegPath, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    ffmpeg.once("close", () => tagged?.release());
    ffmpeg.once("error", () => tagged?.release());
    const chunks = [];
    let size = 0;
    let stderr = "";
    let settled = false;
    let stopReason = null;
    let escalationTimer = null;
    let closeDeadline = null;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(escalationTimer);
      clearTimeout(closeDeadline);
      signal?.removeEventListener("abort", cancel);
      if (error) reject(error);
      else resolve(value);
    };
    const requestStop = (reason) => {
      if (settled || stopReason) return;
      stopReason = reason;
      clearTimeout(timer);
      try { ffmpeg.kill(); } catch { /* still wait for confirmed process close */ }
      // A kill request is not evidence the child exited. Retry once with a
      // stronger signal, then bound the HTTP failure without freeing its slot.
      escalationTimer = setTimeout(() => {
        try { ffmpeg.kill("SIGKILL"); } catch { /* keep capacity reserved */ }
      }, 2_000);
      escalationTimer.unref?.();
      closeDeadline = setTimeout(() => {
        if (settled) return;
        speechUnclosedChildren.add(ffmpeg);
        finish(stopReason);
      }, 8_000);
      closeDeadline.unref?.();
    };
    const cancel = () => requestStop(Object.assign(new Error("Audio analysis cancelled"), { statusCode: 499 }));
    const timer = setTimeout(() => requestStop(Object.assign(new Error("Timed out reading audio for subtitle sync"), { statusCode: 504 })), 45_000);
    timer.unref?.();
    ffmpeg.stdout.on("data", (chunk) => {
      if (size + chunk.length > maxBytes) chunk = chunk.subarray(0, Math.max(0, maxBytes - size));
      size += chunk.length;
      chunks.push(chunk);
    });
    ffmpeg.stderr.on("data", (chunk) => {
      if (stderr.length < 8 * 1024) stderr += chunk.toString("utf8");
    });
    ffmpeg.once("error", (error) => requestStop(error));
    ffmpeg.once("close", (code) => {
      speechUnclosedChildren.delete(ffmpeg);
      if (settled) return;
      if (stopReason) return finish(stopReason);
      const buffer = Buffer.concat(chunks);
      if (code !== 0 && buffer.length < SPEECH_SAMPLE_RATE * 2) {
        finish(Object.assign(new Error(stderr.trim().slice(-600) || `FFmpeg exited with code ${code}`), { statusCode: 502 }));
        return;
      }
      const samples = new Int16Array(Math.floor(buffer.length / 2));
      for (let index = 0; index < samples.length; index += 1) samples[index] = buffer.readInt16LE(index * 2);
      finish(null, samples);
    });
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}

// Anki decks in and out. Import only parses the file and returns the cards; the app stores them.
const MAX_ANKI_UPLOAD_BYTES = 400 * 1024 * 1024;

async function readBinaryBody(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error(`That file is too large (max ${Math.round(maxBytes / 1048576)} MB)`), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Decks are stored: note types, notes and media, so cards render like Anki shows them.
function topDeckName(cards, fallback) {
  const counts = new Map();
  for (const card of cards) {
    const top = String(card.deck || "").split("::")[0].trim();
    if (top && top !== "Default") counts.set(top, (counts.get(top) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || fallback;
}

function textImportCollection(result, name) {
  const escape = (value) => String(value || "").replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[char]).replace(/\n/g, "<br>");
  const notetype = { id: "basic-text", name: "Basic", kind: "normal", fields: ["Front", "Back"], templates: [{ name: "Card 1", qfmt: "{{Front}}", afmt: "{{FrontSide}}<hr id=answer>{{Back}}" }], css: ".card { font-family: arial; font-size: 20px; text-align: center; color: black; background-color: white; }" };
  const notes = result.cards.map((card, index) => ({ id: `t${index + 1}`, guid: card.guid, mid: notetype.id, tags: card.tags || [], fields: [escape(card.front), escape(card.back)] }));
  const cards = result.cards.map((card, index) => ({ ...card, cardId: `t${index + 1}`, noteId: `t${index + 1}`, ord: 0, deck: card.deck || name }));
  return { notetypes: [notetype], notes, cards, media: [] };
}

function storeAnkiPackage(buffer, meta = {}) {
  const collection = readAnkiCollection(buffer);
  if (!collection.cards.length) throw Object.assign(new Error("No cards were found in that deck"), { statusCode: 422 });
  const name = meta.name || topDeckName(collection.cards, "Imported deck");
  const id = meta.id || `import-${crypto.createHash("sha1").update(name).digest("hex").slice(0, 12)}`;
  const stored = ankiStore.saveDeck({ ...meta, id, name, source: meta.source || "import" }, collection);
  return { ...stored, total: collection.total, truncated: collection.truncated, media: collection.media.length };
}

// The installed app reads only its own bundled release history. Never accept a
// pathname, URL or remote source from an API caller; the GitHub source branch
// is not the published release history. The alpha packager stamps its payload
// copy of the Unreleased heading with the version being installed.
const MAX_LOCAL_CHANGELOG_BYTES = 128 * 1024;

function parseLocalChangelog(raw) {
  const sections = [];
  let section = null;
  for (const line of raw.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      if (section) sections.push(section);
      const title = heading[1];
      const release = /^(\d+)\.(\d+)\.(\d+)\s*[—–-]\s*(\d{4}-\d{2}-\d{2})$/.exec(title);
      const unreleased = /^unreleased\b/i.test(title);
      section = (release || unreleased) ? {
        title,
        version: release ? `${release[1]}.${release[2]}.${release[3]}` : null,
        date: release ? release[4] : null,
        unreleased: Boolean(unreleased),
        lines: [],
      } : null;
      continue;
    }
    if (section) {
      const bullet = /^\s*[-*]\s+(.+)\s*$/.exec(line);
      if (bullet) section.lines.push(bullet[1]);
    }
  }
  if (section) sections.push(section);
  sections.sort((a, b) => {
    if (a.unreleased !== b.unreleased) return a.unreleased ? -1 : 1;
    if (a.unreleased) return 0;
    const aVersion = a.version.split(".").map(Number);
    const bVersion = b.version.split(".").map(Number);
    for (let i = 0; i < 3; i++) {
      if (aVersion[i] !== bVersion[i]) return bVersion[i] - aVersion[i];
    }
    return 0;
  });
  const entries = sections.map((entry) => ({ ...entry, changes: entry.lines }));
  return { entries, latest: entries.find((entry) => !entry.unreleased) || null, raw };
}

function localChangelogEndpoint(req, res, url) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  if (url.search) {
    json(res, 400, { error: "Release history does not accept parameters" });
    return true;
  }
  try {
    const source = path.join(root, "CHANGELOG.md");
    const stat = fs.lstatSync(source);
    if (!stat.isFile() || stat.size > MAX_LOCAL_CHANGELOG_BYTES) {
      json(res, 404, { error: "Local release history unavailable" });
      return true;
    }
    const data = fs.readFileSync(source);
    if (data.length > MAX_LOCAL_CHANGELOG_BYTES) {
      json(res, 404, { error: "Local release history unavailable" });
      return true;
    }
    json(res, 200, parseLocalChangelog(data.toString("utf8")),
      { "X-Content-Type-Options": "nosniff" });
  } catch (error) {
    if (error?.code !== "ENOENT") console.warn("Couldn't read bundled release history:", error.message);
    json(res, 404, { error: "Local release history unavailable" });
  }
  return true;
}

// Other websites open in the browser can send requests to 127.0.0.1 too. For the deck, AnkiWeb
// and clip routes: only local host names are served (a DNS-rebinding page has another Host), and
// requests that change data must come from this app's own pages.
function localRequestRejected(req, res) {
  const host = String(req.headers.host || "").toLowerCase();
  const localHost = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  if (!localHost.has(host)) {
    json(res, 403, { error: "This app only answers on 127.0.0.1" });
    return true;
  }
  if (req.method === "GET" || req.method === "HEAD") return false;
  const site = String(req.headers["sec-fetch-site"] || "").toLowerCase();
  const origin = typeof req.headers.origin === "string" ? req.headers.origin.toLowerCase() : "";
  if ((site && site !== "same-origin" && site !== "none") || (origin && origin !== `http://${host}`)) {
    json(res, 403, { error: "Requests from other sites can't change this app's data" });
    return true;
  }
  return false;
}

function requestNativeUpdate(action, fields = {}) {
  return new Promise((resolve, reject) => {
    if (!UPDATE_BRIDGE) return reject(new Error("Installed updater unavailable"));
    const client = net.connect({ host: "127.0.0.1", port: UPDATE_BRIDGE.port });
    let done = false;
    let response = "";
    const finish = (error, value) => {
      if (done) return;
      done = true;
      client.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    client.setTimeout(4000, () => finish(new Error("Updater did not answer")));
    client.on("error", () => finish(new Error("Updater connection unavailable")));
    client.on("connect", () => client.write(JSON.stringify({
      secret: UPDATE_BRIDGE.secret, action, ...fields,
    }) + "\n"));
    client.on("data", (chunk) => {
      response += chunk.toString("utf8");
      if (Buffer.byteLength(response) > 8192) return finish(new Error("Invalid updater response"));
      const end = response.indexOf("\n");
      if (end < 0) return;
      try {
        const status = JSON.parse(response.slice(0, end));
        if (!status || typeof status !== "object" || Array.isArray(status)) throw new Error("Invalid updater response");
        if (!("installed" in status) && typeof status.error === "string") {
          return finish(Object.assign(new Error(status.error), { statusCode: 400 }));
        }
        finish(null, status);
      } catch (error) { finish(error); }
    });
    client.on("end", () => finish(new Error("Updater connection ended")));
  });
}

// Automatic updates wait until no video is open; see backend/app-updates/update-policy.js.
const updatePolicy = UPDATE_BRIDGE ? createUpdatePolicy({
  request: requestNativeUpdate,
  prefsFile: path.join(appDataRoot, "app-update-policy.json"),
  isBusy: () => torrentSessions.size > 0 || activeTranscodes.size > 0,
  patchCapable: () => fs.existsSync(path.join(root, "runtime", "update-apply.mjs")),
  log: (message) => console.log(`Updates: ${message}`),
}) : null;

async function appUpdatesEndpoint(req, res, url) {
  if (url.pathname === "/api/app-updates/changelog")
    return localChangelogEndpoint(req, res, url);
  if (!UPDATE_BRIDGE) {
    if (url.pathname === "/api/app-updates/status" && req.method === "GET") {
      json(res, 200, {
        installed: false, automatic: false, enabled: false, intervalDays: 1,
        lastCheckedAt: null, installedVersion: APP_VERSION || null,
        available: false, availableVersion: null, checking: false,
        downloading: false, error: null, notice: null, noticePending: false,
      });
      return true;
    }
    json(res, 409, { error: "Updates are only available in installed LVL." });
    return true;
  }

  const actions = new Map([
    ["/api/app-updates/status", ["GET", "status"]],
    ["/api/app-updates/settings", ["POST", "settings"]],
    ["/api/app-updates/check", ["POST", "check"]],
    ["/api/app-updates/install", ["POST", "install"]],
  ]);
  const route = actions.get(url.pathname);
  if (!route) return false;
  if (req.method !== route[0]) return methodNotAllowed(res, [route[0]]);
  if (req.method === "POST") {
    // For privileged actions require an explicit same-origin browser request.
    // Other websites cannot trigger native dialogs, checks or preferences.
    const expected = `http://${String(req.headers.host || "").toLowerCase()}`;
    if (req.headers.origin !== expected ||
        (req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin")) {
      json(res, 403, { error: "Only this LVL window can manage updates" });
      return true;
    }
    if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
      json(res, 415, { error: "Expected JSON update request" });
      return true;
    }
  }
  let fields = {};
  if (route[1] === "settings") {
    const body = await readJsonBody(req, 1024);
    if (!body || typeof body.automatic !== "boolean" ||
        ![1, 7, 30].includes(body.intervalDays) ||
        Object.keys(body).some((key) => key !== "automatic" && key !== "intervalDays")) {
      json(res, 400, { error: "Choose automatic updates and a 1, 7 or 30 day interval" });
      return true;
    }
    fields = { automatic: body.automatic, intervalDays: body.intervalDays };
  } else if (req.method === "POST") {
    const body = await readJsonBody(req, 1024);
    if (route[1] === "check") {
      if (!body || typeof body.apply !== "boolean" ||
          Object.keys(body).some((key) => key !== "apply")) {
        json(res, 400, { error: "Update check must specify apply: true or false" });
        return true;
      }
      fields = { apply: body.apply };
    } else if (!body || Object.keys(body).length !== 0) {
      json(res, 400, { error: "Update install request must be empty" });
      return true;
    }
  }
  try {
    json(res, 200, await updatePolicy.handle(route[1], fields));
  } catch (error) {
    json(res, error.statusCode || 503, { error: error.message || "Updater unavailable" });
  }
  return true;
}

async function importAnkiDeck(req, res) {
  const body = await readBinaryBody(req, MAX_ANKI_UPLOAD_BYTES);
  if (!body.length) {
    json(res, 400, { error: "No file was received" });
    return;
  }
  const isZip = body[0] === 0x50 && body[1] === 0x4b;
  if (isZip) {
    json(res, 200, storeAnkiPackage(body));
    return;
  }
  const result = readAnkiText(body.toString("utf8"));
  if (!result.cards.length) {
    json(res, 422, { error: "No cards were found in that file" });
    return;
  }
  const name = topDeckName(result.cards, "Imported notes");
  const stored = ankiStore.saveDeck({ id: `import-text-${crypto.createHash("sha1").update(name).digest("hex").slice(0, 12)}`, name, source: "import" }, textImportCollection(result, name));
  json(res, 200, { ...stored, total: result.total, truncated: result.truncated, media: 0 });
}

function sendStoredFile(req, res, { file, type, bytes }, { cacheControl = "private, max-age=86400", extraHeaders = {} } = {}) {
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ""));
  const base = { "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": cacheControl, "X-Content-Type-Options": "nosniff", ...extraHeaders };
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, bytes - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(bytes - 1, Number(range[2])) : bytes - 1;
    if (start > end || start >= bytes) {
      res.writeHead(416, { "Content-Range": `bytes */${bytes}` });
      res.end();
      return;
    }
    res.writeHead(206, { ...base, "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${bytes}` });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file, { start, end }).on("error", () => res.destroy()).pipe(res);
    return;
  }
  res.writeHead(200, { ...base, "Content-Length": bytes });
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(file).on("error", () => res.destroy()).pipe(res);
}

function serveAnkiMedia(req, res, deckId, encodedName) {
  let name;
  try { name = decodeURIComponent(encodedName); } catch { name = ""; }
  const found = name ? ankiStore.mediaFile(deckId, name) : null;
  if (!found) {
    json(res, 404, { error: "Media file not found" });
    return;
  }
  const font = /^font\//.test(found.type);
  sendStoredFile(req, res, found, {
    extraHeaders: {
      // Fonts are fetched with CORS from the sandboxed card frame; other media needs no CORS.
      ...(font ? { "Access-Control-Allow-Origin": "*" } : {}),
      ...(/svg/.test(found.type) ? { "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:" } : {}),
    },
  });
}

const ankiwebJobs = new Map();

function startAnkiwebDownload(sharedId) {
  const existing = [...ankiwebJobs.values()].find((job) => job.sharedId === sharedId && (job.status === "downloading" || job.status === "importing"));
  if (existing) return existing;
  const job = { id: crypto.randomUUID(), sharedId, status: "downloading", received: 0, total: 0, startedAt: Date.now() };
  ankiwebJobs.set(job.id, job);
  for (const [id, item] of ankiwebJobs) if (Date.now() - item.startedAt > 30 * 60 * 1000 && item.status !== "downloading" && item.status !== "importing") ankiwebJobs.delete(id);
  (async () => {
    try {
      const { info, bytes } = await downloadSharedDeck(sharedId, {
        maxBytes: MAX_ANKI_UPLOAD_BYTES,
        onProgress: (received, total) => { job.received = received; job.total = total; },
      });
      job.status = "importing";
      job.title = info.title;
      const result = storeAnkiPackage(bytes, {
        id: `ankiweb-${sharedId}`,
        name: info.title || undefined,
        source: "ankiweb",
        sharedId: String(sharedId),
        description: htmlToText(info.description).slice(0, 2000),
      });
      Object.assign(job, { status: "done", result });
    } catch (error) {
      Object.assign(job, { status: "error", error: error.message || "Download failed" });
    }
  })();
  return job;
}

function ankiwebJobPayload(job, { includeResult = false } = {}) {
  return {
    id: job.id,
    sharedId: job.sharedId,
    status: job.status,
    received: job.received,
    total: job.total,
    title: job.title || "",
    error: job.error || null,
    ...(includeResult && job.result ? { deck: job.result.deck, cards: job.result.cards, media: job.result.media } : {}),
  };
}

async function handleLearningStoreApi(req, res, url) {
  const { pathname } = url;
  if (pathname === "/api/anki/decks") {
    if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
    json(res, 200, { decks: ankiStore.listDecks() });
    return true;
  }
  let match = /^\/api\/anki\/decks\/([a-z0-9-]{1,64})(?:\/(render))?$/.exec(pathname);
  if (match) {
    const [, deckId, action] = match;
    if (action === "render") {
      if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
      const rendered = ankiStore.render(deckId, url.searchParams.get("note") || "", url.searchParams.get("ord") || 0, { deckName: url.searchParams.get("deck") || "" });
      if (!rendered) json(res, 404, { error: "Card not found in the stored deck" });
      else json(res, 200, rendered);
      return true;
    }
    if (req.method === "GET") {
      const deck = ankiStore.getDeck(deckId);
      if (!deck) json(res, 404, { error: "Deck not found" });
      else json(res, 200, { deck });
      return true;
    }
    if (req.method === "DELETE") {
      ankiStore.deleteDeck(deckId);
      res.writeHead(204, { "Cache-Control": "no-store" });
      res.end();
      return true;
    }
    return methodNotAllowed(res, ["GET", "DELETE"]);
  }
  match = /^\/api\/anki\/media\/([a-z0-9-]{1,64})\/([^/]{1,400})$/.exec(pathname);
  if (match) {
    if (req.method !== "GET" && req.method !== "HEAD") return methodNotAllowed(res, ["GET", "HEAD"]);
    serveAnkiMedia(req, res, match[1], match[2]);
    return true;
  }
  if (pathname === "/api/anki/presets") {
    if (req.method === "GET") {
      const language = String(url.searchParams.get("language") || "").toUpperCase();
      const glosses = await loadGlosses(language);
      json(res, 200, {
        language,
        available: Boolean(glosses?.length),
        sizes: PRESET_WORD_SIZES.map((size) => ({ size, cards: (glosses || []).filter((row) => row.rank <= size).length })),
      });
      return true;
    }
    if (req.method !== "POST") return methodNotAllowed(res, ["GET", "POST"]);
    const body = await readJsonBody(req);
    const language = String(body.language || "").toUpperCase();
    const { meta, collection } = await presetDeck({ language, languageName: String(body.languageName || "").slice(0, 40), size: Number(body.size), romanize: romanizeSubtitleLine });
    json(res, 200, ankiStore.saveDeck(meta, collection, { replace: false }));
    return true;
  }
  if (pathname === "/api/ankiweb/search") {
    if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
    const query = String(url.searchParams.get("q") || "").trim();
    if (!query) {
      json(res, 400, { error: "A search is required" });
      return true;
    }
    const decks = await searchSharedDecks(query);
    json(res, 200, { query, stale: Boolean(decks.stale), decks: decks.slice(0, Math.max(1, Math.min(100, Number(url.searchParams.get("limit")) || 40))) });
    return true;
  }
  match = /^\/api\/ankiweb\/decks\/(\d{1,12})(?:\/(download))?$/.exec(pathname);
  if (match) {
    const sharedId = Number(match[1]);
    if (match[2] === "download") {
      if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
      json(res, 202, ankiwebJobPayload(startAnkiwebDownload(sharedId)));
      return true;
    }
    if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
    const { downloadKey, ...info } = await sharedDeckInfo(sharedId);
    void downloadKey;
    json(res, 200, { ...info, description: htmlToText(info.description).slice(0, 3000), stored: Boolean(ankiStore.getDeck(`ankiweb-${sharedId}`)) });
    return true;
  }
  match = /^\/api\/ankiweb\/jobs\/([0-9a-f-]{36})$/.exec(pathname);
  if (match) {
    if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
    const job = ankiwebJobs.get(match[1]);
    if (!job) json(res, 404, { error: "Download not found" });
    else json(res, 200, ankiwebJobPayload(job, { includeResult: url.searchParams.get("result") === "1" }));
    return true;
  }
  if (pathname === "/api/clips") {
    if (req.method === "GET") {
      json(res, 200, {
        clips: clipStore.list({
          kind: ["card", "dictation"].includes(url.searchParams.get("kind")) ? url.searchParams.get("kind") : "",
          lang: String(url.searchParams.get("lang") || "").slice(0, 8),
          libraryId: /^[a-f0-9]{40}$/i.test(url.searchParams.get("library") || "") ? url.searchParams.get("library") : "",
          fileIndex: url.searchParams.get("file"),
          limit: Number(url.searchParams.get("limit")) || 400,
        }),
        stats: clipStore.stats(),
      });
      return true;
    }
    if (req.method !== "POST") return methodNotAllowed(res, ["GET", "POST"]);
    if (!ffmpegPath) {
      json(res, 503, { error: "Bundled FFmpeg binary is unavailable" });
      return true;
    }
    const body = await readJsonBody(req);
    const session = getTorrentSession(String(body.sessionId || ""));
    const fileIndex = boundedInteger(body.fileIndex, 0, MAX_TORRENT_FILES);
    if (!session || fileIndex === undefined || !/^[a-f0-9]{40}$/i.test(String(body.libraryId || "")) || !session.torrent?.files?.[fileIndex]) {
      json(res, 400, { error: "A playing torrent session, its file and a library id are required" });
      return true;
    }
    const created = await clipStore.create({ ...body, fileIndex });
    const totals = clipStore.stats();
    if ((totals.card?.bytes || 0) + (totals.dictation?.bytes || 0) > storage.limits().clipBytes) collectClipGarbage();
    json(res, 200, created);
    return true;
  }
  match = /^\/api\/clips\/([a-f0-9]{24})(?:\/(audio|image|video))?$/.exec(pathname);
  if (match) {
    const [, id, kind] = match;
    if (kind) {
      if (req.method !== "GET" && req.method !== "HEAD") return methodNotAllowed(res, ["GET", "HEAD"]);
      if (kind !== "image") await clipStore.prepare(id);
      const found = clipStore.file(id, kind);
      if (!found) json(res, 404, { error: "Clip not found" });
      else sendStoredFile(req, res, found, { cacheControl: "private, max-age=31536000, immutable" });
      return true;
    }
    if (req.method === "DELETE") {
      clipStore.remove(id);
      res.writeHead(204, { "Cache-Control": "no-store" });
      res.end();
      return true;
    }
    if (req.method !== "GET") return methodNotAllowed(res, ["GET", "DELETE"]);
    const clip = await clipStore.prepare(id);
    if (!clip) json(res, 404, { error: "Clip not found" });
    else json(res, 200, clip);
    return true;
  }
  return false;
}

// Card clips stay while a card points at them; everything stays within the saved-lines budget.
function collectClipGarbage() {
  try {
    const cards = appDatabase.readSection("cards") || [];
    const referenced = cards.map((card) => card?.clipId).filter(Boolean);
    const result = storage.enforceClips(referenced);
    if (result.demoted || result.removed) console.log(`Clips: ${result.demoted} released from cards, ${result.removed} removed (budget)`);
  } catch (error) {
    console.warn("Clip housekeeping failed:", error.message);
  }
}
setTimeout(collectClipGarbage, 30_000).unref?.();
setInterval(collectClipGarbage, 6 * 60 * 60 * 1000).unref?.();

// Player storage: downloads you aren't watching go first when the limit is reached.
let enforcingPlayerStorage = false;
async function enforcePlayerStorage() {
  if (enforcingPlayerStorage) return;
  enforcingPlayerStorage = true;
  try {
    const result = await storage.enforcePlayer();
    if (result.evicted.length) console.log(`Player storage: freed ${result.evicted.length} download(s) to stay under ${Math.round(result.limitBytes / 1024 ** 3)} GB`);
  } catch (error) {
    console.warn("Player storage check failed:", error.message);
  } finally {
    enforcingPlayerStorage = false;
  }
}
setInterval(() => { void enforcePlayerStorage(); }, 30_000).unref?.();

async function handleStorageApi(req, res, url) {
  const { pathname } = url;
  if (pathname === "/api/storage") {
    if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
    json(res, 200, await storage.report());
    return true;
  }
  if (pathname === "/api/storage/limits") {
    if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
    const body = await readJsonBody(req);
    if (body.remuxCacheEnabled !== undefined && typeof body.remuxCacheEnabled !== "boolean") {
      json(res, 400, { error: "remuxCacheEnabled must be a boolean" });
      return true;
    }
    const gb = (value) => (value === undefined || value === null || value === "" ? undefined : Number(value) * 1024 ** 3);
    // A budget reduction can delete saved learning clips on the next cleanup.
    // Require an explicit, reviewed second request before applying that change.
    const clipBytes = gb(body.clipGB);
    if (Number.isFinite(clipBytes) && clipBytes < storage.limits().clipBytes) {
      const preview = await storage.report();
      if (clipBytes < preview.clips.usedBytes && body.confirmClipEviction !== true) {
        json(res, 409, {
          error: "clip_budget_confirmation_required",
          message: "Reducing this limit could remove saved learning clips. Confirm the change to continue.",
          usedBytes: preview.clips.usedBytes,
          requestedBytes: clipBytes,
          clipCount: preview.clips.cardCount + preview.clips.dictationCount,
        });
        return true;
      }
    }
    storage.setLimits({
      playerBytes: gb(body.playerGB), clipBytes: gb(body.clipGB),
      remuxCacheEnabled: body.remuxCacheEnabled,
    });
    if (body.remuxCacheEnabled === false) await remuxSegmentCache.purgeIdle();
    if (body.remuxCacheEnabled === false) await indexedVideoCache.purgeAll();
    if (body.remuxCacheEnabled === false) {
      progressiveStarts.clear();
      progressiveIslandStarts.clear();
      closeProgressiveReadyListeners();
      await progressiveIndexCache.purgeAll();
    }
    await enforcePlayerStorage();
    collectClipGarbage();
    json(res, 200, await storage.report());
    return true;
  }
  if (pathname === "/api/storage/clear-player" || pathname === "/api/storage/clear-leftovers") {
    if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
    const result = pathname.endsWith("leftovers") ? await storage.clearLeftovers() : await storage.clearPlayer();
    json(res, 200, { ...result, report: await storage.report() });
    return true;
  }
  return false;
}

// Recommendations: picks and settings, linked accounts, your ratings and the export.
async function handleRecsApi(req, res, url) {
  const { pathname } = url;
  const post = async (work) => {
    if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
    json(res, 200, await work(await readJsonBody(req)));
    return true;
  };
  if (pathname === "/api/recs") {
    if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
    json(res, 200, recs.overview());
    return true;
  }
  if (pathname === "/api/recs/refresh") {
    if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
    const running = recs.status().running;
    // Answers right away; the page polls /api/recs while the refresh runs.
    recs.refresh({ trigger: "manual" }).catch((error) => console.warn("Recommendations refresh failed:", error.message));
    json(res, 202, { ...recs.overview(), alreadyRunning: Boolean(running) });
    return true;
  }
  if (pathname === "/api/recs/settings") return post((body) => recs.updateSettings({ mode: body.mode, intervalDays: body.intervalDays }));
  if (pathname === "/api/recs/anilist/link") return post((body) => recs.linkAniList(body.username));
  if (pathname === "/api/recs/anilist/authenticated") {
    if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
    json(res, 200, recs.linkAuthenticatedAniList(await readJsonBody(req, 8 * 1024 * 1024)));
    return true;
  }
  if (pathname === "/api/recs/anilist/sync") return post(() => recs.syncAniList());
  if (pathname === "/api/recs/anilist/unlink") return post(() => recs.unlinkAniList());
  if (pathname === "/api/recs/anilist/library") {
    if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
    json(res, 200, await recs.anilistLibrary());
    return true;
  }
  if (pathname === "/api/recs/tmdb") return post((body) => recs.setTmdbKey(body.key));
  if (pathname === "/api/recs/letterboxd/link") return post((body) => recs.linkLetterboxd(body.username));
  if (pathname === "/api/recs/letterboxd/unlink") return post(() => recs.unlinkLetterboxd());
  if (pathname === "/api/recs/letterboxd/import") {
    if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
    const body = await readBinaryBody(req, 40 * 1024 * 1024);
    if (!body.length) {
      json(res, 400, { error: "No file was received" });
      return true;
    }
    json(res, 200, recs.importLetterboxd(body));
    return true;
  }
  if (pathname === "/api/recs/hide") return post((body) => recs.hide(body.itemId));
  if (pathname === "/api/recs/unhide-all") return post(() => recs.unhideAll());
  if (pathname === "/api/recs/clear-cache") return post(() => recs.clearCache());
  if (pathname === "/api/recs/export") {
    if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
    const csv = url.searchParams.get("format") === "csv";
    const stamp = new Date().toISOString().slice(0, 10);
    const payload = Buffer.from(csv ? ratingsCsv(recsStore) : `${JSON.stringify(exportRecsData(recsStore), null, 2)}\n`, "utf8");
    res.writeHead(200, {
      "Content-Type": csv ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="lvl-${csv ? "ratings" : "recommendations"}-${stamp}.${csv ? "csv" : "json"}"`,
      "Content-Length": payload.length,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(payload);
    return true;
  }
  if (pathname === "/api/ratings") {
    if (req.method === "GET") {
      json(res, 200, recs.titleRatings({
        catalogId: String(url.searchParams.get("catalogId") || "").slice(0, 20),
        seriesKey: String(url.searchParams.get("key") || "").slice(0, 300),
        title: String(url.searchParams.get("title") || "").slice(0, 300),
        year: Number(url.searchParams.get("year")) || null,
      }));
      return true;
    }
    return post((body) => recs.rate(body));
  }
  return false;
}

async function exportAnkiDeck(req, res) {
  const body = await readJsonBody(req, 96 * 1024 * 1024);
  const cards = Array.isArray(body?.cards) ? body.cards : [];
  if (!cards.length) {
    json(res, 400, { error: "No cards to export" });
    return;
  }
  const deckName = String(body.deckName || "LVL").replace(/[\r\n]+/g, " ").trim().slice(0, 120) || "LVL";
  const stamp = new Date().toISOString().slice(0, 10);
  const text = body.format === "txt";
  const payload = text ? Buffer.from(buildAnkiText(cards, { deckName }), "utf8") : buildAnkiPackage(cards, { deckName });
  res.writeHead(200, {
    "Content-Type": text ? "text/plain; charset=utf-8" : "application/zip",
    "Content-Disposition": `attachment; filename="lvl-${stamp}.${text ? "txt" : "apkg"}"`,
    "Content-Length": payload.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(payload);
}

async function serveRemuxWarmWindow(req,res,session,fileIndex,requestUrl){
  if(req.method!=="GET")return methodNotAllowed(res,["GET"]);
  if(!session.torrent?.files?.[fileIndex]){
    json(res,404,{error:"Torrent video unavailable"});return;
  }
  const producerToken=requestUrl.searchParams.get("producer")||"";
  const start=requestUrl.searchParams.get("start")||"";
  if(!/^[a-f0-9]{48}$/.test(producerToken)||!/^(?:0|[1-9]\d{0,5})(?:\.\d{1,3})?$/.test(start)){
    json(res,400,{error:"Invalid cached window request"});return;
  }
  const window=await remuxSegmentCache.lookupWarmWindow({
    sessionId:session.id,fileIndex,sourceIdentity:session.infoHash,
    producerToken,startSeconds:Number(start),maxWindowBytes:16*1024*1024,
  });
  if(!window){json(res,404,{error:"Warm remux window unavailable"});return;}
  async function* segments(){
    for(const range of window.ranges){
      for(let offset=range.start;offset<=range.end;){
        const buffer=Buffer.allocUnsafe(Math.min(64*1024,range.end-offset+1));
        const {bytesRead}=await window.handle.read(buffer,0,buffer.length,offset);
        if(bytesRead<=0)throw Error('Warm remux window was truncated');
        offset+=bytesRead;
        yield buffer.subarray(0,bytesRead);
      }
    }
  }
  try{
    if(res.destroyed||res.writableEnded)return;
    res.writeHead(200,{
      "Content-Type":"video/mp4","Content-Length":String(window.bytes),
      "Cache-Control":"no-store","Accept-Ranges":"none",
      "X-Content-Type-Options":"nosniff",
      "X-LVL-Window-Base-Seconds":String(window.baseSeconds),
      "X-LVL-Window-Start-Seconds":String(window.windowStartSeconds),
      "X-LVL-Window-End-Seconds":String(window.windowEndSeconds),
      "X-LVL-Window-Producer":window.producerToken,
      "X-LVL-Window-Source-Generation":window.sourceGeneration,
    });
    trackOpenStream(session,res,fileIndex);
    await pipeline(Readable.from(segments()),res);
  }catch{
    if(!res.destroyed)res.destroy();
  }finally{
    await window.release();
  }
}

async function transcodeTorrentFile(req, res, session, fileIndex, requestUrl = null) {
  const traceToken = typeof playbackTrace !== "undefined" ? playbackTrace.captureToken(session.id, fileIndex) : null;
  const tracing = Boolean(traceToken);
  const file = session.torrent.files[fileIndex];
  if (!file) {
    json(res, 404, { error: "Torrent file not found" });
    return;
  }
  if (!VIDEO_EXTENSIONS.has(path.extname(file.name).toLowerCase())) {
    json(res, 415, { error: "Selected torrent file is not a supported video file" });
    return;
  }
  if (Number(file.length) > MAX_TORRENT_VIDEO_BYTES) {
    json(res, 413, { error: `Selected video is too large (max ${Math.round(MAX_TORRENT_VIDEO_BYTES / 1024 / 1024 / 1024)} GB)` });
    return;
  }
  if (rejectOversizeVideo(res, file)) return;
  if (!ffmpegPath) {
    json(res, 503, { error: "Bundled FFmpeg binary is unavailable" });
    return;
  }
  let media = getCachedMediaProbe(session.id, fileIndex);
  // Do not block playback startup on FFprobe. Duration is loaded by the client
  // independently and cached for later requests; FFmpeg can start immediately.

  let sourceUrl = `http://127.0.0.1:${port}/api/torrents/${encodeURIComponent(session.id)}/files/${fileIndex}/stream`;
  const requestedStart = Number(requestUrl?.searchParams?.get("start") || 0);
  const requestedAudio = Number(requestUrl?.searchParams?.get("audio") || 0);
  const maximumStart = media?.durationSeconds ? Math.max(0, Number(media.durationSeconds) - 0.25) : requestedStart;
  const startSeconds = Number.isFinite(requestedStart) && requestedStart > 0
    ? Math.max(0, Math.min(requestedStart, maximumStart))
    : 0;
  const truthyParam = (name) => /^(?:1|true|yes)$/i.test(String(requestUrl?.searchParams?.get(name) || ""));
  const requestedVideoMode = requestUrl?.searchParams?.get("video") || "auto";
  // Explicit copy must never quietly turn a seeked HDR source into SDR just
  // because media metadata is not yet cached when the video is reopened.
  if (startSeconds > 0 && requestedVideoMode === "copy" && !media) {
    try { media = await probeTorrentFile(session, fileIndex); }
    catch (error) {
      if (!res.destroyed && !res.writableEnded) json(res, error.statusCode || 422, { error: "Cannot verify source compatibility for copied-video seeking" });
      return;
    }
  }
  const audioTracks = Array.isArray(media?.audioTracks) ? media.audioTracks : [];
  const audioTrackOrder = Number.isInteger(requestedAudio) && requestedAudio >= 0 && requestedAudio < Math.max(1, audioTracks.length)
    ? requestedAudio
    : 0;
  const plan = createTranscodePlan(media, {
    fileName: file.name,
    startSeconds,
    audioTrackOrder,
    audioMode: requestUrl?.searchParams?.get("audioMode") || (truthyParam("surround") ? "surround" : "stereo"),
    videoMode: requestedVideoMode,
    clientHevc: truthyParam("hevc"),
    clientAv1: truthyParam("av1"),
  });
  if (tracing) playbackTrace.plan(session.id, fileIndex, {
    videoMode: plan.video.mode, videoReason: plan.video.fallbackReason,
    sourceVideoCodec: plan.video.sourceCodec, audioMode: plan.audio.mode,
    audioReason: plan.audio.reason, audioOutputCodec: plan.audio.outputCodec,
    audioOutputChannels: plan.audio.channels, startSeconds,
  }, traceToken);
  if (startSeconds > 0 && requestedVideoMode === "copy" && plan.video.hdrKind && plan.video.mode !== "copy") {
    json(res, 422, { error: "This HDR video cannot be safely copied with the requested browser codec capabilities" });
    return;
  }
  let effectiveStartSeconds = startSeconds;
  if (startSeconds > 0 && plan.video.mode === "copy") {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    req.once("aborted", cancel);
    res.once("close", cancel);
    try {
      const origin = await copiedSeekOrigin(session, fileIndex, startSeconds, controller.signal);
      effectiveStartSeconds = origin.effectiveStartSeconds;
    } catch (error) {
      if (!controller.signal.aborted && !res.destroyed && !res.writableEnded)
        json(res, error.statusCode && error.statusCode !== 499 ? error.statusCode : 422,
          { error: "Copied-video source clock could not be verified; video was not downgraded" });
      return;
    } finally {
      req.off("aborted", cancel);
      res.off("close", cancel);
    }
  }
  // In copied-video mode -noaccurate_seek retains the preceding GOP for both
  // streams. -t must cover that preroll, or audio gets cut before the final
  // video frames near EOF. Keep -ss at the requested time: changing it to the
  // keyframe origin alters FFmpeg's seek and breaks verified A/V alignment.
  const durationOrigin = plan.video.mode === "copy" ? effectiveStartSeconds : startSeconds;
  const remainingDuration = media?.durationSeconds ? Math.max(0.25, Number(media.durationSeconds) - durationOrigin) : null;
  const videoFilter = transcodeVideoFilter(plan);
  const videoEncoder = plan.video.mode === "copy" ? "copy" : await videoTranscodeEncoder();
  if (res.destroyed || res.writableEnded) return;
  // Fragment caches are strictly bound to their exact validated movie clock,
  // source, audio track and FFmpeg plan. Only an EOF-verified complete fMP4 is
  // safe for a native HTMLMediaElement replay. Partial moofs stay internal.
  let remuxIdentity = plan.video.mode === "copy" ? {
    sessionId: session.id, sourceIdentity: session.infoHash, fileIndex,
    sourceLength: Number(file.length), startSeconds, effectiveStartSeconds,
    remainingDuration, videoMode: plan.video.mode,
    videoCodec: plan.video.sourceCodec || "unknown", videoTag: plan.video.tag || null,
    audioTrack: audioTrackOrder, audioMode: plan.audio.mode,
    audioCodec: plan.audio.codec, audioChannels: plan.audio.channels,
    audioBitrate: plan.audio.bitRate || null, audioFilter: plan.audio.codec === "copy" ? null : "aresample=async=1",
  } : null;
  // Only short, fully downloaded, FFprobe-verified 8-bit SDR conversions may
  // save an exact-plan H264/AAC output for replay on a repeat request. The
  // recorder verifies complete EOF and the shared cache enforces a hard
  // per-record 64MiB cap. This never authorizes an HEVC/HDR MSE warm seek.
  let encodedAdmission = null;
  if (!remuxIdentity && startSeconds > 0 && plan.video.mode === "h264"
    && videoEncoder === "libx264" && media?.durationSeconds
    && remainingDuration > 0 && remainingDuration <= 180
    && typeof storage !== "undefined"
    && typeof isTorrentFileFullyVerified === "function"
    && storage.limits().remuxCacheEnabled === true
    && isTorrentFileFullyVerified(session.torrent, fileIndex)) {
    const estimatedOutputBytes = Math.ceil(
      Number(file.length) * remainingDuration / Math.max(1, Number(media.durationSeconds)));
    if (Number.isSafeInteger(estimatedOutputBytes) && estimatedOutputBytes >= 4096
      && estimatedOutputBytes <= 32 * 1024 * 1024) {
      try {
        const allowance = await storage.playerCacheAllowance({
          additionalBytes: 2 * estimatedOutputBytes + 4 * 1024 * 1024,
          reservedSourceBytes: 0,
        });
        if (allowance.allowed && !res.destroyed && !res.writableEnded
          && torrentSessions.get(session.id) === session) {
          const audioFilter = plan.audio.codec === "copy" ? null
            : "asetpts=PTS-STARTPTS,aresample=async=1:first_pts=0";
          const ffmpegFingerprint = await exactFfmpegFingerprint();
          // Fingerprinting is asynchronous. A removed/replaced torrent must
          // not even acquire cache admission under a now-stale source ID.
          if (res.destroyed || res.writableEnded) return;
          if (torrentSessions.get(session.id) !== session) {
            if (!res.headersSent) json(res, 410, { error: "Source session has expired" });
            else res.destroy();
            return;
          }
          const decision = evaluateEncodedH264CacheEligibility({
            sessionId: session.id, sourceIdentity: session.infoHash, fileIndex,
            sourceLength: Number(file.length), media,
            verifiedProbe: getCachedMediaProbe(session.id, fileIndex) === media,
            plan, startSeconds, effectiveStartSeconds, remainingDuration,
            audioTrackOrder, videoEncoder,
            videoEncodingArgs: hardwareVideoEncodingArgs(videoEncoder, media.video?.height),
            videoFilter, audioFilter, ffmpegFingerprint,
            availableCacheBytes: allowance.availableBytes,
            reservedSourceBytes: 0, estimatedOutputBytes,
            activeTranscodes: activeTranscodes.size,
          });
          if (decision.eligible) {
            encodedAdmission = decision;
            remuxIdentity = decision.identity;
          }
        }
      } catch { /* Cache admission is optional; foreground playback proceeds. */ }
    }
  }
  // Computing an optional encoded-cache fingerprint can yield for an entire
  // file read. Never start a cached conversion for a session retired meanwhile.
  // Unchanged legacy non-cached routes do not acquire an extra session guard.
  if (res.destroyed || res.writableEnded) return;
  if (encodedAdmission && typeof torrentSessions !== "undefined"
    && torrentSessions.get(session.id) !== session) {
    // A session can be deleted while the optional FFmpeg binary hash is read.
    // Do not leave a still-connected HTTP request hanging indefinitely.
    if (!res.headersSent) json(res, 410, { error: "Source session has expired" });
    else res.destroy();
    return;
  }
  const outputHeaders = () => ({
    "Content-Type": "video/mp4",
    "Cache-Control": "no-store",
    "Accept-Ranges": "none",
    "X-Blackline-Transcode": `${plan.video.mode}-${plan.audio.codec}`,
    "X-Media-Video-Mode": plan.video.mode,
    "X-Media-Video-Source-Codec": plan.video.sourceCodec || "unknown",
    "X-Media-Video-Output-Codec": plan.video.mode === "copy" ? (plan.video.sourceCodec || "unknown") : "h264",
    "X-Media-Video-Encoder": videoEncoder,
    "X-Media-Video-Keyframe-Seek": plan.video.keyframeSeek ? "1" : "0",
    "X-Media-Audio-Mode": plan.audio.mode,
    "X-Media-Audio-Channels": String(plan.audio.channels),
    "X-Media-Audio-Output-Codec": plan.audio.outputCodec || "none",
    "X-Media-Audio-Output-Bitrate": plan.audio.bitRate || "original",
    "X-Media-Audio-Reason": plan.audio.reason,
    ...(plan.video.hdrKind ? { "X-Media-HDR-Source": plan.video.hdrKind } : {}),
    ...(plan.video.hdrKind ? { "X-Media-HDR-Output": plan.video.mode === "copy" ? plan.video.hdrKind : "sdr-bt709" } : {}),
    ...(plan.video.fallbackReason ? { "X-Media-Video-Fallback": plan.video.fallbackReason } : {}),
    "X-Media-Start-Seconds": String(startSeconds),
    "X-Media-Effective-Start-Seconds": String(effectiveStartSeconds),
    "X-Audio-Track-Index": String(audioTrackOrder),
    ...(media?.durationSeconds ? { "X-Media-Duration-Seconds": String(media.durationSeconds) } : {}),
  });
  if (remuxIdentity && typeof remuxSegmentCache !== "undefined") {
    // A lease pins this exact reader across concurrent session cleanup and
    // option toggles; it is released after EOF or HTTP disconnect.
    const complete = await remuxSegmentCache.openComplete(remuxIdentity);
    // A superseded seek can disconnect while the optional cache lookup
    // waits for an earlier recorder to finish. A MISS is still asynchronous:
    // without this guard the old request spawns an orphan FFmpeg after its
    // abort/close events have already fired, consuming one of only two slots.
    if (res.destroyed || res.writableEnded || req.aborted) {
      await complete?.release();
      return;
    }
    if (complete) {
      let cacheStream = null;
      try {
        if (res.destroyed || res.writableEnded) { await complete.release(); return; }
        cacheStream = complete.handle.createReadStream({ start: 0,
          end: complete.bytes - 1, autoClose: false });
        res.writeHead(200, { ...outputHeaders(), "Content-Length": String(complete.bytes),
          "X-LVL-Remux-Cache": "complete-hit" });
        trackOpenStream(session, res, fileIndex);
        // Closing the HTTP response also destroys a paused disk source.
        res.once("close", () => cacheStream.destroy());
        void pipeline(cacheStream,res).catch(() => {
          if (!res.destroyed) res.destroy();
        }).finally(() => complete.release());
        return;
      } catch {
        if (cacheStream)cacheStream.destroy();
        await complete.release();
        if (res.headersSent) { res.destroy(); return; }
      }
    }
  }
  // Recheck after ALL async cache/admission work. The client may have moved
  // to another episode or disposed this source before FFmpeg is spawned.
  if (res.destroyed || res.writableEnded || req.aborted) return;
  if (typeof torrentSessions !== "undefined" && torrentSessions.get(session.id) !== session) {
    if (!res.headersSent) json(res, 410, { error: "Source session has expired" });
    else res.destroy();
    return;
  }
  // Encoder detection is asynchronous. Two other requests can have claimed
  // slots while this request awaited it; re-check immediately before spawn.
  // A dead encoder can remain in this Set if Windows never completes its
  // ChildProcess "close" event (for example, when an auxiliary pipe stalls).
  // Reclaim only confirmed exited PIDs before rejecting an otherwise valid
  // conversion. Do not kill or unpipe any live FFmpeg.
  pruneExitedTranscodes(activeTranscodes);
  // Foreground seeks outrank offline encoding, but don't throw away a
  // half-built whole-episode rendition while a spare FFmpeg slot exists.
  // Preempt only when admission would otherwise hit the two-slot ceiling;
  // stopAll waits for actual child close before the next admission check.
  if (activeTranscodes.size >= MAX_TRANSCODE_JOBS) {
    await progressiveIndexCache.stopAll();
    if (activeTranscodes.size >= MAX_TRANSCODE_JOBS) await indexedVideoCache.stopAll();
  }
  if (activeTranscodes.size >= MAX_TRANSCODE_JOBS) {
    json(res, 429, { error: "Too many videos are being transcoded right now" });
    return;
  }
  const tagged = typeof internalTorrentSource === "function"
    ? internalTorrentSource(session, fileIndex, "conversion") : null;
  if (tagged) sourceUrl = tagged.url;
  const audioFilter = plan.audio.codec === "copy"
    ? null
    : (plan.video.mode === "copy" ? "aresample=async=1" : "asetpts=PTS-STARTPTS,aresample=async=1:first_pts=0");
  const args = [
    "-hide_banner",
    "-loglevel", "error",
    ...(tracing ? ["-progress", "pipe:2", "-stats_period", "1"] : []),
    "-nostdin",
    // Accurate input seeking discards audio until the exact requested second,
    // but stream-copy video must start at an earlier keyframe. That creates a
    // real A/V timestamp gap (often >1s after a seek/reopened paused stream).
    // Preserve the same preroll on BOTH streams when copying video; re-encoded
    // video can still use accurate seeking because FFmpeg trims both streams.
    ...(startSeconds > 0 && plan.video.mode === "copy" ? ["-noaccurate_seek"] : []),
    ...(startSeconds > 0 ? ["-ss", String(startSeconds)] : []),
    "-i", sourceUrl,
    "-map", "0:v:0",
    "-map", `0:a:${audioTrackOrder}?`,
    ...(plan.video.mode === "copy" ? ["-c:v", "copy"] : hardwareVideoEncodingArgs(videoEncoder, media?.video?.height)),
    ...(plan.video.mode === "copy"
      ? (plan.video.tag ? ["-tag:v", plan.video.tag] : [])
      : [
        "-pix_fmt", "yuv420p",
        ...(videoFilter ? ["-vf", videoFilter] : []),
        ...(encodedAdmission ? ["-force_key_frames", "expr:gte(t,n_forced*2)"] : []),
        ...(plan.video.toneMapToSdr ? ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709"] : []),
      ]),
    "-c:a", plan.audio.codec,
    ...(plan.audio.codec === "copy" ? [] : [
      "-b:a", plan.audio.bitRate,
      "-ac", String(plan.audio.channels),
      ...(audioFilter ? ["-af", audioFilter] : []),
    ]),
    ...(remainingDuration ? ["-t", String(remainingDuration)] : []),
    "-avoid_negative_ts", "make_zero",
    "-movflags", "frag_keyframe+empty_moov+default_base_moof",
    "-f", "mp4",
    "pipe:1",
    // Second output: the same audio as 16 kHz mono speech band, kept as loudness per 10 ms for
    // subtitle sync (no extra download or decode).
    ...(audioTracks.length ? [
      "-map", `0:a:${audioTrackOrder}`,
      "-vn", "-sn", "-dn",
      "-ac", "1", "-ar", String(SPEECH_SAMPLE_RATE),
      "-af", "aresample=async=1:first_pts=0,highpass=f=120,lowpass=f=4000",
      "-f", "s16le", "pipe:3",
    ] : []),
  ];

  const ffmpeg = spawn(ffmpegPath, args, {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe", "pipe"],
  });
  activeTranscodes.add(ffmpeg);
  scheduleSessionExpiry(session);
  trackOpenStream(session, res, fileIndex);
  if (audioTracks.length && ffmpeg.stdio[3]) {
    const tape = speechTapeWriter(session.id, fileIndex, audioTrackOrder, startSeconds);
    ffmpeg.stdio[3].on("data", (chunk) => tape.push(chunk));
    ffmpeg.stdio[3].once("close", () => tape.end());
    ffmpeg.stdio[3].on("error", () => {});
  }

  let stderr = "";
  let progressBuffer = "";
  ffmpeg.stderr.on("data", (chunk) => {
    if (tracing) {
      progressBuffer = (progressBuffer + chunk.toString("utf8")).slice(-4096);
      const lines = progressBuffer.split(/\r?\n/);
      progressBuffer = lines.pop() || "";
      for (const line of lines) playbackTrace.progress(session.id, line.trim(), traceToken);
    }
    if (stderr.length < 8192) stderr += chunk.toString("utf8");
  });

  const remuxRecorder = remuxIdentity && typeof remuxSegmentCache !== "undefined"
    ? remuxSegmentCache.begin(remuxIdentity,
      encodedAdmission ? { maxEntryBytes: encodedAdmission.maxOutputBytes } : undefined) : null;
  // Only verified, already fully downloaded local pieces may run independently
  // of browser HTTP backpressure. This is SAME-FFmpeg, SAME-producer-token
  // buffering, not a second torrent reader or a new conversion job. A client
  // must explicitly opt into the MSE consumer; native streams remain unchanged.
  const runAheadEligible = Boolean(remuxRecorder && truthyParam("mse")
    && plan.video.mode === "copy" && plan.video.sourceCodec === "h264"
    && plan.audio.outputCodec === "aac" && !plan.video.hdrKind
    && isTorrentFileFullyVerified(session.torrent, fileIndex));
  res.writeHead(200,{...outputHeaders(),
    ...(remuxRecorder?{"X-LVL-Remux-Producer":remuxRecorder.producerToken}:{}),
    ...(runAheadEligible?{"X-LVL-Remux-Run-Ahead":"verified-local-bounded"}:{})});
  res.flushHeaders?.();
  ffmpeg.stdout.on("error", () => res.destroy());
  if (remuxRecorder) {
    remuxRecorder.transform.on("error", () => res.destroy());
    if (runAheadEligible) {
      // The recorder sees verified fragments beyond the browser's +45s MSE
      // read limit. 96MiB of queued output is the HARD cap; once full, normal
      // backpressure pauses this very same FFmpeg and its cache writer.
      const generation = remuxRecorder.producerToken;
      const current = () => torrentSessions.get(session.id) === session
        && session.torrent?.files?.[fileIndex] === file;
      const ahead = pipeRemuxAhead({
        source:remuxRecorder.transform, response:res,sourceGeneration:generation,
        getCurrentGeneration:()=>current()?generation:null,
        isVerifiedComplete:()=>current() && file.done === true && Number(file.downloaded) === Number(file.length),
        maxBufferedBytes:96*1024*1024,
        onAbort:()=>{if(!ffmpeg.killed)ffmpeg.kill();},
      });
      if (ahead.started) {
        ffmpeg.stdout.pipe(remuxRecorder.transform);
        void ahead.done.then((result)=>{
          if(!result.completed && !res.destroyed)res.destroy();
        });
      } else ffmpeg.stdout.pipe(remuxRecorder.transform).pipe(res);
    } else ffmpeg.stdout.pipe(remuxRecorder.transform).pipe(res);
  } else ffmpeg.stdout.pipe(res);

  let cancelledByClient = false;
  let childClosed = false;
  let stopEscalation = null;
  const stop = () => {
    if (res.writableFinished || cancelledByClient) return;
    cancelledByClient = true;
    // Node unpipes a closed HTTP response but does not destroy the upstream
    // streams. A paused stdout/recorder can keep ChildProcess "close" pending
    // after FFmpeg has exited, stranding slots and incomplete cache records.
    // This teardown is ONLY for a disconnected client; successful streams
    // must keep their original pipe chain until the final MP4 atom drains.
    try { if (!ffmpeg.killed) ffmpeg.kill(); } catch { /* escalate below */ }
    stopEscalation = setTimeout(() => {
      if (!childClosed) {
        try { ffmpeg.kill("SIGKILL"); } catch { /* retain slot until close */ }
      }
    }, 2_000);
    stopEscalation.unref?.();
    ffmpeg.stdout.unpipe();
    ffmpeg.stdout.destroy();
    remuxRecorder?.transform.destroy();
    // The optional speech side-channel is another ChildProcess stdio pipe.
    // Once the movie response is cancelled its output must not pin close.
    ffmpeg.stdio[3]?.destroy();
  };
  req.once("aborted", stop);
  res.once("close", stop);

  ffmpeg.once("error", (error) => {
    tagged?.release();
    void remuxRecorder?.finish({ success: false });
    // Node may emit ChildProcess "error" before its stdio and process have
    // actually closed. Releasing the slot here could admit a replacement
    // FFmpeg while this failed child still owns pipes or file handles.
    // The "close" listener below is the sole slot-release owner.
    console.warn(`FFmpeg failed for ${file.name}:`, error.message);
    if (!res.headersSent) json(res, 500, { error: "Unable to start FFmpeg transcode" });
    else res.destroy();
  });
  ffmpeg.once("close", (code) => {
    childClosed = true;
    clearTimeout(stopEscalation);
    tagged?.release();
    if (remuxRecorder) {
      // ChildProcess close does not mean the optional Transform has finished
      // draining FFmpeg's stdout. Finalizing now can drop its final MP4 atom.
      // The recorder is optional, so never let it end the browser's response.
      const settleRecorder = () => void remuxRecorder.finish({
        success: code === 0 && !cancelledByClient
          && ffmpeg.stdout.readableEnded && remuxRecorder.transform.writableFinished,
      });
      if (remuxRecorder.transform.writableFinished || !ffmpeg.stdout.readableEnded)
        settleRecorder();
      else {
        remuxRecorder.transform.once("finish", settleRecorder);
        remuxRecorder.transform.once("close", settleRecorder);
      }
    }
    activeTranscodes.delete(ffmpeg);
    if (code && videoEncoder !== "copy" && videoEncoder !== "libx264" && !cancelledByClient) {
      failedHardwareEncoder = videoEncoder;
      console.warn(`Hardware encoder ${videoEncoder} failed; future streams will use software H.264`);
    }
    req.removeListener("aborted", stop);
    // Keep the response-close listener through the final pipe drain: a client
    // can still disconnect after the child exits while bytes remain queued.
    if (code && stderr.trim()) console.warn(`FFmpeg exited ${code} for ${file.name}: ${stderr.trim().slice(-1200)}`);
    // stdout.pipe(recorder?).pipe(res) (or the bounded run-ahead pipeline)
    // must own end-of-response. Calling res.end() at child close truncates
    // buffered fMP4 output for a slow consumer and causes media decode errors.
  });
}

function boundedInteger(value, min = 1, max = 10_000) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) return undefined;
  return number;
}

function buildSubdlSearchParams(body, { queryOverride = "", loose = false } = {}) {
  const query = String(queryOverride || (typeof body.query === "string" ? body.query : "")).trim();
  const language = typeof body.language === "string" ? body.language.trim().toUpperCase() : "";

  if (!query || query.length > 240) {
    const error = new Error("A subtitle title or release query is required");
    error.statusCode = 400;
    throw error;
  }
  if (!language || language.length > 32 || !/^[A-Z,-]+$/.test(language)) {
    const error = new Error("A valid SubDL language code is required");
    error.statusCode = 400;
    throw error;
  }

  const params = new URLSearchParams({
    film_name: query,
    languages: language,
    unpack: "1",
    releases: "1",
    subs_per_page: "30",
  });
  if (!loose) {
    if (body.type === "movie" || body.type === "tv") params.set("type", body.type);
    const season = boundedInteger(body.season, 1, 999);
    const episode = boundedInteger(body.episode, 1, 9999);
    if (season) params.set("season_number", String(season));
    if (episode) params.set("episode_number", String(episode));
  }
  return params;
}

function normalizeSubdlResults(payload, fallbackLanguage) {
  const subtitles = Array.isArray(payload?.subtitles) ? payload.subtitles : [];
  const results = [];

  for (let subtitleIndex = 0; subtitleIndex < subtitles.length && results.length < 60; subtitleIndex += 1) {
    const subtitle = subtitles[subtitleIndex] || {};
    const unpackFiles = Array.isArray(subtitle.unpack_files) && subtitle.unpack_files.length ? subtitle.unpack_files : [null];
    for (let fileIndex = 0; fileIndex < unpackFiles.length && results.length < 60; fileIndex += 1) {
      const file = unpackFiles[fileIndex];
      const resultUrl = file?.url || subtitle.url;
      if (typeof resultUrl !== "string" || !validateSubdlDownloadUrl(resultUrl)) continue;
      const label = file?.name || subtitle.name || subtitle.release_name || `Subtitle ${results.length + 1}`;
      const release = file?.release_name || subtitle.release_name || subtitle.name || "";
      const language = String(file?.language || subtitle.language || fallbackLanguage || "").toUpperCase();
      const extension = path.extname(label).slice(1).toLowerCase();
      results.push({
        id: String(file?.file_n_id || subtitle.n_id || subtitle.id || `${subtitleIndex}-${fileIndex}`),
        provider: "SubDL",
        label,
        language,
        release,
        url: resultUrl,
        format: file?.format || subtitle.format || extension || (resultUrl.toLowerCase().endsWith(".zip") ? "zip" : "srt"),
      });
    }
  }
  return results;
}

function normalizeSubtitleLanguage(value) {
  const raw = String(value || "").trim().toLowerCase();
  const map = {
    eng: "EN", spa: "ES", fre: "FR", fra: "FR", ger: "DE", deu: "DE",
    ita: "IT", por: "PT", jpn: "JA", ja: "JA", kor: "KO", ko: "KO",
    chi: "ZH", zho: "ZH", rus: "RU", dut: "NL", nld: "NL", pol: "PL", tur: "TR",
  };
  return map[raw] || raw.slice(0, 2).toUpperCase();
}

function romanizationLanguage(value) {
  const language = normalizeSubtitleLanguage(value);
  if (language === "JA" || language === "KO" || language === "ZH" || language === "RU") return language;
  return null;
}

function romanizeRussian(value) {
  const map = {
    а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "yo", ж: "zh", з: "z", и: "i", й: "y",
    к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f",
    х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
  };
  return [...String(value || "")].map((char) => {
    const lower = char.toLowerCase();
    const replacement = map[lower];
    if (replacement === undefined) return char;
    if (char === lower || !replacement) return replacement;
    return replacement[0].toUpperCase() + replacement.slice(1);
  }).join("");
}

async function getKuroshiro() {
  if (!kuroshiroPromise) {
    kuroshiroPromise = (async () => {
      const Kuroshiro = KuroshiroModule?.default || KuroshiroModule;
      const instance = new Kuroshiro();
      await instance.init(new KuromojiAnalyzer());
      return instance;
    })().catch((error) => {
      kuroshiroPromise = null;
      throw error;
    });
  }
  return kuroshiroPromise;
}

async function romanizeSubtitleLine(text, language) {
  const value = String(text || "").trim();
  if (!value) return "";
  if (language === "JA") {
    const kuroshiro = await getKuroshiro();
    return String(await kuroshiro.convert(value, { to: "romaji", mode: "spaced" })).replace(/\s+/g, " ").trim();
  }
  if (language === "KO") return String(hangulRomanization.convert(value)).replace(/\s+/g, " ").trim();
  if (language === "ZH") return String(pinyin(value, { toneType: "none" })).replace(/\s+/g, " ").trim();
  if (language === "RU") return romanizeRussian(value).replace(/\s+/g, " ").trim();
  return value;
}

async function romanizeSubtitles(req, res) {
  const body = await readJsonBody(req);
  const language = romanizationLanguage(body.language);
  const texts = Array.isArray(body.texts) ? body.texts : [];
  if (!language) {
    json(res, 400, { error: "Romanization currently supports Japanese, Korean, Chinese, and Russian text" });
    return;
  }
  if (!texts.length || texts.length > MAX_ROMANIZATION_LINES) {
    json(res, 400, { error: `Romanization accepts 1-${MAX_ROMANIZATION_LINES} subtitle lines per request` });
    return;
  }
  const normalized = texts.map((text) => String(text || "").slice(0, 4000));
  const totalBytes = normalized.reduce((sum, text) => sum + Buffer.byteLength(text), 0);
  if (totalBytes > MAX_ROMANIZATION_TEXT_BYTES) {
    json(res, 413, { error: "Romanization batch is too large" });
    return;
  }
  const romanized = [];
  for (const text of normalized) romanized.push(await romanizeSubtitleLine(text, language));
  json(res, 200, { language, romanized });
}

async function searchOpenSubtitlesStremio(body) {
  let catalogId = validateImdbId(body.catalogId);
  if (!catalogId && body.query) {
    const catalogType = body.type === "tv" ? "series" : "movie";
    const queries = [body.query, ...(Array.isArray(body.aliases) ? body.aliases : [])]
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .slice(0, 3);
    const normalizeName = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    for (const query of queries) {
      try {
        const endpoint = `${CINEMETA_ORIGIN}/catalog/${catalogType}/top/search=${encodeURIComponent(query)}.json`;
        const payload = await fetchUpstreamJson(endpoint, 8_000);
        const metas = (Array.isArray(payload.metas) ? payload.metas : [])
          .map((meta) => normalizeCatalogMeta(meta, catalogType))
          .filter(Boolean);
        const exact = metas.find((meta) => normalizeName(meta.name) === normalizeName(query));
        catalogId = (exact || metas[0])?.id || null;
        if (catalogId) break;
      } catch {}
    }
  }
  if (!catalogId) return [];
  const season = boundedInteger(body.season, 1, 999);
  const episode = boundedInteger(body.episode, 1, 9999);
  const isSeries = body.type === "tv";
  if (isSeries && (!season || !episode)) return [];
  const videoId = isSeries ? `${catalogId}:${season}:${episode}` : catalogId;
  const addonType = isSeries ? "series" : "movie";
  const upstream = await fetch(`${OPENSUBTITLES_STREMIO_ORIGIN}/subtitles/${addonType}/${videoId}.json`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!upstream.ok) return [];
  const payload = await upstream.json().catch(() => null);
  const subtitles = Array.isArray(payload?.subtitles) ? payload.subtitles : [];
  const requestedLanguages = new Set(String(body.language || "").split(",").map((value) => value.trim().toUpperCase()).filter(Boolean));
  return subtitles.slice(0, 100).flatMap((subtitle, index) => {
    const url = typeof subtitle?.url === "string" ? subtitle.url : "";
    if (!validateOpenSubtitlesDownloadUrl(url)) return [];
    const language = normalizeSubtitleLanguage(subtitle.lang);
    if (requestedLanguages.size && !requestedLanguages.has(language)) return [];
    const label = String(subtitle.subtitleFileName || subtitle.movieReleaseName || `OpenSubtitles ${index + 1}`).slice(0, 500);
    return [{
      id: String(subtitle.id || `os-${index}`),
      provider: "OpenSubtitles",
      label,
      language,
      release: String(subtitle.movieReleaseName || "").slice(0, 500),
      url,
      format: path.extname(label).slice(1).toLowerCase() || "srt",
      matchedQuery: videoId,
      matchMode: "stremio",
    }];
  });
}

function subtitleLanguageName(code) {
  const map = {
    EN: "english", ES: "spanish", FR: "french", DE: "german", IT: "italian", PT: "portuguese",
    JA: "japanese", KO: "korean", ZH: "chinese", RU: "russian", NL: "dutch", PL: "polish", TR: "turkish",
  };
  return map[normalizeSubtitleLanguage(code)] || "";
}

function normalizeWyzieResults(items) {
  const results = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (results.length >= 100) break;
    const language = normalizeSubtitleLanguage(item?.language || item?.display || "");
    const sourceName = Array.isArray(item?.source) ? item.source.join(" + ") : String(item?.source || "");
    const label = String(item?.fileName || item?.release || item?.media || `Wyzie subtitle ${results.length + 1}`).slice(0, 500);
    const url = registerRemoteSubtitleDownload({
      url: item?.url,
      label,
      language,
      provider: sourceName ? `Wyzie/${sourceName}` : "Wyzie",
    });
    if (!url || !language) continue;
    results.push({
      id: String(item?.id || `wyzie-${results.length}`),
      provider: sourceName ? `Wyzie - ${sourceName}` : "Wyzie",
      via: "Wyzie",
      label,
      language,
      release: String(item?.release || item?.matchedRelease || "").slice(0, 500),
      url,
      format: String(item?.format || path.extname(label).slice(1) || "srt").toLowerCase(),
      origin: String(item?.origin || "").slice(0, 80),
      matchedRelease: String(item?.matchedRelease || "").slice(0, 500),
      downloads: Number(item?.downloadCount) || 0,
      hearingImpaired: Boolean(item?.isHearingImpaired),
      matchMode: item?.matchedFilter ? `wyzie-${String(item.matchedFilter)}` : "wyzie",
    });
  }
  return results;
}

async function searchWyzie(body) {
  const key = optionalProviderKey(body, "wyzieKey", "WYZIE_API_KEY");
  const imdbId = validateImdbId(body.catalogId);
  if (!key || !imdbId) return [];
  const languages = String(body.language || "").split(",").map((value) => normalizeSubtitleLanguage(value).toLowerCase()).filter(Boolean);
  const season = boundedInteger(body.season, 1, 999);
  const episode = boundedInteger(body.episode, 1, 9999);
  const base = {
    imdb_id: imdbId,
    language: languages,
    key,
    ...(body.type === "tv" && season && episode ? { season, episode } : {}),
  };
  const combined = [];
  const seen = new Set();
  const append = (items) => {
    for (const item of normalizeWyzieResults(items)) {
      const fingerprint = `${item.language}|${item.label}|${item.release}|${item.provider}`.toLowerCase();
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      combined.push(item);
    }
  };
  const releaseQuery = String(body.releaseQuery || "").trim();
  if (releaseQuery) {
    try { append(await searchWyzieSubtitles({ ...base, filename: releaseQuery })); } catch {}
  }
  if (combined.length < 12 || body.forceBroad) {
    append(await searchWyzieSubtitles(base));
  }
  return combined.slice(0, 100);
}

function subSourceEpisodeMatches(item, season, episode) {
  if (!season || !episode) return true;
  const release = [
    ...(Array.isArray(item?.releaseInfo) ? item.releaseInfo : []),
    item?.commentary,
  ].filter(Boolean).join(" ");
  const paddedSeason = String(season).padStart(2, "0");
  const paddedEpisode = String(episode).padStart(2, "0");
  const exact = new RegExp(`(?:S0?${season}E0?${episode}|${season}x0?${episode})`, "i");
  if (exact.test(release)) return true;
  const pack = new RegExp(`(?:S(?:EASON)?[ ._-]*0?${season}|SEASON[ ._-]*${paddedSeason}).*(?:COMPLETE|PACK)|(?:COMPLETE|PACK).*S(?:EASON)?[ ._-]*0?${season}`, "i");
  return pack.test(release) && !new RegExp(`E(?!${paddedEpisode}\b)\d{2,3}`, "i").test(release);
}

async function searchSubSource(body) {
  const key = optionalProviderKey(body, "subsourceKey", "SUBSOURCE_API_KEY");
  if (!key) return [];
  const query = String(body.query || "").trim();
  const imdbId = validateImdbId(body.catalogId);
  if (!query && !imdbId) return [];
  const season = boundedInteger(body.season, 1, 999);
  const episode = boundedInteger(body.episode, 1, 9999);
  const headers = { Accept: "application/json", "X-API-Key": key };
  const fetchMovieItems = async (params) => {
    const response = await fetch(`${SUBSOURCE_API_ORIGIN}/movies/search?${params}`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return [];
    const payload = await response.json().catch(() => null);
    return Array.isArray(payload?.data) ? payload.data
      : Array.isArray(payload?.results) ? payload.results
        : Array.isArray(payload?.found) ? payload.found : [];
  };
  const searchParams = new URLSearchParams(imdbId
    ? { searchType: "imdb", imdb: imdbId }
    : { searchType: "text", q: query });
  if (body.type === "tv" && season) searchParams.set("season", String(season));
  let movieItems = await fetchMovieItems(searchParams);
  if (!movieItems.length && query && imdbId) {
    const fallback = new URLSearchParams({ searchType: "text", q: query });
    if (body.type === "tv" && season) fallback.set("season", String(season));
    movieItems = await fetchMovieItems(fallback);
  }
  if (!movieItems.length) return [];
  const normalizeName = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const wanted = normalizeName(query);
  const movie = movieItems.find((item) => normalizeName(item?.title || item?.name) === wanted) || movieItems[0];
  const movieId = Number(movie?.movieId ?? movie?.id);
  if (!Number.isInteger(movieId) || movieId <= 0) return [];

  const requestedLanguages = String(body.language || "").split(",").map((value) => normalizeSubtitleLanguage(value)).filter(Boolean);
  const results = [];
  for (const languageCode of requestedLanguages) {
    const languageName = subtitleLanguageName(languageCode);
    if (!languageName) continue;
    const params = new URLSearchParams({ movieId: String(movieId), language: languageName, sort: "rating", limit: "100" });
    const response = await fetch(`${SUBSOURCE_API_ORIGIN}/subtitles?${params}`, { headers, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) continue;
    const payload = await response.json().catch(() => null);
    const items = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.results) ? payload.results : [];
    for (const item of items) {
      if (results.length >= 100) break;
      if (body.type === "tv" && !subSourceEpisodeMatches(item, season, episode)) continue;
      const subtitleId = Number(item?.subtitleId ?? item?.id);
      if (!Number.isInteger(subtitleId) || subtitleId <= 0) continue;
      const release = Array.isArray(item?.releaseInfo) ? item.releaseInfo.filter(Boolean).join(" / ") : String(item?.releaseInfo || "");
      const label = String(release || item?.commentary || `SubSource ${subtitleId}`).slice(0, 500);
      const url = registerRemoteSubtitleDownload({
        url: `${SUBSOURCE_API_ORIGIN}/subtitles/${subtitleId}/download`,
        headers: { "X-API-Key": key },
        label: `${label}.zip`,
        language: languageCode,
        provider: "SubSource",
      });
      if (!url) continue;
      results.push({
        id: String(subtitleId),
        provider: "SubSource",
        label,
        language: languageCode,
        release,
        url,
        format: "zip",
        downloads: Number(item?.downloads) || 0,
        hearingImpaired: Boolean(item?.hearingImpaired),
        matchMode: "subsource",
      });
    }
  }
  return results;
}

async function searchSubtitles(req, res) {
  const body = await readJsonBody(req);
  let apiKey = null;
  try {
    apiKey = getSubdlApiKey(req, body);
  } catch (error) {
    if (error.statusCode !== 401) throw error;
  }
  const rawCandidates = [body.query, ...(Array.isArray(body.aliases) ? body.aliases : []), body.releaseQuery]
    .map((value) => String(value || "").trim())
    .filter((value, index, array) => value && value.length <= 240 && array.indexOf(value) === index)
    .slice(0, 6);
  if (!rawCandidates.length) {
    json(res, 400, { error: "A subtitle title or release query is required" });
    return;
  }

  const run = async (query, loose) => {
    const params = buildSubdlSearchParams(body, { queryOverride: query, loose });
    params.set("api_key", apiKey);
    const upstream = await fetch(`${SUBDL_API_ORIGIN}/api/v1/subtitles?${params}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "X-API-Key": apiKey,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });
    const text = await upstream.text();
    let payload;
    try { payload = JSON.parse(text); } catch { payload = null; }
    if (!upstream.ok) throw Object.assign(new Error(payload?.error || `SubDL search failed with HTTP ${upstream.status}`), { statusCode: upstream.status });
    if (!payload || payload.status === false) throw Object.assign(new Error(payload?.error || "SubDL returned an invalid search response"), { statusCode: 502 });
    return normalizeSubdlResults(payload, body.language);
  };

  const merged = [];
  const seen = new Set();
  const requestedSeason = boundedInteger(body.season, 1, 999);
  const requestedEpisode = boundedInteger(body.episode, 1, 9999);
  const episodeMatchesRequest = (item) => {
    if (body.type !== "tv" || !requestedSeason || !requestedEpisode) return true;
    const text = [item?.label, item?.release, item?.matchedRelease].filter(Boolean).join(" ");
    const matches = [
      ...text.matchAll(/\bS(\d{1,2})E(\d{1,3})\b/ig),
      ...text.matchAll(/\b(\d{1,2})x(\d{1,3})\b/ig),
    ];
    if (matches.length) return matches.some((match) => Number(match[1]) === requestedSeason && Number(match[2]) === requestedEpisode);
    const naturalEpisode = text.match(/\b(?:episode|ep)[ ._-]*(\d{1,3})\b/i);
    if (naturalEpisode) return Number(naturalEpisode[1]) === requestedEpisode;
    return true;
  };
  const append = (items, query, mode) => {
    for (const item of items) {
      if (!episodeMatchesRequest(item)) continue;
      const key = `${item.language}|${item.url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({
        ...item,
        matchedQuery: query,
        matchMode: mode,
        title: String(body.query || "").slice(0, 240),
        season: requestedSeason || null,
        episode: requestedEpisode || null,
      });
      if (merged.length >= 120) break;
    }
  };

  let firstError = null;
  if (apiKey) {
    for (let index = 0; index < rawCandidates.length && merged.length < 60; index += 1) {
      const query = rawCandidates[index];
      try {
        const strict = await run(query, false);
        append(strict, query, "episode");
        if (merged.length >= 20 && !body.forceBroad) break;
        if (!strict.length || body.animeFallback || body.forceBroad) {
          const loose = await run(query, true);
          append(loose, query, "title");
        }
      } catch (error) {
        firstError ||= error;
      }
    }
  }

  try {
    append(await searchOpenSubtitlesStremio(body), body.catalogId || body.query, "stremio");
  } catch (error) {
    firstError ||= error;
  }

  try {
    append(await searchWyzie(body), body.catalogId || body.query, "wyzie");
  } catch (error) {
    firstError ||= error;
  }

  try {
    append(await searchSubSource(body), body.catalogId || body.query, "subsource");
  } catch (error) {
    firstError ||= error;
  }

  if (!merged.length && firstError) {
    json(res, firstError.statusCode || 502, { error: firstError.message });
    return;
  }
  const providers = [
    apiKey ? "SubDL" : null,
    "OpenSubtitles",
    optionalProviderKey(body, "wyzieKey", "WYZIE_API_KEY") ? "Wyzie" : null,
    optionalProviderKey(body, "subsourceKey", "SUBSOURCE_API_KEY") ? "SubSource" : null,
  ].filter(Boolean);
  json(res, 200, { results: merged, queriesTried: rawCandidates, providers });
}

function validateSubdlDownloadUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return null;
  let url;
  try {
    url = value.startsWith("/") ? new URL(value, SUBDL_DOWNLOAD_ORIGIN) : new URL(value);
  } catch {
    return null;
  }
  if (url.origin !== SUBDL_DOWNLOAD_ORIGIN || !url.pathname.startsWith("/subtitle/")) return null;
  url.username = "";
  url.password = "";
  return url;
}

function validateOpenSubtitlesDownloadUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "https:" || !/^subs\d+\.strem\.io$/i.test(url.hostname)) return null;
  url.username = "";
  url.password = "";
  return url;
}

async function readBoundedResponse(response, maxBytes) {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) throw Object.assign(new Error("Upstream file is too large"), { statusCode: 413 });
  if (!response.body) return Buffer.alloc(0);

  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > maxBytes) {
      throw Object.assign(new Error("Upstream file is too large"), { statusCode: 413 });
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function assTimestampToVtt(value) {
  const match = String(value || "").trim().match(/^(\d+):(\d{2}):(\d{2})[.](\d{1,2})$/);
  if (!match) return null;
  const hours = String(Number(match[1])).padStart(2, "0");
  const centiseconds = Number(match[4].padEnd(2, "0").slice(0, 2));
  return `${hours}:${match[2]}:${match[3]}.${String(centiseconds * 10).padStart(3, "0")}`;
}

function assToWebVtt(text) {
  // Respect ASS event formatting and drawing mode; the old token stripper
  // exposed vector coordinates as subtitles and duplicated styled overlays.
  // Preserve visible signs in the default output (classification remains
  // available to future optional sign-vs-dialogue controls).
  return parseAssToWebVtt(text);
}

function subtitleRecord(name, data) {
  const ext = path.extname(name).toLowerCase();
  if (![".srt", ".vtt", ".ass", ".ssa"].includes(ext)) return null;
  if (data.length > MAX_SUBTITLE_TEXT_BYTES) return null;
  if (ext === ".ass" || ext === ".ssa") {
    const converted = assToWebVtt(data.toString("utf8"));
    if (!converted) return null;
    return {
      filename: `${path.basename(name, ext)}.vtt`,
      format: "vtt",
      text: converted,
      convertedFrom: ext.slice(1),
    };
  }
  return {
    filename: path.basename(name),
    format: ext.slice(1),
    text: data.toString("utf8"),
  };
}

function subtitlePreferenceScore(record, label) {
  const preferred = path.basename(String(label || "")).replace(/\.(srt|vtt)$/i, "").toLowerCase();
  if (!preferred) return 0;
  const candidate = record.filename.replace(/\.(srt|vtt)$/i, "").toLowerCase();
  if (candidate === preferred) return 100;
  if (candidate.includes(preferred) || preferred.includes(candidate)) return 50;
  const preferredWords = new Set(preferred.split(/[^a-z0-9]+/).filter((word) => word.length > 2));
  return candidate.split(/[^a-z0-9]+/).filter((word) => preferredWords.has(word)).length;
}

async function downloadSubtitle(req, res) {
  const body = await readJsonBody(req);
  const remoteMatch = typeof body.url === "string" ? /^remote:([a-f0-9]{36})$/i.exec(body.url) : null;
  if (remoteMatch) {
    pruneRemoteSubtitleDownloads();
    const remote = remoteSubtitleDownloads.get(remoteMatch[1]);
    if (!remote || remote.expiresAt <= Date.now()) {
      json(res, 404, { error: "Subtitle download token expired; search again" });
      return;
    }
    const { response: upstream, finalUrl } = await fetchRemoteSubtitleDownload(remote);
    if (!upstream.ok) {
      json(res, 502, { error: `${remote.provider} download failed with HTTP ${upstream.status}` });
      return;
    }
    const data = await readBoundedResponse(upstream, MAX_SUBTITLE_DOWNLOAD_BYTES);
    const contentType = upstream.headers.get("content-type") || "";
    const pathname = finalUrl.pathname.toLowerCase();
    const isZip = pathname.endsWith(".zip") || contentType.includes("zip") || /\.zip$/i.test(remote.label);
    if (!isZip) {
      let name = String(remote.label || body.label || path.basename(pathname) || "subtitle.srt").slice(0, 255);
      if (!/\.(srt|vtt|ass|ssa)$/i.test(name)) {
        const head = data.toString("utf8", 0, 64).trimStart();
        const extension = head.startsWith("WEBVTT") ? "vtt" : /\[Script Info\]|^Dialogue\s*:/im.test(head) ? "ass" : "srt";
        name = `${name || "subtitle"}.${extension}`;
      }
      const record = subtitleRecord(name, data);
      if (!record) {
        json(res, 415, { error: `${remote.provider} returned an unsupported subtitle file` });
        return;
      }
      json(res, 200, { ...record, language: remote.language, provider: remote.provider });
      return;
    }
    let zip;
    try { zip = new AdmZip(data); } catch {
      json(res, 422, { error: `${remote.provider} returned an invalid ZIP` });
      return;
    }
    const files = [];
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory || files.length >= MAX_SUBTITLE_FILES) continue;
      const ext = path.extname(entry.entryName).toLowerCase();
      if (![".srt", ".vtt", ".ass", ".ssa"].includes(ext) || entry.header.size > MAX_SUBTITLE_TEXT_BYTES) continue;
      const record = subtitleRecord(entry.entryName, entry.getData());
      if (record) files.push(record);
    }
    if (!files.length) {
      json(res, 422, { error: `${remote.provider} ZIP contained no supported subtitle files` });
      return;
    }
    files.sort((a, b) => subtitlePreferenceScore(b, body.label || remote.label) - subtitlePreferenceScore(a, body.label || remote.label));
    json(res, 200, { ...files[0], language: remote.language, provider: remote.provider });
    return;
  }
  const openSubtitlesUrl = validateOpenSubtitlesDownloadUrl(body.url);
  const url = openSubtitlesUrl || validateSubdlDownloadUrl(body.url);
  if (!url) {
    json(res, 400, { error: "A valid supported subtitle download URL is required" });
    return;
  }

  if (openSubtitlesUrl) {
    const upstream = await fetch(openSubtitlesUrl, {
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!upstream.ok) {
      json(res, upstream.status, { error: `OpenSubtitles download failed with HTTP ${upstream.status}` });
      return;
    }
    const data = await readBoundedResponse(upstream, MAX_SUBTITLE_DOWNLOAD_BYTES);
    const suppliedName = typeof body.label === "string" ? body.label.slice(0, 255) : "OpenSubtitles.srt";
    const name = /\.(srt|vtt|ass|ssa)$/i.test(suppliedName) ? suppliedName : `${suppliedName || "OpenSubtitles"}.srt`;
    const record = subtitleRecord(name, data);
    if (!record) {
      json(res, 415, { error: "OpenSubtitles returned an unsupported subtitle file" });
      return;
    }
    json(res, 200, record);
    return;
  }

  const apiKey = getSubdlApiKey(req, body);

  const upstream = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}`, "X-API-Key": apiKey },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!upstream.ok) {
    json(res, upstream.status, { error: `SubDL download failed with HTTP ${upstream.status}` });
    return;
  }

  const data = await readBoundedResponse(upstream, MAX_SUBTITLE_DOWNLOAD_BYTES);
  const contentType = upstream.headers.get("content-type") || "";
  const pathname = url.pathname.toLowerCase();
  const isZip = pathname.endsWith(".zip") || contentType.includes("zip");

  if (!isZip) {
    const suppliedName = typeof body.label === "string" ? body.label : typeof body.fileName === "string" ? body.fileName : typeof body.name === "string" ? body.name : "";
    let name = suppliedName.slice(0, 255) || path.basename(url.pathname) || "subtitle.srt";
    if (!/\.(srt|vtt|ass|ssa)$/i.test(name)) {
      const extension = data.toString("utf8", 0, 32).trimStart().startsWith("WEBVTT") ? "vtt" : "srt";
      name = `${name || "subtitle"}.${extension}`;
    }
    const record = subtitleRecord(name, data);
    if (!record) {
      json(res, 415, { error: "Downloaded subtitle must be SRT, VTT, ASS, or SSA" });
      return;
    }
    json(res, 200, record);
    return;
  }

  let zip;
  try {
    zip = new AdmZip(data);
  } catch {
    json(res, 422, { error: "Downloaded ZIP is invalid" });
    return;
  }

  const files = [];
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    if (files.length >= MAX_SUBTITLE_FILES) break;
    const ext = path.extname(entry.entryName).toLowerCase();
    if (![".srt", ".vtt", ".ass", ".ssa"].includes(ext)) continue;
    if (entry.header.size > MAX_SUBTITLE_TEXT_BYTES) continue;
    const record = subtitleRecord(entry.entryName, entry.getData());
    if (record) files.push(record);
  }

  if (!files.length) {
    json(res, 422, { error: "ZIP contained no bounded SRT, VTT, ASS, or SSA files" });
    return;
  }
  files.sort((a, b) => subtitlePreferenceScore(b, body.label) - subtitlePreferenceScore(a, body.label));
  json(res, 200, files[0]);
}

function validateArtworkImageUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.origin !== TVMAZE_IMAGE_ORIGIN) return null;
  return url.toString();
}

const MAX_POSTER_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_POSTER_WEBP_BYTES = 360 * 1024;
const optimizedPosterCache = new Map();
const optimizedPosterPending = new Map();

function validatedOptimizedPosterSource(value) {
  const validated = validateArtworkImageUrl(value);
  if (!validated) return null;
  const url = new URL(validated);
  return !url.search && !url.hash && /^\/uploads\/images\/original_untouched\/\d+\/\d+\.(?:jpe?g|png|webp)$/i.test(url.pathname)
    ? validated : null;
}

async function optimizedTvMazePoster(source) {
  if (!ffmpegPath) throw new Error("Poster conversion unavailable");
  const upstream = await fetch(source, { redirect: "error", signal: AbortSignal.timeout(8_000),
    headers: { Accept: "image/webp,image/jpeg,image/png", "User-Agent": "LVL/0.1" } });
  if (!upstream.ok || !/^image\/(?:jpe?g|png|webp)\b/i.test(upstream.headers.get("content-type") || ""))
    throw new Error("Artwork provider did not return a supported image");
  if (Number(upstream.headers.get("content-length")) > MAX_POSTER_SOURCE_BYTES)
    throw new Error("Artwork source exceeds the size limit");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of upstream.body) {
    bytes += chunk.length;
    if (bytes > MAX_POSTER_SOURCE_BYTES) {
      await upstream.body.cancel().catch(() => {});
      throw new Error("Artwork source exceeds the size limit");
    }
    chunks.push(chunk);
  }
  const input = Buffer.concat(chunks);
  return await new Promise((resolve, reject) => {
    const job = spawn(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-threads", "1", "-i", "pipe:0",
      "-vf", "scale='min(760,iw)':-2:flags=lanczos", "-frames:v", "1", "-c:v", "libwebp",
      "-quality", "75", "-compression_level", "4", "-f", "webp", "pipe:1"],
    { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    let size = 0;
    const output = [];
    let done = false;
    const timeout = setTimeout(() => finish(new Error("Poster conversion timed out")), 12_000);
    const finish = (error = null, result = null) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      if (error) { job.kill(); reject(error); } else resolve(result);
    };
    job.stdin.on("error", () => {});
    job.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_POSTER_WEBP_BYTES) finish(new Error("Converted poster exceeds the size limit"));
      else output.push(chunk);
    });
    job.once("error", (error) => finish(error));
    job.once("close", (code) => {
      if (code !== 0 || !size) finish(new Error("Could not convert poster"));
      else finish(null, Buffer.concat(output));
    });
    job.stdin.end(input);
  });
}

async function serveOptimizedPoster(req, res, url) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  const source = validatedOptimizedPosterSource(url.searchParams.get("src"));
  if (!source) { json(res, 400, { error: "Unsupported poster source" }); return true; }
  try {
    let image = optimizedPosterCache.get(source);
    if (!image) {
      let pending = optimizedPosterPending.get(source);
      if (!pending) {
        pending = optimizedTvMazePoster(source);
        optimizedPosterPending.set(source, pending);
      }
      try { image = await pending; } finally { optimizedPosterPending.delete(source); }
      optimizedPosterCache.delete(source);
      optimizedPosterCache.set(source, image);
      while (optimizedPosterCache.size > 24) optimizedPosterCache.delete(optimizedPosterCache.keys().next().value);
    }
    res.writeHead(200, { "Content-Type": "image/webp", "Content-Length": image.length,
      "Cache-Control": "public, max-age=86400", "X-Content-Type-Options": "nosniff" });
    res.end(image);
  } catch (error) {
    json(res, 502, { error: "Could not optimize poster" });
  }
  return true;
}

async function searchLibraryArtwork(req, res, url) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  const query = String(url.searchParams.get("q") || "").trim();
  if (!query || query.length > MAX_ARTWORK_QUERY_LENGTH) {
    json(res, 400, { error: "A short series title is required for artwork search" });
    return true;
  }

  pruneTimedCache(artworkSearchCache, 40);
  const cacheKey = query.toLowerCase();
  const cached = artworkSearchCache.get(cacheKey);
  if (cached) {
    json(res, 200, { query, results: cached.results, cached: true });
    return true;
  }

  const upstream = await fetch(`${TVMAZE_API_ORIGIN}/search/shows?q=${encodeURIComponent(query)}`, {
    headers: {
      Accept: "application/json",
      "User-Agent": "LVL/0.1",
    },
    signal: AbortSignal.timeout(8_000),
  });
  if (!upstream.ok) {
    json(res, 502, { error: `Artwork search failed with HTTP ${upstream.status}` });
    return true;
  }

  const payload = await upstream.json().catch(() => null);
  if (!Array.isArray(payload)) {
    json(res, 502, { error: "Artwork provider returned an invalid response" });
    return true;
  }

  const seen = new Set();
  const results = [];
  for (const record of payload) {
    if (results.length >= MAX_ARTWORK_RESULTS) break;
    const show = record?.show || {};
    const imageUrl = validateArtworkImageUrl(show.image?.original || show.image?.medium || "");
    if (!imageUrl || seen.has(imageUrl)) continue;
    seen.add(imageUrl);
    results.push({
      url: imageUrl,
      title: String(show.name || query).slice(0, 240),
      source: "TVMAZE",
      pageUrl: typeof show.url === "string" && /^https:\/\/www\.tvmaze\.com\//.test(show.url) ? show.url : null,
    });
  }

  artworkSearchCache.set(cacheKey, { results, expiresAt: Date.now() + ARTWORK_CACHE_TTL_MS });
  json(res, 200, { query, results, cached: false });
  return true;
}

function pruneTimedCache(cache, maxEntries = 80) {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (!entry || entry.expiresAt <= now) cache.delete(key);
  }
  while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
}

async function fetchUpstreamJson(url, timeoutMs = STREAM_UPSTREAM_TIMEOUT_MS) {
  const upstream = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "LVL/0.1",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!upstream.ok) {
    const error = new Error(`Upstream request failed with HTTP ${upstream.status}`);
    error.statusCode = 502;
    throw error;
  }
  const payload = await upstream.json().catch(() => null);
  if (!payload || typeof payload !== "object") {
    const error = new Error("Upstream provider returned invalid JSON");
    error.statusCode = 502;
    throw error;
  }
  return payload;
}

function validateCatalogType(value) {
  return value === "movie" || value === "series" ? value : null;
}

function validateImdbId(value, { allowVideoId = false } = {}) {
  const pattern = allowVideoId ? /^tt\d{5,12}(?::\d{1,3}:\d{1,4})?$/ : /^tt\d{5,12}$/;
  return typeof value === "string" && pattern.test(value) ? value : null;
}

function httpsImageUrl(value) {
  return typeof value === "string" && value.length <= 2048 && /^https:\/\//i.test(value) ? value : "";
}

function catalogRating(value) {
  const rating = Number.parseFloat(value);
  return Number.isFinite(rating) && rating > 0 && rating <= 10 ? rating.toFixed(1) : "";
}

function catalogRuntime(value) {
  const runtime = String(value ?? "").trim();
  return runtime.length <= 24 && /\d/.test(runtime) && /^[\w .:-]+$/.test(runtime) ? runtime : "";
}

function truncateCatalogText(value, maxLength) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  const cut = text.slice(0, maxLength - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s,.;:–-]+$/, "")}…`;
}

function normalizeCatalogMeta(meta, type) {
  const id = validateImdbId(meta?.id);
  if (!id) return null;
  const name = String(meta?.name || "").trim().slice(0, 240);
  if (!name) return null;
  const releaseInfo = String(meta?.releaseInfo || meta?.year || "").trim().slice(0, 80);
  return {
    id,
    type,
    name,
    poster: httpsImageUrl(meta?.poster),
    background: httpsImageUrl(meta?.background),
    logo: httpsImageUrl(meta?.logo),
    releaseInfo,
    description: String(meta?.description || "").trim().slice(0, 1200),
    genres: Array.isArray(meta?.genres) ? meta.genres.map((item) => String(item)).slice(0, 8) : [],
    imdbRating: catalogRating(meta?.imdbRating),
    runtime: catalogRuntime(meta?.runtime),
  };
}

// Home browsing payload: enough for posters, the hero billboard (backdrop, logo, synopsis) and
// card metadata. Still metadata only; torrent sources are fetched only when a user asks.
function lightweightCatalogMeta(meta, type) {
  const normalized = normalizeCatalogMeta(meta, type);
  if (!normalized) return null;
  return {
    id: normalized.id,
    type: normalized.type,
    name: normalized.name,
    poster: normalized.poster,
    background: normalized.background,
    logo: normalized.logo,
    releaseInfo: normalized.releaseInfo,
    description: truncateCatalogText(normalized.description, 360),
    genres: normalized.genres,
    imdbRating: normalized.imdbRating,
    runtime: normalized.runtime,
  };
}

function savedHomeCatalog() {
  try {
    const value = JSON.parse(appDatabase.getMeta(HOME_CATALOG_META_KEY) || "null");
    if (value && ["movies", "series", "anime"].every((key) => Array.isArray(value[key]))) {
      return value;
    }
  } catch (error) {
    console.warn("Could not read saved Home catalog:", error.message);
  }
  return null;
}

async function homeCatalog(req, res, url) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  pruneTimedCache(homeCatalogCache, 4);
  const cached = homeCatalogCache.get("home");
  const refresh = url.searchParams.get("refresh") === "1";
  if (!refresh && cached?.expiresAt > Date.now()) {
    json(res, 200, { ...cached.value, cached: true });
    return true;
  }
  const previous = cached?.value || savedHomeCatalog();
  const restoreOnStartup = !refresh && !cached && previous && !homeCatalogRestoredFromDisk;
  homeCatalogRestoredFromDisk = true;
  // Opening the app should be immediate after the catalog has loaded once, even if
  // Cinemeta is currently slow or unreachable. A later refresh can update this copy.
  if (restoreOnStartup) {
    const restored = { ...previous, stale: true };
    homeCatalogCache.set("home", { value: restored, expiresAt: Date.now() + 60_000 });
    json(res, 200, { ...restored, cached: true });
    return true;
  }

  const requests = [
    ...["movie", "series"].flatMap((type) => [0, 50].map((skip) => ({
      label: `${type} top ${skip}`,
      type,
      anime: false,
      url: CINEMETA_ORIGIN + "/catalog/" + type + "/top" + (skip ? "/skip=" + skip : "") + ".json",
    }))),
    ...["movie", "series"].map((type) => ({
      label: `${type} anime`,
      type,
      anime: true,
      url: CINEMETA_ORIGIN + "/catalog/" + type + "/top/genre=Anime.json",
    })),
  ];
  const responses = await Promise.allSettled(requests.map(({ url: endpoint }) => fetchUpstreamJson(endpoint, 8_000)));
  const groups = { movie: [], series: [], animeMovie: [], animeSeries: [] };
  let successfulRequests = 0;
  const failed = [];
  responses.forEach((response, index) => {
    const request = requests[index];
    if (response.status === "rejected") {
      failed.push(`${request.label}: ${response.reason?.message || "unavailable"}`);
      return;
    }
    const group = request.anime ? (request.type === "series" ? "animeSeries" : "animeMovie") : request.type;
    successfulRequests += 1;
    for (const meta of Array.isArray(response.value.metas) ? response.value.metas : []) {
      const normalized = lightweightCatalogMeta(meta, request.type);
      if (normalized) groups[group].push(normalized);
    }
  });
  if (failed.length) console.warn("Home catalog provider errors:", failed.join("; "));
  if (!successfulRequests && previous) {
    const restored = { ...previous, stale: true, partial: true };
    homeCatalogCache.set("home", { value: restored, expiresAt: Date.now() + 60_000 });
    json(res, 200, { ...restored, cached: true });
    return true;
  }
  const dedupe = (items, limit) => [...new Map(items.map((item) => [item.id, item])).values()].slice(0, limit);
  const allMovies = groups.movie.length ? dedupe(groups.movie, 96) : (previous?.movies || []);
  const allSeries = groups.series.length ? dedupe(groups.series, 96) : (previous?.series || []);
  const animeSeries = groups.animeSeries.length ? dedupe(groups.animeSeries, 50) : (previous?.anime || []).filter((item) => item.type === "series");
  const animeMovies = groups.animeMovie.length ? dedupe(groups.animeMovie, 50) : (previous?.anime || []).filter((item) => item.type === "movie");
  const reusedSavedTitles = Boolean(previous) && (
    (!groups.movie.length && allMovies.length > 0)
    || (!groups.series.length && allSeries.length > 0)
    || (!groups.animeSeries.length && animeSeries.length > 0)
    || (!groups.animeMovie.length && animeMovies.length > 0)
  );
  const animeTitles = dedupe([...animeSeries, ...animeMovies], 100);
  if (!allMovies.length && !allSeries.length && !animeTitles.length) {
    json(res, 503, { error: "The catalog provider is unavailable. Try again shortly." });
    return true;
  }
  const animeIds = new Set(animeTitles.map((item) => item.id));
  const movies = allMovies.filter((item) => !animeIds.has(item.id));
  const series = allSeries.filter((item) => !animeIds.has(item.id));
  const anime = animeTitles;
  const value = {
    movies,
    series,
    anime,
    seed: Math.floor(Date.now() / (10 * 60 * 1000)),
    generatedAt: Date.now(),
    refreshAfterMs: 10 * 60 * 1000,
  };
  const partial = failed.length > 0;
  value.partial = partial;
  if (reusedSavedTitles) value.stale = true;
  homeCatalogCache.set("home", { value, expiresAt: Date.now() + (partial ? 60_000 : 10 * 60 * 1000) });
  if (successfulRequests) {
    try { appDatabase.setMeta(HOME_CATALOG_META_KEY, JSON.stringify(value)); }
    catch (error) { console.warn("Could not save Home catalog:", error.message); }
  }
  json(res, 200, { ...value, cached: false, partial });
  return true;
}

async function searchCatalog(req, res, url) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  const query = String(url.searchParams.get("q") || "").trim();
  if (!query || query.length > MAX_CATALOG_QUERY_LENGTH) {
    json(res, 400, { error: "A short movie or series title is required" });
    return true;
  }
  const { results, cached } = await catalogSearchResults(query, { withCacheFlag: true });
  json(res, 200, { query, results, cached });
  return true;
}

// Public IMDb title suggestions are a fallback when Cinemeta's search is down.
// They include IMDb ids, titles, release years and posters, so the same title
// page and source lookup can operate without a separate API key.
async function imdbCatalogSearch(query) {
  const normalizedQuery = String(query).trim().toLowerCase();
  const first = normalizedQuery[0];
  const endpoint = `${IMDB_SUGGEST_ORIGIN}/${encodeURIComponent(first)}/${encodeURIComponent(normalizedQuery)}.json`;
  const payload = await fetchUpstreamJson(endpoint, 5_000);
  if (!Array.isArray(payload.d)) throw new Error("IMDb suggestions returned an invalid result");
  return payload.d.map((item) => {
    const category = `${item?.qid || ""} ${item?.q || ""}`.toLowerCase();
    const type = /(?:series|miniseries|mini series)/.test(category) ? "series"
      : /(?:movie|feature|film)/.test(category) ? "movie"
        : null;
    if (!type) return null; // Person, game, TV episode and unrelated suggestions.
    const rawPoster = httpsImageUrl(item?.i?.imageUrl);
    const poster = rawPoster.replace(/_V1_[^/]*\.(?:jpe?g)$/i, "_V1_UX300.jpg");
    return normalizeCatalogMeta({
      id: item.id, name: item.l, releaseInfo: item.y, poster,
    }, type);
  }).filter(Boolean);
}

// Cinemeta movie and series search, cached for a while.
async function catalogSearchResults(query, { withCacheFlag = false } = {}) {
  const value = String(query || "").trim().slice(0, MAX_CATALOG_QUERY_LENGTH);
  if (!value) return withCacheFlag ? { results: [], cached: false } : [];
  pruneTimedCache(catalogSearchCache, 60);
  const cacheKey = value.toLowerCase();
  const cached = catalogSearchCache.get(cacheKey);
  if (cached?.expiresAt > Date.now()) return withCacheFlag ? { results: cached.results, cached: true } : cached.results;

  const searches = ["movie", "series"].map(async (type) => {
    const endpoint = `${CINEMETA_ORIGIN}/catalog/${type}/top/search=${encodeURIComponent(value)}.json`;
    try {
      const payload = await fetchUpstreamJson(endpoint, 4_000);
      return {
        available: true,
        results: (Array.isArray(payload.metas) ? payload.metas : [])
          .map((meta) => normalizeCatalogMeta(meta, type))
          .filter(Boolean),
      };
    } catch (error) {
      console.warn(`Cinemeta ${type} search failed:`, error.message);
      return { available: false, results: [] };
    }
  });
  const responses = await Promise.all(searches);
  const providerFailures = responses.filter((response) => !response.available).length;
  let imdbAvailable = false;
  let imdbResults = [];
  if (providerFailures) {
    try {
      imdbResults = await imdbCatalogSearch(value);
      imdbAvailable = true;
    } catch (error) {
      console.warn("IMDb title suggestion fallback failed:", error.message);
    }
  }
  if (!responses.some((response) => response.available) && !imdbAvailable) {
    if (withCacheFlag) {
      const error = new Error("Title search is temporarily unavailable. Try again shortly.");
      error.statusCode = 503;
      throw error;
    }
    return [];
  }
  const combined = [...responses.flatMap((response) => response.results), ...imdbResults];
  const seen = new Set();
  const results = [];
  for (const result of combined) {
    const key = `${result.type}:${result.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(result);
    if (results.length >= MAX_CATALOG_RESULTS) break;
  }
  // Retry Cinemeta sooner after partial outages, even if the IMDb fallback succeeded.
  catalogSearchCache.set(cacheKey, { results, expiresAt: Date.now() + (providerFailures ? 60_000 : CATALOG_CACHE_TTL_MS) });
  return withCacheFlag ? { results, cached: false } : results;
}

async function getCatalogMeta(type, imdbId) {
  const endpoint = `${CINEMETA_ORIGIN}/meta/${type}/${encodeURIComponent(imdbId)}.json`;
  const payload = await fetchUpstreamJson(endpoint, 8_000);
  const meta = payload.meta;
  if (!meta || typeof meta !== "object") {
    const error = new Error("Metadata was not found for that title");
    error.statusCode = 404;
    throw error;
  }
  return meta;
}

async function catalogMeta(req, res, url) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  const type = validateCatalogType(url.searchParams.get("type"));
  const imdbId = validateImdbId(url.searchParams.get("id"));
  if (!type || !imdbId) {
    json(res, 400, { error: "A valid movie/series type and IMDb id are required" });
    return true;
  }
  const meta = await getCatalogMeta(type, imdbId);
  const normalized = {
    ...(normalizeCatalogMeta(meta, type) || { id: imdbId, type, name: String(meta.name || imdbId) }),
    ...catalogTitleDetails(meta),
  };
  if (type === "series") {
    const seasons = new Map();
    for (const video of Array.isArray(meta.videos) ? meta.videos : []) {
      const season = Number(video.season);
      const episode = Number(video.episode ?? video.number);
      const videoId = validateImdbId(video.id, { allowVideoId: true });
      if (!Number.isInteger(season) || season < 0 || !Number.isInteger(episode) || episode < 1 || !videoId) continue;
      const record = seasons.get(season) || { season, count: 0, episodes: [] };
      record.count += 1;
      if (record.episodes.length < MAX_SEASON_LIST_EPISODES) record.episodes.push(catalogEpisodeRecord(video, videoId, episode));
      seasons.set(season, record);
    }
    normalized.seasons = [...seasons.values()]
      .map((record) => ({ ...record, episodes: record.episodes.sort((a, b) => a.episode - b.episode) }))
      .sort((a, b) => a.season - b.season);
  }
  json(res, 200, { meta: normalized });
  return true;
}

// One chapter of a series for the chapter list: metadata only, no torrent lookups.
function catalogEpisodeRecord(video, videoId, episode) {
  const released = String(video.released || video.firstAired || "").match(/^\d{4}-\d{2}-\d{2}/)?.[0] || "";
  return {
    id: videoId,
    episode,
    name: String(video.name || video.title || `Episode ${episode}`).replace(/\s+/g, " ").trim().slice(0, 240) || `Episode ${episode}`,
    released,
    thumbnail: httpsImageUrl(video.thumbnail),
    overview: truncateCatalogText(video.overview || video.description || "", 900),
    rating: catalogRating(video.rating),
  };
}

function parseStreamPeers(text) {
  const match = String(text || "").match(/👤\s*([\d,]+)/u);
  return match ? Number(match[1].replaceAll(",", "")) || 0 : 0;
}

function parseStreamSizeBytes(text) {
  const match = String(text || "").match(/💾\s*([\d.]+)\s*(TB|GB|MB|KB)/iu);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const scale = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }[match[2].toUpperCase()];
  return Math.round(value * scale);
}

function detectStreamQuality(text) {
  return qualityLabel(releaseVideoHeight(text)) || "UNKNOWN";
}

function detectStreamCodec(text) {
  const value = String(text || "").toLowerCase();
  if (/\b(?:av1)\b/.test(value)) return "AV1";
  if (/\b(?:x265|h\.?265|hevc)\b/.test(value)) return "HEVC";
  if (/\b(?:x264|h\.?264|avc)\b/.test(value)) return "H264";
  return "UNKNOWN";
}

function detectStreamAudioLanguages(text) {
  const value = String(text || "");
  const lower = value.toLowerCase();
  const languages = new Set();
  const add = (name) => languages.add(name);
  const flagMap = [
    ["🇬🇧", "English"], ["🇺🇸", "English"], ["🇨🇦", "English"],
    ["🇪🇸", "Spanish"], ["🇲🇽", "Spanish"], ["🇦🇷", "Spanish"],
    ["🇫🇷", "French"], ["🇮🇹", "Italian"], ["🇩🇪", "German"],
    ["🇵🇹", "Portuguese"], ["🇧🇷", "Portuguese"], ["🇯🇵", "Japanese"],
    ["🇰🇷", "Korean"], ["🇨🇳", "Chinese"], ["🇹🇼", "Chinese"],
    ["🇷🇺", "Russian"], ["🇳🇱", "Dutch"], ["🇵🇱", "Polish"],
    ["🇹🇷", "Turkish"], ["🇨🇿", "Czech"], ["🇭🇺", "Hungarian"],
    ["🇩🇰", "Danish"], ["🇸🇪", "Swedish"], ["🇳🇴", "Norwegian"],
  ];
  for (const [flag, name] of flagMap) if (value.includes(flag)) add(name);
  const tokenRules = [
    [/\b(?:english|eng)\b/i, "English"],
    [/\b(?:spanish|spa|castellano|latino)\b/i, "Spanish"],
    [/\b(?:french|fre|fra|vff|vfq)\b/i, "French"],
    [/\b(?:italian|ita)\b/i, "Italian"],
    [/\b(?:german|ger|deu)\b/i, "German"],
    [/\b(?:portuguese|por|pt-br|ptbr)\b/i, "Portuguese"],
    [/\b(?:japanese|jpn)\b/i, "Japanese"],
    [/\b(?:korean|kor)\b/i, "Korean"],
    [/\b(?:chinese|chi|zho|mandarin)\b/i, "Chinese"],
    [/\b(?:russian|rus)\b/i, "Russian"],
  ];
  for (const [pattern, name] of tokenRules) if (pattern.test(lower)) add(name);
  return [...languages].slice(0, 8);
}

function streamRankScore(stream) {
  const height = Number(stream.height) || heightFromQualityLabel(stream.quality) || 0;
  const qualityScore = !height ? 100
    : height >= 2000 ? 430
      : height >= 1300 ? 480
        : height >= 1000 ? 520
          : height >= 780 ? 420
            : height >= 700 ? 340
              : 160;
  const codecScore = { H264: 170, UNKNOWN: 45, HEVC: 10, AV1: -30 }[stream.codec] || 0;
  const peersScore = Math.min(220, Math.round(Math.log2(Math.max(1, stream.peers) + 1) * 24));
  let sizeScore = 0;
  if (stream.sizeBytes) {
    const gb = stream.sizeBytes / (1024 ** 3);
    if (gb <= 1) sizeScore = -20;
    else if (gb <= 6) sizeScore = 80;
    else if (gb <= 14) sizeScore = 35;
    else if (gb <= 30) sizeScore = -30;
    else sizeScore = -110;
  }
  return qualityScore + codecScore + peersScore + sizeScore;
}

function streamMagnet(infoHash, stream) {
  const filename = String(stream?.behaviorHints?.filename || "").trim();
  const firstTitleLine = String(stream?.title || "").split("\n")[0].trim();
  const displayName = (filename || firstTitleLine).slice(0, 240);
  const parts = [`xt=urn:btih:${infoHash}`];
  if (displayName) parts.push(`dn=${encodeURIComponent(displayName)}`);
  const trackers = new Set(FALLBACK_TRACKERS);
  const sources = Array.isArray(stream?.sources) ? stream.sources : [];
  for (const source of sources) {
    const tracker = typeof source === "string" && source.startsWith("tracker:") ? source.slice(8).trim() : "";
    if (/^(?:udp|https?):\/\//i.test(tracker)) trackers.add(tracker);
  }
  for (const tracker of trackers) parts.push(`tr=${encodeURIComponent(tracker)}`);
  return `magnet:?${parts.join("&")}`;
}

function normalizeProviderStream(stream, provider) {
  const infoHash = String(stream?.infoHash || "").trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(infoHash)) return null;
  const title = String(stream?.title || stream?.name || "Torrent source").trim().slice(0, 1400);
  const label = String(stream?.name || provider.name).trim().slice(0, 160);
  const combined = `${label}\n${title}\n${stream?.behaviorHints?.filename || ""}`;
  const result = {
    infoHash,
    magnet: streamMagnet(infoHash, stream),
    provider: provider.name,
    providers: [provider.name],
    title,
    label,
    fileIdx: Number.isInteger(stream?.fileIdx) && stream.fileIdx >= 0 ? stream.fileIdx : null,
    filename: typeof stream?.behaviorHints?.filename === "string" ? stream.behaviorHints.filename.slice(0, 500) : "",
    quality: detectStreamQuality(combined),
    height: releaseVideoHeight(combined),
    codec: detectStreamCodec(combined),
    audioLanguages: detectStreamAudioLanguages(combined),
    peers: parseStreamPeers(title),
    sizeBytes: parseStreamSizeBytes(title),
  };
  result.score = streamRankScore(result);
  return result;
}

async function queryStreamProvider(provider, type, videoId) {
  const endpoint = `${provider.origin}/stream/${type}/${encodeURIComponent(videoId)}.json`;
  try {
    const payload = await fetchUpstreamJson(endpoint);
    return {
      provider: provider.name,
      ok: true,
      streams: (Array.isArray(payload.streams) ? payload.streams : [])
        .map((stream) => normalizeProviderStream(stream, provider))
        .filter(Boolean),
    };
  } catch (error) {
    console.warn(`${provider.name} stream lookup failed for ${videoId}:`, error.message);
    return { provider: provider.name, ok: false, error: error.message, streams: [] };
  }
}

function mergeStreamResults(providerResults) {
  const merged = new Map();
  for (const providerResult of providerResults) {
    for (const stream of providerResult.streams) {
      const existing = merged.get(stream.infoHash);
      if (!existing) {
        merged.set(stream.infoHash, { ...stream });
        continue;
      }
      existing.providers = [...new Set([...existing.providers, ...stream.providers])];
      if (stream.score > existing.score) {
        const providers = existing.providers;
        Object.assign(existing, stream);
        existing.providers = providers;
      }
    }
  }
  return [...merged.values()]
    // Default provider ordering is peers-first. Score remains a tie-breaker.
    .sort((a, b) => b.peers - a.peers || b.score - a.score)
    .slice(0, MAX_STREAM_RESULTS);
}

async function streamsForVideo(type, videoId) {
  const cacheKey = `${type}:${videoId}`;
  pruneTimedCache(streamSearchCache, 160);
  const cached = streamSearchCache.get(cacheKey);
  if (cached?.expiresAt > Date.now()) return cached.value;
  const providerResults = await Promise.all(STREAM_PROVIDERS.map((provider) => queryStreamProvider(provider, type, videoId)));
  const value = {
    streams: mergeStreamResults(providerResults),
    providers: providerResults.map(({ provider, ok, error }) => ({ provider, ok, error: error || null })),
  };
  streamSearchCache.set(cacheKey, { value, expiresAt: Date.now() + STREAM_CACHE_TTL_MS });
  return value;
}

async function searchStreams(req, res, url) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  const type = validateCatalogType(url.searchParams.get("type"));
  const videoId = validateImdbId(url.searchParams.get("id"), { allowVideoId: true });
  if (!type || !videoId) {
    json(res, 400, { error: "A valid movie/series type and Stremio video id are required" });
    return true;
  }
  if (type === "movie" && videoId.includes(":")) {
    json(res, 400, { error: "Movie stream ids must be plain IMDb ids" });
    return true;
  }
  const result = await streamsForVideo(type, videoId);
  json(res, 200, { type, id: videoId, ...result });
  return true;
}

function cacheableJson(req, res, payload, etagSeed) {
  const body = JSON.stringify(payload);
  const etag = `"${crypto.createHash("sha256").update(String(etagSeed)).digest("base64url").slice(0, 22)}"`;
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "public, max-age=3600, must-revalidate",
    ETag: etag,
    "X-Content-Type-Options": "nosniff",
  };
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, { "Cache-Control": headers["Cache-Control"], ETag: etag });
    res.end();
    return;
  }
  res.writeHead(200, headers);
  res.end(req.method === "HEAD" ? undefined : body);
}

async function learningPresets(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") return methodNotAllowed(res, ["GET", "HEAD"]);
  const language = String(url.searchParams.get("language") || "").trim();
  if (!language) {
    const catalog = await learningPresetCatalog();
    cacheableJson(req, res, catalog, `learning-presets:${catalog.datasetVersion}:catalog`);
    return true;
  }
  const bundle = await learningPresetBundle(language, {
    wordSize: url.searchParams.get("words") || url.searchParams.get("wordSize"),
    phraseSize: url.searchParams.get("phrases") || url.searchParams.get("phraseSize"),
    includeCounts: url.searchParams.get("includeCounts") === "1",
  });
  if (!bundle) {
    json(res, 404, { error: "Unsupported learning preset language" });
    return true;
  }
  if (bundle.error === "unsupported-size") {
    json(res, 400, {
      error: "Unsupported preset size",
      wordSizes: bundle.manifest.wordSizes,
      phraseSizes: bundle.manifest.phraseSizes,
    });
    return true;
  }
  cacheableJson(req, res, bundle, `learning-presets:${bundle.datasetVersion}:${bundle.language}:${bundle.wordSize}:${bundle.phraseSize}:${url.searchParams.get("includeCounts") === "1"}`);
  return true;
}

async function learningPresetByPath(req, res, url, language, type, size) {
  if (req.method !== "GET" && req.method !== "HEAD") return methodNotAllowed(res, ["GET", "HEAD"]);
  const preset = await learningPresetSlice(language, type, size, { includeCounts: url.searchParams.get("includeCounts") === "1" });
  if (!preset) {
    json(res, 404, { error: "Unsupported learning preset language or type" });
    return true;
  }
  if (preset.error === "unsupported-size") {
    json(res, 400, {
      error: "Unsupported preset size",
      wordSizes: preset.manifest.wordSizes,
      phraseSizes: preset.manifest.phraseSizes,
    });
    return true;
  }
  cacheableJson(req, res, preset, `learning-presets:${preset.datasetVersion}:${preset.language}:${preset.type}:${preset.size}:${url.searchParams.get("includeCounts") === "1"}`);
  return true;
}

async function processLearningSubtitle(req, res) {
  const body = await readJsonBody(req, MAX_LEARNING_ARTIFACT_BODY_BYTES);
  const input = body.artifact || body.track || body;
  const artifact = processCueArtifact(input);
  json(res, 200, { artifact });
}

async function alignLearningSubtitles(req, res) {
  const body = await readJsonBody(req, MAX_LEARNING_ALIGNMENT_BODY_BYTES);
  const tracks = Array.isArray(body.tracks) ? body.tracks : body.artifacts;
  const result = alignCueArtifacts(tracks, { referenceTrackId: body.referenceTrackId });
  json(res, 200, result);
}

async function handleApi(req, res, url) {
  // Routes only the app's own page uses. Requests sent by other sites (a page you visit can
  // post to 127.0.0.1) and under other host names (DNS rebinding) are refused, so no other
  // site can send prompts through your ChatGPT, change your saved data or start a torrent.
  // The helper extension's own routes (pair, poll, result, live-control, live-transcript)
  // stay outside this check: they carry the helper's token instead.
  const appOnlyRoute = url.pathname === "/api/app-state" || url.pathname.startsWith("/api/app-state/")
    || url.pathname === "/api/diagnostics/playback"
    || url.pathname.startsWith("/api/app-updates/")
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

function serveStatic(req, res, url) {
  const asset = PUBLIC_ASSETS.get(url.pathname);
  if (!asset) {
    res.writeHead(404, { "Cache-Control": "no-store" });
    res.end(req.method === "HEAD" ? undefined : "Not found");
    return;
  }

  const fullPath = path.join(root, asset.file);
  fs.stat(fullPath, (statError, stat) => {
    if (statError || !stat.isFile()) {
      res.writeHead(404, { "Cache-Control": "no-store" });
      res.end(req.method === "HEAD" ? undefined : "Not found");
      return;
    }

    const headers = {
      "Content-Type": mime[path.extname(fullPath).toLowerCase()] || "application/octet-stream",
      "Content-Length": stat.size,
      "Cache-Control": asset.cacheControl,
      "X-Content-Type-Options": "nosniff",
    };
    if (req.method === "HEAD") {
      res.writeHead(200, headers);
      res.end();
      return;
    }

    fs.readFile(fullPath, (readError, data) => {
      if (readError) {
        res.writeHead(404, { "Cache-Control": "no-store" });
        res.end("Not found");
        return;
      }
      res.writeHead(200, headers);
      res.end(data);
    });
  });
}

// Optional features (reader, franchises, reading sources) plug in through
// backend/features/registry.js; core routes always take precedence.
const serverFeatures = createServerFeatureHost(SERVER_FEATURES, { coreAssets: PUBLIC_ASSETS });
for (const [route, asset] of serverFeatures.assets) PUBLIC_ASSETS.set(route, asset);
serverFeatures.init({
  db: appDatabase.sqlite, getMeta: appDatabase.getMeta, setMeta: appDatabase.setMeta,
  dataRoot: appDataRoot, port, root, json, readJsonBody, methodNotAllowed,
  rejectNonLocal: localRequestRejected, anilist: anilistClient,
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
