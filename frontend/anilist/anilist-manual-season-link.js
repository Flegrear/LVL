// The Title fallback accepts an explicit AniList URL/ID, never a ranked search
// suggestion. A local season association requires a fresh AniList ID lookup AND
// independent catalog identity, not simply the user's pasted number.
import { canLinkAniListTv } from "./anilist-library.js";
import { matchPublicAniListSeasons } from "../catalog/title-public-ratings.js";

export const ANILIST_MANUAL_ID_VERIFY = `query ($id: Int!) {
  Media(id: $id, type: ANIME) {
    id format episodes seasonYear title { english romaji }
    relations { edges { relationType node { id type format } } }
  }
}`;

/** Accept AniList anime links with optional www/slug/query, or an integer ID. */
export function parseManualAniListId(value) {
  const input = String(value || "").trim();
  if (!input || input.length > 512) return null;
  const number = /^\d{1,10}$/.test(input) ? Number(input) : null;
  if (number !== null) return Number.isInteger(number) && number > 0 && number <= 2147483647 ? number : null;
  // The compact placeholder intentionally omits the scheme; an otherwise
  // exact AniList host/path may be pasted without https://.
  const candidate = /^(?:www\.)?anilist\.co\/anime\//i.test(input) ? `https://${input}` : input;
  let url;
  try { url = new URL(candidate); } catch { return null; }
  if (!["http:", "https:"].includes(url.protocol)
    || !["anilist.co", "www.anilist.co"].includes(url.hostname.toLowerCase())
    || url.username || url.password || (url.port && !["80", "443"].includes(url.port))) return null;
  const match = /^\/anime\/(\d{1,10})(?:\/[^/]+)?\/?$/.exec(url.pathname);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isInteger(id) && id > 0 && id <= 2147483647 ? id : null;
}

const validYear = (year) => Number.isInteger(year) && year >= 1900 && year <= 2200;

/**
 * Produce one account-scoped, one-to-one manual association only if the user
 * explicitly picked a catalog season AND pasted an AniList ID whose full
 * metadata fits that particular season. Never infer split cour offsets.
 * The calling UI must still re-check account/title and ask for confirmation.
 */
export function planVerifiedManualAniListSeason({ media, meta, series, linked, season, accountId } = {}) {
  if (!Number.isSafeInteger(accountId) || accountId < 1 || !Number.isInteger(season) || season < 1
    || !/^tt\d{5,12}$/.test(String(series?.catalogId || ""))
    || meta?.id !== series.catalogId || !canLinkAniListTv(media)
    || !Array.isArray(meta.seasons)) return null;
  const catalog = meta.seasons.filter((item) => Number.isInteger(item?.season) && item.season > 0
    && Number.isSafeInteger(item?.count) && item.count > 0).sort((a, b) => a.season - b.season);
  if (!catalog.length || catalog[0].season !== 1 || catalog.some((row, i) => row.season !== i + 1)) return null;
  const target = catalog.find((row) => row.season === season);
  if (!target || target.count !== media.episodes || (linked?.seasons || []).some((part) => part.season === season)) return null;
  const year = Number(String(meta.releaseInfo || "").match(/\d{4}/)?.[0]);
  if (!validYear(year) || !validYear(media.seasonYear)) return null;
  const firstDate = (target.episodes || []).find((episode) => Number(episode?.episode) === 1)?.released;
  const firstYear = Number(String(firstDate || "").match(/^(\d{4})-\d{2}-\d{2}/)?.[1]);
  if (validYear(firstYear) && Math.abs(media.seasonYear - firstYear) > 1) return null;

  if (season === 1) {
    // Strict original root identity. No fuzzy display aliases and no 2003 FMA
    // entry passing for 2009 FMA Brotherhood, even when both are TV anime.
    const root = matchPublicAniListSeasons({ media: [media], title: meta.name, year,
      seasons: [{ season: 1, count: target.count }] });
    if (!root || root.seasons.length !== 1 || root.seasons[0].parts[0].id !== media.id) return null;
  } else {
    // A manually selected second season needs a previously trusted first
    // season and AniList's explicit PREQUEL edge back to it. A TV title/name
    // suffix, catalogue number or search order is not enough evidence.
    const previous = (linked?.seasons || []).filter((part) => part.season === season - 1);
    if (previous.length !== 1 || !Number.isSafeInteger(previous[0].anilistId)) return null;
    const prequels = [...new Set((media.relations?.edges || [])
      .filter((edge) => edge?.relationType === "PREQUEL" && edge.node?.type === "ANIME"
        && ["TV", "TV_SHORT", "ONA"].includes(edge.node?.format) && Number.isSafeInteger(edge.node?.id))
      .map((edge) => edge.node.id))];
    if (prequels.length !== 1 || prequels[0] !== previous[0].anilistId
      || media.seasonYear < year) return null;
  }
  return { userId: accountId, season, anilistId: media.id, episodes: media.episodes,
    format: media.format, title: String(media.title?.english || media.title?.romaji || "").trim() };
}
