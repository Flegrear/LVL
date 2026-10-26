// anki.js: read and write Anki decks, so cards move between Anki and this app with their schedule.
//
// Reading: .apkg / .colpkg (collection.anki21b zstd, collection.anki21, collection.anki2; both the
// legacy JSON schema and the newer table schema) and Anki's "Notes in Plain Text" export.
// Writing: .apkg in the legacy schema every Anki version imports, and the plain-text format.
// readAnkiCollection() also returns note types (templates, CSS) and media, so decks can be
// stored and shown the way Anki shows them (anki-store.js, anki-render.js).

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import AdmZip from "adm-zip";
import { DAY_MS, dayStartMs } from "../browser/review-scheduler.js";

export const MAX_ANKI_IMPORT_CARDS = 50_000;
const MAX_COLLECTION_BYTES = 1024 * 1024 * 1024;
const FIELD_SEPARATOR = "\x1f";

/* ---------------------------------------------------------------- text helpers */

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };

export function htmlToText(value) {
  return String(value || "")
    .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/\[sound:[^\]]*\]/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(div|p|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
      if (code[0] === "#") {
        const number = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(number) && number > 0 && number < 0x110000 ? String.fromCodePoint(number) : "";
      }
      return ENTITIES[code.toLowerCase()] ?? match;
    })
    // Anki furigana: 漢字[かんじ] shows the kanji; the reading stays in the note.
    .replace(/ ?([^\s[\]]+)\[[^\]]*\]/gu, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[char]);
}

/* ---------------------------------------------------------------- templates */

const CLOZE = /\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g;

function renderCloze(text, number, side) {
  return String(text || "").replace(CLOZE, (match, index, answer, hint) => {
    if (Number(index) !== number) return answer;
    return side === "question" ? `[${hint || "…"}]` : `[${answer}]`;
  });
}

