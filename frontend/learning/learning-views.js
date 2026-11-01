// Learning: keys and wiring of the Study, Review and Test views.
import { bindTabs } from "../ui/ui.js";
import { quiz, studyView, testSetup } from "../../app.js";
import { $ } from "../app/dom.js";
import { switchView, viewActive } from "../app/navigation.js";
import { changeReviewTargetLanguage, reviewMode } from "./voice-coach.js";
import {
  addAnkiwebDeck, addTopWords, closeStudySession, currentStudyCard, deleteStudyDeck,
  exportCardsToAnki, openAnkiwebDialog, openStudyDeck, openTopWordsDialog, playStudySounds,
  rateStudyCard, replayStudyCard, revealStudyAnswer, searchAnkiweb, stopStudySounds, studyDecks,
  suspendStudyCard, toggleAnkiwebDetails, undoStudyRating,
} from "./study-decks.js";
import {
  currentDictationClip, dictation, loadDictationClips, nextDictation, renderDictation,
  renderStudyPage, startDictation, submitDictationAnswer,
} from "./study-page.js";
import { answerQuiz, renderQuiz } from "./review-quiz.js";
import {
  answerTestQuestion, currentTestQuestion, endTestSession, renderTest, startTestSession,
} from "./scored-tests.js";

/* ---------------------------------------------------------------- keys and wiring */

// Study keys (Anki's): Space/Enter show or Good, 1–4 rate, R replay, U undo, Esc decks.
export function handleStudyKey(event) {
  if (!viewActive("study") || !studyView.deckKey) return false;
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  const card = currentStudyCard();
  if (event.code === "Escape") { closeStudySession(); return true; }
  if (event.key?.toLowerCase() === "u") { event.preventDefault(); undoStudyRating(); return true; }
  if (!card) return false;
  if ((event.code === "Space" || event.code === "Enter") && !studyView.revealed) { event.preventDefault(); revealStudyAnswer(); return true; }
  if ((event.code === "Space" || event.code === "Enter") && studyView.revealed && (!event.target?.closest?.("button") || event.target.id === "show-answer" || event.target.classList?.contains("study-rating"))) { event.preventDefault(); rateStudyCard("good"); return true; }
  const rating = { 1: "again", 2: "hard", 3: "good", 4: "easy" }[event.key];
  if (rating && studyView.revealed) { event.preventDefault(); rateStudyCard(rating); return true; }
  if (event.key?.toLowerCase() === "r") { event.preventDefault(); replayStudyCard(); return true; }
  return false;
}

export function handleQuizKey(event) {
  if (!viewActive("review") || reviewMode === "voice" || event.ctrlKey || event.metaKey || event.altKey) return false;
  if (!quiz.question) return false;
  if (quiz.picked === null && /^[1-4]$/.test(event.key) && Number(event.key) <= quiz.question.options.length) { event.preventDefault(); answerQuiz(Number(event.key) - 1); return true; }
  if (quiz.picked !== null && event.code === "Enter") { event.preventDefault(); quiz.question = null; renderQuiz(); return true; }
  return false;
}

export function handleTestKey(event, typing) {
  if (!viewActive("test") || event.metaKey || event.altKey) return false;
  const question = currentTestQuestion();
  if (!question) return false;
  if (event.ctrlKey && event.code === "Space" && question.audioUrl) { event.preventDefault(); playStudySounds([question.audioUrl]); return true; }
  if (!typing && (question.type === "choice" || question.type === "listen-choice") && /^[1-4]$/.test(event.key) && Number(event.key) <= question.options.length) {
    event.preventDefault();
    answerTestQuestion(Number(event.key) - 1);
    return true;
  }
  return false;
}

