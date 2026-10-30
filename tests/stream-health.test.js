import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter, once } from 'node:events';
import { Readable, Writable } from 'node:stream';
import path from 'node:path';
import vm from 'node:vm';
import { createStreamHealth } from '../backend/media/stream-health.js';

const selectedTorrent = ({ peers = 2, speed = 50_000, have = new Set([0, 1]) } = {}) => ({
  pieceLength: 1024, numPeers: peers, downloadSpeed: speed,
  bitfield: { get: piece => have.has(piece) },
  files: [{ offset: 512, length: 6144 }],
});

test('active recorded ranges bound requested-offset verification and preserve unknown role', () => {
  let time = 10_000;
  const health = createStreamHealth({ now: () => time });
  const torrent = selectedTorrent();
  const session = { torrent };
  const initial = health.snapshot(session, { fileIndex: 0, offset: 150 });
  assert.equal(initial.status, 'offset-not-active');
  assert.equal(initial.requestedPiecePresent, null);
  const first = health.begin(session, { fileIndex: 0, start: 0, end: 2047, role: 'fake-private-title' });
  const second = health.begin(session, { fileIndex: 0, start: 3000, end: 4095 });
  time += 200;
  first.firstByte();
  first.firstByte();
  const snapshot = health.snapshot(session, { fileIndex: 0, offset: 150 });
  assert.equal(snapshot.activeReaderCount, 2);
  assert.equal(snapshot.competingReaderCount, 1);
  assert.equal(snapshot.requestedRangeActive, true);
  assert.equal(snapshot.requestedPiecePresent, true);
  assert.equal(snapshot.status, 'available');
  assert.deepEqual(snapshot.readers.map(reader => reader.role), ['unknown', 'unknown']);
  assert.equal(snapshot.readers[0].firstByteMs, 200);
  assert.equal(snapshot.playheadVerified, false);
  assert.equal(health.snapshot(session, { fileIndex: 0, offset: 5000 }).status, 'offset-not-active');
  assert.equal(health.snapshot(session, { fileIndex: 0, offset: 5000 }).requestedPiecePresent, null);
  first.end('cancel');
  first.end('complete');
  second.end('complete');
  assert.equal(health.snapshot(session, { fileIndex: 0 }).activeReaderCount, 0);
  const done = health.snapshot(session, { fileIndex: 0 }).recentReaders;
  assert.equal(done.length, 2);
  assert.deepEqual(done.map(reader => reader.outcome), ['cancel', 'complete']);
  assert.equal(done[0].firstByteMs, 200);
  assert.doesNotMatch(JSON.stringify(done), /fake-private-title|infoHash|magnet|sourceUrl/);
});

test('global torrent piece offsets account for file offsets and exact requested byte', () => {
  const health = createStreamHealth();
  const torrent = selectedTorrent({ have: new Set([1]) });
  const session = { torrent };
  const reader = health.begin(session, { fileIndex: 0, start: 0, end: 2500 });
  assert.equal(health.snapshot(session, { fileIndex: 0, offset: 200 }).requestedPiecePresent, false);
  assert.equal(health.snapshot(session, { fileIndex: 0, offset: 600 }).requestedPiecePresent, true);
  assert.equal(health.snapshot(session, { fileIndex: 0, offset: 2200 }).requestedPiecePresent, false);
  assert.equal(health.snapshot(session, { fileIndex: 0, offset: 9000 }).requestedPiecePresent, null);
  reader.end();
});

