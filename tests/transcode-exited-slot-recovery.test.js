import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pruneExitedTranscodes } from '../backend/media/transcode-slot-lifecycle.js';

const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');

test('dead FFmpeg children never permanently consume the two player conversion slots', () => {
  const completed = { pid: 100, exitCode: 0, signalCode: null };
  const killed = { pid: 101, exitCode: null, signalCode: 'SIGTERM' };
  const running = { pid: 102, exitCode: null, signalCode: null };
  const set = new Set([completed, killed, running]);
  const removed = pruneExitedTranscodes(set, () => true);
  assert.equal(removed, 2);
  assert.deepEqual([...set], [running], 'a real running encoder retains its slot');
});

test('windows process vanished before ChildProcess close eventually releases stale slot', () => {
  const ghost = { pid: 200, exitCode: null, signalCode: null };
  const running = { pid: 201, exitCode: null, signalCode: null };
  const set = new Set([ghost, running]);
  assert.equal(pruneExitedTranscodes(set, (pid) => pid === 201), 1);
  assert.deepEqual([...set], [running]);
});

test('only confirmed dead children are pruned; unknown or permission-denied process remains bounded', () => {
  const pending = { pid: 300, exitCode: null, signalCode: null };
  const set = new Set([pending]);
  assert.equal(pruneExitedTranscodes(set, () => true), 0);
  assert.equal(set.size, 1);
});

test('real backend reaps stale FFmpeg slots before rejecting new E1 conversion', () => {
  assert.match(server, /pruneExitedTranscodes\(activeTranscodes\)/,
    'the production admission route must reclaim dead processes, not just the synthetic helper');
  assert.match(server, /activeTranscodes\.size >= MAX_TRANSCODE_JOBS/);
  assert.match(server, /ffmpeg\.once\("close", \(code\) => \{/);
});
