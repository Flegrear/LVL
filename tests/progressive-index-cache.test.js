import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import ffprobe from 'ffprobe-static';
import { progressiveIndexEligibility, createProgressiveIndexCache } from '../backend/media/progressive-index-cache.js';

function source(sessionId, codec, bytes) {
  return { enabled: true, session: { id: sessionId, infoHash: 'b'.repeat(40),
    torrent: { pieceLength: 1024 * 1024, bitfield: { get: () => true },
      files: [{ name: 'fixture.mkv', offset: 0, length: bytes, downloaded: bytes, done: true }] } },
  fileIndex: 0, audioIndex: 0, audioMode: 'auto', media: {
    durationSeconds: 8, video: { codec, profile: codec === 'h264' ? 'High' : 'Main 10',
      pixelFormat: codec === 'h264' ? 'yuv420p' : 'yuv420p10le',
      bitDepth: codec === 'h264' ? 8 : 10,
      width: 160, height: 90, colorTransfer: 'bt709',
      colorPrimaries: 'bt709', colorSpace: 'bt709' },
    audioTracks: [{ codec: 'aac', channels: 2 }], compatibility: { video: { hdr: false } },
  } };
}

async function prepare(t, codec, {surround=false,bFrames=false}={}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lvl-progressive-owned-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const sid = '5c7de251-70a9-4e2b-8efc-c2df398b425a';
  const folder = path.join(root, sid);
  await mkdir(folder, { recursive: true });
  const input = path.join(folder, 'fixture.mkv');
  const result = spawnSync(ffmpeg, ['-hide_banner','-loglevel','error','-y',
    '-f','lavfi','-i','testsrc2=duration=8:size=160x90:rate=24',
    '-f','lavfi','-i','sine=frequency=330:duration=8',
    ...(surround?['-f','lavfi','-i','sine=frequency=880:duration=8']:[]),
    '-map','0:v:0','-map','1:a:0','-c:v',codec==='h264'?'libx264':'libx265',
    ...(surround?['-map','2:a:0']:[]),
    '-preset','ultrafast','-threads','2',
    ...(codec==='hevc'?['-x265-params','pools=1:frame-threads=1:log-level=error']:[]),
    '-g','24','-keyint_min','24','-sc_threshold','0','-bf',bFrames?'2':'0',
    '-pix_fmt',codec==='h264'?'yuv420p':'yuv420p10le',
    '-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709',
    '-c:a','aac','-ac:a:0','2',
    ...(surround?['-c:a:1','ac3','-ac:a:1','6']:[]),input], {timeout:20000});
  assert.equal(result.status,0,String(result.stderr).slice(-900));
  const params = source(sid,codec,(await stat(input)).size);
  if(surround){params.audioIndex=1;params.audioMode='surround';
    params.media.audioTracks.push({codec:'ac3',channels:6});}
  const info = progressiveIndexEligibility(params);
  assert.equal(info.eligible,true);
  return {root,input,params,info};
}

async function until(fn, name, timeout=12000) {
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){const result=await fn();if(result)return result;await new Promise(r=>setTimeout(r,20));}
  assert.fail('timed out: '+(typeof name==='function'?name():name));
}

test('admission requires fully verified whole H264/HEVC source, valid selected audio and exact identity',()=>{
  const p=source('5c7de251-70a9-4e2b-8efc-c2df398b425a','hevc',5000);
  const base=progressiveIndexEligibility(p);
  assert.equal(base.eligible,true);
  assert.equal(progressiveIndexEligibility({...p,session:{...p.session,torrent:{...p.session.torrent,bitfield:{get:()=>false}}}}).eligible,false);
  assert.equal(progressiveIndexEligibility({...p,media:{...p.media,video:{...p.media.video,hdrKind:'hdr10'}}}).eligible,false);
  assert.notEqual(base.key,progressiveIndexEligibility({...p,audioMode:'stereo'}).key);
});

test('optional GOP conversion suppresses auto-generated MP4 timecode/chapter tracks',async()=>{
  // Some real H264 MKVs automatically gain a third tmcd/text track in FFmpeg
  // despite explicit video/audio -map. This makes strict AVC/AAC init proof
  // fail closed before any GOP becomes ready. Preserve the suppression flags.
  const sourceText=await readFile(new URL('../backend/media/progressive-index-cache.js',import.meta.url),'utf8');
  const args=sourceText.slice(sourceText.indexOf('const args=['),sourceText.indexOf('const child=spawn(ffmpegPath,args'));
  assert.match(args,/'-map_metadata','-1','-map_chapters','-1','-write_tmcd','0'/);
  assert.match(args,/'-map','0:v:0','-map',`0:a:\$\{info\.identity\.audioIndex\}`/);
});

