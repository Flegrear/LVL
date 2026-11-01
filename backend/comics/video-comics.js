// Comics on video title pages.
// A series or movie with no manga (Spider-Man, Avatar: The Last Airbender) gets a
// Comics section. Its comics come from the chosen sources: a comic is a title
// with no files (a "local-" id) whose pages come from the sources linked to it.
//
// - Each video page starts with a draft named after the video; the sources are
//   searched by that name. The first source added makes the draft a comic: it
//   takes the entry's title and cover, and remembers the page it was added on.
// - A comic shows on the page it was added on, on pages it was added to (an entry
//   already used by a comic links that comic instead of making a second one), and on
//   related videos: their titles share a name of two words or more ("Spider-Man"
//   and "The Amazing Spider-Man"; "Avatar" alone doesn't relate to the 2009 film).
// - "Hide here" hides a comic on one page only.
// - From the Library a comic opens the page it was added on with Comics open.
import { localIdFor } from "../reader/local-library.js";
import { normalizeSeriesName } from "../../shared/reading/release-name.js";
import { WORK_ID } from "../../shared/reading/ids.js";

export const VIDEO_ID = /^tt\d{5,12}$/;
export const VIDEO_TYPES = Object.freeze(["series", "movie"]);
export const NOT_IN_LIBRARY = "NONE";
const SOURCE_KEY = /^video:(tt\d{5,12})#\d{1,4}$/;
const NAME_STOP = new Set(["the", "a", "an", "of", "and"]);

const words = (title) => normalizeSeriesName(title).split(" ").filter(Boolean);
const significant = (list) => list.filter((word) => !NAME_STOP.has(word) && !/^\d+$/.test(word));

// Two video titles are related when the shorter one's words appear, in order and
// together, in the longer one, and that name has at least two real words.
export function relatedVideoTitles(a, b) {
  let short = words(a);
  let long = words(b);
  if (!short.length || !long.length) return false;
  if (short.length > long.length) [short, long] = [long, short];
  while (short.length && NAME_STOP.has(short[0])) short = short.slice(1);
  if (significant(short).length < 2) return false;
  for (let at = 0; at + short.length <= long.length; at += 1) {
    if (short.every((word, offset) => long[at + offset] === word)) return true;
  }
  return false;
}

export function createVideoComics({ db, now = Date.now, local, linked }) {
  db.exec(`CREATE TABLE IF NOT EXISTS comic_video_links (work_id TEXT NOT NULL, video_id TEXT NOT NULL, video_type TEXT NOT NULL, video_title TEXT NOT NULL,
      origin INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0, added_at INTEGER NOT NULL, PRIMARY KEY (work_id, video_id));
    CREATE TABLE IF NOT EXISTS comic_source_titles (work_id TEXT PRIMARY KEY, video_id TEXT NOT NULL, cover_url TEXT NOT NULL DEFAULT '', cover_source TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL)`);
  const q = {
    linksOf: db.prepare("SELECT * FROM comic_video_links WHERE video_id = ?"),
    origins: db.prepare("SELECT * FROM comic_video_links WHERE origin = 1"),
    originOf: db.prepare("SELECT * FROM comic_video_links WHERE work_id = ? AND origin = 1"),
    link: db.prepare(`INSERT INTO comic_video_links (work_id, video_id, video_type, video_title, origin, hidden, added_at) VALUES (?, ?, ?, ?, ?, 0, ?)
      ON CONFLICT(work_id, video_id) DO UPDATE SET hidden = 0, video_title = excluded.video_title, origin = MAX(comic_video_links.origin, excluded.origin)`),
    hide: db.prepare(`INSERT INTO comic_video_links (work_id, video_id, video_type, video_title, origin, hidden, added_at) VALUES (?, ?, ?, ?, 0, ?, ?)
      ON CONFLICT(work_id, video_id) DO UPDATE SET hidden = excluded.hidden`),
    showAll: db.prepare("UPDATE comic_video_links SET hidden = 0 WHERE video_id = ?"),
    titlesOf: db.prepare("SELECT * FROM comic_source_titles WHERE video_id = ? ORDER BY created_at"),
    title: db.prepare("SELECT * FROM comic_source_titles WHERE work_id = ?"),
    addTitle: db.prepare("INSERT OR IGNORE INTO comic_source_titles (work_id, video_id, created_at) VALUES (?, ?, ?)"),
    cover: db.prepare("UPDATE comic_source_titles SET cover_url = ?, cover_source = ? WHERE work_id = ?"),
    usedBy: db.prepare("SELECT DISTINCT work_id FROM comic_work_sources WHERE kind = ? AND source_id = ? AND manga_id = ?"),
  };
  const sourceCount = (workId) => linked.list(workId).length;
  const isSourceTitle = (workId) => Boolean(q.title.get(String(workId)));

  // The page's draft: a source title for this video with no sources yet (made when asked).
  function draftFor(video, { create = false } = {}) {
    const existing = q.titlesOf.all(video.id).find((row) => !sourceCount(row.work_id));
    if (existing) return existing.work_id;
    if (!create) return null;
    for (let n = q.titlesOf.all(video.id).length + 1; n < 10_000; n += 1) {
      const seriesKey = `video:${video.id}#${n}`;
      const id = localIdFor(seriesKey);
      if (local.localTitle(id)) continue;
      local.createTitle({ id, title: video.title, seriesKey, status: NOT_IN_LIBRARY });
      q.addTitle.run(id, video.id, now());
      q.link.run(id, video.id, video.type, video.title, 1, now());
      return id;
    }
    return null;
  }

  // Comics for a video page: [{ workId, here, hidden, origin: { id, type, title } }], drafts left out.
  function comicsFor(video) {
    const rows = new Map();
    for (const row of q.linksOf.all(video.id)) rows.set(row.work_id, { workId: row.work_id, here: true, hidden: Boolean(row.hidden), addedAt: row.added_at });
    for (const row of q.origins.all()) {
      if (row.video_id === video.id || rows.has(row.work_id) || !relatedVideoTitles(row.video_title, video.title)) continue;
      rows.set(row.work_id, { workId: row.work_id, here: false, hidden: false, addedAt: row.added_at });
    }
    return [...rows.values()].filter((item) => sourceCount(item.workId) || !isSourceTitle(item.workId))
      .map((item) => ({ ...item, origin: originOf(item.workId) }))
      .sort((a, b) => Number(b.origin?.id === video.id) - Number(a.origin?.id === video.id) || a.addedAt - b.addedAt);
  }

  function originOf(workId) {
    const row = q.originOf.get(String(workId));
    return row ? { id: row.video_id, type: row.video_type, title: row.video_title } : null;
  }

  // Before a source is added to workId: an entry another comic already uses joins that
  // comic to the draft's page instead of making a second comic. Returns the comic to use.
  function linkTarget(workId, choice) {
    const draft = q.title.get(String(workId));
    if (!draft || sourceCount(workId)) return workId;
    const owner = q.usedBy.all(String(choice?.kind || ""), String(choice?.sourceId || ""), String(choice?.mangaId || "")).map((row) => row.work_id).find((id) => id !== workId);
    if (!owner) return workId;
    const origin = originOf(workId);
    if (origin) q.link.run(owner, origin.id, origin.type, origin.title, 0, now());
    return owner;
  }

  // After the first source is added to a draft: it takes the entry's title and cover.
  function linkedFirst(workId, choice, cover) {
    if (!isSourceTitle(workId) || sourceCount(workId) !== 1) return;
    if (choice?.title) local.renameTitle(workId, String(choice.title));
    if (cover?.url) q.cover.run(cover.url, cover.sourceId || "", workId);
  }

  return {
    draftFor, comicsFor, originOf, linkTarget, linkedFirst, isSourceTitle,
    sourceTitle: (workId) => q.title.get(String(workId)) || null,
    hide(workId, video, hidden = true) { q.hide.run(String(workId), video.id, video.type, video.title, hidden ? 1 : 0, now()); },
    showAll: (videoId) => q.showAll.run(String(videoId)).changes,
    // The source titles in the Library (a status was set or reading started) with at least one source.
    libraryRows: () => local.localTitles().filter((row) => SOURCE_KEY.test(row.series_key) && row.status !== NOT_IN_LIBRARY && isSourceTitle(row.id) && sourceCount(row.id)),
  };
}

