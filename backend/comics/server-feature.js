// Comics section, server side. Registered in
// backend/features/registry.js; routes are local-only and run after core.
import { createComicsStore, COMIC_STATUSES } from "./comics-store.js";
import { DETAILS_QUERY, SEARCH_QUERY, browseQuery, browseVariables, homeQuery, normalizeComic, normalizeDetails, normalizeHome, searchQuery } from "./anilist-manga.js";
import { createMangaDexClient } from "./mangadex.js";
import { compareUnitNumbers } from "../../shared/reading/units.js";
import { mainAnimeRelation } from "../../shared/reading/franchise.js";
import { createLocalLibrary } from "../reader/local-library.js";
import { closeAllArchives } from "../reader/pages.js";
import { createUploadMaintenance, handleLocalRoutes, localTitleEntry } from "./local-routes.js";
import { mangaForAnime } from "./anime-links.js";
import { createSourcesStore } from "./sources-store.js";
import { createComicDownloads } from "./torrent-downloads.js";
import { createImageCache, createMangaDexReader } from "./remote-reading.js";
import { handleSourceRoutes } from "./sources-routes.js";
import { createTracking, importEntries, newChapters } from "./tracking.js";
import { fetchWikipediaList, mergeIndex, plausibleList } from "./chapter-index.js";
import { availability, chapterCandidates, createLinkedSources } from "./linked-sources.js";
import { createRepositoryCache, fetchRepository, filterExtensions } from "./extension-index.js";
import { createExtSources } from "./ext-sources.js";
import { checkHost, createRemoteFetch, isBotCheck } from "./remote-fetch.js";
import { createSourceBrowser, withBrowserFallback } from "./source-browser.js";
import { createAppBrowser } from "./app-browser.js";
import { createExtRunner } from "./ext-runner.js";
import { readSignedImage, signedImage } from "./ext-routes.js";
import { LEGACY_ENGINE_PATHS } from "./runner-engine.js";
import { createVideoComics, handleVideoRoutes, NOT_IN_LIBRARY } from "./video-comics.js";
import { createMihonImport } from "./mihon-import.js";
import { createChapterMarks } from "./chapter-marks.js";
import nodePath from "node:path";

const HOUR = 60 * 60 * 1000;
export const COMICS_CACHE_MS = Object.freeze({ home: 12 * HOUR, search: HOUR, details: 7 * 24 * HOUR, units: 24 * HOUR });
// 9: Wikipedia lists split into parts ("Lists of One Piece chapters") are read part by part.
// 10: indexes built while Wikipedia refused requests are no longer kept for a day.
// 11: Wikipedia gives numbers only (no titles); parts named in {{Main|…}} (Naruto) are read.
// 12: ranges ("Mission: 1-5"), side chapters (Bleach 0.8), other series on the page (Dragon Ball Z) and commented volumes.
export const COMICS_CACHE_VERSION = 12;

const asset = (file) => [`/${file}`, { file, cacheControl: "no-cache" }];
export const COMICS_ASSETS = Object.freeze([
  ["/comic", { file: "index.html", cacheControl: "no-store" }],
  asset("frontend/comics/feature.js"),
  asset("frontend/comics/comics-enabled.js"),
  asset("frontend/comics/comics-api.js"),
  asset("frontend/comics/comics-render.js"),
  asset("frontend/comics/comics-browser.js"),
  asset("frontend/comics/comics-provider.js"),
  asset("frontend/comics/comics-manga.js"),
  asset("frontend/comics/comics-video.js"),
  asset("frontend/comics/comics-title-subject.js"),
  asset("frontend/comics/comics-score.js"),
  asset("frontend/comics/comics-chapters.js"),
  asset("frontend/comics/comics-chapter-preload.js"),
  asset("frontend/comics/comics.css"),
  asset("frontend/comics/comics-settings.js"),
  asset("frontend/comics/comics-i18n.js"),
  asset("frontend/comics/comics-extensions.js"),
  asset("frontend/comics/comics-links.js"),
  asset("frontend/comics/comics-sources.js"),
  asset("frontend/comics/comics-source-filter.js"),
  asset("frontend/comics/comics-tracking.js"),
  asset("frontend/reader/reader.js"),
  asset("frontend/reader/reader-core.js"),
  asset("frontend/reader/reader-page-window.js"),
  asset("frontend/reader/reader.css"),
  asset("shared/reading/units.js"),
  asset("shared/reading/ids.js"),
  asset("shared/reading/franchise.js"),
]);

