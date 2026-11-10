// A bounded on-disk cache for remote images (source pages, covers), and the
// MangaDex calls LVL still uses as catalog data: new-chapter notices and volume
// covers. MangaDex is no longer a reading source.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { sniffImage } from "../reader/pages.js";
import { MANGADEX_API } from "./mangadex.js";
import { discardResponseBody, readBoundedResponse } from "./response-body.js";
import { normalizeUnitNumber } from "../../shared/reading/units.js";

const MAX_IMAGE = 25 * 1024 * 1024;

async function fetchImage(url, { headers = {}, fetchImpl = globalThis.fetch } = {}) {
  const controller = new AbortController();
  const response = await fetchImpl(url, { headers,
    signal: AbortSignal.any([AbortSignal.timeout(30_000), controller.signal]) });
  if (!response.ok) {
    await discardResponseBody(response, () => controller.abort());
    throw Object.assign(new Error(`Image answered HTTP ${response.status}`), { status: 502 });
  }
  const buffer = await readBoundedResponse(response, MAX_IMAGE, "Image is too large", () => controller.abort());
  const type = sniffImage(buffer);
  if (!type) throw new Error("Not an image");
  return { buffer, type };
}

// ---- Image cache: <dir>/<sha1>.img, oldest removed first above maxBytes.
export function createImageCache({ dir, maxBytes = 1024 ** 3 } = {}) {
  let writes = 0;
  const file = (key) => path.join(dir, `${crypto.createHash("sha1").update(key).digest("hex")}.img`);
  async function prune() {
    const names = (await fs.readdir(dir).catch(() => [])).filter((name) => name.endsWith(".img"));
    const stats = (await Promise.all(names.map(async (name) => ({ name, stat: await fs.stat(path.join(dir, name)).catch(() => null) })))).filter((item) => item.stat);
    let total = stats.reduce((sum, item) => sum + item.stat.size, 0);
    for (const item of stats.sort((a, b) => a.stat.atimeMs - b.stat.atimeMs)) {
      if (total <= maxBytes) break;
      await fs.rm(path.join(dir, item.name), { force: true });
      total -= item.stat.size;
    }
    return total;
  }
  return {
    async get(key, load) {
      try {
        const buffer = await fs.readFile(file(key));
        const type = sniffImage(buffer);
        if (type) return { buffer, type };
      } catch {}
      const image = await load();
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(file(key), image.buffer);
      if (++writes % 40 === 0) void prune();
      return image;
    },
    async usage() {
      const names = (await fs.readdir(dir).catch(() => [])).filter((name) => name.endsWith(".img"));
      let bytes = 0;
      for (const name of names) bytes += (await fs.stat(path.join(dir, name)).catch(() => ({ size: 0 }))).size;
      return { bytes, files: names.length, maxBytes };
    },
    async clear() {
      for (const name of (await fs.readdir(dir).catch(() => [])).filter((item) => item.endsWith(".img"))) await fs.rm(path.join(dir, name), { force: true });
    },
    prune,
  };
}

// ---- MangaDex reading
export const MANGADEX_LANGS = Object.freeze({ es: ["es", "es-la"], "es-419": ["es-la", "es"], pt: ["pt-br", "pt"], zh: ["zh", "zh-hk"], en: ["en"] });
export function mangadexLanguages(languages = []) {
  return [...new Set(languages.flatMap((code) => MANGADEX_LANGS[String(code).toLowerCase()] || [String(code).toLowerCase()]))]
    .filter((code) => /^[a-z]{2}(?:-[a-z]{2})?$/.test(code)).slice(0, 6);
}

export function createMangaDexReader({ endpoint = MANGADEX_API, fetchImpl = globalThis.fetch, userAgent = "LVL (local app)" } = {}) {
  const getJson = async (url) => {
    const response = await fetchImpl(url, { headers: { Accept: "application/json", "User-Agent": userAgent }, signal: AbortSignal.timeout(20_000) });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.result === "error") throw Object.assign(new Error(payload?.errors?.[0]?.detail || `MangaDex answered HTTP ${response.status}`), { status: 502 });
    return payload;
  };
  return {
    async latest(mangadexId, languages) {
      if (!/^[0-9a-f-]{36}$/i.test(String(mangadexId || ""))) return [];
      const params = new URLSearchParams({ limit: "10", "order[readableAt]": "desc" });
      for (const code of mangadexLanguages(languages)) params.append("translatedLanguage[]", code);
      for (const rating of ["safe", "suggestive"]) params.append("contentRating[]", rating);
      const payload = await getJson(`${endpoint}/manga/${mangadexId}/feed?${params}`);
      return (payload.data || []).map((item) => ({
        id: `md-${item.id}`, chapter: normalizeUnitNumber(item.attributes?.chapter), volume: normalizeUnitNumber(item.attributes?.volume),
        language: item.attributes?.translatedLanguage || "", externalUrl: item.attributes?.externalUrl || "", publishedAt: item.attributes?.readableAt || null,
      })).filter((item) => item.chapter);
    },
    image: (url) => fetchImage(url, { headers: { "User-Agent": userAgent }, fetchImpl }),
  };
}
