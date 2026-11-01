// LVL's own data as sync records (shared/sync/records.js), and incoming changes applied to it.
// - Library (the app-state "library" section): video.title, video.progress, video.watched.
//   Changes are written with the section's revision check, like another LVL window's edit.
// - LVL ratings (rec_ratings, source "app"): rating.lvl, through the ratings store.
// - Comics: comics-data.js.
// mark(): a short text that changes whenever synced data may have changed (section times, row
// counts and newest times), so the sync service compares everything only when it moved.
// An incoming change older than the same item here (by the item's own time) isn't applied:
// the next export sends the newer local value instead. This keeps the newest data the first
// time two devices with their own data meet.
import { joinId, splitId } from "../../shared/sync/records.js";
import { parseStamp } from "../../shared/sync/clock.js";
import { COMIC_TYPES, createComicsData } from "./comics-data.js";

const TITLE_FIELDS = ["title", "displayTitle", "rawName", "seriesKey", "magnet", "coverUrl", "catalogId", "catalogType", "mediaKind", "aliases", "sourceMeta",
  "addedAt", "trackingStatus", "artworkIndex", "artworkSource", "artworkPinned", "chapterFileIndexes", "chapterLabels"];
const HASH_ID = /^[0-9a-f]{40}$/;
const present = (value) => value !== undefined && value !== null && value !== "";
const pick = (object, keys) => Object.fromEntries(keys.filter((key) => present(object?.[key])).map((key) => [key, object[key]]));
// An episode's metadata as synced: not its position (video.progress) and not this device's analysis of the file.
const episodeMeta = ({ progress, analysis, ...rest } = {}) => rest;
const stampMs = (change) => parseStamp(change.at)?.ms || 0;

export function createLocalData({ appState, db, recs, log = console }) {
  const comics = createComicsData({ db });
  const types = ["video.title", "video.progress", "video.watched", "rating.lvl", ...COMIC_TYPES];
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
            // A title that doesn't say what it is would be a blank Library card: wait for one that does.
            if (!present(change.value.title) && !present(change.value.displayTitle)) continue;
            const created = { id: change.id, ...pick(change.value, TITLE_FIELDS), episodes: episodes || [], addedAt: change.value.addedAt || at, updatedAt: at };
            library.push(created);
            byId.set(change.id, created);
          } else {
            const known = new Map((entry.episodes || []).map((episode) => [Number(episode.fileIndex), episode]));
            Object.assign(entry, pick(change.value, TITLE_FIELDS));
            // The other device's episode metadata over this one's; this device's file analysis and positions stay.
            if (episodes) {
              entry.episodes = episodes.map((episode) => {
                const mine = known.get(Number(episode.fileIndex));
                return mine ? { ...mine, ...episode, ...(mine.progress ? { progress: mine.progress } : {}) } : { ...episode };
              });
            }
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
    if (!tableExists("rec_ratings")) return;
    const value = change.value || previous?.value || {};
    const existing = db.prepare("SELECT updated_at FROM rec_ratings WHERE rating_key = ?").get(change.id);
    if (existing && Number(existing.updated_at || 0) > stampMs(change)) return;
    const identity = { catalogId: value.catalogId || "", seriesKey: value.seriesKey || "", season: value.season ?? null };
    if (change.value === null) {
      if (identity.catalogId || identity.seriesKey) recs.setAppRating({ ...identity, score: null, status: null });
      else db.prepare("DELETE FROM rec_ratings WHERE rating_key = ? AND source = 'app'").run(change.id);
    } else {
      if (!identity.catalogId && !identity.seriesKey) return;
      recs.setAppRating({ ...identity, title: value.title || "", kind: value.kind || null, year: value.year ?? null, score: value.score ?? null, status: value.status || null });
    }
    done.add(change);
  }

  return {
    types,
    export() {
      const out = [];
      exportLibrary(out);
      exportRatings(out);
      comics.export(out);
      return out;
    },
    // Applies changes; returns the ones applied (the rest stay pending, or a newer local
    // value is sent on the next export). previous: Map "type id" -> the change before.
    apply(changes, previous = new Map()) {
      const done = new Set();
      const library = changes.filter((change) => change.type.startsWith("video."));
      if (library.length) applyLibrary(library, done);
      const order = (change) => (change.type === "rating.lvl" ? -1 : COMIC_TYPES.indexOf(change.type));
      for (const change of changes.filter((item) => order(item) !== -1 || item.type === "rating.lvl").sort((a, b) => order(a) - order(b))) {
        // A change LVL's own stores refuse stays pending instead of failing the whole sync.
        try {
          if (change.type === "rating.lvl") applyRating(change, previous.get(`${change.type} ${change.id}`), done);
          else comics.apply(change, done);
        } catch (error) {
          log.warn?.(`Sync: ${change.type} ${String(change.id).slice(0, 80)} not applied: ${error.message}`);
        }
      }
      return done;
    },
    mark() {
      const ratings = tableExists("rec_ratings") ? db.prepare("SELECT COUNT(*) AS n, MAX(updated_at) AS t FROM rec_ratings WHERE source = 'app'").get() : null;
      return [appState.sectionUpdatedAt("library"), ratings ? `${ratings.n}.${ratings.t ?? 0}` : "-", comics.mark()].join("|");
    },
  };
}
