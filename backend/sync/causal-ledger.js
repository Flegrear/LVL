// Local-only causal evidence for syncable Comics and app-rating records.
// No wire-format changes: these rows are verified/materialized under the same
// SQLite writer transaction as an incoming record or a committed outgoing log.
import crypto from "node:crypto";
import { compareStamps, parseStamp } from "../../shared/sync/clock.js";

export const causallyTracked = (type) => type?.startsWith("comic.")
  || type === "rating.lvl" || type === "rating.imported";
const LOCAL_CAUSAL_SCHEMA = 1;
const futureSchemaError = () => Object.assign(
  new Error("Unknown local causal metadata schema; preserve it and upgrade LVL before synchronizing this item"),
  { code: "sync_causal_schema_unsupported" });
const stable = (value) => Array.isArray(value) ? `[${value.map(stable).join(",")}]`
  : value && typeof value === "object"
    ? `{${Object.keys(value).filter(key => value[key] !== undefined).sort()
      .map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`
    : JSON.stringify(value ?? null);
const proof = (value) => crypto.createHash("sha256").update(stable(value)).digest("hex");

export function createSyncCausalLedger(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS sync_causal_items (
    scope TEXT NOT NULL, item_key TEXT NOT NULL, schema_version INTEGER NOT NULL,
    accepted_at TEXT NOT NULL, content_proof TEXT NOT NULL,
    origin TEXT NOT NULL, deleted INTEGER NOT NULL,
    PRIMARY KEY(scope, item_key)
  );
  CREATE TABLE IF NOT EXISTS sync_causal_fields (
    scope TEXT NOT NULL, item_key TEXT NOT NULL, field_key TEXT NOT NULL,
    schema_version INTEGER NOT NULL, accepted_at TEXT NOT NULL,
    content_proof TEXT NOT NULL, deleted INTEGER NOT NULL,
    PRIMARY KEY(scope, item_key, field_key)
  )`);
  const get = db.prepare("SELECT schema_version, accepted_at, content_proof FROM sync_causal_items WHERE scope = ? AND item_key = ?");
  const allFields = db.prepare("SELECT field_key, schema_version, content_proof, deleted FROM sync_causal_fields WHERE scope = ? AND item_key = ?");
  const put = db.prepare(`INSERT INTO sync_causal_items
    (scope, item_key, schema_version, accepted_at, content_proof, origin, deleted)
    VALUES (?, ?, 1, ?, ?, ?, ?)
    ON CONFLICT(scope, item_key) DO UPDATE SET schema_version=1,
      accepted_at=excluded.accepted_at, content_proof=excluded.content_proof,
      origin=excluded.origin, deleted=excluded.deleted`);
  const putField = db.prepare(`INSERT INTO sync_causal_fields
    (scope, item_key, field_key, schema_version, accepted_at, content_proof, deleted)
    VALUES (?, ?, ?, 1, ?, ?, ?)
    ON CONFLICT(scope, item_key, field_key) DO UPDATE SET schema_version=1,
      accepted_at=excluded.accepted_at, content_proof=excluded.content_proof,
      deleted=excluded.deleted`);
  const keyOf = change => `${change.type} ${change.id}`;
  const supported = (scope, key, item = get.get(scope, key)) =>
    (!item || item.schema_version === LOCAL_CAUSAL_SCHEMA)
    && allFields.all(scope, key).every(field => field.schema_version === LOCAL_CAUSAL_SCHEMA);
  return {
    // Compare the *actual* local projection with the last accepted one, not
    // wall timestamps. An intervening edit at the same millisecond is dirty.
    probe(scope, change, current) {
      if (!causallyTracked(change.type)) return "apply";
      const key = keyOf(change);
      const row = get.get(scope, key);
      // Local metadata can have been written by a newer LVL build. Do not
      // infer this client's schema v1 content proof or stamp interpretation
      // from its unknown format, even if there is no item row but a future
      // field row survived. Preserve both rows without a false receipt.
      if (!supported(scope, key, row)) return "unsupported";
      if (!row) return "apply"; // migrate prior installations non-destructively
      if (row.content_proof !== proof(current)) {
        // A local removal, or a transition from imported to explicit rating,
        // may already have materialized the *absence* requested by a newer
        // tombstone. Never delete the other type's independent record.
        if (change.value === null && current === null) return "apply";
        return "dirty";
      }
      return compareStamps(row.accepted_at, change.at) >= 0 ? "already" : "apply";
    },
    // Caller must hold the writer lock (the per-record SAVEPOINT or journal
    // commit). If recording fails, producer effects and ack must roll back.
    record(scope, change, materialized, origin = "incoming") {
      if (!causallyTracked(change.type)) return false;
      if (!parseStamp(change.at) || !scope) throw new Error("Invalid local causal stamp or scope");
      const key = keyOf(change);
      const previous = get.get(scope, key);
      // This is checked before ANY item/field INSERT/UPSERT, so a field from
      // a future local schema cannot be overwritten with v1 metadata even
      // when the item row itself is absent or still version 1.
      if (!supported(scope, key, previous)) throw futureSchemaError();
      if (previous && compareStamps(previous.accepted_at, change.at) > 0) return false;
      put.run(scope, key, change.at, proof(materialized), origin, materialized === null ? 1 : 0);
      const live = new Map(materialized && typeof materialized === "object"
        ? Object.entries(materialized).map(([name, value]) => [JSON.stringify(name), value])
        : []);
      // Old field identities remain as tombstones instead of being pruned.
      const oldFields = new Map(allFields.all(scope, key).map(row => [row.field_key, row]));
      for (const row of oldFields.values()) if (!live.has(row.field_key)
        && (row.deleted !== 1 || row.content_proof !== proof(null)))
        putField.run(scope, key, row.field_key, change.at, proof(null), 1);
      for (const [field, value] of live) {
        const fieldProof = proof(value);
        const old = oldFields.get(field);
        // Unchanged fields keep their original causality: a score-only edit
        // does not fabricate a newer authority for account provenance.
        if (!old || old.deleted !== 0 || old.content_proof !== fieldProof)
          putField.run(scope, key, field, change.at, fieldProof, 0);
      }
      if (materialized === null)
        putField.run(scope, key, "!item-tombstone", change.at, proof(null), 1);
      else if (oldFields.get("!item-tombstone")?.deleted === 1)
        // Keep the historical marker while recording a later legitimate
        // resurrection as live. The item row's deleted flag remains decisive.
        putField.run(scope, key, "!item-tombstone", change.at, proof(materialized), 0);
      return true;
    },
    read(scope, type, id) {
      const item = get.get(scope, `${type} ${id}`);
      return item ? { ...item } : null;
    },
    fields(scope, type, id) {
      return db.prepare("SELECT field_key, schema_version, accepted_at, deleted, content_proof FROM sync_causal_fields WHERE scope = ? AND item_key = ? ORDER BY field_key")
        .all(scope, `${type} ${id}`);
    },
  };
}
