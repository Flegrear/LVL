// Local comic files: watched folders, scanning, matching to
// AniList, local-only titles, manual matches and reading progress. Files are
// read where they are and never modified.
import fs from "node:fs/promises";
import { watch as watchFolder } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { IMAGE_EXT, listPages, archiveContentWitness, invalidateArchive } from "./pages.js";
import { normalizeSeriesName, parseReleaseName } from "../../shared/reading/release-name.js";
import { compareUnitNumbers } from "../../shared/reading/units.js";
import { EXT_CHAPTER_ID, WORK_ID, isSyncableSourceTitleKey } from "../../shared/reading/ids.js";
import { createProgressTransaction } from "./progress-transaction.js";

export const SCAN_LIMITS = Object.freeze({ depth: 6, files: 20_000 });
const ARCHIVE_EXT = /\.(?:cbz|zip)$/i;
const RESCAN_MS = 10 * 60 * 1000;
const WATCH_DEBOUNCE_MS = 2000;

const hash = (value, size = 12) => crypto.createHash("sha1").update(String(value)).digest("hex").slice(0, size);
export const fileIdFor = (fullPath, { platform = path.sep === "\\" ? "win32" : "posix" } = {}) =>
  `f${hash(platform === "win32" ? path.resolve(fullPath).toLowerCase() : path.resolve(fullPath), 16)}`;
