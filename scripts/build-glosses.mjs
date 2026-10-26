#!/usr/bin/env node
// Builds learning/data/<lang>.glosses.tsv: a short English meaning (and a reading for Japanese and
// Chinese) for the most frequent words of each preset language, so the Top 100 / 1,000 / 5,000
// decks can be studied as two-sided cards ("hola" → "hello").
//
// Sources, downloaded once into %TEMP%/lvl-dict-cache (resumable, see learning/data/NOTICE.md):
// - WikDict bilingual dictionaries xx-en / en-es (Wiktionary, CC BY-SA)
// - lemmatization-lists by Michal Měchura (ODbL): inflected form → dictionary form
// - JMdict via jmdict-simplified (EDRDG licence, CC BY-SA 4.0) for Japanese
// - CC-CEDICT (CC BY-SA 4.0) for Chinese
// - kengdic (MPL 2.0) for Korean
//
// Usage: node scripts/build-glosses.mjs [LANG ...]   (default: every preset language)
// Env: MAX_SECONDS (default 1500) stops cleanly between languages; re-running resumes.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import AdmZip from "adm-zip";
import { bundledMeaning } from "../learning/browser/vocabulary-meanings.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(root, "learning", "data");
const cacheDir = path.join(process.env.TEMP || process.env.TMPDIR || "/tmp", "lvl-dict-cache");
const budgetMs = (Number(process.env.MAX_SECONDS) || 1500) * 1000;
const startedAt = Date.now();
const WORDS = 5000;

const WIKDICT = "https://download.wikdict.com/dictionaries/sqlite/2";
const LEMMAS = "https://raw.githubusercontent.com/michmech/lemmatization-lists/master";
const SOURCES = {
  ES: { wikdict: "es-en", lemmas: "es" },
  FR: { wikdict: "fr-en", lemmas: "fr" },
  DE: { wikdict: "de-en", lemmas: "de" },
  IT: { wikdict: "it-en", lemmas: "it" },
  PT: { wikdict: "pt-en", lemmas: "pt" },
  RU: { wikdict: "ru-en", lemmas: "ru" },
  NL: { wikdict: "nl-en" },
  PL: { wikdict: "pl-en" },
  TR: { wikdict: "tr-en" },
  EN: { wikdict: "en-es", lemmas: "en", glossLanguage: "ES" },
  JA: { jmdict: true },
  ZH: { cedict: true },
  KO: { kengdic: true },
};

fs.mkdirSync(cacheDir, { recursive: true });
const log = (...parts) => console.log(`[${((Date.now() - startedAt) / 1000).toFixed(0)}s]`, ...parts);

async function download(url, name, { minBytes = 50_000 } = {}) {
  const file = path.join(cacheDir, name);
  if (fs.existsSync(file) && fs.statSync(file).size >= minBytes) return file;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const began = Date.now();
    try {
      const response = await fetch(url, { headers: { "User-Agent": "language-video-learner data build" }, signal: AbortSignal.timeout(600_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length < minBytes) throw new Error(`only ${bytes.length} bytes`);
      fs.writeFileSync(`${file}.part`, bytes);
      fs.renameSync(`${file}.part`, file);
      log(`downloaded ${name}: ${(bytes.length / 1e6).toFixed(1)} MB in ${((Date.now() - began) / 1000).toFixed(0)} s`);
      return file;
    } catch (error) {
      log(`download ${name} failed (attempt ${attempt}): ${error.message}`);
      if (attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 4000 * attempt));
    }
  }
  return file;
}

function frequencyWords(language) {
  return fs.readFileSync(path.join(dataDir, `${language.toLowerCase()}.words.tsv`), "utf8")
    .split(/\r?\n/).filter(Boolean).slice(0, WORDS)
    .map((line) => line.slice(0, line.lastIndexOf("\t") > 0 ? line.lastIndexOf("\t") : line.length).trim())
    .filter(Boolean);
}

// "to be | to exist | …" → up to three short senses.
function tidyGloss(parts, max = 3) {
  const seen = new Set();
  const output = [];
  for (const raw of parts) {
    const value = String(raw || "").replace(/\s+/g, " ").replace(/^\((?:[^)]{0,40})\)\s*/, (match) => match).trim();
    if (!value || value.length > 48) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(value);
    if (output.length >= max) break;
  }
  return output.join("; ");
}

/* ---------------------------------------------------------------- WikDict + lemmas */

