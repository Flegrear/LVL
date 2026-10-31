// learn.js: pure helpers for Study (decks), Review (quick quiz with instant answers) and Tests
// (scored mixed tests). No DOM: app.js renders the results.
import { primaryMeaning } from "./vocabulary-meanings.js";

/* ---------------------------------------------------------------- decks */

export const DECK_SOURCES = Object.freeze({
  videos: "From your videos",
  words: "Saved words",
  preset: "Top words",
  ankiweb: "AnkiWeb",
  import: "Imported",
  legacy: "Imported (text)",
});

/** Which deck a card belongs to: a stored deck, older text-only imports, video cards, or saved words. */
export function studyDeckKey(card) {
  if (card?.anki?.deckId) return `store:${card.anki.deckId}`;
  if (card?.origin === "anki") return "legacy";
  if (card?.sourceLibraryId || card?.context || card?.origin === "subtitle" || card?.origin === "subtitle-auto") return "videos";
  return "words";
}

/**
 * One row per deck: { key, name, source, storeId, total, suspended, counts: { new, learning,
 * review }, cards }. buildQueue(cards) returns the scheduler's { counts }. storedDecks come from
 * the server (names, sources, media); a stored deck with no cards left still shows.
 */
export function deckSummaries(cards, storedDecks = [], { buildQueue } = {}) {
  const groups = new Map();
  const stored = new Map((storedDecks || []).map((deck) => [`store:${deck.id}`, deck]));
  for (const card of cards || []) {
    if (!card) continue;
    const key = studyDeckKey(card);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(card);
  }
  for (const key of stored.keys()) if (!groups.has(key)) groups.set(key, []);
  const rows = [...groups.entries()].map(([key, list]) => {
    const deck = stored.get(key);
    const source = deck ? deck.source : key === "legacy" ? "legacy" : key;
    const name = deck?.name || (key === "legacy" ? (list[0]?.anki?.deck?.split("::")[0] || DECK_SOURCES.legacy) : DECK_SOURCES[key] || key);
    const counts = buildQueue && list.length ? buildQueue(list).counts : { new: 0, learning: 0, review: 0 };
    return {
      key,
      name,
      source,
      storeId: deck?.id || null,
      language: deck?.language || list.find((card) => card.targetLanguage)?.targetLanguage || "",
      description: deck?.description || "",
      media: Number(deck?.media) || 0,
      extra: deck?.extra || null,
      total: list.length,
      suspended: list.filter((card) => card.suspended).length,
      counts,
      cards: list,
    };
  });
  const order = { videos: 0, preset: 1, ankiweb: 2, import: 3, legacy: 4, words: 5 };
  return rows.sort((a, b) => (order[a.source] ?? 9) - (order[b.source] ?? 9) || a.name.localeCompare(b.name));
}

/* ---------------------------------------------------------------- answers */

const DIACRITICS = /[\u0300-\u036f]/g;

