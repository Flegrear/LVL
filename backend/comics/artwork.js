// Lazy catalog-only MangaDex cover fallback. The authoritative manga identity
// is the numeric AniList link in MangaDex metadata; titles never authorize art.
import { sniffImage } from "../reader/pages.js";
import { readBoundedResponse, discardResponseBody } from "./response-body.js";

const POSITIVE_MS = 6 * 60 * 60_000;
const NEGATIVE_MS = 15 * 60_000;
const ERROR_MS = 60_000;
const MAX_COVER_BYTES = 2 * 1024 * 1024;
const TRUSTED_COVER = /^https:\/\/uploads\.mangadex\.org\/covers\/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\/([a-z0-9_-]{1,80}\.(?:jpe?g|png|webp))$/i;

export function catalogCoverUrlAllowed(url, cover) {
  const match = TRUSTED_COVER.exec(String(url || ""));
  return Boolean(match && match[1] === cover?.mangaId && match[2] === cover?.filename
    && String(cover?.url) === url);
}

// Require a valid, bounded raster before a local proxy can serve bytes. Browser
// decode remains the final authority for visible sharper-than-source adoption.
export function imageDimensions(bytes, type) {
  if (!Buffer.isBuffer(bytes)) return null;
  let width = 0, height = 0;
  if (type === "image/png" && bytes.length >= 24
    && bytes.toString("ascii", 12, 16) === "IHDR") {
    width = bytes.readUInt32BE(16);
    height = bytes.readUInt32BE(20);
  } else if (type === "image/jpeg" && bytes.length > 10) {
    for (let at = 2; at + 9 < bytes.length;) {
      if (bytes[at] !== 0xff) break;
      while (bytes[at] === 0xff) at++;
      const marker = bytes[at++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker >= 0xd0 && marker <= 0xd7 || marker === 0x01) continue;
      if (at + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(at);
      if (length < 2 || at + length > bytes.length) break;
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker) && length >= 7) {
        height = bytes.readUInt16BE(at + 3);
        width = bytes.readUInt16BE(at + 5);
        break;
      }
      at += length;
    }
  } else if (type === "image/webp" && bytes.length >= 30) {
    const format = bytes.toString("ascii", 12, 16);
    if (format === "VP8X") {
      width = 1 + bytes.readUIntLE(24, 3);
      height = 1 + bytes.readUIntLE(27, 3);
    } else if (format === "VP8 " && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      width = bytes.readUInt16LE(26) & 0x3fff;
      height = bytes.readUInt16LE(28) & 0x3fff;
    } else if (format === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
      const packed = bytes.readUInt32LE(21);
      width = (packed & 0x3fff) + 1;
      height = ((packed >>> 14) & 0x3fff) + 1;
    }
  }
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 100 || height < 100
    || width > 8192 || height > 12000 || width / height < 0.4 || width / height > 1.2) return null;
  return { width, height };
}

export function createCatalogArtworkResolver({
  mangadex, imageCache, fetchImpl = globalThis.fetch, now = Date.now,
  positiveMs = POSITIVE_MS, negativeMs = NEGATIVE_MS, errorMs = ERROR_MS,
  maxEntries = 48, maxParallel = 2,
} = {}) {
  if (!mangadex?.findArtworkByAniList || !imageCache?.get) throw new Error("Artwork dependencies are missing");
  const metadata = new Map();
  const pending = new Map();
  const queued = [];
  const imagePending = new Map();
  let active = 0;

  function remember(id, cover, ttlMs, failed = false) {
    metadata.delete(id);
    metadata.set(id, { cover, failed, until: now() + ttlMs });
    while (metadata.size > maxEntries) metadata.delete(metadata.keys().next().value);
  }
  function startQueued() {
    while (active < maxParallel && queued.length) {
      const job = queued.shift();
      if (Date.now() >= job.deadline) {
        pending.delete(job.key);
        job.reject(Object.assign(new Error("Artwork queue deadline elapsed"), { status: 504 }));
        continue;
      }
      active++;
      void mangadex.findArtworkByAniList(Number(job.key), job.titles, { deadline: job.deadline }).then(result => {
        const cover = result && catalogCoverUrlAllowed(result.url, result) ? result : null;
        remember(job.key, cover, cover ? positiveMs : negativeMs);
        job.resolve(cover);
      }).catch(() => {
        // A temporary server/provider failure must never become a confirmed
        // 404 on the local route or a long browser negative-cache entry.
        remember(job.key, null, errorMs, true);
        job.reject(Object.assign(new Error("Catalog provider temporarily unavailable"), { status: 503 }));
      }).finally(() => {
        active--;
        pending.delete(job.key);
        startQueued();
      });
    }
  }
  async function find(anilistId, titles, { deadline = Date.now() + 17_000 } = {}) {
    const key = String(anilistId);
    if (!/^[1-9]\d{0,9}$/.test(key)) return null;
    const cached = metadata.get(key);
    if (cached?.until > now()) {
      metadata.delete(key);
      metadata.set(key, cached);
      if (cached.failed) throw Object.assign(new Error("Catalog provider temporarily unavailable"), { status: 503 });
      return cached.cover;
    }
    metadata.delete(key);
    if (pending.has(key)) return pending.get(key);
    if (queued.length >= 24 || Date.now() >= deadline)
      throw Object.assign(new Error("Artwork lookup queue is full or expired"), { status: 503 });
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    pending.set(key, promise);
    queued.push({ key, titles, deadline, resolve, reject });
    startQueued();
    return promise;
  }

  async function fetchCover(cover, deadline = Infinity) {
    if (!catalogCoverUrlAllowed(cover?.url, cover)) throw new Error("Invalid catalog cover identity");
    const controller = new AbortController();
    const response = await fetchImpl(cover.url, {
      redirect: "error",
      headers: { Accept: "image/jpeg,image/png,image/webp", "User-Agent": "LVL (local app)" },
      signal: AbortSignal.any([AbortSignal.timeout(Math.max(1, Math.min(6000, deadline - Date.now()))), controller.signal]),
    });
    if (!response.ok) {
      await discardResponseBody(response, () => controller.abort());
      throw Object.assign(new Error(`MangaDex cover answered HTTP ${response.status}`), { status: response.status });
    }
    const buffer = await readBoundedResponse(response, MAX_COVER_BYTES, "MangaDex cover exceeds 2 MiB", () => controller.abort());
    const type = sniffImage(buffer);
    if (!["image/jpeg", "image/png", "image/webp"].includes(type)) throw new Error("Unexpected catalog image type");
    if (String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase() !== type)
      throw new Error("Catalog image MIME mismatch");
    const size = imageDimensions(buffer, type);
    if (!size) throw new Error("Invalid catalog image dimensions");
    return { buffer, type, ...size };
  }

  async function image(cover, { deadline = Infinity } = {}) {
    if (!catalogCoverUrlAllowed(cover?.url, cover)) throw new Error("Invalid catalog cover identity");
    const key = `catalog-original-v1:${cover.mangaId}:${cover.coverId}:${cover.filename}`;
    if (imagePending.has(key)) return imagePending.get(key);
    const job = (async () => {
      const cached = await imageCache.get(key, () => fetchCover(cover, deadline));
      const size = imageDimensions(cached.buffer, cached.type);
      if (!size) throw new Error("Cached catalog image is malformed");
      return { ...cached, ...size };
    })().finally(() => imagePending.delete(key));
    imagePending.set(key, job);
    return job;
  }

  return { find, image };
}