function wikdictLookup(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  // Senses of a headword, most important first; reverse-derived rows (no lexentry) last.
  const rows = db.prepare(`SELECT trans_list, score FROM translation WHERE written_rep = ?
    ORDER BY (lexentry IS NULL), importance DESC, score DESC LIMIT 8`);
  const cache = new Map();
  const lookup = (word) => {
    if (cache.has(word)) return cache.get(word);
    let found = rows.all(word);
    if (!found.length && word !== word.toLowerCase()) found = rows.all(word.toLowerCase());
    const value = found.length
      ? { gloss: tidyGloss(found.flatMap((row) => String(row.trans_list || "").split(" | "))), score: Math.max(...found.map((row) => Number(row.score) || 0)) }
      : null;
    cache.set(word, value);
    return value;
  };
  return { lookup, close: () => db.close() };
}

function readLemmas(file) {
  // Each line: lemma<TAB>form. A form can have several lemmas; keep them in file order.
  const map = new Map();
  for (const line of fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const [lemma, form] = line.split("\t").map((value) => value?.trim());
    if (!lemma || !form || lemma === form) continue;
    const key = form.toLowerCase();
    const list = map.get(key) || [];
    if (!list.includes(lemma)) list.push(lemma);
    map.set(key, list);
  }
  return map;
}


/* ---------------------------------------------------------------- Japanese: JMdict */

const JA_VERB_ENDINGS = ["く", "う", "る", "ぐ", "す", "つ", "ぬ", "ぶ", "む", "い", "する", "な", "しい"];
// Single kanji the tokenizer leaves behind from common verbs (言っ → 言, 来て → 来).
const JA_VERB_STEM_KANJI = new Set([..."言行来知聞見出思入持待立死書読食飲使取呼帰起会買売住考違始終助殺探教忘答置決続変走歩泣笑遊休働払送届撃守逃戦勝負触動止着脱開閉消落選信頼願祈頑張乗降付掛押引切洗描作貸借返渡運"]);

function jmdictLookup(file) {
  const zip = new AdmZip(file);
  const entry = zip.getEntries().find((item) => item.entryName.endsWith(".json"));
  const data = JSON.parse(entry.getData().toString("utf8"));
  const byText = new Map();
  for (const word of data.words || []) {
    const common = (word.kanji || []).some((item) => item.common) || (word.kana || []).some((item) => item.common);
    const glosses = (word.sense || []).flatMap((sense) => (sense.gloss || []).filter((gloss) => !gloss.lang || gloss.lang === "eng").map((gloss) => gloss.text));
    const pos = (word.sense || [])[0]?.partOfSpeech || [];
    const misc = (word.sense || [])[0]?.misc || [];
    const reading = (word.kana || []).find((item) => item.common)?.text || word.kana?.[0]?.text || "";
    const kanaUsual = !(word.kanji || []).length || misc.includes("uk");
    const record = { common, glosses, pos, reading, kanaUsual };
    const elements = [...(word.kanji || []).map((item, index) => ({ ...item, primary: index === 0, kana: false })), ...(word.kana || []).map((item, index) => ({ ...item, primary: index === 0, kana: true }))];
    for (const item of elements) {
      const list = byText.get(item.text) || [];
      list.push({ ...record, textCommon: Boolean(item.common), primary: item.primary, viaKana: item.kana });
      byText.set(item.text, list);
    }
  }
  const affix = (candidate) => candidate.pos.some((tag) => /^(?:suf|pref|ctr)$/.test(tag));
  const score = (candidate) => Number(candidate.textCommon) * 4 + Number(candidate.primary) * 2 + Number(candidate.common)
    + (candidate.viaKana && candidate.kanaUsual ? 2 : 0) - (affix(candidate) ? 3 : 0) + Math.min(0.9, candidate.glosses.length / 40);
  const pick = (list) => list && list.slice().sort((a, b) => score(b) - score(a))[0];
  const verbFor = (token) => {
    const found = [];
    JA_VERB_ENDINGS.forEach((ending, order) => {
      const candidate = pick(byText.get(token + ending));
      if (candidate?.common && candidate.pos.some((tag) => /^(?:v|adj)/.test(tag))) found.push({ candidate, lemma: token + ending, order });
    });
    // The written form itself must be common (行く, not the rare 行る spelling of やる).
    found.sort((a, b) => Number(b.candidate.textCommon) - Number(a.candidate.textCommon) || a.order - b.order);
    return found[0] || null;
  };
  return (token) => {
    let match = pick(byText.get(token));
    let lemma = "";
    // Tokenizers cut verbs and adjectives at the stem (分か, 聞, 食べ): look for the dictionary form.
    if (/\p{Script=Han}/u.test(token) && (!match?.common || (token.length === 1 && JA_VERB_STEM_KANJI.has(token)))) {
      const verb = verbFor(token);
      if (verb) ({ candidate: match, lemma } = verb);
    }
    if (!match) return null;
    return { lemma, reading: /\p{Script=Han}/u.test(lemma || token) ? match.reading : "", gloss: tidyGloss(match.glosses) };
  };
}

