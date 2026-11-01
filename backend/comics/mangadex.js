// MangaDex metadata for the Comics section: find a series by its AniList id
// (MangaDex stores it in attributes.links.al) and list its volumes and
// chapters (the aggregate endpoint). Used for listing only; reading
// chapters comes with sources. MangaDex allows about five
// requests per second; this client sends at most four and honors Retry-After.

import { normalizeUnitNumber, sortVolumes, countChapters } from "../../shared/reading/units.js";

export const MANGADEX_API = "https://api.mangadex.org";
const SAFE_RATINGS = ["safe", "suggestive"];

export function createMangaDexClient({ endpoint = MANGADEX_API, fetchImpl = globalThis.fetch, minGapMs = 250, timeoutMs = 15_000,
  userAgent = "LVL (local app)", now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  let queue = Promise.resolve();
  let lastAt = 0;

  async function send(pathAndQuery, attempt = 0) {
    const wait = lastAt + minGapMs - now();
    if (wait > 0) await sleep(wait);
    lastAt = now();
    const response = await fetchImpl(`${endpoint}${pathAndQuery}`, {
      headers: { Accept: "application/json", "User-Agent": userAgent },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 429 && attempt < 1) {
      await sleep(Math.min(10, Math.max(1, Number(response.headers?.get?.("retry-after")) || 2)) * 1000);
      return send(pathAndQuery, attempt + 1);
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.result === "error") {
      const message = payload?.errors?.[0]?.detail || `MangaDex answered HTTP ${response.status}`;
      throw Object.assign(new Error(message), { status: response.status });
    }
    return payload || {};
  }

  const request = (pathAndQuery) => {
    const run = queue.then(() => send(pathAndQuery));
    queue = run.catch(() => {});
    return run;
  };

  return {
    /** MangaDex id of the series whose stored AniList link equals anilistId, or null. */
    async findByAniList(anilistId, titles = []) {
      const target = String(anilistId);
      const tried = new Set();
      for (const title of titles) {
        const query = String(title || "").trim().slice(0, 120);
        if (!query || tried.has(query.toLowerCase()) || tried.size >= 3) continue;
        tried.add(query.toLowerCase());
        const params = new URLSearchParams({ title: query, limit: "10" });
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
        const payload = await request(`/cover?manga[]=${mangadexId}&limit=100&offset=${offset}&order[volume]=asc`);
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
    // Chapters can be listed under several volumes when groups disagree; keep the first.
    volumes.push({ volume, chapters });
  }
  const seen = new Set();
  const sorted = sortVolumes(volumes).map((group) => ({
    ...group,
    chapters: group.chapters.filter((item) => (seen.has(item.chapter) ? false : seen.add(item.chapter))),
  })).filter((group) => group.chapters.length || group.volume !== null);
  return { volumes: sorted, chapterCount: countChapters(sorted) };
}
