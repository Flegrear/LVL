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

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// node:http lets the test send any Host / Origin / Sec-Fetch-Site header.
function request(port, method, pathname, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: "127.0.0.1",
      port,
      method,
      path: pathname,
      headers: { ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}), ...headers },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on("error", reject);
    req.setTimeout(20_000, () => req.destroy(new Error("request timed out")));
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForServer(port, child) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`test server exited early with code ${child.exitCode}`);
    try {
      const response = await request(port, "GET", "/api/anki/decks");
      if (response.status === 200) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("test server did not become ready");
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill();
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

test("Top words decks are stored, rendered and deleted; other sites and foreign hosts are refused", { timeout: 30_000 }, async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "language-video-learner-decks-"));
  const port = await freePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: projectRoot,
    env: { ...process.env, PORT: String(port), LANGUAGE_VIDEO_LEARNER_DATA_ROOT: dataRoot },
    stdio: "ignore",
    windowsHide: true,
  });
  const own = { Origin: `http://127.0.0.1:${port}`, "Sec-Fetch-Site": "same-origin" };
  try {
    await waitForServer(port, child);
    assert.deepEqual((await request(port, "GET", "/api/anki/decks")).json, { decks: [] });
    const sizes = (await request(port, "GET", "/api/anki/presets?language=ES")).json;
    assert.equal(sizes.available, true);
    assert.deepEqual(sizes.sizes.map((item) => item.size), [100, 1000, 5000]);

    // Requests from other sites can't add or delete decks.
    const crossOrigin = await request(port, "POST", "/api/anki/presets", { headers: { Origin: "https://example.com" }, body: { language: "ES", size: 100 } });
    assert.equal(crossOrigin.status, 403);
    const crossSite = await request(port, "POST", "/api/anki/presets", { headers: { "Sec-Fetch-Site": "cross-site" }, body: { language: "ES", size: 100 } });
    assert.equal(crossSite.status, 403);
    const sameSiteOtherPort = await request(port, "POST", "/api/clips", { headers: { Origin: "http://127.0.0.1:5173", "Sec-Fetch-Site": "same-site" }, body: {} });
    assert.equal(sameSiteOtherPort.status, 403, "another local dev server is another site too");
    // A DNS-rebinding page reaches 127.0.0.1 with its own host name: nothing is served to it.
    const rebinding = await request(port, "GET", "/api/anki/decks", { headers: { Host: `attacker.example:${port}` } });
    assert.equal(rebinding.status, 403);
    assert.deepEqual((await request(port, "GET", "/api/anki/decks")).json, { decks: [] }, "nothing was added");

    // This app's own pages can.
    const added = await request(port, "POST", "/api/anki/presets", { headers: own, body: { language: "ES", languageName: "Spanish", size: 100 } });
    assert.equal(added.status, 200, added.text);
    assert.equal(added.json.deck.id, "preset-words-es");
    assert.ok(added.json.cards.length >= 90, `${added.json.cards.length} cards`);
    const first = added.json.cards.find((card) => card.rank === 1);
    assert.ok(first?.front && first?.back, "word and meaning");
    const rendered = await request(port, "GET", `/api/anki/decks/preset-words-es/render?note=${encodeURIComponent(first.noteId)}&ord=0`);
    assert.equal(rendered.status, 200);
    assert.match(rendered.json.question, /class="lvl-word"/);
    assert.match(rendered.json.answer, /class="lvl-meaning"/);
    assert.match(rendered.json.css, /\.card/);
    assert.equal((await request(port, "GET", "/api/anki/decks")).json.decks.length, 1);

    const clip = await request(port, "POST", "/api/clips", { headers: own, body: { sessionId: "none", fileIndex: 0, libraryId: "0".repeat(40), startMs: 0, endMs: 2000 } });
    assert.equal(clip.status, 400, "a clip needs a playing torrent session");
    assert.equal((await request(port, "GET", "/api/clips/0123456789abcdef01234567/audio")).status, 404);

    assert.equal((await request(port, "DELETE", "/api/anki/decks/preset-words-es", { headers: { Origin: "https://example.com" } })).status, 403);
    assert.equal((await request(port, "DELETE", "/api/anki/decks/preset-words-es", { headers: own })).status, 204);
    assert.deepEqual((await request(port, "GET", "/api/anki/decks")).json, { decks: [] });
  } finally {
    await stopServer(child);
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});


