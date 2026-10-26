import test from "node:test";
import assert from "node:assert/strict";
import { clozeNumbers, fieldIsEmpty, furiganaHtml, renderAnkiCard, renderTemplate, rewriteMedia } from "../learning/anki/anki-render.js";

const mediaUrl = (name) => `/api/anki/media/deck-1/${encodeURIComponent(name)}`;

test("fields, sections and special fields render like Anki", () => {
  const fields = { Front: "犬", Reading: "", Back: "dog<br>", Notes: "<br><div></div>" };
  const html = renderTemplate("{{Front}}{{#Reading}}<i>{{Reading}}</i>{{/Reading}}{{^Reading}}<b>no reading</b>{{/Reading}}{{#Notes}}NOTES{{/Notes}} {{Deck}} {{Tags}}", fields, { special: { Deck: "Japanese::Animals", Tags: "n5 animal" } });
  assert.equal(html, "犬<b>no reading</b> Japanese::Animals n5 animal");
  assert.equal(fieldIsEmpty("<br><div> </div>&nbsp;"), true);
  assert.equal(fieldIsEmpty('<img src="a.jpg">'), false, "an image counts as content");
  assert.equal(renderTemplate("{{text:Back}}|{{ Front }}|{{Missing}}", fields), "dog|犬|");
});

test("furigana, kana, kanji and hint filters", () => {
  assert.equal(furiganaHtml("日本語[にほんご]を 勉強[べんきょう]"), "<ruby><rb>日本語</rb><rt>にほんご</rt></ruby>を<ruby><rb>勉強</rb><rt>べんきょう</rt></ruby>");
  assert.equal(furiganaHtml("[sound:a.mp3]"), "[sound:a.mp3]", "sound tags are not furigana");
  const fields = { Expression: "猫[ねこ]が 好[す]き" };
  assert.equal(renderTemplate("{{kana:Expression}}", fields), "ねこがすき");
  assert.equal(renderTemplate("{{kanji:Expression}}", fields), "猫が好き");
  const hint = renderTemplate("{{hint:Expression}}", fields);
  assert.match(hint, /<a class="hint" href="#" data-lvl-hint="hint\d+">Expression<\/a><div id="hint\d+" class="hint" style="display:none">猫\[ねこ\]が 好\[す\]き<\/div>/);
  assert.equal(renderTemplate("{{hint:Empty}}", { Empty: "" }), "");
});

test("cloze deletions: active, hinted and inactive, on both sides", () => {
  const notetype = { kind: "cloze", fields: ["Text", "Extra"], templates: [{ name: "Cloze", qfmt: "{{cloze:Text}}", afmt: "{{cloze:Text}}<br>{{Extra}}" }], css: ".cloze { color: blue; }" };
  const note = { fields: ["{{c1::Paris}} is the capital of {{c2::France::country}}.", "Geography"], tags: [] };
  assert.deepEqual(clozeNumbers(note.fields[0]), [1, 2]);
  const first = renderAnkiCard({ notetype, note, ord: 0, mediaUrl });
  assert.match(first.question, /<span class="cloze" data-ordinal="1">\[\.\.\.\]<\/span> is the capital of <span class="cloze-inactive" data-ordinal="2">France<\/span>/);
  assert.match(first.answer, /<span class="cloze" data-ordinal="1">Paris<\/span>/);
  const second = renderAnkiCard({ notetype, note, ord: 1, mediaUrl });
  assert.match(second.question, /\[country\]/);
  assert.equal(second.empty, false);
  assert.equal(renderAnkiCard({ notetype, note, ord: 4, mediaUrl }).empty, true, "no c5 in the note");
});

test("type answer: an input on the question, a comparison slot on the answer", () => {
  const notetype = { kind: "normal", fields: ["Front", "Back"], templates: [{ name: "Type", qfmt: "{{Front}}<br>{{type:Back}}", afmt: "{{FrontSide}}<hr id=answer>{{type:Back}}" }], css: "" };
  const card = renderAnkiCard({ notetype, note: { fields: ["gato", "<b>cat</b>"], tags: [] }, ord: 0, mediaUrl });
  assert.match(card.question, /<input type="text" id="typeans"/);
  assert.match(card.answer, /<div class="lvl-typeans-result" data-expected="cat"><\/div>/);
  assert.doesNotMatch(card.answer, /<input/, "the answer's FrontSide drops the input");
});

test("media: images, scripts, CSS urls and sounds point at the deck's media route", () => {
  const { html, sounds } = rewriteMedia('<img src="cat photo.jpg"><img src=\'dog.png\'><img src="https://example.com/x.png"><script src="_furigana.js"></script>[sound:hello world.mp3]<style>@font-face{src:url(_font.woff2)}</style>', mediaUrl);
  assert.match(html, /<img src="\/api\/anki\/media\/deck-1\/cat%20photo\.jpg">/);
  assert.match(html, /<img src="\/api\/anki\/media\/deck-1\/dog\.png">/);
  assert.match(html, /src="https:\/\/example\.com\/x\.png"/, "absolute URLs stay");
  assert.match(html, /<script src="\/api\/anki\/media\/deck-1\/_furigana\.js">/);
  assert.match(html, /url\("\/api\/anki\/media\/deck-1\/_font\.woff2"\)/);
  assert.match(html, /class="replay-button soundLink" href="#" data-lvl-sound="\/api\/anki\/media\/deck-1\/hello%20world\.mp3"/);
  assert.deepEqual(sounds, ["/api/anki/media/deck-1/hello%20world.mp3"]);
});

test("a whole card: CSS rewritten, answer plays only its own sounds, special fields filled", () => {
  const notetype = {
    kind: "normal",
    name: "Basic (audio)",
    fields: ["Word", "Audio", "Meaning", "Example audio"],
    templates: [{ name: "Recognition", qfmt: "{{Word}}{{Audio}}", afmt: "{{FrontSide}}<hr id=answer>{{Meaning}}{{Example audio}}<small>{{Card}} · {{Type}} · {{Subdeck}}</small>" }],
    css: ".card { background: url('_bg.png'); }",
  };
  const note = { fields: ["hola", "[sound:hola.mp3]", "hello", "[sound:ejemplo.mp3]"], tags: ["greeting"] };
  const card = renderAnkiCard({ notetype, note, ord: 0, deckName: "Spanish::Basics", mediaUrl });
  assert.equal(card.css, '.card { background: url("/api/anki/media/deck-1/_bg.png"); }');
  assert.deepEqual(card.questionSounds, ["/api/anki/media/deck-1/hola.mp3"]);
  assert.deepEqual(card.answerSounds, ["/api/anki/media/deck-1/ejemplo.mp3"]);
  assert.match(card.answer, /<small>Recognition · Basic \(audio\) · Basics<\/small>/);
  assert.equal(card.template, "Recognition");
});
