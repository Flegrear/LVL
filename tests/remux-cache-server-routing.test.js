import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { EventEmitter, once } from 'node:events';
import { createTranscodePlan, transcodeVideoFilter } from '../shared/media/media-compat.js';
import { pruneExitedTranscodes } from '../backend/media/transcode-slot-lifecycle.js';

const source=readFileSync(new URL('../server.js',import.meta.url),'utf8');
const start=source.indexOf('async function transcodeTorrentFile(');
const end=source.indexOf('\nfunction boundedInteger(',start);
assert.ok(start>0&&end>start,'exercise the actual backend remux handler');

function fixture({hit=true,cacheEnabled=true,deferLookup=false,holdFfmpeg=false,maxJobs=2}={}){
  const root=mkdtempSync(path.join(os.tmpdir(),'lvl-private-remux-route-'));
  const file=path.join(root,'verified-complete.mp4');
  const bytes=Buffer.from('safe-fixture-cache-hit');
  writeFileSync(file,bytes);
  const media={durationSeconds:10,video:{codec:'h264',height:240},
    audioTracks:[{codec:'ac3',channels:2},{codec:'ac3',channels:2}]};
  const session={
    id:'de178568-edcb-47fb-85f1-e6ee11fa1b33',infoHash:'f00d0123456789abcdef0123456789abcdef0123',
    torrent:{files:[{name:'two-track.mkv',length:100000}]},
  };
  const torrentSessions=new Map([[session.id,session]]);
  const calls={spawn:0,reads:0,recorders:0,opened:0,identity:null,released:0,kills:0,children:[]};
  const pendingLookups = [];
  const cache={
    async openComplete(identity){
      calls.reads++;calls.identity=identity;
      if(deferLookup) await new Promise(resolve=>{pendingLookups.push(resolve);});
      if(!hit)return null;
      const handle=await fs.promises.open(file,'r');
      return {handle,bytes:bytes.length,async release(){calls.released++;await handle.close();}};
    },
    begin(){calls.recorders++;return null;},
  };
  const ctx=vm.createContext({
    path,fs,pipeline,Number,String,Set,AbortController,setTimeout,clearTimeout,port:5000,
    MAX_TORRENT_VIDEO_BYTES:20*1024**3,MAX_TRANSCODE_JOBS:maxJobs,
    VIDEO_EXTENSIONS:new Set(['.mkv','.mp4']),
    rejectOversizeVideo:()=>false,ffmpegPath:'mock-ffmpeg',
    createTranscodePlan,transcodeVideoFilter,
    getCachedMediaProbe:()=>media,probeTorrentFile:async()=>media,
    copiedSeekOrigin:async(_session,_file,start)=>({
      verified:true,requestedStartSeconds:start,effectiveStartSeconds:4}),
    videoTranscodeEncoder:async()=> 'libx264',hardwareVideoEncodingArgs:()=>['-c:v','libx264'],
    remuxSegmentCache:cache,activeTranscodes:new Set(),pruneExitedTranscodes,failedHardwareEncoder:null,torrentSessions,
    scheduleSessionExpiry(){},trackOpenStream(){calls.opened++;},
    SPEECH_SAMPLE_RATE:16000,
    speechTapeWriter(){return{push(){},end(){}};},
    spawn(){
      calls.spawn++;
      const process=new EventEmitter();
      process.killed=false;
      process.kill=()=>{calls.kills++;process.killed=true;return true;};
      process.stdout=holdFfmpeg ? new PassThrough()
        : Object.assign(new EventEmitter(),{pipe(res){res.write(Buffer.from('fresh'));res.end();}});
      process.stderr=new EventEmitter();
      process.stdio=[null,process.stdout,process.stderr,null];
      calls.children.push(process);
      return process;
    },
    json(res,status,body){res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));},
  });
  vm.runInContext(source.slice(start,end),ctx);
  function beginRequest(startSeconds=5.37,audio=1){
    const req=Object.assign(new EventEmitter(),{method:'GET',headers:{}});
    const res=new PassThrough();
    res.status=0;res.headers={};res.headersSent=false;
    res.writeHead=(status,headers)=>{res.status=status;res.headers=headers;res.headersSent=true;};
    res.flushHeaders=()=>{};
    const received=[];
    res.on('data',data=>received.push(Buffer.from(data)));
    const url=new URL(`http://localhost/api/torrents/${session.id}/files/0/transcode?start=${startSeconds}&video=copy&audio=${audio}`);
    const started=vm.runInContext('transcodeTorrentFile',ctx)(req,res,session,0,url);
    return {req,res,started,body:()=>Buffer.concat(received)};
  }
  async function waitForLookups(count=1){
    for(let n=0;n<50&&pendingLookups.length<count;n++)await new Promise(resolve=>setImmediate(resolve));
    assert.ok(pendingLookups.length>=count,`expected ${count} deferred cache lookups`);
  }
  function resolveLookups(count=1){
    assert.ok(pendingLookups.length>=count,'must only release outstanding cache lookups');
    for(let i=0;i<count;i++)pendingLookups.shift()();
  }
  async function request(startSeconds=5.37,audio=1,{abortDuringLookup=false,retireDuringLookup=false}={}){
    const pending=beginRequest(startSeconds,audio);
    const {req,res,started}=pending;
    const ended=abortDuringLookup?null:once(res,'end');
    if(abortDuringLookup||retireDuringLookup){
      assert.ok(deferLookup,'cache race test must control the asynchronous lookup');
      await waitForLookups();
      if(abortDuringLookup){req.aborted=true;res.destroy();}
      if(retireDuringLookup)torrentSessions.delete(session.id);
      resolveLookups();
    }
    await started;
    if(ended)await ended;
    await new Promise(resolve=>setImmediate(resolve));
    return {res,body:pending.body()};
  }
  return {request,beginRequest,waitForLookups,resolveLookups,calls,bytes,cache,
    activeTranscodes:ctx.activeTranscodes,cleanup(){rmSync(root,{recursive:true,force:true});}};
}

