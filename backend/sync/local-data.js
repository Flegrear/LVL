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
import crypto from "node:crypto";
import { joinId, splitId } from "../../shared/sync/records.js";
import { parseStamp } from "../../shared/sync/clock.js";
import { COMIC_TYPES, createComicsData, present } from "./comics-data.js";

const TITLE_FIELDS = ["title", "displayTitle", "rawName", "seriesKey", "magnet", "coverUrl", "catalogId", "catalogType", "mediaKind", "aliases", "sourceMeta",
  "addedAt", "trackingStatus", "artworkIndex", "artworkSource", "artworkPinned", "chapterFileIndexes", "chapterLabels", "catalogOnly", "externalSource", "externalId"];
const HASH_ID = /^[0-9a-f]{40}$/i;
// Catalog cards have no torrent hash. A deterministic alias keeps their wire identity
// compatible with older devices; libraryId preserves the original local identity.
const wireId = (id) => HASH_ID.test(id) ? id.toLowerCase() : crypto.createHash("sha1").update(`lvl-library:${id}`).digest("hex");
const pick = (object, keys) => Object.fromEntries(keys.filter((key) => present(object?.[key])).map((key) => [key, object[key]]));
// An episode's metadata as synced: not its position (video.progress) and not this device's analysis of the file.
const episodeMeta = ({ progress, analysis, ...rest } = {}) => rest;
const stampMs = (change) => parseStamp(change.at)?.ms || 0;
// Older clients preserve optional fields when rewriting a record. Only the
// writer that supplied a timestamp can vouch for it; otherwise use its stamp.
const editedMs = (change) => {
  const stamp = parseStamp(change.at);
  const value = Number(change.value?.updatedAt);
  return change.value?.updatedBy === stamp?.device && value > 0 && value <= stamp.ms ? value : stamp?.ms || 0;
};
const importedSnapshot = (entry) => {
  const local = entry.anilist;
  const synced = entry.anilistSync;
  const info = !local || synced?.accountUserId === local.accountUserId
    && Number(synced.updatedAt || 0) > Number(local.updatedAt || 0) ? synced || local : local;
  if (!info?.showId) return null;
  return { ...pick(info, ["showId", "accountUserId", "anilistId", "averageScore", "url", "status", "cover", "updatedAt"]),
    seasons: (info.seasons || []).map(part => pick(part, ["anilistId", "season", "title", "format", "episodes", "status", "progress", "score"])) };
};

