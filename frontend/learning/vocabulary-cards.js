// Learning: a chapter's words and phrases, and their cards.
import {
  analyzePhrases, analyzeWords, formatTime, isLearningStopWord, normalizeText,
} from "../../learning/browser/core.js";
import { emptyMarkup, escapeHtml } from "../ui/ui.js";
import { isNonSpeechCue } from "../../shared/subtitles/subtitle-sync.js";
import { empty, learningEnabled, renderStats, state } from "../../app.js";
import { persistPreferences, readStorageArray, saveLibrary, saveState } from "../app/saved-state.js";
import { $, $$ } from "../app/dom.js";
import { fetchJson } from "../app/http.js";
import {
  activeSourceTag, activeTrack, currentSourceTracks, normalizeTrackLanguage, sourceTagText,
} from "../player/player-tracks.js";
import { renderSubtitles } from "../player/subtitle-display.js";
import { cueNearPlaybackMs, subtitleFingerprint, trackEffectiveOffsetAt } from "../player/subtitle-timing.js";
import { pairedBaseLines, pairingReady } from "../player/subtitle-pairing.js";
import { libraryEntryById, librarySeriesKey } from "../library/library-data.js";
import { libraryChapterName } from "../library/library-page.js";
import {
  cardKeySet, currentExposureMediaKey, isKnownItem, isMasteredItem, learningItemKey,
  learningItemKeyFor, setKnownItem, touchLearningState,
} from "./learning-state.js";
import { renderStudy, studyChapterCatalog, studyRomanizationFor } from "./study-vocabulary.js";
import { openLinePreview } from "./study-decks.js";
import { renderReview } from "./review-quiz.js";

let analysisMemo = { key: "", words: [], phrases: [] };
export const learningPresetCache = new Map();
const learningPresetRequests = new Map();

export let discardedAutoCardKeys = new Set(readStorageArray("blackline-discarded-auto-cards").map(String).filter(Boolean).slice(-20_000));

/* ---------------------------------------------------------------- Line pairing (dual subtitles, cards) */

// Per episode: the most frequent words and phrases that aren't known or carded yet.
const AUTO_CARD_WORDS_PER_EPISODE = 60;
const AUTO_CARD_PHRASES_PER_EPISODE = 20;

function getWords() {
  return currentAnalysis().words;
}

function getPhrases() {
  return currentAnalysis().phrases;
}

export function currentAnalysis() {
  const track = activeTrack();
  if (!track?.cues?.length) {
    analysisMemo = { key: "", words: [], phrases: [], wordByValue: new Map(), phraseByValue: new Map() };
    return analysisMemo;
  }
  const sourceTag = activeSourceTag();
  const fingerprint = track.fingerprint || subtitleFingerprint(track.cues);
  const key = `${track.id}|${fingerprint}|${sourceTag}`;
  if (analysisMemo.key === key) return analysisMemo;
  const language = normalizeTrackLanguage(track.language || state.targetLanguage);
  const words = analyzeWords(track.cues, { hideStopWords: true, language }).map((item) => ({ ...item, sourceTag, language, type: "word", origin: "subtitle" }));
  const phrases = analyzePhrases(track.cues, { minCount: 2, language }).map((item) => ({ ...item, sourceTag, language, type: "phrase", origin: "subtitle" }));
  analysisMemo = {
    key,
    words,
    phrases,
    wordByValue: new Map(words.map((item) => [normalizeText(item.value), item])),
    phraseByValue: new Map(phrases.map((item) => [normalizeText(item.value), item])),
  };
  return analysisMemo;
}

function normalizePresetCollection(items, type, language) {
  const seen = new Set();
  return (Array.isArray(items) ? items : []).map((raw, index) => {
    const value = String(typeof raw === "string" ? raw : raw?.value || raw?.text || "").trim();
    const normalized = normalizeText(value);
    if (!normalized || seen.has(normalized)) return null;
    seen.add(normalized);
    return {
      value,
      normalized,
      rank: Math.max(1, Number(typeof raw === "object" ? raw?.rank : 0) || index + 1),
      gloss: String(typeof raw === "object" ? raw?.gloss || raw?.meaning || "" : "").trim(),
      language,
      type,
      origin: "frequency",
      sourceTag: `COMMON ${language}`,
      deckId: `${language}:${type}`,
      occurrences: [],
      count: 0,
      scenes: 0,
    };
  }).filter(Boolean).sort((a, b) => a.rank - b.rank);
}

