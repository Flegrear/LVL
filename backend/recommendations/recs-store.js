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
  mapped_at INTEGER,
  provenance_json TEXT,
  account_id TEXT
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
  error TEXT,
  account_scope TEXT
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

// New installations default to daily automatic refresh; explicitly saved
// manual/cadence settings remain user-owned across every later metadata write.
export const RECS_DEFAULTS = Object.freeze({ mode: "auto", intervalDays: 1 });
export const RECS_INTERVALS = Object.freeze([1, 3, 7, 14, 30]);
const SETTINGS_KEY = "recs_settings";
const KEEP_RUNS = 12;
const LEGACY_ACCOUNT = "legacy:unverified";

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
    accountId: row.account_id || null,
    ...(row.provenance_json ? { provenance: parse(row.provenance_json, null) } : {}),
  };
}

/** The rating key of a title (or one of its seasons) rated in the app. */
export function appRatingKey({ catalogId = "", seriesKey = "", season = null, kind = null } = {}) {
  const title = catalogId ? String(catalogId) : seriesKey ? `key:${seriesKey}` : "";
  const namespace = ["anime", "anime-movie", "movie", "series"].includes(kind) ? `${kind}:` : "";
  return title ? `app:${namespace}${title}:${Number.isInteger(season) ? season : "all"}` : "";
}

const ownerId = (source, owner = null) => {
  if (source === "anilist") {
    if (Number.isSafeInteger(owner?.userId) && owner.userId > 0) return `user:${owner.userId}`;
    return owner?.username ? `name:${String(owner.username).toLowerCase()}` : "unassigned";
  }
  if (source === "letterboxd") return owner?.username ? `user:${String(owner.username).toLowerCase()}` : "import";
  return "";
};

// A current linked profile says nothing about who owned imported records
// written before account ownership was stored. Only evidence carried *by the
// row* can establish that association. Preserve every other record as legacy
// data with an explicitly unknown account, including rows from A and B in the
// same old database. Never manufacture an account from today's settings.
function previousRatingOwner(row) {
  // A namespaced rating_key alone is not independent proof: an older startup
  // migrator could have manufactured it using whichever account was linked.
  // The dedicated account_id column is honored before this function is called.
  if (row.source === "anilist") {
    const provenance = parse(row.provenance_json, null);
    if (Number.isSafeInteger(provenance?.accountUserId) && provenance.accountUserId > 0 && provenance.source === "anilist")
      return `user:${provenance.accountUserId}`;
  }
  if (row.source === "letterboxd") {
    const provenance = parse(row.provenance_json, null);
    if (["csv", "ratings.csv", "diary.csv", "watched.csv"].includes(provenance?.channel)) return "import";
  }
  return LEGACY_ACCOUNT;
}

