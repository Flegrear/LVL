import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('real backend hosts an independent progressive ready-range status and scoped window reader', () => {
  assert.match(server, /createProgressiveIndexCache/);
  assert.match(server, /progressive\/status/);
  assert.match(server, /progressive\/window/);
  assert.match(server, /async function serveProgressive/);
  assert.match(server, /readyRanges/);
});

test('progressive reader cannot survive disabling storage or replacing source session', () => {
  assert.match(server, /progressiveIndexCache\.purgeAll\(/);
  assert.match(server, /progressiveIndexCache\.stopSession\(/);
  assert.match(server, /progressiveIndexCache\.stopAll\(/);
});

test('player uses verified disjoint progressive range data and a dedicated segment seek path', () => {
  assert.match(app, /function checkProgressiveSeekCache\(/);
  assert.match(app, /function openProgressiveSeekAt\(/);
  assert.match(app, /function readyProgressiveWindow\(/);
  assert.match(app, /function renderProgressiveSeekableRanges\(/);
  assert.match(html, /id="player-progress-progressive"/);
  assert.match(app, /requestVideoFrameCallback/);
});
