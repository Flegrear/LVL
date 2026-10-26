// Exact, read-only AniList identity resolution for newly saved Library anime.
// This is deliberately distinct from fuzzy public rating display and from
// authenticated MediaList writes. Ambiguous/missing seasons require a choice.
import { matchPublicAniListSeasons, verifiedPublicAniListLinks } from "../catalog/title-public-ratings.js";

const IMDB_ID = /^tt\d{5,12}$/;
const TV_FORMATS = new Set(["TV", "TV_SHORT", "ONA"]);
const MAX_SEQUEL_LOOKUPS = 10;

const validAniListId = (id) => Number.isSafeInteger(id) && id > 0;

/**
 * Public AniList search is NOT a verified association. Only an unambiguous
 * first-season identity and a complete exact sequence of episodes/seasons can
 * produce a persisted account-scoped link. The root title, year, and counts
 * must agree with the catalog; subsequent titles need explicit SEQUEL edges.
 *
 * The returned IDs may be used locally for guarded watched sync, but this
 * function neither reads nor writes any authenticated AniList data.
 */
export async function resolveVerifiedAniListLibraryLinks({ catalogId = "", meta = null, userId = null,
  fetchTitle, fetchSequels } = {}) {
  if (!IMDB_ID.test(String(catalogId)) || meta?.id !== catalogId
    || !validAniListId(userId) || typeof fetchTitle !== "function" || typeof fetchSequels !== "function") return [];
  const title = String(meta.name || "").trim();
  const year = Number(String(meta.releaseInfo || "").match(/\d{4}/)?.[0]);
  const seasons = Array.isArray(meta.seasons) ? meta.seasons.filter((part) =>
    Number.isInteger(part?.season) && part.season > 0 && Number.isSafeInteger(part?.count) && part.count > 0) : [];
  if (!title || !Number.isInteger(year) || year < 1900 || year > 2200 || !seasons.length) return [];

  const found = await fetchTitle(title);
  if (!Array.isArray(found)) return [];
  const byId = new Map(found.filter((item) => validAniListId(item?.id)).map((item) => [item.id, item]));
  const match = () => matchPublicAniListSeasons({ media: [...byId.values()], title, year, seasons });
  const verified = () => verifiedPublicAniListLinks(match(), { userId, year, catalogId });
  let links = verified();
  if (links.length) return links;

  // Do not infer the identity from search rank: the strict matcher must find
  // exactly one verifiable *complete first catalog season* before graph walking.
  const initial = match();
  const rootId = initial?.seasons?.[0]?.parts?.[0]?.id;
  if (!validAniListId(rootId)) return [];

  const traversed = new Set();
  let id = rootId;
  for (let lookups = 0; lookups < MAX_SEQUEL_LOOKUPS;) {
    const current = byId.get(id);
    if (!current || traversed.has(id) || !TV_FORMATS.has(current.format)
      || !Number.isSafeInteger(current.episodes) || current.episodes < 1) return [];
    traversed.add(id);
    // A second successor (including a film fork) is ambiguous without
    // additional user input; never arbitrarily follow whichever was fetched.
    const successors = [...new Set((current.relations?.edges || [])
      .filter((edge) => edge?.relationType === "SEQUEL" && validAniListId(edge.node?.id))
      .map((edge) => edge.node.id))];
    if (successors.length !== 1 || traversed.has(successors[0])) return [];
    id = successors[0];
    if (!byId.has(id)) {
      lookups += 1;
      const fetched = await fetchSequels([id]);
      if (!Array.isArray(fetched) || !fetched.some((entry) => entry?.id === id)) return [];
      for (const item of fetched) if (validAniListId(item?.id)) byId.set(item.id, item);
    }
    links = verified();
    if (links.length) return links;
  }
  return [];
}
