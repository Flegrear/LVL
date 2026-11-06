export function parseTimestamp(value) {
  const normalized = value.trim().replace(",", ".");
  const parts = normalized.split(":").map(Number);
  if (parts.some(Number.isNaN)) return 0;
  if (parts.length === 3) return ((parts[0] * 60 + parts[1]) * 60 + parts[2]) * 1000;
  if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
  return parts[0] * 1000;
}

export function parseSubtitle(text, trackId = "track") {
  const cleaned = text.replace(/^\uFEFF/, "").replace(/\r/g, "").trim();
  const isVtt = /^WEBVTT/i.test(cleaned);
  const body = isVtt ? cleaned.replace(/^WEBVTT[^\n]*\n+/, "") : cleaned;
  const blocks = body.split(/\n{2,}/);
  const cues = [];

  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trimEnd()).filter(Boolean);
    if (!lines.length) continue;
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) continue;
    const [startRaw, endRawWithSettings] = lines[timingIndex].split("-->");
    if (!startRaw || !endRawWithSettings) continue;
    const endRaw = endRawWithSettings.trim().split(/\s+/)[0];
    // HTML tags and ASS override blocks ({\an8}, {\i1}) are styling, not dialogue.
    const cueText = lines.slice(timingIndex + 1).join(" ").replace(/<[^>]+>/g, "").replace(/\{\\[^}]*\}/g, "").replace(/\s{2,}/g, " ").trim();
    if (!cueText) continue;
    cues.push({
      id: `${trackId}-${cues.length + 1}`,
      trackId,
      startMs: parseTimestamp(startRaw),
      endMs: parseTimestamp(endRaw),
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