// Enough of Anki's template language for text: fields, filters, conditionals, cloze.
function renderTemplate(template, fields, { cloze = 0, side = "question", frontSide = "" } = {}) {
  let output = String(template || "");
  for (let pass = 0; pass < 4; pass += 1) {
    const before = output;
    output = output.replace(/\{\{([#^])([^}]+)\}\}([\s\S]*?)\{\{\/\2\}\}/g, (match, kind, name, inner) => {
      const filled = Boolean(htmlToText(fields[name.trim()] || ""));
      return (kind === "#" ? filled : !filled) ? inner : "";
    });
    if (output === before) break;
  }
  return output.replace(/\{\{([^}]+)\}\}/g, (match, rawName) => {
    const name = rawName.trim();
    if (name === "FrontSide") return frontSide;
    const parts = name.split(":");
    const field = parts.pop().trim();
    const filters = parts.map((part) => part.trim().toLowerCase());
    if (filters.includes("type") || filters.includes("tts")) return "";
    const value = fields[field] ?? "";
    if (filters.includes("cloze")) return renderCloze(value, cloze, side);
    return value;
  });
}

/* ---------------------------------------------------------------- tiny protobuf reader */

// The newer collection schema stores note type and template settings as protobuf messages.
function readProtobuf(bytes) {
  const buffer = Buffer.from(bytes || []);
  const fields = new Map();
  let offset = 0;
  const varint = () => {
    let result = 0n;
    let shift = 0n;
    while (offset < buffer.length) {
      const byte = buffer[offset++];
      result |= BigInt(byte & 0x7f) << shift;
      if (!(byte & 0x80)) break;
      shift += 7n;
    }
    return result;
  };
  while (offset < buffer.length) {
    const key = Number(varint());
    const number = key >> 3;
    const wire = key & 7;
    let value;
    if (wire === 0) value = Number(varint());
    else if (wire === 2) {
      const length = Number(varint());
      value = buffer.subarray(offset, offset + length);
      offset += length;
    } else if (wire === 1) { value = buffer.subarray(offset, offset + 8); offset += 8; }
    else if (wire === 5) { value = buffer.subarray(offset, offset + 4); offset += 4; }
    else break;
    if (!fields.has(number)) fields.set(number, value);
  }
  return fields;
}

/* ---------------------------------------------------------------- collection */

function collectionBytes(zip) {
  const entry = (name) => zip.getEntry(name);
  const modern = entry("collection.anki21b");
  if (modern) {
    const compressed = modern.getData();
    if (typeof zlib.zstdDecompressSync !== "function") throw Object.assign(new Error("This Anki package needs zstd support (Node 22.15+)"), { statusCode: 422 });
    return { bytes: zlib.zstdDecompressSync(compressed, { maxOutputLength: MAX_COLLECTION_BYTES }), format: "anki21b" };
  }
  for (const name of ["collection.anki21", "collection.anki2"]) {
    const found = entry(name);
    if (found) {
      if (found.header.size > MAX_COLLECTION_BYTES) throw Object.assign(new Error("The Anki collection is too large"), { statusCode: 413 });
      return { bytes: found.getData(), format: name.split(".")[1] };
    }
  }
  throw Object.assign(new Error("This file has no Anki collection inside"), { statusCode: 422 });
}

function withTemporaryDatabase(bytes, work) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lvl-anki-"));
  const file = path.join(directory, "collection.db");
  fs.writeFileSync(file, bytes);
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    return work(db);
  } finally {
    try { db?.close(); } catch {}
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function hasTable(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function loadCollectionModel(db) {
  const col = db.prepare("SELECT * FROM col LIMIT 1").get() || {};
  const crtSeconds = Number(col.crt) || Math.floor(Date.now() / 1000);
  const decks = new Map();
  const notetypes = new Map();
  if (hasTable(db, "notetypes")) {
    for (const row of db.prepare("SELECT id, name FROM decks").all()) decks.set(String(row.id), String(row.name || "").split(FIELD_SEPARATOR).join("::"));
    for (const row of db.prepare("SELECT id, name, config FROM notetypes").all()) {
      const config = readProtobuf(row.config);
      notetypes.set(String(row.id), {
        id: String(row.id),
        name: String(row.name || "Note"),
        cloze: config.get(1) === 1,
        css: config.get(3) ? Buffer.from(config.get(3)).toString("utf8") : "",
        fields: [],
        templates: [],
      });
    }
    for (const row of db.prepare("SELECT ntid, ord, name FROM fields ORDER BY ntid, ord").all()) notetypes.get(String(row.ntid))?.fields.push(String(row.name));
    for (const row of db.prepare("SELECT ntid, ord, name, config FROM templates ORDER BY ntid, ord").all()) {
      const config = readProtobuf(row.config);
      notetypes.get(String(row.ntid))?.templates.push({
        name: String(row.name || ""),
        qfmt: config.get(1) ? Buffer.from(config.get(1)).toString("utf8") : "",
        afmt: config.get(2) ? Buffer.from(config.get(2)).toString("utf8") : "",
      });
    }
  } else {
    const parse = (value) => { try { return JSON.parse(value || "{}"); } catch { return {}; } };
    for (const [id, deck] of Object.entries(parse(col.decks))) decks.set(String(id), String(deck?.name || "Default"));
    for (const [id, model] of Object.entries(parse(col.models))) {
      notetypes.set(String(id), {
        id: String(id),
        name: String(model?.name || "Note"),
        cloze: Number(model?.type) === 1,
        css: String(model?.css || ""),
        fields: (Array.isArray(model?.flds) ? model.flds : []).slice().sort((a, b) => a.ord - b.ord).map((field) => String(field.name)),
        templates: (Array.isArray(model?.tmpls) ? model.tmpls : []).slice().sort((a, b) => a.ord - b.ord).map((template) => ({ name: String(template.name || ""), qfmt: String(template.qfmt || ""), afmt: String(template.afmt || "") })),
      });
    }
  }
  return { crtSeconds, decks, notetypes };
}

// Anki card columns → this app's schedule.
function scheduleFromAnki(row, crtSeconds, now) {
  const type = Number(row.type);
  const queue = Number(row.queue);
  const due = Number(row.originalDue) || Number(row.due) || 0;
  const reviewCount = Math.max(0, Number(row.reps) || 0);
  const ease = Number(row.factor) > 0 ? Math.round(Number(row.factor)) / 1000 : undefined;
  const crtDay = dayStartMs(crtSeconds * 1000);
  const dayDue = (days) => new Date(new Date(crtDay).setDate(new Date(crtDay).getDate() + days)).getTime();
  const base = { reviewCount, lapses: Math.max(0, Number(row.lapses) || 0), suspended: queue === -1, ...(ease ? { ease } : {}) };
  if (type === 2) {
    const intervalDays = Math.max(1, Number(row.ivl) || 1);
    const dueAt = dayDue(due);
    return { ...base, state: "review", learningStep: 0, intervalDays, dueAt, lastReviewedAt: dueAt - intervalDays * DAY_MS, firstReviewedAt: dueAt - intervalDays * DAY_MS };
  }
  if (type === 1 || type === 3) {
    const relearning = type === 3;
    const steps = relearning ? 1 : 2;
    const remaining = Math.max(1, (Number(row.left) || 0) % 1000);
    const dueAt = queue === 3 ? dayDue(due) : due * 1000 || now;
    return {
      ...base,
      state: relearning ? "relearning" : "learning",
      learningStep: Math.max(0, Math.min(steps - 1, steps - remaining)),
      intervalDays: relearning ? Math.max(1, Number(row.ivl) || 1) : 0,
      lapseIntervalDays: relearning ? Math.max(1, Number(row.ivl) || 1) : undefined,
      dueAt,
      lastReviewedAt: Math.min(now, dueAt),
      firstReviewedAt: Math.min(now, dueAt) - DAY_MS,
    };
  }
  return { ...base, state: "new", learningStep: 0, intervalDays: 0, dueAt: now, newPosition: due };
}

function cardSides(note, notetype, ord) {
  const fields = Object.fromEntries((notetype?.fields || []).map((name, index) => [name, note.fields[index] ?? ""]));
  if (notetype?.fields?.length === EXPORT_FIELDS.length && EXPORT_FIELDS.every((name, index) => notetype.fields[index] === name)) {
    // Cards exported by this app: keep the parts apart.
    return {
      front: htmlToText(fields.Front),
      back: htmlToText(fields.Back) || htmlToText(fields.Translation),
      reading: htmlToText(fields.Reading),
      sentence: htmlToText(fields.Sentence),
      translation: htmlToText(fields.Translation),
    };
  }
  const template = notetype?.cloze ? notetype.templates[0] : notetype?.templates[ord];
  if (!template) {
    return { front: htmlToText(note.fields[0]), back: htmlToText(note.fields.slice(1).join("\n")) };
  }
  const cloze = notetype.cloze ? ord + 1 : 0;
  const question = renderTemplate(template.qfmt, fields, { cloze, side: "question" });
  const answer = renderTemplate(template.afmt, fields, { cloze, side: "answer", frontSide: "" });
  let back = htmlToText(answer);
  const front = htmlToText(question);
  if (!notetype.cloze && back.startsWith(front)) back = back.slice(front.length).trim();
  return { front, back };
}

// Every value of every field (repeated fields included), for the package media list.
function readProtobufAll(bytes) {
  const buffer = Buffer.from(bytes || []);
  const fields = new Map();
  let offset = 0;
  const varint = () => {
    let result = 0n;
    let shift = 0n;
    while (offset < buffer.length) {
      const byte = buffer[offset++];
      result |= BigInt(byte & 0x7f) << shift;
      if (!(byte & 0x80)) break;
      shift += 7n;
    }
    return result;
  };
  while (offset < buffer.length) {
    const key = Number(varint());
    const number = key >> 3;
    const wire = key & 7;
    let value;
    if (wire === 0) value = Number(varint());
    else if (wire === 2) {
      const length = Number(varint());
      value = buffer.subarray(offset, offset + length);
      offset += length;
    } else if (wire === 1) { value = buffer.subarray(offset, offset + 8); offset += 8; }
    else if (wire === 5) { value = buffer.subarray(offset, offset + 4); offset += 4; }
    else break;
    if (!fields.has(number)) fields.set(number, []);
    fields.get(number).push(value);
  }
  return fields;
}

const MAX_MEDIA_FILE_BYTES = 64 * 1024 * 1024;

// Media in a package: legacy packages list {"0": "name.jpg"} as JSON; newer ones (meta version 3)
// list protobuf entries, and both the list and each file are zstd-compressed.
function mediaEntries(zip) {
  const meta = zip.getEntry("meta");
  const version = meta ? Number(readProtobuf(meta.getData()).get(1)) || 0 : 0;
  const zstd = version >= 3;
  const list = zip.getEntry("media");
  if (!list) return [];
  let data = list.getData();
  if (zstd) {
    if (typeof zlib.zstdDecompressSync !== "function") return [];
    data = zlib.zstdDecompressSync(data, { maxOutputLength: 64 * 1024 * 1024 });
  }
  let pairs = [];
  if (zstd) {
    pairs = (readProtobufAll(data).get(1) || []).map((entryBytes, index) => {
      const entry = readProtobufAll(entryBytes);
      const legacyName = entry.get(255)?.[0];
      return { index: String(legacyName ?? index), name: Buffer.from(entry.get(1)?.[0] || []).toString("utf8") };
    });
  } else {
    try {
      pairs = Object.entries(JSON.parse(data.toString("utf8") || "{}")).map(([index, name]) => ({ index: String(index), name: String(name) }));
    } catch {
      pairs = [];
    }
  }
  return pairs
    .filter(({ name }) => name && !/[\\/]/.test(name) && name !== "." && name !== "..")
    .map(({ index, name }) => ({
      name,
      read() {
        const entry = zip.getEntry(index);
        if (!entry || entry.header.size > MAX_MEDIA_FILE_BYTES) return null;
        const raw = entry.getData();
        return zstd ? zlib.zstdDecompressSync(raw, { maxOutputLength: MAX_MEDIA_FILE_BYTES }) : raw;
      },
    }));
}

/**
 * Everything in an Anki package: note types (fields, templates, CSS), notes, cards with their
 * schedule, deck names and media (read lazily). Used to store a deck and render it like Anki.
 */
export function readAnkiCollection(buffer, { now = Date.now(), maxCards = MAX_ANKI_IMPORT_CARDS } = {}) {
  let zip;
  try {
    zip = new AdmZip(Buffer.from(buffer));
  } catch {
    throw Object.assign(new Error("This isn't a readable Anki package"), { statusCode: 422 });
  }
  const { bytes, format } = collectionBytes(zip);
  const media = mediaEntries(zip);
  return withTemporaryDatabase(bytes, (db) => {
    const { crtSeconds, decks, notetypes } = loadCollectionModel(db);
    const notes = new Map();
    for (const row of db.prepare("SELECT id, guid, mid, tags, flds FROM notes").all()) {
      notes.set(String(row.id), { id: String(row.id), guid: String(row.guid || row.id), mid: String(row.mid), tags: String(row.tags || "").trim().split(/\s+/).filter(Boolean), fields: String(row.flds || "").split(FIELD_SEPARATOR) });
    }
    const rows = db.prepare("SELECT id, nid, did, ord, type, queue, due, ivl, factor, reps, lapses, left, odid, odue FROM cards ORDER BY nid, ord").all();
    const cards = [];
    for (const row of rows) {
      if (cards.length >= maxCards) break;
      const note = notes.get(String(row.nid));
      if (!note) continue;
      const deckId = Number(row.odid) ? String(row.odid) : String(row.did);
      cards.push({
        cardId: String(row.id),
        noteId: note.id,
        ord: Number(row.ord) || 0,
        deck: decks.get(deckId) || "Default",
        ...scheduleFromAnki({ ...row, originalDue: Number(row.odid) ? row.odue : 0 }, crtSeconds, now),
      });
    }
    const usedNotes = new Set(cards.map((card) => card.noteId));
    const usedTypes = new Set([...usedNotes].map((id) => notes.get(id)?.mid));
    // The dummy collection Anki adds for old versions is a single "please update" note.
    const onlyNote = cards.length === 1 ? notes.get(cards[0].noteId) : null;
    const dummy = format === "anki2" && onlyNote && /update to the latest anki/i.test(htmlToText(onlyNote.fields.join(" ")));
    return {
      format,
      crtSeconds,
      decks,
      notetypes: [...notetypes.entries()].filter(([id]) => usedTypes.has(id)).map(([id, type]) => ({ ...type, id })),
      notes: [...usedNotes].map((id) => notes.get(id)),
      cards: dummy ? [] : cards,
      media: dummy ? [] : media,
      total: rows.length,
      truncated: rows.length > maxCards,
      dummy: Boolean(dummy),
    };
  });
}

// Plain-text sides of one card (search, quizzes, tests), from its note type's templates.
export function ankiCardText(note, notetype, ord) {
  return cardSides(note, notetype, ord);
}

export function readAnkiPackage(buffer, { now = Date.now(), maxCards = MAX_ANKI_IMPORT_CARDS } = {}) {
  const collection = readAnkiCollection(buffer, { now, maxCards });
  const notes = new Map(collection.notes.map((note) => [note.id, note]));
  const notetypes = new Map(collection.notetypes.map((type) => [type.id, type]));
  const cards = [];
  for (const card of collection.cards) {
    const note = notes.get(card.noteId);
    const notetype = notetypes.get(note?.mid);
    const { front, back, reading = "", sentence = "", translation = "" } = cardSides(note, notetype, card.ord);
    if (!front) continue;
    cards.push({ ...card, front, back, reading, sentence, translation, notetype: notetype?.name || "Note", tags: note.tags, guid: note.guid });
  }
  return { format: collection.format, cards, total: collection.total, media: collection.media.length, truncated: collection.truncated };
}


/* ---------------------------------------------------------------- plain text (Notes in Plain Text) */

function splitDelimited(text, separator) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === "\"" && text[index + 1] === "\"") { field += "\""; index += 1; }
      else if (char === "\"") quoted = false;
      else field += char;
      continue;
    }
    if (char === "\"" && field === "") { quoted = true; continue; }
    if (char === separator) { row.push(field); field = ""; continue; }
    if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((cells) => cells.some((cell) => cell.trim()));
}