for(const codec of ['h264','hevc']){
  test(`real ${codec} selected episode publishes timestamp/IDR/AV-verified playable GOPs BEFORE conversion completes`,
    {skip:!ffmpeg||!ffprobe?.path,timeout:50000},async t=>{
      const f=await prepare(t,codec);
      let ffmpegClosed=false,slotStarts=0,slotCloses=0;
      const notices=[],diagnostics=[];
      const cache=createProgressiveIndexCache({sessionsRoot:f.root,
        ffmpegPath:ffmpeg,ffprobePath:ffprobe.path,enabled:()=>true,
        allowance:async()=>({allowed:true}),sourceUrl:()=>({url:f.input}),
        isCurrent:()=>true,foregroundBusy:()=>false,
        onSpawn:()=>{slotStarts++;diagnostics.push('spawn');},
        onClose:()=>{slotCloses++;ffmpegClosed=true;diagnostics.push('close');},
        onReady:window=>notices.push({...window,beforeClose:!ffmpegClosed}),
        onDiagnostic:why=>diagnostics.push(why),
        ffmpegInputArgs:['-readrate','3'],
      });
      t.after(()=>cache.stopAll());
      const job=cache.start(f.params);
      const first=await until(()=>notices[0],()=>`first GOP before EOS: ${codec} ${diagnostics.join(',')}`,5500);
      assert.equal(first.beforeClose,true,'ready section published while FFmpeg still converting future sections');
      assert.ok(first.start>=0 && first.end>first.start);
      assert.match(first.id,/^[a-f\d]{64}$/);
      const listed=await cache.status(f.params);
      assert.ok(listed.ranges?.length>=1,'read-only status exposes early ready interval');
      assert.equal(listed.complete,false,'partial GOP readiness is not whole-episode completion');
      assert.equal(first.independentlyDecodable,true);
      assert.equal(first.movieClockVerified,true);
      assert.equal(first.sourceVerified,true);
      assert.match(first.videoCodecString,/^avc1\.[a-f0-9]{6}$/);
      const leased=await cache.open(f.params,first.id);
      assert.ok(leased);
      try{
        assert.ok(leased.bytes>1000);
        const inspect=spawnSync(ffprobe.path,['-v','error','-show_streams','-show_packets',
          '-show_frames','-of','json',leased.file],{timeout:12000});
        assert.equal(inspect.status,0,String(inspect.stderr).slice(-1000));
        const data=JSON.parse(String(inspect.stdout));
        assert.equal(data.streams.filter(s=>s.codec_type==='video')[0].codec_name,'h264');
        assert.equal(data.streams.filter(s=>s.codec_type==='audio')[0].codec_name,'aac');
        const packets=data.packets||data.packets_and_frames.filter(s=>s.type==='packet');
        const frames=data.frames||data.packets_and_frames.filter(s=>s.type==='frame');
        assert.ok(packets.some(s=>s.codec_type==='video' && s.flags?.includes('K')));
        assert.ok(frames.some(s=>s.media_type==='video' && s.key_frame===1));
      } finally {await leased.release();}
      await job;
      const final=await cache.status(f.params);
      assert.equal(final.status,'ready',JSON.stringify(final.ranges.map(({start,end,sequence})=>({start,end,sequence}))));
      assert.equal(final.complete,true);
      assert.ok(final.ranges.length>1,'several GOPs remain independently available');
      assert.equal(slotStarts,1);assert.equal(slotCloses,1);
    });
}

test('cancellation retains already verified windows, stops process, preserves source bytes',
  {skip:!ffmpeg||!ffprobe?.path,timeout:40000},async t=>{
    const f=await prepare(t,'h264');
    let ready=0;
    const cache=createProgressiveIndexCache({sessionsRoot:f.root,
      ffmpegPath:ffmpeg,ffprobePath:ffprobe.path,
      enabled:()=>true,allowance:async()=>({allowed:true}),
      sourceUrl:()=>({url:f.input}),isCurrent:()=>true,
      ffmpegInputArgs:['-readrate','2'],onReady:()=>{ready++;}});
    t.after(()=>cache.stopAll());
    const initialBytes=(await stat(f.input)).size;
    const work=cache.start(f.params);
    await until(()=>ready>=1,'first published GOP');
    await cache.stopAll();await work;
    const snapshot=await cache.status(f.params);
    assert.ok(snapshot.ranges.length>=1,'finished GOP survives canceled later work');
    assert.equal(snapshot.status,'partial','canceled later work can never advertise whole-episode completion');
    assert.equal(snapshot.complete,false);
    assert.equal((await stat(f.input)).size,initialBytes);
  });

