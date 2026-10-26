import test from "node:test";
import assert from "node:assert/strict";
import { presetDeck } from "../learning/preset-decks.js";

test("Top 100 contains 100 common words with meanings, independently of video vocabulary", async () => {
  for (const language of ["EN", "JA"]) {
    const { meta, collection } = await presetDeck({ language, size: 100, now: 1 });
    assert.equal(collection.cards.length, 100);
    assert.equal(collection.notes.length, 100);
    assert.equal(new Set(collection.notes.map((note) => note.guid)).size, 100);
    assert.equal(meta.extra.version, 2);
  }
});

test("preset cards show romanization on the question and keep one primary meaning", async () => {
  const { collection } = await presetDeck({ language: "JA", size: 100, romanize: async (text) => `romaji:${text}` });
  assert.match(collection.notetypes[0].templates[0].qfmt, /Reading/);
  assert.match(collection.cards[0].reading, /^romaji:/);
  assert.equal(collection.cards[0].back, "what");
  assert.doesNotMatch(collection.notetypes[0].css, /text-transform:\s*uppercase/);
});

test("reported English meanings are corrected before creating Anki notes", async () => {
  const { collection } = await presetDeck({ language: "EN", size: 100 });
  const cards = new Map(collection.cards.map((card) => [card.front, card.back]));
  assert.equal(cards.get("do"), "hacer");
  assert.equal(cards.get("did"), "hacer");
  assert.equal(cards.get("me"), "yo");
  assert.equal(cards.get("can"), "poder");
  assert.equal(cards.get("are"), "ser");
});

test("inflected vocabulary is romanized from its displayed form", async () => {
  const { collection } = await presetDeck({ language: "KO", size: 100, romanize: async (text) => text });
  const card = collection.cards.find((item) => item.front === "내가");
  assert.equal(card.reading, "내가");
});
