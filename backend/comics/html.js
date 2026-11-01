// A small HTML parser and CSS selector engine for source sites.
// It covers what the Madara and MangaThemesia themes use from jsoup: tag, #id,
// .class, [attr], [attr=|^=|$=|*=|~=v], descendant, >, +, ~, :not(), :has(),
// :contains(), :containsOwn(), :first-child, :last-child. Pages are parsed
// leniently, like a browser would: unclosed <li>/<p>/<td> close themselves and
// stray end tags are ignored.

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const RAW = new Set(["script", "style", "textarea", "title"]);
const CLOSES_P = new Set(["address", "article", "aside", "blockquote", "div", "dl", "fieldset", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6",
  "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "table", "ul"]);
// A start tag closes an open element of these kinds, up to the given boundary.
const AUTO_CLOSE = {
  li: { close: ["li"], stop: ["ul", "ol", "menu"] },
  dt: { close: ["dt", "dd"], stop: ["dl"] },
  dd: { close: ["dt", "dd"], stop: ["dl"] },
  tr: { close: ["tr", "td", "th"], stop: ["table", "thead", "tbody", "tfoot"] },
  td: { close: ["td", "th"], stop: ["tr", "table"] },
  th: { close: ["td", "th"], stop: ["tr", "table"] },
  option: { close: ["option"], stop: ["select", "datalist", "optgroup"] },
  optgroup: { close: ["optgroup", "option"], stop: ["select"] },
  thead: { close: ["tbody", "thead", "tfoot", "tr", "td", "th"], stop: ["table"] },
  tbody: { close: ["tbody", "thead", "tfoot", "tr", "td", "th"], stop: ["table"] },
  tfoot: { close: ["tbody", "thead", "tfoot", "tr", "td", "th"], stop: ["table"] },
  a: { close: ["a"], stop: [] },
};
const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  laquo: "«", raquo: "»", middot: "·", bull: "•", copy: "©", reg: "®", trade: "™", deg: "°", times: "×", iexcl: "¡", iquest: "¿",
  aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú", ntilde: "ñ", uuml: "ü", Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó", Uacute: "Ú", Ntilde: "Ñ", Uuml: "Ü",
  agrave: "à", egrave: "è", ccedil: "ç", ecirc: "ê", ocirc: "ô", atilde: "ã", otilde: "õ", acirc: "â", ouml: "ö", auml: "ä", szlig: "ß",
};

export function decodeEntities(text) {
  if (!text || text.indexOf("&") === -1) return text || "";
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,31});?/gi, (whole, name) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, name) ? ENTITIES[name] : whole;
  });
}

const collapse = (text) => text.replace(/[\s\u00a0]+/g, " ").trim();

export class TextNode {
  constructor(text, parent) { this.type = 3; this.value = text; this.parent = parent; }
}

export class Element {
  constructor(tag, attrs = {}, parent = null, document = null) {
    this.type = 1;
    this.tag = tag;
    this.attrs = attrs;
    this.parent = parent;
    this.document = document;
    this.children = [];
  }
  get elements() { return this.children.filter((node) => node.type === 1); }
  hasAttr(name) { return Object.prototype.hasOwnProperty.call(this.attrs, String(name).toLowerCase()); }
  attr(name) {
    const key = String(name).toLowerCase();
    if (key.startsWith("abs:")) return this.absAttr(key.slice(4));
    return this.hasAttr(key) ? this.attrs[key] : "";
  }
  // The attribute as an absolute URL against the page (empty when it isn't one).
  absAttr(name) {
    const value = this.attr(name).trim();
    if (!value) return "";
    try {
      const url = new URL(value, this.document?.baseUri || undefined);
      return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
    } catch { return ""; }
  }
  hasClass(name) {
    const wanted = String(name).toLowerCase();
    return this.attr("class").toLowerCase().split(/\s+/).includes(wanted);
  }
  // Text of this element and its descendants, whitespace collapsed (like jsoup's text()).
  text() {
    const parts = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (child.type === 3) parts.push(child.value);
        else if (child.tag === "br") parts.push(" ");
        else if (child.tag !== "script" && child.tag !== "style") { if (BLOCKISH.has(child.tag)) parts.push(" "); walk(child); if (BLOCKISH.has(child.tag)) parts.push(" "); }
      }
    };
    walk(this);
    return collapse(parts.join(""));
  }
  ownText() { return collapse(this.children.filter((node) => node.type === 3).map((node) => node.value).join("")); }
  // Raw contents of <script> and <style>.
  data() { return this.children.filter((node) => node.type === 3).map((node) => node.value).join(""); }
  previousElement() {
    if (!this.parent) return null;
    const siblings = this.parent.elements;
    return siblings[siblings.indexOf(this) - 1] || null;
  }
  select(selector) { return select(this, selector); }
  selectFirst(selector) { return select(this, selector, true)[0] || null; }
}
const BLOCKISH = new Set(["p", "div", "li", "tr", "td", "th", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "section", "article", "header", "footer", "dd", "dt", "table"]);

