// Learning: Review's quick quiz.
import { buttonMarkup, emptyMarkup, escapeHtml, icon } from "../ui/ui.js";
import {
  choiceQuestion, listeningMeaningQuestion, quizPool, shuffle, studyDeckKey,
} from "../../learning/browser/learn.js";
import { t } from "../ui/ui-i18n.js";
import { quiz, state } from "../../app.js";
import { saveState } from "../app/saved-state.js";
import { $, $$ } from "../app/dom.js";
import { viewActive } from "../app/navigation.js";
import { refreshBrowserCoachStatus, renderVoiceChatStage, reviewMode, reviewTabId, voiceChat } from "./voice-coach.js";
import { languageName, reviewSentenceMarkup, studyDecks, updateDueCount } from "./study-decks.js";
import { dictation, loadDictationClips, renderStudyLanguageSelect, renderStudyPage } from "./study-page.js";

function quizDeckOptions() {
  return studyDecks().filter((deck) => quizPool(deck.cards).length >= 4);
}

function quizCards() {
  if (quiz.deckKey === "all") return state.cards.filter((card) => !card.targetLanguage || card.targetLanguage === state.targetLanguage);
  return state.cards.filter((card) => studyDeckKey(card) === quiz.deckKey);
}

function nextQuizQuestion() {
  quiz.picked = null;
  if (quiz.direction === "listening") {
    const clips = dictation.clips.filter((clip) => clip.lang === state.targetLanguage && clip.baseLang === state.baseLanguage);
    const fresh = clips.filter((clip) => !quiz.recent.includes(`clip:${clip.id}`));
    quiz.question = null;
    for (const clip of shuffle(fresh.length ? fresh : clips)) {
      quiz.question = listeningMeaningQuestion(clip, clips);
      if (quiz.question) break;
    }
    if (quiz.question) quiz.recent = [`clip:${quiz.question.clipId}`, ...quiz.recent].slice(0, Math.min(12, Math.floor(clips.length / 2)));
    return;
  }
  const pool = quizPool(quizCards());
  if (pool.length < 4) {
    quiz.question = null;
    return;
  }
  const fresh = pool.filter((card) => !quiz.recent.includes(card.id));
  const candidates = shuffle(fresh.length ? fresh : pool);
  const reverse = quiz.direction === "reverse" || (quiz.direction === "mixed" && Math.random() < 0.5);
  quiz.question = null;
  for (const card of candidates) {
    quiz.question = choiceQuestion(card, pool, { reverse }) || choiceQuestion(card, pool, { reverse: !reverse });
    if (quiz.question) break;
  }
  if (quiz.question) quiz.recent = [quiz.question.cardId, ...quiz.recent].slice(0, Math.min(12, Math.floor(pool.length / 2)));
}

export function answerQuiz(index) {
  const question = quiz.question;
  if (!question || quiz.picked !== null) return;
  quiz.picked = Number(index);
  const right = quiz.picked === question.answerIndex;
  quiz.total += 1;
  quiz.correct += right ? 1 : 0;
  quiz.streak = right ? quiz.streak + 1 : 0;
  state.cards = state.cards.map((card) => (card.id === question.cardId
    ? { ...card, quiz: { right: (Number(card.quiz?.right) || 0) + (right ? 1 : 0), wrong: (Number(card.quiz?.wrong) || 0) + (right ? 0 : 1), lastAt: Date.now() } }
    : card));
  saveState();
  renderQuiz();
}

