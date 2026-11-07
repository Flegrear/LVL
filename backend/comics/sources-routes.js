// Routes for comic sources. Mounted by server-feature.js.
// Reading sources are extensions from Mihon repositories (ext-routes.js);
// torrent indexers find packs to download.
import { searchPirateBay, searchTorznab } from "./torrent-search.js";
import { extChapterList, extPages, fetchPageImage, handleExtRoutes, titleVariants } from "./ext-routes.js";
import { sourceChapters } from "./linked-sources.js";
import { EXT_CHAPTER_ID, WORK_ID } from "../../shared/reading/ids.js";
import { normalizeUnitNumber } from "../../shared/reading/units.js";

// Which chapter of a work an "ex-" reader id is: { chapter, volume, source }, from the chapter
// list of the chosen source it belongs to (cached for an hour, like the title page's).
export async function describeRemoteChapter(workId, readerId, deps) {
  const known = deps.ext.chapter(readerId);
  if (!known) return null;
  const links = deps.linked.list(workId).filter((link) => link.kind === "ext" && link.sourceId === known.sourceId);
  if (!links.length) return null;
  const title = await deps.workInfo(workId).then((info) => info.comic.title, () => "");
  for (const link of links) {
    const item = (await extChapterList(link, deps, title).catch(() => [])).find((entry) => entry.id === readerId);
    const chapter = item ? normalizeUnitNumber(item.chapter) : "";
    if (chapter) return { chapter, volume: normalizeUnitNumber(item.volume) || null, source: link.name || "" };
  }
  return null;
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
        try { return { link, chapters: await extChapterList(link, deps, title) }; } catch (error) { return { link, chapters: [], error: error.message }; }
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
      const available = new Map(selectableUnits(await chapterLists()).map((item) => [item.id, item]));
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
      return send(200, { counts: deps.availability(lists), chapters: sourceChapters(lists), units: selectableUnits(lists),
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
    let pages;
    try {
      pages = (await cached(`pages:${remote[1]}`, 10 * 60_000, () => extPages(remote[1], deps))).value;
    } catch (error) { return bad(error.message, Number(error.status) === 404 ? 404 : 502); }
    if (!pages.length) return bad("This chapter has no page images (it may be a text chapter)", 502);
    if (remote[2] === undefined) {
      const workId = WORK_ID.test(url.searchParams.get("work") || "") ? url.searchParams.get("work") : null;
      const progress = local.remoteProgress(remote[1]);
      const unread = workId && deps.marks?.isExplicitUnread(workId, remote[1]);
      // Opened from its address alone (a reload, a shared link): which chapter of the work this is.
      const about = workId && url.searchParams.get("describe") === "1" ? await describeRemoteChapter(workId, remote[1], deps).catch(() => null) : null;
      return send(200, { file: { id: remote[1], name: url.searchParams.get("name")?.slice(0, 120) || "", progress: progress ? { page: progress.page, pages: progress.pages, finished: Boolean(progress.finished) && !unread } : null }, workId, pages: pages.length, prev: null, next: null,
        ...(about || {}), ...(pages[0]?.trim === "credit-strip" ? { trim: "credit-strip" } : {}) });
    }
    const target = pages[Number(remote[2])];
    if (!target) return bad("No such page", 404);
    let image;
    try {
      image = await images.get(`${remote[1]}:${remote[2]}`, async () => {
        try { return await fetchPageImage(deps.remote, target, deps); } catch (error) {
          if (!target.expires) throw error;
          // The chapter's access token ran out: ask the site for the pages again.
          const fresh = (await cached(`pages:${remote[1]}`, 0, () => extPages(remote[1], deps))).value;
          return fetchPageImage(deps.remote, fresh[Number(remote[2])] || target, deps);
        }
      });
    } catch (error) { return bad(error.message, 502); }
    res.writeHead(200, { "Content-Type": image.type, "Content-Length": image.buffer.length, "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff" });
    res.end(image.buffer);
    return true;
  }
  if (p === "/api/reader/remote-progress") {
    if (req.method !== "PUT") return ctx.methodNotAllowed(res, ["PUT"]), true;
    const input = await body() || {};
    const saved = local.saveRemoteProgress(input);
    if (saved && Number(input.page) >= Number(input.pages) - 1) deps.marks?.finish(input.workId, input.id, true);
    if (saved) await deps.onProgress?.(input.workId);
    return saved ? send(200, { progress: saved }) : bad("Invalid chapter");
  }
  if (p === "/api/comics/cache") {
    if (req.method === "GET") return send(200, await images.usage());
    if (req.method === "DELETE") { await images.clear(); return send(200, await images.usage()); }
    return ctx.methodNotAllowed(res, ["GET", "DELETE"]), true;
  }
  return false;
}