function parseAttributes(source) {
  const attrs = {};
  const re = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let match;
  while ((match = re.exec(source))) {
    const name = match[1].toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(attrs, name)) attrs[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attrs;
}

// Finds the end of a tag starting at `from` (just after "<name"), honouring quotes.
function tagEnd(html, from) {
  let quote = "";
  for (let i = from; i < html.length; i += 1) {
    const c = html[i];
    if (quote) { if (c === quote) quote = ""; }
    else if (c === '"' || c === "'") { const prev = html[i - 1]; if (prev === "=" || /\s/.test(prev)) quote = c; }
    else if (c === ">") return i;
  }
  return -1;
}

export function parseHtml(html, location = "") {
  const source = String(html || "");
  const document = new Element("#document", {}, null, null);
  document.document = document;
  document.location = location;
  document.baseUri = location;
  document.html = source;
  const stack = [document];
  const current = () => stack[stack.length - 1];
  const addText = (text) => { if (text) current().children.push(new TextNode(decodeEntities(text), current())); };
  const closeTo = (index) => { stack.length = Math.max(1, index); };
  const findOpen = (names, stops) => {
    for (let i = stack.length - 1; i > 0; i -= 1) {
      if (names.includes(stack[i].tag)) return i;
      if (stops.includes(stack[i].tag)) return -1;
    }
    return -1;
  };
  let i = 0;
  while (i < source.length) {
    const lt = source.indexOf("<", i);
    if (lt === -1) { addText(source.slice(i)); break; }
    if (lt > i) addText(source.slice(i, lt));
    if (source.startsWith("<!--", lt)) {
      const end = source.indexOf("-->", lt + 4);
      i = end === -1 ? source.length : end + 3;
      continue;
    }
    const next = source[lt + 1] || "";
    if (next === "!" || next === "?") {
      const end = source.indexOf(">", lt + 2);
      i = end === -1 ? source.length : end + 1;
      continue;
    }
    if (next === "/") {
      const match = /^<\/([a-zA-Z][a-zA-Z0-9:-]*)[^>]*>/.exec(source.slice(lt, lt + 200));
      if (!match) { addText("<"); i = lt + 1; continue; }
      const name = match[1].toLowerCase();
      const open = findOpen([name], []);
      if (open > 0) closeTo(open);
      i = lt + match[0].length;
      continue;
    }
    const nameMatch = /^<([a-zA-Z][a-zA-Z0-9:-]*)/.exec(source.slice(lt, lt + 80));
    if (!nameMatch) { addText("<"); i = lt + 1; continue; }
    const name = nameMatch[1].toLowerCase();
    const end = tagEnd(source, lt + nameMatch[0].length);
    if (end === -1) { addText(source.slice(lt)); break; }
    const inner = source.slice(lt + nameMatch[0].length, end);
    const selfClosing = /\/\s*$/.test(inner);
    const attrs = parseAttributes(selfClosing ? inner.replace(/\/\s*$/, "") : inner);
    if (CLOSES_P.has(name)) { const p = findOpen(["p"], ["button", "table", "li", "td", "th"]); if (p > 0) closeTo(p); }
    const rule = AUTO_CLOSE[name];
    if (rule) { const open = findOpen(rule.close, rule.stop); if (open > 0) closeTo(open); }
    const element = new Element(name, attrs, current(), document);
    current().children.push(element);
    if (name === "base" && attrs.href && document.baseUri === location) {
      try { document.baseUri = new URL(attrs.href, location || undefined).href; } catch {}
    }
    i = end + 1;
    if (VOID.has(name) || selfClosing) continue;
    if (RAW.has(name)) {
      const close = new RegExp(`</${name}\\s*>`, "i");
      const rest = source.slice(i);
      const found = close.exec(rest);
      const raw = found ? rest.slice(0, found.index) : rest;
      element.children.push(new TextNode(name === "textarea" || name === "title" ? decodeEntities(raw) : raw, element));
      i += found ? found.index + found[0].length : rest.length;
      continue;
    }
    stack.push(element);
  }
  return document;
}

// ---- Selectors
function splitTopLevel(text, separator) {
  const parts = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) { if (c === quote) quote = ""; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(" || c === "[") depth += 1;
    else if (c === ")" || c === "]") depth -= 1;
    else if (c === separator && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

const unquote = (value) => {
  const text = String(value).trim();
  return /^(["']).*\1$/.test(text) ? text.slice(1, -1) : text;
};

// One compound selector: tag#id.class[attr]:pseudo(...)
function parseCompound(text) {
  const compound = { tag: "", id: "", classes: [], attrs: [], pseudos: [] };
  let i = 0;
  const ident = () => {
    const match = /^(?:\\.|[A-Za-z0-9_\u00a0-\uffff-])+/.exec(text.slice(i));
    if (!match) throw new Error(`Bad selector: ${text}`);
    i += match[0].length;
    return match[0].replace(/\\(.)/g, "$1");
  };
  if (text[0] === "*") i = 1;
  else if (/[A-Za-z]/.test(text[0] || "")) compound.tag = ident().toLowerCase();
  while (i < text.length) {
    const c = text[i];
    if (c === "#") { i += 1; compound.id = ident(); }
    else if (c === ".") { i += 1; compound.classes.push(ident().toLowerCase()); }
    else if (c === "[") {
      let depth = 0;
      let quote = "";
      let j = i;
      for (; j < text.length; j += 1) {
        const ch = text[j];
        if (quote) { if (ch === quote) quote = ""; }
        else if (ch === '"' || ch === "'") quote = ch;
        else if (ch === "[") depth += 1;
        else if (ch === "]") { depth -= 1; if (!depth) break; }
      }
      const body = text.slice(i + 1, j);
      const match = /^\s*([^\s~|^$*=\]]+)\s*(?:([~|^$*]?=)\s*(.*?))?\s*$/s.exec(body);
      if (!match) throw new Error(`Bad selector: ${text}`);
      compound.attrs.push({ name: match[1].toLowerCase(), op: match[2] || "", value: match[3] !== undefined ? unquote(match[3]).replace(/\\(.)/g, "$1").toLowerCase() : "" });
      i = j + 1;
    } else if (c === ":") {
      i += 1;
      const name = ident().toLowerCase();
      let arg = "";
      if (text[i] === "(") {
        let depth = 0;
        let j = i;
        for (; j < text.length; j += 1) {
          if (text[j] === "(") depth += 1;
          else if (text[j] === ")") { depth -= 1; if (!depth) break; }
        }
        arg = text.slice(i + 1, j);
        i = j + 1;
      }
      const pseudo = { name, arg };
      if (name === "not" || name === "has") pseudo.selector = parseSelector(arg);
      else if (name === "contains" || name === "containsown") pseudo.text = unquote(arg).toLowerCase();
      else if (name === "nth-child") {
        if (!/^\s*\d+\s*$/.test(arg)) throw new Error(`Unsupported selector :nth-child(${arg})`);
        pseudo.index = Number(arg);
      } else if (!["first-child", "last-child", "only-child"].includes(name)) throw new Error(`Unsupported selector :${name}`);
      compound.pseudos.push(pseudo);
    } else throw new Error(`Bad selector: ${text}`);
  }
  return compound;
}

// A complex selector as compounds from right to left with the combinator before each.
function parseComplex(text) {
  const tokens = [];
  let buffer = "";
  let depth = 0;
  let quote = "";
  const flush = () => { if (buffer.trim()) tokens.push({ type: "compound", value: buffer.trim() }); buffer = ""; };
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) { buffer += c; if (c === quote) quote = ""; continue; }
    if (c === '"' || c === "'") { quote = c; buffer += c; continue; }
    if (c === "(" || c === "[") depth += 1;
    if (c === ")" || c === "]") depth -= 1;
    if (depth === 0 && (c === ">" || c === "+" || c === "~") && text[i + 1] !== "=") { flush(); tokens.push({ type: "comb", value: c }); continue; }
    if (depth === 0 && /\s/.test(c)) { flush(); if (tokens.length && tokens[tokens.length - 1].type === "compound") tokens.push({ type: "comb", value: " " }); continue; }
    buffer += c;
  }
  flush();
  while (tokens.length && tokens[tokens.length - 1].type === "comb") tokens.pop();
  const parts = [];
  let comb = null;
  for (const token of tokens) {
    if (token.type === "comb") { if (token.value !== " " || !comb) comb = token.value; continue; }
    parts.push({ compound: parseCompound(token.value), comb: comb || " " });
    comb = null;
  }
  return parts.reverse();
}

const selectorCache = new Map();
export function parseSelector(text) {
  const key = String(text);
  if (selectorCache.has(key)) return selectorCache.get(key);
  const parsed = splitTopLevel(key, ",").map(parseComplex);
  if (selectorCache.size > 500) selectorCache.clear();
  selectorCache.set(key, parsed);
  return parsed;
}

function attrMatches(element, { name, op, value }) {
  if (!element.hasAttr(name)) return false;
  if (!op) return true;
  const actual = element.attrs[name].toLowerCase();
  if (op === "=") return actual === value;
  if (op === "^=") return Boolean(value) && actual.startsWith(value);
  if (op === "$=") return Boolean(value) && actual.endsWith(value);
  if (op === "*=") return Boolean(value) && actual.includes(value);
  if (op === "~=") return actual.split(/\s+/).includes(value);
  if (op === "|=") return actual === value || actual.startsWith(`${value}-`);
  return false;
}

function compoundMatches(element, compound) {
  if (element.type !== 1 || element.tag === "#document") return false;
  if (compound.tag && element.tag !== compound.tag) return false;
  if (compound.id && element.attr("id") !== compound.id) return false;
  for (const cls of compound.classes) if (!element.hasClass(cls)) return false;
  for (const attr of compound.attrs) if (!attrMatches(element, attr)) return false;
  for (const pseudo of compound.pseudos) {
    if (pseudo.name === "not" && matchesAny(element, pseudo.selector)) return false;
    if (pseudo.name === "has" && !select(element, pseudo.selector, true).length) return false;
    if (pseudo.name === "contains" && !element.text().toLowerCase().includes(pseudo.text)) return false;
    if (pseudo.name === "containsown" && !element.ownText().toLowerCase().includes(pseudo.text)) return false;
    if (pseudo.name === "first-child" && element.parent?.elements[0] !== element) return false;
    if (pseudo.name === "last-child" && element.parent?.elements.at(-1) !== element) return false;
    if (pseudo.name === "only-child" && element.parent?.elements.length !== 1) return false;
    if (pseudo.name === "nth-child" && element.parent?.elements[pseudo.index - 1] !== element) return false;
  }
  return true;
}

function complexMatches(element, parts, index = 0) {
  if (!compoundMatches(element, parts[index].compound)) return false;
  if (index === parts.length - 1) return true;
  const comb = parts[index].comb;
  if (comb === ">") return Boolean(element.parent) && complexMatches(element.parent, parts, index + 1);
  if (comb === "+") { const prev = element.previousElement(); return Boolean(prev) && complexMatches(prev, parts, index + 1); }
  if (comb === "~") {
    const siblings = element.parent ? element.parent.elements : [];
    for (let i = siblings.indexOf(element) - 1; i >= 0; i -= 1) if (complexMatches(siblings[i], parts, index + 1)) return true;
    return false;
  }
  for (let node = element.parent; node; node = node.parent) if (complexMatches(node, parts, index + 1)) return true;
  return false;
}

function matchesAny(element, groups) { return groups.some((parts) => complexMatches(element, parts)); }

// Descendants of root matching the selector, in document order.
export function select(root, selector, firstOnly = false) {
  const groups = typeof selector === "string" ? parseSelector(selector) : selector;
  const out = [];
  const walk = (node) => {
    for (const child of node.children) {
      if (child.type !== 1) continue;
      if (matchesAny(child, groups)) { out.push(child); if (firstOnly) return true; }
      if (walk(child) && firstOnly) return true;
    }
    return false;
  };
  walk(root);
  return out;
}
