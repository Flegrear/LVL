export function parseTimestamp(value) {
  const normalized = value.trim().replace(",", ".");
  const parts = normalized.split(":").map(Number);
  if (parts.some(Number.isNaN)) return 0;
  if (parts.length === 3) return ((parts[0] * 60 + parts[1]) * 60 + parts[2]) * 1000;
  if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
  return parts[0] * 1000;
}

export function parseSubtitle(text, trackId = "track") {
  const cleaned = text.replace(/^\uFEFF/, "").replace(/\r/g, "").trim();
  const isVtt = /^WEBVTT/i.test(cleaned);
  const body = isVtt ? cleaned.replace(/^WEBVTT[^\n]*\n+/, "") : cleaned;
  const blocks = body.split(/\n{2,}/);
  const cues = [];

  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trimEnd()).filter(Boolean);
    if (!lines.length) continue;
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) continue;
    const [startRaw, endRawWithSettings] = lines[timingIndex].split("-->");
    if (!startRaw || !endRawWithSettings) continue;
    const endRaw = endRawWithSettings.trim().split(/\s+/)[0];
    // HTML tags and ASS override blocks ({\an8}, {\i1}) are styling, not dialogue.
    const cueText = lines.slice(timingIndex + 1).join(" ").replace(/<[^>]+>/g, "").replace(/\{\\[^}]*\}/g, "").replace(/\s{2,}/g, " ").trim();
    if (!cueText) continue;
    cues.push({
      id: `${trackId}-${cues.length + 1}`,
      trackId,
      startMs: parseTimestamp(startRaw),
      endMs: parseTimestamp(endRaw),
      text: cueText,
      normalizedText: normalizeText(cueText),
    });
  }

  return cues;
}

export function normalizeText(text) {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[“”‘’]/g, "'")
    .replace(/[^\p{L}\p{N}'\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeDictationToken(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/^['\-]+|['\-]+$/g, "")
    .replace(/[^\p{L}\p{N}'-]+/gu, "")
    .trim();
}

export function dictationTokens(value) {
  return String(value || "")
    .normalize("NFKC")
    .split(/\s+/u)
    .map(normalizeDictationToken)
    .filter(Boolean);
}

export function alignDictation(expectedText, actualText) {
  const expected = dictationTokens(expectedText);
  const actual = dictationTokens(actualText);
  const rows = expected.length + 1;
  const cols = actual.length + 1;
  const cost = Array.from({ length: rows }, () => Array(cols).fill(0));
  for (let i = 0; i < rows; i += 1) cost[i][0] = i;
  for (let j = 0; j < cols; j += 1) cost[0][j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const substitution = expected[i - 1] === actual[j - 1] ? 0 : 1;
      cost[i][j] = Math.min(cost[i - 1][j] + 1, cost[i][j - 1] + 1, cost[i - 1][j - 1] + substitution);
    }
  }
  const diff = [];
  let i = expected.length;
  let j = actual.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && expected[i - 1] === actual[j - 1] && cost[i][j] === cost[i - 1][j - 1]) {
      diff.push({ type: "correct", expected: expected[i - 1], actual: actual[j - 1] }); i -= 1; j -= 1; continue;
    }
    if (i > 0 && j > 0 && cost[i][j] === cost[i - 1][j - 1] + 1) {
      diff.push({ type: "substituted", expected: expected[i - 1], actual: actual[j - 1] }); i -= 1; j -= 1; continue;
    }
    if (i > 0 && cost[i][j] === cost[i - 1][j] + 1) {
      diff.push({ type: "missing", expected: expected[i - 1], actual: "" }); i -= 1; continue;
    }
    diff.push({ type: "extra", expected: "", actual: actual[j - 1] }); j -= 1;
  }
  diff.reverse();
  const distance = cost[expected.length][actual.length];
  const denominator = Math.max(1, expected.length, actual.length);
  const accuracy = Math.max(0, Math.round((1 - distance / denominator) * 100));
  return { expected, actual, diff, distance, accuracy };
}

function normalizedLanguageTag(language) {
  const value = String(language || "").trim().toLowerCase();
  const aliases = { ja: "ja", jp: "ja", zh: "zh", ko: "ko", en: "en", es: "es", fr: "fr", de: "de", it: "it", pt: "pt", ru: "ru", nl: "nl", pl: "pl", tr: "tr" };
  return aliases[value] || value || "en";
}

