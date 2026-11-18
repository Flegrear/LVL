// Immutable work identity for LVL's rating UI and per-work edit queue.
// The Library producer emits catalog:/entry:/provisional:/external: route IDs.
// Never construct a work identity from a display title, name alias, list order,
// season ordinal, or the linked account's current media-list scores.
const WORK_KINDS = new Set(["anime", "anime-movie", "movie", "series"]);
const CATALOG = /^tt\d{5,12}$/i;
const CATALOG_ROUTE = /^catalog:(movie|series):(tt\d{5,12})$/i;
const SAVED_LOCAL = /^(entry|provisional):([^\s]+)$/;
const EXTERNAL_ROUTE = /^external:(anilist|tmdb):(movie|series):([1-9]\d*)$/i;
const movieType = (kind) => ["movie", "anime-movie"].includes(kind) ? "movie" : "series";

/**
 * An IMDb catalog work is verified only with its proper media kind; otherwise
 * use the Library's already-persisted exact source entry/provisional ID or its
 * independently identified external provider ID. Old name/ordinal and
 * unresolved-entry: view-local serials are deliberately not durable identities.
 */
export function ratingWorkKey(subject = {}) {
  const kind = String(subject?.kind || "");
  if (!WORK_KINDS.has(kind)) return null;
  const rawCatalog = String(subject.catalogId || "").trim();
  const rawRoute = String(subject.workKey || subject.seriesKey || "").trim();
  const catalog = CATALOG.test(rawCatalog) ? rawCatalog.toLowerCase() : null;
  const routed = CATALOG_ROUTE.exec(rawRoute);
  const routedId = routed?.[2]?.toLowerCase() || null;
  if (rawCatalog && !catalog) return null;
  if (routed && (routed[1].toLowerCase() !== movieType(kind)
    || (catalog && catalog !== routedId))) return null;
  if (catalog || routedId) return `rating:${kind}:catalog:${catalog || routedId}`;
  const local = SAVED_LOCAL.exec(rawRoute);
  if (local && local[2]) return `rating:${kind}:${local[1]}:${local[2]}`;
  const external = EXTERNAL_ROUTE.exec(rawRoute);
  if (external && external[2].toLowerCase() === movieType(kind))
    return `rating:${kind}:external:${external[1].toLowerCase()}:${external[2].toLowerCase()}:${external[3]}`;
  return null;
}

/**
 * Presentation is deliberately a *separate* cache version. Renames, graph
 * reorderings, score snapshots and authenticated account changes may need a
 * fresh GET/markup, but must never create a new write queue for one work.
 * Sorting by stable AniList media IDs prevents a provider array reorder from
 * creating fake new work identities.
 */
export function ratingPresentationKey(subject = {}) {
  const list = subject?.anilist;
  const parts = (Array.isArray(list?.seasons) ? list.seasons : [])
    .map((part) => [part?.anilistId ?? null, part?.season ?? null,
      part?.score ?? null, part?.status ?? null,
      // Only list-entry presence affects rating precedence. Playback progress
      // increments must not trigger a fresh ratings GET on every render.
      Number.isInteger(part?.progress) && part.progress >= 0])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return JSON.stringify([
    ratingWorkKey(subject),
    subject.catalogId || "",
    subject.seriesKey || "",
    subject.title || "",
    subject.year ?? null,
    [...new Set(Array.isArray(subject.seasons) ? subject.seasons : [])]
      .filter((season) => Number.isInteger(season) && season > 0).sort((a, b) => a - b),
    Number.isSafeInteger(subject.accountUserId) && subject.accountUserId > 0
      ? subject.accountUserId : null,
    list?.accountUserId ?? null, list?.anilistId ?? null,
    list?.status ?? null, parts,
  ]);
}

/** Event-order serialization is keyed only by the immutable owner, not display. */
export function createRatingWriteQueue() {
  const pending = new Map();
  function enqueue(subject, action) {
    const key = ratingWorkKey(subject);
    if (!key) return Promise.reject(new Error("A persisted or verified rating work is required"));
    const previous = pending.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    pending.set(key, next);
    void next.finally(() => { if (pending.get(key) === next) pending.delete(key); }).catch(() => {});
    return next;
  }
  return { pending, enqueue };
}
