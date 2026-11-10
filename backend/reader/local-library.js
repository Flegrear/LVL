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
export const fileIdFor = (fullPath, { platform = path.sep === "\\" ? "win32" : "posix" } = {}) =>
  `f${hash(platform === "win32" ? path.resolve(fullPath).toLowerCase() : path.resolve(fullPath), 16)}`;
const legacyFileIdFor = (fullPath) => `f${hash(path.resolve(fullPath).toLowerCase(), 16)}`;
export const localIdFor = (seriesKey) => `local-${hash(seriesKey)}`;
// A chapter or volume number as stored with a read chapter ("12", "12.5"), else null.
const unitNumber = (value) => (/^\d{1,5}(?:\.\d{1,2})?$/.test(String(value ?? "")) ? String(value) : null);

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
    CREATE TABLE IF NOT EXISTS comic_remote_progress (
      work_id TEXT NOT NULL, file_id TEXT NOT NULL, page INTEGER NOT NULL, pages INTEGER NOT NULL,
      finished INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY (work_id, file_id));
    CREATE TABLE IF NOT EXISTS comic_read_units (work_id TEXT NOT NULL, unit_id TEXT NOT NULL, volume TEXT, chapter TEXT, finished_at INTEGER NOT NULL, PRIMARY KEY (work_id, unit_id));
  `);
  // Old records have exactly one known owner; migrate only that association.
  // Repeating this insertion is harmless, including after an interrupted start.
  db.exec(`INSERT OR IGNORE INTO comic_remote_progress (work_id, file_id, page, pages, finished, updated_at)
    SELECT work_id, file_id, page, pages, finished, updated_at FROM comic_progress
    WHERE file_id LIKE 'ex-%' AND work_id IS NOT NULL`);
  const atomic = (run) => {
    db.exec("SAVEPOINT comic_reading_atomic");
    try { const result = run(); db.exec("RELEASE comic_reading_atomic"); return result; }
    catch (error) { db.exec("ROLLBACK TO comic_reading_atomic"); db.exec("RELEASE comic_reading_atomic"); throw error; }
  };
  const q = {
    folders: db.prepare("SELECT path, is_default, added_at, scanned_at, files, error FROM comic_folders ORDER BY is_default DESC, added_at"),
    addFolder: db.prepare("INSERT OR IGNORE INTO comic_folders (path, is_default, added_at) VALUES (?, ?, ?)"),
    removeFolder: db.prepare("DELETE FROM comic_folders WHERE path = ? AND is_default = 0"),
    folderPresent: db.prepare("SELECT 1 FROM comic_folders WHERE path = ?"),
    folderScanned: db.prepare("UPDATE comic_folders SET scanned_at = ?, files = ?, error = ? WHERE path = ?"),
    filesIn: db.prepare("SELECT * FROM comic_files WHERE folder = ?"),
    file: db.prepare("SELECT * FROM comic_files WHERE id = ?"),
    upsertFile: db.prepare(`INSERT INTO comic_files (id, folder, path, kind, size, mtime, pages, series, series_key, volume, volume_end, chapter, chapter_end, anilist_hint, match, error, seen_at)
      VALUES (@id, @folder, @path, @kind, @size, @mtime, @pages, @series, @series_key, @volume, @volume_end, @chapter, @chapter_end, @anilist_hint, 'pending', @error, @seen_at)
      ON CONFLICT(id) DO UPDATE SET folder = excluded.folder, path = excluded.path, kind = excluded.kind,
        size = excluded.size, mtime = excluded.mtime, pages = excluded.pages, series = excluded.series,
        series_key = excluded.series_key, volume = excluded.volume, volume_end = excluded.volume_end,
        chapter = excluded.chapter, chapter_end = excluded.chapter_end, anilist_hint = excluded.anilist_hint,
        error = excluded.error, seen_at = excluded.seen_at`),
    resetFile: db.prepare("UPDATE comic_files SET work_id = NULL, match = 'pending', reason = NULL WHERE id = ?"),
    touchFile: db.prepare("UPDATE comic_files SET seen_at = ? WHERE id = ?"),
    deleteFile: db.prepare("DELETE FROM comic_files WHERE id = ?"),
    deleteFilesIn: db.prepare("DELETE FROM comic_files WHERE folder = ?"),
    pending: db.prepare("SELECT * FROM comic_files WHERE match = 'pending' AND error IS NULL ORDER BY series_key"),
    setMatch: db.prepare("UPDATE comic_files SET work_id = ?, match = ?, reason = ? WHERE series_key = ? AND match IN ('pending', 'auto', 'local')"),
    setMatchManual: db.prepare("UPDATE comic_files SET work_id = ?, match = 'manual', reason = ? WHERE work_id = ?"),
    filesOf: db.prepare("SELECT * FROM comic_files WHERE work_id = ? AND error IS NULL"),
    anyOwnedFile: db.prepare("SELECT 1 FROM comic_files WHERE work_id = ? LIMIT 1"),
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
    remoteProgress: db.prepare("SELECT * FROM comic_remote_progress WHERE work_id = ? AND file_id = ?"),
    remoteProgressOf: db.prepare("SELECT * FROM comic_remote_progress WHERE work_id = ?"),
    remoteSave: db.prepare(`INSERT INTO comic_remote_progress (work_id, file_id, page, pages, finished, updated_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(work_id, file_id) DO UPDATE SET
      page = excluded.page, pages = excluded.pages,
      finished = MAX(comic_remote_progress.finished, excluded.finished), updated_at = excluded.updated_at`),
    remoteReplace: db.prepare(`INSERT INTO comic_remote_progress (work_id, file_id, page, pages, finished, updated_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(work_id, file_id) DO UPDATE SET
      page = excluded.page, pages = excluded.pages, finished = excluded.finished, updated_at = excluded.updated_at`),
    saveProgress: db.prepare(`INSERT INTO comic_progress (file_id, work_id, page, pages, finished, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_id) DO UPDATE SET work_id = excluded.work_id, page = excluded.page, pages = excluded.pages, finished = MAX(comic_progress.finished, excluded.finished), updated_at = excluded.updated_at`),
    deleteProgress: db.prepare("DELETE FROM comic_progress WHERE file_id = ?"),
    deleteRemote: db.prepare("DELETE FROM comic_remote_progress WHERE file_id = ?"),
    deleteReadUnit: db.prepare("DELETE FROM comic_read_units WHERE unit_id = ?"),
    deleteLocalReadUnit: db.prepare("DELETE FROM comic_read_units WHERE work_id = ? AND unit_id = ?"),
    markRead: db.prepare("INSERT OR IGNORE INTO comic_read_units (work_id, unit_id, volume, chapter, finished_at) VALUES (?, ?, ?, ?, ?)"),
    readUnits: db.prepare("SELECT volume, chapter FROM comic_read_units WHERE work_id = ?"),
  };

  const defaultFolder = path.join(dataRoot, "comics");
  let watchers = [];
  let timer = null;
  let scanning = null;
  const debounce = new Map();
  const folderGenerations = new Map();
  const liveFolder = (root, generation) => (folderGenerations.get(root) || 0) === generation && Boolean(q.folderPresent.get(root));
  const deleteFileHistory = (id) => {
    q.deleteProgress.run(id);
    q.deleteRemote.run(id);
    q.deleteReadUnit.run(id);
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'comic_chapter_choices'").get())
      db.prepare("DELETE FROM comic_chapter_choices WHERE unit_id = ?").run(id);
  };
  const transferReadState = (id, fromWorkId, toWorkId) => {
    if (!fromWorkId || fromWorkId === toWorkId) return;
    db.prepare("UPDATE comic_progress SET work_id = ? WHERE file_id = ? AND work_id = ?").run(toWorkId, id, fromWorkId);
    db.prepare(`INSERT OR IGNORE INTO comic_read_units (work_id, unit_id, volume, chapter, finished_at)
      SELECT ?, unit_id, volume, chapter, finished_at FROM comic_read_units
      WHERE work_id = ? AND unit_id = ?`).run(toWorkId, fromWorkId, id);
    q.deleteLocalReadUnit.run(fromWorkId, id);
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'comic_chapter_choices'").get()) {
      db.prepare(`INSERT OR IGNORE INTO comic_chapter_choices
        (work_id, unit_id, read, changed_at, source_id, path, chapter, volume, sync_stamp)
        SELECT ?, unit_id, read, changed_at, source_id, path, chapter, volume, sync_stamp
        FROM comic_chapter_choices WHERE work_id = ? AND unit_id = ?`).run(toWorkId, fromWorkId, id);
      db.prepare("DELETE FROM comic_chapter_choices WHERE work_id = ? AND unit_id = ?").run(fromWorkId, id);
    }
  };
  const migrateFileId = (previous, next) => atomic(() => {
    // A pre-fix lowercased id is transferred only when its exact path is known.
    const occupiedHistory = q.progress.get(next) ||
      db.prepare("SELECT 1 FROM comic_read_units WHERE unit_id = ?").get(next) ||
      (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'comic_chapter_choices'").get() &&
        db.prepare("SELECT 1 FROM comic_chapter_choices WHERE unit_id = ?").get(next));
    if (q.file.get(next) || occupiedHistory) return false;
    if (!db.prepare("UPDATE comic_files SET id = ? WHERE id = ?").run(next, previous).changes) return false;
    db.prepare("UPDATE comic_progress SET file_id = ? WHERE file_id = ?").run(next, previous);
    q.deleteProgress.run(previous);
    db.prepare(`INSERT OR IGNORE INTO comic_read_units (work_id, unit_id, volume, chapter, finished_at)
      SELECT work_id, ?, volume, chapter, finished_at FROM comic_read_units WHERE unit_id = ?`).run(next, previous);
    q.deleteReadUnit.run(previous);
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'comic_chapter_choices'").get()) {
      db.prepare(`INSERT OR IGNORE INTO comic_chapter_choices (work_id, unit_id, read, changed_at, source_id, path, chapter, volume, sync_stamp)
        SELECT work_id, ?, read, changed_at, source_id, path, chapter, volume, sync_stamp
        FROM comic_chapter_choices WHERE unit_id = ?`).run(next, previous);
      db.prepare("DELETE FROM comic_chapter_choices WHERE unit_id = ?").run(previous);
    }
    return true;
  });
  // Some older reader paths (including explicit bulk unread) still write the
  // legacy row. Honor it only for the same owner and only if actually newer.
  const currentRemote = (id, workId) => {
    const scoped = q.remoteProgress.get(workId, id);
    const legacy = q.progress.get(id);
    return legacy?.work_id === workId && (!scoped || Number(legacy.updated_at) > Number(scoped.updated_at))
      ? legacy : scoped;
  };
  const reconcileLegacy = (id, workId) => {
    const scoped = q.remoteProgress.get(workId, id);
    const legacy = q.progress.get(id);
    if (legacy?.work_id === workId && (!scoped || Number(legacy.updated_at) > Number(scoped.updated_at)))
      q.remoteReplace.run(workId, id, legacy.page, legacy.pages, legacy.finished, legacy.updated_at);
  };

  async function ensureDefaultFolder() {
    // Create it for a fresh installation, but do not silently recreate a
    // previously scanned missing root: an empty replacement could prune saved
    // files before the original folder becomes accessible again.
    if (!q.folders.all().some((folder) => folder.path === defaultFolder))
      await fs.mkdir(defaultFolder, { recursive: true });
    q.addFolder.run(defaultFolder, 1, now());
  }

  // Bounded walk: archives, and folders that directly contain images (one chapter or volume each).
  async function walk(root) {
    const found = [];
    const errors = [];
    let complete = true;
    const incomplete = (message) => {
      complete = false;
      if (errors.length < 8) errors.push(String(message).slice(0, 200));
    };
    const add = (full, kind) => {
      if (found.length >= SCAN_LIMITS.files) {
        incomplete(`File limit reached (${SCAN_LIMITS.files})`);
        return;
      }
      found.push({ full, kind });
    };
    const visit = async (dir, depth) => {
      if (depth > SCAN_LIMITS.depth) {
        incomplete(`Depth limit reached (${SCAN_LIMITS.depth}) at ${dir}`);
        return;
      }
      if (found.length >= SCAN_LIMITS.files) {
        incomplete(`File limit reached (${SCAN_LIMITS.files})`);
        return;
      }
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); }
      catch (problem) {
        incomplete(`Cannot read ${dir}: ${problem?.message || problem}`);
        return;
      }
      let images = 0;
      for (const entry of entries) {
        if (found.length >= SCAN_LIMITS.files) {
          incomplete(`File limit reached (${SCAN_LIMITS.files})`);
          return;
        }
        if (entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await visit(full, depth + 1);
        else if (entry.isFile() && ARCHIVE_EXT.test(entry.name)) add(full, "cbz");
        else if (entry.isFile() && IMAGE_EXT.test(entry.name)) images += 1;
      }
      if (images > 0 && dir !== root) add(dir, "folder");
    };
    await visit(root, 0);
    return { found, complete, errors };
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
    const generation = folderGenerations.get(root) || 0;
    const known = new Map(q.filesIn.all(root).map((row) => [row.id, row]));
    let error = null;
    let count = 0;
    let complete = false;
    let errors = [];
    try {
      const stat = await fs.stat(root);
      if (!liveFolder(root, generation)) return { folder: root, files: 0, error: "Folder removed", complete: false, errors: [] };
      if (!stat.isDirectory()) throw new Error("Not a folder");
      const walked = await walk(root);
      if (!liveFolder(root, generation)) return { folder: root, files: 0, error: "Folder removed", complete: false, errors: [] };
      complete = walked.complete;
      errors = [...walked.errors];
      for (const { full, kind } of walked.found) {
        const id = fileIdFor(full);
        let stat2;
        try { stat2 = await fs.stat(full); }
        catch (problem) {
          complete = false;
          if (errors.length < 8) errors.push(`Cannot stat ${full}: ${problem?.message || problem}`.slice(0, 200));
          continue;
        }
        if (!liveFolder(root, generation)) return { folder: root, files: 0, error: "Folder removed", complete: false, errors: [] };
        count += 1;
        const size = kind === "folder" ? 0 : stat2.size;
        const mtime = Math.round(stat2.mtimeMs);
        let old = known.get(id);
        if (path.sep !== "\\") {
          const occupied = old || q.file.get(id);
          // Before this fix A.cbz and a.cbz used the same lowercased id.
          // Keep the historical row with the exact path that owned it.
          if (occupied && path.resolve(occupied.path) !== path.resolve(full)) {
            const ownerId = fileIdFor(occupied.path);
            if (ownerId !== id && !q.file.get(ownerId)) {
              if (!migrateFileId(id, ownerId)) {
                complete = false;
                if (errors.length < 8) errors.push(`Cannot migrate conflicting legacy history: ${full}`.slice(0, 200));
                continue;
              }
              if (known.has(id)) {
                known.delete(id);
                known.set(ownerId, q.file.get(ownerId));
              }
              old = null;
            } else {
              complete = false;
              if (errors.length < 8) errors.push(`Conflicting path identity: ${full}`.slice(0, 200));
              continue;
            }
          }
        }
        if (!old && path.sep !== "\\") {
          const legacy = legacyFileIdFor(full);
          const original = known.get(legacy);
          if (legacy !== id && original && path.resolve(original.path) === path.resolve(full) && !q.file.get(id)) {
            if (!migrateFileId(legacy, id)) {
              complete = false;
              if (errors.length < 8) errors.push(`Cannot migrate conflicting legacy history: ${full}`.slice(0, 200));
              continue;
            }
            known.delete(legacy);
            old = q.file.get(id);
          }
        }
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
        if (!liveFolder(root, generation)) return { folder: root, files: 0, error: "Folder removed", complete: false, errors: [] };
        const name = info?.series || series;
        const next = {
          id, folder: root, path: full, kind, size, mtime, pages, series: name, series_key: normalizeSeriesName(name) || id,
          volume: parsed.volume ?? (info?.volume || null), volume_end: parsed.volumeEnd, chapter: parsed.chapter ?? (info?.number || null),
          chapter_end: parsed.chapterEnd, anilist_hint: info?.anilistId || null, error: fileError, seen_at: started,
        };
        if (fileError && old) {
          // Failed reads do not establish a new comic identity. Keep the last
          // successfully parsed chapter fields while marking the current
          // bytes unreadable. The next good parse must compare against that
          // verified identity, rather than against a filename fallback.
          for (const field of ["kind", "pages", "series", "series_key", "volume", "volume_end",
            "chapter", "chapter_end", "anilist_hint"]) next[field] = old[field];
        }
        atomic(() => {
          if (old && !fileError && ["kind", "series_key", "volume", "volume_end", "chapter", "chapter_end", "anilist_hint"]
            .some((key) => String(old[key] ?? "") !== String(next[key] ?? ""))) {
            // A different chapter at the same location is a new read identity.
            deleteFileHistory(id);
            q.resetFile.run(id);
          }
          q.upsertFile.run(next);
        });
      }
      if (!complete) error = `Incomplete scan: ${errors.join("; ")}`.slice(0, 200);
    } catch (problem) {
      error = String(problem?.message || problem).slice(0, 200);
      complete = false;
      errors = [error];
    }
    if (!liveFolder(root, generation)) return { folder: root, files: 0, error: "Folder removed", complete: false, errors: [] };
    atomic(() => {
      if (complete) for (const id of known.keys()) q.deleteFile.run(id);
      q.folderScanned.run(started, count, error, root);
    });
    return { folder: root, files: count, error, complete, errors };
  }

  // Pending files are matched per series: a manual override first, then the
  // ComicInfo AniList link, then an exact title/alias match from search(name).
  // Anything else becomes a local-only title in the Library.
  async function matchPending({ search, ensureLibrary }) {
    const groups = new Map();
    for (const row of q.pending.all()) if (!groups.has(row.series_key)) groups.set(row.series_key, row);
    const results = [];
    for (const [key, row] of groups) {
      const generation = folderGenerations.get(row.folder) || 0;
      const stillPending = () => {
        const current = q.file.get(row.id);
        return liveFolder(row.folder, generation) && current?.folder === row.folder &&
          current.series_key === key && current.match === "pending";
      };
      if (!stillPending()) continue;
      let workId = q.override.get(key)?.work_id || null;
      let reason = workId ? "manual" : "";
      // Once an unmatched series has a local Library title, newly scanned
      // chapters belong to that same title. Later provider recovery must not
      // silently rematch it or discard its status; Match is an explicit action.
      if (!workId) {
        const localId = localIdFor(key);
        const existing = q.localTitle.get(localId);
        if (existing?.series_key === key) { workId = localId; reason = "unmatched"; }
      }
      if (!workId && row.anilist_hint) { workId = `anilist-${row.anilist_hint}`; reason = "comicinfo"; }
      if (!workId && search) {
        try {
          const wanted = normalizeSeriesName(row.series);
          const hit = (await search(row.series)).find((comic) => [comic.title, ...(comic.aliases || [])].some((name) => normalizeSeriesName(name) === wanted));
          if (hit) { workId = `anilist-${hit.anilistId}`; reason = "title"; }
        } catch (problem) {
          log.warn?.("Comic match search failed:", problem?.message);
          // Online title metadata is optional. Keep readable archives visible
          // through the same local-only fallback as an unmatched search result;
          // users can explicitly Match that local title later.
        }
      }
      if (!stillPending()) continue;
      if (workId?.startsWith("anilist-")) {
        try {
          // Do not assign files to a catalog entry that failed to load: they
          // would stop being pending without gaining a readable Library card.
          if (typeof ensureLibrary !== "function") throw new Error("Comic Library verification is unavailable");
          // The callback may itself await network metadata before publishing
          // a Library card. Its writer must recheck this predicate immediately
          // before that side effect, not only after the callback resolves.
          const verified = await ensureLibrary(Number(workId.slice(8)), { isCurrent: stillPending });
          if (verified === null || verified === false || (verified && typeof verified === "object"
            && (verified.id !== workId || !String(verified.work?.title || "").trim())))
            throw new Error("Comic Library entry is not verified");
        } catch (problem) {
          log.warn?.("Comic metadata unavailable:", problem?.message);
          // Explicit ownership is retained and retried on the next scan.
          if (reason === "manual") continue;
          workId = null;
          reason = "unmatched";
        }
        if (!stillPending()) continue;
        if (workId) q.setMatch.run(workId, reason === "manual" ? "manual" : "auto", reason, key);
      }
      if (!workId?.startsWith("anilist-")) {
        if (!stillPending()) continue;
        const localId = workId?.startsWith("local-") ? workId : localIdFor(key);
        atomic(() => {
          q.addLocal.run(localId, row.series, key, now(), now());
          q.setMatch.run(localId, "local", "unmatched", key);
        });
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
      return atomic(() => {
        const removed = q.removeFolder.run(full).changes > 0;
        if (removed) {
          folderGenerations.set(full, (folderGenerations.get(full) || 0) + 1);
          clearTimeout(debounce.get(full));
          debounce.delete(full);
          for (const row of q.filesIn.all(full)) deleteFileHistory(row.id);
          q.deleteFilesIn.run(full);
        }
        return removed;
      });
    },
    scanAll,
    matchPending,
    file: (id) => q.file.get(String(id)) || null,
    files: (workId) => q.filesOf.all(String(workId)).map(fileView).sort(sortFiles),
    // Route preflight is about ownership, not immediate readability. A title
    // with only errored files can still be rematched with its reading history.
    hasLocalFiles: (workId) => Boolean(q.anyOwnedFile.get(String(workId))),
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
      // setMatchManual moves every file, including temporarily unreadable ones.
      // Their existing progress/read units must move in the same transaction.
      const files = db.prepare("SELECT * FROM comic_files WHERE work_id = ?").all(String(fromWorkId));
      if (!files.length) return null;
      const keys = [...new Set(files.map((row) => row.series_key))];
      let target = toWorkId;
      return atomic(() => {
        if (!target) {
          target = localIdFor(`manual:${keys[0]}`);
          q.addLocal.run(target, files[0].series, keys[0], now(), now());
        }
        if (!WORK_ID.test(String(target))) throw new Error("Invalid comic id");
        for (const row of files) {
          transferReadState(row.id, String(fromWorkId), target);
        }
        q.setMatchManual.run(target, "manual", String(fromWorkId));
        for (const key of keys) q.setOverride.run(key, target, now());
        if (String(fromWorkId).startsWith("local-")) q.deleteLocal.run(String(fromWorkId));
        return target;
      });
    },
    // Files under dirPath (a finished download) belong to workId, now and on later scans.
    assignPath(dirPath, workId) {
      if (!WORK_ID.test(String(workId))) throw new Error("Invalid comic id");
      const keyFor = (value) => {
        const full = path.resolve(value);
        return path.sep === "\\" ? full.toLowerCase() : full;
      };
      const root = keyFor(dirPath);
      const prefix = root + path.sep;
      const rows = db.prepare("SELECT id, path, series_key, work_id FROM comic_files").all()
        .filter((row) => keyFor(row.path).startsWith(prefix) || keyFor(row.path) === root);
      return atomic(() => {
        for (const key of new Set(rows.map((row) => row.series_key))) q.setOverride.run(key, String(workId), now());
        const update = db.prepare("UPDATE comic_files SET work_id = ?, match = 'manual', reason = 'download' WHERE id = ?");
        for (const row of rows) {
          transferReadState(row.id, row.work_id, String(workId));
          update.run(String(workId), row.id);
        }
        return rows.length;
      });
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
    progressOf: (workId) => {
      const owner = String(workId);
      const existing = q.progressOf.all(owner);
      const scoped = new Map(q.remoteProgressOf.all(owner).map((row) => [row.file_id, row]));
      for (const row of existing.filter((item) => EXT_CHAPTER_ID.test(item.file_id))) {
        const prior = scoped.get(row.file_id);
        if (!prior || Number(row.updated_at) > Number(prior.updated_at)) scoped.set(row.file_id, row);
      }
      return [...existing.filter((row) => !EXT_CHAPTER_ID.test(row.file_id)), ...scoped.values()];
    },
    // Chapters read from a source: id is "ex-<20 hex>" (see backend/comics/ext-sources.js).
    saveRemoteProgress({ id, workId, page, pages, chapter = null, volume = null }) {
      if (!EXT_CHAPTER_ID.test(String(id)) || !WORK_ID.test(String(workId))) return null;
      const total = Math.max(1, Math.min(Number(pages) || 1, 10_000));
      const at = Math.max(0, Math.min(Number(page) || 0, total - 1));
      const when = Math.max(now(), Number(currentRemote(String(id), String(workId))?.updated_at || 0) + 1);
      atomic(() => {
        reconcileLegacy(String(id), String(workId));
        q.remoteSave.run(String(workId), String(id), at, total, at >= total - 1 ? 1 : 0, when);
        const shadow = q.progress.get(String(id));
        if (!shadow || shadow.work_id === String(workId))
          q.saveProgress.run(String(id), String(workId), at, total, at >= total - 1 ? 1 : 0, when);
        if (at >= total - 1) q.markRead.run(String(workId), String(id), unitNumber(volume), unitNumber(chapter), when);
      });
      const row = q.remoteProgress.get(String(workId), String(id));
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
    remoteProgress: (id, workId = null) => workId
      ? currentRemote(String(id), String(workId)) || null
      : q.progress.get(String(id)) || null,
    // A source chapter's progress from elsewhere: an import (keepFurther: never moves it back)
    // or another device (the newest change, given as at, already won). Finished stays finished.
    importRemoteProgress({ id, workId, page = 0, pages = 1, finished = false, chapter = null, volume = null, at = now(), keepFurther = false }) {
      if (!EXT_CHAPTER_ID.test(String(id)) || !WORK_ID.test(String(workId))) return null;
      const old = currentRemote(String(id), String(workId));
      const total = Math.max(1, Math.min(Math.max(Number(pages) || 1, Number(old?.pages) || 0), 10_000));
      const spot = Math.max(0, Math.min(Number(page) || 0, total - 1));
      if (old && keepFurther && (old.finished || (!finished && old.page >= spot))) return { id: String(id), saved: false };
      const when = Math.max(0, Math.round(Number(at) || now()));
      atomic(() => {
        reconcileLegacy(String(id), String(workId));
        q.remoteSave.run(String(workId), String(id), spot, total, finished ? 1 : 0, when);
        const shadow = q.progress.get(String(id));
        if (!shadow || shadow.work_id === String(workId))
          q.saveProgress.run(String(id), String(workId), spot, total, finished ? 1 : 0, when);
        if (finished) q.markRead.run(String(workId), String(id), unitNumber(volume), unitNumber(chapter), when);
      });
      return { id: String(id), saved: true };
    },
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
