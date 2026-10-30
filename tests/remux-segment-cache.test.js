import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { once } from 'node:events';
import ffmpegPath from 'ffmpeg-static';
import { createRemuxSegmentCache } from '../backend/media/remux-segment-cache.js';

const SID='de178568-edcb-47fb-85f1-e6ee11fa1b33';
const identity=(startSeconds=1.23, overrides={})=>({
  sessionId:SID,sourceIdentity:'synthetic-deterministic-private-hash',
  fileIndex:0,startSeconds,effectiveStartSeconds:1.0,
  videoMode:'copy',videoCodec:'h264',audioTrack:1,audioCodec:'aac',audioChannels:2,
  audioBitrate:'160k',videoTag:'avc1',...overrides,
});

async function temporary(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'lvl-private-remux-cache-test-'));
  t.after(async()=>fs.rm(root,{recursive:true,force:true}));
  await fs.mkdir(path.join(root,SID));
  return root;
}
function fmp4(){
  const ffmpeg=spawnSync(ffmpegPath,[
    '-v','error','-f','lavfi','-i','testsrc2=size=64x64:rate=8:duration=3',
    '-f','lavfi','-i','sine=frequency=200:sample_rate=48000:duration=3',
    '-c:v','libx264','-pix_fmt','yuv420p','-g','8','-keyint_min','8','-sc_threshold','0',
    '-c:a','aac','-b:a','96k','-movflags','frag_keyframe+empty_moov+default_base_moof',
    '-f','mp4','pipe:1',
  ],{encoding:null,maxBuffer:16*1024*1024});
  assert.equal(ffmpeg.status,0,String(ffmpeg.stderr));
  assert.ok(ffmpeg.stdout.length>10000);
  return ffmpeg.stdout;
}
async function deliver(recorder,bytes,{chunkSize=71}={}){
  assert.ok(recorder);
  const chunks=[];
  for(let offset=0;offset<bytes.length;offset+=chunkSize)chunks.push(bytes.subarray(offset,offset+chunkSize));
  const consumed=[];
  const reader=Readable.from(chunks).pipe(recorder.transform);
  reader.on('data',(chunk)=>consumed.push(Buffer.from(chunk)));
  await once(reader,'end');
  assert.deepEqual(Buffer.concat(consumed),bytes,'cache tap must never alter browser MP4 stream');
}
function cache(root,{enabled=()=>true,allowance=async()=>({allowed:true,availableBytes:2**30}),maxEntryBytes=64*1024*1024,
  maxIndexFragments}={}){
  return createRemuxSegmentCache({sessionsRoot:root,enabled,allowance,maxEntryBytes,maxIndexFragments});
}

test('progressive fMP4 captures only complete init and moof+mdat fragments, with exact decode times and lossless complete replay',async(t)=>{
  const root=await temporary(t),manager=cache(root),data=fmp4();
  const recorder=manager.begin(identity());
  await deliver(recorder,data);
  await recorder.finish({success:true});
  const entry=await manager.lookupComplete(identity());
  assert.ok(entry,'verified full same-target MP4 should become replayable');
  assert.equal(entry.bytes,data.length);
  assert.deepEqual(await fs.readFile(entry.file),data);
  assert.ok(entry.fragments.length>=2,'self-authored keyframe MP4 has multiple committed fragments');
  assert.ok(entry.fragments.every(x=>x.offset>=0&&x.bytes>0&&x.tracks.length>=1));
  assert.ok(entry.fragments.every(x=>x.tracks.every(track=>
    Number.isSafeInteger(track.baseDecodeTime)&&track.baseDecodeTime>=0&&
    Number.isSafeInteger(track.timescale)&&track.timescale>0)));
  assert.equal(await manager.lookupComplete(identity(6)),null);
  assert.equal(await manager.lookupComplete(identity(1.23,{audioTrack:2})),null);
  await manager.dropSession(SID);
  assert.equal(await manager.lookupComplete(identity()),null);
  assert.ok(!(await fs.readdir(path.join(root,SID))).some(name=>name.startsWith('.lvl-remux-')));
});

test('early client close discards indexed-but-unplayable prefix instead of starving source torrent storage',async(t)=>{
  const root=await temporary(t),manager=cache(root),data=fmp4();
  const recorder=manager.begin(identity());
  await deliver(recorder,data.subarray(0,data.length-23));
  await recorder.finish({success:false});
  const during=await manager.debugEntries(SID);
  assert.equal(during.length,0,'aborted key must be available for a new retry');
  assert.equal(await manager.lookupComplete(identity()),null);
  assert.deepEqual(await fs.readdir(path.join(root,SID)),[],
    'partial prefixes cannot be replayed and must not occupy source budget after close');
  // The next replay of the *same* requested timestamp must be allowed to
  // start a new recording; a stale invalid key must not permanently block it.
  const retry=manager.begin(identity());
  assert.ok(retry);
  await deliver(retry,data);
  await retry.finish({success:true});
  assert.equal((await manager.lookupComplete(identity()))?.bytes,data.length);
  await manager.dropSession(SID);
});

