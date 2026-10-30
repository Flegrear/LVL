import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { waitForStartupMediaProbe } from "../frontend/player/media-startup.js";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");

test("ready media uses metadata immediately and clears the grace timer", async () => {
  let cancelled;
  const result = await waitForStartupMediaProbe(Promise.resolve({ audioTracks: [{ codec: "aac" }] }), {
    timeoutMs: 2000, schedule: () => 9, cancel: (timer) => { cancelled = timer; },
  });
  assert.equal(result.audioTracks[0].codec, "aac");
  assert.equal(cancelled, 9);
});

test("slow media releases startup while the original probe remains available for later refinement", async () => {
  let resolveMetadata;
  let releaseTimer;
  const request = new Promise((resolve) => { resolveMetadata = resolve; });
  const waiting = waitForStartupMediaProbe(request, {
    timeoutMs: 2000, schedule: (finish, ms) => { assert.equal(ms, 2000); releaseTimer = finish; return 1; },
    cancel: () => {},
  });
  releaseTimer();
  assert.equal(await waiting, null, "foreground can begin playback without blocking on slow FFprobe");
  resolveMetadata({ durationSeconds: 123 });
  assert.equal((await request).durationSeconds, 123);
  assert.match(app, /const metadataRequest = fetchJson\(metadataUrl\)/);
  assert.match(app, /await waitForStartupMediaProbe\(metadataRequest\)/);
  assert.match(app, /await metadataRequest\.catch\(\(\) => fetchJson\(metadataUrl\)\)/);
  assert.match(server, /\["\/frontend\/player\/media-startup\.js", \{ file: "frontend\/player\/media-startup\.js"/,
    "browser module imports must be mapped in the backend's explicit static allowlist");
});
