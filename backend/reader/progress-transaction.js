// SQLite-backed reader progress generations and idempotent CAS operations.
// Installed inside Comics' own database setup, not in Core-owned sync code.
// AFTER triggers observe *all* SQLite writers (including Core direct SQL).
import crypto from "node:crypto";

const OP = /^[0-9a-f-]{20,72}$/i;
const UNIT = /^(?:f[0-9a-f]{16}|ex-[0-9a-f]{20})$/;
const WORK = /^(?:anilist-[1-9]\d{0,9}|local-[0-9a-f]{12})$/;
const SOURCE = /^(?:local|-?[0-9]{1,20})$/;
const PROOF = /^[a-zA-Z0-9-]{1,120}$/;
const OP_LIMIT_PER_UNIT = 4096;
const fail = (message, status = 409) => Object.assign(new Error(message), { status });

export function installProgressGeneration(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS comic_reader_generation_v1 (
    work_id TEXT NOT NULL, file_id TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(work_id, file_id));
    CREATE TABLE IF NOT EXISTS comic_reader_operation_v1 (
      operation_id TEXT PRIMARY KEY, work_id TEXT NOT NULL, file_id TEXT NOT NULL,
      digest TEXT NOT NULL, generation INTEGER NOT NULL, result_json TEXT NOT NULL,
      accepted_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS comic_reader_operation_owner_v1
      ON comic_reader_operation_v1(work_id, file_id);
    CREATE TABLE IF NOT EXISTS comic_reader_deleted_work_v1 (
      work_id TEXT PRIMARY KEY, deleted_at INTEGER NOT NULL DEFAULT 1);
  `);
  // Trigger generation cannot be synthesized from updated_at: Core sync and
  // local edits may accept distinct changes within the same millisecond.
  const bump = (w, u) => `INSERT INTO comic_reader_generation_v1(work_id,file_id,generation)
    SELECT ${w}, ${u}, 1 WHERE ${w} IS NOT NULL AND ${u} IS NOT NULL
    ON CONFLICT(work_id,file_id) DO UPDATE SET generation = generation + 1;`;
  const on = (table, name, write, extra = "") => {
    db.exec(`CREATE TRIGGER IF NOT EXISTS reader_gen_v1_${name} AFTER ${write} ON ${table} BEGIN ${extra} END;`);
  };
  for (const [table, unit] of [["comic_progress", "file_id"], ["comic_remote_progress", "file_id"],
    ["comic_remote_page_witness", "file_id"], ["comic_read_units", "unit_id"]]) {
    on(table, table + "_i", "INSERT", bump("NEW.work_id", "NEW." + unit));
    on(table, table + "_u", "UPDATE", bump("NEW.work_id", "NEW." + unit)
      + ` UPDATE comic_reader_generation_v1 SET generation = generation + 1
        WHERE work_id = OLD.work_id AND file_id = OLD.${unit}
          AND (OLD.work_id IS NOT NEW.work_id OR OLD.${unit} IS NOT NEW.${unit});`);
    on(table, table + "_d", "DELETE", bump("OLD.work_id", "OLD." + unit));
  }
  // Local archive ownership or source revision changes invalidate an earlier
  // progress promise even if no page row was modified.
  on("comic_files", "file_i", "INSERT", bump("NEW.work_id", "NEW.id"));
  on("comic_files", "file_u", "UPDATE",
    `UPDATE comic_reader_generation_v1 SET generation = generation + 1
      WHERE work_id = OLD.work_id AND file_id = OLD.id
        AND (OLD.work_id IS NOT NEW.work_id OR OLD.content_rev IS NOT NEW.content_rev
          OR OLD.id IS NOT NEW.id);`
    + ` UPDATE comic_reader_generation_v1 SET generation = generation + 1
        WHERE work_id = NEW.work_id AND file_id = NEW.id
        AND (OLD.work_id IS NOT NEW.work_id OR OLD.content_rev IS NOT NEW.content_rev
          OR OLD.id IS NOT NEW.id);`);
  on("comic_files", "file_d", "DELETE",
    `UPDATE comic_reader_generation_v1 SET generation = generation + 1
      WHERE work_id = OLD.work_id AND file_id = OLD.id;`);
  return {
    // Other Comics-owned providers can create their tables after local library.
    // Install once those exist. All remain durable DB triggers thereafter.
    ensureExtended() {
      const exists = (name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
      if (exists("comic_chapter_choices")) {
        for (const [event, subject] of [["INSERT", "NEW"], ["UPDATE", "NEW"], ["DELETE", "OLD"]])
          on("comic_chapter_choices", "choice_" + event.toLowerCase(), event,
            bump(subject + ".work_id", subject + ".unit_id"));
        on("comic_chapter_choices", "choice_old_owner_u", "UPDATE",
          `UPDATE comic_reader_generation_v1 SET generation = generation + 1
            WHERE work_id = OLD.work_id AND file_id = OLD.unit_id
              AND (OLD.work_id IS NOT NEW.work_id OR OLD.unit_id IS NOT NEW.unit_id);`);
      }
      if (exists("comic_ext_chapters")) {
        for (const [event, subject] of [["UPDATE", "NEW"], ["DELETE", "OLD"]])
          on("comic_ext_chapters", "chapter_" + event.toLowerCase(), event,
            `UPDATE comic_reader_generation_v1 SET generation = generation + 1
              WHERE file_id = ${subject}.id;`);
        on("comic_ext_chapters", "chapter_old_id_u", "UPDATE",
          `UPDATE comic_reader_generation_v1 SET generation = generation + 1
            WHERE file_id = OLD.id AND OLD.id IS NOT NEW.id;`);
      }
      if (exists("comic_work_sources")) {
        for (const [event, subject] of [["INSERT", "NEW"], ["UPDATE", "NEW"], ["DELETE", "OLD"]])
          on("comic_work_sources", "source_" + event.toLowerCase(), event,
            `UPDATE comic_reader_generation_v1 SET generation = generation + 1
              WHERE work_id = ${subject}.work_id;`);
        on("comic_work_sources", "source_old_owner_u", "UPDATE",
          `UPDATE comic_reader_generation_v1 SET generation = generation + 1
            WHERE work_id = OLD.work_id AND OLD.work_id IS NOT NEW.work_id;`);
      }
      if (exists("comic_library")) {
        // Reading a not-yet-shelved title creates its Library card in an
        // onProgress callback AFTER the accepted CAS receipt. Insertion is
        // display/status metadata, not a page/content mutation. Deletion is
        // authoritative and must invalidate the preceding reader generation.
        on("comic_library", "library_delete", "DELETE",
          `UPDATE comic_reader_generation_v1 SET generation = generation + 1
            WHERE work_id = 'anilist-' || OLD.anilist_id;`);
        on("comic_library", "tombstone_delete", "DELETE",
          `INSERT INTO comic_reader_deleted_work_v1(work_id) VALUES ('anilist-' || OLD.anilist_id)
            ON CONFLICT(work_id) DO UPDATE SET deleted_at = deleted_at + 1;`);
        on("comic_library", "tombstone_restore", "INSERT",
          `DELETE FROM comic_reader_deleted_work_v1 WHERE work_id = 'anilist-' || NEW.anilist_id;`);
      }
      if (exists("comic_local_titles")) {
        for (const event of ["INSERT", "DELETE"])
          on("comic_local_titles", "local_" + event.toLowerCase(), event,
            `UPDATE comic_reader_generation_v1 SET generation = generation + 1
              WHERE work_id = ${event === "INSERT" ? "NEW" : "OLD"}.id;`);
        on("comic_local_titles", "tombstone_delete", "DELETE",
          `INSERT INTO comic_reader_deleted_work_v1(work_id) VALUES (OLD.id)
            ON CONFLICT(work_id) DO UPDATE SET deleted_at = deleted_at + 1;`);
        on("comic_local_titles", "tombstone_restore", "INSERT",
          `DELETE FROM comic_reader_deleted_work_v1 WHERE work_id = NEW.id;`);
      }
    },
  };
}

export function createProgressTransaction({ db, now = Date.now } = {}) {
  const created = installProgressGeneration(db);
  const seed = db.prepare(`INSERT OR IGNORE INTO comic_reader_generation_v1(work_id,file_id,generation) VALUES (?,?,0)`);
  const gen = db.prepare("SELECT generation FROM comic_reader_generation_v1 WHERE work_id = ? AND file_id = ?");
  const count = db.prepare("SELECT COUNT(*) AS n FROM comic_reader_operation_v1 WHERE work_id = ? AND file_id = ?");
  const byOp = db.prepare("SELECT * FROM comic_reader_operation_v1 WHERE operation_id = ?");
  const deleted = db.prepare("SELECT 1 FROM comic_reader_deleted_work_v1 WHERE work_id = ?");
  const insert = db.prepare(`INSERT INTO comic_reader_operation_v1
    (operation_id,work_id,file_id,digest,generation,result_json,accepted_at)
    VALUES(?,?,?,?,?,?,?)`);
  const snapshot = (workId, fileId) => {
    if (!WORK.test(workId) || !UNIT.test(fileId)) return null;
    seed.run(workId, fileId);
    const generation = gen.get(workId, fileId)?.generation;
    if (!Number.isSafeInteger(generation) || generation < 0) throw fail("Unusable progress generation");
    return generation;
  };
  const digestOf = (input) => crypto.createHash("sha256").update(JSON.stringify({
    // Preserve v1 bytes for already-accepted operation receipts after upgrade.
    schema: input.version, workId: input.workId, fileId: input.fileId, sourceId: input.sourceId,
    contentWitness: input.contentWitness, page: input.page, pages: input.pages,
    finished: input.finished, expectedGeneration: input.expectedGeneration,
    chapter: input.chapter ?? null, volume: input.volume ?? null,
    chapterPath: input.chapterPath ?? null, mangaId: input.mangaId ?? null,
    ...(input.version === 2 ? { predecessorOperationId: input.predecessorOperationId,
      predecessorGeneration: input.predecessorGeneration } : {}),
  })).digest("hex");
  const receipt = (row) => JSON.parse(row.result_json);
  const guard = (input) => {
    if (![1, 2].includes(input?.version) || !OP.test(input.operationId || "")
      || !WORK.test(input.workId || "") || !UNIT.test(input.fileId || "")
      || !SOURCE.test(input.sourceId || "") || !PROOF.test(input.contentWitness || "")
      || !Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 0
      || !Number.isSafeInteger(input.page) || input.page < 0
      || !Number.isSafeInteger(input.pages) || input.pages < 1 || input.page >= input.pages
      || typeof input.finished !== "boolean"
      || (input.version === 1 && (input.predecessorOperationId != null || input.predecessorGeneration != null))
      || (input.version === 2 && (!OP.test(input.predecessorOperationId || "")
        || input.predecessorOperationId === input.operationId
        || !Number.isSafeInteger(input.predecessorGeneration)
        || input.predecessorGeneration !== input.expectedGeneration)))
      throw fail("Unsupported or unverifiable reader progress operation");
  };
  const prior = (input) => {
    guard(input);
    const existing = byOp.get(input.operationId);
    if (!existing) return null;
    if (existing.work_id !== input.workId || existing.file_id !== input.fileId
      || existing.digest !== digestOf(input))
      throw fail("Reader operation ID reused with a different canonical payload");
    return { saved: receipt(existing).saved, progressReceipt: receipt(existing).progressReceipt, duplicate: true };
  };
  return {
    ensureExtended: created.ensureExtended,
    generation: snapshot,
    prior,
    // The callback and durable receipt use the *same* SQLite savepoint. Core
    // triggers increment generation synchronously on every accepted SQL write.
    accept(input, { validate, save } = {}) {
      guard(input);
      db.exec("SAVEPOINT comic_reader_cas_v1");
      try {
        const duplicate = prior(input);
        if (duplicate) { db.exec("RELEASE comic_reader_cas_v1"); return duplicate; }
        const before = snapshot(input.workId, input.fileId);
        if (before !== input.expectedGeneration)
          throw fail("Reader progress changed on this device or through sync; reconcile before retrying");
        if (input.version === 2) {
          const previous = byOp.get(input.predecessorOperationId);
          const proof = previous && receipt(previous).progressReceipt;
          // The predecessor is a *real accepted* operation for this exact
          // work/unit/source/content, not a claimed browser generation. A
          // different sync/import/local write increments before and conflicts.
          if (!previous || previous.work_id !== input.workId || previous.file_id !== input.fileId
            || previous.generation !== before || proof?.operationId !== input.predecessorOperationId
            || proof.generation !== before || proof.sourceId !== input.sourceId
            || proof.contentWitness !== input.contentWitness)
            throw fail("Preceding reader operation receipt cannot prove this generation");
        }
        if (deleted.get(input.workId))
          throw fail("This comic was deleted; reopen or add it again before saving progress");
        if (typeof validate !== "function" || validate() !== true)
          throw fail("Reader source, work ownership or content revision changed; reopen before saving");
        if (count.get(input.workId, input.fileId).n >= OP_LIMIT_PER_UNIT)
          throw fail("Reader operation receipt capacity reached; no receipts were discarded", 507);
        const saved = save();
        if (!saved) throw fail("Reader progress did not commit");
        const after = snapshot(input.workId, input.fileId);
        if (!(after > before)) throw fail("Reader progress write failed to advance semantic generation", 500);
        const progressReceipt = { version: input.version, operationId: input.operationId,
          workId: input.workId, fileId: input.fileId, sourceId: input.sourceId,
          contentWitness: input.contentWitness, expectedGeneration: before,
          page: input.page, pages: input.pages, generation: after,
          ...(input.version === 2 ? { predecessorOperationId: input.predecessorOperationId,
            predecessorGeneration: input.predecessorGeneration } : {}) };
        const result = { saved, progressReceipt };
        insert.run(input.operationId, input.workId, input.fileId, digestOf(input), after, JSON.stringify(result), now());
        db.exec("RELEASE comic_reader_cas_v1");
        return result;
      } catch (error) {
        db.exec("ROLLBACK TO comic_reader_cas_v1");
        db.exec("RELEASE comic_reader_cas_v1");
        throw error;
      }
    },
  };
}
