import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRemuxRunAheadController, createRemuxSegmentCache } from
  '../backend/media/remux-segment-cache.js';

const sessionId = '99f137aa-ae45-46df-97de-f2c907d1641c';
const genA = 'a'.repeat(48), genB = 'b'.repeat(48);
const identity = {
  sessionId, sourceIdentity: 'fully-verified-local-source', fileIndex: 1,
  startSeconds: 0, effectiveStartSeconds: 0, videoMode: 'copy',
  videoCodec: 'h264', audioMode: 'aac', audioTrack: 0,
};
const MiB = 1024 * 1024;
const candidate = {
  identity, sourceGeneration: genA, expectedSourceGeneration: genA,
  sourceFileBytes: 80 * MiB, verifiedLocalBytes: 80 * MiB,
  verifiedLocalFile: true, localInputOnly: true,
  playheadSeconds: 50, startSeconds: 55, endSeconds: 170,
  durationSeconds: 240, estimatedOutputBytes: 12 * MiB,
  availableCacheBytes: 128 * MiB, reservedSourceBytes: 60 * MiB,
  activeTranscodes: 1, maxTranscodes: 2,
};

test('local-only admission is passive; rejects incomplete pieces, remote sources and unsafe cache budgets', () => {
  const control = createRemuxRunAheadController();
  let readTorrent = 0, spawnFfmpeg = 0, writeCache = 0;
  const forbidden = {
    read: () => { readTorrent++; },
    spawn: () => { spawnFfmpeg++; },
    write: () => { writeCache++; },
  };
  // A gate must not invoke even supplied untrusted actions. No network access
  // or FFmpeg process capability is part of the controller API.
  assert.equal(control.acquire({ ...candidate, ...forbidden, verifiedLocalFile: false }), null);
  assert.equal(control.acquire({ ...candidate, ...forbidden, verifiedLocalBytes: candidate.sourceFileBytes - 1 }), null);
  assert.equal(control.acquire({ ...candidate, ...forbidden, localInputOnly: false }), null);
  assert.equal(control.acquire({ ...candidate, ...forbidden, expectedSourceGeneration: genB }), null);
  assert.equal(control.acquire({ ...candidate, ...forbidden, activeTranscodes: 2 }), null);
  assert.equal(control.acquire({ ...candidate, ...forbidden, maxTranscodes: 100 }), null,
    'cannot override the production two-transcode hard limit');
  assert.equal(control.acquire({ ...candidate, ...forbidden,
    sourceFileBytes: 21 * 1024 * MiB, verifiedLocalBytes: 21 * 1024 * MiB }), null,
    'the source must respect the existing 20 GiB video boundary');
  assert.equal(control.acquire({ ...candidate, ...forbidden, availableCacheBytes: 64 * MiB }), null,
    'source reservation plus 2x output margin cannot exceed shared disk headroom');
  assert.equal(control.acquire({ ...candidate, ...forbidden, endSeconds: 240 }), null,
    'request more than 180 seconds past playhead fails closed');
  assert.equal(control.acquire({ ...candidate, ...forbidden, estimatedOutputBytes: 64 * MiB }), null,
    'reject output without twice-estimated disk headroom');
  assert.equal(control.acquire({ ...candidate, ...forbidden, identity: { ...identity, videoCodec: 'hevc' } }), null);
  assert.equal(control.acquire({ ...candidate, ...forbidden, identity: { ...identity, videoMode: 'transcode' } }), null);
  assert.equal(control.busy, false);
  assert.deepEqual([readTorrent, spawnFfmpeg, writeCache], [0, 0, 0]);
  control.close();
  assert.equal(control.acquire(candidate), null);
});

test('lease bounds output bytes, timestamps, job concurrency, and requires abort acknowledgement', () => {
  const control = createRemuxRunAheadController({ maxOutputBytes: 32 * MiB });
  const first = control.acquire(candidate);
  assert.ok(first);
  assert.equal(control.busy, true);
  assert.equal(control.acquire(candidate), null, 'one background producer at most');
  assert.equal(first.maxBytes, 32 * MiB);
  assert.equal(first.observe({outputBytes: 10 * MiB, producedUntilSeconds: 60}), true);
  assert.equal(first.bytes, 10 * MiB);
  assert.equal(first.observe({outputBytes: 3 * MiB, producedUntilSeconds: 62, generation: genB}), false);
  assert.equal(first.signal.aborted, true, 'stale source generation cancels producer immediately');
  assert.equal(first.bytes, 10 * MiB, 'rejected progress is never recorded');
  assert.equal(control.acquire(candidate), null, 'do not overlap while previous FFmpeg has not acknowledged abort');
  first.release();
  first.release();
  assert.equal(control.busy, false);
  const second = control.acquire({ ...candidate, sourceGeneration: genB, expectedSourceGeneration: genB });
  assert.ok(second);
  assert.equal(second.observe({outputBytes: 24 * MiB, producedUntilSeconds: 80}), true);
  assert.equal(second.observe({outputBytes: 9 * MiB, producedUntilSeconds: 81}), false,
    'hard output cap aborts even with an underestimated byte-rate');
  assert.equal(second.bytes, 24 * MiB);
  second.release();
  const third = control.acquire(candidate);
  assert.ok(third);
  assert.equal(third.observe({outputBytes: 1, producedUntilSeconds: 171}), false,
    'producer may not pass the strictly bounded request interval');
  third.release();
  control.close();
});

test('source-generation change, explicit abort and wall deadline all fail closed', async () => {
  const control = createRemuxRunAheadController({maxWallMs: 150});
  const first = control.acquire(candidate);
  assert.ok(first);
  control.cancelGeneration(genA);
  assert.equal(first.signal.aborted, false, 'same generation stays active');
  control.cancelGeneration(genB);
  assert.equal(first.signal.aborted, true, 'new source invalidates old run-ahead producer');
  assert.equal(first.observe({outputBytes: 1}), false);
  assert.equal(control.acquire(candidate), null, 'cannot start a replacement until old producer releases');
  first.release();
  const second = control.acquire(candidate);
  assert.ok(second);
  await new Promise(resolve => setTimeout(resolve, 190));
  assert.equal(second.signal.aborted, true, 'bounded wall-clock deadline enforces cancellation');
  second.release();
  const third = control.acquire(candidate);
  assert.ok(third);
  control.close();
  assert.equal(third.signal.aborted, true);
  assert.equal(control.acquire(candidate), null, 'closed controller never restarts itself');
  third.release();
});

test('run-ahead admission never mutates recorder state or promotes unverified cache bytes', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lvl-run-ahead-gate-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  let grants = 0;
  const cache = createRemuxSegmentCache({
    sessionsRoot: root, enabled: () => true,
    allowance: async () => { grants++; return {allowed: true, availableBytes: 500 * MiB}; },
  });
  const control = createRemuxRunAheadController();
  const lease = control.acquire(candidate);
  assert.ok(lease);
  assert.equal(grants, 0, 'admission must not reserve/write storage or trigger network work');
  assert.deepEqual(await cache.debugEntries(sessionId), []);
  assert.deepEqual(fs.readdirSync(root), [], 'no implicit recorder or disk writes');
  assert.equal(lease.observe({outputBytes: 1024, producedUntilSeconds: 60}), true);
  assert.deepEqual(await cache.debugEntries(sessionId), [],
    'advisory progress cannot make any fMP4 playable without actual MP4/IDR verification');
  lease.release();
  control.close();
});