export function createLocalData({ appState, db, recs, log = console }) {
  const comics = createComicsData({ db });
  const types = ["video.title", "video.progress", "video.watched", "video.imported-watched", "rating.lvl", "rating.imported", ...COMIC_TYPES];
  const tableExists = (name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));

  function exportLibrary(out, entries = appState.readSection("library") || []) {
    for (const entry of entries) {
      const libraryId = String(entry?.id || "");
      if (!libraryId || libraryId.length > 600) continue;
      const id = wireId(libraryId);
      const context = (code) => ({ title: String(entry.displayTitle || entry.title || "").slice(0, 2000),
        ...(entry.catalogId ? { catalogId: entry.catalogId } : {}), ...(code ? { episode: code } : {}) });
      out.push({ type: "video.title", id, value: { ...pick(entry, TITLE_FIELDS),
        ...(importedSnapshot(entry) ? { anilistSync: importedSnapshot(entry) } : {}),
        ...(!HASH_ID.test(libraryId) ? { libraryId } : {}), episodes: (entry.episodes || []).map(episodeMeta) } });
      for (const episode of entry.episodes || []) {
        const index = Number(episode?.fileIndex);
        if (!episode?.progress || !Number.isInteger(index) || index < 0) continue;
        out.push({ type: "video.progress", id: `${id}/${index}`, value: {
          positionMs: Math.max(0, Math.round(Number(episode.progress.positionMs) || 0)),
          durationMs: Math.max(0, Math.round(Number(episode.progress.durationMs) || 0)),
          finished: Boolean(episode.progress.finished),
          ...(Number(episode.progress.updatedAt) > 0 ? { updatedAt: Number(episode.progress.updatedAt) } : {}),
          context: context(episode.code) } });
      }
      for (const [code, watched] of Object.entries(entry.watchedChapters || {})) {
        if (typeof watched !== "boolean" && !(typeof watched === "number" && Number.isFinite(watched) && watched > 0)) continue;
        const updatedAt = typeof watched === "number" ? watched : Number(entry.watchedChapterUpdatedAt?.[code]) || 0;
        const origin = entry.watchedChapterOrigins?.[code] || (watched && entry.anilist?.showId
          ? { source: "anilist", accountUserId: entry.anilist.accountUserId || null, updatedAt } : null);
        out.push({ type: origin?.source === "anilist" && watched ? "video.imported-watched" : "video.watched", id: joinId(id, code), value: { watched: Boolean(watched),
          ...(origin ? { provenance: origin } : {}),
          ...(updatedAt > 0 ? { updatedAt } : {}), context: context(code) } });
      }
    }
  }

  function exportRatings(out) {
    if (!tableExists("rec_ratings")) return;
    for (const row of db.prepare("SELECT * FROM rec_ratings WHERE source = 'app'").all()) {
      const provenance = row.provenance_json ? JSON.parse(row.provenance_json) : null;
      out.push({ type: provenance?.source === "anilist" ? "rating.imported" : "rating.lvl", id: row.rating_key, value: pick({
        catalogId: row.catalog_id, seriesKey: row.series_key, season: row.season, title: row.title, kind: row.kind,
        year: row.year, score: row.score, status: row.status, provenance },
        ["catalogId", "seriesKey", "season", "title", "kind", "year", "score", "status", "provenance"]) });
    }
  }

  // Library changes in one revision-checked write (tried again if a window saved meanwhile).
  function applyLibrary(changes, done, onLibraryApplied) {
    const order = { "video.title": 0, "video.progress": 1, "video.watched": 2, "video.imported-watched": 3 };
    const sorted = [...changes].sort((a, b) => order[a.type] - order[b.type]);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const expected = appState.sectionUpdatedAt("library");
      const library = structuredClone(appState.readSection("library") || []);
      const byId = new Map(library.map((entry) => [wireId(String(entry?.id || "")), entry]));
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
            const originalId = change.value.libraryId;
            const id = typeof originalId === "string" && wireId(originalId) === change.id ? originalId : change.id;
            const created = { id, ...pick(change.value, TITLE_FIELDS), episodes: episodes || [], addedAt: change.value.addedAt || at, updatedAt: at };
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
          const target = byId.get(change.id);
          // Synced list metadata is presentation, never local account authorization.
          if (Object.hasOwn(change.value, "anilistSync")) target.anilistSync = change.value.anilistSync;
          appliedNow.push(change);
        } else if (change.type === "video.progress") {
          const [id, index] = change.id.split("/");
          const entry = byId.get(id);
          if (!entry) continue;
          entry.episodes = Array.isArray(entry.episodes) ? entry.episodes : [];
          let episode = entry.episodes.find((item) => Number(item.fileIndex) === Number(index));
          if (!episode) { episode = { fileIndex: Number(index) }; entry.episodes.push(episode); }
          const playedAt = editedMs(change);
          if (Number(episode.progress?.updatedAt || 0) > playedAt) continue;
          if (change.value === null) delete episode.progress;
          else {
            episode.progress = { positionMs: change.value.positionMs || 0, durationMs: change.value.durationMs || 0, finished: Boolean(change.value.finished), updatedAt: playedAt };
            if (playedAt >= Number(entry.lastPlayedAt || 0)) { entry.lastPlayedAt = playedAt; entry.lastPlayedFileIndex = Number(index); }
          }
          appliedNow.push(change);
        } else if (change.type === "video.watched" || change.type === "video.imported-watched") {
          const [id, code] = splitId(change.id);
          const entry = byId.get(id);
          if (!entry || !code) continue;
          const imported = change.type === "video.imported-watched";
          const origin = entry.watchedChapterOrigins?.[code];
          // Moving between local and imported record types emits a tombstone
          // for the old type. It must not erase the replacement value.
          if (change.value === null && (imported ? origin?.source !== "anilist" : origin?.source === "anilist")) {
            appliedNow.push(change); continue;
          }
          if (imported && change.value !== null && change.value.provenance?.source !== "anilist") continue;
          if (imported && change.value?.watched && (entry.watchedChapters?.[code] === false || origin?.source === "local")) {
            appliedNow.push(change); continue;
          }
          const localAt = typeof entry.watchedChapters?.[code] === "number" ? entry.watchedChapters[code] : Number(entry.watchedChapterUpdatedAt?.[code]) || 0;
          const watchedAt = editedMs(change);
          if (localAt > watchedAt && !(!imported && origin?.source === "anilist")) continue;
          const marks = { ...(entry.watchedChapters || {}) };
          if (change.value === null) delete marks[code];
          else marks[code] = Boolean(change.value.watched);
          entry.watchedChapters = marks;
          entry.watchedChapterUpdatedAt = { ...(entry.watchedChapterUpdatedAt || {}) };
          if (change.value === null || !change.value.updatedAt) delete entry.watchedChapterUpdatedAt[code];
          else entry.watchedChapterUpdatedAt[code] = watchedAt;
          entry.watchedChapterOrigins = { ...(entry.watchedChapterOrigins || {}) };
          if (change.value?.provenance) entry.watchedChapterOrigins[code] = change.value.provenance;
          else delete entry.watchedChapterOrigins[code];
          appliedNow.push(change);
        }
      }
      if (!appliedNow.length) return;
      const result = appState.compareAndSwapSection("library", library, expected,
        onLibraryApplied ? (updatedAt) => onLibraryApplied({ library, updatedAt }) : null);
      if (result.ok) { for (const change of appliedNow) done.add(change); return; }
    }
    throw new Error("The Library kept changing while sync applied changes; it tries again on the next sync");
  }

  function applyRating(change, previous, done) {
    if (!tableExists("rec_ratings")) return;
    const value = change.value || previous?.value || {};
    const existing = db.prepare("SELECT * FROM rec_ratings WHERE rating_key = ?").get(change.id);
    if (existing && Number(existing.updated_at || 0) > stampMs(change)) return;
    const identity = { catalogId: value.catalogId || "", seriesKey: value.seriesKey || "", season: value.season ?? null };
    if (change.value === null) {
      const imported = existing?.provenance_json && JSON.parse(existing.provenance_json)?.source === "anilist";
      if (Boolean(imported) !== (change.type === "rating.imported")) { done.add(change); return; }
      if (identity.catalogId || identity.seriesKey) recs.setAppRating({ ...identity, score: null, status: null });
      else db.prepare("DELETE FROM rec_ratings WHERE rating_key = ? AND source = 'app'").run(change.id);
    } else {
      if (!identity.catalogId && !identity.seriesKey) return;
      recs.setAppRating({ ...identity, title: value.title || "", kind: value.kind || null, year: value.year ?? null, score: value.score ?? null, status: value.status || null,
        provenance: value.provenance || null });
    }
    done.add(change);
  }

  return {
    types,
    // Used to detect user edits made after a journaled incoming Library apply,
    // including removal of an entire title (which has no per-title timestamp).
    exportLibrarySnapshot(entries = appState.readSection("library") || []) {
      const out = [];
      exportLibrary(out, entries);
      return out;
    },
    export() {
      const out = [];
      exportLibrary(out);
      exportRatings(out);
      comics.export(out);
      return out;
    },
    // Applies changes; returns the ones applied (the rest stay pending, or a newer local
    // value is sent on the next export). previous: Map "type id" -> the change before.
    apply(changes, previous = new Map(), { onLibraryApplied, applyOtherAtomically } = {}) {
      const done = new Set();
      const library = changes.filter((change) => change.type.startsWith("video."));
      if (library.length) applyLibrary(library, done, onLibraryApplied);
      const isRating = (change) => change.type === "rating.lvl" || change.type === "rating.imported";
      const order = (change) => (isRating(change) ? -1 : COMIC_TYPES.indexOf(change.type));
      const other = changes.filter((item) => order(item) !== -1 || isRating(item)).sort((a, b) => order(a) - order(b));
      const applyOther = () => {
        for (const change of other) {
          // A change LVL's own stores refuse stays pending instead of failing the whole sync.
          try {
            if (isRating(change)) applyRating(change, previous.get(`${change.type} ${change.id}`), done);
            else comics.apply(change, done);
          } catch (error) {
            log.warn?.(`Sync: ${change.type} ${String(change.id).slice(0, 80)} not applied: ${error.message}`);
          }
        }
      };
      if (other.length && applyOtherAtomically) applyOtherAtomically(applyOther);
      else applyOther();
      return done;
    },
    mark() {
      const ratings = tableExists("rec_ratings") ? db.prepare("SELECT COUNT(*) AS n, MAX(updated_at) AS t FROM rec_ratings WHERE source = 'app'").get() : null;
      return [appState.sectionUpdatedAt("library"), ratings ? `${ratings.n}.${ratings.t ?? 0}` : "-", comics.mark()].join("|");
    },
  };
}
