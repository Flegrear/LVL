import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// Exercise the real production route function without importing server.js:
// importing server.js would start a listener, torrent engine, and background
// work. Every dependency below is deliberately isolated/fake, including the
// pinned file handle (no HTTP, local file, FFmpeg, WebTorrent or browser).
const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const start = server.indexOf('async function serveProgressiveSeek(');
const end = server.indexOf('\nfunction streamTorrentFile(', start);
assert.ok(start > 0 && end > start, 'exercise the actual progressive route, not a reimplementation');
const routeSource = server.slice(start, end);
const ROUTE = /^\/api\/torrents\/([0-9a-f-]+)\/files\/(\d+)\/progressive\/(?:status|window\/[a-f0-9]{64})$/;
const ID = 'a'.repeat(64);
const SESSION_ID = 'deadbeef-dade-4afb-8bdb-3b6ff23ccb90';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture({ status = 'waiting', complete = false, ranges = [], enabled = true, openable = true,
  asyncStart = false, delayedOpen = false, cacheUsesGuards = true } = {}) {
  const session = { id: SESSION_ID, state: 'ready', torrent: { files: [
    { name: 's01e01.mkv', path: 'season/s01e01.mkv', length: 700000000 },
    { name: 's01e02.mkv', path: 'season/s01e02.mkv', length: 710000000 },
  ] } };
  const sessions = new Map([[session.id, session]]);
  const media = { durationSeconds: 8, video: { codec: 'h264' }, audioTracks: [{ codec: 'aac' }] };
  const calls = { statuses: [], starts: [], opens: [], releases: 0, reads: 0, destroys: 0, openedStreams: 0, readerBytes: 0 };
  const state = { status, complete, ranges, enabled, openable, media,
    stale: false, sourceVerified: true, session, canContinue:false,
    verifiedSourceBytes:700000000 };
  const payload = Buffer.from('synthetic-completed-verified-fmp4-window');
  const startGate = deferred();
  const openGate = deferred();
  const isCurrent = params => state.enabled && !state.stale && sessions.get(params.session.id) === params.session;
  const cache = {
    async status(params) {
      calls.statuses.push(params);
      return isCurrent(params)
        ? { status: state.status, complete: state.complete, ranges: state.ranges,
          readyRanges: state.ranges.map(({ start, end }) => [start, end]),
          identityKey: 'a'.repeat(64),canContinue:state.canContinue,
          verifiedSourceBytes:state.verifiedSourceBytes }
        : { status: !state.enabled ? 'disabled' : 'source-incomplete',
          ranges: [], readyRanges: [] };
    },
    async start(params) {
      calls.starts.push(params);
      if (asyncStart) await startGate.promise;
      return isCurrent(params);
    },
    async open(params, id) {
      calls.opens.push({ params, id });
      if (delayedOpen) await openGate.promise;
      if (!state.openable || !state.ranges.some(item => item.id === id)) return null;
      if (cacheUsesGuards && !isCurrent(params)) return null;
      return { bytes: payload.length, start: 2, end: 3.2,
        handle: { createReadStream({ autoClose }) {
          assert.equal(autoClose, false, 'pinned cache handle remains owned by its release()');
          calls.reads++;
          return Readable.from([payload]);
        } },
        async release() { calls.releases++; },
      };
    },
  };
  const context = vm.createContext({
    VIDEO_EXTENSIONS: new Set(['.mkv', '.mp4']),
    path, torrentRoot: 'C:\\private-synthetic-test-root',
    torrentSessions: sessions,
    storage: { limits: () => ({ remuxCacheEnabled: state.enabled }) },
    // File piece verification is covered independently by
    // tests/verified-torrent-range.test.js. This VM exercises the route's
    // required final verification gate without ever touching a torrent.
    isTorrentFileFullyVerified: () => state.sourceVerified,
    safeTorrentRelativePath: relative => !relative.startsWith('..') && !path.isAbsolute(relative),
    localVerifiedTorrentInputPath:(session,index)=>{
      const relative=session.torrent.files[index].path;
      return relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)
        ?path.join('C:\\private-synthetic-test-root',session.id,relative):null;
    },
    getCachedMediaProbe: () => state.media,
    progressiveIndexCache: cache,
    startProgressiveWhenNewPieces(params,status) {
      if (!state.enabled || !status?.identityKey || !(status.status==='waiting'
        || status.status==='partial'&&status.canContinue===true)) return false;
      const key=status.identityKey+':'+status.verifiedSourceBytes;
      if (calls.lastAttempt===key) return false;
      calls.lastAttempt=key;
      void cache.start(params);
      return true;
    },
    pipeline,
    trackOpenStream(_session, _response, fileIndex) {
      assert.equal(fileIndex, 0);
      calls.openedStreams++;
    },
    json(res, code, body, headers = {}) {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
      res.end(res.method === 'HEAD' ? undefined : JSON.stringify(body));
    },
  });
  vm.runInContext(routeSource, context, { timeout: 500 });
  const handle = vm.runInContext('serveProgressiveSeek', context);
  function begin(action, { method = 'GET', range = null, audio = '0',
    audioMode = 'auto', generation = '3', fileIndex = 0, id = ID } = {}) {
    const pathname = `/api/torrents/${session.id}/files/${fileIndex}/progressive/${action === 'status' ? 'status' : 'window/' + id}`;
    const url = new URL('http://localhost' + pathname);
    url.searchParams.set('audio', audio);
    url.searchParams.set('audioMode', audioMode);
    url.searchParams.set('generation', generation);
    const req = Object.assign(new EventEmitter(), {
      method, headers: range ? { range } : {}, aborted: false, url: pathname,
    });
    const res = new PassThrough();
    res.method = method;
    res.status = null;
    res.headers = null;
    const chunks = [];
    res.on('data', chunk => chunks.push(Buffer.from(chunk)));
    res.writeHead = (code, headers) => {
      res.status = code; res.headers = headers;
      return res;
    };
    const started = handle(req, res, session, fileIndex, url, action === 'status');
    return { req, res, url, started,
      body: () => Buffer.concat(chunks),
      json: () => JSON.parse(Buffer.concat(chunks).toString('utf8')) };
  }
  async function request(action, opts = {}) {
    const r = begin(action, opts);
    await r.started;
    return r;
  }
  const window = (id = ID) => ({
    id, sequence: 0, start: 2, end: 3.2, mediaStart: 2,
    videoCodecString: 'avc1.42c01e', initHash: 'a'.repeat(64),
    bytes: payload.length, complete: true, verified: true,
  });
  return { request, begin, cache, calls, state, session, sessions, payload, window, startGate, openGate };
}

