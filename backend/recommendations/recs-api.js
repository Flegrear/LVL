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
    json(res, 200, recs.linkAuthenticatedAniList(await readJsonBody(req, 8 * 1024 * 1024)));
    return true;
  }
  if (pathname === "/api/recs/anilist/sync") return post(() => recs.syncAniList());
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
        title: String(url.searchParams.get("title") || "").slice(0, 300),
        year: Number(url.searchParams.get("year")) || null,
      }));
      return true;
    }
    return post((body) => recs.rate(body));
  }
  return false;
}