export async function ensureLearningPreset(language = state.targetLanguage) {
  if (!learningEnabled) return state.learningPreset;
  const normalizedLanguage = normalizeTrackLanguage(language);
  const cached = learningPresetCache.get(normalizedLanguage);
  if (cached) {
    state.learningPreset = cached;
    return cached;
  }
  if (learningPresetRequests.has(normalizedLanguage)) return learningPresetRequests.get(normalizedLanguage);
  state.learningPreset = { language: normalizedLanguage, words: [], phrases: [], status: "loading", error: "" };
  if ($("#view-study")?.classList.contains("is-active")) renderStudy();
  const task = (async () => {
    try {
      const data = await fetchJson(`/api/learning/presets?language=${encodeURIComponent(normalizedLanguage)}`);
      const preset = {
        language: normalizeTrackLanguage(data?.language || normalizedLanguage),
        words: normalizePresetCollection(data?.words, "word", normalizedLanguage).slice(0, 5000),
        phrases: normalizePresetCollection(data?.phrases, "phrase", normalizedLanguage).slice(0, 1000),
        status: "ready",
        error: "",
      };
      preset.wordRank = new Map(preset.words.map((item) => [item.normalized, item.rank]));
      preset.phraseRank = new Map(preset.phrases.map((item) => [item.normalized, item.rank]));
      learningPresetCache.set(normalizedLanguage, preset);
      if (state.targetLanguage === normalizedLanguage) state.learningPreset = preset;
      touchLearningState();
      renderSubtitles();
      if ($("#view-study")?.classList.contains("is-active")) renderStudy();
      return preset;
    } catch (error) {
      const failed = { language: normalizedLanguage, words: [], phrases: [], status: "error", error: error.message || "Preset unavailable" };
      if (state.targetLanguage === normalizedLanguage) state.learningPreset = failed;
      if ($("#view-study")?.classList.contains("is-active")) renderStudy();
      return failed;
    } finally {
      learningPresetRequests.delete(normalizedLanguage);
    }
  })();
  learningPresetRequests.set(normalizedLanguage, task);
  return task;
}

export function enrichPresetItem(item, type) {
  const analysis = currentAnalysis();
  const match = (type === "word" ? analysis.wordByValue : analysis.phraseByValue)?.get(item.normalized || normalizeText(item.value));
  if (!match) return { ...item, itemKey: learningItemKey(item.language, type, item.value) };
  return {
    ...item,
    count: match.count,
    scenes: match.scenes || match.occurrences?.length || 0,
    occurrences: match.occurrences || [],
    sourceTag: `${item.sourceTag} · VIDEO`,
    itemKey: learningItemKey(item.language, type, item.value),
  };
}

export function renderAnalysisRows(items, type) {
  if (!items.length) return empty(`No ${type}s found`, "");
  return items.slice(0, 100).map((item, index) => {
    const romanized = studyRomanizationFor(item);
    return `
      <div class="ui-row study-vocabulary-row" data-index="${index}">
        <span class="ui-row__lead">${index + 1}</span>
        <span class="study-vocabulary-row__copy"><span class="ui-row__title">${escapeHtml(item.value)}</span>${romanized && romanized !== item.value ? `<span class="ui-row__sub">${escapeHtml(romanized)}</span>` : ""}<span class="ui-row__sub">${escapeHtml(sourceTagText(item.sourceTag || activeSourceTag()))}</span></span>
        <span class="study-vocabulary-row__status">${isMasteredItem(item, type) ? '<span class="ui-learn ui-learn--known" data-i18n="Mastered">Mastered</span>' : cardKeySet().has(learningItemKeyFor(item, type)) ? '<span class="ui-learn ui-learn--review" data-i18n="Learning">Learning</span>' : ""}</span>
        <span class="study-vocabulary-row__count">${Number(item.count) > 0 ? `${item.count}×` : "—"}</span>
        <button class="ui-btn ui-btn--ghost ui-btn--sm" type="button" data-i18n="Open">Open</button>
      </div>`;
  }).join("");
}