/* ---------------------------------------------------------------- Chinese: CC-CEDICT */

const TONE_MARKS = { a: "āáǎà", e: "ēéěè", i: "īíǐì", o: "ōóǒò", u: "ūúǔù", ü: "ǖǘǚǜ" };

function pinyinWithMarks(numbered) {
  return String(numbered || "").split(/\s+/).map((syllable) => {
    const match = syllable.toLowerCase().replace(/u:/g, "ü").replace(/v/g, "ü").match(/^([a-zü]+)([1-5])$/);
    if (!match) return syllable.replace(/u:/g, "ü");
    const [, letters, toneText] = match;
    const tone = Number(toneText);
    if (tone === 5) return letters;
    const index = letters.search(/[ae]/) >= 0 ? letters.search(/[ae]/)
      : letters.includes("ou") ? letters.indexOf("o")
        : Math.max(...["a", "e", "i", "o", "u", "ü"].map((vowel) => letters.lastIndexOf(vowel)));
    if (index < 0) return letters;
    const vowel = letters[index];
    return letters.slice(0, index) + TONE_MARKS[vowel][tone - 1] + letters.slice(index + 1);
  }).join(" ");
}

function cedictLookup(file) {
  const text = zlib.gunzipSync(fs.readFileSync(file)).toString("utf8");
  const bySimplified = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(\S+) (\S+) \[([^\]]*)\] \/(.*)\/\s*$/);
    if (!match) continue;
    const [, , simplified, pinyin, glossText] = match;
    const glosses = glossText.split("/")
      .filter((gloss) => gloss && !/^(?:surname |variant of|old variant|CL:|see also|see |used in |also pr\.|also written|abbr\. for|erhua variant|Taiwan pr\.)/i.test(gloss))
      .map((gloss) => gloss.replace(/;\s*also pr\..*$/i, "").replace(/\s*\((?:[^()]*\[[a-z]+\d\][^()]*)\)/gi, "").trim())
      .filter(Boolean);
    if (!glosses.length) continue;
    const list = bySimplified.get(simplified) || [];
    list.push({ pinyin, glosses, proper: /^[A-Z]/.test(pinyin), marked: glosses.every((gloss) => /^\((?:coll|dialect|old|archaic|literary|Tw|Cant|onom|arch|obsolete|slang|loanword)\b/i.test(gloss)), order: list.length });
    bySimplified.set(simplified, list);
  }
  return (token) => {
    const list = bySimplified.get(token);
    if (!list) return null;
    const best = list.slice().sort((a, b) => Number(a.proper) - Number(b.proper) || Number(a.marked) - Number(b.marked) || a.order - b.order)[0];
    return { lemma: "", reading: pinyinWithMarks(best.pinyin), gloss: tidyGloss(best.glosses) };
  };
}

/* ---------------------------------------------------------------- Korean: kengdic */

const KO_PARTICLES = ["에서는", "으로는", "에게는", "한테는", "에서", "에게", "한테", "으로", "까지", "부터", "처럼", "보다", "하고", "이나", "은", "는", "이", "가", "을", "를", "에", "의", "도", "만", "로", "와", "과", "요", "야"];
const KO_ENDINGS = ["습니다", "었어요", "았어요", "해요", "어요", "아요", "었어", "았어", "는데", "지만", "니까", "어서", "아서", "해", "어", "아", "지", "고", "게", "죠"];

function kengdicLookup(file) {
  const byWord = new Map();
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const header = lines.shift().split("\t");
  const surfaceIndex = header.indexOf("surface");
  const glossIndex = header.indexOf("gloss");
  for (const line of lines) {
    const cells = line.split("\t");
    const surface = cells[surfaceIndex]?.trim();
    const gloss = cells[glossIndex]?.replace(/\s+/g, " ").trim();
    if (!surface || !gloss) continue;
    const list = byWord.get(surface) || [];
    if (list.length < 6) list.push(gloss);
    byWord.set(surface, list);
  }
  return (token) => {
    const tries = [token];
    for (const particle of KO_PARTICLES) if (token.length > particle.length && token.endsWith(particle)) tries.push(token.slice(0, -particle.length));
    for (const ending of KO_ENDINGS) {
      if (token.length > ending.length && token.endsWith(ending)) {
        const stem = token.slice(0, -ending.length);
        tries.push(`${stem}다`, `${stem}하다`);
      }
    }
    for (const candidate of tries) {
      const list = byWord.get(candidate);
      if (list) {
        const senses = list.flatMap((gloss) => gloss.split(/\s*[,;]\s*/)).map((gloss) => gloss.replace(/^(?:a|an|the) /i, "").replace(/^[A-Z](?=[a-z])/, (char) => char.toLowerCase()).trim()).filter((gloss) => gloss && !/~/.test(gloss));
        return { lemma: candidate === token ? "" : candidate, reading: "", gloss: tidyGloss(senses) };
      }
    }
    return null;
  };
}


