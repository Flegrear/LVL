import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const dataRoot = path.join(root, "data");
const manifest = JSON.parse(await fs.readFile(path.join(dataRoot, "manifest.json"), "utf8"));

function csvRows(text) {
  const rows = [];
  let field = "";
  let row = [];
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { field += '"'; index += 1; continue; }
      if (char === '"') { quoted = false; continue; }
      field += char;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === ",") { row.push(field); field = ""; continue; }
    if (char === "\n") { row.push(field.replace(/\r$/, "")); rows.push(row); row = []; field = ""; continue; }
    field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function lexicalCount(value, locale) {
  const segmenter = new Intl.Segmenter(locale, { granularity: "word" });
  return [...segmenter.segment(value)].filter((segment) => segment.isWordLike).length;
}

async function fetchText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return response.text();
}

for (const [language, config] of Object.entries(manifest.languages)) {
  const wordCode = config.wordSourceCode;
  const wordFile = wordCode === "ja" ? "ja_full.txt" : `${wordCode}_50k.txt`;
  const wordUrl = `https://raw.githubusercontent.com/hermitdave/FrequencyWords/${manifest.provenance.words.upstreamCommit}/content/2018/${wordCode}/${wordFile}`;
  const wordText = await fetchText(wordUrl);
  const words = [];
  for (const line of wordText.split(/\r?\n/)) {
    const match = line.match(/^(.+?)\s+(\d+)$/u);
    if (!match) continue;
    const value = match[1].trim();
    if (!value || value.length > 80 || /\s/u.test(value) || !/[\p{L}\p{N}]/u.test(value)) continue;
    words.push(`${value.replaceAll("\t", " ")}\t${match[2]}`);
    if (words.length >= 5_000) break;
  }
  if (words.length < 5_000) throw new Error(`${language}: only ${words.length} usable words`);
  await fs.writeFile(path.join(dataRoot, `${language.toLowerCase()}.words.tsv`), `${words.join("\n")}\n`, "utf8");

  const phraseCode = config.phraseSourceCode;
  const phraseUrl = `https://raw.githubusercontent.com/orgtre/top-open-subtitles-sentences/${manifest.provenance.phrases.upstreamCommit}/bld/top_sentences/${phraseCode}_top_sentences.csv`;
  const phraseText = await fetchText(phraseUrl);
  const rows = csvRows(phraseText);
  const phrases = [];
  for (const row of rows.slice(1)) {
    const value = String(row[0] || "").replace(/\s+/g, " ").trim();
    const count = Number(row[1]);
    if (!value || !Number.isFinite(count) || count < 1 || value.length > 120) continue;
    const tokens = lexicalCount(value, phraseCode.replace("_", "-"));
    if (tokens < 2 || tokens > 8) continue;
    phrases.push(`${value.replaceAll("\t", " ")}\t${Math.round(count)}`);
    if (phrases.length >= 1_000) break;
  }
  if (phrases.length < 1_000) throw new Error(`${language}: only ${phrases.length} usable phrases`);
  await fs.writeFile(path.join(dataRoot, `${language.toLowerCase()}.phrases.tsv`), `${phrases.join("\n")}\n`, "utf8");
  console.log(`${language}: ${words.length} words, ${phrases.length} phrases`);
}
