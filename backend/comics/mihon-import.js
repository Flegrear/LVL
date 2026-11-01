// Import from Mihon or Tachiyomi (Settings › Comics): the backup's library joins Library ›
// Comics with its sources and reading progress. Nothing is written to AniList or Mihon.
// - A comic is matched to its AniList work by the backup's AniList tracking, else its
//   MyAnimeList tracking, else an exact title match. Others join as comics read from
//   their source (like a comic made from a source on a video page).
// - Status: the tracker's, else from the chapters read. An LVL entry keeps its status
//   unless it is Planning.
// - Each comic's source becomes a source of the work, and a favorite source when one of
//   LVL's repositories has its extension (LVL runs the same extensions, so ids match).
// - Read chapters are marked read, a chapter in progress opens on its page; an import
//   never moves progress back. Importing the same file again adds nothing.
// Routes: POST /api/comics/import/mihon (the file's bytes) starts it; GET shows the step;
// POST …/apply imports what the preview showed; DELETE drops it.
import { IDS_QUERY, MAL_IDS_QUERY, normalizeComic, titleSearchQuery } from "./anilist-manga.js";
import { MAX_BACKUP_BYTES, backupError, readBackup } from "./mihon-backup.js";
import { toLvlPath } from "./runner-engine.js";
import { chapterNumber, volumeNumber } from "./chapter-names.js";
import { localIdFor } from "../reader/local-library.js";
import { normalizeSeriesName } from "../../shared/reading/release-name.js";
import { SOURCE_ID } from "../../shared/reading/ids.js";

