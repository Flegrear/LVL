// Tracking: volume ratings (overall = mean of rated
// volumes, or a manual override), AniList manga list import, and new chapters
// for titles being read. AniList writes happen in the browser with the user's token.
import { normalizeComic } from "./anilist-manga.js";
import { COMIC_STATUSES } from "./comics-store.js";
import { mangadexLanguages } from "./remote-reading.js";

const SCORE = (value) => (value === null ? null : Number.isFinite(Number(value)) && Number(value) >= 1 && Number(value) <= 10 ? Math.round(Number(value) * 100) / 100 : undefined);

export function createTracking({ db, now = Date.now } = {}) {
  db.exec("CREATE TABLE IF NOT EXISTS comic_ratings (work_id TEXT NOT NULL, volume TEXT NOT NULL, score REAL NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (work_id, volume))");
  const read = db.prepare("SELECT volume, score FROM comic_ratings WHERE work_id = ?");
  const write = db.prepare("INSERT INTO comic_ratings (work_id, volume, score, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(work_id, volume) DO UPDATE SET score = excluded.score, updated_at = excluded.updated_at");
  const clear = db.prepare("DELETE FROM comic_ratings WHERE work_id = ? AND volume = ?");
  function ratings(workId) {
    const volumes = {};
    let override = null;
    for (const row of read.all(String(workId))) {
      if (row.volume === "") override = row.score;
      else volumes[row.volume] = row.score;
    }
    const values = Object.values(volumes);
    const average = values.length ? Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100 : null;
    return { volumes, override, average, overall: override ?? average };
  }
  return {
    ratings,
    // volume "" sets the overall override; score null removes the rating.
    rate(workId, volume, score) {
      const key = volume === "" ? "" : String(volume ?? "");
      if (key !== "" && !/^\d{1,5}(?:\.\d{1,2})?$/.test(key)) throw new Error("Invalid volume");
      const value = SCORE(score);
      if (value === undefined) throw new Error("Scores go from 1 to 10");
      if (value === null) clear.run(String(workId), key);
      else write.run(String(workId), key, value, now());
      return ratings(workId);
    },
  };
}

// AniList list entries (MediaListCollection, type MANGA) → Library entries.
export function importEntries(lists) {
  const out = [];
  for (const list of lists || []) {
    for (const item of list?.entries || []) {
      const comic = normalizeComic({ ...item.media, description: "" });
      if (!comic || !["MANGA", "ONE_SHOT"].includes(item.media?.format)) continue;
      const status = COMIC_STATUSES.includes(item.status) ? item.status : "PLANNING";
      out.push({ anilistId: comic.anilistId, status, progress: Number(item.progress) || 0, progressVolumes: Number(item.progressVolumes) || 0, comic });
    }
  }
  return out.slice(0, 3000);
}

// Newest chapters on MangaDex for titles being read, beyond what was finished.
export async function newChapters({ entries, unitsFor, readSummary, fetchLatest, languages }) {
  const out = [];
  for (const entry of entries.filter((item) => ["CURRENT", "REPEATING"].includes(item.status) && item.anilistId).slice(0, 20)) {
    let mangadexId = null;
    try { mangadexId = (await unitsFor(entry.anilistId))?.mangadexId || null; } catch {}
    if (!mangadexId) continue;
    let latest;
    try { latest = await fetchLatest(mangadexId, mangadexLanguages(languages)); } catch { continue; }
    const read = readSummary(entry.id).chapters;
    const fresh = latest.filter((chapter) => Number(chapter.chapter) > read && !chapter.externalUrl);
    if (fresh.length) out.push({ entry, chapter: fresh[0], count: fresh.length });
  }
  return out.sort((a, b) => Date.parse(b.chapter.publishedAt || 0) - Date.parse(a.chapter.publishedAt || 0));
}