const SEPARATORS = { tab: "\t", comma: ",", semicolon: ";", space: " ", pipe: "|", colon: ":" };

export function readAnkiText(text, { now = Date.now(), maxCards = MAX_ANKI_IMPORT_CARDS } = {}) {
  const lines = String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/);
  const header = {};
  let bodyStart = 0;
  while (bodyStart < lines.length && lines[bodyStart].startsWith("#")) {
    const match = lines[bodyStart].match(/^#([\w ]+):(.*)$/);
    if (match) header[match[1].trim().toLowerCase()] = match[2].trim();
    bodyStart += 1;
  }
  const body = lines.slice(bodyStart).join("\n");
  const firstLine = lines[bodyStart] || "";
  const separator = SEPARATORS[String(header.separator || "").toLowerCase()] || header.separator?.[0]
    || (firstLine.includes("\t") ? "\t" : firstLine.includes(";") ? ";" : ",");
  const column = (name) => {
    const value = Number(header[`${name} column`]);
    return Number.isInteger(value) && value >= 1 ? value - 1 : -1;
  };
  const special = { guid: column("guid"), notetype: column("notetype"), deck: column("deck"), tags: column("tags") };
  const html = String(header.html || "true").toLowerCase() !== "false";
  const clean = (value) => (html ? htmlToText(value) : String(value || "").trim());
  const rows = splitDelimited(body, separator);
  const cards = [];
  for (const cells of rows) {
    if (cards.length >= maxCards) break;
    const fields = cells.filter((cell, index) => !Object.values(special).includes(index));
    const front = clean(fields[0]);
    if (!front) continue;
    cards.push({
      front,
      back: fields.slice(1).map(clean).filter(Boolean).join("\n"),
      deck: special.deck >= 0 ? String(cells[special.deck] || "").trim() || header.deck || "Imported" : header.deck || "Imported",
      notetype: special.notetype >= 0 ? String(cells[special.notetype] || "").trim() : header.notetype || "Basic",
      tags: [...(header.tags ? header.tags.split(/\s+/) : []), ...(special.tags >= 0 ? String(cells[special.tags] || "").split(/\s+/) : [])].filter(Boolean),
      guid: special.guid >= 0 ? String(cells[special.guid] || "").trim() : crypto.createHash("sha1").update(`${front}\u0000${fields[1] || ""}`).digest("hex").slice(0, 16),
      ord: 0,
      state: "new",
      learningStep: 0,
      intervalDays: 0,
      dueAt: now,
      reviewCount: 0,
      lapses: 0,
    });
  }
  return { format: "text", cards, total: rows.length, media: 0, truncated: rows.length > maxCards };
}

