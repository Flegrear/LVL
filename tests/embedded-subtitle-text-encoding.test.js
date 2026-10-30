import test from "node:test";
import assert from "node:assert/strict";
import { decodeSubtitleBytes } from "../shared/subtitles/subtitle-text-encoding.js";

test("UTF-8 and BOM-marked UTF-16 decode without guessing the subtitle language", () => {
  const utf8 = new TextEncoder().encode("WEBVTT\n日本語 — español");
  assert.deepEqual(decodeSubtitleBytes(utf8), {
    text: "WEBVTT\n日本語 — español", encoding: "utf-8", needsEncoding: false,
  });
  assert.equal(decodeSubtitleBytes(Uint8Array.of(0xef, 0xbb, 0xbf, ...utf8)).text, "WEBVTT\n日本語 — español");
  assert.equal(decodeSubtitleBytes(Uint8Array.of(0xff, 0xfe, 0x41, 0, 0x42, 0)).text, "AB");
  assert.equal(decodeSubtitleBytes(Uint8Array.of(0xfe, 0xff, 0, 0x41, 0, 0x42)).text, "AB");
});

test("Shift-JIS, EUC-KR and GB18030 are decoded only when the charset is specified", () => {
  const fixtures = [
    ["shift_jis", Uint8Array.of(0x93, 0xfa, 0x96, 0x7b), "日本"],
    ["euc-kr", Uint8Array.of(0xb0, 0xa1), "가"],
    ["gb18030", Uint8Array.of(0xd6, 0xd0, 0xce, 0xc4), "中文"],
  ];
  for (const [encoding, bytes, expected] of fixtures) {
    assert.deepEqual(decodeSubtitleBytes(bytes), { text: null, encoding: null, needsEncoding: true });
    assert.equal(decodeSubtitleBytes(bytes, { encoding }).text, expected);
  }
});

test("missing BOM, invalid legacy encoding and invalid charset never enter tracks as mojibake", () => {
  assert.equal(decodeSubtitleBytes(Uint8Array.of(0x41, 0, 0x42, 0)).needsEncoding, true,
    "UTF-16 without a BOM must require explicit user selection");
  assert.equal(decodeSubtitleBytes(Uint8Array.of(0x41, 0, 0x42, 0), { encoding: "utf-16le" }).text, "AB");
  assert.throws(() => decodeSubtitleBytes(Uint8Array.of(0x80), { encoding: "utf-8" }), TypeError);
  assert.throws(() => decodeSubtitleBytes(Uint8Array.of(0x41), { encoding: "guess" }), RangeError);
});
