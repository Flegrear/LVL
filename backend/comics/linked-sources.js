// Sources chosen for a comic. The chapter list on the comic page is
// the index; a source only supplies pages. Opening a chapter asks which chosen
// sources (and local files) have it: one opens straight away, several let the
// user pick. Source chapter lists are fetched once per source and cached.
import { normalizeUnitNumber, unitKey } from "../../shared/reading/units.js";
import { validSitePath } from "./ext-sources.js";
import { WORK_ID, isSyncableComicLink } from "../../shared/reading/ids.js";

// "ext": a source from an extension repository; manga_id is the manga's path on the site.
const KINDS = new Set(["ext"]);

export function createLinkedSources({ db, now = Date.now } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS comic_work_sources (work_id TEXT NOT NULL, kind TEXT NOT NULL, source_id TEXT NOT NULL, manga_id TEXT NOT NULL,
    name TEXT NOT NULL, title TEXT NOT NULL, lang TEXT NOT NULL DEFAULT '', added_at INTEGER NOT NULL, PRIMARY KEY (work_id, kind, source_id, manga_id))`);
  // Persistent work-scoped revision: a suspended chapter fetch must not publish
  // after a link is removed and re-added with the very same source/path.
  db.exec(`CREATE TABLE IF NOT EXISTS comic_work_source_revisions (work_id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0);
    CREATE TRIGGER IF NOT EXISTS implicit_link_revision_insert AFTER INSERT ON comic_work_sources BEGIN
      INSERT INTO comic_work_source_revisions (work_id, revision) VALUES (NEW.work_id, 1)
        ON CONFLICT(work_id) DO UPDATE SET revision = revision + 1;
    END;
    CREATE TRIGGER IF NOT EXISTS implicit_link_revision_update AFTER UPDATE ON comic_work_sources BEGIN
      INSERT INTO comic_work_source_revisions (work_id, revision) VALUES (NEW.work_id, 1)
        ON CONFLICT(work_id) DO UPDATE SET revision = revision + 1;
    END;
    CREATE TRIGGER IF NOT EXISTS implicit_link_revision_delete AFTER DELETE ON comic_work_sources BEGIN
      INSERT INTO comic_work_source_revisions (work_id, revision) VALUES (OLD.work_id, 1)
        ON CONFLICT(work_id) DO UPDATE SET revision = revision + 1;
    END;`);
  db.exec(`CREATE TABLE IF NOT EXISTS comic_ext_manga_aliases
    (work_id TEXT NOT NULL, source_id TEXT NOT NULL, old_path TEXT NOT NULL, new_path TEXT NOT NULL,
      proof TEXT NOT NULL, verified_at INTEGER NOT NULL,
      PRIMARY KEY (work_id, source_id, old_path))`);
  const list = db.prepare("SELECT * FROM comic_work_sources WHERE work_id = ? ORDER BY added_at");
  const revision = db.prepare("SELECT revision FROM comic_work_source_revisions WHERE work_id = ?");
  const owners = db.prepare("SELECT work_id FROM comic_work_sources WHERE kind = 'ext' AND source_id = ? AND manga_id = ? ORDER BY added_at");
  const aliasOwners = db.prepare("SELECT work_id FROM comic_ext_manga_aliases WHERE source_id = ? AND old_path = ? ORDER BY verified_at");
  const aliasOf = db.prepare("SELECT new_path FROM comic_ext_manga_aliases WHERE work_id = ? AND source_id = ? AND old_path = ?");
  const insert = db.prepare(`INSERT INTO comic_work_sources (work_id, kind, source_id, manga_id, name, title, lang, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(work_id, kind, source_id, manga_id) DO UPDATE SET name = excluded.name, title = excluded.title, lang = excluded.lang`);
  const remove = db.prepare("DELETE FROM comic_work_sources WHERE work_id = ? AND kind = ? AND source_id = ? AND manga_id = ?");
  const view = (row) => ({ key: `${row.kind}:${row.source_id}:${row.manga_id}`, kind: row.kind, sourceId: row.source_id, mangaId: row.manga_id, name: row.name, title: row.title, lang: row.lang, addedAt: row.added_at });
  return {
    list: (workId) => list.all(String(workId)).filter((row) => KINDS.has(row.kind)).map(view),
    revision: (workId) => revision.get(String(workId))?.revision ?? 0,
    owners: (sourceId, mangaId) => [...new Set([
      ...owners.all(String(sourceId), String(mangaId)),
      ...aliasOwners.all(String(sourceId), String(mangaId)),
    ].map((row) => row.work_id))],
    resolveMangaPath: (workId, sourceId, path) =>
      aliasOf.get(String(workId), String(sourceId), String(path))?.new_path || String(path),
    // Persist a confirmed redirect as an alias of one owner's existing link.
    // The destination's separate work/source ownership must be absent. URL
    // equality or a similar title is never used as proof.
    relinkVerified(workId, sourceId, previousPath, nextPath, { confirmed = false, proof = "" } = {}) {
      const owner = String(workId), source = String(sourceId);
      if (!confirmed || !String(proof).trim() || !WORK_ID.test(owner) ||
        !validSitePath(previousPath) || !validSitePath(nextPath) ||
        !isSyncableComicLink(owner, source, nextPath) || previousPath === nextPath)
        throw new Error("A verified source redirect is required");
      db.exec("SAVEPOINT comic_manga_relink");
      try {
        const old = db.prepare(`SELECT * FROM comic_work_sources
          WHERE work_id = ? AND kind = 'ext' AND source_id = ? AND manga_id = ?`).get(owner, source, previousPath);
        if (!old) throw new Error("Original source link is missing");
        if (owners.all(source, nextPath).length ||
          aliasOwners.all(source, nextPath).some((item) => item.work_id !== owner))
          throw new Error("The new source path already belongs to another title");
        const previous = aliasOf.get(owner, source, previousPath);
        if (previous && previous.new_path !== nextPath)
          throw new Error("A conflicting redirect is already recorded");
        db.prepare("UPDATE comic_work_sources SET manga_id = ? WHERE work_id = ? AND kind = 'ext' AND source_id = ? AND manga_id = ?")
          .run(nextPath, owner, source, previousPath);
        // Preserve local work-id provenance and its synced series_key, even
        // when the provider has renamed this URL. The alias resolves access
        // while the old key continues to identify the user's saved title.
        db.prepare(`INSERT INTO comic_ext_manga_aliases
          (work_id, source_id, old_path, new_path, proof, verified_at) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(work_id, source_id, old_path) DO UPDATE SET
          new_path = excluded.new_path, proof = excluded.proof, verified_at = excluded.verified_at`)
          .run(owner, source, previousPath, nextPath, String(proof).slice(0, 160), now());
        db.exec("RELEASE comic_manga_relink");
        return this.list(owner);
      } catch (error) {
        db.exec("ROLLBACK TO comic_manga_relink");
        db.exec("RELEASE comic_manga_relink");
        throw error;
      }
    },
    link(workId, { kind, sourceId = "", mangaId, name = "", title = "", lang = "" }) {
      if (!KINDS.has(kind)) throw new Error("Unknown source type");
      const manga = String(mangaId || "");
      if (!/^-?\d{1,20}$/.test(String(sourceId))) throw new Error("Invalid source");
      if (!validSitePath(manga)) throw new Error("Invalid source title");
      if (!isSyncableComicLink(String(workId), String(sourceId), manga))
        throw new Error("Source path cannot be synced; no link was saved");
      insert.run(String(workId), kind, String(sourceId), manga, String(name).slice(0, 80) || kind, String(title).slice(0, 200), String(lang).slice(0, 10), now());
      return this.list(workId);
    },
    unlink(workId, key) {
      const [kind, sourceId, ...rest] = String(key || "").split(":");
      return remove.run(String(workId), kind, sourceId, rest.join(":")).changes > 0;
    },
    // Entries saved by LVL's old engines in their own path form: the form
    // the extension uses now. rewrites: theme -> (path) => path. Returns how many changed.
    migrateLegacy(rewrites) {
      let rows;
      try {
        rows = db.prepare(`SELECT w.work_id, w.kind, w.source_id, w.manga_id, p.theme FROM comic_work_sources w
          JOIN comic_ext_sources s ON s.source_id = w.source_id JOIN comic_ext_packages p ON p.pkg = s.pkg WHERE w.kind = 'ext'`).all();
      } catch { return 0; } // the extension tables aren't there yet
      const move = db.prepare("UPDATE OR IGNORE comic_work_sources SET manga_id = ? WHERE work_id = ? AND kind = ? AND source_id = ? AND manga_id = ?");
      let changed = 0;
      for (const row of rows) {
        const next = rewrites[row.theme]?.(row.manga_id);
        if (next && next !== row.manga_id && validSitePath(next)
          && isSyncableComicLink(row.work_id, row.source_id, next))
          changed += move.run(next, row.work_id, row.kind, row.source_id, row.manga_id).changes;
      }
      return changed;
    },
  };
}

// Candidates for one chapter number across local files and chosen sources.
// chapterLists: [{ link, chapters: [{ id, chapter, volume, language, group, externalUrl, title }] }]
export function chapterCandidates({ chapter, volume = null, files = [], chapterLists = [] }) {
  const wanted = normalizeUnitNumber(chapter);
  const requestedVolume = normalizeUnitNumber(volume);
  const out = [];
  for (const file of files) {
    const inRange = (from, to, value) => from && Number(value) >= Number(from) && Number(value) <= Number(to || from);
    // A file explicitly belonging to V1 cannot satisfy V2C1 even when its
    // chapter number matches. Unlabelled files retain the legacy fallback.
    const fileVolumeMatches = !requestedVolume || !file.volume || inRange(file.volume, file.volumeEnd, requestedVolume);
    const hit = fileVolumeMatches && (file.chapter ? inRange(file.chapter, file.chapterEnd, wanted)
      : requestedVolume && inRange(file.volume, file.volumeEnd, requestedVolume));
    if (hit) out.push({ readerId: file.id, kind: "local", sourceId: "local", name: file.name, detail: file.chapter ? "" : `Volume ${file.volume}`, lang: "", page: file.progress && !file.progress.finished ? file.progress.page : 0 });
  }
  for (const { link, chapters } of chapterLists) {
    const matches = chapters.filter((item) => normalizeUnitNumber(item.chapter) === wanted && !item.externalUrl);
    const exact = requestedVolume ? matches.filter((item) => normalizeUnitNumber(item.volume) === requestedVolume) : [];
    // No silent fallback from V2C1 to V1C1. Unlabelled chapters are usable
    // only when the source supplies no competing, explicitly-labelled volume.
    const chosen = !requestedVolume ? matches : exact.length ? exact
      : matches.every((item) => !normalizeUnitNumber(item.volume)) ? matches : [];
    for (const item of chosen) {
      out.push({ readerId: item.id, kind: link.kind, sourceId: link.sourceId, name: link.name, detail: [item.group, item.title].filter(Boolean).join(" · "), lang: item.language || link.lang || "", page: 0 });
    }
  }
  return out;
}

// Which index chapters each chosen source has, for availability marks.
export function availability(chapterLists) {
  const counts = {};
  for (const { chapters } of chapterLists) {
    const seen = new Set();
    for (const item of chapters) {
      const key = normalizeUnitNumber(item.chapter);
      if (!key || item.externalUrl || seen.has(key)) continue;
      seen.add(key);
      counts[key] = (counts[key] || 0) + 1;
    }
  }
  return counts;
}

// Volume-aware counts accompany the legacy chapter-number counts while older
// clients still consume the former. The current UI must use the exact key for
// a repeated number, never inherit the combined count from another volume.
export function availabilityByUnit(chapterLists) {
  const counts = {};
  for (const { chapters } of chapterLists) {
    const seen = new Set();
    for (const item of chapters) {
      const key = unitKey(item);
      if (!key || item.externalUrl || seen.has(key)) continue;
      seen.add(key);
      counts[key] = (counts[key] || 0) + 1;
    }
  }
  return counts;
}

// A source's chapter name without the number it already shows ("Vol.06 Ch.048 - Ki" -> "Ki").
export function sourceChapterTitle(name) {
  const text = String(name || "").replace(/\s+/g, " ").trim();
  const rest = text.replace(/^(?:vol(?:ume)?\.?\s*\d+(?:\.\d+)?\s*[,:-]?\s*)?(?:ch(?:apter)?\.?|cap[ií]tulo|cap\.?|episode|ep\.?|#)\s*\d+(?:[.-]\d+)?\s*(?:[:\-–—]\s*)?/i, "").trim();
  return rest === text && /^\d+(?:\.\d+)?$/.test(text) ? "" : rest.slice(0, 160);
}

// The chosen sources' chapters, one per volume/number (first title wins):
// the list shows those the chapter index doesn't have (a manga with no index, or newer chapters).
export function sourceChapters(chapterLists, { limit = 3000 } = {}) {
  const byUnit = new Map();
  for (const { chapters } of chapterLists) {
    for (const item of chapters) {
      const chapter = normalizeUnitNumber(item.chapter);
      if (!chapter || item.externalUrl) continue;
      const volume = normalizeUnitNumber(item.volume);
      const key = unitKey({ volume, chapter });
      const title = sourceChapterTitle(item.title);
      const known = byUnit.get(key);
      if (!known) byUnit.set(key, { chapter, volume, title });
      else if (!known.title && title) known.title = title;
    }
  }
  // For the transient display list alone, an unlabelled title can decorate
  // the only known volume for that number. With two labelled volumes it stays
  // unassigned; no saved progress or reader ID is rekeyed.
  for (const [key, entry] of byUnit) {
    if (entry.volume !== null) continue;
    const labelled = [...byUnit.values()].filter((other) => other.chapter === entry.chapter && other.volume !== null);
    if (labelled.length !== 1) continue;
    if (!labelled[0].title && entry.title) labelled[0].title = entry.title;
    byUnit.delete(key);
  }
  return [...byUnit.values()].sort((a, b) => Number(a.chapter) - Number(b.chapter)
    || (a.volume === null ? 1 : 0) - (b.volume === null ? 1 : 0)
    || Number(a.volume ?? 0) - Number(b.volume ?? 0)).slice(0, limit);
}