export function createRecsStore({ db, getMeta, setMeta, now = Date.now } = {}) {
  db.exec("PRAGMA busy_timeout = 750");
  // DDL, ownership migration and historical run attribution are one immediate
  // SQLite transaction. A second handle either sees the complete migration or
  // gets a bounded BUSY before any schema/data change. Keep old rating keys
  // untouched: partial old/new key namespaces may already coexist.
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(SCHEMA);
    const ratingColumns = new Set(db.prepare("PRAGMA table_info(rec_ratings)").all().map((column) => column.name));
    if (!ratingColumns.has("provenance_json")) db.exec("ALTER TABLE rec_ratings ADD COLUMN provenance_json TEXT");
    if (!ratingColumns.has("account_id")) db.exec("ALTER TABLE rec_ratings ADD COLUMN account_id TEXT");
    if (!db.prepare("PRAGMA table_info(rec_runs)").all().some((column) => column.name === "account_scope"))
      db.exec("ALTER TABLE rec_runs ADD COLUMN account_scope TEXT");
    const missingOwners = db.prepare("SELECT rating_key, source, provenance_json FROM rec_ratings WHERE source IN ('anilist','letterboxd') AND account_id IS NULL").all();
    const assign = db.prepare("UPDATE rec_ratings SET account_id = ?, provenance_json = ? WHERE rating_key = ? AND account_id IS NULL");
    for (const row of missingOwners) {
      const owner = previousRatingOwner(row);
      const previous = parse(row.provenance_json, null);
      const origin = owner === LEGACY_ACCOUNT
        ? JSON.stringify({ ...(previous && typeof previous === "object" && !Array.isArray(previous) ? previous : {}), legacyAccount: "unverified" })
        : row.provenance_json;
      assign.run(owner, origin, row.rating_key);
    }
    // Historical recommendations without independent account proof also
    // remain durable but cannot be displayed as the newly linked user's picks.
    const legacyScope = JSON.stringify([LEGACY_ACCOUNT, LEGACY_ACCOUNT]);
    db.prepare("UPDATE rec_runs SET account_scope = ? WHERE account_scope IS NULL").run(legacyScope);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  const statements = new Map();
  const statement = (sql) => {
    if (!statements.has(sql)) statements.set(sql, db.prepare(sql));
    return statements.get(sql);
  };
  const transaction = (work) => {
    db.exec("BEGIN IMMEDIATE");
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
      mode: saved.mode === "manual" ? "manual" : RECS_DEFAULTS.mode,
      intervalDays: RECS_INTERVALS.includes(Number(saved.intervalDays))
        ? Number(saved.intervalDays) : RECS_DEFAULTS.intervalDays,
      anilist: saved.anilist && typeof saved.anilist === "object" ? saved.anilist : null,
      letterboxd: saved.letterboxd && typeof saved.letterboxd === "object" ? saved.letterboxd : null,
      tmdbKey: typeof saved.tmdbKey === "string" ? saved.tmdbKey : "",
      tmdbCheckedAt: Number(saved.tmdbCheckedAt) || null,
      ratingsChangedAt: Number(saved.ratingsChangedAt) || 0,
    };
  }

  const activeAccount = (source) => ownerId(source, settings()[source]);
  const accountScope = () => JSON.stringify([activeAccount("anilist"), activeAccount("letterboxd")]);
  const visible = (row) => row.source === "app" || row.account_id === activeAccount(row.source)
    || (row.source === "letterboxd" && row.account_id === "import") || row.account_id === LEGACY_ACCOUNT;

  function saveSettings(patch = {}) {
    // Keep fields from compatible future clients opaque; only the public
    // settings() reader validates understood mode/cadence values.
    const stored = parse(getMeta(SETTINGS_KEY) || "{}", {});
    const next = { ...(stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {}), ...patch };
    setMeta(SETTINGS_KEY, JSON.stringify(next));
    return settings();
  }

  // In one millisecond two distinct edits still need distinct scheduler marks.
  // Core's SQLite semantic trigger separately tracks cross-handle app edits.
  const markRatingsChanged = () => saveSettings({
    ratingsChangedAt: Math.max(now(), settings().ratingsChangedAt + 1),
  });

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

  /** The inner writer runs under a SQLite savepoint (see below). */
  function writeAppRating({ catalogId = "", seriesKey = "", season = null, title = "", kind = null, year = null, score = null, status = null, itemId = null, provenance = null, statusOnly = false, scoreOnly = false, expectedLocalUpdatedAt = undefined } = {}) {
    const key = appRatingKey({ catalogId, seriesKey, season, kind });
    if (!key) throw Object.assign(new Error("A title is required"), { statusCode: 400 });
    const oldKey = appRatingKey({ catalogId, seriesKey, season });
    if (key !== oldKey && !statement("SELECT 1 FROM rec_ratings WHERE rating_key = ?").get(key)) {
      const legacy = statement("SELECT source, kind FROM rec_ratings WHERE rating_key = ?").get(oldKey);
      if (legacy?.source === "app" && (!legacy.kind || legacy.kind === kind))
        statement("UPDATE rec_ratings SET rating_key = ? WHERE rating_key = ? AND source = 'app'").run(key, oldKey);
    }
    const occupied = statement("SELECT source FROM rec_ratings WHERE rating_key = ?").get(key);
    if (occupied && occupied.source !== "app") {
      if (score === null && !status) return null;
      throw Object.assign(new Error("A different provider owns this rating identity"), { statusCode: 409 });
    }
    const existing = statement("SELECT * FROM rec_ratings WHERE rating_key = ?").get(key);
    // An authenticated AniList -> LVL copy is planned from a particular local
    // rating snapshot. Verify the same row still owns that revision *under the
    // writer savepoint*; a subsequent same-millisecond local edit must win.
    // Ordinary local edits and accepted Core sync replay leave this optional.
    if (expectedLocalUpdatedAt !== undefined) {
      const valid = expectedLocalUpdatedAt === null
        ? !existing
        : Number.isSafeInteger(expectedLocalUpdatedAt) && expectedLocalUpdatedAt > 0
          && existing?.source === "app" && existing.updated_at === expectedLocalUpdatedAt;
      if (!valid) throw Object.assign(new Error("The local rating changed during AniList score copy; refresh before retrying"), { statusCode: 409 });
    }
    // Status-only updates must use the current persisted app score, not a
    // possibly stale score shown in the browser (including an AniList score).
    // Never inherit a foreign source's rating: occupied keys were rejected.
    const nextScore = statusOnly === true ? existing?.score ?? null : score;
    const nextStatus = scoreOnly === true && statusOnly !== true
      ? existing?.status ?? null : status;
    if (nextScore === null && !nextStatus) {
      statement("DELETE FROM rec_ratings WHERE rating_key = ? AND source = 'app'").run(key);
      markRatingsChanged();
      return null;
    }
    // updated_at doubles as a local per-rating compare-and-swap revision for
    // browser score copies. Unlike Date.now alone it cannot tie two edits in
    // the same millisecond or move backward when a device clock drifts.
    const at = Math.max(now(), Number(existing?.updated_at || 0) + 1);
    const nextKind = text(kind, 20) || existing?.kind || null;
    const nextTitle = text(title, 300) || existing?.title || "Untitled";
    const nextYear = int(year) ?? existing?.year ?? null;
    // Verified IMDb identity is independent of mutable title/year presentation.
    // The persisted catalog_id, kind and season must each agree with the
    // incoming *validated* work; a matching rating_key or an alias is not proof.
    const nextCatalogId = text(catalogId, 40);
    const nextSeriesKey = text(seriesKey, 300);
    const nextSeason = int(season);
    const sameStoredIdentity = existing?.source === "app"
      && (existing.catalog_id || null) === nextCatalogId
      && (existing.series_key || null) === nextSeriesKey
      && (existing.season ?? null) === nextSeason;
    const verifiedSameWork = existing?.source === "app"
      && /^tt\d{5,12}$/.test(String(catalogId))
      && existing.catalog_id === String(catalogId)
      && ["anime", "anime-movie", "movie", "series"].includes(kind)
      && existing.kind === kind
      && (season === null || Number.isInteger(season))
      && (existing.season ?? null) === season;
    // Preserve the older conservative presentation rule for unchanged legacy
    // identities, never across a rekey, a kind/season change or contradictory
    // persisted catalog identity.
    const samePresentation = sameStoredIdentity && existing.kind === nextKind
      && existing.title === nextTitle && (existing.year ?? null) === nextYear;
    const sameTarget = verifiedSameWork || samePresentation;
    const origin = provenance?.source === "anilist" && Number.isSafeInteger(provenance.accountUserId) && provenance.accountUserId > 0
      && Number.isSafeInteger(provenance.mediaId) && provenance.mediaId > 0 && provenance.score === score
      ? { source: "anilist", accountUserId: provenance.accountUserId, mediaId: provenance.mediaId, score } : null;
    // An explicit local edit is a new source of authority. The previous
    // AniList import can no longer claim ownership of this score, even when
    // the user happens to enter the same value. Only the copy operation can
    // attach a fresh, account-and-media verified AniList provenance record.
    // Changing watch status does not alter score ownership; an explicit
    // score edit still removes any previously imported AniList provenance.
    // A status-only edit of a verified unchanged work can rename presentation
    // without losing a previously attested score origin. The stored score,
    // account and media are never replaced by browser/import snapshot values.
    // Historical malformed provenance does not gain authority merely because
    // a rating key happens to contain an IMDb-looking string.
    const previousOrigin = parse(existing?.provenance_json, null);
    const priorAniListOrigin = previousOrigin?.source === "anilist"
      && Number.isSafeInteger(previousOrigin.accountUserId) && previousOrigin.accountUserId > 0
      && Number.isSafeInteger(previousOrigin.mediaId) && previousOrigin.mediaId > 0
      && previousOrigin.score === existing?.score;
    const provenanceValue = statusOnly === true
      ? (samePresentation || (verifiedSameWork && priorAniListOrigin) ? previousOrigin : null) : origin;
    statement(`INSERT OR REPLACE INTO rec_ratings (rating_key, source, item_id, catalog_id, series_key, season, title, kind, year, score, status, progress, rated_at, updated_at, mapped_at, provenance_json)
      VALUES (?, 'app', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`)
      .run(key, itemId || (sameTarget ? existing.item_id : null) || null, nextCatalogId, nextSeriesKey, nextSeason, nextTitle,
        nextKind, nextYear, real(nextScore), text(nextStatus, 20), at, at, sameTarget ? existing.mapped_at ?? null : null, provenanceValue ? JSON.stringify(provenanceValue) : null);
    markRatingsChanged();
    return ratingFromRow(statement("SELECT * FROM rec_ratings WHERE rating_key = ?").get(key));
  }

  /** Your rating of a title (or season), atomically with its change marker.
   * SAVEPOINT joins Core's existing sync-journal BEGIN IMMEDIATE + causal
   * SAVEPOINT without attempting a nested BEGIN. Standalone HTTP writes gain
   * the same all-or-nothing key migration, rating, provenance and settings
   * behavior. app-db's narrow recs_settings nested-writer exception remains
   * responsible for persisting the marker under the already held lock.
   */
  function setAppRating(options = {}, { verifyWrite = null } = {}) {
    db.exec("SAVEPOINT recs_app_rating_write");
    try {
      // An authenticated provider-copy guard must read its account and media
      // proof under the same writer reservation as the local rating change.
      // Core's accepted causal sync producer uses this API without a browser
      // attestation callback and retains its own journal/ledger authority.
      if (verifyWrite) verifyWrite();
      const result = writeAppRating(options);
      db.exec("RELEASE recs_app_rating_write");
      return result;
    } catch (error) {
      db.exec("ROLLBACK TO recs_app_rating_write");
      db.exec("RELEASE recs_app_rating_write");
      throw error;
    }
  }

  const rating = (key) => {
    const row = statement("SELECT * FROM rec_ratings WHERE rating_key = ?").get(key);
    return row && visible(row) ? ratingFromRow(row) : null;
  };

  /** Only a verified catalog identity may join imported ratings to a known work. */
  function titleRatings({ catalogId = "", seriesKey = "", kind = null, year = null, anilistIds = [] } = {}) {
    const all = ratings();
    // AniList exposes MOVIE format under its generic "anime" kind. Its stable
    // media ID and catalog mapping still identify the anime film exactly.
    const matchingKind = (rated) => !kind || !rated.kind || rated.kind === kind
      || (kind === "anime-movie" && rated.source === "anilist" && rated.kind === "anime");
    const matchingYear = (rated) => !year || !rated.year || Math.abs(Number(rated.year) - Number(year)) <= 1;
    const own = all.filter((rated) => rated.source === "app" && matchingKind(rated) && (catalogId || matchingYear(rated)) && (
      catalogId ? rated.catalogId === catalogId : !rated.catalogId && Boolean(seriesKey) && rated.seriesKey === seriesKey));
    const itemIds = new Set(catalogId ? statement("SELECT item_id, kind FROM rec_items WHERE imdb_id = ?").all(catalogId)
      .filter((row) => !kind || !row.kind || row.kind === kind || (kind === "anime-movie" && row.kind === "anime"))
      .map((row) => row.item_id) : []);
    // A selected Library title may already carry exact AniList media IDs
    // before the separate IMDb crosswalk has been fetched. IDs come from its
    // verified source mapping, not from a name lookup. Keep the account and
    // kind filters, and refuse any stored conflicting IMDb association.
    if (!kind || kind === "anime" || kind === "anime-movie") {
      for (const id of [...new Set(Array.isArray(anilistIds) ? anilistIds : [])].slice(0, 30)) {
        if (!Number.isSafeInteger(id) || id <= 0) continue;
        const itemId = `anilist:${id}`;
        const item = statement("SELECT source, kind, imdb_id FROM rec_items WHERE item_id = ?").get(itemId);
        if (item?.source !== "anilist" || (catalogId && item.imdb_id && item.imdb_id !== catalogId)) continue;
        if (kind && item.kind && item.kind !== kind && !(kind === "anime-movie" && item.kind === "anime")) continue;
        itemIds.add(itemId);
      }
    }
    return [...own, ...all.filter((rated) => rated.source !== "app" && itemIds.has(rated.itemId) && matchingKind(rated))];
  }

  function setRatingItem(key, itemId) {
    statement("UPDATE rec_ratings SET item_id = COALESCE(?, item_id), mapped_at = ? WHERE rating_key = ?").run(itemId || null, now(), key);
  }

  // An unsafe older startup may have assigned B's key to an account-unknown
  // rating. Move that row to a collision-safe legacy key before B imports it.
  // Both rows and their full histories survive, and the change is transactional.
  function preserveKeyCollision(key, source, owner) {
    const previous = statement("SELECT source, account_id FROM rec_ratings WHERE rating_key = ?").get(key);
    if (!previous || (previous.source === source && previous.account_id === owner)) return;
    let displaced = `legacy:${key}`;
    let suffix = 0;
    while (statement("SELECT 1 FROM rec_ratings WHERE rating_key = ?").get(displaced)) {
      suffix += 1;
      displaced = `legacy:${key}:${suffix}`;
    }
    statement("UPDATE rec_ratings SET rating_key = ? WHERE rating_key = ?").run(displaced, key);
  }

  /** Replaces everything imported from one account (AniList, Letterboxd) with a fresh copy. */
  function replaceSourceRatings(source, entries = [], { account } = {}) {
    const owner = ownerId(source, account === undefined ? settings()[source] : account);
    transaction(() => {
      statement("DELETE FROM rec_ratings WHERE source = ? AND account_id = ?").run(source, owner);
      for (const entry of entries) {
        const key = `${source}:${owner}:${entry.key || entry.itemId}`;
        preserveKeyCollision(key, source, owner);
        statement(`INSERT OR REPLACE INTO rec_ratings (rating_key, source, item_id, catalog_id, series_key, season, title, kind, year, score, status, progress, rated_at, updated_at, mapped_at, provenance_json, account_id)
          VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(key, source, entry.itemId || null, text(entry.title, 300) || "Untitled", text(entry.kind, 20), int(entry.year), real(entry.score),
            text(entry.status, 20), int(entry.progress), int(entry.ratedAt), Number(entry.updatedAt) || now(), entry.itemId ? now() : null,
            entry.provenance ? JSON.stringify(entry.provenance) : null, owner);
      }
    });
    markRatingsChanged();
  }

  /** Adds an account's entries to what's there (the Letterboxd feed only has recent ones); a missing score or id keeps the earlier one. */
  function mergeSourceRatings(source, entries = [], { account } = {}) {
    const owner = ownerId(source, account === undefined ? settings()[source] : account);
    transaction(() => {
      for (const entry of entries) {
        const key = `${source}:${owner}:${entry.key || entry.itemId}`;
        preserveKeyCollision(key, source, owner);
        const previous = statement("SELECT provenance_json FROM rec_ratings WHERE rating_key = ? AND source = ? AND account_id = ?").get(key, source, owner);
        const oldProvenance = parse(previous?.provenance_json, null);
        const combinedHistory = [...(oldProvenance?.history || []), ...(entry.provenance?.history || [])];
        const history = [...new Map(combinedHistory.map((record) => [JSON.stringify(record), record])).values()];
        const provenance = entry.provenance || oldProvenance ? JSON.stringify({ ...oldProvenance, ...entry.provenance, history }) : null;
        statement(`INSERT INTO rec_ratings (rating_key, source, item_id, catalog_id, series_key, season, title, kind, year, score, status, progress, rated_at, updated_at, mapped_at, provenance_json, account_id)
          VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(rating_key) DO UPDATE SET item_id = COALESCE(excluded.item_id, rec_ratings.item_id), title = excluded.title,
            year = COALESCE(excluded.year, rec_ratings.year),
            score = CASE WHEN excluded.score IS NULL THEN rec_ratings.score
              WHEN COALESCE(excluded.rated_at, 0) >= COALESCE(rec_ratings.rated_at, 0)
                THEN excluded.score ELSE COALESCE(rec_ratings.score, excluded.score) END,
            status = CASE WHEN COALESCE(excluded.rated_at, 0) >= COALESCE(rec_ratings.rated_at, 0)
              THEN excluded.status ELSE COALESCE(rec_ratings.status, excluded.status) END,
            rated_at = MAX(COALESCE(excluded.rated_at, 0), COALESCE(rec_ratings.rated_at, 0)),
            updated_at = MAX(excluded.updated_at, rec_ratings.updated_at),
            mapped_at = COALESCE(rec_ratings.mapped_at, excluded.mapped_at),
            provenance_json = COALESCE(excluded.provenance_json, rec_ratings.provenance_json)`)
          .run(key, source, entry.itemId || null, text(entry.title, 300) || "Untitled", text(entry.kind, 20), int(entry.year), real(entry.score),
            text(entry.status, 20), int(entry.progress), int(entry.ratedAt), Number(entry.updatedAt) || now(), entry.itemId ? now() : null, provenance, owner);
      }
    });
    markRatingsChanged();
  }

  const removeSourceRatings = (source) => {
    const currentOwner = activeAccount(source);
    statement("DELETE FROM rec_ratings WHERE source = ? AND (account_id = ? OR (? = 'letterboxd' AND account_id = 'import'))")
      .run(source, currentOwner, source);
    markRatingsChanged();
  };

  const ratings = () => {
    const rows = statement("SELECT * FROM rec_ratings ORDER BY COALESCE(score, -1) DESC, title").all().filter(visible).map(ratingFromRow);
    // Verified crosswalks may connect an explicit CSV import to a current RSS
    // account rating. Keep both database rows/history; show only the merged film.
    const merged = new Map();
    const out = [];
    for (const row of rows) {
      // An unverified old account may share a correct movie ID with the newly
      // linked account. Never fold its score or provenance into that account.
      const identifier = row.accountId !== LEGACY_ACCOUNT && row.source === "letterboxd"
        && /^tmdb:movie:\d+$/.test(row.itemId || "") ? row.itemId : null;
      if (!identifier || !merged.has(identifier)) {
        out.push(row);
        if (identifier) merged.set(identifier, row);
        continue;
      }
      const current = merged.get(identifier);
      const better = row.score !== null && (current.score === null || (row.ratedAt || 0) > (current.ratedAt || 0));
      const chosen = better ? row : current;
      const history = [...new Map([...(current.provenance?.history || []), ...(row.provenance?.history || [])]
        .map((entry) => [JSON.stringify(entry), entry])).values()];
      Object.assign(current, chosen, { provenance: { ...chosen.provenance, history } });
    }
    return out;
  };
  /** Ratings allowed to drive the active account's recommendations. */
  const ratingsForRecommendations = () => ratings().filter((row) => row.accountId !== LEGACY_ACCOUNT);
  const unmappedRatings = (source, olderThan) => statement("SELECT * FROM rec_ratings WHERE source = ? AND item_id IS NULL AND (mapped_at IS NULL OR mapped_at < ?)")
    .all(source, olderThan).filter((row) => visible(row) && row.account_id !== LEGACY_ACCOUNT).map(ratingFromRow);

  function hide(itemId) {
    statement("INSERT OR REPLACE INTO rec_hidden (item_id, hidden_at) VALUES (?, ?)").run(itemId, now());
    statement("DELETE FROM rec_picks WHERE item_id = ?").run(itemId);
  }
  const unhideAll = () => statement("DELETE FROM rec_hidden").run().changes;
  const hidden = () => new Set(statement("SELECT item_id FROM rec_hidden").all().map((row) => row.item_id));

  const startRun = (trigger) => Number(statement("INSERT INTO rec_runs (trigger, started_at, status, account_scope) VALUES (?, ?, 'running', ?)")
    .run(trigger, now(), accountScope()).lastInsertRowid);
  /** An update that was still running when the app stopped can't finish any more. */
  const failInterruptedRuns = () => statement("UPDATE rec_runs SET status = 'failed', finished_at = ?, error = 'The app stopped during this update' WHERE status = 'running'").run(now()).changes;

  function finishRun(runId, { status = "done", seeds = 0, candidates = 0, picks = 0, requests = 0, curve = null, error = null } = {}) {
    return transaction(() => {
      const changed = statement("UPDATE rec_runs SET finished_at = ?, status = ?, seeds = ?, candidates = ?, picks = ?, requests = ?, curve = ?, error = ? WHERE run_id = ? AND status = 'running' AND account_scope = ?")
        .run(now(), status, seeds, candidates, picks, requests, curve ? JSON.stringify(curve) : null, text(error, 500), runId, accountScope()).changes;
      if (!changed) return false;
      const runs = statement("SELECT run_id FROM rec_runs ORDER BY run_id DESC").all().map((row) => row.run_id);
      if (runs.length <= KEEP_RUNS) return true;
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
      return true;
    });
  }

  function savePicks(runId, picks = []) {
    return transaction(() => {
      if (!statement("SELECT 1 FROM rec_runs WHERE run_id = ? AND status = 'running' AND account_scope = ?")
        .get(runId, accountScope())) return false;
      for (const pick of picks) {
        statement("INSERT OR REPLACE INTO rec_picks (run_id, rank, item_id, match, raw, features, reasons, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .run(runId, pick.rank, pick.itemId, pick.match, pick.raw, JSON.stringify(pick.features || {}), JSON.stringify(pick.reasons || []), text(pick.summary, 300));
      }
      return true;
    });
  }

  const runFromRow = (row) => (row ? { ...row, curve: parse(row.curve, null) } : null);
  const lastRun = () => runFromRow(statement("SELECT * FROM rec_runs WHERE account_scope = ? ORDER BY run_id DESC LIMIT 1").get(accountScope()));
  const lastGoodRun = () => runFromRow(statement("SELECT * FROM rec_runs WHERE status = 'done' AND account_scope = ? ORDER BY run_id DESC LIMIT 1").get(accountScope()));

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
    const rows = statement(`SELECT p.raw AS raw, r.score AS score, r.rating_key AS rating_key FROM rec_ratings r
      JOIN rec_picks p ON p.item_id = r.item_id JOIN rec_runs u ON u.run_id = p.run_id
      WHERE r.score IS NOT NULL AND r.rated_at > u.started_at
      AND u.account_scope = ?
      AND u.run_id = (SELECT MAX(u2.run_id) FROM rec_picks p2 JOIN rec_runs u2 ON u2.run_id = p2.run_id WHERE p2.item_id = r.item_id AND u2.started_at < r.rated_at AND u2.account_scope = ?)`).all(accountScope(), accountScope());
    const activeKeys = new Set(ratingsForRecommendations().map((row) => row.key));
    return rows.filter((row) => activeKeys.has(row.rating_key)).map((row) => ({ raw: row.raw, liked: row.score >= average }));
  }

  function stats() {
    const count = (sql, ...args) => Number(statement(sql).get(...args)?.n || 0);
    const bySource = {};
    for (const row of ratingsForRecommendations()) {
      if (!bySource[row.source]) bySource[row.source] = { count: 0, scored: 0 };
      bySource[row.source].count += 1;
      if (row.score !== null) bySource[row.source].scored += 1;
    }
    const unverified = statement("SELECT COUNT(*) AS n, SUM(score IS NOT NULL) AS scored FROM rec_ratings WHERE account_id = ?").get(LEGACY_ACCOUNT);
    return {
      ratings: bySource,
      unverifiedLegacy: { count: Number(unverified?.n || 0), scored: Number(unverified?.scored || 0) },
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
    setAppRating, rating, titleRatings, setRatingItem, replaceSourceRatings, mergeSourceRatings, removeSourceRatings,
    ratings, ratingsForRecommendations, unmappedRatings,
    hide, unhideAll, hidden, startRun, failInterruptedRuns, finishRun, savePicks, lastRun, lastGoodRun, currentPicks, outcomes, stats, clearCache,
  };
}
