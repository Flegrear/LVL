import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { media } from "./recs-fixtures.js";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function request(port, method, pathname, { headers = {}, body = null, raw = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = raw ?? (body === null ? null : Buffer.from(JSON.stringify(body)));
    const req = http.request({ host: "127.0.0.1", port, method, path: pathname, headers: { ...(payload && !raw ? { "Content-Type": "application/json" } : {}), ...(payload ? { "Content-Length": payload.length } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, json, text });
      });
    });
    req.on("error", reject);
    req.setTimeout(20_000, () => req.destroy(new Error("request timed out")));
    if (payload) req.write(payload);
    req.end();
  });
}

// AniList GraphQL and Cinemeta search, answered locally.
function startStub() {
  const anime = {
    154587: media(154587, { title: { english: "Frieren: Beyond Journey's End", romaji: "Sousou no Frieren" }, seasonYear: 2023, genres: ["Adventure", "Fantasy"],
      recommendations: { nodes: [{ rating: 1191, mediaRecommendation: { id: 21827 } }] } }),
    113415: media(113415, { title: { english: "JUJUTSU KAISEN", romaji: "Jujutsu Kaisen" }, genres: ["Action"], recommendations: { nodes: [{ rating: 800, mediaRecommendation: { id: 127230 } }] } }),
    21827: media(21827, { title: { english: "Violet Evergarden", romaji: "Violet Evergarden" }, seasonYear: 2018, averageScore: 85, genres: ["Drama", "Fantasy"] }),
    127230: media(127230, { title: { english: "Chainsaw Man", romaji: "Chainsaw Man" }, seasonYear: 2022, genres: ["Action"] }),
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const reply = (data) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };
      if (req.method === "GET" && req.url.includes("/search=")) {
        const query = decodeURIComponent(req.url.match(/search=([^/]+)\.json/)[1]);
        const metas = query === "Violet Evergarden" && req.url.includes("/series/") ? [{ id: "tt7078180", name: "Violet Evergarden", type: "series", releaseInfo: "2018", poster: "" }] : [];
        reply({ metas });
        return;
      }
      const { query, variables } = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      if (query.includes("MediaListCollection")) {
        if (variables.name !== "me") { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ errors: [{ message: "User not found" }] })); return; }
        reply({ data: { MediaListCollection: { user: { id: 1, name: "me" }, lists: [{ entries: [{ status: "COMPLETED", score: 9.7, progress: 28, updatedAt: 1_700_000_000, media: anime[154587] }] }] } } });
      } else if (query.includes("id_in")) {
        reply({ data: { Page: { media: variables.ids.map((id) => anime[id]).filter(Boolean) } } });
      } else if (query.includes("search:")) {
        reply({ data: { Page: { media: variables.q === "Jujutsu Kaisen" ? [{ id: 113415, format: "TV", seasonYear: 2020, popularity: 900000, title: anime[113415].title, synonyms: [] }] : [] } } });
      } else reply({ data: {} });
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

