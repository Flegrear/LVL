import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { defaultEmbeddedSubtitleTrack } from "../frontend/player/embedded-subtitle-default.js";

const track = (index, language, title, disposition = {}) => ({
  streamIndex: index, language, title, textBased: true, disposition,
});
const normalize = (value) => ({ eng: "EN", jpn: "JA", spa: "ES" })[value] || value;
const pick = (tracks, languages = ["EN", "JA"]) => defaultEmbeddedSubtitleTrack({
  media: { subtitleTracks: tracks }, languages, normalizeLanguage: normalize,
});

test("an unflagged signs-and-songs stream cannot displace same-language dialogue", () => {
  assert.equal(pick([
    track(3, "eng", "English [Signs & Songs]", { default: 1 }),
    track(4, "eng", "English [Full]"),
  ]).streamIndex, 4);
  assert.equal(pick([
    track(9, "eng", "English OP/ED Lyrics", { default: 1 }),
    track(10, "eng", "English Main Dialogue"),
  ]).streamIndex, 10);
});

test("prefer dialogue in the next requested language over a preferred-language signs-only stream", () => {
  assert.equal(pick([
    track(1, "eng", "Signs/Songs", { forced: 1, default: 1 }),
    track(2, "jpn", "Japanese dialogue"),
  ]).streamIndex, 2);
  assert.equal(pick([
    track(1, "eng", "Signs/Songs", { forced: 1, default: 1 }),
    track(2, "jpn", "Japanese dialogue"),
  ], ["JA", "EN"]).streamIndex, 2);
});

test("only available signs track remains accessible; full dialogue and sign language are not misclassified", () => {
  assert.equal(pick([track(5, "eng", "Signs/Songs", { forced: 1 })]).streamIndex, 5);
  assert.equal(pick([
    track(5, "eng", "English Full + Signs/Songs", { default: 1 }),
    track(6, "eng", "English Main Dialogue"),
  ]).streamIndex, 5);
  assert.equal(pick([
    track(7, "eng", "English Sign Language", { default: 1 }),
    track(8, "eng", "English [Signs Only]"),
  ]).streamIndex, 7);
  assert.equal(pick([track(2, "eng", "Dialogue")], ["EN"]).streamIndex, 2);
});

test("caption-off, saved manual selection and image-based tracks still prevent automatic override", () => {
  const media = { subtitleTracks: [track(1, "eng", "Full Dialogue")] };
  assert.equal(defaultEmbeddedSubtitleTrack({ media, captionsEnabled: false }), null);
  assert.equal(defaultEmbeddedSubtitleTrack({ media, attached: [{ cues: [{ text: "manual" }] }] }), null);
  assert.equal(pick([{ ...track(1, "eng", "PGS"), textBased: false }]), null);
});

test("media metadata requests true default/forced stream disposition from FFprobe", () => {
  const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
  // The downstream subtitleTracks mapping cannot recover disposition bits
  // omitted by -show_entries, even if the selected MKV track marks forced=1.
  assert.match(server, /stream_disposition=default,forced/,
    "FFprobe must return forced/default flags for signs-only track avoidance");
});
