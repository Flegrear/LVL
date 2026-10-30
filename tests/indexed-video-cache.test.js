import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ffmpeg from 'ffmpeg-static';
import ffprobe from 'ffprobe-static';
import { indexedCacheEligibility, createIndexedVideoCache } from '../backend/media/indexed-video-cache.js';

function fixture() {
  return { enabled: true,
    session: {
      id: 'a1234567-1234-4123-8123-123456789abc', infoHash: 'a'.repeat(40),
      torrent: { pieceLength: 1048576, bitfield: { get: () => true }, files: [
        { name: 'S01E01.mkv', offset: 0, length: 10485760, downloaded: 10485760, done: true },
      ] },
    },
    fileIndex: 0, audioIndex: 0, audioMode: 'stereo',
    media: {
      durationSeconds: 2100.152,
      video: { codec: 'hevc', profile: 'Main 10', pixelFormat: 'yuv420p10le',
        bitDepth: 10, width: 1920, height: 1080, colorTransfer: 'bt709',
        colorPrimaries: 'bt709', colorSpace: 'bt709' },
      audioTracks: [{ codec: 'aac', channels: 2 }, { codec: 'ac3', channels: 6 }],
      compatibility: { video: { hdr: false } },
    },
  };
}
test('complete verified SDR Main10 video is eligible for identity-bound indexed cache', () => {
  const x=fixture();
  const result=indexedCacheEligibility(x);
  assert.equal(result.eligible,true);
  assert.match(result.key,/^[a-f0-9]{64}$/);
  assert.equal(result.identity.channels,2);
  assert.equal(result.identity.bitrate,'160k');
  assert.notEqual(indexedCacheEligibility({ ...x,audioIndex:1 }).key,result.key);
  assert.notEqual(indexedCacheEligibility({ ...x,audioMode:'surround',audioIndex:1 }).key,result.key);
  assert.notEqual(indexedCacheEligibility({ ...x,session:{...x.session,infoHash:'b'.repeat(40)} }).key,result.key);
  assert.notEqual(indexedCacheEligibility({ ...x,session:{...x.session,torrent:{
    files:[{ ...x.session.torrent.files[0],name:'S01E02.mkv' }] } }}).key,result.key);
});
test('setting off, unverified bytes and incomplete selected file never start an optional conversion', () => {
  const x=fixture();
  assert.equal(indexedCacheEligibility({ ...x,enabled:false }).reason,'disabled');
  assert.equal(indexedCacheEligibility({ ...x,session:{...x.session,torrent:{files:[{
    ...x.session.torrent.files[0],done:false,
  }]}}}).reason,'source-incomplete');
  assert.equal(indexedCacheEligibility({ ...x,session:{...x.session,torrent:{files:[{
    ...x.session.torrent.files[0],downloaded:10485759,
  }]}}}).reason,'source-incomplete');
  assert.equal(indexedCacheEligibility({ ...x,audioIndex:99 }).reason,'invalid-audio');
  assert.equal(indexedCacheEligibility({ ...x,session:{...x.session,torrent:{
    ...x.session.torrent,bitfield:{get:()=>false},
  }}}).reason,'source-incomplete', 'download byte count is not sufficient without verified torrent pieces');
});
test('HDR, Dolby Vision, BT2020, unsupported codecs and invalid durations are denied',()=>{
  const x=fixture();
  for(const video of [
    {hdrKind:'hdr10'}, {dolbyVision:true}, {colorTransfer:'smpte2084'},
    {colorTransfer:'arib-std-b67'}, {colorPrimaries:'bt2020'},
    {colorSpace:'bt2020nc'}, {codec:'av1'}, {bitDepth:8,pixelFormat:'yuv420p'},
    {profile:'Rext'}, {pixelFormat:'yuv444p10le'}, {pixelFormat:'yuv422p10le'},
    {width:4000}, {height:4000}, {width:0}, {height:0},
  ]) {
    const result=indexedCacheEligibility({ ...x,media:{...x.media,video:{...x.media.video,...video}}});
    assert.equal(result.eligible,false,JSON.stringify(video));
  }
  assert.equal(indexedCacheEligibility({ ...x,media:{...x.media,durationSeconds:200000}}).eligible,false);
});

