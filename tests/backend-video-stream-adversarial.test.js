// Final QA: negative controls for streamed subtitle extraction and its process
// lifecycle. Runs the real endpoint function inside a VM, with mock FFmpeg and
// HTTP responses; never touches the installed server or a user's torrent.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import vm from "node:vm";

const source = readFileSync(new URL("../server.js", import.meta.url), "utf8");
const begin = source.indexOf("async function extractTorrentSubtitle(");
const end = source.indexOf("\n// Speech activity of one audio window", begin);
assert.ok(begin >= 0 && end > begin);
const code = source.slice(begin, end);

function harness({ pendingProbe = null } = {}) {
  let nextTimer = 0;
  const timers = new Map();
  const children = [];
  const responses = [];
  const session = { id: "local-subtitle", state: "ready", torrent: { files: [{ name: "sample.mkv", length: 5e6 }] } };
  const media = { durationSeconds: 1200, subtitleTracks: [{ streamIndex: 3, codec: "ass", textBased: true, language: "en", title: "English" }] };
  const context = vm.createContext({
    ffmpegPath: "mock-ffmpeg", port: 4173, MAX_SUBTITLE_TEXT_BYTES: 2048,
    MAX_EMBEDDED_SUBTITLE_JOBS: 2, activeEmbeddedSubtitleJobs: new Set(),
    boundedInteger: (value, min, max) => value !== null && /^\d+$/.test(String(value)) && Number(value) >= min && Number(value) <= max ? Number(value) : undefined,
    probeTorrentFile: () => pendingProbe || Promise.resolve(media),
    methodNotAllowed: (res) => { res.status = 405; res.writableEnded = true; },
    json: (res, status, body) => { res.status = status; res.body = body; res.writableEnded = true; responses.push({ status, body }); },
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    spawn(_binary, args) {
      const child = Object.assign(new EventEmitter(), {
        args, stdout: Object.assign(new EventEmitter(), { pause() {}, resume() {} }),
        stderr: new EventEmitter(), killed: false,
        kill() { this.killed = true; },
      });
      children.push(child);
      return child;
    },
  });
  vm.runInContext(code, context);
  function request(start = "175", { progressive = true, method = "GET" } = {}) {
    const req = Object.assign(new EventEmitter(), { method, headers: {} });
    const res = Object.assign(new EventEmitter(), {
      destroyed: false, writableEnded: false, status: 0, body: "", chunks: [], headers: null,
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      flushHeaders() {},
      write(chunk) { this.chunks.push(String(chunk)); return true; },
      end(chunk) { if (chunk) this.chunks.push(String(chunk)); this.writableEnded = true; this.emit("close"); },
    });
    const url = new URL(`http://127.0.0.1:4173/api/torrents/${session.id}/files/0/subtitle?stream=3&start=${start}&progressive=${progressive ? 1 : 0}`);
    const pending = vm.runInContext("extractTorrentSubtitle", context)(req, res, session, 0, url);
    return { req, res, pending };
  }
  const drainMicrotasks = () => new Promise((resolve) => setImmediate(resolve));
  return { children, timers, media, session, responses, request, drainMicrotasks };
}

test("positive: progressive arbitrary seek uses original subtitle clock and caps extraction to 180s", async () => {
  const f = harness();
  const { pending, res } = f.request("175.85");
  await pending;
  assert.equal(f.children.length, 1);
  const args = f.children[0].args;
  const adjacent = (flag, val) => args.some((x, i) => x === flag && args[i + 1] === val);
  assert.ok(adjacent("-ss", "175"));
  assert.ok(adjacent("-output_ts_offset", "175"));
  assert.ok(adjacent("-t", "180"));
  assert.ok(adjacent("-map", "0:3"));
  f.children[0].stdout.emit("data", Buffer.from("WEBVTT\n\n00:02:55.000 --> 00:02:58.000\nBefore seek\n\n"));
  assert.equal(res.status, 200);
  f.children[0].emit("close", 0);
  assert.equal(res.writableEnded, true);
  assert.match(res.chunks.join(""), /LVL-EXTRACT-COMPLETE/);
  assert.equal(f.timers.size, 0);
});

