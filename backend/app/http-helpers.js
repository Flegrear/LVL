// Small HTTP helpers for LVL's own server: JSON replies, request bodies, bounded reads, local-only checks.
import fs from "node:fs";
import crypto from "node:crypto";
import net from "node:net";
import { port } from "../../server.js";

const MAX_BODY_BYTES = 64 * 1024;

const STREAM_UPSTREAM_TIMEOUT_MS = 12 * 1000;

export function json(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

export function methodNotAllowed(res, allowed) {
  json(res, 405, { error: "Method not allowed" }, { Allow: allowed.join(", ") });
  return true;
}

export async function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error("Request body too large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Invalid JSON body");
    error.statusCode = 400;
    throw error;
  }
}

export function isPrivateOrReservedIp(address) {
  const normalized = String(address || "").trim().toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  const family = net.isIP(normalized);
  if (family === 4) {
    const [a, b, c] = normalized.split(".").map(Number);
    return a === 0
      || a === 10
      || a === 127
      || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 0 && (c === 0 || c === 2))
      || (a === 192 && b === 168)
      || (a === 192 && b === 88 && c === 99)
      || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113);
  }
  if (family === 6) {
    return normalized.startsWith("::")
      || /^f[cd]/.test(normalized)
      || /^fe[89ab]/.test(normalized)
      || /^fe[c-f]/.test(normalized)
      || normalized.startsWith("ff")
      || normalized.startsWith("2001:db8:");
  }
  return false;
}

export async function readBinaryBody(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error(`That file is too large (max ${Math.round(maxBytes / 1048576)} MB)`), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Other websites open in the browser can send requests to 127.0.0.1 too. For the deck, AnkiWeb
// and clip routes: only local host names are served (a DNS-rebinding page has another Host), and
// requests that change data must come from this app's own pages.
export function localRequestRejected(req, res) {
  const host = String(req.headers.host || "").toLowerCase();
  const localHost = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  if (!localHost.has(host)) {
    json(res, 403, { error: "This app only answers on 127.0.0.1" });
    return true;
  }
  if (req.method === "GET" || req.method === "HEAD") return false;
  const site = String(req.headers["sec-fetch-site"] || "").toLowerCase();
  const origin = typeof req.headers.origin === "string" ? req.headers.origin.toLowerCase() : "";
  if ((site && site !== "same-origin" && site !== "none") || (origin && origin !== `http://${host}`)) {
    json(res, 403, { error: "Requests from other sites can't change this app's data" });
    return true;
  }
  return false;
}

export function sendStoredFile(req, res, { file, type, bytes }, { cacheControl = "private, max-age=86400", extraHeaders = {} } = {}) {
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ""));
  const base = { "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": cacheControl, "X-Content-Type-Options": "nosniff", ...extraHeaders };
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, bytes - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(bytes - 1, Number(range[2])) : bytes - 1;
    if (start > end || start >= bytes) {
      res.writeHead(416, { "Content-Range": `bytes */${bytes}` });
      res.end();
      return;
    }
    res.writeHead(206, { ...base, "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${bytes}` });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file, { start, end }).on("error", () => res.destroy()).pipe(res);
    return;
  }
  res.writeHead(200, { ...base, "Content-Length": bytes });
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(file).on("error", () => res.destroy()).pipe(res);
}

export function boundedInteger(value, min = 1, max = 10_000) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) return undefined;
  return number;
}

export async function readBoundedResponse(response, maxBytes) {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) throw Object.assign(new Error("Upstream file is too large"), { statusCode: 413 });
  if (!response.body) return Buffer.alloc(0);

  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > maxBytes) {
      throw Object.assign(new Error("Upstream file is too large"), { statusCode: 413 });
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function pruneTimedCache(cache, maxEntries = 80) {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (!entry || entry.expiresAt <= now) cache.delete(key);
  }
  while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
}

export async function fetchUpstreamJson(url, timeoutMs = STREAM_UPSTREAM_TIMEOUT_MS) {
  const upstream = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "LVL/0.1",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!upstream.ok) {
    const error = new Error(`Upstream request failed with HTTP ${upstream.status}`);
    error.statusCode = 502;
    throw error;
  }
  const payload = await upstream.json().catch(() => null);
  if (!payload || typeof payload !== "object") {
    const error = new Error("Upstream provider returned invalid JSON");
    error.statusCode = 502;
    throw error;
  }
  return payload;
}

export function cacheableJson(req, res, payload, etagSeed) {
  const body = JSON.stringify(payload);
  const etag = `"${crypto.createHash("sha256").update(String(etagSeed)).digest("base64url").slice(0, 22)}"`;
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "public, max-age=3600, must-revalidate",
    ETag: etag,
    "X-Content-Type-Options": "nosniff",
  };
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, { "Cache-Control": headers["Cache-Control"], ETag: etag });
    res.end();
    return;
  }
  res.writeHead(200, headers);
  res.end(req.method === "HEAD" ? undefined : body);
}
