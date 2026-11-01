// Learning: the Study page and dictation.
import { alignDictation } from "../../learning/browser/core.js";
import { buttonMarkup, emptyMarkup, escapeHtml, icon, setActiveTab } from "../ui/ui.js";
import { shuffle } from "../../learning/browser/learn.js";
import { t } from "../ui/ui-i18n.js";
import { quiz, SPEECH_LOCALES, state, studyView } from "../../app.js";
import { $ } from "../app/dom.js";
import { fetchJson } from "../app/http.js";
import { viewActive } from "../app/navigation.js";
import { renderStudy } from "./study-vocabulary.js";
import {
  languageName, loadStoredDecks, playStudySounds, renderStudyDecks, renderStudySession,
  storedDecksState, studyDecks, updateDueCount,
} from "./study-decks.js";
import { renderQuiz } from "./review-quiz.js";
import { renderTest } from "./scored-tests.js";

/* ---------------------------------------------------------------- Study: page and dictation */

export function renderStudyLanguageSelect(select) {
  if (!select) return;
  select.innerHTML = Object.keys(SPEECH_LOCALES)
    .filter((language) => language !== state.baseLanguage)
    .map((language) => `<option value="${language}" ${language === state.targetLanguage ? "selected" : ""}>${escapeHtml(languageName(language))}</option>`)
    .join("");
}

export function renderStudyPage() {
  if (storedDecksState === "idle") void loadStoredDecks();
  renderStudyLanguageSelect($("#study-target-language"));
  const now = Date.now();
  const decks = studyDecks(now);
  const due = updateDueCount(decks);
  $("#study-summary").textContent = state.cards.length
    ? t("{due} to study today, from {cards} cards in {decks} decks", { due: due.toLocaleString(), cards: state.cards.length.toLocaleString(), decks: decks.filter((deck) => deck.total).length })
    : "";
  const inSession = Boolean(studyView.deckKey);
  $("#study-session").hidden = !inSession;
  $("#study-tabs").hidden = inSession;
  for (const tab of ["decks", "dictation", "words"]) {
    const panel = $(`#study-panel-${tab}`);
    if (panel) panel.hidden = inSession || studyView.tab !== tab;
  }
  setActiveTab($("#study-tabs"), studyView.tab);
  const summary = $("#review-deck-summary");
  const suspended = state.cards.filter((card) => card.suspended).length;
  if (summary) summary.textContent = suspended ? `${suspended.toLocaleString()} suspended card${suspended === 1 ? "" : "s"} are not shown.` : "";
  $("#review-export-anki")?.toggleAttribute("disabled", !state.cards.length);
  $("#review-export-text")?.toggleAttribute("disabled", !state.cards.length);
  if (inSession) {
    if (!studyView.cardId || !$("#study-stage .study-card, #study-stage .study-done")) renderStudySession();
    return;
  }
  if (studyView.tab === "decks") renderStudyDecks(decks);
  else if (studyView.tab === "dictation") renderDictation();
  else renderStudy();
}

// Dictation: lines saved from watched episodes. Hear the line, type it, compare with the subtitle.
export const dictation = { clips: [], status: "idle", error: "", loadedFor: "", group: null, queue: [], index: 0, answer: null, results: [] };

export async function loadDictationClips({ force = false } = {}) {
  const language = state.targetLanguage;
  if (dictation.status === "loading" || (!force && dictation.loadedFor === language && dictation.status === "ready")) return dictation.clips;
  dictation.status = "loading";
  try {
    const data = await fetchJson(`/api/clips?${new URLSearchParams({ lang: language, limit: "3000" })}`);
    const cardLanguages = new Map(state.cards.filter((card) => card.clipId).map((card) => [card.clipId, card.baseLanguage]));
    dictation.clips = (data.clips || []).filter((clip) => clip.text).map((clip) => ({ ...clip,
      baseLang: clip.baseLang || cardLanguages.get(clip.id) || "" }));
    dictation.status = "ready";
    dictation.loadedFor = language;
  } catch (error) {
    dictation.status = "error";
    dictation.error = error.message || "Couldn't load saved lines";
  }
  if (viewActive("study") && studyView.tab === "dictation") renderDictation();
  if (viewActive("test")) renderTest();
  if (viewActive("review") && quiz.direction === "listening") renderQuiz();
  return dictation.clips;
}

function dictationGroups() {
  const groups = new Map();
  for (const clip of dictation.clips) {
    const key = `${clip.libraryId}|${clip.fileIndex}`;
    if (!groups.has(key)) groups.set(key, { key, series: clip.series || "Video", chapter: clip.chapter || "", clips: [] });
    groups.get(key).clips.push(clip);
  }
  return [...groups.values()].sort((a, b) => a.series.localeCompare(b.series) || a.chapter.localeCompare(b.chapter, undefined, { numeric: true }));
}

export function startDictation(groupKey) {
  const pool = groupKey === "all" ? dictation.clips : dictationGroups().find((group) => group.key === groupKey)?.clips || [];
  dictation.group = groupKey;
  dictation.queue = shuffle(pool).slice(0, 15);
  dictation.index = 0;
  dictation.answer = null;
  dictation.results = [];
  renderDictation();
}

export function currentDictationClip() {
  return dictation.group ? dictation.queue[dictation.index] || null : null;
}