/* ---------------------------------------------------------------- build */

async function lookupFor(language) {
  const source = SOURCES[language];
  if (source.jmdict) {
    const release = await (await fetch("https://api.github.com/repos/scriptin/jmdict-simplified/releases/latest", { headers: { "User-Agent": "language-video-learner data build" }, signal: AbortSignal.timeout(20_000) })).json();
    const asset = (release.assets || []).find((item) => /^jmdict-eng-\d.*\.json\.zip$/.test(item.name));
    if (!asset) throw new Error("jmdict-simplified release has no jmdict-eng zip");
    return { lookup: jmdictLookup(await download(asset.browser_download_url, "jmdict-eng.json.zip", { minBytes: 5_000_000 })), close() {} };
  }
  if (source.cedict) return { lookup: cedictLookup(await download("https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz", "cedict.txt.gz", { minBytes: 1_000_000 })), close() {} };
  if (source.kengdic) return { lookup: kengdicLookup(await download("https://raw.githubusercontent.com/garfieldnate/kengdic/master/kengdic.tsv", "kengdic.tsv", { minBytes: 1_000_000 })), close() {} };
  const dictionary = wikdictLookup(await download(`${WIKDICT}/${source.wikdict}.sqlite3`, `${source.wikdict}.sqlite3`, { minBytes: 500_000 }));
  const lemmas = source.lemmas ? readLemmas(await download(`${LEMMAS}/lemmatization-${source.lemmas}.txt`, `lemmatization-${source.lemmas}.txt`, { minBytes: 100_000 })) : new Map();
  return {
    lookup(word) {
      const direct = dictionary.lookup(word);
      // Rows scored 4 or less are reverse translations of rare senses ("es" → "ace"): the
      // dictionary form's meaning is better when the word is an inflected form.
      if (direct && direct.score > 4) return { lemma: "", reading: "", gloss: direct.gloss };
      for (const lemma of lemmas.get(word.toLowerCase()) || []) {
        const found = dictionary.lookup(lemma);
        if (found && found.score > 4) return { lemma, reading: "", gloss: found.gloss };
      }
      return direct ? { lemma: "", reading: "", gloss: direct.gloss } : null;
    },
    close: dictionary.close,
  };
}

const clean = (value) => String(value || "").replace(/[\t\r\n]+/g, " ").trim();

async function buildLanguage(language) {
  const words = frequencyWords(language);
  const { lookup, close } = await lookupFor(language);
  const lines = [];
  const began = Date.now();
  try {
    words.forEach((word, index) => {
      if (/^[\p{P}\p{S}\p{N}\s]+$/u.test(word)) return;
      const found = lookup(word);
      if (!found?.gloss) return;
      lines.push([index + 1, word, clean(found.lemma), clean(found.reading), clean(bundledMeaning(language, { word, ...found }))].join("\t"));
    });
  } finally {
    close();
  }
  const header = `# rank\tword\tlemma\treading\tgloss (${SOURCES[language].glossLanguage || "EN"})`;
  fs.writeFileSync(path.join(dataDir, `${language.toLowerCase()}.glosses.tsv`), `${header}\n${lines.join("\n")}\n`);
  const within = (limit) => lines.filter((line) => Number(line.split("\t")[0]) <= limit).length;
  log(`${language}: ${lines.length}/${words.length} glossed (top 100: ${within(100)}, top 1000: ${within(1000)}) in ${((Date.now() - began) / 1000).toFixed(1)} s`);
}

const requested = process.argv.slice(2).map((value) => value.toUpperCase());
const languages = requested.length ? requested : Object.keys(SOURCES);
for (const language of languages) {
  if (!SOURCES[language]) {
    log(`skip ${language}: no source configured`);
    continue;
  }
  if (Date.now() - startedAt > budgetMs) {
    log(`time budget reached before ${language}; re-run to continue`);
    break;
  }
  try {
    await buildLanguage(language);
  } catch (error) {
    log(`${language} failed: ${error.message}`);
    process.exitCode = 1;
  }
}
log("done");
