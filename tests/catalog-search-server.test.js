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

test("Catalog search uses a healthy provider and distinguishes an outage from no matches", { timeout: 30_000 }, async () => {
  let mode = "partial";
  const provider = http.createServer((req, res) => {
    const suggestion = req.url.startsWith("/suggestion/");
    const unavailable = mode === "offline" || (mode === "fallback" && !suggestion)
      || (mode === "partial" && req.url.includes("/series/"));
    res.writeHead(unavailable ? 503 : 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(unavailable ? { error: "offline" } : suggestion ? {
      d: mode === "fallback" ? [{ id: "tt0133093", l: "The Matrix", qid: "movie", y: 1999, i: { imageUrl: "https://m.media-amazon.com/images/M/example_V1_.jpg" } }] : [],
    } : {
      metas: [{ id: "tt0145487", type: "movie", name: "Spider-Man", poster: "" }],
    }));
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const port = await freePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      LANGUAGE_VIDEO_LEARNER_CINEMETA_URL: `http://127.0.0.1:${provider.address().port}`,
      LANGUAGE_VIDEO_LEARNER_IMDB_SUGGEST_URL: `http://127.0.0.1:${provider.address().port}/suggestion`,
      LANGUAGE_VIDEO_LEARNER_DATA_ROOT: fs.mkdtempSync(path.join(os.tmpdir(), "lvl-search-test-")),
    },
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString().slice(0, 2000); });
  const search = async (query) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/catalog/search?q=${encodeURIComponent(query)}`, { signal: AbortSignal.timeout(10_000) });
    return { status: response.status, payload: await response.json() };
  };
  try {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (child.exitCode !== null) throw new Error(`LVL exited: ${stderr}`);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (res.ok) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const partial = await search("Spiderman");
    assert.equal(partial.status, 200);
    assert.equal(partial.payload.results.length, 1);
    assert.equal(partial.payload.results[0].name, "Spider-Man");

    mode = "fallback";
    const fallback = await search("Matrix");
    assert.equal(fallback.status, 200, "IMDb should supply titles if Cinemeta is down");
    assert.equal(fallback.payload.results[0].name, "The Matrix");
    assert.equal(fallback.payload.results[0].id, "tt0133093");
    assert.equal(fallback.payload.results[0].type, "movie");
    assert.equal(fallback.payload.results[0].releaseInfo, "1999");
    assert.match(fallback.payload.results[0].poster, /_V1_UX300\.jpg/);

    mode = "offline";
    const unavailable = await search("Uncached query");
    assert.equal(unavailable.status, 503);
    assert.match(unavailable.payload.error, /temporarily unavailable/);

    mode = "online";
    const recovered = await search("Uncached query");
    assert.equal(recovered.status, 200, "an outage should never cache an empty search result");
    assert.equal(recovered.payload.results.length, 2, "movie and series providers both recovered");
  } finally {
    if (child.exitCode === null) {
      const closed = new Promise((resolve) => child.once("close", resolve));
      child.kill();
      await closed;
    }
    await new Promise((resolve) => provider.close(resolve));
  }
});