const legacyFileIdFor = (fullPath) => `f${hash(path.resolve(fullPath).toLowerCase(), 16)}`;
export const localIdFor = (seriesKey) => `local-${hash(seriesKey)}`;
// A normalized display title is only a search hint. Files with distinct
// spelling/provenance must never share that hint as a durable work identity.
export const localSeriesKeyFor = (series, file, root, anilistHint = null) => {
  const shown = String(series || "").normalize("NFC").replace(/\s+/g, " ").trim();
  const relative = path.relative(root, path.dirname(file)).split(path.sep).join("/");
  const scope = relative === "." ? "" : relative;
  if (Number.isSafeInteger(Number(anilistHint)) && Number(anilistHint) > 0)
    return `series2:anilist:${Number(anilistHint)}:${hash(scope, 16)}`;
  return `series2:${hash(`${scope}\n${shown}`, 20)}:${normalizeSeriesName(shown).slice(0, 70)}`;
};
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
    -- The last exact image opened for a source chapter, scoped to its work.
    -- Separate from the portable progress row: older peers can still sync its
    -- page/finished fields without inheriting an unverified page ordering.
    CREATE TABLE IF NOT EXISTS comic_remote_page_witness (
      work_id TEXT NOT NULL, file_id TEXT NOT NULL, manifest_witness TEXT NOT NULL,
      image_witness TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (work_id, file_id));
    -- A reading-session pointer, never a second page/finished authority.
    -- Updated only when a verified reader opens; imports and chapter browsing
    -- cannot replace the last chapter/source the user actually opened.
    CREATE TABLE IF NOT EXISTS comic_resume_sessions (
      work_id TEXT PRIMARY KEY, file_id TEXT NOT NULL, opened_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS comic_read_units (work_id TEXT NOT NULL, unit_id TEXT NOT NULL, volume TEXT, chapter TEXT, finished_at INTEGER NOT NULL, PRIMARY KEY (work_id, unit_id));
    -- When a folder is scanned before the destination of a move, preserve the
    -- verified missing-file identity until the destination is discovered.
    CREATE TABLE IF NOT EXISTS comic_missing_files (
      file_id TEXT PRIMARY KEY, old_path TEXT NOT NULL, file_dev TEXT NOT NULL,
      file_ino TEXT NOT NULL, content_rev TEXT, previous_json TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS comic_missing_files_inode ON comic_missing_files(file_dev, file_ino);
  `);
  // A path is a location; a filesystem incarnation is (device,inode,ctime).
  // These metadata witnesses are cheap to check on periodic scans and keep
  // moved archives distinct from independent copies. Unknown legacy witnesses
  // are backfilled without rewriting their saved history.
  const fileColumns = new Set(db.prepare("PRAGMA table_info(comic_files)").all().map((row) => row.name));
  for (const field of ["file_dev", "file_ino", "file_ctime", "content_rev"])
    if (!fileColumns.has(field)) db.exec(`ALTER TABLE comic_files ADD COLUMN ${field} TEXT`);
  // Old records have exactly one known owner; migrate only that association.
  // Repeating this insertion is harmless, including after an interrupted start.
  db.exec(`INSERT OR IGNORE INTO comic_remote_progress (work_id, file_id, page, pages, finished, updated_at)
    SELECT work_id, file_id, page, pages, finished, updated_at FROM comic_progress
    WHERE file_id LIKE 'ex-%' AND work_id IS NOT NULL`);
  // Additive persisted CAS generations and triggers. These are installed on
  // the actual SQLite tables: direct Core sync/legacy SQL cannot bypass them.
  const readerTxn = createProgressTransaction({ db, now });
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
    upsertFile: db.prepare(`INSERT INTO comic_files (id, folder, path, kind, size, mtime, pages, series, series_key, volume, volume_end, chapter, chapter_end, anilist_hint, match, error, seen_at, file_dev, file_ino, file_ctime, content_rev)
      VALUES (@id, @folder, @path, @kind, @size, @mtime, @pages, @series, @series_key, @volume, @volume_end, @chapter, @chapter_end, @anilist_hint, 'pending', @error, @seen_at, @file_dev, @file_ino, @file_ctime, @content_rev)
      ON CONFLICT(id) DO UPDATE SET folder = excluded.folder, path = excluded.path, kind = excluded.kind,
        size = excluded.size, mtime = excluded.mtime, pages = excluded.pages, series = excluded.series,
        series_key = excluded.series_key, volume = excluded.volume, volume_end = excluded.volume_end,
        chapter = excluded.chapter, chapter_end = excluded.chapter_end, anilist_hint = excluded.anilist_hint,
        file_dev = excluded.file_dev, file_ino = excluded.file_ino, file_ctime = excluded.file_ctime,
        content_rev = excluded.content_rev, error = excluded.error, seen_at = excluded.seen_at`),
    fileByPath: db.prepare("SELECT * FROM comic_files WHERE path = ?"),
    filesByInode: db.prepare("SELECT * FROM comic_files WHERE file_dev = ? AND file_ino = ?"),
    missingByInode: db.prepare("SELECT * FROM comic_missing_files WHERE file_dev = ? AND file_ino = ?"),
    missingById: db.prepare("SELECT * FROM comic_missing_files WHERE file_id = ?"),
    saveMissing: db.prepare(`INSERT INTO comic_missing_files (file_id, old_path, file_dev, file_ino, content_rev, previous_json, at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(file_id) DO UPDATE SET old_path = excluded.old_path,
      file_dev = excluded.file_dev, file_ino = excluded.file_ino, content_rev = excluded.content_rev,
      previous_json = excluded.previous_json, at = excluded.at`),
    forgetMissing: db.prepare("DELETE FROM comic_missing_files WHERE file_id = ?"),
    backfillFileProof: db.prepare("UPDATE comic_files SET file_dev = ?, file_ino = ?, file_ctime = ?, content_rev = ? WHERE id = ?"),
    resetFile: db.prepare("UPDATE comic_files SET work_id = NULL, match = 'pending', reason = NULL WHERE id = ?"),
    touchFile: db.prepare("UPDATE comic_files SET seen_at = ? WHERE id = ?"),
    deleteFile: db.prepare("DELETE FROM comic_files WHERE id = ?"),
    deleteFilesIn: db.prepare("DELETE FROM comic_files WHERE folder = ?"),
    pending: db.prepare("SELECT * FROM comic_files WHERE match = 'pending' AND error IS NULL ORDER BY series_key"),
    setMatch: db.prepare("UPDATE comic_files SET work_id = ?, match = ?, reason = ? WHERE series_key = ? AND match IN ('pending', 'auto', 'local')"),
    setSeriesKey: db.prepare("UPDATE comic_files SET series_key = ? WHERE id = ?"),
    setFileOwner: db.prepare("UPDATE comic_files SET work_id = ?, match = ?, reason = ? WHERE id = ?"),
    filesForSeriesKey: db.prepare("SELECT * FROM comic_files WHERE series_key = ?"),
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
    remotePageWitness: db.prepare("SELECT manifest_witness, image_witness, updated_at FROM comic_remote_page_witness WHERE work_id = ? AND file_id = ?"),
    saveRemotePageWitness: db.prepare(`INSERT INTO comic_remote_page_witness
      (work_id, file_id, manifest_witness, image_witness, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(work_id, file_id) DO UPDATE SET manifest_witness = excluded.manifest_witness,
        image_witness = excluded.image_witness, updated_at = excluded.updated_at`),
    deleteRemotePageWitness: db.prepare("DELETE FROM comic_remote_page_witness WHERE work_id = ? AND file_id = ?"),
    deleteAllRemotePageWitnesses: db.prepare("DELETE FROM comic_remote_page_witness WHERE file_id = ?"),
    resumeOf: db.prepare("SELECT file_id, opened_at FROM comic_resume_sessions WHERE work_id = ?"),
    rememberResume: db.prepare(`INSERT INTO comic_resume_sessions (work_id, file_id, opened_at) VALUES (?, ?, ?)
      ON CONFLICT(work_id) DO UPDATE SET file_id = excluded.file_id, opened_at = MAX(comic_resume_sessions.opened_at + 1, excluded.opened_at)`),
    forgetResumeFile: db.prepare("DELETE FROM comic_resume_sessions WHERE file_id = ?"),
    forgetResumeWork: db.prepare("DELETE FROM comic_resume_sessions WHERE work_id = ?"),
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
  const watchers = new Map();
  let timer = null;
  let scanning = null;
  let scanEpoch = 0;
  let scanRunner = null;
  const debounce = new Map();
  const folderGenerations = new Map();
  const attachWatcher = (folder) => {
    if (!timer || watchers.has(folder)) return;
    try {
      const watcher = watchFolder(folder, { recursive: true }, () => {
        if (!timer) return;
        clearTimeout(debounce.get(folder));
        const wait = setTimeout(() => scanRunner?.(), WATCH_DEBOUNCE_MS);
        wait.unref?.();
        debounce.set(folder, wait);
      });
      watcher.on("error", () => {
        watcher.close();
        if (watchers.get(folder) === watcher) watchers.delete(folder);
      });
      watchers.set(folder, watcher);
    } catch {}
  };
  const detachWatcher = (folder) => {
    watchers.get(folder)?.close();
    watchers.delete(folder);
    clearTimeout(debounce.get(folder));
    debounce.delete(folder);
  };
  // Capture ambiguous old normalized-key groups before migrating any of their
  // rows. Otherwise the first migration could conceal the collision from the
  // second file scanned in the same or a different watched folder.
  const legacyTokenGroups = new Map();
  for (const row of db.prepare("SELECT series_key, series, path, folder, anilist_hint FROM comic_files").all()) {
    if (row.series_key.startsWith("series2:")) continue;
    if (!legacyTokenGroups.has(row.series_key)) legacyTokenGroups.set(row.series_key, new Set());
    legacyTokenGroups.get(row.series_key).add(
      localSeriesKeyFor(row.series, row.path, row.folder, row.anilist_hint));
  }
  const liveFolder = (root, generation) => (folderGenerations.get(root) || 0) === generation && Boolean(q.folderPresent.get(root));
  const deleteFileHistory = (id) => {
    q.forgetResumeFile.run(id);
    q.deleteProgress.run(id);
    q.deleteRemote.run(id);
    q.deleteAllRemotePageWitnesses.run(id);
    q.deleteReadUnit.run(id);
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'comic_chapter_choices'").get())
      db.prepare("DELETE FROM comic_chapter_choices WHERE unit_id = ?").run(id);
  };
  const transferReadState = (id, fromWorkId, toWorkId) => {
    if (!fromWorkId || fromWorkId === toWorkId) return;
    db.prepare("UPDATE comic_progress SET work_id = ? WHERE file_id = ? AND work_id = ?").run(toWorkId, id, fromWorkId);
    const savedResume = q.resumeOf.get(fromWorkId);
    if (savedResume?.file_id === id) {
      const prior = q.resumeOf.get(toWorkId);
      if (!prior || Number(prior.opened_at) <= Number(savedResume.opened_at))
        q.rememberResume.run(toWorkId, id, savedResume.opened_at);
      q.forgetResumeWork.run(fromWorkId);
    }
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
    db.prepare("UPDATE comic_resume_sessions SET file_id = ? WHERE file_id = ?").run(next, previous);
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
  const migrateLegacySeriesKey = (old, key) => {
    if (!old || old.series_key === key) return;
    atomic(() => {
      const rows = q.filesForSeriesKey.all(old.series_key);
      const originalTokens = new Set(rows.map((row) =>
        localSeriesKeyFor(row.series, row.path, row.folder, row.anilist_hint)));
      if (Math.max(originalTokens.size, legacyTokenGroups.get(old.series_key)?.size || 0) > 1
        && old.work_id && old.match !== "manual") {
        // The legacy normalized key joined distinct raw titles or source
        // folders. Only this file's witnessed history moves to its own work.
        // Never copy ambiguous source links or an unverified AniList match.
        const ownId = localIdFor(key);
        const occupied = q.localTitle.get(ownId);
        if (occupied && occupied.series_key !== key) throw new Error("Local work collision");
        const inherited = q.localTitle.get(old.work_id);
        q.addLocal.run(ownId, old.series, key, now(), now());
        if (inherited && inherited.status !== "PLANNING")
          q.setLocalStatus.run(inherited.status, now(), ownId);
        transferReadState(old.id, old.work_id, ownId);
        q.setFileOwner.run(ownId, "local", "separated-legacy-provenance", old.id);
      } else if (old.work_id) {
        const previous = q.override.get(key);
        if (!previous || previous.work_id === old.work_id)
          q.setOverride.run(key, old.work_id, now());
      }
      q.setSeriesKey.run(key, old.id);
    });
  };
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
      if (path.sep !== "\\") {
        // Migrate an older case-folded ID from its *recorded exact path*
        // before enumerating case-distinct new files. If a.cbz is visited
        // before A.cbz, the historical lowercased ID belongs to A.cbz, not
        // to whichever spelling the directory walker happens to see first.
        // This is a path-owner migration, never a merge by title or inode.
        for (const [legacyId, previous] of [...known]) {
          if (!liveFolder(root, generation)) return { folder: root, files: 0, error: "Folder removed", complete: false, errors: [] };
          const exactId = fileIdFor(previous.path);
          if (exactId === legacyId || legacyId !== legacyFileIdFor(previous.path)) continue;
          if (!migrateFileId(legacyId, exactId)) {
            complete = false;
            if (errors.length < 8) errors.push(`Cannot migrate conflicting legacy history: ${previous.path}`.slice(0, 200));
            continue;
          }
          known.delete(legacyId);
          known.set(exactId, q.file.get(exactId));
        }
      }
      for (const { full, kind } of walked.found) {
        let id = q.fileByPath.get(full)?.id || fileIdFor(full);
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
        const file_dev = String(stat2.dev);
        const file_ino = String(stat2.ino);
        const file_ctime = String(stat2.ctimeMs);
        let content_rev;
        let witnessFailure = null;
        try {
          content_rev = kind === "cbz" ? await archiveContentWitness(full, stat2)
            : crypto.createHash("sha256").update([file_dev, file_ino, file_ctime, String(size), String(mtime)].join(":")).digest("hex").slice(0, 20);
          const after = await fs.stat(full);
          if (after.dev !== stat2.dev || after.ino !== stat2.ino || after.size !== stat2.size
            || after.mtimeMs !== stat2.mtimeMs || after.ctimeMs !== stat2.ctimeMs)
            throw new Error("Archive changed during scan");
        } catch (problem) {
          const message = String(problem?.message || problem);
          // An unreadable ZIP is a verified *parse failure*, not a missing
          // file. Publish its error while preserving the last known identity
          // and reading history. Races and I/O errors remain incomplete scans.
          if (kind === "cbz" && /^(?:Not a ZIP archive|Invalid archive size|Invalid ZIP(?:64)? directory)$/.test(message)) {
            // The format failure is authoritative only for the inode that was
            // statted before verification. A concurrent replacement is a
            // transient scan race and cannot authorize folder pruning.
            const after = await fs.stat(full).catch(() => null);
            if (!after || after.dev !== stat2.dev || after.ino !== stat2.ino ||
                after.size !== stat2.size || after.mtimeMs !== stat2.mtimeMs ||
                after.ctimeMs !== stat2.ctimeMs) {
              complete = false;
              if (errors.length < 8) errors.push(`Archive changed during verification: ${full}`.slice(0, 200));
              continue;
            }
            witnessFailure = message === "Invalid archive size" ? "Not a ZIP archive" : message;
            content_rev = null;
            invalidateArchive(full);
          } else {
            complete = false;
            if (errors.length < 8) errors.push(`Cannot verify ${full}: ${message}`.slice(0, 200));
            continue;
          }
        }
        if (!liveFolder(root, generation)) return { folder: root, files: 0, error: "Folder removed", complete: false, errors: [] };
        // An inode and its witnessed content can move across watched folders.
        // Missing-file proofs survive whichever folder was scanned first.
        // Copies, live hardlinks and same-name archives never qualify.
        let moved = false;
        let movedProof = null;
        if (!q.fileByPath.get(full)) {
          const candidates = [
            ...q.filesByInode.all(file_dev, file_ino).filter((row) => row.path !== full),
            ...q.missingByInode.all(file_dev, file_ino).map((proof) => {
              try { return { ...JSON.parse(proof.previous_json), missingProof: proof }; } catch { return null; }
            }).filter(Boolean),
          ].filter((row) => row.kind === kind && row.size === size
            && row.content_rev?.startsWith("v2-") && row.content_rev === content_rev
            && (!row.missingProof || started - row.missingProof.at <= 30 * 24 * 60 * 60_000));
          const unique = [...new Map(candidates.map((row) => [row.id || row.file_id, row])).values()];
          const missing = [];
          for (const row of unique) if (!(await fs.stat(row.path).catch(() => null))) missing.push(row);
          if (missing.length === 1 && !q.file.get(id)) {
            id = missing[0].id;
            movedProof = missing[0];
            moved = true;
          }
        }
        let old = known.get(id) || q.file.get(id) || movedProof;
        if (path.sep !== "\\") {
          const occupied = moved ? null : old || q.file.get(id);
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
        if (moved && old) {
          const { kind: oldKind, pages, series, series_key, volume, volume_end, chapter,
            chapter_end, anilist_hint, error } = old;
          q.upsertFile.run({ id, folder: root, path: full, kind: oldKind, size, mtime,
            pages, series, series_key, volume, volume_end, chapter, chapter_end,
            anilist_hint, error, seen_at: started, file_dev, file_ino, file_ctime, content_rev });
          if (old.work_id) q.setFileOwner.run(old.work_id, old.match, old.reason, id);
          q.forgetMissing.run(id);
          continue;
        }
        if (old && !old.error && old.size === size && old.mtime === mtime
            && (old.content_rev === content_rev || (!old.content_rev && kind !== "cbz"))) {
          if (old.content_rev !== content_rev || old.file_ctime !== file_ctime)
            q.backfillFileProof.run(file_dev, file_ino, file_ctime, content_rev, id);
          if (!old.series_key.startsWith("series2:")) {
            const key = localSeriesKeyFor(old.series, full, root, old.anilist_hint);
            migrateLegacySeriesKey(old, key);
          }
          q.touchFile.run(started, id);
          continue;
        }
        if (old && old.content_rev !== content_rev) invalidateArchive(full);
        const { parsed, series } = describe(full, kind, root);
        let pages = 0;
        let info = null;
        let fileError = witnessFailure;
        if (!witnessFailure) {
          try {
            const listed = await listPages({ path: full, kind, mtime, content_rev });
            pages = listed.pages.length;
            info = listed.comicInfo;
            if (!pages) fileError = "No pages";
          } catch (problem) {
            fileError = String(problem?.message || "Unreadable").slice(0, 200);
          }
        }
        if (!liveFolder(root, generation)) return { folder: root, files: 0, error: "Folder removed", complete: false, errors: [] };
        const name = info?.series || series;
        const next = {
          id, folder: root, path: full, kind, size, mtime, pages, series: name, series_key: normalizeSeriesName(name) || id,
          volume: parsed.volume ?? (info?.volume || null), volume_end: parsed.volumeEnd, chapter: parsed.chapter ?? (info?.number || null),
          chapter_end: parsed.chapterEnd, anilist_hint: info?.anilistId || null, error: fileError, seen_at: started,
          file_dev, file_ino, file_ctime, content_rev,
        };
        next.series_key = localSeriesKeyFor(name, full, root, next.anilist_hint);
        if (fileError && old) {
          // Failed reads do not establish a new comic identity. Keep the last
          // successfully parsed chapter fields while marking the current
          // bytes unreadable. The next good parse must compare against that
          // verified identity, rather than against a filename fallback.
          for (const field of ["kind", "pages", "series", "series_key", "volume", "volume_end",
            "chapter", "chapter_end", "anilist_hint", "file_dev", "file_ino", "file_ctime", "content_rev"]) next[field] = old[field];
        }
        atomic(() => {
          if (old && !fileError && !old.series_key.startsWith("series2:") && old.series_key !== next.series_key
            && (old.content_rev === next.content_rev
              || (!old.content_rev?.startsWith("v2-")
                && ["kind", "volume", "volume_end", "chapter", "chapter_end", "anilist_hint"]
                  .every((key) => String(old[key] ?? "") === String(next[key] ?? "")))))
            migrateLegacySeriesKey(old, next.series_key);
          if (old && !fileError && ((old.content_rev?.startsWith("v2-") && old.content_rev !== next.content_rev)
            || ["kind", "volume", "volume_end", "chapter", "chapter_end", "anilist_hint"]
              .some((key) => String(old[key] ?? "") !== String(next[key] ?? "")))) {
            // A different chapter at the same location is a new read identity.
            deleteFileHistory(id);
            q.resetFile.run(id);
          }
          q.upsertFile.run(next);
          if (old && !fileError && old.series_key !== next.series_key
            && old.work_id && old.match === "manual") {
            // An explicit user match is authoritative across a filename or
            // key migration. Later chapters inherit that exact work choice.
            const prior = q.override.get(next.series_key);
            if (!prior || prior.work_id === old.work_id)
              q.setOverride.run(next.series_key, old.work_id, now());
          }
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
      if (complete) for (const [id, previous] of known) {
        // A removed path is a possible move, not permission to erase saved
        // progress. Preserve only exact inode provenance, never title guesses.
        if (previous.file_dev && previous.file_ino)
          q.saveMissing.run(id, previous.path, previous.file_dev, previous.file_ino,
            previous.content_rev, JSON.stringify(previous), started);
        q.deleteFile.run(id);
      }
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
          const candidates = (await search(row.series)).filter((comic) =>
            Number.isSafeInteger(Number(comic.anilistId)) && Number(comic.anilistId) > 0
            && [comic.title, ...(comic.aliases || [])].some((name) => normalizeSeriesName(name) === wanted));
          const exact = [...new Set(candidates.map((comic) => Number(comic.anilistId)))];
          if (exact.length === 1) { workId = `anilist-${exact[0]}`; reason = "title"; }
          // Equal normalized titles with different catalogue IDs are
          // unverified. Keep them local until the user explicitly matches.
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
          const occupied = q.localTitle.get(localId);
          if (occupied && occupied.series_key !== key) throw new Error("Local comic identity collision");
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
    const epoch = scanEpoch;
    scanning = (async () => {
      await ensureDefaultFolder();
      if (epoch !== scanEpoch) return { folders: [], matched: [], cancelled: true };
      const folders = [];
      for (const folder of q.folders.all()) {
        if (epoch !== scanEpoch) return { folders, matched: [], cancelled: true };
        folders.push(await scanFolder(folder.path));
      }
      if (epoch !== scanEpoch) return { folders, matched: [], cancelled: true };
      const matched = await matchPending(options);
      return { folders, matched };
    })().finally(() => { scanning = null; });
    return scanning;
  }

  function fileView(row) {
    const progress = q.progress.get(row.id);
    return {
      id: row.id, name: path.basename(row.path), kind: row.kind, pages: row.pages, series: row.series,
      revision: row.content_rev || null,
      volume: row.volume, volumeEnd: row.volume_end, chapter: row.chapter, chapterEnd: row.chapter_end, match: row.match,
      progress: progress ? { page: progress.page, pages: progress.pages, finished: Boolean(progress.finished), updatedAt: progress.updated_at } : null,
    };
  }
  const sortFiles = (a, b) => compareUnitNumbers(a.volume, b.volume) || compareUnitNumbers(a.chapter, b.chapter) || a.name.localeCompare(b.name, undefined, { numeric: true });

  return {
    defaultFolder,
    progressGeneration: (workId, fileId) => readerTxn.generation(String(workId), String(fileId)),
    installExtendedProgressTriggers: () => readerTxn.ensureExtended(),
    // All native/legacy clients retain their existing progress methods; only
    // v1 durable journal traffic is fenced by exact operation+generation.
    saveLocalProgressCAS(input) {
      return readerTxn.accept(input, {
        validate: () => {
          const row = q.file.get(input.fileId);
          return Boolean(row && row.work_id === input.workId && row.content_rev === input.contentWitness
            && input.sourceId === "local" && row.error == null
            && Number(row.pages) === input.pages);
        },
        save: () => {
          const saved = this.saveProgress({ fileId: input.fileId, page: input.page,
            pages: input.pages, finished: input.finished });
          if (saved && (input.finished || input.page === input.pages - 1))
            input.markFinished?.(input.workId, input.fileId);
          return saved;
        },
      });
    },
    saveRemoteProgressCAS(input) {
      const chapterSource = db.prepare("SELECT source_id, path FROM comic_ext_chapters WHERE id = ?");
      const ownedSource = db.prepare(`SELECT 1 FROM comic_work_sources WHERE work_id = ?
        AND kind = 'ext' AND source_id = ? AND manga_id = ? LIMIT 1`);
      return readerTxn.accept(input, {
        validate: () => {
          const chapter = chapterSource.get(input.fileId);
          return Boolean(chapter && chapter.source_id === input.sourceId
            && typeof input.chapterPath === "string" && chapter.path === input.chapterPath
            && typeof input.mangaId === "string" && input.mangaId.length > 0
            && ownedSource.get(input.workId, input.sourceId, input.mangaId));
        },
        save: () => {
          const saved = this.saveRemoteProgress({ id: input.fileId, workId: input.workId,
            page: input.page, pages: input.pages, chapter: input.chapter, volume: input.volume,
            manifestWitness: input.contentWitness, imageWitness: input.imageWitness });
          if (saved?.finished) input.markFinished?.(input.workId, input.fileId);
          return saved;
        },
      });
    },
    priorProgressCAS: (input) => readerTxn.prior(input),
    ensureDefaultFolder,
    folders: () => q.folders.all().map((row) => ({ path: row.path, isDefault: Boolean(row.is_default), addedAt: row.added_at, scannedAt: row.scanned_at, files: row.files, error: row.error })),
    async addFolder(folder) {
      const full = path.resolve(String(folder || ""));
      if (!path.isAbsolute(String(folder || "")) || full.length > 400) throw new Error("Enter the full path of a folder");
      const stat = await fs.stat(full).catch(() => null);
      if (!stat?.isDirectory()) throw new Error("That folder doesn't exist");
      q.addFolder.run(full, 0, now());
      attachWatcher(full);
      return full;
    },
    removeFolder(folder) {
      const full = path.resolve(String(folder || ""));
      return atomic(() => {
        const removed = q.removeFolder.run(full).changes > 0;
        if (removed) {
          folderGenerations.set(full, (folderGenerations.get(full) || 0) + 1);
          detachWatcher(full);
          for (const row of q.filesIn.all(full)) deleteFileHistory(row.id);
          q.deleteFilesIn.run(full);
        }
        return removed;
      });
    },
    scanAll,
    matchPending,
    file: (id) => q.file.get(String(id)) || null,
    // A reader may open immediately after an external archive replacement,
    // before the ten-minute watcher scan. Verify bytes before any page or
    // progress route is allowed to use the persisted manifest/revision.
    async refreshFile(id) {
      const row = q.file.get(String(id));
      if (!row) return null;
      const stat = await fs.stat(row.path);
      const revision = row.kind === "cbz" ? await archiveContentWitness(row.path, stat)
        : crypto.createHash("sha256").update([
          String(stat.dev), String(stat.ino), String(stat.ctimeMs), String(stat.size), String(Math.round(stat.mtimeMs)),
        ].join(":")).digest("hex").slice(0, 20);
      const verifiedStat = await fs.stat(row.path);
      if (verifiedStat.dev !== stat.dev || verifiedStat.ino !== stat.ino
        || verifiedStat.ctimeMs !== stat.ctimeMs || verifiedStat.mtimeMs !== stat.mtimeMs
        || verifiedStat.size !== stat.size)
        throw new Error("Archive changed while opening. Retry.");
      if (revision !== row.content_rev || Number(row.size) !== (row.kind === "cbz" ? stat.size : 0)
        || Number(row.mtime) !== Math.round(stat.mtimeMs)) {
        await scanAll();
        const refreshed = q.file.get(String(id));
        if (!refreshed || refreshed.path !== row.path || refreshed.content_rev !== revision)
          throw new Error("Archive changed while scanning. Retry.");
      }
      return q.file.get(String(id)) || null;
    },
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
      const owner = String(id);
      const fullKey = String(seriesKey);
      if (fullKey.startsWith("mihon:") && !isSyncableSourceTitleKey(fullKey))
        throw new Error("Mihon source path is too long or cannot be synced; no comic was saved");
      // A hash collision or older truncated key is ambiguous. Keep the old title
      // and every mark until verified original provider provenance is supplied.
      const previous = q.localTitle.get(owner);
      if (previous && previous.series_key !== fullKey)
        throw new Error("Comic identity collision: existing source provenance differs");
      db.prepare("INSERT OR IGNORE INTO comic_local_titles (id, title, series_key, status, added_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(owner, String(title).slice(0, 200), fullKey, String(status), now(), now());
      return q.localTitle.get(owner) || null;
    },
    renameTitle: (id, title) => db.prepare("UPDATE comic_local_titles SET title = ?, updated_at = ? WHERE id = ?").run(String(title).slice(0, 200), now(), String(id)).changes > 0,
    // Hide a local title: its files stay on disk but are no longer listed.
    removeLocal(id) {
      db.prepare("UPDATE comic_files SET work_id = NULL, match = 'ignored' WHERE work_id = ?").run(String(id));
      q.forgetResumeWork.run(String(id));
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
    // A saved reader takes precedence over numeric chapter order and imported
    // timestamps. Older installations still have a deterministic progress-only
    // fallback, so no progress row or source selection is migrated or discarded.
    resumeTarget(workId) {
      const owner = String(workId);
      if (!WORK_ID.test(owner)) return null;
      const existing = q.progressOf.all(owner);
      const scoped = new Map(q.remoteProgressOf.all(owner).map((row) => [row.file_id, row]));
      for (const row of existing.filter((item) => EXT_CHAPTER_ID.test(item.file_id))) {
        const prior = scoped.get(row.file_id);
        if (!prior || Number(row.updated_at) > Number(prior.updated_at)) scoped.set(row.file_id, row);
      }
      const all = [...existing.filter((row) => !EXT_CHAPTER_ID.test(row.file_id)), ...scoped.values()];
      const session = q.resumeOf.get(owner);
      const row = session ? all.find((item) => item.file_id === session.file_id) : [...all].sort((a, b) =>
        Number(b.updated_at) - Number(a.updated_at) || String(b.file_id).localeCompare(String(a.file_id)))[0];
      if (!session && !row) return null;
      return {
        readerId: String(session?.file_id || row.file_id),
        page: row ? Math.max(0, Math.min(Number(row.page) || 0, Math.max(1, Number(row.pages) || 1) - 1)) : 0,
        pages: Number(row?.pages) || 0, finished: Boolean(row?.finished),
        updatedAt: Number(row?.updated_at || session?.opened_at || 0),
      };
    },
    // Called by the server only after confirming file/work or live linked
    // source/chapter ownership; it never changes the page/progress tables.
    recordResume(workId, readerId) {
      const owner = String(workId);
      const id = String(readerId);
      if (!WORK_ID.test(owner) || (!EXT_CHAPTER_ID.test(id) && !/^f[0-9a-f]{16}$/.test(id))) return false;
      q.rememberResume.run(owner, id, now());
      return true;
    },
    // Chapters read from a source: id is "ex-<20 hex>" (see backend/comics/ext-sources.js).
    saveRemoteProgress({ id, workId, page, pages, chapter = null, volume = null,
      manifestWitness = null, imageWitness = null }) {
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
        if (/^[0-9a-f]{24}$/.test(manifestWitness || "") && /^[0-9a-f]{24}$/.test(imageWitness || ""))
          q.saveRemotePageWitness.run(String(workId), String(id), manifestWitness, imageWitness, when);
        else q.deleteRemotePageWitness.run(String(workId), String(id));
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
    remotePageWitness: (workId, id) => q.remotePageWitness.get(String(workId), String(id)) || null,
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
        // Incoming progress has no page-manifest proof. Never apply this
        // device's old witness to a page number supplied by another device.
        q.deleteRemotePageWitness.run(String(workId), String(id));
        const shadow = q.progress.get(String(id));
        if (!shadow || shadow.work_id === String(workId))
          q.saveProgress.run(String(id), String(workId), spot, total, finished ? 1 : 0, when);
        if (finished) q.markRead.run(String(workId), String(id), unitNumber(volume), unitNumber(chapter), when);
      });
      return { id: String(id), saved: true };
    },
    start({ search, ensureLibrary } = {}) {
      if (timer) return;
      const run = () => scanAll({ search, ensureLibrary }).catch((problem) => log.warn?.("Comic scan failed:", problem?.message));
      scanRunner = run;
      timer = setInterval(run, RESCAN_MS);
      timer.unref?.();
      for (const folder of q.folders.all()) attachWatcher(folder.path);
      // The default folder is created by the first scan on a new profile.
      // Install its watcher only after that creation has finished.
      void run().then(() => {
        if (timer) for (const folder of q.folders.all()) attachWatcher(folder.path);
      });
    },
    stop() {
      clearInterval(timer);
      timer = null;
      scanRunner = null;
      scanEpoch++;
      for (const wait of debounce.values()) clearTimeout(wait);
      debounce.clear();
      for (const folder of [...watchers.keys()]) detachWatcher(folder);
      for (const folder of q.folders.all())
        folderGenerations.set(folder.path, (folderGenerations.get(folder.path) || 0) + 1);
    },
  };
}
