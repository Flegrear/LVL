// AniList uses one ID for each anime season. LVL/Cinemeta uses an IMDb series
// ID for the show as a whole. Match a later season to its verified series root,
// but never guess an IMDb ID from popularity or fuzzy similarity alone.

export function normalizeAnimeCatalogName(value) {
  return String(value || "").normalize("NFKC").toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

// Only explicit sequel markers: names like "Blue Box" remain untouched.
// This intentionally does not strip "2" by itself or words inside a title.
export function animeCatalogRootName(value) {
  const name = String(value || "").trim();
  return name
    // AniList sometimes puts a named story arc AFTER the season number:
    // "JUJUTSU KAISEN Season 3: The Culling Game Part 1". The whole
    // suffix is season metadata, not a new IMDb series identity.
    .replace(/\s*(?:[-:–]\s*)?(?:season\s+[2-9]\d*|[2-9]\d*(?:st|nd|rd|th)\s+season)\s*[:–-]\s*\S.+$/iu, "")
    .replace(/\s*(?:[-:–]\s*)?(?:season\s+[2-9]\d*|[2-9]\d*(?:st|nd|rd|th)\s+season)(?:\s*[-:–]?\s*part\s+\d+)?\s*$/iu, "")
    .replace(/\s*(?:[-:–]\s*)?(?:part|cour)\s+[2-9]\d*\s*$/iu, "")
    .trim();
}

const catalogYear = (item) => {
  const year = Number(String(item?.releaseInfo || item?.year || "").match(/\b(?:19|20)\d{2}\b/)?.[0]);
  return Number.isInteger(year) && year >= 1900 ? year : null;
};

export function verifiedAnimeCatalogMatch(media, candidates = []) {
  const titles = [media?.title, media?.titleAlt].map(normalizeAnimeCatalogName).filter(Boolean);
  const names = new Set(titles);
  const roots = new Set([media?.title, media?.titleAlt].map(animeCatalogRootName)
    .filter((root, index) => root && normalizeAnimeCatalogName(root) !== titles[index])
    .map(normalizeAnimeCatalogName));
  const type = media?.format === "MOVIE" ? "movie" : "series";
  const results = candidates.filter((item) => item?.type === type
    && /^tt\d{5,12}$/.test(String(item?.id || "")));
  const exact = results.filter((item) => names.has(normalizeAnimeCatalogName(item.name)));
  // A season-specific exact name is more reliable than a series-wide root.
  if (exact.length === 1 || new Set(exact.map((item) => item.id)).size === 1) return exact[0] || null;
  if (exact.length > 1) {
    // Several titles share the exact name (One Piece: the 1999 anime and the 2023
    // live-action series). The anime's start year picks one, but only when
    // exactly one of them starts within a year of it; otherwise stay unresolved.
    const startYear = Number(media?.year);
    if (!Number.isInteger(startYear) || startYear < 1900) return null;
    const near = exact.filter((item) => { const year = catalogYear(item); return year !== null && Math.abs(year - startYear) <= 1; });
    return new Set(near.map((item) => item.id)).size === 1 ? near[0] : null;
  }
  if (type === "movie" || !roots.size) return null;

  const releaseYear = Number(media.year);
  // A sequel's year is not the show's starting year. Reject future IMDb titles
  // and don't assume a season maps to an unrelated old reboot with the same name.
  const rootMatches = results.filter((item) => {
    if (!roots.has(normalizeAnimeCatalogName(item.name))) return false;
    const year = catalogYear(item);
    return year !== null && Number.isInteger(releaseYear) && releaseYear >= 1900 && year <= releaseYear;
  });
  // Ambiguous root matches are safer to leave unresolved than to corrupt the
  // user's Library or play sources for a different incarnation of the show.
  return new Set(rootMatches.map((item) => item.id)).size === 1 ? rootMatches[0] : null;
}

// When the viewer has already linked a show to a specific IMDb catalog ID,
// that is stronger identity evidence than a transient third-party search. A
// later AniList season may omit the original show's year and the Library's
// normalized series row may not have releaseInfo at all. Only reuse a single
// *explicitly linked* matching series, never an unlinked/fuzzy title or two
// competing incarnations with different IMDb IDs.
export function verifiedAnimeLibraryCatalogMatch(media, library = []) {
  if (media?.format === 'MOVIE') return null;
  const roots = new Set([media?.title, media?.titleAlt]
    .map(animeCatalogRootName).map(normalizeAnimeCatalogName).filter(Boolean));
  if (!roots.size) return null;
  const candidates = library.filter(series =>
    /^tt\d{5,12}$/.test(String(series?.catalogId || ''))
    && series?.type !== 'movie'
    && roots.has(normalizeAnimeCatalogName(series?.title || '')));
  const uniqueIds = new Set(candidates.map(item => item.catalogId));
  if (uniqueIds.size !== 1) return null;
  const series = candidates[0];
  return { id: series.catalogId, name: series.title, type: 'series' };
}

export function animeCatalogSearchNames(media) {
  const names = [media?.title, media?.titleAlt].filter(Boolean);
  const distinct = new Map(names.map((title) => [normalizeAnimeCatalogName(title), title]));
  return [...distinct.values()];
}

export function animeCatalogRootSearchNames(media) {
  const original = new Set(animeCatalogSearchNames(media).map(normalizeAnimeCatalogName));
  const roots = [media?.title, media?.titleAlt].filter(Boolean)
    .map(animeCatalogRootName).filter((title) => title && !original.has(normalizeAnimeCatalogName(title)));
  return [...new Map(roots.map((title) => [normalizeAnimeCatalogName(title), title])).values()];
}

// Some Cinemeta searches interpret an English series name as disconnected
// words (e.g. "Hell's Paradise" gives unrelated movies), while the IMDb
// search for "Hell's Paradise: Jigokuraku" returns its exact series record.
// This is ONLY another search expression: verifiedAnimeCatalogMatch still
// requires an exact known alias/root, unique IMDb ID, type and sensible year.
export function animeCatalogCombinedSearchNames(media) {
  const names = [media?.title, media?.titleAlt].map(animeCatalogRootName).filter(Boolean);
  if (names.length !== 2 || normalizeAnimeCatalogName(names[0]) === normalizeAnimeCatalogName(names[1])) return [];
  const combined = `${names[0]}: ${names[1]}`;
  return combined.length <= 90 ? [combined] : [];
}

// IMDb may index a long AniList romanized title under its shorter first
// clause. Search e.g. "Yuusha Kei ni Shosu" instead of the full
// "Yuusha Kei ni Shosu: Choubatsu Yuusha 9004-tai Keimu Kiroku".
// This does not add a matching alias: verifiedAnimeCatalogMatch must still
// identify the original English/romaji title or a verified sequel root.
export function animeCatalogSubtitleSearchNames(media) {
  if (!media?.title || !media?.titleAlt) return [];
  const alt = animeCatalogRootName(media.titleAlt);
  const colon = alt.indexOf(":");
  if (colon < 5 || colon > 70 || !alt.slice(colon + 1).trim()) return [];
  const prefix = alt.slice(0, colon).trim();
  if (!prefix || !/\s/u.test(prefix)) return [];
  const known = new Set([...animeCatalogSearchNames(media), ...animeCatalogRootSearchNames(media)]
    .map(normalizeAnimeCatalogName));
  return known.has(normalizeAnimeCatalogName(prefix)) ? [] : [prefix];
}