test('status GET starts asynchronous bounded producer but does not wait for full encode', async () => {
  const f = fixture({ status: 'waiting', asyncStart: true });
  const reply = await f.request('status');
  assert.equal(reply.res.status, 200);
  assert.equal(f.calls.starts.length, 1, 'GET status permits one cache producer kickoff');
  assert.equal(f.calls.opens.length, 0, 'status is metadata, never a media reader');
  assert.equal(reply.json().status, 'waiting');
  assert.equal(reply.json().kind, 'indexed-video-segments');
  assert.equal(reply.res.headers['Cache-Control'], 'no-store');
  assert.equal(reply.json().sourceKey, `torrent:${SESSION_ID}:0`);
  assert.equal(reply.json().generation, 3);
  assert.equal(reply.json().audioIndex, 0);
  assert.equal(reply.json().audioMode, 'auto');
  assert.equal(reply.json().segments.length, 0);
  f.startGate.resolve();
});

test('HEAD status cannot start a producer or expose any partially ready media bytes', async () => {
  const f = fixture({ status: 'partial', ranges: [fixture().window()] });
  const reply = await f.request('status', { method: 'HEAD' });
  assert.equal(reply.res.status, 200);
  assert.equal(reply.body().length, 0);
  assert.equal(f.calls.starts.length, 0);
  assert.equal(f.calls.opens.length, 0);
  assert.equal(f.calls.readerBytes, 0);
});

test('one completed decoder-verified GOP becomes status-visible before whole-episode conversion ends', async () => {
  const f = fixture({ status: 'partial', complete: false, ranges: [fixture().window()] });
  const reply = await f.request('status', { generation: '17', audio: '0', audioMode: 'stereo' });
  const body = reply.json();
  assert.equal(reply.res.status, 200);
  assert.equal(body.status, 'partial-ready');
  assert.equal(body.durationSeconds, 8);
  assert.equal(body.segments.length, 1);
  assert.equal(body.segments[0].id, ID);
  assert.equal(body.segments[0].startSeconds, 2);
  assert.equal(body.segments[0].endSeconds, 3.2);
  assert.equal(body.segments[0].independentlyDecodable, true);
  assert.equal(body.segments[0].movieClockVerified, true);
  assert.equal(body.segments[0].keyframeStart, true);
  assert.equal(body.mime, 'video/mp4; codecs="avc1.42c01e, mp4a.40.2"');
  assert.equal(body.identityKey, 'a'.repeat(64));
  assert.equal(body.generation, 17);
  assert.equal(f.calls.starts.length, 0,
    'a stopped producer with committed partial GOPs must not auto-restart on status GET');
  assert.equal(f.calls.opens.length, 0);
});

