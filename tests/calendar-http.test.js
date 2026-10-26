import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const close = (server) => new Promise((resolve) => server.close(resolve));

test("Isolated LVL server exposes the real release calendar endpoint and keeps keys private", { timeout: 30_000 }, async () => {
  const portPicker = net.createServer();
  await listen(portPicker);
  const port = portPicker.address().port;
  await close(portPicker);
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    let payload;
    if (req.method === "POST" && body.includes("relations")) {
      const ids = JSON.parse(body).variables.ids;
      payload = { data: { Page: { media: ids.map((id) => id === 100 ? {
        id: 100, format: "TV", relations: { edges: [{ relationType: "SEQUEL",
          node: { id: 200, type: "ANIME", format: "TV" } }] },
      } : id === 200 ? { id: 200, format: "TV", title: { english: "A Saved Show Season 2" },
        coverImage: { large: "https://example.test/season-2.jpg" },
        nextAiringEpisode: { id: 701, airingAt: Date.parse("2026-10-21T16:00:00Z") / 1000, episode: 3 },
        relations: { edges: [] } } : null).filter(Boolean) } } };
    } else if (req.method === "POST" && body.includes("airingSchedules")) {
      const filtered = JSON.parse(body).variables.ids;
      payload = { data: { Page: { pageInfo: { hasNextPage: false }, airingSchedules: [{
        id: filtered ? 702 : 700, airingAt: Date.parse("2026-10-20T16:00:00Z") / 1000, episode: 4,
        media: { id: filtered ? 200 : 17, format: "TV", title: { english: filtered ? "A Saved Show Season 2" : "Schedule Example" } },
      }] } } };
    } else payload = [{ id: 99, season: 1, number: 2, name: "Episode Two", airstamp: "2026-10-21T02:00:00Z",
      show: { id: 20, name: "Shows Example" } }];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  });
  await listen(upstream);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lvl-calendar-http-"));
  const child = spawn(process.execPath, ["server.js"], {
    cwd: projectRoot, stdio: ["ignore", "ignore", "ignore"],
    env: {
      ...process.env, PORT: String(port), LANGUAGE_VIDEO_LEARNER_DATA_ROOT: tempRoot,
      LANGUAGE_VIDEO_LEARNER_ANILIST_URL: `http://127.0.0.1:${upstream.address().port}/anilist`,
      LANGUAGE_VIDEO_LEARNER_TVMAZE_SCHEDULE_URL: `http://127.0.0.1:${upstream.address().port}/tvmaze`,
    },
  });
  try {
    let ready = false;
    for (let tries = 0; tries < 100; tries++) {
      if (child.exitCode !== null) throw new Error("LVL server exited during startup");
      try {
        const health = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (health.ok) { ready = true; break; }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(ready, "Isolated server started");
    const invalid = await fetch(`http://127.0.0.1:${port}/api/calendar/releases?from=bad&to=2026-10-25`);
    assert.equal(invalid.status, 400);
    const invalidScope = await fetch(`http://127.0.0.1:${port}/api/calendar/releases?from=2026-10-19&to=2026-10-25&scope=all`);
    assert.equal(invalidScope.status, 400, "Unsupported global scopes cannot be requested");
    const response = await fetch(`http://127.0.0.1:${port}/api/calendar/releases?from=2026-10-19&to=2026-10-25`);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(new Set(result.events.map((event) => event.type)), new Set(["anime", "series"]));
    assert.equal(result.coverage.TMDb.status, "needs_key");
    assert.equal(result.coverage.AniList.status, "ok");
    assert.equal(result.coverage.TVmaze.status, "ok");
    const animeOnly = await fetch(`http://127.0.0.1:${port}/api/calendar/releases?from=2026-10-19&to=2026-10-25&scope=anime-all`);
    assert.equal(animeOnly.status, 200);
    const animeFeed = await animeOnly.json();
    assert.deepEqual(animeFeed.events.map((event) => [event.type, event.title]), [["anime", "Schedule Example"]]);
    assert.deepEqual(Object.keys(animeFeed.coverage), ["AniList"], "All Anime never includes the TVmaze or movie feed");
    const linked = await fetch(`http://127.0.0.1:${port}/api/calendar/releases?from=2026-10-19&to=2026-10-25&anilistIds=100`);
    assert.equal(linked.status, 200);
    const related = (await linked.json()).events.filter((row) => row.source === "AniList");
    assert.deepEqual(related.map((row) => [row.title, row.linkedAniListIds]), [
      ["A Saved Show Season 2", [100]], ["A Saved Show Season 2", [100]],
    ]);
    assert.equal(related.find((row) => row.id === "anilist:701")?.artwork, "https://example.test/season-2.jpg");
  } finally {
    const exited = child.exitCode === null
      ? new Promise((resolve) => child.once("exit", resolve)) : Promise.resolve();
    if (child.exitCode === null) child.kill("SIGKILL");
    await exited;
    await close(upstream);
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  }
});
