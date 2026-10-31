/**
 * Deterministic, portless regression for a seek into an UNINDEXED gap between
 * bright verified progressive sections. Exercises real app.js seek dispatch
 * and transcode debounce; does not inspect media data or assume that a fully
 * downloaded torrent implies a complete indexed MP4.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
function slice(start, end) {
  const a = app.indexOf(start);
  const b = app.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `Missing real app.js boundary: ${start} / ${end}`);
  return app.slice(a, b);
}

const opening = slice('function openProgressiveSeekAt(', '\nlet remuxMseWarmSeek');
const gapFallback = slice('function seekGapViaVerifiedIndexedOrNative(', '\nfunction openProgressiveSeekAt(');
const schedule = slice('function scheduleTranscodeSeek(', '\n// While a seek is waiting,');
const seek = slice('function seekPlayerTo(seconds) {', '\nfunction seekPlayerBy(');
const playerIntent = slice('function playerIsPlaying() {', '\n// FFmpeg\'s fragmented MP4');
const recovery = slice('async function recoverPlayback(', '\nfunction scheduleBufferingIndicator(');

function fixture({ paused = true, indexedReady = false, indexedReport = { status: 'building' },
  progressive = true, cachedRemuxWindow = false, currentTime = 8 } = {}) {
  const calls = [], timers = [];
  let nextTimer = 0;
  const session = { id: 'session-jjk-e4', kind: 'torrent', fileIndex: 0 };
  const context = { sessionId: 'session-jjk-e4', fileIndex: 0,
    audioIndex: 1, baseUrl: '/api/torrents/session-jjk-e4/files/0/transcode', copyVideo: true };
  const state = {
    currentSource: session, transcodeContext: context, pendingSeek: null,
    mediaDurationMs: 144_000, transcodeBaseOffsetSeconds: 0,
    currentMs: currentTime * 1000, scrubbing: false,
  };
  const video = {
    dataset: { mode: 'transcode', ...(progressive ? { progressive: '1' } : {}) },
    paused, readyState: 4, currentTime, duration: 144, muted: false,
    seeking: false, buffered: { length: 1, start: () => 6, end: () => 10 },
    pause() { this.paused = true; calls.push({ type: 'pause' }); },
    play() { this.paused = false; calls.push({ type: 'play' }); return Promise.resolve(); },
  };
  const win = {
    MediaSource: { isTypeSupported: () => true },
    clearTimeout() {},
    setTimeout(fn, delay) { const item = { id: ++nextTimer, fn, delay };
      timers.push(item); return item.id; },
  };
  const vmContext = vm.createContext({
    state, video, window: win, remuxMseCacheAllowed: true,
    playbackLoadRequestId: 77,
    remuxMseSession: cachedRemuxWindow ? {
      cancelRestore() {}, async restoreWindow() {
        calls.push({ type: 'restore-window' }); return true;
      },
    } : null,
    progressiveSeekReady: { report: { mime: 'video/mp4; codecs="avc1.4d401e, mp4a.40.2"' } },
    // Two actual bright sections 6-10 and 30-35, no section at 20.
    readyProgressiveWindow: target => (
      target >= 6 && target < 9.75 ? { id: 'first' } :
      target >= 30 && target < 34.75 ? { id: 'second' } : null),
    progressiveSeekContext: () => ({
      sourceKey: 'torrent:session-jjk-e4:0', generation: 77,
      audioIndex: 1, audioMode: 'auto', durationSeconds: 144,
    }),
    readyIndexedVideo: () => indexedReady || Boolean(vmContext.indexedSeekReady), openIndexedSeekAt(at, options) {
      calls.push({ type: 'indexed', at, options }); return true;
    },
    indexedGapSeekRequest: null, indexedSeekReady: null,
    indexedCacheStatusUrl: () => '/api/torrents/session-jjk-e4/files/0/indexed/status?audio=1',
    audioOutputMode: 'auto', normalizeAudioMode: v => v || 'auto',
    fetchJson: async () => indexedReport,
    AbortSignal, AbortController, encodeURIComponent,
    isPlayerTimeBuffered: () => false,
    seekInsideRemuxMse: () => calls.some(c => c.type === 'restore-window'),
    bufferedRemuxSeekTarget: () => false,
    openTranscodeAt: async (at, options) => {
      calls.push({ type: 'native', at, options });
      return true;
    },
    restartTranscodeAt: async (at, options) => {
      calls.push({ type: 'restart', at, options });
      return true;
    },
    clearWaitingTorrentSeek() {},
    invalidateStreamStatus() {},
    preserveCurrentFrameForTranscodeSeek() {
      calls.push({ type: 'preserve-frame' });
    },
    cancelTranscodeStart() {}, closeRemuxMseSession() {},
    setPlayerLoading(_p, message) { calls.push({ type: 'loading', message }); },
    hideLoadingForBufferedSeek() {},
    renderSubtitles() {}, updateCompatControls() {},
    loadMoreEmbeddedSubtitles() { calls.push({ type: 'captions' }); },
    formatTime: seconds => String(seconds),
    frame: { classList: { contains: () => true } },
    absolutePlaybackSeconds: () => video.currentTime,
    progressiveSeekController: null, progressiveContinueController: null,
    progressiveMseLoader: null,
  });
  vm.runInContext(gapFallback + '\n' + opening + '\n' + playerIntent
    + '\n' + schedule + '\n' + seek, vmContext);
  return {
    calls, state, video, timers, context, session, vmContext,
    go: seconds => vm.runInContext(`seekPlayerTo(${seconds})`, vmContext),
    async flush() {
      await new Promise(resolve => setImmediate(resolve));
      const items = timers.splice(0);
      for (const item of items) await item.fn();
      await new Promise(resolve => setImmediate(resolve));
    },
  };
}

test('RED: a missing progressive section falls back one-way to NATIVE at movie timestamp, never another optional remux-MSE retry', async () => {
  const f = fixture({ paused: false });
  assert.equal(f.go(20), true);
  assert.equal(f.state.pendingSeek.target, 20);
  assert.equal(f.state.pendingSeek.wasPlaying, true);
  await f.flush();
  const fallback = f.calls.filter(c => c.type === 'native' || c.type === 'restart');
  assert.equal(fallback.length, 1, 'only one replacement attempt for the verified-section gap');
  assert.equal(fallback[0].type, 'native',
    'missing progressive section must select explicit one-way native fallback, not restart optional MSE');
  assert.equal(fallback[0].at, 20, 'do not reuse previous short MSE buffer-local time');
  assert.equal(fallback[0].options.wasPlaying, true);
  assert.equal(fallback[0].options.forceNative, true);
  assert.equal(f.state.currentSource, f.session, 'same episode source identity');
  assert.equal(f.state.transcodeContext, f.context, 'same audio/source plan');
  assert.equal(f.calls.some(c => c.type === 'indexed'), false,
    'a full indexed MP4 must not be assumed to exist');
});

test('newly verified complete indexed MP4 wins over a progressive gap without starting FFmpeg',async()=>{
  const f=fixture({paused:false,indexedReport:{status:'ready',
    url:'/api/torrents/session-jjk-e4/files/0/indexed?audio=1&audioMode=auto'}});
  assert.equal(f.go(20),true);
  await f.flush();
  const indexed=f.calls.filter(c=>c.type==='indexed');
  assert.equal(indexed.length,1,'freshly authenticated completed MP4 must be used immediately');
  assert.equal(indexed[0].at,20);
  assert.equal(indexed[0].options.wasPlaying,true);
  assert.equal(f.calls.filter(c=>c.type==='native'||c.type==='restart').length,0,
    'no restart or speculative MSE when full indexed range is already ready');
});

test('RED: a paused seek into a gap must never restart audio and must keep the selected source/track', async () => {
  const f = fixture({ paused: true });
  assert.equal(f.go(21), true);
  assert.equal(f.state.pendingSeek.wasPlaying, false);
  await f.flush();
  const fallback = f.calls.filter(c => c.type === 'native' || c.type === 'restart');
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0].type, 'native');
  assert.equal(fallback[0].options.wasPlaying, false);
  assert.equal(fallback[0].options.forceNative, true);
  assert.equal(f.video.paused, true);
  assert.equal(f.calls.some(c => c.type === 'play'), false);
  assert.equal(f.state.transcodeContext.audioIndex, 1);
});

test('tiny 90ms cross-GOP gap seek must not issue raw video.currentTime into an unbuffered MSE hole', async () => {
  const f = fixture({ paused: true, currentTime: 9.70 });
  assert.equal(f.go(9.79), true);
  await f.flush();
  const fallback = f.calls.filter(c => c.type === 'native' || c.type === 'restart');
  assert.equal(fallback.length, 1, 'even a sub-200ms gap requires an explicit handoff');
  assert.equal(fallback[0].type, 'native');
  assert.equal(fallback[0].at, 9.79);
  assert.equal(f.video.currentTime, 9.70,
    'old short MSE video must not be told to decode a missing range');
});

test('queued gap seek must honor latest Play/Pause intent and ignore superseded source generation', async () => {
  const f = fixture({ paused: true });
  f.go(20);
  f.state.pendingSeek.wasPlaying = true;
  await f.flush();
  const first = f.calls.filter(c => c.type === 'native' || c.type === 'restart');
  assert.equal(first.length, 1);
  assert.equal(first[0].options.wasPlaying, true, 'Play while pending applies to the destination');

  const obsolete = fixture({ paused: false });
  obsolete.go(20);
  obsolete.vmContext.playbackLoadRequestId = 78;
  obsolete.state.currentSource = { id: 'different-episode' };
  await obsolete.flush();
  assert.equal(obsolete.calls.some(c => c.type === 'restart' || c.type === 'native'), false,
    'old pending gap timer must not open a previous episode over a newer selection');
});

test('RED guard: ordinary transcode remux seeks must retain the original warm-window restore path', async () => {
  const f = fixture({ paused: false, progressive: false, cachedRemuxWindow: true });
  assert.equal(f.go(20), true);
  assert.equal(f.state.pendingSeek.gapIndexedLookup, undefined,
    'a NON-progressive seek is not a hole in standalone progressive GOP coverage');
  await f.flush();
  assert.equal(f.calls.filter(c => c.type === 'restore-window').length, 1,
    'ordinary MSE remux must still try its bounded cache restore before restarting FFmpeg');
  assert.equal(f.calls.filter(c => c.type === 'native' || c.type === 'restart').length, 0);
});

test('RED: long-paused progressive decode failure uses bounded ONE-WAY native recovery, not a new MSE loop', async () => {
  const source = { kind: 'torrent', libraryId: 'jjk-e4', sessionId: 'same-session' };
  const calls = [];
  const video = { dataset: { mode: 'transcode', progressive: '1' },
    paused: true, ended: false, error: { code: 4 } };
  const state = { currentSource: source, pendingSeek: null, loadingProgress: 100,
    transcodeContext: { sessionId: 'same-session', audioIndex: 1 } };
  const context = vm.createContext({
    state, video, recoveryBusy: false, recoveryPlaybackRequested: true,
    recoveryDisplayPhase: '', recoveryStallDiagnosis: null,
    recoveryDisplayEvents: [], recoveryDisplayEpisode: '',
    recoveryWaitingSince: null, recoveryLastMotionAt: 0, recoveryLastPosition: -1,
    playbackRecovery: { sourceKey: 'jjk-e4:0' }, playbackLoadRequestId: 91,
    currentRecoveryKey: () => 'jjk-e4:0', currentChapterSources: () => [],
    requestPlaybackRecovery: initial => ({
      state: initial, action: { type: 'retry-source', reason: 'error', sourceKey: 'jjk-e4:0', attempt: 1 },
    }),
    currentStreamDiagnosis: () => null,
    viewActive: () => true, floatingDesktopWindow: null, floatingDesktopPending: false,
    document: { pictureInPictureElement: null },
    window: { documentPictureInPicture: null, setTimeout() {} },
    $: () => ({ textContent: '', classList: { contains: () => false } }),
    playbackRetryStrategy: () => 'restart-transcode',
    recordRecoveryDisplay() {}, stopRecoveryWatch() {}, setPlayerLoading() {},
    renderRecoveryOverlay() {}, toast() {},
    absolutePlaybackSeconds: () => 20.25,
    restartTranscodeAt: async (at, options) => {
      calls.push({ at, options, source: state.currentSource });
      return true;
    },
    console: { warn() {} }, Date,
  });
  vm.runInContext(recovery, context);
  await vm.runInContext('recoverPlayback("error")', context);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].at, 20.25);
  assert.equal(calls[0].options.wasPlaying, true,
    'explicit Play intent survives the error even if the video element reports paused');
  assert.equal(calls[0].options.forceNative, true,
    'an errored standalone progressive MSE must not be re-opened as optional MSE again');
  assert.equal(calls[0].source, source, 'no phantom source switch');
});
