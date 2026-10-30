// Parse the text-bearing events of external ASS/SSA subtitles without treating
// vector drawings or anime signs as ordinary spoken dialogue. This is a
// bounded, plain-text conversion: libass positioning, fonts and effects are
// intentionally not claimed to survive WebVTT conversion.

const DEFAULT_EVENT_FIELDS = ["Layer", "Start", "End", "Style", "Name", "MarginL", "MarginR", "MarginV", "Effect", "Text"];
const MAX_ASS_EVENTS = 20_000;

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
      // Text is conventionally last, and can contain arbitrary commas.
      if (fields.length >= 4 && fields.at(-1)?.toLowerCase() === "text"
        && ["start", "end"].every((field) => fields.some((candidate) => candidate.toLowerCase() === field)))
        format = fields;
      continue;
    }
    const dialogue = /^\s*Dialogue\s*:\s*(.*)$/i.exec(line);
    if (!dialogue) continue;
    const fields = [];
    let remaining = dialogue[1];
    for (let i = 1; i < format.length; i++) {
      const separator = remaining.indexOf(",");
      if (separator < 0) break;
      fields.push(remaining.slice(0, separator));
      remaining = remaining.slice(separator + 1);
    }
    if (fields.length !== format.length - 1) continue;
    fields.push(remaining);
    const event = Object.fromEntries(format.map((name, i) => [name.toLowerCase(), fields[i]]));
    const startMs = assTime(event.start), endMs = assTime(event.end);
    if (startMs === null || endMs === null || endMs <= startMs) continue;
    const content = readAssText(event.text);
    if (!content.text) continue; // Includes vector-only drawing events.
    const style = String(event.style || "").trim();
    const effect = String(event.effect || "").trim();
    const signsStyle = /(?:^|[\s_-])(?:signs?|songs?|karaoke|lyrics|op|ed|opening|ending)(?:$|[\s_-])/i.test(`${style} ${effect}`);
    const kind = signsStyle || content.signPosition || content.karaoke ? "sign" : "dialogue";
    const identity = `${startMs}|${endMs}|${content.text}`;
    if (seen.has(identity)) continue; // Redundant ASS overlay lines do not double dialogue.
    seen.add(identity);
    result.push({ startMs, endMs, text: content.text, style, kind,
      hasVisualEffects: content.containedDrawing || content.signPosition || content.karaoke });
    if (result.length >= limit) break;
  }
  return result;
}

export function assEventsToWebVtt(events, { includeSigns = true } = {}) {
  const cues = (Array.isArray(events) ? events : [])
    .filter((event) => includeSigns || event.kind !== "sign")
    .map((event) => `${vttTime(event.startMs)} --> ${vttTime(event.endMs)}\n${event.text}`);
  return cues.length ? `WEBVTT\n\n${cues.join("\n\n")}\n` : "";
}

export function assToWebVtt(source, options = {}) {
  return assEventsToWebVtt(parseAssDialogueEvents(source), options);
}
