import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';

const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const trackStart = source.indexOf('function trackOpenStream(');
const trackEnd = source.indexOf('// A video bigger than the player storage limit', trackStart);
const cacheStart = source.indexOf('const remuxSegmentCache = createRemuxSegmentCache(');
const cacheEnd = source.indexOf('const APP_STATE_CAS_SECTIONS', cacheStart);
assert.ok(trackStart > 0 && trackEnd > trackStart && cacheStart > 0 && cacheEnd > cacheStart);

test('shared remux allowance reserves every concurrently streaming file in a torrent session exactly once', async () => {
  const a = { id: 'source-A', preferredFileIndex: 0, torrent: { files: [
    { length: 1000, downloaded: 100 }, { length: 3000, downloaded: 200 },
  ] } };
  const b = { id: 'source-B', preferredFileIndex: 0, torrent: { files: [
    { length: 900, downloaded: 400 },
  ] } };
  const sessions = new Map([[a.id, a], [b.id, b]]);
  const allowances = [];
  let registeredOptions = null;
  const ctx = vm.createContext({
    torrentSessions: sessions,
    storage: { limits: () => ({ remuxCacheEnabled: true }),
      async playerCacheAllowance(args) { allowances.push(args); return { allowed: true, availableBytes: 8192 }; } },
    torrentRoot: 'not-used',
    createRemuxSegmentCache(options) { registeredOptions = options; return {}; },
  });
  vm.runInContext(source.slice(trackStart, trackEnd), ctx);
  vm.runInContext(source.slice(cacheStart, cacheEnd), ctx);
  const track = vm.runInContext('trackOpenStream', ctx);
  assert.equal(typeof registeredOptions.allowance, 'function');
  const r1 = new EventEmitter(), r2 = new EventEmitter(), r3 = new EventEmitter();
  track(a, r1, 0);
  track(a, r2, 1);
  track(b, r3, 0);
  const id = { sessionId: a.id, fileIndex: 0 };
  await registeredOptions.allowance(4096, id);
  assert.equal(allowances.at(-1).reservedSourceBytes, 900 + 2800 + 500,
    'another episode in the same session and another active session retain source headroom');
  track(a, new EventEmitter(), 0);
  await registeredOptions.allowance(4096, id);
  assert.equal(allowances.at(-1).reservedSourceBytes, 4200, 'duplicate streams of one file are reserved once');
  r2.emit('close');
  await registeredOptions.allowance(4096, id);
  assert.equal(allowances.at(-1).reservedSourceBytes, 1400, 'closing the other file releases only its own reservation');
  r3.emit('close');
  await registeredOptions.allowance(4096, id);
  assert.equal(allowances.at(-1).reservedSourceBytes, 900, 'the active producer remains protected');
  assert.equal(a.activeStreamFiles.get(0), 2);
  r1.emit('close');
  assert.equal(a.activeStreamFiles.get(0), 1);
});
