// Requests to source sites. Sites come from extension
// repositories, so every request is treated as untrusted:
// - only http(s) to public addresses; the resolved address is checked and used
//   for the connection (no DNS rebinding to 127.0.0.1 or the LAN), and every
//   redirect is checked again;
// - bounded time, size and redirects;
// - requests to one host are paced and limited in number, like Mihon's rate limits;
// - cookies a site sets are kept in memory for that host (some sites need them).
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import net from "node:net";
import zlib from "node:zlib";
import { createSiteCookieJar } from "./site-cookie-jar.js";

export const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
// A GET answered with a server error (5xx, Cloudflare's 52x) is tried again
// after these waits; Retry-After is honored up to 10 s.
const LIMITS = Object.freeze({ timeoutMs: 25_000, maxBytes: 8 * 1024 * 1024, redirects: 5, gapMs: 300, perHost: 3, retryDelays: [1000, 3000] });
const RETRY_STATUS = new Set([500, 502, 503, 504, 520, 521, 522, 523, 524]);

function ipv4Private(address) {
  const [a, b, c] = address.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 192 && b === 88 && c === 99) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113) || a >= 224;
}

// WHATWG URL canonicalization turns dotted IPv4-mapped literals into hex,
// e.g. ::ffff:127.0.0.1 -> ::ffff:7f00:1. Decode the actual IPv6 words
// before applying the same IPv4 policy to mapped/compatible addresses.
function ipv6Words(address) {
  let canonical;
  try { canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1); }
  catch { return null; }
  const halves = canonical.split("::");
  if (halves.length > 2) return null;
  const before = halves[0] ? halves[0].split(":") : [];
  const after = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const gap = 8 - before.length - after.length;
  if (halves.length === 2 ? gap < 1 : before.length !== 8) return null;
  const words = [...before, ...Array(halves.length === 2 ? gap : 0).fill("0"), ...after]
    .map((value) => Number.parseInt(value, 16));
  return words.length === 8 && words.every((value) => Number.isInteger(value) && value >= 0 && value <= 0xffff)
    ? words : null;
}

export function isPublicAddress(address) {
  address = String(address);
  // Scoped IPv6 values cannot be validated as globally routable endpoints.
  if (address.includes("%")) return false;
  const kind = net.isIP(address);
  if (kind === 4) return !ipv4Private(address);
  if (kind !== 6) return false;
  const words = ipv6Words(address);
  if (!words) return false;
  if (words.slice(0, 5).every((value) => value === 0)
    && (words[5] === 0xffff || words[5] === 0)) {
    const octets = [words[6] >> 8, words[6] & 255, words[7] >> 8, words[7] & 255];
    return !ipv4Private(octets.join("."));
  }
  const first = words[0];
  // Preserve the existing loopback/unspecified, ULA, link-local, multicast,
  // NAT64 and documentation-address restrictions, regardless of textual form.
  if (words.slice(0, 7).every((value) => value === 0) && words[7] <= 1) return false;
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0 || (first & 0xff00) === 0xff00) return false;
  if (first === 0x64 && words[1] === 0xff9b) return false;
  return !(first === 0x2001 && words[1].toString(16).startsWith("db8"));
}

export function checkUrl(value) {
  let url;
  try { url = new URL(String(value)); } catch { throw Object.assign(new Error("Invalid address"), { status: 400 }); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw Object.assign(new Error("Only web addresses can be fetched"), { status: 400 });
  if (url.username || url.password) throw Object.assign(new Error("Addresses with passwords aren't fetched"), { status: 400 });
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && !isPublicAddress(host)) throw Object.assign(new Error("Local addresses aren't fetched"), { status: 400 });
  if (/^(?:localhost|.*\.localhost|.*\.local|.*\.internal|.*\.lan|.*\.home\.arpa)$/i.test(host)) throw Object.assign(new Error("Local addresses aren't fetched"), { status: 400 });
  return url;
}

// dns.lookup that refuses non-public answers. Handles { all: true } (used by
// Node's happy-eyeballs connect) as well as the single-address form.
export function safeLookup(resolve = dns.lookup, isAllowed = isPublicAddress) {
  return (hostname, options, callback) => {
    const cb = typeof options === "function" ? options : callback;
    const opts = typeof options === "object" && options ? options : {};
    resolve(hostname, { ...opts, all: true }, (error, addresses) => {
      if (error) return cb(error);
      const list = (Array.isArray(addresses) ? addresses : [{ address: addresses, family: net.isIP(addresses) }]).filter((item) => isAllowed(item.address));
      if (!list.length) return cb(Object.assign(new Error("The site resolved to a local address"), { code: "EPRIVATE" }));
      if (opts.all) return cb(null, list);
      return cb(null, list[0].address, list[0].family);
    });
  };
}

// For requests another program makes (the source browser): the URL and the
// addresses its host resolves to must be public.
export async function checkHost(value, resolve = dns.lookup) {
  const url = checkUrl(value);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) return url;
  await new Promise((done, reject) => safeLookup(resolve)(host, { all: true }, (error) => (error ? reject(Object.assign(error, { status: 400 })) : done())));
  return url;
}

