// Subtitle files from the web: provider keys, safe download addresses and the downloads kept for a while.
import { default as crypto } from "node:crypto";
import { default as dns } from "node:dns/promises";
import { default as net } from "node:net";
import { remoteSubtitleDownloads } from "../../server.js";
import { isPrivateOrReservedIp } from "../app/http-helpers.js";
import { normalizeSubtitleLanguage } from "./subtitle-search.js";

export function getSubdlApiKey(req, body = {}) {
  const headerKey = req.headers["x-subdl-api-key"];
  const auth = req.headers.authorization;
  const bearerKey = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const bodyKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  const environmentKey = typeof process.env.SUBDL_API_KEY === "string" ? process.env.SUBDL_API_KEY.trim() : "";
  const key = (Array.isArray(headerKey) ? headerKey[0] : headerKey) || bearerKey || bodyKey || environmentKey;
  if (!key || key.length > 512) {
    const error = new Error("A SubDL API key is required in the app or SUBDL_API_KEY environment variable");
    error.statusCode = 401;
    throw error;
  }
  return key;
}

export function optionalProviderKey(body, bodyField, environmentField) {
  const bodyKey = typeof body?.[bodyField] === "string" ? body[bodyField].trim() : "";
  const environmentKey = typeof process.env[environmentField] === "string" ? process.env[environmentField].trim() : "";
  const key = bodyKey || environmentKey;
  return key && key.length <= 512 ? key : "";
}

export function pruneRemoteSubtitleDownloads() {
  const now = Date.now();
  for (const [token, record] of remoteSubtitleDownloads) {
    if (!record || record.expiresAt <= now) remoteSubtitleDownloads.delete(token);
  }
  while (remoteSubtitleDownloads.size > 300) remoteSubtitleDownloads.delete(remoteSubtitleDownloads.keys().next().value);
}

function parseRemoteSubtitleUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || "")); } catch { return null; }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || String(value).length > 2048) return null;
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || isPrivateOrReservedIp(hostname)) return null;
  return parsed;
}

async function assertPublicRemoteSubtitleTarget(url) {
  const parsed = parseRemoteSubtitleUrl(url);
  if (!parsed) throw Object.assign(new Error("Subtitle provider returned an unsafe download URL"), { statusCode: 502 });
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(hostname)) return parsed;
  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw Object.assign(new Error("Subtitle download host could not be resolved"), { statusCode: 502 });
  }
  if (!addresses.length || addresses.some((record) => isPrivateOrReservedIp(record.address))) {
    throw Object.assign(new Error("Subtitle download host resolved to a private or reserved address"), { statusCode: 502 });
  }
  return parsed;
}

export async function fetchRemoteSubtitleDownload(remote) {
  const original = await assertPublicRemoteSubtitleTarget(remote.url);
  const originalOrigin = original.origin;
  let current = original;
  const signal = AbortSignal.timeout(15_000);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    current = await assertPublicRemoteSubtitleTarget(current);
    const response = await fetch(current, {
      headers: current.origin === originalOrigin ? remote.headers : {},
      redirect: "manual",
      signal,
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return { response, finalUrl: current };
    const location = response.headers.get("location");
    if (!location) return { response, finalUrl: current };
    if (redirects >= 3) {
      await response.body?.cancel().catch(() => {});
      throw Object.assign(new Error("Subtitle download redirected too many times"), { statusCode: 502 });
    }
    let next;
    try { next = new URL(location, current); } catch {
      await response.body?.cancel().catch(() => {});
      throw Object.assign(new Error("Subtitle provider returned an invalid redirect URL"), { statusCode: 502 });
    }
    await response.body?.cancel().catch(() => {});
    current = next;
  }
  throw Object.assign(new Error("Subtitle download redirected too many times"), { statusCode: 502 });
}

export function registerRemoteSubtitleDownload({ url, headers = {}, label = "subtitle.srt", language = "", provider = "REMOTE" }) {
  const parsed = parseRemoteSubtitleUrl(url);
  if (!parsed) return null;
  pruneRemoteSubtitleDownloads();
  const token = crypto.randomBytes(18).toString("hex");
  remoteSubtitleDownloads.set(token, {
    url: parsed.toString(),
    headers: Object.fromEntries(Object.entries(headers).filter(([key, value]) => typeof key === "string" && typeof value === "string")),
    label: String(label || "subtitle.srt").slice(0, 500),
    language: normalizeSubtitleLanguage(language),
    provider: String(provider || "REMOTE").slice(0, 80),
    expiresAt: Date.now() + 20 * 60 * 1000,
  });
  return `remote:${token}`;
}
