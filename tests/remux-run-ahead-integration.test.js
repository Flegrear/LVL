import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {Writable,Readable,PassThrough} from 'node:stream';
import {once} from 'node:events';
import ffmpeg from 'ffmpeg-static';
import ffprobe from 'ffprobe-static';
import {createRemuxSegmentCache} from '../backend/media/remux-segment-cache.js';
import {pipeRemuxAhead} from '../backend/media/remux-run-ahead.js';

const sid='99f137aa-ae45-46df-97de-f2c907d1641c', gen='a'.repeat(48);
const MiB=1024*1024;
const identity={
  sessionId:sid,sourceIdentity:'synthetic-local-source',fileIndex:0,
  sourceLength:0,startSeconds:0,effectiveStartSeconds:0,remainingDuration:8,
  videoMode:'copy',videoCodec:'h264',audioCodec:'copy',audioMode:'stereo',
  audioTrack:0,audioChannels:2,
};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function syntheticSource(t,{duration=8,gop=10}={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'lvl-remux-runahead-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const movie=path.join(root,'locally-authored.mp4');
  const created=spawnSync(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-y',
    '-f','lavfi','-i',`testsrc2=size=128x72:rate=10:duration=${duration}`,
    '-f','lavfi','-i',`sine=frequency=880:sample_rate=48000:duration=${duration}`,
    '-map','0:v:0','-map','1:a:0',
    '-threads','2','-c:v','libx264','-pix_fmt','yuv420p',
    '-g',String(gop),'-keyint_min',String(gop),'-sc_threshold','0',
    '-c:a','aac','-b:a','96k','-ac','2','-f','mp4',movie],
  {windowsHide:true,timeout:45000,encoding:'utf8'});
  assert.equal(created.status,0,created.stderr||String(created.error));
  return {root,movie};
}

