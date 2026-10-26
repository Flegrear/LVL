import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import AdmZip from "adm-zip";
import { buildAnkiPackage, buildAnkiText, htmlToText, readAnkiPackage, readAnkiText } from "../learning/anki/anki.js";
import { dayStartMs } from "../learning/browser/review-scheduler.js";

const DAY = 86_400_000;
const NOW = new Date(2026, 5, 10, 15, 0).getTime();

test("HTML fields become plain text: breaks, entities, furigana, sound tags", () => {
  assert.equal(htmlToText("日本語[にほんご]を<b>勉強</b>します<br>[sound:a.mp3]&amp; more&nbsp;text"), "日本語を勉強します\n& more text");
  assert.equal(htmlToText("<div>One</div><div>Two</div>"), "One\nTwo");
  assert.equal(htmlToText("<style>.x{}</style>&#x732B;&#29356;"), "猫犬");
});

test("an exported .apkg imports back with its text and schedule", () => {
  const today = dayStartMs(NOW);
  const cards = [
    { id: "a", type: "word", front: "猫", romanized: "neko", back: "My cat is asleep.", baseContext: "My cat is asleep.", context: "私の猫は寝ている。", sourceTag: "Show · S01E02", timestampMs: 83_000,
      state: "review", intervalDays: 12, ease: 2.35, dueAt: today + 3 * DAY, reviewCount: 6, lapses: 1, targetLanguage: "JA" },
    { id: "b", type: "phrase", front: "行こう", back: "Let's go", state: "learning", learningStep: 1, ease: 2.5, dueAt: NOW + 10 * 60_000, reviewCount: 1 },
    { id: "c", type: "word", front: "犬", back: "dog", state: "new" },
    { id: "d", type: "word", front: "鳥", back: "bird", state: "review", intervalDays: 30, ease: 2.5, dueAt: today - 2 * DAY, reviewCount: 4, suspended: true },
  ];
  const buffer = buildAnkiPackage(cards, { deckName: "LVL::JA", now: NOW });
  assert.ok(new AdmZip(buffer).getEntry("collection.anki2"), "legacy collection every Anki version imports");
  const { cards: imported, format } = readAnkiPackage(buffer, { now: NOW });
  assert.equal(format, "anki2");
  assert.equal(imported.length, 4);
  const byFront = Object.fromEntries(imported.map((card) => [card.front, card]));
  assert.equal(byFront["猫"].reading, "neko");
  assert.equal(byFront["猫"].sentence, "私の猫は寝ている。");
  assert.equal(byFront["猫"].translation, "My cat is asleep.");
  assert.equal(byFront["猫"].deck, "LVL::JA");
  assert.ok(byFront["猫"].tags.includes("lang::ja"));
  assert.equal(byFront["猫"].state, "review");
  assert.equal(byFront["猫"].intervalDays, 12);
  assert.equal(byFront["猫"].ease, 2.35);
  assert.equal(byFront["猫"].dueAt, today + 3 * DAY);
  assert.equal(byFront["猫"].reviewCount, 6);
  assert.equal(byFront["猫"].lapses, 1);
  assert.equal(byFront["行こう"].state, "learning");
  assert.equal(byFront["行こう"].learningStep, 1);
  assert.ok(Math.abs(byFront["行こう"].dueAt - (NOW + 10 * 60_000)) < 1000);
  assert.equal(byFront["犬"].state, "new");
  assert.equal(byFront["鳥"].suspended, true);
  assert.equal(byFront["鳥"].dueAt, today - 2 * DAY, "overdue reviews stay overdue");
  const again = readAnkiPackage(buildAnkiPackage(cards, { now: NOW }), { now: NOW });
  assert.deepEqual(again.cards.map((card) => card.guid), imported.map((card) => card.guid), "note ids are stable, so re-importing into Anki updates notes");
});

