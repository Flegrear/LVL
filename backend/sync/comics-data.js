// Comics as sync records (shared/sync/records.js). The Comics feature (backend/comics) owns
// these tables; sync reads and writes them like another LVL window would, and skips the ones
// that don't exist (Comics never ran on this device).
// - comic.library: AniList comics (comic_library), and comics read from their sources: a source
//   title (comic_local_titles + comic_source_titles) with a "video:…" or "mihon:…" series key,
//   whose id every device computes from that key.
// - comic.source: the sources chosen for each comic (comic_work_sources).
// - comic.read: progress in chapters read from sources (comic_progress, comic_read_units).
//   Local files aren't synced: their ids are paths on this device.
// - comic.rating: volume ratings (comic_ratings).
// - comic.favorite: favorite sources with their own settings (comic_ext_sources, comic_ext_settings).
// - comic.repository: extension repositories (comic_sources). Torznab indexers stay on each device.
// An incoming change older than this device's own copy (by the row's time) isn't applied; a
// change this LVL can't place (an unknown status, a bad id) waits instead of being guessed.
import { joinId, splitId } from "../../shared/sync/records.js";
import { parseStamp } from "../../shared/sync/clock.js";
import { SOURCE_ID, WORK_ID } from "../../shared/reading/ids.js";
import { cleanSiteSettings, extChapterId, validSitePath } from "../comics/ext-sources.js";
import { NOT_IN_LIBRARY, SOURCE_TITLE_KEY } from "../comics/video-comics.js";
import { COMIC_STATUSES } from "../comics/comics-store.js";
import { safeHttpUrl } from "../comics/sources-store.js";
import { localIdFor } from "../reader/local-library.js";

// Applied in this order, so a comic exists before its sources and progress.
export const COMIC_TYPES = Object.freeze(["comic.repository", "comic.favorite", "comic.library", "comic.source", "comic.read", "comic.rating"]);
const present = (value) => value !== undefined && value !== null && value !== "";
const compact = (object) => Object.fromEntries(Object.entries(object).filter(([, value]) => present(value)));
const parse = (text) => { try { const value = JSON.parse(text || "{}"); return value && typeof value === "object" && !Array.isArray(value) ? value : {}; } catch { return {}; } };
const stampMs = (change) => parseStamp(change.at)?.ms || 0;
const unitNumber = (value) => (/^\d{1,5}(?:\.\d{1,2})?$/.test(String(value ?? "")) ? String(value) : null);
const parts = (id) => { try { return splitId(id); } catch { return []; } };
const PACKAGE = /^[A-Za-z0-9_.]{3,160}$/;
const VIDEO_ID = /^tt\d{5,12}$/;
// The rows each table adds or changes, as a cheap mark: counts and newest times.
const MARKS = Object.freeze([
  ["comic_library", "COUNT(*), MAX(updated_at)"], ["comic_local_titles", "COUNT(*), MAX(updated_at)"], ["comic_source_titles", "COUNT(*), MAX(created_at)"],
  ["comic_work_sources", "COUNT(*), MAX(added_at)"], ["comic_progress", "COUNT(*), MAX(updated_at)"], ["comic_ratings", "COUNT(*), MAX(updated_at)"],
  ["comic_ext_sources", "COUNT(*), MAX(added_at)"], ["comic_ext_settings", "COUNT(*), MAX(updated_at)"], ["comic_sources", "COUNT(*), MAX(added_at), SUM(enabled), SUM(removed)"],
]);

