// Learning: Study's chapter vocabulary.
import { normalizeText } from "../../learning/browser/core.js";
import { escapeHtml } from "../ui/ui.js";
import { t } from "../ui/ui-i18n.js";
import { empty, state } from "../../app.js";
import { saveLibrary, saveState } from "../app/saved-state.js";
import { $, $$ } from "../app/dom.js";
import { postJson } from "../app/http.js";
import { languageName, normalizeTrackLanguage } from "../player/player-tracks.js";
import { isRomanizableLanguage } from "../player/subtitle-display.js";
import { episodeSortKey } from "../player/torrent-playback.js";
import { buildLibrarySeries, groupLibraryChapters } from "../library/library-data.js";
import { libraryChapterName } from "../library/library-page.js";
import { renderVoiceChatStage, reviewMode, voiceChat } from "./voice-coach.js";
import {
  cardKeySet, isMasteredItem, learningItemKey, learningItemKeyFor, masteredCardKeySet,
  touchLearningState,
} from "./learning-state.js";
import { enrichPresetItem, ensureLearningPreset, renderAnalysisRows, wireAnalysisRows } from "./vocabulary-cards.js";

const studyRomanizationCache = new Map();
const studyRomanizationRequests = new Map();

const STUDY_PAGE_SIZE = 80;

function studyTierForType(type) {
  return type === "phrase" ? state.studyPhraseTier : state.studyWordTier;
}

export function studyChapterCatalog() {
  const chapters = [];
  buildLibrarySeries().forEach((series) => {
    [...series.seasons.entries()].sort((a, b) => Number(a[0]) - Number(b[0])).forEach(([, refs]) => {
      groupLibraryChapters(refs).forEach((chapter) => {
        const sources = chapter.sources.filter(({ episode }) => !episode?.extra);
        if (!sources.length) return;
        const ranked = sources.slice().sort((a, b) => {
          const analysisA = a.episode?.analysis || {};
          const analysisB = b.episode?.analysis || {};
          const languageA = normalizeTrackLanguage(analysisA.language || "");
          const languageB = normalizeTrackLanguage(analysisB.language || "");
          const scoreA = (languageA === state.targetLanguage ? 100000 : 0) + (analysisA.words?.length || 0) + (analysisA.phrases?.length || 0);
          const scoreB = (languageB === state.targetLanguage ? 100000 : 0) + (analysisB.words?.length || 0) + (analysisB.phrases?.length || 0);
          return scoreB - scoreA;
        });
        const best = ranked[0];
        const analysis = best.episode?.analysis || { words: [], phrases: [] };
        const language = normalizeTrackLanguage(analysis.language || state.targetLanguage);
        chapters.push({
          id: `${series.key}|${chapter.key}`,
          seriesKey: series.key,
          seriesTitle: series.title,
          code: String(chapter.code || "VIDEO").toUpperCase(),
          title: chapter.title || best.episode?.episodeTitle || best.episode?.name || "Untitled chapter",
          libraryId: best.entry.id,
          fileIndex: best.episode.fileIndex,
          sourceTag: best.episode.sourceTag || `${series.title} · ${chapter.code || "VIDEO"}`,
          analysis,
          language,
          hasTargetAnalysis: language === state.targetLanguage && Boolean((analysis.words?.length || 0) + (analysis.phrases?.length || 0)),
          sortKey: episodeSortKey(best.episode?.name) ?? 999999,
        });
      });
    });
  });
  return chapters.sort((a, b) => a.seriesTitle.localeCompare(b.seriesTitle, undefined, { sensitivity: "base" }) || a.sortKey - b.sortKey || a.title.localeCompare(b.title));
}

function selectedStudyChapter() {
  const chapters = studyChapterCatalog();
  if (!chapters.length) return null;
  let selected = chapters.find((chapter) => chapter.id === state.studyChapterId) || null;
  if (!selected && state.currentSource?.libraryId) {
    selected = chapters.find((chapter) => String(chapter.libraryId) === String(state.currentSource.libraryId)
      && String(chapter.fileIndex) === String(state.currentSource.fileIndex)) || null;
  }
  selected ||= chapters.find((chapter) => chapter.hasTargetAnalysis) || chapters[0];
  if (selected.id !== state.studyChapterId) {
    state.studyChapterId = selected.id;
    localStorage.setItem("blackline-study-chapter-id", selected.id);
  }
  return selected;
}