export function wireAnalysisRows(container, type, items) {
  container.querySelectorAll("[data-index]").forEach((row) => row.addEventListener("click", () => openDetail(items[Number(row.dataset.index)], type)));
}

function openDetail(item, type) {
  const occurrences = Array.isArray(item.occurrences) ? item.occurrences : [];
  const known = isKnownItem(item, type);
  const itemKey = learningItemKeyFor(item, type);
  const chapterDerived = Boolean(item.sourceLibraryId && item.sourceFileIndex !== null && item.sourceFileIndex !== undefined);
  const discarded = discardedAutoCardKeys.has(itemKey);
  if (chapterDerived && !known && !discarded && !cardKeySet().has(itemKey)) ensureAutoCardForItem(item, type);
  const inReview = cardKeySet().has(itemKey);
  const cardAction = chapterDerived
    ? inReview
      ? "DISCARD CARD"
      : discarded
        ? "RESTORE CARD"
        : known
          ? "MASTERED"
          : "RESTORE CARD"
    : inReview
      ? "IN REVIEW"
      : "+ ADD CARD";
  const cardDisabled = (!chapterDerived && inReview) || (chapterDerived && known && !inReview && !discarded);
  const eyebrow = item.origin === "frequency" ? `COMMON ${type.toUpperCase()}${item.rank ? ` #${item.rank}` : ""}` : `${type.toUpperCase()} / ${item.count || 0} OCCURRENCES`;
  const romanized = studyRomanizationFor(item);
  $("#dialog-content").innerHTML = `
    <div class="detail-body">
      <span class="eyebrow">${escapeHtml(eyebrow)}</span>
      <h2>${escapeHtml(item.value)}</h2>
      ${romanized && romanized !== item.value ? `<p class="study-detail-reading">${escapeHtml(romanized)}</p>` : ""}
      <p><span class="source-tag">${escapeHtml(sourceTagText(item.sourceTag || activeSourceTag()))}</span></p>
      ${item.gloss ? `<p>${escapeHtml(item.gloss)}</p>` : ""}
      ${occurrences.length ? `<p>Seen in ${item.scenes || occurrences.length} subtitle scenes in the current analysis track.</p>` : ""}
      <div class="detail-actions">
        <button id="detail-known" class="button">${known ? "MARK UNKNOWN" : "MARK KNOWN"}</button>
        <button id="detail-card" class="button ${inReview && chapterDerived ? "button-quiet" : "button-solid"}" ${cardDisabled ? "disabled" : ""}>${cardAction}</button>
      </div>
      <div>${occurrences.slice(0, 30).map((occurrence) => `
        <div class="occurrence">
          <time>${formatTime(occurrence.startMs)}</time>
          <p>${escapeHtml(occurrence.text)}</p>
          <button class="tiny-btn occurrence-seek" data-seek="${occurrence.startMs}">PLAY</button>
        </div>`).join("")}</div>
    </div>`;
  $("#detail-known").addEventListener("click", () => {
    setKnownItem(item, type, !known);
    $("#detail-dialog").close();
    renderStudy();
  });
  if (!cardDisabled) $("#detail-card")?.addEventListener("click", () => {
    if (chapterDerived && inReview) discardCardByLearningKey(itemKey);
    else if (chapterDerived) restoreAutoCard(item, type);
    else addCard(item, type);
    $("#detail-dialog").close();
  });
  $$(".occurrence-seek").forEach((button) => button.addEventListener("click", () => {
    const occurrence = occurrences.find((source) => Number(source.startMs) === Number(button.dataset.seek));
    const seekMs = occurrencePlaybackMs(occurrence, item);
    $("#detail-dialog").close();
    void openLinePreview({ ...item, timestampMs: seekMs, endMs: seekMs + Math.max(300, Number(occurrence?.endMs) - Number(occurrence?.startMs)), context: occurrence?.text || item.value, baseContext: alignedBaseCueForOccurrence(occurrence)?.text || "" });
  }));
  $("#detail-dialog").showModal();
}

