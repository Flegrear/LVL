// The chapter index: every chapter that exists, by number
// and grouped by volume, before any source is chosen. Built from Wikipedia's
// "List of … chapters" pages (volume → chapter numbers and titles), MangaDex's
// aggregate (fills chapters not collected yet), and AniList's chapter count.
import { normalizeUnitNumber, sortVolumes } from "../../shared/reading/units.js";

export const WIKIPEDIA_API = "https://en.wikipedia.org/w/api.php";

// Splits a template body at top-level "|" (nested {{…}} and [[…]] kept whole).
export function templateArgs(body) {
  const args = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < body.length; i += 1) {
    const two = body.slice(i, i + 2);
    if (two === "{{" || two === "[[") { depth += 1; current += two; i += 1; continue; }
    if ((two === "}}" || two === "]]") && depth > 0) { depth -= 1; current += two; i += 1; continue; }
    if (body[i] === "|" && depth === 0) { args.push(current); current = ""; continue; }
    current += body[i];
  }
  args.push(current);
  return args;
}

// Every {{Name …}} occurrence's inner text (balanced braces).
export function findTemplates(text, name) {
  const out = [];
  const open = new RegExp(`\\{\\{\\s*${name.replace(/ /g, "[ _]")}\\s*(?=[|}])`, "gi");
  for (const match of String(text).matchAll(open)) {
    let depth = 0;
    for (let i = match.index; i < text.length - 1; i += 1) {
      if (text[i] === "{" && text[i + 1] === "{") { depth += 1; i += 1; }
      else if (text[i] === "}" && text[i + 1] === "}") {
        depth -= 1; i += 1;
        if (depth === 0) { out.push(text.slice(match.index + 2, i - 1)); break; }
      }
    }
  }
  return out;
}

const cleanTitle = (value) => {
  const quoted = /"([^"]{1,200})"/.exec(value)?.[1] || /“([^”]{1,200})”/.exec(value)?.[1] || "";
  return quoted.replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, "$1").replace(/''+/g, "").replace(/<[^>]+>/g, "").trim();
};

