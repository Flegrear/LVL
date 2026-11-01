// Learning: known words, exposure and pronunciation practice.
import { isLearningStopWord, normalizeText } from "../../learning/browser/core.js";
import { isNonSpeechCue } from "../../shared/subtitles/subtitle-sync.js";
import { learningEnabled, state, video } from "../../app.js";
import { persistAppSection, saveState, storeLocalCopy } from "../app/saved-state.js";
import { $ } from "../app/dom.js";
import { normalizeTrackLanguage } from "../player/player-tracks.js";
import { cueSegments, renderSubtitles, subtitleRenderMemo } from "../player/subtitle-display.js";
import { renderVoiceChatStage, voiceChat } from "./voice-coach.js";
import { cardLearningKey, discardedAutoCardKeys, persistDiscardedAutoCardKeys } from "./vocabulary-cards.js";
import { renderStudyProgress, studyChapterCatalog, studyRawItems, studyRomanizationFor } from "./study-vocabulary.js";
import { openLinePreview } from "./study-decks.js";

export let learningRevision = 0;
let cardIndexMemo = { revision: -1, keys: new Set(), mastered: new Set() };

const exposureCueSeen = new Set();
let exposureMediaKey = "";
let learningExposureSaveTimer = null;
let learningExposureDirty = false;

export let pronunciationQueueIndex = 0;

function flushLearningExposure() {
  if (!learningExposureDirty) return;
  learningExposureDirty = false;
  if (learningExposureSaveTimer) clearTimeout(learningExposureSaveTimer);
  learningExposureSaveTimer = null;
  try {
    const entries = Object.entries(state.learningExposure || {});
    if (entries.length > 12000) {
      entries.sort((a, b) => Number(b[1]?.lastSeenAt || 0) - Number(a[1]?.lastSeenAt || 0));
      state.learningExposure = Object.fromEntries(entries.slice(0, 10000));
    }
    storeLocalCopy("blackline-learning-exposure", state.learningExposure);
    persistAppSection("learningExposure", state.learningExposure, { immediate: true });
  } catch (error) {
    console.warn("Learning exposure could not be saved:", error);
  }
}

export function saveLearningExposure({ immediate = false } = {}) {
  learningExposureDirty = true;
  if (immediate) {
    flushLearningExposure();
    return;
  }
  if (learningExposureSaveTimer) return;
  learningExposureSaveTimer = setTimeout(flushLearningExposure, 1500);
}

export function learningItemKey(language, type, value) {
  const normalized = normalizeText(value);
  const normalizedType = type === "phrase" ? "phrase" : "word";
  return `${normalizeTrackLanguage(language || state.targetLanguage)}|${normalizedType}|${normalized}`;
}

export function learningItemKeyFor(item, type = item?.type || "word") {
  return item?.itemKey || learningItemKey(item?.language || state.targetLanguage, type, item?.value || item?.front || "");
}

export function cardKeySet() {
  if (cardIndexMemo.revision === learningRevision) return cardIndexMemo.keys;
  const keys = new Set();
  const mastered = new Set();
  state.cards.forEach((card) => {
    const key = card.itemKey || learningItemKey(card.targetLanguage || state.targetLanguage, card.type, card.front);
    if (!key) return;
    keys.add(key);
    if (Number(card.reviewCount || 0) >= 3 && Number(card.intervalDays || 0) >= 7) mastered.add(key);
  });
  cardIndexMemo = {
    revision: learningRevision,
    keys,
    mastered,
  };
  return cardIndexMemo.keys;
}

export function masteredCardKeySet() {
  cardKeySet();
  return cardIndexMemo.mastered;
}

function pronunciationQueueStatus(itemKey, card = null) {
  if (state.known.has(itemKey) || masteredCardKeySet().has(itemKey)) return "mastered";
  if (Number(card?.reviewCount || 0) > 0) return "practiced";
  return "";
}

