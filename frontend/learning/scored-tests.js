// Learning: scored mixed tests.
import { buttonMarkup, escapeHtml, icon, toast } from "../ui/ui.js";
import { buildMixedTest, gradeQuestion, quizPool, studyDeckKey } from "../../learning/browser/learn.js";
import { state, testSetup } from "../../app.js";
import { saveTestResults } from "../app/saved-state.js";
import { $ } from "../app/dom.js";
import { loadStoredDecks, playStudySounds, stopStudySounds, storedDecksState, studyDecks } from "./study-decks.js";
import { dictation, loadDictationClips } from "./study-page.js";
import { languageName } from "../player/player-tracks.js";

let testSession = null;

const TEST_TYPE_LABELS = { choice: "Multiple choice", "listen-choice": "Listening", typing: "Typing", dictation: "Listening" };

function testCards() {
  if (testSetup.deckKey === "all") return state.cards.filter((card) => !card.targetLanguage || card.targetLanguage === state.targetLanguage);
  return state.cards.filter((card) => studyDeckKey(card) === testSetup.deckKey);
}

export function startTestSession() {
  const questions = buildMixedTest({ cards: testCards(), clips: dictation.clips, size: testSetup.size, types: testSetup.types });
  if (!questions.length) {
    toast("Not enough cards or saved lines for a test", { tone: "error" });
    return;
  }
  testSession = { id: crypto.randomUUID(), questions, index: 0, answers: [], startedAt: Date.now(), completed: false };
  renderTest();
}

export function currentTestQuestion() {
  return testSession && !testSession.completed ? testSession.questions[testSession.index] || null : null;
}

export function answerTestQuestion(response) {
  const question = currentTestQuestion();
  if (!question) return;
  stopStudySounds();
  testSession.answers.push({ response, ...gradeQuestion(question, response) });
  testSession.index += 1;
  if (testSession.index >= testSession.questions.length) finishTestSession();
  else renderTest();
}

function finishTestSession() {
  const total = testSession.questions.length;
  const points = testSession.answers.reduce((sum, answer) => sum + (Number(answer.points) || 0), 0);
  const result = {
    id: testSession.id,
    mode: "mixed",
    targetLanguage: state.targetLanguage,
    score: total ? Math.round(points / total) : 0,
    correct: testSession.answers.filter((answer) => answer.correct).length,
    total,
    startedAt: testSession.startedAt,
    completedAt: Date.now(),
  };
  state.testResults.push(result);
  saveTestResults();
  testSession = { ...testSession, completed: true, result };
  renderTest();
}

export function endTestSession() {
  testSession = null;
}

