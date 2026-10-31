// anki-render.js: renders Anki card templates to HTML the way Anki does, for decks stored in the
// app (imports, AnkiWeb downloads, presets). Pure JavaScript (no DOM, no Node APIs): server.js
// renders cards with it.
//
// Covered: {{Field}}, filters (text, furigana, kana, kanji, hint, type, cloze, tts: skipped),
// {{#Field}} / {{^Field}} sections, special fields (FrontSide, Tags, Type, Deck, Subdeck, Card),
// cloze deletions with hints, [sound:…] tags and media file references (img/audio/video/script
// src and CSS url()) rewritten to the app's media route.

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" };
export const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);

// Anki treats a field as empty when it holds only whitespace, <br> and <div> tags.
const EMPTY_FIELD = /^(?:[\s\u200b]|&nbsp;|<\/?(?:br|div)\s*\/?>)*$/i;
export function fieldIsEmpty(value) {
  return EMPTY_FIELD.test(String(value ?? ""));
}

export function stripHtml(value) {
  return String(value ?? "")
    .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, "\"").replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/* ---------------------------------------------------------------- furigana */

// Anki's furigana syntax: 日本語[にほんご] (a space ends the previous base). [sound:…] is not furigana.
const FURIGANA = / ?([^ >]+?)\[(.+?)\]/g;
const notSound = (reading) => !/^sound:/i.test(reading);

export function furiganaHtml(value) {
  return String(value ?? "").replace(FURIGANA, (match, base, reading) => (notSound(reading) ? `<ruby><rb>${base}</rb><rt>${reading}</rt></ruby>` : match));
}
export function kanaOnly(value) {
  return String(value ?? "").replace(FURIGANA, (match, base, reading) => (notSound(reading) ? reading : match));
}
export function kanjiOnly(value) {
  return String(value ?? "").replace(FURIGANA, (match, base, reading) => (notSound(reading) ? base : match));
}

/* ---------------------------------------------------------------- cloze */

const CLOZE = /\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g;

export function clozeNumbers(text) {
  return [...new Set([...String(text ?? "").matchAll(CLOZE)].map((match) => Number(match[1])))].sort((a, b) => a - b);
}

function renderClozeText(text, ordinal, side) {
  return String(text ?? "").replace(CLOZE, (match, number, answer, hint) => {
    if (Number(number) !== ordinal) return `<span class="cloze-inactive" data-ordinal="${number}">${answer}</span>`;
    if (side === "question") return `<span class="cloze" data-ordinal="${number}">[${hint ? escapeHtml(stripHtml(hint)) : "..."}]</span>`;
    return `<span class="cloze" data-ordinal="${number}">${answer}</span>`;
  });
}

function clozeAnswers(text, ordinal) {
  return [...String(text ?? "").matchAll(CLOZE)].filter((match) => Number(match[1]) === ordinal).map((match) => stripHtml(match[2]));
}

/* ---------------------------------------------------------------- templates */

let hintCounter = 0;

function applyFilters(value, filters, context) {
  let output = value;
  // Filters run right to left: {{text:furigana:Field}} applies furigana first.
  for (const filter of filters.slice().reverse()) {
    const name = filter.trim().toLowerCase();
    if (name === "text") output = stripHtml(output);
    else if (name === "furigana") output = furiganaHtml(output);
    else if (name === "kana") output = kanaOnly(output);
    else if (name === "kanji") output = kanjiOnly(output);
    else if (name === "cloze") output = renderClozeText(output, context.ordinal, context.side);
    else if (name === "cloze-only") output = clozeAnswers(output, context.ordinal).join(", ");
    else if (name === "hint") {
      if (fieldIsEmpty(output)) return "";
      hintCounter += 1;
      const id = `hint${hintCounter}`;
      output = `<a class="hint" href="#" data-lvl-hint="${id}">${escapeHtml(context.fieldName)}</a><div id="${id}" class="hint" style="display:none">${output}</div>`;
    } else if (name.startsWith("tts")) return "";
  }
  return output;
}

function lookupField(fields, name) {
  if (Object.hasOwn(fields, name)) return fields[name];
  const lower = name.toLowerCase();
  const key = Object.keys(fields).find((item) => item.toLowerCase() === lower);
  return key === undefined ? undefined : fields[key];
}