function knownChapterPronunciationItems(existingKeys) {
  const items = [];
  for (const chapter of studyChapterCatalog()) {
    if (chapter.language !== state.targetLanguage) continue;
    for (const type of ["word", "phrase"]) {
      const values = type === "phrase" ? chapter.analysis?.phrases : chapter.analysis?.words;
      for (const raw of Array.isArray(values) ? values : []) {
        const value = String(raw?.value || "").trim();
        if (!value) continue;
        const itemKey = learningItemKey(chapter.language, type, value);
        if (!state.known.has(itemKey) || existingKeys.has(itemKey)) continue;
        const occurrence = raw?.occurrence && typeof raw.occurrence === "object" ? raw.occurrence : null;
        if (!occurrence?.text || !chapter.libraryId || chapter.fileIndex === null || chapter.fileIndex === undefined) continue;
        items.push({
          id: `known:${chapter.id}:${itemKey}`,
          itemKey,
          type,
          front: value,
          romanized: studyRomanizationFor({ value, romanized: raw?.romanized, language: chapter.language }),
          back: String(raw?.baseContext || ""),
          baseContext: String(raw?.baseContext || ""),
          context: String(occurrence?.text || ""),
          timestampMs: Math.max(0, Number(occurrence?.startMs) || 0),
          endMs: Number(occurrence?.endMs) || null,
          sourceTag: String(raw?.sourceTag || chapter.sourceTag || `${chapter.seriesTitle} · ${chapter.code}`),
          sourceLibraryId: chapter.libraryId,
          sourceFileIndex: chapter.fileIndex,
          targetLanguage: chapter.language,
          baseLanguage: state.baseLanguage,
          reviewCount: 0,
          intervalDays: 0,
          knownOnly: true,
        });
        existingKeys.add(itemKey);
      }
    }
  }
  return items;
}

export function pronunciationPracticeQueue() {
  const existingKeys = new Set();
  const queue = [];
  for (const card of state.cards) {
    if (!card?.front || !["word", "phrase"].includes(card.type)) continue;
    if (normalizeTrackLanguage(card.targetLanguage || state.targetLanguage) !== state.targetLanguage) continue;
    if (!card.context || !card.sourceLibraryId || card.sourceFileIndex === null || card.sourceFileIndex === undefined) continue;
    const itemKey = cardLearningKey(card);
    if (!itemKey || existingKeys.has(itemKey)) continue;
    const status = pronunciationQueueStatus(itemKey, card);
    if (!status) continue;
    existingKeys.add(itemKey);
    queue.push({
      ...card,
      romanized: String(card.romanized || studyRomanizationFor({
        value: card.front,
        romanized: card.romanized,
        language: card.targetLanguage || state.targetLanguage,
      })),
      itemKey,
      pronunciationStatus: status,
    });
  }
  for (const item of knownChapterPronunciationItems(existingKeys)) {
    queue.push({ ...item, pronunciationStatus: "mastered" });
  }
  return queue.sort((a, b) => {
    const statusDelta = (a.pronunciationStatus === "mastered" ? 0 : 1) - (b.pronunciationStatus === "mastered" ? 0 : 1);
    if (statusDelta) return statusDelta;
    const sourceDelta = String(a.sourceTag || "").localeCompare(String(b.sourceTag || ""), undefined, { sensitivity: "base" });
    if (sourceDelta) return sourceDelta;
    return String(a.front || "").localeCompare(String(b.front || ""), undefined, { sensitivity: "base" });
  });
}

export function currentPronunciationPracticeItem(queue = pronunciationPracticeQueue()) {
  if (!queue.length) {
    pronunciationQueueIndex = 0;
    return null;
  }
  pronunciationQueueIndex = Math.max(0, Math.min(pronunciationQueueIndex, queue.length - 1));
  return queue[pronunciationQueueIndex] || null;
}

export function pronunciationPracticePayload(item) {
  if (!item?.front) return null;
  return {
    type: item.type === "phrase" ? "phrase" : "word",
    targetText: String(item.front || ""),
    romanized: String(item.romanized || ""),
    baseText: String(item.baseContext || item.back || ""),
    cue: String(item.context || ""),
    sourceTag: String(item.sourceTag || item.trackLabel || ""),
    timestampMs: Number.isFinite(Number(item.timestampMs)) ? Math.max(0, Math.round(Number(item.timestampMs))) : null,
  };
}

export function stepPronunciationQueue(direction) {
  const queue = pronunciationPracticeQueue();
  if (!queue.length || voiceChat.pending || voiceChat.listening) return;
  pronunciationQueueIndex = (pronunciationQueueIndex + (direction < 0 ? -1 : 1) + queue.length) % queue.length;
  voiceChat.error = "";
  renderVoiceChatStage();
}

export function playPronunciationCue(item) {
  if (item?.context) void openLinePreview(item);
}

export function touchLearningState() {
  learningRevision += 1;
  cardIndexMemo.revision = -1;
  subtitleRenderMemo.key = "";
}