test("closed request during pending media metadata never starts orphaned FFmpeg", async () => {
  let resolveProbe;
  const mediaPromise = new Promise((resolve) => { resolveProbe = resolve; });
  const f = harness({ pendingProbe: mediaPromise });
  const operation = f.request("541");
  operation.res.destroyed = true;
  operation.res.emit("close");
  assert.equal(f.children.length, 0);
  resolveProbe(f.media);
  await operation.pending;
  assert.equal(f.children.length, 0, "metadata completion must not start a subtitle job after client disconnect");
  assert.equal(f.timers.size, 0, "no orphaned 42s timer may survive this path");
});

test("concurrent progressive subtitle requests cap at two FFmpeg jobs and release exact child slots", async () => {
  const f = harness();
  const requests = Array.from({ length: 9 }, (_, i) => f.request(String(i * 100)));
  await Promise.all(requests.map((op) => op.pending));
  assert.equal(f.children.length, 2, "only two subtitle extractors may run simultaneously");
  assert.ok(f.children.every((child) => !child.killed));
  assert.equal(f.timers.size, 2, "rejected requests must not create long timeout jobs");
  for (const op of requests.slice(2)) assert.equal(op.res.status, 429, "saturated extractor rejects immediately");
  for (const op of requests) { op.res.destroyed = true; op.res.emit("close"); }
  assert.ok(f.children.every((child) => child.killed));
  assert.equal(f.timers.size, 0);
  // Slots count live child processes, not closed responses. Allow replacements
  // only after FFmpeg has actually signaled close.
  const stillBusy = f.request("400");
  await stillBusy.pending;
  assert.equal(stillBusy.res.status, 429);
  f.children.forEach((child) => child.emit("close", null));
  const subsequent = f.request("500");
  await subsequent.pending;
  assert.equal(f.children.length, 3, "process close releases its exact worker slot");
  subsequent.res.destroyed = true;
  subsequent.res.emit("close");
  f.children[2].emit("close", null);
});

test("positive: output overflow kills stalled FFmpeg and reports partial progressive cue stream", async () => {
  const f = harness();
  const op = f.request("180");
  await op.pending;
  f.children[0].stdout.emit("data", Buffer.from("WEBVTT\n\n"));
  f.children[0].stdout.emit("data", Buffer.alloc(4096, "A"));
  assert.equal(f.children[0].killed, true);
  assert.match(op.res.chunks.join(""), /LVL-EXTRACT-PARTIAL/);
  assert.equal(f.timers.size, 0);
});

test("subtitle slot is reclaimed on child error, normal EOF and timeout; no busy-slot leak", async () => {
  const f = harness();
  const first = f.request("180");
  const second = f.request("365");
  await Promise.all([first.pending, second.pending]);
  const rejected = f.request("545");
  await rejected.pending;
  assert.equal(rejected.res.status, 429);

  // Spawn errors may arrive before a close event; release must be idempotent.
  f.children[0].emit("error", new Error("simulated FFmpeg spawn failure"));
  assert.equal(first.res.status, 500);
  const replacement = f.request("725");
  await replacement.pending;
  assert.equal(f.children.length, 3);
  f.children[0].emit("close", -1);
  f.children[1].stdout.emit("data", Buffer.from("WEBVTT\n\n"));
  f.children[1].emit("close", 0);
  assert.equal(second.res.writableEnded, true);
  const other = f.request("905");
  await other.pending;
  assert.equal(f.children.length, 4, "normal completion releases another slot");

  const timeouts = [...f.timers.values()];
  assert.equal(timeouts.length, 2);
  for (const timer of timeouts) timer.fn();
  assert.ok(f.children[2].killed && f.children[3].killed);
  assert.equal(f.timers.size, 0);
  f.children[2].emit("close", null);
  f.children[3].emit("close", null);
  const final = f.request("1080");
  await final.pending;
  assert.equal(f.children.length, 5, "after all closes there is capacity for a new extraction");
  final.res.destroyed = true;
  final.res.emit("close");
  f.children[4].emit("close", null);
});