test('even a successful process exit cannot retain incomplete MP4 or permanently block the same seek key',async(t)=>{
  const root=await temporary(t),manager=cache(root),data=fmp4();
  const incomplete=manager.begin(identity());
  await deliver(incomplete,data.subarray(0,data.length-17));
  await incomplete.finish({success:true});
  assert.equal(await manager.lookupComplete(identity()),null);
  assert.deepEqual(await fs.readdir(path.join(root,SID)),[],
    'a partial final moof/mdat must be discarded even when FFmpeg exits zero');
  const valid=manager.begin(identity());
  assert.ok(valid,'the same exact seek must remain retryable');
  await deliver(valid,data);
  await valid.finish({success:true});
  assert.equal((await manager.lookupComplete(identity()))?.bytes,data.length);
  await manager.dropSession(SID);
});

test('disable and exhausted shared storage allowance create no cache and never block playback',async(t)=>{
  const root=await temporary(t),data=fmp4();
  let active=false;
  const off=cache(root,{enabled:()=>active});
  assert.equal(off.begin(identity()),null);
  assert.deepEqual(await fs.readdir(path.join(root,SID)),[]);
  active=true;
  const gated=cache(root,{allowance:async()=>({allowed:false,availableBytes:0})});
  const capture=gated.begin(identity());
  await deliver(capture,data);
  await capture.finish({success:true});
  assert.equal(await gated.lookupComplete(identity()),null);
  assert.deepEqual(await fs.readdir(path.join(root,SID)),[]);
});

test('cache allowance always receives the source session identity to reserve the remaining torrent budget',async(t)=>{
  const root=await temporary(t),data=fmp4(),seen=[];
  const manager=cache(root,{allowance:async(_bytes,id)=>{
    seen.push(id);
    return {allowed:true,availableBytes:2**30};
  }});
  const recorder=manager.begin(identity());
  await deliver(recorder,data);
  await recorder.finish({success:true});
  assert.ok(seen.length>0);
  assert.ok(seen.every(id=>id.sessionId===SID&&id.fileIndex===0&&
    id.sourceIdentity==='synthetic-deterministic-private-hash'),
    'budget admission must reserve *this* selected torrent source before allowing cache bytes');
});

test('runtime toggle and bounded queue cancel writing without truncating consumer output',async(t)=>{
  const root=await temporary(t),data=fmp4();
  let enabled=true;
  const manager=cache(root,{enabled:()=>enabled,maxEntryBytes:4096});
  const recorder=manager.begin(identity());
  await deliver(recorder,data,{chunkSize:55});
  enabled=false;
  await recorder.finish({success:true});
  assert.equal(await manager.lookupComplete(identity()),null);
  await manager.purgeIdle();
  assert.deepEqual(await fs.readdir(path.join(root,SID)),[]);
});

test('bounded fragment index drops optional cache cleanly without stalling browser data when the fragment cap is exceeded',async(t)=>{
  const root=await temporary(t),data=fmp4();
  const manager=cache(root,{maxIndexFragments:1});
  const recorder=manager.begin(identity());
  await deliver(recorder,data,{chunkSize:71});
  await recorder.finish({success:true});
  assert.equal(await manager.lookupComplete(identity()),null);
  assert.deepEqual(await fs.readdir(path.join(root,SID)),[],
    'bounded index exhaustion must not leak partial media or metadata');
});

test('disabling the setting while an fMP4 producer is active purges cache without aborting its browser byte stream',async(t)=>{
  const root=await temporary(t),data=fmp4();
  let enabled=true,release;
  const continueSource=new Promise(resolve=>{release=resolve;});
  const manager=cache(root,{enabled:()=>enabled});
  const recorder=manager.begin(identity());
  const transferred=[];
  const source=Readable.from((async function*(){
    yield data.subarray(0,10000);
    await continueSource;
    yield data.subarray(10000);
  })());
  const pipe=source.pipe(recorder.transform);
  pipe.on('data',chunk=>transferred.push(Buffer.from(chunk)));
  await new Promise(resolve=>pipe.once('data',resolve));
  enabled=false;
  await manager.purgeIdle();
  release();
  await once(pipe,'end');
  await recorder.finish({success:true});
  assert.deepEqual(Buffer.concat(transferred),data,
    'disabling the optional cache cannot drop or stall media bytes');
  assert.equal(await manager.lookupComplete(identity()),null);
  assert.deepEqual(await fs.readdir(path.join(root,SID)),[]);
});

test('reject path traversal and stale profile identity; never reach outside caller-owned session folder',async(t)=>{
  const root=await temporary(t),manager=cache(root);
  assert.equal(manager.begin(identity(1,{sessionId:'../../another-app'})),null);
  assert.equal(manager.begin(identity(1,{sessionId:'12345678-1234-1234-1234-123456789abc/evil'})),null);
  assert.equal(await manager.lookupComplete(identity(1,{sessionId:'../../another-app'})),null);
  assert.deepEqual(await fs.readdir(root),[SID]);
});

test('damaged MP4 atoms or unverified fragment decode origins fail closed, not merely truncated',async(t)=>{
  const root=await temporary(t),data=fmp4();
  const manager=cache(root);
  const corrupt=Buffer.from(data);
  corrupt.write('NOPE',4,'ascii'); // unrecognized container header
  const broken=manager.begin(identity());
  await deliver(broken,corrupt,{chunkSize:127});
  await broken.finish({success:true});
  assert.equal(await manager.lookupComplete(identity()),null);
  assert.deepEqual(await fs.readdir(path.join(root,SID)),[]);
});