// Chapters listed in one volume entry, in page order: {{Numbered list|start=N|…}}
// blocks, lines with their own number ("* 001. …", "<li value="5">…"), and plain
// "#" items, which carry on from the previous chapter (Black Clover's volume 1
// lists 1–4 as "#" lines and 5–7 in a Numbered list). next: the first number
// when a volume starts with plain "#" items (the previous volume's last + 1).
export function chaptersInVolume(entry, { next = 1 } = {}) {
  // Commented-out lines (a volume Wikipedia hasn't published yet) aren't chapters.
  const source = String(entry).replace(/<!--[\s\S]*?-->/g, "");
  const lists = findTemplates(source, "Numbered list");
  let text = source;
  lists.forEach((list, index) => { text = text.replace(`{{${list}}}`, `\n@@numbered-list-${index}@@\n`); });
  const chapters = [];
  let following = Number(next) || 1;
  // Side chapters out of order (Bleach's 0.8 among 99–107) don't move the count back.
  const push = (number, title) => {
    const chapter = normalizeUnitNumber(String(number));
    if (!chapter) return;
    chapters.push({ chapter, title: cleanTitle(title) });
    following = Math.max(following, Math.floor(Number(chapter)) + 1);
  };
  for (const line of text.split("\n")) {
    const marker = /^@@numbered-list-(\d+)@@$/.exec(line.trim());
    if (marker) {
      const args = templateArgs(lists[Number(marker[1])]).slice(1);
      const start = Number(/^\s*start\s*=\s*(\d+)/.exec(args.find((arg) => /^\s*start\s*=/.test(arg)) || "")?.[1]) || following;
      args.filter((arg) => !/^\s*[a-z]+\s*=/.test(arg) && arg.trim()).forEach((item, index) => push(start + index, item));
      continue;
    }
    // Ranges: "*Mission: 1–5", "* Chapters 12–17", "*Short Mission: 15, 17-18". Side series
    // (extra, short, special…) number their own chapters, so they're left out.
    const range = RANGE_LINE.exec(line);
    if (range) {
      if (!SIDE_SERIES.test(range[1] || "")) for (const number of expandRanges(range[2])) push(number, "");
      continue;
    }
    const numbered = /^\s*[*#:]\s*(?:<li[^>]*>)?\s*(?:Chapter\s*)?(\d{1,4}(?:\.\d)?)[.:)]?\s+(.*)$/i.exec(line) || /<li\s+value\s*=\s*"?(\d{1,4})"?\s*>(.*)$/i.exec(line);
    if (numbered) { push(numbered[1], numbered[2]); continue; }
    // A plain ordered item: the next chapter after the last one listed.
    const plain = /^\s*#(?![#*:])\s*(.+)$/.exec(line);
    if (plain && plain[1].trim()) push(following, plain[1]);
  }
  return chapters;
}

const RANGE_ITEM = String.raw`\d{1,4}(?:\.\d)?(?:\s*[–—-]\s*\d{1,4})?`;
// "*" + optional label ("Mission:", "Chapters") + numbers and ranges, and nothing else on the line.
const RANGE_LINE = new RegExp(String.raw`^\s*[*#:]\s*(?:([A-Za-z][A-Za-z .'’]{0,40}?)\s*:?\s*)?(${RANGE_ITEM}(?:\s*,\s*${RANGE_ITEM})*)\s*$`);
const SIDE_SERIES = /\b(?:extra|short|special|bonus|side|omake|one[- ]?shot|pilot|spin[- ]?off|gaiden)\b/i;
// "1–5, 7" -> ["1", "2", "3", "4", "5", "7"] (at most 200 numbers per range).
export function expandRanges(text) {
  const out = [];
  for (const part of String(text).split(",")) {
    const match = /^\s*(\d{1,4}(?:\.\d)?)(?:\s*[–—-]\s*(\d{1,4}))?\s*$/.exec(part);
    if (!match) continue;
    const from = Number(match[1]);
    const to = match[2] ? Number(match[2]) : from;
    if (!match[2] || !Number.isInteger(from) || to < from || to - from > 200) { out.push(match[1]); continue; }
    for (let n = from; n <= to; n += 1) out.push(String(n));
  }
  return out;
}

export function parseChapterList(wikitext, { next: start = 1 } = {}) {
  const volumes = [];
  let next = Number(start) || 1;
  for (const entry of findTemplates(wikitext, "Graphic novel list")) {
    if (/^\s*Graphic novel list\s*\//i.test(entry)) continue; // the /header and /footer templates
    const args = templateArgs(entry);
    const field = (name) => args.find((arg) => new RegExp(`^\\s*${name}\\s*=`, "i").test(arg))?.replace(/^[^=]*=/, "").trim() || "";
    const volume = normalizeUnitNumber(/^\s*(\d{1,4})/.exec(field("VolumeNumber"))?.[1]);
    if (!volume) continue;
    // Volume numbers starting over: the page goes on with another series (Dragon Ball's
    // page continues with Dragon Ball Z and SD); only the first one is this manga's.
    if (volumes.length && Number(volume) <= Number(volumes.at(-1).volume)) break;
    // "| ChapterList = *Mission: 1–5": the first line starts after "=".
    const chapterText = args.filter((arg) => /^\s*ChapterList/i.test(arg)).map((arg) => arg.replace(/^\s*ChapterList\d*\s*=[ \t]*/i, "")).join("\n");
    const chapters = chaptersInVolume(chapterText, { next });
    if (chapters.length) next = Math.max(next, highestChapter(chapters) + 1);
    const title = cleanTitle(`"${field("LicensedTitle") || field("OriginalTitle")}"`);
    const date = (/([A-Z][a-z]+ \d{1,2}, \d{4})/.exec(field("OriginalRelDate")) || [])[1] || null;
    volumes.push({ volume, title, date, chapters });
  }
  return volumes;
}

// The highest whole chapter number listed (side chapters like 0.8 don't lower it).
const highestChapter = (chapters) => chapters.reduce((max, item) => Math.max(max, Math.floor(Number(item.chapter)) || 0), 0);

// Accept Wikipedia's list only when it is consistent: volumes in order, chapters
// increasing without large gaps, and not far beyond AniList's count. Side chapters
// with a part number or below 1 placed out of order (Bleach's 0.8 after 107, its two
// chapter 0s in volume 23, 520.5 after 643) are allowed; whole numbers must keep the order.
export function plausibleList(volumes, { chaptersTotal = null } = {}) {
  const all = volumes.flatMap((group) => group.chapters.map((item) => Number(item.chapter)));
  let highest = -Infinity;
  const numbers = all.filter((value) => {
    const side = (!Number.isInteger(value) || value < 1) && value < highest;
    if (!side) highest = Math.max(highest, value);
    return !side;
  });
  if (volumes.length < 1 || numbers.length < 3) return false;
  for (let i = 1; i < numbers.length; i += 1) if (!(numbers[i] > numbers[i - 1]) || numbers[i] - numbers[i - 1] > 5) return false;
  if (Number.isInteger(chaptersTotal) && chaptersTotal > 0 && numbers[numbers.length - 1] > chaptersTotal + 20) return false;
  return true;
}

// null: the page doesn't exist. Throws when Wikipedia couldn't answer (busy, rate
// limited, offline), so the caller can try again later instead of caching "no list".
async function wikiPage(page, { fetchImpl, endpoint }) {
  const params = new URLSearchParams({ action: "parse", page, prop: "wikitext", redirects: "1", format: "json", formatversion: "2", origin: "*" });
  const response = await fetchImpl(`${endpoint}?${params}`, { headers: { "User-Agent": "LVL (local app)", Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (response.status === 429 || response.status >= 500) throw Object.assign(new Error(`Wikipedia answered HTTP ${response.status}`), { code: "wiki-busy" });
  if (!response.ok) return null;
  const payload = await response.json().catch(() => undefined);
  if (payload === undefined) throw Object.assign(new Error("Wikipedia sent an unreadable answer (it may be limiting requests)"), { code: "wiki-busy" });
  if (payload?.error?.code === "missingtitle") return null;
  if (payload?.error) throw Object.assign(new Error(`Wikipedia: ${payload.error.info || payload.error.code}`), { code: "wiki-busy" });
  const text = payload?.parse?.wikitext;
  return typeof text === "string" && text.length < 3_000_000 ? { title: String(payload.parse.title || page), text } : null;
}

// Long series split the list into parts: "Lists of One Piece chapters" links to
// "List of One Piece chapters (1–186)", … "(1016–current)"; "List of Naruto volumes"
// names "List of Naruto chapters (Part I)" in {{Main|…}}. The parts, in page order (at most 12).
export function chapterListParts(wikitext, title) {
  const escaped = String(title || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!escaped) return [];
  const name = `List of ${escaped}(?: manga)? (?:chapters|volumes) \\([^\\]|#{}]{1,60}\\)`;
  const link = new RegExp(`\\[\\[\\s*(${name})\\s*(?:[|#][^\\]]*)?\\]\\]|\\{\\{\\s*(?:Main|See also|Further)\\s*\\|\\s*(${name})`, "gi");
  return [...new Set([...String(wikitext).matchAll(link)].map((match) => (match[1] || match[2]).replace(/_/g, " ").trim()))].slice(0, 12);
}

// Only numbers are taken from Wikipedia: which chapters exist and which volume each is in
//. Titles come from the chosen sources instead.
const numbersOnly = (volumes) => volumes.map((group) => ({ volume: group.volume, date: group.date || null, chapters: group.chapters.map((item) => ({ chapter: item.chapter })) }));

export async function fetchWikipediaList(titles, { fetchImpl = globalThis.fetch, endpoint = WIKIPEDIA_API } = {}) {
  let busy = null;
  for (const title of [...new Set(titles.filter(Boolean))].slice(0, 3)) {
    let page;
    try { page = await wikiPage(`List of ${title} chapters`, { fetchImpl, endpoint }); } catch (error) { busy = error; continue; }
    if (!page) continue;
    const volumes = parseChapterList(page.text);
    if (volumes.length) return { page: page.title, volumes: numbersOnly(volumes) };
    // An index of parts: read each, carrying the chapter numbering across them.
    const parts = chapterListParts(page.text, title);
    if (!parts.length) continue;
    const all = [];
    for (const part of parts) {
      const piece = await wikiPage(part, { fetchImpl, endpoint }); // a busy answer throws: try again later
      if (!piece) return null; // a missing part would leave a hole; MangaDex and AniList fill in instead
      const next = all.length ? highestChapter(all.flatMap((group) => group.chapters)) + 1 : 1;
      const partVolumes = parseChapterList(piece.text, { next });
      if (!partVolumes.length) return null;
      all.push(...partVolumes);
    }
    return { page: page.title, parts: parts.length, volumes: numbersOnly(all) };
  }
  if (busy) throw busy;
  return null;
}

// One index: Wikipedia's volumes first, MangaDex's chapters for anything not in them,
// then AniList's count for chapters nobody lists (shown in "Not in a volume yet").
export function mergeIndex({ wikipedia = null, mangadex = null, chaptersTotal = null, volumesTotal = null } = {}) {
  const byVolume = new Map();
  const seen = new Set();
  const add = (volume, chapter, title = "") => {
    if (!chapter || seen.has(chapter)) return;
    seen.add(chapter);
    if (!byVolume.has(volume)) byVolume.set(volume, { volume, chapters: [] });
    byVolume.get(volume).chapters.push({ chapter, ...(title ? { title } : {}) });
  };
  const meta = new Map();
  for (const group of wikipedia?.volumes || []) {
    meta.set(group.volume, { title: group.title || "", date: group.date || null });
    if (!byVolume.has(group.volume)) byVolume.set(group.volume, { volume: group.volume, chapters: [] });
    for (const item of group.chapters) add(group.volume, item.chapter, item.title);
  }
  for (const group of mangadex?.volumes || []) for (const item of group.chapters) add(group.volume, item.chapter);
  if (Number.isInteger(chaptersTotal) && chaptersTotal > 0 && chaptersTotal <= 5000) {
    for (let n = 1; n <= chaptersTotal; n += 1) if (!seen.has(String(n))) add(null, String(n));
  }
  const total = Number.isInteger(volumesTotal) && volumesTotal > 0 && volumesTotal <= 500 ? volumesTotal : 0;
  for (let n = 1; n <= total; n += 1) if (!byVolume.has(String(n))) byVolume.set(String(n), { volume: String(n), chapters: [] });
  const volumes = sortVolumes([...byVolume.values()]).map((group) => ({ ...group, ...(meta.get(group.volume) || {}) }));
  const chapterCount = volumes.reduce((sum, group) => sum + group.chapters.length, 0);
  return {
    volumes, chapterCount,
    sources: [wikipedia ? "wikipedia" : "", mangadex?.volumes?.length ? "mangadex" : "", chaptersTotal ? "anilist" : ""].filter(Boolean),
    complete: Boolean(wikipedia) || (Number.isInteger(chaptersTotal) && chapterCount >= chaptersTotal),
  };
}

