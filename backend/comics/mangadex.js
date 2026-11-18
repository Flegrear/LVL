// MangaDex metadata for the Comics section: find a series by its AniList id
// (MangaDex stores it in attributes.links.al) and list its volumes and
// chapters (the aggregate endpoint). Used for listing only; reading
// chapters comes with sources. MangaDex allows about five
// requests per second; this client sends at most four and honors Retry-After.

import { normalizeUnitNumber, sortVolumes, countChapters, unitKey } from "../../shared/reading/units.js";
import { readBoundedResponse } from "./response-body.js";

export const MANGADEX_API = "https://api.mangadex.org";
const SAFE_RATINGS = ["safe", "suggestive"];
const MANGA_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COVER_FILENAME = /^[a-z0-9_-]{1,80}\.(?:jpe?g|png|webp)$/i;
const METADATA_MAX_BYTES = 4 * 1024 * 1024;
const COVER_MAX_BYTES = 2 * 1024 * 1024;

// The primary edition is explicitly linked by MangaDex. A matching title is
// only a search hint; it never authorizes an artwork substitution.
export function primaryCoverForAniList(manga, anilistId, included = []) {
  if (String(manga?.attributes?.links?.al || "") !== String(anilistId)
    || !MANGA_UUID.test(String(manga?.id || ""))) return null;
  const relationship = manga?.relationships?.find((item) => item?.type === "cover_art");
  if (!relationship || !MANGA_UUID.test(String(relationship.id || ""))) return null;
  const expanded = included.find((item) => item?.type === "cover_art" && item.id === relationship.id);
  const filename = String(expanded?.attributes?.fileName || relationship.attributes?.fileName || "");
  if (!COVER_FILENAME.test(filename)) return null;
  return { mangaId: manga.id, coverId: relationship.id, filename,
    url: `https://uploads.mangadex.org/covers/${manga.id}/${filename}` };
}

