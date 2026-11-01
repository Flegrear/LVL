// LVL's own data as sync records (shared/sync/records.js), and incoming changes applied to it.
// - Library (the app-state "library" section): video.title, video.progress, video.watched.
//   Changes are written with the section's revision check, like another LVL window's edit.
// - LVL ratings (rec_ratings, source "app"): rating.lvl, through the ratings store.
// - Comics library (comic_library): comic.library.
// An incoming change older than the same item here (by the item's own time) isn't applied:
// the next export sends the newer local value instead. This keeps the newest data the first
// time two devices with their own data meet.
import { joinId, splitId } from "../../shared/sync/records.js";
import { parseStamp } from "../../shared/sync/clock.js";

const TITLE_FIELDS = ["title", "displayTitle", "seriesKey", "magnet", "coverUrl", "catalogId", "catalogType", "aliases", "sourceMeta", "addedAt"];
const HASH_ID = /^[0-9a-f]{40}$/;
const present = (value) => value !== undefined && value !== null && value !== "";
const pick = (object, keys) => Object.fromEntries(keys.filter((key) => present(object?.[key])).map((key) => [key, object[key]]));
const episodeMeta = ({ progress, ...rest } = {}) => rest;
const stampMs = (change) => parseStamp(change.at)?.ms || 0;