test('repeated GET status polling after an interrupted partial conversion never restarts FFmpeg', async () => {
  const f = fixture({ status: 'partial', complete: false, ranges: [fixture().window()] });
  // Models several minutes of a three-second frontend polling loop. Each
  // request may report already verified GOPs, but none may re-encode the full
  // episode after the previous producer stopped or failed.
  for (let poll = 0; poll < 120; poll++) {
    const reply = await f.request('status', { generation: String(poll) });
    assert.equal(reply.res.status, 200);
    assert.equal(reply.json().status, 'partial-ready');
    assert.equal(reply.json().segments.length, 1, 'previously verified GOP remains usable');
    assert.equal(f.calls.starts.length, 0, `poll ${poll} must not restart FFmpeg`);
  }
  assert.equal(f.calls.statuses.length, 120);
  assert.equal(f.calls.starts.length, 0);
  assert.equal(f.calls.opens.length, 0, 'status polling is always read-only for media bytes');
});

test('a producer already building after its first indexed GOP does not get re-kicked', async () => {
  const f = fixture({ status: 'building', complete: false, ranges: [fixture().window()] });
  const reply = await f.request('status', { range: 'bytes=0-500' });
  assert.equal(reply.res.status, 200);
  assert.equal(reply.res.headers['Content-Range'], undefined);
  assert.equal(reply.json().status, 'partial-ready');
  assert.equal(reply.json().segments.length, 1);
  assert.equal(f.calls.starts.length, 0, 'ongoing producer must not spawn duplicate job');
});

test('scoped endpoint accepts only valid UUID/file/hash route shape and isolates audio settings', async () => {
  const f = fixture({ status: 'partial', ranges: [fixture().window()] });
  assert.match(`/api/torrents/${SESSION_ID}/files/0/progressive/window/${ID}`, ROUTE);
  for (const pathname of [
    `/api/torrents/${SESSION_ID}/files/0/progressive/window/../../escape`,
    `/api/torrents/${SESSION_ID}/files/0/progressive/window/${'b'.repeat(63)}`,
    `/api/torrents/${SESSION_ID}/files/0/progressive/window/${ID.toUpperCase()}`,
  ]) assert.doesNotMatch(pathname, ROUTE);
  const status = await f.request('status', { audio: '1', audioMode: 'surround' });
  assert.equal(f.calls.statuses[0].audioIndex, 1);
  assert.equal(f.calls.statuses[0].audioMode, 'surround');
  assert.match(f.calls.statuses[0].inputPath, /s01e01\.mkv$/);
  assert.equal(status.json().sourceKey, `torrent:${SESSION_ID}:0`);
  const wrong = await f.request('window', { id: 'b'.repeat(64) });
  assert.equal(wrong.res.status, 404, 'other scoped audio/source segment is not present');
  assert.equal(f.calls.releases, 0);
});

test('GET verified fMP4 window returns bounded 200 even when Range header supplied, then releases pin', async () => {
  const f = fixture({ status: 'partial', ranges: [fixture().window()], complete: false });
  const reply = await f.request('window', { range: 'bytes=2-5' });
  assert.equal(reply.res.status, 200, 'never advertise HTTP 206 on an incomplete episode');
  assert.equal(reply.res.headers['Accept-Ranges'], 'none');
  assert.equal(reply.res.headers['Content-Type'], 'video/mp4');
  assert.equal(reply.res.headers['Content-Length'], String(f.payload.length));
  assert.equal(reply.res.headers['Content-Range'], undefined);
  assert.equal(reply.res.headers['X-LVL-Progressive-Start-Seconds'], '2');
  assert.equal(reply.res.headers['X-LVL-Progressive-End-Seconds'], '3.2');
  assert.equal(reply.res.headers['X-LVL-Progressive-Source'], SESSION_ID);
  assert.deepEqual(reply.body(), f.payload);
  assert.equal(f.calls.reads, 1);
  assert.equal(f.calls.releases, 1, 'pinned cache release is unconditional after pipeline');
  assert.equal(f.calls.openedStreams, 1);
  assert.equal(f.calls.starts.length, 0, 'opening a verified window never starts conversion');
});

test('HEAD window describes saved bytes without constructing a reader or consuming the pin', async () => {
  const f = fixture({ status: 'ready', ranges: [fixture().window()] });
  const reply = await f.request('window', { method: 'HEAD' });
  assert.equal(reply.res.status, 200);
  assert.equal(reply.res.headers['Content-Length'], String(f.payload.length));
  assert.equal(reply.body().length, 0);
  assert.equal(f.calls.reads, 0);
  assert.equal(f.calls.releases, 1);
  assert.equal(f.calls.openedStreams, 0);
});

