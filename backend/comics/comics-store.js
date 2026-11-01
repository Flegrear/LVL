// SQLite tables owned by the Comics feature (created through ctx.db, like
// recs-store.js; backend/persistence/app-db.js doesn't change). Later steps add
// units, progress, folders, files and ratings.

export const COMIC_STATUSES = Object.freeze(["CURRENT", "PLANNING", "COMPLETED", "PAUSED", "DROPPED", "REPEATING"]);
const CACHE_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_CACHE_VALUE = 2 * 1024 * 1024;

export function createComicsStore({ db, now = Date.now } = {}) {
  if (!db?.exec || !db?.prepare) throw new Error("Comics store needs a SQLite database");
  db.exec(`
    CREATE TABLE IF NOT EXISTS comic_cache (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS comic_library (
      anilist_id INTEGER PRIMARY KEY,
      status TEXT NOT NULL,
      work_json TEXT NOT NULL,
      added_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS comic_settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  const settingsAll = db.prepare("SELECT key, value_json FROM comic_settings");
  const settingsWrite = db.prepare(`INSERT INTO comic_settings (key, value_json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`);
  db.prepare("DELETE FROM comic_cache WHERE fetched_at < ?").run(now() - CACHE_KEEP_MS);

  const cacheRead = db.prepare("SELECT value_json, fetched_at FROM comic_cache WHERE key = ?");
  const cacheWrite = db.prepare(`INSERT INTO comic_cache (key, value_json, fetched_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, fetched_at = excluded.fetched_at`);
  const libraryAll = db.prepare("SELECT anilist_id, status, work_json, added_at, updated_at FROM comic_library ORDER BY updated_at DESC");
  const libraryOne = db.prepare("SELECT anilist_id, status, work_json, added_at, updated_at FROM comic_library WHERE anilist_id = ?");
  const libraryWrite = db.prepare(`INSERT INTO comic_library (anilist_id, status, work_json, added_at, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(anilist_id) DO UPDATE SET status = excluded.status, work_json = excluded.work_json, updated_at = excluded.updated_at`);
  const libraryDelete = db.prepare("DELETE FROM comic_library WHERE anilist_id = ?");
  const librarySnapshot = db.prepare("UPDATE comic_library SET work_json = ? WHERE anilist_id = ?");

  const parse = (text, fallback = null) => {
    try { return JSON.parse(text); } catch { return fallback; }
  };
  const entry = (row) => (row ? {
    id: `anilist-${row.anilist_id}`, anilistId: row.anilist_id, status: row.status, work: parse(row.work_json, {}),
    addedAt: row.added_at, updatedAt: row.updated_at,
  } : null);

  return {
    cacheGet(key) {
      const row = cacheRead.get(String(key));
      if (!row) return null;
      const value = parse(row.value_json);
      return value === null ? null : { value, fetchedAt: row.fetched_at };
    },
    cachePut(key, value) {
      const text = JSON.stringify(value);
      if (text.length > MAX_CACHE_VALUE) return false;
      cacheWrite.run(String(key), text, now());
      return true;
    },
    library: () => libraryAll.all().map(entry),
    libraryGet: (anilistId) => entry(libraryOne.get(Number(anilistId))),
    // The card's snapshot only; status and dates stay as they are.
    librarySnapshot: (anilistId, work) => librarySnapshot.run(JSON.stringify(work || {}), Number(anilistId)).changes > 0,
    librarySet(anilistId, status, work) {
      if (!Number.isInteger(anilistId) || anilistId <= 0) throw new Error("Invalid AniList id");
      if (!COMIC_STATUSES.includes(status)) throw new Error(`Unknown status: ${status}`);
      const at = now();
      libraryWrite.run(anilistId, status, JSON.stringify(work || {}), at, at);
      return entry(libraryOne.get(anilistId));
    },
    libraryRemove: (anilistId) => libraryDelete.run(Number(anilistId)).changes > 0,
    // Settings › Comics choices kept on the server (they change what the server asks AniList and the sources for).
    settings() {
      const rows = settingsAll.all();
      const value = Object.fromEntries(rows.map((row) => [row.key, parse(row.value_json)]));
      // enabled: Settings › Comics › Enable Comics, on unless turned off.
      return { showAdult: value.showAdult === true, enabled: value.enabled !== false };
    },
    saveSettings(input = {}) {
      if (Object.hasOwn(input, "showAdult")) settingsWrite.run("showAdult", JSON.stringify(input.showAdult === true), now());
      if (Object.hasOwn(input, "enabled")) settingsWrite.run("enabled", JSON.stringify(input.enabled !== false), now());
      return this.settings();
    },
  };
}
