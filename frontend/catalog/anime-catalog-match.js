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
  if (exact.length > 1) return null;
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
