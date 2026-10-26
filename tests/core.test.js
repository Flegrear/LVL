import test from "node:test";
import assert from "node:assert/strict";
import {
  alignDictation,
  analyzePhrases,
  analyzeWords,
  buildReviewQueue,
  dayStartMs,
  formatReviewInterval,
  isLearningStopWord,
  parseSubtitle,
  previewReviewIntervals,
  scheduleReview,
  segmentText,
  sortReviewQueue,
  tokenizeWords,
} from "../learning/browser/core.js";

test("parses SRT and strips markup", () => {
  const cues = parseSubtitle("1\n00:00:01,000 --> 00:00:03,500\nHello <i>there</i>.\n\n2\n00:00:04,000 --> 00:00:05,000\nAgain.", "t");
  assert.equal(cues.length, 2);
  assert.equal(cues[0].startMs, 1000);
  assert.equal(cues[0].endMs, 3500);
  assert.equal(cues[0].text, "Hello there.");
});

test("parses WebVTT", () => {
  const cues = parseSubtitle("WEBVTT\n\n00:01.000 --> 00:03.000\nHello there", "t");
  assert.equal(cues.length, 1);
  assert.equal(cues[0].startMs, 1000);
});

test("ranks words and repeated phrases", () => {
  const cues = [
    { id: "1", startMs: 0, text: "I suppose we should go" },
    { id: "2", startMs: 1, text: "Suppose we should wait" },
    { id: "3", startMs: 2, text: "I suppose we should go" },
  ];
  const words = analyzeWords(cues);
  assert.equal(words.find((item) => item.value === "suppose")?.count, 3);
  const phrases = analyzePhrases(cues, { minCount: 2 });
  assert.ok(phrases.some((item) => item.value === "suppose we" && item.count === 3));
});

test("language-aware segmentation preserves visible text and word tokens", () => {
  const segments = segmentText("Hello, world!", "EN");
  assert.equal(segments.map((part) => part.text).join(""), "Hello, world!");
  assert.deepEqual(segments.filter((part) => part.isWord).map((part) => part.normalized), ["hello", "world"]);
});

test("CJK analysis keeps useful single-character words", () => {
  const words = tokenizeWords("私は学生です", "JA");
  assert.ok(words.length >= 2);
  const analyzed = analyzeWords([{ id: "ja-1", startMs: 0, text: "私は学生です" }], { language: "JA", hideStopWords: false });
  assert.ok(analyzed.length >= 2);
});

test("grammar words like particles don't become vocabulary", () => {
  for (const [word, language] of [["の", "JA"], ["は", "JA"], ["です", "JA"], ["ね", "JA"], ["ハハハッ", "JA"], ["フッ", "JA"], ["まあ", "JA"], ["an8", "JA"], ["the", "EN"], ["el", "ES"], ["的", "ZH"]]) {
    assert.equal(isLearningStopWord(word, language), true, `${language} ${word}`);
  }
  assert.equal(parseSubtitle("1\n00:00:01,000 --> 00:00:02,000\n{\\an8}<i>Hola</i> {\\i1}amigo", "t")[0].text, "Hola amigo");
  for (const [word, language] of [["学生", "JA"], ["人", "JA"], ["house", "EN"], ["casa", "ES"]]) assert.equal(isLearningStopWord(word, language), false, `${language} ${word}`);
  const words = analyzeWords([{ id: "1", startMs: 0, text: "私の猫の名前は" }, { id: "2", startMs: 1, text: "猫の目" }], { language: "JA" }).map((item) => item.value);
  assert.ok(!words.includes("の"));
  assert.ok(words.includes("猫"));
});

test("new card Good enters the second learning step instead of graduating immediately", () => {
  const now = 1_700_000_000_000;
  const card = { intervalDays: 0, reviewCount: 0, lapses: 0 };
  const result = scheduleReview(card, "good", now);
  assert.equal(result.state, "learning");
  assert.equal(result.learningStep, 1);
  assert.equal(result.intervalDays, 10 / 1440);
  assert.equal(result.reviewCount, 1);
  assert.equal(result.dueAt, now + 10 * 60000);
  assert.equal(result.ease, 2.5);
  assert.equal(result.firstReviewedAt, now);
});