export function isKnownItem(item, type = item?.type || "word") {
  return state.known.has(learningItemKeyFor(item, type));
}

export function isMasteredItem(item, type = item?.type || "word") {
  const key = learningItemKeyFor(item, type);
  return state.known.has(key) || masteredCardKeySet().has(key);
}

export function setKnownItem(item, type, known) {
  const key = learningItemKeyFor(item, type);
  if (!key) return;
  if (known) state.known.add(key); else state.known.delete(key);
  touchLearningState();
  saveState();
  renderSubtitles();
}

export function migrateLearningState() {
  let changed = false;
  const migratedKnown = new Set();
  state.known.forEach((value) => {
    const raw = String(value || "").trim();
    if (!raw) return;
    if (/^[A-Z]{2,3}\|(word|phrase)\|/i.test(raw)) {
      migratedKnown.add(raw);
      return;
    }
    migratedKnown.add(learningItemKey(state.targetLanguage, "word", raw));
    migratedKnown.add(learningItemKey(state.targetLanguage, "phrase", raw));
    changed = true;
  });
  state.known = migratedKnown;
  state.cards = state.cards.map((card) => {
    if (card?.itemKey) return card;
    changed = true;
    return { ...card, itemKey: learningItemKey(card?.targetLanguage || state.targetLanguage, card?.type, card?.front) };
  });
  // Auto cards made before grammar words and sound-effect captions were filtered out. Only cards
  // that were never reviewed; their keys are remembered so they don't come back.
  const junk = state.cards.filter((card) => card?.autoGenerated && !Number(card.reviewCount)
    && (isLearningStopWord(card.front, card.targetLanguage || state.targetLanguage) || (card.context && isNonSpeechCue(card.context))));
  if (junk.length) {
    const keys = new Set(junk.map((card) => cardLearningKey(card)));
    state.cards = state.cards.filter((card) => !keys.has(cardLearningKey(card)) || Number(card.reviewCount));
    keys.forEach((key) => discardedAutoCardKeys.add(key));
    persistDiscardedAutoCardKeys();
    changed = true;
  }
  if (changed) saveState();
  touchLearningState();
}

export function currentExposureMediaKey() {
  const source = state.currentSource || {};
  return [source.libraryId || source.sourceTag || source.title || source.kind || "source", source.fileIndex ?? source.fileName ?? "file"].join("|");
}

function incrementLearningExposure(key, mediaKey, now) {
  const previous = state.learningExposure[key] || { encounters: 0, media: 0, lastMedia: "", lastSeenAt: 0 };
  state.learningExposure[key] = {
    encounters: Number(previous.encounters || 0) + 1,
    media: Number(previous.media || 0) + (previous.lastMedia === mediaKey ? 0 : 1),
    lastMedia: mediaKey,
    lastSeenAt: now,
  };
}

export function recordCueExposure(track, cue) {
  if (!learningEnabled || !cue || normalizeTrackLanguage(track?.language) !== state.targetLanguage) return;
  const mediaKey = currentExposureMediaKey();
  if (mediaKey !== exposureMediaKey) {
    exposureMediaKey = mediaKey;
    exposureCueSeen.clear();
  }
  const cueKey = `${track.id}|${cue.id}`;
  if (exposureCueSeen.has(cueKey)) return;
  exposureCueSeen.add(cueKey);
  const now = Date.now();
  const wordList = cueSegments(cue, track).filter((segment) => segment.isWord && segment.normalized).map((segment) => segment.normalized);
  const exposureKeys = new Set([...new Set(wordList)].map((word) => learningItemKey(state.targetLanguage, "word", word)));
  const phraseRanks = state.learningPreset?.language === state.targetLanguage && state.learningPreset?.status === "ready" ? state.learningPreset.phraseRank : null;
  for (let size = 2; size <= 4; size += 1) {
    for (let index = 0; index <= wordList.length - size; index += 1) {
      const phrase = wordList.slice(index, index + size).join(" ");
      const key = learningItemKey(state.targetLanguage, "phrase", phrase);
      if (phraseRanks?.has(phrase) || state.known.has(key) || cardKeySet().has(key)) exposureKeys.add(key);
    }
  }
  exposureKeys.forEach((key) => incrementLearningExposure(key, mediaKey, now));
  if (exposureKeys.size) {
    saveLearningExposure();
    if ($("#view-study")?.classList.contains("is-active") && video.paused) renderStudyProgress(studyRawItems(), state.studyType);
  }
}
