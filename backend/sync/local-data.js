// LVL's own data as sync records (shared/sync/records.js), and incoming changes applied to it.
// - Library (the app-state "library" section): video.title, video.progress, video.watched.
//   Changes are written with the section's revision check, like another LVL window's edit.
// - LVL ratings (rec_ratings, source "app"): rating.lvl, through the ratings store.
// - Comics: comics-data.js.
// mark(): a short text that changes whenever synced data may have changed (section times, row
// counts and newest times), so the sync service compares everything only when it moved.
// Accepted sync changes follow their logical stamps. Local pending edits are
// protected by sync-service's acknowledged base rather than by raw wall time.
import crypto from "node:crypto";
import { joinId, splitId } from "../../shared/sync/records.js";
import { records } from "../../shared/sync/records.js";
import { compareStamps, parseStamp } from "../../shared/sync/clock.js";
import { videoProgressComplete, videoPartialProgress, videoWatchedChoice,
  verifiedVideoEpisodeKey } from "../../shared/sync/video-state.js";
import { COMIC_TYPES, createComicsData, present } from "./comics-data.js";
import { createAppRatingRevision } from "./rating-revision.js";
import { causallyTracked, createSyncCausalLedger } from "./causal-ledger.js";

const TITLE_FIELDS = ["title", "displayTitle", "rawName", "seriesKey", "magnet", "coverUrl", "catalogId", "catalogType", "mediaKind", "aliases", "sourceMeta",
  "addedAt", "trackingStatus", "watchedTitleAt", "artworkIndex", "artworkSource", "artworkPinned", "chapterFileIndexes", "chapterLabels", "catalogOnly", "externalSource", "externalId"];
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
  const causal = createSyncCausalLedger(db);
  let causalScope = "unbound-local";
  const comics = createComicsData({ db, acceptedRead: (id, value) => {
    // The full HLC and content proof are bound to the verified sync account.
    // An unbound or older client cannot infer a winner from matching wall ms.
    if (causalScope === "unbound-local") return null;
    const accepted = causal.read(causalScope, "comic.read", id);
    if (!accepted || accepted.schema_version !== 1 || accepted.deleted) return null;
    const decision = causal.probe(causalScope,
      { type: "comic.read", id, at: accepted.accepted_at }, records.clean("comic.read", value));
    return decision === "already" ? true : decision === "dirty" ? false : null;
  } });
  const ratingRevision = createAppRatingRevision(db);
  // Install existing rating-table triggers immediately, not only on the
  // first timer mark. Direct writers on another connection share the same
  // durable SQLite triggers. A table created later is picked up by mark().
  ratingRevision.ensure();
  const types = ["video.title", "video.progress", "video.watched", "video.imported-watched", "rating.lvl", "rating.imported", ...COMIC_TYPES];
  const tableExists = (name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));

  function exportLibrary(out, entries = appState.readSection("library") || []) {
    const sourceIds = new Set(entries.map((entry) => wireId(String(entry?.id || ""))));
    for (const entry of entries) {
      const libraryId = String(entry?.id || "");
      if (!libraryId || libraryId.length > 600) continue;
      const id = wireId(libraryId);
      const context = (code) => ({ title: String(entry.displayTitle || entry.title || "").slice(0, 2000),
        ...(entry.catalogId ? { catalogId: entry.catalogId } : {}),
        ...(entry.catalogType ? { catalogType: entry.catalogType } : {}),
        ...(code ? { episode: code } : {}) });
      out.push({ type: "video.title", id, value: { ...pick(entry, TITLE_FIELDS),
        ...(importedSnapshot(entry) ? { anilistSync: importedSnapshot(entry) } : {}),
        ...(!HASH_ID.test(libraryId) ? { libraryId } : {}), episodes: (entry.episodes || []).map(episodeMeta) } });
      const completed = new Map();
      for (const episode of entry.episodes || []) {
        const index = Number(episode?.fileIndex);
        if (!episode?.progress || !Number.isInteger(index) || index < 0) continue;
        const code = String(episode.code || "").toUpperCase();
        const manual = videoWatchedChoice(entry, code);
        const identifiable = /^S\d{2}E\d{2,4}$/.test(code);
        if (identifiable && (manual === true || manual !== false && videoProgressComplete(episode.progress))) {
          if (manual !== true && manual !== false) completed.set(code, episode.progress);
          // The watched register is the compact account record. Dropping this
          // source progress produces the existing v1 progress tombstone.
          continue;
        }
        out.push({ type: "video.progress", id: `${id}/${index}`, value: {
          positionMs: Math.max(0, Math.round(Number(episode.progress.positionMs) || 0)),
          durationMs: Math.max(0, Math.round(Number(episode.progress.durationMs) || 0)),
          // An unidentified file has no chapter key for a compact watched
          // register, so retain its source-specific completed state.
          finished: !identifiable && manual !== false && videoProgressComplete(episode.progress),
          ...(Number(episode.progress.updatedAt) > 0 ? { updatedAt: Number(episode.progress.updatedAt) } : {}),
          context: context(episode.code) } });
      }
      for (const [code, watched] of [...Object.entries(entry.watchedChapters || {}),
        ...[...completed].filter(([code]) => !Object.hasOwn(entry.watchedChapters || {}, code))
          .map(([code, progress]) => [code, Number(progress.updatedAt) || true])]) {
        if (typeof watched !== "boolean" && !(typeof watched === "number" && Number.isFinite(watched) && watched > 0)) continue;
        const updatedAt = typeof watched === "number" ? watched : Number(entry.watchedChapterUpdatedAt?.[code]) || 0;
        const mirrored = entry.watchedChapterReplicas?.[code];
        // Replicas avoid echoing a watch action under every torrent hash.
        // If its originating file has since been removed, another verified
        // source adopts the mark so the account does not lose its watch truth.
        if (mirrored && mirrored.value === Boolean(watched) && mirrored.observedAt === updatedAt
          && (!mirrored.sourceId || sourceIds.has(mirrored.sourceId))) continue;
        const origin = entry.watchedChapterOrigins?.[code] || (completed.has(code) ? { source: "playback", updatedAt } : null) || (watched && entry.anilist?.showId
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
    const sorted = [...changes].sort((a, b) => {
      const aTitle = a.type === "video.title";
      const bTitle = b.type === "video.title";
      return aTitle !== bTitle ? (aTitle ? -1 : 1)
        : compareStamps(a.at, b.at) || order[a.type] - order[b.type];
    });
    const importedReplacements = new Set(sorted.filter((item) => item.type === "video.imported-watched" && item.value?.watched)
      .map((item) => item.id));
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const expected = appState.sectionUpdatedAt("library");
      const library = structuredClone(appState.readSection("library") || []);
      const before = JSON.stringify(library);
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
          // The service only delivers accepted remote HLC records after it has
          // protected unacknowledged local edits against their accepted base.
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
          if (episode.progress?.syncStamp && compareStamps(episode.progress.syncStamp, change.at) >= 0) {
            appliedNow.push(change); continue;
          }
          if (change.value === null) delete episode.progress;
          else {
            const code = String(episode.code || "").toUpperCase();
            const explicitUnwatch = videoWatchedChoice(entry, code) === false;
            const unwatchStamp = entry.watchedChapterSyncStamps?.[code];
            // A negative watched action blocks stale prior completion, not a
            // *later* real rewatch at 24%. The chapter stays explicitly
            // unwatched until the player re-arms it after genuine playback.
            const allowPartialRewatch = explicitUnwatch && videoPartialProgress(change.value)
              && (!unwatchStamp || compareStamps(change.at, unwatchStamp) > 0);
            episode.progress = { positionMs: explicitUnwatch && !allowPartialRewatch ? 0 : change.value.positionMs || 0,
              durationMs: change.value.durationMs || 0,
              finished: !explicitUnwatch && videoProgressComplete(change.value), updatedAt: playedAt, syncStamp: change.at };
            if (playedAt >= Number(entry.lastPlayedAt || 0)) { entry.lastPlayedAt = playedAt; entry.lastPlayedFileIndex = Number(index); }
          }
          appliedNow.push(change);
        } else if (change.type === "video.watched" || change.type === "video.imported-watched") {
          let id, code;
          try { [id, code] = splitId(change.id); } catch { continue; }
          const entry = byId.get(id);
          if (!code) continue;
          const imported = change.type === "video.imported-watched";
          const origin = entry?.watchedChapterOrigins?.[code];
          // Moving between local and imported record types emits a tombstone
          // for the old type. It must not erase the replacement value.
          if (!imported && change.value === null && importedReplacements.has(change.id)) {
            appliedNow.push(change); continue;
          }
          if (change.value === null && (imported ? origin?.source !== "anilist" : origin?.source === "anilist")) {
            appliedNow.push(change); continue;
          }
          if (imported && change.value !== null && change.value.provenance?.source !== "anilist") continue;
          if (imported && change.value?.watched && (entry?.watchedChapters?.[code] === false
            || origin?.source === "local" || origin?.source === "playback")) {
            appliedNow.push(change); continue;
          }
          const watchedAt = editedMs(change);
          const context = change.value?.context;
          const identity = verifiedVideoEpisodeKey(entry, code);
          // The historical source might already be removed. Its authenticated
          // accepted record can still carry a verified work/episode identity;
          // never infer one from a translated title or an unverified alias.
          const verifiedContext = verifiedVideoEpisodeKey(context, code);
          if (entry && identity && verifiedContext && identity !== verifiedContext) continue;
          // A present source without a verified catalog must stay independent,
          // even when its legacy record carries a claimed catalog context.
          // When the source is gone entirely, the accepted record's verified
          // context is the only safe account identity still available.
          const sharedIdentity = !entry ? verifiedContext
            : identity && (verifiedContext === identity || !context?.catalogId) ? identity : null;
          // A tombstone retires ONE source's old watched record. It is not an
          // explicit "unwatch" for every source with the same verified chapter.
          // Such a chapter-wide choice is represented by watched:false. In
          // particular, completion compaction can retire an old torrent's true
          // record after a new explicit false was published by the catalog card.
          const matches = change.value === null ? entry ? [entry] : []
            : sharedIdentity ? library.filter((item) =>
              verifiedVideoEpisodeKey(item, code) === sharedIdentity) : entry ? [entry] : [];
          if (!matches.length) {
            if (change.value === null) appliedNow.push(change);
            continue;
          }
          // Imported completions do not acquire a new origin after the
          // original account-bound source has been removed.
          if (imported && !entry) continue;
          // An external aggregate count is weaker than a locally observed
          // partial episode; it cannot turn 16/22 minutes into watched.
          if (imported && change.value?.watched && matches.some((item) =>
            (item.episodes || []).some((ep) => String(ep.code || "").toUpperCase() === code
              && videoPartialProgress(ep.progress)))) {
            appliedNow.push(change); continue;
          }
          for (const target of matches) {
            const prior = target.watchedChapterSyncStamps?.[code];
            if (prior && compareStamps(prior, change.at) >= 0) continue;
            const replica = target.watchedChapterReplicas?.[code];
            // The source being retired may already display a newer choice
            // copied from a different record. Its own tombstone must not
            // destroy that independently authored watched/unwatched choice.
            if (change.value === null && replica?.sourceId && replica.sourceId !== id) continue;
            const localChoice = videoWatchedChoice(target, code);
            if (target !== entry && target.watchedChapterOrigins?.[code]?.source === "local"
              && !prior && localChoice !== null) continue;
            if (target !== entry && replica && (replica.value !== localChoice
              || replica.observedAt !== (Number(target.watchedChapterUpdatedAt?.[code]) || 0))) continue;
            target.watchedChapters = { ...(target.watchedChapters || {}) };
            if (change.value === null) delete target.watchedChapters[code];
            else target.watchedChapters[code] = Boolean(change.value.watched);
            target.watchedChapterUpdatedAt = { ...(target.watchedChapterUpdatedAt || {}) };
            if (change.value === null || !change.value.updatedAt) delete target.watchedChapterUpdatedAt[code];
            else target.watchedChapterUpdatedAt[code] = watchedAt;
            target.watchedChapterOrigins = { ...(target.watchedChapterOrigins || {}) };
            if (change.value?.provenance) target.watchedChapterOrigins[code] = change.value.provenance;
            else delete target.watchedChapterOrigins[code];
            target.watchedChapterSyncStamps = { ...(target.watchedChapterSyncStamps || {}), [code]: change.at };
            if (target !== entry) target.watchedChapterReplicas = { ...(target.watchedChapterReplicas || {}), [code]: {
              value: Boolean(change.value?.watched), observedAt: change.value?.updatedAt ? watchedAt : 0,
              sourceId: id } };
            else if (target.watchedChapterReplicas?.[code]) {
              target.watchedChapterReplicas = { ...target.watchedChapterReplicas };
              delete target.watchedChapterReplicas[code];
            }
            if (change.value?.watched === false)
              for (const ep of target.episodes || []) {
                if (String(ep.code || "").toUpperCase() !== code || !ep.progress) continue;
                // A genuine in-flight partial replay can arrive in the same
                // v1 batch as an explicit unwatch. Keep that safe resume
                // point; reset completed/near-end positions to prevent Up Next.
                const keepPartial = videoPartialProgress(ep.progress)
                  && Number(ep.progress.positionMs) <= Number(ep.progress.durationMs) * 0.8;
                ep.progress = { ...ep.progress, positionMs: keepPartial ? ep.progress.positionMs : 0, finished: false,
                  updatedAt: watchedAt, syncStamp: change.at };
              }
          }
          appliedNow.push(change);
        }
      }
      if (!appliedNow.length) return;
      if (JSON.stringify(library) === before) { for (const change of appliedNow) done.add(change); return; }
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
    // The sync journal has already selected this record using the full HLC
    // and protected later local edits. The app rating's wall-clock updated_at
    // can be days ahead of a peer and must not veto the accepted record.
    if (existing && existing.source !== "app") return;
    const identity = { catalogId: value.catalogId || existing?.catalog_id || "",
      seriesKey: value.seriesKey || existing?.series_key || "", season: value.season ?? existing?.season ?? null,
      kind: value.kind || existing?.kind || null };
    if (change.value === null) {
      const imported = existing?.provenance_json && JSON.parse(existing.provenance_json)?.source === "anilist";
      // Retiring the old imported/local wire type cannot remove the current
      // other-type rating. Its absent projection is a real tombstone, not a
      // synthetic deletion of the other type.
      if (Boolean(imported) !== (change.type === "rating.imported")) { done.add(change); return; }
      if (existing && (identity.catalogId || identity.seriesKey))
        recs.setAppRating({ ...identity, score: null, status: null });
      else db.prepare("DELETE FROM rec_ratings WHERE rating_key = ? AND source = 'app'").run(change.id);
      // A kind-namespaced identity must not be marked removed if the producer
      // resolved a different key or refused the deletion.
      if (db.prepare("SELECT 1 FROM rec_ratings WHERE rating_key = ?").get(change.id)) return;
    } else {
      if (!identity.catalogId && !identity.seriesKey) return;
      recs.setAppRating({ ...identity, title: value.title || "", kind: value.kind || null, year: value.year ?? null, score: value.score ?? null, status: value.status || null,
        provenance: value.provenance || null });
    }
    done.add(change);
  }

  // These exact record keys are already validated by the registry. The local
  // content proof is over its cleaned current projection, not a wall-time,
  // display title alias, or an unrelated row's change counter.
  const projectionOf = (change) => {
    const out = [];
    if (change.type.startsWith("rating.")) exportRatings(out);
    else comics.export(out);
    const row = out.find(item => item.type === change.type && item.id === change.id);
    return row ? records.clean(change.type, row.value) : null;
  };
  function applyCausalOne(change, previous, done) {
    // Both producer state and per-field HLC proof must commit together.
    // SAVEPOINT is safe inside the outer journal's BEGIN IMMEDIATE; no
    // connection-global trigger suppression can hide another local writer.
    db.exec("SAVEPOINT sync_causal_one");
    try {
      if (change.type.startsWith("rating.")) ratingRevision.ensure();
      const before = projectionOf(change);
      const decision = causal.probe(causalScope, change, before);
      if (decision === "unsupported") {
        db.exec("RELEASE sync_causal_one");
        return; // keep unknown future local metadata and pending remote intact
      }
      if (decision === "dirty") {
        db.exec("RELEASE sync_causal_one");
        return; // unsent independent local edit wins; remote stays unapplied
      }
      if (decision === "already") {
        db.exec("RELEASE sync_causal_one");
        done.add(change); // a previously persisted causal proof, not an invented ack
        return;
      }
      const appliedOne = new Set();
      if (change.type.startsWith("rating."))
        applyRating(change, previous, appliedOne);
      else comics.apply(change, appliedOne, { acceptedBySync: true });
      if (!appliedOne.has(change)) {
        db.exec("ROLLBACK TO sync_causal_one");
        db.exec("RELEASE sync_causal_one");
        return;
      }
      const after = projectionOf(change);
      if (change.value === null ? after !== null : after === null)
        throw new Error("Producer did not materialize the requested sync record");
      if (!causal.record(causalScope, change, after))
        throw new Error("A newer causal record already owns this sync item");
      db.exec("RELEASE sync_causal_one");
      done.add(change);
    } catch (error) {
      db.exec("ROLLBACK TO sync_causal_one");
      db.exec("RELEASE sync_causal_one");
      throw error;
    }
  }

  return {
    types,
    setCausalScope(value) {
      if (typeof value !== "string" || !value) throw new Error("A bound sync scope is required");
      causalScope = value;
    },
    recordAuthoredCausal(outgoing, captured = []) {
      const proofByKey = new Map(captured);
      for (const change of outgoing) {
        const key = `${change.type} ${change.id}`;
        if (!causallyTracked(change.type) || !proofByKey.has(key)) continue;
        if (!causal.record(causalScope, change, proofByKey.get(key), "authored"))
          throw new Error("Outgoing causal record is older than the durable accepted stamp; preserve the journal");
      }
    },
    inspectCausality(type, id) {
      return { item: causal.read(causalScope, type, id), fields: causal.fields(causalScope, type, id) };
    },
    // A first-time join may have an unsent local title (artwork, source data)
    // colliding with a newer accepted AniList display snapshot. Keep the
    // local title edit, but do not republish its *older* same-account import.
    // This carries display metadata only; it never grants AniList write access.
    reconcileImportedSnapshot(change) {
      const incoming = change?.type === "video.title" ? change.value?.anilistSync : null;
      const account = Number(incoming?.accountUserId);
      const updatedAt = Number(incoming?.updatedAt);
      if (!incoming?.showId || !Number.isSafeInteger(account) || account <= 0
        || !Number.isFinite(updatedAt) || updatedAt <= 0) return false;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const expected = appState.sectionUpdatedAt("library");
        const library = structuredClone(appState.readSection("library") || []);
        const entry = library.find((item) => wireId(String(item?.id || "")) === change.id);
        if (!entry) return false;
        const current = importedSnapshot(entry);
        if (!current?.showId || current.showId !== incoming.showId
          || Number(current.accountUserId) !== account
          || Number(current.updatedAt || 0) >= updatedAt) return false;
        entry.anilistSync = structuredClone(incoming);
        if (appState.compareAndSwapSection("library", library, expected).ok) return true;
      }
      throw new Error("The Library changed while reconciling accepted AniList display metadata");
    },
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
            applyCausalOne(change, previous.get(`${change.type} ${change.id}`), done);
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
      return [appState.sectionUpdatedAt("library"), ratingRevision.mark(), comics.mark()].join("|");
    },
  };
}
