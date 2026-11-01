// Stream sources for a title or episode, from the stream providers, ranked.
import { heightFromQualityLabel, qualityLabel, releaseVideoHeight } from "../../shared/media/series-sources.js";
import { FALLBACK_TRACKERS } from "../../server.js";
import { fetchUpstreamJson, json, methodNotAllowed, pruneTimedCache } from "../app/http-helpers.js";
import { validateCatalogType, validateImdbId } from "./catalog-api.js";

const STREAM_CACHE_TTL_MS = 10 * 60 * 1000;

const MAX_STREAM_RESULTS = 200;

const STREAM_PROVIDERS = [
  { id: "torrentio", name: "Torrentio", origin: "https://torrentio.strem.fun" },
  { id: "tpbplus", name: "TPB+", origin: "https://thepiratebay-plus.strem.fun" },
];

const streamSearchCache = new Map();

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

export async function searchStreams(req, res, url) {
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
