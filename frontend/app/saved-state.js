// LVL's saved state: the server's copy of the app state (sections, revisions, conflicts) and the local copies it falls back on.
import { normalizeLearningLocale } from "../../shared/settings/language-settings.js";
import { learningEnabled, localCopyUnloaded, POPUP_HANDOFF, renderAll, state, uiLanguage } from "../../app.js";
import { fetchJson, postJson } from "./http.js";
import { viewActive } from "./navigation.js";
import { applySubtitleStyle, subtitleStyleDefaults } from "../player/subtitle-style.js";
import { renderLibrary } from "../library/library-page.js";
import { refreshTitlePage } from "../title/title-page.js";
import { scheduleAniListAutoSync } from "../anilist/anilist-sync.js";
import {
  applyVoicePreferences, backfillPersistedChapterAutoCards, coachProviderId, discardedAutoCardKeys,
  ensureLearningPreset, migrateLearningState, refreshVoiceUsageStatus, restoreDiscardedAutoCardKeys,
  restoreVoiceSession, reviewMode, touchLearningState, voiceAudio, voiceChat, voiceLiveAssistance,
  voiceLivePresetId, voiceUsageSegments,
} from "../learning/index.js";

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
// Successful, still-unreflected changes authored by this tab. A newer user
// edit can change the same item again while its previous CAS acknowledgment
// arrives, without confusing that prior same-tab edit with a remote conflict.
const persistentAppUnreflectedLibraryWrites = new Map();
const persistentAppUnresolvedConflicts = new Set();
const persistentAppConflictViewBaselines = new Map();
const persistentAppPartialLibrarySaves = new Set();
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
    if (committed.has(id))
      persistentAppUnreflectedLibraryWrites.set(id, { value: copyPersistentLibrary([committed.get(id)])[0] });
    else persistentAppUnreflectedLibraryWrites.set(id, { deleted: true });
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
  try { if (typeof sessionStorage !== "undefined") sessionStorage.removeItem(APP_DB_TAB_LIBRARY_PENDING_KEY); } catch {}
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
  alert.textContent = "Library changed in another tab. Some edits remain saved only here. Back them up via Library → ⋯ → Export the library before reloading. New nonconflicting changes can still be saved.";
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