test('progress advances the live pending piece beyond a previously delivered available piece', () => {
  let time = 0;
  const health = createStreamHealth({ now: () => time });
  const torrent = { pieceLength: 1024, numPeers: 2, downloadSpeed: 64_000,
    files: [{ offset: 0, length: 4096 }], bitfield: { get: index => index === 0 } };
  const session = { torrent };
  const reader = health.begin(session, { fileIndex: 0, start: 0, end: 3071 });
  const state = () => health.snapshot(session, { fileIndex: 0 });
  assert.equal(state().status, 'available', 'initial piece is available');
  time += 24;
  reader.progress(800);
  assert.equal(state().readers[0].nextByteOffset, 800);
  assert.equal(state().readers[0].nextPiecePresent, true);
  reader.progress(224);
  const stalled = state();
  assert.equal(stalled.readers[0].firstPiecePresent, true);
  assert.equal(stalled.readers[0].firstByteMs, 24);
  assert.equal(stalled.readers[0].bytesDelivered, 1024);
  assert.equal(stalled.readers[0].nextByteOffset, 1024);
  assert.equal(stalled.readers[0].nextPiecePresent, false);
  assert.equal(stalled.observedMissingActiveRange, true);
  assert.equal(stalled.observedRangeStatus, 'missing-piece');
  assert.equal(stalled.status, 'missing-piece', 'previously completed first piece cannot mask missing next piece');
  torrent.numPeers = 0;
  assert.equal(state().status, 'no-peers', 'newest undelivered piece has no available peer');
  reader.progress(Number.MAX_SAFE_INTEGER);
  const completeBytes = state();
  assert.equal(completeBytes.readers[0].bytesDelivered, 3072, 'delivered bytes must be clamped to requested Range');
  assert.equal(completeBytes.readers[0].nextByteOffset, 3071);
  assert.equal(completeBytes.readers[0].nextPiecePresent, null, 'no pending piece after the full requested range was sent');
  assert.equal(completeBytes.observedMissingActiveRange, false);
  reader.end('complete');
  assert.equal(state().recentReaders[0].bytesDelivered, 3072);
  assert.equal(state().activeReaderCount, 0);
});

test('pending range availability uses file offset while a partial chunk crosses pieces', () => {
  const health = createStreamHealth();
  const torrent = selectedTorrent({ have: new Set([0, 1]) });
  const session = { torrent };
  const reader = health.begin(session, { fileIndex: 0, start: 250, end: 2000 });
  reader.progress(1286);
  const snapshot = health.snapshot(session, { fileIndex: 0 });
  assert.equal(snapshot.readers[0].nextByteOffset, 1536);
  assert.equal(snapshot.readers[0].firstPiecePresent, true);
  assert.equal(snapshot.readers[0].nextPiecePresent, false, 'file offset makes next byte land in global piece 2');
  assert.equal(snapshot.status, 'missing-piece');
  reader.end('cancel');
});

test('status code is grounded in piece bitfield, observed peers and reader timing', () => {
  let time = 0;
  const health = createStreamHealth({ now: () => time });
  const torrent = selectedTorrent({ have: new Set(), peers: 0, speed: 0 });
  const session = { torrent };
  const reader = health.begin(session, { fileIndex: 0, start: 2000, end: 3000 });
  const at = () => health.snapshot(session, { fileIndex: 0, offset: 2300 });
  assert.equal(at().status, 'no-peers');
  assert.equal(health.snapshot(session, { fileIndex: 0 }).status, 'no-peers');
  assert.equal(health.snapshot(session, { fileIndex: 0 }).statusSource, 'observed-reader');
  assert.equal(health.snapshot(session, { fileIndex: 0 }).observedMissingActiveRange, true);
  assert.equal(health.snapshot(session, { fileIndex: 0 }).playheadVerified, false);
  torrent.numPeers = 2;
  assert.equal(at().status, 'waiting-for-piece');
  time = 8_100;
  assert.equal(at().status, 'slow-source');
  assert.equal(health.snapshot(session, { fileIndex: 0 }).status, 'slow-source');
  torrent.downloadSpeed = 100_000;
  assert.equal(at().status, 'waiting-for-piece');
  reader.firstByte();
  assert.equal(at().status, 'missing-piece');
  torrent.bitfield = null;
  assert.equal(at().status, 'unknown');
  reader.end('error');
  assert.equal(at().status, 'offset-not-active');
  assert.equal(at().requestedPiecePresent, null);
});