export function normalizeAnswer(text, { keepAccents = false } = {}) {
  let value = String(text ?? "").normalize("NFKC").toLowerCase();
  if (!keepAccents) value = value.normalize("NFD").replace(DIACRITICS, "").normalize("NFC");
  return value
    .replace(/['’‘`´]/g, "")
    .replace(/[\u3000\s]+/g, " ")
    .replace(/[!-/:-@[-`{-~。、・「」『』（）！？…‥〜～♪]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// "to go; to move (towards)" → ["to go", "go", "to move (towards)", "to move", "move"]
export function meaningAlternatives(text) {
  const output = [];
  const add = (value) => {
    const clean = String(value || "").replace(/\s+/g, " ").trim();
    if (clean && !output.includes(clean)) output.push(clean);
  };
  for (const part of String(text ?? "").split(/[;,/|\n]+/)) {
    const bare = part.replace(/\([^)]*\)|\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
    add(part);
    add(bare);
    const noArticle = bare.replace(/^(?:to|a|an|the)\s+/i, "");
    add(noArticle);
  }
  return output.slice(0, 16);
}

export function editDistance(a, b) {
  const left = [...String(a)];
  const right = [...String(b)];
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[right.length];
}

/**
 * Grades a typed answer against the accepted answers.
 * Returns { verdict: "correct" | "close" | "wrong", matched, note }: accents and punctuation
 * don't count; one slip in a word of 4+ letters (two in 9+) is "close".
 */
export function checkTypedAnswer(typed, accepted) {
  const answer = normalizeAnswer(typed);
  const options = (Array.isArray(accepted) ? accepted : [accepted]).map((value) => String(value ?? "").trim()).filter(Boolean);
  if (!answer || !options.length) return { verdict: "wrong", matched: options[0] || "", note: "" };
  for (const option of options) {
    if (normalizeAnswer(option, { keepAccents: true }) === normalizeAnswer(typed, { keepAccents: true })) return { verdict: "correct", matched: option, note: "" };
  }
  for (const option of options) {
    if (normalizeAnswer(option) === answer) return { verdict: "correct", matched: option, note: "accents" };
  }
  let best = null;
  for (const option of options) {
    const target = normalizeAnswer(option);
    const distance = editDistance(target, answer);
    const allowed = [...target].length >= 9 ? 2 : [...target].length >= 4 ? 1 : 0;
    if (distance <= allowed && (!best || distance < best.distance)) best = { option, distance };
  }
  if (best) return { verdict: "close", matched: best.option, note: "spelling" };
  return { verdict: "wrong", matched: options[0], note: "" };
}

/** Anki-style type-answer comparison: good / bad / missed runs, character by character. */
export function typeAnswerDiff(expected, typed) {
  const want = [...String(expected ?? "")];
  const got = [...String(typed ?? "")];
  const rows = want.length + 1;
  const cols = got.length + 1;
  const cost = Array.from({ length: rows }, (_, i) => Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const same = want[i - 1].toLowerCase() === got[j - 1].toLowerCase();
      cost[i][j] = Math.min(cost[i - 1][j] + 1, cost[i][j - 1] + 1, cost[i - 1][j - 1] + (same ? 0 : 1));
    }
  }
  const parts = [];
  const push = (type, char) => {
    const last = parts.at(-1);
    if (last?.type === type) last.text += char;
    else parts.push({ type, text: char });
  };
  let i = want.length;
  let j = got.length;
  const reversed = [];
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && want[i - 1].toLowerCase() === got[j - 1].toLowerCase() && cost[i][j] === cost[i - 1][j - 1]) { reversed.push(["good", got[j - 1]]); i -= 1; j -= 1; }
    else if (j > 0 && (i === 0 || cost[i][j] === cost[i][j - 1] + 1)) { reversed.push(["bad", got[j - 1]]); j -= 1; }
    else if (i > 0 && j > 0 && cost[i][j] === cost[i - 1][j - 1] + 1) { reversed.push(["missed", want[i - 1]]); reversed.push(["bad", got[j - 1]]); i -= 1; j -= 1; }
    else { reversed.push(["missed", want[i - 1]]); i -= 1; }
  }
  reversed.reverse().forEach(([type, char]) => push(type, char));
  return parts;
}


/* ---------------------------------------------------------------- questions */

export function seededRandom(seed = Date.now()) {
  let value = (Number(seed) >>> 0) || 1;
  return () => {
    value ^= value << 13; value >>>= 0;
    value ^= value >>> 17;
    value ^= value << 5; value >>>= 0;
    return value / 4294967296;
  };
}

export function shuffle(list, random = Math.random) {
  const output = list.slice();
  for (let index = output.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [output[index], output[target]] = [output[target], output[index]];
  }
  return output;
}

const firstLine = (text) => String(text ?? "").split("\n").map((line) => line.trim()).find(Boolean) || "";
export const cardPrompt = (card) => firstLine(card?.front).slice(0, 160);
const sentenceMeaning = (card) => Boolean(card?.context && card?.baseContext
  && normalizeAnswer(card.back || card.baseContext) === normalizeAnswer(card.baseContext));
export const cardMeaning = (card) => {
  const value = firstLine(card?.back || card?.baseContext);
  return (sentenceMeaning(card) ? value : primaryMeaning(value)).slice(0, 200);
};

function clozePrompt(card) {
  const word = cardPrompt(card);
  if (!word || card.type === "phrase") return null;
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const latin = /\p{Script=Latin}/u.test(word);
  const pattern = new RegExp(latin ? `(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])` : escaped, "iu");
  return pattern.test(card.context) ? card.context.replace(pattern, "____") : null;
}

/** Cards that can be asked: both sides have text. Studied ones first (weakest first), then new. */
export function quizPool(cards) {
  const usable = (cards || []).filter((card) => card && !card.suspended && cardPrompt(card) && cardMeaning(card) && normalizeAnswer(cardPrompt(card)) !== normalizeAnswer(cardMeaning(card)));
  const weakness = (card) => (Number(card.lapses) || 0) * 3 + (card.state === "relearning" ? 4 : card.state === "learning" ? 2 : 0) - Math.min(4, Math.log2(1 + (Number(card.intervalDays) || 0)));
  const studied = usable.filter((card) => card.state && card.state !== "new").sort((a, b) => weakness(b) - weakness(a));
  const fresh = usable.filter((card) => !card.state || card.state === "new");
  return [...studied, ...fresh];
}

/**
 * A multiple-choice question: the card's prompt (or meaning when reverse) and four options, the
 * right one among three others from the same pool that don't read the same.
 */
export function choiceQuestion(card, pool, { reverse = false, random = Math.random, size = 4 } = {}) {
  const sentence = sentenceMeaning(card);
  const cloze = sentence && reverse ? clozePrompt(card) : null;
  if (sentence && reverse && !cloze) reverse = false;
  const side = (item) => (reverse ? cardPrompt(item) : cardMeaning(item));
  const answer = side(card);
  const seen = new Set([normalizeAnswer(answer)]);
  const answerLength = [...answer].length;
  const others = shuffle((pool || []).filter((item) => item.id !== card.id && (reverse || sentenceMeaning(item) === sentence)), random)
    .map((item) => side(item))
    .filter((text) => {
      const key = normalizeAnswer(text);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    // Options of a similar length make guessing by shape harder.
    .sort((a, b) => Math.abs([...a].length - answerLength) - Math.abs([...b].length - answerLength))
    .slice(0, size - 1);
  if (others.length < Math.min(2, size - 1)) return null;
  const options = shuffle([answer, ...others], random);
  return {
    type: "choice",
    cardId: card.id,
    reverse,
    kind: cloze ? "cloze" : sentence ? "sentence" : "word",
    prompt: cloze || (sentence && !reverse ? card.context : reverse ? cardMeaning(card) : cardPrompt(card)),
    context: cloze ? card.baseContext : "",
    options,
    answerIndex: options.indexOf(answer),
    answer,
  };
}

/** Hear a saved line and choose its meaning. All distractors use the same language pair. */
export function listeningMeaningQuestion(clip, clips, { random = Math.random } = {}) {
  const answer = String(clip?.baseText || "").trim();
  if (!answer || !clip?.audioUrl || !clip.baseLang) return null;
  const seen = new Set([normalizeAnswer(answer)]);
  const words = new Set(normalizeAnswer(answer).split(" "));
  const distance = (value) => {
    const tokens = normalizeAnswer(value).split(" ");
    const overlap = tokens.filter((word) => words.has(word)).length / Math.max(words.size, tokens.length, 1);
    return Math.abs(value.length - answer.length) / Math.max(value.length, answer.length, 1) - overlap * 0.4;
  };
  const others = shuffle((clips || []).filter((item) => item.id !== clip.id && item.lang === clip.lang && item.baseLang === clip.baseLang), random)
    .map((item) => String(item.baseText || "").trim()).filter((value) => {
      const key = normalizeAnswer(value);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    }).sort((a, b) => distance(a) - distance(b)).slice(0, 3);
  if (others.length !== 3) return null;
  const options = shuffle([answer, ...others], random);
  return { type: "listen-choice", meaning: true, clipId: clip.id, audioUrl: clip.audioUrl,
    imageUrl: clip.imageUrl || "", prompt: "", sourceText: clip.text || "", options, answer,
    answerIndex: options.indexOf(answer) };
}

/** A typing question: type the meaning (or the word, when reverse) of the card. */
export function typingQuestion(card, { reverse = false } = {}) {
  const answer = reverse ? cardPrompt(card) : cardMeaning(card);
  return {
    type: "typing",
    cardId: card.id,
    reverse,
    prompt: reverse ? cardMeaning(card) : cardPrompt(card),
    answer,
    accepted: reverse ? [cardPrompt(card), card.romanized, card.reading].filter(Boolean) : meaningAlternatives(answer),
  };
}

/** A listening question from a saved clip: type what is said, or pick the line that was said. */
export function listeningQuestion(clip, clips, { choice = false, random = Math.random } = {}) {
  const answer = String(clip?.text || "").trim();
  if (!answer || !clip?.audioUrl) return null;
  if (choice) {
    const seen = new Set([normalizeAnswer(answer)]);
    const others = shuffle((clips || []).filter((item) => item.id !== clip.id && item.lang === clip.lang), random)
      .map((item) => String(item.text || "").trim())
      .filter((text) => {
        const key = normalizeAnswer(text);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 3);
    if (others.length < 2) return null;
    const options = shuffle([answer, ...others], random);
    return { type: "listen-choice", clipId: clip.id, audioUrl: clip.audioUrl, imageUrl: clip.imageUrl || "", options, answerIndex: options.indexOf(answer), answer, translation: clip.baseText || "" };
  }
  return { type: "dictation", clipId: clip.id, audioUrl: clip.audioUrl, imageUrl: clip.imageUrl || "", answer, translation: clip.baseText || "" };
}

/**
 * A mixed test: about half multiple choice, the rest typing, and listening questions when clips
 * exist. types: { choice, typing, listening } booleans. Returns questions in random order.
 */
export function buildMixedTest({ cards = [], clips = [], size = 10, types = { choice: true, typing: true, listening: true }, random = Math.random } = {}) {
  const pool = quizPool(cards);
  const listenClips = types.listening ? shuffle((clips || []).filter((clip) => clip?.text && clip.audioUrl), random) : [];
  const enabled = ["choice", "typing", "listening"].filter((type) => types[type] && (type !== "listening" || listenClips.length));
  if (!enabled.length) return [];
  const questions = [];
  const usedCards = new Set();
  let listenIndex = 0;
  const pickCard = () => {
    const fresh = pool.filter((card) => !usedCards.has(card.id));
    if (!fresh.length) return null;
    // Mostly weak cards, some variety.
    const window = Math.max(1, Math.min(fresh.length, Math.ceil(fresh.length * 0.6)));
    const card = fresh[Math.floor(random() * window)];
    usedCards.add(card.id);
    return card;
  };
  for (let index = 0; questions.length < size && index < size * 4; index += 1) {
    const type = enabled[index % enabled.length];
    if (type === "listening") {
      const clip = listenClips[listenIndex++];
      if (!clip) continue;
      const question = listeningQuestion(clip, clips, { choice: random() < 0.4, random });
      if (question) questions.push(question);
      continue;
    }
    const card = pickCard();
    if (!card) continue;
    const reverse = random() < 0.3;
    const question = type === "choice" ? choiceQuestion(card, pool, { reverse, random }) : typingQuestion(card, { reverse: reverse && Boolean(card.romanized || /^[\p{Script=Latin}\s'-]+$/u.test(cardPrompt(card))) });
    if (question) questions.push(question);
  }
  return shuffle(questions, random).slice(0, size);
}

/** Points for one answered question (0-100) and whether it counts as right. */
export function gradeQuestion(question, response) {
  if (!question) return { points: 0, correct: false };
  if (question.type === "choice" || question.type === "listen-choice") {
    const correct = Number(response) === question.answerIndex;
    return { points: correct ? 100 : 0, correct };
  }
  if (question.type === "typing") {
    const result = checkTypedAnswer(response, question.accepted);
    return { points: result.verdict === "correct" ? 100 : result.verdict === "close" ? 75 : 0, correct: result.verdict !== "wrong", verdict: result.verdict, matched: result.matched };
  }
  if (question.type === "dictation") {
    const accuracy = dictationAccuracy(question.answer, response);
    return { points: accuracy, correct: accuracy >= 80, accuracy };
  }
  return { points: 0, correct: false };
}

// Word-level accuracy of a dictation (characters for languages written without spaces).
export function dictationAccuracy(expected, typed) {
  const spaced = /\s/.test(String(expected ?? "").trim());
  const tokens = (text) => (spaced ? normalizeAnswer(text).split(" ").filter(Boolean) : [...normalizeAnswer(text).replace(/\s+/g, "")]);
  const want = tokens(expected);
  const got = tokens(typed);
  if (!want.length) return 0;
  const perToken = editDistanceTokens(want, got);
  return Math.max(0, Math.round((1 - perToken / Math.max(want.length, got.length, 1)) * 100));
}

function editDistanceTokens(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    previous = current;
  }
  return previous[b.length];
}
