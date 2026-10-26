// anki-store.js: Anki decks kept by the app. Note types (fields, templates, CSS), notes and the
// media list live in the project database; media files live in <data>/anki-media/<deck>/. Cards'
// schedules stay with the app's other cards (the "cards" state section); a card points at its deck
// and note, and is rendered on demand with anki-render.js, so it looks the way the deck's author
// made it. Node only (server.js).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ankiCardText } from "./anki.js";
import { renderAnkiCard } from "./anki-render.js";

const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MEDIA_TYPES = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".bmp": "image/bmp", ".avif": "image/avif",
  ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".oga": "audio/ogg", ".opus": "audio/ogg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".aac": "audio/aac", ".flac": "audio/flac", ".spx": "audio/ogg",
  ".mp4": "video/mp4", ".webm": "video/webm", ".ogv": "video/ogg",
  ".ttf": "font/ttf", ".otf": "font/otf", ".woff": "font/woff", ".woff2": "font/woff2",
  ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
};

export function isSafeDeckId(value) {
  return SAFE_ID.test(String(value || ""));
}

export function mediaType(name) {
  return MEDIA_TYPES[path.extname(String(name || "")).toLowerCase()] || "application/octet-stream";
}

export function createAnkiStore({ db, mediaRoot }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS anki_decks (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, source TEXT NOT NULL, shared_id TEXT, description TEXT,
      language TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      notes INTEGER NOT NULL DEFAULT 0, cards INTEGER NOT NULL DEFAULT 0, media INTEGER NOT NULL DEFAULT 0,
      media_bytes INTEGER NOT NULL DEFAULT 0, extra_json TEXT
    );
    CREATE TABLE IF NOT EXISTS anki_notetypes (
      deck_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
      fields_json TEXT NOT NULL, templates_json TEXT NOT NULL, css TEXT NOT NULL,
      PRIMARY KEY (deck_id, id)
    );
    CREATE TABLE IF NOT EXISTS anki_notes (
      deck_id TEXT NOT NULL, id TEXT NOT NULL, notetype_id TEXT NOT NULL, guid TEXT NOT NULL,
      fields_json TEXT NOT NULL, tags TEXT NOT NULL,
      PRIMARY KEY (deck_id, id)
    );
    CREATE TABLE IF NOT EXISTS anki_media (
      deck_id TEXT NOT NULL, name TEXT NOT NULL, file TEXT NOT NULL, bytes INTEGER NOT NULL,
      PRIMARY KEY (deck_id, name)
    );
  `);
  fs.mkdirSync(mediaRoot, { recursive: true });

  const statements = {
    deck: db.prepare("SELECT * FROM anki_decks WHERE id = ?"),
    decks: db.prepare("SELECT * FROM anki_decks ORDER BY updated_at DESC"),
    notetype: db.prepare("SELECT * FROM anki_notetypes WHERE deck_id = ? AND id = ?"),
    note: db.prepare("SELECT * FROM anki_notes WHERE deck_id = ? AND id = ?"),
    media: db.prepare("SELECT file, bytes FROM anki_media WHERE deck_id = ? AND name = ?"),
    upsertDeck: db.prepare(`INSERT INTO anki_decks (id, name, source, shared_id, description, language, created_at, updated_at, notes, cards, media, media_bytes, extra_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, source = excluded.source, shared_id = excluded.shared_id, description = excluded.description,
        language = excluded.language, updated_at = excluded.updated_at, notes = excluded.notes, cards = excluded.cards, media = excluded.media,
        media_bytes = excluded.media_bytes, extra_json = excluded.extra_json`),
    upsertNotetype: db.prepare(`INSERT INTO anki_notetypes (deck_id, id, name, kind, fields_json, templates_json, css) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(deck_id, id) DO UPDATE SET name = excluded.name, kind = excluded.kind, fields_json = excluded.fields_json, templates_json = excluded.templates_json, css = excluded.css`),
    upsertNote: db.prepare(`INSERT INTO anki_notes (deck_id, id, notetype_id, guid, fields_json, tags) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(deck_id, id) DO UPDATE SET notetype_id = excluded.notetype_id, guid = excluded.guid, fields_json = excluded.fields_json, tags = excluded.tags`),
    upsertMedia: db.prepare(`INSERT INTO anki_media (deck_id, name, file, bytes) VALUES (?, ?, ?, ?)
      ON CONFLICT(deck_id, name) DO UPDATE SET file = excluded.file, bytes = excluded.bytes`),
    countNotes: db.prepare("SELECT COUNT(*) AS count FROM anki_notes WHERE deck_id = ?"),
    countMedia: db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes FROM anki_media WHERE deck_id = ?"),
    deleteDeck: db.prepare("DELETE FROM anki_decks WHERE id = ?"),
    deleteNotetypes: db.prepare("DELETE FROM anki_notetypes WHERE deck_id = ?"),
    deleteNotes: db.prepare("DELETE FROM anki_notes WHERE deck_id = ?"),
    deleteMedia: db.prepare("DELETE FROM anki_media WHERE deck_id = ?"),
  };

  const deckDirectory = (deckId) => path.join(mediaRoot, deckId);
  const summary = (row) => (row ? {
    id: row.id,
    name: row.name,
    source: row.source,
    sharedId: row.shared_id || null,
    description: row.description || "",
    language: row.language || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    notes: row.notes,
    cards: row.cards,
    media: row.media,
    mediaBytes: row.media_bytes,
    ...(row.extra_json ? { extra: JSON.parse(row.extra_json) } : {}),
  } : null);

  function transaction(work) {
    db.exec("BEGIN");
    try {
      const value = work();
      db.exec("COMMIT");
      return value;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Stores a deck. collection: { notetypes: [{ id, name, cloze|kind, fields, templates, css }],
   * notes: [{ id, guid, mid, tags, fields }], cards: [{ cardId, noteId, ord, deck, ...schedule }],
   * media: [{ name, read() }] }. replace: drop what the deck held before (a fresh import).
   * Returns { deck, cards } with cards as records for the app's card list.
   */
  function saveDeck(meta, collection, { replace = true } = {}) {
    const deckId = isSafeDeckId(meta.id) ? meta.id : `deck-${crypto.randomUUID().slice(0, 12)}`;
    const directory = deckDirectory(deckId);
    const now = Date.now();
    if (replace) fs.rmSync(directory, { recursive: true, force: true });
    fs.mkdirSync(directory, { recursive: true });
    // Media first (outside the transaction: file writes), then the rows in one transaction.
    const mediaRows = [];
    for (const item of collection.media || []) {
      const data = item.read?.() ?? item.data;
      if (!data) continue;
      const file = `${crypto.createHash("sha1").update(item.name).digest("hex").slice(0, 20)}${path.extname(item.name).toLowerCase().slice(0, 8).replace(/[^.a-z0-9]/g, "")}`;
      fs.writeFileSync(path.join(directory, file), data);
      mediaRows.push([item.name, file, data.length]);
    }
    const noteMap = new Map((collection.notes || []).map((note) => [String(note.id), note]));
    const typeMap = new Map((collection.notetypes || []).map((type) => [String(type.id), type]));
    transaction(() => {
      if (replace) {
        statements.deleteNotetypes.run(deckId);
        statements.deleteNotes.run(deckId);
        statements.deleteMedia.run(deckId);
      }
      for (const type of typeMap.values()) {
        statements.upsertNotetype.run(deckId, String(type.id), String(type.name || "Note"), type.kind === "cloze" || type.cloze ? "cloze" : "normal",
          JSON.stringify(type.fields || []), JSON.stringify((type.templates || []).map(({ name, qfmt, afmt }) => ({ name, qfmt, afmt }))), String(type.css || ""));
      }
      for (const note of noteMap.values()) {
        statements.upsertNote.run(deckId, String(note.id), String(note.mid), String(note.guid || note.id), JSON.stringify(note.fields || []), (note.tags || []).join(" "));
      }
      for (const row of mediaRows) statements.upsertMedia.run(deckId, ...row);
      const existing = statements.deck.get(deckId);
      const noteCount = statements.countNotes.get(deckId).count;
      const media = statements.countMedia.get(deckId);
      const cardTotal = Number.isFinite(Number(meta.cards)) ? Number(meta.cards) : (collection.cards || []).length;
      statements.upsertDeck.run(deckId, String(meta.name || "Deck").slice(0, 200), String(meta.source || "import"), meta.sharedId ? String(meta.sharedId) : null,
        String(meta.description || "").slice(0, 4000), String(meta.language || ""), Number(existing?.created_at) || now, now, noteCount, cardTotal,
        media.count, media.bytes, meta.extra ? JSON.stringify(meta.extra) : existing?.extra_json || null);
    });
    const deck = summary(statements.deck.get(deckId));
    const cards = (collection.cards || []).map((card) => {
      const note = noteMap.get(String(card.noteId));
      const type = typeMap.get(String(note?.mid));
      const text = card.front !== undefined ? {} : note && type ? ankiCardText(note, { ...type, cloze: type.kind === "cloze" || type.cloze }, card.ord) : { front: "", back: "" };
      return {
        ...card,
        deckId,
        deckName: deck.name,
        guid: note?.guid || card.noteId,
        notetype: type?.name || "Note",
        tags: note?.tags || [],
        front: String(card.front ?? text.front ?? "").slice(0, 600),
        back: String(card.back ?? text.back ?? "").slice(0, 1200),
        reading: String(card.reading || text.reading || ""),
        sentence: String(text.sentence || ""),
        translation: String(text.translation || ""),
      };
    }).filter((card) => card.front || card.back);
    return { deck, cards };
  }

  function listDecks() {
    return statements.decks.all().map(summary);
  }

  function getDeck(deckId) {
    return isSafeDeckId(deckId) ? summary(statements.deck.get(deckId)) : null;
  }

  function deleteDeck(deckId) {
    if (!isSafeDeckId(deckId)) return false;
    transaction(() => {
      statements.deleteNotetypes.run(deckId);
      statements.deleteNotes.run(deckId);
      statements.deleteMedia.run(deckId);
      statements.deleteDeck.run(deckId);
    });
    fs.rmSync(deckDirectory(deckId), { recursive: true, force: true });
    return true;
  }

  function mediaFile(deckId, name) {
    if (!isSafeDeckId(deckId)) return null;
    const row = statements.media.get(deckId, String(name || ""));
    if (!row) return null;
    const file = path.join(deckDirectory(deckId), row.file);
    return fs.existsSync(file) ? { file, bytes: row.bytes, type: mediaType(name) } : null;
  }

  function mediaUrlFor(deckId) {
    return (name) => `/api/anki/media/${deckId}/${encodeURIComponent(String(name).trim())}`;
  }

  function render(deckId, noteId, ord, { deckName = "" } = {}) {
    if (!isSafeDeckId(deckId)) return null;
    const noteRow = statements.note.get(deckId, String(noteId));
    if (!noteRow) return null;
    const typeRow = statements.notetype.get(deckId, noteRow.notetype_id);
    if (!typeRow) return null;
    const notetype = { name: typeRow.name, kind: typeRow.kind, fields: JSON.parse(typeRow.fields_json), templates: JSON.parse(typeRow.templates_json), css: typeRow.css };
    const note = { fields: JSON.parse(noteRow.fields_json), tags: noteRow.tags ? noteRow.tags.split(" ").filter(Boolean) : [] };
    const deck = statements.deck.get(deckId);
    return renderAnkiCard({ notetype, note, ord: Number(ord) || 0, deckName: deckName || deck?.name || "", mediaUrl: mediaUrlFor(deckId) });
  }

  return { saveDeck, listDecks, getDeck, deleteDeck, mediaFile, render };
}