function alignedBaseCueForOccurrence(source) {
  if (!source?.cueId || state.alignedSubtitleSourceKey !== currentExposureMediaKey() || !state.alignedSubtitleTimeline.length) return null;
  const unit = state.alignedSubtitleTimeline.find((item) => Array.isArray(item?.items) && item.items.some((entry) => String(entry?.cueId) === String(source.cueId)));
  const paired = unit?.items?.find((entry) => normalizeTrackLanguage(entry?.language) === state.baseLanguage);
  if (!paired?.text) return null;
  return { text: String(paired.text), startMs: Number(paired.startMs) || 0, endMs: Number(paired.endMs) || 0 };
}

function occurrencePlaybackMs(source, item = null) {
  if (!source) return 0;
  const referencesCurrentChapter = !item?.sourceLibraryId || (String(item.sourceLibraryId) === String(state.currentSource?.libraryId)
    && String(item.sourceFileIndex ?? "") === String(state.currentSource?.fileIndex ?? ""));
  if (!referencesCurrentChapter) return Number(source.startMs) || 0;
  const sourceTrack = currentSourceTracks().find((track) => track.cues?.some((cue) => String(cue.id) === String(source.cueId))) || activeTrack();
  return sourceTrack ? Math.max(0, Number(source.startMs || 0) + trackEffectiveOffsetAt(sourceTrack, Number(source.startMs) || 0)) : Number(source.startMs) || 0;
}

// The line a card shows: dialogue rather than a sound-effect caption, of ordinary length.
function bestOccurrence(item) {
  const occurrences = Array.isArray(item?.occurrences) ? item.occurrences.filter(Boolean) : [];
  const speech = occurrences.filter((occurrence) => !isNonSpeechCue(occurrence?.text));
  const pool = speech.length ? speech : occurrences;
  const lengthRank = (text) => {
    const length = [...String(text || "")].length;
    return length < 4 ? 3 : length <= 60 ? 0 : length <= 110 ? 1 : 2;
  };
  return pool.slice().sort((a, b) => lengthRank(a.text) - lengthRank(b.text))[0] || null;
}

function cardRecordForItem(item, type, { autoGenerated = false } = {}) {
  const itemKey = learningItemKeyFor(item, type);
  if (!itemKey) return null;
  const source = bestOccurrence(item);
  const referencesCurrentChapter = !item.sourceLibraryId || (String(item.sourceLibraryId) === String(state.currentSource?.libraryId)
    && String(item.sourceFileIndex ?? "") === String(state.currentSource?.fileIndex ?? ""));
  const playbackMs = occurrencePlaybackMs(source, item);
  const baseTrack = referencesCurrentChapter ? currentSourceTracks().find((track) => String(track.language || "").toUpperCase() === state.baseLanguage) : null;
  const sourceTrack = referencesCurrentChapter && source ? currentSourceTracks().find((track) => track.cues?.some((cue) => String(cue.id) === String(source.cueId))) : null;
  const sourceCue = sourceTrack?.cues.find((cue) => String(cue.id) === String(source.cueId)) || null;
  const baseCue = referencesCurrentChapter
    ? ((sourceCue && pairedBaseLines(sourceTrack, sourceCue)) || alignedBaseCueForOccurrence(source) || cueNearPlaybackMs(baseTrack, playbackMs))
    : null;
  const savedBaseContext = String(item.baseContext || "");
  return {
    id: crypto.randomUUID(),
    itemKey,
    type,
    front: item.value,
    romanized: studyRomanizationFor(item),
    back: savedBaseContext || baseCue?.text || item.gloss || "",
    context: source?.text || "",
    timestampMs: playbackMs,
    endMs: source ? playbackMs + Math.max(300, Number(source.endMs) - Number(source.startMs)) : 0,
    trackLabel: item.trackLabel || (source && referencesCurrentChapter ? activeTrack()?.label || "Subtitle" : source ? "Saved chapter subtitle" : `Common ${item.language || state.targetLanguage}`),
    sourceTag: item.sourceTag || activeSourceTag(),
    baseLanguage: state.baseLanguage,
    targetLanguage: item.language || state.targetLanguage,
    baseContext: savedBaseContext || baseCue?.text || "",
    sourceLibraryId: item.sourceLibraryId || (source ? state.currentSource?.libraryId || null : null),
    sourceFileIndex: item.sourceFileIndex ?? (source ? state.currentSource?.fileIndex ?? null : null),
    origin: autoGenerated ? "subtitle-auto" : item.origin || "subtitle",
    autoGenerated: Boolean(autoGenerated),
    deckId: item.deckId || "",
    rank: Number(item.rank) || null,
    createdAt: Date.now(),
    dueAt: Date.now(),
    state: "new",
    learningStep: 0,
    intervalDays: 0,
    reviewCount: 0,
    lapses: 0,
  };
}

