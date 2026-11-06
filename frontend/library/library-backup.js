// Library export and import.
import { discardedCardKeys, mergeDiscardedCardKeys } from "../app/legacy-preferences.js";
import { toast } from "../ui/ui.js";
import { state } from "../../app.js";
import { persistentAppStateReady, persistAppSection, persistPreferences, saveLibrary, saveState, saveTestResults, storeLocalCopy } from "../app/saved-state.js";
import { $ } from "../app/dom.js";
import { renderLibrary, updateLibrarySummary } from "./library-page.js";
import { renderHome } from "../home/home-page.js";

export function exportLibraryDatabase() {
  if (!persistentAppStateReady) {
    toast("Library backup is unavailable until saved data finishes loading. Try again after it reconnects.", { tone: "error" });
    return;
  }
  const payload = {
    schema: "blackline-library",
    version: 5,
    exportedAt: new Date().toISOString(),
    library: state.library,
    cards: state.cards,
    known: [...state.known],
    discardedAutoCardKeys: discardedCardKeys().slice(-20_000),
    learningExposure: state.learningExposure,
    testResults: state.testResults,
    preferences: { baseLanguage: state.baseLanguage, targetLanguage: state.targetLanguage },
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `lvl-library-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function mergeImportedLibrary(payload) {
  const incoming = Array.isArray(payload) ? payload : payload?.library;
  if (!Array.isArray(incoming)) throw new Error("This JSON file does not contain a valid Library array.");
  if (incoming.length > 5000) throw new Error("Import is too large. Maximum is 5000 Library records.");
  const byId = new Map(state.library.map((entry) => [String(entry.id), entry]));
  let added = 0;
  incoming.forEach((raw) => {
    if (!raw || typeof raw !== "object") return;
    const id = String(raw.id || "").slice(0, 400);
    const title = String(raw.displayTitle || raw.title || "").slice(0, 500);
    if (!id || !title) return;
    const safe = {
      ...raw,
      id,
      title: String(raw.title || title).slice(0, 500),
      displayTitle: title,
      magnet: typeof raw.magnet === "string" && raw.magnet.startsWith("magnet:?") ? raw.magnet.slice(0, 12000) : "",
      coverUrl: typeof raw.coverUrl === "string" ? raw.coverUrl.slice(0, 4_000_000) : "",
      episodes: Array.isArray(raw.episodes) ? raw.episodes.slice(0, 256) : [],
      aliases: Array.isArray(raw.aliases) ? raw.aliases.map(String).slice(0, 20) : [],
      addedAt: Number(raw.addedAt) || Date.now(),
      updatedAt: Number(raw.updatedAt) || Date.now(),
    };
    const current = byId.get(id);
    // Import is additive: an older backup must never silently roll back
    // watched overrides, captions, local clips, mappings or newer progress.
    byId.set(id, current ? { ...safe, ...current } : safe);
    if (!current) added += 1;
  });
  state.library = [...byId.values()];
  if (Array.isArray(payload?.cards)) {
    const cards = new Map(payload.cards.slice(0, 20_000).filter((card) => card && card.id).map((card) => [String(card.id), card]));
    for (const card of state.cards) if (card && card.id) cards.set(String(card.id), card);
    state.cards = [...cards.values()].slice(-20_000);
  }
  if (Array.isArray(payload?.known)) state.known = new Set([...state.known, ...payload.known.map(String)].slice(-100_000));
  const importedDiscarded = Array.isArray(payload?.discardedAutoCardKeys)
    ? payload.discardedAutoCardKeys
    : Array.isArray(payload?.preferences?.discardedAutoCardKeys)
      ? payload.preferences.discardedAutoCardKeys
      : [];
  if (importedDiscarded.length) {
    mergeDiscardedCardKeys(importedDiscarded);
    persistPreferences();
  }
  if (payload?.learningExposure && typeof payload.learningExposure === "object" && !Array.isArray(payload.learningExposure)) {
    const importedExposure = Object.fromEntries(Object.entries(payload.learningExposure).slice(0, 10000).map(([key, value]) => [String(key).slice(0, 500), {
      encounters: Math.max(0, Number(value?.encounters) || 0),
      media: Math.max(0, Number(value?.media) || 0),
      lastMedia: String(value?.lastMedia || "").slice(0, 1000),
      lastSeenAt: Math.max(0, Number(value?.lastSeenAt) || 0),
    }]));
    state.learningExposure = { ...importedExposure, ...state.learningExposure };
    storeLocalCopy("blackline-learning-exposure", state.learningExposure);
    persistAppSection("learningExposure", state.learningExposure, { immediate: true });
  }
  if (Array.isArray(payload?.testResults)) {
    const importedResults = payload.testResults.slice(-500).map((result) => ({
      id: String(result?.id || crypto.randomUUID()).slice(0, 200),
      mode: result?.mode === "listening" ? "listening" : "recall",
      targetLanguage: String(result?.targetLanguage || state.targetLanguage).slice(0, 12),
      score: Math.max(0, Math.min(100, Math.round(Number(result?.score) || 0))),
      correct: Math.max(0, Math.round(Number(result?.correct) || 0)),
      total: Math.max(1, Math.round(Number(result?.total) || 1)),
      startedAt: Math.max(0, Number(result?.startedAt) || 0),
      completedAt: Math.max(0, Number(result?.completedAt) || 0),
    }));
    const results = new Map(importedResults.map((result) => [result.id, result]));
    for (const result of state.testResults) if (result?.id) results.set(result.id, result);
    state.testResults = [...results.values()].slice(-500);
    saveTestResults();
  }
  saveLibrary();
  saveState();
  if ($("#view-library")?.classList.contains("is-active")) renderLibrary();
  else updateLibrarySummary();
  if (state.homeLoaded && $("#view-home")?.classList.contains("is-active")) renderHome();
  return added;
}
