// Manga on title pages. One "Manga" section serves both
// pages: an anime's title page (the chip after its seasons) and a manga's own
// title page (/title?f=comics&item=…). Both use the same Manga block. Opening a
// manga goes to the anime it was adapted into, with the Manga chip open, when
// there is one (the franchise's page). Only AniList relations.
import { refreshImages } from "../ui/ui.js";
import { eligibleForPublicAnimeRating } from "../catalog/title-public-ratings.js";
import { comicKey, libraryEntry } from "./comics-render.js";
import { comicsApi } from "./comics-api.js";
import { mountMangaBlock } from "./comics-manga.js";
import { comicTitles, loadComicTitle } from "./comics-title-subject.js";
import { comicsEnabled } from "./comics-enabled.js";
import { mainAnimeRelation } from "../../shared/reading/franchise.js";

const lookups = new Map();   // query -> Promise<{ manga }>
const resolved = new Map();  // query -> { main, others, index } once known
const shownManga = new Map(); // query -> work id the user picked on that page
let openHint = null;          // { workId, at }: the manga just opened from a card
// Video page -> the comic to show first in its Comics section: opened from a card, or picked there.
const videoPicks = new Map();
export const pickVideoComic = (videoId, workId) => videoPicks.set(String(videoId), String(workId));
export const pickedVideoComic = (videoId) => videoPicks.get(String(videoId)) || "";

function animeQuery(payload) {
  const { subject = {}, meta = null } = payload || {};
  if (payload?.feature) return null;
  const info = payload?.info || meta || {};
  const anilistId = (subject?.series?.sources || []).map((source) => Number(source.anilistId)).find((id) => Number.isInteger(id) && id > 0) || null;
  const anime = anilistId || subject?.series?.mediaKind === "anime"
    || eligibleForPublicAnimeRating({ mediaKind: subject?.series?.mediaKind, genres: info.genres, country: info.country });
  if (!anime) return null;
  const title = info.name && info.name !== "Untitled" ? info.name : "";
  const year = Number(String(info.releaseInfo || info.released || info.year || "").match(/\d{4}/)?.[0]) || null;
  if (!anilistId && !title) return null;
  return anilistId ? `anilistId=${anilistId}` : `title=${encodeURIComponent(title)}${year ? `&year=${year}` : ""}`;
}

async function fetchManga(query) {
  if (!lookups.has(query)) {
    lookups.set(query, fetch(`/api/comics/for-anime?${query}`, { signal: AbortSignal.timeout(30_000) })
      .then((response) => (response.ok ? response.json() : { manga: [] })).catch(() => ({ manga: [] })));
  }
  return lookups.get(query);
}

// Looks up the manga and its chapter index once per title, then redraws the title page.
function lookUp(query, ctx) {
  if (resolved.has(query) || lookUp.pending.has(query)) return;
  lookUp.pending.add(query);
  void fetchManga(query).then(async ({ manga = [] }) => {
    const main = manga.find((item) => item.main) || manga[0] || null;
    // The manga the user just opened from a card shows first, if it belongs here.
    const hinted = openHint && Date.now() - openHint.at < 60_000 ? manga.find((item) => comicKey(item.anilistId) === openHint.workId) : null;
    if (hinted) { shownManga.set(query, openHint.workId); openHint = null; }
    const index = main ? await comicsApi.units(comicKey(main.anilistId)).catch(() => null) : null;
    resolved.set(query, { main, others: manga.filter((item) => item !== main), index });
    lookUp.pending.delete(query);
    // With a manga the Manga chip appears; without one, the Comics chip.
    ctx.refreshTitle?.();
  });
}
lookUp.pending = new Set();

// The manga shown on an anime page: the one picked there, else the main one.
async function shownOn(query) {
  const known = resolved.get(query);
  const all = [known.main, ...known.others].filter(Boolean);
  if (openHint && Date.now() - openHint.at < 60_000 && all.some((item) => comicKey(item.anilistId) === openHint.workId)) {
    shownManga.set(query, openHint.workId);
    openHint = null;
  }
  const picked = shownManga.get(query) && all.find((item) => comicKey(item.anilistId) === shownManga.get(query));
  const current = picked || known.main;
  const id = comicKey(current.anilistId);
  const index = current === known.main ? known.index : await comicsApi.units(id).catch(() => null);
  const work = await comicsApi.work(id).then((payload) => payload.comic).catch(() => null);
  return { id, comic: { ...current, ...(work || {}) }, index, others: all.filter((item) => item !== current) };
}

// A video page and its manga: "not-anime" (no lookup), "pending", "manga" or "none".
export function animeMangaState(payload, ctx) {
  const query = animeQuery(payload);
  if (!query) return "not-anime";
  const known = resolved.get(query);
  if (!known) { lookUp(query, ctx); return "pending"; }
  return known.main ? "manga" : "none";
}

