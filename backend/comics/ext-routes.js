// Routes for extension sources. Mounted by sources-routes.js.
//   GET  /api/comics/extensions/index   sources from the repositories, with favorites and support
//   GET  /api/comics/ext/favorites      the favorite sources
//   POST /api/comics/ext/favorites      { sourceId, favorite } (reads the extension's theme)
//   POST /api/comics/ext/settings       { sourceId, settings } one site's settings ({} resets them)
//   GET  /api/comics/work/<id>/ext-search?source=<sourceId>   this comic on one favorite source
//   GET  /api/comics/ext/image?u=&s=&sig=                     a site image (covers, icons), signed
import crypto from "node:crypto";
import nodePath from "node:path";
import { engineFor, PACKAGE_ENGINES, PACKAGE_ENGINE_VERSIONS } from "./source-engines.js";
import { createRunnerEngine, fromLvlPath } from "./runner-engine.js";
import { validSitePath } from "./ext-sources.js";
import { normalizeSeriesName } from "../../shared/reading/release-name.js";
import { sniffImage } from "../reader/pages.js";
import { SOURCE_ID, WORK_ID, isSyncableSourceTitleKey, isLegacyComicSourceTitleKey, isSyncableComicLink } from "../../shared/reading/ids.js";
import { localIdFor } from "../reader/local-library.js";

const MAX_IMAGE = 25 * 1024 * 1024;
const signingKey = crypto.randomBytes(32);