test("recommendation routes: link AniList, rate, refresh, picks matched to titles, export; other sites refused", { timeout: 40_000 }, async () => {
  const stub = await startStub();
  const stubUrl = `http://127.0.0.1:${stub.address().port}`;
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "language-video-learner-recs-"));
  const tempRoot = path.join(dataRoot, "tmp");
  fs.mkdirSync(tempRoot, { recursive: true });
  const port = await freePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: projectRoot,
    env: { ...process.env, PORT: String(port), LANGUAGE_VIDEO_LEARNER_DATA_ROOT: dataRoot, TEMP: tempRoot, TMP: tempRoot, TMPDIR: tempRoot,
      LANGUAGE_VIDEO_LEARNER_ANILIST_URL: `${stubUrl}/graphql`, LANGUAGE_VIDEO_LEARNER_CINEMETA_URL: stubUrl },
    stdio: "ignore",
    windowsHide: true,
  });
  const own = { Origin: `http://127.0.0.1:${port}`, "Sec-Fetch-Site": "same-origin" };
  try {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try { if ((await request(port, "GET", "/api/recs")).status === 200) break; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const start = await request(port, "GET", "/api/recs");
    assert.equal(start.status, 200);
    assert.equal(start.json.settings.mode, "auto", "recommendation generation is automatic daily by default");
    assert.equal(start.json.settings.intervalDays, 1);
    assert.deepEqual(start.json.picks, []);

    assert.equal((await request(port, "POST", "/api/recs/settings", { headers: { Origin: "https://example.com", "Sec-Fetch-Site": "cross-site" }, body: { mode: "auto" } })).status, 403);
    assert.equal((await request(port, "GET", "/api/recs/export", { headers: { Host: `attacker.example:${port}` } })).status, 403);
    assert.equal((await request(port, "POST", "/api/recs/settings", { headers: own, body: { mode: "sometimes" } })).status, 400);

    // The authenticated browser uploads only list metadata. The localhost
    // server must not perform a username lookup or receive the OAuth token.
    const authorizedSnapshot = {
      Viewer: { id: 88, name: "authorized" },
      MediaListCollection: { user: { id: 88, name: "authorized" }, lists: [{ entries: [
        { status: "CURRENT", score: 7.5, progress: 3, updatedAt: 1_700_000_123,
          media: media(154587, { title: { english: "Frieren: Beyond Journey's End", romaji: "Sousou no Frieren" }, seasonYear: 2023 }) },
      ] }] },
    };
    const authLink = await request(port, "POST", "/api/recs/anilist/authenticated", { headers: own, body: authorizedSnapshot });
    assert.equal(authLink.status, 200, authLink.text);
    assert.equal(authLink.json.settings.anilist.username, "authorized");
    assert.equal(authLink.json.settings.anilist.count, 1);
    const malformedAuth = await request(port, "POST", "/api/recs/anilist/authenticated", { headers: own,
      body: { Viewer: { id: 88, name: "authorized" }, MediaListCollection: { lists: [{ missing: true }] } } });
    assert.equal(malformedAuth.status, 400, malformedAuth.text);
    assert.equal((await request(port, "GET", "/api/recs")).json.settings.anilist.username, "authorized", "Invalid replacement preserves snapshot");
    assert.equal((await request(port, "POST", "/api/recs/anilist/authenticated", { headers: { ...own, Origin: "https://attacker.example" }, body: authorizedSnapshot })).status, 403);

    const missing = await request(port, "POST", "/api/recs/anilist/link", { headers: own, body: { username: "nobody" } });
    assert.equal(missing.status, 404, missing.text);
    const linked = await request(port, "POST", "/api/recs/anilist/link", { headers: own, body: { username: "me" } });
    assert.equal(linked.status, 200, linked.text);
    assert.equal(linked.json.settings.anilist.username, "me");

    const rated = await request(port, "POST", "/api/ratings", { headers: own, body: { catalogId: "tt12343534", title: "Jujutsu Kaisen", kind: "anime", year: 2020, score: 9.004 } });
    assert.equal(rated.status, 200, rated.text);
    assert.equal(rated.json.rating.score, 9);
    assert.equal((await request(port, "POST", "/api/ratings", { headers: own, body: { catalogId: "tt12343534", title: "x", score: "abc" } })).status, 400);
    const frieren = await request(port, "GET", `/api/ratings?catalogId=tt22248376&title=${encodeURIComponent("Frieren: Beyond Journey's End")}&year=2023`);
    assert.deepEqual(frieren.json.ratings.map((rating) => [rating.source, rating.score]), [["anilist", 9.7]]);

    assert.equal((await request(port, "POST", "/api/recs/refresh", { headers: own, body: {} })).status, 202);
    let overview = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      overview = (await request(port, "GET", "/api/recs")).json;
      if (!overview.status.running && overview.status.lastRun) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(overview.status.lastRun.status, "done", JSON.stringify(overview.status));
    const titles = overview.picks.map((pick) => pick.title);
    assert.ok(titles.includes("Violet Evergarden") && titles.includes("Chainsaw Man"), titles.join(", "));
    assert.equal(overview.picks.find((pick) => pick.title === "Violet Evergarden").imdbId, "tt7078180");

    const exported = await request(port, "GET", "/api/recs/export");
    assert.equal(exported.status, 200);
    assert.match(exported.headers["content-disposition"], /attachment; filename="lvl-recommendations-/);
    assert.ok(exported.json.shows.some((show) => show.title === "Violet Evergarden"));
    const csv = await request(port, "GET", "/api/recs/export?format=csv");
    assert.match(csv.text, /^title,season,score/);

    assert.equal((await request(port, "POST", "/api/recs/tmdb", { headers: own, body: { key: "nope" } })).status, 400);
    const imported = await request(port, "POST", "/api/recs/letterboxd/import", { headers: { ...own, "Content-Type": "text/csv" }, raw: Buffer.from("Date,Name,Year,Rating\n2024-01-01,Heat,1995,4.5\n") });
    assert.equal(imported.status, 200, imported.text);
    assert.equal(imported.json.settings.letterboxd.imported, 1);

    const violet = overview.picks.find((pick) => pick.title === "Violet Evergarden");
    const hidden = await request(port, "POST", "/api/recs/hide", { headers: own, body: { itemId: violet.itemId } });
    assert.ok(!hidden.json.picks.some((pick) => pick.itemId === violet.itemId));
  } finally {
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
    }
    await new Promise((resolve) => stub.close(resolve));
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
  });