// Paces requests per host: at most `perHost` at once, `gapMs` between starts.
// A request can ask for a slower pace for its host (a site's speed setting);
// later requests to that host (its images) keep it.
function hostPacer({ gapMs, perHost, now }) {
  const hosts = new Map();
  const maxHosts = 200;
  const idleTtlMs = 10 * 60_000;
  const idle = (state) => state.active === 0 && state.queue.length === 0;
  const pruneIdle = () => {
    const stamp = now();
    for (const [host, state] of hosts) {
      if (idle(state) && state.idleAt !== null && stamp - state.idleAt >= idleTtlMs)
        hosts.delete(host);
    }
    // Insertion order is the LRU order. Never evict an active or queued
    // owner, even if that temporarily places the map above the idle cap.
    for (const [host, state] of hosts) {
      if (hosts.size <= maxHosts) break;
      if (idle(state)) hosts.delete(host);
    }
  };
  return async function run(host, task, pace = null) {
    pruneIdle();
    const state = hosts.get(host) || { active: 0, last: 0, queue: [], pace: null, idleAt: null, startTurn: Promise.resolve() };
    if (hosts.has(host)) hosts.delete(host);
    hosts.set(host, state);
    state.idleAt = null;
    if (pace) state.pace = pace;
    const gap = Math.max(gapMs, state.pace?.gapMs || 0);
    const limit = Math.max(1, Math.min(perHost, state.pace?.perHost || perHost));
    if (state.active >= limit || state.queue.length)
      await new Promise((resolve) => state.queue.push(resolve));
    else state.active += 1;
    // The active permit limits concurrent transfers; this short start-only
    // baton serializes the *admission timestamp*, not the transfer. Two
    // overdue timers cannot both claim the same instant after a late wakeup.
    const priorStart = state.startTurn;
    let finishStart;
    state.startTurn = new Promise((resolve) => { finishStart = resolve; });
    await priorStart;
    try {
      for (;;) {
        const currentGap = Math.max(gapMs, state.pace?.gapMs || gap);
        const wait = state.last + currentGap - now();
        if (wait <= 0) break;
        await new Promise((resolve) => setTimeout(resolve, wait));
        // Re-read the actual clock and last admitted start after every wake.
      }
      state.last = now();
    } finally {
      finishStart();
    }
    try { return await task(); } finally {
      state.active -= 1;
      const currentLimit = Math.max(1, Math.min(perHost, state.pace?.perHost || perHost));
      while (state.active < currentLimit && state.queue.length) {
        state.active += 1; // Reserve the permit before resuming its queued owner.
        state.queue.shift()();
      }
      if (idle(state)) state.idleAt = now();
      pruneIdle();
    }
  };
}

function decode(buffer, encoding, maxBytes) {
  const options = { maxOutputLength: maxBytes };
  const kind = String(encoding || "").toLowerCase().trim();
  if (kind === "gzip" || kind === "x-gzip") return zlib.gunzipSync(buffer, options);
  if (kind === "br") return zlib.brotliDecompressSync(buffer, options);
  if (kind === "deflate") { try { return zlib.inflateSync(buffer, options); } catch { return zlib.inflateRawSync(buffer, options); } }
  return buffer;
}

