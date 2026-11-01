// Torrent searches for comics: The Pirate Bay's own search
// API (category 602 Comics; TPB+ is a video-only Stremio addon) and user Torznab
// indexers (Prowlarr/Jackett, category 7030 Comics). Results are magnets only.

export const PIRATEBAY_API = "https://apibay.org";
const TRACKERS = ["udp://tracker.opentrackr.org:1337/announce", "udp://open.stealth.si:80/announce", "udp://tracker.torrent.eu.org:451/announce",
  "udp://exodus.desync.com:6969/announce", "udp://tracker.openbittorrent.com:6969/announce"];

export const magnetFor = (hash, name) => `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(String(name || "").slice(0, 200))}${TRACKERS.map((tracker) => `&tr=${encodeURIComponent(tracker)}`).join("")}`;
export const validMagnet = (value) => /^magnet:\?xt=urn:btih:(?:[0-9a-f]{40}|[a-z2-7]{32})(?:&|$)/i.test(String(value || ""));

async function getText(url, { fetchImpl = globalThis.fetch, timeoutMs = 20_000 } = {}) {
  const response = await fetchImpl(url, { headers: { Accept: "application/json, application/xml, text/xml" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw Object.assign(new Error(`The source answered HTTP ${response.status}`), { status: response.status });
  const text = await response.text();
  if (text.length > 4 * 1024 * 1024) throw new Error("The source sent too much data");
  return text;
}

export function normalizePirateBay(items) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => /^[0-9a-f]{40}$/i.test(item?.info_hash || "") && item.info_hash !== "0000000000000000000000000000000000000000")
    .map((item) => ({
      name: String(item.name || "").slice(0, 300), size: Number(item.size) || 0, seeders: Number(item.seeders) || 0, leechers: Number(item.leechers) || 0,
      files: Number(item.num_files) || 0, added: Number(item.added) ? Number(item.added) * 1000 : null, magnet: magnetFor(item.info_hash.toLowerCase(), item.name),
    }))
    .filter((item) => item.seeders > 0)
    .sort((a, b) => b.seeders - a.seeders)
    .slice(0, 25);
}

export async function searchPirateBay(title, { category = 602, endpoint = PIRATEBAY_API, fetchImpl } = {}) {
  const query = String(title || "").trim().slice(0, 100);
  if (!query) return [];
  const text = await getText(`${endpoint}/q.php?${new URLSearchParams({ q: query, cat: String(category) })}`, { fetchImpl });
  let items;
  try { items = JSON.parse(text); } catch { throw new Error("The Pirate Bay sent an unreadable answer"); }
  return normalizePirateBay(items);
}

const decode = (value) => String(value || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").trim();

// Torznab RSS: <item><title/><size/><link/><enclosure url/><torznab:attr name="magneturl|seeders|size" value/></item>
export function parseTorznab(xml) {
  const items = [];
  for (const match of String(xml || "").matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const body = match[1];
    const tag = (name) => decode(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body)?.[1]);
    const attr = (name) => decode(new RegExp(`<torznab:attr[^>]*name="${name}"[^>]*value="([^"]*)"`).exec(body)?.[1]);
    const enclosure = decode(/<enclosure[^>]*url="([^"]*)"/.exec(body)?.[1]);
    const magnet = [attr("magneturl"), tag("link"), enclosure].find(validMagnet) || "";
    if (!magnet) continue;
    items.push({ name: tag("title").slice(0, 300), size: Number(attr("size") || tag("size")) || 0, seeders: Number(attr("seeders")) || 0, leechers: Number(attr("peers")) || 0, files: Number(attr("files")) || 0, added: Date.parse(tag("pubDate")) || null, magnet });
  }
  return items.filter((item) => item.seeders > 0).sort((a, b) => b.seeders - a.seeders).slice(0, 25);
}

export async function searchTorznab(title, { url, apiKey = "", category = 7030, fetchImpl } = {}) {
  const query = String(title || "").trim().slice(0, 100);
  if (!query || !url) return [];
  const target = new URL(url);
  if (!/\/api\/?$/.test(target.pathname)) target.pathname = `${target.pathname.replace(/\/+$/, "")}/api`;
  target.search = new URLSearchParams({ t: "search", q: query, cat: String(category), ...(apiKey ? { apikey: apiKey } : {}) }).toString();
  return parseTorznab(await getText(target.href, { fetchImpl }));
}
