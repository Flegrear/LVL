import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const learningRoot = path.dirname(fileURLToPath(import.meta.url));
const dataRoot = path.join(learningRoot, "data");
const MAX_CACHE_ENTRIES = 12;
const dataCache = new Map();
let manifestPromise = null;

function touchCache(key, value) {
  dataCache.delete(key);
  dataCache.set(key, value);
  while (dataCache.size > MAX_CACHE_ENTRIES) dataCache.delete(dataCache.keys().next().value);
  return value;
}

async function loadManifest() {
  if (!manifestPromise) {
    manifestPromise = fs.readFile(path.join(dataRoot, "manifest.json"), "utf8")
      .then((text) => JSON.parse(text));
  }
  return manifestPromise;
}

function normalizePresetLanguage(value) {
  const raw = String(value || "").trim().toUpperCase().replace("-", "_");
  if (raw === "ZH_CN" || raw === "ZH_TW") return "ZH";
  if (raw === "PT_BR" || raw === "PT_PT") return "PT";
  return raw;
}

function normalizePresetKind(value) {
  const raw = String(value || "").trim().toLowerCase();
  return raw === "words" || raw === "phrases" ? raw : null;
}

function resolvePresetSize(manifest, kind, value) {
  const allowed = kind === "words" ? manifest.wordSizes : manifest.phraseSizes;
  const fallback = allowed.at(-1);
  if (value === undefined || value === null || value === "") return fallback;
  const size = Number(value);
  return allowed.includes(size) ? size : null;
}

async function loadPresetRows(language, kind) {
  const manifest = await loadManifest();
  const languageConfig = manifest.languages[language];
  if (!languageConfig) return null;
  const cacheKey = `${language}:${kind}`;
  const cached = dataCache.get(cacheKey);
  if (cached) return touchCache(cacheKey, cached);

  const file = path.join(dataRoot, `${language.toLowerCase()}.${kind}.tsv`);
  const text = await fs.readFile(file, "utf8");
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const tab = line.lastIndexOf("\t");
    if (tab <= 0) continue;
    const value = line.slice(0, tab).trim();
    const count = Number(line.slice(tab + 1));
    if (!value) continue;
    rows.push({ value, count: Number.isFinite(count) && count >= 0 ? count : 0 });
  }
  return touchCache(cacheKey, rows);
}

function compactRows(rows, size, includeCounts = false) {
  return rows.slice(0, size).map((row, index) => includeCounts
    ? { value: row.value, rank: index + 1, count: row.count }
    : { value: row.value, rank: index + 1 });
}

export async function learningPresetCatalog() {
  const manifest = await loadManifest();
  return {
    schemaVersion: manifest.schemaVersion,
    datasetVersion: manifest.datasetVersion,
    wordSizes: manifest.wordSizes,
    phraseSizes: manifest.phraseSizes,
    languages: Object.entries(manifest.languages).map(([code, config]) => ({ code, name: config.name })),
    provenance: manifest.provenance,
  };
}
export async function learningPresetBundle(languageInput, {
  wordSize,
  phraseSize,
  includeCounts = false,
} = {}) {
  const manifest = await loadManifest();
  const language = normalizePresetLanguage(languageInput);
  const config = manifest.languages[language];
  if (!config) return null;
  const wordsSize = resolvePresetSize(manifest, "words", wordSize);
  const phrasesSize = resolvePresetSize(manifest, "phrases", phraseSize);
  if (!wordsSize || !phrasesSize) return { error: "unsupported-size", manifest };
  const [wordRows, phraseRows] = await Promise.all([
    loadPresetRows(language, "words"),
    loadPresetRows(language, "phrases"),
  ]);
  return {
    schemaVersion: manifest.schemaVersion,
    datasetVersion: manifest.datasetVersion,
    language,
    languageName: config.name,
    wordSize: wordsSize,
    phraseSize: phrasesSize,
    words: compactRows(wordRows || [], wordsSize, includeCounts),
    phrases: compactRows(phraseRows || [], phrasesSize, includeCounts),
    provenance: manifest.provenance,
  };
}

export async function learningPresetSlice(languageInput, kindInput, sizeInput, { includeCounts = false } = {}) {
  const manifest = await loadManifest();
  const language = normalizePresetLanguage(languageInput);
  const kind = normalizePresetKind(kindInput);
  const config = manifest.languages[language];
  if (!config || !kind) return null;
  const size = resolvePresetSize(manifest, kind, sizeInput);
  if (!size) return { error: "unsupported-size", manifest };
  const rows = await loadPresetRows(language, kind);
  return {
    schemaVersion: manifest.schemaVersion,
    datasetVersion: manifest.datasetVersion,
    language,
    languageName: config.name,
    type: kind,
    size,
    items: compactRows(rows || [], size, includeCounts),
    provenance: manifest.provenance[kind],
  };
}
