// preset-decks.js: the Top 100 / 1,000 / 5,000 words of a language as an Anki-style deck. Each
// note holds the word, its reading (Japanese, Chinese), its meaning and dictionary form; the card
// shows the word and flips to the meaning, rated Again / Hard / Good / Easy like any Anki card.
// Built from learning/data/<lang>.words.tsv (frequency) and <lang>.glosses.tsv (meanings, see
// scripts/build-glosses.mjs). Node only (server.js stores the result with anki-store.js).

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundledMeaning } from "./browser/vocabulary-meanings.js";

const dataRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "data");
export const PRESET_WORD_SIZES = Object.freeze([100, 1000, 5000]);
const glossCache = new Map();

export const PRESET_NOTETYPE_ID = "lvl-vocabulary-1";
export const PRESET_FIELDS = Object.freeze(["Word", "Reading", "Meaning", "Dictionary form", "Rank", "Language"]);

const PRESET_CSS = `.card {
  font-family: Inter, "Segoe UI", "Hiragino Sans", "Noto Sans CJK JP", "Noto Sans CJK KR", "Noto Sans CJK SC", Arial, sans-serif;
  font-size: 20px; line-height: 1.5; text-align: center; color: #111; background: #fff; padding: 28px 18px;
}
.lvl-word { font-size: 52px; font-weight: 650; letter-spacing: -0.02em; line-height: 1.15; }
.lvl-reading { margin-top: 10px; font-size: 22px; color: #666; }
.lvl-meaning { margin-top: 18px; font-size: 26px; font-weight: 500; }
.lvl-lemma { margin-top: 10px; font-size: 16px; color: #777; }
.lvl-lemma::before { content: "Dictionary form: "; }
.lvl-rank { margin-top: 26px; font-size: 12px; color: #999; }
hr#answer { width: 48px; margin: 22px auto 0; border: 0; border-top: 1px solid #ddd; }
.nightMode .card, .card.nightMode, .night_mode .card { color: #f2f2f2; background: #0b0b0b; }
.nightMode .lvl-reading, .night_mode .lvl-reading { color: #a8a8a8; }
.nightMode .lvl-lemma, .night_mode .lvl-lemma, .nightMode .lvl-rank, .night_mode .lvl-rank { color: #8a8a8a; }
.nightMode hr#answer, .night_mode hr#answer { border-top-color: #2a2a2a; }`;

const PRESET_QFMT = '<div class="lvl-word" lang="{{Language}}">{{Word}}</div>{{#Reading}}<div class="lvl-reading">{{Reading}}</div>{{/Reading}}';
const PRESET_AFMT = `{{FrontSide}}
<hr id="answer">
<div class="lvl-meaning">{{Meaning}}</div>
{{#Dictionary form}}<div class="lvl-lemma" lang="{{Language}}">{{Dictionary form}}</div>{{/Dictionary form}}
<div class="lvl-rank">Frequency rank {{Rank}}</div>`;

export const PRESET_NOTETYPE = Object.freeze({
  id: PRESET_NOTETYPE_ID,
  name: "LVL Vocabulary",
  kind: "normal",
  fields: [...PRESET_FIELDS],
  templates: [{ name: "Recognition", qfmt: PRESET_QFMT, afmt: PRESET_AFMT }],
  css: PRESET_CSS,
});

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[char]);

export async function loadGlosses(language) {
  const code = String(language || "").toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return null;
  if (glossCache.has(code)) return glossCache.get(code);
  let text;
  try {
    text = await fs.readFile(path.join(dataRoot, `${code.toLowerCase()}.glosses.tsv`), "utf8");
  } catch {
    return null;
  }
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const [rank, word, lemma = "", reading = "", gloss = ""] = line.split("\t");
    if (!word || !gloss || !(Number(rank) > 0)) continue;
    rows.push({ rank: Number(rank), word, lemma, reading, gloss: bundledMeaning(code, { word, lemma, gloss }) });
  }
  glossCache.set(code, rows);
  return rows;
}

export function presetDeckId(language) {
  return `preset-words-${String(language || "").toLowerCase()}`;
}

/**
 * The deck for the top `size` words: { meta, collection } ready for anki-store saveDeck(). Card
 * records are all new, in frequency order; the store keeps notes that were added before (a larger
 * size adds the words that were missing).
 */
export async function presetDeck({ language, languageName = "", size = 100, now = Date.now(), romanize = null }) {
  const code = String(language || "").toUpperCase();
  const limit = PRESET_WORD_SIZES.includes(Number(size)) ? Number(size) : 100;
  const glosses = await loadGlosses(code);
  if (!glosses?.length) throw Object.assign(new Error(`No word meanings are bundled for ${languageName || code} yet`), { statusCode: 404 });
  // Dictionary coverage can have gaps in rank. Select the requested number of usable words.
  const rows = glosses.slice(0, limit).map((row) => ({ ...row }));
  if (romanize && ["JA", "KO", "ZH", "RU"].includes(code)) {
    for (const row of rows) row.reading = await romanize(row.reading || row.word, code);
  }
  const notes = rows.map((row) => ({
    id: `${code.toLowerCase()}-${row.rank}`,
    guid: `lvl-${code.toLowerCase()}-${row.rank}-${row.word}`,
    mid: PRESET_NOTETYPE_ID,
    tags: ["language-video-learner", `lang::${code.toLowerCase()}`, `top::${row.rank <= 100 ? 100 : row.rank <= 1000 ? 1000 : 5000}`],
    fields: [escapeHtml(row.word), escapeHtml(row.reading), escapeHtml(row.gloss), escapeHtml(row.lemma && row.lemma !== row.word ? row.lemma : ""), String(row.rank), code.toLowerCase()],
  }));
  const cards = rows.map((row) => ({
    cardId: `${code.toLowerCase()}-${row.rank}-0`,
    noteId: `${code.toLowerCase()}-${row.rank}`,
    ord: 0,
    deck: `Top words: ${languageName || code}`,
    rank: row.rank,
    front: row.word,
    back: row.gloss,
    reading: row.reading,
    lemma: row.lemma,
    state: "new",
    learningStep: 0,
    intervalDays: 0,
    dueAt: now,
    reviewCount: 0,
    lapses: 0,
    newPosition: row.rank,
  }));
  return {
    meta: {
      id: presetDeckId(code),
      name: `Top words: ${languageName || code}`,
      source: "preset",
      language: code,
      description: `The ${limit.toLocaleString("en-US")} most frequent words in ${languageName || code} subtitles (OpenSubtitles 2018), with meanings.`,
      cards: rows.length,
      extra: { kind: "preset-words", size: limit, glossed: rows.length, version: 2, meaningLanguage: code === "EN" ? "ES" : "EN" },
    },
    collection: { notetypes: [PRESET_NOTETYPE], notes, cards, media: [] },
  };
}