// GET  /api/comics/video/<tt id>?type=series|movie&title=…[&draft=1|0]   the page's comics and its draft
// POST /api/comics/video/<tt id>/hide?type=&title=   { workId, hidden } or { all: true }
// deps: { ctx, videoComics, workInfo(workId) -> { comic } }
export async function handleVideoRoutes(req, res, url, { ctx, videoComics, workInfo }) {
  const route = /^\/api\/comics\/video\/(tt\d{5,12})(\/hide)?$/.exec(url.pathname);
  if (!route) return false;
  const type = VIDEO_TYPES.includes(url.searchParams.get("type")) ? url.searchParams.get("type") : "series";
  const title = String(url.searchParams.get("title") || "").replace(/\s+/g, " ").trim().slice(0, 200);
  if (!VIDEO_ID.test(route[1]) || !title) return ctx.json(res, 400, { error: "A video id and title are needed" }), true;
  const video = { id: route[1], type, title };
  if (route[2]) {
    if (req.method !== "POST") return ctx.methodNotAllowed(res, ["POST"]), true;
    let body;
    try { body = await ctx.readJsonBody(req, 2048); } catch { return ctx.json(res, 400, { error: "Invalid JSON body" }), true; }
    if (body?.all === true) videoComics.showAll(video.id);
    else if (WORK_ID.test(String(body?.workId || ""))) videoComics.hide(body.workId, video, body.hidden !== false);
    else return ctx.json(res, 400, { error: "Which comic?" }), true;
  } else if (req.method !== "GET") return ctx.methodNotAllowed(res, ["GET"]), true;
  const all = videoComics.comicsFor(video);
  const shown = [];
  for (const item of all.filter((entry) => !entry.hidden)) {
    const info = await workInfo(item.workId).catch(() => null);
    if (info?.comic) shown.push({ id: item.workId, title: info.comic.title, cover: info.comic.cover || "", here: item.here, origin: item.origin });
  }
  // A page with no comics gets its draft on a plain GET; draft=1 asks for a new one, draft=0 never makes one.
  const draft = videoComics.draftFor(video, { create: url.searchParams.get("draft") === "1" || (req.method === "GET" && !shown.length && url.searchParams.get("draft") !== "0") });
  return ctx.json(res, 200, { comics: shown, hidden: all.filter((entry) => entry.hidden).length, draft }), true;
}