export function renderDictation() {
  const stage = $("#dictation-stage");
  if (!stage) return;
  if (dictation.loadedFor !== state.targetLanguage || dictation.status === "idle") void loadDictationClips({ force: true });
  if (dictation.status === "loading" && !dictation.clips.length) {
    stage.innerHTML = '<div class="ui-skeleton ui-skeleton--wide" aria-hidden="true"></div>';
    return;
  }
  const clip = currentDictationClip();
  if (!dictation.group || (!clip && !dictation.results.length)) {
    const groups = dictationGroups();
    stage.innerHTML = groups.length
      ? `<div class="dictation-intro"><p>${dictation.clips.length.toLocaleString()} ${escapeHtml(languageName(state.targetLanguage))} lines saved from ${groups.length} chapter${groups.length === 1 ? "" : "s"}. Rounds of 15.</p>${buttonMarkup({ label: "Mix all chapters", variant: "primary", attrs: { "data-dictation-start": "all" } })}</div>
        <div class="dictation-groups">${groups.map((group) => `<button class="dictation-group" type="button" data-dictation-start="${escapeHtml(group.key)}"><strong>${escapeHtml(group.series)}</strong><span>${escapeHtml([group.chapter, `${group.clips.length} line${group.clips.length === 1 ? "" : "s"}`].filter(Boolean).join(", "))}</span></button>`).join("")}</div>`
      : emptyMarkup({ icon: "subtitles", title: "No saved lines yet", text: `While you watch with ${languageName(state.targetLanguage)} subtitles, lines are saved here with their audio. Come back after an episode.` });
    return;
  }
  if (!clip) {
    const average = Math.round(dictation.results.reduce((sum, item) => sum + item.accuracy, 0) / Math.max(1, dictation.results.length));
    stage.innerHTML = `<div class="dictation-card dictation-done"><strong class="dictation-score">${average}%</strong><p>${dictation.results.length} lines, ${dictation.results.filter((item) => item.accuracy >= 80).length} right</p><div class="dictation-actions">${buttonMarkup({ label: "Another round", variant: "primary", attrs: { "data-dictation-start": dictation.group } })}${buttonMarkup({ label: "Chapters", variant: "ghost", attrs: { "data-dictation-exit": "" } })}</div></div>`;
    return;
  }
  const result = dictation.answer;
  const diff = result?.diff?.map((item) => {
    if (item.type === "correct") return `<span class="dictation-token is-correct">${escapeHtml(item.expected)}</span>`;
    if (item.type === "missing") return `<span class="dictation-token is-missing">${escapeHtml(item.expected)}</span>`;
    if (item.type === "extra") return `<span class="dictation-token is-extra">${escapeHtml(item.actual)}</span>`;
    return `<span class="dictation-token is-substituted"><del>${escapeHtml(item.actual)}</del> <ins>${escapeHtml(item.expected)}</ins></span>`;
  }).join(" ") || "";
  stage.innerHTML = `<article class="dictation-card">
    <header class="dictation-card__head"><span>${escapeHtml([clip.series, clip.chapter].filter(Boolean).join(", "))}</span><strong>${dictation.index + 1} / ${dictation.queue.length}</strong></header>
    ${result && clip.imageUrl ? `<img class="dictation-card__still" src="${escapeHtml(clip.imageUrl)}" alt="" loading="lazy">` : ""}
    <button id="dictation-play" class="dictation-play" type="button" aria-label="Play the line (Ctrl+Space)">${icon("play")}<span>Play line</span></button>
    ${result ? `<div class="dictation-result"><strong>${result.accuracy}%</strong><div class="dictation-diff" lang="${escapeHtml(state.targetLanguage.toLowerCase())}">${diff}</div>${clip.baseText ? `<p class="dictation-translation">${escapeHtml(clip.baseText)}</p>` : ""}</div>
      <div class="dictation-actions">${buttonMarkup({ label: "Next", variant: "primary", attrs: { id: "dictation-next" } })}</div>`
      : `<form id="dictation-form" class="dictation-form"><label for="dictation-input">Type what you hear</label><textarea id="dictation-input" rows="2" autocomplete="off" autocapitalize="off" spellcheck="false" lang="${escapeHtml(state.targetLanguage.toLowerCase())}"></textarea><div class="dictation-actions">${buttonMarkup({ label: "Check", variant: "primary", type: "submit" })}<span class="learn-footnote">Enter checks, Ctrl+Space plays it again</span></div></form>`}
  </article>`;
  stage.querySelector(".dictation-card__still")?.addEventListener("error", (event) => event.target.remove(), { once: true });
  if (!result) {
    playStudySounds([clip.audioUrl]);
    queueMicrotask(() => $("#dictation-input")?.focus());
  } else $("#dictation-next")?.focus();
}

export function submitDictationAnswer() {
  const clip = currentDictationClip();
  const input = $("#dictation-input");
  if (!clip || !input || dictation.answer) return;
  const typed = input.value.trim();
  if (!typed) return;
  const aligned = alignDictation(clip.text, typed);
  dictation.answer = { ...aligned, typed };
  dictation.results.push({ clipId: clip.id, accuracy: aligned.accuracy });
  renderDictation();
}

export function nextDictation() {
  if (!dictation.answer) return;
  dictation.index += 1;
  dictation.answer = null;
  renderDictation();
}