// A package as Anki 2.1.50+ writes it: zstd collection with the table-based schema.
function modernPackage() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lvl-anki-test-"));
  const file = path.join(directory, "c.db");
  const db = new DatabaseSync(file);
  const pb = (fields) => Buffer.concat(fields.map(([number, value]) => {
    if (typeof value === "number") return Buffer.from([(number << 3) | 0, value]);
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([Buffer.from([(number << 3) | 2, bytes.length]), bytes]);
  }));
  db.exec(`CREATE TABLE col (id integer primary key, crt integer, mod integer, scm integer, ver integer, dty integer, usn integer, ls integer, conf text, models text, decks text, dconf text, tags text);
    CREATE TABLE notetypes (id integer primary key, name text, mtime_secs integer, usn integer, config blob);
    CREATE TABLE fields (ntid integer, ord integer, name text, config blob);
    CREATE TABLE templates (ntid integer, ord integer, name text, mtime_secs integer, usn integer, config blob);
    CREATE TABLE decks (id integer primary key, name text, mtime_secs integer, usn integer, common blob, kind blob);
    CREATE TABLE notes (id integer primary key, guid text, mid integer, mod integer, usn integer, tags text, flds text, sfld text, csum integer, flags integer, data text);
    CREATE TABLE cards (id integer primary key, nid integer, did integer, ord integer, mod integer, usn integer, type integer, queue integer, due integer, ivl integer, factor integer, reps integer, lapses integer, left integer, odue integer, odid integer, flags integer, data text);`);
  const crt = Math.floor(dayStartMs(NOW - 100 * DAY) / 1000);
  db.prepare("INSERT INTO col VALUES (1, ?, 0, 0, 18, 0, 0, 0, '', '', '', '', '')").run(crt);
  db.prepare("INSERT INTO notetypes VALUES (10, 'Basic (and reversed card)', 0, 0, ?)").run(pb([[1, 0]]));
  db.prepare("INSERT INTO notetypes VALUES (11, 'Cloze', 0, 0, ?)").run(pb([[1, 1]]));
  for (const [ntid, ord, name] of [[10, 0, "Front"], [10, 1, "Back"], [11, 0, "Text"], [11, 1, "Back Extra"]]) db.prepare("INSERT INTO fields VALUES (?, ?, ?, x'')").run(ntid, ord, name);
  db.prepare("INSERT INTO templates VALUES (10, 0, 'Card 1', 0, 0, ?)").run(pb([[1, "{{Front}}"], [2, "{{FrontSide}}<hr id=answer>{{Back}}"]]));
  db.prepare("INSERT INTO templates VALUES (10, 1, 'Card 2', 0, 0, ?)").run(pb([[1, "{{Back}}"], [2, "{{FrontSide}}<hr id=answer>{{Front}}"]]));
  db.prepare("INSERT INTO templates VALUES (11, 0, 'Cloze', 0, 0, ?)").run(pb([[1, "{{cloze:Text}}"], [2, "{{cloze:Text}}<br>{{Back Extra}}"]]));
  db.prepare("INSERT INTO decks VALUES (20, ?, 0, 0, x'', x'')").run("Japanese\x1fCore 2k");
  db.prepare("INSERT INTO notes VALUES (100, 'g1', 10, 0, 0, ' vocab ', ?, '', 0, 0, '')").run("水\x1fwater");
  db.prepare("INSERT INTO notes VALUES (101, 'g2', 11, 0, 0, '', ?, '', 0, 0, '')").run("{{c1::Paris::city}} is in {{c2::France}}\x1fGeography");
  // Forward card in review (due in 5 days, 20-day interval), reverse card new, cloze cards.
  db.prepare("INSERT INTO cards VALUES (1000, 100, 20, 0, 0, 0, 2, 2, ?, 20, 2650, 9, 2, 0, 0, 0, 0, '')").run(105);
  db.prepare("INSERT INTO cards VALUES (1001, 100, 20, 1, 0, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0, 0, '')").run();
  db.prepare("INSERT INTO cards VALUES (1002, 101, 20, 0, 0, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, '')").run();
  db.prepare("INSERT INTO cards VALUES (1003, 101, 20, 1, 0, 0, 0, -1, 9, 0, 0, 0, 0, 0, 0, 0, 0, '')").run();
  db.close();
  const zip = new AdmZip();
  zip.addFile("collection.anki21b", zlib.zstdCompressSync(fs.readFileSync(file)));
  zip.addFile("collection.anki2", Buffer.from("dummy"));
  fs.rmSync(directory, { recursive: true, force: true });
  return zip.toBuffer();
}

test("a modern Anki package (zstd, table schema) imports every card type", () => {
  const { cards, format } = readAnkiPackage(modernPackage(), { now: NOW });
  assert.equal(format, "anki21b");
  assert.equal(cards.length, 4);
  const [forward, reverse, cloze1, cloze2] = cards;
  assert.deepEqual([forward.front, forward.back], ["水", "water"]);
  assert.deepEqual([reverse.front, reverse.back], ["water", "水"], "the reverse template swaps the sides");
  assert.equal(forward.deck, "Japanese::Core 2k");
  assert.deepEqual(forward.tags, ["vocab"]);
  assert.equal(forward.state, "review");
  assert.equal(forward.intervalDays, 20);
  assert.equal(forward.ease, 2.65);
  assert.equal(forward.dueAt, dayStartMs(NOW + 5 * DAY), "review due is counted in days from the collection's creation");
  assert.equal(reverse.state, "new");
  assert.equal(cloze1.front, "[city] is in France");
  assert.equal(cloze1.back, "[Paris] is in France\nGeography");
  assert.equal(cloze2.front, "Paris is in [...]".replace("...", "…"));
  assert.equal(cloze2.suspended, true);
});

test("Anki's plain-text export imports, with its header directives and quoting", () => {
  const text = "#separator:tab\n#html:true\n#guid column:1\n#deck column:2\n#tags column:5\nabc\tJapanese\t猫\t\"a <b>cat</b>\ttoo\"\tanimals n5\nxyz\tJapanese\t犬\tdog\t\n";
  const { cards } = readAnkiText(text, { now: NOW });
  assert.equal(cards.length, 2);
  assert.deepEqual([cards[0].guid, cards[0].deck, cards[0].front, cards[0].back], ["abc", "Japanese", "猫", "a cat\ttoo"]);
  assert.deepEqual(cards[0].tags, ["animals", "n5"]);
  assert.equal(cards[1].back, "dog");
  const plain = readAnkiText("hello,hola\nbye,adiós\n", { now: NOW }).cards;
  assert.deepEqual(plain.map((card) => [card.front, card.back]), [["hello", "hola"], ["bye", "adiós"]], "a header-less CSV works too");
  const exported = buildAnkiText([{ id: "a", front: "猫", back: "cat", context: "猫がいる", targetLanguage: "JA" }]);
  assert.match(exported, /^#separator:tab\n#html:true\n#guid column:1\n#notetype:Basic\n/);
  const roundTrip = readAnkiText(exported, { now: NOW }).cards;
  assert.equal(roundTrip[0].front, "猫");
  assert.match(roundTrip[0].back, /cat/);
});