test('identical, complete cached remux replays on existing /transcode route without FFmpeg or audio-track alteration',async(t)=>{
  const f=fixture();t.after(f.cleanup);
  const {res,body}=await f.request();
  assert.equal(res.status,200);
  assert.deepEqual(body,f.bytes);
  assert.equal(f.calls.spawn,0);
  assert.equal(f.calls.reads,1);
  assert.equal(f.calls.recorders,0);
  assert.equal(f.calls.opened,1);
  assert.equal(f.calls.released,1,'completed cached reader closes its lease');
  assert.equal(res.headers['X-LVL-Remux-Cache'],'complete-hit');
  assert.equal(res.headers['X-Media-Start-Seconds'],'5.37');
  assert.equal(res.headers['X-Media-Effective-Start-Seconds'],'4');
  assert.equal(res.headers['X-Audio-Track-Index'],'1');
  assert.equal(res.headers['Content-Length'],String(f.bytes.length));
  assert.equal(f.calls.identity.audioTrack,1);
  assert.equal(f.calls.identity.effectiveStartSeconds,4);
});

test('missing or incompatible cached window falls back to original FFmpeg path, without promising a cache hit',async(t)=>{
  const f=fixture({hit:false});t.after(f.cleanup);
  const {res,body}=await f.request(6.23,0);
  assert.equal(res.status,200);
  assert.equal(body.toString(),'fresh');
  assert.equal(f.calls.spawn,1);
  assert.equal(res.headers['X-LVL-Remux-Cache'],undefined);
  assert.equal(res.headers['X-Audio-Track-Index'],'0');
});

test('client abort during a delayed cache MISS never launches a detached FFmpeg conversion',async(t)=>{
  const f=fixture({hit:false,deferLookup:true});t.after(f.cleanup);
  await f.request(10,0,{abortDuringLookup:true});
  assert.equal(f.calls.reads,1);
  assert.equal(f.calls.spawn,0,'closed browser request must not occupy an FFmpeg job slot');
  assert.equal(f.calls.recorders,0,'orphan request must not start an optional recording');
});

test('replaced torrent session during a delayed cache MISS returns HTTP 410 without an orphan transcode',async(t)=>{
  const f=fixture({hit:false,deferLookup:true});t.after(f.cleanup);
  const {res}=await f.request(10,0,{retireDuringLookup:true});
  assert.equal(res.status,410);
  assert.equal(f.calls.spawn,0);
  assert.equal(f.calls.opened,0);
});

test('two simultaneous cancelled cache misses leave both FFmpeg slots free for the next seek',async(t)=>{
  const f=fixture({hit:false,deferLookup:true});t.after(f.cleanup);
  const a=f.beginRequest(10,0);
  const b=f.beginRequest(25,0);
  await f.waitForLookups(2);
  for(const pending of [a,b]){pending.req.aborted=true;pending.res.destroy();}
  f.resolveLookups(2);
  await Promise.all([a.started,b.started]);
  assert.equal(f.calls.spawn,0,'neither cancelled request starts FFmpeg after the cache MISS');
  assert.equal(f.calls.opened,0,'neither disconnected response acquires a stream');
  assert.equal(f.activeTranscodes.size,0,'both scarce conversion slots remain free');
  const third=f.request(85,0);
  await f.waitForLookups();
  f.resolveLookups();
  const {res,body}=await third;
  assert.equal(res.status,200,'the live seek is admitted instead of HTTP 429');
  assert.equal(body.toString(),'fresh');
  assert.equal(f.calls.spawn,1);
});

test('cancelled deferred cache HIT releases its reader lease without opening a stream',async(t)=>{
  const f=fixture({hit:true,deferLookup:true});t.after(f.cleanup);
  await f.request(10,0,{abortDuringLookup:true});
  assert.equal(f.calls.released,1,'a cache hit returned after disconnect must release its handle');
  assert.equal(f.calls.opened,0);
  assert.equal(f.calls.spawn,0);
});

test('cancelled running FFmpeg holds its slot until child close, then next request is admitted',async(t)=>{
  const f=fixture({hit:false,holdFfmpeg:true,maxJobs:1});t.after(f.cleanup);
  const first=f.beginRequest(10,0);
  await first.started;
  assert.equal(f.activeTranscodes.size,1);
  first.res.destroy();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.calls.kills,1,'response close requests FFmpeg termination');
  assert.equal(f.activeTranscodes.size,1,'kill request is not a child close event');
  const blocked=f.beginRequest(25,0);
  await blocked.started;
  assert.equal(blocked.res.status,429,'do not over-admit until first child exits');
  f.calls.children[0].emit('close',1);
  assert.equal(f.activeTranscodes.size,0,'actual close releases the slot');
  const next=f.beginRequest(85,0);
  await next.started;
  assert.equal(next.res.status,200);
  assert.equal(f.calls.spawn,2);
  next.res.destroy();
  f.calls.children[1].emit('close',1);
});

test('FFmpeg error alone does not free a still-closing child slot',async(t)=>{
  const f=fixture({hit:false,holdFfmpeg:true,maxJobs:1});t.after(f.cleanup);
  const first=f.beginRequest(10,0);
  await first.started;
  assert.equal(f.activeTranscodes.size,1);
  f.calls.children[0].emit('error',new Error('synthetic spawn error'));
  assert.equal(f.activeTranscodes.size,1,'error may precede child close; never over-admit');
  f.calls.children[0].emit('close',1);
  assert.equal(f.activeTranscodes.size,0);
});
