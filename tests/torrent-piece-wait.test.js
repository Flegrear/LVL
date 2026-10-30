import test from 'node:test';
import assert from 'node:assert/strict';
import { torrentSeekPieceStatus } from '../frontend/player/torrent-piece-wait.js';

test('real partial episode missing 00:34–03:49 keeps 01:48 seek waiting despite 87.5% overall bytes', () => {
  const buckets = new Uint8Array(120).fill(255);
  buckets.fill(0, 3, 20);
  assert.equal(torrentSeekPieceStatus({ buckets, targetSeconds: 108, durationSeconds: 1374.97 }), 'missing');
  assert.equal(torrentSeekPieceStatus({ buckets, targetSeconds: 400, durationSeconds: 1374.97 }), 'likely-ready');
  assert.equal(torrentSeekPieceStatus({ buckets, targetSeconds: 108, durationSeconds: 1374.97, verifiedComplete: true }), 'verified-complete');
});

test('recovery waits for preceding keyframe bucket as well as the requested target bucket', () => {
  const buckets = new Uint8Array(120).fill(255);
  const target = 108, duration = 1374.97;
  const index = Math.floor(target / duration * buckets.length);
  buckets[index - 1] = 0;
  assert.equal(torrentSeekPieceStatus({ buckets, targetSeconds: target, durationSeconds: duration }), 'missing');
  buckets[index - 1] = 255;
  assert.equal(torrentSeekPieceStatus({ buckets, targetSeconds: target, durationSeconds: duration }), 'likely-ready');
  assert.equal(torrentSeekPieceStatus({ buckets: null, targetSeconds: target, durationSeconds: duration }), 'unknown');
});