test("Storage limits, app state, coach and torrent routes only answer this app; the helper still pairs", { timeout: 30_000 }, async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "language-video-learner-guard-"));
  // The server keeps torrent downloads under the temp folder: give it its own one.
  const tempRoot = path.join(dataRoot, "tmp");
  fs.mkdirSync(tempRoot, { recursive: true });
  const port = await freePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: projectRoot,
    env: { ...process.env, PORT: String(port), LANGUAGE_VIDEO_LEARNER_DATA_ROOT: dataRoot, TEMP: tempRoot, TMP: tempRoot, TMPDIR: tempRoot },
    stdio: "ignore",
    windowsHide: true,
  });
  const own = { Origin: `http://127.0.0.1:${port}`, "Sec-Fetch-Site": "same-origin" };
  const otherSite = { Origin: "https://example.com", "Sec-Fetch-Site": "cross-site" };
  const GB = 1024 ** 3;
  try {
    await waitForServer(port, child);

    // Storage: defaults, then limits are saved and kept within their ranges.
    const report = await request(port, "GET", "/api/storage");
    assert.equal(report.status, 200, report.text);
    assert.equal(report.json.limits.playerBytes, 20 * GB);
    assert.equal(report.json.limits.clipBytes, 2 * GB);
    assert.equal(report.json.limits.remuxCacheEnabled, true, 'new installs keep playback cache enabled');
    assert.equal((await request(port, "POST", "/api/storage/limits", { headers: otherSite, body: { playerGB: 50 } })).status, 403);
    assert.equal((await request(port, "POST", "/api/storage/limits", { headers: own, body: { remuxCacheEnabled: 'false' } })).status, 400,
      'cache option only accepts a JSON boolean, never an accidentally truthy string');
    const disabled = await request(port, "POST", "/api/storage/limits", { headers: own, body: { remuxCacheEnabled: false } });
    assert.equal(disabled.status, 200, disabled.text);
    assert.equal(disabled.json.limits.remuxCacheEnabled, false, 'toggle-off is stored and reflected by the server');
    assert.equal((await request(port, "GET", "/api/storage")).json.limits.remuxCacheEnabled, false);
    const saved = await request(port, "POST", "/api/storage/limits", { headers: own, body: { playerGB: 5000, clipGB: 0.01 } });
    assert.equal(saved.status, 200, saved.text);
    assert.equal(saved.json.limits.playerBytes, 1000 * GB, "player storage is capped at 1000 GB");
    assert.equal(saved.json.limits.clipBytes, Math.round(0.25 * GB), "saved lines keep at least 0.25 GB");
    assert.equal(saved.json.limits.remuxCacheEnabled, false, 'editing budgets cannot silently re-enable cache');
    const enabled = await request(port, "POST", "/api/storage/limits", { headers: own, body: { remuxCacheEnabled: true } });
    assert.equal(enabled.status, 200, enabled.text);
    assert.equal(enabled.json.limits.remuxCacheEnabled, true);
    assert.equal((await request(port, "POST", "/api/storage/clear-leftovers", { headers: { Origin: "http://127.0.0.1:5173" } })).status, 403);

    // App state: other sites can't write (even with merge, which skips the revision check),
    // and a DNS-rebinding page can't read it (it holds subtitle-provider keys).
    const results = [{ id: "test-1", startedAt: 1, completedAt: 2, score: 3, total: 4 }];
    assert.equal((await request(port, "POST", "/api/app-state/testResults", { headers: otherSite, body: { value: results } })).status, 403);
    assert.equal((await request(port, "POST", "/api/app-state/library", { headers: otherSite, body: { value: [{ id: "x" }], merge: true } })).status, 403);
    assert.equal((await request(port, "POST", "/api/app-state/bootstrap", { headers: otherSite, body: { legacyState: { cards: [] } } })).status, 403);
    assert.equal((await request(port, "GET", "/api/app-state", { headers: { Host: `attacker.example:${port}` } })).status, 403);
    const written = await request(port, "POST", "/api/app-state/testResults", { headers: own, body: { value: results } });
    assert.equal(written.status, 200, written.text);
    assert.deepEqual((await request(port, "GET", "/api/app-state/testResults")).json.value.map((item) => item.id), ["test-1"]);

    // Coach: no other site can send prompts through your ChatGPT or open the helper folder.
    for (const pathname of ["/api/coach/live-session/start", "/api/coach/voice-turn", "/api/coach/live-transcript/enrich", "/api/browser-coach/decision", "/api/browser-coach/voice-correction", "/api/browser-coach/open-extension-folder"]) {
      const refused = await request(port, "POST", pathname, { headers: otherSite, body: { prompt: "hello", presetContext: "x" } });
      assert.equal(refused.status, 403, `${pathname} answered ${refused.status}`);
    }
    assert.equal((await request(port, "GET", "/api/coach/providers")).status, 200);
    assert.equal((await request(port, "GET", "/api/browser-coach/status", { headers: { Host: `attacker.example:${port}` } })).status, 403);

    // Torrents: other sites can't start one.
    assert.equal((await request(port, "POST", "/api/torrents", { headers: otherSite, body: { magnet: `magnet:?xt=urn:btih:${"a".repeat(40)}` } })).status, 403);

    // The helper extension pairs from its own origin with its own client id and version.
    const version = "0.1.30"; // Legacy helper protocol; no extension ships with Alpha.
    const paired = await request(port, "POST", "/api/browser-coach/pair", {
      headers: { Origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop", "Sec-Fetch-Site": "none" },
      body: { client: "language-video-learner-browser-extension", version, instanceId: "test-instance-0001" },
    });
    assert.equal(paired.status, 200, paired.text);
    assert.equal(typeof paired.json.token, "string");
    const polled = await request(port, "POST", "/api/browser-coach/poll", {
      headers: { Origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop", Authorization: `Bearer ${paired.json.token}` },
      body: { version, instanceId: "test-instance-0001" },
    });
    assert.equal(polled.status, 200, polled.text);
    assert.equal(polled.json.request, null);
    assert.equal((await request(port, "GET", "/api/browser-coach/status?instanceId=test-instance-0001")).json.available, true);
  } finally {
    await stopServer(child);
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});
