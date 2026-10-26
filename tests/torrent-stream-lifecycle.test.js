import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter, once } from "node:events";
import { Readable, Writable } from "node:stream";
import path from "node:path";
import vm from "node:vm";

const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
const start = server.indexOf("function streamTorrentFile(");
const end = server.indexOf("\nfunction probeCacheKey(", start);
assert.ok(start >= 0 && end > start);

function streamFixture(range = null) {
  const readers = [];
  const file = {
    name: "sample.mp4", length: 4096, type: "video/mp4",
    createReadStream(options) {
      const stream = new Readable({ read() {} });
      let prematureDestroyCount = 0;
      const originalDestroy = stream.destroy.bind(stream);
      stream.destroy = (...args) => {
        prematureDestroyCount += 1;
        return originalDestroy(...args);
      };
      readers.push({ stream, options, get prematureDestroyCount() { return prematureDestroyCount; } });
      return stream;
    },
  };
  const session = { state: "ready", torrent: { files: [file] }, openStreams: 0 };
  const context = vm.createContext({
    VIDEO_EXTENSIONS: new Set([".mp4"]), MAX_TORRENT_VIDEO_BYTES: 1_000_000,
    path, mime: { ".mp4": "video/mp4" },
    rejectOversizeVideo: () => false,
    json: () => { throw new Error("Unexpected JSON error response"); },
    parseRange: () => range,
    trackOpenStream(s, res) {
      s.openStreams++;
      res.once("close", () => { s.openStreams--; });
    },
  });
  vm.runInContext(server.slice(start, end), context);
  function openRequest({ method = "GET" } = {}) {
    const req = new EventEmitter();
    req.method = method;
    req.headers = { range: range ? "bytes=512-1023" : undefined };
    const chunks = [];
    const res = new Writable({ write(chunk, _encoding, done) { chunks.push(chunk); done(); } });
    res.writeHead = (status, headers) => { res.status = status; res.headers = headers; };
    res.flushHeaders = () => {};
    vm.runInContext("streamTorrentFile(req, res, session, 0)", vm.createContext({
      streamTorrentFile: context.streamTorrentFile, req, res, session,
    }));
    return { req, res, chunks };
  }
  return { session, readers, openRequest };
}

for (const range of [null, { start: 512, end: 1023 }]) {
  test(`${range ? "ranged" : "full"} torrent read is destroyed when browser closes response without req.aborted`, async () => {
    const f = streamFixture(range);
    const { req, res } = f.openRequest();
    assert.equal(f.session.openStreams, 1);
    assert.equal(res.status, range ? 206 : 200);
    assert.equal(f.readers[0].prematureDestroyCount, 0);
    const closed = once(res, "close");
    res.destroy();
    await closed;
    assert.ok(f.readers[0].stream.destroyed, "The old WebTorrent piece reader must stop when the response closes");
    assert.equal(f.session.openStreams, 0);
    assert.equal(req.listenerCount("aborted"), 0, "Aborted listener is released with the reader");
  });
}

test("reopening after a seek destroys the old read without interrupting the new stream", async () => {
  const f = streamFixture();
  const oldRequest = f.openRequest();
  const newRequest = f.openRequest();
  assert.equal(f.session.openStreams, 2);
  const closedOld = once(oldRequest.res, "close");
  oldRequest.res.destroy();
  await closedOld;
  assert.equal(f.readers[0].stream.destroyed, true);
  assert.equal(f.readers[1].stream.destroyed, false);
  assert.equal(f.session.openStreams, 1);
  const closedNew = once(newRequest.res, "close");
  newRequest.res.destroy();
  await closedNew;
  assert.equal(f.session.openStreams, 0);
});

test("normal complete response releases listeners after reading the whole file", async () => {
  const f = streamFixture();
  const { req, res } = f.openRequest();
  const finished = once(res, "finish");
  f.readers[0].stream.push(Buffer.from("sample contents"));
  f.readers[0].stream.push(null);
  await finished;
  assert.equal(req.listenerCount("aborted"), 0);
  assert.equal(f.session.openStreams, 0);
});