const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate, label) {
  for(let attempt=0;attempt<100;attempt++) {
    if(await predicate()) return;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  assert.fail(`timed out: ${label}`);
}

async function harness(t, { allowance = async () => ({allowed:true}), spawn: suppliedSpawn,
  checkEveryMs = 10, removeIndexedDir, purgeRetryMs } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lvl-indexed-cache-test-'));
  const events = [], children = [];
  const spawn = suppliedSpawn || ((binary,args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill = signal => {
      if (child.closed) return false;
      events.push(['kill',signal,binary]);
      child.closed = true;
      queueMicrotask(() => child.emit('close',143));
      return true;
    };
    children.push({ binary,args,child });
    events.push(['spawn',binary]);
    return child;
  });
  const session = fixture();
  const info = indexedCacheEligibility(session);
  const cache = createIndexedVideoCache({
    sessionsRoot:root, enabled:()=>true, allowance,
    sourceUrl:()=>({url:'http://127.0.0.1/owned-fixture',release:()=>events.push(['released'])}),
    ffmpegPath:'fake-ffmpeg',ffprobePath:'fake-ffprobe',
    isCurrent:()=>true, foregroundBusy:()=>false,spawn,
    onSpawn:()=>events.push(['slot-in']),onClose:child=>events.push(['slot-out',Boolean(child)]),
    checkEveryMs,removeIndexedDir,purgeRetryMs,
  });
  t.after(async()=>{ await cache.stopAll(); await rm(root,{recursive:true,force:true}); });
  return { cache,session,info,events,children,root };
}

test('two concurrent build requests claim one admission before the quota check resolves', async t => {
  const quota = deferred();
  const h = await harness(t,{allowance:()=>quota.promise});
  const first = h.cache.build(h.info), second = h.cache.build(h.info);
  quota.resolve({allowed:true});
  await until(()=>h.children.some(c=>c.binary==='fake-ffmpeg'),'encoder admission');
  assert.equal(h.children.filter(c=>c.binary==='fake-ffmpeg').length,1,
    'only one FFmpeg conversion may be admitted for a single selected episode');
  await h.cache.stopAll();
  await Promise.all([first,second]);
});

test('stopAll cancels pending quota admission before spawning an FFmpeg child', async t => {
  const quota = deferred();
  const h = await harness(t,{allowance:()=>quota.promise});
  const build = h.cache.build(h.info);
  const stop = h.cache.stopAll();
  const settled = await Promise.race([stop.then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),120))]);
  assert.equal(settled,true,'foreground playback must never wait on an unresolved background quota read');
  quota.resolve({allowed:true});
  await tick();
  assert.equal(h.children.length,0,'an admission granted after cancellation cannot spawn a child');
  await h.cache.stopAll();
  await build;
});