export function createRemoteFetch({ lookup = dns.lookup, transport = { http, https }, limits = {}, now = Date.now, userAgent = BROWSER_UA,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const config = { ...LIMITS, ...limits };
  const jar = createSiteCookieJar({ now });
  const pace = hostPacer({ gapMs: config.gapMs, perHost: config.perHost, now });
  // Validate even injected DNS implementations at the final socket lookup.
  const checkedLookup = safeLookup(lookup);

  function once(url, { method, headers, body, timeoutMs, maxBytes }) {
    return new Promise((resolve, reject) => {
      const lib = url.protocol === "https:" ? transport.https : transport.http;
      const request = lib.request(url, { method, headers, lookup: checkedLookup, timeout: timeoutMs }, (response) => {
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > maxBytes) { request.destroy(Object.assign(new Error("The page is too large"), { status: 502 })); return; }
          chunks.push(chunk);
        });
        response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, raw: Buffer.concat(chunks) }));
        response.on("error", reject);
      });
      request.on("timeout", () => request.destroy(Object.assign(new Error("The site took too long to answer"), { status: 504 })));
      request.on("error", (error) => reject(error.code === "EPRIVATE" ? Object.assign(error, { status: 400 }) : error));
      if (body) request.write(body);
      request.end();
    });
  }

  // options: { method, headers, form (object -> urlencoded), referer, lang, accept, maxBytes, timeoutMs }
  async function request(input, options = {}) {
    let url = checkUrl(input);
    if (options.httpsOnly && url.protocol !== "https:")
      throw Object.assign(new Error("HTTPS is required for this download"), { status: 400 });
    const credentialOrigin = url.origin;
    let method = options.method || (options.form || options.json !== undefined ? "POST" : "GET");
    let body = options.form ? new URLSearchParams(options.form).toString() : options.json !== undefined ? JSON.stringify(options.json) : options.body ?? null;
    const bodyType = options.form ? "application/x-www-form-urlencoded; charset=UTF-8" : options.json !== undefined ? "application/json" : options.contentType || "text/plain;charset=UTF-8";
    const maxBytes = Math.min(options.maxBytes || config.maxBytes, 40 * 1024 * 1024);
    const maxDecodedBytes = Math.min(options.maxDecodedBytes || maxBytes, 40 * 1024 * 1024);
    for (let hop = 0; hop <= config.redirects; hop += 1) {
      const sameOrigin = url.origin === credentialOrigin;
      // Header values supplied by a site engine may include its auth tokens.
      // After a cross-origin redirect, forward only ordinary representation
      // hints; the destination receives its own host-scoped cookies.
      const crossOriginHeader = /^(?:accept|accept-language|accept-encoding|content-type|user-agent|cache-control|x-requested-with|range)$/i;
      const suppliedHeaders = Object.fromEntries(Object.entries(options.headers || {})
        .filter(([key]) => !/^(?:host|connection|proxy-authorization|transfer-encoding|content-length)$/i.test(key)
          && (sameOrigin || crossOriginHeader.test(key))));
      const headers = {
        "User-Agent": userAgent,
        Accept: options.accept || "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": options.lang ? `${options.lang},en;q=0.8` : "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        ...(options.referer && sameOrigin ? { Referer: options.referer } : {}),
        ...(body !== null ? { "Content-Type": bodyType, "Content-Length": Buffer.byteLength(body) } : {}),
        ...suppliedHeaders,
      };
      const explicitCookie = Object.keys(headers).some((key) => /^cookie$/i.test(key));
      const cookie = [jar.header(url), sameOrigin ? options.cookies || "" : ""].filter(Boolean).join("; ");
      if (cookie) {
        if (explicitCookie) {
          const previous = Object.keys(headers).find((key) => /^cookie$/i.test(key));
          headers[previous] = [headers[previous], cookie].filter(Boolean).join("; ");
        } else headers.Cookie = cookie;
      }
      const current = url;
      let result;
      for (let attempt = 0; ; attempt += 1) {
        const canRetry = method === "GET" && attempt < config.retryDelays.length;
        try {
          result = await pace(url.hostname, () => once(current, { method, headers, body, timeoutMs: options.timeoutMs || config.timeoutMs, maxBytes }), options.pace || null);
        } catch (error) {
          // A dropped connection is tried again; a timeout isn't (it already took the full time).
          if (!canRetry || !(/^(?:ECONNRESET|EPIPE|ECONNABORTED)$/.test(error.code || "") || /socket hang up/i.test(error.message || ""))) throw error;
          await sleep(config.retryDelays[attempt]);
          continue;
        }
        jar.store(url, result.headers["set-cookie"]);
        if (!canRetry || !RETRY_STATUS.has(result.status)) break;
        let peek = null;
        try { peek = decode(result.raw, result.headers["content-encoding"], maxDecodedBytes); } catch {}
        if (peek && isBotCheck({ status: result.status, headers: result.headers, buffer: peek })) break;
        const after = Number(result.headers["retry-after"]);
        await sleep(Number.isFinite(after) && after >= 0 ? Math.min(10_000, after * 1000) : config.retryDelays[attempt]);
      }
      if ([301, 302, 303, 307, 308].includes(result.status) && result.headers.location) {
        const next = checkUrl(new URL(result.headers.location, url).href);
        if (options.httpsOnly && next.protocol !== "https:")
          throw Object.assign(new Error("HTTPS is required for this download"), { status: 400 });
        // A site that moved domain (kagane.cx -> kagane.moe) answers every path with the same
        // path on the new host; its API posts must stay posts there. Other 301/302s after a POST
        // turn into a GET, as in browsers.
        const moved = next.host !== url.host && next.pathname === url.pathname && next.search === url.search && next.protocol === url.protocol;
        url = next;
        if (!moved && (result.status === 303 || ((result.status === 301 || result.status === 302) && method === "POST"))) { method = "GET"; body = null; }
        continue;
      }
      let buffer;
      try { buffer = decode(result.raw, result.headers["content-encoding"], maxDecodedBytes); } catch { throw Object.assign(new Error("The site sent an unreadable answer"), { status: 502 }); }
      return {
        status: result.status,
        ok: result.status >= 200 && result.status < 300,
        url: url.href,
        headers: result.headers,
        buffer,
        text: () => buffer.toString("utf8"),
        json: () => JSON.parse(buffer.toString("utf8")),
      };
    }
    throw Object.assign(new Error("Too many redirects"), { status: 502 });
  }
  return { request };
}

// A Cloudflare or similar check page instead of the content.
export function isBotCheck(response) {
  if (!response) return false;
  if (response.headers?.["cf-mitigated"] === "challenge") return true;
  if (![403, 429, 503].includes(response.status)) return false;
  const head = response.buffer.subarray(0, 4000).toString("utf8");
  return /<title>\s*(?:Just a moment|Attention Required|Un momento|DDoS-Guard)/i.test(head) || /cf-chl-|challenge-platform/i.test(head);
}
