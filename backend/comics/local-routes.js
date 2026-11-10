// Routes for local comic files. Mounted by server-feature.js.
import path from "node:path";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { listPages, readPage } from "../reader/pages.js";
import { WORK_ID } from "../../shared/reading/ids.js";

const FILE_ID = /^f[0-9a-f]{16}$/;

// Adding comic files by picking them (LVL's Android app can't read a folder of yours on the
// phone): each picked CBZ or ZIP is copied into the default comics folder and scanned like any
// file there. Names are reduced to a plain file name; an existing file is never replaced.
export const MAX_UPLOAD_BYTES = 4 * 1024 ** 3;
const UPLOAD_NAME = /^[^\\/:*?"<>|\u0000-\u001f]{1,180}\.(?:cbz|zip)$/i;
const PART_SUFFIX = /^(.+\.[A-Za-z]{3})\.([0-9a-f]{8}|[0-9a-f]{16})\.lvl-part$/;
const HOUR = 60 * 60 * 1000;
const ACTIVE_PARTS = new Set();
export const UPLOAD_CLEANUP_LIMITS = Object.freeze({
  ageMs: 24 * HOUR,
  intervalMs: 6 * HOUR,
  maxExamined: 4096,
  maxRemovedFiles: 64,
  maxRemovedBytes: 16 * 1024 ** 3,
});
export function uploadName(value) {
  const name = path.basename(String(value || "").replace(/\\/g, "/")).trim();
  return UPLOAD_NAME.test(name) && !name.startsWith(".") ? name : null;
}

async function closeUploadSweepCursor(cursor) {
  const handle = cursor.handle;
  cursor.handle = null;
  cursor.dev = null;
  cursor.ino = null;
  if (handle) await handle.close().catch((error) => {
    if (error?.code !== "ERR_DIR_CLOSED") throw error;
  });
}

// Only LVL's unique unfinished upload names in its own default Comics folder
// are candidates. Completed archives, other files, links and live writers remain owned.
export async function sweepAbandonedUploads(folder, {
  now = Date.now, ageMs = UPLOAD_CLEANUP_LIMITS.ageMs,
  maxExamined = UPLOAD_CLEANUP_LIMITS.maxExamined,
  maxRemovedFiles = UPLOAD_CLEANUP_LIMITS.maxRemovedFiles,
  maxRemovedBytes = UPLOAD_CLEANUP_LIMITS.maxRemovedBytes,
  shouldContinue = () => true,
  cursor = null,
} = {}) {
  const result = { examined: 0, removed: 0, removedBytes: 0 };
  const state = cursor || { handle: null, dev: null, ino: null };
  const dir = await fs.lstat(folder).catch(() => null);
  if (!dir?.isDirectory() || dir.isSymbolicLink()) {
    await closeUploadSweepCursor(state);
    return result;
  }
  const cutoff = now() - ageMs;
  if (state.handle && (state.dev !== dir.dev || state.ino !== dir.ino)) await closeUploadSweepCursor(state);
  if (!state.handle) {
    try {
      state.handle = await fs.opendir(folder);
      state.dev = dir.dev;
      state.ino = dir.ino;
    } catch { return result; }
  }
  let exhausted = false;
  let completed = false;
  try {
    while (shouldContinue() && result.examined < maxExamined && result.removed < maxRemovedFiles) {
      const entry = await state.handle.read();
      if (!entry) { exhausted = true; break; }
      result.examined++;
      if (!entry.isFile()) continue;
      const match = PART_SUFFIX.exec(entry.name);
      if (!match || uploadName(match[1]) !== match[1]) continue;
      const file = path.join(folder, entry.name);
      if (ACTIVE_PARTS.has(file)) continue;
      try {
        const old = await fs.lstat(file);
        if (!old.isFile() || old.nlink !== 1 || old.size > MAX_UPLOAD_BYTES || old.mtimeMs > cutoff) continue;
        if (result.removedBytes + old.size > maxRemovedBytes) continue;
        // Recheck identity and timestamp immediately before removal: a newly
        // opened writer or completed publication must not inherit a stale stat.
        if (ACTIVE_PARTS.has(file) || !shouldContinue()) break;
        const current = await fs.lstat(file);
        if (!current.isFile() || current.nlink !== 1 || current.ino !== old.ino || current.dev !== old.dev
          || current.size !== old.size || current.mtimeMs !== old.mtimeMs || current.ctimeMs !== old.ctimeMs) continue;
        if (ACTIVE_PARTS.has(file) || !shouldContinue()) break;
        await fs.unlink(file);
        result.removed++;
        result.removedBytes += old.size;
      } catch (error) {
        if (!["ENOENT", "EPERM", "EACCES", "EBUSY"].includes(error?.code)) throw error;
      }
    }
    completed = true;
  } finally {
    if (!cursor || exhausted || !shouldContinue() || !completed) await closeUploadSweepCursor(state);
  }
  return { ...result, hasMore: Boolean(state.handle) };
}

export function createUploadMaintenance(folder, options = {}) {
  let stopped = false;
  let timer = null;
  let continuation = null;
  let pending = null;
  const cursor = { handle: null, dev: null, ino: null };
  const run = () => {
    if (stopped) return Promise.resolve(null);
    if (pending) return pending;
    pending = sweepAbandonedUploads(folder, { ...options, cursor, shouldContinue: () => !stopped })
      .then((result) => {
        if (!stopped && result.hasMore && !continuation) {
          continuation = setTimeout(() => {
            continuation = null;
            void run().catch(() => {});
          }, options.continuationMs ?? 1000);
          continuation.unref?.();
        }
        return result;
      })
      .finally(() => { pending = null; });
    return pending;
  };
  return {
    start() {
      if (stopped) throw new Error("Upload cleanup has stopped");
      if (!timer) {
        timer = setInterval(() => { void run().catch(() => {}); }, options.intervalMs ?? UPLOAD_CLEANUP_LIMITS.intervalMs);
        timer.unref?.();
      }
      return run();
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      clearTimeout(continuation);
      timer = null;
      continuation = null;
      await pending?.catch(() => {});
      await closeUploadSweepCursor(cursor);
    },
  };
}

export async function saveUpload(req, folder, name, length) {
  await fs.mkdir(folder, { recursive: true });
  // The scanner reads only .cbz/.zip files, so the unfinished copy is never picked up.
  const part = path.join(folder, `${name}.${crypto.randomBytes(8).toString("hex")}.lvl-part`);
  let written = 0;
  const counter = new Transform({
    transform(chunk, _encoding, done) {
      written += chunk.length;
      done(written > length ? Object.assign(new Error("The file is larger than announced"), { statusCode: 400 }) : null, chunk);
    },
  });
  const sink = createWriteStream(part, { flags: "wx" });
  let ownsPart = false;
  sink.once("open", () => { ownsPart = true; ACTIVE_PARTS.add(part); });
  try {
    await pipeline(req, counter, sink);
    if (written !== length) throw Object.assign(new Error("The file didn't arrive completely"), { statusCode: 400 });
    // Same-directory hard-link creation is an atomic no-replace publication,
    // including across processes. Rename may replace someone else's completed
    // file after an access check, so never use it as a collision fallback.
    const ext = path.extname(name);
    const stem = name.slice(0, -ext.length);
    for (let n = 1; n < 100; n++) {
      const final = path.join(folder, n === 1 ? name : `${stem} (${n})${ext}`);
      try {
        await fs.link(part, final);
      } catch (error) {
        if (error.code === "EEXIST") continue;
        throw error; // Unsupported hard links fail closed: no visible partial.
      }
      // Publication already succeeded; a failed partial unlink must not make
      // the caller retry and publish the same complete upload a second time.
      await fs.rm(part, { force: true }).catch(() => {});
      return final;
    }
    throw Object.assign(new Error("Too many files with this name"), { statusCode: 409 });
  } catch (error) {
    // A rare token collision fails the exclusive wx open. Never unlink an
    // existing partial owned by another upload in that error path.
    if (ownsPart) await fs.rm(part, { force: true }).catch(() => {});
    throw error;
  } finally {
    if (ownsPart) ACTIVE_PARTS.delete(part);
  }
}

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
  if (p === "/api/comics/files") {
    if (req.method !== "POST") return ctx.methodNotAllowed(res, ["POST"]), true;
    const name = uploadName(url.searchParams.get("name"));
    if (!name) return bad("Only CBZ or ZIP files can be added");
    const length = Number(req.headers["content-length"]);
    if (!Number.isSafeInteger(length) || length < 1) return bad("The file is empty or its size is unknown", 411);
    if (length > MAX_UPLOAD_BYTES) return bad("This file is larger than 4 GB", 413);
    try {
      const saved = await saveUpload(req, local.defaultFolder, name, length);
      rescan();
      return ctx.json(res, 200, { file: path.basename(saved), folders: local.folders() }), true;
    } catch (error) {
      if (res.headersSent || res.destroyed) return true;
      return bad(error.message || "Couldn't add the file", error.statusCode || 500);
    }
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
    // Do not fetch/create an unrelated AniList Library card if this title has
    // nothing to transfer. A failed verification must not move its files or
    // existing reading history out of the local title.
    // local.files() is intentionally a readable-only view, but rematch() also
    // transfers temporarily errored archives and their saved reading history.
    // Use the Reader's all-owned-row predicate; tolerate small legacy stubs.
    const hasFiles = () => typeof local.hasLocalFiles === "function"
      ? local.hasLocalFiles(from) : local.files(from).length > 0;
    if (!hasFiles()) return bad("This title has no local files", 404);
    const status = from.startsWith("local-") ? local.localTitle(from)?.status : null;
    if (anilistId) {
      try {
        const entry = await ensureEntry(anilistId, status || "PLANNING", { isCurrent: hasFiles });
        if (!hasFiles()) return bad("This title has no local files", 404);
        if (entry?.id !== `anilist-${anilistId}` || !String(entry.work?.title || "").trim())
          throw new Error("Comic Library metadata is incomplete");
      } catch (error) { return bad(error.message || "Comic Library metadata is unavailable", 502); }
    }
    const target = local.rematch(from, anilistId ? `anilist-${anilistId}` : null);
    if (!target) return bad("This title has no local files", 404);
    return ctx.json(res, 200, { workId: target }), true;
  }

  if (p === "/api/reader/progress") {
    if (req.method !== "PUT") return ctx.methodNotAllowed(res, ["PUT"]), true;
    const input = await body();
    if (!FILE_ID.test(String(input?.fileId || ""))) return bad("Invalid file");
    const saved = local.saveProgress(input);
    if (saved && (input.finished === true || Number(input.page) >= Number(input.pages) - 1)) deps.marks?.finish(local.file(input.fileId)?.work_id, input.fileId, true);
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