test('quota denial before spawn and during later GOP is fail-closed and never deletes the source',
  {skip:!ffmpeg||!ffprobe?.path,timeout:40000},async t=>{
    const f=await prepare(t,'h264');
    let starts=0;
    const rejected=createProgressiveIndexCache({sessionsRoot:f.root,
      ffmpegPath:ffmpeg,ffprobePath:ffprobe.path,
      enabled:()=>true,allowance:async()=>({allowed:false}),
      isCurrent:()=>true,onSpawn:()=>starts++});
    await rejected.start({...f.params,inputPath:f.input});
    assert.equal(starts,0);
    assert.equal((await rejected.status(f.params)).status,'waiting');
    let checks=0,ready=0;
    const limited=createProgressiveIndexCache({sessionsRoot:f.root,
      ffmpegPath:ffmpeg,ffprobePath:ffprobe.path,
      enabled:()=>true,allowance:async()=>({allowed:++checks<=2}),
      isCurrent:()=>true,ffmpegInputArgs:['-readrate','5'],
      onReady:()=>ready++});
    t.after(()=>limited.stopAll());
    await limited.start({...f.params,inputPath:f.input});
    const state=await limited.status(f.params);
    assert.equal(ready,1);
    assert.equal(state.status,'partial');
    assert.equal(state.complete,false);
    assert.equal((await stat(f.input)).size,f.params.session.torrent.files[0].length);
  });

test('failed Windows purge retries locked cache only, preserves source and prevents stale ready claims',
  {skip:!ffmpeg||!ffprobe?.path,timeout:30000},async t=>{
    const f=await prepare(t,'h264');
    let locked=true;
    const cache=createProgressiveIndexCache({sessionsRoot:f.root,
      ffmpegPath:ffmpeg,ffprobePath:ffprobe.path,enabled:()=>true,
      allowance:async()=>({allowed:true}),isCurrent:()=>true,
      ffmpegInputArgs:['-readrate','20'],purgeRetryMs:10,
      removeProgressiveDir:async(dir,options)=>{
        if(locked){const err=Error('active synthetic Windows Range reader');err.code='EPERM';throw err;}
        return rm(dir,options);
      }});
    t.after(()=>cache.stopAll());
    await cache.start({...f.params,inputPath:f.input});
    assert.ok((await cache.status(f.params)).ranges.length>0);
    await cache.purgeAll();
    assert.equal((await cache.status(f.params)).ranges.length,0,
      'pending purge must not advertise stale windows even when their files exist');
    locked=false;
    await until(async()=>{
      const folder=path.join(f.root,f.params.session.id,'progressive-index');
      try{await stat(folder);return false;}catch(e){return e.code==='ENOENT';}
    },'locked cache eventual removal',3000);
    assert.equal((await stat(f.input)).size,f.params.session.torrent.files[0].length);
  });

test('selected second 5.1 dub and resumed manifests preserve exact track and source identity',
  {skip:!ffmpeg||!ffprobe?.path,timeout:35000},async t=>{
    const f=await prepare(t,'h264',{surround:true,bFrames:true});
    let lastReady=null;
    const config={sessionsRoot:f.root,ffmpegPath:ffmpeg,ffprobePath:ffprobe.path,
      enabled:()=>true,allowance:async()=>({allowed:true}),isCurrent:()=>true};
    const cache=createProgressiveIndexCache({...config,
      ffmpegInputArgs:['-readrate','20'],onReady:range=>{lastReady=range;}});
    t.after(()=>cache.stopAll());
    await cache.start({...f.params,inputPath:f.input});
    assert.ok(lastReady,'B-frame H264 source should produce at least one self-decoding GOP');
    const warmed=await cache.status(f.params);
    assert.ok(warmed.ranges.length>=1);
    const fresh=createProgressiveIndexCache(config);
    const loaded=await fresh.status(f.params);
    assert.deepEqual(loaded.ranges,warmed.ranges,'persisted index reopens without starting FFmpeg');
    const segment=await fresh.openWindow(f.params,warmed.ranges[0].start+0.2);
    assert.ok(segment,'already-ready section is independently read-leaseable after process reload');
    try{
      const p=spawnSync(ffprobe.path,['-v','error','-show_streams','-of','json',segment.file],{timeout:15000});
      assert.equal(p.status,0,String(p.stderr));
      const streams=JSON.parse(String(p.stdout)).streams;
      assert.equal(streams.filter(s=>s.codec_type==='audio')[0].channels,6);
      assert.equal(streams.filter(s=>s.codec_type==='video')[0].codec_name,'h264');
    }finally{await segment.release();}
    assert.equal((await fresh.status({...f.params,audioIndex:0,audioMode:'stereo'})).ranges.length,0,
      'a different audio track cannot reuse the ready 5.1 window');
    assert.equal((await fresh.status({...f.params,session:{...f.params.session,
      infoHash:'a'.repeat(40)}})).ranges.length,0,
      'another torrent infohash cannot reuse the indexed windows');
  });
