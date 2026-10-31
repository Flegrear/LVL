import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const fragment = (start, end) => {
  const a = app.indexOf(start), b = app.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, 'production timeline function exists');
  return app.slice(a, b);
};

function harness({ base = 0, ranges = [[0, 30]], now = 10, mode = 'transcode', duration = 3480, indexedReady = false,
  knownDuration = true } = {}) {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { style: {}, textContent: '', max: '1', value: '0',
      classList: { toggle() {} }, setAttribute() {} });
    return nodes.get(id);
  };
  const video = { dataset: { mode }, currentTime: now, duration: duration - base,
    muted: false, volume: 1, buffered: { length: ranges.length,
      start: index => ranges[index][0], end: index => ranges[index][1] } };
  const state = { mediaDurationMs: knownDuration ? duration * 1000 : 0,
    transcodeBaseOffsetSeconds: base, scrubbing: false };
  const ctx = vm.createContext({
    state, video, $: selector => node(selector),
    renderEpisodeTimelineSegments() {}, refreshSubtitleTimelineFits() {},
    formatTime: ms => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`,
    playerIsPlaying: () => true,
    absolutePlaybackSeconds: () => base + now,
    readyIndexedVideo: () => indexedReady,
    renderProgressiveSeekableRanges() {},
    transcodeStartAttempt: null,
  });
  vm.runInContext(fragment('function playerReadyRangeSeconds() {', '\nfunction isPlayerTimeBuffered('),ctx);
  vm.runInContext(fragment('function updateCompatControls() {', '\nfunction updatePlayerPreferenceButtons()'),ctx);
  vm.runInContext('updateCompatControls()',ctx);
  return { node, ctx, state, video };
}

test('41:03 / 58:00 timeline white played width uses absolute position, not local FFmpeg timestamp', () => {
  const h = harness({ base: 2400, now: 63, ranges: [[60, 82]], duration: 3480 });
  assert.equal(h.node('#compat-time').textContent, '41:03 / 58:00');
  assert.equal(h.node('#player-progress-played').style.width, `${(2463 / 3480 * 100)}%`);
});

test('ready band starts at exact native buffer range and never paints unbuffered time from conversion origin', () => {
  const h = harness({ base: 2400, now: 63, ranges: [[59, 83]], duration: 3480 });
  assert.equal(h.node('#player-progress-ready').style.left, `${(2459 / 3480 * 100)}%`);
  assert.ok(Math.abs(parseFloat(h.node('#player-progress-ready').style.width) - 24 / 3480 * 100) < 0.000001);
});

test('a disjoint or stale buffer range cannot be presented as instantly available', () => {
  const h = harness({ base: 2400, now: 63, ranges: [[0, 12], [85, 130]], duration: 3480 });
  assert.equal(h.node('#player-progress-ready').style.width, '0%');
  assert.equal(h.node('#player-progress-ready').style.left, '0%');
});

test('verified completed indexed MP4 makes the full episode ready on timeline even before source handoff', () => {
  const h = harness({ base: 0, now: 6, duration: 1437, ranges: [[0, 13]], indexedReady: true });
  assert.equal(h.node('#player-progress-ready').style.left, '0%');
  assert.equal(h.node('#player-progress-ready').style.width, '100%');
});

test('short native fMP4 window must not be shown as the entire episode while probe duration is pending', () => {
  const h = harness({ now: 6, duration: 13, knownDuration: false, mode: 'transcode' });
  assert.equal(h.node('#compat-time').textContent, '0:06 / --:--');
  assert.equal(h.node('#player-progress-ready').style.width, '0%');
});