export function segmentText(text, language = "") {
  const source = String(text || "");
  if (!source) return [];
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    try {
      const segmenter = new Intl.Segmenter(normalizedLanguageTag(language), { granularity: "word" });
      return [...segmenter.segment(source)].map((part) => ({
        text: part.segment,
        normalized: part.isWordLike ? normalizeText(part.segment) : "",
        isWord: Boolean(part.isWordLike && normalizeText(part.segment)),
      }));
    } catch {}
  }
  return (source.match(/[\p{L}\p{N}'’-]+|[^\p{L}\p{N}'’-]+/gu) || [source]).map((part) => {
    const normalized = normalizeText(part);
    const isWord = /[\p{L}\p{N}]/u.test(part) && Boolean(normalized);
    return { text: part, normalized: isWord ? normalized : "", isWord };
  });
}

export function tokenizeWords(text, language = "") {
  return segmentText(text, language).filter((part) => part.isWord).map((part) => part.normalized);
}

export const defaultStopWords = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "for", "from", "had", "has", "have",
  "he", "her", "him", "his", "i", "if", "in", "is", "it", "its", "me", "my", "of", "on", "or", "our",
  "she", "so", "that", "the", "their", "them", "they", "this", "to", "was", "we", "were", "what", "when",
  "where", "who", "will", "with", "you", "your"
]);

// Grammar words (particles, articles, auxiliaries): too common and too abstract to be useful cards.
const STOP_WORDS_BY_LANGUAGE = {
  en: defaultStopWords,
  ja: new Set(["の", "に", "は", "を", "た", "が", "で", "て", "と", "し", "れ", "さ", "も", "な", "か", "よ", "ね", "ぞ", "ぜ", "わ", "や", "へ", "だ", "ん", "う", "い",
    "です", "ます", "でした", "ました", "だっ", "だった", "だろ", "だろう", "でしょ", "でしょう", "じゃ", "じゃない", "では", "には", "とは", "から", "まで", "より", "って", "けど", "けれど",
    "ない", "なかっ", "ある", "あっ", "いる", "い", "いた", "する", "し", "して", "した", "なる", "なっ", "られ", "れる", "られる", "せる", "させ", "ぬ", "ず", "たい", "ので", "のに", "なら", "ば", "たら",
    "この", "その", "あの", "こと", "もの", "よう", "そう", "ここ", "そこ", "あそこ", "これ", "それ", "あれ", "ええ", "うん", "あ", "え", "お", "ああ", "おい", "ほら"]),
  zh: new Set(["的", "了", "是", "在", "我", "你", "他", "她", "它", "们", "这", "那", "和", "就", "也", "都", "吗", "吧", "呢", "啊", "着", "过", "个", "不", "有", "要", "会", "能", "说", "被", "把", "给", "让", "很"]),
  ko: new Set(["이", "가", "은", "는", "을", "를", "에", "의", "도", "로", "으로", "와", "과", "하고", "에서", "까지", "부터", "고", "요", "네", "다", "야", "아", "그", "저", "이거", "그거", "뭐"]),
  es: new Set(["el", "la", "los", "las", "un", "una", "unos", "unas", "de", "del", "al", "a", "y", "o", "que", "en", "es", "se", "no", "lo", "le", "les", "me", "te", "nos", "mi", "tu", "su", "por", "para", "con", "como", "pero", "si", "ya", "yo", "tú", "él", "ella", "eso", "esto"]),
  fr: new Set(["le", "la", "les", "un", "une", "des", "de", "du", "au", "aux", "et", "ou", "que", "qui", "en", "est", "se", "ne", "pas", "je", "tu", "il", "elle", "on", "nous", "vous", "ils", "me", "te", "ce", "ça", "c'est", "j'ai", "mon", "ton", "son", "à", "dans", "pour", "avec", "sur", "mais"]),
  de: new Set(["der", "die", "das", "den", "dem", "des", "ein", "eine", "einen", "einem", "und", "oder", "zu", "in", "im", "ist", "ich", "du", "er", "sie", "es", "wir", "ihr", "nicht", "mit", "von", "auf", "für", "an", "am", "so", "ja", "aber", "was", "wie"]),
  it: new Set(["il", "lo", "la", "i", "gli", "le", "un", "uno", "una", "di", "del", "della", "a", "al", "e", "o", "che", "in", "è", "si", "non", "mi", "ti", "ci", "io", "tu", "lui", "lei", "per", "con", "ma", "come", "questo"]),
  pt: new Set(["o", "a", "os", "as", "um", "uma", "de", "do", "da", "dos", "das", "em", "no", "na", "e", "ou", "que", "é", "se", "não", "me", "te", "eu", "tu", "ele", "ela", "você", "por", "para", "com", "mas", "como", "isso", "isto"]),
};