export const mangaTitleSection = {
  id: "manga",
  label: "Manga",
  available(payload, ctx) {
    if (!comicsEnabled()) return null;
    // A manga's own page: its chapter count, once loaded.
    if (payload?.feature === "comics") {
      const known = comicTitles.get(comicKey(payload.item));
      return known?.state === "ready" ? (known.index?.chapterCount || true) : null;
    }
    const query = animeQuery(payload);
    if (!query) return null;
    const known = resolved.get(query);
    if (!known) { lookUp(query, ctx); return null; }
    if (!known.main) return null;
    return known.index?.chapterCount || known.main.chapters || true;
  },
  render(element, payload, ctx) {
    const head = payload.head || null;
    if (payload?.feature === "comics") {
      const id = comicKey(payload.item);
      const known = comicTitles.get(id);
      if (!known?.comic) { element.innerHTML = ""; void loadComicTitle(id, ctx); return; }
      mountMangaBlock(element, ctx, { workId: id, comic: { ...known.comic, id }, index: known.index, files: known.files, head });
      return;
    }
    const query = animeQuery(payload);
    if (!resolved.get(query)?.main) { element.innerHTML = ""; return; }
    element.innerHTML = `<div class="ui-skeleton comic-volumes__loading"></div>`;
    void Promise.all([shownOn(query), 0]).then(async ([{ id, comic, index, others }]) => {
      if (!element.isConnected) return;
      const files = await comicsApi.files(id).then((data) => data.files || []).catch(() => []);
      if (!element.isConnected) return;
      mountMangaBlock(element, ctx, { workId: id, comic, index, files, head, others, scores: true,
        onSwitch: (target) => { shownManga.set(query, target); mangaTitleSection.render(element, payload, ctx); } });
      refreshImages(element);
    });
  },
};

// Where a manga opens: its anime's title page with the Manga chip open, or its own page.
// Matches are remembered so the next open is immediate. v2: matches now use the anime's
// start year (same-name titles like One Piece), so v1 answers aren't trusted.
const ANIME_MATCHES_KEY = "lvl-comics-anime-match-v2";
const NO_MATCH_MS = 24 * 3600_000;
const readMatches = () => { try { return JSON.parse(localStorage.getItem(ANIME_MATCHES_KEY) || "{}") || {}; } catch { return {}; } };
export function knownAnimeCatalog(anilistId) {
  const hit = readMatches()[anilistId];
  return hit?.id && /^tt\d{5,12}$/.test(hit.id) ? hit.id : "";
}
function rememberMatch(anilistId, match) {
  const all = readMatches();
  all[anilistId] = { ...match, at: Date.now() };
  const keys = Object.keys(all);
  if (keys.length > 500) for (const key of keys.slice(0, keys.length - 500)) delete all[key];
  try { localStorage.setItem(ANIME_MATCHES_KEY, JSON.stringify(all)); } catch {}
}
// Only "no verified match" means the anime isn't in the catalog; a search that
// failed (offline, catalog down) is tried again next time.
const confirmedMiss = (error) => /No verified LVL catalog match|no searchable name/i.test(String(error?.message || ""));
const recentMiss = (anilistId) => { const hit = readMatches()[anilistId]; return Boolean(hit?.none && Date.now() - hit.at < NO_MATCH_MS); };

export async function animeFor(workId) {
  const saved = libraryEntry(workId)?.work;
  if (saved && Object.hasOwn(saved, "anime")) return saved.anime;
  const comic = comicTitles.get(workId)?.comic || (await comicsApi.work(workId).then((payload) => payload.comic).catch(() => null));
  return mainAnimeRelation(comic?.relations || []);
}

export async function openComic(ctx, id, { historyMode = "push" } = {}) {
  const key = comicKey(id);
  if (!key) return;
  if (key.startsWith("local-")) {
    // A comic read from sources opens the page it was added on, with Comics open and it shown.
    const video = libraryEntry(key)?.work?.video || (await comicsApi.work(key).catch(() => null))?.comic?.video || null;
    if (video?.id && ctx.openVideoTitle) {
      pickVideoComic(video.id, key);
      if (ctx.openVideoTitle({ id: video.id, type: video.type, section: "comics", historyMode })) return undefined;
    }
    return ctx.openFeatureTitle({ feature: "comics", item: key, historyMode });
  }
  const anime = await animeFor(key);
  if (anime && !recentMiss(anime.anilistId)) {
    openHint = { workId: key, at: Date.now() };
    try {
      const match = await ctx.openAnimeTitle({ anilistId: anime.anilistId, title: anime.title, year: anime.year || null, section: "manga", historyMode });
      rememberMatch(anime.anilistId, { id: match.id, type: match.type });
      return undefined;
    } catch (error) {
      // Not in the video catalog (or the search failed this time): the manga's own page.
      if (confirmedMiss(error)) rememberMatch(anime.anilistId, { none: true });
      openHint = null;
    }
  }
  return ctx.openFeatureTitle({ feature: "comics", item: key, historyMode });
}

// Library entries whose anime is matched in the background, so "All" shows one card per franchise.
const matching = new Set();
export function matchLibraryAnime(entries, ctx) {
  const todo = entries.map((entry) => entry.work?.anime).filter((anime) => anime && !matching.has(anime.anilistId)
    && (!readMatches()[anime.anilistId] || (readMatches()[anime.anilistId].none && !recentMiss(anime.anilistId)))).slice(0, 4);
  if (!todo.length || !ctx.findAnimeTitle) return;
  for (const anime of todo) matching.add(anime.anilistId);
  void (async () => {
    let found = false;
    for (const anime of todo) {
      try { rememberMatch(anime.anilistId, await ctx.findAnimeTitle({ anilistId: anime.anilistId, title: anime.title, year: anime.year || null })); found = true; } catch (error) {
        if (confirmedMiss(error)) rememberMatch(anime.anilistId, { none: true });
      }
      matching.delete(anime.anilistId);
    }
    if (found) ctx.refreshLibrary?.();
  })();
}