function addCard(item, type) {
  const itemKey = learningItemKeyFor(item, type);
  if (cardKeySet().has(itemKey)) return;
  const restored = discardedAutoCardKeys.delete(itemKey);
  const card = cardRecordForItem(item, type);
  if (!card) return;
  state.cards.push(card);
  touchLearningState();
  saveState();
  if (restored) persistDiscardedAutoCardKeys();
  renderReview();
  renderStats();
  renderSubtitles();
  if ($("#view-study")?.classList.contains("is-active")) renderStudy();
}

export function restoreDiscardedAutoCardKeys(keys) {
  discardedAutoCardKeys = new Set((Array.isArray(keys) ? keys : []).map(String).filter(Boolean).slice(-20_000));
}

export function addDiscardedAutoCardKeys(keys) {
  discardedAutoCardKeys = new Set([
    ...discardedAutoCardKeys,
    ...keys.map(String).filter(Boolean),
  ].slice(-20_000));
}

export function persistDiscardedAutoCardKeys({ immediate = false } = {}) {
  const values = [...discardedAutoCardKeys].slice(-20_000);
  localStorage.setItem("blackline-discarded-auto-cards", JSON.stringify(values));
  persistPreferences({ immediate });
}

export function cardLearningKey(card) {
  return String(card?.itemKey || learningItemKey(card?.targetLanguage || state.targetLanguage, card?.type || "word", card?.front || ""));
}

function syncEpisodeAutoCardMetadata(libraryId, fileIndex) {
  if (!libraryId || fileIndex === null || fileIndex === undefined) return false;
  const entry = libraryEntryById(libraryId);
  const episode = entry?.episodes?.find((item) => Number(item.fileIndex) === Number(fileIndex));
  if (!episode?.analysis) return false;
  const cards = state.cards.filter((card) => card.autoGenerated
    && String(card.sourceLibraryId) === String(libraryId)
    && String(card.sourceFileIndex ?? "") === String(fileIndex ?? ""));
  const nextCount = cards.length;
  const nextWords = cards.filter((card) => card.type === "word").length;
  const nextPhrases = cards.filter((card) => card.type === "phrase").length;
  const changed = Number(episode.analysis.autoCardCount || 0) !== nextCount
    || Number(episode.analysis.autoWordCardCount || 0) !== nextWords
    || Number(episode.analysis.autoPhraseCardCount || 0) !== nextPhrases;
  episode.analysis.autoCardCount = nextCount;
  episode.analysis.autoWordCardCount = nextWords;
  episode.analysis.autoPhraseCardCount = nextPhrases;
  if (changed) entry.updatedAt = Date.now();
  return changed;
}