/* ---------------------------------------------------------------- writing */

const EXPORT_MODEL_ID = 1_698_000_000_101;
const EXPORT_FIELDS = ["Front", "Back", "Reading", "Sentence", "Translation", "Source"];
const EXPORT_CSS = `.card { font-family: "Segoe UI", "Hiragino Sans", "Noto Sans CJK JP", Arial, sans-serif; font-size: 22px; text-align: center; color: #111; background: #fff; }
.front { font-size: 40px; font-weight: 600; }
.reading { color: #666; font-size: 18px; margin-top: 4px; }
.sentence { margin-top: 18px; font-size: 22px; }
.sentence b { text-decoration: underline; }
.back { margin-top: 10px; }
.translation { color: #444; margin-top: 12px; font-size: 20px; }
.source { color: #999; margin-top: 18px; font-size: 13px; }
.nightMode .card, .card.nightMode { color: #eee; background: #111; }`;
const EXPORT_QFMT = "<div class=\"front\">{{Front}}</div>{{#Reading}}<div class=\"reading\">{{Reading}}</div>{{/Reading}}{{#Sentence}}<div class=\"sentence\">{{Sentence}}</div>{{/Sentence}}";
const EXPORT_AFMT = "{{FrontSide}}<hr id=\"answer\">{{#Back}}<div class=\"back\">{{Back}}</div>{{/Back}}{{#Translation}}<div class=\"translation\">{{Translation}}</div>{{/Translation}}{{#Source}}<div class=\"source\">{{Source}}</div>{{/Source}}";

