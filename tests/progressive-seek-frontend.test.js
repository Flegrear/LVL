import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeProgressiveSeekStatus,
  normalizeCommittedProgressiveIndexStatus,
  findProgressiveReadySegment,
  progressiveReadyRanges,
  createProgressiveSeekController,
  createStandaloneProgressiveMseLoader,
} from '../frontend/player/progressive-seek.js';

const identity = Object.freeze({
  sourceKey: 'torrent:synthetic-alpha', generation: 5,
  audioIndex: 0, audioMode: 'auto', durationSeconds: 96,
});
const segment = (id, startSeconds, endSeconds, overrides = {}) => ({
  id, startSeconds, endSeconds, bytes: 1024 * 1024,
  complete: true, verified: true, independentlyDecodable: true,
  keyframeStart: true, movieClockVerified: true, ...overrides,
});
const report = (segments, overrides = {}) => ({
  kind: 'indexed-video-segments', status: 'partial-ready',
  ...identity, videoCodec: 'h264', audioCodec: 'aac', container: 'fmp4',
  mime: 'video/mp4; codecs="avc1.640028, mp4a.40.2"',
  initVerified: true, sourceVerified: true, segments, ...overrides,
});

function fakeVideo() {
  const pending = new Map();
  let frameId = 0;
  const video = {
    paused: false, seeking: false, readyState: 4, currentTime: 0,
    currentSrc: 'blob:alpha-current', src: 'blob:alpha-current',
    style: { visibility: '' }, playCount: 0, pauseCount: 0,
    get pendingFrames() { return pending.size; },
    requestVideoFrameCallback(callback) { const id = ++frameId; pending.set(id, callback); return id; },
    cancelVideoFrameCallback(id) { pending.delete(id); },
    deliver(mediaTime) {
      const entry = pending.entries().next().value;
      assert.ok(entry, 'frame callback must be armed before delivery');
      pending.delete(entry[0]);
      entry[1](0, { mediaTime });
    },
    pause() { this.paused = true; this.pauseCount++; },
    play() { this.paused = false; this.playCount++; return Promise.resolve(); },
  };
  return video;
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const runner = ({ getContext = () => ({ ...identity }), loadWindow, video = fakeVideo(), ...more } = {}) => {
  const seen = [];
  const controller = createProgressiveSeekController({
    video, getContext, canUseMse: () => true,
    timeoutMs: 200, loadWindow: loadWindow || (async ({ segment }) => {
      seen.push(segment.id);
      return { ready: true, baseSeconds: 0 };
    }), ...more,
  });
  return { controller, seen, video };
};

test('RED: a completed per-section index is bright before full-episode completion, never downloaded map', () => {
  const ready = normalizeProgressiveSeekStatus(report([
    segment('a', 0, 10), segment('b', 30, 38),
  ], { downloadedMap: '100% downloaded', status: 'building' }), identity);
  assert.ok(ready, 'completed verified sections must work while full indexed MP4 is building');
  assert.deepEqual(progressiveReadyRanges(ready), [{start:0,end:9.75},{start:30,end:37.75}]);
  assert.equal(findProgressiveReadySegment(ready, 6)?.id, 'a');
  assert.equal(findProgressiveReadySegment(ready, 34)?.id, 'b');
  assert.equal(findProgressiveReadySegment(ready, 20), null, 'missing decoded gap cannot be bright');
  assert.equal(findProgressiveReadySegment(ready, 37.95), null, 'need a bounded decode-ahead margin');
  assert.equal(normalizeProgressiveSeekStatus(report([], {downloadedMap:'100%'}), identity), null);
});

test('verified distant MKV Cluster maps LOCAL fragment PTS to ORIGINAL 4-second movie clock',()=>{
  const localFirstFrame=0.04, originalFirstFrame=4;
  const island=segment('island-at-four',4,4.96,{
    mediaStartSeconds:localFirstFrame,
    timelineOffsetSeconds:originalFirstFrame-localFirstFrame,
    initHash:'a'.repeat(64),
  });
  const ready=normalizeProgressiveSeekStatus(report([island]),identity);
  assert.ok(ready,'a probe-verified island must not be rejected because remux PTS restarted at zero');
  assert.deepEqual(progressiveReadyRanges(ready),[{start:4,end:4.71}]);
  assert.equal(findProgressiveReadySegment(ready,4.4)?.id,'island-at-four');
  assert.equal(findProgressiveReadySegment(ready,0.4),null,
    'download position or local remux time 0.4 never corresponds to the original movie 0.4');
  assert.equal(normalizeProgressiveSeekStatus(report([
    segment('unproven-clock',4,4.96,{mediaStartSeconds:localFirstFrame})
  ]),identity),null,'later island without FFprobe-proven offset must never claim movie time');
});

test('RED: bright range preserves even sub-250ms unseekable section edges and disjoint gaps', () => {
  const ready = normalizeProgressiveSeekStatus(report([
    segment('d',30,35), segment('a',0,5), segment('b',5,9), segment('c',8,11),
    segment('e',35.001,45),
  ]), identity);
  assert.deepEqual(progressiveReadyRanges(ready),
    [{start:0,end:4.75},{start:5,end:10.75},
      {start:30,end:34.75},{start:35.001,end:44.75}]);
  assert.equal(findProgressiveReadySegment(ready, 10.8), null,
    'an individual bounded window must cover the target and lookahead');
  assert.equal(findProgressiveReadySegment(ready, 32)?.id, 'd');
});

test('RED: unverified/partial/download-only sections must NEVER enter ready range map', () => {
  const ready = normalizeProgressiveSeekStatus(report([
    segment('a',0,10),
    segment('bad-incomplete',10,20,{complete:false}),
    segment('bad-source',20,30,{verified:false}),
    segment('bad-codec',30,40,{independentlyDecodable:false}),
    segment('bad-gop',40,50,{keyframeStart:false}),
    segment('bad-clock',50,60,{movieClockVerified:false}),
    segment('bad-size',60,70,{bytes: 1024 * 1024 * 1024}),
    segment('bad-nan',NaN,90),
  ]),identity);
  assert.deepEqual(progressiveReadyRanges(ready),[{start:0,end:9.75}]);
  for (const t of [12,22,32,42,52,62,75])
    assert.equal(findProgressiveReadySegment(ready,t),null);
});

test('RED: stale identity, audio, generation, invalid duration/codec/container reject entire report', () => {
  const valid=[segment('a',0,20)];
  for (const changes of [
    {sourceKey:'torrent:other'}, {generation:4}, {audioIndex:1},
    {audioMode:'surround'}, {durationSeconds:97}, {videoCodec:'hevc'},
    {audioCodec:'opus'}, {container:'mp4'}, {initVerified:false},
    {sourceVerified:false}, {mime:'video/mp4; codecs="hvc1.1.6.L93.B0, mp4a.40.2"'},
    {kind:'torrent-piece-map'}, {status:'downloaded'},
  ])
    assert.equal(normalizeProgressiveSeekStatus(report(valid,changes),identity),null,
      'changed status identity or unsupported codec should fail closed: '+JSON.stringify(changes));
  for (const expected of [
    {...identity,generation:6}, {...identity,sourceKey:'torrent:old'},
    {...identity,audioIndex:1}, {...identity,audioMode:'stereo'},
  ]) assert.equal(normalizeProgressiveSeekStatus(report(valid),expected),null);
});

test('RED: limits refuse unbounded status arrays, segments and bad duplicated IDs', () => {
  assert.equal(normalizeProgressiveSeekStatus(report(
    Array.from({length:8193},(_,i)=>segment('s'+i,i*.001,i*.001+.001))),identity),null);
  assert.deepEqual(progressiveReadyRanges(normalizeProgressiveSeekStatus(report([
    segment('a',0,10), segment('a',50,65),
    segment('outside',90,110), segment('invalid',60,70,{bytes:-2}),
  ]),identity)),[{start:0,end:9.75}]);
});

test('RED: real backend committed index adapter preserves disjoint GOPs and exact AVC profile', () => {
  const raw={
    status:'building',complete:false,identityKey:'a'.repeat(64),
    mime:'video/mp4; codecs="avc1.4D401E, mp4a.40.2"',
    ranges:[
      {id:'b'.repeat(64),sequence:0,start:0,end:12,mediaStart:0,
        baseSeconds:0,seekOffsetSeconds:0,initHash:'c'.repeat(64),bytes:8192},
      {id:'d'.repeat(64),sequence:2,start:30,end:45,mediaStart:30,
        baseSeconds:0,seekOffsetSeconds:0,initHash:'c'.repeat(64),bytes:8192},
    ],
  };
  const normalized=normalizeCommittedProgressiveIndexStatus(raw, identity,identity);
  assert.ok(normalized, 'already-committed indexed GOPs must be admitted during building');
  assert.equal(normalized.mime,raw.mime);
  assert.equal(normalized.identityKey,raw.identityKey);
  assert.equal(normalized.segments[1].mediaStartSeconds,30);
  assert.equal(normalized.segments[1].initHash,'c'.repeat(64));
  assert.equal(Object.isFrozen(normalized),true);
  assert.equal(Object.isFrozen(normalized.segments[0]),true);
  assert.equal(Object.isFrozen(normalized.ranges[0]),true);
  assert.throws(()=>{ normalized.ranges[0].end=96; },TypeError);
  assert.deepEqual(progressiveReadyRanges(normalized),[{start:0,end:11.75},{start:30,end:44.75}]);
  assert.equal(findProgressiveReadySegment(normalized,20),null);
  assert.equal(normalizeCommittedProgressiveIndexStatus(raw,identity,{...identity,generation:6}),null);
  assert.equal(normalizeCommittedProgressiveIndexStatus(raw,{...identity,identityKey:'e'.repeat(64)},identity),null);
  assert.equal(normalizeCommittedProgressiveIndexStatus({...raw,mime:'video/mp4; codecs="hvc1.1.6.L93.B0"'},identity,identity),null);
  assert.equal(normalizeCommittedProgressiveIndexStatus({...raw,ranges:[{...raw.ranges[0],seekOffsetSeconds:1}]},identity,identity),null);
  assert.equal(normalizeProgressiveSeekStatus(report([segment('t',10,20,{
    mediaStartSeconds:30,
  })]),identity),null,'impossible video timestamp cannot become seek ready');
});

test('RED: seek helper uses verified window, waits for actual visible rVFC target, never starts playback', async () => {
  const {controller, video, seen} = runner();
  const pending = controller.seek(report([segment('a',0,30)]), 12);
  await flush();
  assert.deepEqual(seen,['a']);
  assert.equal(video.currentTime,12);
  video.deliver(0); // Chromium can report hidden old preroll frame.
  assert.equal(video.pendingFrames,1);
  video.style.visibility = 'hidden';
  video.deliver(12); // Hidden target is not visibly ready.
  assert.equal(video.pendingFrames,1);
  video.style.visibility = '';
  video.seeking = true;
  video.deliver(12);
  assert.equal(video.pendingFrames,1);
  video.seeking = false;
  video.deliver(12.02);
  assert.deepEqual(await pending,{ok:true,mediaTime:12.02,absoluteSeconds:12.02});
  assert.equal(video.pendingFrames,0);
  assert.equal(video.playCount,0);
  assert.equal(video.pauseCount,0);
});

test('RED: paused seeking preserves explicit pause, source clock base and demands exact frame', async () => {
  const video=fakeVideo(); video.paused=true;
  const {controller} = runner({video,loadWindow:async()=>({ready:true,baseSeconds:20})});
  const pending=controller.seek(report([segment('b',20,40)]),25);
  await flush();
  assert.equal(video.currentTime,5);
  video.deliver(4.7);
  assert.equal(video.pendingFrames,1);
  video.deliver(5.03);
  assert.deepEqual(await pending,{ok:true,mediaTime:5.03,absoluteSeconds:25.03});
  assert.equal(video.paused,true);
  assert.equal(video.playCount,0);
});

test('RED: incomplete target, unsupported MSE, stale context are rejected before loader or seek', async () => {
  const video=fakeVideo(); const seen=[];
  const {controller}=runner({video,seen,canUseMse:()=>false,
    loadWindow:async()=>{seen.push('loaded');return {ready:true,baseSeconds:0};}});
  assert.equal((await controller.seek(report([segment('a',0,20)]),12)).ok,false);
  assert.deepEqual(seen,[]);
  const allowed=runner({video});
  assert.equal((await allowed.controller.seek(report([segment('a',0,10)]),40)).ok,false);
  assert.equal(video.currentTime,0);
  assert.equal(video.pendingFrames,0);
});

test('RED: source/audio/generation mutation during async window load aborts and forbids late seek', async () => {
  let release; const blocker=new Promise(r=>{release=r;});
  const source={...identity};
  const {controller,video}=runner({getContext:()=>({...source}),
    loadWindow:async()=>blocker});
  const pending=controller.seek(report([segment('a',0,35)]),15);
  await flush();
  source.audioIndex=2;
  release({ready:true,baseSeconds:0});
  assert.equal((await pending).ok,false);
  assert.equal(video.currentTime,0);
  assert.equal(video.pendingFrames,0);
});

test('RED: concurrent seek supersedes old, cancel/close release rVFC, stale media source fails closed', async () => {
  const video=fakeVideo();
  const {controller}=runner({video});
  const a=controller.seek(report([segment('a',0,40)]),10);
  await flush();
  assert.equal(video.pendingFrames,1);
  const b=controller.seek(report([segment('a',0,40)]),25);
  assert.equal((await a).ok,false);
  await flush();
  video.deliver(25.01);
  assert.equal((await b).ok,true);
  const c=controller.seek(report([segment('a',0,40)]),15);
  await flush();
  video.src='blob:unexpected-other-video';
  video.deliver(15);
  assert.equal((await c).ok,false);
  assert.equal(video.pendingFrames,0);
  const d=controller.seek(report([segment('a',0,40)]),16);
  await flush();
  controller.close();
  assert.equal((await d).ok,false);
  assert.equal(video.pendingFrames,0);
  assert.equal((await controller.seek(report([segment('a',0,40)]),17)).ok,false);
});

test('RED: abort signal reaches window loader; failed/expired loader can never assert ready', async () => {
  const aborts=[];
  const {controller,video}=runner({loadWindow:async({signal})=>
    new Promise(resolve=>signal.addEventListener('abort',()=>{
      aborts.push(true);resolve({ready:true,baseSeconds:0});
    },{once:true})), timeoutMs:50});
  const pending=controller.seek(report([segment('a',0,40)]),18);
  assert.equal((await pending).ok,false);
  assert.equal(video.pendingFrames,0);
  assert.ok(aborts.length>=1);
});

const mp4Box = (name, length=12) => {
  const bytes = new Uint8Array(length);
  new DataView(bytes.buffer).setUint32(0, length);
  for (let i = 0; i < 4; i++) bytes[4 + i] = name.charCodeAt(i);
  return bytes;
};
const minimalWindow = () => {
  const boxes = ['ftyp','moov','moof'].map(name=>mp4Box(name))
    .concat(mp4Box('mdat',4096-36));
  const joined = new Uint8Array(boxes.reduce((a,b) => a + b.length, 0));
  let i = 0;
  for (const bytes of boxes) { joined.set(bytes,i);i+=bytes.length; }
  return joined;
};
const verifiedWindow = (section, overrides = {}) => ({
  segmentId: section.id, sourceKey: identity.sourceKey,
  generation: identity.generation, audioIndex: identity.audioIndex,
  audioMode: identity.audioMode, startSeconds: section.startSeconds,
  endSeconds: section.endSeconds, mediaStartSeconds: 0,
  contentType: 'video/mp4; codecs="avc1.640028, mp4a.40.2"',
  complete: true, verified: true, initVerified: true,
  bytes: minimalWindow(), ...overrides,
});

function fakeStandaloneMedia(video, { start = 10, end = 20 } = {}) {
  const mediaSources = [], revoked = [];
  let created = 0;
  class Emitter {
    constructor() { this.listeners = new Map(); }
    addEventListener(name, fn) {
      const set=this.listeners.get(name)||new Set();set.add(fn);this.listeners.set(name,set);
    }
    removeEventListener(name, fn) {this.listeners.get(name)?.delete(fn);}
    emit(name) {for(const fn of [...(this.listeners.get(name)||[])]) fn();}
  }
  class BufferFake extends Emitter {
    constructor() {super();this.updating=false;this.timestampOffset=0;this.mode='segments';this.saved=null;}
    get buffered() {
      return {
        length: this.saved ? 1 : 0,
        start:()=>start + this.timestampOffset,
        end:()=>end + this.timestampOffset,
      };
    }
    appendBuffer(bytes) {
      this.saved=bytes;this.updating=true;
      setImmediate(()=>{this.updating=false;this.emit('updateend');});
    }
  }
  class MediaFake extends Emitter {
    constructor() {super();this.readyState='closed';this.buffer=null;this.duration=NaN;}
    addSourceBuffer() {this.buffer=new BufferFake();return this.buffer;}
    endOfStream() {this.readyState='ended';}
  }
  const createMediaSource = () => {
    const media = new MediaFake();
    mediaSources.push(media);
    return media;
  };
  const createObjectURL = () => {
    created++;
    const url='blob:synthetic-progressive-'+created;
    video.onLoad = ()=>setImmediate(()=>{
      const m=mediaSources.at(-1);m.readyState='open';m.emit('sourceopen');
    });
    return url;
  };
  video.load = () => video.onLoad?.();
  const revokeObjectURL = url => revoked.push(url);
  return {mediaSources,revoked,createMediaSource,createObjectURL,revokeObjectURL};
}

test('RED: standalone bounded verified fMP4 GOP loads independent MSE with correct movie time offset', async () => {
  const video=fakeVideo();
  const media=fakeStandaloneMedia(video,{start:0,end:10});
  const seekWindow=segment('s10',10,20,{bytes:4096});
  const loader=createStandaloneProgressiveMseLoader({
    video,requestWindow:async({segment})=>verifiedWindow(segment),
    ...media,
  });
  const {controller}=runner({video,loadWindow:loader,timeoutMs:400});
  const task=controller.seek(report([seekWindow]),12);
  for(let i=0;i<10&&!video.pendingFrames;i++) await flush();
  assert.equal(video.currentTime,12, 'MSE window must use absolute movie clock');
  assert.equal(media.mediaSources.length,1);
  assert.equal(media.mediaSources[0].buffer.timestampOffset,10);
  assert.equal(media.mediaSources[0].duration,96);
  assert.equal(video.src,'blob:synthetic-progressive-1');
  video.deliver(12.01);
  assert.equal((await task).ok,true);
  assert.equal(media.revoked.length,0,'committed media must remain alive while playing');
  controller.close();
  assert.deepEqual(media.revoked,['blob:synthetic-progressive-1']);
});

test('RED: standalone absolute-timestamp GOP uses zero offset; rejects unverified or corrupt bytes before source swap', async () => {
  const video=fakeVideo();
  const media=fakeStandaloneMedia(video,{start:10,end:20});
  const ready=report([segment('s10',10,20,{bytes:4096})]);
  const invalid=[
    {complete:false}, {verified:false}, {initVerified:false},
    {audioIndex:1}, {generation:4}, {segmentId:'different'},
    {contentType:'video/mp4; codecs="hvc1.1.6.L93.B0"'},
    {bytes:new Uint8Array(20)}, {bytes:new Uint8Array(70*1024*1024)},
  ];
  for(const override of invalid) {
    const loader=createStandaloneProgressiveMseLoader({
      video,requestWindow:async({segment})=>verifiedWindow(segment,override),...media,
    });
    const task=await runner({video,loadWindow:loader}).controller.seek(ready,12);
    assert.equal(task.ok,false,JSON.stringify(Object.keys(override)));
    assert.equal(video.src,'blob:alpha-current');
    loader.close();
  }
  const loader=createStandaloneProgressiveMseLoader({
    video,requestWindow:async({segment})=>verifiedWindow(segment,{mediaStartSeconds:10}),...media,
  });
  const {controller}=runner({video,loadWindow:loader});
  const task=controller.seek(ready,12);
  for(let i=0;i<10&&!video.pendingFrames;i++) await flush();
  assert.equal(media.mediaSources.at(-1).buffer.timestampOffset,0);
  video.deliver(12);
  assert.equal((await task).ok,true);
  controller.close();
});

test('RED: standalone loader abort before MSE attach, stale source/window never installs', async () => {
  const video=fakeVideo(); const media=fakeStandaloneMedia(video);
  let release;
  const pendingFetch=new Promise(resolve=>{release=resolve;});
  const loader=createStandaloneProgressiveMseLoader({
    video,requestWindow:async()=>pendingFetch,...media,
  });
  const {controller}=runner({video,loadWindow:loader,timeoutMs:40});
  const result=controller.seek(report([segment('a',10,20,{bytes:4096})]),12);
  assert.equal((await result).ok,false);
  release(verifiedWindow(segment('a',10,20)));
  await flush();
  assert.equal(video.src,'blob:alpha-current');
  assert.equal(media.mediaSources.length,0);
  loader.close();
});

test('RED: a source/audio change during verified-window GET must not even attach stale MSE', async () => {
  const video=fakeVideo(); const media=fakeStandaloneMedia(video);
  let release; const response=new Promise(resolve=>{release=resolve;});
  const current={...identity};
  const loader=createStandaloneProgressiveMseLoader({
    video,requestWindow:async()=>response,...media,
  });
  const {controller}=runner({video,getContext:()=>({...current}),loadWindow:loader});
  const pending=controller.seek(report([segment('a',10,20,{bytes:4096})]),12);
  await flush();
  current.generation++;
  current.audioMode='stereo';
  release(verifiedWindow(segment('a',10,20,{bytes:4096})));
  assert.equal((await pending).ok,false);
  assert.equal(media.mediaSources.length,0,'stale section may not replace current media');
  assert.equal(video.src,'blob:alpha-current');
  loader.close();
});
