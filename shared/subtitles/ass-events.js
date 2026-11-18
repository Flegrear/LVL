// Parse the text-bearing events of external ASS/SSA subtitles without treating
// vector drawings or anime signs as ordinary spoken dialogue. This is a
// bounded, plain-text conversion: libass positioning, fonts and effects are
// intentionally not claimed to survive WebVTT conversion.

const DEFAULT_EVENT_FIELDS = ["Layer", "Start", "End", "Style", "Name", "MarginL", "MarginR", "MarginV", "Effect", "Text"];
const MAX_ASS_EVENTS = 20_000;
const MAX_ASS_SOURCE_CHARS = 8_000_000;

function assTime(value) {
  const match = /^(\d{1,3}):(\d\d):(\d\d)\.(\d{1,2})$/.exec(String(value || "").trim());
  if (!match || Number(match[2]) > 59 || Number(match[3]) > 59) return null;
  return ((Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1000)
    + Number(match[4].padEnd(2, "0")) * 10;
}

function vttTime(ms) {
  const hours = Math.floor(ms / 3_600_000);
  const mins = Math.floor(ms / 60_000) % 60;
  const secs = Math.floor(ms / 1000) % 60;
  return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
}

// Extract natural text between ASS override blocks. \p1 drawings are vector
// coordinates, not human-readable captions. A later \p0 can resume dialogue.
function readAssText(raw) {
  let drawing = false;
  let signPosition = false;
  let karaoke = false;
  let containedDrawing = false;
  let text = "";
  for (const part of String(raw || "").matchAll(/\{([^}]*)\}|([^{}]+)/g)) {
    if (part[1] !== undefined) {
      const tags = part[1];
      if (!tags.includes("\\")) {
        // Ordinary braces are valid dialogue text; only backslash-prefixed
        // override tags should be removed from a plain-text conversion.
        if (!drawing) text += `{${tags}}`;
        continue;
      }
      for (const mode of tags.matchAll(/\\p\s*(\d+)/gi)) drawing = Number(mode[1]) > 0;
      if (/\\(?:pos|move|org)\s*\(/i.test(tags)) signPosition = true;
      if (/\\(?:k|kf|ko|kt)\s*\d+/i.test(tags)) karaoke = true;
    } else if (drawing) {
      containedDrawing = true;
    } else {
      text += part[2];
    }
  }
  text = text.replace(/\\[Nn]/g, "\n").replace(/\\h/gi, " ").trim();
  return { text, signPosition, karaoke, containedDrawing };
}

export function parseAssDialogueEvents(source, { maxEvents = MAX_ASS_EVENTS } = {}) {
  const limit = Number.isSafeInteger(maxEvents) ? Math.min(MAX_ASS_EVENTS, Math.max(0, maxEvents)) : MAX_ASS_EVENTS;
  if (!limit) return [];
  // Event count alone cannot bound a single adversarial dialogue or line.
  // Reject explicitly rather than silently accepting a truncated transcript.
  if (String(source ?? "").length > MAX_ASS_SOURCE_CHARS)
    throw new RangeError("ASS subtitle source exceeds the 8-million-character import limit");
  const result = [];
  const seen = new Set();
  let inEvents = false;
  let sawSection = false;
  let format = DEFAULT_EVENT_FIELDS;

  for (const line of String(source || "").replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const section = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (section) {
      sawSection = true;
      inEvents = /^events$/i.test(section[1]);
      continue;
    }
    if (sawSection && !inEvents) continue;
    const formatLine = /^\s*Format\s*:\s*(.*)$/i.exec(line);
    if (formatLine) {
      const fields = formatLine[1].split(",").map((field) => field.trim());
      // ASS permits reordered columns. Text may include commas; the other
      // schema-defined columns are delimited from the left/right so those
      // commas remain part of Text, including when it is not the last column.
      const names = fields.map((field) => field.toLowerCase());
      if (fields.length >= 4 && names.filter((field) => field === "text").length === 1
        && ["start", "end"].every((field) => names.filter((name) => name === field).length === 1)
        && fields.every(Boolean) && new Set(names).size === names.length)
        format = fields;
      continue;
    }
    const dialogue = /^\s*Dialogue\s*:\s*(.*)$/i.exec(line);
    if (!dialogue) continue;
    const fields = new Array(format.length);
    const textIndex = format.findIndex((field) => field.toLowerCase() === "text");
    let remaining = dialogue[1];
    let valid = textIndex >= 0;
    for (let i = 0; i < textIndex && valid; i++) {
      const separator = remaining.indexOf(",");
      if (separator < 0) { valid = false; break; }
      fields[i] = remaining.slice(0, separator);
      remaining = remaining.slice(separator + 1);
    }
    for (let i = format.length - 1; i > textIndex && valid; i--) {
      const separator = remaining.lastIndexOf(",");
      if (separator < 0) { valid = false; break; }
      fields[i] = remaining.slice(separator + 1);
      remaining = remaining.slice(0, separator);
    }
    if (!valid) continue;
    fields[textIndex] = remaining;
    const event = Object.fromEntries(format.map((name, i) => [name.toLowerCase(), fields[i]]));
    const startMs = assTime(event.start), endMs = assTime(event.end);
    if (startMs === null || endMs === null || endMs <= startMs) continue;
    const content = readAssText(event.text);
    if (!content.text) continue; // Includes vector-only drawing events.
    const style = String(event.style || "").trim();
    const effect = String(event.effect || "").trim();
    const signsStyle = /(?:^|[\s_-])(?:signs?|songs?|karaoke|lyrics|op|ed|opening|ending)(?:$|[\s_-])/i.test(`${style} ${effect}`);
    const kind = signsStyle || content.signPosition || content.karaoke ? "sign" : "dialogue";
    // Matching time and words do not prove the same ASS event: different
    // actors/layers/styles can speak simultaneously. Collapse only matching
    // semantic events from repeated extraction of the same stream.
    const identity = JSON.stringify([
      startMs, endMs, content.text, String(event.layer || "").trim(),
      String(event.name || "").trim(), style, effect,
      String(event.text || "").trim(),
    ]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    result.push({ startMs, endMs, text: content.text, style,
      actor: String(event.name || "").trim(), layer: String(event.layer || "").trim(), kind,
      hasVisualEffects: content.containedDrawing || content.signPosition || content.karaoke });
    if (result.length >= limit) break;
  }
  return result;
}

export function assEventsToWebVtt(events, { includeSigns = true } = {}) {
  const cues = (Array.isArray(events) ? events : [])
    .filter((event) => includeSigns || event.kind !== "sign")
    .filter((event) => Number.isFinite(event.startMs) && Number.isFinite(event.endMs)
      && event.endMs > event.startMs)
    .map((event) => {
      // A WebVTT cue body must not inject a second block or timestamp arrow.
      // Keep ordinary ASS line breaks and escape text as text, not VTT markup.
      const body = String(event.text || "").replace(/&/g, "&amp;")
        .replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/\n(?:\s*\n)+/g, "\n");
      return `${vttTime(event.startMs)} --> ${vttTime(event.endMs)}\n${body}`;
    });
  return cues.length ? `WEBVTT\n\n${cues.join("\n\n")}\n` : "";
}

export function assToWebVtt(source, options = {}) {
  return assEventsToWebVtt(parseAssDialogueEvents(source), options);
}
