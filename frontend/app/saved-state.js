// LVL's saved state: the server's copy of the app state (sections, revisions, conflicts) and the local copies it falls back on.
import { normalizeLearningLocale } from "../../shared/settings/language-settings.js";
import { localCopyUnloaded, POPUP_HANDOFF, renderAll, state, uiLanguage } from "../../app.js";
import { legacyPreferencesSnapshot, preserveLegacyPreferences } from "./legacy-preferences.js";
import { fetchJson, postJson } from "./http.js";
import { viewActive } from "./navigation.js";
import { applySubtitleStyle, subtitleStyleDefaults } from "../player/subtitle-style.js";
import { renderLibrary } from "../library/library-page.js";
import { refreshTitlePage } from "../title/title-page.js";
import { scheduleAniListAutoSync } from "../anilist/anilist-sync.js";
import { renderWatchChapters } from "../watch/watch-page.js";

export function readStorageArray(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

// The big sections (cards, library…) live in the app database; the browser keeps a copy as a
// cache. A copy that doesn't fit in browser storage (large Anki decks) is dropped and marked, so
// a failed copy never stops the database save, and an empty placeholder never replaces it.
const LOCAL_COPY_SECTIONS = Object.freeze({
  "blackline-cards": "cards",
  "blackline-known": "known",
  "blackline-library": "library",
  "blackline-learning-exposure": "learningExposure",
  "blackline-test-results": "testResults",
  "blackline-coach-transcripts": "coachTranscripts",
});
const LOCAL_COPY_MISSING_KEY = "blackline-local-copy-missing-v1";

export function localCopyMissing() {
  try {
    const value = JSON.parse(localStorage.getItem(LOCAL_COPY_MISSING_KEY) || "[]");
    return new Set(Array.isArray(value) ? value.map(String) : []);
  } catch {
    return new Set();
  }
}

function writeLocalCopyMissing(keys) {
  try {
    if (keys.size) localStorage.setItem(LOCAL_COPY_MISSING_KEY, JSON.stringify([...keys]));
    else localStorage.removeItem(LOCAL_COPY_MISSING_KEY);
  } catch {}
}

export function storeLocalCopy(key, value) {
  if (localCopyUnloaded.has(key)) return false;
  const missing = localCopyMissing();
  try {
    localStorage.setItem(key, JSON.stringify(value));
    if (missing.delete(key)) writeLocalCopyMissing(missing);
    return true;
  } catch (error) {
    try { localStorage.removeItem(key); } catch {}
    missing.add(key);
    writeLocalCopyMissing(missing);
    console.warn(`The browser copy of ${LOCAL_COPY_SECTIONS[key] || key} is too large for local storage; the app database keeps it.`, error?.name || error);
    return false;
  }
}

export function readStorageObject(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export const APP_DB_MIGRATION_KEY = "blackline-db-migrated-v1";
const APP_DB_PREFERENCES_MIGRATION_KEY = "blackline-db-preferences-v2";
const APP_DB_DIRTY_SECTIONS_KEY = "blackline-db-dirty-sections-v1";
export let persistentAppStateReady = false;
const persistentAppWriteTimers = new Map();
const persistentAppWriteChains = new Map();
const persistentAppWriteGenerations = new Map();
const persistentAppSectionRevisions = new Map();
// The last *confirmed* SQLite Library snapshot, not a possibly stale browser
// cache. CAS recovery must know what was changed by this tab vs another tab.
const persistentAppAcceptedSnapshots = new Map();
// The confirmed SQLite snapshot that the *visible* Library was based on. A
// later-generation edit can still be made on stale visible data while an older
// HTTP CAS is in flight; updating acceptedSnapshots alone does not update it.
let persistentAppLibraryViewBaseline = null;
// The revision the open tab has actually applied. A successful SQLite CAS
// can advance the acknowledged revision while newer in-tab edits still keep
// the visible Library based on an older snapshot.
let persistentAppLibraryViewRevision = null;
// Successful, still-unreflected changes authored by this tab. A newer user
// edit can change the same item again while its previous CAS acknowledgment
// arrives, without confusing that prior same-tab edit with a remote conflict.
const persistentAppUnreflectedLibraryWrites = new Map();
const persistentAppUnresolvedConflicts = new Set();
const persistentAppConflictViewBaselines = new Map();
const persistentAppPartialLibrarySaves = new Set();
// Local SQLite transport failures are retryable. A real semantic conflict is
// held separately above until the user chooses how to resolve it.
const persistentAppRetryAfter = new Map();
// Browser localStorage is shared by tabs. Only this tab's writes may block
// its read-only Library refresh; the shared marker alone proves no ownership.
const persistentAppOwnPendingSections = new Set();
const PERSISTENT_CAS_SECTIONS = new Set(["cards", "known", "library", "preferences"]);
const APP_DB_TAB_LIBRARY_PENDING_KEY = "blackline-db-library-pending-tab-v1";

function persistentDirtySections() {
  const withTabPending = (sections) => {
    // A different same-origin tab may clear/replace the shared dirty marker.
    // The current tab's sessionStorage shadow remains authoritative proof it
    // has a pending Library save, even after that shared marker disappears.
    try {
      if (typeof sessionStorage !== "undefined"
        && typeof APP_DB_TAB_LIBRARY_PENDING_KEY !== "undefined"
        && sessionStorage.getItem(APP_DB_TAB_LIBRARY_PENDING_KEY)
        && !sections.has("library")) sections.set("library", { mode: "replace", expectedUpdatedAt: null });
    } catch {}
    return sections;
  };
  try {
    const parsed = JSON.parse(localStorage.getItem(APP_DB_DIRTY_SECTIONS_KEY) || "[]");
    if (Array.isArray(parsed)) {
      return withTabPending(new Map(parsed.map((section) => {
        const name = String(section);
        return [name, { mode: name === "coachTranscripts" ? "merge" : "replace", expectedUpdatedAt: null }];
      })));
    }
    if (parsed && typeof parsed === "object") {
      return withTabPending(new Map(Object.entries(parsed).map(([section, raw]) => {
        const entry = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : { mode: raw };
        const expectedUpdatedAt = entry.expectedUpdatedAt == null ? null : Number(entry.expectedUpdatedAt);
        return [String(section), {
          mode: entry.mode === "merge" ? "merge" : "replace",
          expectedUpdatedAt: expectedUpdatedAt !== null && Number.isFinite(expectedUpdatedAt) && expectedUpdatedAt >= 0 ? expectedUpdatedAt : null,
        }];
      })));
    }
    return withTabPending(new Map());
  } catch {
    return withTabPending(new Map());
  }
}

function setPersistentSectionDirty(section, dirty, mode = "replace", expectedUpdatedAt = undefined) {
  const sections = persistentDirtySections();
  const existing = sections.get(section);
  const baseRevision = expectedUpdatedAt !== undefined
    ? expectedUpdatedAt
    : existing?.expectedUpdatedAt ?? persistentAppSectionRevisions.get(section) ?? null;
  if (dirty) sections.set(section, {
    mode: mode === "merge" ? "merge" : "replace",
    expectedUpdatedAt: PERSISTENT_CAS_SECTIONS.has(section) && baseRevision != null && Number.isFinite(Number(baseRevision))
      ? Math.max(0, Number(baseRevision))
      : null,
  });
  else sections.delete(section);
  if (sections.size) localStorage.setItem(APP_DB_DIRTY_SECTIONS_KEY, JSON.stringify(Object.fromEntries(sections)));
  else localStorage.removeItem(APP_DB_DIRTY_SECTIONS_KEY);
}

function applyPersistentSectionRevisions(revisions) {
  if (!revisions || typeof revisions !== "object" || Array.isArray(revisions)) return;
  for (const [section, value] of Object.entries(revisions)) {
    const revision = Number(value);
    if (Number.isFinite(revision) && revision >= 0) persistentAppSectionRevisions.set(section, revision);
  }
}

function copyPersistentLibrary(items) {
  return JSON.parse(JSON.stringify(Array.isArray(items) ? items.slice(0, 5_000) : []));
}

function applyUnreflectedPersistentLibraryWrites(visibleBase) {
  if (!Array.isArray(visibleBase)) return null;
  const items = new Map(visibleBase.filter(item => item?.id != null)
    .map(item => [String(item.id), item]));
  for (const [id, change] of persistentAppUnreflectedLibraryWrites) {
    if (change.deleted) items.delete(id);
    else items.set(id, change.value);
  }
  return copyPersistentLibrary([...items.values()]);
}

function recordUnreflectedPersistentLibraryWrite(visibleBase, submitted, saved) {
  // Only values the tab actually intended to change gain this exemption.
  // Entries inserted/edited by a different tab during a 409 rebase must never
  // be treated as this tab's own edits.
  if (![visibleBase, submitted, saved].every(Array.isArray)) return;
  const index = items => new Map(items.filter(item => item?.id != null)
    .map(item => [String(item.id), item]));
  const before = index(visibleBase);
  const mine = index(submitted);
  const committed = index(saved);
  for (const id of new Set([...before.keys(), ...mine.keys()])) {
    if (JSON.stringify(before.get(id) ?? null) === JSON.stringify(mine.get(id) ?? null)) continue;
    if (mine.has(id) && committed.has(id))
      persistentAppUnreflectedLibraryWrites.set(id, { value: copyPersistentLibrary([mine.get(id)])[0] });
    else if (!mine.has(id) && !committed.has(id)) persistentAppUnreflectedLibraryWrites.set(id, { deleted: true });
  }
}

function preservePendingLibraryForTab(items) {
  // localStorage is shared between LVL tabs. A tab-local shadow means another
  // tab's browser-cache write cannot erase this tab's pending Library intent.
  try {
    if (typeof sessionStorage !== "undefined") {
      const previous = sessionStorage.getItem(APP_DB_TAB_LIBRARY_PENDING_KEY);
      let prior = null;
      try { if (previous) prior = JSON.parse(previous); } catch {}
      // A previous ambiguous/partial shadow stays unsafe for the lifetime of
      // this pending intent, even if another disjoint save advances SQLite's
      // revision. Old shadows without an explicit certificate fail closed.
      const previouslyUnsafe = Boolean(previous)
        && (Array.isArray(prior) || prior?.safeToReplay !== true);
      const revision = persistentAppSectionRevisions.get("library");
      const certifiedBaseRevision = Number.isSafeInteger(revision)
        && persistentAppAcceptedSnapshots.has("library") ? revision : null;
      // The last accepted write may have completed while a newer edit was
      // already queued. SQLite is then ahead of the Library still visible in
      // this tab: a matching revision can NOT certify that stale full snapshot.
      const visibleBaseVerified = Array.isArray(persistentAppLibraryViewBaseline)
        && JSON.stringify(persistentAppLibraryViewBaseline)
          === JSON.stringify(persistentAppAcceptedSnapshots.get("library"));
      const safeToReplay = !previouslyUnsafe
        && !persistentAppUnresolvedConflicts.has("library")
        && !persistentAppPartialLibrarySaves.has("library")
        && visibleBaseVerified
        && certifiedBaseRevision !== null;
      sessionStorage.setItem(APP_DB_TAB_LIBRARY_PENDING_KEY, JSON.stringify({
        value: copyPersistentLibrary(items),
        expectedUpdatedAt: revision ?? null,
        // An exact revision match alone is NOT a replay certificate: a partial
        // safe edit can move DB to that revision while a conflicting item stays
        // stale in this tab's visible Library. Bind replay eligibility to the
        // pristine tab-owned SQLite baseline, separately from its pending data.
        certifiedBaseRevision: safeToReplay ? certifiedBaseRevision : null,
        safeToReplay,
      }));
    }
  } catch { /* SQLite and the normal local copy remain independent fallbacks. */ }
}

function invalidatePersistentLibraryReplay() {
  persistentAppPartialLibrarySaves.add("library");
  try {
    if (typeof sessionStorage === "undefined") return;
    const raw = sessionStorage.getItem(APP_DB_TAB_LIBRARY_PENDING_KEY);
    if (!raw) return;
    let record;
    try { record = JSON.parse(raw); } catch { record = null; }
    const value = Array.isArray(record) ? record : record?.value;
    sessionStorage.setItem(APP_DB_TAB_LIBRARY_PENDING_KEY, JSON.stringify({
      value: copyPersistentLibrary(value ?? state.library),
      expectedUpdatedAt: record?.expectedUpdatedAt ?? null,
      certifiedBaseRevision: null,
      safeToReplay: false,
    }));
  } catch { /* Preserve the in-memory dirty Library even if storage is full. */ }
}

function clearPendingLibraryForTab() {
  persistentAppOwnPendingSections.delete("library");
  try { if (typeof sessionStorage !== "undefined") sessionStorage.removeItem(APP_DB_TAB_LIBRARY_PENDING_KEY); } catch {}
}

function hasPendingLibraryForTab() {
  try {
    return typeof sessionStorage !== "undefined" && Boolean(sessionStorage.getItem(APP_DB_TAB_LIBRARY_PENDING_KEY));
  } catch { return false; }
}

function alertPersistentLibraryConflict() {
  if (typeof document === "undefined") return;
  const parent = document.querySelector("#view-library .lib-main");
  if (!parent) return;
  let alert = document.getElementById("library-persistence-conflict");
  if (!alert) {
    alert = document.createElement("p");
    alert.id = "library-persistence-conflict";
    alert.setAttribute("role", "alert");
    alert.style.cssText = "padding:12px 16px;border:1px solid #777;color:#fff;background:#161616;margin:0 0 12px";
    parent.prepend(alert);
  }
  alert.textContent = "Saved changes could not be merged with edits in this window. Export the library to keep those edits, or use the saved Library to replace this unsaved copy. ";
  const recover = document.createElement("button");
  recover.type = "button";
  recover.className = "ui-btn ui-btn--secondary ui-btn--sm";
  recover.textContent = "Use saved Library";
  recover.addEventListener("click", async () => {
    recover.disabled = true;
    try {
      if (!await useSavedPersistentLibrary()) recover.textContent = "Save in progress — try again";
    } catch { recover.textContent = "Couldn't load saved Library — retry"; }
    finally { recover.disabled = false; }
  });
  alert.append(recover);
}

async function useSavedPersistentLibrary() {
  if (!persistentAppStateReady || persistentAppWriteChains.has("library") || persistentAppWriteTimers.has("library")) return false;
  const generation = persistentAppWriteGenerations.get("library") || 0;
  const visible = copyPersistentLibrary(state.library);
  const disk = await fetchJson("/api/app-state/library");
  if (!Array.isArray(disk?.value) || !Number.isSafeInteger(disk.updatedAt)
      || generation !== (persistentAppWriteGenerations.get("library") || 0)
      || persistentAppWriteChains.has("library") || persistentAppWriteTimers.has("library")
      || !sameLibraryContent(visible, state.library)) return false;
  const saved = copyPersistentLibrary(disk.value);
  state.library = saved;
  persistentAppSectionRevisions.set("library", disk.updatedAt);
  persistentAppAcceptedSnapshots.set("library", copyPersistentLibrary(saved));
  persistentAppLibraryViewBaseline = copyPersistentLibrary(saved);
  persistentAppLibraryViewRevision = disk.updatedAt;
  persistentAppUnreflectedLibraryWrites.clear();
  persistentAppUnresolvedConflicts.delete("library");
  persistentAppConflictViewBaselines.delete("library");
  persistentAppPartialLibrarySaves.delete("library");
  clearPendingLibraryForTab();
  setPersistentSectionDirty("library", false);
  storeLocalCopy("blackline-library", saved);
  if (typeof document !== "undefined") document.getElementById("library-persistence-conflict")?.remove();
  if (viewActive("library")) renderLibrary();
  refreshTitlePage();
  if (viewActive("watch")) renderWatchChapters();
  return true;
}

// A stopped WebView may retain a dirty marker even if its last Library save
// completed in SQLite. Compare records independent of object-key ordering so
// an acknowledged identical copy is never treated as a multi-tab conflict.
function sameLibraryContent(a, b) {
  const canonical = (value) => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).filter((key) => value[key] !== undefined)
        .sort().map((key) => [key, canonical(value[key])]))
      : value;
  return Array.isArray(a) && Array.isArray(b)
    && JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function rebasePersistentPlayback(base, local, remote) {
  if (!base || !local || !remote || ![base.episodes, local.episodes, remote.episodes].every(Array.isArray)) return null;
  const equal = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const expected = copyPersistentLibrary([base])[0];
  const next = copyPersistentLibrary([remote])[0];
  // A watch flag, its author and its timestamp are one episode edit. Different
  // episodes can change on both devices without conflicting over the whole title.
  // A sync stamp and its replica identify the causal author of a watched
  // choice. They must follow that very chapter's edit, never an unrelated
  // whole-title metadata update from a different tab.
  const tracking = ["watchedChapters", "watchedChapterUpdatedAt", "watchedChapterOrigins",
    "watchedChapterSyncStamps", "watchedChapterReplicas"];
  for (const entry of [base, local, remote]) for (const field of tracking)
    if (entry[field] !== undefined && (!entry[field] || typeof entry[field] !== "object" || Array.isArray(entry[field]))) return null;
  const bundle = (entry, code) => Object.fromEntries(tracking
    .filter(field => Object.hasOwn(entry[field] || {}, code)).map(field => [field, entry[field][code]]));
  const codes = new Set(tracking.flatMap(field => [...Object.keys(base[field] || {}), ...Object.keys(local[field] || {})]));
  for (const code of codes) {
    if (!/^S\d{2}E\d{2,4}$/.test(code)) return null;
    const was = bundle(base, code), mine = bundle(local, code), theirs = bundle(remote, code);
    if (equal(was, mine)) continue;
    if (!equal(was, theirs) && !equal(mine, theirs)) {
      const watched = entry => {
        const choice = entry.watchedChapters?.[code];
        return choice === false ? false
          : choice === true || typeof choice === "number" && Number.isFinite(choice) && choice > 0 ? true : null;
      };
      // Two tabs may explicitly confirm the same watched choice at different
      // times. Accept the already-saved causality for that idempotent choice;
      // opposing watched/unwatched decisions still need a real user choice.
      if (watched(local) !== null && watched(local) === watched(remote)) continue;
      return null;
    }
    for (const field of tracking) {
      if (Object.hasOwn(local[field] || {}, code)) {
        next[field] = next[field] || {};
        next[field][code] = local[field][code];
      } else if (next[field]) delete next[field][code];
    }
  }
  for (const field of tracking) {
    if (Object.hasOwn(local, field)) expected[field] = JSON.parse(JSON.stringify(local[field]));
    else delete expected[field];
  }
  for (const episode of local.episodes) {
    const was = expected.episodes.find(item => item.fileIndex === episode.fileIndex);
    const incoming = next.episodes.find(item => item.fileIndex === episode.fileIndex);
    if (!was) {
      // An added local source episode is independent of a remote watch choice
      // for another chapter. It must retain a unique concrete file identity.
      if (!Number.isSafeInteger(episode.fileIndex) || episode.fileIndex < 0
        || local.episodes.filter(item => item.fileIndex === episode.fileIndex).length !== 1
        || incoming && !equal(incoming, episode)) return null;
      expected.episodes.push(copyPersistentLibrary([episode])[0]);
      if (!incoming) next.episodes.push(copyPersistentLibrary([episode])[0]);
      continue;
    }
    if (!incoming) return null;
    if (!equal(was.progress, episode.progress)) {
      if (!equal(was.progress, incoming.progress) && !equal(episode.progress, incoming.progress)) return null;
      if (Object.hasOwn(episode, "progress")) incoming.progress = episode.progress;
      else delete incoming.progress;
    }
    if (Object.hasOwn(episode, "progress")) was.progress = episode.progress;
    else delete was.progress;
  }
  for (const prior of base.episodes) {
    if (local.episodes.some(item => item.fileIndex === prior.fileIndex)) continue;
    const incoming = next.episodes.find(item => item.fileIndex === prior.fileIndex);
    if (incoming && !equal(prior, incoming)) return null;
    expected.episodes = expected.episodes.filter(item => item.fileIndex !== prior.fileIndex);
    next.episodes = next.episodes.filter(item => item.fileIndex !== prior.fileIndex);
  }
  for (const key of ["lastPlayedAt", "lastPlayedFileIndex"]) {
    if (Object.hasOwn(local, key)) expected[key] = local[key];
    else delete expected[key];
  }
  // A Library title can be renamed while a different device watches or
  // unwatches a chapter. Compare field ownership to the *confirmed* base:
  // preserve remote fields we never edited, and never select a winner for a
  // genuinely competing edit to the same field. Episode identity/structure
  // remains strict; watched flags, their timestamps and author are one unit.
  const sameField = (a, b, key) => Object.hasOwn(a, key) === Object.hasOwn(b, key)
    && (!Object.hasOwn(a, key) || equal(a[key], b[key]));
  const applyOwned = (keys) => {
    if (!keys.some(key => !sameField(base, local, key))) return true;
    const remoteChanged = keys.some(key => !sameField(base, remote, key));
    if (remoteChanged && keys.some(key => !sameField(local, remote, key))) return false;
    for (const key of keys) {
      if (Object.hasOwn(local, key)) {
        expected[key] = local[key];
        next[key] = local[key];
      } else {
        delete expected[key];
        delete next[key];
      }
    }
    return true;
  };
  // Names and their stable series grouping describe one semantic rename.
  // A competing partial rename is not two safe independent edits.
  const titleFields = ["title", "displayTitle", "seriesKey"];
  if (!applyOwned(titleFields)) return null;
  // Title-level watched state is an explicit user choice. A different tab
  // may update the poster or chapter while this tab marks the title watched.
  // Preserve both when independent, but refuse competing changes to the mark.
  if (!applyOwned(["watchedTitleAt"])) return null;
  // A poster pin selects a particular image, not just a boolean. Changes to
  // its URL, source, index and pinned state must be compared as one selection.
  const artworkFields = ["coverUrl", "artworkSource", "artworkIndex", "artworkPinned"];
  if (!applyOwned(artworkFields)) return null;
  // A catalog rematch can keep the same torrent infoHash but change which
  // title the Library represents. A verified AniList link is authorized for
  // the catalog that was visible when the association was made; never attach
  // an independently added old-catalog link to a new catalog identity.
  const identityFields = ["catalogId", "catalogType", "mediaKind", "magnet", "rawName",
    "sourceMeta", "externalSource", "externalId"];
  const mappingFields = ["anilist", "anilistSync", "anilistManualLinks",
    "anilistAutoLinks", "anilistImported"];
  const edited = (a, b, keys) => keys.some(key => !sameField(a, b, key));
  // A catalog rematch changes the identity under which a chapter was
  // verified. Do not transfer a concurrent old-catalog watched choice,
  // playback timestamp, or source-episode edit into the new catalog.
  const watchedFields = ["watchedChapters", "watchedChapterUpdatedAt", "watchedChapterOrigins",
    "watchedChapterSyncStamps", "watchedChapterReplicas", "watchedTitleAt"];
  const changedChapterOrSource = (a, b) =>
    edited(a, b, watchedFields) || !sameField(a, b, "episodes")
      || edited(a, b, ["lastPlayedAt", "lastPlayedFileIndex"]);
  if ((edited(base, local, identityFields) && edited(base, remote, mappingFields))
    || (edited(base, remote, identityFields) && edited(base, local, mappingFields))
    || (edited(base, local, identityFields) && changedChapterOrSource(base, remote))
    || (edited(base, remote, identityFields) && changedChapterOrSource(base, local))) return null;
  if (!applyOwned(identityFields) || !applyOwned(mappingFields)) return null;
  // Only understood, independent presentation fields may be rebased one at a
  // time. Any other local metadata edit remains subject to the old strict
  // comparison below, rather than inventing field independence for it.
  for (const key of ["description", "releaseInfo"]) if (!applyOwned([key])) return null;
  // updatedAt is the entry's modification clock, not authorization to win a
  // conflict. Concurrent disjoint edits may both advance it; retain the newer
  // clock only after the semantic fields have independently passed comparison.
  if (!sameField(base, local, "updatedAt")) {
    if (!sameField(base, remote, "updatedAt") && !sameField(local, remote, "updatedAt")) {
      if (!Number.isSafeInteger(local.updatedAt) || !Number.isSafeInteger(remote.updatedAt)
        || local.updatedAt < 0 || remote.updatedAt < 0) return null;
      next.updatedAt = Math.max(local.updatedAt, remote.updatedAt);
    } else if (Object.hasOwn(local, "updatedAt")) next.updatedAt = local.updatedAt;
    else delete next.updatedAt;
    if (Object.hasOwn(local, "updatedAt")) expected.updatedAt = local.updatedAt;
    else delete expected.updatedAt;
  }
  // No unrecognized local episode identity mutation or structural rewrite may
  // slip through the explicit field and per-chapter ownership checks above.
  if (!equal(expected, local)) return null;
  if (Number(local.lastPlayedAt || 0) >= Number(remote.lastPlayedAt || 0))
    for (const key of ["lastPlayedAt", "lastPlayedFileIndex"])
      if (Object.hasOwn(local, key)) next[key] = local[key];
  return next;
}

function rebasePersistentLibrary(base, local, remote) {
  // Proven playback and disjoint episode edits can cross incoming changes.
  // Competing edits and deletions retain their conflict checks.
  if (![base, local, remote].every(Array.isArray)) return null;
  const index = items => new Map(items.filter(item => item && item.id != null)
    .map(item => [String(item.id), item]));
  const before = index(base);
  const current = index(local);
  const disk = index(remote);
  const equal = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const changes = new Map();
  for (const id of new Set([...before.keys(), ...current.keys()])) {
    const was = before.get(id), mine = current.get(id), theirs = disk.get(id);
    if (equal(was, mine)) continue;
    if (!equal(was, theirs) && !equal(mine, theirs)) {
      const playback = rebasePersistentPlayback(was, mine, theirs);
      if (!playback) return null;
      changes.set(id, playback);
    } else changes.set(id, mine);
  }
  const updated = new Map(disk);
  for (const [id, item] of changes) {
    if (item === undefined) updated.delete(id);
    else updated.set(id, item);
  }
  if (updated.size > 5_000) return null;
  return copyPersistentLibrary([...updated.values()]);
}

export function saveState() {
  storeLocalCopy("blackline-cards", state.cards);
  storeLocalCopy("blackline-known", [...state.known]);
  persistAppSection("cards", state.cards);
  persistAppSection("known", [...state.known]);
}

export function saveTestResults() {
  state.testResults = state.testResults.slice(-500);
  storeLocalCopy("blackline-test-results", state.testResults);
  persistAppSection("testResults", state.testResults);
}

function persistentPreferencesSnapshot() {
  return {
    ...legacyPreferencesSnapshot(),
    subdlKey: String(state.subdlKey || ""),
    wyzieKey: String(state.wyzieKey || ""),
    subsourceKey: String(state.subsourceKey || ""),
    baseLanguage: String(state.baseLanguage || "EN"),
    targetLanguage: String(state.targetLanguage || "ES"),
    baseLocale: state.baseLocale,
    targetLocale: state.targetLocale,
    interfaceLanguage: state.interfaceLanguage,
    subtitleStyle: { ...state.subtitleStyle },
  };
}

function persistentAppSnapshot() {
  return {
    cards: state.cards,
    known: [...state.known],
    library: state.library,
    learningExposure: state.learningExposure,
    testResults: state.testResults,
    coachTranscripts: state.coachTranscripts,
    preferences: persistentPreferencesSnapshot(),
  };
}

function persistBlockedLibraryChange(section, submittedValue, generation) {
  // Legacy/contested dirty data cannot be safely auto-merged. However, a
  // *subsequent* user edit has a known before/after in this running tab. Replay
  // only that new delta, and keep the older unresolved data visibly dirty.
  const previousWrite = persistentAppWriteChains.get(section) || Promise.resolve();
  const currentWrite = previousWrite.catch(() => {}).then(async () => {
    if (persistentAppWriteGenerations.get(section) !== generation) return;
    const before = persistentAppConflictViewBaselines.get(section);
    if (!before || JSON.stringify(before) === JSON.stringify(submittedValue)) return;
    const disk = await fetchJson("/api/app-state/library");
    if (persistentAppWriteGenerations.get(section) !== generation) return;
    const rebased = rebasePersistentLibrary(before, submittedValue, disk?.value);
    if (!rebased || !Number.isSafeInteger(disk?.updatedAt)) {
      console.warn("The new Library edit also conflicts with another tab; all unsaved changes remain in the browser.");
      return;
    }
    try {
      const result = await postJson("/api/app-state/library", {
        value: rebased, merge: false, expectedUpdatedAt: disk.updatedAt,
      });
      // Even a successful disjoint delta is NOT a successful save of the
      // contested whole Library; never certify its stale visible snapshot.
      invalidatePersistentLibraryReplay();
      if (Number.isFinite(Number(result?.updatedAt)))
        persistentAppSectionRevisions.set(section, Number(result.updatedAt));
      persistentAppAcceptedSnapshots.set(section, copyPersistentLibrary(rebased));
      if (persistentAppWriteGenerations.get(section) === generation)
        persistentAppConflictViewBaselines.set(section, copyPersistentLibrary(submittedValue));
      // Do NOT clear the original conflict flag/dirty marker or replace the
      // visible Library: its earlier unresolved edits still need attention.
    } catch (error) {
      if (error?.status !== 409 || error?.data?.error !== "app_state_conflict") throw error;
      console.warn("Library changed during the safe edit retry; leaving pending local changes untouched.");
    }
  }).catch(error => console.warn("Library conflict recovery failed:", error))
    .finally(() => {
      if (persistentAppWriteChains.get(section) === currentWrite) persistentAppWriteChains.delete(section);
    });
  persistentAppWriteChains.set(section, currentWrite);
}

export function persistAppSection(section, value, { immediate = false, merge = false } = {}) {
  const mode = merge ? "merge" : "replace";
  // The pop-up player window saves nothing: LVL's window does (no second writer, no conflicts).
  if (typeof POPUP_HANDOFF !== "undefined" && POPUP_HANDOFF) return;
  if (section === "library" && !merge) persistentAppOwnPendingSections.add(section);
  const generation = (persistentAppWriteGenerations.get(section) || 0) + 1;
  persistentAppWriteGenerations.set(section, generation);
  if (section === "library" && !merge) preservePendingLibraryForTab(value);
  setPersistentSectionDirty(section, true, mode);
  if (!persistentAppStateReady) return;
  // A contested same-title edit cannot be safely auto-resolved. Subsequent
  // local edits remain in the browser's unsaved copy, not forced into SQLite.
  const submittedValue = section === "library" ? copyPersistentLibrary(value) : value;
  const libraryViewBaseAtGeneration = section === "library" && !merge
    ? (typeof persistentAppLibraryViewBaseline !== "undefined" && Array.isArray(persistentAppLibraryViewBaseline)
      ? copyPersistentLibrary(persistentAppLibraryViewBaseline)
      : (typeof persistentAppAcceptedSnapshots !== "undefined"
        && Array.isArray(persistentAppAcceptedSnapshots.get(section))
        ? copyPersistentLibrary(persistentAppAcceptedSnapshots.get(section)) : null))
    : null;
  if (typeof persistentAppUnresolvedConflicts !== "undefined"
    && persistentAppUnresolvedConflicts.has(section)) {
    if (section === "library" && !merge) {
      invalidatePersistentLibraryReplay();
      persistBlockedLibraryChange(section, submittedValue, generation);
    }
    return;
  }
  const previous = persistentAppWriteTimers.get(section);
  if (previous) clearTimeout(previous);
  const commit = () => {
    persistentAppWriteTimers.delete(section);
    const previousWrite = persistentAppWriteChains.get(section) || Promise.resolve();
    const currentWrite = previousWrite
      .catch(() => {})
      .then(async () => {
        // A newer in-tab edit supersedes this queued payload; do not replay an
        // older generation over its newer content after another tab's update.
        if (persistentAppWriteGenerations.get(section) !== generation
          || (typeof persistentAppUnresolvedConflicts !== "undefined"
            && persistentAppUnresolvedConflicts.has(section))) return null;
        const pending = persistentDirtySections().get(section);
        // localStorage dirty metadata is shared across tabs: its revision can
        // belong to ANOTHER writer. Only a revision verified by this tab's own
        // read or successful CAS is safe as a replacement precondition.
        const expectedUpdatedAt = PERSISTENT_CAS_SECTIONS.has(section) && !merge
          ? persistentAppSectionRevisions.get(section) ?? null
          : undefined;
        if (PERSISTENT_CAS_SECTIONS.has(section) && !merge && expectedUpdatedAt == null)
          throw new Error(`Persistent ${section} is waiting for its SQLite base revision; replacement not sent.`);
        const endpoint = `/api/app-state/${encodeURIComponent(section)}`;
        const write = (payloadValue, expected) => postJson(endpoint, {
          value: payloadValue, merge, expectedUpdatedAt: expected,
        });
        let candidate = submittedValue;
        let confirmedBaseForRetry = null;
        if (section === "library" && !merge
          && typeof persistentAppAcceptedSnapshots !== "undefined") {
          const confirmed = persistentAppAcceptedSnapshots.get(section);
          // A preceding generation may have successfully rebased onto another
          // tab's additions while our visible state still lacks those entries.
          // Use the view's captured baseline, not the newly advanced SQLite
          // revision, to prove what THIS generation actually changed.
          const effectiveBase = applyUnreflectedPersistentLibraryWrites(libraryViewBaseAtGeneration);
          if (!Array.isArray(effectiveBase) || !Array.isArray(confirmed)
            || !(candidate = rebasePersistentLibrary(effectiveBase, submittedValue, confirmed))) {
            persistentAppUnresolvedConflicts.add(section);
            invalidatePersistentLibraryReplay();
            persistentAppConflictViewBaselines.set(section, copyPersistentLibrary(submittedValue));
            alertPersistentLibraryConflict();
            console.warn("Library changed while an earlier save completed. The pending edit was kept without overwriting another tab.");
            return null;
          }
          confirmedBaseForRetry = copyPersistentLibrary(confirmed);
        }
        try {
          return { result: await write(candidate, expectedUpdatedAt), savedValue: candidate };
        } catch (error) {
          if (section !== "library" || merge || error?.status !== 409
            || error?.data?.error !== "app_state_conflict") throw error;
          // Only an exact three-way comparison can prove the replacement safe.
          // Never treat the revision returned in 409 as permission to force-write.
          const disk = await fetchJson("/api/app-state/library");
          if (persistentAppWriteGenerations.get(section) !== generation) return null;
          const baseline = confirmedBaseForRetry;
          const rebased = rebasePersistentLibrary(baseline, candidate, disk?.value);
          if (!rebased || !Number.isSafeInteger(disk?.updatedAt)) {
            if (typeof persistentAppUnresolvedConflicts !== "undefined")
              persistentAppUnresolvedConflicts.add(section);
            invalidatePersistentLibraryReplay();
            if (typeof persistentAppConflictViewBaselines !== "undefined")
              persistentAppConflictViewBaselines.set(section, copyPersistentLibrary(submittedValue));
            alertPersistentLibraryConflict();
            console.warn("Library changed in another tab. Your unsaved changes were preserved; conflicting titles were not overwritten.");
            return null;
          }
          try {
            // Exactly one retry, atomically CAS against the snapshot compared.
            return { result: await write(rebased, disk.updatedAt), savedValue: rebased };
          } catch (retryError) {
            if (retryError?.status === 409 && retryError?.data?.error === "app_state_conflict") {
              // A second CAS revision mismatch is a transport race, not
              // automatically a collision between watched choices. Check the
              // newly persisted snapshot once, then leave a safe disjoint
              // delta pending for the bounded timer/manual retry path.
              const latest = await fetchJson("/api/app-state/library");
              if (persistentAppWriteGenerations.get(section) !== generation) return null;
              if (Number.isSafeInteger(latest?.updatedAt)
                && rebasePersistentLibrary(disk.value, rebased, latest?.value)) {
                invalidatePersistentLibraryReplay();
                persistentAppRetryAfter.set(section, Date.now() + 10_000);
                console.warn("Library changed again during a safe edit. Retrying after a short delay.");
                return null;
              }
              if (typeof persistentAppUnresolvedConflicts !== "undefined")
                persistentAppUnresolvedConflicts.add(section);
              invalidatePersistentLibraryReplay();
              if (typeof persistentAppConflictViewBaselines !== "undefined")
                persistentAppConflictViewBaselines.set(section, copyPersistentLibrary(submittedValue));
              alertPersistentLibraryConflict();
              console.warn("Library changed again during recovery. Your unsaved changes were preserved.");
              return null;
            }
            throw retryError;
          }
        }
      })
      .then((completed) => {
        if (!completed) return;
        const { result, savedValue } = completed;
        persistentAppRetryAfter.delete(section);
        if (Number.isFinite(Number(result?.updatedAt))) persistentAppSectionRevisions.set(section, Number(result.updatedAt));
        if (section === "library" && typeof persistentAppAcceptedSnapshots !== "undefined")
          persistentAppAcceptedSnapshots.set(section, copyPersistentLibrary(savedValue));
        if (persistentAppWriteGenerations.get(section) === generation) {
          if (section === "library") {
            persistentAppPartialLibrarySaves.delete(section);
            state.library = copyPersistentLibrary(savedValue);
            if (typeof persistentAppLibraryViewBaseline !== "undefined")
              persistentAppLibraryViewBaseline = copyPersistentLibrary(savedValue);
            persistentAppLibraryViewRevision = persistentAppSectionRevisions.get("library") ?? null;
            if (typeof persistentAppUnreflectedLibraryWrites !== "undefined")
              persistentAppUnreflectedLibraryWrites.clear();
            if (typeof storeLocalCopy === "function") storeLocalCopy("blackline-library", state.library);
            clearPendingLibraryForTab();
            if (typeof renderLibrary === "function" && typeof viewActive === "function" && viewActive("library"))
              renderLibrary();
            // A successful revision-bound retry may have merged a remote
            // watched change into this tab's local title edit. The visible
            // Library state is now current, so repaint whichever chapter view
            // is open rather than leaving its pre-ACK watched marks stale.
            if (viewActive("title")) refreshTitlePage();
            if (viewActive("watch")) renderWatchChapters();
          }
          setPersistentSectionDirty(section, false);
        }
        else {
          if (section === "library") {
            // The old ACK advances our verified DB revision but does not
            // refresh the newer generation's stale visible Library. No
            // subsequent crash replay may promote that view to a full-CAS
            // snapshot, even if another save captures the new revision.
            invalidatePersistentLibraryReplay();
            if (typeof persistentAppUnreflectedLibraryWrites !== "undefined")
              recordUnreflectedPersistentLibraryWrite(libraryViewBaseAtGeneration, submittedValue, savedValue);
          }
          const pending = persistentDirtySections().get(section);
          if (pending) setPersistentSectionDirty(section, true, pending.mode, result?.updatedAt);
        }
      })
      .catch((error) => {
        if (section === "library" && !persistentAppUnresolvedConflicts.has(section))
          persistentAppRetryAfter.set(section, Date.now() + 10_000);
        console.warn(`Persistent ${section} save failed:`, error);
      })
      .finally(() => {
        if (persistentAppWriteChains.get(section) === currentWrite) persistentAppWriteChains.delete(section);
      });
    persistentAppWriteChains.set(section, currentWrite);
  };
  const delay = section === "learningExposure" ? 500 : 0;
  if (immediate || delay === 0) commit();
  else persistentAppWriteTimers.set(section, setTimeout(commit, delay));
}

export function persistPreferences({ immediate = false } = {}) {
  persistAppSection("preferences", persistentPreferencesSnapshot(), { immediate });
}

function mirrorPersistentPreferencesToLocalStorage(preferences) {
  const prefs = preferences && typeof preferences === "object" ? preferences : {};
  localStorage.setItem("blackline-subdl-key", String(prefs.subdlKey || ""));
  localStorage.setItem("blackline-wyzie-key", String(prefs.wyzieKey || ""));
  localStorage.setItem("blackline-subsource-key", String(prefs.subsourceKey || ""));
  localStorage.setItem("blackline-base-language", String(prefs.baseLanguage || "EN"));
  localStorage.setItem("blackline-target-language", String(prefs.targetLanguage || "ES"));
  localStorage.setItem("blackline-base-locale", normalizeLearningLocale(prefs.baseLanguage, prefs.baseLocale));
  localStorage.setItem("blackline-target-locale", normalizeLearningLocale(prefs.targetLanguage, prefs.targetLocale));
  localStorage.setItem("blackline-interface-language", ["en", "es"].includes(prefs.interfaceLanguage) ? prefs.interfaceLanguage : "auto");
  localStorage.setItem("blackline-subdl-languages", [prefs.targetLanguage || "ES", prefs.baseLanguage || "EN"].join(","));
  localStorage.setItem("blackline-subtitle-style", JSON.stringify(prefs.subtitleStyle || subtitleStyleDefaults));
}

function applyPersistentAppState(snapshot = {}) {
  if (Array.isArray(snapshot.cards)) state.cards = snapshot.cards.slice(0, 20_000);
  if (Array.isArray(snapshot.known)) state.known = new Set(snapshot.known.map(String).slice(0, 100_000));
  if (Array.isArray(snapshot.library)) state.library = snapshot.library.slice(0, 5_000);
  if (snapshot.learningExposure && typeof snapshot.learningExposure === "object" && !Array.isArray(snapshot.learningExposure)) {
    state.learningExposure = snapshot.learningExposure;
  }
  if (Array.isArray(snapshot.testResults)) state.testResults = snapshot.testResults.slice(-500);
  if (Array.isArray(snapshot.coachTranscripts)) state.coachTranscripts = snapshot.coachTranscripts.slice(-100);
  const prefs = snapshot.preferences && typeof snapshot.preferences === "object" && !Array.isArray(snapshot.preferences) ? snapshot.preferences : null;
  if (prefs) {
    preserveLegacyPreferences(prefs);
    state.subdlKey = String(prefs.subdlKey || "");
    state.wyzieKey = String(prefs.wyzieKey || "");
    state.subsourceKey = String(prefs.subsourceKey || "");
    state.baseLanguage = String(prefs.baseLanguage || "EN").toUpperCase();
    state.targetLanguage = String(prefs.targetLanguage || "ES").toUpperCase();
    state.baseLocale = normalizeLearningLocale(state.baseLanguage, prefs.baseLocale);
    state.targetLocale = normalizeLearningLocale(state.targetLanguage, prefs.targetLocale);
    state.interfaceLanguage = ["en", "es"].includes(prefs.interfaceLanguage) ? prefs.interfaceLanguage : "auto";
    uiLanguage.setLanguage(state.interfaceLanguage, state.baseLanguage);
    state.subtitleStyle = { ...subtitleStyleDefaults, ...(prefs.subtitleStyle || {}) };
    mirrorPersistentPreferencesToLocalStorage(prefs);
  }
  storeLocalCopy("blackline-cards", state.cards);
  storeLocalCopy("blackline-known", [...state.known]);
  storeLocalCopy("blackline-library", state.library);
  storeLocalCopy("blackline-learning-exposure", state.learningExposure);
  storeLocalCopy("blackline-test-results", state.testResults);
  storeLocalCopy("blackline-coach-transcripts", state.coachTranscripts);
}

export async function hydratePersistentAppState() {
  // Unsaved changes of a section whose browser copy didn't fit can't be recovered from that copy
  // (it holds nothing): keep the database's version instead of replacing it with an empty one.
  for (const key of localCopyUnloaded) {
    const section = LOCAL_COPY_SECTIONS[key];
    if (section && persistentDirtySections().has(section)) {
      console.warn(`Unsaved ${section} changes from the last visit weren't kept in the browser; using the saved copy.`);
      setPersistentSectionDirty(section, false);
    }
  }
  // A shared-origin tab may have replaced localStorage's Library cache while
  // this tab still owned unsaved edits. Prefer this tab's pending shadow.
  let tabPendingRevision = null;
  let tabPendingSafeToReplay = false;
  let tabPendingValue = null;
  try {
    if (typeof sessionStorage !== "undefined") {
      const pending = sessionStorage.getItem(APP_DB_TAB_LIBRARY_PENDING_KEY);
      if (pending) {
        const parsed = JSON.parse(pending);
        const candidate = Array.isArray(parsed) ? parsed : parsed?.value;
        if (Array.isArray(candidate)) {
          tabPendingValue = copyPersistentLibrary(candidate);
          persistentAppOwnPendingSections.add("library");
          tabPendingRevision = Number.isSafeInteger(parsed?.expectedUpdatedAt)
            ? parsed.expectedUpdatedAt : null;
          tabPendingSafeToReplay = parsed?.safeToReplay === true
            && tabPendingRevision !== null
            && parsed?.certifiedBaseRevision === tabPendingRevision;
          state.library = copyPersistentLibrary(candidate);
        }
      }
    }
  } catch {}
  const localSnapshot = persistentAppSnapshot();
  // persistentAppSnapshot exposes live array references. Capture the actual
  // pre-hydration Library contents now, before a user can unshift a new title
  // into that same array while bootstrap is waiting on SQLite.
  const originalLibraryBaseline = JSON.parse(JSON.stringify(localSnapshot.library || []));
  const alreadyMigrated = localStorage.getItem(APP_DB_MIGRATION_KEY) === "1";
  try {
    let payload = await postJson("/api/app-state/bootstrap", { legacyState: alreadyMigrated ? null : localSnapshot });
    if (!payload.initialized && alreadyMigrated) {
      payload = await postJson("/api/app-state/bootstrap", { legacyState: localSnapshot });
    }
    applyPersistentSectionRevisions(payload?.revisions);
    const attemptedRecovery = new Set();
    while (true) {
      const dirtySections = persistentDirtySections();
      const next = [...dirtySections.entries()].find(([section, entry]) => {
        const generation = persistentAppWriteGenerations.get(section) || 0;
        return !attemptedRecovery.has(`${section}:${entry.mode}:${entry.expectedUpdatedAt ?? "none"}:${generation}`);
      });
      if (!next) break;
      const [section, entry] = next;
      const mode = entry.mode;
      const generation = persistentAppWriteGenerations.get(section) || 0;
      attemptedRecovery.add(`${section}:${mode}:${entry.expectedUpdatedAt ?? "none"}:${generation}`);
      const recoverySnapshot = persistentAppSnapshot();
      if (!Object.prototype.hasOwnProperty.call(recoverySnapshot, section)) continue;
      if (section === "library" && mode !== "merge") {
        // Across app restarts we have no trustworthy *pre-edit* Library base.
        // A stale whole-section CAS must not resurrect titles another tab
        // deleted. Keep the local snapshot dirty until a safe base is known.
        continue;
      }
      if (PERSISTENT_CAS_SECTIONS.has(section) && mode !== "merge" && entry.expectedUpdatedAt == null) {
        // A Library item added during this very hydration is reconciled with
        // the freshly loaded disk list below, once its CAS revision is known.
        if (section !== "library" || generation === 0)
          console.warn(`Persistent ${section} recovery is waiting for conflict resolution because its legacy dirty snapshot has no base revision.`);
        continue;
      }
      try {
        const recoveryResult = await postJson(`/api/app-state/${encodeURIComponent(section)}`, {
          value: recoverySnapshot[section],
          merge: mode === "merge",
          expectedUpdatedAt: PERSISTENT_CAS_SECTIONS.has(section) && mode !== "merge"
            ? entry.expectedUpdatedAt
            : undefined,
        });
        if (Number.isFinite(Number(recoveryResult?.updatedAt))) persistentAppSectionRevisions.set(section, Number(recoveryResult.updatedAt));
        if ((persistentAppWriteGenerations.get(section) || 0) === generation
          && persistentDirtySections().get(section)?.mode === mode) {
          setPersistentSectionDirty(section, false);
        } else {
          const pending = persistentDirtySections().get(section);
          if (pending) setPersistentSectionDirty(section, true, pending.mode, recoveryResult?.updatedAt);
        }
      } catch (error) {
        console.warn(`Persistent ${section} recovery save failed:`, error);
      }
    }
    if (localStorage.getItem(APP_DB_PREFERENCES_MIGRATION_KEY) !== "1"
      && !persistentDirtySections().has("preferences")) {
      try {
        const preferenceMigration = await postJson("/api/app-state/preferences", {
          value: persistentPreferencesSnapshot(),
          merge: true,
        });
        if (Number.isFinite(Number(preferenceMigration?.updatedAt))) persistentAppSectionRevisions.set("preferences", Number(preferenceMigration.updatedAt));
        localStorage.setItem(APP_DB_PREFERENCES_MIGRATION_KEY, "1");
      } catch (error) {
        console.warn("Persistent preference backfill failed:", error);
      }
    }
    payload = await fetchJson("/api/app-state");
    applyPersistentSectionRevisions(payload?.revisions);
    if (tabPendingValue && tabPendingSafeToReplay && tabPendingRevision !== null
      && (persistentAppWriteGenerations.get("library") || 0) === 0
      && Number(payload?.revisions?.library) === tabPendingRevision) {
      // An interrupted PUT can be safely retried ONLY if SQLite still has the
      // exact revision previously verified by this tab. A concurrent write
      // causes 409 and is NEVER replaced with a later revision.
      try {
        const recovered = await postJson("/api/app-state/library", {
          value: tabPendingValue, merge: false, expectedUpdatedAt: tabPendingRevision,
        });
        if (Number.isFinite(Number(recovered?.updatedAt))) {
          payload.state.library = copyPersistentLibrary(tabPendingValue);
          payload.revisions.library = Number(recovered.updatedAt);
          persistentAppSectionRevisions.set("library", Number(recovered.updatedAt));
          // A user may edit during the network round trip. Do not discard the
          // newer generation or its tab-local shadow when the old PUT returns.
          if ((persistentAppWriteGenerations.get("library") || 0) === 0) {
            clearPendingLibraryForTab();
            setPersistentSectionDirty("library", false);
          }
        }
      } catch (error) {
        // The submitted data stays in sessionStorage and the visible Library.
        console.warn("An unsaved Library change could not be restored automatically:", error);
      }
    }
    if (Array.isArray(payload?.state?.library) && typeof persistentAppAcceptedSnapshots !== "undefined")
      persistentAppAcceptedSnapshots.set("library", copyPersistentLibrary(payload.state.library));
    if (Array.isArray(payload?.state?.library) && typeof persistentAppLibraryViewBaseline !== "undefined")
      persistentAppLibraryViewBaseline = copyPersistentLibrary(payload.state.library);
    if (typeof persistentAppUnreflectedLibraryWrites !== "undefined")
      persistentAppUnreflectedLibraryWrites.clear();
    const remainingDirty = persistentDirtySections();
    const earlySaveSections = [];
    if (remainingDirty.size && payload?.state && typeof payload.state === "object") {
      const localOverlay = persistentAppSnapshot();
      for (const [section, dirty] of remainingDirty) {
        if (!Object.prototype.hasOwnProperty.call(localOverlay, section)) continue;
        if (section === "library"
          && (persistentAppWriteGenerations.get(section) || 0) > 0
          && persistentAppSectionRevisions.has(section)) {
          const rebased = rebasePersistentLibrary(originalLibraryBaseline, localOverlay.library, payload.state.library);
          if (rebased) {
            payload.state.library = rebased;
            setPersistentSectionDirty(section, true, "replace", persistentAppSectionRevisions.get(section));
            earlySaveSections.push(section);
          } else {
            // Ambiguous edits during bootstrap must remain visible/unsaved;
            // never silently submit them against the new disk revision.
            if (typeof persistentAppUnresolvedConflicts !== "undefined")
              persistentAppUnresolvedConflicts.add("library");
            invalidatePersistentLibraryReplay();
            if (typeof persistentAppConflictViewBaselines !== "undefined")
              persistentAppConflictViewBaselines.set("library", copyPersistentLibrary(localOverlay.library));
            alertPersistentLibraryConflict();
            payload.state.library = localOverlay.library;
          }
        } else if (section === "library") {
          if (sameLibraryContent(localOverlay.library, payload.state.library)) {
            // A previous window may have crashed after SQLite accepted its
            // PUT but before clearing its tab shadow. There is no remaining
            // unsaved intent once the disk has the exact same Library.
            clearPendingLibraryForTab();
            persistentAppPartialLibrarySaves.delete("library");
            setPersistentSectionDirty("library", false);
            continue;
          }
          // Legacy dirty data may include an item already removed by another
          // tab. Preserve local intent without retrying an unprovable replace.
          if (typeof persistentAppUnresolvedConflicts !== "undefined")
            persistentAppUnresolvedConflicts.add("library");
          invalidatePersistentLibraryReplay();
          if (typeof persistentAppConflictViewBaselines !== "undefined")
            persistentAppConflictViewBaselines.set("library", copyPersistentLibrary(localOverlay.library));
          alertPersistentLibraryConflict();
          payload.state.library = localOverlay.library;
        } else payload.state[section] = localOverlay[section];
      }
    }
    if (payload?.state && typeof payload.state === "object") applyPersistentAppState(payload.state);
    persistentAppLibraryViewRevision = !persistentDirtySections().has("library")
      && sameLibraryContent(state.library, persistentAppAcceptedSnapshots.get("library"))
      ? persistentAppSectionRevisions.get("library") ?? null : null;
    persistentAppStateReady = true;
    for (const section of earlySaveSections) persistAppSection(section, persistentAppSnapshot()[section], { immediate: true });
    if (localCopyUnloaded.size) {
      localCopyUnloaded.clear();
      storeLocalCopy("blackline-cards", state.cards);
      storeLocalCopy("blackline-library", state.library);
    }
    localStorage.setItem(APP_DB_MIGRATION_KEY, "1");
    renderAll();
    applySubtitleStyle();
  } catch (error) {
    console.warn("On-disk app database is unavailable; using the browser cache for this session:", error);
    renderAll();
  }
}

// Refresh a confirmed server revision without reloading the app or saving a stale
// browser snapshot back over it. Pending edits keep their existing CAS workflow.
export async function refreshPersistentLibrary({ revision } = {}) {
  if (persistentAppRetryAfter.has("library") && Date.now() >= persistentAppRetryAfter.get("library")
    && persistentAppStateReady && !POPUP_HANDOFF && hasPendingLibraryForTab()
    && !persistentAppUnresolvedConflicts.has("library")
    && !persistentAppWriteChains.has("library") && !persistentAppWriteTimers.has("library")) {
    persistentAppRetryAfter.set("library", Date.now() + 10_000);
    persistAppSection("library", state.library, { immediate: true });
  }
  const blocked = () => !persistentAppStateReady || POPUP_HANDOFF
    || persistentAppOwnPendingSections.has("library") || hasPendingLibraryForTab()
    || persistentAppWriteTimers.has("library")
    || persistentAppWriteChains.has("library") || persistentAppUnresolvedConflicts.has("library");
  if (blocked() || !Number.isSafeInteger(revision)) return false;
  // Only an applied revision proves the window is current. An acknowledged
  // SQLite write may be newer than the view when another local edit is queued.
  const appliedRevision = persistentAppLibraryViewRevision ?? 0;
  if (revision <= appliedRevision) return true;
  const generation = persistentAppWriteGenerations.get("library") || 0;
  const visible = copyPersistentLibrary(state.library);
  const disk = await fetchJson("/api/app-state/library");
  if (blocked() || generation !== (persistentAppWriteGenerations.get("library") || 0)
    || !sameLibraryContent(visible, state.library) || !Array.isArray(disk?.value)
    || !Number.isSafeInteger(disk.updatedAt) || disk.updatedAt < revision
    || disk.updatedAt <= appliedRevision) return false;
  const baseline = persistentAppLibraryViewBaseline;
  const next = copyPersistentLibrary(disk.value);
  if (!sameLibraryContent(visible, baseline)) {
    // Playback updates its in-memory position between database saves. Preserve
    // that one episode while accepting flags/metadata for the rest of Library.
    // Any other unconfirmed edit defers the refresh instead of guessing intent.
    const source = state.currentSource;
    const mine = visible.find(item => item.id === source?.libraryId);
    const old = baseline?.find(item => item.id === source?.libraryId);
    const incoming = next.find(item => item.id === source?.libraryId);
    const current = mine?.episodes?.find(item => Number(item.fileIndex) === Number(source?.fileIndex));
    const received = incoming?.episodes?.find(item => Number(item.fileIndex) === Number(source?.fileIndex));
    if (!current || !old || !received) return false;
    const expected = copyPersistentLibrary(baseline);
    const entry = expected.find(item => item.id === mine.id);
    const episode = entry.episodes.find(item => Number(item.fileIndex) === Number(source.fileIndex));
    if (!episode) return false;
    episode.progress = current.progress;
    for (const key of ["lastPlayedAt", "lastPlayedFileIndex"]) {
      if (Object.hasOwn(mine, key)) entry[key] = mine[key];
      else delete entry[key];
    }
    if (!sameLibraryContent(expected, visible)) return false;
    received.progress = current.progress;
    for (const key of ["lastPlayedAt", "lastPlayedFileIndex"])
      if (Object.hasOwn(mine, key)) incoming[key] = mine[key];
  }
  persistentAppSectionRevisions.set("library", disk.updatedAt);
  persistentAppAcceptedSnapshots.set("library", copyPersistentLibrary(disk.value));
  persistentAppLibraryViewBaseline = copyPersistentLibrary(disk.value);
  persistentAppLibraryViewRevision = disk.updatedAt;
  persistentAppUnreflectedLibraryWrites.clear();
  state.library = next;
  storeLocalCopy("blackline-library", state.library);
  if (viewActive("library")) renderLibrary();
  refreshTitlePage();
  if (viewActive("watch")) renderWatchChapters();
  return true;
}

// The Settings "Sync now" action must not snapshot SQLite while a watched
// edit is still in the browser's pending CAS write. It would publish the old
// Library and make a second device look as though the watched change vanished.
export async function flushLibraryPersistenceBeforeSync() {
  // A transient offline/503 failure left the browser's own full Library
  // intent pending, but no writer is active. Retry using the same three-way
  // CAS path before a manual account sync can publish an older disk snapshot.
  if (persistentAppStateReady && hasPendingLibraryForTab()
    && !persistentAppWriteTimers.has("library") && !persistentAppWriteChains.has("library")
    && !persistentAppUnresolvedConflicts.has("library")) {
    persistAppSection("library", state.library, { immediate: true });
  }
  const deadline = Date.now() + 8_000;
  while (persistentAppWriteChains.has("library")) {
    const pending = persistentAppWriteChains.get("library");
    let timeout = null;
    try {
      await Promise.race([
        pending,
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error("Library changes are still saving. Please retry Sync now.")),
            Math.max(1, deadline - Date.now()));
        }),
      ]);
    } finally { if (timeout !== null) clearTimeout(timeout); }
    if (Date.now() >= deadline) break;
  }
  if (!persistentAppStateReady || persistentAppWriteChains.has("library")
    || persistentAppWriteTimers.has("library") || persistentDirtySections().has("library")
    || persistentAppUnresolvedConflicts.has("library"))
    throw new Error("Library changes are still saving or require conflict resolution before Sync now.");
}

export function saveLibrary() {
  try {
    storeLocalCopy("blackline-library", state.library);
    persistAppSection("library", state.library);
  } catch (error) {
    console.warn("Library could not be saved:", error);
  }
  refreshTitlePage();
  scheduleAniListAutoSync();
}