function studyChapterItems(type) {
  const chapter = selectedStudyChapter();
  if (!chapter || chapter.language !== state.targetLanguage) return [];
  const values = type === "phrase" ? chapter.analysis?.phrases : chapter.analysis?.words;
  return (Array.isArray(values) ? values : []).map((item, index) => {
    const value = String(item?.value || "").trim();
    const occurrence = item?.occurrence && typeof item.occurrence === "object" ? item.occurrence : null;
    return {
      ...item,
      value,
      normalized: normalizeText(value),
      language: chapter.language,
      type,
      origin: "subtitle",
      sourceTag: item?.sourceTag || chapter.sourceTag,
      deckId: `chapter:${chapter.id}`,
      count: Number(item?.count) || 0,
      scenes: Number(item?.scenes) || 0,
      occurrences: Array.isArray(item?.occurrences) ? item.occurrences : (occurrence ? [occurrence] : []),
      sourceLibraryId: chapter.libraryId,
      sourceFileIndex: chapter.fileIndex,
      baseContext: String(item?.baseContext || ""),
      chapterId: chapter.id,
      chapterLabel: `${chapter.seriesTitle} · ${chapter.code}`,
      savedOrder: index,
    };
  }).filter((item) => item.value);
}

function studyRomanizationKey(language, value) {
  return `${normalizeTrackLanguage(language)}|${String(value || "")}`;
}

export function studyRomanizationFor(item) {
  const language = normalizeTrackLanguage(item?.language || state.targetLanguage);
  if (!isRomanizableLanguage(language)) return "";
  return String(item?.romanized || studyRomanizationCache.get(studyRomanizationKey(language, item?.value)) || "").trim();
}

function persistResolvedStudyRomanizations(language, resolved) {
  const normalizedLanguage = normalizeTrackLanguage(language);
  if (!(resolved instanceof Map) || !resolved.size) return;
  let cardsChanged = false;
  let libraryChanged = false;
  for (const card of state.cards) {
    if (normalizeTrackLanguage(card.targetLanguage || state.targetLanguage) !== normalizedLanguage) continue;
    const romanized = resolved.get(String(card.front || ""));
    if (!romanized || card.romanized === romanized) continue;
    card.romanized = romanized;
    cardsChanged = true;
  }
  for (const entry of state.library) {
    let entryChanged = false;
    for (const episode of Array.isArray(entry.episodes) ? entry.episodes : []) {
      const analysis = episode?.analysis;
      if (!analysis || normalizeTrackLanguage(analysis.language || "") !== normalizedLanguage) continue;
      let analysisChanged = false;
      for (const collection of [analysis.words, analysis.phrases]) {
        for (const item of Array.isArray(collection) ? collection : []) {
          const romanized = resolved.get(String(item?.value || ""));
          if (!romanized || item.romanized === romanized) continue;
          item.romanized = romanized;
          libraryChanged = true;
          analysisChanged = true;
          entryChanged = true;
        }
      }
      if (analysisChanged) analysis.updatedAt = Math.max(Number(analysis.updatedAt) || 0, Date.now());
    }
    if (entryChanged) entry.updatedAt = Math.max(Number(entry.updatedAt) || 0, Date.now());
  }
  if (cardsChanged) {
    touchLearningState();
    saveState();
  }
  if (libraryChanged) saveLibrary();
}

