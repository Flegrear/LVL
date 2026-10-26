import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import AdmZip from "adm-zip";
import { readAnkiCollection } from "../learning/anki/anki.js";
import { createAnkiStore } from "../learning/anki/anki-store.js";
import { presetDeck } from "../learning/preset-decks.js";

function protobufField(number, value) {
  const varint = (input) => {
    const bytes = [];
    let rest = BigInt(input);
    do {
      let byte = Number(rest & 0x7fn);
      rest >>= 7n;
      if (rest) byte |= 0x80;
      bytes.push(byte);
    } while (rest);
    return Buffer.from(bytes);
  };
  if (typeof value === "number") return Buffer.concat([varint((number << 3) | 0), varint(value)]);
  const data = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
  return Buffer.concat([varint((number << 3) | 2), varint(data.length), data]);
}

// A small legacy-schema collection: one note type with CSS and media references, two notes.
function collectionFile() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lvl-anki-store-test-"));
  const file = path.join(directory, "collection.anki2");
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE col (id integer primary key, crt integer, mod integer, scm integer, ver integer, dty integer, usn integer, ls integer, conf text, models text, decks text, dconf text, tags text);
    CREATE TABLE notes (id integer primary key, guid text, mid integer, mod integer, usn integer, tags text, flds text, sfld text, csum integer, flags integer, data text);
    CREATE TABLE cards (id integer primary key, nid integer, did integer, ord integer, mod integer, usn integer, type integer, queue integer, due integer, ivl integer, factor integer, reps integer, lapses integer, left integer, odue integer, odid integer, flags integer, data text);
  `);
  const models = { 1700: {
    id: 1700, name: "Picture words", type: 0, css: ".card { font-family: 'Deck Font'; } @font-face { font-family: 'Deck Font'; src: url('_deck.woff2'); }",
    flds: [{ name: "Word", ord: 0 }, { name: "Picture", ord: 1 }, { name: "Meaning", ord: 2 }, { name: "Audio", ord: 3 }],
    tmpls: [{ name: "Word → meaning", ord: 0, qfmt: "<div class=word>{{Word}}</div>{{Picture}}{{Audio}}", afmt: "{{FrontSide}}<hr id=answer>{{Meaning}}" }],
  } };
  db.prepare("INSERT INTO col VALUES (1, 1600000000, 0, 0, 11, 0, 0, 0, '{}', ?, ?, '{}', '{}')").run(JSON.stringify(models), JSON.stringify({ 1: { name: "Default" }, 42: { name: "Picture Spanish::Animals" } }));
  const sep = "\x1f";
  db.prepare("INSERT INTO notes VALUES (10, 'guid-gato', 1700, 0, 0, ' animal ', ?, 'gato', 0, 0, '')").run(["gato", '<img src="gato.jpg">', "cat", "[sound:gato.mp3]"].join(sep));
  db.prepare("INSERT INTO notes VALUES (11, 'guid-perro', 1700, 0, 0, '', ?, 'perro', 0, 0, '')").run(["perro", "", "dog", ""].join(sep));
  db.prepare("INSERT INTO cards VALUES (100, 10, 42, 0, 0, 0, 2, 2, 30, 12, 2300, 5, 1, 0, 0, 0, 0, '')").run();
  db.prepare("INSERT INTO cards VALUES (101, 11, 42, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, '')").run();
  db.close();
  const bytes = fs.readFileSync(file);
  fs.rmSync(directory, { recursive: true, force: true });
  return bytes;
}

const MEDIA = { "gato.jpg": Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), "gato.mp3": Buffer.from("ID3-audio"), "_deck.woff2": Buffer.from("wOF2-font") };

function legacyPackage() {
  const zip = new AdmZip();
  zip.addFile("collection.anki2", collectionFile());
  zip.addFile("media", Buffer.from(JSON.stringify({ 0: "gato.jpg", 1: "gato.mp3", 2: "_deck.woff2" })));
  Object.values(MEDIA).forEach((data, index) => zip.addFile(String(index), data));
  return zip.toBuffer();
}

function modernPackage() {
  const zip = new AdmZip();
  zip.addFile("collection.anki21b", zlib.zstdCompressSync(collectionFile()));
  zip.addFile("meta", protobufField(1, 3));
  const list = Buffer.concat(Object.entries(MEDIA).map(([name, data]) => protobufField(1, Buffer.concat([protobufField(1, name), protobufField(2, data.length)]))));
  zip.addFile("media", zlib.zstdCompressSync(list));
  Object.values(MEDIA).forEach((data, index) => zip.addFile(String(index), zlib.zstdCompressSync(data)));
  return zip.toBuffer();
}

function temporaryStore() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lvl-anki-store-"));
  const db = new DatabaseSync(path.join(directory, "app.sqlite3"));
  const store = createAnkiStore({ db, mediaRoot: path.join(directory, "anki-media") });
  return { store, directory, close: () => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}

for (const [label, build] of [["legacy", legacyPackage], ["zstd (Anki 2.1.50+)", modernPackage]]) {
  test(`a ${label} package is stored with its templates, CSS and media, and renders like Anki`, () => {
    const collection = readAnkiCollection(build());
    assert.equal(collection.notetypes[0].css.includes("@font-face"), true);
    assert.deepEqual(collection.media.map((item) => item.name).sort(), ["_deck.woff2", "gato.jpg", "gato.mp3"]);
    const { store, close } = temporaryStore();
    try {
      const { deck, cards } = store.saveDeck({ id: "import-test", name: "Picture Spanish", source: "import" }, collection);
      assert.equal(deck.notes, 2);
      assert.equal(deck.media, 3);
      assert.equal(cards.length, 2);
      const gato = cards.find((card) => card.guid === "guid-gato");
      assert.equal(gato.front, "gato");
      assert.equal(gato.back, "cat");
      assert.equal(gato.state, "review");
      assert.equal(gato.intervalDays, 12);
      assert.equal(gato.deck, "Picture Spanish::Animals");
      const rendered = store.render("import-test", gato.noteId, 0);
      assert.match(rendered.question, /<img src="\/api\/anki\/media\/import-test\/gato\.jpg">/);
      assert.deepEqual(rendered.questionSounds, ["/api/anki/media/import-test/gato.mp3"]);
      assert.match(rendered.css, /url\("\/api\/anki\/media\/import-test\/_deck\.woff2"\)/);
      assert.match(rendered.answer, /<hr id=answer>cat/);
      const image = store.mediaFile("import-test", "gato.jpg");
      assert.deepEqual(fs.readFileSync(image.file), MEDIA["gato.jpg"]);
      assert.equal(image.type, "image/jpeg");
      assert.equal(store.mediaFile("import-test", "../app.sqlite3"), null);
      assert.equal(store.deleteDeck("import-test"), true);
      assert.equal(store.getDeck("import-test"), null);
      assert.equal(store.render("import-test", gato.noteId, 0), null);
      assert.equal(fs.existsSync(image.file), false);
    } finally {
      close();
    }
  });
}

test("a preset deck grows from Top 100 to Top 1,000 without losing notes", async () => {
  const { store, close } = temporaryStore();
  try {
    const small = await presetDeck({ language: "ES", languageName: "Spanish", size: 100 });
    const first = store.saveDeck(small.meta, small.collection, { replace: false });
    assert.equal(first.deck.id, "preset-words-es");
    assert.ok(first.cards.length >= 90 && first.cards.length <= 100, `${first.cards.length} cards`);
    const ser = first.cards.find((card) => card.front === "es");
    assert.ok(ser, "the word 'es' is in the Top 100");
    assert.match(ser.back, /\bbe\b/);
    const rendered = store.render("preset-words-es", ser.noteId, 0);
    assert.match(rendered.question, /class="lvl-word" lang="es">es</);
    assert.match(rendered.answer, /Dictionary form|lvl-lemma/);
    const large = await presetDeck({ language: "ES", languageName: "Spanish", size: 1000 });
    const second = store.saveDeck(large.meta, large.collection, { replace: false });
    assert.ok(second.deck.notes > first.deck.notes);
    assert.equal(second.deck.extra.size, 1000);
    assert.ok(store.render("preset-words-es", ser.noteId, 0), "earlier notes are still there");
  } finally {
    close();
  }
});