export function discardCardByLearningKey(itemKey, { rememberAutoDiscard = true } = {}) {
  const key = String(itemKey || "");
  if (!key) return false;
  const before = state.cards.length;
  let removedAutoOrChapter = false;
  const affectedEpisodes = new Map();
  state.cards = state.cards.filter((card) => {
    if (cardLearningKey(card) !== key) return true;
    removedAutoOrChapter ||= Boolean(card.autoGenerated || card.origin === "subtitle-auto"
      || (card.sourceLibraryId && card.sourceFileIndex !== null && card.sourceFileIndex !== undefined));
    if (card.sourceLibraryId && card.sourceFileIndex !== null && card.sourceFileIndex !== undefined) {
      affectedEpisodes.set(`${card.sourceLibraryId}:${card.sourceFileIndex}`, [card.sourceLibraryId, card.sourceFileIndex]);
    }
    return false;
  });
  if (before === state.cards.length) return false;
  if (rememberAutoDiscard && removedAutoOrChapter) {
    discardedAutoCardKeys.add(key);
    persistDiscardedAutoCardKeys();
  }
  touchLearningState();
  saveState();
  let libraryChanged = false;
  for (const [libraryId, fileIndex] of affectedEpisodes.values()) {
    libraryChanged = syncEpisodeAutoCardMetadata(libraryId, fileIndex) || libraryChanged;
  }
  if (libraryChanged) saveLibrary();
  renderReview();
  renderStats();
  renderSubtitles();
  if ($("#view-study")?.classList.contains("is-active")) renderStudy();
  return true;
}

function ensureAutoCardForItem(item, type, { persist = true } = {}) {
  const itemKey = learningItemKeyFor(item, type);
  if (!itemKey || cardKeySet().has(itemKey) || discardedAutoCardKeys.has(itemKey) || state.known.has(itemKey)) return false;
  const card = cardRecordForItem(item, type, { autoGenerated: true });
  if (!card) return false;
  state.cards.push(card);
  touchLearningState();
  if (persist) {
    saveState();
    if (syncEpisodeAutoCardMetadata(card.sourceLibraryId, card.sourceFileIndex)) saveLibrary();
  }
  return true;
}

function restoreAutoCard(item, type) {
  const itemKey = learningItemKeyFor(item, type);
  if (!itemKey) return false;
  const wasDiscarded = discardedAutoCardKeys.delete(itemKey);
  let added = false;
  if (!cardKeySet().has(itemKey)) {
    const card = cardRecordForItem(item, type, { autoGenerated: true });
    if (card) {
      state.cards.push(card);
      added = true;
      touchLearningState();
      saveState();
      if (syncEpisodeAutoCardMetadata(card.sourceLibraryId, card.sourceFileIndex)) saveLibrary();
    }
  }
  if (wasDiscarded) persistDiscardedAutoCardKeys();
  if (added || wasDiscarded) {
    renderReview();
    renderStats();
    renderSubtitles();
    if ($("#view-study")?.classList.contains("is-active")) renderStudy();
  }
  return added || wasDiscarded;
}

