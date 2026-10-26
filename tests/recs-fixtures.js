// Shared fixtures for the recommendation tests (not a test file itself).
import { DatabaseSync } from "node:sqlite";
import { createRecsStore } from "../backend/recommendations/recs-store.js";
import { normalizeAniListLinks, normalizeAniListList, normalizeAniListMedia } from "../backend/integrations/anilist.js";

export function memoryStore(now = () => Date.now()) {
  const meta = new Map();
  return createRecsStore({ db: new DatabaseSync(":memory:"), getMeta: (key) => meta.get(key) ?? null, setMeta: (key, value) => meta.set(key, value), now });
}

export const media = (id, extra = {}) => ({
  id, idMal: id + 1, format: "TV", seasonYear: 2020, episodes: 12, isAdult: false, title: { english: `Anime ${id}`, romaji: `Anime ${id} romaji` },
  description: "A <i>story</i><br>about things. (Source: Somewhere)", coverImage: { large: `https://img/${id}.jpg` }, bannerImage: null,
  averageScore: 80, popularity: 100000, genres: ["Drama"], tags: [], studios: { nodes: [] },
  stats: { scoreDistribution: [{ score: 90, amount: 60 }, { score: 70, amount: 40 }] }, relations: { edges: [] }, recommendations: { nodes: [] }, ...extra,
});

/** A stand-in for the AniList client: answers from fixtures and counts requests. */
export function fakeAniList({ list = [], anime = {}, search = {}, user = "me" } = {}) {
  let requests = 0;
  const calls = [];
  return {
    calls,
    get requests() { return requests; },
    async userList(name) {
      requests += 1;
      calls.push(["list", name]);
      if (name !== user) throw Object.assign(new Error("That AniList user wasn't found, or their list is private."), { status: 404 });
      return normalizeAniListList({ MediaListCollection: { user: { id: 1, name: user }, lists: [{ entries: list }] } });
    },
    async details(ids, { links = false } = {}) {
      requests += Math.ceil(ids.length / 25);
      calls.push(["details", ids.length, links]);
      return ids.map((id) => anime[Number(String(id).replace("anilist:", ""))]).filter(Boolean)
        .map((raw) => ({ item: normalizeAniListMedia(raw), links: links ? normalizeAniListLinks(raw) : null }));
    },
    async search(title) {
      requests += 1;
      calls.push(["search", title]);
      return search[title] || [];
    },
  };
}