export function createComicsData({ db, now = Date.now, random = () => Math.random().toString(36).slice(2, 6) }) {
  const has = (table) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const newerHere = (row, column, change) => Boolean(row) && Number(row[column] || 0) > stampMs(change);

  function exportLibrary(out) {
    if (has("comic_library")) {
      for (const row of all("SELECT anilist_id, status, work_json FROM comic_library")) {
        const work = parse(row.work_json);
        out.push({ type: "comic.library", id: `anilist-${row.anilist_id}`, value: compact({ status: row.status, title: work.title, work }) });
      }
    }
    if (!has("comic_local_titles") || !has("comic_source_titles")) return;
    const links = has("comic_video_links");
    const seen = new Set();
    for (const row of all(`SELECT t.id, t.title, t.series_key, t.status, s.cover_url, s.cover_source${links ? ", v.video_id, v.video_type, v.video_title" : ""}
        FROM comic_local_titles t JOIN comic_source_titles s ON s.work_id = t.id${links ? " LEFT JOIN comic_video_links v ON v.work_id = t.id AND v.origin = 1" : ""}`)) {
      if (seen.has(row.id) || row.status === NOT_IN_LIBRARY || !SOURCE_TITLE_KEY.test(row.series_key) || localIdFor(row.series_key) !== row.id) continue;
      seen.add(row.id);
      out.push({ type: "comic.library", id: row.id, value: compact({ status: row.status, title: row.title, seriesKey: row.series_key,
        cover: row.cover_url ? compact({ url: row.cover_url, source: row.cover_source }) : null,
        video: row.video_id ? compact({ id: row.video_id, type: row.video_type, title: row.video_title }) : null }) });
    }
  }

  function applyLibrary(change, done) {
    const at = stampMs(change);
    if (change.id.startsWith("anilist-")) {
      if (!has("comic_library")) return;
      const anilistId = Number(change.id.slice("anilist-".length));
      if (newerHere(get("SELECT updated_at FROM comic_library WHERE anilist_id = ?", anilistId), "updated_at", change)) return;
      if (change.value === null) run("DELETE FROM comic_library WHERE anilist_id = ?", anilistId);
      else {
        if (!COMIC_STATUSES.includes(change.value.status)) return;
        run(`INSERT INTO comic_library (anilist_id, status, work_json, added_at, updated_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(anilist_id) DO UPDATE SET status = excluded.status, work_json = excluded.work_json, updated_at = excluded.updated_at`,
        anilistId, change.value.status, JSON.stringify(change.value.work || {}), at, at);
      }
      done.add(change);
      return;
    }
    if (!has("comic_local_titles") || !has("comic_source_titles")) return;
    const existing = get("SELECT updated_at FROM comic_local_titles WHERE id = ?", change.id);
    if (newerHere(existing, "updated_at", change)) return;
    if (change.value === null) {
      // Out of the Library, as on the device that removed it; the comic and its sources stay.
      if (existing) run("UPDATE comic_local_titles SET status = ?, updated_at = ? WHERE id = ?", NOT_IN_LIBRARY, at, change.id);
      done.add(change);
      return;
    }
    const { status, title = "", seriesKey = "", cover, video } = change.value;
    if (!COMIC_STATUSES.includes(status) || !SOURCE_TITLE_KEY.test(seriesKey) || localIdFor(seriesKey) !== change.id) return;
    run(`INSERT INTO comic_local_titles (id, title, series_key, status, added_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET title = excluded.title, status = excluded.status, updated_at = excluded.updated_at`,
    change.id, String(title).slice(0, 200) || "Untitled", seriesKey, status, at, at);
    const videoId = VIDEO_ID.test(String(video?.id || "")) ? video.id : "";
    run("INSERT OR IGNORE INTO comic_source_titles (work_id, video_id, created_at) VALUES (?, ?, ?)", change.id, videoId, at);
    if (/^https?:\/\/\S{4,1500}$/.test(String(cover?.url || ""))) {
      run("UPDATE comic_source_titles SET cover_url = ?, cover_source = ? WHERE work_id = ?", cover.url, String(cover.source || "").slice(0, 40), change.id);
    }
    if (videoId && has("comic_video_links")) {
      run(`INSERT INTO comic_video_links (work_id, video_id, video_type, video_title, origin, hidden, added_at) VALUES (?, ?, ?, ?, 1, 0, ?)
        ON CONFLICT(work_id, video_id) DO UPDATE SET origin = 1`, change.id, videoId, video.type === "movie" ? "movie" : "series", String(video.title || title).slice(0, 200), at);
    }
    done.add(change);
  }

  function exportSources(out) {
    if (!has("comic_work_sources")) return;
    for (const row of all("SELECT work_id, source_id, manga_id, name, title, lang FROM comic_work_sources WHERE kind = 'ext'")) {
      out.push({ type: "comic.source", id: joinId(row.work_id, "ext", row.source_id, row.manga_id), value: compact({ name: row.name, title: row.title, lang: row.lang }) });
    }
  }
  function applySource(change, done) {
    if (!has("comic_work_sources")) return;
    const [work = "", kind, source = "", manga = ""] = parts(change.id);
    if (!WORK_ID.test(work) || kind !== "ext" || !SOURCE_ID.test(source) || !validSitePath(manga)) return;
    if (change.value === null) run("DELETE FROM comic_work_sources WHERE work_id = ? AND kind = 'ext' AND source_id = ? AND manga_id = ?", work, source, manga);
    else {
      run(`INSERT INTO comic_work_sources (work_id, kind, source_id, manga_id, name, title, lang, added_at) VALUES (?, 'ext', ?, ?, ?, ?, ?, ?)
        ON CONFLICT(work_id, kind, source_id, manga_id) DO UPDATE SET name = excluded.name, title = excluded.title, lang = excluded.lang`,
      work, source, manga, String(change.value.name).slice(0, 80), String(change.value.title || "").slice(0, 200), String(change.value.lang || "").slice(0, 10), stampMs(change));
    }
    done.add(change);
  }

  function exportRead(out) {
    if (!has("comic_progress") || !has("comic_ext_chapters")) return;
    const units = has("comic_read_units");
    const seen = new Set();
    for (const row of all(`SELECT p.work_id, p.page, p.pages, p.finished, c.source_id, c.path${units ? ", u.volume, u.chapter" : ""}
        FROM comic_progress p JOIN comic_ext_chapters c ON c.id = p.file_id${units ? " LEFT JOIN comic_read_units u ON u.unit_id = p.file_id AND u.work_id = p.work_id" : ""}
        WHERE p.work_id IS NOT NULL`)) {
      const id = joinId(row.source_id, row.path);
      if (seen.has(id) || !WORK_ID.test(row.work_id)) continue;
      seen.add(id);
      out.push({ type: "comic.read", id, value: compact({ workId: row.work_id, page: row.page, pages: row.pages, finished: Boolean(row.finished), chapter: row.chapter, volume: row.volume }) });
    }
  }
  function applyRead(change, done) {
    if (!has("comic_progress") || !has("comic_ext_chapters")) return;
    const [source = "", path = ""] = parts(change.id);
    if (!SOURCE_ID.test(source) || !validSitePath(path)) return;
    const id = extChapterId(source, path);
    const at = stampMs(change);
    if (newerHere(get("SELECT updated_at FROM comic_progress WHERE file_id = ?", id), "updated_at", change)) return;
    const units = has("comic_read_units");
    if (change.value === null) {
      run("DELETE FROM comic_progress WHERE file_id = ?", id);
      if (units) run("DELETE FROM comic_read_units WHERE unit_id = ?", id);
      done.add(change);
      return;
    }
    const { workId, page, pages, finished = false, chapter, volume } = change.value;
    if (!WORK_ID.test(String(workId))) return;
    const total = Math.max(1, Math.min(Math.round(pages) || 1, 10_000));
    const spot = Math.max(0, Math.min(Math.round(page) || 0, total - 1));
    run("INSERT OR IGNORE INTO comic_ext_chapters (id, source_id, path, created_at) VALUES (?, ?, ?, ?)", id, source, path, at);
    // Finished stays finished, as when reading here.
    run(`INSERT INTO comic_progress (file_id, work_id, page, pages, finished, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_id) DO UPDATE SET work_id = excluded.work_id, page = excluded.page, pages = excluded.pages,
      finished = MAX(comic_progress.finished, excluded.finished), updated_at = excluded.updated_at`, id, workId, spot, total, finished ? 1 : 0, at);
    if (finished && units) {
      run("INSERT OR IGNORE INTO comic_read_units (work_id, unit_id, volume, chapter, finished_at) VALUES (?, ?, ?, ?, ?)", workId, id, unitNumber(volume), unitNumber(chapter), at);
    }
    done.add(change);
  }

  function exportRatings(out) {
    if (!has("comic_ratings")) return;
    for (const row of all("SELECT work_id, volume, score FROM comic_ratings")) out.push({ type: "comic.rating", id: joinId(row.work_id, row.volume), value: { score: row.score } });
  }
  function applyRating(change, done) {
    if (!has("comic_ratings")) return;
    const [work = "", volume] = parts(change.id);
    if (!WORK_ID.test(work) || volume === undefined || (volume !== "" && !unitNumber(volume))) return;
    if (newerHere(get("SELECT updated_at FROM comic_ratings WHERE work_id = ? AND volume = ?", work, volume), "updated_at", change)) return;
    if (change.value === null) run("DELETE FROM comic_ratings WHERE work_id = ? AND volume = ?", work, volume);
    else {
      run(`INSERT INTO comic_ratings (work_id, volume, score, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(work_id, volume) DO UPDATE SET score = excluded.score, updated_at = excluded.updated_at`, work, volume, Math.round(change.value.score * 100) / 100, stampMs(change));
    }
    done.add(change);
  }

  function exportFavorites(out) {
    if (!has("comic_ext_sources")) return;
    const own = has("comic_ext_settings") ? new Map(all("SELECT source_id, settings_json FROM comic_ext_settings").map((row) => [row.source_id, cleanSiteSettings(parse(row.settings_json))])) : new Map();
    for (const row of all("SELECT source_id, pkg, ext_name, name, lang, base_url, nsfw FROM comic_ext_sources")) {
      const settings = own.get(row.source_id);
      out.push({ type: "comic.favorite", id: row.source_id, value: compact({ pkg: row.pkg, extension: row.ext_name, name: row.name, lang: row.lang,
        baseUrl: row.base_url, nsfw: Boolean(row.nsfw), settings: settings && Object.keys(settings).length ? settings : null }) });
    }
  }
  function applyFavorite(change, done) {
    if (!has("comic_ext_sources")) return;
    if (change.value === null) {
      run("DELETE FROM comic_ext_sources WHERE source_id = ?", change.id);
      done.add(change);
      return;
    }
    const { pkg, extension = "", name, lang = "", baseUrl, nsfw = false, settings } = change.value;
    if (!PACKAGE.test(pkg) || !/^https?:\/\/[^/\s]+/.test(baseUrl)) return;
    // The address only starts a new favorite: each device follows its repository for moves.
    run(`INSERT INTO comic_ext_sources (source_id, pkg, repo, ext_name, name, lang, base_url, version, nsfw, added_at) VALUES (?, ?, '', ?, ?, ?, ?, '', ?, ?)
      ON CONFLICT(source_id) DO UPDATE SET pkg = excluded.pkg, ext_name = excluded.ext_name, name = excluded.name, lang = excluded.lang, nsfw = excluded.nsfw`,
    change.id, pkg, String(extension || name).slice(0, 120), String(name).slice(0, 120), String(lang).slice(0, 12), String(baseUrl).replace(/\/+$/, "").slice(0, 300), nsfw ? 1 : 0, stampMs(change));
    if (has("comic_ext_settings")) {
      const clean = cleanSiteSettings(settings && typeof settings === "object" ? settings : {});
      if (Object.keys(clean).length) {
        run(`INSERT INTO comic_ext_settings (source_id, settings_json, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(source_id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at`, change.id, JSON.stringify(clean), stampMs(change));
      } else run("DELETE FROM comic_ext_settings WHERE source_id = ?", change.id);
    }
    done.add(change);
  }

  const repositories = () => (has("comic_sources") ? all("SELECT id, name, enabled, removed, config_json FROM comic_sources WHERE kind = 'mihon-repo'")
    .map((row) => ({ ...row, url: safeHttpUrl(parse(row.config_json).url, { allowHttp: false }) })) : []);
  function exportRepositories(out) {
    for (const row of repositories()) if (row.url && !row.removed) out.push({ type: "comic.repository", id: row.url, value: { name: row.name, enabled: Boolean(row.enabled) } });
  }
  function applyRepository(change, done) {
    if (!has("comic_sources")) return;
    const row = repositories().find((item) => item.url === change.id);
    if (change.value === null) {
      if (row) run("UPDATE comic_sources SET removed = 1, enabled = 0 WHERE id = ?", row.id);
      done.add(change);
      return;
    }
    let host = "Repository";
    try { host = new URL(change.id).host; } catch {}
    const name = String(change.value.name || "").slice(0, 80) || host;
    if (row) run("UPDATE comic_sources SET name = ?, enabled = ?, removed = 0 WHERE id = ?", name, change.value.enabled ? 1 : 0, row.id);
    else {
      run("INSERT INTO comic_sources (id, kind, name, enabled, preset, removed, config_json, added_at) VALUES (?, 'mihon-repo', ?, ?, 0, 0, ?, ?)",
        `mihon-repo-${now().toString(36)}${random()}`, name, change.value.enabled ? 1 : 0, JSON.stringify({ url: change.id }), stampMs(change));
    }
    done.add(change);
  }

  const appliers = { "comic.repository": applyRepository, "comic.favorite": applyFavorite, "comic.library": applyLibrary,
    "comic.source": applySource, "comic.read": applyRead, "comic.rating": applyRating };
  return {
    types: COMIC_TYPES,
    export(out) { exportRepositories(out); exportFavorites(out); exportLibrary(out); exportSources(out); exportRead(out); exportRatings(out); },
    apply(change, done) { appliers[change.type]?.(change, done); },
    mark: () => MARKS.map(([table, columns]) => (has(table) ? Object.values(get(`SELECT ${columns} FROM ${table}`)).map((value) => value ?? 0).join(".") : "-")).join(","),
  };
}
