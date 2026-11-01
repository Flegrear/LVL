// Chapter numbers and dates as source sites write them.
// "Chapter 12.5", "Capítulo 12", "Cap. 12 - Title", "Vol.2 Ch.10", "Episode 3",
// "Frieren 140" all give a number; the manga title is removed first so a title
// with digits ("Kaiju No. 8") doesn't count as the chapter.
import { normalizeUnitNumber } from "../../shared/reading/units.js";

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const MARKERS = /(?:cap[ií]tulo|cap[ií]t?\.?|chapter|chapitre|chap\.?|ch\.?|episod(?:e|io)|ep\.?|#)\s*(\d+(?:\.\d+)?)/i;
const UNWANTED = /(?:\b|\d)(?:vol(?:ume|\.)?|tomo|t\.|season|temporada|s|ver(?:sion|\.)?|v)\s*\d+/gi;

export function chapterNumber(name, mangaTitle = "") {
  let text = ` ${String(name || "").toLowerCase()} `;
  const title = String(mangaTitle || "").toLowerCase().trim();
  if (title.length >= 2) text = text.replace(new RegExp(escape(title), "g"), " ");
  text = text.replace(/(\d),(\d)/g, "$1.$2").replace(/(\d)-(\d{1,2})(?!\d)/g, "$1.$2");
  const marked = MARKERS.exec(text);
  if (marked) return normalizeUnitNumber(marked[1]);
  const cleaned = text.replace(UNWANTED, " ");
  const plain = /(\d+(?:\.\d+)?)/.exec(cleaned);
  return plain ? normalizeUnitNumber(plain[1]) : null;
}

export function volumeNumber(name) {
  const match = /\b(?:vol(?:ume|\.)?|tomo)\s*(\d+(?:\.\d+)?)/i.exec(String(name || ""));
  return match ? normalizeUnitNumber(match[1]) : null;
}

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
  ene: 1, abr: 4, ago: 8, dic: 12,
  janeiro: 1, fevereiro: 2, "março": 3, maio: 5, junho: 6, julho: 7, setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
};
const UNITS = [
  [/\b(?:years?|años?|anos?)\b/, 365 * 86400_000], [/\b(?:months?|mes(?:es)?|meses)\b/, 30 * 86400_000], [/\b(?:weeks?|semanas?)\b/, 7 * 86400_000],
  [/\b(?:days?|d[ií]as?)\b/, 86400_000], [/\b(?:hours?|horas?|hrs?)\b/, 3600_000], [/\b(?:minutes?|minutos?|mins?)\b/, 60_000], [/\b(?:seconds?|segundos?|secs?)\b/, 1000],
];

// Milliseconds since 1970 (UTC), or null when the text isn't a date.
export function parseSiteDate(value, now = Date.now()) {
  const text = String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!text) return null;
  const day = (offset) => { const d = new Date(now); d.setUTCHours(0, 0, 0, 0); return d.getTime() - offset * 86400_000; };
  if (/^(?:today|hoy|hoje)\b/.test(text) || /\bjust now\b|\bjust released\b/.test(text)) return day(0);
  if (/^(?:yesterday|ayer|ontem)\b/.test(text)) return day(1);
  const amount = /(\d+)/.exec(text);
  if (amount && /\b(?:ago|hace|atr[aá]s|há)\b/.test(text)) {
    for (const [re, ms] of UNITS) if (re.test(text)) return now - Number(amount[1]) * ms;
  }
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  if (match) return Date.UTC(+match[1], +match[2] - 1, +match[3]);
  match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(text);
  if (match) {
    const year = +match[3] < 100 ? 2000 + +match[3] : +match[3];
    // Day first unless that's impossible (dd/MM is far more common on these sites).
    const [d, m] = +match[2] > 12 ? [+match[2], +match[1]] : [+match[1], +match[2]];
    return Date.UTC(year, m - 1, d);
  }
  // "March 3, 2024", "3 de marzo de 2024", "mar 03, 24", "03 March 2024"
  const words = text.replace(/\bde\b|,|\./g, " ").split(" ").filter(Boolean);
  let month = 0;
  let dayOfMonth = 0;
  let year = 0;
  for (const word of words) {
    if (!month && MONTHS[word]) month = MONTHS[word];
    else if (/^\d{4}$/.test(word)) year = +word;
    else if (/^\d{1,2}(?:st|nd|rd|th)?$/.test(word) && !dayOfMonth) dayOfMonth = parseInt(word, 10);
    else if (/^\d{2}$/.test(word) && dayOfMonth && !year) year = 2000 + +word;
  }
  if (month && dayOfMonth && year && dayOfMonth <= 31) return Date.UTC(year, month - 1, dayOfMonth);
  return null;
}