test("negative: cross-site fetch headers do not guard read-only subtitle extraction against an expensive GET", async () => {
  const f = harness();
  const req = Object.assign(new EventEmitter(), {
    method: "GET", headers: {
      host: "127.0.0.1:4173", origin: "http://outside.example", "sec-fetch-site": "cross-site",
    },
  });
  // The top-level route enforces local Host, but deliberately allows GET
  // regardless of sec-fetch-site. The subtitle handler itself only checks GET.
  const res = Object.assign(new EventEmitter(), {
    destroyed: false, writableEnded: false,
    writeHead() {}, flushHeaders() {}, write() { return true; },
    end() { this.writableEnded = true; this.emit("close"); },
  });
  const url = new URL("http://127.0.0.1:4173/api/torrents/local-subtitle/files/0/subtitle?stream=3&start=180&progressive=1");
  // Host validation is shared with production localRequestRejected().
  const localGuardStart = source.indexOf("function localRequestRejected(");
  const localGuardEnd = source.indexOf("\nfunction requestNativeUpdate(", localGuardStart);
  assert.ok(localGuardStart > 0 && localGuardEnd > localGuardStart);
  const ctx = vm.createContext({ port: 4173, json() { throw new Error("unexpected local host rejection"); } });
  vm.runInContext(source.slice(localGuardStart, localGuardEnd), ctx);
  assert.equal(vm.runInContext("localRequestRejected", ctx)(req, res), false);
  // A cross-site request needs the unpredictable session ID, so this is a
  // resource-pressure hardening finding, not an unauthenticated source leak.
  const op = f.request("180");
  op.req.headers = req.headers;
  await op.pending;
  assert.equal(f.children.length, 1);
  op.res.destroyed = true;
  op.res.emit("close");
});

test("duplicate concurrent copied-seek preflights share one probe and do not waste the two-job budget", async () => {
  const from = source.indexOf("async function copiedSeekOrigin(");
  const to = source.indexOf("\nasync function copiedSeekOriginEndpoint(", from);
  assert.ok(from > 0 && to > from);
  const session = { id: "cache", state: "ready", torrent: { files: [{ name: "episode.mkv", length: 1000 }] } };
  const sessions = new Map([[session.id, session]]);
  const pending = [];
  const ctx = vm.createContext({
    path: { extname: () => ".mkv" }, VIDEO_EXTENSIONS: new Set([".mkv"]),
    MAX_TORRENT_VIDEO_BYTES: 20 * 1024 ** 3, MAX_COPIED_SEEK_PROBES: 2,
    MAX_COPIED_SEEK_CACHE_ENTRIES: 64, COPIED_SEEK_CACHE_TTL_MS: 600_000,
    MAX_COPIED_SEEK_SUBSCRIBERS: 16, AbortController,
    Date, Number, port: 4173, torrentSessions: sessions, ffprobePath: "ffprobe",
    getCachedMediaProbe: () => ({ durationSeconds: 300 }),
    probeCopiedSeekOrigin: () => new Promise((resolve) => { pending.push(resolve); }),
  });
  vm.runInContext(`const copiedSeekOriginCache = new Map(); const copiedSeekOriginInflight = new Map(); let activeCopiedSeekProbes = 0;\n${source.slice(from, to)}`, ctx);
  const invoke = vm.runInContext("copiedSeekOrigin", ctx);
  const first = invoke(session, 0, 5.37);
  const second = invoke(session, 0, 5.37);
  const third = invoke(session, 0, 5.37);
  assert.equal(pending.length, 1, "all three identical requests share exactly one FFprobe");
  const verified = { requestedStartSeconds: 5.37, effectiveStartSeconds: 4, prerollSeconds: 1.37, verified: true };
  for (const resolve of pending) resolve(verified);
  assert.deepEqual(await first, verified);
  assert.deepEqual(await second, verified);
  assert.deepEqual(await third, verified);
  assert.deepEqual(await invoke(session, 0, 5.37), verified, "settled verified requests benefit from the cache");
  assert.equal(vm.runInContext("activeCopiedSeekProbes", ctx), 0);
});
