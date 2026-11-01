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

export const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
// A GET answered with a server error (5xx, Cloudflare's 52x) is tried again
// after these waits; Retry-After is honored up to 10 s.
const LIMITS = Object.freeze({ timeoutMs: 25_000, maxBytes: 8 * 1024 * 1024, redirects: 5, gapMs: 300, perHost: 3, retryDelays: [1000, 3000] });
const RETRY_STATUS = new Set([500, 502, 503, 504, 520, 521, 522, 523, 524]);

function ipv4Private(address) {
  const [a, b, c] = address.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

export function isPublicAddress(address) {
  const kind = net.isIP(String(address));
  if (kind === 4) return !ipv4Private(address);
  if (kind !== 6) return false;
  const lower = address.toLowerCase();
  const mapped = /^(?:0*:)*:?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower) || /^::(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return !ipv4Private(mapped[1]);
  if (lower === "::" || lower === "::1") return false;
  return !/^(?:f[cd]|fe[89ab]|ff)/.test(lower) && !lower.startsWith("64:ff9b:") && !lower.startsWith("2001:db8");
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
export function safeLookup(resolve = dns.lookup) {
  return (hostname, options, callback) => {
    const cb = typeof options === "function" ? options : callback;
    const opts = typeof options === "object" && options ? options : {};
    resolve(hostname, { ...opts, all: true }, (error, addresses) => {
      if (error) return cb(error);
      const list = (Array.isArray(addresses) ? addresses : [{ address: addresses, family: net.isIP(addresses) }]).filter((item) => isPublicAddress(item.address));
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

function cookieJar() {
  const jars = new Map();
  const site = (host) => host.split(".").slice(-2).join(".");
  return {
    header(url) {
      const jar = jars.get(site(url.hostname));
      return jar && jar.size ? [...jar].map(([name, value]) => `${name}=${value}`).join("; ") : "";
    },
    store(url, setCookie) {
      if (!setCookie) return;
      const key = site(url.hostname);
      const jar = jars.get(key) || new Map();
      for (const line of [].concat(setCookie)) {
        const pair = /^\s*([^=;\s]{1,100})=([^;]{0,2000})/.exec(line);
        if (!pair) continue;
        if (/;\s*max-age=0\b|;\s*expires=thu, 01 jan 1970/i.test(line)) jar.delete(pair[1]);
        else jar.set(pair[1], pair[2]);
      }
      if (jar.size > 60) jar.delete(jar.keys().next().value);
      jars.set(key, jar);
      if (jars.size > 300) jars.delete(jars.keys().next().value);
    },
  };
}

// Paces requests per host: at most `perHost` at once, `gapMs` between starts.
// A request can ask for a slower pace for its host (a site's speed setting);
// later requests to that host (its images) keep it.
function hostPacer({ gapMs, perHost, now }) {
  const hosts = new Map();
  return async function run(host, task, pace = null) {
    const state = hosts.get(host) || { active: 0, last: 0, queue: [], pace: null };
    hosts.set(host, state);
    if (pace) state.pace = pace;
    const gap = Math.max(gapMs, state.pace?.gapMs || 0);
    const limit = Math.max(1, Math.min(perHost, state.pace?.perHost || perHost));
    if (state.active >= limit) await new Promise((resolve) => state.queue.push(resolve));
    state.active += 1;
    const wait = state.last + gap - now();
    state.last = Math.max(now(), state.last + gap);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    try { return await task(); } finally {
      state.active -= 1;
      state.queue.shift()?.();
      if (!state.active && !state.queue.length && !state.pace && hosts.size > 200) hosts.delete(host);
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

export function createRemoteFetch({ lookup = safeLookup(), transport = { http, https }, limits = {}, now = Date.now, userAgent = BROWSER_UA,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const config = { ...LIMITS, ...limits };
  const jar = cookieJar();
  const pace = hostPacer({ gapMs: config.gapMs, perHost: config.perHost, now });

  function once(url, { method, headers, body, timeoutMs, maxBytes }) {
    return new Promise((resolve, reject) => {
      const lib = url.protocol === "https:" ? transport.https : transport.http;
      const request = lib.request(url, { method, headers, lookup, timeout: timeoutMs }, (response) => {
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
    let method = options.method || (options.form || options.json !== undefined ? "POST" : "GET");
    let body = options.form ? new URLSearchParams(options.form).toString() : options.json !== undefined ? JSON.stringify(options.json) : options.body ?? null;
    const bodyType = options.form ? "application/x-www-form-urlencoded; charset=UTF-8" : options.json !== undefined ? "application/json" : options.contentType || "text/plain;charset=UTF-8";
    const maxBytes = Math.min(options.maxBytes || config.maxBytes, 40 * 1024 * 1024);
    for (let hop = 0; hop <= config.redirects; hop += 1) {
      const headers = {
        "User-Agent": userAgent,
        Accept: options.accept || "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": options.lang ? `${options.lang},en;q=0.8` : "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        ...(options.referer ? { Referer: options.referer } : {}),
        ...(body !== null ? { "Content-Type": bodyType, "Content-Length": Buffer.byteLength(body) } : {}),
        ...(options.headers || {}),
      };
      const cookie = [jar.header(url), options.cookies || ""].filter(Boolean).join("; ");
      if (cookie) headers.Cookie = cookie;
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
        try { peek = decode(result.raw, result.headers["content-encoding"], maxBytes); } catch {}
        if (peek && isBotCheck({ status: result.status, headers: result.headers, buffer: peek })) break;
        const after = Number(result.headers["retry-after"]);
        await sleep(Number.isFinite(after) && after >= 0 ? Math.min(10_000, after * 1000) : config.retryDelays[attempt]);
      }
      if ([301, 302, 303, 307, 308].includes(result.status) && result.headers.location) {
        const next = checkUrl(new URL(result.headers.location, url).href);
        // A site that moved domain (kagane.cx -> kagane.moe) answers every path with the same
        // path on the new host; its API posts must stay posts there. Other 301/302s after a POST
        // turn into a GET, as in browsers.
        const moved = next.host !== url.host && next.pathname === url.pathname && next.search === url.search && next.protocol === url.protocol;
        url = next;
        if (!moved && (result.status === 303 || ((result.status === 301 || result.status === 302) && method === "POST"))) { method = "GET"; body = null; }
        continue;
      }
      let buffer;
      try { buffer = decode(result.raw, result.headers["content-encoding"], maxBytes); } catch { throw Object.assign(new Error("The site sent an unreadable answer"), { status: 502 }); }
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
