// Which title page a manga opens on: the
// franchise's video title when the manga was adapted into a TV or web series,
// with the Manga chip open; otherwise the manga's own title page. Movies, OVAs
// and specials don't count (their pages have no chapter chips). Shared by the
// browser and the server.

const SERIES_FORMATS = new Set(["TV", "TV_SHORT", "ONA"]);

// relations: [{ relation, type, format, anilistId, title, year }] from AniList.
// Returns { anilistId, title, year } of the first TV/ONA adaptation, or null.
export function mainAnimeRelation(relations = []) {
  const series = (Array.isArray(relations) ? relations : []).filter((item) => item?.type === "ANIME" && item.relation === "ADAPTATION"
    && SERIES_FORMATS.has(item.format) && Number.isSafeInteger(item.anilistId) && item.anilistId > 0);
  const first = series.sort((a, b) => (a.year || 9999) - (b.year || 9999) || a.anilistId - b.anilistId)[0];
  return first ? { anilistId: first.anilistId, title: String(first.title || ""), year: first.year || null } : null;
}

// A manga Library entry is shown inside its anime's card when that anime is in
// the Library (one card per franchise). ids: { catalogIds, anilistIds } of the
// Library's video titles; catalogFor(anilistId) -> known catalog id or "".
export function joinedToVideo(entry, ids, catalogFor = () => "") {
  if (!ids) return false;
  // A comic read from sources belongs to the video page it was added on.
  const video = entry?.work?.video?.id;
  if (video && ids.catalogIds?.has(video)) return true;
  const anime = entry?.work?.anime;
  if (!anime) return false;
  if (ids.anilistIds?.has(anime.anilistId)) return true;
  const catalogId = catalogFor(anime.anilistId);
  return Boolean(catalogId && ids.catalogIds?.has(catalogId));
}
