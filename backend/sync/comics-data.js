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
import { compareStamps, parseStamp } from "../../shared/sync/clock.js";
import { SOURCE_ID, WORK_ID } from "../../shared/reading/ids.js";
import { cleanSiteSettings, extChapterId, validSitePath } from "../comics/ext-sources.js";
import { NOT_IN_LIBRARY, SOURCE_TITLE_KEY } from "../comics/video-comics.js";
import { COMIC_STATUSES } from "../comics/comics-store.js";
import { safeHttpUrl } from "../comics/sources-store.js";
import { localIdFor } from "../reader/local-library.js";
import { ensureChapterChoices } from "../comics/chapter-marks.js";

// Applied in this order, so a comic exists before its sources and progress.
export const COMIC_TYPES = Object.freeze(["comic.repository", "comic.favorite", "comic.library", "comic.source", "comic.read", "comic.choice", "comic.rating"]);
export const present = (value) => value !== undefined && value !== null && value !== "";
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
  ["comic_work_sources", "COUNT(*), MAX(added_at)"], ["comic_progress", "COUNT(*), MAX(updated_at)"],
  ["comic_remote_progress", "COUNT(*), MAX(updated_at)"],
  ["comic_chapter_choices", "COUNT(*), MAX(changed_at)"], ["comic_ratings", "COUNT(*), MAX(updated_at)"],
  ["comic_ext_sources", "COUNT(*), MAX(added_at)"], ["comic_ext_settings", "COUNT(*), MAX(updated_at)"], ["comic_sources", "COUNT(*), MAX(added_at), SUM(enabled), SUM(removed)"],
]);

