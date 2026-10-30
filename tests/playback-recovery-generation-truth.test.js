import test from 'node:test';
import assert from 'node:assert/strict';
import {
  changePlaybackRecoverySource, createPlaybackRecoveryState,
  recordPlaybackProgress, requestPlaybackRecovery,
} from '../frontend/player/playback-recovery.js';
import { classifyPlaybackStreamStatus } from '../frontend/player/stream-status.js';

test('a new playback generation of the same saved episode starts a fresh bounded recovery incident', () => {
  let state = createPlaybackRecoveryState('same-film:0', 12);
  state = requestPlaybackRecovery(state, { sourceGeneration: 12 }).state;
  state = requestPlaybackRecovery(state, { sourceGeneration: 12 }).state;
  assert.equal(state.exhausted, true);

  const newLoad = changePlaybackRecoverySource(state, 'same-film:0', { sourceGeneration: 13 });
  assert.equal(newLoad.sourceGeneration, 13);
  assert.equal(newLoad.exhausted, false);
  const next = requestPlaybackRecovery(newLoad, { sourceGeneration: 13 });
  assert.equal(next.action.type, 'retry-source');
  assert.equal(next.action.attempt, 1);
});

test('late callbacks from an older media generation cannot consume retries or invent recovery', () => {
  const old = createPlaybackRecoveryState('same-film:0', 21);
  const active = changePlaybackRecoverySource(old, 'same-film:0', { sourceGeneration: 22 });
  const stale = requestPlaybackRecovery(active, { sourceGeneration: 21, reason: 'error' });
  assert.strictEqual(stale.state, active);
  assert.equal(stale.action.type, 'none');
  assert.equal(stale.action.reason, 'stale-source-generation');
  assert.strictEqual(recordPlaybackProgress(active, {
    sourceGeneration: 21, currentTimeSeconds: 200,
  }), active);
  assert.equal(requestPlaybackRecovery(active, { sourceGeneration: 22 }).action.type, 'retry-source');
  const unrelated = changePlaybackRecoverySource(active, 'different-film:0');
  assert.equal(unrelated.sourceGeneration, null, 'an unrelated source must not reuse an earlier load identity');
});

test('confirmed alternate-source transitions preserve incident history across load generations', () => {
  let state = createPlaybackRecoveryState('film-a:0', 'load-a');
  state = requestPlaybackRecovery(state, { sourceGeneration: 'load-a', alternateSourceKeys: ['film-b:0'] }).state;
  const switched = requestPlaybackRecovery(state, { sourceGeneration: 'load-a', alternateSourceKeys: ['film-b:0'] });
  assert.equal(switched.action.type, 'switch-source');
  state = changePlaybackRecoverySource(switched.state, 'film-b:0', { sourceGeneration: 'load-b' });
  assert.equal(state.sourceSwitches, 1);
  assert.equal(state.sourceGeneration, 'load-b');
  assert.deepEqual(state.attemptedSourceKeys, ['film-a:0', 'film-b:0']);
});

test('single forward playhead discontinuity does not impersonate five seconds of recovered playback', () => {
  let state = createPlaybackRecoveryState('film:0');
  state = requestPlaybackRecovery(state).state;
  state = recordPlaybackProgress(state, { currentTimeSeconds: 12 });
  state = recordPlaybackProgress(state, { currentTimeSeconds: 180, seeking: false });
  assert.equal(state.retryCount, 1, 'a single seek-sized jump cannot renew the bounded retry budget');
  state = recordPlaybackProgress(state, { currentTimeSeconds: 180.5 });
  assert.equal(state.retryCount, 1);
  state = recordPlaybackProgress(state, { currentTimeSeconds: 185.5 });
  assert.equal(state.retryCount, 0, 'continuous subsequent progress can earn another incident');
});

test('subtitle, probe and speech readers cannot explain a stopped video or override codec recovery', () => {
  const health = { peers: 0, activeReaderCount: 3, observedReaderCount: 3,
    readers: ['subtitle', 'probe', 'speech'].map((role) => ({
      role, ageMs: 15_000, nextPiecePresent: false,
    })) };
  assert.equal(classifyPlaybackStreamStatus(health, { stalled: true }), null);
  assert.equal(classifyPlaybackStreamStatus({ ...health, requestedRangeActive: true,
    requestedPiecePresent: false, status: 'missing-piece', statusSource: 'requested-offset' },
  { stalled: true }), null);
});

test('current conversion reader still provides grounded starvation diagnosis when another auxiliary job waits', () => {
  const health = { peers: 0, activeReaderCount: 2, observedReaderCount: 2, readers: [
    { role: 'subtitle', nextPiecePresent: false, ageMs: 12_000 },
    { role: 'conversion', nextPiecePresent: false, ageMs: 8_500 },
  ] };
  assert.equal(classifyPlaybackStreamStatus(health, { stalled: true }).code, 'no-peers');
  assert.equal(classifyPlaybackStreamStatus(health, { stalled: true, paused: true }), null);
});
