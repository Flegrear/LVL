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

async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

async function get(port, endpoint) {
  const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, { signal: AbortSignal.timeout(12_000) });
  return { status: response.status, body: await response.json() };
}

async function runServer(port, provider, dataRoot) {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: root,
    env: { ...process.env, PORT: String(port), LANGUAGE_VIDEO_LEARNER_CINEMETA_URL: provider, LANGUAGE_VIDEO_LEARNER_DATA_ROOT: dataRoot },
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString().slice(0, 2000); });
  for (let i = 0; i < 120; i += 1) {
    if (child.exitCode !== null) throw new Error(`LVL server exited during startup: ${child.exitCode}\n${stderr}`);
    try { if ((await get(port, "/api/health")).status === 200) return child; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill();
  throw new Error("LVL server did not start");
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  const stopped = new Promise((resolve) => child.once("close", resolve));
  child.kill();
  await stopped;
}

test("Home keeps loading with one Cinemeta section down, and saved catalog survives offline restart", { timeout: 45_000 }, async () => {
  let mode = "partial";
  const provider = http.createServer((req, res) => {
    const endpoint = req.url || "";
    const fail = mode === "offline" || (mode === "partial" && endpoint.includes("series/top/genre=Anime"));
    res.writeHead(fail ? 503 : 200, { "Content-Type": "application/json" });
    const item = endpoint.includes("movie/")
      ? { id: endpoint.includes("genre=Anime") ? "tt32345" : endpoint.includes("skip=50") ? "tt12346" : "tt12345", name: "Movie", type: "movie" }
      : { id: endpoint.includes("skip=50") ? "tt22346" : "tt22345", name: "Series", type: "series" };
    res.end(JSON.stringify(fail ? { error: "temporarily unavailable" } : { metas: [item] }));
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const providerUrl = `http://127.0.0.1:${provider.address().port}`;
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lvl-home-catalog-test-"));
  let child;
  try {
    let port = await freePort();
    child = await runServer(port, providerUrl, dataRoot);
    const initial = await get(port, "/api/catalog/home");
    assert.equal(initial.status, 200);
    assert.equal(initial.body.partial, true);
    assert.equal(initial.body.movies.length, 2);
    assert.equal(initial.body.series.length, 2);

    mode = "offline";
    const fallback = await get(port, "/api/catalog/home?refresh=1");
    assert.equal(fallback.status, 200);
    assert.equal(fallback.body.stale, true);
    assert.equal(fallback.body.movies.length, 2);
    assert.equal(fallback.body.series.length, 2);

    await stopServer(child);
    child = null;
    port = await freePort();
    child = await runServer(port, providerUrl, dataRoot);
    const restored = await get(port, "/api/catalog/home");
    assert.equal(restored.status, 200);
    assert.equal(restored.body.cached, true);
    assert.equal(restored.body.stale, true);
    assert.equal(restored.body.movies.length, 2);

    await stopServer(child);
    child = null;
    port = await freePort();
    child = await runServer(port, providerUrl, fs.mkdtempSync(path.join(os.tmpdir(), "lvl-home-empty-test-")));
    const unavailable = await get(port, "/api/catalog/home");
    assert.equal(unavailable.status, 503, "a new offline install must show a retryable error");
    assert.match(unavailable.body.error, /unavailable/i);
  } finally {
    if (child) await stopServer(child);
    await new Promise((resolve) => provider.close(resolve));
  }
});

test("real upstream HTTP 504 plus a hung request preserves the previous Home catalog until recovery", { timeout: 35_000 }, async () => {
  let mode = "healthy";
  let timedOutConnections = 0;
  const upstream = http.createServer((req, res) => {
    if (mode === "degraded") {
      if (req.url === "/catalog/series/top.json") {
        // Exercise the server's real 8-second AbortSignal timeout as well as 504.
        res.once("close", () => { timedOutConnections += 1; });
        return;
      }
      res.writeHead(504, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Gateway Timeout" }));
      return;
    }
    const movie = req.url?.includes("/movie/");
    const anime = req.url?.includes("genre=Anime");
    const skip = req.url?.includes("skip=50");
    const id = movie ? (anime ? "tt91003" : skip ? "tt91002" : "tt91001")
      : (anime ? "tt92003" : skip ? "tt92002" : "tt92001");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ metas: [{ id, name: `Title ${id}`, type: movie ? "movie" : "series" }] }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const providerUrl = `http://127.0.0.1:${upstream.address().port}`;
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lvl-home-timeout-test-"));
  let child;
  try {
    const port = await freePort();
    child = await runServer(port, providerUrl, dataRoot);
    const first = await get(port, "/api/catalog/home");
    assert.equal(first.status, 200);
    assert.equal(first.body.partial, false);
    assert.equal(first.body.stale, undefined);
    assert.equal(first.body.movies.length, 2);
    assert.equal(first.body.series.length, 2);

    mode = "degraded";
    const saved = await get(port, "/api/catalog/home?refresh=1");
    assert.equal(saved.status, 200, "upstream failures should not blank an already loaded catalog");
    assert.equal(saved.body.cached, true);
    assert.equal(saved.body.stale, true, "the old catalog must not be labeled fresh");
    assert.equal(saved.body.partial, true);
    assert.deepEqual(saved.body.movies, first.body.movies);
    assert.deepEqual(saved.body.series, first.body.series);
    assert.deepEqual(saved.body.anime, first.body.anime);
    assert.equal(saved.body.generatedAt, first.body.generatedAt, "failed refresh must preserve source timestamp");
    assert.ok(timedOutConnections > 0, "upstream must actually abort its hung HTTP request");

    const cached = await get(port, "/api/catalog/home");
    assert.equal(cached.status, 200);
    assert.equal(cached.body.cached, true);
    assert.equal(cached.body.stale, true, "cached fallback must remain labeled stale");
    assert.equal(cached.body.partial, true, "cached fallback must retain degraded provider status");
    assert.equal(cached.body.generatedAt, first.body.generatedAt);
    assert.deepEqual(cached.body.movies, first.body.movies, "cached reads still retain the last known good titles");

    mode = "healthy";
    const refreshed = await get(port, "/api/catalog/home?refresh=1");
    assert.equal(refreshed.status, 200, "provider recovery should permit new catalog fetches");
    assert.equal(refreshed.body.partial, false);
    assert.equal(refreshed.body.stale, undefined);
    assert.equal(refreshed.body.cached, false);
  } finally {
    if (child) await stopServer(child);
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});
