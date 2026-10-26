import test from "node:test";
import assert from "node:assert/strict";
import * as learn from "../learning/browser/learn.js";

const video = { id: "1", type: "word", front: "want", back: "Quiero ir a casa", context: "I want to go home", baseContext: "Quiero ir a casa" };
const pool = [video, ...["need", "like", "know"].map((front, index) => ({ ...video, id: String(index + 2), front, context: `I ${front} this place`, back: `Frase número ${index + 2}`, baseContext: `Frase número ${index + 2}` }))];

test("a video word without its own definition becomes a cloze, not a sentence-sized word meaning", () => {
  const question = learn.choiceQuestion(video, pool, { reverse: true, random: () => 0.5 });
  assert.equal(question.kind, "cloze");
  assert.equal(question.prompt, "I ____ to go home");
  assert.equal(question.context, "Quiero ir a casa");
  assert.equal(question.options[question.answerIndex], "want");
  const forward = learn.choiceQuestion(video, pool, { random: () => 0.5 });
  assert.equal(forward.kind, "sentence");
  assert.equal(forward.prompt, "I want to go home");
});

test("a vocabulary quiz presents one main sense without modifying the original card", () => {
  const card = { id: "me", front: "me", back: "yo; mí; me" };
  assert.equal(learn.cardMeaning(card), "yo");
  assert.equal(card.back, "yo; mí; me");
});

test("listening meanings uses exactly four distinct close translations from the same language pair", () => {
  const clip = (id, baseText, extras = {}) => ({ id, text: "日本語", audioUrl: `/api/clips/${id}/audio`, lang: "JA", baseLang: "ES", baseText, ...extras });
  const correct = clip("a", "Quiero ir a casa");
  const clips = [correct, clip("b", "Quiero ir al parque"), clip("c", "Quiero volver a casa"), clip("d", "Prefiero quedarme en casa"), clip("e", "Esta es una traducción mucho más larga y evidente que no debería ser usada como distractor"), clip("f", "I want to go home", { baseLang: "EN" }), clip("g", "Quiero ir a casa")];
  const question = learn.listeningMeaningQuestion(correct, clips, { random: () => 0.5 });
  assert.equal(question.options.length, 4);
  assert.equal(question.options[question.answerIndex], correct.baseText);
  assert.equal(question.audioUrl, correct.audioUrl);
  assert.equal(question.prompt, "");
  assert.equal(question.sourceText, correct.text);
  assert.ok(question.options.every((text) => text.length < 40));
  assert.equal(learn.listeningMeaningQuestion(correct, clips.slice(0, 3)), null);
});
