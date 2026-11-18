// A remote download token is an authorization handle, not an upstream item
// identity. Hash provider IDs or underlying URLs so equality never exposes a
// provider's signed URL in API responses.
import { createHash } from "node:crypto";

export function wyzieItemIdentity(item) {
  const source = Array.isArray(item?.source) ? item.source.join(" + ") : String(item?.source || "");
  const id = String(item?.id ?? "").trim();
  // wyzie-lib 2.5.2 describes item.id as a *media* IMDb/TMDB identifier,
  // not a unique subtitle file ID. Distinct files from that media and source
  // must survive despite identical display strings and item.id values.
  let url;
  try { url = new URL(String(item?.url || "")); } catch { return ""; }
  if (url.protocol !== "https:" || url.username || url.password) return "";
  url.hash = "";
  // Signed URLs can gain a new credential between release-filtered and broad
  // queries. Only durable location selectors contribute to item identity.
  for (const key of [...url.searchParams.keys()]) {
    if (/^(?:key|api[_-]?key|token|access[_-]?token|auth|authorization|signature|sig|expires?|expiry|timestamp|ts|policy)$/i.test(key))
      url.searchParams.delete(key);
  }
  url.searchParams.sort();
  const material = `wyzie\0${source.toLowerCase()}\0${id}\0${url.href}`;
  return `wyzie:${createHash("sha256").update(material).digest("hex")}`;
}
