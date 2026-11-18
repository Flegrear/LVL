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
  const [a, b, c, d] = address.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 192 && b === 0 && (c === 2 || (c === 0 && d !== 9 && d !== 10)))
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
  // Preserve existing mapped/compatible public IPv4 support above. Native
  // globally routed IPv6 must be in 2000::/3; transition tunnels can carry
  // private IPv4 destinations even when the outer IPv6 address looks public.
  if (words.slice(0, 7).every((value) => value === 0) && words[7] <= 1) return false;
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0 || (first & 0xff00) === 0xff00) return false;
  if (first === 0x64 && words[1] === 0xff9b) return false;
  if ((first & 0xe000) !== 0x2000) return false;
  if (first === 0x2002 || (first === 0x2001 && words[1] === 0)) return false; // 6to4 / Teredo
  if (first === 0x2001 && (words[1] === 0x0002 || (words[1] & 0xfff0) === 0x0010 || (words[1] & 0xfff0) === 0x0020))
    return false; // benchmarking and protocol-assignment ranges
  return !(first === 0x2001 && words[1] === 0x0db8); // documentation
}

export function checkUrl(value) {
  let url;
  try { url = new URL(String(value)); } catch { throw Object.assign(new Error("Invalid address"), { status: 400 }); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw Object.assign(new Error("Only web addresses can be fetched"), { status: 400 });
  if (url.username || url.password) throw Object.assign(new Error("Addresses with passwords aren't fetched"), { status: 400 });
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.+$/, "");
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
      const list = (Array.isArray(addresses) ? addresses : [{ address: addresses, family: net.isIP(addresses) }])
        .filter((item) => item && (net.isIP(item.address) === 4 || net.isIP(item.address) === 6)
          && (!item.family || item.family === net.isIP(item.address)) && isAllowed(item.address))
        .map((item) => ({ address: item.address, family: net.isIP(item.address) }));
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

function abortFailure(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return Object.assign(new Error("The request was cancelled"), { name: "AbortError", code: "ABORT_ERR", status: 499 });
}

function waitFor(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortFailure(signal));
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); };
    const cancel = () => { cleanup(); reject(abortFailure(signal)); };
    timer = setTimeout(() => { cleanup(); resolve(); }, Math.max(0, ms));
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}

function observeAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortFailure(signal));
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", cancel);
    const cancel = () => { cleanup(); reject(abortFailure(signal)); };
    signal.addEventListener("abort", cancel, { once: true });
    Promise.resolve(promise).then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); },
    );
    if (signal.aborted) cancel();
  });
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
  return async function run(host, task, pace = null, signal = null) {
    if (signal?.aborted) throw abortFailure(signal);
    pruneIdle();
    const state = hosts.get(host) || { active: 0, last: 0, queue: [], pace: null, idleAt: null, startTurn: Promise.resolve() };
    if (hosts.has(host)) hosts.delete(host);
    hosts.set(host, state);
    state.idleAt = null;
    if (pace) state.pace = pace;
    const gap = Math.max(gapMs, state.pace?.gapMs || 0);
    const limit = Math.max(1, Math.min(perHost, state.pace?.perHost || perHost));
    if (state.active >= limit || state.queue.length) {
      await new Promise((resolve, reject) => {
        const owner = { resume: () => { signal?.removeEventListener("abort", cancel); resolve(); } };
        const cancel = () => {
          const index = state.queue.indexOf(owner);
          if (index === -1) return; // Already admitted: the owner's finally releases the permit.
          state.queue.splice(index, 1);
          signal?.removeEventListener("abort", cancel);
          if (idle(state)) state.idleAt = now();
          pruneIdle();
          reject(abortFailure(signal));
        };
        state.queue.push(owner);
        signal?.addEventListener("abort", cancel, { once: true });
        if (signal?.aborted) cancel();
      });
    } else state.active += 1;
    try {
      if (signal?.aborted) throw abortFailure(signal);
      // The active permit limits concurrent transfers. This short baton
      // serializes the admission timestamp, not the transfer.
      const priorStart = state.startTurn;
      let finishStart;
      state.startTurn = new Promise((resolve) => { finishStart = resolve; });
      try {
        await observeAbort(priorStart, signal);
        for (;;) {
          const currentGap = Math.max(gapMs, state.pace?.gapMs || gap);
          const wait = state.last + currentGap - now();
          if (wait <= 0) break;
          await waitFor(wait, signal);
        }
        if (signal?.aborted) throw abortFailure(signal);
        state.last = now();
      } finally {
        finishStart();
      }
      return await task();
    } finally {
      state.active -= 1;
      const currentLimit = Math.max(1, Math.min(perHost, state.pace?.perHost || perHost));
      while (state.active < currentLimit && state.queue.length) {
        state.active += 1; // Reserve the permit before resuming its queued owner.
        state.queue.shift().resume();
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
  // Identity/no encoding previously bypassed maxDecodedBytes if maxBytes
  // allowed a larger wire response.
  if (buffer.length > maxBytes) throw new Error("Decoded body is too large");
  return buffer;
}

// A verified repository replacement may move a *public* source search POST
// from one origin to another. Tokens and arbitrary request bodies cannot make
// that move. All origin, source and revision evidence is checked again by a
// transport-owner verifier immediately before the foreign request is sent.
const CLIENT_BOUND_FIELD = /(?:token|secret|auth|cookie|passw(?:ord|d)|session|csrf|signature|nonce|api[-_]?key|client[-_]?key|private[-_]?key)|^key$/i;
function hasClientBoundFields(value, depth = 0) {
  if (depth > 12) return true;
  if (!value || typeof value !== "object") return false;
  if (value instanceof URLSearchParams) return [...value.keys()].some((key) => CLIENT_BOUND_FIELD.test(key));
  if (Array.isArray(value)) return value.some((item) => hasClientBoundFields(item, depth + 1));
  return Object.entries(value).some(([key, item]) =>
    CLIENT_BOUND_FIELD.test(key) || hasClientBoundFields(item, depth + 1));
}

export function createRemoteFetch({ lookup = dns.lookup, transport = { http, https }, limits = {}, now = Date.now, userAgent = BROWSER_UA,
  sleep = null, verifyRepositoryMigration = null } = {}) {
  const config = { ...LIMITS, ...limits };
  const jar = createSiteCookieJar({ now });
  const pace = hostPacer({ gapMs: config.gapMs, perHost: config.perHost, now });
  // Validate even injected DNS implementations at the final socket lookup.
  const checkedLookup = safeLookup(lookup);

  function once(url, { method, headers, body, timeoutMs, maxBytes, signal }) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(abortFailure(signal)); return; }
      const lib = url.protocol === "https:" ? transport.https : transport.http;
      let settled = false;
      let request;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", cancel);
        callback(value);
      };
      const cancel = () => request.destroy(abortFailure(signal));
      request = lib.request(url, { method, headers, lookup: checkedLookup, timeout: timeoutMs }, (response) => {
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          if (settled) return;
          size += chunk.length;
          if (size > maxBytes) {
            const error = Object.assign(new Error("The page is too large"), { status: 502 });
            finish(reject, error);
            request.destroy(error);
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => finish(resolve, { status: response.statusCode, headers: response.headers, raw: Buffer.concat(chunks) }));
        response.on("error", (error) => finish(reject, error));
        response.on("aborted", () => finish(reject, Object.assign(new Error("The site interrupted its answer"), { status: 502 })));
        response.on("close", () => {
          if (!settled) finish(reject, Object.assign(new Error("The site closed its answer"), { status: 502 }));
        });
      });
      request.on("timeout", () => request.destroy(Object.assign(new Error("The site took too long to answer"), { status: 504 })));
      request.on("error", (error) => finish(reject, error.code === "EPRIVATE" ? Object.assign(error, { status: 400 }) : error));
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) { cancel(); return; }
      if (body) request.write(body);
      request.end();
    });
  }

  // options: { method, headers, form (object -> urlencoded), referer, lang, accept, maxBytes, timeoutMs }
  // `migration` is *identity context*, not authority. Only the trusted
  // constructor's verifyRepositoryMigration callback can approve a POST hop.
  async function request(input, options = {}) {
    let url = checkUrl(input);
    if (options.httpsOnly && url.protocol !== "https:")
      throw Object.assign(new Error("HTTPS is required for this download"), { status: 400 });
    const credentialOrigin = url.origin;
    let method = options.method || (options.form || options.json !== undefined ? "POST" : "GET");
    let body = options.form ? new URLSearchParams(options.form).toString() : options.json !== undefined ? JSON.stringify(options.json) : options.body ?? null;
    let droppedBody = false;
    let migratedBody = false;
    let pendingMigration = null;
    const bodyType = options.form ? "application/x-www-form-urlencoded; charset=UTF-8" : options.json !== undefined ? "application/json" : options.contentType || "text/plain;charset=UTF-8";
    const maxBytes = Math.min(options.maxBytes || config.maxBytes, 40 * 1024 * 1024);
    const maxDecodedBytes = Math.min(options.maxDecodedBytes || maxBytes, 40 * 1024 * 1024);
    // One budget covers pacer queues, inter-request gaps, retries and all
    // redirects. Socket timeout alone begins too late for queued callers.
    const timeoutMs = Math.max(1, Math.min(Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : config.timeoutMs, 120_000));
    const controller = new AbortController();
    const signal = controller.signal;
    const externalCancel = () => controller.abort(options.signal?.reason instanceof Error ? options.signal.reason : abortFailure(options.signal));
    options.signal?.addEventListener("abort", externalCancel, { once: true });
    if (options.signal?.aborted) externalCancel();
    const timeout = setTimeout(() => controller.abort(Object.assign(new Error("The site took too long to answer"), { status: 504, code: "ETIMEDOUT" })), timeoutMs);
    const pause = (ms) => sleep ? observeAbort(Promise.resolve().then(() => sleep(ms)), signal) : waitFor(ms, signal);
    try {
    for (let hop = 0; hop <= config.redirects; hop += 1) {
      if (signal.aborted) throw abortFailure(signal);
      const sameOrigin = url.origin === credentialOrigin;
      // Header values supplied by a site engine may include its auth tokens.
      // After a cross-origin redirect, forward only ordinary representation
      // hints; the destination receives its own host-scoped cookies.
      const crossOriginHeader = /^(?:accept|accept-language|accept-encoding|user-agent|cache-control|range)$/i;
      const suppliedHeaders = Object.fromEntries(Object.entries(options.headers || {})
        .filter(([key, value]) => !/^(?:host|connection|proxy-authorization|transfer-encoding|content-length)$/i.test(key)
          && (!droppedBody || !/^(?:content-type|content-encoding)$/i.test(key))
          && (sameOrigin || crossOriginHeader.test(key)
            // An AJAX hint is harmless after a POST was converted to a
            // GET/HEAD; an unrelated origin is never given the original
            // caller's AJAX context, or a custom value for this header.
            || (droppedBody && /^(?:GET|HEAD)$/i.test(method)
              && /^x-requested-with$/i.test(key) && value === "XMLHttpRequest"))));
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
          result = await pace(url.hostname, async () => {
            if (pendingMigration) {
              // Verify at the final transport admission, *after* host pacing
              // and any queue wait, so a revoked source generation cannot
              // authorize a request that was merely queued earlier.
              const claim = pendingMigration;
              const proof = await verifyRepositoryMigration(claim);
              if (proof?.verified !== true || proof.sourceId !== claim.sourceId
                || proof.repositoryId !== claim.repositoryId || proof.revision !== claim.revision
                || proof.generation !== claim.generation
                || proof.previousOrigin !== claim.previousOrigin
                || proof.replacementOrigin !== claim.replacementOrigin)
                throw Object.assign(new Error("A request body cannot be redirected to another site"), { status: 400 });
              pendingMigration = null;
              if (signal.aborted) throw abortFailure(signal);
            }
            return once(current, { method, headers, body, timeoutMs, maxBytes, signal });
          }, options.pace || null, signal);
        } catch (error) {
          // A dropped connection is tried again; a timeout isn't (it already took the full time).
          if (signal.aborted || !canRetry || !(/^(?:ECONNRESET|EPIPE|ECONNABORTED)$/.test(error.code || "") || /socket hang up/i.test(error.message || ""))) throw error;
          await pause(config.retryDelays[attempt]);
          continue;
        }
        jar.store(url, result.headers["set-cookie"]);
        if (!canRetry || !RETRY_STATUS.has(result.status)) break;
        let peek = null;
        try { peek = decode(result.raw, result.headers["content-encoding"], maxDecodedBytes); } catch {}
        if (peek && isBotCheck({ status: result.status, headers: result.headers, buffer: peek })) break;
        const after = Number(result.headers["retry-after"]);
        await pause(Number.isFinite(after) && after >= 0 ? Math.min(10_000, after * 1000) : config.retryDelays[attempt]);
      }
      if ([301, 302, 303, 307, 308].includes(result.status) && result.headers.location) {
        const next = checkUrl(new URL(result.headers.location, url).href);
        if (options.httpsOnly && next.protocol !== "https:")
          throw Object.assign(new Error("HTTPS is required for this download"), { status: 400 });
        // A provider-controlled redirect is not evidence that its destination
        // belongs to the same source. Preserve POST across a foreign origin
        // only with a fresh, exact repository-backed migration grant.
        const moved = next.host !== url.host && next.pathname === url.pathname && next.search === url.search && next.protocol === url.protocol;
        const nextMethod = result.status === 303 && method !== "HEAD" ? "GET"
          : (result.status === 301 || result.status === 302) && method === "POST" && !moved ? "GET" : method;
        const nextBody = nextMethod === method ? body : null;
        if (next.origin !== url.origin && (nextBody !== null || !/^(?:GET|HEAD)$/i.test(nextMethod))) {
          const context = options.migration;
          const scoped = context && typeof context === "object"
            && /^-?\d{1,20}$/.test(String(context.sourceId ?? ""))
            && typeof context.repositoryId === "string" && context.repositoryId.length > 0
            && typeof context.revision === "string" && context.revision.length > 0
            && typeof context.generation === "string" && context.generation.length > 0;
          // Apply the check to the exact body that won request serialization:
          // form takes precedence over json. Both supplied at once must not
          // let safe JSON metadata disguise a credential-bearing form.
          const publicBody = options.form
            ? typeof options.form === "object" && !hasClientBoundFields(options.form)
            : options.json !== undefined && options.json && typeof options.json === "object"
              && !hasClientBoundFields(options.json);
          const eligible = typeof verifyRepositoryMigration === "function" && scoped && publicBody
              && method === "POST" && nextMethod === "POST" && !migratedBody && moved
              && url.origin === credentialOrigin && url.protocol === "https:" && next.protocol === "https:"
              && ![...url.searchParams.keys()].some((key) => CLIENT_BOUND_FIELD.test(key));
          if (!eligible) throw Object.assign(new Error("A request body cannot be redirected to another site"), { status: 400 });
          // The verifier is supplied by the trusted server, not a site
          // engine. It must consult current repository/source revision and
          // generation state at final socket admission. A request assertion
          // alone cannot grant its own migration authority.
          pendingMigration = {
            sourceId: context.sourceId, repositoryId: context.repositoryId,
            revision: context.revision, generation: context.generation,
            previousOrigin: credentialOrigin, replacementOrigin: next.origin,
            previousUrl: url.href, replacementUrl: next.href, status: result.status,
          };
          migratedBody = true;
        }
        url = next;
        method = nextMethod;
        if (body !== null && nextBody === null) droppedBody = true;
        body = nextBody;
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
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", externalCancel);
    }
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
