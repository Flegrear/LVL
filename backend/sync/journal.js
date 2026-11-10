// Durable local sync intent. The remote append-only files cannot join SQLite's
// transaction; each file is published under a fixed device/sequence identity.
// A prepared operation survives interruption until its item rows, checkpoint
// and journal deletion commit together.
import { APP_STATE_SCHEMA_VERSION } from "../persistence/app-db.js";

export function createSyncJournal(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS sync_journal (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    operation_json TEXT NOT NULL
  )`);
  const read = db.prepare("SELECT operation_json FROM sync_journal WHERE id = 1");
  const write = db.prepare(`INSERT INTO sync_journal(id, operation_json) VALUES (1, ?)
    ON CONFLICT(id) DO UPDATE SET operation_json = excluded.operation_json`);
  const clear = db.prepare("DELETE FROM sync_journal WHERE id = 1");
  const readCheckpoint = db.prepare("SELECT value FROM app_meta WHERE key = 'sync'");
  const readSchema = db.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'");
  const assertSupportedSchema = () => {
    const version = Number(readSchema.get()?.value);
    if (Number.isFinite(version) && version > APP_STATE_SCHEMA_VERSION)
      throw new Error(`Unsupported newer app-state schema version ${version}; this build supports ${APP_STATE_SCHEMA_VERSION}`);
  };
  const assertCheckpoint = (expected) => {
    if (expected !== undefined && (readCheckpoint.get()?.value ?? null) !== expected)
      throw Object.assign(new Error("Sync checkpoint changed in another process; reload and retry"), { code: "sync_generation_changed" });
  };
  return {
    load() {
      const raw = read.get()?.operation_json;
      if (!raw) return null;
      let operation;
      try { operation = JSON.parse(raw); } catch { throw new Error("The unfinished sync journal cannot be read; local records were preserved"); }
      if (operation?.schema !== 1 || !["preapply", "prepared"].includes(operation.phase)
        || !operation.scope || typeof operation.operationId !== "string")
        throw new Error("The unfinished sync journal uses an unsupported format; local records were preserved");
      return operation;
    },
    save(operation, expectedCheckpoint = undefined, beforeSave = null) {
      db.exec("BEGIN IMMEDIATE");
      try {
        assertSupportedSchema();
        assertCheckpoint(expectedCheckpoint);
        const existingText = read.get()?.operation_json;
        const existing = existingText ? JSON.parse(existingText) : null;
        if (existing && existing.operationId !== operation.operationId)
          throw new Error("Another sync process already has a pending operation; retry its journal first");
        // An old same-operation worker must not replace a prepared outbox with
        // a different plan or rewind a publication's acknowledged chunk count.
        if (existing?.phase === "prepared" && (operation.phase !== "prepared"
          || !Number.isInteger(operation.nextChunk) || operation.nextChunk <= existing.nextChunk))
          throw Object.assign(new Error("The sync outbox advanced in another process; reload before publishing"),
            { code: "sync_generation_changed" });
        // Snapshot the local state (and any repo-reset item-table changes)
        // under the SAME writer lock as journal admission. No stale remote
        // reader can clear accepted sync_items before its generation check.
        beforeSave?.(operation);
        write.run(JSON.stringify({ ...operation, schema: 1 }));
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    // Called ONLY from appState.compareAndSwapSection's locked transaction.
    // If that Library write commits before an interruption, the recovery marker
    // commits with it. Later deletions can then be distinguished from replay.
    recordAppliedLibrary(operationId, { library, updatedAt }, project = null) {
      assertSupportedSchema();
      const existing = read.get()?.operation_json;
      if (!existing) throw new Error("The sync journal disappeared during Library application");
      const operation = JSON.parse(existing);
      if (operation.operationId !== operationId || operation.phase !== "preapply")
        throw new Error("The sync journal changed during Library application");
      write.run(JSON.stringify({ ...operation, appliedLibrary: library, appliedLibraryRevision: updatedAt,
        ...(project ? { expectedLocal: project() } : {}) }));
    },
    // Comics/ratings are synchronous SQLite writers. Publish their resulting
    // projection in the same immediate transaction as their application, so
    // an interrupted batch cannot confuse an incoming edit with a user edit.
    applyAndRecord(operationId, apply, project) {
      db.exec("BEGIN IMMEDIATE");
      try {
        assertSupportedSchema();
        const existing = read.get()?.operation_json;
        if (!existing) throw new Error("The sync journal disappeared during local application");
        const operation = JSON.parse(existing);
        if (operation.operationId !== operationId || operation.phase !== "preapply")
          throw new Error("The sync journal changed during local application");
        const result = apply();
        write.run(JSON.stringify({ ...operation, expectedLocal: project() }));
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    clear() { clear.run(); },
    commit(operationId, apply, expectedCheckpoint = undefined) {
      db.exec("BEGIN IMMEDIATE");
      try {
        assertSupportedSchema();
        assertCheckpoint(expectedCheckpoint);
        const existing = read.get()?.operation_json;
        if (!existing || JSON.parse(existing).operationId !== operationId)
          throw new Error("Another sync process completed or replaced this journal; refresh before committing");
        apply();
        clear.run();
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