export function createLocalData({ appState, db, recs }) {
  const types = ["video.title", "video.progress", "video.watched", "rating.lvl", "comic.library"];
  const tableExists = (name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));

  function exportLibrary(out) {
    for (const entry of appState.readSection("library") || []) {
      const id = String(entry?.id || "").toLowerCase();
      if (!HASH_ID.test(id)) continue;
      out.push({ type: "video.title", id, value: { ...pick(entry, TITLE_FIELDS), episodes: (entry.episodes || []).map(episodeMeta) } });
      for (const episode of entry.episodes || []) {
        const index = Number(episode?.fileIndex);
        if (!episode?.progress || !Number.isInteger(index) || index < 0) continue;
        out.push({ type: "video.progress", id: `${id}/${index}`, value: {
          positionMs: Math.max(0, Math.round(Number(episode.progress.positionMs) || 0)),
          durationMs: Math.max(0, Math.round(Number(episode.progress.durationMs) || 0)),
          finished: Boolean(episode.progress.finished) } });
      }
      for (const [code, watched] of Object.entries(entry.watchedChapters || {}))
        if (typeof watched === "boolean") out.push({ type: "video.watched", id: joinId(id, code), value: { watched } });
    }
  }

  function exportRatings(out) {
    if (!tableExists("rec_ratings")) return;
    for (const row of db.prepare("SELECT * FROM rec_ratings WHERE source = 'app'").all()) {
      out.push({ type: "rating.lvl", id: row.rating_key, value: pick({
        catalogId: row.catalog_id, seriesKey: row.series_key, season: row.season, title: row.title, kind: row.kind,
        year: row.year, score: row.score, status: row.status }, ["catalogId", "seriesKey", "season", "title", "kind", "year", "score", "status"]) });
    }
  }

  function exportComics(out) {
    if (!tableExists("comic_library")) return;
    for (const row of db.prepare("SELECT anilist_id, status, work_json FROM comic_library").all()) {
      let work = {};
      try { work = JSON.parse(row.work_json || "{}") || {}; } catch {}
      out.push({ type: "comic.library", id: `anilist-${row.anilist_id}`, value: pick({ status: row.status, title: work.title, work }, ["status", "title", "work"]) });
    }
  }

  // Library changes in one revision-checked write (tried again if a window saved meanwhile).
  function applyLibrary(changes, done) {
    const order = { "video.title": 0, "video.progress": 1, "video.watched": 2 };
    const sorted = [...changes].sort((a, b) => order[a.type] - order[b.type]);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const expected = appState.sectionUpdatedAt("library");
      const library = structuredClone(appState.readSection("library") || []);
      const byId = new Map(library.map((entry) => [String(entry?.id || "").toLowerCase(), entry]));
      const appliedNow = [];
      for (const change of sorted) {
        const at = stampMs(change);
        if (change.type === "video.title") {
          const entry = byId.get(change.id);
          if (change.value === null) {
            if (entry) library.splice(library.indexOf(entry), 1);
            byId.delete(change.id);
            appliedNow.push(change);
            continue;
          }
          if (entry && Number(entry.updatedAt || entry.addedAt || 0) > at) continue;
          const episodes = Array.isArray(change.value.episodes) ? change.value.episodes : null;
          if (!entry) {
            const created = { id: change.id, ...pick(change.value, TITLE_FIELDS), episodes: episodes || [], addedAt: change.value.addedAt || at, updatedAt: at };
            library.push(created);
            byId.set(change.id, created);
          } else {
            const progress = new Map((entry.episodes || []).map((episode) => [Number(episode.fileIndex), episode.progress]));
            Object.assign(entry, pick(change.value, TITLE_FIELDS));
            if (episodes) entry.episodes = episodes.map((episode) => (progress.get(Number(episode.fileIndex)) ? { ...episode, progress: progress.get(Number(episode.fileIndex)) } : { ...episode }));
          }
          appliedNow.push(change);
        } else if (change.type === "video.progress") {
          const [id, index] = change.id.split("/");
          const entry = byId.get(id);
          if (!entry) continue;
          entry.episodes = Array.isArray(entry.episodes) ? entry.episodes : [];
          let episode = entry.episodes.find((item) => Number(item.fileIndex) === Number(index));
          if (!episode) { episode = { fileIndex: Number(index) }; entry.episodes.push(episode); }
          if (Number(episode.progress?.updatedAt || 0) > at) continue;
          if (change.value === null) delete episode.progress;
          else {
            episode.progress = { positionMs: change.value.positionMs || 0, durationMs: change.value.durationMs || 0, finished: Boolean(change.value.finished), updatedAt: at };
            if (at >= Number(entry.lastPlayedAt || 0)) { entry.lastPlayedAt = at; entry.lastPlayedFileIndex = Number(index); }
          }
          appliedNow.push(change);
        } else if (change.type === "video.watched") {
          const [id, code] = splitId(change.id);
          const entry = byId.get(id);
          if (!entry || !code) continue;
          const marks = { ...(entry.watchedChapters || {}) };
          if (change.value === null) delete marks[code];
          else marks[code] = Boolean(change.value.watched);
          entry.watchedChapters = marks;
          appliedNow.push(change);
        }
      }
      if (!appliedNow.length) return;
      const result = appState.compareAndSwapSection("library", library, expected);
      if (result.ok) { for (const change of appliedNow) done.add(change); return; }
    }
    throw new Error("The Library kept changing while sync applied changes; it tries again on the next sync");
  }

  function applyRating(change, previous, done) {
    const value = change.value || previous?.value || {};
    const existing = db.prepare("SELECT updated_at FROM rec_ratings WHERE rating_key = ?").get(change.id);
    if (existing && Number(existing.updated_at || 0) > stampMs(change)) return;
    const identity = { catalogId: value.catalogId || "", seriesKey: value.seriesKey || "", season: value.season ?? null };
    if (change.value === null) {
      if (identity.catalogId || identity.seriesKey) recs.setAppRating({ ...identity, score: null, status: null });
      else db.prepare("DELETE FROM rec_ratings WHERE rating_key = ? AND source = 'app'").run(change.id);
    } else {
      recs.setAppRating({ ...identity, title: value.title || "", kind: value.kind || null, year: value.year ?? null, score: value.score ?? null, status: value.status || null });
    }
    done.add(change);
  }

  function applyComic(change, done) {
    if (!tableExists("comic_library")) return;
    const anilistId = Number(change.id.slice("anilist-".length));
    const existing = db.prepare("SELECT updated_at FROM comic_library WHERE anilist_id = ?").get(anilistId);
    if (existing && Number(existing.updated_at || 0) > stampMs(change)) return;
    if (change.value === null) db.prepare("DELETE FROM comic_library WHERE anilist_id = ?").run(anilistId);
    else {
      const at = stampMs(change);
      db.prepare(`INSERT INTO comic_library (anilist_id, status, work_json, added_at, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(anilist_id) DO UPDATE SET status = excluded.status, work_json = excluded.work_json, updated_at = excluded.updated_at`)
        .run(anilistId, change.value.status || "PLANNING", JSON.stringify(change.value.work || {}), at, at);
    }
    done.add(change);
  }

  return {
    types,
    export() {
      const out = [];
      exportLibrary(out);
      exportRatings(out);
      exportComics(out);
      return out;
    },
    // Applies changes; returns the ones applied (the rest stay pending, or a newer local
    // value is sent on the next export). previous: Map "type id" -> the change before.
    apply(changes, previous = new Map()) {
      const done = new Set();
      const library = changes.filter((change) => change.type.startsWith("video."));
      if (library.length) applyLibrary(library, done);
      for (const change of changes) {
        if (change.type === "rating.lvl") applyRating(change, previous.get(`${change.type} ${change.id}`), done);
        else if (change.type === "comic.library") applyComic(change, done);
      }
      return done;
    },
  };
}