test('same FFmpeg producer moves ahead of blocked HTTP, retains exact recorder identity and decodes cache',
  {timeout:60000},async t=>{
    const {root,movie}=syntheticSource(t);
    const sourceIdentity={...identity,sourceLength:fs.statSync(movie).size};
    const cache=createRemuxSegmentCache({sessionsRoot:root,
      enabled:()=>true,allowance:async()=>({allowed:true,availableBytes:500*MiB})});
    const recorder=cache.begin(sourceIdentity);
    assert.ok(recorder);
    let responseBytes=0, holdFirst=null;
    const collected=[];
    const response=new Writable({highWaterMark:1,
      write(chunk,_enc,callback) {
        collected.push(Buffer.from(chunk));
        responseBytes+=chunk.length;
        if(!holdFirst) {
          holdFirst=callback;
          return;
        }
        callback();
      }});
    const verified=()=>true;
    let current=gen, killed=0;
    const ahead=pipeRemuxAhead({source:recorder.transform,response,
      sourceGeneration:gen,getCurrentGeneration:()=>current,
      isVerifiedComplete:verified,maxBufferedBytes:128*1024,maxChunkBytes:64*1024,
      onAbort:()=>{killed++;}});
    assert.equal(ahead.started,true);
    const ff=spawn(ffmpeg,['-hide_banner','-loglevel','error','-nostdin',
      '-i',movie,'-map','0:v:0','-map','0:a:0','-c:v','copy','-c:a','copy',
      '-avoid_negative_ts','make_zero',
      '-movflags','frag_keyframe+empty_moov+default_base_moof',
      '-f','mp4','pipe:1'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    const childClosed=once(ff,'close');
    const errors=[];
    ff.stderr.on('data',data=>errors.push(String(data)));
    ff.stdout.pipe(recorder.transform);
    const deadline=Date.now()+6000;
    while(!holdFirst&&Date.now()<deadline)await wait(10);
    assert.ok(holdFirst,'HTTP response must receive first bytes');
    // HTTP is blocked; the recorder has already accepted same-producer data.
    await wait(250);
    assert.ok(ahead.spool.totalAcceptedBytes>responseBytes,
      'recorder progresses independently past blocked response write');
    assert.ok(ahead.bufferedBytes<=128*1024,'spool never crosses strict byte cap');
    assert.ok(ahead.peakBufferedBytes<=128*1024,'peak spool allocation is capped');
    holdFirst();
    let deadlineTimer;
    const [result,[exit]]=await Promise.race([
      Promise.all([ahead.done,childClosed]),
      new Promise((_,reject)=>{deadlineTimer=setTimeout(()=>reject(Error(JSON.stringify({
        waiting:'bridge drain',readable:ahead.spool.readableLength,
        writable:ahead.spool.writableLength,
        queued:ahead.spool.queuedBytes,pending:ahead.spool.pending?.chunk.length,
        inputEnded:ahead.spool.inputEnded,outputEnded:ahead.spool.outputEnded,
        responseBytes,accepted:ahead.spool.totalAcceptedBytes,
        spoolDestroyed:ahead.spool.destroyed,
        recorderReadEnded:recorder.transform.readableEnded,
      }))),3000);}),
    ]);
    clearTimeout(deadlineTimer);
    assert.equal(exit,0,errors.join('').slice(-700));
    assert.equal(result.completed,true,String(result.error));
    assert.equal(killed,0);
    await recorder.finish({success:true});
    const cached=await cache.openComplete(sourceIdentity);
    assert.ok(cached,'complete exact-plan output is retained by original recorder');
    const out=path.join(root,'replayed.mp4');
    fs.writeFileSync(out,Buffer.concat(collected));
    const probe=spawnSync(ffprobe.path,['-v','error','-show_entries',
      'stream=codec_name','-of','json',out],{windowsHide:true,encoding:'utf8'});
    assert.equal(probe.status,0,probe.stderr);
    const codecs=JSON.parse(probe.stdout).streams.map(stream=>stream.codec_name);
    assert.deepEqual(codecs.sort(),['aac','h264']);
    const read=Buffer.allocUnsafe(cached.bytes);
    const {bytesRead}=await cached.handle.read(read,0,read.length,0);
    assert.equal(bytesRead,read.length);
    assert.deepEqual(read,Buffer.concat(collected),
      'one active producer/recorder persisted exactly what the HTTP client received');
    await cached.release();
    const warm=await cache.lookupWarmWindow({sessionId:sid,sourceIdentity:identity.sourceIdentity,
      fileIndex:0,producerToken:recorder.producerToken,startSeconds:3.1});
    assert.ok(warm,'verified RAP windows remain accessible by SAME response producer token');
    await warm.release();
    await cache.dropSession(sid);
  });

test('real +85s seek window is verified under SAME active token while HTTP is blocked',
  {timeout:45000},async t=>{
    const {root,movie}=syntheticSource(t,{duration:96,gop:20});
    const exact={...identity,sourceLength:fs.statSync(movie).size,remainingDuration:96};
    const cache=createRemuxSegmentCache({sessionsRoot:root,
      enabled:()=>true,allowance:async()=>({allowed:true,availableBytes:500*MiB})});
    const recorder=cache.begin(exact);
    assert.ok(recorder);
    let unblock=null,bytesToHttp=0,firstHttpBytes=0;
    const response=new Writable({highWaterMark:1,write(chunk,_enc,callback){
      bytesToHttp+=chunk.length;
      if(!unblock) {
        firstHttpBytes=bytesToHttp;
        unblock=callback;
      }else callback();
    }});
    let aborts=0;
    const ahead=pipeRemuxAhead({source:recorder.transform,response,
      sourceGeneration:gen,getCurrentGeneration:()=>gen,isVerifiedComplete:()=>true,
      maxBufferedBytes:96*MiB,onAbort:()=>aborts++});
    assert.ok(ahead.started);
    const child=spawn(ffmpeg,['-hide_banner','-loglevel','error','-nostdin',
      '-i',movie,'-map','0:v:0','-map','0:a:0','-c:v','copy','-c:a','copy',
      '-avoid_negative_ts','make_zero',
      '-movflags','frag_keyframe+empty_moov+default_base_moof',
      '-f','mp4','pipe:1'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    t.after(()=>{if(!child.killed)child.kill();});
    const childClosed=once(child,'close');
    const stderr=[];
    child.stderr.on('data',part=>stderr.push(String(part)));
    child.stdout.pipe(recorder.transform);
    let window=null;
    const deadline=Date.now()+25_000;
    while(Date.now()<deadline) {
      window=await cache.lookupWarmWindow({sessionId:sid,fileIndex:0,
        sourceIdentity:identity.sourceIdentity,producerToken:recorder.producerToken,
        startSeconds:85.2});
      if(window)break;
      await wait(25);
    }
    assert.ok(window,'+85s verified IDR RAP window must exist with HTTP still blocked');
    assert.ok(unblock,'the downstream HTTP client has a deliberately stalled write');
    assert.equal(bytesToHttp,firstHttpBytes,'HTTP has not consumed past its first write');
    assert.ok(window.windowStartSeconds<=85.2&&window.windowEndSeconds>85.2);
    assert.equal(window.producerToken,recorder.producerToken);
    assert.equal(window.sourceGeneration,recorder.producerToken,
      'source identity and active token unchanged throughout ahead recording');
    assert.ok(window.bytes<=16*MiB,'same backend warm-window quota still enforced');
    assert.ok(ahead.peakBufferedBytes<=96*MiB,'hard spool budget maintained');
    assert.ok(ahead.spool.totalAcceptedBytes>bytesToHttp,
      'recorder continues far beyond the browser HTTP backpressure');
    const preview=Buffer.alloc(window.bytes);
    let at=0;
    for(const range of window.ranges) {
      const len=range.end-range.start+1;
      const read=await window.handle.read(preview,at,len,range.start);
      assert.equal(read.bytesRead,len);
      at+=len;
    }
    await window.release();
    const warmPath=path.join(root,'verified-plus85.mp4');
    fs.writeFileSync(warmPath,preview);
    const probe=spawnSync(ffprobe.path,['-v','error','-show_entries',
      'packet=pts_time,flags','-select_streams','v:0',
      '-show_packets','-of','json',warmPath],{windowsHide:true,encoding:'utf8'});
    assert.equal(probe.status,0,probe.stderr);
    const packets=JSON.parse(probe.stdout).packets;
    assert.ok(packets?.length>0&&packets[0].flags.startsWith('K'),
      'cached +85s window must begin on a decodable keyframe, not a guessed timestamp');
    unblock();
    const [result,[code]]=await Promise.all([ahead.done,childClosed]);
    assert.equal(code,0,stderr.join('').slice(-300));
    assert.equal(result.completed,true,String(result.error));
    await recorder.finish({success:true});
    assert.equal(aborts,0);
    const completed=await cache.openComplete(exact);
    assert.ok(completed,'full same-producer file is EOF-validated and retained');
    await completed.release();
    await cache.dropSession(sid);
  });

test('bounded queue backpressures upstream when HTTP remains stalled, then drains byte-exact',async()=>{
  const chunks=Array.from({length:48},(_,i)=>Buffer.alloc(8*1024,i));
  const source=Readable.from(chunks);
  let first=null,output=[];
  const response=new Writable({highWaterMark:1,write(chunk,_enc,callback){
    output.push(Buffer.from(chunk));
    if(!first)first=callback;
    else callback();
  }});
  const ahead=pipeRemuxAhead({source,response,sourceGeneration:gen,
    getCurrentGeneration:()=>gen,isVerifiedComplete:()=>true,
    maxBufferedBytes:64*1024,maxChunkBytes:8*1024});
  assert.equal(ahead.started,true);
  await wait(80);
  assert.ok(first);
  assert.ok(ahead.peakBufferedBytes<=64*1024);
  assert.ok(ahead.bufferedBytes<=64*1024);
  assert.ok(ahead.spool.totalAcceptedBytes<Buffer.concat(chunks).length,
    'producer stalls once unread bytes hit the cap');
  first();
  const result=await ahead.done;
  assert.equal(result.completed,true,String(result.error));
  assert.deepEqual(Buffer.concat(output),Buffer.concat(chunks),
    'unblocking consumer drains without lost/repeated bytes');
});

test('source generation/verified-coverage revocation stops source and HTTP without stale data',async()=>{
  const source=new PassThrough({highWaterMark:1024});
  const response=new Writable({write(_c,_e,callback){callback();}});
  let current=gen,valid=true,abortCount=0;
  const ahead=pipeRemuxAhead({source,response,sourceGeneration:gen,
    getCurrentGeneration:()=>current,isVerifiedComplete:()=>valid,
    maxBufferedBytes:64*1024,maxChunkBytes:8*1024,
    onAbort:()=>abortCount++});
  assert.equal(ahead.started,true);
  source.write(Buffer.alloc(2048));
  await wait(10);
  current='b'.repeat(48);
  source.write(Buffer.alloc(2048));
  const result=await ahead.done;
  assert.equal(result.completed,false);
  assert.match(result.error.message,/source generation|local completion/i);
  assert.equal(abortCount,1);
  assert.equal(source.destroyed,true);
  assert.equal(response.destroyed,true);
  assert.equal(ahead.peakBufferedBytes<=64*1024,true);
});

test('external abort during HTTP backpressure releases streams and rejects unverified admission',async()=>{
  const controller=new AbortController();
  const source=new PassThrough({highWaterMark:1024});
  let responseCallback;
  const response=new Writable({write(_chunk,_encoding,callback){responseCallback=callback;}});
  assert.equal(pipeRemuxAhead({source,response,sourceGeneration:gen,
    getCurrentGeneration:()=>gen,isVerifiedComplete:()=>false}).started,false);
  const active=pipeRemuxAhead({source,response,sourceGeneration:gen,
    getCurrentGeneration:()=>gen,isVerifiedComplete:()=>true,
    signal:controller.signal,maxBufferedBytes:64*1024,maxChunkBytes:8*1024});
  assert.equal(active.started,true);
  source.write(Buffer.alloc(4096));
  await wait(20);
  assert.ok(responseCallback);
  controller.abort();
  const result=await active.done;
  assert.equal(result.completed,false);
  assert.equal(source.destroyed,true);
  assert.equal(response.destroyed,true);
  assert.equal(active.bufferedBytes,0);
});
