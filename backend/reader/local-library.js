// Local comic files: watched folders, scanning, matching to
// AniList, local-only titles, manual matches and reading progress. Files are
// read where they are and never modified.
import fs from "node:fs/promises";
import { watch as watchFolder } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { IMAGE_EXT, listPages } from "./pages.js";
import { normalizeSeriesName, parseReleaseName } from "../../shared/reading/release-name.js";
import { compareUnitNumbers } from "../../shared/reading/units.js";
import { EXT_CHAPTER_ID, WORK_ID } from "../../shared/reading/ids.js";

export const SCAN_LIMITS = Object.freeze({ depth: 6, files: 20_000 });
const ARCHIVE_EXT = /\.(?:cbz|zip)$/i;
const RESCAN_MS = 10 * 60 * 1000;
const WATCH_DEBOUNCE_MS = 2000;

const hash = (value, size = 12) => crypto.createHash("sha1").update(String(value)).digest("hex").slice(0, size);
export const fileIdFor = (fullPath) => `f${hash(path.resolve(fullPath).toLowerCase(), 16)}`;
export const localIdFor = (seriesKey) => `local-${hash(seriesKey)}`;

export function createLocalLibrary({ db, dataRoot, now = Date.now, log = console } = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS comic_folders (path TEXT PRIMARY KEY, is_default INTEGER NOT NULL DEFAULT 0, added_at INTEGER NOT NULL, scanned_at INTEGER, files INTEGER NOT NULL DEFAULT 0, error TEXT);
    CREATE TABLE IF NOT EXISTS comic_files (
      id TEXT PRIMARY KEY, folder TEXT NOT NULL, path TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, size INTEGER NOT NULL, mtime INTEGER NOT NULL,
      pages INTEGER NOT NULL DEFAULT 0, series TEXT NOT NULL, series_key TEXT NOT NULL, volume TEXT, volume_end TEXT, chapter TEXT, chapter_end TEXT,
      anilist_hint INTEGER, work_id TEXT, match TEXT NOT NULL DEFAULT 'pending', reason TEXT, error TEXT, seen_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS comic_files_work ON comic_files(work_id);
    CREATE TABLE IF NOT EXISTS comic_local_titles (id TEXT PRIMARY KEY, title TEXT NOT NULL, series_key TEXT NOT NULL, status TEXT NOT NULL, added_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS comic_match_overrides (series_key TEXT PRIMARY KEY, work_id TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS comic_progress (file_id TEXT PRIMARY KEY, work_id TEXT, page INTEGER NOT NULL, pages INTEGER NOT NULL, finished INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS comic_read_units (work_id TEXT NOT NULL, unit_id TEXT NOT NULL, volume TEXT, chapter TEXT, finished_at INTEGER NOT NULL, PRIMARY KEY (work_id, unit_id));
  `);
  const q = {
    folders: db.prepare("SELECT path, is_default, added_at, scanned_at, files, error FROM comic_folders ORDER BY is_default DESC, added_at"),
    addFolder: db.prepare("INSERT OR IGNORE INTO comic_folders (path, is_default, added_at) VALUES (?, ?, ?)"),
    removeFolder: db.prepare("DELETE FROM comic_folders WHERE path = ? AND is_default = 0"),
    folderScanned: db.prepare("UPDATE comic_folders SET scanned_at = ?, files = ?, error = ? WHERE path = ?"),
    filesIn: db.prepare("SELECT * FROM comic_files WHERE folder = ?"),
    file: db.prepare("SELECT * FROM comic_files WHERE id = ?"),
    upsertFile: db.prepare(`INSERT INTO comic_files (id, folder, path, kind, size, mtime, pages, series, series_key, volume, volume_end, chapter, chapter_end, anilist_hint, match, error, seen_at)
      VALUES (@id, @folder, @path, @kind, @size, @mtime, @pages, @series, @series_key, @volume, @volume_end, @chapter, @chapter_end, @anilist_hint, 'pending', @error, @seen_at)
      ON CONFLICT(id) DO UPDATE SET size = excluded.size, mtime = excluded.mtime, pages = excluded.pages, error = excluded.error, seen_at = excluded.seen_at`),
    touchFile: db.prepare("UPDATE comic_files SET seen_at = ? WHERE id = ?"),
    deleteFile: db.prepare("DELETE FROM comic_files WHERE id = ?"),
    deleteFilesIn: db.prepare("DELETE FROM comic_files WHERE folder = ?"),
    pending: db.prepare("SELECT * FROM comic_files WHERE match = 'pending' AND error IS NULL ORDER BY series_key"),
    setMatch: db.prepare("UPDATE comic_files SET work_id = ?, match = ?, reason = ? WHERE series_key = ? AND match IN ('pending', 'auto', 'local')"),
    setMatchManual: db.prepare("UPDATE comic_files SET work_id = ?, match = 'manual', reason = ? WHERE work_id = ?"),
    filesOf: db.prepare("SELECT * FROM comic_files WHERE work_id = ? AND error IS NULL"),
    workCounts: db.prepare("SELECT work_id, COUNT(*) AS files FROM comic_files WHERE work_id IS NOT NULL AND error IS NULL GROUP BY work_id"),
    override: db.prepare("SELECT work_id FROM comic_match_overrides WHERE series_key = ?"),
    setOverride: db.prepare("INSERT INTO comic_match_overrides (series_key, work_id, at) VALUES (?, ?, ?) ON CONFLICT(series_key) DO UPDATE SET work_id = excluded.work_id, at = excluded.at"),
    localTitles: db.prepare("SELECT * FROM comic_local_titles ORDER BY updated_at DESC"),
    localTitle: db.prepare("SELECT * FROM comic_local_titles WHERE id = ?"),
    addLocal: db.prepare("INSERT OR IGNORE INTO comic_local_titles (id, title, series_key, status, added_at, updated_at) VALUES (?, ?, ?, 'PLANNING', ?, ?)"),
    setLocalStatus: db.prepare("UPDATE comic_local_titles SET status = ?, updated_at = ? WHERE id = ?"),
    deleteLocal: db.prepare("DELETE FROM comic_local_titles WHERE id = ?"),
    progress: db.prepare("SELECT * FROM comic_progress WHERE file_id = ?"),
    progressOf: db.prepare("SELECT * FROM comic_progress WHERE work_id = ?"),
    saveProgress: db.prepare(`INSERT INTO comic_progress (file_id, work_id, page, pages, finished, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_id) DO UPDATE SET work_id = excluded.work_id, page = excluded.page, pages = excluded.pages, finished = MAX(comic_progress.finished, excluded.finished), updated_at = excluded.updated_at`),
    markRead: db.prepare("INSERT OR IGNORE INTO comic_read_units (work_id, unit_id, volume, chapter, finished_at) VALUES (?, ?, ?, ?, ?)"),
    readUnits: db.prepare("SELECT volume, chapter FROM comic_read_units WHERE work_id = ?"),
  };

  const defaultFolder = path.join(dataRoot, "comics");
  let watchers = [];
  let timer = null;
  let scanning = null;
  const debounce = new Map();

  async function ensureDefaultFolder() {
    await fs.mkdir(defaultFolder, { recursive: true });
    q.addFolder.run(defaultFolder, 1, now());
  }

  // Bounded walk: archives, and folders that directly contain images (one chapter or volume each).
  async function walk(root) {
    const found = [];
    const visit = async (dir, depth) => {
      if (depth > SCAN_LIMITS.depth || found.length >= SCAN_LIMITS.files) return;
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      let images = 0;
      for (const entry of entries) {
        if (found.length >= SCAN_LIMITS.files) return;
        if (entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await visit(full, depth + 1);
        else if (entry.isFile() && ARCHIVE_EXT.test(entry.name)) found.push({ full, kind: "cbz" });
        else if (entry.isFile() && IMAGE_EXT.test(entry.name)) images += 1;
      }
      if (images > 0 && dir !== root) found.push({ full: dir, kind: "folder" });
    };
    await visit(root, 0);
    return found;
  }

  function describe(full, kind, root) {
    const base = path.basename(full);
    const parsed = parseReleaseName(base);
    const parent = path.dirname(full) === root ? "" : path.basename(path.dirname(full));
    const parentSeries = parent ? parseReleaseName(parent).series || parent : "";
    const series = (kind === "folder" ? parentSeries || parsed.series : parsed.series || parentSeries) || base;
    return { parsed, series };
  }

  async function scanFolder(root) {
    const started = now();
    const known = new Map(q.filesIn.all(root).map((row) => [row.id, row]));
    let error = null;
    let count = 0;
    try {
      const stat = await fs.stat(root);
      if (!stat.isDirectory()) throw new Error("Not a folder");
      for (const { full, kind } of await walk(root)) {
        const id = fileIdFor(full);
        const stat2 = await fs.stat(full).catch(() => null);
        if (!stat2) continue;
        count += 1;
        const size = kind === "folder" ? 0 : stat2.size;
        const mtime = Math.round(stat2.mtimeMs);
        const old = known.get(id);
        known.delete(id);
        if (old && old.size === size && old.mtime === mtime) { q.touchFile.run(started, id); continue; }
        const { parsed, series } = describe(full, kind, root);
        let pages = 0;
        let info = null;
        let fileError = null;
        try {
          const listed = await listPages({ path: full, kind, mtime });
          pages = listed.pages.length;
          info = listed.comicInfo;
          if (!pages) fileError = "No pages";
        } catch (problem) {
          fileError = String(problem?.message || "Unreadable").slice(0, 200);
        }
        const name = info?.series || series;
        q.upsertFile.run({
          id, folder: root, path: full, kind, size, mtime, pages, series: name, series_key: normalizeSeriesName(name) || id,
          volume: parsed.volume ?? (info?.volume || null), volume_end: parsed.volumeEnd, chapter: parsed.chapter ?? (info?.number || null),
          chapter_end: parsed.chapterEnd, anilist_hint: info?.anilistId || null, error: fileError, seen_at: started,
        });
      }
    } catch (problem) {
      error = String(problem?.message || problem).slice(0, 200);
    }
    if (!error) for (const id of known.keys()) q.deleteFile.run(id);
    q.folderScanned.run(started, count, error, root);
    return { folder: root, files: count, error };
  }

  // Pending files are matched per series: a manual override first, then the
  // ComicInfo AniList link, then an exact title/alias match from search(name).
  // Anything else becomes a local-only title in the Library.
  async function matchPending({ search, ensureLibrary }) {
    const groups = new Map();
    for (const row of q.pending.all()) if (!groups.has(row.series_key)) groups.set(row.series_key, row);
    const results = [];
    for (const [key, row] of groups) {
      let workId = q.override.get(key)?.work_id || null;
      let reason = workId ? "manual" : "";
      if (!workId && row.anilist_hint) { workId = `anilist-${row.anilist_hint}`; reason = "comicinfo"; }
      if (!workId && search) {
        try {
          const wanted = normalizeSeriesName(row.series);
          const hit = (await search(row.series)).find((comic) => [comic.title, ...(comic.aliases || [])].some((name) => normalizeSeriesName(name) === wanted));
          if (hit) { workId = `anilist-${hit.anilistId}`; reason = "title"; }
        } catch (problem) {
          log.warn?.("Comic match search failed:", problem?.message);
          continue; // Stay pending; the next scan tries again.
        }
      }
      if (workId?.startsWith("anilist-")) {
        q.setMatch.run(workId, reason === "manual" ? "manual" : "auto", reason, key);
        await ensureLibrary?.(Number(workId.slice(8)));
      } else {
        const localId = workId?.startsWith("local-") ? workId : localIdFor(key);
        q.addLocal.run(localId, row.series, key, now(), now());
        q.setMatch.run(localId, "local", "unmatched", key);
        workId = localId;
      }
      results.push({ series: row.series, workId, reason: reason || "unmatched" });
    }
    return results;
  }

  async function scanAll(options = {}) {
    if (scanning) return scanning;
    scanning = (async () => {
      await ensureDefaultFolder();
      const folders = [];
      for (const folder of q.folders.all()) folders.push(await scanFolder(folder.path));
      const matched = await matchPending(options);
      return { folders, matched };
    })().finally(() => { scanning = null; });
    return scanning;
  }

  function fileView(row) {
    const progress = q.progress.get(row.id);
    return {
      id: row.id, name: path.basename(row.path), kind: row.kind, pages: row.pages, series: row.series,
      volume: row.volume, volumeEnd: row.volume_end, chapter: row.chapter, chapterEnd: row.chapter_end, match: row.match,
      progress: progress ? { page: progress.page, pages: progress.pages, finished: Boolean(progress.finished), updatedAt: progress.updated_at } : null,
    };
  }
  const sortFiles = (a, b) => compareUnitNumbers(a.volume, b.volume) || compareUnitNumbers(a.chapter, b.chapter) || a.name.localeCompare(b.name, undefined, { numeric: true });

  return {
    defaultFolder,
    ensureDefaultFolder,
    folders: () => q.folders.all().map((row) => ({ path: row.path, isDefault: Boolean(row.is_default), addedAt: row.added_at, scannedAt: row.scanned_at, files: row.files, error: row.error })),
    async addFolder(folder) {
      const full = path.resolve(String(folder || ""));
      if (!path.isAbsolute(String(folder || "")) || full.length > 400) throw new Error("Enter the full path of a folder");
      const stat = await fs.stat(full).catch(() => null);
      if (!stat?.isDirectory()) throw new Error("That folder doesn't exist");
      q.addFolder.run(full, 0, now());
      return full;
    },
    removeFolder(folder) {
      const full = path.resolve(String(folder || ""));
      const removed = q.removeFolder.run(full).changes > 0;
      if (removed) q.deleteFilesIn.run(full);
      return removed;
    },
    scanAll,
    matchPending,
    file: (id) => q.file.get(String(id)) || null,
    files: (workId) => q.filesOf.all(String(workId)).map(fileView).sort(sortFiles),
    fileCounts: () => new Map(q.workCounts.all().map((row) => [row.work_id, row.files])),
    localTitles: () => q.localTitles.all(),
    localTitle: (id) => q.localTitle.get(String(id)) || null,
    setLocalStatus: (id, status) => q.setLocalStatus.run(status, now(), String(id)).changes > 0,
    // A title with no files (a comic read from sources only); kept if it exists.
    createTitle({ id, title, seriesKey, status = "NONE" }) {
      db.prepare("INSERT OR IGNORE INTO comic_local_titles (id, title, series_key, status, added_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(String(id), String(title).slice(0, 200), String(seriesKey).slice(0, 300), String(status), now(), now());
      return q.localTitle.get(String(id)) || null;
    },
    renameTitle: (id, title) => db.prepare("UPDATE comic_local_titles SET title = ?, updated_at = ? WHERE id = ?").run(String(title).slice(0, 200), now(), String(id)).changes > 0,
    // Hide a local title: its files stay on disk but are no longer listed.
    removeLocal(id) {
      db.prepare("UPDATE comic_files SET work_id = NULL, match = 'ignored' WHERE work_id = ?").run(String(id));
      return q.deleteLocal.run(String(id)).changes > 0;
    },
    // Move every file of fromWorkId to toWorkId ("anilist-N", or null for a new local title).
    rematch(fromWorkId, toWorkId) {
      const files = q.filesOf.all(String(fromWorkId));
      if (!files.length) return null;
      const keys = [...new Set(files.map((row) => row.series_key))];
      let target = toWorkId;
      if (!target) {
        target = localIdFor(`manual:${keys[0]}`);
        q.addLocal.run(target, files[0].series, keys[0], now(), now());
      }
      q.setMatchManual.run(target, "manual", String(fromWorkId));
      for (const key of keys) q.setOverride.run(key, target, now());
      if (String(fromWorkId).startsWith("local-")) q.deleteLocal.run(String(fromWorkId));
      return target;
    },
    // Files under dirPath (a finished download) belong to workId, now and on later scans.
    assignPath(dirPath, workId) {
      const prefix = path.resolve(dirPath).toLowerCase() + path.sep;
      const rows = db.prepare("SELECT id, path, series_key FROM comic_files").all().filter((row) => path.resolve(row.path).toLowerCase().startsWith(prefix) || path.resolve(row.path).toLowerCase() === prefix.slice(0, -1));
      for (const key of new Set(rows.map((row) => row.series_key))) q.setOverride.run(key, String(workId), now());
      const update = db.prepare("UPDATE comic_files SET work_id = ?, match = 'manual', reason = 'download' WHERE id = ?");
      for (const row of rows) update.run(String(workId), row.id);
      return rows.length;
    },
    saveProgress({ fileId, page, pages, finished }) {
      const row = q.file.get(String(fileId));
      if (!row) return null;
      const total = Math.max(1, Math.min(Number(pages) || row.pages || 1, 100_000));
      const at = Math.max(0, Math.min(Number(page) || 0, total - 1));
      const done = finished || at >= total - 1;
      q.saveProgress.run(row.id, row.work_id, at, total, done ? 1 : 0, now());
      if (done && row.work_id) q.markRead.run(row.work_id, row.id, row.volume_end || row.volume, row.chapter_end || row.chapter, now());
      return fileView(row);
    },
    progressOf: (workId) => q.progressOf.all(String(workId)),
    // Chapters read from a source: id is "ex-<20 hex>" (see backend/comics/ext-sources.js).
    saveRemoteProgress({ id, workId, page, pages, chapter = null, volume = null }) {
      if (!EXT_CHAPTER_ID.test(String(id)) || !WORK_ID.test(String(workId))) return null;
      const total = Math.max(1, Math.min(Number(pages) || 1, 10_000));
      const at = Math.max(0, Math.min(Number(page) || 0, total - 1));
      q.saveProgress.run(String(id), String(workId), at, total, at >= total - 1 ? 1 : 0, now());
      const clean = (value) => (/^\d{1,5}(?:\.\d{1,2})?$/.test(String(value ?? "")) ? String(value) : null);
      if (at >= total - 1) q.markRead.run(String(workId), String(id), clean(volume), clean(chapter), now());
      const row = q.progress.get(String(id));
      return { id: row.file_id, page: row.page, pages: row.pages, finished: Boolean(row.finished) };
    },
    // Highest chapter and volume finished (for AniList progress and "new chapters").
    readSummary(workId) {
      let chapters = 0;
      let volumes = 0;
      const rows = q.readUnits.all(String(workId));
      for (const row of rows) {
        chapters = Math.max(chapters, Math.floor(Number(row.chapter) || 0));
        volumes = Math.max(volumes, Math.floor(Number(row.volume) || 0));
      }
      return { chapters, volumes, units: rows.length, readChapters: [...new Set(rows.map((row) => row.chapter).filter(Boolean))], readVolumes: [...new Set(rows.filter((row) => !row.chapter).map((row) => row.volume).filter(Boolean))] };
    },
    remoteProgress: (id) => q.progress.get(String(id)) || null,
    start({ search, ensureLibrary } = {}) {
      const run = () => scanAll({ search, ensureLibrary }).catch((problem) => log.warn?.("Comic scan failed:", problem?.message));
      void run();
      timer = setInterval(run, RESCAN_MS);
      timer.unref?.();
      for (const folder of q.folders.all()) {
        try {
          const watcher = watchFolder(folder.path, { recursive: true }, () => {
            clearTimeout(debounce.get(folder.path));
            const wait = setTimeout(run, WATCH_DEBOUNCE_MS);
            wait.unref?.();
            debounce.set(folder.path, wait);
          });
          watcher.on("error", () => {});
          watchers.push(watcher);
        } catch {}
      }
    },
    stop() {
      clearInterval(timer);
      for (const wait of debounce.values()) clearTimeout(wait);
      for (const watcher of watchers) watcher.close();
      watchers = [];
    },
  };
}
