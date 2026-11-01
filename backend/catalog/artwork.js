// Posters and artwork: checked image addresses, optimized posters and Library artwork search.
import { spawn } from "node:child_process";
import { default as ffmpegPath } from "ffmpeg-static";
import { json, methodNotAllowed, pruneTimedCache } from "../app/http-helpers.js";

const MAX_ARTWORK_QUERY_LENGTH = 180;
const MAX_ARTWORK_RESULTS = 12;
const ARTWORK_CACHE_TTL_MS = 30 * 60 * 1000;

const TVMAZE_API_ORIGIN = "https://api.tvmaze.com";
const TVMAZE_IMAGE_ORIGIN = "https://static.tvmaze.com";

const artworkSearchCache = new Map();

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

export async function serveOptimizedPoster(req, res, url) {
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

export async function searchLibraryArtwork(req, res, url) {
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