export function backfillPersistedChapterAutoCards() {
  if (!learningEnabled) return 0;
  const existingKeys = new Set(cardKeySet());
  let added = 0;
  let libraryMetadataChanged = false;
  for (const chapter of studyChapterCatalog()) {
    if (chapter.language !== state.targetLanguage || !chapter.hasTargetAnalysis) continue;
    const beforeChapter = state.cards.length;
    for (const type of ["word", "phrase"]) {
      const values = type === "phrase" ? chapter.analysis?.phrases : chapter.analysis?.words;
      for (const rawItem of Array.isArray(values) ? values : []) {
        if (state.cards.length >= 20_000) break;
        const value = String(rawItem?.value || "").trim();
        if (!value) continue;
        const occurrence = rawItem?.occurrence && typeof rawItem.occurrence === "object" ? rawItem.occurrence : null;
        const item = {
          ...rawItem,
          value,
          language: chapter.language,
          type,
          origin: "subtitle-auto",
          sourceTag: rawItem?.sourceTag || chapter.sourceTag,
          deckId: `chapter:${chapter.id}`,
          occurrences: Array.isArray(rawItem?.occurrences) ? rawItem.occurrences : (occurrence ? [occurrence] : []),
          sourceLibraryId: chapter.libraryId,
          sourceFileIndex: chapter.fileIndex,
          baseContext: String(rawItem?.baseContext || ""),
        };
        const itemKey = learningItemKeyFor(item, type);
        if (!itemKey || existingKeys.has(itemKey) || discardedAutoCardKeys.has(itemKey) || state.known.has(itemKey)) continue;
        if (isLearningStopWord(value, chapter.language) || !bestOccurrence(item) || isNonSpeechCue(bestOccurrence(item).text)) continue;
        const limit = type === "phrase" ? AUTO_CARD_PHRASES_PER_EPISODE : AUTO_CARD_WORDS_PER_EPISODE;
        const chapterCount = state.cards.filter((card) => card.autoGenerated && card.type === type
          && String(card.sourceLibraryId) === String(chapter.libraryId) && String(card.sourceFileIndex ?? "") === String(chapter.fileIndex ?? "")).length;
        if (chapterCount >= limit) break;
        const card = cardRecordForItem(item, type, { autoGenerated: true });
        if (!card) continue;
        state.cards.push(card);
        existingKeys.add(itemKey);
        added += 1;
      }
    }
    const chapterCards = state.cards.filter((card) => card.autoGenerated
      && String(card.sourceLibraryId) === String(chapter.libraryId)
      && String(card.sourceFileIndex ?? "") === String(chapter.fileIndex ?? ""));
    const nextCount = chapterCards.length;
    const nextWords = chapterCards.filter((card) => card.type === "word").length;
    const nextPhrases = chapterCards.filter((card) => card.type === "phrase").length;
    if (Number(chapter.analysis.autoCardCount || 0) !== nextCount
      || Number(chapter.analysis.autoWordCardCount || 0) !== nextWords
      || Number(chapter.analysis.autoPhraseCardCount || 0) !== nextPhrases
      || state.cards.length !== beforeChapter) {
      chapter.analysis.autoCardCount = nextCount;
      chapter.analysis.autoWordCardCount = nextWords;
      chapter.analysis.autoPhraseCardCount = nextPhrases;
      chapter.analysis.autoCardsGeneratedAt ||= Date.now();
      libraryMetadataChanged = true;
    }
  }
  if (added) {
    touchLearningState();
    saveState();
  }
  if (libraryMetadataChanged) saveLibrary();
  return added;
}

export function saveCurrentEpisodeAnalysis() {
  if (!learningEnabled) return;
  const source = state.currentSource;
  if (!source?.libraryId || source.fileIndex === null || source.fileIndex === undefined) return;
  const entry = libraryEntryById(source.libraryId);
  const episode = entry?.episodes?.find((item) => Number(item.fileIndex) === Number(source.fileIndex));
  const track = activeTrack();
  if (!entry || !episode || !track || track.sourceTag !== source.sourceTag || !track.cues?.length) return;
  const baseTrack = currentSourceTracks().find((item) => normalizeTrackLanguage(item.language) === state.baseLanguage);
  const compact = (item) => {
    const occurrence = item.occurrences?.[0] || null;
    const playbackMs = occurrence ? occurrencePlaybackMs(occurrence, { sourceLibraryId: source.libraryId, sourceFileIndex: source.fileIndex }) : 0;
    const aligned = alignedBaseCueForOccurrence(occurrence)
      || cueNearPlaybackMs(baseTrack, playbackMs);
    return {
      value: item.value,
      count: item.count,
      scenes: item.scenes || item.occurrences?.length || 0,
      sourceTag: activeSourceTag(),
      occurrence: occurrence ? { cueId: String(occurrence.cueId || "").slice(0, 180), startMs: playbackMs,
        endMs: playbackMs + Math.max(300, Number(occurrence.endMs) - Number(occurrence.startMs)), text: String(occurrence.text || "").slice(0, 800) } : null,
      baseContext: String(aligned?.text || "").slice(0, 800),
    };
  };
  episode.analysis = {
    words: getWords().slice(0, 300).map(compact),
    phrases: getPhrases().slice(0, 200).map(compact),
    updatedAt: Date.now(),
    trackLabel: track.label,
    language: track.language,
  };
  if (normalizeTrackLanguage(track.language) === state.targetLanguage) {
    autoCreateEpisodeCards(entry, episode, track);
  }
  entry.updatedAt = Date.now();
  saveLibrary();
}

