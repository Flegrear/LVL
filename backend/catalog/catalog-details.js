/**
 * Extra details for a title page, read from a Cinemeta meta object: cast, writers, directors,
 * country, awards, status, first release date and YouTube trailers. Everything is checked and
 * trimmed here so the page can show it as plain text and safe links.
 */

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const MAX_PEOPLE = 12;
const MAX_TRAILERS = 4;

function cleanText(value, maxLength) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

/** Names from an array (or a comma-separated string), without blanks or repeats. */
export function cleanNames(value, limit = MAX_PEOPLE) {
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const seen = new Set();
  const names = [];
  for (const item of list) {
    const name = cleanText(typeof item === "object" && item ? item.name : item, 80);
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
    if (names.length >= limit) break;
  }
  return names;
}

/** "2023-09-29T00:00:00.000Z" → "2023-09-29"; anything else → "". */
export function isoDay(value) {
  const match = String(value ?? "").match(/^(\d{4})-(\d{2})-(\d{2})(?:$|T)/);
  if (!match) return "";
  const month = Number(match[2]);
  const day = Number(match[3]);
  return month >= 1 && month <= 12 && day >= 1 && day <= 31 ? `${match[1]}-${match[2]}-${match[3]}` : "";
}

/** YouTube trailers from `trailerStreams` ({ytId, title}) and `trailers` ({source, type}). */
export function cleanTrailers(meta) {
  const candidates = [
    ...(Array.isArray(meta?.trailerStreams) ? meta.trailerStreams.map((item) => ({ id: item?.ytId, title: item?.title })) : []),
    ...(Array.isArray(meta?.trailers) ? meta.trailers.map((item) => ({ id: item?.source, title: item?.type })) : []),
  ];
  const seen = new Set();
  const trailers = [];
  for (const candidate of candidates) {
    const id = String(candidate.id ?? "").trim();
    if (!YOUTUBE_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    trailers.push({ id, title: cleanText(candidate.title, 100) });
    if (trailers.length >= MAX_TRAILERS) break;
  }
  return trailers;
}

function linkNames(meta, category) {
  const links = Array.isArray(meta?.links) ? meta.links : [];
  return links.filter((link) => String(link?.category || "").toLowerCase() === category).map((link) => link?.name);
}

/** The details block added to /api/catalog/meta. Missing fields come back empty, never invented. */
export function catalogTitleDetails(meta = {}) {
  const people = (field, category) => cleanNames(Array.isArray(meta?.[field]) && meta[field].length ? meta[field] : linkNames(meta, category));
  return {
    cast: people("cast", "cast"),
    director: people("director", "directors"),
    writer: people("writer", "writers"),
    country: cleanText(meta?.country, 80),
    awards: cleanText(meta?.awards, 160),
    status: cleanText(meta?.status, 40),
    released: isoDay(meta?.released),
    trailers: cleanTrailers(meta),
  };
}