test('completed output is a normal staged .mp4, checked with ffprobe and manifest published last', async t => {
  const h = await harness(t);
  const work = h.cache.build(h.info);
  await until(()=>h.children.some(c=>c.binary==='fake-ffmpeg'),'encoder start');
  const encoder = h.children.find(c=>c.binary==='fake-ffmpeg');
  assert.ok(encoder);
  assert.match(encoder.args.at(-1),/\.part\.mp4$/,'staged output must still carry the MP4 extension');
  assert.ok(encoder.args.includes('-f') && encoder.args.includes('mp4'));
  assert.deepEqual(encoder.args.slice(encoder.args.indexOf('-map'),encoder.args.indexOf('-map')+4),
    ['-map','0:v:0','-map','0:a:0']);
  await writeFile(encoder.args.at(-1),Buffer.alloc(8192));
  encoder.child.closed=true; encoder.child.emit('close',0);
  await until(()=>h.children.some(c=>c.binary==='fake-ffprobe'),'probe start');
  const probe = h.children.find(c=>c.binary==='fake-ffprobe');
  assert.ok(probe);
  probe.child.stdout.emit('data',JSON.stringify({format:{duration:h.info.identity.duration},
    streams:[{codec_type:'video',codec_name:'h264',pix_fmt:'yuv420p',
      width:h.info.identity.videoWidth,height:h.info.identity.videoHeight},
    {codec_type:'audio',codec_name:'aac',channels:h.info.identity.channels}]}));
  probe.child.closed=true;probe.child.emit('close',0);
  await work;
  const ready = await h.cache.finished(h.info);
  assert.equal(ready?.bytes,8192);
  assert.match(ready.file,/\.mp4$/);
  assert.deepEqual(JSON.parse(await readFile(h.cache.paths(h.info).manifest,'utf8')).identity,h.info.identity);
  assert.equal((await readdir(h.cache.paths(h.info).dir)).some(x=>x.includes('.part')),false);
  assert.equal(h.events.filter(x=>x[0]==='slot-in').length,1);
  assert.equal(h.events.filter(x=>x[0]==='slot-out').length,1);
});

test('cancel while FFprobe is validating must stop the probe and never publish half-verified output', async t => {
  const h=await harness(t);
  const build=h.cache.build(h.info);
  await until(()=>h.children.some(c=>c.binary==='fake-ffmpeg'),'encoder start');
  const encoder=h.children.find(x=>x.binary==='fake-ffmpeg');
  await writeFile(encoder.args.at(-1),Buffer.alloc(8192));
  encoder.child.closed=true;encoder.child.emit('close',0);
  await until(()=>h.children.some(c=>c.binary==='fake-ffprobe'),'probe start');
  assert.equal(h.children.some(x=>x.binary==='fake-ffprobe'),true);
  const stop=h.cache.stopAll();
  const settled=await Promise.race([stop.then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),200))]);
  assert.equal(settled,true,'stopAll cannot block foreground FFmpeg behind an abandoned FFprobe');
  await build;
  assert.equal(await h.cache.finished(h.info),null);
  const probe=h.children.find(x=>x.binary==='fake-ffprobe');
  assert.ok(h.events.some(x=>x[0]==='kill'&&x[2]===probe.binary));
});

test('invalidated torrent bitfield cancels in-flight encode despite unchanged file.done', async t => {
  const h=await harness(t);
  const build=h.cache.build(h.info);
  await until(()=>h.children.some(c=>c.binary==='fake-ffmpeg'),'encoder start');
  // Preserve the exact torrent object identity; only a verification bit changed.
  h.session.session.torrent.bitfield.get=()=>false;
  await until(()=>h.events.some(x=>x[0]==='kill'&&x[2]==='fake-ffmpeg'),
    'invalidated source cancellation');
  await build;
  assert.equal(await h.cache.finished(h.info),null);
});

test('budget exhaustion while encoding stops optional work and never exposes an incomplete file', async t => {
  let checks=0;
  const h=await harness(t,{allowance:async()=>({allowed:++checks===1}),checkEveryMs:5});
  const work=h.cache.build(h.info);
  await until(()=>h.children.some(c=>c.binary==='fake-ffmpeg'),'encoder start');
  await writeFile(h.cache.paths(h.info).partial,Buffer.alloc(4096));
  await until(()=>h.events.some(x=>x[0]==='kill'&&x[2]==='fake-ffmpeg'),
    'quota cancellation');
  await work;
  assert.equal(await h.cache.finished(h.info),null);
  const files=await readdir(h.cache.paths(h.info).dir);
  assert.equal(files.some(x=>x.endsWith('.mp4')||x.endsWith('.json')),false);
});

