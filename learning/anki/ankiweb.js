// ankiweb.js: AnkiWeb's shared decks (https://ankiweb.net/shared/decks) for the Study page:
// search by keyword (ordered by rating, like the site), read one deck's details and download its
// .apkg so the app can store it. Uses the same public service the AnkiWeb site calls (protobuf
// responses, no account needed). Only decks the learner picks are downloaded. Node only.

const ANKIWEB = "https://ankiweb.net";
const USER_AGENT = "language-video-learner (local study app)";
const SEARCH_TTL_MS = 6 * 60 * 60 * 1000;
const SEARCH_STALE_MS = 7 * 24 * 60 * 60 * 1000;

/* ---------------------------------------------------------------- protobuf */

function readMessage(bytes) {
  const buffer = Buffer.from(bytes || []);
  const fields = new Map();
  let offset = 0;
  const varint = () => {
    let result = 0n;
    let shift = 0n;
    while (offset < buffer.length) {
      const byte = buffer[offset++];
      result |= BigInt(byte & 0x7f) << shift;
      if (!(byte & 0x80)) break;
      shift += 7n;
    }
    return result;
  };
  while (offset < buffer.length) {
    const key = Number(varint());
    const number = key >> 3;
    const wire = key & 7;
    let value;
    if (wire === 0) value = varint();
    else if (wire === 2) {
      const length = Number(varint());
      value = buffer.subarray(offset, offset + length);
      offset += length;
    } else if (wire === 1) { value = buffer.subarray(offset, offset + 8); offset += 8; }
    else if (wire === 5) { value = buffer.subarray(offset, offset + 4); offset += 4; }
    else throw new Error(`Unexpected AnkiWeb response (wire type ${wire})`);
    if (!fields.has(number)) fields.set(number, []);
    fields.get(number).push(value);
  }
  return fields;
}

const number = (fields, no) => Number(fields.get(no)?.[0] ?? 0);
const text = (fields, no) => (fields.get(no)?.[0] ? Buffer.from(fields.get(no)[0]).toString("utf8") : "");

/* ---------------------------------------------------------------- requests */

