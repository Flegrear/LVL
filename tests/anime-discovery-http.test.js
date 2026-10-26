import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const close = (server) => new Promise((resolve) => server.close(resolve));

test("isolated LVL discovery route serves public AniList seasons without account tokens", { timeout: 30_000 }, async () => {
  const picker = net.createServer();
  await listen(picker);
  const port = picker.address().port;
  await close(picker);
  const calls = [];
  const upstream = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    calls.push(request);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ data: { Page: { pageInfo: { currentPage: 1, hasNextPage: true }, media: [
      { id: 1, title: { english: "Seasonal Example" }, format: "TV", season: "FALL", seasonYear: 2026,
        averageScore: 92, coverImage: { large: "https://example.test/cover.png" } },
    ] } } }));
  });
  await listen(upstream);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lvl-anime-browser-"));
  const server = spawn(process.execPath, ["server.js"], {
    cwd: root, windowsHide: true, stdio: "ignore",
    env: { ...process.env, PORT: String(port), LANGUAGE_VIDEO_LEARNER_DATA_ROOT: tempRoot,
      LANGUAGE_VIDEO_LEARNER_ANILIST_URL: `http://127.0.0.1:${upstream.address().port}/graphql` },
  });
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (server.exitCode !== null) throw new Error("Test server exited");
      try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) { ready = true; break; } } catch {}
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    assert.ok(ready);
    const url = `http://127.0.0.1:${port}/api/anime/discover?year=2026&season=FALL&format=TV&sort=SCORE_DESC`;
    const response = await fetch(url);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.items[0].title, "Seasonal Example");
    assert.equal(payload.items[0].score, 92);
    assert.equal(payload.hasNextPage, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].variables.year, 2026);
    assert.equal(calls[0].variables.season, "FALL");
    assert.equal(calls[0].variables.sort[0], "SCORE_DESC");
    assert.doesNotMatch(JSON.stringify(calls[0]), /token|Authorization/i);
    await fetch(url);
    assert.equal(calls.length, 1, "Duplicate filters use cached AniList response");
    const year = await fetch(`http://127.0.0.1:${port}/api/anime/discover?year=2006&season=`);
    assert.equal(year.status, 200);
    assert.match(calls[1].query, /startDate_greater/);
    assert.doesNotMatch(calls[1].query, /seasonYear:/);
  } finally {
    const exit = server.exitCode === null ? new Promise((resolve) => server.once("exit", resolve)) : Promise.resolve();
    if (server.exitCode === null) server.kill("SIGKILL");
    await exit;
    await close(upstream);
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
  }
});