function autoCreateEpisodeCards(entry, episode, track) {
  if (!entry || !episode || !track?.cues?.length || normalizeTrackLanguage(track.language) !== state.targetLanguage) return 0;
  // Only once the lines are synced (or matched): a card's translation comes from the base track.
  if (!pairingReady()) return 0;
  const existingKeys = new Set(cardKeySet());
  const deckId = `chapter:${entry.seriesKey || librarySeriesKey(entry.displayTitle || entry.title)}|${String(episode.code || episode.fileIndex || "video").toUpperCase()}`;
  const dialogue = (item) => {
    const occurrence = bestOccurrence(item);
    return occurrence && !isNonSpeechCue(occurrence.text);
  };
  const candidates = [
    ...getWords().filter(dialogue).slice(0, AUTO_CARD_WORDS_PER_EPISODE).map((item) => ({ item, type: "word" })),
    ...getPhrases().filter(dialogue).slice(0, AUTO_CARD_PHRASES_PER_EPISODE).map((item) => ({ item, type: "phrase" })),
  ];
  let added = 0;
  for (const candidate of candidates) {
    const rawItem = candidate.item;
    const type = candidate.type;
    const item = {
      ...rawItem,
      language: state.targetLanguage,
      type,
      origin: "subtitle-auto",
      deckId,
      sourceTag: rawItem.sourceTag || activeSourceTag(),
      sourceLibraryId: entry.id,
      sourceFileIndex: episode.fileIndex,
    };
    const key = learningItemKeyFor(item, type);
    if (!key || existingKeys.has(key) || discardedAutoCardKeys.has(key) || state.known.has(key)) continue;
    const card = cardRecordForItem(item, type, { autoGenerated: true });
    if (!card) continue;
    state.cards.push(card);
    existingKeys.add(key);
    added += 1;
  }
  episode.analysis.autoCardsGeneratedAt = Date.now();
  const episodeCards = state.cards.filter((card) => card.autoGenerated
    && String(card.sourceLibraryId) === String(entry.id)
    && String(card.sourceFileIndex ?? "") === String(episode.fileIndex ?? ""));
  episode.analysis.autoCardCount = episodeCards.length;
  episode.analysis.autoWordCardCount = episodeCards.filter((card) => card.type === "word").length;
  episode.analysis.autoPhraseCardCount = episodeCards.filter((card) => card.type === "phrase").length;
  if (!added) return 0;
  touchLearningState();
  saveState();
  renderReview();
  renderStats();
  renderSubtitles();
  if ($("#view-study")?.classList.contains("is-active")) renderStudy();
  return added;
}

export function showLibraryVocabulary(libraryId, fileIndex, kind) {
  const entry = libraryEntryById(libraryId);
  const episode = entry?.episodes?.find((item) => Number(item.fileIndex) === Number(fileIndex));
  if (!entry || !episode) return;
  const items = episode.analysis?.[kind] || [];
  const noun = kind === "phrases" ? "phrase" : "word";
  $("#library-words-title").textContent = `${items.length.toLocaleString()} ${noun}${items.length === 1 ? "" : "s"}`;
  $("#library-words-source").textContent = [entry.displayTitle || entry.title, libraryChapterName(episode) || episode.episodeTitle].filter(Boolean).join(", ");
  $("#library-words-content").innerHTML = items.length
    ? `<ol class="ui-list library-words-list">${items.slice(0, 500).map((item, index) => {
      const known = isKnownItem(item, noun);
      const learning = cardKeySet().has(learningItemKeyFor({ ...item, language: item.language || state.targetLanguage }, noun));
      return `<li class="ui-row"><span class="ui-row__lead">${index + 1}</span><span><span class="ui-row__title" lang="${escapeHtml(String(item.language || state.targetLanguage).toLowerCase())}">${escapeHtml(item.value)}</span>${item.romanized && item.romanized !== item.value ? `<span class="ui-row__sub">${escapeHtml(item.romanized)}</span>` : ""}</span><span class="ui-row__trail">${known ? '<span class="ui-learn ui-learn--known">Mastered</span>' : learning ? '<span class="ui-learn ui-learn--review">Learning</span>' : ""}<span>${Number(item.count) || 0}×</span></span></li>`;
    }).join("")}</ol>`
    : emptyMarkup({ compact: true, title: `No ${noun}s saved`, text: `Play this chapter with ${state.targetLanguage} subtitles to find them.` });
  $("#library-words-dialog").showModal();
}
