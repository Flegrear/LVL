/**
 * PRIME-owned app.js progressive playback integration regression tests.
 *
 * Deliberately RED until PRIME applies the documented app.js patches:
 * no app.js/server.js/shared-helper edits from this worker. Uses VM-extracted
 * real source and deterministic fake media/network; never touches live ports,
 * torrent sessions, browsers or user media. Test failures are reproducible
 * evidence, not an instruction to weaken assertions or skip the checks.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  normalizeProgressiveSeekStatus,
  createStandaloneProgressiveMseLoader,
} from '../frontend/player/progressive-seek.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const SLICE = (begin, end, { last = false } = {}) => {
  const start = last ? app.lastIndexOf(begin) : app.indexOf(begin);
  assert.notEqual(start, -1, 'missing app.js function: ' + begin);
  const finish = app.indexOf(end, start + begin.length);
  assert.ok(finish > start, 'missing app.js boundary: ' + end);
  return app.slice(start, finish);
};
const seekSource = SLICE('function openProgressiveSeekAt(', '\nlet remuxMseWarmSeek');
const contextSource = SLICE('function progressiveSeekContext()', '\nfunction readyProgressiveWindow');
const readySource = SLICE('function readyProgressiveWindow(', '\nfunction checkProgressiveSeekCache');
const pollSource = SLICE('function checkProgressiveSeekCache()', '\nfunction renderProgressiveSeekableRanges');
const setSource = SLICE('function setMediaSource(', '\nfunction updateCompatControls');
const storageSource = SLICE('async function playerStorageLimit()', '\nfunction wireStorageSettings');
const endedSource = SLICE('video.addEventListener("ended", () => {',
  'video.addEventListener("seeking"', { last: true });
const HEX = 'a'.repeat(64);
const MIME = 'video/mp4; codecs="avc1.4D401E, mp4a.40.2"';
const flush = () => new Promise(resolve => setImmediate(resolve));
const sourceObject = () => ({kind:'torrent',libraryId:'synthetic'});

test('black-screen regression: progressive helper remains optional on still-running older static allowlists',()=>{
  assert.doesNotMatch(app,/\bfrom\s*["']\.\/frontend\/player\/progressive-seek\.js["']/,
    'A mandatory static ESM import makes ALL of LVL black when the old server returns 404');
  assert.match(app,/await import\(["']\.\/frontend\/player\/progressive-seek\.js["']\)\s*\.catch\(\(\)\s*=>\s*null\)/,
    'The new helper must fail closed without breaking the entire SPA');
  assert.match(app,/if \(!progressiveSeekAvailable\) return;/,
    'The compatibility route must not poll missing backend endpoints');
});

const sourceContext = () => ({
  sessionId:'12345678-1234-4234-8234-123456789abc',
  fileIndex:1, audioIndex:0, baseUrl:'/synthetic/transcode',
});

function makePlayerEnv({playing=true}={}) {
  let resolveSeek, rejectSeek;
  const calls = {pause:0,play:0,controllers:[],loaders:[],fallbacks:[],
    render:0,requests:[],readWindow:null};
  const video = {
    dataset:{mode:'transcode'}, paused:!playing, muted:false,
    style:{visibility:''}, readyState:4, src:'blob:original',
    pause(){this.paused=true; calls.pause++;},
    play(){this.paused=false;calls.play++;return Promise.resolve();},
    load(){},addEventListener(){},
    requestVideoFrameCallback(){return 1;},
  };
  const state = {
    transcodeContext:sourceContext(), currentSource:sourceObject(),
    mediaDurationMs:96_000, pendingSeek:null, currentMs:0,
    transcodeBaseOffsetSeconds:0,
  };
  const report = {kind:'indexed-video-segments',status:'partial-ready',
    mime:MIME,sourceKey:`torrent:${state.transcodeContext.sessionId}:1`,
    generation:10,audioIndex:0,audioMode:'auto',durationSeconds:96};
  const snapshot = {report,snapshot:{verified:true},context:state.transcodeContext,
    source:state.currentSource,generation:10,audioIndex:0,audioMode:'auto'};
  const fakeLoader = ({requestWindow}) => {
    calls.readWindow=requestWindow;
    const loader = ()=>{};
    loader.closed=0;loader.close=()=>{loader.closed++;};
    calls.loaders.push(loader);
    return loader;
  };
  const fakeController = options => {
    const controller = {
      options, closed:0, cancelled:0,
      close(){this.closed++;},
      cancel(){this.cancelled++;},
      seek(_report,_target) {
        return new Promise((resolve,reject)=>{resolveSeek=resolve;rejectSeek=reject;});
      },
    };
    calls.controllers.push(controller);
    return controller;
  };
  const context = vm.createContext({
    state,video,window:{MediaSource:{isTypeSupported:()=>true}},
    progressiveSeekReady:snapshot, progressiveSeekController:null,
    progressiveMseLoader:null,remuxMseCacheAllowed:true,
    progressiveSeekOriginalMute:null,
    progressiveContinueController:null,
    readyIndexedVideo:()=>false,openIndexedSeekAt:()=>false,
    continueProgressiveOrRecover:()=>false,
    closeProgressiveEventStream:()=>{},
    extendProgressivePlayback:()=>Promise.resolve(false),
    progressiveSeekStatusAt:0,progressiveIndexStatus:'unknown',
    progressiveTimelineKey:'',
    progressiveTimelineRangesFingerprint:'',progressiveTimelineVersion:0,
    audioOutputMode:'auto',playbackLoadRequestId:10,
    normalizeAudioMode:value=>value || 'auto',
    findProgressiveReadySegment:()=>({id:HEX,startSeconds:10,endSeconds:16,bytes:8192}),
    cancelIndexedSeekAttempt:()=>{},closeRemuxMseSession:()=>{},
    cancelTranscodeStart:()=>{},invalidateSubtitleFrameClock:()=>{},
    setPlayerLoading:()=>{},formatTime:()=>'',renderSubtitles:()=>{},
    updateCompatControls:()=>{},clearTranscodeSeekFrame:()=>{},
    loadMoreEmbeddedSubtitles:()=>{},schedulePresentedSubtitleFrame:()=>{},
    hideLoadingForBufferedSeek:()=>{},
    sourceFrameGate:null,subtitlePresentedFrame:null,
    frame:{classList:{remove:()=>{},add:()=>{}}},
    createStandaloneProgressiveMseLoader:fakeLoader,
    createProgressiveSeekController:fakeController,
    openTranscodeAt:(seconds, options)=>{calls.fallbacks.push({seconds,options});return Promise.resolve(true);},
    recoverPlayback:()=>{},fetch:async url=>{calls.requests.push(url);throw Error('Unexpected test fetch');},
    AbortSignal,Uint8Array,encodeURIComponent,
    $:()=>({hidden:false,textContent:'',classList:{remove(){},add(){}},value:'',max:''}),
    windowClear:()=>{},
    URL:{revokeObjectURL:()=>{}},
    windowClearTimer:()=>{},
    clearAutoNext:()=>{},beginRecoveryWatch:()=>{},stopRecoveryWatch:()=>{},
    drawPlayerDownloadMap:()=>{},renderProgressiveSeekableRanges:()=>{},
    revealPlayerControls:()=>{},updateChapterButtons:()=>{},
    updatePlayerPreferenceButtons:()=>{},renderSubtitleWorkspace:()=>{},
    expectNewVideoFrame:()=>{},invalidateStreamStatus:()=>{},
    setMediaSource:null,
  });
  context.window.clearTimeout=()=>{};
  vm.runInContext(contextSource + '\n' + readySource + '\n' + seekSource,context);
  return {
    calls,video,state,context,snapshot,
    open:(seconds=12,opts)=>vm.runInContext(`openProgressiveSeekAt(${seconds}, ${JSON.stringify(opts||{wasPlaying:playing})})`,context),
    resolve(value={ok:true,mediaTime:12,absoluteSeconds:12}){resolveSeek(value);},
    reject(error=new Error('Synthetic seek promise rejection')){rejectSeek(error);},
    async settle(){await flush();await flush();},
  };
}

test('RED app.js: user Pause during progressive preroll must override initial play intent',async()=>{
  const env=makePlayerEnv({playing:true});
  assert.equal(env.open(),true);
  assert.equal(env.state.pendingSeek.wasPlaying,true);
  // The real UI togglePlayback() updates this live pending flag.
  env.state.pendingSeek.wasPlaying=false;
  env.resolve();
  await env.settle();
  assert.equal(env.video.paused,true,
    'must honor latest pendingSeek.wasPlaying after rVFC, not stale captured wasPlaying');
  assert.equal(env.calls.play,0,'do not restart playback after user explicitly paused');
});

test('RED app.js: user Play during originally paused progressive seek resumes after verified frame',async()=>{
  const env=makePlayerEnv({playing:false});
  assert.equal(env.open(12,{wasPlaying:false}),true);
  env.state.pendingSeek.wasPlaying=true; // togglePlayback while pending
  env.resolve();
  await env.settle();
  assert.equal(env.video.paused,false,
    'latest pending intent must win; original wasPlaying=false is stale');
});

test('GREEN app.js: setMediaSource cancellation restores original mute for next source',async()=>{
  const env=makePlayerEnv();
  assert.equal(env.open(),true);
  assert.equal(env.video.muted,true,'only silent decoder preroll may use temporary mute');
  // Exercise real cancellation function, not just mutating state directly.
  vm.runInContext(setSource,env.context);
  env.state.currentSource=sourceObject();
  vm.runInContext(`setMediaSource({src:'blob:next',title:'Next',status:'',mode:'local',durationMs:30000})`,
    env.context);
  env.resolve({ok:false,reason:'stale-source'});
  await env.settle();
  assert.equal(env.video.muted,false,
    'source cancellation must restore temporary preroll mute before next media');
  assert.equal(env.calls.fallbacks.length,0,'stale session must never start fallback');
  assert.equal(env.calls.controllers[0].cancelled,1);
  assert.equal(env.calls.loaders[0].closed,1);
});

test('RED app.js: superseding progressive seek while muted must preserve original user mute intent',async()=>{
  const env=makePlayerEnv({playing:true});
  assert.equal(env.open(12),true);
  assert.equal(env.video.muted,true,'first seek temporarily mutes decoder');
  assert.equal(env.open(14),true,'second seek supersedes first verified-window request');
  assert.equal(env.calls.controllers[0].closed,1);
  env.resolve({ok:true,mediaTime:14,absoluteSeconds:14});
  await env.settle();
  assert.equal(env.state.pendingSeek,null);
  assert.equal(env.video.muted,false,
    'second seek must inherit FIRST preroll original mute, not temporary muted=true');
});

test('RED app.js: rejected progressive seek promise disposes MSE/controller before native fallback',async()=>{
  const env=makePlayerEnv();
  assert.equal(env.open(),true);
  env.reject();
  await env.settle();
  assert.equal(env.calls.fallbacks.length,1,'fallback remains bounded and current-only');
  assert.equal(env.calls.controllers[0].closed,1,'controller needs closing, even for rejection');
  assert.equal(env.calls.loaders[0].closed,1,'retained MSE blob needs revocation before fallback');
  assert.equal(env.context.progressiveSeekController,null,
    'old controller must not retain stale source');
});

test('RED app.js: short progressive GOP ending during frame-gate must not emit terminal sync error',()=>{
  let ended, terminal=0, fallback=0, paused=0;
  const video={dataset:{mode:'transcode',progressive:'1'},
    paused:false, addEventListener:(name,fn)=>{if(name==='ended') ended=fn;},
    pause:()=>{paused++;}};
  const state={pendingSeek:{target:11,wasPlaying:true,priming:true,streamInstalled:true},
    mediaDurationMs:96_000};
  const ctx=vm.createContext({
    state,video,transcodeStartAttempt:null,
    cancelTranscodeStart:()=>{},setPlayerLoading:()=>{terminal++;},
    absolutePlaybackSeconds:()=>13,
    restartTranscodeAt:()=>{fallback++;return Promise.resolve(true);},
    openTranscodeAt:(position,options)=>{
      assert.equal(position,11,'fallback must seek the intended requested frame');
      assert.equal(options?.forceNative,true);
      fallback++;return Promise.resolve(true);
    },
    isNewSourceFramePending:()=>false,stopRecoveryWatch:()=>{},
    recordWatchProgress:()=>{},startAutoNext:()=>{},
    fallbackActiveRemuxMseToNative:()=>false,recoverPlayback:()=>{},
  });
  vm.runInContext(endedSource,ctx);
  assert.equal(typeof ended,'function');
  ended();
  assert.equal(terminal,0,
    'a standalone GOP EOF while priming is expected window boundary, not Video synchronization unavailable');
  assert.equal(fallback,1,'should recover from this GOP boundary instead of trapping the loader');
});

test('RED full 58-minute episode: backend 1700 verified GOPs must not erase every bright range',()=>{
  const duration=3600;
  const context={sourceKey:'torrent:synthetic',generation:9,audioIndex:0,
    audioMode:'auto',durationSeconds:duration};
  const segments=Array.from({length:1700},(_,i)=>({
    id:'section'+i,startSeconds:i*2,endSeconds:i*2+2,
    mediaStartSeconds:i*2,bytes:16_384,
    complete:true,verified:true,independentlyDecodable:true,
    keyframeStart:true,movieClockVerified:true,
  }));
  const snapshot=normalizeProgressiveSeekStatus({
    ...context,kind:'indexed-video-segments',status:'partial-ready',
    videoCodec:'h264',audioCodec:'aac',container:'fmp4',mime:MIME,
    initVerified:true,sourceVerified:true,segments,
  },context);
  assert.ok(snapshot,'backend allows 7200 committed sections; UI must not silently discard all after 1024');
  assert.ok(snapshot.ranges.length>0);
});

test('RED app.js: pending progressive status poll must not install stale source after source replacement',async()=>{
  let completeFetch;
  const oldSource=sourceObject(), oldContext=sourceContext();
  const state={transcodeContext:oldContext,currentSource:oldSource,mediaDurationMs:96_000};
  const video={dataset:{mode:'transcode'}};
  const ctx=vm.createContext({
    state,video,playbackLoadRequestId:10,audioOutputMode:'auto',
    remuxMseCacheAllowed:true,progressiveSeekAvailable:true,
    progressiveSeekStatusPending:false,
    progressiveSeekStatusAt:0,progressiveSeekReady:null,
    progressiveRefreshAfterPending:false,
    progressiveEventStream:null,
    progressiveIndexStatus:'unknown',normalizeAudioMode:value=>value||'auto',
    normalizeProgressiveSeekStatus:()=>({ranges:[]}),
    renderProgressiveSeekableRanges:()=>{},
    fetchJson:()=>new Promise(resolve=>{completeFetch=resolve;}),
    AbortSignal,Date,encodeURIComponent,
  });
  vm.runInContext(contextSource+'\n'+pollSource,ctx);
  vm.runInContext('checkProgressiveSeekCache()',ctx);
  assert.equal(typeof completeFetch,'function');
  state.currentSource=sourceObject();state.transcodeContext=sourceContext();
  completeFetch({kind:'indexed-video-segments',status:'partial-ready'});
  await flush();
  assert.equal(ctx.progressiveSeekReady,null);
  assert.equal(ctx.progressiveIndexStatus,'unknown',
    'obsolete source response must not change readiness of newly selected source');
});

test('still-running backend without optional progressive module does not poll or crash Watch',()=>{
  const state={transcodeContext:sourceContext(),currentSource:sourceObject(),mediaDurationMs:96_000};
  const ctx=vm.createContext({state,video:{dataset:{mode:'transcode'}},
    progressiveSeekAvailable:false,remuxMseCacheAllowed:true,
    progressiveSeekStatusPending:false,progressiveSeekStatusAt:0,
    progressiveEventStream:null,Date,
    fetchJson:()=>{throw Error('Unsupported route must not be requested');}});
  vm.runInContext(pollSource+'\ncheckProgressiveSeekCache()',ctx);
  assert.equal(ctx.progressiveSeekStatusPending,false);
  assert.equal(ctx.progressiveSeekStatusAt,0);
});

test('RED Settings: absent or malformed cache-enabled response cannot authorize progressive seeking', async()=>{
  const ctx=vm.createContext({
    playerStorageLimitCache:{value:0,at:0}, remuxMseCacheAllowed:false,
    fetchJson:async()=>({limits:{playerBytes:12_000}}), Date,
  });
  vm.runInContext(storageSource,ctx);
  await vm.runInContext('playerStorageLimit()',ctx);
  assert.equal(ctx.remuxMseCacheAllowed,false,
    'an absent remuxCacheEnabled must not be treated as authenticated true');
});

test('RED seamless GOP continuation: natural EOF with verified neighboring GOP must not restart FFmpeg',()=>{
  let ended, restart=0,continuations=0;
  const video={dataset:{progressive:'1',mode:'transcode'},
    addEventListener:(name,fn)=>{if(name==='ended')ended=fn;}};
  const ctx=vm.createContext({
    state:{pendingSeek:null,mediaDurationMs:96_000},
    video,progressiveSeekReady:{snapshot:{segments:[
      {id:'gop1',startSeconds:10,endSeconds:12},
      {id:'gop2',startSeconds:12,endSeconds:14},
    ]}},
    progressiveMseLoader:{appendNext:async()=>{continuations++;return true;}},
    extendProgressivePlayback:async()=>{continuations++;return true;},
    continueProgressiveOrRecover:()=>{continuations++;return true;},
    absolutePlaybackSeconds:()=>12,
    restartTranscodeAt:()=>{restart++;return Promise.resolve(true);},
    isNewSourceFramePending:()=>false,stopRecoveryWatch:()=>{},
    recordWatchProgress:()=>{},startAutoNext:()=>{},recoverPlayback:()=>{},
  });
  vm.runInContext(endedSource,ctx);
  ended();
  assert.equal(restart,0,
    'verified adjacent GOP should append in same MSE, not cause a fresh FFmpeg every 2 seconds');
  assert.equal(continuations,1,'append exactly one next verified complete GOP');
});

const testMp4 = () => {
  const buf=new Uint8Array(4096);const view=new DataView(buf.buffer);
  let pos=0;
  for (const [name,len] of [['ftyp',12],['moov',12],['moof',12],['mdat',4060]]) {
    view.setUint32(pos,len);
    for(let i=0;i<4;i++)buf[pos+4+i]=name.charCodeAt(i);
    pos+=len;
  }
  return buf;
};
test('RED verified GOP with audio earlier than video accepts negative timestampOffset',async()=>{
  const sourceKey='torrent:synthetic',mime=MIME;
  const bytes=testMp4();
  const context={sourceKey,generation:5,audioIndex:0,audioMode:'auto',
    durationSeconds:96,mime};
  const segment={id:'verified',startSeconds:0,endSeconds:2,
    mediaStartSeconds:0.04,bytes:bytes.byteLength};
  let mse=null,attached=false;
  const emitter=()=>({
    handlers:new Map(),
    addEventListener(name,fn){this.handlers.set(name,fn);},
    removeEventListener(name){this.handlers.delete(name);},
    emit(name){this.handlers.get(name)?.();},
  });
  const video={src:'blob:old',load(){
    setImmediate(()=>{mse.readyState='open';mse.emit('sourceopen');});
  }};
  const loader=createStandaloneProgressiveMseLoader({
    video,requestWindow:async()=>({
      segmentId:segment.id,sourceKey,generation:5,audioIndex:0,audioMode:'auto',
      startSeconds:0,endSeconds:2,mediaStartSeconds:0.04,contentType:mime,
      complete:true,verified:true,initVerified:true,bytes,
    }),
    createMediaSource:()=>{
      mse=Object.assign(emitter(),{
        readyState:'closed',duration:NaN,
        addSourceBuffer(){
          attached=true;
          const buffer=Object.assign(emitter(),{
            mode:'segments',timestampOffset:0,updating:false,
            buffered:{length:1,start:()=>0,end:()=>2},
            appendBuffer(){setImmediate(()=>this.emit('updateend'));},
          });
          this.buffer=buffer;return buffer;
        },
        endOfStream(){this.readyState='ended';},
      });
      return mse;
    },
    createObjectURL:()=> 'blob:negative-offset-verified',
    revokeObjectURL:()=>{},
    timeoutMs:200,
  });
  const result=await loader({segment,targetSeconds:1,context,
    signal:new AbortController().signal});
  assert.equal(result.ready,true,
    'first video PTS +0.04 relative to first audio PTS 0 is valid, not a rejected negative offset');
  assert.equal(attached,true);
  assert.equal(mse.buffer.timestampOffset,-0.04);
  result.dispose();
  loader.close();
});
