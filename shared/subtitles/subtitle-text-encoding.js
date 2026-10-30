// Decode external subtitle text conservatively. A language alone is never
// evidence of an encoding. Unsupported legacy files require an explicit
// user/provider charset so silent mojibake cannot enter the subtitle track.

const ENCODINGS = new Map([
  ["utf-8", "utf-8"], ["utf8", "utf-8"],
  ["utf-16le", "utf-16le"], ["utf-16be", "utf-16be"],
  ["shift_jis", "shift_jis"], ["shift-jis", "shift_jis"], ["sjis", "shift_jis"],
  ["euc-kr", "euc-kr"], ["gb18030", "gb18030"],
]);

function normalizeBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new TypeError("Subtitle data must be a byte array");
}

function bomEncoding(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  return null;
}

export function decodeSubtitleBytes(data, { encoding = null } = {}) {
  const bytes = normalizeBytes(data);
  const bom = bomEncoding(bytes);
  const charset = bom || (encoding === null || encoding === undefined
    ? "utf-8" : ENCODINGS.get(String(encoding).trim().toLowerCase()));
  if (!charset) throw new RangeError("Unsupported subtitle encoding");
  try {
    const text = new TextDecoder(charset, { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
    // UTF-16 without a BOM can appear to be valid UTF-8 because of its NUL
    // bytes. Require an explicit charset rather than importing broken text.
    if (!bom && !encoding && text.includes("\u0000"))
      return { text: null, encoding: null, needsEncoding: true };
    return { text, encoding: charset, needsEncoding: false };
  } catch (error) {
    if (error instanceof TypeError && !bom && !encoding)
      return { text: null, encoding: null, needsEncoding: true };
    throw error;
  }
}
