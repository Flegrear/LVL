// Sources chosen for a comic. The chapter list on the comic page is
// the index; a source only supplies pages. Opening a chapter asks which chosen
// sources (and local files) have it: one opens straight away, several let the
// user pick. Source chapter lists are fetched once per source and cached.
import { normalizeUnitNumber } from "../../shared/reading/units.js";
import { validSitePath } from "./ext-sources.js";

// "ext": a source from an extension repository; manga_id is the manga's path on the site.
const KINDS = new Set(["ext"]);

export function createLinkedSources({ db, now = Date.now } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS comic_work_sources (work_id TEXT NOT NULL, kind TEXT NOT NULL, source_id TEXT NOT NULL, manga_id TEXT NOT NULL,
    name TEXT NOT NULL, title TEXT NOT NULL, lang TEXT NOT NULL DEFAULT '', added_at INTEGER NOT NULL, PRIMARY KEY (work_id, kind, source_id, manga_id))`);
  const list = db.prepare("SELECT * FROM comic_work_sources WHERE work_id = ? ORDER BY added_at");
  const owners = db.prepare("SELECT work_id FROM comic_work_sources WHERE kind = 'ext' AND source_id = ? AND manga_id = ? ORDER BY added_at");
  const insert = db.prepare(`INSERT INTO comic_work_sources (work_id, kind, source_id, manga_id, name, title, lang, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(work_id, kind, source_id, manga_id) DO UPDATE SET name = excluded.name, title = excluded.title, lang = excluded.lang`);
  const remove = db.prepare("DELETE FROM comic_work_sources WHERE work_id = ? AND kind = ? AND source_id = ? AND manga_id = ?");
  const view = (row) => ({ key: `${row.kind}:${row.source_id}:${row.manga_id}`, kind: row.kind, sourceId: row.source_id, mangaId: row.manga_id, name: row.name, title: row.title, lang: row.lang, addedAt: row.added_at });
  return {
    list: (workId) => list.all(String(workId)).filter((row) => KINDS.has(row.kind)).map(view),
    owners: (sourceId, mangaId) => owners.all(String(sourceId), String(mangaId)).map((row) => row.work_id),
    link(workId, { kind, sourceId = "", mangaId, name = "", title = "", lang = "" }) {
      if (!KINDS.has(kind)) throw new Error("Unknown source type");
      const manga = String(mangaId || "");
      if (!/^-?\d{1,20}$/.test(String(sourceId))) throw new Error("Invalid source");
      if (!validSitePath(manga)) throw new Error("Invalid source title");
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
        if (next && next !== row.manga_id && validSitePath(next)) changed += move.run(next, row.work_id, row.kind, row.source_id, row.manga_id).changes;
      }
      return changed;
    },
  };
}

// Candidates for one chapter number across local files and chosen sources.
// chapterLists: [{ link, chapters: [{ id, chapter, volume, language, group, externalUrl, title }] }]
export function chapterCandidates({ chapter, volume = null, files = [], chapterLists = [] }) {
  const wanted = normalizeUnitNumber(chapter);
  const out = [];
  for (const file of files) {
    const inRange = (from, to, value) => from && Number(value) >= Number(from) && Number(value) <= Number(to || from);
    const hit = file.chapter ? inRange(file.chapter, file.chapterEnd, wanted) : volume && inRange(file.volume, file.volumeEnd, volume);
    if (hit) out.push({ readerId: file.id, kind: "local", name: file.name, detail: file.chapter ? "" : `Volume ${file.volume}`, lang: "", page: file.progress && !file.progress.finished ? file.progress.page : 0 });
  }
  for (const { link, chapters } of chapterLists) {
    const matches = chapters.filter((item) => normalizeUnitNumber(item.chapter) === wanted && !item.externalUrl);
    const requestedVolume = normalizeUnitNumber(volume);
    const exact = requestedVolume ? matches.filter((item) => normalizeUnitNumber(item.volume) === requestedVolume) : [];
    // When the source genuinely distinguishes two identical chapter numbers
    // by volume, prefer the selected volume. Unlabelled candidates remain
    // usable, and if no exact volume exists we retain the old fallback.
    const chosen = exact.length
      ? matches.filter((item) => !normalizeUnitNumber(item.volume) || normalizeUnitNumber(item.volume) === requestedVolume)
      : matches;
    for (const item of chosen) {
      out.push({ readerId: item.id, kind: link.kind, name: link.name, detail: [item.group, item.title].filter(Boolean).join(" · "), lang: item.language || link.lang || "", page: 0 });
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

// A source's chapter name without the number it already shows ("Vol.06 Ch.048 - Ki" -> "Ki").
export function sourceChapterTitle(name) {
  const text = String(name || "").replace(/\s+/g, " ").trim();
  const rest = text.replace(/^(?:vol(?:ume)?\.?\s*\d+(?:\.\d+)?\s*[,:-]?\s*)?(?:ch(?:apter)?\.?|cap[ií]tulo|cap\.?|episode|ep\.?|#)\s*\d+(?:[.-]\d+)?\s*(?:[:\-–—]\s*)?/i, "").trim();
  return rest === text && /^\d+(?:\.\d+)?$/.test(text) ? "" : rest.slice(0, 160);
}

// The chosen sources' chapters, one per number (the first source with a title wins):
// the list shows those the chapter index doesn't have (a manga with no index, or newer chapters).
export function sourceChapters(chapterLists, { limit = 3000 } = {}) {
  const byNumber = new Map();
  for (const { chapters } of chapterLists) {
    for (const item of chapters) {
      const chapter = normalizeUnitNumber(item.chapter);
      if (!chapter || item.externalUrl) continue;
      const title = sourceChapterTitle(item.title);
      const known = byNumber.get(chapter);
      if (!known) byNumber.set(chapter, { chapter, volume: normalizeUnitNumber(item.volume) || null, title });
      else { if (!known.title && title) known.title = title; if (!known.volume && item.volume) known.volume = normalizeUnitNumber(item.volume) || null; }
    }
  }
  return [...byNumber.values()].sort((a, b) => Number(a.chapter) - Number(b.chapter)).slice(0, limit);
}