export function createAnkiwebClient({ origin = ANKIWEB, now = Date.now } = {}) {
  const searchCache = new Map();
  const pendingSearches = new Map();

  async function ankiwebResponse(pathAndQuery, { timeoutMs = 20_000 } = {}) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await fetch(`${origin}${pathAndQuery}`, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(timeoutMs) });
      if (response.ok) return response;
      const retryHeader = response.headers.get("retry-after");
      const retrySeconds = retryHeader === null ? 1 + attempt : /^\d+(?:\.\d+)?$/.test(retryHeader)
        ? Number(retryHeader) : Math.max(0, (Date.parse(retryHeader) - now()) / 1000);
      await response.body?.cancel();
      const transient = response.status === 429 || response.status === 503;
      if (transient && attempt < 2 && Number.isFinite(retrySeconds) && retrySeconds <= 3) {
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, retrySeconds) * 1000));
        continue;
      }
      const message = response.status === 429
        ? `AnkiWeb is busy. Try again${retrySeconds > 0 ? ` in ${Math.ceil(retrySeconds)} seconds` : " shortly"}, or download a deck from ankiweb.net and use Import file (.apkg).`
        : `AnkiWeb answered ${response.status}. Try again or use Import file (.apkg).`;
      throw Object.assign(new Error(message), { statusCode: response.status === 429 ? 429 : response.status === 404 ? 404 : 502 });
    }
  }

  async function ankiwebGet(pathAndQuery, options) {
    const response = await ankiwebResponse(pathAndQuery, options);
    return new Uint8Array(await response.arrayBuffer());
  }

  /** Shared decks matching a search, best rated first: [{ id, title, rating, thumbsUp, thumbsDown, modified, notes, audio, images }]. */
  async function searchSharedDecks(query) {
    const search = String(query || "").trim().slice(0, 120);
    const key = search.toLowerCase();
    const cached = searchCache.get(key);
    if (cached && cached.expiresAt > now()) return cached.value;
    if (pendingSearches.has(key)) return pendingSearches.get(key);
    const request = (async () => {
      let bytes;
      try { bytes = await ankiwebGet(`/svc/shared/list-decks?${new URLSearchParams({ search })}`); }
      catch (error) {
        if (cached && cached.staleUntil > now() && error.statusCode !== 404) {
          return Object.assign([...cached.value], { stale: true });
        }
        throw error;
      }
      const rows = (readMessage(bytes).get(1) || []).map((row) => {
        const fields = readMessage(row);
        const up = number(fields, 3);
        const down = number(fields, 4);
        return {
          id: number(fields, 1),
          title: text(fields, 2),
          thumbsUp: up,
          thumbsDown: down,
          rating: up + down ? up / (up + down) : 0,
          modified: number(fields, 5) * 1000,
          notes: number(fields, 6),
          audio: number(fields, 7),
          images: number(fields, 8),
        };
      }).filter((row) => row.id && row.title);
      // Wilson-style ordering: many votes and few downvotes first (AnkiWeb's "rating" order).
      const confidence = (row) => {
        const total = row.thumbsUp + row.thumbsDown;
        if (!total) return 0;
        const p = row.thumbsUp / total;
        const z = 1.64;
        return (p + (z * z) / (2 * total) - z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total)) / (1 + (z * z) / total);
      };
      rows.sort((a, b) => confidence(b) - confidence(a) || b.thumbsUp - a.thumbsUp);
      searchCache.set(key, { value: rows, expiresAt: now() + SEARCH_TTL_MS, staleUntil: now() + SEARCH_STALE_MS });
      while (searchCache.size > 60) searchCache.delete(searchCache.keys().next().value);
      return rows;
    })();
    pendingSearches.set(key, request);
    try { return await request; } finally { pendingSearches.delete(key); }
  }

  /** One deck's details plus the key its download needs. */
  async function sharedDeckInfo(id) {
    const sharedId = Math.trunc(Number(id));
    if (!(sharedId > 0)) throw Object.assign(new Error("A shared deck id is required"), { statusCode: 400 });
    const bytes = await ankiwebGet(`/svc/shared/item-info?${new URLSearchParams({ sharedId: String(sharedId) })}`);
    const response = readMessage(bytes);
    const available = response.get(1)?.[0];
    if (!available) throw Object.assign(new Error(response.get(3) ? "AnkiWeb doesn't allow downloading this deck" : "This deck is no longer shared on AnkiWeb"), { statusCode: 404 });
    const item = readMessage(available);
    const deck = item.get(10)?.[0] ? readMessage(item.get(10)[0]) : null;
    if (!deck) throw Object.assign(new Error("That AnkiWeb item is not a deck"), { statusCode: 422 });
    return {
      id: sharedId,
      title: text(item, 5),
      tags: text(item, 6),
      size: number(item, 7),
      lastUpdated: number(item, 8) * 1000,
      description: text(item, 9),
      thumbsUp: number(item, 18),
      thumbsDown: number(item, 19),
      originalName: text(item, 20),
      notes: number(deck, 1),
      audio: number(deck, 2),
      images: number(deck, 3),
      downloadKey: text(deck, 5),
    };
  }

  /**
   * Downloads a shared deck's .apkg. onProgress(received, total) is called as bytes arrive.
   * Returns { info, bytes }.
   */
  async function downloadSharedDeck(id, { maxBytes = 1024 * 1024 * 1024, onProgress = () => {}, timeoutMs = 20 * 60 * 1000 } = {}) {
    const info = await sharedDeckInfo(id);
    if (!info.downloadKey) throw Object.assign(new Error("AnkiWeb gave no download for this deck"), { statusCode: 502 });
    if (info.size > maxBytes) throw Object.assign(new Error(`This deck is ${Math.round(info.size / 1048576)} MB, over the ${Math.round(maxBytes / 1048576)} MB limit`), { statusCode: 413 });
    const response = await ankiwebResponse(`/svc/shared/download-deck/${info.id}?${new URLSearchParams({ t: info.downloadKey })}`, { timeoutMs });
    if (!response.ok || !response.body) throw Object.assign(new Error(`AnkiWeb download failed (${response.status})`), { statusCode: 502 });
    const total = Number(response.headers.get("content-length")) || info.size || 0;
    const chunks = [];
    let received = 0;
    for await (const chunk of response.body) {
      received += chunk.length;
      if (received > maxBytes) throw Object.assign(new Error("The download is larger than allowed"), { statusCode: 413 });
      chunks.push(Buffer.from(chunk));
      onProgress(received, total);
    }
    const bytes = Buffer.concat(chunks);
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw Object.assign(new Error("AnkiWeb didn't send an Anki package"), { statusCode: 502 });
    return { info, bytes };
  }

  return { searchSharedDecks, sharedDeckInfo, downloadSharedDeck };
}

const defaultClient = createAnkiwebClient();
export const searchSharedDecks = (...args) => defaultClient.searchSharedDecks(...args);
export const sharedDeckInfo = (...args) => defaultClient.sharedDeckInfo(...args);
export const downloadSharedDeck = (...args) => defaultClient.downloadSharedDeck(...args);

// Search words that find decks for each app language on AnkiWeb.
export const ANKIWEB_LANGUAGE_QUERIES = Object.freeze({
  EN: "english", ES: "spanish", FR: "french", DE: "german", IT: "italian", PT: "portuguese", JA: "japanese",
  KO: "korean", ZH: "chinese", RU: "russian", NL: "dutch", PL: "polish", TR: "turkish",
});
