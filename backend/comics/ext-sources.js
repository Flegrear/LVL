// Favorite sources from extension repositories, like Mihon's
// pinned sources. A favorite keeps what's needed to use it offline from the
// repository list: name, language, base URL, extension and version. The theme
// LVL found in each extension version is kept per package. Source chapters get
// short stable ids ("ex-" + 20 hex) so the browser never sends site URLs.
// Each source can have its own settings (address, browser use, speed, options).
import crypto from "node:crypto";
import { PACKAGE_ENGINES } from "./source-engines.js";
import { checkUrl } from "./remote-fetch.js";
import { BROWSER_MODES, SITE_SPEEDS } from "./source-site.js";
import { EXT_CHAPTER_ID, SOURCE_ID } from "../../shared/reading/ids.js";

export { EXT_CHAPTER_ID };
const PKG = /^[A-Za-z0-9_.]{3,160}$/;
const EXT = "eu.kanade.tachiyomi.extension.";
// A source chapter's id: the same on every device for the same source and chapter path.
export const extChapterId = (sourceId, path) => `ex-${crypto.createHash("sha256").update(`${sourceId}\n${path}`).digest("hex").slice(0, 20)}`;

// Favorites a new profile starts with (all from keiyoushi).
// Removing one keeps it removed. Versions and site moves come from the repository.
export const DEFAULT_FAVORITES = Object.freeze([
  { id: "2598725055968738551", pkg: `${EXT}es.bloomscans`, extension: "Bloom Scans", name: "Bloom Scans", lang: "es", baseUrl: "https://bloomscans.com" },
  { id: "6291099060619088371", pkg: `${EXT}all.kagane`, extension: "Kagane", name: "Kagane", lang: "es", baseUrl: "https://kagane.cx" },
  { id: "4024736764982024684", pkg: `${EXT}all.kagane`, extension: "Kagane", name: "Kagane", lang: "en", baseUrl: "https://kagane.cx" },
  { id: "5020395055978987501", pkg: `${EXT}en.mangabuddy`, extension: "MangaK", name: "MangaK", lang: "en", baseUrl: "https://mangak.io" },
  { id: "6484561431658238800", pkg: `${EXT}en.mangafox`, extension: "MangaFox", name: "MangaFox", lang: "en", baseUrl: "https://fanfox.net" },
  { id: "397029358682805931", pkg: `${EXT}en.manhwabuddy`, extension: "ManhwaBuddy", name: "ManhwaBuddy", lang: "en", baseUrl: "https://manhwabuddy.com" },
  { id: "5177484976652938680", pkg: `${EXT}en.manhwatop`, extension: "Manhwatop", name: "Manhwatop", lang: "en", baseUrl: "https://manhwatop.com" },
]);

