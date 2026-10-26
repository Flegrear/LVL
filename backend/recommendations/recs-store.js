/**
 * Recommendation data, kept in the project database:
 *
 *   rec_items    one row per show season, part or movie (AniList entry or TMDB title): ids,
 *                show it belongs to and its season number, community score with voters and
 *                the share who liked it, genres, tags, studios, description, snapshot time
 *   rec_links    "fans of A also recommend B": AniList votes or TMDB position, snapshot time
 *   rec_ratings  your ratings and statuses, by source (app, anilist, letterboxd)
 *   rec_runs     each refresh: when, why, how many favorites and candidates, the match curve
 *   rec_picks    the picks of each refresh with their match, reasons and summary
 *   rec_hidden   titles marked "not interested"
 *
 * Settings and linked accounts are kept in app_meta under "recs_settings".
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rec_items (
  item_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'anime',
  franchise_id TEXT,
  season_number INTEGER,
  title TEXT NOT NULL,
  title_alt TEXT,
  format TEXT,
  year INTEGER,
  episodes INTEGER,
  score REAL,
  scored_by INTEGER,
  liked_share REAL,
  popularity INTEGER,
  genres TEXT NOT NULL DEFAULT '[]',
  tags TEXT NOT NULL DEFAULT '[]',
  studios TEXT NOT NULL DEFAULT '[]',
  relations TEXT NOT NULL DEFAULT '[]',
  description TEXT,
  cover TEXT,
  banner TEXT,
  adult INTEGER NOT NULL DEFAULT 0,
  mal_id INTEGER,
  imdb_id TEXT,
  tmdb_id TEXT,
  fetched_at INTEGER NOT NULL,
  links_at INTEGER
);
CREATE INDEX IF NOT EXISTS rec_items_franchise ON rec_items(franchise_id);
CREATE INDEX IF NOT EXISTS rec_items_imdb ON rec_items(imdb_id);
CREATE TABLE IF NOT EXISTS rec_links (
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  votes INTEGER,
  rank INTEGER,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (from_id, to_id)
);
CREATE TABLE IF NOT EXISTS rec_ratings (
  rating_key TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  item_id TEXT,
  catalog_id TEXT,
  series_key TEXT,
  season INTEGER,
  title TEXT NOT NULL,
  kind TEXT,
  year INTEGER,
  score REAL,
  status TEXT,
  progress INTEGER,
  rated_at INTEGER,
  updated_at INTEGER NOT NULL,
  mapped_at INTEGER
);
CREATE INDEX IF NOT EXISTS rec_ratings_item ON rec_ratings(item_id);
CREATE INDEX IF NOT EXISTS rec_ratings_catalog ON rec_ratings(catalog_id);
CREATE TABLE IF NOT EXISTS rec_hidden (item_id TEXT PRIMARY KEY, hidden_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS rec_runs (
  run_id INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL,
  seeds INTEGER,
  candidates INTEGER,
  picks INTEGER,
  requests INTEGER,
  curve TEXT,
  error TEXT
);
CREATE TABLE IF NOT EXISTS rec_picks (
  run_id INTEGER NOT NULL,
  rank INTEGER NOT NULL,
  item_id TEXT NOT NULL,
  match REAL NOT NULL,
  raw REAL NOT NULL,
  features TEXT NOT NULL,
  reasons TEXT NOT NULL,
  summary TEXT,
  PRIMARY KEY (run_id, item_id)
);
`;

// Recommendations refresh daily on app launch. Legacy preferences from the
// earlier opt-in scheduler must not strand existing installations in manual mode.
export const RECS_DEFAULTS = Object.freeze({ mode: "auto", intervalDays: 1 });
export const RECS_INTERVALS = Object.freeze([1, 3, 7, 14, 30]);
const SETTINGS_KEY = "recs_settings";
const KEEP_RUNS = 12;

const parse = (value, fallback) => {
  try {
    const parsed = JSON.parse(value);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
};
const text = (value, max = 500) => (value === null || value === undefined ? null : String(value).replace(/\s+/g, " ").trim().slice(0, max) || null);
const int = (value) => (Number.isFinite(Number(value)) && value !== null && value !== "" ? Math.round(Number(value)) : null);
const real = (value) => (Number.isFinite(Number(value)) && value !== null && value !== "" ? Number(value) : null);

function itemFromRow(row) {
  if (!row) return null;
  return {
    itemId: row.item_id,
    source: row.source,
    sourceId: row.source_id,
    kind: row.kind,
    franchiseId: row.franchise_id || null,
    seasonNumber: row.season_number ?? null,
    title: row.title,
    titleAlt: row.title_alt || "",
    format: row.format || "",
    year: row.year ?? null,
    episodes: row.episodes ?? null,
    score: row.score ?? null,
    scoredBy: row.scored_by ?? null,
    likedShare: row.liked_share ?? null,
    popularity: row.popularity ?? null,
    genres: parse(row.genres, []),
    tags: parse(row.tags, []),
    studios: parse(row.studios, []),
    relations: parse(row.relations, []),
    description: row.description || "",
    cover: row.cover || "",
    banner: row.banner || "",
    adult: Boolean(row.adult),
    malId: row.mal_id ?? null,
    imdbId: row.imdb_id || null,
    tmdbId: row.tmdb_id || null,
    fetchedAt: row.fetched_at,
    linksAt: row.links_at ?? null,
  };
}

function ratingFromRow(row) {
  return {
    key: row.rating_key,
    source: row.source,
    itemId: row.item_id || null,
    catalogId: row.catalog_id || null,
    seriesKey: row.series_key || null,
    season: row.season ?? null,
    title: row.title,
    kind: row.kind || null,
    year: row.year ?? null,
    score: row.score ?? null,
    status: row.status || null,
    progress: row.progress ?? null,
    ratedAt: row.rated_at ?? null,
    updatedAt: row.updated_at,
    mappedAt: row.mapped_at ?? null,
  };
}

/** The rating key of a title (or one of its seasons) rated in the app. */
export function appRatingKey({ catalogId = "", seriesKey = "", season = null } = {}) {
  const title = catalogId ? String(catalogId) : seriesKey ? `key:${seriesKey}` : "";
  return title ? `app:${title}:${Number.isInteger(season) ? season : "all"}` : "";
}