test('closing the response during a pinned stream releases the lease', async () => {
  const f = fixture({ status: 'partial', ranges: [fixture().window()] });
  const original = f.cache.open;
  f.cache.open = async (...args) => {
    const pinned = await original(...args);
    pinned.handle.createReadStream = () => {
      f.calls.reads++;
      const source = new PassThrough();
      source.write('initial-data');
      // Keep the stream open: only a simulated HTTP disconnect closes it.
      return source;
    };
    return pinned;
  };
  const pending = f.begin('window');
  for (let i = 0; i < 20 && !pending.res.status; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.res.status, 200);
  pending.res.destroy();
  await pending.started;
  assert.equal(f.calls.releases, 1, 'abort must release the source pin');
  assert.equal(f.calls.reads, 1);
});

test('missing/uncommitted windows and unsupported file path return 404 without starting a stream', async () => {
  for (const options of [
    { status: 'waiting', ranges: [], openable: false },
    { status: 'partial', ranges: [fixture().window()], openable: false },
  ]) {
    const f = fixture(options);
    const reply = await f.request('window');
    assert.equal(reply.res.status, 404);
    assert.equal(f.calls.releases, 0);
    assert.equal(f.calls.openedStreams, 0);
    assert.equal(f.calls.reads, 0);
  }
  const wrongFile = fixture();
  wrongFile.session.torrent.files[0].path = '../outside.mp4';
  const reply = await wrongFile.request('status');
  assert.equal(reply.res.status, 404);
  assert.equal(wrongFile.calls.statuses.length, 0);
});

test('disabled Settings and stale session are refused by cache before exposure', async () => {
  const f = fixture({ status: 'partial', ranges: [fixture().window()], enabled: false });
  const disabled = await f.request('status');
  assert.equal(disabled.res.status, 200);
  assert.equal(disabled.json().status, 'disabled');
  assert.deepEqual(disabled.json().segments, []);
  assert.equal(f.calls.starts.length, 0);
  const missing = await f.request('window');
  assert.equal(missing.res.status, 404);
  assert.equal(f.calls.reads, 0);
  f.state.enabled = true;
  f.sessions.delete(f.session.id);
  const stale = await f.request('window');
  assert.equal(stale.res.status, 404);
  assert.equal(f.calls.openedStreams, 0);
});

test('disconnect while awaiting cache.open releases any later pinned window, without writing 200', async () => {
  const f = fixture({ status: 'partial', ranges: [fixture().window()], delayedOpen: true });
  const pending = f.begin('window');
  pending.res.destroy();
  f.openGate.resolve();
  await pending.started;
  assert.equal(pending.res.status, null);
  assert.equal(f.calls.releases, 1);
  assert.equal(f.calls.reads, 0);
  assert.equal(f.calls.openedStreams, 0);
});

test('adversarial pin arriving after source replacement cannot serve a stale source', async () => {
  // Model cache.open() having already passed its own identity check while a
  // later request removes the session before the returned promise settles.
  // The route needs its own final generation guard before writing HTTP 200.
  const f = fixture({ status: 'partial', ranges: [fixture().window()],
    delayedOpen: true, cacheUsesGuards: false });
  const pending = f.begin('window');
  f.sessions.delete(f.session.id);
  f.state.stale = true;
  f.openGate.resolve();
  await pending.started;
  assert.notEqual(pending.res.status, 200, 'stale cache pins must never reach the player');
  assert.equal(f.calls.reads, 0, 'stale source cannot create an fMP4 stream');
  assert.equal(f.calls.openedStreams, 0);
  assert.equal(f.calls.releases, 1, 'stale pin always released');
});

test('adversarial pin arriving after disabling progressive cache cannot serve data', async () => {
  const f = fixture({ status: 'partial', ranges: [fixture().window()],
    delayedOpen: true, cacheUsesGuards: false });
  const pending = f.begin('window');
  f.state.enabled = false;
  f.openGate.resolve();
  await pending.started;
  assert.notEqual(pending.res.status, 200, 'Settings-disabled cache must not serve previously opened pin');
  assert.equal(f.calls.reads, 0);
  assert.equal(f.calls.openedStreams, 0);
  assert.equal(f.calls.releases, 1);
});

test('adversarial pin arriving after torrent piece verification expires is rejected', async () => {
  const f = fixture({ status: 'partial', ranges: [fixture().window()],
    delayedOpen: true, cacheUsesGuards: false });
  const pending = f.begin('window');
  f.state.sourceVerified = false;
  f.openGate.resolve();
  await pending.started;
  assert.equal(pending.res.status, 404);
  assert.equal(f.calls.reads, 0);
  assert.equal(f.calls.openedStreams, 0);
  assert.equal(f.calls.releases, 1);
});