test('failed storage allowance checks must stop the optional encode safely', async t => {
  let checks=0;
  const h=await harness(t,{allowance:async()=>{
    if(++checks>1) throw Error('synthetic disk usage inspection unavailable');
    return {allowed:true};
  },checkEveryMs:5});
  const build=h.cache.build(h.info);
  await until(()=>h.children.some(c=>c.binary==='fake-ffmpeg'),'encoder start');
  await writeFile(h.cache.paths(h.info).partial,Buffer.alloc(4096));
  await until(()=>h.events.some(x=>x[0]==='kill'&&x[2]==='fake-ffmpeg'),
    'quota read error cancellation');
  await build;
  assert.equal(await h.cache.finished(h.info),null);
});

test('a crashed output without a matching final manifest cannot be served or mistaken for ready', async t => {
  const h=await harness(t);
  const p=h.cache.paths(h.info);
  await mkdir(p.dir,{recursive:true});
  await writeFile(p.output,Buffer.alloc(8192));
  assert.equal(await h.cache.finished(h.info),null);
  await writeFile(p.manifest+'.tmp',JSON.stringify({identity:h.info.identity,bytes:8192,duration:2100}));
  assert.equal(await h.cache.finished(h.info),null,'temporary manifest is never published');
  await writeFile(p.manifest,JSON.stringify({identity:{...h.info.identity,audioIndex:1},bytes:8192,duration:2100}));
  assert.equal(await h.cache.finished(h.info),null,'mismatched identity must not reuse another dub');
  await writeFile(p.manifest,JSON.stringify({identity:h.info.identity,bytes:4096,duration:2100}));
  assert.equal(await h.cache.finished(h.info),null,'same filename with incorrect byte count is not complete');
});

test('an orphaned output from a crashed publish is cleared before quota admission', async t => {
  let output;
  const h=await harness(t,{allowance:async()=>{
    try { await stat(output); return {allowed:false}; }
    catch { return {allowed:true}; }
  }});
  const p=h.cache.paths(h.info);
  output=p.output;
  await mkdir(p.dir,{recursive:true});
  await writeFile(p.output,Buffer.alloc(8192));
  const build=h.cache.build(h.info);
  await until(()=>h.children.some(c=>c.binary==='fake-ffmpeg'),
    'orphan output cleared before new conversion quota admission');
  await h.cache.stopAll();await build;
});

test('purge removes only indexed rendition files and preserves source torrent bytes', async t => {
  const h=await harness(t);
  const p=h.cache.paths(h.info);
  const sessionRoot=path.dirname(p.dir);
  await mkdir(p.dir,{recursive:true});
  const source=path.join(sessionRoot,'original-torrent-piece.bin');
  await writeFile(source,Buffer.from('irreplaceable verified source'));
  await writeFile(p.partial,Buffer.alloc(4096));
  await writeFile(p.output,Buffer.alloc(8192));
  await writeFile(p.manifest,JSON.stringify({identity:h.info.identity,bytes:8192,duration:2100}));
  await h.cache.purgeAll();
  assert.equal(String(await readFile(source)),'irreplaceable verified source');
  await assert.rejects(stat(p.output),{code:'ENOENT'});
  await assert.rejects(stat(p.manifest),{code:'ENOENT'});
});

test('Windows locked Range reader defers purge, blocks new outputs, and retries when lock clears', async t => {
  let locked=true;
  const h=await harness(t,{purgeRetryMs:10,removeIndexedDir:async(dir,opts)=>{
    if(locked){const error=Error('synthetic Windows sharing violation');error.code='EPERM';throw error;}
    await rm(dir,opts);
  }});
  const p=h.cache.paths(h.info);
  await mkdir(p.dir,{recursive:true});
  await writeFile(p.output,Buffer.alloc(8192));
  await writeFile(p.manifest,JSON.stringify({identity:h.info.identity,bytes:8192,duration:2100}));
  await h.cache.purgeAll();
  assert.equal((await stat(p.output)).size,8192,'locked Range file remains intact for its active reader');
  assert.equal(await h.cache.finished(h.info),null,'pending purge never advertises old cache as ready');
  await h.cache.build(h.info);
  assert.equal(h.children.length,0,'a new background encode must not repopulate a locked directory');
  locked=false;
  await until(async()=>{
    try{await stat(p.output);return false;}catch(e){return e?.code==='ENOENT';}
  },'deferred purge removes unlocked old indexed file');
  assert.equal((await readdir(path.dirname(p.dir))).includes('indexed-seek'),false);
});