export function wireLearningViews() {
  bindTabs($("#study-tabs"), { onChange: (value) => { studyView.tab = value; renderStudyPage(); } });
  $("#study-target-language")?.addEventListener("change", (event) => changeReviewTargetLanguage(event.target.value));
  $("#study-add-top")?.addEventListener("click", () => { void openTopWordsDialog(); });
  $("#study-add-ankiweb")?.addEventListener("click", openAnkiwebDialog);
  $("#study-deck-list")?.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.dataset.emptyAction === "top") { void openTopWordsDialog(); return; }
    if (button.dataset.emptyAction === "ankiweb") { openAnkiwebDialog(); return; }
    const row = button.closest("[data-deck-key]");
    const deck = row ? studyDecks().find((item) => item.key === row.dataset.deckKey) : null;
    if (!deck) return;
    if (button.hasAttribute("data-deck-open")) openStudyDeck(deck.key);
    else if (button.hasAttribute("data-deck-menu")) { studyView.menuKey = studyView.menuKey === deck.key ? null : deck.key; renderStudyPage(); }
    else if (button.dataset.deckExport) void exportCardsToAnki(button.dataset.deckExport, { cards: deck.cards, deckName: deck.name, button });
    else if (button.hasAttribute("data-deck-delete")) void deleteStudyDeck(deck);
  });
  $("#study-session-back")?.addEventListener("click", closeStudySession);
  $("#study-stage")?.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.id === "show-answer") revealStudyAnswer();
    else if (button.dataset.rating) rateStudyCard(button.dataset.rating);
    else if (button.hasAttribute("data-study-replay")) replayStudyCard();
    else if (button.hasAttribute("data-study-undo")) undoStudyRating();
    else if (button.hasAttribute("data-study-suspend")) suspendStudyCard();
    else if (button.hasAttribute("data-study-back")) closeStudySession();
  });
  $("#dictation-stage")?.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.dataset.dictationStart) startDictation(button.dataset.dictationStart);
    else if (button.hasAttribute("data-dictation-exit")) { dictation.group = null; dictation.results = []; renderDictation(); }
    else if (button.id === "dictation-play") { const clip = currentDictationClip(); if (clip) playStudySounds([clip.audioUrl]); }
    else if (button.id === "dictation-next") nextDictation();
  });
  $("#dictation-stage")?.addEventListener("submit", (event) => { event.preventDefault(); submitDictationAnswer(); });
  $("#dictation-stage")?.addEventListener("keydown", (event) => {
    if (event.target.id === "dictation-input" && event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submitDictationAnswer(); }
    else if (event.ctrlKey && event.code === "Space") { event.preventDefault(); const clip = currentDictationClip(); if (clip) playStudySounds([clip.audioUrl]); }
  });
  $("#top-words-options")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-top-size]");
    if (button && !button.disabled) void addTopWords(Number(button.dataset.topSize), button);
  });
  $("#ankiweb-search-form")?.addEventListener("submit", (event) => { event.preventDefault(); void searchAnkiweb($("#ankiweb-query").value); });
  $("#ankiweb-results")?.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    const row = button?.closest("[data-shared-id]");
    if (!row) return;
    const sharedId = Number(row.dataset.sharedId);
    if (button.hasAttribute("data-ankiweb-toggle")) void toggleAnkiwebDetails(sharedId);
    else if (button.hasAttribute("data-ankiweb-add")) void addAnkiwebDeck(sharedId);
    else if (button.hasAttribute("data-ankiweb-study")) { $("#ankiweb-dialog").close(); studyView.tab = "decks"; switchView("study"); openStudyDeck(`store:ankiweb-${sharedId}`); }
  });
  $("#quiz-panel")?.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.dataset.quizOption !== undefined) answerQuiz(Number(button.dataset.quizOption));
    else if (button.dataset.quizDirection) { stopStudySounds(); quiz.direction = button.dataset.quizDirection; quiz.question = null; if (quiz.direction === "listening") void loadDictationClips({ force: dictation.status === "error" }); renderQuiz(); }
    else if (button.hasAttribute("data-quiz-play")) { if (quiz.question?.audioUrl) playStudySounds([quiz.question.audioUrl]); }
    else if (button.id === "quiz-next") { stopStudySounds(); quiz.question = null; renderQuiz(); }
  });
  $("#quiz-panel")?.addEventListener("change", (event) => {
    if (event.target.id === "quiz-deck") { quiz.deckKey = event.target.value; quiz.question = null; quiz.recent = []; renderQuiz(); }
  });
  $("#test-stage")?.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.id === "test-start" || button.id === "test-restart") startTestSession();
    else if (button.id === "test-setup-back" || button.id === "test-quit") { endTestSession(); stopStudySounds(); renderTest(); }
    else if (button.dataset.testSize) { testSetup.size = Number(button.dataset.testSize); renderTest(); }
    else if (button.dataset.testOption !== undefined) answerTestQuestion(Number(button.dataset.testOption));
    else if (button.hasAttribute("data-test-play")) { const question = currentTestQuestion(); if (question?.audioUrl) playStudySounds([question.audioUrl]); }
  });
  $("#test-stage")?.addEventListener("change", (event) => {
    if (event.target.id === "test-deck") { testSetup.deckKey = event.target.value; renderTest(); }
    else if (event.target.dataset.testType) { testSetup.types[event.target.dataset.testType] = event.target.checked; renderTest(); }
  });
  $("#test-stage")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = $("#test-answer");
    if (input) answerTestQuestion(input.value.trim());
  });
  $("#test-stage")?.addEventListener("keydown", (event) => {
    if (event.target.id === "test-answer" && event.target.tagName === "TEXTAREA" && event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      answerTestQuestion(event.target.value.trim());
    }
  });
}
