import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter, once } from 'node:events';
import { Readable, Writable } from 'node:stream';
import path from 'node:path';
import vm from 'node:vm';

// Exercise the real HTTP Range parser and torrent response writer together.
// A WebTorrent fixture supplies known bytes without opening ports or trackers.
const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const begin = server.indexOf('function parseRange(');
const end = server.indexOf('\nfunction probeCacheKey(', begin);
assert.ok(begin >= 0 && end > begin, 'Torrent response implementation must be discoverable');
const bytes = Buffer.from(Array.from({ length: 1024 }, (_, index) => index % 251));

function fixture({ createReaderError = null } = {}) {
  const readers = [];
  const createAttempts = [];
  const file = {
    name: 'sample.mp4', type: 'video/mp4', length: bytes.length,
    createReadStream(range) {
      createAttempts.push(range ?? null);
      if (createReaderError) throw createReaderError;
      const start = range?.start ?? 0;
      const end = range?.end ?? bytes.length - 1;
      const source = Readable.from([bytes.subarray(start, end + 1)]);
      readers.push({ start, end, source });
      return source;
    },
  };
  const session = { state: 'ready', torrent: { files: [file] }, openStreams: 0 };
  const context = vm.createContext({
    VIDEO_EXTENSIONS: new Set(['.mp4']), MAX_TORRENT_VIDEO_BYTES: 1_000_000,
    path, mime: { '.mp4': 'video/mp4' },
    rejectOversizeVideo: () => false,
    json(res, status, payload) {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    },
    trackOpenStream(s, res) {
      s.openStreams++;
      res.once('close', () => { s.openStreams--; });
    },
  });
  vm.runInContext(server.slice(begin, end), context);

  async function request(range, method = 'GET') {
    const req = new EventEmitter();
    req.headers = range ? { range } : {};
    req.method = method;
    const chunks = [];
    const res = new Writable({ write(chunk, _encoding, done) { chunks.push(chunk); done(); } });
    res.writeHead = (status, headers = {}) => { res.status = status; res.headers = headers; };
    res.flushHeaders = () => {};
    context.streamTorrentFile(req, res, session, 0);
    await once(res, 'finish');
    return { req, res, body: Buffer.concat(chunks) };
  }
  return { request, readers, createAttempts, session };
}

test('stream GET returns precise 206 length, Content-Range, and requested bytes for common browser ranges', async () => {
  const cases = [
    ['bytes=0-0', 0, 0],
    ['bytes=100-199', 100, 199],
    ['bytes=1020-', 1020, 1023],
    ['bytes=1000-9999', 1000, 1023],
    ['bytes=-32', 992, 1023],
    ['bytes=-9999', 0, 1023],
  ];
  for (const [header, start, end] of cases) {
    const f = fixture();
    const { res, body } = await f.request(header);
    assert.equal(res.status, 206, header);
    assert.equal(res.headers['Content-Range'], `bytes ${start}-${end}/${bytes.length}`, header);
    assert.equal(res.headers['Content-Length'], end - start + 1, header);
    assert.equal(res.headers['Accept-Ranges'], 'bytes', header);
    assert.deepEqual(body, bytes.subarray(start, end + 1), header);
    assert.deepEqual([f.readers[0].start, f.readers[0].end], [start, end], header);
    assert.equal(f.session.openStreams, 0, header);
  }
});

test('invalid or unsatisfiable ranges return 416 without opening a torrent reader', async () => {
  for (const header of ['bytes=1024-', 'bytes=1023-1022', 'bytes=-0', 'bytes=-',
    'bytes=9007199254740993-', 'items=0-3']) {
    const f = fixture();
    const { res, body } = await f.request(header);
    assert.equal(res.status, 416, header);
    assert.equal(res.headers['Content-Range'], `bytes */${bytes.length}`, header);
    assert.equal(body.length, 0, header);
    assert.equal(f.readers.length, 0, header);
    assert.equal(f.session.openStreams, 0, header);
  }
});

test('full GET and HEAD preserve Content-Length and HEAD never opens a reader', async () => {
  const f = fixture();
  const head = await f.request(undefined, 'HEAD');
  assert.equal(head.res.status, 200);
  assert.equal(head.res.headers['Content-Length'], bytes.length);
  assert.equal(head.body.length, 0);
  assert.equal(f.readers.length, 0);
  const full = await f.request();
  assert.equal(full.res.status, 200);
  assert.equal(full.res.headers['Content-Length'], bytes.length);
  assert.deepEqual(full.body, bytes);
  assert.equal(f.readers.length, 1);
  assert.equal(f.session.openStreams, 0);
});

test('HEAD ignores invalid and unsatisfiable Range headers and never creates a torrent reader', async () => {
  for (const header of ['bytes=1024-', 'bytes=1023-1022', 'bytes=bad', 'bytes=-0', 'bytes=0-1,3-5']) {
    const f = fixture();
    const { req, res, body } = await f.request(header, 'HEAD');
    assert.equal(res.status, 200, header);
    assert.equal(res.headers['Content-Length'], bytes.length, header);
    assert.equal(res.headers['Accept-Ranges'], 'bytes', header);
    assert.equal(res.headers['Content-Range'], undefined, header);
    assert.equal(body.length, 0, header);
    assert.equal(f.createAttempts.length, 0, header);
    assert.equal(f.session.openStreams, 0, header);
    assert.equal(req.listenerCount('aborted'), 0, header);
  }
});

test('unsupported but syntactically valid multipart GET Range falls back to 200 full bytes', async () => {
  const f = fixture();
  const { req, res, body } = await f.request('bytes=0-1,3-5');
  assert.equal(res.status, 200);
  assert.equal(res.headers['Content-Range'], undefined);
  assert.equal(res.headers['Content-Length'], bytes.length);
  assert.deepEqual(body, bytes);
  assert.equal(f.createAttempts.length, 1, 'a single full-file reader serves the fallback');
  assert.deepEqual([f.readers[0].start, f.readers[0].end], [0, bytes.length - 1]);
  assert.equal(f.session.openStreams, 0);
  assert.equal(req.listenerCount('aborted'), 0);
});

test('synchronous WebTorrent reader creation failure returns 5xx without stale active readers', async () => {
  for (const header of [undefined, 'bytes=64-127']) {
    const f = fixture({ createReaderError: new Error('fixture reader failed before construction') });
    const { req, res } = await f.request(header);
    assert.ok(res.status >= 500 && res.status <= 599, `reader failure must produce 5xx for ${header || 'full GET'}`);
    assert.equal(f.createAttempts.length, 1, 'reader construction was attempted');
    assert.equal(f.readers.length, 0, 'no reader was created');
    assert.equal(f.session.openStreams, 0, 'no retained busy session');
    assert.equal(req.listenerCount('aborted'), 0, 'no abandoned abort listener');
    assert.equal(res.writableFinished, true, 'response terminates normally');
  }
});