export function createExtSources({ db, now = Date.now, defaults = DEFAULT_FAVORITES, adult = () => false } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS comic_ext_sources (source_id TEXT PRIMARY KEY, pkg TEXT NOT NULL, repo TEXT NOT NULL DEFAULT '', ext_name TEXT NOT NULL,
    name TEXT NOT NULL, lang TEXT NOT NULL DEFAULT '', base_url TEXT NOT NULL, version TEXT NOT NULL DEFAULT '', nsfw INTEGER NOT NULL DEFAULT 0, added_at INTEGER NOT NULL)`);
  // Which theme LVL's old engines found in each extension. Nothing writes it
  // now; linked-sources' migrateLegacy reads it to rewrite entries saved in those engines' form.
  db.exec(`CREATE TABLE IF NOT EXISTS comic_ext_packages (pkg TEXT PRIMARY KEY, version TEXT NOT NULL, theme TEXT, hints_json TEXT NOT NULL DEFAULT '{}',
    error TEXT, analyzed_at INTEGER NOT NULL)`);
  db.exec("CREATE TABLE IF NOT EXISTS comic_ext_chapters (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, path TEXT NOT NULL, created_at INTEGER NOT NULL)");
  db.exec(`CREATE TABLE IF NOT EXISTS comic_ext_source_aliases
    (old_id TEXT PRIMARY KEY, new_id TEXT NOT NULL, pkg TEXT NOT NULL, repo TEXT NOT NULL, verified_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS comic_ext_chapter_aliases
    (old_id TEXT PRIMARY KEY, new_id TEXT NOT NULL, source_id TEXT NOT NULL, proof TEXT NOT NULL, verified_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS comic_ext_manga_aliases
    (work_id TEXT NOT NULL, source_id TEXT NOT NULL, old_path TEXT NOT NULL, new_path TEXT NOT NULL,
      proof TEXT NOT NULL, verified_at INTEGER NOT NULL, PRIMARY KEY (work_id, source_id, old_path));`);
  const parse = (text) => { try { return JSON.parse(text) || {}; } catch { return {}; } };
  const favoritesQuery = db.prepare("SELECT * FROM comic_ext_sources ORDER BY added_at");
  const favoriteQuery = db.prepare("SELECT * FROM comic_ext_sources WHERE source_id = ?");
  const insertFavorite = db.prepare(`INSERT INTO comic_ext_sources (source_id, pkg, repo, ext_name, name, lang, base_url, version, nsfw, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_id) DO UPDATE SET pkg = excluded.pkg, repo = excluded.repo, ext_name = excluded.ext_name, name = excluded.name, lang = excluded.lang,
    base_url = excluded.base_url, version = excluded.version, nsfw = excluded.nsfw`);
  const deleteFavorite = db.prepare("DELETE FROM comic_ext_sources WHERE source_id = ?");
  const insertChapter = db.prepare("INSERT OR IGNORE INTO comic_ext_chapters (id, source_id, path, created_at) VALUES (?, ?, ?, ?)");
  const chapterRow = db.prepare("SELECT * FROM comic_ext_chapters WHERE id = ?");
  const sourceAlias = db.prepare("SELECT new_id FROM comic_ext_source_aliases WHERE old_id = ?");
  const chapterAlias = db.prepare("SELECT new_id FROM comic_ext_chapter_aliases WHERE old_id = ?");
  const chapterByPath = db.prepare("SELECT id FROM comic_ext_chapters WHERE source_id = ? AND path = ?");
  const mangaAlias = db.prepare("SELECT new_path FROM comic_ext_manga_aliases WHERE work_id = ? AND source_id = ? AND old_path = ?");
  const hasTable = (name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
  const moveId = (table, field, previous, next) => {
    if (hasTable(table)) db.prepare(`UPDATE ${table} SET ${field} = ? WHERE ${field} = ?`).run(next, previous);
  };
  const atomic = (task) => {
    db.exec("SAVEPOINT comic_ext_rekey");
    try { const result = task(); db.exec("RELEASE comic_ext_rekey"); return result; }
    catch (error) { db.exec("ROLLBACK TO comic_ext_rekey"); db.exec("RELEASE comic_ext_rekey"); throw error; }
  };
  function rekeyChapter(oldId, nextId, newSource, nextPath, proof) {
    if (oldId === nextId) return nextId;
    if (chapterRow.get(nextId) || chapterAlias.get(nextId)) throw new Error("Conflicting chapter identity; migration stopped");
    for (const [table, key] of [
      ["comic_progress", "file_id"],
      ["comic_remote_progress", "file_id"],
      ["comic_remote_page_witness", "file_id"],
      ["comic_resume_sessions", "file_id"],
      ["comic_read_units", "unit_id"],
      ["comic_chapter_choices", "unit_id"],
    ]) {
      if (!hasTable(table)) continue;
      // Composite keys are work-scoped except legacy comic_progress. An
      // existing destination is independent history, never overwritten.
      if (db.prepare(`SELECT 1 FROM ${table} WHERE ${key} = ? LIMIT 1`).get(nextId))
        throw new Error(`Conflicting saved ${table} history; migration stopped`);
    }
    moveId("comic_progress", "file_id", oldId, nextId);
    moveId("comic_remote_progress", "file_id", oldId, nextId);
    moveId("comic_remote_page_witness", "file_id", oldId, nextId);
    moveId("comic_resume_sessions", "file_id", oldId, nextId);
    moveId("comic_read_units", "unit_id", oldId, nextId);
    moveId("comic_chapter_choices", "unit_id", oldId, nextId);
    db.prepare("UPDATE comic_ext_chapters SET id = ?, source_id = ?, path = ? WHERE id = ?")
      .run(nextId, newSource, nextPath, oldId);
    db.prepare(`INSERT INTO comic_ext_chapter_aliases (old_id, new_id, source_id, proof, verified_at)
      VALUES (?, ?, ?, ?, ?)`).run(oldId, nextId, newSource, proof, now());
    return nextId;
  }
  // Per-site settings (Settings › Comics › a favorite's settings); kept when the favorite is removed.
  db.exec("CREATE TABLE IF NOT EXISTS comic_ext_settings (source_id TEXT PRIMARY KEY, settings_json TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  const settingsRow = db.prepare("SELECT settings_json FROM comic_ext_settings WHERE source_id = ?");
  const saveSettingsRow = db.prepare(`INSERT INTO comic_ext_settings (source_id, settings_json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(source_id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at`);
  const deleteSettingsRow = db.prepare("DELETE FROM comic_ext_settings WHERE source_id = ?");
  const settingsOf = (sourceId) => { const row = settingsRow.get(String(sourceId)); return row ? cleanSiteSettings(parse(row.settings_json)) : {}; };
  // Sites that answered from a new domain (from_url: the repository's address at the time).
  // A move applies until the repository lists another address for the source.
  db.exec("CREATE TABLE IF NOT EXISTS comic_ext_moves (source_id TEXT PRIMARY KEY, from_url TEXT NOT NULL, to_url TEXT NOT NULL, at INTEGER NOT NULL)");
  const moveRow = db.prepare("SELECT from_url, to_url FROM comic_ext_moves WHERE source_id = ?");
  const saveMove = db.prepare(`INSERT INTO comic_ext_moves (source_id, from_url, to_url, at) VALUES (?, ?, ?, ?)
    ON CONFLICT(source_id) DO UPDATE SET from_url = excluded.from_url, to_url = excluded.to_url, at = excluded.at`);
  const deleteMove = db.prepare("DELETE FROM comic_ext_moves WHERE source_id = ?");
  const moveOf = (row) => { const move = moveRow.get(row.source_id); return move && move.from_url === row.base_url && move.to_url !== row.base_url ? move.to_url : ""; };
  // This receipt is NOT a provider redirect and is never derived from a
  // similar display name or arbitrary Location header. Only an enabled
  // repository's successful listing may issue a replacement generation for
  // the *same* source ID, package, repository and language. Preserve it across
  // restarts so a previously cached old-origin request can be verified.
  db.exec(`CREATE TABLE IF NOT EXISTS comic_ext_repository_migrations (
    source_id TEXT PRIMARY KEY, pkg TEXT NOT NULL, repo TEXT NOT NULL,
    repository_url TEXT NOT NULL, repository_fingerprint TEXT NOT NULL,
    revision TEXT NOT NULL, generation TEXT NOT NULL,
    previous_origin TEXT NOT NULL, replacement_origin TEXT NOT NULL,
    verified_at INTEGER NOT NULL)`);
  const repositoryMigration = db.prepare("SELECT * FROM comic_ext_repository_migrations WHERE source_id = ?");
  const deleteRepositoryMigration = db.prepare("DELETE FROM comic_ext_repository_migrations WHERE source_id = ?");
  const saveRepositoryMigration = db.prepare(`INSERT INTO comic_ext_repository_migrations
    (source_id, pkg, repo, repository_url, repository_fingerprint, revision, generation, previous_origin, replacement_origin, verified_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_id) DO UPDATE SET
      pkg=excluded.pkg, repo=excluded.repo, repository_url=excluded.repository_url,
      repository_fingerprint=excluded.repository_fingerprint, revision=excluded.revision,
      generation=excluded.generation, previous_origin=excluded.previous_origin,
      replacement_origin=excluded.replacement_origin, verified_at=excluded.verified_at`);
  const originOf = (value) => {
    try { const url = checkUrl(value); return url.protocol === "https:" ? url.origin : ""; }
    catch { return ""; }
  };
  const activeRepositoryMigration = (row, settings = settingsOf(row.source_id)) => {
    if (settings.baseUrl || moveOf(row)) return null;
    const receipt = repositoryMigration.get(row.source_id);
    if (!receipt || receipt.pkg !== row.pkg || receipt.repo !== row.repo
      || receipt.revision !== row.version || !row.repo || !row.version
      || !receipt.generation || originOf(row.base_url) !== receipt.replacement_origin
      || receipt.previous_origin === receipt.replacement_origin) return null;
    return receipt;
  };
  const resolvedSource = (sourceId) => {
    let id = String(sourceId);
    const visited = new Set();
    for (let i = 0; i < 32; i++) {
      if (visited.has(id)) throw new Error("Cyclic source identity aliases");
      visited.add(id);
      const next = sourceAlias.get(id)?.new_id;
      if (!next) return id;
      id = next;
    }
    throw new Error("Source migration chain is too long");
  };
  const resolvedChapter = (chapterId) => {
    let id = String(chapterId);
    const visited = new Set();
    for (let i = 0; i < 32; i++) {
      if (visited.has(id)) throw new Error("Cyclic chapter identity aliases");
      visited.add(id);
      const next = chapterAlias.get(id)?.new_id;
      if (!next) return id;
      id = next;
    }
    throw new Error("Chapter migration chain is too long");
  };
  function recordMove(sourceId, origin) {
    const row = favoriteQuery.get(String(sourceId));
    let url = null;
    try { url = new URL(String(origin)); } catch {}
    if (!row || !url || !/^https?:$/.test(url.protocol) || url.username || url.password) return;
    if (url.origin === row.base_url) { deleteMove.run(row.source_id); return; }
    if (moveOf(row) !== url.origin) {
      deleteRepositoryMigration.run(row.source_id);
      saveMove.run(row.source_id, row.base_url, url.origin, now());
    }
  }
  db.exec("CREATE TABLE IF NOT EXISTS comic_ext_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  if (!db.prepare("SELECT 1 FROM comic_ext_meta WHERE key = 'defaults-seeded'").get()) {
    const seed = db.prepare(`INSERT OR IGNORE INTO comic_ext_sources (source_id, pkg, repo, ext_name, name, lang, base_url, version, nsfw, added_at) VALUES (?, ?, 'keiyoushi', ?, ?, ?, ?, '', 0, ?)`);
    defaults.forEach((item, index) => seed.run(item.id, item.pkg, item.extension, item.name, item.lang, item.baseUrl, now() + index));
    db.prepare("INSERT INTO comic_ext_meta (key, value) VALUES ('defaults-seeded', ?)").run(String(now()));
  }

  // LVL's own engine for an extension (MangaFox, Kagane), by package; null: the extension runs.
  const support = (pkg) => (PACKAGE_ENGINES[pkg] ? { theme: PACKAGE_ENGINES[pkg] } : null);
  const view = (row) => {
    if (!row) return null;
    const current = support(row.pkg);
    const settings = settingsOf(row.source_id);
    const movedTo = moveOf(row);
    const verified = activeRepositoryMigration(row, settings);
    // An own address returns other pages: its own cache entries.
    const content = settings.baseUrl || "";
    return {
      id: row.source_id, pkg: row.pkg, repo: row.repo, extension: row.ext_name, name: row.name, lang: row.lang, baseUrl: settings.baseUrl || movedTo || row.base_url, repoBaseUrl: row.base_url,
      ...(verified ? { migration: { sourceId: row.source_id, repositoryId: row.repo,
        revision: row.version, generation: verified.generation } } : {}),
      movedTo, onMove: (origin) => { if (!settings.baseUrl) recordMove(row.source_id, origin); },
      version: row.version, nsfw: Boolean(row.nsfw), settings, cacheKey: content ? `${row.source_id}~${crypto.createHash("sha1").update(content).digest("hex").slice(0, 8)}` : row.source_id,
      theme: current?.theme || null, error: null, supported: Boolean(current), addedAt: row.added_at, adult: adult() === true,
    };
  };

  return {
    showAdult: () => adult() === true,
    favorites: () => favoritesQuery.all().map(view),
    favorite: (sourceId) => view(favoriteQuery.get(resolvedSource(sourceId))),
    isFavorite: (sourceId) => Boolean(favoriteQuery.get(resolvedSource(sourceId))),
    resolveSourceId: resolvedSource,
    resolveChapterId: resolvedChapter,
    // Called by the transport's constructor-owned verifier at final admission.
    // Do not resolve historical source aliases or accept a requested URL as
    // repository evidence: the canonical current owner must match exactly.
    verifyRepositoryMigration(claim, { repositoryUrl = "" } = {}) {
      if (!claim || typeof claim !== "object" || !SOURCE_ID.test(String(claim.sourceId || ""))) return null;
      const row = favoriteQuery.get(String(claim.sourceId));
      if (!row || !activeRepositoryMigration(row)) return null;
      const verified = repositoryMigration.get(row.source_id);
      if (!repositoryUrl || repositoryUrl !== verified.repository_url
        || String(claim.repositoryId) !== row.repo || String(claim.revision) !== row.version
        || String(claim.generation) !== verified.generation
        || String(claim.previousOrigin) !== verified.previous_origin
        || String(claim.replacementOrigin) !== verified.replacement_origin) return null;
      let from, to;
      try { from = checkUrl(claim.previousUrl); to = checkUrl(claim.replacementUrl); } catch { return null; }
      if (from.origin !== verified.previous_origin || to.origin !== verified.replacement_origin
        || from.pathname !== to.pathname || from.search !== to.search
        || from.protocol !== "https:" || to.protocol !== "https:") return null;
      return { verified: true, sourceId: row.source_id, repositoryId: row.repo,
        revision: row.version, generation: verified.generation,
        previousOrigin: verified.previous_origin, replacementOrigin: verified.replacement_origin };
    },
    // The route verifies current signed-repository package/provenance and
    // obtains explicit confirmation before calling this method. The migration
    // is one SQLite savepoint: no half-rekeyed favorite, link or read history.
    rekeyVerified(oldSourceId, ext, replacement, repo, { confirmed = false } = {}) {
      const oldId = String(oldSourceId), nextId = String(replacement?.id || "");
      const old = favoriteQuery.get(oldId);
      if (!confirmed || !old || !SOURCE_ID.test(nextId) || nextId === oldId
        || old.pkg !== ext?.pkg || old.repo !== String(repo)
        || old.lang !== String(replacement.lang || "") || favoriteQuery.get(nextId)
        || sourceAlias.get(nextId)
        || (ext.sources || []).some((source) => String(source.id) === oldId)
        || !(ext.sources || []).some((source) => String(source.id) === nextId)
        || !/^https?:\/\/[^/\s]+/.test(String(replacement.baseUrl || "")))
        throw new Error("Source identity is unverified or conflicts with another source");
      if (sourceAlias.get(oldId)) throw new Error("This source already has an identity migration");
      const proof = `${old.pkg}|${old.repo}|${oldId}->${nextId}`;
      return atomic(() => {
        // Refuse all collisions before mutating even one saved work.
        const chapters = db.prepare("SELECT * FROM comic_ext_chapters WHERE source_id = ?").all(oldId);
        for (const chapter of chapters) {
          const nextChapter = extChapterId(nextId, chapter.path);
          if (chapterRow.get(nextChapter) || chapterAlias.get(nextChapter))
            throw new Error("Conflicting chapter identity; migration stopped");
        }
        if (hasTable("comic_work_sources")) {
          const links = db.prepare("SELECT * FROM comic_work_sources WHERE source_id = ?").all(oldId);
          for (const link of links) {
            if (db.prepare("SELECT 1 FROM comic_work_sources WHERE work_id = ? AND kind = ? AND source_id = ? AND manga_id = ?")
              .get(link.work_id, link.kind, nextId, link.manga_id))
              throw new Error("A target source link already exists; migration stopped");
          }
        }
        // The local work ID is a hash of its *original* full provider key.
        // Keep that immutable provenance so older peers can still export,
        // import and match this title. Verified source aliases translate its
        // current endpoint without rewriting a previously synced work ID.
        // Move chapter progress/choices/resume first, retaining the old ID as
        // a durable input alias for bookmarks and old peers.
        for (const chapter of chapters)
          rekeyChapter(chapter.id, extChapterId(nextId, chapter.path), nextId, chapter.path, proof);
        for (const table of ["comic_work_sources", "comic_ext_settings", "comic_ext_moves", "comic_ext_manga_aliases"])
          moveId(table, "source_id", oldId, nextId);
        if (hasTable("comic_chapter_choices")) moveId("comic_chapter_choices", "source_id", oldId, nextId);
        if (hasTable("comic_source_titles")) moveId("comic_source_titles", "cover_source", oldId, nextId);
        db.prepare("UPDATE comic_ext_sources SET source_id = ?, ext_name = ?, name = ?, base_url = ?, version = ?, nsfw = ? WHERE source_id = ?")
          .run(nextId, String(ext.name).slice(0, 120), String(replacement.name || ext.name).slice(0, 120),
            String(replacement.baseUrl).replace(/\/+$/, ""), String(ext.version || "").slice(0, 40), ext.nsfw ? 1 : 0, oldId);
        // Chapter/source aliases remain durable, but an ID rekey is never
        // equivalent to a same-ID repository domain replacement.
        deleteRepositoryMigration.run(oldId);
        deleteRepositoryMigration.run(nextId);
        db.prepare(`INSERT INTO comic_ext_source_aliases
          (old_id, new_id, pkg, repo, verified_at) VALUES (?, ?, ?, ?, ?)`)
          .run(oldId, nextId, old.pkg, old.repo, now());
        return { sourceId: nextId, migratedChapters: chapters.length };
      });
    },
    // A provider URL redirect can be committed only with an explicit verified
    // mapping. Never infer identity from matching chapter number or title.
    recordChapterRedirect(sourceId, previousPath, nextPath, { confirmed = false, proof = "" } = {}) {
      const id = resolvedSource(sourceId);
      if (!confirmed || !proof || !validSitePath(previousPath) || !validSitePath(nextPath)
        || previousPath === nextPath || !favoriteQuery.get(id))
        throw new Error("Verified chapter redirect is required");
      return atomic(() => {
        const old = chapterByPath.get(id, previousPath);
        if (!old) throw new Error("The original chapter path is unknown");
        const nextId = extChapterId(id, nextPath);
        if (chapterRow.get(nextId)) throw new Error("Target chapter already owns separate history");
        return rekeyChapter(old.id, nextId, id, nextPath, proof);
      });
    },
    // ext: an extension from the repository index; source: one of ext.sources.
    add(ext, source, repo = "") {
      if (!PKG.test(String(ext?.pkg || "")) || !SOURCE_ID.test(String(source?.id || ""))) throw new Error("Unknown source");
      if (!/^https?:\/\/[^/\s]+/.test(String(source.baseUrl || ""))) throw new Error("This source has no address");
      insertFavorite.run(String(source.id), ext.pkg, String(repo).slice(0, 80), String(ext.name).slice(0, 120), String(source.name || ext.name).slice(0, 120),
        String(source.lang || ext.lang || "").slice(0, 12), String(source.baseUrl).replace(/\/+$/, ""), String(ext.version || "").slice(0, 40), ext.nsfw ? 1 : 0, now());
      deleteRepositoryMigration.run(String(source.id));
      return view(favoriteQuery.get(String(source.id)));
    },
    remove(sourceId) {
      deleteRepositoryMigration.run(String(sourceId));
      return deleteFavorite.run(String(sourceId)).changes > 0;
    },
    // Keeps favorites in step with the repository (sites move domain; versions change).
    // Returns the ids of favorites whose address or version changed.
    refresh(extensions, { trustedRepositories = [] } = {}) {
      const trusted = new Map(trustedRepositories.map((repo) => [repo.id, repo]));
      const bySource = new Map();
      for (const ext of extensions) {
        for (const source of ext.sources || []) bySource.set(String(source.id), { ext, source });
      }
      const changed = [];
      for (const row of favoritesQuery.all()) {
        const hit = bySource.get(row.source_id);
        // A source ID change requires the explicit transactional migration
        // above. Matching package, title or language is not an identity proof.
        if (!hit || hit.ext.pkg !== row.pkg
          || (hit.ext.repo && hit.ext.repo !== row.repo)
          || String(hit.source.lang || hit.ext.lang || "") !== row.lang) continue;
        const baseUrl = String(hit.source.baseUrl || "").replace(/\/+$/, "");
        const currentReceipt = repositoryMigration.get(row.source_id);
        const signerContinuous = !currentReceipt || (trusted.has(row.repo)
          && currentReceipt.repository_fingerprint === trusted.get(row.repo).fingerprint
          && currentReceipt.repository_url === trusted.get(row.repo).url);
        if (currentReceipt && !signerContinuous)
          deleteRepositoryMigration.run(row.source_id);
        if (baseUrl && (baseUrl !== row.base_url || String(hit.ext.version || "") !== row.version)) {
          const oldOrigin = originOf(row.base_url);
          const newOrigin = originOf(baseUrl);
          this.add(hit.ext, hit.source, row.repo);
          // A configured enabled HTTPS repository's successful listing is the
          // only owner authorized to create a migration generation.
          if (trusted.has(row.repo) && signerContinuous && row.repo && hit.ext.repo === row.repo
            && oldOrigin && newOrigin && oldOrigin !== newOrigin
            && String(hit.ext.version || "")) {
            const authority = trusted.get(row.repo);
            saveRepositoryMigration.run(row.source_id, row.pkg, row.repo,
              authority.url, authority.fingerprint,
              String(hit.ext.version), crypto.randomUUID(), oldOrigin, newOrigin, now());
          }
          changed.push(row.source_id);
        }
      }
      return changed;
    },
    settings: (sourceId) => settingsOf(sourceId),
    // Saves a site's settings (only what differs from the defaults); {} resets them.
    saveSettings(sourceId, input) {
      const clean = cleanSiteSettings(input, { strict: true });
      const previous = settingsOf(sourceId);
      if (previous.baseUrl !== clean.baseUrl) deleteRepositoryMigration.run(String(sourceId));
      if (Object.keys(clean).length) saveSettingsRow.run(String(sourceId), JSON.stringify(clean), now());
      else deleteSettingsRow.run(String(sourceId));
      return view(favoriteQuery.get(String(sourceId))) || clean;
    },
    support: (pkg) => support(String(pkg)),
    chapterId(sourceId, path) {
      const current = resolvedSource(sourceId);
      const id = extChapterId(current, path);
      const redirected = resolvedChapter(id);
      if (redirected !== id) return redirected;
      insertChapter.run(id, current, String(path), now());
      return id;
    },
    chapter(id) {
      if (!EXT_CHAPTER_ID.test(String(id))) return null;
      const row = chapterRow.get(resolvedChapter(id));
      return row ? { id: row.id, sourceId: row.source_id, path: row.path } : null;
    },
  };
}

// A manga or chapter path on a source site: "/manga/frieren/" (no host, no "..").
export function validSitePath(value) {
  const path = String(value || "");
  if (path.length > 500 || !/^\/(?!\/)[^\s\\]*$/.test(path) || /[\x00-\x1f\x7f]/.test(path)) return false;
  let decoded = path;
  for (let depth = 0; depth < 3; depth++) {
    if (/(^|\/)\.\.(?:\/|$|[?#])/.test(decoded) || /\\/.test(decoded)) return false;
    if (!/%[0-9a-f]{2}/i.test(decoded)) break;
    try { decoded = decodeURIComponent(decoded); } catch { return false; }
    if (!decoded.startsWith("/") || decoded.startsWith("//")) return false;
  }
  return !/(^|\/)\.\.(?:\/|$|[?#])/.test(decoded) && !/\\/.test(decoded);
}

// A site's settings with defaults left out: { baseUrl, browser, speed } (LVL's own engines: MangaFox, Kagane).
// strict: a bad value is an error (from the Settings form) instead of being dropped (stored rows).
export function cleanSiteSettings(input = {}, { strict = false } = {}) {
  const out = {};
  const bad = (message) => { if (strict) throw Object.assign(new Error(message), { status: 400 }); };
  const address = String(input?.baseUrl || "").trim();
  if (address) {
    let url = null;
    try { url = new URL(address); } catch {}
    if (url && /^https?:$/.test(url.protocol) && !url.username && !url.password && url.hostname.includes(".")) out.baseUrl = url.origin;
    else bad("The site address must look like https://example.com");
  }
  const browser = String(input?.browser || "auto");
  if (!BROWSER_MODES.includes(browser)) bad("Unknown browser setting");
  else if (browser !== "auto") out.browser = browser;
  const speed = String(input?.speed || "normal");
  if (!Object.hasOwn(SITE_SPEEDS, speed)) bad("Unknown speed");
  else if (speed !== "normal") out.speed = speed;
  return out;
}
