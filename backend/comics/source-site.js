// Helpers shared by the site engines: requests to one
// source site with its per-site settings, list parsing and chapter items.
import { parseHtml } from "./html.js";
import { isBotCheck } from "./remote-fetch.js";
import { chapterNumber, volumeNumber, parseSiteDate } from "./chapter-names.js";

export const fail = (message, status = 502, code = "") => Object.assign(new Error(message), { status, code });

// Path (and query) of a URL, so a site that moves domain keeps working.
export function sitePath(href) {
  try { const url = new URL(href); return `${url.pathname}${url.search}`; } catch { return ""; }
}

// Per-site request speed (Settings › Comics › a favorite's settings).
export const SITE_SPEEDS = Object.freeze({ normal: null, slow: { gapMs: 1500, perHost: 1 }, slower: { gapMs: 4000, perHost: 1 } });
export const BROWSER_MODES = Object.freeze(["auto", "always", "never"]);

// Request options that follow a source's settings: the browser mode and pacing.
export function siteRequestOptions(source) {
  const settings = source?.settings || {};
  return {
    ...(BROWSER_MODES.includes(settings.browser) && settings.browser !== "auto" ? { browser: settings.browser } : {}),
    ...(SITE_SPEEDS[settings.speed] ? { pace: SITE_SPEEDS[settings.speed] } : {}),
  };
}

export function siteClient(source, remote) {
  const base = String(source.baseUrl || "").replace(/\/+$/, "");
  if (!/^https?:\/\/[^/]+/.test(base)) throw fail("This source has no address", 400);
  const abs = (path) => new URL(String(path), `${base}/`).href;
  const extra = siteRequestOptions(source);
  const baseOrigin = new URL(base).origin;
  // The site answered from another domain at the same path: it moved there.
  function noteMove(requested, response) {
    if (typeof source.onMove !== "function" || !response?.url || response.status >= 400) return;
    let from;
    let to;
    try { from = new URL(String(requested)); to = new URL(response.url); } catch { return; }
    if (from.origin === baseOrigin && to.origin !== baseOrigin && to.pathname === from.pathname && /^https?:$/.test(to.protocol)) source.onMove(to.origin);
  }
  async function send(url, options = {}) {
    const response = await remote.request(url, { lang: source.lang, referer: `${base}/`, ...extra, ...options });
    noteMove(url, response);
    if (isBotCheck(response)) {
      const message = extra.browser === "never"
        ? `${source.name} asks for a browser check (Cloudflare), and its settings say not to use the browser`
        : `${source.name} asks for a browser check (Cloudflare), which LVL can't pass`;
      throw fail(message, 502, "blocked");
    }
    return response;
  }
  async function ok(url, options) {
    const response = await send(url, options);
    if (!response.ok) throw fail(`${source.name} answered HTTP ${response.status}`, response.status === 404 ? 404 : 502);
    return response;
  }
  const doc = async (url, options) => { const response = await ok(url, options); return parseHtml(response.text(), response.url); };
  const json = async (url, options = {}) => {
    const response = await ok(url, { accept: "application/json", ...options });
    try { return response.json(); } catch { throw fail(`${source.name} sent an unexpected answer`); }
  };
  const xhr = { "X-Requested-With": "XMLHttpRequest" };
  return { base, abs, send, ok, doc, json, xhr };
}

// The image an <img> really shows (lazy-loading attributes first).
export function imageOf(element) {
  if (!element) return "";
  for (const name of ["data-src", "data-lazy-src", "data-lzl-src", "data-cfsrc", "data-manga-src", "data-original"]) {
    if (element.hasAttr(name) && element.attr(name).trim()) return element.absAttr(name);
  }
  if (element.hasAttr("srcset")) {
    const best = element.attr("srcset").split(",").map((part) => part.trim().split(/\s+/)).filter((part) => /^https?:\/\//.test(part[0]) || part[0]?.startsWith("/"))
      .map(([url, size]) => ({ url, size: parseFloat(size) || 0 })).sort((a, b) => b.size - a.size)[0];
    if (best) { try { return new URL(best.url, element.document?.baseUri).href; } catch {} }
  }
  return element.absAttr("src");
}

export const cleanTitle = (text) => String(text || "").replace(/\s+/g, " ").trim().slice(0, 200);

export function chapterItem({ href, name, date, mangaTitle, group = "" }) {
  const path = sitePath(href);
  if (!path) return null;
  const label = cleanTitle(name);
  return { path, name: label, chapter: chapterNumber(label, mangaTitle), volume: volumeNumber(label), date: typeof date === "number" ? date : parseSiteDate(date), group };
}

export const unique = (items, key) => {
  const seen = new Set();
  return items.filter((item) => item && !seen.has(key(item)) && seen.add(key(item)));
};

// Scripts packed with Dean Edwards' packer ("eval(function(p,a,c,k,e,d)…"), which
// sites use to hide reader data (MangaFox's desktop reader). Pure: the packed
// text is decoded, never run.
const PACKED = /\}\('((?:\\.|[^'\\])*)',\s*(\d+),\s*(\d+),\s*'((?:\\.|[^'\\])*)'\.split\('\|'\)/s;
const PACK_DIGITS = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
export function unpackPacked(text) {
  const match = PACKED.exec(String(text || ""));
  if (!match) return "";
  const radix = Number(match[2]);
  const count = Number(match[3]);
  if (!(radix >= 2 && radix <= 62)) return "";
  const words = match[4].split("|");
  const encode = (value) => (value < radix ? "" : encode(Math.floor(value / radix))) + PACK_DIGITS[value % radix];
  const decode = (word) => [...word].reduce((sum, char) => sum * radix + PACK_DIGITS.indexOf(char), 0);
  return match[1].replace(/\\(.)/g, "$1").replace(/\b\w+\b/g, (word) => {
    if (![...word].every((char) => { const at = PACK_DIGITS.indexOf(char); return at >= 0 && at < radix; })) return word;
    const value = decode(word);
    return value < count && encode(value) === word && words[value] ? words[value] : word;
  });
}

// Every packed script in a page, unpacked.
export function packedScripts(html) {
  return [...String(html || "").matchAll(/eval\(function\(p,a,c,k,e,[dr]\)[\s\S]*?\.split\('\|'\)[^)]*\)\)/g)].map((item) => unpackPacked(item[0])).filter(Boolean);
}

// The first of several searches to find something; [] if none does; an error only if all fail.
export function firstWithResults(searches) {
  return new Promise((resolve, reject) => {
    let left = searches.length;
    const errors = [];
    const settle = () => {
      if (--left > 0) return;
      if (errors.length === searches.length) reject(errors.find((error) => error.code === "blocked") || errors[0]);
      else if (errors.some((error) => error.code === "blocked")) reject(errors.find((error) => error.code === "blocked"));
      else resolve([]);
    };
    for (const search of searches) {
      Promise.resolve(search).then((items) => { if (items?.length) resolve(items); settle(); }, (error) => { errors.push(error); settle(); });
    }
  });
}