test("learning Again resets to the first step and Good graduates after the last one (Anki: 1 day)", () => {
  const now = new Date(2026, 3, 10, 21, 30).getTime();
  const learning = { id: "learn-1", state: "learning", learningStep: 1, intervalDays: 10 / 1440, reviewCount: 2, lapses: 0 };
  const again = scheduleReview(learning, "again", now);
  assert.equal(again.state, "learning");
  assert.equal(again.learningStep, 0);
  assert.equal(again.dueAt, now + 60000);
  const hard = scheduleReview({ ...learning, learningStep: 0 }, "hard", now);
  assert.equal(hard.dueAt, now + 5.5 * 60000, "Hard on the first step waits between the two steps");

  const good = scheduleReview(learning, "good", now);
  assert.equal(good.state, "review");
  assert.equal(good.intervalDays, 1);
  assert.equal(good.dueAt, new Date(2026, 3, 11, 4, 0).getTime(), "due when tomorrow starts (4 AM)");
});

test("Easy graduates a learning card early", () => {
  const now = 1_700_000_000_000;
  const result = scheduleReview({ id: "easy-new", state: "learning", learningStep: 0, intervalDays: 1 / 1440 }, "easy", now);
  assert.equal(result.state, "review");
  assert.equal(result.intervalDays, 4);
});

test("review Again creates a lapse, lowers ease and relearns for 10 minutes", () => {
  const now = 1_700_000_000_000;
  const card = { id: "review-lapse", state: "review", intervalDays: 12, ease: 2.5, reviewCount: 5, lapses: 1, lastReviewedAt: now - 12 * 86400000 };
  const result = scheduleReview(card, "again", now);
  assert.equal(result.state, "relearning");
  assert.equal(result.learningStep, 0);
  assert.equal(result.lapses, 2);
  assert.equal(result.ease, 2.3);
  assert.equal(result.dueAt, now + 10 * 60000);
  const relearned = scheduleReview(result, "good", now + 10 * 60000);
  assert.equal(relearned.state, "review");
  assert.equal(relearned.intervalDays, 1, "back to review with the lapse interval");
  assert.equal(scheduleReview({ ...card, ease: 1.35 }, "again", now).ease, 1.3, "ease never drops below 130%");
});

test("review intervals follow Anki's formulas within its fuzz ranges", () => {
  const now = new Date(2026, 5, 1, 12, 0).getTime();
  const card = { id: "review-progressive", state: "review", intervalDays: 10, ease: 2.5, reviewCount: 8, lapses: 0, lastReviewedAt: now - 10 * 86400000 };
  const hard = scheduleReview(card, "hard", now);
  const good = scheduleReview(card, "good", now);
  const easy = scheduleReview(card, "easy", now);
  assert.ok(hard.intervalDays >= 11 && hard.intervalDays <= 14, `hard ${hard.intervalDays}`);
  assert.ok(good.intervalDays >= 22 && good.intervalDays <= 28, `good ${good.intervalDays}`);
  assert.ok(easy.intervalDays >= 29 && easy.intervalDays <= 36, `easy ${easy.intervalDays}`);
  assert.ok(hard.intervalDays < good.intervalDays && good.intervalDays < easy.intervalDays);
  assert.equal(hard.ease, 2.35);
  assert.equal(good.ease, 2.5);
  assert.equal(easy.ease, 2.65);
  assert.ok(Number.isInteger(good.intervalDays), "review intervals are whole days");
  const late = scheduleReview({ ...card, lastReviewedAt: now - 30 * 86400000 }, "good", now);
  assert.ok(late.intervalDays > good.intervalDays, "a late correct answer earns a longer interval");
  assert.deepEqual(scheduleReview(card, "good", now), good, "the same answer always gets the same interval");
});