// Mihon's tracker status numbers (AniList and MyAnimeList number them differently).
const ANILIST_STATUS = Object.freeze({ 1: "CURRENT", 2: "COMPLETED", 3: "PAUSED", 4: "DROPPED", 5: "PLANNING", 6: "REPEATING" });
const MAL_STATUS = Object.freeze({ 1: "CURRENT", 2: "COMPLETED", 3: "PAUSED", 4: "DROPPED", 6: "PLANNING", 7: "REPEATING" });
const MEDIA_ID = /^[1-9]\d{0,9}$/;
const COMIC_FORMATS = new Set(["MANGA", "ONE_SHOT"]);
const TITLES_PER_REQUEST = 6;
const chunks = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, n) => list.slice(n * size, n * size + size));
const httpCover = (value) => (/^https?:\/\/[^\s"'<>]{4,1500}$/.test(String(value || "")) ? String(value) : "");

// The backup's library: one entry per comic on a source, with what LVL uses.
export function libraryEntries(backup) {
  const seen = new Set();
  const entries = [];
  for (const manga of backup.manga) {
    if (!manga.favorite || manga.sourceId === "0" || !SOURCE_ID.test(manga.sourceId) || !manga.url) continue;
    const key = `${manga.sourceId}\n${manga.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const anilist = manga.tracking.find((track) => track.tracker === 2 && MEDIA_ID.test(track.mediaId));
    const mal = manga.tracking.find((track) => track.tracker === 1 && MEDIA_ID.test(track.mediaId));
    const lastRead = new Map(manga.history.filter((item) => item.url).map((item) => [item.url, item.lastRead]));
    const chapters = manga.chapters.filter((chapter) => chapter.url && (chapter.read || chapter.lastPageRead > 0)).map((chapter) => ({
      url: chapter.url, name: chapter.name, read: chapter.read, page: chapter.lastPageRead, number: chapter.number, at: lastRead.get(chapter.url) || 0 }));
    entries.push({
      key, sourceId: manga.sourceId, sourceName: String(backup.sources.get(manga.sourceId) || "").slice(0, 80), path: toLvlPath(manga.url),
      title: manga.title.trim().slice(0, 200) || "Untitled", cover: httpCover(manga.cover), anilistId: anilist ? Number(anilist.mediaId) : null,
      malId: mal ? Number(mal.mediaId) : null, status: ANILIST_STATUS[anilist?.status] || MAL_STATUS[mal?.status] || "", chapters,
      allRead: manga.chapters.length > 0 && manga.chapters.every((chapter) => chapter.read),
    });
  }
  return entries;
}

const comicOf = (media) => {
  const comic = normalizeComic(media, { adult: true });
  return comic && COMIC_FORMATS.has(media.format) ? { ...comic, adult: media.isAdult === true } : null;
};
// Exact titles, spacing aside: a source's "Ao Ashi" is AniList's "Aoashi".
const compact = (name) => normalizeSeriesName(name).replace(/\s+/g, "");
const sameTitle = (comic, title) => {
  const wanted = compact(title);
  return wanted.length >= 2 && [comic.title, ...(comic.aliases || [])].some((name) => compact(name) === wanted);
};

// entry key -> AniList comic, by AniList id, then MyAnimeList id, then exact title.
// query: the AniList client's query(text, variables) (it paces requests). A failed
// request stops the match: a half-matched import would turn AniList works into source comics.
export async function matchEntries(entries, { query, onProgress = () => {}, isCancelled = () => false } = {}) {
  const matches = new Map();
  const byId = [...new Set(entries.filter((entry) => entry.anilistId).map((entry) => entry.anilistId))];
  const byMal = [...new Set(entries.filter((entry) => !entry.anilistId && entry.malId).map((entry) => entry.malId))];
  let total = Math.ceil(byId.length / 50) + Math.ceil(byMal.length / 50) + Math.ceil(entries.length / TITLES_PER_REQUEST);
  let done = 0;
  const step = () => { done += 1; onProgress(done, total); };
  onProgress(0, total);
  for (const ids of chunks(byId, 50)) {
    if (isCancelled()) return matches;
    const found = new Map(((await query(IDS_QUERY, { ids }))?.Page?.media || []).map((media) => [media.id, comicOf(media)]));
    for (const entry of entries) if (entry.anilistId && found.get(entry.anilistId)) matches.set(entry.key, found.get(entry.anilistId));
    step();
  }
  for (const ids of chunks(byMal, 50)) {
    if (isCancelled()) return matches;
    const found = new Map(((await query(MAL_IDS_QUERY, { ids }))?.Page?.media || []).map((media) => [media.idMal, comicOf(media)]));
    for (const entry of entries) if (!matches.has(entry.key) && entry.malId && found.get(entry.malId)) matches.set(entry.key, found.get(entry.malId));
    step();
  }
  const left = entries.filter((entry) => !matches.has(entry.key));
  total = done + Math.ceil(left.length / TITLES_PER_REQUEST);
  for (const group of chunks(left, TITLES_PER_REQUEST)) {
    if (isCancelled()) return matches;
    const data = await query(titleSearchQuery(group.length), Object.fromEntries(group.map((entry, n) => [`q${n}`, entry.title.slice(0, 100)])));
    group.forEach((entry, n) => {
      const hit = (data?.[`t${n}`]?.media || []).map(comicOf).find((comic) => comic && sameTitle(comic, entry.title));
      if (hit) matches.set(entry.key, hit);
    });
    step();
  }
  return matches;
}

function importedStatus(entry, comic) {
  if (entry.status) return entry.status;
  if (!entry.chapters.some((chapter) => chapter.read)) return "PLANNING";
  return entry.allRead && comic?.status === "FINISHED" ? "COMPLETED" : "CURRENT";
}
const keepStatus = (existing, imported) => (existing && existing !== "PLANNING" && existing !== "NONE" ? existing : imported);
const chapterLabel = (chapter) => {
  const number = chapter.number > 0 ? Math.round(chapter.number * 100) / 100 : Number(chapterNumber(chapter.name));
  return Number.isFinite(number) && number > 0 && number < 100_000 ? String(number) : null;
};
const repoBase = (url) => {
  const value = String(url || "").trim().replace(/\/index(?:\.min)?\.json$/i, "").replace(/\/+$/, "");
  return /^https:\/\/[^\s"'<>]{4,300}$/.test(value) ? value : "";
};

// deps: { store, snapshot(comic), local, linked, ext, videoComics, extensions() -> [extension
//   with .repo], repositories() -> [url], showAdult(), now() }
const sourceIndex = (extensions) => {
  const index = new Map();
  for (const ext of extensions) for (const source of ext.sources || []) index.set(String(source.id), { ext, source });
  return index;
};

export async function previewImport(entries, matches, stores, deps) {
  const known = sourceIndex(await deps.extensions().catch(() => []));
  const adultHidden = !deps.showAdult();
  const out = { entries: entries.length, onAniList: 0, inLibrary: 0, fromSources: 0, adult: 0, read: 0, inProgress: 0, notMatched: [] };
  const found = new Map();
  const missing = new Map();
  for (const entry of entries) {
    const comic = matches.get(entry.key);
    if (comic?.adult && adultHidden) { out.adult += 1; continue; }
    if (comic) { out.onAniList += 1; if (deps.store.libraryGet(comic.anilistId)) out.inLibrary += 1; } else {
      out.fromSources += 1;
      if (out.notMatched.length < 12) out.notMatched.push(entry.title);
    }
    for (const chapter of entry.chapters) out[chapter.read ? "read" : "inProgress"] += 1;
    (known.has(entry.sourceId) ? found : missing).set(entry.sourceId, entry.sourceName || known.get(entry.sourceId)?.source.name || entry.sourceId);
  }
  const ours = new Set(deps.repositories().map(repoBase));
  const repositories = new Map();
  for (const store of stores) { const url = repoBase(store.url); if (url && !ours.has(url)) repositories.set(url, { url, name: String(store.name || "").slice(0, 80) }); }
  const newFavorites = [...found].filter(([id]) => !deps.ext.isFavorite(id)).map(([, name]) => name);
  return { ...out, sources: [...found.values()], newFavorites, missingSources: [...missing.values()], repositories: [...repositories.values()] };
}

export async function applyImport(entries, matches, deps) {
  const known = sourceIndex(await deps.extensions().catch(() => []));
  const counts = { comics: 0, newInLibrary: 0, fromSources: 0, adultSkipped: 0, favorites: 0, read: 0, inProgress: 0, unreadable: 0 };
  for (const entry of entries) {
    const comic = matches.get(entry.key);
    if (comic?.adult && !deps.showAdult()) { counts.adultSkipped += 1; continue; }
    let workId;
    if (comic) {
      workId = `anilist-${comic.anilistId}`;
      const existing = deps.store.libraryGet(comic.anilistId);
      if (!existing) counts.newInLibrary += 1;
      deps.store.librarySet(comic.anilistId, keepStatus(existing?.status, importedStatus(entry, comic)), deps.snapshot(comic));
    } else {
      const seriesKey = `mihon:${entry.sourceId}:${entry.path}`.slice(0, 300);
      workId = localIdFor(seriesKey);
      const existing = deps.local.localTitle(workId);
      deps.local.createTitle({ id: workId, title: entry.title, seriesKey, status: importedStatus(entry, null) });
      if (existing && keepStatus(existing.status, importedStatus(entry, null)) !== existing.status) deps.local.setLocalStatus(workId, importedStatus(entry, null));
      deps.videoComics.importTitle(workId, { cover: entry.cover, sourceId: entry.sourceId });
      counts.fromSources += 1;
    }
    counts.comics += 1;
    const found = known.get(entry.sourceId);
    try {
      deps.linked.link(workId, { kind: "ext", sourceId: entry.sourceId, mangaId: entry.path, name: entry.sourceName || found?.source.name || found?.ext.name || "Source",
        title: entry.title, lang: found?.source.lang || "" });
    } catch { counts.unreadable += 1; }
    if (found && !deps.ext.isFavorite(entry.sourceId)) {
      try { deps.ext.add(found.ext, found.source, found.ext.repo || ""); counts.favorites += 1; } catch { /* a source without an address stays out */ }
    }
    for (const chapter of entry.chapters) {
      const saved = deps.local.importRemoteProgress({
        id: deps.ext.chapterId(entry.sourceId, toLvlPath(chapter.url)), workId, keepFurther: true,
        page: chapter.read ? 0 : chapter.page, pages: chapter.read ? 1 : chapter.page + 1, finished: chapter.read,
        chapter: chapterLabel(chapter), volume: volumeNumber(chapter.name), at: chapter.at || deps.now(),
      });
      if (saved?.saved) counts[chapter.read ? "read" : "inProgress"] += 1;
    }
  }
  return counts;
}

// Reads a request body as bytes, up to max (a larger one is drained, then refused).
function readBytes(req, max) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    req.on("data", (chunk) => { size += chunk.length; if (size <= max) parts.push(chunk); });
    req.on("end", () => (size > max ? reject(backupError("The backup is larger than 50 MB", 413)) : resolve(Buffer.concat(parts))));
    req.on("error", reject);
  });
}

// One import at a time, kept in memory until it's imported or dropped.
export function createMihonImport(deps) {
  let job = null;
  const view = () => (job ? { state: job.state, file: job.file, progress: job.progress, preview: job.preview, result: job.result, error: job.error } : { state: "none" });
  async function start(bytes, file = "") {
    if (job && ["matching", "importing"].includes(job.state)) throw Object.assign(new Error("An import is already running"), { status: 409 });
    const backup = readBackup(bytes);
    const entries = libraryEntries(backup);
    if (!entries.length) throw backupError("The backup's library is empty");
    const mine = { state: "matching", file: String(file).slice(0, 120), progress: { done: 0, total: 1 }, entries, matches: null, preview: null, result: null, error: "" };
    job = mine;
    void (async () => {
      try {
        const matches = await matchEntries(entries, { query: deps.query, onProgress: (done, total) => { mine.progress = { done, total }; }, isCancelled: () => job !== mine });
        if (job !== mine) return;
        mine.matches = matches;
        mine.preview = await previewImport(entries, matches, backup.stores, deps);
        mine.state = "ready";
      } catch (error) {
        if (job !== mine) return;
        mine.state = "error";
        mine.error = /AniList|fetch|network|timed? ?out|abort/i.test(String(error?.message)) ? "AniList didn't answer. Try again in a few minutes." : String(error?.message || error).slice(0, 200);
      }
    })();
    return view();
  }
  async function apply() {
    const mine = job;
    if (mine?.state !== "ready") throw Object.assign(new Error("Choose a backup first"), { status: 409 });
    mine.state = "importing";
    try { mine.result = await applyImport(mine.entries, mine.matches, deps); mine.state = "done"; } catch (error) { mine.state = "error"; mine.error = String(error?.message || error).slice(0, 200); }
    mine.entries = [];
    mine.matches = null;
    return view();
  }
  const cancel = () => { job = null; return view(); };
  return {
    view, start, apply, cancel,
    async handle(req, res, path, ctx) {
      try {
        if (path === "/api/comics/import/mihon/apply") {
          if (req.method !== "POST") return ctx.methodNotAllowed(res, ["POST"]);
          return ctx.json(res, 200, await apply());
        }
        if (req.method === "GET") return ctx.json(res, 200, view());
        if (req.method === "DELETE") return ctx.json(res, 200, cancel());
        if (req.method !== "POST") return ctx.methodNotAllowed(res, ["GET", "POST", "DELETE"]);
        let name = "";
        try { name = decodeURIComponent(String(req.headers["x-file-name"] || "")); } catch {}
        return ctx.json(res, 200, await start(await readBytes(req, MAX_BACKUP_BYTES), name));
      } catch (error) {
        return ctx.json(res, Number(error.status) || 500, { error: String(error.message || error).slice(0, 300) });
      }
    },
  };
}
