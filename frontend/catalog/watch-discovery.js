// Small, deterministic recommendations for the Watch sidebar. No extra
// provider requests, and no claims of provider-supplied related titles.
export function watchSidebarPicks(catalog, current, { excluded = [], relatedLimit = 5, recommendedLimit = 7 } = {}) {
  const items = [...(catalog?.anime || []), ...(catalog?.series || []), ...(catalog?.movies || [])];
  const seen = new Set([String(current?.id || ""), ...excluded.map(String)]);
  const unique = items.filter((item) => {
    if (!item?.id || !item?.name || seen.has(String(item.id))) return false;
    seen.add(String(item.id));
    return true;
  });
  const genres = new Set((current?.genres || []).map((genre) => String(genre).toLowerCase()));
  const type = current?.type === "movie" ? "movie" : "series";
  const scored = unique.map((item, index) => {
    const shared = (item.genres || []).filter((genre) => genres.has(String(genre).toLowerCase())).length;
    return { item, index, shared, sameType: (item.type === "movie" ? "movie" : "series") === type };
  });
  const related = scored.filter((row) => row.shared > 0)
    .sort((a, b) => (b.sameType ? 1 : 0) - (a.sameType ? 1 : 0)
      || b.shared - a.shared || a.index - b.index)
    .slice(0, relatedLimit).map((row) => row.item);
  const used = new Set(related.map((item) => item.id));
  const recommended = scored.filter((row) => !used.has(row.item.id))
    .sort((a, b) => (b.sameType ? 1 : 0) - (a.sameType ? 1 : 0)
      || a.index - b.index)
    .slice(0, recommendedLimit).map((row) => row.item);
  return { related, recommended };
}
