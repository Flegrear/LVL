// Routes for local comic files. Mounted by server-feature.js.
import path from "node:path";
import { listPages, readPage } from "../reader/pages.js";
import { WORK_ID } from "../../shared/reading/ids.js";

const FILE_ID = /^f[0-9a-f]{16}$/;

export function localTitleEntry(row, files, cover) {
  return {
    id: row.id, anilistId: null, local: true, status: row.status, addedAt: row.added_at, updatedAt: row.updated_at,
    work: { id: row.id, title: row.title, aliases: [], cover, format: "LOCAL", files },
  };
}

// deps: { ctx, local, store, ensureEntry(anilistId, status) }
export async function handleLocalRoutes(req, res, url, deps) {
  const { ctx, local, ensureEntry, rescan } = deps;
  const p = url.pathname;
  const body = async () => { try { return await ctx.readJsonBody(req, 8192); } catch { return null; } };
  const bad = (message, status = 400) => (ctx.json(res, status, { error: message }), true);

  if (p === "/api/comics/folders") {
    if (req.method === "GET") return ctx.json(res, 200, { folders: local.folders(), defaultFolder: local.defaultFolder }), true;
    if (req.method === "POST") {
      const input = await body();
      try {
        const folder = await local.addFolder(input?.path);
        rescan();
        return ctx.json(res, 200, { folder, folders: local.folders() }), true;
      } catch (error) { return bad(error.message); }
    }
    if (req.method === "DELETE") {
      const input = await body();
      const removed = local.removeFolder(input?.path);
      if (removed) rescan();
      return ctx.json(res, 200, { removed, folders: local.folders() }), true;
    }
    return ctx.methodNotAllowed(res, ["GET", "POST", "DELETE"]), true;
  }
  if (p === "/api/comics/folders/rescan") {
    if (req.method !== "POST") return ctx.methodNotAllowed(res, ["POST"]), true;
    const result = await rescan({ wait: true });
    return ctx.json(res, 200, { ...result, folders: local.folders() }), true;
  }

  const files = /^\/api\/comics\/work\/([^/]+)\/files$/.exec(p);
  if (files) {
    if (req.method !== "GET") return ctx.methodNotAllowed(res, ["GET"]), true;
    if (!WORK_ID.test(files[1])) return bad("Invalid comic id");
    return ctx.json(res, 200, { files: local.files(files[1]) }), true;
  }
  const rematch = /^\/api\/comics\/work\/([^/]+)\/match$/.exec(p);
  if (rematch) {
    if (req.method !== "PUT") return ctx.methodNotAllowed(res, ["PUT"]), true;
    const from = rematch[1];
    if (!WORK_ID.test(from)) return bad("Invalid comic id");
    const input = await body();
    const anilistId = input?.anilistId === null ? null : Number(input?.anilistId);
    if (anilistId !== null && !(Number.isInteger(anilistId) && anilistId > 0)) return bad("Choose a title");
    const status = from.startsWith("local-") ? local.localTitle(from)?.status : null;
    const target = local.rematch(from, anilistId ? `anilist-${anilistId}` : null);
    if (!target) return bad("This title has no local files", 404);
    if (anilistId) {
      try { await ensureEntry(anilistId, status || "PLANNING"); } catch (error) { return bad(error.message, 502); }
    }
    return ctx.json(res, 200, { workId: target }), true;
  }

  if (p === "/api/reader/progress") {
    if (req.method !== "PUT") return ctx.methodNotAllowed(res, ["PUT"]), true;
    const input = await body();
    if (!FILE_ID.test(String(input?.fileId || ""))) return bad("Invalid file");
    const saved = local.saveProgress(input);
    if (saved) await deps.onProgress?.(local.file(input.fileId)?.work_id);
    return saved ? (ctx.json(res, 200, { file: saved }), true) : bad("Unknown file", 404);
  }
  const reader = /^\/api\/reader\/files\/(f[0-9a-f]{16})(?:\/pages\/(\d{1,5}))?$/.exec(p);
  if (reader) {
    if (req.method !== "GET") return ctx.methodNotAllowed(res, ["GET"]), true;
    const row = local.file(reader[1]);
    if (!row || row.error) return bad("Unknown file", 404);
    let listed;
    try { listed = await listPages(row); } catch (error) { return bad(error.message, 422); }
    if (reader[2] === undefined) {
      const siblings = local.files(row.work_id);
      const index = siblings.findIndex((item) => item.id === row.id);
      return ctx.json(res, 200, {
        file: siblings[index] || null, workId: row.work_id, pages: listed.pages.length,
        prev: index > 0 ? siblings[index - 1].id : null, next: index >= 0 && index < siblings.length - 1 ? siblings[index + 1].id : null,
      }), true;
    }
    const name = listed.pages[Number(reader[2])];
    if (!name) return bad("No such page", 404);
    const tag = `"${row.id}-${row.size}-${row.mtime}-${reader[2]}"`;
    if (req.headers["if-none-match"] === tag) { res.writeHead(304); res.end(); return true; }
    let page;
    try { page = await readPage(row, name); } catch (error) { return bad(error.message, 422); }
    if (!page) return bad("Not an image", 415);
    res.writeHead(200, {
      "Content-Type": page.type, "Content-Length": page.buffer.length, ETag: tag,
      "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `inline; filename="${path.basename(name).replace(/[^\w.-]/g, "_")}"`,
    });
    res.end(req.method === "HEAD" ? undefined : page.buffer);
    return true;
  }
  return false;
}