export async function ensureStudyRomanizations(items, language = state.targetLanguage) {
  const normalizedLanguage = normalizeTrackLanguage(language);
  if (!isRomanizableLanguage(normalizedLanguage)) return;
  const missing = items.filter((item) => item?.value && !studyRomanizationFor({ ...item, language: normalizedLanguage })).slice(0, STUDY_PAGE_SIZE);
  if (!missing.length) return;
  const requestKey = `${normalizedLanguage}|${missing.map((item) => item.value).join("\u0001")}`;
  if (studyRomanizationRequests.has(requestKey)) return studyRomanizationRequests.get(requestKey);
  const task = (async () => {
    try {
      const result = await postJson("/api/subtitles/romanize", { language: normalizedLanguage, texts: missing.map((item) => item.value) });
      const resolved = new Map();
      (result.romanized || []).forEach((text, index) => {
        const item = missing[index];
        const romanized = String(text || "").trim();
        if (item?.value && romanized) {
          studyRomanizationCache.set(studyRomanizationKey(normalizedLanguage, item.value), romanized);
          resolved.set(String(item.value), romanized);
        }
      });
      persistResolvedStudyRomanizations(normalizedLanguage, resolved);
      if ($("#view-study")?.classList.contains("is-active")) renderStudy();
      if (reviewMode === "voice" && voiceChat.mode === "practice" && $("#view-review")?.classList.contains("is-active")) renderVoiceChatStage();
    } catch (error) {
      console.warn("Study romanization unavailable:", error);
    } finally {
      studyRomanizationRequests.delete(requestKey);
    }
  })();
  studyRomanizationRequests.set(requestKey, task);
  return task;
}

export function studyRawItems() {
  const type = state.studyType;
  if (state.studySource === "preset") {
    const preset = state.learningPreset;
    if (preset.language !== state.targetLanguage || preset.status === "idle") void ensureLearningPreset(state.targetLanguage);
    if (preset.language !== state.targetLanguage || preset.status !== "ready") return [];
    const tier = studyTierForType(type);
    return (type === "phrase" ? preset.phrases : preset.words).filter((item) => item.rank <= tier);
  }
  return studyChapterItems(type);
}

function itemMatchesStudyFilter(item, type) {
  const known = isMasteredItem(item, type);
  const review = cardKeySet().has(learningItemKeyFor(item, type));
  if (state.studyFilter === "known") return known;
  if (state.studyFilter === "review") return review;
  if (state.studyFilter === "unknown") return !known;
  return true;
}

export function renderStudyProgress(items, type) {
  const total = items.length;
  const now = Date.now();
  const dueKeys = new Set(state.cards.filter((card) => Number(card.dueAt || 0) <= now).map((card) => card.itemKey || learningItemKey(card.targetLanguage || state.targetLanguage, card.type, card.front)));
  let known = 0;
  let review = 0;
  let due = 0;
  let seen = 0;
  items.forEach((item) => {
    const key = learningItemKeyFor(item, type);
    if (state.known.has(key) || masteredCardKeySet().has(key)) known += 1;
    if (cardKeySet().has(key)) review += 1;
    if (dueKeys.has(key)) due += 1;
    if (Number(state.learningExposure?.[key]?.encounters || 0) > 0) seen += 1;
  });
  $("#study-stat-known").textContent = total ? `${known}/${total}` : "0";
  $("#study-stat-review").textContent = review;
  $("#study-stat-due").textContent = due;
  $("#study-stat-seen").textContent = seen;
}

function renderStudyControlState() {
  $$('[data-study-source]').forEach((button) => {
    const source = button.dataset.studySource;
    const type = button.dataset.studyType;
    const tier = Number(button.dataset.studyTier || 0);
    const active = source === state.studySource && type === state.studyType && (source !== "preset" || tier === studyTierForType(type));
    button.classList.toggle("is-active", active);
  });
  $$('[data-study-category]').forEach((button) => button.classList.toggle("is-active", button.dataset.studyCategory === state.studySource));
  const presetPanel = $("#study-source-presets");
  const chapterPanel = $("#study-source-chapters");
  if (presetPanel) presetPanel.hidden = state.studySource !== "preset";
  if (chapterPanel) chapterPanel.hidden = state.studySource !== "chapter";
  const chapterSelect = $("#study-chapter-select");
  if (chapterSelect) {
    const chapters = studyChapterCatalog();
    const selected = selectedStudyChapter();
    chapterSelect.innerHTML = chapters.length
      ? chapters.map((chapter) => `<option value="${escapeHtml(chapter.id)}" ${chapter.id === selected?.id ? "selected" : ""}>${escapeHtml(chapter.seriesTitle)} ${escapeHtml(libraryChapterName({ code: chapter.code }) || chapter.code)}${chapter.title && chapter.title !== chapter.code ? `: ${escapeHtml(chapter.title)}` : ""}${chapter.hasTargetAnalysis ? "" : " (not indexed)"}</option>`).join("")
      : `<option value="">${escapeHtml(t("No Library chapters"))}</option>`;
    chapterSelect.disabled = !chapters.length;
  }
  const filter = $("#study-filter");
  if (filter && document.activeElement !== filter) filter.value = state.studyFilter;
  const coloring = $("#study-color-subs");
  if (coloring) coloring.checked = state.wordColoring;
}