function renderSections(template, fields) {
  let output = String(template ?? "");
  for (let pass = 0; pass < 8; pass += 1) {
    const before = output;
    output = output.replace(/\{\{([#^])\s*([^}]+?)\s*\}\}([\s\S]*?)\{\{\/\s*\2\s*\}\}/g, (match, kind, name, inner) => {
      const value = lookupField(fields, name.replace(/^[^:]*:/, "").trim()) ?? "";
      const filled = !fieldIsEmpty(value);
      return (kind === "#" ? filled : !filled) ? inner : "";
    });
    if (output === before) break;
  }
  return output;
}

/**
 * Renders one side. fields: { name: html }. context: { ordinal (cloze number, 1-based), side
 * ("question" | "answer"), frontSide (rendered question for {{FrontSide}}), special: { Tags, Type,
 * Deck, Subdeck, Card }, typed (what the learner typed, answer side) }.
 */
export function renderTemplate(template, fields, context = {}) {
  const ctx = { ordinal: 1, side: "question", frontSide: "", special: {}, typed: "", ...context };
  const withSections = renderSections(template, fields);
  return withSections.replace(/\{\{([^{}]+?)\}\}/g, (match, raw) => {
    const inner = raw.trim();
    if (inner === "FrontSide") return ctx.frontSide;
    const parts = inner.split(":");
    const fieldName = parts.pop().trim();
    const filters = parts;
    if (Object.hasOwn(ctx.special, fieldName) && !Object.hasOwn(fields, fieldName)) return escapeHtml(ctx.special[fieldName]);
    const value = lookupField(fields, fieldName);
    if (value === undefined) return "";
    if (filters.some((filter) => filter.trim().toLowerCase() === "type")) {
      const clozeType = filters.some((filter) => filter.trim().toLowerCase() === "cloze");
      const expected = clozeType ? clozeAnswers(value, ctx.ordinal).join(", ") : stripHtml(value);
      return ctx.side === "question"
        ? '<input type="text" id="typeans" class="lvl-typeans" autocomplete="off" autocapitalize="off" spellcheck="false">'
        : `<div class="lvl-typeans-result" data-expected="${escapeHtml(expected)}"></div>`;
    }
    return applyFilters(value, filters, { ...ctx, fieldName });
  });
}

/* ---------------------------------------------------------------- media */

const PLAY_ICON = '<svg class="playImage" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="29"/><path d="M56.502,32.301l-37.502,20.101l0.329,-40.804l37.173,20.703Z"/></svg>';
const isRelativeMedia = (value) => value && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(value.trim());

function decodeHtmlAttribute(value) {
  return String(value).replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

/**
 * Rewrites media references to URLs from mediaUrl(name) and turns [sound:…] into play buttons.
 * Returns { html, sounds: [url] } with sounds in order of appearance.
 */
export function rewriteMedia(html, mediaUrl) {
  const sounds = [];
  let output = String(html ?? "").replace(/\[sound:([^\]]+)\]/gi, (match, name) => {
    const url = mediaUrl(name.trim());
    sounds.push(url);
    return `<a class="replay-button soundLink" href="#" data-lvl-sound="${escapeHtml(url)}" aria-label="Play audio">${PLAY_ICON}</a>`;
  });
  output = output.replace(/(<(?:img|audio|video|source|script|track|embed)\b[^>]*?\bsrc\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi, (match, prefix, double, single, bare) => {
    const value = decodeHtmlAttribute(double ?? single ?? bare ?? "");
    return isRelativeMedia(value) ? `${prefix}"${escapeHtml(mediaUrl(value))}"` : match;
  });
  output = output.replace(/(<link\b[^>]*?\bhref\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi, (match, prefix, double, single) => {
    const value = decodeHtmlAttribute(double ?? single ?? "");
    return isRelativeMedia(value) ? `${prefix}"${escapeHtml(mediaUrl(value))}"` : match;
  });
  output = output.replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi, (match, attributes, css) => `<style${attributes}>${rewriteCssUrls(css, mediaUrl)}</style>`);
  return { html: output, sounds };
}

export function rewriteCssUrls(css, mediaUrl) {
  return String(css ?? "").replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"']*))\s*\)/gi, (match, double, single, bare) => {
    const value = String(double ?? single ?? bare ?? "").trim();
    return isRelativeMedia(value) ? `url("${mediaUrl(value).replace(/"/g, "%22")}")` : match;
  });
}

/* ---------------------------------------------------------------- whole card */

/**
 * notetype: { kind ("normal" | "cloze"), fields: [name], templates: [{ name, qfmt, afmt }], css }
 * note: { fields: [html] (in notetype field order), tags: [tag] }
 * ord: card ordinal (template index, or cloze number - 1).
 * Returns { question, answer, css, questionSounds, answerSounds, template, empty }.
 */
export function renderAnkiCard({ notetype, note, ord = 0, deckName = "", mediaUrl = (name) => name }) {
  const fieldNames = Array.isArray(notetype?.fields) ? notetype.fields : [];
  const fields = Object.fromEntries(fieldNames.map((name, index) => [name, String(note?.fields?.[index] ?? "")]));
  const cloze = notetype?.kind === "cloze";
  const template = cloze ? notetype.templates?.[0] : notetype?.templates?.[ord];
  const css = rewriteCssUrls(String(notetype?.css ?? ""), mediaUrl);
  if (!template) {
    const question = rewriteMedia(fields[fieldNames[0]] ?? "", mediaUrl);
    const answer = rewriteMedia(fieldNames.slice(1).map((name) => fields[name]).filter((value) => !fieldIsEmpty(value)).join("<br>"), mediaUrl);
    return { question: question.html, answer: `${question.html}<hr id="answer">${answer.html}`, css, questionSounds: question.sounds, answerSounds: answer.sounds, template: "", empty: fieldIsEmpty(fields[fieldNames[0]] ?? "") };
  }
  const special = {
    Tags: (note?.tags || []).join(" "),
    Type: notetype?.name || "",
    Deck: deckName,
    Subdeck: String(deckName).split("::").pop(),
    Card: template.name || `Card ${ord + 1}`,
    CardFlag: "",
  };
  const ordinal = cloze ? ord + 1 : 0;
  const questionRaw = renderTemplate(template.qfmt, fields, { ordinal, side: "question", special });
  const answerRaw = renderTemplate(template.afmt, fields, { ordinal, side: "answer", special, frontSide: questionRaw.replace(/<input[^>]*id="typeans"[^>]*>/, "") });
  const question = rewriteMedia(questionRaw, mediaUrl);
  const answer = rewriteMedia(answerRaw, mediaUrl);
  // On the answer side Anki plays the answer's own sounds, not the question's again.
  const questionSet = new Set(question.sounds);
  const empty = cloze ? !clozeNumbers(fields[fieldNames.find((name) => /\{\{c\d+::/.test(fields[name])) || fieldNames[0]]).includes(ordinal) : !stripHtml(questionRaw.replace(/<img\b/gi, "x<img")) && !question.sounds.length;
  return {
    question: question.html,
    answer: answer.html,
    css,
    questionSounds: question.sounds,
    answerSounds: answer.sounds.filter((url) => !questionSet.has(url)),
    template: template.name || "",
    empty,
  };
}
