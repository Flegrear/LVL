// Developer-only, explicit opt-in integration check. Uses the browser's current
// AniList bearer directly, never sends it to LVL's Node server. It creates
// ONLY a never-listed anime entry, advances 1→2→3, and deletes solely the
// freshly created list ENTRY ID after validating unchanged test progress.
import {
  anilistGraphql, ANILIST_LIST_QUERY, ANILIST_SINGLE_PROGRESS_QUERY,
  ANILIST_SAVE_PROGRESS, remoteAniListEntries,
} from "./anilist-auto-client.js";

export const ANILIST_SMOKE_CANDIDATES = `query {
  Page(page: 10, perPage: 25) {
    media(type: ANIME, format: TV, isAdult: false, sort: POPULARITY_DESC) {
      id episodes title { english romaji }
    }
  }
}`;
export const ANILIST_SMOKE_ADVANCE = `mutation ($id: Int!, $progress: Int!) {
  SaveMediaListEntry(id: $id, progress: $progress) { id mediaId progress status }
}`;
export const ANILIST_SMOKE_DELETE = `mutation ($id: Int!) {
  DeleteMediaListEntry(id: $id) { deleted }
}`;

const validId = (value) => Number.isSafeInteger(value) && value > 0;

export async function runAniListReversibleSmoke({
  account, graphql = anilistGraphql, onStep = () => {}, stillConnected = () => true,
}) {
  if (!validId(account?.userId) || !account.token) throw new Error("Connect AniList before testing.");
  const request = (query, variables = {}) => {
    if (!stillConnected()) throw new Error("AniList connection changed while testing; check your AniList list manually.");
    return graphql(account.token, query, variables);
  };
  onStep("Checking your list for an anime you have not added…");
  const snapshot = await request(ANILIST_LIST_QUERY, { id: account.userId });
  if (snapshot?.Viewer?.id !== account.userId
      || !Array.isArray(snapshot?.MediaListCollection?.lists))
    throw new Error("AniList didn't return a complete list; no test changes were made.");
  const listed = remoteAniListEntries(snapshot);
  const candidates = await request(ANILIST_SMOKE_CANDIDATES);
  const candidate = candidates?.Page?.media?.find((media) => validId(media?.id)
    && Number.isSafeInteger(media.episodes) && media.episodes >= 4 && !listed.has(media.id));
  if (!candidate) throw new Error("No safely unlisted anime was found for the test. No changes were made.");
  const name = candidate.title?.english || candidate.title?.romaji || `AniList ${candidate.id}`;
  const lookup = async () => {
    const result = await request(ANILIST_SINGLE_PROGRESS_QUERY, { id: account.userId, mediaId: candidate.id });
    if (!result || !Object.hasOwn(result, "MediaList"))
      throw new Error("AniList didn't confirm the test item's current state.");
    return result.MediaList;
  };
  if (await lookup() !== null) throw new Error("The selected anime is already in AniList; no changes made.");

  let createdId = null;
  let progress = 0;
  let deleted = false;
  let failed = null;
  try {
    for (const episode of [1, 2, 3]) {
      onStep(`${name}: testing episode ${episode}/3…`);
      const data = episode === 1
        ? await request(ANILIST_SAVE_PROGRESS, { mediaId: candidate.id, progress: episode, status: "CURRENT" })
        : await request(ANILIST_SMOKE_ADVANCE, { id: createdId, progress: episode });
      const entry = data?.SaveMediaListEntry;
      if (episode === 1 && validId(entry?.id)) createdId = entry.id;
      if (!validId(createdId) || entry?.id !== createdId || entry?.mediaId !== candidate.id
          || entry?.progress !== episode || entry?.status !== "CURRENT")
        throw new Error("AniList returned an unexpected test update; the entry may need manual cleanup.");
      progress = episode;
      const fresh = await lookup();
      if (fresh?.id !== createdId || fresh.mediaId !== candidate.id
          || fresh.progress !== episode || fresh.status !== "CURRENT")
        throw new Error("AniList did not confirm test progress; check the list manually.");
    }
  } catch (error) { failed = error; }

  // Delete ONLY the entry created by the test, using its list-entry ID.
  // Never delete a pre-existing entry or an entry edited concurrently by a
  // human/other client. Cleanup is attempted even if episode 2 or 3 failed.
  if (validId(createdId)) {
    try {
      onStep(`Restoring your AniList list: removing the temporary ${name} entry…`);
      const current = await lookup();
      if (current?.id !== createdId || current.mediaId !== candidate.id
          || current.progress !== progress || current.status !== "CURRENT")
        throw new Error("The test entry changed externally; refusing to delete it. Review the AniList list manually.");
      const response = await request(ANILIST_SMOKE_DELETE, { id: createdId });
      if (response?.DeleteMediaListEntry?.deleted !== true)
        throw new Error("AniList did not confirm deletion of the temporary entry.");
      if (await lookup() !== null)
        throw new Error("Temporary entry deletion couldn't be verified on AniList.");
      deleted = true;
    } catch (error) {
      throw new Error(`${failed ? `${failed.message} ` : ""}Cleanup of temporary AniList entry ${createdId} was not verified: ${error.message}`);
    }
  }
  if (failed) throw failed;
  if (!deleted) throw new Error("AniList test was not completed; check the list for a temporary entry.");
  onStep(`Verified: ${name} progressed 1 → 2 → 3; temporary entry removed.`);
  return { mediaId: candidate.id, name, episodesTested: 3, deleted: true };
}
