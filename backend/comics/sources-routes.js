// Routes for comic sources. Mounted by server-feature.js.
// Reading sources are extensions from Mihon repositories (ext-routes.js);
// torrent indexers find packs to download.
import crypto from "node:crypto";
import { searchPirateBay, searchTorznab } from "./torrent-search.js";
import { extChapterList, extPages, fetchPageImage, handleExtRoutes, titleVariants } from "./ext-routes.js";
import { sourceChapters, availabilityByUnit } from "./linked-sources.js";
import { EXT_CHAPTER_ID, WORK_ID } from "../../shared/reading/ids.js";
import { normalizeUnitNumber } from "../../shared/reading/units.js";

// Index/ordinal by itself identifies a slot, not an image. A provider may
// reorder pages without changing the count or the chapter ID. Include the
// ordered page manifest in the disk-cache identity so the next fetched page
// cannot reuse bytes from an earlier ordering.
const pageDescriptor = (page) => [
  page?.url || "", page?.referer || "", page?.origin || "", page?.alt || "",
  page?.source || "", page?.trim || "", page?.runner
    ? [page.runner.index, page.runner.url || "", page.runner.imageUrl || ""] : null,
];
const pageHash = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
// Provider image URLs may rotate a short-lived query signature without
// changing the underlying page. Only remove recognized authentication fields
// for the *resume* witness; the byte-cache key still uses the strict full URL.
// Never discard arbitrary page/variant queries, because those can select
// different images at the same path.
const stableImageAddress = (raw) => {
  try {
    const url = new URL(String(raw || ""));
    if (!["http:", "https:"].includes(url.protocol)) return String(raw || "");
    for (const key of [...url.searchParams.keys()])
      if (/^(?:token|access_token|expires?|expiry|expire_at|signature|sig|auth|authorization|x-amz-.+|x-goog-.+|policy|key-pair-id)$/i.test(key))
        url.searchParams.delete(key);
    url.hash = "";
    return url.toString();
  } catch { return String(raw || ""); }
};
export const remotePageIdentity = (page) => pageHash([
  stableImageAddress(page?.url),
  stableImageAddress(page?.runner?.imageUrl),
  stableImageAddress(page?.runner?.url),
  page?.source || "",
]);
export const remotePageManifestWitness = (pages) => pageHash(pages.map(pageDescriptor));
export function remotePageCacheKey(chapterId, index, pages) {
  return `remote-page-v2:${chapterId}:${index}:${remotePageManifestWitness(pages)}`;
}

// Resolve a chapter through the currently chosen source and its chapter index.
// A bare chapter id or client-provided chapter number proves no work membership.
async function currentRemoteChapter(workId, readerId, deps) {
  const known = deps.ext.chapter(readerId);
  if (!known) return null;
  const revision = deps.linked.revision?.(workId) ?? null;
  const links = deps.linked.list(workId).filter((link) => link.kind === "ext" && link.sourceId === known.sourceId);
  if (!links.length) return null;
  const title = await deps.workInfo(workId).then((info) => info.comic.title, () => "");
  for (const link of links) {
    const item = (await (deps.chapterList || extChapterList)(link, deps, title).catch(() => []))
      .find((entry) => entry.id === readerId && entry.path === known.path && !entry.externalUrl);
    if (item && (deps.linked.revision?.(workId) ?? null) === revision &&
        deps.linked.list(workId).some((current) => current.kind === "ext" && current.sourceId === link.sourceId && current.mangaId === link.mangaId))
      return { chapter: normalizeUnitNumber(item.chapter) || null, volume: normalizeUnitNumber(item.volume) || null,
        source: link.name || "", sourceId: known.sourceId, path: known.path, mangaId: link.mangaId, revision };
  }
  return null;
}
export async function describeRemoteChapter(workId, readerId, deps) {
  const found = await currentRemoteChapter(workId, readerId, deps);
  return found ? { chapter: found.chapter, volume: found.volume, source: found.source, sourceId: found.sourceId } : null;
}

const settle = async (name, run) => {
  try { return { status: "ok", items: await run() }; } catch (error) { return { status: "error", error: String(error?.message || error).slice(0, 200), items: [] }; }
};