export function createComicsData({ db, now = Date.now, random = () => Math.random().toString(36).slice(2, 6) }) {
  ensureChapterChoices(db);
  const has = (table) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const newerHere = (row, column, change) => Boolean(row) && Number(row[column] || 0) > stampMs(change);
  let remoteReady = false;
  function ensureRemoteProgress() {
    if (remoteReady || !has("comic_progress")) return;
    // Sync can initialize before the Comics reader. One-time backfill preserves
    // only each legacy row's actual owner, even if a second work used its path.
    db.exec(`CREATE TABLE IF NOT EXISTS comic_remote_progress (
      work_id TEXT NOT NULL, file_id TEXT NOT NULL, page INTEGER NOT NULL, pages INTEGER NOT NULL,
      finished INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY(work_id, file_id));
      INSERT OR IGNORE INTO comic_remote_progress (work_id, file_id, page, pages, finished, updated_at)
        SELECT work_id, file_id, page, pages, finished, updated_at FROM comic_progress
        WHERE file_id LIKE 'ex-%' AND work_id IS NOT NULL`);
    remoteReady = true;
  }
  // SQLite change counters avoid hashing every Comics table on each short sync check.
  // Triggers are installed lazily because the sync and Comics features may start in either order.
  db.exec("CREATE TABLE IF NOT EXISTS comic_sync_metadata_revision (id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL DEFAULT 0)");
  db.exec("INSERT OR IGNORE INTO comic_sync_metadata_revision (id, revision) VALUES (1, 0)");
  const metadataTriggers = new Map([
    ["comic_work_sources", ["name", "title", "lang"]],
    ["comic_source_titles", ["video_id", "cover_url", "cover_source"]],
    // A source comic's exported origin is taken from this table. Title/type
    // updates leave the existing row count and added_at unchanged.
    ["comic_video_links", ["work_id", "video_id", "video_type", "video_title", "origin"]],
    ["comic_ext_sources", ["pkg", "repo", "ext_name", "name", "lang", "base_url", "version", "nsfw"]],
    ["comic_sources", ["name", "enabled", "removed", "config_json"]],
  ]);
  const installedTriggers = new Set();
  function ensureMetadataTriggers() {
    for (const [table, columns] of metadataTriggers) {
      if (installedTriggers.has(table) || !has(table)) continue;
      const available = new Set(all(`PRAGMA table_info(${table})`).map((column) => column.name));
      const changed = columns.filter((column) => available.has(column))
        .map((column) => `OLD.${column} IS NOT NEW.${column}`).join(" OR ");
      if (!changed) continue;
      db.exec(`CREATE TRIGGER IF NOT EXISTS implicit_comics_meta_${table} AFTER UPDATE ON ${table}
        WHEN ${changed} BEGIN
          UPDATE comic_sync_metadata_revision SET revision = revision + 1 WHERE id = 1;
        END;
        CREATE TRIGGER IF NOT EXISTS implicit_comics_meta_${table}_insert AFTER INSERT ON ${table} BEGIN
          UPDATE comic_sync_metadata_revision SET revision = revision + 1 WHERE id = 1;
        END;
        CREATE TRIGGER IF NOT EXISTS implicit_comics_meta_${table}_delete AFTER DELETE ON ${table} BEGIN
          UPDATE comic_sync_metadata_revision SET revision = revision + 1 WHERE id = 1;
        END`);
      installedTriggers.add(table);
    }
  }

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
        ON CONFLICT(work_id, video_id) DO UPDATE SET
          origin = 1, video_type = excluded.video_type, video_title = excluded.video_title`,
      change.id, videoId, video.type === "movie" ? "movie" : "series", String(video.title || title).slice(0, 200), at);
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
    ensureRemoteProgress();
    const units = has("comic_read_units");
    const progressTable = has("comic_remote_progress") ? "comic_remote_progress" : "comic_progress";
    const current = (field) => progressTable === "comic_remote_progress"
      ? `CASE WHEN legacy.updated_at > p.updated_at THEN legacy.${field} ELSE p.${field} END AS ${field}`
      : `p.${field}`;
    for (const row of all(`SELECT p.work_id, ${current("page")}, ${current("pages")}, ${current("finished")}, c.source_id, c.path${units ? ", u.volume, u.chapter" : ""}
        FROM ${progressTable} p JOIN comic_ext_chapters c ON c.id = p.file_id
          ${progressTable === "comic_remote_progress" ? "LEFT JOIN comic_progress legacy ON legacy.file_id = p.file_id AND legacy.work_id = p.work_id" : ""}
          ${units ? " LEFT JOIN comic_read_units u ON u.unit_id = p.file_id AND u.work_id = p.work_id" : ""}
        WHERE p.work_id IS NOT NULL`)) {
      const id = joinId(row.work_id, row.source_id, row.path);
      if (!WORK_ID.test(row.work_id) || id.length > 600) continue;
      out.push({ type: "comic.read", id, value: compact({ workId: row.work_id, page: row.page, pages: row.pages, finished: Boolean(row.finished), chapter: row.chapter, volume: row.volume }) });
    }
  }
  function applyRead(change, done) {
    if (!has("comic_progress") || !has("comic_ext_chapters")) return;
    ensureRemoteProgress();
    const key = parts(change.id);
    const scoped = key.length === 3;
    if (key.length !== 2 && !scoped) return;
    const [source = "", path = ""] = scoped ? key.slice(1) : key;
    if (!SOURCE_ID.test(source) || !validSitePath(path)) return;
    const id = extChapterId(source, path);
    const at = stampMs(change);
    const units = has("comic_read_units");
    const perWork = has("comic_remote_progress");
    if (change.value === null) {
      // Legacy deletions have no work key; restrict them to the sole known legacy owner.
      const owner = scoped ? key[0] : get("SELECT work_id FROM comic_progress WHERE file_id = ?", id)?.work_id;
      if (!WORK_ID.test(String(owner))) { done.add(change); return; }
      const previous = perWork
        ? get("SELECT updated_at FROM comic_remote_progress WHERE work_id = ? AND file_id = ?", owner, id)
        : get("SELECT updated_at FROM comic_progress WHERE work_id = ? AND file_id = ?", owner, id);
      if (newerHere(previous, "updated_at", change)) return;
      if (perWork) run("DELETE FROM comic_remote_progress WHERE work_id = ? AND file_id = ?", owner, id);
      run("DELETE FROM comic_progress WHERE file_id = ? AND work_id = ?", id, owner);
      if (units) run("DELETE FROM comic_read_units WHERE work_id = ? AND unit_id = ?", owner, id);
      run("DELETE FROM comic_chapter_choices WHERE work_id = ? AND unit_id = ? AND read = 2", owner, id);
      done.add(change);
      return;
    }
    const { workId, page, pages, finished = false, chapter, volume } = change.value;
    if (!WORK_ID.test(String(workId)) || (scoped && workId !== key[0])) return;
    const scopedProgress = perWork
      ? get("SELECT updated_at FROM comic_remote_progress WHERE work_id = ? AND file_id = ?", workId, id)
      : get("SELECT updated_at FROM comic_progress WHERE work_id = ? AND file_id = ?", workId, id);
    const legacyProgress = perWork
      ? get("SELECT updated_at FROM comic_progress WHERE work_id = ? AND file_id = ?", workId, id) : null;
    const existing = legacyProgress && (!scopedProgress || Number(legacyProgress.updated_at) > Number(scopedProgress.updated_at))
      ? legacyProgress : scopedProgress;
    if (newerHere(existing, "updated_at", change)) return;
    const chosen = get("SELECT read, changed_at, sync_stamp FROM comic_chapter_choices WHERE work_id = ? AND unit_id = ?", workId, id);
    if (chosen?.read === 2 && chosen.sync_stamp && compareStamps(chosen.sync_stamp, change.at) >= 0) return;
    const unreadAfterThisRead = chosen?.read <= 0 && (chosen.sync_stamp
      ? compareStamps(chosen.sync_stamp, change.at) >= 0 : Number(chosen.changed_at) > at);
    const total = Math.max(1, Math.min(Math.round(pages) || 1, 10_000));
    const spot = Math.max(0, Math.min(Math.round(page) || 0, total - 1));
    run("INSERT OR IGNORE INTO comic_ext_chapters (id, source_id, path, created_at) VALUES (?, ?, ?, ?)", id, source, path, at);
    // A source path can legitimately be attached to several works. Legacy progress
    // keeps its first known owner; independent entries live in the composite table.
    const effectiveSpot = unreadAfterThisRead && spot === total - 1 ? 0 : spot;
    const effectiveDone = finished && !unreadAfterThisRead ? 1 : 0;
    if (perWork) run(`INSERT INTO comic_remote_progress (work_id, file_id, page, pages, finished, updated_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(work_id, file_id) DO UPDATE SET
      page = excluded.page, pages = excluded.pages,
      finished = CASE WHEN ? = 1 THEN 0 ELSE MAX(comic_remote_progress.finished, excluded.finished) END,
      updated_at = excluded.updated_at`, workId, id, effectiveSpot, total, effectiveDone, at, unreadAfterThisRead ? 1 : 0);
    const shadow = get("SELECT work_id FROM comic_progress WHERE file_id = ?", id);
    if (!shadow || shadow.work_id === workId)
      run(`INSERT INTO comic_progress (file_id, work_id, page, pages, finished, updated_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(file_id) DO UPDATE SET page = excluded.page, pages = excluded.pages,
        finished = CASE WHEN ? = 1 THEN 0 ELSE MAX(comic_progress.finished, excluded.finished) END,
        updated_at = excluded.updated_at`, id, workId, effectiveSpot, total, effectiveDone, at, unreadAfterThisRead ? 1 : 0);
    if (finished && !unreadAfterThisRead && units) {
      run("INSERT OR IGNORE INTO comic_read_units (work_id, unit_id, volume, chapter, finished_at) VALUES (?, ?, ?, ?, ?)", workId, id, unitNumber(volume), unitNumber(chapter), at);
      if (chosen?.read <= 0) run("UPDATE comic_chapter_choices SET read = 1, changed_at = ?, sync_stamp = ? WHERE work_id = ? AND unit_id = ?", at, change.at, workId, id);
      else if (!chosen || chosen.read === 2) run("INSERT INTO comic_chapter_choices (work_id, unit_id, read, changed_at, source_id, path, chapter, volume, sync_stamp) "
        + "VALUES (?, ?, 2, ?, ?, ?, ?, ?, ?) ON CONFLICT(work_id, unit_id) DO UPDATE SET "
        + "read = 2, changed_at = excluded.changed_at, source_id = excluded.source_id, path = excluded.path, "
        + "chapter = excluded.chapter, volume = excluded.volume, sync_stamp = excluded.sync_stamp",
      workId, id, at, source, path, unitNumber(chapter), unitNumber(volume), change.at);
    }
    done.add(change);
  }

  function exportChoices(out) {
    if (!has("comic_chapter_choices")) return;
    const withChapter = has("comic_ext_chapters");
    const sql = "SELECT k.work_id, k.unit_id, k.read, k.changed_at, k.chapter, k.volume, "
      + (withChapter ? "COALESCE(k.source_id, c.source_id) AS source_id, COALESCE(k.path, c.path) AS path" : "k.source_id, k.path")
      + " FROM comic_chapter_choices k"
      + (withChapter ? " LEFT JOIN comic_ext_chapters c ON c.id = k.unit_id" : "");
    for (const row of all(sql)) {
      if (row.read < 0 || row.read > 1) continue;
      if (!WORK_ID.test(row.work_id) || !SOURCE_ID.test(String(row.source_id)) || !validSitePath(row.path) ||
          extChapterId(row.source_id, row.path) !== row.unit_id || (present(row.chapter) && !unitNumber(row.chapter))) continue;
      const key = joinId(row.work_id, row.source_id, row.path);
      if (key.length > 600) continue;
      out.push({ type: "comic.choice", id: key,
        value: compact({ read: Boolean(row.read), chapter: row.chapter, volume: row.volume, updatedAt: row.changed_at }) });
    }
  }

  function applyChoice(change, done) {
    if (!has("comic_chapter_choices") || !has("comic_read_units")) return;
    ensureRemoteProgress();
    const [work = "", source = "", path = ""] = parts(change.id);
    if (!WORK_ID.test(work) || !SOURCE_ID.test(source) || !validSitePath(path)) return;
    const id = extChapterId(source, path);
    const at = stampMs(change);
    const prior = get("SELECT read, changed_at, sync_stamp, chapter, volume FROM comic_chapter_choices WHERE work_id = ? AND unit_id = ?", work, id);
    // A locally authored choice has no sync_stamp until another device applies
    // it. Once this device has sent it, the sync registry knows its full HLC:
    // compare that rather than a millisecond timestamp that may be tied.
    const sentStamp = !prior?.sync_stamp && has("sync_items")
      ? parse(get("SELECT change_json FROM sync_items WHERE item_key = ?", `comic.choice ${change.id}`)?.change_json).at : null;
    const previousStamp = prior?.sync_stamp || sentStamp;
    if (prior && (previousStamp ? compareStamps(previousStamp, change.at) >= 0 : Number(prior.changed_at) > at)) return;
    // The legacy row is still authoritative for its original owner if an older
    // local client updated it directly. Other works use their separate rows.
    const legacyProgress = has("comic_progress")
      ? get("SELECT finished, updated_at FROM comic_progress WHERE work_id = ? AND file_id = ?", work, id) : null;
    const scopedProgress = has("comic_remote_progress")
      ? get("SELECT finished, updated_at FROM comic_remote_progress WHERE work_id = ? AND file_id = ?", work, id) : null;
    const sentRead = has("sync_items")
      ? [joinId(work, source, path), joinId(source, path)]
        .map((id) => parse(get("SELECT change_json FROM sync_items WHERE item_key = ?", `comic.read ${id}`)?.change_json).at)
        .filter(Boolean).sort(compareStamps).at(-1) : null;
    // A legacy owner's progress can have been acknowledged under the old read
    // key. Its matching HLC is authoritative when comparing a cross-type
    // choice at the same millisecond, even if the new shadow has a newer clock.
    const acknowledgedLegacy = Boolean(legacyProgress && sentRead &&
      Number(legacyProgress.updated_at) === (parseStamp(sentRead)?.ms ?? -1));
    const progress = acknowledgedLegacy ? legacyProgress
      : scopedProgress && (!legacyProgress || Number(scopedProgress.updated_at) > Number(legacyProgress.updated_at))
        ? scopedProgress : legacyProgress || scopedProgress;
    const readStamp = [prior?.read === 2 ? prior.sync_stamp : null, sentRead]
      .filter(Boolean).sort(compareStamps).at(-1);
    const unsentCompletion = progress?.finished && (readStamp
      ? Number(progress.updated_at) > (parseStamp(readStamp)?.ms || 0) && Number(progress.updated_at) >= at
      : Number(progress.updated_at) >= at);
    if ((!change.value || change.value.read === false) && progress?.finished &&
        (unsentCompletion || (readStamp && compareStamps(readStamp, change.at) > 0))) {
      const unit = get("SELECT chapter, volume FROM comic_read_units WHERE work_id = ? AND unit_id = ?", work, id);
      run("INSERT INTO comic_chapter_choices (work_id, unit_id, read, changed_at, source_id, path, chapter, volume, sync_stamp) "
        + "VALUES (?, ?, 1, ?, ?, ?, ?, ?, NULL) ON CONFLICT(work_id, unit_id) DO UPDATE SET "
        + "read = 1, changed_at = excluded.changed_at, source_id = excluded.source_id, path = excluded.path, "
        + "chapter = excluded.chapter, volume = excluded.volume, sync_stamp = NULL",
      work, id, Number(progress.updated_at), source, path,
      unitNumber(unit?.chapter ?? change.value?.chapter ?? prior?.chapter), unitNumber(unit?.volume ?? change.value?.volume ?? prior?.volume));
      return;
    }
    if (change.value === null) {
      run("INSERT INTO comic_chapter_choices (work_id, unit_id, read, changed_at, source_id, path, sync_stamp) "
        + "VALUES (?, ?, -1, ?, ?, ?, ?) ON CONFLICT(work_id, unit_id) DO UPDATE SET "
        + "read = -1, changed_at = excluded.changed_at, source_id = excluded.source_id, path = excluded.path, sync_stamp = excluded.sync_stamp",
      work, id, at, source, path, change.at);
      const finished = progress?.finished || 0;
      if (!finished) run("DELETE FROM comic_read_units WHERE work_id = ? AND unit_id = ?", work, id);
      done.add(change);
      return;
    }
    const { read, chapter, volume } = change.value;
    if (typeof read !== "boolean" || (present(chapter) && !unitNumber(chapter)) || (present(volume) && !unitNumber(volume))) return;
    run("INSERT INTO comic_chapter_choices (work_id, unit_id, read, changed_at, source_id, path, chapter, volume, sync_stamp) "
      + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(work_id, unit_id) DO UPDATE SET "
      + "read = excluded.read, changed_at = excluded.changed_at, source_id = excluded.source_id, path = excluded.path, "
      + "chapter = excluded.chapter, volume = excluded.volume, sync_stamp = excluded.sync_stamp",
    work, id, read ? 1 : 0, at, source, path, unitNumber(chapter), unitNumber(volume), change.at);
    if (read) {
      run("INSERT INTO comic_read_units (work_id, unit_id, volume, chapter, finished_at) VALUES (?, ?, ?, ?, ?) "
        + "ON CONFLICT(work_id, unit_id) DO UPDATE SET volume = excluded.volume, chapter = excluded.chapter, finished_at = excluded.finished_at",
      work, id, unitNumber(volume), unitNumber(chapter), at);
    } else {
      run("DELETE FROM comic_read_units WHERE work_id = ? AND unit_id = ?", work, id);
      if (progress && Number(progress.updated_at) <= at)
        run("UPDATE comic_progress SET finished = 0, page = CASE WHEN page >= pages - 1 THEN 0 ELSE page END, "
          + "updated_at = ? WHERE work_id = ? AND file_id = ?", at, work, id);
      if (progress && Number(progress.updated_at) <= at && has("comic_remote_progress"))
        run("UPDATE comic_remote_progress SET finished = 0, page = CASE WHEN page >= pages - 1 THEN 0 ELSE page END, "
          + "updated_at = ? WHERE work_id = ? AND file_id = ?", at, work, id);
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
    "comic.source": applySource, "comic.read": applyRead, "comic.choice": applyChoice, "comic.rating": applyRating };
  return {
    types: COMIC_TYPES,
    export(out) { exportRepositories(out); exportFavorites(out); exportLibrary(out); exportSources(out); exportRead(out); exportChoices(out); exportRatings(out); },
    apply(change, done) { appliers[change.type]?.(change, done); },
    mark: () => {
      ensureRemoteProgress();
      ensureMetadataTriggers();
      return MARKS.map(([table, columns]) => (has(table) ? Object.values(get(`SELECT ${columns} FROM ${table}`)).map((value) => value ?? 0).join(".") : "-")).join(",")
        + `,meta:${get("SELECT revision FROM comic_sync_metadata_revision WHERE id = 1")?.revision ?? 0}`;
    },
  };
}
