// Favorite sources from extension repositories, like Mihon's
// pinned sources. A favorite keeps what's needed to use it offline from the
// repository list: name, language, base URL, extension and version. The theme
// LVL found in each extension version is kept per package. Source chapters get
// short stable ids ("ex-" + 20 hex) so the browser never sends site URLs.
// Each source can have its own settings (address, browser use, speed, options).
import crypto from "node:crypto";
import { PACKAGE_ENGINES } from "./source-engines.js";
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
  const parse = (text) => { try { return JSON.parse(text) || {}; } catch { return {}; } };
  const favoritesQuery = db.prepare("SELECT * FROM comic_ext_sources ORDER BY added_at");
  const favoriteQuery = db.prepare("SELECT * FROM comic_ext_sources WHERE source_id = ?");
  const insertFavorite = db.prepare(`INSERT INTO comic_ext_sources (source_id, pkg, repo, ext_name, name, lang, base_url, version, nsfw, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_id) DO UPDATE SET pkg = excluded.pkg, repo = excluded.repo, ext_name = excluded.ext_name, name = excluded.name, lang = excluded.lang,
    base_url = excluded.base_url, version = excluded.version, nsfw = excluded.nsfw`);
  const deleteFavorite = db.prepare("DELETE FROM comic_ext_sources WHERE source_id = ?");
  const insertChapter = db.prepare("INSERT OR IGNORE INTO comic_ext_chapters (id, source_id, path, created_at) VALUES (?, ?, ?, ?)");
  const chapterRow = db.prepare("SELECT * FROM comic_ext_chapters WHERE id = ?");
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
  function recordMove(sourceId, origin) {
    const row = favoriteQuery.get(String(sourceId));
    let url = null;
    try { url = new URL(String(origin)); } catch {}
    if (!row || !url || !/^https?:$/.test(url.protocol) || url.username || url.password) return;
    if (url.origin === row.base_url) { deleteMove.run(row.source_id); return; }
    if (moveOf(row) !== url.origin) saveMove.run(row.source_id, row.base_url, url.origin, now());
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
    // An own address returns other pages: its own cache entries.
    const content = settings.baseUrl || "";
    return {
      id: row.source_id, pkg: row.pkg, repo: row.repo, extension: row.ext_name, name: row.name, lang: row.lang, baseUrl: settings.baseUrl || movedTo || row.base_url, repoBaseUrl: row.base_url,
      movedTo, onMove: (origin) => { if (!settings.baseUrl) recordMove(row.source_id, origin); },
      version: row.version, nsfw: Boolean(row.nsfw), settings, cacheKey: content ? `${row.source_id}~${crypto.createHash("sha1").update(content).digest("hex").slice(0, 8)}` : row.source_id,
      theme: current?.theme || null, error: null, supported: Boolean(current), addedAt: row.added_at, adult: adult() === true,
    };
  };

  return {
    showAdult: () => adult() === true,
    favorites: () => favoritesQuery.all().map(view),
    favorite: (sourceId) => view(favoriteQuery.get(String(sourceId))),
    isFavorite: (sourceId) => Boolean(favoriteQuery.get(String(sourceId))),
    // ext: an extension from the repository index; source: one of ext.sources.
    add(ext, source, repo = "") {
      if (!PKG.test(String(ext?.pkg || "")) || !SOURCE_ID.test(String(source?.id || ""))) throw new Error("Unknown source");
      if (!/^https?:\/\/[^/\s]+/.test(String(source.baseUrl || ""))) throw new Error("This source has no address");
      insertFavorite.run(String(source.id), ext.pkg, String(repo).slice(0, 80), String(ext.name).slice(0, 120), String(source.name || ext.name).slice(0, 120),
        String(source.lang || ext.lang || "").slice(0, 12), String(source.baseUrl).replace(/\/+$/, ""), String(ext.version || "").slice(0, 40), ext.nsfw ? 1 : 0, now());
      return view(favoriteQuery.get(String(source.id)));
    },
    remove: (sourceId) => deleteFavorite.run(String(sourceId)).changes > 0,
    // Keeps favorites in step with the repository (sites move domain; versions change).
    // Returns the ids of favorites whose address or version changed.
    refresh(extensions) {
      const bySource = new Map();
      const byPackage = new Map();
      for (const ext of extensions) {
        byPackage.set(ext.pkg, ext);
        for (const source of ext.sources || []) bySource.set(String(source.id), { ext, source });
      }
      const changed = [];
      for (const row of favoritesQuery.all()) {
        let hit = bySource.get(row.source_id);
        if (!hit) {
          // The extension renamed or re-keyed its source: the same extension's source for this language.
          const ext = byPackage.get(row.pkg);
          const same = (ext?.sources || []).filter((source) => source.lang === row.lang);
          const source = same.length === 1 ? same[0] : same.find((item) => item.name === row.name);
          if (!source) continue;
          hit = { ext, source: { ...source, id: row.source_id } };
        }
        const baseUrl = String(hit.source.baseUrl || "").replace(/\/+$/, "");
        if (baseUrl && (baseUrl !== row.base_url || String(hit.ext.version || "") !== row.version)) {
          this.add(hit.ext, hit.source, row.repo);
          changed.push(row.source_id);
        }
      }
      return changed;
    },
    settings: (sourceId) => settingsOf(sourceId),
    // Saves a site's settings (only what differs from the defaults); {} resets them.
    saveSettings(sourceId, input) {
      const clean = cleanSiteSettings(input, { strict: true });
      if (Object.keys(clean).length) saveSettingsRow.run(String(sourceId), JSON.stringify(clean), now());
      else deleteSettingsRow.run(String(sourceId));
      return view(favoriteQuery.get(String(sourceId))) || clean;
    },
    support: (pkg) => support(String(pkg)),
    chapterId(sourceId, path) {
      const id = extChapterId(sourceId, path);
      insertChapter.run(id, String(sourceId), String(path), now());
      return id;
    },
    chapter(id) {
      if (!EXT_CHAPTER_ID.test(String(id))) return null;
      const row = chapterRow.get(String(id));
      return row ? { id: row.id, sourceId: row.source_id, path: row.path } : null;
    },
  };
}

// A manga or chapter path on a source site: "/manga/frieren/" (no host, no "..").
export function validSitePath(value) {
  const path = String(value || "");
  return path.length <= 500 && /^\/(?!\/)[^\s\\]*$/.test(path) && !/(^|\/)\.\.(\/|$)/.test(path);
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