// deps: { ctx, sources, downloads, local, cached, ext, remote, images, workInfo(id) -> { comic } }
export async function handleSourceRoutes(req, res, url, deps) {
  const { ctx, sources, downloads, local, cached, images, workInfo } = deps;
  const p = url.pathname;
  const body = async () => { try { return await ctx.readJsonBody(req, 8192); } catch { return null; } };
  const send = (status, payload) => (ctx.json(res, status, payload), true);
  const bad = (message, status = 400) => send(status, { error: message });

  if (p === "/api/comics/sources") {
    if (req.method === "GET") return send(200, { sources: sources.publicList(), downloads: downloads.list() });
    if (req.method === "POST") {
      try { return send(200, { source: sources.publicView(sources.add(await body() || {})) }); } catch (error) { return bad(error.message); }
    }
    return ctx.methodNotAllowed(res, ["GET", "POST"]), true;
  }
  if (await handleExtRoutes(req, res, url, deps)) return true;
  const one = /^\/api\/comics\/sources\/([a-z0-9-]{3,60})$/.exec(p);
  if (one) {
    if (req.method === "DELETE") return send(200, { removed: sources.remove(one[1]) });
    if (req.method !== "PUT") return ctx.methodNotAllowed(res, ["PUT", "DELETE"]), true;
    try {
      const updated = sources.update(one[1], await body() || {});
      return updated ? send(200, { source: sources.publicView(updated) }) : bad("Unknown source", 404);
    } catch (error) { return bad(error.message); }
  }

  // ---- Downloads
  if (p === "/api/comics/downloads") {
    if (req.method === "GET") return send(200, { downloads: downloads.list() });
    if (req.method !== "POST") return ctx.methodNotAllowed(res, ["GET", "POST"]), true;
    const input = await body();
    if (input?.workId && !WORK_ID.test(String(input.workId))) return bad("Invalid comic id");
    try { return send(200, { download: await downloads.start({ magnet: input?.magnet, name: input?.name, workId: input?.workId || null }) }); } catch (error) { return bad(error.message); }
  }
  const dl = /^\/api\/comics\/downloads\/([0-9a-f]{12})$/.exec(p);
  if (dl) {
    if (req.method !== "DELETE") return ctx.methodNotAllowed(res, ["DELETE"]), true;
    return send(200, { removed: downloads.cancel(dl[1]) });
  }

  // ---- Sources chosen for a comic; the chapter list stays the index
  const linkedRoute = /^\/api\/comics\/work\/([^/]+)\/(linked|availability|chapter|mark)$/.exec(p);
  if (linkedRoute && WORK_ID.test(linkedRoute[1])) {
    const workId = linkedRoute[1];
    const chapterLists = async () => {
      const links = deps.linked.list(workId);
      const title = links.length ? await workInfo(workId).then((info) => info.comic.title, () => "") : "";
      return Promise.all(links.map(async (link) => {
        try { return { link, chapters: await (deps.chapterList || extChapterList)(link, deps, title) }; } catch (error) { return { link, chapters: [], error: error.message }; }
      }));
    };
    const selectableUnits = (lists) => {
      const records = [];
      for (const { link, chapters } of lists) {
        for (const item of chapters) if (item.chapter && !item.externalUrl)
          records.push({ id: item.id, sourceId: link.sourceId, path: item.path, chapter: item.chapter, volume: item.volume || null });
      }
      for (const file of local.files(workId)) if (file.chapter && (!file.chapterEnd || file.chapterEnd === file.chapter))
        records.push({ id: file.id, sourceId: "local", chapter: file.chapter, volume: file.volume || null });
      return records;
    };
    if (linkedRoute[2] === "linked") {
      if (req.method === "GET") return send(200, { linked: deps.linked.list(workId) });
      if (req.method === "POST") {
        try {
          const choice = await body() || {};
          // Comics on video pages: an entry another comic uses joins that comic to this
          // page; a draft's first source gives it its title and cover.
          const target = deps.videoComics?.linkTarget(workId, choice) || workId;
          const result = deps.linked.link(target, choice);
          if (target === workId) deps.videoComics?.linkedFirst(workId, choice, deps.readSignedImage?.(choice.cover) || null);
          return send(200, { linked: result, workId: target });
        } catch (error) { return bad(error.message); }
      }
      if (req.method === "DELETE") return send(200, { removed: deps.linked.unlink(workId, url.searchParams.get("key")), linked: deps.linked.list(workId) });
      return ctx.methodNotAllowed(res, ["GET", "POST", "DELETE"]), true;
    }
    if (linkedRoute[2] === "mark") {
      if (req.method !== "POST") return ctx.methodNotAllowed(res, ["POST"]), true;
      let input;
      try { input = await ctx.readJsonBody(req, 16384); } catch { return bad("Invalid chapter selection"); }
      const ids = input?.ids;
      if (typeof input?.read !== "boolean" || !Array.isArray(ids) || !ids.length || ids.length > 200 || new Set(ids).size !== ids.length) return bad("Select 1–200 chapters");
      const beforeRevision = deps.linked.revision?.(workId) ?? null;
      const available = new Map(selectableUnits(await chapterLists()).map((item) => [item.id, item]));
      if ((deps.linked.revision?.(workId) ?? null) !== beforeRevision)
        return bad("The selected chapters changed. Refresh their sources.", 409);
      const selected = ids.map((id) => available.get(id));
      if (selected.some((item) => !item)) return bad("The selected chapters changed. Refresh their sources.", 409);
      try {
        const result = deps.marks.set(workId, selected, input.read);
        return send(200, { ...result, ...deps.marks.summary(workId) });
      } catch (error) { return bad(error.message); }
    }
    if (req.method !== "GET") return ctx.methodNotAllowed(res, ["GET"]), true;
    if (linkedRoute[2] === "availability") {
      const lists = await chapterLists();
      return send(200, { counts: deps.availability(lists), countsByUnit: availabilityByUnit(lists),
        chapters: sourceChapters(lists), units: selectableUnits(lists),
        sources: lists.map((item) => ({ ...item.link, chapters: item.chapters.length, error: item.error || null })) });
    }
    const chapter = String(url.searchParams.get("chapter") || "");
    if (!/^\d{1,5}(?:\.\d{1,2})?$/.test(chapter)) return bad("Invalid chapter");
    const volume = /^\d{1,5}(?:\.\d{1,2})?$/.test(url.searchParams.get("volume") || "") ? url.searchParams.get("volume") : null;
    return send(200, { candidates: deps.chapterCandidates({ chapter, volume, files: local.files(workId), chapterLists: await chapterLists() }) });
  }

  // ---- Per-comic source search (only when the user asks)
  const work = /^\/api\/comics\/work\/([^/]+)\/sources$/.exec(p);
  if (work) {
    if (req.method !== "GET") return ctx.methodNotAllowed(res, ["GET"]), true;
    if (!WORK_ID.test(work[1])) return bad("Invalid comic id");
    let info;
    try { info = await workInfo(work[1]); } catch (error) { return bad(error.message, Number(error.status) === 404 ? 404 : 502); }
    const title = info.comic.title;
    // Torrent names rarely carry full subtitles: try "Frieren: Beyond…", "Frieren", then the romaji alias.
    const variants = titleVariants(info.comic);
    const firstHit = async (search) => {
      for (const variant of variants) {
        const items = await search(variant);
        if (items.length) return items;
      }
      return [];
    };
    const jobs = sources.enabled().filter((source) => source.kind === "piratebay" || source.kind === "torznab").map(async (source) => {
      const base = { id: source.id, kind: source.kind, name: source.name };
      if (source.kind === "piratebay") return { ...base, ...await settle(source.id, () => firstHit(async (variant) => (await cached(`tpb:${source.config.category}:${variant.toLowerCase()}`, 60 * 60_000, () => searchPirateBay(variant, { category: source.config.category || 602 }))).value)) };
      return { ...base, ...await settle(source.id, () => firstHit((variant) => searchTorznab(variant, source.config))) };
    });
    return send(200, { title, sources: await Promise.all(jobs), downloads: downloads.list().filter((item) => item.workId === work[1]) });
  }

  // ---- Remote reading (pages proxied and cached; the browser never passes image URLs)
  const remote = /^\/api\/reader\/remote\/([a-z0-9-]{4,40})(?:\/pages\/(\d{1,4}))?$/.exec(p);
  if (remote) {
    if (req.method !== "GET") return ctx.methodNotAllowed(res, ["GET"]), true;
    if (!EXT_CHAPTER_ID.test(remote[1])) return bad("Unknown chapter", 404);
    const chapterId = deps.ext?.resolveChapterId?.(remote[1]) || remote[1];
    let pages;
    try {
      pages = (await cached(`pages:${chapterId}`, 10 * 60_000, () => (deps.chapterPages || extPages)(chapterId, deps))).value;
    } catch (error) { return bad(error.message, Number(error.status) === 404 ? 404 : 502); }
    if (!pages.length) return bad("This chapter has no page images (it may be a text chapter)", 502);
    if (remote[2] === undefined) {
      const workId = WORK_ID.test(url.searchParams.get("work") || "") ? url.searchParams.get("work") : null;
      const proved = workId ? await currentRemoteChapter(workId, chapterId, deps).catch(() => null) : null;
      if (workId && !proved) return bad("The source chapter is no longer linked to this work", 409);
      const progress = local.remoteProgress(chapterId, workId);
      const unread = workId && deps.marks?.isExplicitUnread(workId, chapterId);
      const pageWitness = remotePageManifestWitness(pages);
      const previous = workId ? local.remotePageWitness?.(workId, chapterId) : null;
      let resumed = progress ? { page: progress.page, pages: progress.pages, finished: Boolean(progress.finished) && !unread } : null;
      const pageRebased = Boolean(resumed && previous && previous.manifest_witness !== pageWitness);
      if (pageRebased) {
        // A saved number alone cannot identify the page after insertion or
        // reordering. Locate the saved image uniquely, otherwise reopen at 0.
        // The previous proof must belong to this exact saved progress write:
        // bulk unread or incoming peer updates can invalidate it.
        const matches = Number(previous.updated_at) === Number(progress.updated_at)
          ? pages.flatMap((page, index) => remotePageIdentity(page) === previous.image_witness ? [index] : [])
          : [];
        resumed = matches.length === 1
          ? { page: matches[0], pages: pages.length,
              finished: resumed.finished && matches[0] === pages.length - 1 }
          : { page: 0, pages: pages.length, finished: false };
      }
      // Opened from its address alone (a reload, a shared link): which chapter of the work this is.
      const about = workId && url.searchParams.get("describe") === "1" ? await describeRemoteChapter(workId, chapterId, deps).catch(() => null) : null;
      return send(200, { file: { id: chapterId, name: url.searchParams.get("name")?.slice(0, 120) || "", progress: resumed }, workId, pages: pages.length,
        pageWitness, pageRebased, progressGeneration: proved
          ? local.progressGeneration?.(workId, chapterId) ?? null : null,
        ...(proved ? { sourceId: proved.sourceId } : {}),
        prev: null, next: null,
        ...(about || {}), ...(pages[0]?.trim === "credit-strip" ? { trim: "credit-strip" } : {}) });
    }
    const target = pages[Number(remote[2])];
    if (!target) return bad("No such page", 404);
    const repairIncarnation = url.searchParams.get("cache-recover");
    if (repairIncarnation !== null && !/^[0-9a-f]{24}$/.test(repairIncarnation))
      return bad("Unverified image cache incarnation", 409);
    let image;
    try {
      const index = Number(remote[2]);
      const cacheKey = remotePageCacheKey(chapterId, index, pages);
      const loader = () => fetchPageImage(deps.remote, target, deps);
      image = repairIncarnation === null ? await images.get(cacheKey, loader)
        : await images.recover(cacheKey, repairIncarnation, loader);
    } catch (error) {
      if (error.status === 409) return bad(error.message, 409);
      if (!target.expires) return bad(error.message, 502);
      try {
        // The old signed URL expired. A refreshed URL belongs to its *new*
        // manifest cache generation, even when the page count is unchanged.
        const fresh = (await cached(`pages:${chapterId}`, 0,
          () => (deps.chapterPages || extPages)(chapterId, deps))).value;
        const index = Number(remote[2]);
        if (!fresh?.[index]) return bad("The chapter pages changed. Reload the reader.", 409);
        image = await images.get(remotePageCacheKey(chapterId, index, fresh),
          () => fetchPageImage(deps.remote, fresh[index], deps));
      } catch (freshError) { return bad(freshError.message, 502); }
    }
    // The public page URL contains only an ordinal. Do not let a browser
    // retain that URL after the page manifest has been reordered upstream.
    res.writeHead(200, { "Content-Type": image.type, "Content-Length": image.buffer.length,
      "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
      ...(image.incarnation ? { "X-LVL-Image-Incarnation": image.incarnation } : {}) });
    res.end(image.buffer);
    return true;
  }
  if (p === "/api/reader/remote-progress") {
    if (req.method !== "PUT") return ctx.methodNotAllowed(res, ["PUT"]), true;
    const input = await body() || {};
    if (!EXT_CHAPTER_ID.test(String(input.id)) || !WORK_ID.test(String(input.workId)))
      return bad("Invalid chapter");
    const chapterId = deps.ext?.resolveChapterId?.(input.id) || String(input.id);
    const known = await currentRemoteChapter(input.workId, chapterId, deps).catch(() => null);
    if (!known) return bad("The chapter is no longer linked to this comic. Refresh its sources.", 409);
    const requestedChapter = normalizeUnitNumber(input.chapter) || null;
    const requestedVolume = normalizeUnitNumber(input.volume) || null;
    if ((input.chapter != null && requestedChapter !== known.chapter) ||
        (input.volume != null && requestedVolume !== known.volume))
      return bad("The chapter numbers changed. Refresh its sources.", 409);
    let actualPages;
    try {
      actualPages = (await cached(`pages:${chapterId}`, 10 * 60_000,
        () => (deps.chapterPages || extPages)(chapterId, deps))).value;
    } catch { return bad("The chapter pages are unavailable. Try again.", 502); }
    if (!actualPages?.length || !Number.isSafeInteger(input.page) || input.page < 0 || input.page >= actualPages.length ||
        Number(input.pages) !== actualPages.length)
      return bad("The chapter page count changed. Reload the reader.", 409);
    const pageWitness = remotePageManifestWitness(actualPages);
    if (input.pageWitness != null && input.pageWitness !== pageWitness)
      return bad("The chapter pages changed. Reload the reader before saving progress.", 409);
    // The source may have been removed while page metadata was being fetched.
    if ((deps.linked.revision?.(input.workId) ?? null) !== known.revision ||
        !deps.linked.list(input.workId).some((link) => link.kind === "ext" &&
        link.sourceId === known.sourceId && link.mangaId === known.mangaId) ||
        deps.ext.chapter(chapterId)?.path !== known.path)
      return bad("The chapter is no longer linked to this comic. Refresh its sources.", 409);
    const journaled = input.progressVersion !== undefined || input.expectedGeneration !== undefined
      || input.operationId !== undefined;
    if (journaled && (input.sourceId !== known.sourceId || input.pageWitness !== pageWitness
      || !local.saveRemoteProgressCAS))
      return bad("The chapter source or page manifest changed. Reopen before saving.", 409);
    let accepted;
    try {
      accepted = journaled ? local.saveRemoteProgressCAS({
        version: input.progressVersion, workId: input.workId, fileId: chapterId,
        sourceId: input.sourceId, contentWitness: pageWitness, operationId: input.operationId,
        expectedGeneration: input.expectedGeneration, page: input.page, pages: actualPages.length,
        finished: input.finished, chapter: known.chapter, volume: known.volume,
        predecessorOperationId: input.predecessorOperationId,
        predecessorGeneration: input.predecessorGeneration,
        chapterPath: known.path, mangaId: known.mangaId,
        imageWitness: remotePageIdentity(actualPages[input.page]),
        markFinished: (workId, fileId) => deps.marks?.finish(workId, fileId, true),
      }) : { saved: local.saveRemoteProgress({ id: chapterId, workId: input.workId, page: input.page,
        pages: actualPages.length, chapter: known.chapter, volume: known.volume,
        manifestWitness: pageWitness, imageWitness: remotePageIdentity(actualPages[input.page]) }) };
    } catch (error) { return bad(error.message || "Reader progress conflict", error.status || 409); }
    const saved = accepted.saved;
    if (!journaled && saved?.finished) deps.marks?.finish(input.workId, chapterId, true);
    if (saved) await deps.onProgress?.(input.workId);
    return saved ? send(200, { progress: saved,
      ...(accepted.progressReceipt ? { progressReceipt: accepted.progressReceipt,
        progressDuplicate: accepted.duplicate === true } : {}) }) : bad("Invalid chapter");
  }
  if (p === "/api/comics/cache") {
    if (req.method === "GET") return send(200, await images.usage());
    if (req.method === "DELETE") { await images.clear(); return send(200, await images.usage()); }
    return ctx.methodNotAllowed(res, ["GET", "DELETE"]), true;
  }
  return false;
}