function rebasePersistentLibrary(base, local, remote) {
  // Whole-record comparisons deliberately reject simultaneous edits to the
  // same entry, including a remote deletion. That may defer compatible field
  // edits, but can never resurrect a removed title or replace another tab's
  // metadata. Unrelated additions/updates/deletions are safe to replay.
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
    if (!equal(was, theirs) && !equal(mine, theirs)) return null;
    changes.set(id, mine);
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
    subdlKey: String(state.subdlKey || ""),
    wyzieKey: String(state.wyzieKey || ""),
    subsourceKey: String(state.subsourceKey || ""),
    baseLanguage: String(state.baseLanguage || "EN"),
    targetLanguage: String(state.targetLanguage || "ES"),
    baseLocale: state.baseLocale,
    targetLocale: state.targetLocale,
    interfaceLanguage: state.interfaceLanguage,
    subtitleStyle: { ...state.subtitleStyle },
    studySource: state.studySource === "preset" ? "preset" : "chapter",
    studyChapterId: String(state.studyChapterId || ""),
    studyType: state.studyType === "phrase" ? "phrase" : "word",
    studyWordTier: Number(state.studyWordTier) || 100,
    studyPhraseTier: Number(state.studyPhraseTier) || 100,
    studyFilter: String(state.studyFilter || "all"),
    wordColoring: Boolean(state.wordColoring),
    reviewMode: reviewMode === "voice" ? "voice" : "cards",
    coachProviderId: String(coachProviderId || "chatgpt-browser"),
    voiceMode: voiceChat.mode === "practice" ? "practice" : "live",
    voiceLivePresetId: String(voiceLivePresetId || "top-100"),
    voiceLiveAssistance,
    discardedAutoCardKeys: [...discardedAutoCardKeys].slice(-20_000),
    voiceAudio: { ...voiceAudio },
    voiceUsageSegments: voiceUsageSegments.slice(-256),
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
            if (retryError?.status === 409) {
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
        if (Number.isFinite(Number(result?.updatedAt))) persistentAppSectionRevisions.set(section, Number(result.updatedAt));
        if (section === "library" && typeof persistentAppAcceptedSnapshots !== "undefined")
          persistentAppAcceptedSnapshots.set(section, copyPersistentLibrary(savedValue));
        if (persistentAppWriteGenerations.get(section) === generation) {
          if (section === "library") {
            state.library = copyPersistentLibrary(savedValue);
            if (typeof persistentAppLibraryViewBaseline !== "undefined")
              persistentAppLibraryViewBaseline = copyPersistentLibrary(savedValue);
            if (typeof persistentAppUnreflectedLibraryWrites !== "undefined")
              persistentAppUnreflectedLibraryWrites.clear();
            if (typeof storeLocalCopy === "function") storeLocalCopy("blackline-library", state.library);
            clearPendingLibraryForTab();
            if (typeof renderLibrary === "function" && typeof viewActive === "function" && viewActive("library"))
              renderLibrary();
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
  localStorage.setItem("blackline-study-source", prefs.studySource === "preset" ? "preset" : "chapter");
  localStorage.setItem("blackline-study-chapter-id", String(prefs.studyChapterId || ""));
  localStorage.setItem("blackline-study-type", prefs.studyType === "phrase" ? "phrase" : "word");
  localStorage.setItem("blackline-study-word-tier", String(Number(prefs.studyWordTier) || 100));
  localStorage.setItem("blackline-study-phrase-tier", String(Number(prefs.studyPhraseTier) || 100));
  localStorage.setItem("blackline-study-filter", String(prefs.studyFilter || "all"));
  localStorage.setItem("blackline-word-coloring", prefs.wordColoring === false ? "0" : "1");
  localStorage.setItem("blackline-review-mode", prefs.reviewMode === "voice" ? "voice" : "cards");
  localStorage.setItem("blackline-coach-provider", String(prefs.coachProviderId || "chatgpt-browser"));
  localStorage.setItem("blackline-voice-mode", prefs.voiceMode === "practice" ? "practice" : "live");
  localStorage.setItem("blackline-live-preset", String(prefs.voiceLivePresetId || "top-100"));
  localStorage.setItem("blackline-live-assistance", prefs.voiceLiveAssistance === "unassisted" ? "unassisted" : "assisted");
  localStorage.setItem("blackline-discarded-auto-cards", JSON.stringify(Array.isArray(prefs.discardedAutoCardKeys) ? prefs.discardedAutoCardKeys.slice(-20_000) : [...discardedAutoCardKeys].slice(-20_000)));
  localStorage.setItem("blackline-voice-speak-replies", prefs.voiceAudio?.speakReplies === false ? "0" : "1");
  localStorage.setItem("blackline-voice-auto-continue", prefs.voiceAudio?.autoContinue === false ? "0" : "1");
  localStorage.setItem("blackline-voice-tts-uri", String(prefs.voiceAudio?.voiceURI || ""));
  localStorage.setItem("blackline-voice-tts-rate", String(Number(prefs.voiceAudio?.rate) || 0.96));
  localStorage.setItem("blackline-voice-input-language", String(prefs.voiceAudio?.inputLanguage || "auto"));
  localStorage.setItem("blackline-voice-usage", JSON.stringify(Array.isArray(prefs.voiceUsageSegments) ? prefs.voiceUsageSegments.slice(-256) : voiceUsageSegments.slice(-256)));
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
    state.studySource = "chapter";
    state.studyChapterId = String(prefs.studyChapterId || "");
    state.studyType = prefs.studyType === "phrase" ? "phrase" : "word";
    state.studyWordTier = [100, 1000, 5000].includes(Number(prefs.studyWordTier)) ? Number(prefs.studyWordTier) : 100;
    state.studyPhraseTier = [100, 1000].includes(Number(prefs.studyPhraseTier)) ? Number(prefs.studyPhraseTier) : 100;
    state.studyFilter = ["all", "unknown", "known", "review"].includes(prefs.studyFilter) ? prefs.studyFilter : "all";
    state.wordColoring = prefs.wordColoring !== false;
    applyVoicePreferences(prefs);
    restoreDiscardedAutoCardKeys(prefs.discardedAutoCardKeys);
    mirrorPersistentPreferencesToLocalStorage(prefs);
  }
  restoreVoiceSession(snapshot);
  storeLocalCopy("blackline-cards", state.cards);
  storeLocalCopy("blackline-known", [...state.known]);
  storeLocalCopy("blackline-library", state.library);
  storeLocalCopy("blackline-learning-exposure", state.learningExposure);
  storeLocalCopy("blackline-test-results", state.testResults);
  storeLocalCopy("blackline-coach-transcripts", state.coachTranscripts);
  touchLearningState();
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
    persistentAppStateReady = true;
    for (const section of earlySaveSections) persistAppSection(section, persistentAppSnapshot()[section], { immediate: true });
    if (localCopyUnloaded.size) {
      localCopyUnloaded.clear();
      storeLocalCopy("blackline-cards", state.cards);
      storeLocalCopy("blackline-library", state.library);
    }
    localStorage.setItem(APP_DB_MIGRATION_KEY, "1");
    migrateLearningState();
    backfillPersistedChapterAutoCards();
    renderAll();
    applySubtitleStyle();
    if (learningEnabled && (state.wordColoring || state.studySource === "preset")) void ensureLearningPreset(state.targetLanguage);
    if (learningEnabled) void refreshVoiceUsageStatus({ render: reviewMode === "voice" && voiceChat.mode === "live" });
  } catch (error) {
    console.warn("On-disk app database is unavailable; using the browser cache for this session:", error);
    migrateLearningState();
    backfillPersistedChapterAutoCards();
    renderAll();
  }
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
