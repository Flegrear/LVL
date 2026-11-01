// Romanized subtitle text (Japanese, Russian and others).
import KuroshiroModule from "kuroshiro";
import KuromojiAnalyzer from "kuroshiro-analyzer-kuromoji";
import { pinyin } from "pinyin-pro";
import hangulRomanization from "hangul-romanization";
import { json, readJsonBody } from "../app/http-helpers.js";
import { normalizeSubtitleLanguage } from "./subtitle-search.js";

const MAX_ROMANIZATION_LINES = 80;
const MAX_ROMANIZATION_TEXT_BYTES = 40 * 1024;

let kuroshiroPromise = null;

function romanizationLanguage(value) {
  const language = normalizeSubtitleLanguage(value);
  if (language === "JA" || language === "KO" || language === "ZH" || language === "RU") return language;
  return null;
}

function romanizeRussian(value) {
  const map = {
    а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "yo", ж: "zh", з: "z", и: "i", й: "y",
    к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f",
    х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
  };
  return [...String(value || "")].map((char) => {
    const lower = char.toLowerCase();
    const replacement = map[lower];
    if (replacement === undefined) return char;
    if (char === lower || !replacement) return replacement;
    return replacement[0].toUpperCase() + replacement.slice(1);
  }).join("");
}

async function getKuroshiro() {
  if (!kuroshiroPromise) {
    kuroshiroPromise = (async () => {
      const Kuroshiro = KuroshiroModule?.default || KuroshiroModule;
      const instance = new Kuroshiro();
      await instance.init(new KuromojiAnalyzer());
      return instance;
    })().catch((error) => {
      kuroshiroPromise = null;
      throw error;
    });
  }
  return kuroshiroPromise;
}

export async function romanizeSubtitleLine(text, language) {
  const value = String(text || "").trim();
  if (!value) return "";
  if (language === "JA") {
    const kuroshiro = await getKuroshiro();
    return String(await kuroshiro.convert(value, { to: "romaji", mode: "spaced" })).replace(/\s+/g, " ").trim();
  }
  if (language === "KO") return String(hangulRomanization.convert(value)).replace(/\s+/g, " ").trim();
  if (language === "ZH") return String(pinyin(value, { toneType: "none" })).replace(/\s+/g, " ").trim();
  if (language === "RU") return romanizeRussian(value).replace(/\s+/g, " ").trim();
  return value;
}

export async function romanizeSubtitles(req, res) {
  const body = await readJsonBody(req);
  const language = romanizationLanguage(body.language);
  const texts = Array.isArray(body.texts) ? body.texts : [];
  if (!language) {
    json(res, 400, { error: "Romanization currently supports Japanese, Korean, Chinese, and Russian text" });
    return;
  }
  if (!texts.length || texts.length > MAX_ROMANIZATION_LINES) {
    json(res, 400, { error: `Romanization accepts 1-${MAX_ROMANIZATION_LINES} subtitle lines per request` });
    return;
  }
  const normalized = texts.map((text) => String(text || "").slice(0, 4000));
  const totalBytes = normalized.reduce((sum, text) => sum + Buffer.byteLength(text), 0);
  if (totalBytes > MAX_ROMANIZATION_TEXT_BYTES) {
    json(res, 413, { error: "Romanization batch is too large" });
    return;
  }
  const romanized = [];
  for (const text of normalized) romanized.push(await romanizeSubtitleLine(text, language));
  json(res, 200, { language, romanized });
}
