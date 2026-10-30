import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Exercise the actual client seek scheduling code, never a reimplementation.
const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const from = app.indexOf('function bufferedRemuxSeekTarget(');
const to = app.indexOf('// While a seek is waiting,', from);
assert.ok(from > 0 && to > from);

function player({ buffered = [[0, 42]], base = 240, copyVideo = true,
  readyState = 4, seeking = false, scrubbing = false, forceH264 = false,
  simulatePriming = false } = {}) {
  const timers = new Map();
  const calls = [];
  let now = 0, nextId = 0;
  const state = {
    pendingSeek: null, currentMs: 0, scrubbing,
    currentSource: { sessionId: 'private-session', fileIndex: 0 },
    transcodeBaseOffsetSeconds: base,
    transcodeContext: { baseUrl: '/api/torrents/private/files/0/transcode', copyVideo, forceH264, audioIndex: 1 },
  };
  const video = {
    paused: false, seeking, readyState, dataset: { mode: 'transcode' },
    buffered: {
      length: buffered.length,
      start(i) { return buffered[i][0]; },
      end(i) { return buffered[i][1]; },
    },
    pause() { this.paused = true; calls.push('pause'); },
  };
  const window = {
    setTimeout(fn, delay) { const id = ++nextId; timers.set(id, { fn, at: now + delay, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const context = vm.createContext({
    state, video, window, Number, Math, playbackLoadRequestId: 9,
    remuxMseSession: null,
    invalidateStreamStatus() {},
    cancelTranscodeStart() {
      calls.push('cancel-old-priming');
      if(state.pendingSeek?.priming)state.pendingSeek=null;
    },
    setPlayerLoading() {}, formatTime(ms) { return String(ms); },
    renderSubtitles() {}, updateCompatControls() {},
    restartTranscodeAt(target, options) {
      calls.push(['restart', target, options.wasPlaying]);
      if(simulatePriming)state.pendingSeek={target,wasPlaying:options.wasPlaying,priming:true};
    },
  });
  vm.runInContext(app.slice(from, to), context);
  const invoke = (target) => vm.runInContext('scheduleTranscodeSeek', context)(target);
  const advance = (ms) => {
    now += ms;
    for(const [id, entry] of [...timers]) {
      if(entry.at <= now) { timers.delete(id); entry.fn(); }
    }
  };
  return { state, video, calls, timers, invoke, advance, run: (code)=>vm.runInContext(code,context) };
}

test('buffered current copy-video fragment may coalesce a solitary seek with 180ms instead of 280ms', () => {
  const f=player();
  f.invoke(260); // video.buffered 0..42 is relative to effective 240s keyframe.
  assert.equal(f.state.pendingSeek.target,260);
  assert.equal(f.state.pendingSeek.wasPlaying,true);
  assert.equal(f.state.currentMs,260000);
  assert.deepEqual([...f.timers.values()].map(v=>v.delay),[180],
    'local verified buffer can save 100ms of fixed frontend scheduling, but still reopens FFmpeg');
  f.advance(179);
  assert.equal(f.calls.some(c=>Array.isArray(c)&&c[0]==='restart'),false);
  f.advance(1);
  assert.deepEqual(f.calls.at(-1),['restart',260,true]);
});

test('a rapid second drag step restarts the full 280ms coalescing window and never opens an obsolete FFmpeg seek', () => {
  const f=player();
  f.invoke(260);
  f.advance(90);
  f.invoke(268);
  assert.deepEqual([...f.timers.values()].map(v=>v.delay),[280]);
  f.advance(190);
  assert.equal(f.calls.some(c=>Array.isArray(c)&&c[0]==='restart'),false);
  f.advance(90);
  assert.deepEqual(f.calls.filter(Array.isArray),[['restart',268,true]]);
});

test('unbuffered, out-of-fragment, currently seeking, unreadied, or re-encoded streams retain normal 280ms protection', () => {
  const cases=[
    {buffered:[]},{buffered:[[0,10]]},{base:100},{copyVideo:false},
    {forceH264:true},{readyState:2},{seeking:true},{scrubbing:true},
  ];
  for(const options of cases) {
    const f=player(options);
    f.invoke(260);
    assert.deepEqual([...f.timers.values()].map(v=>v.delay),[280],JSON.stringify(options));
  }
});

test('paused buffered remux seek preserves pause intent, audio choice, subtitles and deferred source install', () => {
  const f=player();
  f.video.paused=true;
  f.invoke(260);
  assert.equal(f.state.pendingSeek.wasPlaying,false);
  assert.equal(f.state.transcodeContext.audioIndex,1);
  assert.equal(f.calls.filter(Array.isArray).length,0);
  f.advance(180);
  assert.deepEqual(f.calls.filter(Array.isArray),[['restart',260,false]]);
});

test('second click 181–279ms after a warm click aborts the first priming attempt and coalesces the replacement normally', () => {
  const f=player({simulatePriming:true});
  f.invoke(260);
  f.advance(200); // First 180ms timer already installed one FFmpeg request.
  assert.deepEqual(f.calls.filter(Array.isArray),[['restart',260,true]]);
  f.invoke(270); // Old verified frame no longer describes target 270.
  assert.equal(f.state.pendingSeek.wasPlaying,true);
  assert.deepEqual([...f.timers.values()].map(x=>x.delay),[280]);
  f.advance(279);
  assert.equal(f.calls.filter(Array.isArray).length,1);
  f.advance(1);
  assert.deepEqual(f.calls.filter(Array.isArray),[['restart',260,true],['restart',270,true]]);
  assert.equal(f.calls.filter(x=>x==='cancel-old-priming').length,2);
});

test('changing source or dub while a warm seek is queued must not reopen an obsolete request', () => {
  for(const change of [
    (f)=>{f.state.currentSource={sessionId:'other-session',fileIndex:0};},
    (f)=>{f.state.transcodeContext={...f.state.transcodeContext,audioIndex:3};},
    (f)=>{f.state.transcodeContext.audioIndex=3;},
    (f)=>{f.run('playbackLoadRequestId = 10');},
  ]) {
    const f=player();
    f.invoke(260);
    change(f);
    f.advance(180);
    assert.deepEqual(f.calls.filter(Array.isArray),[],'superseded seek must not install the new source');
    assert.equal(f.state.pendingSeek,null,'obsolete seek marker must clear');
  }
});