function testHistorySvg(results) {
  if (!results.length) return '<p class="learn-footnote">Scores appear here after your first test.</p>';
  const recent = results.slice(-20);
  const width = 320;
  const height = 116;
  const pad = 10;
  const step = recent.length > 1 ? (width - pad * 2) / (recent.length - 1) : 0;
  const points = recent.map((result, index) => ({
    x: recent.length > 1 ? pad + index * step : width / 2,
    y: pad + ((100 - Math.max(0, Math.min(100, Number(result.score) || 0))) / 100) * (height - pad * 2),
    score: result.score,
  }));
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Test scores over time"><path class="test-chart-guide" d="M${pad} ${pad}H${width - pad}M${pad} ${height / 2}H${width - pad}M${pad} ${height - pad}H${width - pad}"/><polyline class="test-chart-line" points="${points.map(({ x, y }) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ")}"/>${points.map(({ x, y, score }) => `<circle class="test-chart-point" cx="${x}" cy="${y}" r="3"><title>${score}%</title></circle>`).join("")}</svg>`;
}

function renderTestHistory() {
  const results = state.testResults.filter((result) => result && Number.isFinite(Number(result.score)));
  const scores = results.map((result) => Number(result.score));
  $("#test-stat-last").textContent = scores.length ? `${scores.at(-1)}%` : "—";
  $("#test-stat-average").textContent = scores.length ? `${Math.round(scores.reduce((sum, value) => sum + value, 0) / scores.length)}%` : "—";
  $("#test-stat-best").textContent = scores.length ? `${Math.max(...scores)}%` : "—";
  $("#test-stat-sessions").textContent = String(scores.length);
  $("#test-history-chart").innerHTML = testHistorySvg(results);
  const modeName = (mode) => ({ mixed: "Mixed", recall: "Recall", listening: "Listening", dictation: "Dictation" })[mode] || "Test";
  $("#test-history-list").innerHTML = results.slice(-6).reverse().map((result) => `<div><span>${escapeHtml(modeName(result.mode))}, ${new Date(Number(result.completedAt) || Date.now()).toLocaleDateString()}</span><strong>${Math.round(Number(result.score) || 0)}%</strong></div>`).join("");
}

function testSetupMarkup() {
  const decks = studyDecks().filter((deck) => deck.total >= 4);
  const clips = dictation.clips.length;
  const pool = quizPool(testCards()).length;
  const types = [["choice", "Multiple choice"], ["typing", "Typing"], ["listening", `Listening${clips ? "" : " (no saved lines yet)"}`]];
  return `<div class="test-setup">
    <div class="test-setup__row">
      <label class="learn-select"><span>Deck</span><select id="test-deck"><option value="all">All ${escapeHtml(languageName(state.targetLanguage))} cards</option>${decks.map((deck) => `<option value="${escapeHtml(deck.key)}" ${deck.key === testSetup.deckKey ? "selected" : ""}>${escapeHtml(deck.name)}</option>`).join("")}</select></label>
      <div class="ui-segmented" role="group" aria-label="Questions">${[10, 20, 30].map((size) => `<button class="ui-segmented__item" type="button" data-test-size="${size}" aria-pressed="${testSetup.size === size}">${size} questions</button>`).join("")}</div>
    </div>
    <div class="test-setup__row test-setup__types" role="group" aria-label="Question types">${types.map(([key, label]) => `<label class="ui-check"><input type="checkbox" data-test-type="${key}" ${testSetup.types[key] ? "checked" : ""}${key === "listening" && !clips ? " disabled" : ""}><span class="ui-check__box" aria-hidden="true"></span>${escapeHtml(label)}</label>`).join("")}</div>
    <div class="test-setup__row">${buttonMarkup({ label: "Start test", variant: "primary", size: "lg", attrs: { id: "test-start", ...(pool >= 4 || clips ? {} : { disabled: true }) } })}<span class="learn-footnote">${pool.toLocaleString()} cards ready${clips ? `, ${clips.toLocaleString()} saved lines` : ""}</span></div>
  </div>`;
}

function renderTestResults(stage) {
  const { result, questions, answers } = testSession;
  const byType = new Map();
  questions.forEach((question, index) => {
    const label = TEST_TYPE_LABELS[question.type] || question.type;
    const row = byType.get(label) || { right: 0, total: 0 };
    row.total += 1;
    row.right += answers[index]?.correct ? 1 : 0;
    byType.set(label, row);
  });
  const mistakes = questions.map((question, index) => ({ question, answer: answers[index] })).filter(({ answer }) => !answer?.correct);
  const shown = (question, answer) => question.type === "choice" || question.type === "listen-choice" ? question.options[Number(answer.response)] ?? "—" : String(answer.response || "—");
  stage.innerHTML = `<article class="test-card test-results">
    <div class="test-results__score"><strong>${result.score}%</strong><span>${result.correct} of ${result.total} right</span></div>
    <div class="test-results__types">${[...byType.entries()].map(([label, row]) => `<span class="ui-chip">${escapeHtml(label)} <b>${row.right}/${row.total}</b></span>`).join("")}</div>
    ${mistakes.length ? `<h3>To go over</h3><ol class="test-mistakes">${mistakes.map(({ question, answer }) => `<li><span class="test-mistakes__prompt">${escapeHtml(question.prompt || (question.type === "dictation" || question.type === "listen-choice" ? "Listening" : ""))}</span><span class="test-mistakes__yours">${escapeHtml(shown(question, answer))}</span><span class="test-mistakes__right">${escapeHtml(question.answer)}</span></li>`).join("")}</ol>` : "<p>No mistakes.</p>"}
    <div class="test-results__actions">${buttonMarkup({ label: "New test", variant: "primary", attrs: { id: "test-restart" } })}${buttonMarkup({ label: "Change setup", variant: "ghost", attrs: { id: "test-setup-back" } })}</div>
  </article>`;
}

function renderTestStage() {
  const stage = $("#test-stage");
  if (!stage) return;
  if (!testSession) {
    stage.innerHTML = testSetupMarkup();
    return;
  }
  if (testSession.completed) {
    renderTestResults(stage);
    return;
  }
  const question = currentTestQuestion();
  const progress = `<div class="test-progress"><span>${testSession.index + 1} / ${testSession.questions.length}</span><div class="ui-progress" aria-hidden="true"><span style="width:${Math.round((testSession.index / testSession.questions.length) * 100)}%"></span></div><button class="ui-btn ui-btn--ghost ui-btn--sm" type="button" id="test-quit">Stop</button></div>`;
  const lang = escapeHtml(state.targetLanguage.toLowerCase());
  let body = "";
  if (question.type === "choice" || question.type === "listen-choice") {
    const listening = question.type === "listen-choice";
    body = `${listening ? `<p class="quiz-card__ask">Which line do you hear?</p><button class="dictation-play" type="button" data-test-play>${icon("play")}<span>Play</span></button>` : `<p class="quiz-card__ask">${question.reverse ? "Which word means" : "What does this mean?"}</p><div class="quiz-card__prompt" lang="${question.reverse ? escapeHtml(state.baseLanguage.toLowerCase()) : lang}">${escapeHtml(question.prompt)}</div>`}
      <div class="quiz-options" role="group" aria-label="Answers">${question.options.map((option, index) => `<button class="quiz-option" type="button" data-test-option="${index}"><kbd class="ui-kbd">${index + 1}</kbd><span>${escapeHtml(option)}</span></button>`).join("")}</div>`;
  } else if (question.type === "typing") {
    body = `<p class="quiz-card__ask">${question.reverse ? "Type the word for" : "Type the meaning of"}</p><div class="quiz-card__prompt" lang="${question.reverse ? escapeHtml(state.baseLanguage.toLowerCase()) : lang}">${escapeHtml(question.prompt)}</div>
      <form class="test-type-form" data-test-form><input id="test-answer" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Your answer"${question.reverse ? ` lang="${lang}"` : ""}>${buttonMarkup({ label: "Next", variant: "primary", type: "submit" })}</form>`;
  } else {
    body = `<p class="quiz-card__ask">Type what you hear</p><button class="dictation-play" type="button" data-test-play>${icon("play")}<span>Play</span></button>
      <form class="test-type-form" data-test-form><textarea id="test-answer" rows="2" autocomplete="off" spellcheck="false" lang="${lang}" aria-label="What you heard"></textarea>${buttonMarkup({ label: "Next", variant: "primary", type: "submit" })}</form>`;
  }
  stage.innerHTML = `<article class="test-card quiz-card">${progress}${body}</article>`;
  if (question.audioUrl) playStudySounds([question.audioUrl]);
  queueMicrotask(() => $("#test-answer")?.focus());
}

export function renderTest() {
  if (dictation.loadedFor !== state.targetLanguage && dictation.status !== "loading") void loadDictationClips({ force: true });
  if (storedDecksState === "idle") void loadStoredDecks();
  renderTestHistory();
  renderTestStage();
}
