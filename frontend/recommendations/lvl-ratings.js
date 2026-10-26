// LVL's personal rating is an arithmetic mean of independently rated seasons.
// Imported AniList/Letterboxd scores remain a separate source and are never
// silently treated as locally rated seasons.
export function lvlRatingSummary(ratings = [], seasons = []) {
  const available = [...new Set((Array.isArray(seasons) ? seasons : [])
    .filter((season) => Number.isInteger(season) && season > 0))].sort((a, b) => a - b);
  const app = (Array.isArray(ratings) ? ratings : []).filter((row) => row?.source === "app");
  const valid = (score) => score !== null && score !== undefined && score !== ""
    && Number.isFinite(Number(score)) && Number(score) >= 1 && Number(score) <= 10;
  const overall = app.find((row) => !Number.isInteger(row.season)) || null;
  const rows = available.map((season) => {
    const record = app.find((row) => row.season === season);
    return { season, score: valid(record?.score) ? Number(record.score) : null };
  });
  const rated = rows.filter((row) => row.score !== null);
  const score = rows.length ? rated.length
    ? rated.reduce((sum, row) => sum + row.score, 0) / rated.length : null
    : valid(overall?.score) ? Number(overall.score) : null;
  return {
    score: score === null ? null : Math.round((score + Number.EPSILON) * 100) / 100,
    rated: rated.length,
    total: rows.length,
    rows,
    legacyOverall: valid(overall?.score) ? Number(overall.score) : null,
  };
}
