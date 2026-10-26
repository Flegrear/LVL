/**
 * Export of the recommendation data, organized by show:
 *   shows → seasons (each AniList entry or TMDB title) → community snapshot, your ratings and
 *   who fans also recommend. Plus every rating, the last picks and the settings (never the TMDB key).
 */
import { RECS_DEFAULTS } from "./recs-store.js";

// Times at or below 1000 ms are markers (1 = only the basics were read yet), not dates.
const iso = (ms) => (Number(ms) > 1000 ? new Date(Number(ms)).toISOString() : null);

export function exportRecsData(store, { now = Date.now() } = {}) {
  const items = store.items();
  const ratings = store.ratings();
  const ratingsByItem = new Map();
  for (const rating of ratings) {
    if (!rating.itemId) continue;
    if (!ratingsByItem.has(rating.itemId)) ratingsByItem.set(rating.itemId, []);
    ratingsByItem.get(rating.itemId).push(rating);
  }
  const links = store.links([...items.keys()]);
  const shows = new Map();
  for (const item of items.values()) {
    const showId = item.franchiseId || item.itemId;
    if (!shows.has(showId)) shows.set(showId, { showId, title: items.get(showId)?.title || item.title, kind: item.kind, seasons: [] });
    shows.get(showId).seasons.push({
      itemId: item.itemId,
      season: item.seasonNumber,
      title: item.title,
      titleAlt: item.titleAlt || null,
      format: item.format || null,
      year: item.year,
      episodes: item.episodes,
      ids: { [item.source]: item.sourceId, mal: item.malId, imdb: item.imdbId, tmdb: item.tmdbId },
      community: { score: item.score, scoredBy: item.scoredBy, likedShare: item.likedShare, popularity: item.popularity },
      genres: item.genres,
      tags: item.tags,
      studios: item.studios,
      description: item.description || null,
      snapshotAt: iso(item.fetchedAt),
      yourRatings: (ratingsByItem.get(item.itemId) || []).map((rating) => ({ source: rating.source, score: rating.score, status: rating.status, ratedAt: iso(rating.ratedAt) })),
      fansAlsoRecommend: (links.get(item.itemId) || []).map((link) => ({ itemId: link.to, title: items.get(link.to)?.title || null, votes: link.votes, rank: link.rank })),
      linksSnapshotAt: iso(item.linksAt),
    });
  }
  for (const show of shows.values()) show.seasons.sort((a, b) => (a.season ?? 99) - (b.season ?? 99) || (a.year ?? 0) - (b.year ?? 0));
  const settings = store.settings();
  const { run, picks } = store.currentPicks();
  return {
    format: "language-video-learner-recommendations",
    version: 1,
    exportedAt: iso(now),
    settings: {
      mode: settings.mode || RECS_DEFAULTS.mode,
      intervalDays: settings.intervalDays,
      anilist: settings.anilist ? { username: settings.anilist.username, syncedAt: iso(settings.anilist.syncedAt) } : null,
      letterboxd: settings.letterboxd ? { username: settings.letterboxd.username || null, syncedAt: iso(settings.letterboxd.syncedAt) } : null,
      tmdbKey: settings.tmdbKey ? "set (not exported)" : null,
    },
    ratings: ratings.map((rating) => ({
      source: rating.source,
      title: rating.title,
      season: rating.season,
      score: rating.score,
      status: rating.status,
      progress: rating.progress,
      itemId: rating.itemId,
      catalogId: rating.catalogId,
      ratedAt: iso(rating.ratedAt),
      updatedAt: iso(rating.updatedAt),
    })),
    shows: [...shows.values()].sort((a, b) => a.title.localeCompare(b.title)),
    picks: {
      updatedAt: iso(run?.finished_at),
      items: picks.map((pick) => ({ rank: pick.rank, itemId: pick.itemId, title: pick.item.title, match: Math.round(pick.match * 1000) / 1000, summary: pick.summary, reasons: pick.reasons })),
    },
    hiddenTitles: [...store.hidden()],
  };
}

const csvCell = (value) => {
  const textValue = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(textValue) ? `"${textValue.replace(/"/g, '""')}"` : textValue;
};

export function ratingsCsv(store) {
  const header = ["title", "season", "score", "status", "progress", "source", "item_id", "catalog_id", "rated_at"];
  const rows = store.ratings().map((rating) => [rating.title, rating.season, rating.score, rating.status, rating.progress, rating.source, rating.itemId, rating.catalogId, iso(rating.ratedAt)]);
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
