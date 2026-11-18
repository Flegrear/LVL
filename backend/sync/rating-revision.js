// Durable, semantic app-rating revision for the sync short-check mark.
// All mutations are tracked by SQLite triggers, including direct producers on
// another connection. Unchanged projected values cannot advance the revision.
export function createAppRatingRevision(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS sync_rating_semantic_revision (
    id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL DEFAULT 0
  );
  INSERT OR IGNORE INTO sync_rating_semantic_revision(id,revision) VALUES (1,0);
  CREATE TABLE IF NOT EXISTS sync_rating_semantic_rows (
    rating_key TEXT PRIMARY KEY, projection_json TEXT NOT NULL
  )`);
  const exists = () => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='rec_ratings'").get());
  const columns = ["rating_key", "source", "catalog_id", "series_key", "season",
    "title", "kind", "year", "score", "status", "provenance_json", "account_id"];
  let installedSignature = "";
  function ensure() {
    if (!exists()) return false;
    const available = new Set(db.prepare("PRAGMA table_info(rec_ratings)").all().map(row => row.name));
    const fields = columns.filter(name => available.has(name));
    const signature = fields.join("|");
    if (!signature || !available.has("source") || !available.has("rating_key")) return false;
    if (installedSignature === signature) {
      // Trigger DDL may have been created inside a caller's SAVEPOINT and
      // subsequently rolled back by a failed producer/causal apply. An
      // in-memory flag alone is not proof of durable trigger installation.
      const present = db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master
        WHERE type='trigger' AND name IN
          ('sync_app_rating_semantic_insert','sync_app_rating_semantic_update',
           'sync_app_rating_semantic_delete')`).get()?.n;
      if (present === 3) return true;
      installedSignature = "";
    }
    const projection = prefix => `json_array(${fields.map(name => `${prefix}.${name}`).join(",")})`;
    const next = projection("NEW");
    const old = projection("r");
    // A schema migration may add provenance/account columns after startup.
    // Rebuild only our own triggers, and compare the now-versioned projection.
    db.exec("SAVEPOINT sync_rating_revision_install");
    try {
      for (const suffix of ["insert", "update", "delete"])
        db.exec(`DROP TRIGGER IF EXISTS sync_app_rating_semantic_${suffix}`);
      db.exec(`INSERT OR IGNORE INTO sync_rating_semantic_rows(rating_key,projection_json)
        SELECT r.rating_key, ${old} FROM rec_ratings r WHERE r.source='app'
        `);
      db.exec(`CREATE TRIGGER sync_app_rating_semantic_insert AFTER INSERT ON rec_ratings
        WHEN NEW.source='app' BEGIN
          UPDATE sync_rating_semantic_revision SET revision=revision+1 WHERE id=1
            AND (SELECT projection_json FROM sync_rating_semantic_rows WHERE rating_key=NEW.rating_key) IS NOT ${next};
          INSERT INTO sync_rating_semantic_rows(rating_key,projection_json) VALUES (NEW.rating_key,${next})
            ON CONFLICT(rating_key) DO UPDATE SET projection_json=excluded.projection_json;
        END;
        CREATE TRIGGER sync_app_rating_semantic_update AFTER UPDATE ON rec_ratings
        WHEN OLD.source='app' OR NEW.source='app' BEGIN
          UPDATE sync_rating_semantic_revision SET revision=revision+1 WHERE id=1
            AND OLD.source='app' AND (NEW.source!='app' OR OLD.rating_key IS NOT NEW.rating_key)
            AND EXISTS(SELECT 1 FROM sync_rating_semantic_rows WHERE rating_key=OLD.rating_key);
          DELETE FROM sync_rating_semantic_rows WHERE rating_key=OLD.rating_key
            AND OLD.source='app' AND (NEW.source!='app' OR OLD.rating_key IS NOT NEW.rating_key);
          UPDATE sync_rating_semantic_revision SET revision=revision+1 WHERE id=1
            AND NEW.source='app'
            AND (SELECT projection_json FROM sync_rating_semantic_rows WHERE rating_key=NEW.rating_key) IS NOT ${next};
          INSERT OR REPLACE INTO sync_rating_semantic_rows(rating_key,projection_json)
            SELECT NEW.rating_key,${next} WHERE NEW.source='app'
            ;
        END;
        CREATE TRIGGER sync_app_rating_semantic_delete AFTER DELETE ON rec_ratings
        WHEN OLD.source='app' BEGIN
          UPDATE sync_rating_semantic_revision SET revision=revision+1 WHERE id=1
            AND EXISTS(SELECT 1 FROM sync_rating_semantic_rows WHERE rating_key=OLD.rating_key);
          DELETE FROM sync_rating_semantic_rows WHERE rating_key=OLD.rating_key;
        END`);
      db.exec("RELEASE sync_rating_revision_install");
      installedSignature = signature;
      return true;
    } catch (error) {
      db.exec("ROLLBACK TO sync_rating_revision_install");
      db.exec("RELEASE sync_rating_revision_install");
      throw error;
    }
  }
  return {
    ensure,
    mark() {
      if (!ensure()) return "-";
      // MAX(updated_at) would keep churning for timestamp-only producer
      // rewrites. The semantic trigger revision is the source of truth.
      const legacy = db.prepare("SELECT COUNT(*) AS n FROM rec_ratings WHERE source='app'").get();
      const revision = db.prepare("SELECT revision FROM sync_rating_semantic_revision WHERE id=1").get()?.revision ?? 0;
      return `${legacy.n}.rev:${revision}`;
    },
  };
}
