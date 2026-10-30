import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const from = app.indexOf('let indexedSeekAttempt = null;');
const to = app.indexOf('\nlet remuxMseWarmSeek = null;', from);
assert.ok(from >= 0 && to > from, 'real indexed player transition is available');

function makePlayer({ wasPlaying = true } = {}) {
  const calls = [], listeners = new Map(), frames = new Map(), timers = new Map();
  let timerId = 0, frameId = 0;
  const classes = new Set();
  const source = { id: 'episode-one' }, context = { audioIndex: 0 };
  const cache = { context, source, audioIndex: 0, audioMode: 'auto', url: '/api/torrents/own/files/0/indexed?audio=0&audioMode=auto' };
  const video = {
    dataset: { mode: 'transcode' }, currentTime: 1, readyState: 4, error: null,
    src: 'blob:original', currentSrc: 'blob:original', paused: !wasPlaying,
    muted: false, seeking: false, style: {},
    pause() { this.paused = true; calls.push('pause'); },
    play() { this.paused = false; calls.push('play'); return Promise.resolve(); },
    load() { this.currentSrc = this.src; calls.push('load'); },
    addEventListener(name, handler) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(handler); },
    removeEventListener(name, handler) { listeners.get(name)?.delete(handler); },
    requestVideoFrameCallback(handler) { frames.set(++frameId, handler); return frameId; },
    cancelVideoFrameCallback(id) { frames.delete(id); },
  };
  const state = { currentSource: source, transcodeContext: context, pendingSeek: null,
    currentMs: 1000, transcodeBaseOffsetSeconds: 1 };
  const runtime = {
    video, state, playbackLoadRequestId: 17, indexedSeekReady: cache,
    sourceFrameGate: null, subtitlePresentedFrame: null,
    frame: { classList: {
      add(name) { classes.add(name); }, remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); },
    } },
    readyIndexedVideo: () => true,
    closeRemuxMseSession() { calls.push('close-mse'); },
    cancelTranscodeStart() { calls.push('cancel-native'); },
    invalidateSubtitleFrameClock() {},
    setPlayerLoading() { calls.push('show-loader'); },
    formatTime: () => '1:10', renderSubtitles() {},
    clearTranscodeSeekFrame() { calls.push('clear-freeze'); },
    hideLoadingForBufferedSeek() { calls.push('hide-loader'); },
    schedulePresentedSubtitleFrame() {}, updateCompatControls() {},
    expectNewVideoFrame() { classes.add('source-transition');
      runtime.sourceFrameGate = { src: video.src, source, loadId: 17 }; },
    openTranscodeAt() { calls.push('fallback-native'); return Promise.resolve(true); },
    recoverPlayback() {},
    window: {
      setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; },
      clearTimeout(id) { timers.delete(id); },
    },
    URL: { revokeObjectURL() {} },
  };
  const ctx = vm.createContext(runtime);
  vm.runInContext(app.slice(from, to), ctx);
  const emit = (name) => { for (const handler of [...(listeners.get(name) || [])]) handler(); };
  const present = (mediaTime) => {
    const callbacks = [...frames.values()]; frames.clear();
    for (const callback of callbacks) callback(0, { mediaTime });
  };
  return { ctx, video, state, runtime, calls, classes, timers, emit, present };
}

test('verified indexed target frame removes stale source transition and loader, restoring play intent', () => {
  const h = makePlayer({ wasPlaying: true });
  assert.equal(vm.runInContext('openIndexedSeekAt(70,{wasPlaying:true})', h.ctx), true);
  assert.ok(h.classes.has('source-transition'));
  assert.equal(h.video.dataset.indexed, '1');
  h.emit('loadedmetadata');
  h.present(20); // an earlier stale/out-of-target frame cannot pass.
  assert.notEqual(h.state.pendingSeek, null);
  assert.ok(!h.calls.includes('hide-loader'));
  h.present(70.083333);
  assert.equal(h.state.pendingSeek, null);
  assert.equal(h.classes.has('source-transition'), false);
  assert.ok(h.calls.includes('hide-loader'));
  assert.equal(h.video.muted, false);
  assert.equal(h.video.paused, false);
  assert.equal(h.calls.includes('fallback-native'), false);
});

test('paused indexed target seek prerolls muted for frame verification, then remains paused', () => {
  const h = makePlayer({ wasPlaying: false });
  vm.runInContext('openIndexedSeekAt(70,{wasPlaying:false})', h.ctx);
  h.emit('loadedmetadata');
  assert.equal(h.video.muted, true);
  assert.equal(h.video.paused, false, 'muted decoder preroll activates rVFC while paused');
  h.present(70.08333);
  assert.equal(h.video.paused, true);
  assert.equal(h.video.muted, false);
  assert.ok(h.calls.includes('hide-loader'));
});

test('obsolete decoder frame cannot unlock or auto-play a different episode', () => {
  const h = makePlayer();
  vm.runInContext('openIndexedSeekAt(70,{wasPlaying:true})', h.ctx);
  h.emit('loadedmetadata');
  const playback = h.state.currentSource = { id: 'new-episode' };
  h.present(70.083333);
  assert.notEqual(h.state.pendingSeek, null,
    'obsolete indexed callback never changes the newer source pending state');
  assert.equal(h.state.currentSource, playback);
  assert.equal(h.calls.includes('hide-loader'), false);
});
