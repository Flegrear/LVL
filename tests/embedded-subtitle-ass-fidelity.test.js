import test from "node:test";
import assert from "node:assert/strict";
import { assToWebVtt, parseAssDialogueEvents } from "../shared/subtitles/ass-events.js";
import { parseSubtitle } from "../learning/browser/core.js";

const ass = `[Script Info]
Title: Synthetic anime subtitles
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, Bold
Style: Default,Arial,30,&H00FFFFFF,0
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Hello, world!\\Nこんにちは
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Hello, world!\\Nこんにちは
Dialogue: 0,0:00:04.00,0:00:05.00,Sign,,0,0,0,,{\\pos(100,50)\\fs24}Station sign
Dialogue: 0,0:00:06.00,0:00:07.00,Default,,0,0,0,,{\\p1}m 0 0 l 12 8 9 14{\\p0}
Dialogue: 0,0:00:07.00,0:00:08.00,Default,,0,0,0,,{\\p1}m 0 0 l 10 10{\\p0}Spoken after drawing
Dialogue: 0,0:00:09.00,0:00:10.00,Karaoke,,0,0,0,,{\\k20}Sing{\\kf40} along
Dialogue: 0,0:00:11.00,0:00:12.00,Default,,0,0,0,,Ordinary punctuation, commas, 字幕テスト
`;

test("ASS parser preserves dialogue Unicode, commas and overlaps, while dropping only drawing coordinates", () => {
  const events = parseAssDialogueEvents(ass);
  assert.equal(events.length, 5, "duplicate dialogue merges and vector-only drawings disappear");
  assert.deepEqual(events.map(({ startMs, kind }) => [startMs, kind]), [
    [1000, "dialogue"], [4000, "sign"], [7000, "dialogue"], [9000, "sign"], [11000, "dialogue"],
  ]);
  assert.equal(events[0].text, "Hello, world!\nこんにちは");
  assert.equal(events[2].text, "Spoken after drawing");
  assert.equal(events[4].text, "Ordinary punctuation, commas, 字幕テスト");
  assert.equal(events[1].hasVisualEffects, true);
  assert.equal(events[3].hasVisualEffects, true);
  const vtt = assToWebVtt(ass);
  assert.match(vtt, /^WEBVTT\n\n/);
  assert.equal(parseSubtitle(vtt).length, 5, "visible sign captions remain available by default");
  assert.doesNotMatch(vtt, /m 0 0 l 12 8/);
});

test("sign events may be excluded from spoken-audio alignment without deleting source captions", () => {
  const dialogue = parseSubtitle(assToWebVtt(ass, { includeSigns: false }));
  assert.deepEqual(dialogue.map((cue) => cue.text), [
    "Hello, world! こんにちは", "Spoken after drawing", "Ordinary punctuation, commas, 字幕テスト",
  ]);
  const all = parseSubtitle(assToWebVtt(ass));
  assert.ok(all.some((cue) => cue.text.includes("Station sign")));
  assert.ok(all.some((cue) => cue.text.includes("Sing along")));
});

test("ASS parser supports custom event field order and SSA Marked field", () => {
  const source = `[Events]
Format: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: Marked=0,0:01:00.05,0:01:02.00,Dialogue,,0000,0000,0000,,After a minute
`;
  assert.deepEqual(parseAssDialogueEvents(source).map(({ startMs, text }) => [startMs, text]), [[60050, "After a minute"]]);
});

test("invalid ASS timings and a bounded event cap cannot yield unbounded text", () => {
  const events = parseAssDialogueEvents(ass, { maxEvents: 2 });
  assert.equal(events.length, 2);
  assert.deepEqual(parseAssDialogueEvents(ass, { maxEvents: 0 }), []);
  assert.equal(parseAssDialogueEvents("Dialogue: 0,0:99:99.00,0:99:99.50,Default,,0,0,0,,Broken").length, 0);
});