export function renderQuiz() {
  const panel = $("#quiz-panel");
  if (!panel) return;
  const decks = quizDeckOptions();
  const listening = quiz.direction === "listening";
  if (listening && dictation.loadedFor !== state.targetLanguage && !["loading", "error"].includes(dictation.status)) void loadDictationClips();
  if (quiz.deckKey !== "all" && !decks.some((deck) => deck.key === quiz.deckKey)) quiz.deckKey = "all";
  if (!quiz.question) nextQuizQuestion();
  const question = quiz.question;
  const card = question ? state.cards.find((item) => item.id === question.cardId) : null;
  const controls = `<div class="quiz-controls">
    ${!listening ? `<label class="learn-select"><span data-i18n="Deck">Deck</span><select id="quiz-deck"><option value="all">${escapeHtml(t("All {language} cards", { language: languageName(state.targetLanguage) }))}</option>${decks.map((deck) => `<option value="${escapeHtml(deck.key)}" ${deck.key === quiz.deckKey ? "selected" : ""}>${escapeHtml(deck.name)}</option>`).join("")}</select></label>` : ""}
    <div class="ui-segmented" role="group" aria-label="${escapeHtml(t("Question direction"))}">${[["forward", "Word → meaning"], ["reverse", "Meaning → word"], ["mixed", "Mixed"], ["listening", "Listening"]].map(([value, label]) => `<button class="ui-segmented__item" type="button" data-quiz-direction="${value}" aria-pressed="${quiz.direction === value}" data-i18n="${label}">${label}</button>`).join("")}</div>
    <span class="quiz-score" aria-live="polite">${quiz.total ? escapeHtml(t("Quiz score: {correct}/{total}", { correct: quiz.correct, total: quiz.total })) : ""}</span>
  </div>`;
  if (!question || (!listening && !card)) {
    panel.innerHTML = `${controls}${emptyMarkup({ icon: "sparkle", title: t(listening ? dictation.status === "loading" ? "Loading saved lines…" : "Not enough translated lines" : "Not enough cards to quiz"), text: t(listening ? "Listening needs four saved lines with different translations in your current language pair. Watch a chapter with both subtitle languages to save lines." : "A quiz needs at least four cards with a meaning. Add Top words or a deck in Study.") })}`;
    return;
  }
  const answered = quiz.picked !== null;
  const right = answered && quiz.picked === question.answerIndex;
  const cloze = question.kind === "cloze";
  const promptLang = question.reverse && !cloze ? card?.baseLanguage || state.baseLanguage : card?.targetLanguage || state.targetLanguage;
  const optionLang = question.reverse ? card?.targetLanguage || state.targetLanguage : card?.baseLanguage || state.baseLanguage;
  const ask = listening ? "Which line do you hear?" : cloze ? "Which word completes the line?" : question.kind === "sentence" ? "What does this line mean?" : question.reverse ? "Which word means" : "What does this mean?";
  panel.innerHTML = `${controls}<article class="quiz-card${answered ? (right ? " is-right" : " is-wrong") : ""}">
    <p class="quiz-card__ask">${escapeHtml(t(ask))}</p>
    ${listening ? buttonMarkup({ label: t("Play line"), icon: "play", attrs: { "data-quiz-play": "" } }) : `<div class="quiz-card__prompt" lang="${escapeHtml(String(promptLang).toLowerCase())}" data-card-content>${escapeHtml(question.prompt)}</div>`}
    ${cloze && question.context ? `<p class="native-card__translation" data-card-content>${escapeHtml(question.context)}</p>` : ""}
    ${!question.reverse && card?.romanized && card.romanized !== card.front && answered ? `<p class="quiz-card__reading" data-card-content>${escapeHtml(card.romanized)}</p>` : ""}
    <div class="quiz-options" role="group" aria-label="Answers">${question.options.map((option, index) => {
      const state_ = !answered ? "" : index === question.answerIndex ? " is-answer" : index === quiz.picked ? " is-picked" : " is-dim";
      return `<button class="quiz-option${state_}" type="button" data-quiz-option="${index}" lang="${escapeHtml(String(optionLang).toLowerCase())}"${answered ? ' aria-disabled="true"' : ""}><kbd class="ui-kbd">${index + 1}</kbd><span>${escapeHtml(option)}</span>${answered && index === question.answerIndex ? `<b class="quiz-option__mark">${icon("check")}<span class="ui-visually-hidden">Correct answer</span></b>` : answered && index === quiz.picked ? '<b class="quiz-option__mark">✕<span class="ui-visually-hidden">Your answer</span></b>' : ""}</button>`;
    }).join("")}</div>
    ${answered ? `<div class="quiz-feedback" role="status"><strong>${escapeHtml(t(right ? "Right" : "Not quite"))}</strong>${listening ? `<p class="native-card__word" data-card-content>${escapeHtml(question.sourceText)}</p>` : card.context ? reviewSentenceMarkup(card) : ""}${!listening && card.baseContext && card.baseContext !== question.answer ? `<p class="native-card__translation" data-card-content>${escapeHtml(card.baseContext)}</p>` : ""}<div class="quiz-feedback__actions">${buttonMarkup({ label: t("Next"), variant: "primary", attrs: { id: "quiz-next" } })}<span class="learn-footnote" data-i18n="Enter for next, 1–4 to answer">Enter for next, 1–4 to answer</span></div></div>` : ""}
  </article>`;
  if (answered) $("#quiz-next")?.focus({ preventScroll: true });
}

export function renderReview() {
  updateDueCount();
  if (viewActive("study")) renderStudyPage();
  if (!viewActive("review")) return;
  const activeTab = reviewTabId();
  $$("[data-review-tab]").forEach((button) => {
    const active = button.dataset.reviewTab === activeTab;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  });
  renderStudyLanguageSelect($("#review-target-language"));
  const voice = reviewMode === "voice";
  $("#quiz-panel").hidden = voice;
  $("#review-stage").hidden = !voice;
  $("#review-summary").textContent = t(!voice ? "A quick quiz: pick the answer and see right away if it's right."
    : voiceChat.mode === "practice" ? "Say words you've studied out loud and get feedback from your coach."
      : "Talk with a ChatGPT coach about a topic, by voice.");
  $("#review-stage")?.classList.toggle("is-voice-practice", voice);
  $("#review-stage")?.closest(".review-layout")?.classList.toggle("is-voice-mode", voice);
  if (voice) {
    renderVoiceChatStage();
    if (voiceChat.bridgeAvailable === null) void refreshBrowserCoachStatus();
    return;
  }
  renderQuiz();
}
