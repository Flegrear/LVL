import { EXT_CHAPTER_ID, SOURCE_ID, WORK_ID } from "../../shared/reading/ids.js";
import { extChapterId } from "./ext-sources.js";
import { joinId } from "../../shared/sync/records.js";

const LOCAL_ID = /^f[0-9a-f]{16}$/;
const UNIT = /^\d{1,5}(?:\.\d{1,2})?$/;
const normalized = (value) => UNIT.test(String(value ?? "")) ? String(value) : null;

export function ensureChapterChoices(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS comic_chapter_choices (
    work_id TEXT NOT NULL, unit_id TEXT NOT NULL, read INTEGER NOT NULL,
    changed_at INTEGER NOT NULL, source_id TEXT, path TEXT, chapter TEXT, volume TEXT, sync_stamp TEXT,
    PRIMARY KEY (work_id, unit_id))`);
  const columns = new Set(db.prepare("PRAGMA table_info(comic_chapter_choices)").all().map((row) => row.name));
  for (const name of ["source_id", "path", "chapter", "volume", "sync_stamp"])
    if (!columns.has(name)) db.exec(`ALTER TABLE comic_chapter_choices ADD COLUMN ${name} TEXT`);
  const chapterTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'comic_ext_chapters'").get();
  if (chapterTable) db.exec(`UPDATE comic_chapter_choices SET
    source_id = (SELECT source_id FROM comic_ext_chapters WHERE id = unit_id),
    path = (SELECT path FROM comic_ext_chapters WHERE id = unit_id)
    WHERE unit_id LIKE 'ex-%' AND (source_id IS NULL OR path IS NULL)
      AND EXISTS (SELECT 1 FROM comic_ext_chapters WHERE id = unit_id)`);
  const unitTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'comic_read_units'").get();
  if (unitTable) db.exec(`UPDATE comic_chapter_choices SET
    chapter = (SELECT chapter FROM comic_read_units WHERE work_id = comic_chapter_choices.work_id AND unit_id = comic_chapter_choices.unit_id),
    volume = (SELECT volume FROM comic_read_units WHERE work_id = comic_chapter_choices.work_id AND unit_id = comic_chapter_choices.unit_id)
    WHERE chapter IS NULL AND EXISTS (SELECT 1 FROM comic_read_units
      WHERE work_id = comic_chapter_choices.work_id AND unit_id = comic_chapter_choices.unit_id)`);
}

// Explicit selections retain the user's last read/unread choice, even when a
// delayed device sync imports an older finished flag for the same chapter.
export function createChapterMarks({ db, now = Date.now } = {}) {
  ensureChapterChoices(db);
  const units = db.prepare("SELECT unit_id, volume, chapter FROM comic_read_units WHERE work_id = ?");
  const choices = db.prepare("SELECT unit_id, read, chapter, volume FROM comic_chapter_choices WHERE work_id = ?");
  const choice = db.prepare("SELECT * FROM comic_chapter_choices WHERE work_id = ? AND unit_id = ?");
  const sourcePath = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'comic_ext_chapters'").get()
    ? db.prepare("SELECT source_id, path FROM comic_ext_chapters WHERE id = ?") : null;
  const add = db.prepare("INSERT INTO comic_read_units (work_id, unit_id, volume, chapter, finished_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(work_id, unit_id) DO UPDATE SET volume = excluded.volume, chapter = excluded.chapter, finished_at = excluded.finished_at");
  const remove = db.prepare("DELETE FROM comic_read_units WHERE work_id = ? AND unit_id = ?");
  const choose = db.prepare(`INSERT INTO comic_chapter_choices (work_id, unit_id, read, changed_at, source_id, path, chapter, volume)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(work_id, unit_id) DO UPDATE SET
    read = excluded.read, changed_at = excluded.changed_at,
    source_id = COALESCE(excluded.source_id, comic_chapter_choices.source_id),
    path = COALESCE(excluded.path, comic_chapter_choices.path),
    chapter = COALESCE(excluded.chapter, comic_chapter_choices.chapter),
    volume = COALESCE(excluded.volume, comic_chapter_choices.volume), sync_stamp = NULL`);
  const progress = db.prepare("SELECT page, pages, updated_at FROM comic_progress WHERE work_id = ? AND file_id = ?");
  const latestChoice = db.prepare("SELECT MAX(changed_at) AS at FROM comic_chapter_choices");
  const nextAt = () => Math.max(now(), Number(latestChoice.get()?.at || 0) + 1);
  const unreadProgress = db.prepare("UPDATE comic_progress SET finished = 0, page = CASE WHEN page >= pages - 1 THEN 0 ELSE page END, updated_at = ? WHERE work_id = ? AND file_id = ?");
  const hasScopedProgress = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'comic_remote_progress'").get());
  const scopedProgressAt = hasScopedProgress
    ? db.prepare("SELECT updated_at FROM comic_remote_progress WHERE work_id = ? AND file_id = ?") : null;
  const unreadScopedProgress = hasScopedProgress
    ? db.prepare("UPDATE comic_remote_progress SET finished = 0, page = CASE WHEN page >= pages - 1 THEN 0 ELSE page END, updated_at = ? WHERE work_id = ? AND file_id = ?") : null;
  const unitValid = (item) => (EXT_CHAPTER_ID.test(String(item?.id)) && SOURCE_ID.test(String(item?.sourceId))) || (LOCAL_ID.test(String(item?.id)) && item.sourceId === "local");

  return {
    isExplicitUnread: (workId, unitId) => choice.get(String(workId), String(unitId))?.read === 0,
    set(workId, selected, read) {
      if (!WORK_ID.test(String(workId)) || !Array.isArray(selected) || selected.length < 1 || selected.length > 200 ||
          typeof read !== "boolean" || selected.some((item) => !unitValid(item) || !normalized(item.chapter))) throw new Error("Invalid chapter selection");
      const unique = new Map(selected.map((item) => [item.id, item]));
      const resolved = [...unique.values()].map((item) => {
        if (item.sourceId === "local") return { ...item, source: null, path: null };
        const found = sourcePath?.get(item.id);
        const path = found?.path || item.path;
        if (found?.source_id && found.source_id !== item.sourceId) throw new Error("Chapter source changed");
        if (!path || extChapterId(item.sourceId, path) !== item.id) throw new Error("Chapter identity is unavailable; refresh sources");
        if (joinId(workId, item.sourceId, path).length > 600) throw new Error("This source chapter path is too long to sync");
        return { ...item, source: item.sourceId, path };
      });
      function apply() {
        for (const item of resolved) {
          const existing = choice.get(workId, item.id);
          if (existing && existing.read === (read ? 1 : 0) && existing.path === item.path &&
              existing.chapter === normalized(item.chapter) && existing.volume === normalized(item.volume)) continue;
          // A prior per-work page write may have a future/monotonic timestamp
          // even when the local wall clock moved backwards. An explicit unread
          // must be newer than the completion it overrides for sync replay.
          const at = read ? nextAt() : Math.max(nextAt(),
            Number(progress.get(workId, item.id)?.updated_at || 0) + 1,
            Number(scopedProgressAt?.get(workId, item.id)?.updated_at || 0) + 1);
          if (read) add.run(workId, item.id, normalized(item.volume), normalized(item.chapter), at);
          else {
            remove.run(workId, item.id);
            if (progress.get(workId, item.id)) unreadProgress.run(at, workId, item.id);
            // The old progress table only holds the first owner of a source
            // chapter. Every other owner's read position is authoritative in
            // the composite table, and must be reset by explicit unread too.
            if (EXT_CHAPTER_ID.test(String(item.id)))
              unreadScopedProgress?.run(at, workId, item.id);
          }
          choose.run(workId, item.id, read ? 1 : 0, at, item.source, item.path, normalized(item.chapter), normalized(item.volume));
        }
        return { changed: unique.size, read };
      }
      db.exec("BEGIN IMMEDIATE");
      try { const result = apply(); db.exec("COMMIT"); return result; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    // Reader completion is an intentional new read; the explicit unread choice
    // ends only after the actual reader reaches the final page again.
    finish(workId, unitId, finished) {
      if (!finished || !WORK_ID.test(String(workId)) || (!EXT_CHAPTER_ID.test(String(unitId)) && !LOCAL_ID.test(String(unitId)))) return;
      const prior = choice.get(workId, unitId);
      if (prior && prior.read <= 0) choose.run(workId, unitId, 1, nextAt(), prior.source_id, prior.path, prior.chapter, prior.volume);
    },
    summary(workId) {
      const seen = new Map(units.all(String(workId)).map((row) => [row.unit_id, { id: row.unit_id, volume: row.volume, chapter: row.chapter, read: true }]));
      for (const row of choices.all(String(workId))) {
        if (row.read < 0) continue;
        const known = seen.get(row.unit_id);
        if (known) { known.read = Boolean(row.read); known.chapter ||= row.chapter; known.volume ||= row.volume; }
        else seen.set(row.unit_id, { id: row.unit_id, volume: row.volume, chapter: row.chapter, read: Boolean(row.read) });
      }
      const active = [...seen.values()].filter((row) => row.read);
      const readChapters = [...new Set(active.map((row) => row.chapter).filter(Boolean))];
      const readVolumes = [...new Set(active.filter((row) => !row.chapter).map((row) => row.volume).filter(Boolean))];
      return {
        chapters: Math.max(0, ...active.map((row) => Math.floor(Number(row.chapter) || 0))),
        volumes: Math.max(0, ...active.map((row) => Math.floor(Number(row.volume) || 0))),
        units: active.length, readChapters, readVolumes,
        unitStates: [...seen.values()],
      };
    },
  };
}