export function createRecsStore({ db, getMeta, setMeta, now = Date.now } = {}) {
  db.exec(SCHEMA);
  const statements = new Map();
  const statement = (sql) => {
    if (!statements.has(sql)) statements.set(sql, db.prepare(sql));
    return statements.get(sql);
  };
  const transaction = (work) => {
    db.exec("BEGIN");
    try {
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };

  function settings() {
    const saved = parse(getMeta(SETTINGS_KEY) || "{}", {});
    return {
      mode: RECS_DEFAULTS.mode,
      intervalDays: RECS_DEFAULTS.intervalDays,
      anilist: saved.anilist && typeof saved.anilist === "object" ? saved.anilist : null,
      letterboxd: saved.letterboxd && typeof saved.letterboxd === "object" ? saved.letterboxd : null,
      tmdbKey: typeof saved.tmdbKey === "string" ? saved.tmdbKey : "",
      tmdbCheckedAt: Number(saved.tmdbCheckedAt) || null,
      ratingsChangedAt: Number(saved.ratingsChangedAt) || 0,
    };
  }

  function saveSettings(patch = {}) {
    // Old clients may still send a manual/weekly setting; keep the API
    // compatible while enforcing today's daily generation policy.
    const next = { ...settings(), ...patch, mode: RECS_DEFAULTS.mode, intervalDays: RECS_DEFAULTS.intervalDays };
    setMeta(SETTINGS_KEY, JSON.stringify(next));
    return settings();
  }

  const markRatingsChanged = () => saveSettings({ ratingsChangedAt: now() });

  /** Adds or refreshes items; ids, show and season already known are kept when a new snapshot lacks them. */
  function upsertItems(items = [], fetchedAt = now()) {
    const sql = `INSERT INTO rec_items (item_id, source, source_id, kind, franchise_id, season_number, title, title_alt, format, year, episodes,
        score, scored_by, liked_share, popularity, genres, tags, studios, relations, description, cover, banner, adult, mal_id, imdb_id, tmdb_id, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(item_id) DO UPDATE SET
        kind = excluded.kind, title = excluded.title, title_alt = COALESCE(excluded.title_alt, rec_items.title_alt),
        franchise_id = COALESCE(excluded.franchise_id, rec_items.franchise_id), season_number = COALESCE(excluded.season_number, rec_items.season_number),
        format = COALESCE(excluded.format, rec_items.format), year = COALESCE(excluded.year, rec_items.year), episodes = COALESCE(excluded.episodes, rec_items.episodes),
        score = CASE WHEN excluded.fetched_at >= rec_items.fetched_at THEN COALESCE(excluded.score, rec_items.score) ELSE COALESCE(rec_items.score, excluded.score) END,
        scored_by = CASE WHEN excluded.fetched_at >= rec_items.fetched_at THEN COALESCE(excluded.scored_by, rec_items.scored_by) ELSE COALESCE(rec_items.scored_by, excluded.scored_by) END,
        liked_share = CASE WHEN excluded.fetched_at >= rec_items.fetched_at THEN COALESCE(excluded.liked_share, rec_items.liked_share) ELSE COALESCE(rec_items.liked_share, excluded.liked_share) END,
        popularity = CASE WHEN excluded.fetched_at >= rec_items.fetched_at THEN COALESCE(excluded.popularity, rec_items.popularity) ELSE COALESCE(rec_items.popularity, excluded.popularity) END,
        genres = CASE WHEN excluded.genres = '[]' THEN rec_items.genres ELSE excluded.genres END,
        tags = CASE WHEN excluded.tags = '[]' THEN rec_items.tags ELSE excluded.tags END,
        studios = CASE WHEN excluded.studios = '[]' THEN rec_items.studios ELSE excluded.studios END,
        relations = CASE WHEN excluded.relations = '[]' THEN rec_items.relations ELSE excluded.relations END,
        description = COALESCE(excluded.description, rec_items.description), cover = COALESCE(excluded.cover, rec_items.cover),
        banner = COALESCE(excluded.banner, rec_items.banner), adult = excluded.adult, mal_id = COALESCE(excluded.mal_id, rec_items.mal_id),
        imdb_id = COALESCE(excluded.imdb_id, rec_items.imdb_id), tmdb_id = COALESCE(excluded.tmdb_id, rec_items.tmdb_id),
        fetched_at = MAX(excluded.fetched_at, rec_items.fetched_at)`;
    transaction(() => {
      for (const item of items) {
        if (!item?.itemId || !item.title) continue;
        statement(sql).run(
          item.itemId, item.source || "anilist", String(item.sourceId ?? item.itemId.split(":").pop()), item.kind || "anime",
          text(item.franchiseId, 80), int(item.seasonNumber), text(item.title, 300), text(item.titleAlt, 300), text(item.format, 20),
          int(item.year), int(item.episodes), real(item.score), int(item.scoredBy), real(item.likedShare), int(item.popularity),
          JSON.stringify((item.genres || []).slice(0, 12)), JSON.stringify((item.tags || []).slice(0, 20)), JSON.stringify((item.studios || []).slice(0, 5)),
          JSON.stringify((item.relations || []).slice(0, 30)), text(item.description, 900), text(item.cover, 600), text(item.banner, 600),
          item.adult ? 1 : 0, int(item.malId), text(item.imdbId, 20), text(item.tmdbId, 30), Number(item.fetchedAt) || fetchedAt,
        );
      }
    });
  }

  /** Replaces the "fans also recommend" list of one item, and notes when it was read. */
  function setLinks(fromId, links = [], fetchedAt = now()) {
    transaction(() => {
      statement("DELETE FROM rec_links WHERE from_id = ?").run(fromId);
      for (const link of links) {
        if (!link?.to || link.to === fromId) continue;
        statement("INSERT OR REPLACE INTO rec_links (from_id, to_id, votes, rank, fetched_at) VALUES (?, ?, ?, ?, ?)")
          .run(fromId, link.to, int(link.votes), int(link.rank), fetchedAt);
      }
      statement("UPDATE rec_items SET links_at = ? WHERE item_id = ?").run(fetchedAt, fromId);
    });
  }

  function items(ids = null) {
    const rows = ids ? [...new Set(ids)].map((id) => statement("SELECT * FROM rec_items WHERE item_id = ?").get(id)).filter(Boolean)
      : statement("SELECT * FROM rec_items").all();
    return new Map(rows.map((row) => [row.item_id, itemFromRow(row)]));
  }

  const item = (id) => itemFromRow(statement("SELECT * FROM rec_items WHERE item_id = ?").get(id));

  function links(fromIds) {
    const byFrom = new Map();
    for (const fromId of new Set(fromIds)) {
      const rows = statement("SELECT to_id, votes, rank, fetched_at FROM rec_links WHERE from_id = ? ORDER BY COALESCE(rank, 999), votes DESC").all(fromId);
      if (rows.length) byFrom.set(fromId, rows.map((row) => ({ to: row.to_id, votes: row.votes ?? null, rank: row.rank ?? null, fetchedAt: row.fetched_at })));
    }
    return byFrom;
  }

  /** Item ids whose details (or whose links) are missing or older than maxAgeMs. */
  function staleItems(ids, maxAgeMs, { links: forLinks = false } = {}) {
    const cutoff = now() - maxAgeMs;
    return [...new Set(ids)].filter((id) => {
      const row = statement("SELECT fetched_at, links_at FROM rec_items WHERE item_id = ?").get(id);
      if (!row) return true;
      return forLinks ? !(row.links_at >= cutoff) : !(row.fetched_at >= cutoff);
    });
  }

  function setItemIds(itemId, identifiers = {}) {
    const { imdbId, tmdbId, franchiseId, seasonNumber } = identifiers;
    // Franchise and season are recalculated as earlier prequels are discovered.
    // An explicit null clears a former season; omitted fields retain their value.
    const hasFranchise = Object.hasOwn(identifiers, "franchiseId");
    const hasSeason = Object.hasOwn(identifiers, "seasonNumber");
    statement(`UPDATE rec_items SET imdb_id = COALESCE(?, imdb_id), tmdb_id = COALESCE(?, tmdb_id),
      franchise_id = CASE WHEN ? THEN ? ELSE franchise_id END,
      season_number = CASE WHEN ? THEN ? ELSE season_number END WHERE item_id = ?`)
      .run(text(imdbId, 20), text(tmdbId, 30), hasFranchise ? 1 : 0, text(franchiseId, 80), hasSeason ? 1 : 0, int(seasonNumber), itemId);
  }

  /** Your rating of a title (or one season) in the app; no score and no status removes it. */
  function setAppRating({ catalogId = "", seriesKey = "", season = null, title = "", kind = null, year = null, score = null, status = null, itemId = null } = {}) {
    const key = appRatingKey({ catalogId, seriesKey, season });
    if (!key) throw Object.assign(new Error("A title is required"), { statusCode: 400 });
    if (score === null && !status) {
      statement("DELETE FROM rec_ratings WHERE rating_key = ?").run(key);
      markRatingsChanged();
      return null;
    }
    const existing = statement("SELECT * FROM rec_ratings WHERE rating_key = ?").get(key);
    const at = now();
    const nextKind = text(kind, 20) || existing?.kind || null;
    const nextTitle = text(title, 300) || existing?.title || "Untitled";
    const nextYear = int(year) ?? existing?.year ?? null;
    // A different title, kind or release year must be matched again. A remake
    // can keep the same name while referring to an entirely different item.
    const sameTarget = Boolean(existing) && (existing.kind || null) === nextKind
      && existing.title === nextTitle && (existing.year ?? null) === nextYear;
    statement(`INSERT OR REPLACE INTO rec_ratings (rating_key, source, item_id, catalog_id, series_key, season, title, kind, year, score, status, progress, rated_at, updated_at, mapped_at)
      VALUES (?, 'app', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`)
      .run(key, itemId || (sameTarget ? existing.item_id : null) || null, text(catalogId, 40), text(seriesKey, 300), int(season), nextTitle,
        nextKind, nextYear, real(score), text(status, 20), at, at, sameTarget ? existing.mapped_at ?? null : null);
    markRatingsChanged();
    return ratingFromRow(statement("SELECT * FROM rec_ratings WHERE rating_key = ?").get(key));
  }

  const rating = (key) => {
    const row = statement("SELECT * FROM rec_ratings WHERE rating_key = ?").get(key);
    return row ? ratingFromRow(row) : null;
  };

  /** Ratings of one title: yours in the app, and imported ones for the same show. */
  function titleRatings({ catalogId = "", seriesKey = "" } = {}) {
    const rows = statement("SELECT * FROM rec_ratings WHERE (catalog_id = ? AND ? != '') OR (series_key = ? AND ? != '')").all(catalogId, catalogId, seriesKey, seriesKey);
    const own = rows.map(ratingFromRow);
    const itemIds = new Set(own.map((entry) => entry.itemId).filter(Boolean));
    if (catalogId) statement("SELECT item_id FROM rec_items WHERE imdb_id = ?").all(catalogId).forEach((row) => itemIds.add(row.item_id));
    const imported = [...itemIds].flatMap((itemId) => statement("SELECT * FROM rec_ratings WHERE item_id = ? AND source != 'app'").all(itemId).map(ratingFromRow));
    return [...own, ...imported];
  }

  function setRatingItem(key, itemId) {
    statement("UPDATE rec_ratings SET item_id = COALESCE(?, item_id), mapped_at = ? WHERE rating_key = ?").run(itemId || null, now(), key);
  }

  /** Replaces everything imported from one account (AniList, Letterboxd) with a fresh copy. */
  function replaceSourceRatings(source, entries = []) {
    transaction(() => {
      statement("DELETE FROM rec_ratings WHERE source = ?").run(source);
      for (const entry of entries) {
        const key = `${source}:${entry.key || entry.itemId}`;
        statement(`INSERT OR REPLACE INTO rec_ratings (rating_key, source, item_id, catalog_id, series_key, season, title, kind, year, score, status, progress, rated_at, updated_at, mapped_at)
          VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(key, source, entry.itemId || null, text(entry.title, 300) || "Untitled", text(entry.kind, 20), int(entry.year), real(entry.score),
            text(entry.status, 20), int(entry.progress), int(entry.ratedAt), Number(entry.updatedAt) || now(), entry.itemId ? now() : null);
      }
    });
    markRatingsChanged();
  }

  /** Adds an account's entries to what's there (the Letterboxd feed only has recent ones); a missing score or id keeps the earlier one. */
  function mergeSourceRatings(source, entries = []) {
    transaction(() => {
      for (const entry of entries) {
        const key = `${source}:${entry.key || entry.itemId}`;
        statement(`INSERT INTO rec_ratings (rating_key, source, item_id, catalog_id, series_key, season, title, kind, year, score, status, progress, rated_at, updated_at, mapped_at)
          VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(rating_key) DO UPDATE SET item_id = COALESCE(excluded.item_id, rec_ratings.item_id), title = excluded.title,
            year = COALESCE(excluded.year, rec_ratings.year),
            score = CASE WHEN excluded.score IS NULL THEN rec_ratings.score
              WHEN COALESCE(excluded.rated_at, 0) >= COALESCE(rec_ratings.rated_at, 0)
                THEN excluded.score ELSE COALESCE(rec_ratings.score, excluded.score) END,
            status = CASE WHEN COALESCE(excluded.rated_at, 0) >= COALESCE(rec_ratings.rated_at, 0)
              THEN excluded.status ELSE COALESCE(rec_ratings.status, excluded.status) END,
            rated_at = MAX(COALESCE(excluded.rated_at, 0), COALESCE(rec_ratings.rated_at, 0)),
            updated_at = MAX(excluded.updated_at, rec_ratings.updated_at),
            mapped_at = COALESCE(rec_ratings.mapped_at, excluded.mapped_at)`)
          .run(key, source, entry.itemId || null, text(entry.title, 300) || "Untitled", text(entry.kind, 20), int(entry.year), real(entry.score),
            text(entry.status, 20), int(entry.progress), int(entry.ratedAt), Number(entry.updatedAt) || now(), entry.itemId ? now() : null);
      }
    });
    markRatingsChanged();
  }

  const removeSourceRatings = (source) => {
    statement("DELETE FROM rec_ratings WHERE source = ?").run(source);
    markRatingsChanged();
  };

  const ratings = () => statement("SELECT * FROM rec_ratings ORDER BY COALESCE(score, -1) DESC, title").all().map(ratingFromRow);
  const unmappedRatings = (source, olderThan) => statement("SELECT * FROM rec_ratings WHERE source = ? AND item_id IS NULL AND (mapped_at IS NULL OR mapped_at < ?)")
    .all(source, olderThan).map(ratingFromRow);

  function hide(itemId) {
    statement("INSERT OR REPLACE INTO rec_hidden (item_id, hidden_at) VALUES (?, ?)").run(itemId, now());
    statement("DELETE FROM rec_picks WHERE item_id = ?").run(itemId);
  }
  const unhideAll = () => statement("DELETE FROM rec_hidden").run().changes;
  const hidden = () => new Set(statement("SELECT item_id FROM rec_hidden").all().map((row) => row.item_id));

  const startRun = (trigger) => Number(statement("INSERT INTO rec_runs (trigger, started_at, status) VALUES (?, ?, 'running')").run(trigger, now()).lastInsertRowid);
  /** An update that was still running when the app stopped can't finish any more. */
  const failInterruptedRuns = () => statement("UPDATE rec_runs SET status = 'failed', finished_at = ?, error = 'The app stopped during this update' WHERE status = 'running'").run(now()).changes;

  function finishRun(runId, { status = "done", seeds = 0, candidates = 0, picks = 0, requests = 0, curve = null, error = null } = {}) {
    transaction(() => {
      statement("UPDATE rec_runs SET finished_at = ?, status = ?, seeds = ?, candidates = ?, picks = ?, requests = ?, curve = ?, error = ? WHERE run_id = ?")
        .run(now(), status, seeds, candidates, picks, requests, curve ? JSON.stringify(curve) : null, text(error, 500), runId);
      const runs = statement("SELECT run_id FROM rec_runs ORDER BY run_id DESC").all().map((row) => row.run_id);
      if (runs.length <= KEEP_RUNS) return;
      const retained = runs.slice(0, KEEP_RUNS);
      const latestGood = statement("SELECT run_id FROM rec_runs WHERE status = 'done' ORDER BY run_id DESC LIMIT 1").get()?.run_id;
      // A long outage can produce more failed daily/hourly attempts than our
      // history limit. Reserve one of those slots for the last successful
      // snapshot so the UI never loses otherwise-valid saved recommendations.
      // The newest run (even a failure) remains available for retry cooldown.
      if (latestGood != null && !retained.includes(latestGood)) retained[KEEP_RUNS - 1] = latestGood;
      const keep = new Set(retained);
      for (const id of runs) {
        if (keep.has(id)) continue;
        statement("DELETE FROM rec_picks WHERE run_id = ?").run(id);
        statement("DELETE FROM rec_runs WHERE run_id = ?").run(id);
      }
    });
  }

  function savePicks(runId, picks = []) {
    transaction(() => {
      for (const pick of picks) {
        statement("INSERT OR REPLACE INTO rec_picks (run_id, rank, item_id, match, raw, features, reasons, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .run(runId, pick.rank, pick.itemId, pick.match, pick.raw, JSON.stringify(pick.features || {}), JSON.stringify(pick.reasons || []), text(pick.summary, 300));
      }
    });
  }

  const runFromRow = (row) => (row ? { ...row, curve: parse(row.curve, null) } : null);
  const lastRun = () => runFromRow(statement("SELECT * FROM rec_runs ORDER BY run_id DESC LIMIT 1").get());
  const lastGoodRun = () => runFromRow(statement("SELECT * FROM rec_runs WHERE status = 'done' ORDER BY run_id DESC LIMIT 1").get());

  /** The picks of the last finished refresh, with each title's details. */
  function currentPicks() {
    const run = lastGoodRun();
    if (!run) return { run: null, picks: [] };
    const rows = statement("SELECT * FROM rec_picks WHERE run_id = ? ORDER BY rank").all(run.run_id);
    const details = items(rows.map((row) => row.item_id));
    const hiddenIds = hidden();
    const picks = rows.filter((row) => !hiddenIds.has(row.item_id) && details.has(row.item_id)).map((row) => ({
      rank: row.rank, itemId: row.item_id, match: row.match, summary: row.summary || "", reasons: parse(row.reasons, []), features: parse(row.features, {}), item: details.get(row.item_id),
    }));
    return { run, picks };
  }

  /** Earlier picks you later rated: their raw match and whether you rated them above your average. */
  function outcomes(average) {
    const rows = statement(`SELECT p.raw AS raw, r.score AS score FROM rec_ratings r
      JOIN rec_picks p ON p.item_id = r.item_id JOIN rec_runs u ON u.run_id = p.run_id
      WHERE r.score IS NOT NULL AND r.rated_at > u.started_at
      AND u.run_id = (SELECT MAX(u2.run_id) FROM rec_picks p2 JOIN rec_runs u2 ON u2.run_id = p2.run_id WHERE p2.item_id = r.item_id AND u2.started_at < r.rated_at)`).all();
    return rows.map((row) => ({ raw: row.raw, liked: row.score >= average }));
  }

  function stats() {
    const count = (sql, ...args) => Number(statement(sql).get(...args)?.n || 0);
    const bySource = Object.fromEntries(statement("SELECT source, COUNT(*) AS n, SUM(score IS NOT NULL) AS scored FROM rec_ratings GROUP BY source").all()
      .map((row) => [row.source, { count: Number(row.n), scored: Number(row.scored || 0) }]));
    return {
      ratings: bySource,
      items: count("SELECT COUNT(*) AS n FROM rec_items"),
      anime: count("SELECT COUNT(*) AS n FROM rec_items WHERE source = 'anilist'"),
      titles: count("SELECT COUNT(*) AS n FROM rec_items WHERE source = 'tmdb'"),
      links: count("SELECT COUNT(*) AS n FROM rec_links"),
      hidden: count("SELECT COUNT(*) AS n FROM rec_hidden"),
      newestSnapshot: Number(statement("SELECT MAX(fetched_at) AS n FROM rec_items").get()?.n || 0) || null,
    };
  }

  /** Removes cached details, links and refreshes; your ratings, hidden titles and settings stay. */
  function clearCache() {
    transaction(() => {
      statement("DELETE FROM rec_picks").run();
      statement("DELETE FROM rec_runs").run();
      statement("DELETE FROM rec_links").run();
      statement("DELETE FROM rec_items").run();
      statement("UPDATE rec_ratings SET mapped_at = NULL WHERE item_id IS NULL").run();
    });
  }

  return {
    db, statement, transaction, settings, saveSettings, markRatingsChanged, upsertItems, setLinks, items, item, links, staleItems, setItemIds,
    setAppRating, rating, titleRatings, setRatingItem, replaceSourceRatings, mergeSourceRatings, removeSourceRatings, ratings, unmappedRatings,
    hide, unhideAll, hidden, startRun, failInterruptedRuns, finishRun, savePicks, lastRun, lastGoodRun, currentPicks, outcomes, stats, clearCache,
  };
}
