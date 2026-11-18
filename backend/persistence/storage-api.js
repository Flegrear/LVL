// Settings › Storage on the server: usage, limits and clearing.
import {
  indexedVideoCache, progressiveIndexCache, progressiveIslandStarts, progressiveStarts,
  remuxSegmentCache, storage,
} from "../../server.js";
import { json, methodNotAllowed, readJsonBody } from "../app/http-helpers.js";
import { closeProgressiveReadyListeners } from "../streaming/torrent-stream.js";
import { STORAGE_RANGES } from "./storage.js";

// Player storage: downloads you aren't watching go first when the limit is reached.
let enforcingPlayerStorage = false;
let storageOperations = Promise.resolve();
// One admission queue for cleanup, user-triggered clear and limit changes.
// In particular the scheduled retention sweep cannot race a manual clear.
export function runStorageOperation(operation) {
  const run = storageOperations.then(operation, operation);
  storageOperations = run.catch(() => {});
  return run;
}
export async function enforcePlayerStorage() {
  if (enforcingPlayerStorage) return;
  enforcingPlayerStorage = true;
  try {
    const result = await runStorageOperation(() => storage.enforcePlayer());
    if (result.evicted.length) console.log(`Player storage: freed ${result.evicted.length} download(s) to stay under ${Math.round(result.limitBytes / 1024 ** 3)} GB`);
  } catch (error) {
    console.warn("Player storage check failed:", error.message);
  } finally {
    enforcingPlayerStorage = false;
  }
}

export async function handleStorageApi(req, res, url) {
  const { pathname } = url;
  if (pathname === "/api/storage") {
    if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
    json(res, 200, await storage.report());
    return true;
  }
  if (pathname === "/api/storage/limits") {
    // The Android player checks the limit before each video. The complete
    // storage report scans download directories and is expensive on a phone.
    if (req.method === "GET") {
      json(res, 200, { limits: storage.limits() });
      return true;
    }
    if (req.method !== "POST") return methodNotAllowed(res, ["GET", "POST"]);
    const body = await readJsonBody(req);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      json(res, 400, { error: "Storage limits require a JSON object" });
      return true;
    }
    if (body.remuxCacheEnabled !== undefined && typeof body.remuxCacheEnabled !== "boolean") {
      json(res, 400, { error: "remuxCacheEnabled must be a boolean" });
      return true;
    }
    const gb = (value) => (value === undefined || value === null || value === "" ? undefined : Number(value) * 1024 ** 3);
    for (const [field, range] of [["playerGB", STORAGE_RANGES.playerBytes], ["clipGB", STORAGE_RANGES.clipBytes]]) {
      if (body[field] === undefined || body[field] === null || body[field] === "") continue;
      const value = gb(body[field]);
      if (typeof body[field] === "boolean" || !Number.isFinite(value) || value < range.min || value > range.max) {
        json(res, 400, {
          error: `${field} must be a finite storage limit between ${range.min / 1024 ** 3} and ${range.max / 1024 ** 3} GB`,
        });
        return true;
      }
    }
    return runStorageOperation(async () => {
    // A budget reduction can delete saved learning clips on the next cleanup.
    // Require an explicit, reviewed second request before applying that change.
    const clipBytes = gb(body.clipGB);
    const currentClipBytes = storage.limits().clipBytes;
    if (Number.isFinite(clipBytes) && Math.round(clipBytes) !== currentClipBytes) {
      const preview = await storage.report();
      if (preview.clips.evictionSupported !== true) {
        json(res, 409, {
          error: "clip_retention_unmanaged",
          message: "This build can report saved clips but has no active clip retention manager. The clip limit cannot be changed until clip cleanup is supported.",
          usedBytes: preview.clips.usedBytes,
        });
        return true;
      }
    }
    if (Number.isFinite(clipBytes) && clipBytes < currentClipBytes) {
      const preview = await storage.report();
      if (clipBytes < preview.clips.usedBytes && body.confirmClipEviction !== true) {
        json(res, 409, {
          error: "clip_budget_confirmation_required",
          message: "Reducing this limit could remove saved learning clips. Confirm the change to continue.",
          usedBytes: preview.clips.usedBytes,
          requestedBytes: clipBytes,
          clipCount: preview.clips.cardCount + preview.clips.dictationCount,
        });
        return true;
      }
    }
    storage.setLimits({
      playerBytes: gb(body.playerGB), clipBytes: gb(body.clipGB),
      remuxCacheEnabled: body.remuxCacheEnabled,
    });
    if (body.remuxCacheEnabled === false) await remuxSegmentCache.purgeIdle();
    if (body.remuxCacheEnabled === false) await indexedVideoCache.purgeAll();
    if (body.remuxCacheEnabled === false) {
      progressiveStarts.clear();
      progressiveIslandStarts.clear();
      closeProgressiveReadyListeners();
      await progressiveIndexCache.purgeAll();
    }
    // Already holding the storage operation lease: do not enqueue behind self.
    await storage.enforcePlayer();

    json(res, 200, await storage.report());
    return true;
    });
  }
  if (pathname === "/api/storage/clear-player" || pathname === "/api/storage/clear-leftovers") {
    if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
    return runStorageOperation(async () => {
    const result = pathname.endsWith("leftovers") ? await storage.clearLeftovers() : await storage.clearPlayer();
    json(res, 200, { ...result, report: await storage.report() });
    return true;
    });
  }
  return false;
}