export function renderStudy() {
  state.studySource = "chapter";
  renderStudyControlState();
  const type = state.studyType;
  const rawItems = studyRawItems();
  renderStudyProgress(rawItems, type);
  const filtered = rawItems.filter((item) => itemMatchesStudyFilter(item, type));
  const pageCount = Math.max(1, Math.ceil(filtered.length / STUDY_PAGE_SIZE));
  state.studyPage = Math.max(0, Math.min(state.studyPage, pageCount - 1));
  const start = state.studyPage * STUDY_PAGE_SIZE;
  const pageItems = filtered.slice(start, start + STUDY_PAGE_SIZE).map((item) => state.studySource === "preset" ? enrichPresetItem(item, type) : ({ ...item, itemKey: learningItemKey(item.language || state.targetLanguage, type, item.value) }));
  if (isRomanizableLanguage(state.targetLanguage)) void ensureStudyRomanizations(pageItems, state.targetLanguage);
  const list = $("#study-items");
  const title = $("#study-list-title");
  const selectedChapter = state.studySource === "chapter" ? selectedStudyChapter() : null;
  if (title) title.textContent = `${t(type === "phrase" ? "Phrases" : "Words")}: ${selectedChapter ? `${selectedChapter.seriesTitle} ${libraryChapterName({ code: selectedChapter.code }) || selectedChapter.code}` : t("from your chapters")}`;
  if (list) {
    if (state.studySource === "preset" && state.learningPreset.status === "loading") list.innerHTML = empty("Loading common deck", state.targetLanguage);
    else if (state.studySource === "preset" && state.learningPreset.status === "error") list.innerHTML = empty("Common deck unavailable", state.learningPreset.error || state.targetLanguage);
    else if (state.studySource === "chapter" && !selectedChapter) list.innerHTML = empty("No chapters in Library", "");
    else if (state.studySource === "chapter" && selectedChapter.language !== state.targetLanguage) list.innerHTML = empty("Target-language index missing", `${selectedChapter.seriesTitle} ${libraryChapterName({ code: selectedChapter.code }) || selectedChapter.code} is indexed as ${selectedChapter.language || "another language"}. Open that chapter and attach ${state.targetLanguage} subtitles.`);
    else if (state.studySource === "chapter" && !rawItems.length) list.innerHTML = empty("No vocabulary yet", `Add ${state.targetLanguage} subtitles to ${selectedChapter.seriesTitle} ${libraryChapterName({ code: selectedChapter.code }) || selectedChapter.code}`);
    else list.innerHTML = renderAnalysisRows(pageItems, type);
    if (pageItems.length) wireAnalysisRows(list, type, pageItems);
  }
  const range = $("#study-page-range");
  if (range) range.textContent = filtered.length ? `${start + 1}–${Math.min(start + STUDY_PAGE_SIZE, filtered.length)} / ${filtered.length}` : "0";
  const previous = $("#study-page-prev");
  const next = $("#study-page-next");
  if (previous) previous.disabled = state.studyPage <= 0;
  if (next) next.disabled = state.studyPage >= pageCount - 1;
  const status = $("#study-preset-status");
  if (status) {
    if (state.studySource === "preset" && state.learningPreset.status === "ready") {
      status.textContent = `${languageName(state.learningPreset.language)}: ${state.learningPreset.words.length.toLocaleString()} words, ${state.learningPreset.phrases.length.toLocaleString()} phrases`;
    } else if (state.studySource === "chapter" && selectedChapter) {
      status.textContent = `${selectedChapter.seriesTitle} ${libraryChapterName({ code: selectedChapter.code }) || selectedChapter.code}, ${languageName(selectedChapter.language || state.targetLanguage)}: ${selectedChapter.analysis?.words?.length || 0} words, ${selectedChapter.analysis?.phrases?.length || 0} phrases`;
    } else status.textContent = "";
  }
}
