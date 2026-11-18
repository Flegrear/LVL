// The recommendations routes (/api/recs/*).
import { exportRecsData, ratingsCsv } from "./recs-export.js";
import { recs, recsStore } from "../../server.js";
import { json, methodNotAllowed, readBinaryBody, readJsonBody } from "../app/http-helpers.js";

// Recommendations: picks and settings, linked accounts, your ratings and the export.
export async function handleRecsApi(req, res, url) {
  const { pathname } = url;
  const post = async (work) => {
    if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
    json(res, 200, await work(await readJsonBody(req)));
    return true;
  };
  if (pathname === "/api/recs") {
    if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
    json(res, 200, recs.overview());
    return true;
  }
  if (pathname === "/api/recs/refresh") {
    if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
    const running = recs.status().running;
    // Answers right away; the page polls /api/recs while the refresh runs.
    recs.refresh({ trigger: "manual" }).catch((error) => console.warn("Recommendations refresh failed:", error.message));
    json(res, 202, { ...recs.overview(), alreadyRunning: Boolean(running) });
    return true;
  }
  if (pathname === "/api/recs/settings") return post((body) => recs.updateSettings({ mode: body.mode, intervalDays: body.intervalDays }));
  if (pathname === "/api/recs/anilist/link") return post((body) => recs.linkAniList(body.username));
  if (pathname === "/api/recs/anilist/authenticated") {
    if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
    // Accept ephemeral credentials only from LVL's own localhost page. The
    // browser's Viewer/list JSON is not authenticated and is never imported.
    const origin = req.headers.origin;
    let sameLocalOrigin = !origin;
    if (origin) {
      try {
        const parsed = new URL(origin);
        sameLocalOrigin = parsed.protocol === "http:"
          && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
          && parsed.host === req.headers.host;
      } catch { sameLocalOrigin = false; }
    }
    if (!sameLocalOrigin) throw Object.assign(new Error("AniList import requires LVL's local application origin."), { statusCode: 403 });
    const bearer = /^Bearer ([A-Za-z0-9_.-]{40,4096})$/.exec(String(req.headers.authorization || ""));
    if (!bearer) throw Object.assign(new Error("Reconnect AniList before importing authenticated ratings."), { statusCode: 401 });
    const body = await readJsonBody(req, 2048);
    const abort = new AbortController();
    const onClose = () => abort.abort();
    res.once("close", onClose);
    try {
      const result = await recs.linkAuthenticatedAniList({
        token: bearer[1], userId: body.userId, scoreSyncEnabled: body.scoreSyncEnabled,
      }, { signal: abort.signal });
      if (!res.destroyed) json(res, 200, result);
    } finally {
      res.off("close", onClose);
    }
    return true;
  }
  if (pathname === "/api/recs/anilist/sync") return post(() => recs.syncAniList());
  if (pathname === "/api/recs/anilist/score-sync/disable") {
    if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
    // This local-only opt-out never grants authenticated authority; enabling
    // still requires the independently verified bearer import.
    const origin = req.headers.origin;
    if (origin) {
      let valid = false;
      try {
        const parsed = new URL(origin);
        valid = parsed.protocol === "http:"
          && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
          && parsed.host === req.headers.host;
      } catch {}
      if (!valid) throw Object.assign(new Error("AniList score settings require the local application origin."), { statusCode: 403 });
    }
    const body = await readJsonBody(req, 512);
    json(res, 200, recs.disableAuthenticatedAniListScores(body.userId));
    return true;
  }
  if (pathname === "/api/recs/anilist/unlink") return post(() => recs.unlinkAniList());
  if (pathname === "/api/recs/anilist/library") {
    if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
    json(res, 200, await recs.anilistLibrary());
    return true;
  }
  if (pathname === "/api/recs/tmdb") return post((body) => recs.setTmdbKey(body.key));
  if (pathname === "/api/recs/letterboxd/link") return post((body) => recs.linkLetterboxd(body.username));
  if (pathname === "/api/recs/letterboxd/unlink") return post(() => recs.unlinkLetterboxd());
  if (pathname === "/api/recs/letterboxd/import") {
    if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
    const body = await readBinaryBody(req, 40 * 1024 * 1024);
    if (!body.length) {
      json(res, 400, { error: "No file was received" });
      return true;
    }
    json(res, 200, recs.importLetterboxd(body));
    return true;
  }
  if (pathname === "/api/recs/hide") return post((body) => recs.hide(body.itemId));
  if (pathname === "/api/recs/unhide-all") return post(() => recs.unhideAll());
  if (pathname === "/api/recs/clear-cache") return post(() => recs.clearCache());
  if (pathname === "/api/recs/export") {
    if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
    const csv = url.searchParams.get("format") === "csv";
    const stamp = new Date().toISOString().slice(0, 10);
    const payload = Buffer.from(csv ? ratingsCsv(recsStore) : `${JSON.stringify(exportRecsData(recsStore), null, 2)}\n`, "utf8");
    res.writeHead(200, {
      "Content-Type": csv ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="lvl-${csv ? "ratings" : "recommendations"}-${stamp}.${csv ? "csv" : "json"}"`,
      "Content-Length": payload.length,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(payload);
    return true;
  }
  if (pathname === "/api/ratings") {
    if (req.method === "GET") {
      json(res, 200, recs.titleRatings({
        catalogId: String(url.searchParams.get("catalogId") || "").slice(0, 20),
        seriesKey: String(url.searchParams.get("key") || "").slice(0, 300),
        kind: String(url.searchParams.get("kind") || "").slice(0, 20),
        title: String(url.searchParams.get("title") || "").slice(0, 300),
        year: Number(url.searchParams.get("year")) || null,
        anilistIds: String(url.searchParams.get("anilistIds") || "").slice(0, 500).split(",")
          .filter((id) => /^[1-9]\d{0,14}$/.test(id)).map(Number).filter(Number.isSafeInteger).slice(0, 30),
      }));
      return true;
    }
    return post((body) => recs.rate(body));
  }
  return false;
}
