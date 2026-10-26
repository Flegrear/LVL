import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMixedTest,
  checkTypedAnswer,
  choiceQuestion,
  deckSummaries,
  dictationAccuracy,
  gradeQuestion,
  meaningAlternatives,
  quizPool,
  seededRandom,
  studyDeckKey,
  typeAnswerDiff,
} from "../learning/browser/learn.js";

const card = (id, front, back, extra = {}) => ({ id, front, back, state: "new", ...extra });

test("cards group into decks: stored decks, video cards, saved words, older imports", () => {
  const cards = [
    card("a", "犬", "dog", { anki: { deckId: "preset-words-ja" } }),
    card("b", "猫", "cat", { anki: { deckId: "preset-words-ja" }, state: "review", dueAt: 0 }),
    card("c", "言う", "to say", { context: "何て言うの？", sourceLibraryId: "x" }),
    card("d", "hola", "hi", { origin: "anki", anki: { deck: "Spanish::Basics" } }),
    card("e", "casa", "house"),
  ];
  assert.equal(studyDeckKey(cards[0]), "store:preset-words-ja");
  assert.equal(studyDeckKey(cards[2]), "videos");
  assert.equal(studyDeckKey(cards[3]), "legacy");
  assert.equal(studyDeckKey(cards[4]), "words");
  const stored = [{ id: "preset-words-ja", name: "Top words · Japanese", source: "preset" }, { id: "ankiweb-5", name: "Empty deck", source: "ankiweb" }];
  const rows = deckSummaries(cards, stored, { buildQueue: (list) => ({ counts: { new: list.filter((item) => item.state === "new").length, learning: 0, review: list.filter((item) => item.state === "review").length } }) });
  assert.deepEqual(rows.map((row) => [row.key, row.name, row.total]), [
    ["videos", "From your videos", 1],
    ["store:preset-words-ja", "Top words · Japanese", 2],
    ["store:ankiweb-5", "Empty deck", 0],
    ["legacy", "Spanish", 1],
    ["words", "Saved words", 1],
  ]);
  assert.deepEqual(rows[1].counts, { new: 1, learning: 0, review: 1 });
});

test("typed answers: exact, accents, close spelling, alternatives", () => {
  assert.deepEqual(meaningAlternatives("to go; to move (towards)").slice(0, 4), ["to go", "go", "to move (towards)", "to move"]);
  assert.equal(checkTypedAnswer("go", meaningAlternatives("to go; to move")).verdict, "correct");
  assert.equal(checkTypedAnswer("Cafe", ["café"]).verdict, "correct");
  assert.equal(checkTypedAnswer("Cafe", ["café"]).note, "accents");
  assert.equal(checkTypedAnswer("hosue", ["house"]).verdict, "wrong", "a swap is two edits in a 5-letter word");
  assert.equal(checkTypedAnswer("hous", ["house"]).verdict, "close");
  assert.equal(checkTypedAnswer("understnad", ["understand"]).verdict, "close");
  assert.equal(checkTypedAnswer("dog", ["cat"]).verdict, "wrong");
  assert.equal(checkTypedAnswer("", ["cat"]).verdict, "wrong");
  assert.equal(checkTypedAnswer("ねこ", ["猫", "ねこ"]).verdict, "correct");
});

test("type-answer comparison marks good, wrong and missed letters", () => {
  assert.deepEqual(typeAnswerDiff("house", "hause"), [{ type: "good", text: "h" }, { type: "bad", text: "a" }, { type: "missed", text: "o" }, { type: "good", text: "use" }]);
  assert.deepEqual(typeAnswerDiff("cat", "cats"), [{ type: "good", text: "cat" }, { type: "bad", text: "s" }]);
  assert.deepEqual(typeAnswerDiff("cat", ""), [{ type: "missed", text: "cat" }]);
});

test("multiple choice: four different options, one right answer, from the same pool", () => {
  const pool = quizPool([
    card("1", "犬", "dog"), card("2", "猫", "cat"), card("3", "鳥", "bird"), card("4", "魚", "fish"), card("5", "馬", "horse"),
    card("6", "同じ", "同じ"), card("7", "", "empty"),
  ]);
  assert.equal(pool.length, 5, "cards whose sides match or are empty are left out");
  const question = choiceQuestion(pool[0], pool, { random: seededRandom(7) });
  assert.equal(question.options.length, 4);
  assert.equal(new Set(question.options).size, 4);
  assert.equal(question.options[question.answerIndex], "dog");
  assert.equal(gradeQuestion(question, question.answerIndex).correct, true);
  assert.equal(gradeQuestion(question, (question.answerIndex + 1) % 4).correct, false);
  const reverse = choiceQuestion(pool[0], pool, { reverse: true, random: seededRandom(3) });
  assert.equal(reverse.prompt, "dog");
  assert.equal(reverse.answer, "犬");
  assert.equal(choiceQuestion(pool[0], pool.slice(0, 2)), null, "too few other cards");
});

test("studied, weak cards come first in the quiz pool", () => {
  const pool = quizPool([
    card("new", "a", "1"),
    card("easy", "b", "2", { state: "review", intervalDays: 60 }),
    card("lapsed", "c", "3", { state: "relearning", lapses: 3, intervalDays: 1 }),
  ]);
  assert.deepEqual(pool.map((item) => item.id), ["lapsed", "easy", "new"]);
});

test("a mixed test uses choice, typing and listening questions", () => {
  const cards = ["犬:dog", "猫:cat", "鳥:bird", "魚:fish", "馬:horse", "牛:cow", "羊:sheep", "豚:pig"].map((pair, index) => card(String(index), ...pair.split(":")));
  const clips = [
    { id: "c1", text: "おはよう", audioUrl: "/api/clips/c1/audio", lang: "JA", baseText: "Good morning" },
    { id: "c2", text: "ありがとう", audioUrl: "/api/clips/c2/audio", lang: "JA" },
    { id: "c3", text: "さようなら", audioUrl: "/api/clips/c3/audio", lang: "JA" },
  ];
  const questions = buildMixedTest({ cards, clips, size: 9, random: seededRandom(11) });
  assert.equal(questions.length, 9);
  const types = new Set(questions.map((question) => question.type));
  assert.ok(types.has("choice") && types.has("typing"), [...types].join(","));
  assert.ok(types.has("dictation") || types.has("listen-choice"));
  const withoutClips = buildMixedTest({ cards, clips: [], size: 6, random: seededRandom(5) });
  assert.equal(withoutClips.length, 6);
  assert.ok(withoutClips.every((question) => question.type !== "dictation"));
});

test("dictation accuracy counts words (or characters without spaces)", () => {
  assert.equal(dictationAccuracy("I don't know what you mean", "i dont know what you mean"), 100, "case, apostrophes and punctuation don't count");
  assert.equal(dictationAccuracy("I don't know what you mean", "I know what you mean"), 83);
  assert.equal(dictationAccuracy("何て言うの", "なんて言うの"), 67);
  assert.equal(gradeQuestion({ type: "dictation", answer: "hello there" }, "hello there").correct, true);
});