function anilistIdFrom(value) {
  const match = /^(?:anilist-)?([1-9]\d{0,9})$/.exec(String(value || ""));
  return match ? Number(match[1]) : null;
}

// Library snapshot: enough to draw the card offline, and the anime its title page opens on.
function cardSnapshot(comic) {
  const { id, anilistId, title, aliases, cover, color, format, status, chapters, volumes, score, genres, country, year } = comic;
  return { id, anilistId, title, aliases, cover, color, format, status, chapters, volumes, score, genres, country, year,
    ...(Array.isArray(comic.relations) ? { anime: mainAnimeRelation(comic.relations) } : {}) };
}

export function createComicsServerFeature({ mangadexFactory = () => createMangaDexClient(), now = Date.now,
  mangadexReaderFactory = () => createMangaDexReader(),
  downloadsFactory = (options) => createComicDownloads(options), wikipediaFetch = (titles) => fetchWikipediaList(titles),
  repositoryFetch = (repoUrl) => fetchRepository(repoUrl), remoteFactory = () => createRemoteFetch(),
  browserFactory = (options) => (process.env.LVL_EXT_HOST_SOCKET ? createAppBrowser({ dataDir: options.dir }) : createSourceBrowser(options)),
  runnerFactory = (options) => createExtRunner(options) } = {}) {
  const extensionRepoCache = createRepositoryCache({ load: repositoryFetch, now });
  return {
    id: "comics",
    assets: COMICS_ASSETS,
    apiPrefixes: ["/api/comics", "/api/reader"],
    create(ctx) {
      const store = createComicsStore({ db: ctx.db, now });
      const mangadex = mangadexFactory();
      const anilist = ctx.anilist;
      const inflight = new Map();

      // background: a stale copy is answered at once while the fresh one loads (chosen
      // sources' chapter lists: an hour-old list beats every chapter panel waiting on the site).
      async function cached(name, maxAgeMs, load, { background = false } = {}) {
        // Bump COMICS_CACHE_VERSION when normalization changes, so old entries are refetched.
        const key = `v${COMICS_CACHE_VERSION}:${name}`;
        const hit = store.cacheGet(key);
        if (hit && maxAgeMs > 0 && now() - hit.fetchedAt < maxAgeMs) return { value: hit.value, fetchedAt: hit.fetchedAt, stale: false };
        if (!inflight.has(key)) {
          inflight.set(key, (async () => {
            try {
              const value = await load();
              store.cachePut(key, value);
              return { value, fetchedAt: now(), stale: false };
            } finally {
              inflight.delete(key);
            }
          })());
        }
        if (hit && background) {
          inflight.get(key).catch(() => {});
          return { value: hit.value, fetchedAt: hit.fetchedAt, stale: true };
        }
        try {
          return await inflight.get(key);
        } catch (error) {
          if (hit) return { value: hit.value, fetchedAt: hit.fetchedAt, stale: true };
          throw error;
        }
      }

      // Adult content (Settings › Comics, off by default). Details are cached with
      // adult titles kept and hidden on the way out, so turning it off hides them at once.
      const showAdult = () => store.settings().showAdult;
      const adultTag = () => (showAdult() ? "|adult" : "");
      const details = async (id) => {
        const result = await cached(`details:${id}`, COMICS_CACHE_MS.details, async () => {
          if (!anilist?.query) throw new Error("AniList is not available");
          return normalizeDetails((await anilist.query(DETAILS_QUERY, { id }))?.Media, { adult: true }) || { hidden: true, anilistId: id };
        });
        return result.value?.adult && !showAdult() ? { ...result, value: { hidden: true, anilistId: id } } : result;
      };

      // Wikipedia refuses requests for a while when it's busy ("too many requests"); an index
      // built then is rebuilt after 30 minutes instead of a day, so the full list arrives.
      const WIKI_RETRY_MS = 30 * 60_000;
      const loadUnits = async (id, comic) => {
        let wikiFailed = false;
        const [mangadexId, wiki] = await Promise.all([
          mangadex.findByAniList(id, [comic.title, ...(comic.aliases || [])]).catch(() => null),
          wikipediaFetch([comic.title, comic.title.split(/\s*[:：]\s+/)[0], ...(comic.aliases || []).filter((alias) => /^[\x20-\x7e]+$/.test(alias))]).catch(() => { wikiFailed = true; return null; }),
        ]);
        const [aggregate, covers] = mangadexId
          ? await Promise.all([mangadex.aggregate(mangadexId).catch(() => null), mangadex.covers ? mangadex.covers(mangadexId).catch(() => null) : null])
          : [null, null];
        return { mangadexId, mangadex: aggregate, covers, wikipedia: wiki && plausibleList(wiki.volumes, { chaptersTotal: comic.chapters }) ? wiki : null, ...(wikiFailed ? { wikiFailed: true } : {}) };
      };
      const units = async (id, comic) => {
        const result = await cached(`units:${id}`, COMICS_CACHE_MS.units, () => loadUnits(id, comic));
        if (!result.value?.wikiFailed || now() - result.fetchedAt < WIKI_RETRY_MS) return result;
        return cached(`units:${id}`, 0, () => loadUnits(id, comic));
      };

      const fail = (res, error) => ctx.json(res, Number(error?.status) === 404 ? 404 : 502, { error: error?.message || "Comics data is unavailable" });

      // ---- Local files
      const local = createLocalLibrary({ db: ctx.db, dataRoot: ctx.dataRoot || ".", now });
      const searchTitles = async (name) => {
        const data = await anilist.query(SEARCH_QUERY, { q: String(name).slice(0, 100), page: 1, sort: ["SEARCH_MATCH"] });
        return (data?.Page?.media || []).map(normalizeComic).filter(Boolean);
      };
      // Adds an AniList title to the Library (keeps an existing entry's status unless one is given).
      async function ensureEntry(id, status = null, { isCurrent = () => true } = {}) {
        if (!isCurrent()) return null;
        const existing = store.libraryGet(id);
        if (existing && !status && String(existing.work?.title || "").trim()) return existing;
        const comic = (await details(id)).value;
        if (comic?.hidden || comic?.anilistId !== id || !String(comic?.title || "").trim() || comic.title === "Untitled")
          throw Object.assign(new Error("This title isn't available"), { status: 404 });
        // Folder removal/scan generation retirement can occur while details
        // is awaited. No newly verified card may outlive its pending file.
        if (!isCurrent()) return null;
        return store.librarySet(id, status || existing?.status || "PLANNING", cardSnapshot(comic));
      }
      // A rejected/hidden metadata fetch must reach the matcher: treating it as
      // a fulfilled null would claim AniList ownership without a usable card.
      const matchOptions = { search: searchTitles, ensureLibrary: async (id, { isCurrent = () => true } = {}) => {
        const entry = await ensureEntry(id, null, { isCurrent });
        if (!isCurrent()) return null;
        if (entry?.id !== `anilist-${id}` || !String(entry.work?.title || "").trim())
          throw new Error("Comic Library metadata is incomplete");
        return entry;
      } };
      let pendingScan = null;
      function rescan({ wait = false } = {}) {
        const run = local.scanAll(matchOptions);
        pendingScan = run;
        run.catch(() => {});
        return wait ? run : Promise.resolve({ started: true });
      }
      const localCover = (workId) => {
        const first = local.files(workId)[0];
        if (first) return `/api/reader/files/${first.id}/pages/0`;
        // A comic read from sources: the cover of the entry it was made from.
        const source = videoComics.sourceTitle(workId);
        return source?.cover_url ? signedImage(source.cover_url, source.cover_source) : "";
      };
      // Entries saved before snapshots carried the anime get it from the details,
      // one at a time in the background (AniList's queue paces them).
      let backfilling = null;
      function backfillAnime(entries) {
        const missing = entries.filter((entry) => entry.anilistId && entry.work && !Object.hasOwn(entry.work, "anime"));
        if (!missing.length || backfilling) return;
        backfilling = (async () => {
          for (const entry of missing.slice(0, 50)) {
            try {
              const comic = (await details(entry.anilistId)).value;
              if (comic && !comic.hidden) store.librarySnapshot(entry.anilistId, cardSnapshot(comic));
            } catch { /* tried again on the next start */ }
          }
        })().finally(() => { backfilling = null; });
      }
      function libraryEntries() {
        const counts = local.fileCounts();
        // readChapters: the highest chapter finished, for the card's progress in the Library's Comics filter.
        const read = (id) => marks.summary(id).chapters || 0;
        const anilistEntries = store.library().map((entry) => ({ ...entry, files: counts.get(entry.id) || 0, readChapters: read(entry.id) }));
        backfillAnime(anilistEntries);
        const localEntries = local.localTitles().filter((row) => counts.get(row.id))
          .map((row) => ({ ...localTitleEntry(row, counts.get(row.id), localCover(row.id)), files: counts.get(row.id), readChapters: read(row.id) }));
        // Comics read from sources: listed once a status is set or reading starts.
        const sourceEntries = videoComics.libraryRows().filter((row) => !counts.get(row.id)).map((row) => sourceTitleEntry(row, read(row.id)));
        return [...anilistEntries, ...localEntries, ...sourceEntries];
      }
      function sourceTitleEntry(row, readChapters = 0) {
        const entry = localTitleEntry(row, 0, localCover(row.id));
        return { ...entry, files: 0, readChapters, work: { ...entry.work, format: "COMIC", video: videoComics.originOf(row.id) } };
      }
      function localComic(row) {
        const files = local.files(row.id);
        const source = videoComics.isSourceTitle(row.id);
        return { id: row.id, local: true, anilistId: null, title: row.title, aliases: [], cover: localCover(row.id), format: source && !files.length ? "COMIC" : "LOCAL",
          volumes: null, chapters: null, genres: [], staff: [], relations: [], links: [], description: "", files: files.length,
          ...(source ? { sourceOnly: true, video: videoComics.originOf(row.id) } : {}) };
      }
      function localUnits(workId) {
        const groups = new Map();
        for (const file of local.files(workId)) {
          const key = file.volume ?? null;
          if (!groups.has(key)) groups.set(key, { volume: key, chapters: [] });
          if (file.chapter) groups.get(key).chapters.push({ chapter: file.chapter });
        }
        const volumes = [...groups.values()].sort((a, b) => compareUnitNumbers(a.volume, b.volume));
        return { source: "local", volumes, chapterCount: volumes.reduce((sum, group) => sum + group.chapters.length, 0) };
      }

      // ---- Sources
      const sources = createSourcesStore({ db: ctx.db, now });
      const mangadexReader = mangadexReaderFactory();
      const images = createImageCache({ dir: nodePath.join(ctx.dataRoot || ".", "comics-cache") });
      // Sites behind a browser check (Cloudflare) go through a headless browser, like Mihon's WebView;
      // in LVL's Android app the app itself is that browser (app-browser.js).
      const sourceBrowser = browserFactory({ dir: nodePath.join(ctx.dataRoot || ".", "runtime", "source-browser") });
      const remote = withBrowserFallback(remoteFactory(), sourceBrowser, { checkHost, isBotCheck });
      const ext = createExtSources({ db: ctx.db, now, adult: () => store.settings().showAdult });
      const marks = createChapterMarks({ db: ctx.db, now });
      const downloads = downloadsFactory({
        folder: local.defaultFolder,
        onComplete: async (job) => {
          await local.scanAll(matchOptions);
          if (job.workId) local.assignPath(job.folder, job.workId);
        },
      });
      async function workInfo(workId) {
        if (workId.startsWith("local-")) {
          const row = local.localTitle(workId);
          if (!row) throw Object.assign(new Error("This title isn't available"), { status: 404 });
          return { comic: localComic(row), mangadexId: null };
        }
        const id = anilistIdFrom(workId);
        const comic = (await details(id)).value;
        if (comic.hidden) throw Object.assign(new Error("This title isn't available"), { status: 404 });
        const listed = await units(id, comic).catch(() => null);
        return { comic, mangadexId: listed?.value?.mangadexId || null };
      }
      const sourceDeps = { ctx, sources, downloads, local, cached, images, workInfo, ext, remote, store,
        linked: createLinkedSources({ db: ctx.db, now }), availability, chapterCandidates, marks,
        extensionRepos: extensionRepoCache, filterExtensions };
      // Entries chosen with LVL's old theme engines take the extension's path form.
      sourceDeps.linked.migrateLegacy(LEGACY_ENGINE_PATHS);
      // The extension runner: sources LVL has no engine for run their own extension.
      // It starts only when such a source is used, and stops with Comics.
      const runnerDir = nodePath.join(ctx.dataRoot || ".", "runtime", "ext-runner");
      sourceDeps.runnerDir = runnerDir;
      sourceDeps.runner = runnerFactory({ dataDir: runnerDir });
      // Comics on series and movie pages: drafts, where each comic was added, related titles.
      const videoComics = createVideoComics({ db: ctx.db, now, local, linked: sourceDeps.linked });
      sourceDeps.videoComics = videoComics;
      sourceDeps.readSignedImage = readSignedImage;
      // Settings › Comics › Import from Mihon or Tachiyomi.
      const mihonImport = createMihonImport({
        query: (text, variables) => { if (!anilist?.query) throw new Error("AniList is not available"); return anilist.query(text, variables); },
        store, snapshot: cardSnapshot, local, linked: sourceDeps.linked, ext, videoComics, now,
        showAdult: () => store.settings().showAdult,
        repositories: () => sources.list().filter((source) => source.kind === "mihon-repo").map((source) => source.config.url),
        extensions: async () => (await Promise.all(sources.enabled("mihon-repo").map(async (repo) => {
          try { return ((await extensionRepoCache.get(repo.config.url))?.extensions || []).map((item) => ({ ...item, repo: repo.id })); } catch { return []; }
        }))).flat(),
      });

      // ---- Tracking
      const tracking = createTracking({ db: ctx.db, now });
      // Starting to read moves a title from Planning (or not in the Library) to Reading.
      async function onProgress(workId) {
        if (String(workId).startsWith("local-")) {
          const row = local.localTitle(workId);
          // NOT_IN_LIBRARY: a comic read from sources that wasn't in the Library yet.
          if (row?.status === "PLANNING" || row?.status === NOT_IN_LIBRARY) local.setLocalStatus(workId, "CURRENT");
          return;
        }
        const id = anilistIdFrom(workId);
        if (!id) return;
        const entry = store.libraryGet(id);
        if (!entry) await ensureEntry(id, "CURRENT").catch(() => {});
        else if (entry.status === "PLANNING") store.librarySet(id, "CURRENT", entry.work);
      }
      sourceDeps.onProgress = onProgress;

      // Settings › Comics › Enable Comics. Off: every route but the settings answers 409, and
      // the folder scans, comic downloads, the source browser and the extension runner stop.
      const comicsOn = () => store.settings().enabled;
      let uploadMaintenance = null;
      function startLocal() {
        local.start(matchOptions);
        uploadMaintenance = createUploadMaintenance(local.defaultFolder);
        void uploadMaintenance.start().catch(() => {});
      }
      function pause() {
        if (uploadMaintenance) void uploadMaintenance.stop().catch(() => {});
        uploadMaintenance = null;
        local.stop(); closeAllArchives(); downloads.stop(); remote.stop?.(); sourceDeps.runner?.stop?.();
      }

      async function handle(req, res, url) {
        const path = url.pathname;
        if (path !== "/api/comics/settings" && !comicsOn()) {
          return ctx.json(res, 409, { error: "Comics is turned off. Turn it on in Settings › Comics.", code: "comics-off" }), true;
        }
        if (path === "/api/comics/import/mihon" || path === "/api/comics/import/mihon/apply") return (await mihonImport.handle(req, res, path, ctx), true);
        if (await handleLocalRoutes(req, res, url, { ctx, local, ensureEntry, rescan, onProgress, marks })) return true;
        if (await handleSourceRoutes(req, res, url, sourceDeps)) return true;
        const tracked = /^\/api\/comics\/work\/(anilist-[1-9]\d{0,9}|local-[0-9a-f]{12})\/(ratings|read)$/.exec(path);
        if (tracked) {
          if (tracked[2] === "read") return req.method === "GET" ? (ctx.json(res, 200, marks.summary(tracked[1])), true) : (ctx.methodNotAllowed(res, ["GET"]), true);
          if (req.method === "GET") return ctx.json(res, 200, tracking.ratings(tracked[1])), true;
          if (req.method !== "PUT") return ctx.methodNotAllowed(res, ["GET", "PUT"]), true;
          let body;
          try { body = await ctx.readJsonBody(req, 4096); } catch { return ctx.json(res, 400, { error: "Invalid JSON body" }), true; }
          try { return ctx.json(res, 200, tracking.rate(tracked[1], body?.volume ?? "", body?.score ?? null)), true; } catch (error) { return ctx.json(res, 400, { error: error.message }), true; }
        }
        if (path === "/api/comics/library/import") {
          if (req.method !== "POST") return ctx.methodNotAllowed(res, ["POST"]), true;
          let body;
          try { body = await ctx.readJsonBody(req, 8 * 1024 * 1024); } catch { return ctx.json(res, 400, { error: "Invalid JSON body" }), true; }
          const imported = importEntries(body?.lists);
          for (const item of imported) store.librarySet(item.anilistId, item.status, cardSnapshot(item.comic));
          return ctx.json(res, 200, { imported: imported.length }), true;
        }
        if (path === "/api/comics/updates") {
          if (req.method !== "GET") return ctx.methodNotAllowed(res, ["GET"]), true;
          const languages = String(url.searchParams.get("langs") || "en").split(",").filter((code) => /^[a-z]{2}(?:-[a-z0-9]{2,3})?$/.test(code)).slice(0, 4);
          try {
            const items = await newChapters({
              entries: store.library(), languages, readSummary: (workId) => marks.summary(workId),
              unitsFor: async (id) => { const comic = (await details(id)).value; return comic.hidden ? null : (await units(id, comic)).value; },
              fetchLatest: async (mangadexId, langs) => (await cached(`md-latest:${mangadexId}|${langs.join(",")}`, 6 * HOUR, () => mangadexReader.latest(mangadexId, langs))).value,
            });
            return ctx.json(res, 200, { items }), true;
          } catch (error) { return fail(res, error), true; }
        }
        if (path === "/api/comics/for-anime") {
          if (req.method !== "GET") return ctx.methodNotAllowed(res, ["GET"]), true;
          const anilistId = anilistIdFrom(url.searchParams.get("anilistId") || "");
          const title = String(url.searchParams.get("title") || "").trim().slice(0, 100);
          const year = Number.parseInt(url.searchParams.get("year"), 10) || null;
          if (!anilistId && !title) return ctx.json(res, 400, { error: "anilistId or title is required" }), true;
          try {
            const key = anilistId ? `for-anime:${anilistId}` : `for-anime:t:${title.toLowerCase()}|${year || ""}`;
            const result = await cached(key, COMICS_CACHE_MS.details, () => mangaForAnime(anilist, { anilistId, title, year }));
            ctx.json(res, 200, { ...result.value, stale: result.stale });
          } catch (error) { fail(res, error); }
          return true;
        }
        const localWork = /^\/api\/comics\/work\/(local-[0-9a-f]{12})(\/units)?$/.exec(path);
        if (localWork) {
          if (req.method !== "GET") return ctx.methodNotAllowed(res, ["GET"]), true;
          const row = local.localTitle(localWork[1]);
          if (!row) return ctx.json(res, 404, { error: "This title isn't available" }), true;
          if (localWork[2]) return ctx.json(res, 200, localUnits(row.id)), true;
          const files = local.files(row.id).length;
          const sourceOnly = videoComics.isSourceTitle(row.id) && !files;
          const library = sourceOnly ? (row.status === NOT_IN_LIBRARY ? null : sourceTitleEntry(row)) : localTitleEntry(row, files, localCover(row.id));
          return ctx.json(res, 200, { comic: localComic(row), library }), true;
        }
        // Comics on a series or movie page: video-comics.js.
        if (await handleVideoRoutes(req, res, url, { ctx, videoComics, workInfo })) return true;
        if (path === "/api/comics/home") {
          if (req.method !== "GET") return ctx.methodNotAllowed(res, ["GET"]), true;
          try {
            // "home2": the rows after New series, Top rated and Completed were added.
            const adult = showAdult();
            const result = await cached(`home2${adultTag()}`, COMICS_CACHE_MS.home, async () =>
              ({ sections: normalizeHome(await anilist.query(homeQuery(undefined, { adult }), { perPage: 20, pool: 50 }), { adult }) }));
            ctx.json(res, 200, { ...result.value, fetchedAt: result.fetchedAt, stale: result.stale });
          } catch (error) { fail(res, error); }
          return true;
        }
        // Home's comic browser: ?q=&type=&sort=&status=&genre=&year=&page= (adult titles only with the setting on).
        if (path === "/api/comics/browse") {
          if (req.method !== "GET") return ctx.methodNotAllowed(res, ["GET"]), true;
          const parsed = browseVariables(Object.fromEntries(url.searchParams));
          if (parsed.error) return ctx.json(res, 400, { error: parsed.error }), true;
          try {
            const adult = showAdult();
            const result = await cached(`browse:${parsed.key}${adultTag()}`, COMICS_CACHE_MS.search, async () => {
              const data = await anilist.query(browseQuery(parsed.variables, { adult }), parsed.variables);
              return { items: (data?.Page?.media || []).map((media) => normalizeComic(media, { adult })).filter(Boolean), hasNextPage: Boolean(data?.Page?.pageInfo?.hasNextPage) };
            });
            ctx.json(res, 200, { ...result.value, page: parsed.variables.page, stale: result.stale });
          } catch (error) { fail(res, error); }
          return true;
        }
        if (path === "/api/comics/search") {
          if (req.method !== "GET") return ctx.methodNotAllowed(res, ["GET"]), true;
          const q = String(url.searchParams.get("q") || "").trim().slice(0, 100);
          const genre = String(url.searchParams.get("genre") || "").trim().slice(0, 40);
          const page = Math.min(20, Math.max(1, Number.parseInt(url.searchParams.get("page"), 10) || 1));
          if (!q && !genre) return ctx.json(res, 400, { error: "Enter a title or choose a genre" }), true;
          try {
            const variables = { q: q || undefined, genre: genre || undefined, page, sort: q ? ["SEARCH_MATCH"] : ["POPULARITY_DESC"] };
            const adult = showAdult();
            const result = await cached(`search:${q.toLowerCase()}|${genre}|${page}${adultTag()}`, COMICS_CACHE_MS.search, async () => {
              const data = await anilist.query(searchQuery({ adult }), variables);
              return { items: (data?.Page?.media || []).map((media) => normalizeComic(media, { adult })).filter(Boolean), hasNextPage: Boolean(data?.Page?.pageInfo?.hasNextPage) };
            });
            ctx.json(res, 200, { ...result.value, page, stale: result.stale });
          } catch (error) { fail(res, error); }
          return true;
        }
        // Settings › Comics choices: { showAdult, enabled }.
        if (path === "/api/comics/settings") {
          if (req.method === "GET") return ctx.json(res, 200, store.settings()), true;
          if (req.method !== "PUT") return ctx.methodNotAllowed(res, ["GET", "PUT"]), true;
          let input;
          try { input = await ctx.readJsonBody(req, 1024); } catch { return ctx.json(res, 400, { error: "Invalid JSON body" }), true; }
          for (const key of ["showAdult", "enabled"]) {
            if (Object.hasOwn(input || {}, key) && typeof input[key] !== "boolean") return ctx.json(res, 400, { error: `${key} must be true or false` }), true;
          }
          const wasOn = comicsOn();
          const saved = store.saveSettings(input || {});
          if (wasOn && !saved.enabled) pause();
          else if (!wasOn && saved.enabled) startLocal();
          return ctx.json(res, 200, saved), true;
        }
        const cover = /^\/api\/comics\/work\/([^/]+)\/cover\/(\d{1,5}(?:\.\d{1,2})?)$/.exec(path);
        if (cover) {
          if (req.method !== "GET") return ctx.methodNotAllowed(res, ["GET"]), true;
          const id = anilistIdFrom(cover[1]);
          if (!id) return ctx.json(res, 400, { error: "Invalid comic id" }), true;
          try {
            const comic = (await details(id)).value;
            if (comic.hidden) return ctx.json(res, 404, { error: "This title isn't available" }), true;
            const { mangadexId, covers } = (await units(id, comic)).value;
            const file = covers?.[cover[2]];
            if (!mangadexId || !file) return ctx.json(res, 404, { error: "No cover" }), true;
            const image = await images.get(`cover:${mangadexId}:${file}`, () => mangadexReader.image(`https://uploads.mangadex.org/covers/${mangadexId}/${file}.256.jpg`));
            res.writeHead(200, { "Content-Type": image.type, "Content-Length": image.buffer.length, "Cache-Control": "private, max-age=604800", "X-Content-Type-Options": "nosniff" });
            res.end(image.buffer);
          } catch (error) { fail(res, error); }
          return true;
        }
        const work = /^\/api\/comics\/work\/([^/]+)(\/units)?$/.exec(path);
        if (work) {
          if (req.method !== "GET") return ctx.methodNotAllowed(res, ["GET"]), true;
          const id = anilistIdFrom(work[1]);
          if (!id) return ctx.json(res, 400, { error: "Invalid comic id" }), true;
          try {
            const comic = (await details(id)).value;
            if (comic.hidden) return ctx.json(res, 404, { error: "This title isn't available" }), true;
            if (!work[2]) {
              ctx.json(res, 200, { comic, library: store.libraryGet(id) });
              return true;
            }
            const result = await units(id, comic);
            const index = mergeIndex({ wikipedia: result.value.wikipedia, mangadex: result.value.mangadex, chaptersTotal: comic.chapters, volumesTotal: comic.volumes });
            const covers = result.value.covers || {};
            for (const group of index.volumes) if (group.volume && covers[group.volume]) group.cover = `/api/comics/work/anilist-${id}/cover/${encodeURIComponent(group.volume)}`;
            ctx.json(res, 200, { ...index, source: index.sources[0] || null, mangadexId: result.value.mangadexId || null, wikipediaPage: result.value.wikipedia?.page || null,
              partial: !index.complete, volumesTotal: comic.volumes, chaptersTotal: comic.chapters, stale: result.stale });
          } catch (error) { fail(res, error); }
          return true;
        }
        if (path === "/api/comics/library") {
          if (req.method !== "GET") return ctx.methodNotAllowed(res, ["GET"]), true;
          ctx.json(res, 200, { entries: libraryEntries(), statuses: COMIC_STATUSES });
          return true;
        }
        const entry = /^\/api\/comics\/library\/([^/]+)$/.exec(path);
        if (entry) {
          if (/^local-[0-9a-f]{12}$/.test(entry[1])) {
            // A comic read from sources keeps its sources and pages; it only leaves the Library.
            const sourceOnly = videoComics.isSourceTitle(entry[1]) && !local.files(entry[1]).length;
            if (req.method === "DELETE") return ctx.json(res, 200, { removed: sourceOnly ? local.setLocalStatus(entry[1], NOT_IN_LIBRARY) : local.removeLocal(entry[1]) }), true;
            if (req.method !== "PUT") return ctx.methodNotAllowed(res, ["PUT", "DELETE"]), true;
            let body;
            try { body = await ctx.readJsonBody(req, 4096); } catch { return ctx.json(res, 400, { error: "Invalid JSON body" }), true; }
            if (!COMIC_STATUSES.includes(String(body?.status))) return ctx.json(res, 400, { error: `Status must be one of ${COMIC_STATUSES.join(", ")}` }), true;
            if (!local.setLocalStatus(entry[1], body.status)) return ctx.json(res, 404, { error: "This title isn't available" }), true;
            const row = local.localTitle(entry[1]);
            if (sourceOnly) return ctx.json(res, 200, { entry: sourceTitleEntry(row, marks.summary(row.id).chapters || 0) }), true;
            const files = local.files(row.id).length;
            return ctx.json(res, 200, { entry: { ...localTitleEntry(row, files, localCover(row.id)), files } }), true;
          }
          const id = anilistIdFrom(entry[1]);
          if (!id) return ctx.json(res, 400, { error: "Invalid comic id" }), true;
          if (req.method === "DELETE") {
            ctx.json(res, 200, { removed: store.libraryRemove(id) });
            return true;
          }
          if (req.method !== "PUT") return ctx.methodNotAllowed(res, ["PUT", "DELETE"]), true;
          let body;
          try { body = await ctx.readJsonBody(req, 4096); } catch { return ctx.json(res, 400, { error: "Invalid JSON body" }), true; }
          const status = String(body?.status || "PLANNING");
          if (!COMIC_STATUSES.includes(status)) return ctx.json(res, 400, { error: `Status must be one of ${COMIC_STATUSES.join(", ")}` }), true;
          try {
            const comic = (await details(id)).value;
            if (comic.hidden) return ctx.json(res, 404, { error: "This title isn't available" }), true;
            ctx.json(res, 200, { entry: store.librarySet(id, status, cardSnapshot(comic)) });
          } catch (error) { fail(res, error); }
          return true;
        }
        return false;
      }

      return {
        handle,
        start: () => { if (comicsOn()) startLocal(); },
        stop: () => pause(),
        local,
        rescan,
        get pendingScan() { return pendingScan; },
      };
    },
  };
}

export const comicsServerFeature = createComicsServerFeature();