const sign = (source, url) => crypto.createHmac("sha256", signingKey).update(`${source}\n${url}`).digest("hex").slice(0, 32);
// A URL the browser can load; only URLs LVL itself signed are fetched.
export function signedImage(url, sourceId = "") {
  if (!/^https?:\/\//.test(String(url || ""))) return "";
  return `/api/comics/ext/image?${new URLSearchParams({ u: url, s: sourceId, sig: sign(sourceId, url) })}`;
}

// The site image and source behind a URL signedImage() made in this run, or null.
// Signatures change per run, so a cover is stored as { url, sourceId } and signed again.
export function readSignedImage(signed) {
  let parsed;
  try { parsed = new URL(String(signed || ""), "http://lvl.local"); } catch { return null; }
  if (parsed.pathname !== "/api/comics/ext/image") return null;
  const url = parsed.searchParams.get("u") || "";
  const sourceId = parsed.searchParams.get("s") || "";
  const signature = parsed.searchParams.get("sig") || "";
  const expected = sign(sourceId, url);
  if (!/^https?:\/\//.test(url) || signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  return { url, sourceId };
}

// origin: sent as the Origin header when the site's image server checks it (Kagane).
export async function fetchSiteImage(remote, url, referer, { origin = "" } = {}) {
  const headers = /^https?:\/\/[^/]+$/.test(String(origin || "")) ? { Origin: origin } : undefined;
  const response = await remote.request(url, { accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8", referer, ...(headers ? { headers } : {}), maxBytes: MAX_IMAGE, timeoutMs: 40_000 });
  if (!response.ok) throw Object.assign(new Error(`Image answered HTTP ${response.status}`), { status: 502 });
  const type = sniffImage(response.buffer);
  if (!type) throw Object.assign(new Error("Not an image"), { status: 502 });
  return { buffer: response.buffer, type };
}

// A cover or icon in a source's lists. A source that runs its extension fetches it with
// the extension's own client and headers, as Mihon does: LVL's direct request can meet a
// browser check the extension passes (Manhwatop's covers), and the hidden browser may not
// pass it either. Other images, and a failed try, go the direct way.
export async function fetchListImage(target, source, deps) {
  const runner = source && !engineFor(source.theme) ? runnerEngineFor(deps) : null;
  if (runner) {
    try { return await runner.image(source, { index: 0, url: "", imageUrl: target }); } catch {}
  }
  return fetchSiteImage(deps.remote, target, source ? `${source.baseUrl}/` : undefined);
}

// Every source of every enabled repository, with its extension.
async function repositorySources(deps, { force = false } = {}) {
  const repos = await Promise.all(deps.sources.enabled("mihon-repo").map(async (repo) => {
    try { return { repo, value: await deps.extensionRepos.get(repo.config.url, { force }) }; } catch (error) { return { repo, error: error.message }; }
  }));
  const extensions = repos.flatMap((item) => (item.value?.extensions || []).map((ext) => ({ ...ext, repo: item.repo.id, fingerprint: item.value?.fingerprint || "" })));
  // Only enabled, successfully fetched, fingerprint-consistent HTTPS
  // repositories can issue same-source origin migration generations.
  // A stale cache fallback or contradictory signer is not fresh authority.
  const trustedRepositories = repos.filter(({ repo, value, error }) =>
    !error && !value?.error && !value?.stale && value?.fingerprintMatches === true
    && /^(?:[a-f0-9]{64}|(?:[a-f0-9]{2}:){31}[a-f0-9]{2})$/i.test(String(value?.fingerprint || ""))
    && /^https:\/\//.test(String(repo.config?.url || "")))
    .map(({ repo, value }) => ({ id: repo.id, url: repo.config.url,
      fingerprint: String(value.fingerprint).toLowerCase().replaceAll(":", "") }));
  return { repos, extensions, trustedRepositories };
}

// Sources LVL has no engine for run their own extension in the extension runner,
// when it's installed. deps.runner: createExtRunner(); deps.runnerDir: its data folder.
export function runnerEngineFor(deps) {
  if (!deps?.runner?.available?.()) return null;
  if (!deps.runnerEngine) {
    deps.runnerEngine = createRunnerEngine({
      runner: deps.runner, dir: nodePath.join(deps.runnerDir, "apks"), remote: deps.remote,
      findExtension: async (pkg) => (await repositorySources(deps)).extensions.find((item) => item.pkg === pkg) || null,
    });
  }
  return deps.runnerEngine;
}

// LVL's own engine for the source's theme, else the extension itself.
export function engineOf(source, deps) {
  return engineFor(source?.theme) || runnerEngineFor(deps);
}

// Searches use the comic's title, then shorter forms ("Frieren: Beyond…" -> "Frieren"), then ASCII aliases.
export function titleVariants(comic) {
  const title = String(comic?.title || "");
  return [...new Set([title, title.split(/\s*[:：–—]\s+|\s+-\s+/)[0], ...(comic?.aliases || []).filter((alias) => /^[\x20-\x7e]+$/.test(alias)).slice(0, 3)]
    .map((value) => String(value || "").trim()).filter((value) => value.length >= 2))].slice(0, 4);
}

// Best matches first. Results sharing no real word with the title are dropped
// when a site returns several (it ignored the query or matched a word like
// "no"); one or two are kept, since sites sometimes use their own title.
const STOP_WORDS = new Set(["the", "of", "and", "a", "an", "no", "to", "wa", "ga", "wo", "ni", "de", "la", "el", "los", "las", "del", "y", "en", "un", "una", "le", "les", "du", "des", "et"]);
export function rank(items, comic) {
  const names = new Set([comic.title, ...(comic.aliases || [])].map(normalizeSeriesName).filter(Boolean));
  const words = (text) => new Set(normalizeSeriesName(text).split(" ").filter((word) => word.length > 1 && !STOP_WORDS.has(word)));
  const targets = [comic.title, ...(comic.aliases || [])].map(words).filter((set) => set.size);
  const score = (item) => {
    if (names.has(normalizeSeriesName(item.title))) return 2;
    const got = words(item.title);
    return Math.max(0, ...targets.map((target) => [...target].filter((word) => got.has(word)).length / Math.max(target.size, got.size)));
  };
  const scored = items.map((item, index) => ({ ...item, exact: score(item) === 2, score: score(item), index }));
  const kept = scored.length >= 3 ? scored.filter((item) => item.score > 0) : scored;
  return kept.sort((a, b) => b.score - a.score || a.index - b.index).map(({ score: _score, index: _index, ...item }) => item);
}

// Favorites added before the repository was read (the defaults) take its version and
// address. LVL no longer reads extensions' code to pick an engine: the two it has
// its own version of are known by package, and every other source runs its extension.
export async function ensureSynced(deps, favorite, ext = null) {
  if (!favorite || favorite.version) return favorite;
  let found = ext;
  let trustedRepositories = [];
  if (!found) {
    const listing = await repositorySources(deps).catch(() => ({ extensions: [], trustedRepositories: [] }));
    const { extensions } = listing;
    trustedRepositories = listing.trustedRepositories || [];
    found = extensions.find((item) => item.pkg === favorite.pkg);
  }
  const source = found?.sources.find((item) => String(item.id) === String(favorite.id));
  if (!source) return favorite;
  // A repository-listed change to an existing default must go through the
  // same trusted generation lifecycle as periodic refresh.
  if (trustedRepositories.some((repo) => repo.id === found.repo)) {
    deps.ext.refresh([found], { trustedRepositories });
    return deps.ext.favorite(favorite.id);
  }
  return deps.ext.add(found, source, found.repo || favorite.repo);
}

// Favorites follow the repository while they're used, not only in Settings:
// the repository list (cached 6 h) is applied at most every 10 minutes, and a
// site error reads the repository again (at most every 30 minutes) in case the
// source moved or its extension changed.
const syncState = new WeakMap(); // ext store -> { at, forcedAt }
export async function syncFavorites(deps, { force = false, now = Date.now() } = {}) {
  const state = syncState.get(deps.ext) || { at: 0, forcedAt: 0, pending: null };
  syncState.set(deps.ext, state);
  if (state.pending) return state.pending;
  if (force) {
    if (now - state.forcedAt < 30 * 60_000) return [];
  } else if (now - state.at < 10 * 60_000) return [];
  const run = (async () => {
    const { extensions, trustedRepositories } = await repositorySources(deps, { force });
    // A failed or empty listing cannot establish a successful synchronization.
    // Permit another attempt instead of suppressing retries for 10–30 minutes.
    if (!extensions.length) return [];
    const updated = deps.ext.refresh(extensions, { trustedRepositories });
    state.at = now;
    if (force) state.forcedAt = now;
    return updated;
  })().catch(() => []).finally(() => { if (state.pending === run) state.pending = null; });
  state.pending = run;
  return run;
}

// "1.6.38" > "1.6.37"
const newerVersion = (a, b) => {
  const left = String(a || "").split(".").map(Number);
  const right = String(b || "").split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) if ((left[i] || 0) !== (right[i] || 0)) return (left[i] || 0) > (right[i] || 0);
  return false;
};
// A site error, plus a note when LVL's own version of an extension is older than the repository's.
export function explainSiteError(source, error) {
  const known = PACKAGE_ENGINE_VERSIONS[PACKAGE_ENGINES[source?.pkg]];
  if (!known || !newerVersion(source.version, known) || error.code === "blocked" || error.code === "check-open") return error;
  return Object.assign(new Error(`${error.message}. The ${source.extension || source.name} extension was updated to ${source.version}; LVL's version of it follows ${known} and may need an update.`),
    { status: error.status, code: error.code });
}

// Runs task(source) for a favorite; after a site error, reads the repository
// again and retries once if the source's address, version or theme changed.
export const extSearchCacheLifetimeMs = (fresh = false) => fresh ? 0 : 6 * 60 * 60_000;
export async function withFreshSource(deps, sourceId, task) {
  let source = deps.ext.favorite(sourceId);
  if (!source) throw Object.assign(new Error("This source is no longer a favorite"), { status: 404 });
  try { return await task(source); } catch (error) {
    if (error.code === "blocked" || error.code === "check-open" || Number(error.status) === 400) throw explainSiteError(source, error);
    const before = `${source.baseUrl}|${source.version}|${source.theme}`;
    await syncFavorites(deps, { force: true }).catch(() => []);
    const fresh = await ensureSynced(deps, deps.ext.favorite(sourceId));
    if (!fresh || `${fresh.baseUrl}|${fresh.version}|${fresh.theme}` === before) throw explainSiteError(source, error);
    source = fresh;
    try { return await task(source); } catch (retryError) { throw explainSiteError(source, retryError); }
  }
}

// The chapters a linked source has: [{ id, chapter, volume, title, language, publishedAt }].
export async function extChapterList(link, deps, title = "") {
  if (!deps.ext.favorite(link.sourceId)) throw new Error("This source is no longer a favorite");
  return withFreshSource(deps, link.sourceId, async (source) => {
    const engine = engineOf(source, deps);
    if (!engine) throw Object.assign(new Error(`${source.name} isn't supported in LVL yet`), { status: 400 });
    // "ext-chapters3": lists from LVL's old theme engines used other paths than the extensions.
    // A chosen source's list older than an hour is used at once and refreshed in the background.
    const list = (await deps.cached(`ext-chapters4:${source.cacheKey || source.id}:${source.version || ""}:${source.movedTo || ""}:${source.adult ? 1 : 0}:${link.mangaId}`,
      60 * 60_000, () => engine.chapters(source, link.mangaId, { remote: deps.remote, title }), { background: true })).value;
    return list.map((item) => ({ id: deps.ext.chapterId(source.id, item.path), path: item.path, chapter: item.chapter, volume: item.volume, title: item.name, language: source.lang, group: item.group || "", publishedAt: item.date }));
  });
}

export async function extPages(chapterId, deps) {
  const chapter = deps.ext.chapter(chapterId);
  if (!chapter) throw Object.assign(new Error("Unknown chapter"), { status: 404 });
  if (!engineOf(deps.ext.favorite(chapter.sourceId), deps)) throw Object.assign(new Error("This chapter's source isn't available"), { status: 404 });
  return withFreshSource(deps, chapter.sourceId, async (source) => {
    const engine = engineOf(source, deps);
    if (!engine) throw Object.assign(new Error("This chapter's source isn't available"), { status: 404 });
    const result = await engine.pages(source, chapter.path, { remote: deps.remote });
    // Pages from the extension runner are fetched by it (runner: the page as the extension gave it).
    if (result.runner) return result.runner.map((page, at) => ({ url: result.images[at], referer: result.referer, alt: "", expires: false, trim: "", runner: page, source: source.id }));
    return result.images.map((url) => ({ url, referer: result.referer, ...(result.origin ? { origin: result.origin } : {}), alt: result.fallback?.(url) || "", expires: Boolean(result.expires), trim: result.trim || "" }));
  });
}

// One page image; a page whose host fails is tried on the theme's fallback host.
// deps: needed for pages that come through the extension runner.
export async function fetchPageImage(remote, page, deps = null) {
  if (page.runner) {
    const source = deps?.ext?.favorite(page.source);
    const engine = runnerEngineFor(deps);
    if (!source || !engine) throw Object.assign(new Error("This chapter's source isn't available"), { status: 404 });
    return engine.image(source, page.runner);
  }
  try { return await fetchSiteImage(remote, page.url, page.referer, { origin: page.origin }); } catch (error) {
    if (!page.alt) throw error;
    return fetchSiteImage(remote, page.alt, page.referer, { origin: page.origin });
  }
}

// What a source's entry holds: chapter count and range, volumes, newest and oldest
// release, scanlation groups, and the chapter numbers (to compare with the index).
export function describeEntry(list = []) {
  const numbers = [...new Set(list.map((item) => item.chapter).filter(Boolean))].sort((a, b) => Number(a) - Number(b));
  const dated = list.filter((item) => Number.isFinite(item.date) && item.date > 0).sort((a, b) => b.date - a.date);
  const byNumber = [...list].filter((item) => item.chapter).sort((a, b) => Number(b.chapter) - Number(a.chapter));
  // The newest is the highest-numbered chapter: some sites upload a whole series on one day.
  const latest = byNumber[0] || dated[0] || list[0] || null;
  return {
    status: "ok",
    chapters: list.length,
    numbered: numbers.length,
    first: numbers[0] || null,
    last: numbers.at(-1) || null,
    volumes: new Set(list.map((item) => item.volume).filter(Boolean)).size,
    latest: latest ? { name: latest.name, chapter: latest.chapter || null, date: latest.date || null } : null,
    oldestDate: dated.at(-1)?.date || null,
    groups: [...new Set(list.map((item) => item.group).filter(Boolean))].slice(0, 6),
    numbers: numbers.slice(0, 5000),
  };
}

export async function handleExtRoutes(req, res, url, deps) {
  const { ctx, ext } = deps;
  const p = url.pathname;
  const send = (status, payload) => (ctx.json(res, status, payload), true);
  const bad = (message, status = 400) => send(status, { error: message });
  const libraryOwner = (sourceId, mangaId) => (deps.linked?.owners?.(sourceId, mangaId) || []).find((id) => {
    if (id.startsWith("anilist-")) return Boolean(deps.store?.libraryGet(Number(id.slice(8))));
    const local = deps.local.localTitle(id);
    return Boolean(local && local.status !== "NONE");
  }) || null;

  // A repository-source ID can change while the user's favorites, links and
  // reads still reference the old ID. The person must explicitly choose the
  // replacement. Verification uses the fresh signed repository package and
  // its listed source IDs; a matching language or name is never sufficient.
  if (p === "/api/comics/ext/rekey") {
    if (req.method !== "POST") return ctx.methodNotAllowed(res, ["POST"]), true;
    let body;
    try { body = await ctx.readJsonBody(req, 2048); } catch { return bad("Invalid source migration"); }
    const oldId = String(body?.oldSourceId || ""), nextId = String(body?.newSourceId || "");
    const old = SOURCE_ID.test(oldId) ? ext.favorite(oldId) : null;
    if (!old || !SOURCE_ID.test(nextId) || body?.confirmed !== true)
      return bad("Select and confirm an existing favorite and its new repository source", 400);
    let extensions;
    try { ({ extensions } = await repositorySources(deps, { force: true })); }
    catch (error) { return bad(error.message || "Cannot verify repository", 502); }
    const candidates = extensions.filter((item) => item.pkg === old.pkg && item.repo === old.repo
      && /^(?:[0-9a-f]{64}|(?:[0-9a-f]{2}:){31}[0-9a-f]{2})$/i.test(String(item.fingerprint || ""))
      && item.sources?.some((itemSource) => String(itemSource.id) === nextId)
      && !item.sources?.some((itemSource) => String(itemSource.id) === oldId));
    if (candidates.length !== 1) return bad("The repository cannot verify this source replacement", 409);
    const replacement = candidates[0].sources.find((item) => String(item.id) === nextId);
    try {
      const migrated = ext.rekeyVerified(oldId, candidates[0], replacement, old.repo, { confirmed: true });
      return send(200, { ...migrated, favorites: ext.favorites().map((item) => publicFavorite(item, deps)) });
    } catch (error) { return bad(error.message, 409); }
  }
  if (p === "/api/comics/ext/chapter-redirect") {
    if (req.method !== "POST") return ctx.methodNotAllowed(res, ["POST"]), true;
    let body;
    try { body = await ctx.readJsonBody(req, 4096); } catch { return bad("Invalid chapter redirect"); }
    const owner = String(body?.workId || ""), sourceId = String(body?.sourceId || "");
    const from = String(body?.fromPath || ""), to = String(body?.toPath || "");
    if (!WORK_ID.test(owner) || !SOURCE_ID.test(sourceId) || body?.confirmed !== true
      || !deps.linked.list(owner).some((link) => link.sourceId === ext.resolveSourceId(sourceId)))
      return bad("Choose and confirm a linked source first", 409);
    try {
      const chapterId = ext.recordChapterRedirect(sourceId, from, to, {
        confirmed: true, proof: `confirmed:${owner}`,
      });
      return send(200, { chapterId, sourceId: ext.resolveSourceId(sourceId) });
    } catch (error) { return bad(error.message, 409); }
  }
  const relink = /^\/api\/comics\/work\/([^/]+)\/ext-relink$/.exec(p);
  if (relink) {
    if (req.method !== "POST") return ctx.methodNotAllowed(res, ["POST"]), true;
    if (!WORK_ID.test(relink[1])) return bad("Invalid comic");
    let body;
    try { body = await ctx.readJsonBody(req, 4096); } catch { return bad("Invalid source redirect"); }
    const sourceId = ext.resolveSourceId(body?.sourceId || "");
    if (!SOURCE_ID.test(sourceId) || !ext.favorite(sourceId) || body?.confirmed !== true)
      return bad("Confirm a favorite source first", 409);
    try {
      const links = deps.linked.relinkVerified(relink[1], sourceId, String(body.fromPath || ""), String(body.toPath || ""), {
        confirmed: true, proof: `confirmed:${relink[1]}`,
      });
      return send(200, { links });
    } catch (error) { return bad(error.message, 409); }
  }

  if (p === "/api/comics/ext/browse") {
    if (req.method !== "GET") return ctx.methodNotAllowed(res, ["GET"]), true;
    const sourceId = String(url.searchParams.get("source") || "");
    const mode = String(url.searchParams.get("mode") || "popular");
    const query = String(url.searchParams.get("q") || "").trim();
    const rawPage = String(url.searchParams.get("page") || "1");
    if (!SOURCE_ID.test(sourceId) || !["popular", "latest", "search"].includes(mode) ||
      !/^(?:[1-9]|1\d|20)$/.test(rawPage) || query.length > 80 || (mode === "search" && !query)) return bad("Invalid source browse request");
    if (!deps.ext.favorite(sourceId)) return bad("Choose a favorite source first", 404);
    await syncFavorites(deps).catch(() => []);
    let source;
    try { source = await ensureSynced(deps, deps.ext.favorite(sourceId)); }
    catch (error) { return send(200, { status: "error", error: String(error.message).slice(0, 220), items: [], hasNextPage: false }); }
    if (!source) return bad("This source is no longer available", 404);
    const unavailable = { source: publicFavorite(source, deps), status: "unsupported", items: [], hasNextPage: false };
    const engine = engineOf(source, deps);
    if (!engine || (!engine.browse && (mode !== "search" || Number(rawPage) !== 1))) return send(200, unavailable);
    try {
      const result = await withFreshSource(deps, sourceId, async (fresh) => {
        source = fresh;
        const current = engineOf(fresh, deps);
        if (current?.browse) return current.browse(fresh, { mode, query, page: Number(rawPage) });
        if (mode !== "search" || Number(rawPage) !== 1 || !current?.search) return null;
        return { items: await current.search(fresh, query, { remote: deps.remote }), hasNextPage: false };
      });
      if (!result) return send(200, unavailable);
      const candidates = (result.items || []).filter((item) => validSitePath(item.path) && item.title).slice(0, 20);
      // Browse and manual open share the same lossless provider-path contract as
      // Mihon import, the local store, and sync. Never offer an Add button for a
      // path which could only be persisted as an unsyncable or truncated key.
      const canOpen = (item) => isSyncableSourceTitleKey(`mihon:${source.id}:${item.path}`);
      const items = candidates.filter(canOpen);
      const unsupportedPaths = candidates.length - items.length;
      const needsPeerUpgrade = items.filter((item) => !isLegacyComicSourceTitleKey(`mihon:${source.id}:${item.path}`)).length;
      const warning = unsupportedPaths
        ? `${unsupportedPaths} source title path(s) cannot be opened or synced by this version of LVL.` : "";
      const compatibilityWarning = needsPeerUpgrade
        ? `${needsPeerUpgrade} title(s) require an updated LVL on older devices before their full source paths can be opened there.` : "";
      const allUnsupported = unsupportedPaths > 0 && items.length === 0;
      return send(200, { source: publicFavorite(source, deps), status: allUnsupported ? "unsupported" : "ok", page: Number(rawPage),
        hasNextPage: !allUnsupported && Boolean(result.hasNextPage) && Number(rawPage) < 20,
        ...(unsupportedPaths ? { unsupportedPaths, warning, ...(allUnsupported ? { error: warning } : {}) } : {}),
        ...(needsPeerUpgrade ? { needsPeerUpgrade, compatibilityWarning } : {}),
        items: items.map((item) => {
          const key = `mihon:${source.id}:${item.path}`;
          const local = deps.local.localTitle(localIdFor(key));
          return {
            path: item.path, title: String(item.title).slice(0, 200), cover: signedImage(item.cover, source.id),
            workId: libraryOwner(source.id, item.path) || (local && local.series_key === key && local.status !== "NONE" ? local.id : null),
          };
        }) });
    } catch (error) {
      return send(200, { source: publicFavorite(source, deps), status: error.code === "blocked" || error.code === "check-open" ? "blocked" : "error",
        error: String(error.message).slice(0, 220), items: [], hasNextPage: false });
    }
  }

  if (p === "/api/comics/ext/browse/open") {
    if (req.method !== "POST") return ctx.methodNotAllowed(res, ["POST"]), true;
    let body;
    try { body = await ctx.readJsonBody(req, 2048); } catch { return bad("Invalid source title"); }
    const sourceId = String(body?.sourceId || "");
    const entryPath = String(body?.path || "");
    const title = String(body?.title || "").trim().slice(0, 200);
    const source = SOURCE_ID.test(sourceId) ? deps.ext.favorite(sourceId) : null;
    if (!source) return bad("Choose a favorite source first", 404);
    if (!validSitePath(entryPath) || !title) return bad("Invalid source title");
    const key = `mihon:${source.id}:${entryPath}`;
    const workId = localIdFor(key);
    if (!isSyncableSourceTitleKey(key) || !isSyncableComicLink(workId, source.id, entryPath))
      return bad("This source title path cannot be synced or safely opened", 422);
    const owner = libraryOwner(source.id, entryPath);
    if (owner) return send(200, { workId: owner, existed: true });
    const existing = deps.local.localTitle(workId);
    const cover = readSignedImage(body?.cover || "");
    const db = deps.ctx.db;
    try {
      db.exec("BEGIN IMMEDIATE");
      deps.local.createTitle({ id: workId, title, seriesKey: key, status: "PLANNING" });
      if (existing?.status === "NONE") deps.local.setLocalStatus(workId, "PLANNING");
      deps.videoComics.importTitle(workId, cover?.sourceId === source.id ? { cover: cover.url, sourceId: source.id } : {});
      deps.linked.link(workId, { kind: "ext", sourceId: source.id, mangaId: entryPath, name: source.name, title, lang: source.lang });
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); return bad(error.message); }
    return send(200, { workId, existed: Boolean(existing) });
  }

  if (p === "/api/comics/extensions/index") {
    if (req.method !== "GET") return ctx.methodNotAllowed(res, ["GET"]), true;
    const lang = /^[a-z]{2,3}(?:-[a-z0-9]{2,4})?$|^all$/i.test(url.searchParams.get("lang") || "") ? url.searchParams.get("lang") : "";
    const selectedSource = String(url.searchParams.get("source") || "");
    if (selectedSource && !SOURCE_ID.test(selectedSource)) return bad("Invalid source ID");
    const filter = { q: String(url.searchParams.get("q") || "").slice(0, 80), lang, source: selectedSource, adult: ext.showAdult?.() === true,
      offset: Math.max(0, Math.min(5000, Number(url.searchParams.get("offset")) || 0)), limit: 60 };
    const { repos, extensions, trustedRepositories } = await repositorySources(deps, { force: url.searchParams.get("refresh") === "1" });
    ext.refresh(extensions, { trustedRepositories });
    const { total, items } = deps.filterExtensions(extensions, filter);
    const languages = {};
    for (const item of extensions) if (filter.adult || !item.nsfw) for (const code of new Set(item.sources.map((source) => source.lang))) languages[code] = (languages[code] || 0) + 1;
    return send(200, {
      repos: repos.map(({ repo, value, error }) => ({ id: repo.id, name: value?.name || repo.name, url: repo.config.url, website: value?.website || "", fingerprint: value?.fingerprint || "",
        fingerprintMatches: value?.fingerprintMatches ?? null, count: value?.extensions?.length || 0, error: error || value?.error || null, stale: Boolean(value?.stale) })),
      total, offset: filter.offset,
      languages: Object.entries(languages).sort((a, b) => b[1] - a[1]).map(([code, count]) => ({ code, count })),
      extensions: items.map((item) => {
        const known = ext.support(item.pkg);
        const scoped = filter.source ? item.sources.filter((source) => String(source.id) === filter.source) : item.sources;
        const shown = filter.lang && filter.lang !== "all" ? scoped.filter((source) => source.lang === filter.lang || source.lang === "all") : scoped;
        return {
          name: item.name, pkg: item.pkg, lang: item.lang, version: item.version, rating: item.rating, repo: item.repo, icon: signedImage(item.icon),
          supported: known ? Boolean(known.theme) || Boolean(runnerEngineFor(deps)) : runnerEngineFor(deps) ? true : null, theme: known?.theme || null,
          viaExtension: !known?.theme && Boolean(runnerEngineFor(deps)),
          sources: (filter.source ? shown : shown.length ? shown : item.sources).slice(0, 40).map((source) => ({ id: source.id, name: source.name, lang: source.lang, host: hostOf(source.baseUrl), favorite: ext.isFavorite(source.id) })),
        };
      }),
    });
  }

  if (p === "/api/comics/ext/favorites") {
    if (req.method === "GET") return send(200, { favorites: ext.favorites().map((item) => publicFavorite(item, deps)) });
    if (req.method !== "POST") return ctx.methodNotAllowed(res, ["GET", "POST"]), true;
    let body;
    try { body = await ctx.readJsonBody(req, 4096); } catch { return bad("Invalid JSON body"); }
    const sourceId = String(body?.sourceId || "");
    if (!SOURCE_ID.test(sourceId)) return bad("Unknown source");
    if (body?.favorite === false) return send(200, { removed: ext.remove(sourceId), favorites: ext.favorites().map((item) => publicFavorite(item, deps)) });
    const { extensions } = await repositorySources(deps);
    const found = extensions.find((item) => item.sources.some((source) => String(source.id) === sourceId));
    if (!found) return bad("This source isn't in your repositories", 404);
    let favorite;
    try { favorite = ext.add(found, found.sources.find((source) => String(source.id) === sourceId), found.repo); } catch (error) { return bad(error.message); }
    return send(200, { favorite: publicFavorite(favorite, deps), favorites: ext.favorites().map((item) => publicFavorite(item, deps)) });
  }

  if (p === "/api/comics/ext/settings") {
    if (req.method !== "POST") return ctx.methodNotAllowed(res, ["POST"]), true;
    let body;
    try { body = await ctx.readJsonBody(req, 4096); } catch { return bad("Invalid JSON body"); }
    const source = SOURCE_ID.test(String(body?.sourceId || "")) ? ext.favorite(String(body.sourceId)) : null;
    if (!source) return bad("Not a favorite source", 404);
    let saved;
    try { saved = ext.saveSettings(source.id, body?.settings || {}); } catch (error) { return bad(error.message, Number(error.status) || 400); }
    return send(200, { favorite: publicFavorite(saved, deps), favorites: ext.favorites().map((item) => publicFavorite(item, deps)) });
  }

  if (p === "/api/comics/ext/check") {
    if (req.method === "GET") return send(200, deps.remote.verifyState?.() || { open: false, passed: false });
    if (req.method !== "POST") return ctx.methodNotAllowed(res, ["GET", "POST"]), true;
    let body;
    try { body = await ctx.readJsonBody(req, 1024); } catch { return bad("Invalid JSON body"); }
    const source = SOURCE_ID.test(String(body?.sourceId || "")) ? ext.favorite(String(body.sourceId)) : null;
    if (!source) return bad("Not a favorite source", 404);
    if (!deps.remote.openCheck) return bad("This isn't available here", 503);
    try { return send(200, await deps.remote.openCheck(`${source.baseUrl}/`)); } catch (error) { return bad(error.message, Number(error.status) || 502); }
  }

  const preview = /^\/api\/comics\/work\/([^/]+)\/ext-preview$/.exec(p);
  if (preview) {
    if (req.method !== "GET") return ctx.methodNotAllowed(res, ["GET"]), true;
    if (!WORK_ID.test(preview[1])) return bad("Invalid comic id");
    const sourceId = String(url.searchParams.get("source") || "");
    const path = String(url.searchParams.get("path") || "");
    if (!SOURCE_ID.test(sourceId) || !ext.favorite(sourceId)) return bad("Not a favorite source", 404);
    if (!validSitePath(path)) return bad("Invalid entry");
    await syncFavorites(deps).catch(() => []);
    let source = ext.favorite(sourceId);
    if (!engineOf(source, deps)) return bad(`${source.name} isn't supported in LVL yet`, 404);
    try {
      // Same cache as a chosen source's chapter list, so choosing it after looking is instant.
      const list = await withFreshSource(deps, sourceId, async (current) => {
        source = current;
        const engine = engineOf(current, deps);
        if (!engine) throw Object.assign(new Error(`${current.name} isn't supported in LVL yet`), { status: 400 });
        return (await deps.cached(`ext-chapters4:${current.cacheKey || current.id}:${current.version || ""}:${current.movedTo || ""}:${current.adult ? 1 : 0}:${path}`,
          60 * 60_000, () => engine.chapters(current, path, { remote: deps.remote }))).value;
      });
      return send(200, { source: publicFavorite(source, deps), ...describeEntry(list), siteUrl: siteUrlOf(source, path) });
    } catch (error) {
      return send(200, { source: publicFavorite(source, deps), status: error.code === "blocked" ? "blocked" : "error", error: String(error.message).slice(0, 300) });
    }
  }

  const search = /^\/api\/comics\/work\/([^/]+)\/ext-search$/.exec(p);
  if (search) {
    if (req.method !== "GET") return ctx.methodNotAllowed(res, ["GET"]), true;
    if (!WORK_ID.test(search[1])) return bad("Invalid comic id");
    const sourceId = String(url.searchParams.get("source") || "");
    // Verification must prove fresh reachability. A six-hour search cache
    // should never turn a closed challenge window into false success.
    const fresh = url.searchParams.get("fresh") === "1";
    if (!SOURCE_ID.test(sourceId) || !ext.favorite(sourceId)) return bad("Not a favorite source", 404);
    // Addresses and versions as the repository has them now.
    await syncFavorites(deps).catch(() => []);
    let source = await ensureSynced(deps, ext.favorite(sourceId));
    if (!engineOf(source, deps)) return send(200, { source: publicFavorite(source, deps), status: "unsupported", items: [] });
    let info;
    try { info = await deps.workInfo(search[1]); } catch (error) { return bad(error.message, Number(error.status) === 404 ? 404 : 502); }
    const linked = new Set(deps.linked.list(search[1]).filter((link) => link.kind === "ext" && link.sourceId === source.id).map((link) => link.mangaId));
    try {
      const items = await withFreshSource(deps, sourceId, async (current) => {
        source = current;
        const engine = engineOf(current, deps);
        if (!engine) throw Object.assign(new Error(`${current.name} isn't supported in LVL yet`), { status: 400 });
        let found = [];
        for (const variant of titleVariants(info.comic)) {
          const key = `ext-search3:${current.cacheKey || current.id}${current.adult ? "|adult" : ""}:${variant.toLowerCase()}`;
          const load = () => engine.search(current, variant, { remote: deps.remote });
          let result = await deps.cached(key, extSearchCacheLifetimeMs(fresh), load);
          // Nothing found is only remembered for 10 minutes (the site may have been down).
          if (!result.value.length && Date.now() - result.fetchedAt > 10 * 60_000) result = await deps.cached(key, 0, load);
          found = rank(result.value, info.comic);
          if (found.length) break;
        }
        return found;
      });
      return send(200, {
        source: publicFavorite(source, deps), status: "ok",
        items: items.slice(0, 12).map((item) => ({ path: item.path, title: item.title, cover: signedImage(item.cover, source.id), exact: item.exact, linked: linked.has(item.path) })),
      });
    } catch (error) {
      return send(200, { source: publicFavorite(source, deps), status: error.code === "blocked" || error.code === "check-open" ? "blocked" : "error", checkOpen: error.code === "check-open", error: String(error.message).slice(0, 300), items: [] });
    }
  }

  if (p === "/api/comics/ext/image") {
    if (req.method !== "GET") return ctx.methodNotAllowed(res, ["GET"]), true;
    const target = String(url.searchParams.get("u") || "");
    const sourceId = String(url.searchParams.get("s") || "");
    const signature = String(url.searchParams.get("sig") || "");
    const expected = sign(sourceId, target);
    if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return bad("Unknown image", 404);
    const source = sourceId ? ext.favorite(sourceId) : null;
    let image;
    try { image = await deps.images.get(`ext-img:${sourceId}:${target}`, () => fetchListImage(target, source, deps)); } catch (error) { return bad(error.message, 502); }
    res.writeHead(200, { "Content-Type": image.type, "Content-Length": image.buffer.length, "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff" });
    res.end(image.buffer);
    return true;
  }
  return false;
}

function hostOf(value) {
  try { return new URL(value).host; } catch { return ""; }
}

function publicFavorite(favorite, deps = null) {
  if (!favorite) return null;
  // Repository migration generations are internal transport identity
  // context, never browser-visible favorite metadata.
  const { cacheKey: _cacheKey, migration: _migration, ...rest } = favorite;
  let viaBrowser = false;
  try { viaBrowser = Boolean(favorite.baseUrl && deps?.remote?.usesBrowser?.(favorite.baseUrl)); } catch {}
  // No LVL engine of its own: the extension itself runs, when the runner is installed.
  const viaExtension = !engineFor(favorite.theme) && Boolean(runnerEngineFor(deps));
  return { ...rest, supported: Boolean(favorite.supported || viaExtension), viaExtension, host: hostOf(favorite.baseUrl), viaBrowser };
}

// An entry's page on the site (runner paths can hold a full address).
function siteUrlOf(source, entryPath) {
  const value = fromLvlPath(entryPath).split("#")[0];
  if (/^https?:\/\//.test(value)) return value;
  return value.startsWith("/") ? `${source.baseUrl}${value}` : "";
}

export { validSitePath };