test('unknown numeric data remains null and never claims missing bytes or zero peers', () => {
  const health = createStreamHealth();
  const session = { torrent: { files: [{ length: 2048 }], numPeers: NaN, downloadSpeed: Infinity } };
  const reader = health.begin(session, { fileIndex: 0, start: 0, end: 2047 });
  const result = health.snapshot(session, { fileIndex: 0, offset: 10 });
  assert.equal(result.status, 'unknown');
  assert.equal(result.peers, null);
  assert.equal(result.downloadBytesPerSecond, null);
  assert.equal(result.requestedPiecePresent, null);
  reader.end('complete');
});

test('reader records are strictly bounded, overflow is explicit, cleanup idempotent', () => {
  const health = createStreamHealth({ maxActive: 2 });
  const session = { torrent: selectedTorrent() };
  const handles = Array.from({ length: 25 }, (_, i) =>
    health.begin(session, { fileIndex: 0, start: i, end: i + 1 }));
  let result = health.snapshot(session, { fileIndex: 0, offset: 1 });
  assert.equal(result.activeReaderCount, 25);
  assert.equal(result.observedReaderCount, 2);
  assert.equal(result.observationComplete, false);
  handles.forEach(h => { h.firstByte(); h.end('cancel'); h.end('cancel'); });
  result = health.snapshot(session, { fileIndex: 0 });
  assert.equal(result.activeReaderCount, 0);
  assert.equal(result.observationComplete, true);
  for (let i = 0; i < 40; i++) {
    health.begin(session, { fileIndex: 0, start: i, end: i }).end('complete');
  }
  assert.equal(health.snapshot(session).recentReaders.length, 16);
  health.clear(session);
  assert.equal(health.snapshot(session).recentReaders.length, 0);
});

test('untrusted roles cannot pass through the diagnostic serializer', () => {
  const health = createStreamHealth();
  const session = { torrent: selectedTorrent() };
  const suspicious = health.begin(session, { fileIndex: 0, start: 0, end: 1024,
    role: 'magnet:?xt=urn:btih:secret-title' });
  const serialized = JSON.stringify(health.snapshot(session, { fileIndex: 0, offset: 0 }));
  assert.doesNotMatch(serialized, /secret-title|magnet:|urn:btih/);
  suspicious.end();
});

