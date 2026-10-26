/**
 * Letterboxd has no open API, so two ways in:
 * - the public profile feed (letterboxd.com/<user>/rss/): your latest diary entries, with the
 *   star rating, watched date and TMDB id; read again on every sync, so history builds up
 * - the account export (Settings › Data › Export your data): a .zip (or its ratings.csv,
 *   watched.csv or diary.csv) with your whole history, matched to TMDB by title and year
 * Stars (0.5–5) become 1–10: 4.5 stars is 9.00.
 */
import AdmZip from "adm-zip";

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'" };
const decode = (value) => String(value || "")
  .replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, "$1")
  .replace(/&(#\d+|#x[a-f0-9]+|[a-z]+);/gi, (match, entity) => {
    if (ENTITIES[entity]) return ENTITIES[entity];
    if (entity.startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(Number(entity.slice(1)));
    return match;
  })
  .trim();

const tag = (block, name) => {
  const match = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return match ? decode(match[1]) : "";
};

/** 0.5–5 stars as 1–10 with two decimals; no rating → null. */
export function starsToScore(value) {
  const stars = Number(value);
  return Number.isFinite(stars) && stars > 0 ? Math.round(Math.min(10, Math.max(1, stars * 2)) * 100) / 100 : null;
}


/** Diary entries from the profile feed (lists and other posts are skipped). */
export function parseLetterboxdRss(xml) {
  const entries = [];
  for (const block of String(xml || "").split("<item>").slice(1)) {
    const title = tag(block, "letterboxd:filmTitle");
    if (!title) continue;
    const tmdbId = tag(block, "tmdb:movieId");
    const watched = tag(block, "letterboxd:watchedDate");
    const ratedAt = /^\d{4}-\d{2}-\d{2}$/.test(watched) ? Date.parse(`${watched}T12:00:00Z`) : null;
    const year = Number(tag(block, "letterboxd:filmYear")) || null;
    entries.push({
      key: filmKey(title, year),
      itemId: tmdbId ? `tmdb:movie:${tmdbId}` : null,
      title,
      kind: "movie",
      year,
      score: starsToScore(tag(block, "letterboxd:memberRating")),
      status: "WATCHED",
      ratedAt,
      updatedAt: ratedAt || Date.now(),
    });
  }
  return keepLatest(entries);
}

// The same film more than once (rewatches, feed plus export): an entry with a rating wins,
// then the newest one.
function keepLatest(entries) {
  const better = (entry, current) => {
    const rated = Number.isFinite(entry.score);
    if (rated !== Number.isFinite(current.score)) return rated;
    return (entry.ratedAt || 0) > (current.ratedAt || 0);
  };
  const byKey = new Map();
  for (const entry of entries) {
    const current = byKey.get(entry.key);
    if (!current || better(entry, current)) byKey.set(entry.key, current?.itemId && !entry.itemId ? { ...entry, itemId: current.itemId } : entry);
  }
  return [...byKey.values()];
}

/** One key per film for the feed and the export alike (the export has no TMDB ids). */
export function filmKey(title, year) {
  const name = String(title || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `film:${name}:${Number(year) || ""}`;
}

export async function fetchLetterboxdFeed(username, { fetchImpl = globalThis.fetch, timeoutMs = 15_000 } = {}) {
  const supplied = String(username || "").trim();
  let name = supplied;
  if (/^https?:\/\//i.test(supplied)) {
    let url;
    try { url = new URL(supplied); } catch { /* rejected by username validation below */ }
    if (url && ["letterboxd.com", "www.letterboxd.com"].includes(url.hostname.toLowerCase())
        && /^\/[A-Za-z0-9_]{2,40}\/?$/.test(url.pathname)) name = url.pathname.split("/")[1];
  } else {
    name = supplied.replace(/^@/, "");
  }
  if (!/^[A-Za-z0-9_]{2,40}$/.test(name)) throw Object.assign(new Error("Enter your Letterboxd user name"), { statusCode: 400 });
  const response = await fetchImpl(`https://letterboxd.com/${encodeURIComponent(name)}/rss/`, {
    headers: { Accept: "application/rss+xml, application/xml;q=0.9", "User-Agent": "Mozilla/5.0 (LVL)" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status === 404) throw Object.assign(new Error("That Letterboxd user wasn't found."), { statusCode: 404 });
  if (!response.ok) throw Object.assign(new Error(`Letterboxd answered HTTP ${response.status}`), { statusCode: 502 });
  const xml = await response.text();
  if (!/<rss\b/i.test(xml) || !/<channel\b/i.test(xml))
    throw Object.assign(new Error("Letterboxd did not return a public RSS feed. Try again later or import your account export."), { statusCode: 502 });
  const entries = parseLetterboxdRss(xml);
  if (!entries.length)
    throw Object.assign(new Error("No recent films appeared in this public Letterboxd feed. For all your ratings, import your Letterboxd export (.zip)."), { statusCode: 422 });
  return { username: name, entries };
}

/** RFC 4180 CSV (quoted fields, doubled quotes, line breaks inside quotes). */
export function parseCsv(textValue) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const input = String(textValue || "").replace(/^\uFEFF/, "");
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') { field += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { row.push(field); field = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header = [], ...body] = rows.filter((cells) => cells.some((cell) => cell.trim()));
  const names = header.map((name) => name.trim().toLowerCase());
  return body.map((cells) => Object.fromEntries(names.map((name, index) => [name, (cells[index] || "").trim()])));
}

/** Entries from ratings.csv, diary.csv or watched.csv rows (Name, Year, Rating, Date or Watched Date, Letterboxd URI). */
export function letterboxdCsvEntries(rows = []) {
  return keepLatest(rows.filter((row) => row.name).map((row) => {
    const day = row["watched date"] || row.date || "";
    const ratedAt = /^\d{4}-\d{2}-\d{2}$/.test(day) ? Date.parse(`${day}T12:00:00Z`) : null;
    const year = Number(row.year) || null;
    return { key: filmKey(row.name, year), itemId: null, title: row.name, kind: "movie", year, score: starsToScore(row.rating), status: "WATCHED", ratedAt, updatedAt: ratedAt || Date.now() };
  }));
}

/** The export: a .zip (ratings, diary and watched are combined) or one of its CSV files. */
export function readLetterboxdExport(buffer) {
  const isZip = buffer[0] === 0x50 && buffer[1] === 0x4b;
  if (!isZip) return letterboxdCsvEntries(parseCsv(buffer.toString("utf8")));
  const zip = new AdmZip(buffer);
  const read = (name) => {
    const entry = zip.getEntries().find((candidate) => candidate.entryName.toLowerCase().replace(/^.*\//, "") === name);
    return entry ? parseCsv(entry.getData().toString("utf8")) : [];
  };
  // Watched first, then diary and ratings, so a rating wins over a plain "watched".
  return keepLatest([...letterboxdCsvEntries(read("watched.csv")), ...letterboxdCsvEntries(read("diary.csv")), ...letterboxdCsvEntries(read("ratings.csv"))]
    .map((entry, order) => ({ ...entry, ratedAt: entry.ratedAt ?? order })));
}
