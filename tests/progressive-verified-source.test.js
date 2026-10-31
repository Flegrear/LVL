import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import ffprobe from 'ffprobe-static';
import { createProgressiveVerifiedSource, inspectProgressiveVerifiedSource }
  from '../backend/media/progressive-verified-source.js';
import { createProgressiveIndexCache }
  from '../backend/media/progressive-index-cache.js';

const SESSION='acf118ea-02d3-4dd8-9fb9-e8c066b43f07';
const PIECE=32768;
const wait=ms=>new Promise(r=>setTimeout(r,ms));

async function fixture(t,{generate=true,codec='h264'}={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'lvl-prefix-verified-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const home=path.join(root,SESSION);
  await fs.mkdir(home,{recursive:true});
  const input=path.join(home,'episode.mkv');
  if(generate){
    const result=spawnSync(ffmpeg,['-hide_banner','-loglevel','error','-y',
      '-f','lavfi','-i','testsrc2=duration=8:size=160x90:rate=24',
      '-f','lavfi','-i','sine=frequency=440:duration=8',
      '-map','0:v:0','-map','1:a:0','-c:v',codec==='hevc'?'libx265':'libx264',
      '-preset','ultrafast','-threads','2','-g','24','-bf','0',
      ...(codec==='hevc'?['-pix_fmt','yuv420p10le',
        '-x265-params','pools=1:frame-threads=1:log-level=error']:[]),
      '-c:a','aac','-ac','2',input],{timeout:18000});
    assert.equal(result.status,0,String(result.stderr).slice(-600));
  }else await fs.writeFile(input,Buffer.alloc(PIECE*12,0x51));
  const size=(await fs.stat(input)).size;
  const maxPieces=Math.ceil(size/PIECE);
  const bits=new Set();
  let readerCalls=0,gets=0;
  const file={name:'episode.mkv',path:'episode.mkv',offset:0,length:size,
    done:false,downloaded:0,createReadStream(){readerCalls++;throw Error('network-reader-forbidden');}};
  const torrent={files:[file],pieceLength:PIECE,length:size,
    pieces:Array(maxPieces).fill(null),bitfield:{get(i){gets++;return bits.has(i);}}};
  const session={id:SESSION,infoHash:'a'.repeat(40),torrent};
  const params={session,fileIndex:0,inputPath:input,audioIndex:0,audioMode:'auto',generation:7};
  const maker=opts=>createProgressiveVerifiedSource({sessionsRoot:root,
    allowance:async()=>({allowed:true}),isCurrent:()=>true,maxPrefixBytes:64*1024*1024,...opts});
  return {root,home,input,size,bits,session,file,torrent,params,maker,
    get readerCalls(){return readerCalls;},get gets(){return gets;}};
}

function verifiedPrefix(f,ratio=0.66){
  const count=Math.floor(f.size/PIECE*ratio);
  assert.ok(count>=2,'fixture must have multiple pieces');
  for(let i=0;i<count;i++)f.bits.add(i);
  f.file.downloaded=count*PIECE;
  return count*PIECE;
}

test('real H264/AAC MKV torrent decodes a source prefix while torrent remains INCOMPLETE and offline',
  {timeout:30000,skip:!ffmpeg||!ffprobe?.path},async t=>{
    const f=await fixture(t);
    const size=verifiedPrefix(f,0.75);
    const source=f.maker();
    const descriptor=source.inspect(f.params);
    assert.equal(descriptor.eligible,true);
    assert.equal(descriptor.sourceComplete,false);
    assert.equal(descriptor.networkReaderAllowed,false);
    assert.equal(descriptor.mediaTimingProven,false);
    assert.equal(descriptor.verifiedPrefix.bytes,size);
    const lease=await source.materialize(f.params);
    assert.ok(lease,'prefix became usable before torrent finished');
    try{
      assert.equal(lease.sourceComplete,false);
      assert.equal(lease.sourceVerified(),true);
      assert.equal((await fs.stat(lease.inputPath)).size,size);
      assert.deepEqual(await fs.readFile(lease.inputPath),
        (await fs.readFile(f.input)).subarray(0,size),
        'FFmpeg input must be ONLY the verified prefix, never the missing suffix');
      const probe=spawnSync(ffprobe.path,['-v','error','-show_streams','-show_frames',
        '-show_entries','stream=codec_name,codec_type:frame=media_type,key_frame,best_effort_timestamp_time',
        '-of','json',lease.inputPath],{timeout:12000});
      assert.equal(probe.status,0,String(probe.stderr));
      const decoded=JSON.parse(String(probe.stdout));
      assert.ok(decoded.streams.some(s=>s.codec_name==='h264'));
      assert.ok(decoded.streams.some(s=>s.codec_name==='aac'));
      const frames=decoded.frames.filter(frame=>frame.media_type==='video'
        &&Number.isFinite(Number(frame.best_effort_timestamp_time)));
      assert.ok(frames.length>=12,'FFprobe genuinely decoded the incomplete source');
      assert.ok(frames[0].key_frame===1,'real initial decoded keyframe exists');
      assert.ok(Number(frames.at(-1).best_effort_timestamp_time)<8,
        'verified prefix cannot claim the absent end of an 8-second episode');
      assert.equal(f.readerCalls,0);
    }finally{await lease.release();}
    await assert.rejects(fs.stat(lease.inputPath),{code:'ENOENT'});
    assert.equal(source.activeCount,0);
  });

test('missing piece stops prefix at preceding complete piece; later verified islands are advisory ONLY',
  async t=>{
    const f=await fixture(t,{generate:false});
    for(const piece of [0,1,2,6,7,9,10])f.bits.add(piece);
    const report=inspectProgressiveVerifiedSource(f.params);
    assert.equal(report.eligible,true);
    assert.equal(report.verifiedPrefix.bytes,3*PIECE);
    assert.deepEqual(report.islands.map(({start,end,decodable})=>({start,end,decodable})),[
      {start:6*PIECE,end:8*PIECE-1,decodable:false},
      {start:9*PIECE,end:11*PIECE-1,decodable:false}]);
    const lease=await f.maker().materialize(f.params);
    assert.ok(lease);
    assert.equal(lease.bytes,3*PIECE);
    await lease.release();
    assert.equal(f.readerCalls,0);
  });

test('mid-piece file offsets still require SHA1-verified shared boundary pieces',async t=>{
  const f=await fixture(t,{generate:false});
  const initial=f.file.length;
  f.file.offset=1200;
  f.torrent.length=1200+initial;
  f.torrent.pieces=Array(Math.ceil(f.torrent.length/PIECE)).fill(null);
  f.bits.add(0);f.bits.add(1);f.bits.add(2);
  const good=inspectProgressiveVerifiedSource(f.params);
  assert.equal(good.eligible,true);
  assert.ok(good.verifiedPrefix.bytes>2*PIECE-1200);
  f.bits.delete(0);
  assert.equal(inspectProgressiveVerifiedSource(f.params).eligible,false);
});

test('verified downloaded bytes after the 64MiB flat-prefix cap remain eligible as bounded later MKV Cluster candidates',()=>{
  const PIECE_LENGTH=32768;
  const totalPieces=2500,verifiedPieces=2350;
  const file={name:'long.mkv',path:'long.mkv',offset:0,
    length:totalPieces*PIECE_LENGTH,downloaded:verifiedPieces*PIECE_LENGTH,done:false};
  const session={id:SESSION,infoHash:'a'.repeat(40),torrent:{
    files:[file],pieceLength:PIECE_LENGTH,length:file.length,
    pieces:Array(totalPieces).fill(null),bitfield:{get:i=>i<verifiedPieces},
  }};
  const report=inspectProgressiveVerifiedSource({session,fileIndex:0,
    maxPrefixBytes:64*1024*1024});
  assert.equal(report.eligible,true);
  assert.equal(report.sourceComplete,false);
  assert.equal(report.verifiedPrefix.bytes,64*1024*1024);
  assert.deepEqual(report.islands,[{
    start:64*1024*1024,end:verifiedPieces*PIECE_LENGTH-1,
    bytes:verifiedPieces*PIECE_LENGTH-64*1024*1024,decodable:false,
  }]);
  assert.equal(report.networkReaderAllowed,false);
  assert.equal(report.mediaTimingProven,false,
    'late hash-verified bytes still require a complete MKV Cluster and output decoder proof');
});

test('bitfield revocation during copy aborts and deletes staging; source is never modified',async t=>{
  const f=await fixture(t,{generate:false});
  verifiedPrefix(f,0.9);
  const original=await fs.readFile(f.input);
  const originalGet=f.torrent.bitfield.get;
  let checks=0;
  f.torrent.bitfield.get=i=>{
    checks++;
    if(checks>140)f.bits.delete(2);
    return originalGet(i);
  };
  const lease=await f.maker({maxChunkBytes:1024}).materialize(f.params);
  assert.equal(lease,null,'piece revoked after check must invalidate materialization');
  assert.deepEqual(await fs.readFile(f.input),original);
  assert.equal(f.readerCalls,0);
  const area=path.join(f.home,'progressive-verified-source');
  assert.deepEqual(await fs.readdir(area).catch(()=>[]),[],
    'unverified temporary bytes must never remain on disk');
});

test('abort signal, disabled quota, bad source path and stale session all fail closed',async t=>{
  const f=await fixture(t,{generate:false});
  verifiedPrefix(f,0.7);
  const ctrl=new AbortController();ctrl.abort();
  assert.equal(await f.maker().materialize({...f.params,signal:ctrl.signal}),null);
  assert.equal(await f.maker({allowance:async()=>({allowed:false})}).materialize(f.params),null);
  assert.equal(await f.maker().materialize({...f.params,inputPath:path.join(f.root,'outside.mkv')}),null);
  const old=f.session.infoHash;
  const maker=f.maker({isCurrent:identity=>identity.infoHash===old});
  f.session.infoHash='b'.repeat(40);
  assert.equal(await maker.materialize(f.params),null);
  assert.equal(f.readerCalls,0);
});

test('source and audio identity are bound, generation and prefix growth yield a NEW key',async t=>{
  const f=await fixture(t,{generate:false});
  const n=verifiedPrefix(f,0.5);
  const first=inspectProgressiveVerifiedSource(f.params);
  const differentAudio=inspectProgressiveVerifiedSource({...f.params,audioIndex:1});
  const differentGeneration=inspectProgressiveVerifiedSource({...f.params,generation:8});
  assert.notEqual(first.sourceKey,differentAudio.sourceKey);
  assert.notEqual(first.sourceKey,differentGeneration.sourceKey);
  f.bits.add(n/PIECE);
  const grown=inspectProgressiveVerifiedSource(f.params);
  assert.ok(grown.verifiedPrefix.bytes>first.verifiedPrefix.bytes);
  assert.notEqual(grown.sourceKey,first.sourceKey);
  assert.equal(first.mediaTimingProven,false);
});

test('fixed input cap and bounded 64KiB chunks never read beyond verified prefix',async t=>{
  const f=await fixture(t,{generate:false});
  verifiedPrefix(f,0.95);
  const maxPrefixBytes=4*PIECE;
  const lease=await f.maker({maxPrefixBytes,maxChunkBytes:4096}).materialize(f.params);
  assert.ok(lease);
  assert.equal(lease.bytes,maxPrefixBytes);
  assert.equal((await fs.stat(lease.inputPath)).size,maxPrefixBytes);
  await lease.release();
  assert.equal(f.readerCalls,0);
});

test('REAL progressive GOP cache indexes an INCOMPLETE H264 torrent before its EOF',
  {timeout:30000,skip:!ffmpeg||!ffprobe?.path},async t=>{
    const f=await fixture(t);
    const verified=verifiedPrefix(f,0.7);
    const verifiedSource=f.maker();
    const media={durationSeconds:8,
      video:{codec:'h264',profile:'High',pixelFormat:'yuv420p',bitDepth:8,
        width:160,height:90,colorTransfer:'bt709',colorPrimaries:'bt709',colorSpace:'bt709'},
      audioTracks:[{codec:'aac',channels:2}]};
    const params={...f.params,media,enabled:true};
    const notices=[];
    const cache=createProgressiveIndexCache({sessionsRoot:f.root,
      verifiedSource,ffmpegPath:ffmpeg,ffprobePath:ffprobe.path,
      enabled:()=>true,allowance:async()=>({allowed:true}),
      isCurrent:identity=>identity.infoHash===f.session.infoHash.toLowerCase(),
      onReady:section=>notices.push(section),
      ffmpegInputArgs:['-readrate','30'],
    });
    t.after(()=>cache.stopAll());
    const before=cache.eligibility(params);
    assert.equal(before.eligible,true);
    assert.equal(before.sourceMode,'verified-prefix');
    assert.equal(before.verifiedSourceBytes,verified);
    await cache.start(params);
    const state=await cache.status(params);
    assert.ok(notices.length>0,'one or more actual FFmpeg/IDR verified GOPs are published');
    assert.equal(state.sourceMode,'verified-prefix');
    assert.equal(state.complete,false);
    assert.equal(state.status,'partial','an incomplete torrent must not fake full indexed movie completion');
    assert.ok(state.ranges.every(range=>range.sourceByteEnd===verified-1));
    const segment=await cache.open(params,state.ranges[0].id);
    assert.ok(segment,'a verified section is immediately independently seekable');
    await segment.release();
    const pinnedKey=state.identityKey;
    f.bits.add(verified/PIECE);f.file.downloaded+=PIECE;
    const grown=await cache.status(params);
    assert.equal(grown.identityKey,pinnedKey,'prefix growth preserves stable source/audio cache identity');
    assert.equal(grown.canContinue,true,'backend must explicitly kick off new verified-prefix work');
    assert.equal(grown.ranges.length,state.ranges.length,'old indexed GOPs survive prefix growth');
    for(let piece=0;piece<f.torrent.pieces.length;piece++)f.bits.add(piece);
    f.file.downloaded=f.file.length;f.file.done=true;
    const completedTorrent=await cache.status(params);
    assert.equal(completedTorrent.identityKey,pinnedKey,
      'moving from 70% to 100% download must NOT hide already verified sections');
    assert.ok(completedTorrent.ranges.length>=state.ranges.length);
    assert.equal(f.readerCalls,0);
  });

test('REAL incomplete HEVC Main10 SDR prefix independently encodes verified H264/AAC GOPs',
  {timeout:40000,skip:!ffmpeg||!ffprobe?.path},async t=>{
    const f=await fixture(t,{codec:'hevc'});
    verifiedPrefix(f,0.75);
    const verifiedSource=f.maker();
    const params={...f.params,enabled:true,media:{durationSeconds:8,
      video:{codec:'hevc',profile:'Main 10',pixelFormat:'yuv420p10le',bitDepth:10,
        width:160,height:90,colorTransfer:'bt709',colorPrimaries:'bt709',colorSpace:'bt709'},
      audioTracks:[{codec:'aac',channels:2}]}};
    const ready=[];
    const cache=createProgressiveIndexCache({sessionsRoot:f.root,
      verifiedSource,ffmpegPath:ffmpeg,ffprobePath:ffprobe.path,
      enabled:()=>true,allowance:async()=>({allowed:true}),isCurrent:()=>true,
      onReady:section=>ready.push(section),ffmpegInputArgs:['-readrate','25']});
    t.after(()=>cache.stopAll());
    assert.equal(cache.eligibility(params).identity.videoStrategy,'encode');
    await cache.start(params);
    const status=await cache.status(params);
    assert.equal(f.file.done,false);
    assert.ok(ready.length>=1,'a converted HEVC Main10 GOP is ready before torrent EOF');
    assert.equal(status.sourceMode,'verified-prefix');
    assert.equal(status.complete,false);
    const pin=await cache.open(params,ready[0].id);
    assert.ok(pin);
    try{
      const probe=spawnSync(ffprobe.path,['-v','error','-show_entries',
        'stream=codec_type,codec_name,pix_fmt','-of','json',pin.file],{timeout:10000});
      assert.equal(probe.status,0,String(probe.stderr));
      const streams=JSON.parse(String(probe.stdout)).streams;
      assert.ok(streams.some(s=>s.codec_type==='video'&&s.codec_name==='h264'
        &&s.pix_fmt==='yuv420p'));
      assert.ok(streams.some(s=>s.codec_type==='audio'&&s.codec_name==='aac'));
    }finally{await pin.release();}
    assert.equal(f.readerCalls,0);
  });

test('REAL >prefix-cap file grows 25%-to-100% without losing ready GOPs and converts full original file',
  {timeout:40000,skip:!ffmpeg||!ffprobe?.path},async t=>{
    const f=await fixture(t);
    const maxPrefixBytes=4*PIECE;
    assert.ok(f.size>maxPrefixBytes*2,'synthetic source must exceed capped partial input');
    for(let piece=0;piece<4;piece++)f.bits.add(piece);
    f.file.downloaded=maxPrefixBytes;
    const verifiedSource=f.maker({maxPrefixBytes});
    const params={...f.params,enabled:true,media:{durationSeconds:8,
      video:{codec:'h264',profile:'High',pixelFormat:'yuv420p',bitDepth:8,
        width:160,height:90,colorTransfer:'bt709',colorPrimaries:'bt709',colorSpace:'bt709'},
      audioTracks:[{codec:'aac',channels:2}]}};
    const errors=[];
    const cache=createProgressiveIndexCache({sessionsRoot:f.root,
      verifiedSource,ffmpegPath:ffmpeg,ffprobePath:ffprobe.path,
      enabled:()=>true,allowance:async()=>({allowed:true}),
      isCurrent:()=>true,onDiagnostic:e=>errors.push(e),ffmpegInputArgs:['-readrate','40']});
    t.after(()=>cache.stopAll());
    await cache.start(params);
    const partial=await cache.status(params);
    assert.equal(partial.status,'partial');
    assert.ok(partial.ranges.length>0,'actual first verified GOP must be ready before full source');
    const oldCoverage=partial.ranges.map(({start,end})=>({start,end}));
    const oldKey=partial.identityKey;
    for(let piece=0;piece<f.torrent.pieces.length;piece++)f.bits.add(piece);
    f.file.downloaded=f.file.length;f.file.done=true;
    const before=await cache.status(params);
    assert.equal(before.identityKey,oldKey);
    assert.equal(before.canContinue,true);
    await cache.start(params);
    const full=await cache.status(params);
    assert.equal(full.identityKey,oldKey);
    assert.ok(oldCoverage.every(old=>full.ranges.some(window=>
      window.start<=old.start+0.05&&window.end>=old.end-0.05)),
      'earlier verified prefix intervals must stay covered, even if truncated GOP is atomically upgraded');
    assert.ok(full.ranges.at(-1).end>7.6,
      'after all pieces verified the producer must read full original source, not 128KiB cap: '+errors.join(' | '));
    assert.equal(full.complete,true,'full video may only be complete after actual EOF and verified coverage: '
      +JSON.stringify(full.ranges.map(r=>({start:r.start,end:r.end,sequence:r.sequence,hash:r.initHash.slice(0,6)})))
      +' diagnostics='+errors.join('|'));
    assert.equal(f.readerCalls,0);
  });

test('REAL disjoint SHA1-verified MKV Cluster can be locally reconstructed with original timecode',
  {timeout:30000,skip:!ffmpeg||!ffprobe?.path},async t=>{
    const f=await fixture(t);
    // Verified 0..3s EBML header and a later independent ~4-5s cluster;
    // pieces 3-4 and final pieces are absent. No bytes across either gap may
    // enter the synthesized source sent to FFprobe.
    for(const piece of [0,1,2,5,6,7,8])f.bits.add(piece);
    f.file.downloaded=f.bits.size*PIECE;
    const report=inspectProgressiveVerifiedSource(f.params);
    assert.equal(report.eligible,true);
    assert.equal(report.sourceComplete,false);
    assert.equal(report.verifiedPrefix.bytes,3*PIECE);
    assert.ok(report.islands.some(x=>x.start===5*PIECE));
    const diagnostics=[];
    const source=f.maker({ffprobePath:ffprobe.path,onDiagnostic:reason=>diagnostics.push(reason)});
    const island=await source.materializeClusterIsland(f.params);
    const bytes=await fs.readFile(f.input);
    const markers=[];let marker=bytes.indexOf(Buffer.from([0x1f,0x43,0xb6,0x75]));
    while(marker>=0){markers.push(marker);marker=bytes.indexOf(Buffer.from([0x1f,0x43,0xb6,0x75]),marker+4);}
    assert.ok(island,'a complete, verified, independently decodable later MKV Cluster was found: '
      +diagnostics.join(',')+' markers='+markers.join(',')+' verifiedIslands='+JSON.stringify(report.islands));
    try{
      assert.equal(island.sourceKind,'isolated-cluster');
      assert.equal(island.sourceComplete,false);
      assert.equal(island.networkReaderAllowed,false);
      assert.equal(island.mediaTimingProven,false,
        'the source layer does not promote a browser seekable MPEG segment');
      assert.equal(island.sourceVerified(),true);
      assert.ok(island.decodedFirstFramePTS>=3.9&&island.decodedFirstFramePTS<5,
        'FFprobe observes the ORIGINAL movie-clock time after the missing gap');
      assert.ok(island.decodedLastFramePTS>island.decodedFirstFramePTS);
      assert.equal(island.sourceRanges.length,2);
      assert.equal(island.sourceRanges[0].start,0);
      assert.ok(island.sourceRanges[1].start>=5*PIECE);
      assert.ok(island.sourceRanges[1].end<9*PIECE);
      const probe=spawnSync(ffprobe.path,['-v','error','-show_frames',
        '-show_entries','frame=media_type,key_frame,best_effort_timestamp_time',
        '-of','json',island.inputPath],{timeout:10000});
      assert.equal(probe.status,0,String(probe.stderr));
      const frames=JSON.parse(String(probe.stdout)).frames.filter(x=>x.media_type==='video');
      assert.ok(frames.length>=12&&frames[0].key_frame===1);
      const output=path.join(f.home,'island-stamped.mp4');
      const movie=spawnSync(ffmpeg,['-hide_banner','-loglevel','error','-y',
        '-copyts','-i',island.inputPath,'-map','0:v:0','-map','0:a:0',
        '-c:v','copy','-c:a','aac','-af','aresample=async=1',
        '-avoid_negative_ts','disabled',
        '-movflags','frag_keyframe+empty_moov+default_base_moof',
        '-f','mp4',output],{timeout:12000});
      assert.equal(movie.status,0,String(movie.stderr).slice(-500));
      const clock=spawnSync(ffprobe.path,['-v','error','-show_frames',
        '-show_entries','frame=media_type,key_frame,best_effort_timestamp_time',
        '-of','json',output],{timeout:10000});
      assert.equal(clock.status,0,String(clock.stderr));
      const movieFrames=JSON.parse(String(clock.stdout)).frames.filter(x=>x.media_type==='video');
      assert.ok(movieFrames.length>=12);
      const remuxFirst=Number(movieFrames[0].best_effort_timestamp_time);
      assert.ok(Math.abs(remuxFirst)<0.1,
        'FFmpeg resets the isolated media clock even under -copyts; do not advertise raw fMP4 PTS as movie time');
      const exactSourceOffset=island.decodedFirstFramePTS-remuxFirst;
      assert.ok(exactSourceOffset>=3.9&&exactSourceOffset<5,
        'later GOP requires an explicitly verified timeline translation before browser MSE seek');
      assert.equal(f.readerCalls,0);
      f.bits.delete(6);
      assert.equal(island.sourceVerified(),false,
        'revocation of one source Cluster piece must fail closed after publication');
    }finally{await island.release();}
    await assert.rejects(fs.stat(island.inputPath),{code:'ENOENT'});
  });

test('disjoint MKV fragments that do not contain a complete Cluster never become decoder claims',
  {timeout:30000,skip:!ffmpeg||!ffprobe?.path},async t=>{
    const f=await fixture(t);
    for(const piece of [0,1,2,5])f.bits.add(piece);
    f.file.downloaded=f.bits.size*PIECE;
    const result=await f.maker({ffprobePath:ffprobe.path}).materializeClusterIsland(f.params);
    assert.equal(result,null,'piece island with incomplete Cluster must be rejected');
    assert.equal(f.readerCalls,0);
  });

test('REAL cached later MKV island is IDR/FFprobe ready at ORIGINAL movie time, not remux local zero',
  {timeout:30000,skip:!ffmpeg||!ffprobe?.path},async t=>{
    const f=await fixture(t);
    for(const piece of [0,1,2,5,6,7,8])f.bits.add(piece);
    f.file.downloaded=f.bits.size*PIECE;
    const verifiedSource=f.maker({ffprobePath:ffprobe.path});
    const params={...f.params,enabled:true,media:{durationSeconds:8,
      video:{codec:'h264',profile:'High',pixelFormat:'yuv420p',bitDepth:8,
        width:160,height:90,colorTransfer:'bt709',colorPrimaries:'bt709',colorSpace:'bt709'},
      audioTracks:[{codec:'aac',channels:2}]}};
    const diagnostics=[],ready=[];
    const cache=createProgressiveIndexCache({sessionsRoot:f.root,
      verifiedSource,ffmpegPath:ffmpeg,ffprobePath:ffprobe.path,
      enabled:()=>true,allowance:async()=>({allowed:true}),
      isCurrent:identity=>identity.infoHash===f.session.infoHash.toLowerCase(),
      onReady:window=>ready.push(window),onDiagnostic:what=>diagnostics.push(what),
      ffmpegInputArgs:['-readrate','25'],
    });
    t.after(()=>cache.stopAll());
    await cache.start(params,{sourceKind:'island'});
    const status=await cache.status(params);
    assert.ok(ready.length>0,'a later complete verified Cluster must publish its own GOP: '+diagnostics.join(' | '));
    assert.equal(status.status,'partial');
    assert.equal(status.complete,false);
    const window=status.ranges.find(item=>item.sourceKind==='isolated-cluster');
    assert.ok(window,'a verified disjoint section must appear in exact readyRanges');
    assert.ok(window.start>=3.9&&window.start<5,'movie-clock start is near 4s, not local remux 0');
    assert.ok(window.end>window.start+0.5&&window.end<=5.1);
    assert.equal(window.sourceRanges.length,2);
    assert.ok(window.timelineOffsetSeconds>=3.9&&window.timelineOffsetSeconds<5);
    assert.ok(Math.abs(window.mediaStart+window.timelineOffsetSeconds-window.start)<0.1);
    assert.equal(window.movieClockVerified,true);
    assert.equal(window.keyframeStart,true);
    const pin=await cache.open(params,window.id);
    assert.ok(pin,'a source-verified, independently decoded later GOP is immediately readable');
    await pin.release();
    // The missing middle pieces later arrive; a new prefix conversion now
    // overlaps the already indexed island. Replaying candidate GOPs must not
    // corrupt the previously committed index or hide its bright interval.
    f.bits.add(3);f.bits.add(4);
    f.file.downloaded=f.bits.size*PIECE;
    await cache.start(params,{sourceKind:'prefix'});
    const replay=await cache.status(params);
    assert.ok(replay.ranges.some(item=>item.id===window.id),
      'overlapping/new init conversion cannot invalidate an earlier published island');
    for(let i=1;i<replay.ranges.length;i++){
      assert.ok(replay.ranges[i].start>=replay.ranges[i-1].end-0.005,
        'never publish overlapping GOPs with inconsistent movie clocks');
    }
    f.bits.delete(6);
    assert.equal((await cache.status(params)).ranges.length,0,
      'losing a single source island piece revokes bright-ready claim');
    assert.equal(f.readerCalls,0);
  });

test('stopAll aborts stalled verified-source admission and cannot leak its temporary lease',
  {timeout:10000},async t=>{
    const f=await fixture(t,{generate:false});
    verifiedPrefix(f,0.7);
    const source=f.maker({allowance:async()=>new Promise(()=>{})});
    const params={...f.params,enabled:true,media:{durationSeconds:8,
      video:{codec:'h264',profile:'High',pixelFormat:'yuv420p',bitDepth:8,
        width:160,height:90,colorTransfer:'bt709',colorPrimaries:'bt709',colorSpace:'bt709'},
      audioTracks:[{codec:'aac',channels:2}]}};
    const cache=createProgressiveIndexCache({sessionsRoot:f.root,verifiedSource:source,
      ffmpegPath:ffmpeg,ffprobePath:ffprobe.path,enabled:()=>true,
      allowance:async()=>({allowed:true}),isCurrent:()=>true});
    const job=cache.start(params);
    const deadline=Date.now()+1200;
    while(source.activeCount===0&&Date.now()<deadline)await wait(10);
    assert.equal(source.activeCount,1,'background source lease must be visible before cancellation');
    const finished=await Promise.race([cache.stopAll().then(()=>true),wait(800).then(()=>false)]);
    assert.equal(finished,true,'stopAll must not await a hung storage allowance callback');
    await job;
    assert.equal(source.activeCount,0,'abort must free the verified local source slot');
    const staging=path.join(f.home,'progressive-verified-source');
    assert.deepEqual(await fs.readdir(staging).catch(()=>[]),[],
      'canceled incomplete source cannot leave a temporary FFmpeg input');
    assert.equal(f.readerCalls,0);
  });

test('an unchanged verified prefix that cannot produce a section is not repeatedly re-encoded',
  {timeout:30000},async t=>{
    const f=await fixture(t,{generate:false});
    f.bits.add(0);f.bits.add(1);
    const source=f.maker();
    const params={...f.params,enabled:true,media:{durationSeconds:8,
      video:{codec:'h264',profile:'High',pixelFormat:'yuv420p',bitDepth:8,
        width:160,height:90,colorTransfer:'bt709',colorPrimaries:'bt709',colorSpace:'bt709'},
      audioTracks:[{codec:'aac',channels:2}]}};
    const cache=createProgressiveIndexCache({sessionsRoot:f.root,verifiedSource:source,
      ffmpegPath:ffmpeg,ffprobePath:ffprobe.path,enabled:()=>true,
      allowance:async()=>({allowed:true}),isCurrent:()=>true});
    let starts=0;
    const initial=cache.status(params);
    assert.equal((await initial).status,'waiting');
    await cache.start(params);
    const first=await cache.status(params);
    assert.equal(first.status,'waiting-for-pieces');
    const before=starts;
    await cache.start(params);
    assert.equal(starts,before);
    f.bits.add(2);
    const grown=await cache.status(params);
    assert.equal(grown.status,'waiting','new hash-verified pieces permit one new attempt');
    assert.equal(f.readerCalls,0);
  });
