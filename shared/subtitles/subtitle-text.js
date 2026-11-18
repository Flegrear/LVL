// Browser textTrack displays WebVTT entities as characters. The custom player
// stores plain text for captions/cards; decode only standard VTT text entities
// after stripping real markup, never interpret decoded text as HTML.
const VTT_TEXT_ENTITIES = Object.freeze({
  amp: "&", lt: "<", gt: ">", nbsp: "\u00a0", lrm: "\u200e", rlm: "\u200f",
});

function decodeVttTextEntities(text) {
  return String(text).replace(/&(amp|lt|gt|nbsp|lrm|rlm);/gi,
    (encoded, name) => VTT_TEXT_ENTITIES[name.toLowerCase()] ?? encoded);
}

export function parseTimestamp(value) {
  const parts = String(value ?? "").trim().replace(",", ".").split(":");
  if (parts.length < 1 || parts.length > 3
    || !parts.slice(0, -1).every((part) => /^\d+$/.test(part))
    || !/^\d+(?:\.\d{1,3})?$/.test(parts.at(-1))) return NaN;
  const numbers = parts.map(Number);
  if (numbers.some((number) => !Number.isFinite(number))
    || (parts.length > 1 && numbers.at(-1) >= 60)
    || (parts.length === 3 && numbers[1] >= 60)) return NaN;
  const seconds = numbers.reduce((total, part) => total * 60 + part, 0);
  const milliseconds = seconds * 1000;
  return Number.isSafeInteger(Math.round(milliseconds)) ? Math.round(milliseconds) : NaN;
}

export function parseSubtitle(text, trackId = "track") {
  const cleaned = String(text ?? "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
  const isVtt = /^WEBVTT/i.test(cleaned);
  const body = isVtt ? cleaned.replace(/^WEBVTT[^\n]*(?:\n+|$)/, "") : cleaned;
  const blocks = body.split(/\n{2,}/);
  const cues = [];

  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trimEnd());
    if (!lines.length) continue;
    // NOTE/STYLE/REGION are metadata, not caption text even when they
    // contain an arrow; accept only a complete timestamp arrow line.
    if (/^(?:NOTE|STYLE|REGION)(?:\s|$)/i.test(lines[0].trim())) continue;
    const timing = /^\s*([\d:.,]+)\s+-->\s+([\d:.,]+)(?:\s+.*)?$/;
    const timingIndex = lines.findIndex((line) => timing.test(line));
    if (timingIndex < 0) continue;
    const [, startRaw, endRaw] = timing.exec(lines[timingIndex]);
    const startMs = parseTimestamp(startRaw), endMs = parseTimestamp(endRaw);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
    // HTML tags and ASS override blocks ({\an8}, {\i1}) are styling, not dialogue.
    const cueText = decodeVttTextEntities(lines.slice(timingIndex + 1).join("\n")
      .replace(/<[^>]+>/g, "").replace(/\{\\[^}]*\}/g, ""))
      .replace(/[^\S\n]+/g, " ").trim();
    if (!cueText) continue;
    cues.push({
      id: `${trackId}-${cues.length + 1}`,
      trackId,
      startMs,
      endMs,
      text: cueText,
      normalizedText: normalizeText(cueText),
    });
  }

  return cues;
}

export function normalizeText(text) {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[“”‘’]/g, "'")
    .replace(/[^\p{L}\p{N}'\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function formatTime(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