const BASE91 = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#$%&()*+,-./:;<=>?@[]^_`{|}~";

function stableGuid(seed) {
  let value = BigInt(`0x${crypto.createHash("sha256").update(String(seed)).digest("hex").slice(0, 16)}`);
  let output = "";
  while (value > 0n) { output = BASE91[Number(value % 91n)] + output; value /= 91n; }
  return output || "a";
}

function sortFieldChecksum(text) {
  return parseInt(crypto.createHash("sha1").update(htmlToText(text)).digest("hex").slice(0, 8), 16);
}

function exportFields(card) {
  const sentence = String(card.context || "");
  const front = String(card.front || "");
  const highlighted = sentence && front && sentence.includes(front)
    ? escapeHtml(sentence).split(escapeHtml(front)).join(`<b>${escapeHtml(front)}</b>`)
    : escapeHtml(sentence);
  const translation = String(card.baseContext || "");
  const back = String(card.back || "") === translation ? "" : String(card.back || "");
  const seconds = Math.max(0, Math.round(Number(card.timestampMs || 0) / 1000));
  const time = card.context && Number.isFinite(Number(card.timestampMs)) ? ` · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : "";
  return [
    escapeHtml(front),
    escapeHtml(back).replace(/\n/g, "<br>"),
    escapeHtml(card.romanized && card.romanized !== front ? card.romanized : ""),
    highlighted,
    escapeHtml(translation),
    escapeHtml(card.sourceTag ? `${card.sourceTag}${time}` : ""),
  ];
}

function tagsFor(card) {
  const tags = new Set(["language-video-learner", String(card.type || "card")]);
  (Array.isArray(card.anki?.tags) ? card.anki.tags : []).forEach((tag) => tags.add(String(tag)));
  if (card.targetLanguage) tags.add(`lang::${String(card.targetLanguage).toLowerCase()}`);
  return [...tags].map((tag) => tag.replace(/\s+/g, "_")).filter(Boolean);
}

function ankiScheduleFor(card, crtDayStart, now, position) {
  const state = card.state || "new";
  const factor = Math.round((Number(card.ease) || 2.5) * 1000);
  const reps = Math.max(0, Number(card.reviewCount) || 0);
  const lapses = Math.max(0, Number(card.lapses) || 0);
  const queueFor = (queue) => (card.suspended ? -1 : queue);
  if (state === "review") {
    const due = Math.round((dayStartMs(Number(card.dueAt) || now) - crtDayStart) / DAY_MS);
    return { type: 2, queue: queueFor(2), due, ivl: Math.max(1, Math.round(Number(card.intervalDays) || 1)), factor, reps, lapses, left: 0 };
  }
  if (state === "learning" || state === "relearning") {
    const steps = state === "relearning" ? 1 : 2;
    const remaining = Math.max(1, steps - (Number(card.learningStep) || 0));
    return {
      type: state === "relearning" ? 3 : 1,
      queue: queueFor(1),
      due: Math.floor((Number(card.dueAt) || now) / 1000),
      ivl: state === "relearning" ? Math.max(1, Math.round(Number(card.lapseIntervalDays || card.intervalDays) || 1)) : 0,
      factor,
      reps,
      lapses,
      left: remaining * 1000 + remaining,
    };
  }
  return { type: 0, queue: queueFor(0), due: position, ivl: 0, factor: 0, reps: 0, lapses: 0, left: 0 };
}

export function buildAnkiPackage(cards, { deckName = "LVL", now = Date.now() } = {}) {
  const list = (Array.isArray(cards) ? cards : []).filter((card) => String(card?.front || "").trim()).slice(0, MAX_ANKI_IMPORT_CARDS);
  const today = dayStartMs(now);
  const earliest = Math.min(today, ...list.filter((card) => card.state === "review").map((card) => dayStartMs(Number(card.dueAt) || now)));
  const crtDayStart = Number.isFinite(earliest) ? earliest : today;
  const deckId = 1_698_000_000_000 + (parseInt(crypto.createHash("sha1").update(deckName).digest("hex").slice(0, 6), 16) % 100_000);
  const nowSeconds = Math.floor(now / 1000);
  const model = {
    id: EXPORT_MODEL_ID, name: "LVL", type: 0, mod: nowSeconds, usn: -1, sortf: 0, did: deckId,
    tmpls: [{ name: "Card 1", ord: 0, qfmt: EXPORT_QFMT, afmt: EXPORT_AFMT, did: null, bqfmt: "", bafmt: "" }],
    flds: EXPORT_FIELDS.map((name, ord) => ({ name, ord, sticky: false, rtl: false, font: "Arial", size: 20, media: [] })),
    css: EXPORT_CSS, latexPre: "\\documentclass[12pt]{article}\n\\begin{document}\n", latexPost: "\\end{document}", req: [[0, "any", [0]]], tags: [], vers: [],
  };
  const deck = (id, name) => ({ id, name, mod: nowSeconds, usn: -1, lrnToday: [0, 0], revToday: [0, 0], newToday: [0, 0], timeToday: [0, 0], collapsed: false, desc: "", dyn: 0, conf: 1, extendNew: 10, extendRev: 50 });
  const dconf = { 1: { id: 1, name: "Default", mod: 0, usn: 0, maxTaken: 60, autoplay: true, timer: 0, replayq: true, dyn: false,
    new: { bury: true, delays: [1, 10], initialFactor: 2500, ints: [1, 4, 7], order: 1, perDay: 20, separate: true },
    lapse: { delays: [10], leechAction: 0, leechFails: 8, minInt: 1, mult: 0 },
    rev: { bury: true, ease4: 1.3, fuzz: 0.05, ivlFct: 1, maxIvl: 36500, minSpace: 1, perDay: 200, hardFactor: 1.2 } } };
  const conf = { activeDecks: [1], addToCur: true, collapseTime: 1200, curDeck: 1, curModel: String(EXPORT_MODEL_ID), dueCounts: true, estTimes: true, newBury: true, newSpread: 0, nextPos: list.length + 1, sortBackwards: false, sortType: "noteFld", timeLim: 0 };

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lvl-anki-export-"));
  const file = path.join(directory, "collection.anki2");
  try {
    const db = new DatabaseSync(file);
    db.exec(`
      CREATE TABLE col (id integer primary key, crt integer not null, mod integer not null, scm integer not null, ver integer not null, dty integer not null, usn integer not null, ls integer not null, conf text not null, models text not null, decks text not null, dconf text not null, tags text not null);
      CREATE TABLE notes (id integer primary key, guid text not null, mid integer not null, mod integer not null, usn integer not null, tags text not null, flds text not null, sfld integer not null, csum integer not null, flags integer not null, data text not null);
      CREATE TABLE cards (id integer primary key, nid integer not null, did integer not null, ord integer not null, mod integer not null, usn integer not null, type integer not null, queue integer not null, due integer not null, ivl integer not null, factor integer not null, reps integer not null, lapses integer not null, left integer not null, odue integer not null, odid integer not null, flags integer not null, data text not null);
      CREATE TABLE revlog (id integer primary key, cid integer not null, usn integer not null, ease integer not null, ivl integer not null, lastIvl integer not null, factor integer not null, time integer not null, type integer not null);
      CREATE TABLE graves (usn integer not null, oid integer not null, type integer not null);
      CREATE INDEX ix_notes_usn on notes (usn);
      CREATE INDEX ix_cards_usn on cards (usn);
      CREATE INDEX ix_revlog_usn on revlog (usn);
      CREATE INDEX ix_cards_nid on cards (nid);
      CREATE INDEX ix_cards_sched on cards (did, queue, due);
      CREATE INDEX ix_revlog_cid on revlog (cid);
      CREATE INDEX ix_notes_csum on notes (csum);
    `);
    db.prepare("INSERT INTO col VALUES (1, ?, ?, ?, 11, 0, 0, 0, ?, ?, ?, ?, '{}')").run(
      Math.floor(crtDayStart / 1000), now, now, JSON.stringify(conf), JSON.stringify({ [EXPORT_MODEL_ID]: model }),
      JSON.stringify({ 1: deck(1, "Default"), [deckId]: deck(deckId, deckName) }), JSON.stringify(dconf),
    );
    const insertNote = db.prepare("INSERT INTO notes VALUES (?, ?, ?, ?, -1, ?, ?, ?, ?, 0, '')");
    const insertCard = db.prepare("INSERT INTO cards VALUES (?, ?, ?, 0, ?, -1, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, '')");
    db.exec("BEGIN");
    list.forEach((card, index) => {
      const noteId = now + index;
      const fields = exportFields(card);
      const schedule = ankiScheduleFor(card, crtDayStart, now, index + 1);
      insertNote.run(noteId, card.anki?.guid || stableGuid(card.id || card.itemKey || fields[0]), EXPORT_MODEL_ID, nowSeconds, ` ${tagsFor(card).join(" ")} `, fields.join(FIELD_SEPARATOR), htmlToText(fields[0]), sortFieldChecksum(fields[0]));
      insertCard.run(noteId, noteId, deckId, nowSeconds, schedule.type, schedule.queue, schedule.due, schedule.ivl, schedule.factor, schedule.reps, schedule.lapses, schedule.left);
    });
    db.exec("COMMIT");
    db.close();
    const zip = new AdmZip();
    zip.addFile("collection.anki2", fs.readFileSync(file));
    zip.addFile("media", Buffer.from("{}"));
    return zip.toBuffer();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

// Anki "Notes in Plain Text" with header directives: File > Import in Anki picks these up.
export function buildAnkiText(cards, { deckName = "LVL" } = {}) {
  const quote = (value) => (/[\t"\n\r]/.test(value) ? `"${value.replace(/"/g, "\"\"")}"` : value);
  const rows = (Array.isArray(cards) ? cards : []).filter((card) => String(card?.front || "").trim()).map((card) => {
    const [front, back, reading, sentence, translation, source] = exportFields(card);
    const answer = [back, reading && `<div>${reading}</div>`, sentence && `<div>${sentence}</div>`, translation && `<div>${translation}</div>`, source && `<div><small>${source}</small></div>`].filter(Boolean).join("");
    return [card.anki?.guid || stableGuid(card.id || card.itemKey || front), front, answer, tagsFor(card).join(" ")].map(quote).join("\t");
  });
  return `#separator:tab\n#html:true\n#guid column:1\n#notetype:Basic\n#deck:${deckName}\n#tags column:4\n${rows.join("\n")}\n`;
}