export function isLearningStopWord(value, language = "") {
  const words = STOP_WORDS_BY_LANGUAGE[normalizedLanguageTag(language).slice(0, 2)];
  const token = normalizeText(value);
  if (!token) return true;
  if (words?.has(token)) return true;
  if (/^an\d$|^\d+$/.test(token)) return true; // subtitle style codes and bare numbers
  if (!/^ja/.test(normalizedLanguageTag(language))) return false;
  // A lone kana is a particle; ハハハッ, フフッ, へえ… are laughs and sighs.
  return /^[\p{Script=Hiragana}\p{Script=Katakana}ー]$/u.test(token)
    || /^[ハヒフヘホはひふへほ]{1,6}[ッっー]*$/u.test(token)
    || JA_INTERJECTIONS.has(token);
}

const JA_INTERJECTIONS = new Set(["まあ", "えっ", "ええっ", "あっ", "おお", "おっ", "ふう", "はあ", "へえ", "ほう", "さあ", "よし", "あら", "いや", "おや", "ねえ", "なあ", "うわ", "うわっ", "わあ", "くっ", "ちっ", "ん", "んっ", "うっ"]);

export function analyzeWords(cues, { hideStopWords = true, language = "" } = {}) {
  const map = new Map();
  const normalizedLanguage = normalizedLanguageTag(language);
  const allowSingleCharacter = /^(ja|zh|ko)/i.test(normalizedLanguage);
  for (const cue of cues) {
    const tokens = tokenizeWords(cue.text, language);
    const seenInCue = new Set();
    for (const token of tokens) {
      if (!allowSingleCharacter && token.length < 2) continue;
      if (hideStopWords && isLearningStopWord(token, normalizedLanguage)) continue;
      const item = map.get(token) || { value: token, count: 0, scenes: 0, occurrences: [] };
      item.count += 1;
      if (!seenInCue.has(token)) item.scenes += 1;
      item.occurrences.push({ cueId: cue.id, startMs: cue.startMs, text: cue.text });
      map.set(token, item);
      seenInCue.add(token);
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count || b.scenes - a.scenes || a.value.localeCompare(b.value));
}

export function analyzePhrases(cues, { minWords = 2, maxWords = 4, minCount = 2, language = "" } = {}) {
  const map = new Map();
  const useDefaultStopWords = normalizedLanguageTag(language).startsWith("en");
  for (const cue of cues) {
    const tokens = tokenizeWords(cue.text, language).filter(Boolean);
    for (let n = minWords; n <= maxWords; n += 1) {
      for (let i = 0; i <= tokens.length - n; i += 1) {
        const slice = tokens.slice(i, i + n);
        const phrase = slice.join(" ");
        if (useDefaultStopWords && defaultStopWords.has(slice[0]) && defaultStopWords.has(slice[slice.length - 1])) continue;
        const item = map.get(phrase) || { value: phrase, count: 0, occurrences: [] };
        item.count += 1;
        item.occurrences.push({ cueId: cue.id, startMs: cue.startMs, text: cue.text });
        map.set(phrase, item);
      }
    }
  }
  return [...map.values()].filter((item) => item.count >= minCount).sort((a, b) => b.count - a.count || b.value.length - a.value.length);
}

export function formatTime(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

// Spaced repetition lives in review-scheduler.js (Anki's SM-2 rules and default deck options).
export {
  ANKI_DEFAULTS,
  buildReviewQueue,
  cardEase,
  dayStartMs,
  formatReviewInterval,
  previewReviewIntervals,
  reviewQueuePriority,
  scheduleReview,
  schedulerState,
  sortReviewQueue,
} from "./review-scheduler.js";
