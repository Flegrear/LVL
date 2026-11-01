// Links between anime and manga. Only AniList relations are
// used; a title-only lookup must match exactly (title or synonym, year ±1).
import { normalizeComic } from "./anilist-manga.js";
import { normalizeSeriesName } from "../../shared/reading/release-name.js";

const NODE = "id type format isAdult title { romaji english native userPreferred } synonyms coverImage { large extraLarge color } startDate { year } countryOfOrigin chapters volumes averageScore genres status";
const ANIME_RELATIONS = `relations { edges { relationType node { ${NODE} } } }`;
export const ANIME_BY_ID_QUERY = `query ($id: Int) { Media(id: $id, type: ANIME) { id title { romaji english userPreferred } synonyms startDate { year } ${ANIME_RELATIONS} } }`;
export const ANIME_SEARCH_QUERY = `query ($q: String) { Page(perPage: 6) { media(type: ANIME, search: $q, sort: SEARCH_MATCH) { id title { romaji english native userPreferred } synonyms startDate { year } ${ANIME_RELATIONS} } } }`;

const COMIC_FORMATS = new Set(["MANGA", "ONE_SHOT"]);
// Strongest first: the work the anime adapts, then its other comic relatives.
const RELATION_ORDER = ["SOURCE", "ADAPTATION", "ALTERNATIVE", "PARENT", "PREQUEL", "SEQUEL", "SIDE_STORY", "SPIN_OFF"];

export function mangaFromAnime(media) {
  const seen = new Set();
  const animeNames = new Set([media?.title?.english, media?.title?.romaji, media?.title?.userPreferred, ...(media?.synonyms || [])]
    .map(normalizeSeriesName).filter(Boolean));
  const rank = (edge) => RELATION_ORDER.indexOf(edge.relationType);
  const sameTitle = (edge) => [edge.node.title?.english, edge.node.title?.romaji, edge.node.title?.userPreferred]
    .some((name) => animeNames.has(normalizeSeriesName(name)));
  const list = (media?.relations?.edges || [])
    .filter((edge) => edge?.node?.type === "MANGA" && COMIC_FORMATS.has(edge.node.format) && !edge.node.isAdult && RELATION_ORDER.includes(edge.relationType))
    .sort((a, b) => rank(a) - rank(b) || Number(sameTitle(b)) - Number(sameTitle(a)) || (b.node.chapters || 0) - (a.node.chapters || 0))
    .map((edge) => ({ relation: edge.relationType, ...normalizeComic({ ...edge.node, description: "", siteUrl: "" }) }))
    .filter((comic) => comic.anilistId && !seen.has(comic.anilistId) && seen.add(comic.anilistId));
  // The first SOURCE/ADAPTATION entry is the work the anime is based on.
  if (list[0] && ["SOURCE", "ADAPTATION"].includes(list[0].relation)) list[0].main = true;
  return list;
}

export function exactAnimeMatch(candidates, title, year) {
  const wanted = normalizeSeriesName(title);
  if (!wanted) return null;
  return (candidates || []).find((media) => {
    const names = [media.title?.english, media.title?.romaji, media.title?.userPreferred, media.title?.native, ...(media.synonyms || [])];
    const sameName = names.some((name) => normalizeSeriesName(name) === wanted);
    const sameYear = !year || !media.startDate?.year || Math.abs(media.startDate.year - year) <= 1;
    return sameName && sameYear;
  }) || null;
}

// { anilistId, manga: [...] } for an anime given by id, or by exact title (+year).
export async function mangaForAnime(anilist, { anilistId = null, title = "", year = null } = {}) {
  let media = null;
  if (anilistId) media = (await anilist.query(ANIME_BY_ID_QUERY, { id: anilistId }))?.Media || null;
  else if (title) media = exactAnimeMatch((await anilist.query(ANIME_SEARCH_QUERY, { q: String(title).slice(0, 100) }))?.Page?.media, title, year);
  if (!media) return { anilistId: null, manga: [] };
  let manga = mangaFromAnime(media);
  // Later seasons sometimes link to no manga at all: follow one PREQUEL hop then.
  // (Not when they already have manga: JJK's prequel is the JJK 0 film, whose
  // source would wrongly come first.)
  if (!manga.length) {
    const prequel = (media.relations?.edges || []).find((edge) => edge.relationType === "PREQUEL" && edge.node?.type === "ANIME");
    if (prequel) manga = mangaFromAnime((await anilist.query(ANIME_BY_ID_QUERY, { id: prequel.node.id }))?.Media);
  }
  return { anilistId: media.id, manga };
}