export function createMangaDexClient({ endpoint = MANGADEX_API, fetchImpl = globalThis.fetch, minGapMs = 250, timeoutMs = 15_000,
  userAgent = "LVL (local app)", now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  let queue = Promise.resolve();
  let lastAt = 0;

  async function send(pathAndQuery, attempt = 0, options = {}) {
    const remaining = options.deadline === undefined ? timeoutMs : options.deadline - now();
    if (remaining <= 0) throw Object.assign(new Error("MangaDex request time budget elapsed"), { status: 504 });
    const wait = lastAt + minGapMs - now();
    if (wait > 0) {
      if (options.deadline !== undefined && wait >= remaining) throw Object.assign(new Error("MangaDex request time budget elapsed"), { status: 504 });
      await sleep(wait);
    }
    lastAt = now();
    const response = await fetchImpl(`${endpoint}${pathAndQuery}`, {
      headers: { Accept: "application/json", "User-Agent": userAgent },
      signal: AbortSignal.timeout(Math.max(1, Math.min(options.timeoutMs || timeoutMs, options.deadline === undefined ? timeoutMs : options.deadline - now()))),
    });
    if (response.status === 429 && attempt < 1) {
      const retry = Math.min(10, Math.max(1, Number(response.headers?.get?.("retry-after")) || 2)) * 1000;
      if (options.deadline !== undefined && retry >= options.deadline - now())
        throw Object.assign(new Error("MangaDex rate limit exceeds artwork time budget"), { status: 429 });
      await sleep(retry);
      return send(pathAndQuery, attempt + 1, options);
    }
    // All provider JSON, not just artwork metadata, must be admitted through
    // a finite streaming byte budget before parsing (including chunked bodies).
    const maxBytes = options.maxBytes ?? METADATA_MAX_BYTES;
    const bytes = await readBoundedResponse(response, maxBytes, "MangaDex metadata exceeds byte budget");
    let payload;
    try { payload = JSON.parse(bytes.toString("utf8")); }
    catch { throw Object.assign(new Error("Invalid MangaDex metadata"), { status: 502 }); }
    if (!response.ok || payload?.result === "error") {
      const message = payload?.errors?.[0]?.detail || `MangaDex answered HTTP ${response.status}`;
      throw Object.assign(new Error(message), { status: response.status });
    }
    return payload || {};
  }

  const request = (pathAndQuery, options) => {
    const run = queue.then(() => send(pathAndQuery, 0, options));
    queue = run.catch(() => {});
    return run;
  };

  return {
    // Catalog-only lookup. At most three different titles, thirty results per
    // query (Bastard's verified exact match was beyond the old ten-result cap).
    // Existing findByAniList keeps its original string-ID return contract.
    async findArtworkByAniList(anilistId, titles = [], { deadline: outerDeadline } = {}) {
      if (!/^[1-9]\d{0,9}$/.test(String(anilistId))) return null;
      const tried = new Set();
      const deadline = Math.min(now() + 10_000, outerDeadline ?? Infinity);
      for (const title of titles) {
        const query = String(title || "").trim().slice(0, 120);
        if (!query || tried.has(query.toLowerCase()) || tried.size >= 3) continue;
        tried.add(query.toLowerCase());
        const params = new URLSearchParams({ title: query, limit: "30" });
        params.append("includes[]", "cover_art");
        for (const rating of SAFE_RATINGS) params.append("contentRating[]", rating);
        const payload = await request(`/manga?${params}`, { deadline, timeoutMs: 5000, maxBytes: 512 * 1024 });
        for (const manga of payload.data || []) {
          const cover = primaryCoverForAniList(manga, anilistId, payload.included || []);
          if (cover) return cover;
        }
      }
      return null;
    },
    /** MangaDex id of the series whose stored AniList link equals anilistId, or null. */
    async findByAniList(anilistId, titles = []) {
      const target = String(anilistId);
      const tried = new Set();
      for (const title of titles) {
        const query = String(title || "").trim().slice(0, 120);
        if (!query || tried.has(query.toLowerCase()) || tried.size >= 3) continue;
        tried.add(query.toLowerCase());
        // Artwork's verified crosswalk scans up to 30 candidates. The chapter
        // index must use the same bounded verified-ID search horizon, or a
        // title returned at position 11..30 gets a cover but loses its units.
        // Result order and title similarity never confer work identity.
        const params = new URLSearchParams({ title: query, limit: "30" });
        for (const rating of SAFE_RATINGS) params.append("contentRating[]", rating);
        const payload = await request(`/manga?${params}`);
        const hit = (payload.data || []).find((item) => String(item?.attributes?.links?.al || "") === target);
        if (hit && /^[0-9a-f-]{36}$/i.test(hit.id)) return hit.id;
      }
      return null;
    },

    /** Volumes with their chapters, in reading order; chapters without a volume come last. */
    async aggregate(mangadexId) {
      if (!/^[0-9a-f-]{36}$/i.test(String(mangadexId || ""))) throw new Error("Invalid MangaDex id");
      return normalizeAggregate(await request(`/manga/${mangadexId}/aggregate`));
    },

    /** Cover file name per volume ({ "1": "abc.jpg" }), preferring the original edition's cover. */
    async covers(mangadexId, preferred = ["ja", "ko", "zh", "en"]) {
      if (!/^[0-9a-f-]{36}$/i.test(String(mangadexId || ""))) throw new Error("Invalid MangaDex id");
      const byVolume = {};
      for (let offset = 0; offset < 300; offset += 100) {
        const payload = await request(`/cover?manga[]=${mangadexId}&limit=100&offset=${offset}&order[volume]=asc`, { maxBytes: COVER_MAX_BYTES });
        for (const item of payload.data || []) {
          const volume = normalizeUnitNumber(item?.attributes?.volume);
          const file = String(item?.attributes?.fileName || "");
          if (!volume || !/^[\w-]{1,80}\.(?:jpe?g|png|webp)$/i.test(file)) continue;
          const rank = (locale) => { const at = preferred.indexOf(locale); return at < 0 ? preferred.length : at; };
          if (!byVolume[volume] || rank(item.attributes.locale) < rank(byVolume[volume].locale)) byVolume[volume] = { file, locale: item.attributes.locale };
        }
        if ((payload.total || 0) <= offset + 100) break;
      }
      return Object.fromEntries(Object.entries(byVolume).map(([volume, item]) => [volume, item.file]));
    },
  };
}

export function normalizeAggregate(payload) {
  const volumes = [];
  for (const [volumeKey, group] of Object.entries(payload?.volumes || {})) {
    const volume = volumeKey === "none" ? null : normalizeUnitNumber(group?.volume ?? volumeKey);
    if (volumeKey !== "none" && volume === null) continue;
    const chapters = [];
    for (const [chapterKey, chapter] of Object.entries(group?.chapters || {})) {
      const number = chapterKey === "none" ? null : normalizeUnitNumber(chapter?.chapter ?? chapterKey);
      if (number === null) continue;
      chapters.push({ chapter: number });
    }
    // Numbering can restart in a later volume. Only collapse an identical
    // volume/chapter pair, never a chapter in another volume.
    volumes.push({ volume, chapters });
  }
  const seen = new Set();
  const sorted = sortVolumes(volumes).map((group) => ({
    ...group,
    chapters: group.chapters.filter((item) => {
      const key = unitKey({ volume: group.volume, chapter: item.chapter });
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  })).filter((group) => group.chapters.length || group.volume !== null);
  return { volumes: sorted, chapterCount: countChapters(sorted) };
}