test('server.js Range integration records actual first-byte and abort cleanup without changing 206', async () => {
  const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const start = source.indexOf('function streamTorrentFile(');
  const end = source.indexOf('\nfunction probeCacheKey(', start);
  assert.ok(start >= 0 && end > start);
  let clock = 0;
  const health = createStreamHealth({ now: () => clock });
  let torrentReader;
  const file = { name: 'private-film.mp4', offset: 0, length: 4096, type: 'video/mp4',
    createReadStream(options) { assert.deepEqual({ ...options }, { start: 1024, end: 2047 });
      torrentReader = new Readable({ read() {} }); return torrentReader; } };
  const torrent = { files: [file], numPeers: 2, downloadSpeed: 20000, pieceLength: 1024,
    bitfield: { get: p => p === 1 } };
  const session = { state: 'ready', torrent, openStreams: 0 };
  const context = vm.createContext({
    streamHealth: health, VIDEO_EXTENSIONS: new Set(['.mp4']), MAX_TORRENT_VIDEO_BYTES: 1_000_000,
    path, mime: { '.mp4': 'video/mp4' }, rejectOversizeVideo: () => false,
    json: () => { throw new Error('unexpected JSON response'); },
    parseRange: () => ({ start: 1024, end: 2047 }),
    trackOpenStream(s, res) { s.openStreams++; res.once('close', () => s.openStreams--); },
  });
  vm.runInContext(source.slice(start, end), context);
  const req = new EventEmitter();
  req.method = 'GET';
  req.headers = { range: 'bytes=1024-2047' };
  const res = new Writable({ write(_chunk, _encoding, done) { done(); } });
  res.writeHead = (status, headers) => { res.statusCode = status; res.responseHeaders = headers; };
  res.flushHeaders = () => {};
  context.streamTorrentFile(req, res, session, 0);
  assert.equal(res.statusCode, 206);
  assert.equal(res.responseHeaders['Content-Range'], 'bytes 1024-2047/4096');
  assert.equal(health.snapshot(session, { fileIndex: 0 }).activeReaderCount, 1);
  assert.equal(health.snapshot(session, { fileIndex: 0, offset: 1100 }).requestedPiecePresent, true);
  clock += 40;
  torrentReader.push(Buffer.from('real-byte-stream'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(health.snapshot(session, { fileIndex: 0 }).readers[0].firstByteMs, 40);
  assert.equal(health.snapshot(session, { fileIndex: 0 }).readers[0].bytesDelivered, Buffer.byteLength('real-byte-stream'));
  assert.equal(health.snapshot(session, { fileIndex: 0 }).readers[0].nextByteOffset,
    1024 + Buffer.byteLength('real-byte-stream'));
  clock += 80;
  const closed = once(res, 'close');
  res.destroy();
  await closed;
  assert.ok(torrentReader.destroyed);
  assert.equal(health.snapshot(session).activeReaderCount, 0);
  assert.equal(health.snapshot(session).recentReaders[0].outcome, 'cancel');
  assert.equal(health.snapshot(session).recentReaders[0].firstByteMs, 40);
  assert.equal(req.listenerCount('aborted'), 0);
  assert.equal(session.openStreams, 0);
  assert.doesNotMatch(JSON.stringify(health.snapshot(session)), /private-film|magnet|infohash/i);
});

test('HTTP response close releases a stalled reader even when its WebTorrent stream never emits close', async () => {
  const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const start = source.indexOf('function streamTorrentFile(');
  const end = source.indexOf('\nfunction probeCacheKey(', start);
  const health = createStreamHealth();
  let destroyed = false;
  const iterator = new Readable({ read() {} });
  // Model an unresponsive WebTorrent iterator that accepts destroy() but
  // delays its native close event indefinitely (observed in slow-swarm QA).
  iterator.destroy = () => { destroyed = true; return iterator; };
  const session = {
    state: 'ready', openStreams: 0,
    torrent: { files: [{ name: 'synthetic.mp4', length: 2048, offset: 0, type: 'video/mp4',
      createReadStream() { return iterator; } }] },
  };
  const context = vm.createContext({
    streamHealth: health, VIDEO_EXTENSIONS: new Set(['.mp4']), MAX_TORRENT_VIDEO_BYTES: 1_000_000,
    path, mime: { '.mp4': 'video/mp4' }, rejectOversizeVideo: () => false,
    json: () => { throw Error('unanticipated JSON'); }, parseRange: () => ({ start: 128, end: 511 }),
    trackOpenStream(s, res) { s.openStreams++; res.once('close', () => s.openStreams--); },
  });
  vm.runInContext(source.slice(start, end), context);
  const req = new EventEmitter();
  req.method = 'GET';
  req.headers = { range: 'bytes=128-511' };
  const res = new Writable({ write(_chunk, _encoding, done) { done(); } });
  res.writeHead = (status, headers) => { res.statusCode = status; res.responseHeaders = headers; };
  res.flushHeaders = () => {};
  context.streamTorrentFile(req, res, session, 0);
  assert.equal(res.statusCode, 206);
  assert.equal(health.snapshot(session).activeReaderCount, 1);
  const closed = once(res, 'close');
  res.destroy();
  await closed;
  assert.equal(destroyed, true);
  assert.equal(session.openStreams, 0);
  assert.equal(health.snapshot(session).activeReaderCount, 0);
  assert.equal(health.snapshot(session).recentReaders[0].outcome, 'cancel');
  assert.equal(req.listenerCount('aborted'), 0);
  assert.equal(res.listenerCount('close'), 0);
  iterator.push(null);
  // A late end callback must not double-release the reader.
  assert.equal(health.snapshot(session).recentReaders.length, 1);
});