test('real HEVC Main10 SDR MKV produces a finalized indexed H264/AAC MP4 with the selected surround dub',
  {timeout:45000,skip:!ffmpeg||!ffprobe?.path},async t=>{
    const root=await mkdtemp(path.join(os.tmpdir(),'lvl-indexed-real-'));
    t.after(async()=>{ await rm(root,{recursive:true,force:true}); });
    const input=path.join(root,'source-main10.mkv');
    const generated=spawnSync(ffmpeg,['-hide_banner','-loglevel','error','-y',
      '-f','lavfi','-i','testsrc2=duration=3:size=160x90:rate=24',
      '-f','lavfi','-i','sine=frequency=440:duration=3',
      '-f','lavfi','-i','sine=frequency=880:duration=3',
      '-map','0:v:0','-map','1:a:0','-map','2:a:0',
      '-c:v','libx265','-preset','ultrafast','-threads','2',
      '-x265-params','pools=1:frame-threads=1:log-level=error',
      '-pix_fmt','yuv420p10le','-color_primaries','bt709','-color_trc','bt709',
      '-colorspace','bt709','-c:a:0','aac','-ac:a:0','2',
      '-c:a:1','ac3','-ac:a:1','6','-t','3',input],{timeout:20000});
    assert.equal(generated.status,0,String(generated.stderr||'').slice(-1000));
    const inputBytes=(await stat(input)).size;
    const params=fixture();
    params.session.torrent.files[0]={name:'source-main10.mkv',offset:0,
      length:inputBytes,downloaded:inputBytes,done:true};
    params.session.torrent.pieceLength=1048576;
    params.media.durationSeconds=3;
    params.media.video.width=160;params.media.video.height=90;
    params.audioIndex=1;params.audioMode='surround';
    const info=indexedCacheEligibility(params);
    assert.equal(info.eligible,true);
    let active=0,spawns=0;
    const cache=createIndexedVideoCache({sessionsRoot:root,enabled:()=>true,
      allowance:async()=>({allowed:true}),sourceUrl:()=>({url:input}),
      ffmpegPath:ffmpeg,ffprobePath:ffprobe.path,isCurrent:()=>true,
      onSpawn:()=>{active++;spawns++;},onClose:()=>{active--;},checkEveryMs:100});
    t.after(()=>cache.stopAll());
    await cache.build(info);
    const finished=await cache.finished(info);
    assert.ok(finished, 'real encode should pass stream, clock, track and complete MP4 validation');
    assert.equal(spawns,1); assert.equal(active,0);
    const output=await readFile(finished.file);
    const firstAtoms=[];
    for(let offset=0;offset+8<=output.length;){
      const length=output.readUInt32BE(offset);
      if(length<8||length>output.length-offset)break;
      firstAtoms.push(output.toString('ascii',offset+4,offset+8));
      offset+=length;
    }
    assert.ok(firstAtoms.indexOf('moov')>firstAtoms.indexOf('ftyp')
      && firstAtoms.indexOf('moov')<firstAtoms.indexOf('mdat'),
      'faststart MP4 indexes its complete timeline before the video payload');
    const inspected=spawnSync(ffprobe.path,['-v','error','-show_entries',
      'stream=codec_type,codec_name,channels,pix_fmt','-of','json',finished.file],{timeout:10000});
    assert.equal(inspected.status,0,String(inspected.stderr||''));
    const streams=JSON.parse(String(inspected.stdout)).streams;
    assert.equal(streams.find(s=>s.codec_type==='video').pix_fmt,'yuv420p');
    assert.equal(streams.find(s=>s.codec_type==='audio').channels,6,
      'input second AC3 track was selected and encoded to 5.1 AAC');
  });