test("legacy cards with day-scale intervals remain review cards", () => {
  const now = 1_700_000_000_000;
  const legacy = { intervalDays: 2, reviewCount: 1, lapses: 0 };
  const result = scheduleReview(legacy, "good", now);
  assert.equal(result.state, "review");
  assert.ok(result.intervalDays >= 4);
});

test("preview intervals mirror scheduling and provide compact button labels", () => {
  const now = 1_700_000_000_000;
  const card = { state: "learning", learningStep: 0, intervalDays: 1 / 1440, reviewCount: 1 };
  const preview = previewReviewIntervals(card, now);
  assert.equal(preview.again.label, "1m");
  assert.equal(preview.good.label, "10m");
  assert.equal(preview.easy.state, "review");
  assert.equal(preview.easy.label, "4d");
  assert.equal(formatReviewInterval(2 * 86400000), "2d");
  assert.equal(previewReviewIntervals({ id: "x", state: "review", intervalDays: 60, ease: 2.5, lastReviewedAt: now - 60 * 86400000 }, now).good.label.endsWith("mo"), true);
});

test("today's queue follows Anki's daily limits and order", () => {
  const now = new Date(2026, 5, 1, 12, 0).getTime();
  const today = dayStartMs(now);
  const cards = [
    ...Array.from({ length: 30 }, (_, index) => ({ id: `new-${index}`, state: "new", createdAt: index })),
    { id: "learning", state: "learning", dueAt: now - 1000 },
    { id: "review", state: "review", intervalDays: 3, dueAt: today },
    { id: "tomorrow", state: "review", intervalDays: 3, dueAt: today + 86400000 },
    { id: "introduced", state: "learning", dueAt: now + 3 * 3600000, firstReviewedAt: now - 1000 },
    { id: "suspended", state: "review", dueAt: today, suspended: true },
  ];
  const { queue, counts } = buildReviewQueue(cards, { now });
  assert.deepEqual(queue.slice(0, 3).map((card) => card.id), ["learning", "review", "new-0"]);
  assert.equal(counts.new, 19, "20 new cards a day, one was already started today");
  assert.equal(counts.review, 1);
  assert.equal(counts.learning, 2);
  assert.ok(!queue.some((card) => ["suspended", "tomorrow"].includes(card.id)));
  const ahead = buildReviewQueue([{ id: "soon", state: "learning", dueAt: now + 5 * 60000 }], { now });
  assert.deepEqual(ahead.queue.map((card) => card.id), ["soon"], "learning cards due within 20 minutes when nothing else is left");
});

test("review queue prioritizes due learning/relearning before due reviews and new cards", () => {
  const now = 1_700_000_000_000;
  const queue = sortReviewQueue([
    { id: "new", state: "new", dueAt: now - 5000 },
    { id: "review", state: "review", dueAt: now - 10000 },
    { id: "learning", state: "learning", dueAt: now - 1000 },
    { id: "future", state: "review", dueAt: now + 1000 },
  ], now);
  assert.deepEqual(queue.map((card) => card.id), ["learning", "review", "new", "future"]);
});

test("dictation alignment ignores casing and punctuation", () => {
  const result = alignDictation("Hello, world!", "hello world");
  assert.equal(result.accuracy, 100);
  assert.equal(result.distance, 0);
  assert.deepEqual(result.diff.map((item) => item.type), ["correct", "correct"]);
});

test("dictation alignment marks missing, extra and substituted words", () => {
  const missing = alignDictation("we should go now", "we go now");
  assert.ok(missing.diff.some((item) => item.type === "missing" && item.expected === "should"));
  assert.equal(missing.accuracy, 75);

  const substituted = alignDictation("I like green tea", "I like black tea");
  assert.ok(substituted.diff.some((item) => item.type === "substituted" && item.expected === "green" && item.actual === "black"));
  assert.equal(substituted.accuracy, 75);

  const extra = alignDictation("come here", "please come here");
  assert.ok(extra.diff.some((item) => item.type === "extra" && item.actual === "please"));
  assert.equal(extra.accuracy, 67);
});
