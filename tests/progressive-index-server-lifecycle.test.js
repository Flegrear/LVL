/**
 * Private alpha-dev contract tests. Never imports server.js (it would start a
 * live torrent server); extracts only serveProgressiveSeek into an isolated VM.
 * Never connects to 5000/5013, touches a user torrent, or runs real media.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createProgressiveIndexCache, progressiveIndexEligibility }
  from '../backend/media/progressive-index-cache.js';

const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const begin = source.indexOf('async function serveProgressiveSeek(');
const end = source.indexOf('\nfunction streamTorrentFile(', begin);
assert.ok(begin > 0 && end > begin, 'real production route must be isolated, never reimplemented');
const routeBody = source.slice(begin, end);
const SESSION = 'cebf75e5-96b4-4dc1-8fd8-abc1035f2b54';
const HASH = '8'.repeat(40);
const DIGEST = 'b'.repeat(64);
const ID = 'c'.repeat(64);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function liveSource(bytes = 8192) {
  return { session: {
    id: SESSION, infoHash: HASH, torrent: {
      pieceLength: 8192, bitfield: { get: () => true },
      files: [{ name: 'Synthetic.mkv', path: 'Synthetic.mkv', offset: 0,
        length: bytes, downloaded: bytes, done: true }],
    },
  }, fileIndex: 0, media: {durationSeconds: 8,
    video: {codec:'h264',profile:'High',pixelFormat:'yuv420p',bitDepth:8,
      width:160,height:90,colorPrimaries:'bt709',colorTransfer:'bt709',colorSpace:'bt709'},
    audioTracks:[{codec:'aac',channels:2}]},audioIndex:0,audioMode:'auto' };
}

function harness({ initialStatus='partial', ranges = [], includeReader=false, busy=false }={}) {
  const p=liveSource();
  const session=p.session;
  const sessions=new Map([[SESSION, session]]);
  const log={starts:[],statusCalls:0,opens:0,releases:0,sourceStreams:0};
  let state=initialStatus, enabled=true;
  const bytes=Buffer.from('synthetic-verified-fmp4-window');
  const cache={
    status:async params=>{
      log.statusCalls++;
      return {status:state,ranges,readyRanges:ranges,complete:state==='ready',identityKey:DIGEST};
    },
    async start(params){log.starts.push(params); if(busy)await new Promise(()=>{});},
    async open(_params,id){
      log.opens++;
      if(!includeReader||id!==ID)return null;
      return {bytes:bytes.length,start:1,end:2,handle:{
        createReadStream({autoClose}){
          assert.equal(autoClose,false);
          log.sourceStreams++;return Readable.from([bytes]);
        }},async release(){log.releases++;}};
    },
  };
  const context=vm.createContext({path,VIDEO_EXTENSIONS:new Set(['.mkv']),
    torrentRoot:path.join(os.tmpdir(),'isolated-never-requests-ports'),
    torrentSessions:sessions,
    storage:{limits:()=>({remuxCacheEnabled:enabled})},
    progressiveIndexCache:cache,
    startProgressiveWhenNewPieces(params,status){
      if(status.status==='waiting')void cache.start(params);
    },
    getCachedMediaProbe:()=>p.media,
    safeTorrentRelativePath:relative=>!!relative&&!relative.includes('..')&&!path.isAbsolute(relative),
    localVerifiedTorrentInputPath:(session,index)=>path.join(os.tmpdir(),'isolated-never-requests-ports',session.id,session.torrent.files[index].path),
    isTorrentFileFullyVerified:()=>true,trackOpenStream(){},pipeline,
    json(res,code,body,headers={}){
      res.writeHead(code,{'Content-Type':'application/json',...headers});
      res.end(JSON.stringify(body));
    },
  });
  vm.runInContext(routeBody,context,{timeout:500});
  const route=vm.runInContext('serveProgressiveSeek',context);
  async function request({action='status',method='GET',generation=1}={}){
    const suffix=action==='status'?'status':'window/'+ID;
    const url=new URL(`http://localhost/api/torrents/${SESSION}/files/0/progressive/${suffix}`);
    url.searchParams.set('generation',String(generation));
    const req=Object.assign(new EventEmitter(),{method,aborted:false,headers:{}});
    const res=new PassThrough();
    const output=[];
    res.on('data',chunk=>output.push(Buffer.from(chunk)));
    res.status=null;
    res.writeHead=(status,headers)=>{res.status=status;res.headers=headers;return res;};
    await route(req,res,session,0,url,action==='status');
    return {status:res.status,headers:res.headers,
      body:Buffer.concat(output),json:()=>JSON.parse(Buffer.concat(output).toString())};
  }
  return {cache,log,request,setStatus(value){state=value;},setEnabled(value){enabled=value;},
    sessions,session};
}

test('live route HEAD does not spawn workers; a completed GOP is pinned and released on GET',async()=>{
  const f=harness({initialStatus:'ready',ranges:[{id:ID,start:1,end:2,
    videoCodecString:'avc1.640028',initHash:DIGEST,bytes:29}],includeReader:true});
  const head=await f.request({method:'HEAD'});
  assert.equal(head.status,200);
  assert.equal(f.log.starts.length,0);
  assert.equal(f.log.opens,0);
  const window=await f.request({action:'window'});
  assert.equal(window.status,200);
  assert.equal(window.headers['Accept-Ranges'],'none');
  assert.ok(window.body.toString().includes('synthetic-verified-fmp4'));
  assert.equal(f.log.opens,1);
  assert.equal(f.log.releases,1);
  assert.equal(f.log.sourceStreams,1);
});

test('status never fetches media or sends partial HTTP Range and reports plan-bound decoded data',async()=>{
  const f=harness({initialStatus:'building',ranges:[{id:ID,start:1,end:2,
    videoCodecString:'avc1.640028',initHash:DIGEST,bytes:4096}]});
  const status=await f.request();
  assert.equal(status.status,200);
  assert.equal(status.json().status,'partial-ready');
  assert.equal(status.json().segments[0].keyframeStart,true);
  assert.equal(status.json().mime,'video/mp4; codecs="avc1.640028, mp4a.40.2"');
  assert.equal(f.log.sourceStreams,0);
  assert.equal(f.log.starts.length,0,'already-building must not double-spawn');
});

test('background FFmpeg slot wires the same Set for start/close and foreground only preempts on limit',()=>{
  const serverSource=source;
  assert.match(serverSource,/const progressiveIndexCache = createProgressiveIndexCache\(\{/);
  assert.match(serverSource,/foregroundBusy: \(\) => activeForegroundTranscodeCount\(\) >= MAX_TRANSCODE_JOBS/);
  assert.match(serverSource,/const activeForegroundTranscodeCount = \(\) => Math\.max\(0,activeTranscodes\.size/);
  assert.match(serverSource,/onSpawn: child => \{ activeTranscodes\.add\(child\); progressiveActiveProcesses\.add\(child\); \}/);
  assert.match(serverSource,/if \(child\) \{ activeTranscodes\.delete\(child\); progressiveActiveProcesses\.delete\(child\); \}/);
  assert.match(serverSource,/if \(activeTranscodes\.size >= MAX_TRANSCODE_JOBS\) \{\s*await progressiveIndexCache\.stopAll\(\);/);
  assert.match(serverSource,/function localVerifiedTorrentInputPath\(session, fileIndex\)/);
  assert.match(serverSource,/inputPath=localVerifiedTorrentInputPath\(session,fileIndex\)/);
});

test('polling a canceled partial 120 times never restarts the complete FFmpeg conversion',
  async()=>{
    const f=harness({initialStatus:'partial',ranges:[{id:ID,start:1,end:2,
      videoCodecString:'avc1.640028',bytes:4096}]});
    for(let i=0;i<120;i++)await f.request({generation:i+1});
    assert.equal(f.log.starts.length,0,
      'idle incomplete source should not repeatedly encode from episode start on every poll');
  });

test('frontend dispatches progressive discovery before full-episode indexed discovery',()=>{
    const a=app.indexOf('function updateCompatControls()');
    const body=app.slice(a,app.indexOf('const currentMs',a));
    assert.ok(body.indexOf('checkProgressiveSeekCache()')<body.indexOf('checkIndexedSeekCache()'));
  });

test('backend reserves the last slot for progressive before whole-index kickoff',()=>{
    const indexedStart=source.indexOf('async function serveIndexedSeek(');
    const progressiveStart=source.indexOf('async function serveProgressiveSeek(',indexedStart);
    assert.ok(indexedStart>0&&progressiveStart>indexedStart);
    const fullRoute=source.slice(indexedStart,progressiveStart);
    // Source ordering in app.js cannot guarantee HTTP arrival/async disk
    // admission order. The full-index handler must consult a global
    // progressive-priority gate before it starts background FFmpeg.
    assert.equal(/progressiveIndexCache\.(?:status|isEligible|hasPriority|stopAll)/.test(fullRoute),true,
      'whole-file indexed kickoff lacks a backend progressive-priority admission gate');
  });

test('persisted same-size MP4 corruption is rejected both cold and after memoized successful validation',
  async t=>{
    const root=await mkdtemp(path.join(os.tmpdir(),'lvl-prog-lifecycle-integrity-'));
    t.after(()=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
    const p=liveSource(8192),info=progressiveIndexEligibility({...p,enabled:true});
    assert.equal(info.eligible,true);
    const dir=path.join(root,SESSION,'progressive-index',info.key);
    await mkdir(dir,{recursive:true});
    const segmentId=crypto.createHash('sha256').update(info.key+':0').digest('hex');
    const outfile=path.join(dir,segmentId+'.mp4');
    const original=Buffer.alloc(4096,0x44); // Isolated cache-digest fixture, never served to real player.
    await writeFile(outfile,original);
    await writeFile(path.join(dir,'index.json'),JSON.stringify({
      identity:info.identity,complete:true,
      ranges:[{id:segmentId,sequence:0,start:0,end:7.9,mediaStart:0,
        baseSeconds:0,seekOffsetSeconds:0,initHash:DIGEST,
        videoCodecString:'avc1.640028',bytes:original.length,
        contentSha256:crypto.createHash('sha256').update(original).digest('hex'),
        videoCodec:'h264',audioCodec:'aac',container:'fmp4',
        sourceVerified:true,initVerified:true,independentlyDecodable:true,
        keyframeStart:true,movieClockVerified:true}],
    }));
    const cache=createProgressiveIndexCache({sessionsRoot:root,enabled:()=>true,
      isCurrent:()=>true,ffmpegPath:'unused-ffmpeg',ffprobePath:'unused-ffprobe'});
    const initial=await cache.status(p);
    assert.equal(initial.ranges.length,1,'first content digest is memoized with the exact file stat');
    await writeFile(outfile,Buffer.alloc(4096,0x7f)); // Size unchanged, content and mtime changed.
    const status=await cache.status(p);
    assert.equal(status.ranges.length,0,'same-size corrupt media must not be advertised');
    assert.equal(await cache.open(p,segmentId),null,'corrupt segment cannot be leased');
    const reloaded=createProgressiveIndexCache({sessionsRoot:root,enabled:()=>true,
      isCurrent:()=>true,ffmpegPath:'unused-ffmpeg',ffprobePath:'unused-ffprobe'});
    assert.equal((await reloaded.status(p)).ranges.length,0,
      'cold process restart cannot trust old manifest after same-size file corruption');
  });

test('bound stalled background FFmpeg wall-clock and release its true child-close slot',
  async t=>{
    const root=await mkdtemp(path.join(os.tmpdir(),'lvl-prog-lifecycle-idle-'));
    t.after(()=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
    const p=liveSource();
    await mkdir(path.join(root,SESSION),{recursive:true});
    const input=path.join(root,SESSION,'Synthetic.mkv');
    await writeFile(input,Buffer.alloc(8192));
    let child;
    let notifySpawn;
    const spawned=new Promise(resolve=>{notifySpawn=resolve;});
    const spawn=()=>{
      child=new EventEmitter();
      child.stdout=new PassThrough();child.stderr=new PassThrough();
      child.exitCode=null;child.kill=()=>{
        child.exitCode=1;child.stdout.end();child.stderr.end();
        queueMicrotask(()=>child.emit('close',1));return true;};
      notifySpawn();
      return child;
    };
    let closed=0;
    const cache=createProgressiveIndexCache({sessionsRoot:root,enabled:()=>true,
      allowance:async()=>({allowed:true}),isCurrent:()=>true,
      ffmpegPath:'fake-ffmpeg',ffprobePath:'fake-ffprobe',spawn,
      onClose:()=>closed++,maxWallMs:750});
    const active=cache.start({...p,inputPath:input});
    try{
      // Under parallel FFmpeg/SQLite tests, 60ms from initial async admission
      // can elapse BEFORE spawn. Verify the child actually started, then test
      // wall-clock cancellation and close-only slot release.
      const began=await Promise.race([spawned.then(()=>true),sleep(3500).then(()=>false)]);
      assert.equal(began,true,'fixture must actually spawn a background FFmpeg');
      const completed=await Promise.race([active.then(()=>true),sleep(4000).then(()=>false)]);
      assert.equal(completed,true,'stalled background process must be aborted by maxWallMs');
      assert.equal(closed,1);
    }finally{await cache.stopAll();await active;}
  });

test('24-minute synthetic index enumerates many disjoint ready windows without a live media reader',
  {timeout:20000},async t=>{
    const root=await mkdtemp(path.join(os.tmpdir(),'lvl-prog-lifecycle-long-'));
    t.after(()=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
    const p=liveSource(8192);
    p.media.durationSeconds=1440;
    const info=progressiveIndexEligibility({...p,enabled:true});
    assert.equal(info.eligible,true);
    const dir=path.join(root,SESSION,'progressive-index',info.key);
    await mkdir(dir,{recursive:true});
    const windows=[];
    const media=Buffer.alloc(4096,0x37);
    const contentSha256=crypto.createHash('sha256').update(media).digest('hex');
    for(let i=0;i<180;i++){
      const id=crypto.createHash('sha256').update(info.key+':'+i).digest('hex');
      const start=i*8;
      windows.push({id,sequence:i,start,end:start+7.8,mediaStart:start,
        baseSeconds:0,seekOffsetSeconds:0,initHash:DIGEST,contentSha256,
        videoCodecString:'avc1.640028',videoCodec:'h264',audioCodec:'aac',
        container:'fmp4',bytes:media.length,sourceVerified:true,initVerified:true,
        independentlyDecodable:true,keyframeStart:true,movieClockVerified:true});
      await writeFile(path.join(dir,id+'.mp4'),media);
    }
    await writeFile(path.join(dir,'index.json'),JSON.stringify({
      identity:info.identity,ranges:windows,complete:false}));
    const cache=createProgressiveIndexCache({sessionsRoot:root,enabled:()=>true,
      isCurrent:()=>true,ffmpegPath:'unused-ffmpeg',ffprobePath:'unused-ffprobe'});
    for(let i=0;i<2;i++){
      const status=await cache.status(p);
      assert.equal(status.status,'partial');
      assert.equal(status.ranges.length,180);
      assert.equal(status.complete,false);
      assert.equal(status.ranges.at(-1).start,1432);
    }
    const pin=await cache.open(p,windows.at(-1).id);
    assert.ok(pin&&pin.handle,'the last GOP is pinned directly without scanning/warming the episode');
    await pin.release();
    await writeFile(path.join(dir,windows[91].id+'.mp4'),Buffer.alloc(4096,0x73));
    assert.equal((await cache.status(p)).ranges.length,0,
      'a corrupted interior GOP must not leave phantom ready ranges');
  });
