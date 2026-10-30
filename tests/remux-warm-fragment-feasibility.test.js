// Isolated feasibility experiment for warm seeks. This deliberately does not
// integrate with the production cache/route: isolated fragments still need
// validated RAP, ownership, coverage, MSE and live-splice handling.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import ffprobe from 'ffprobe-static';
import { Readable } from 'node:stream';
import { once } from 'node:events';
import { createRemuxSegmentCache } from '../backend/media/remux-segment-cache.js';

const MP4_HEADER_MAX = 16;
function boxes(bytes, from = 0, to = bytes.length) {
  const result = [];
  for (let at = from; at < to;) {
    assert.ok(at + 8 <= to, 'complete MP4 atom header required');
    const shortSize = bytes.readUInt32BE(at);
    const header = shortSize === 1 ? MP4_HEADER_MAX : 8;
    assert.ok(at + header <= to, 'complete extended-size header required');
    const bigSize = shortSize === 1 ? bytes.readBigUInt64BE(at + 8) : BigInt(shortSize);
    assert.ok(bigSize >= BigInt(header) && bigSize <= BigInt(to - at), 'complete bounded atom required');
    const size = Number(bigSize);
    result.push({ type: bytes.toString('ascii', at + 4, at + 8), start: at, body: at + header, end: at + size });
    at += size;
  }
  return result;
}

function timescales(moov) {
  const result = new Map();
  for (const trak of boxes(moov, 8).filter(b => b.type === 'trak')) {
    const items = boxes(moov, trak.body, trak.end);
    const tkhd = items.find(b => b.type === 'tkhd');
    const mdia = items.find(b => b.type === 'mdia');
    assert.ok(tkhd && mdia);
    const mdhd = boxes(moov, mdia.body, mdia.end).find(b => b.type === 'mdhd');
    assert.ok(mdhd);
    const idAt = tkhd.body + (moov[tkhd.body] === 1 ? 20 : 12);
    const scaleAt = mdhd.body + (moov[mdhd.body] === 1 ? 20 : 12);
    const id = moov.readUInt32BE(idAt), scale = moov.readUInt32BE(scaleAt);
    assert.ok(id > 0 && scale > 0 && !result.has(id));
    result.set(id, scale);
  }
  assert.equal(result.size, 2, 'fixture requires distinct video and audio timebases');
  return result;
}

function videoTrackId(moov) {
  const tracks = boxes(moov, 8).filter(b => b.type === 'trak');
  for (const trak of tracks) {
    const mdia = boxes(moov, trak.body, trak.end).find(b => b.type === 'mdia');
    const hdlr = mdia && boxes(moov, mdia.body, mdia.end).find(b => b.type === 'hdlr');
    if (hdlr && moov.toString('ascii', hdlr.body + 8, hdlr.body + 12) === 'vide') {
      const tkhd = boxes(moov, trak.body, trak.end).find(b => b.type === 'tkhd');
      return moov.readUInt32BE(tkhd.body + (moov[tkhd.body] === 1 ? 20 : 12));
    }
  }
  throw Error('no verified video track');
}

function firstSampleFlags(moof, videoId) {
  // FullBox flags may locate first-sample flags in trun, or use tfhd defaults.
  // Unknown flags must not be promoted to a random-access point.
  for (const traf of boxes(moof, 8).filter(b => b.type === 'traf')) {
    const members = boxes(moof, traf.body, traf.end);
    const tfhd = members.find(b => b.type === 'tfhd');
    if (!tfhd || moof.readUInt32BE(tfhd.body + 4) !== videoId) continue;
    const tfhdFlags = moof.readUInt32BE(tfhd.body) & 0xffffff;
    let offset = tfhd.body + 8;
    if (tfhdFlags & 0x1) offset += 8;
    if (tfhdFlags & 0x2) offset += 4;
    if (tfhdFlags & 0x8) offset += 4;
    if (tfhdFlags & 0x10) offset += 4;
    let defaults = null;
    if (tfhdFlags & 0x20) {
      assert.ok(offset + 4 <= tfhd.end);
      defaults = moof.readUInt32BE(offset);
    }
    const trun = members.find(b => b.type === 'trun');
    assert.ok(trun);
    const flags = moof.readUInt32BE(trun.body) & 0xffffff;
    assert.ok(moof.readUInt32BE(trun.body + 4) > 0, 'nonempty sample run');
    let runOffset = trun.body + 8;
    if (flags & 0x1) runOffset += 4;
    if (flags & 0x4) return { flags: moof.readUInt32BE(runOffset), at: runOffset };
    if (flags & 0x100) runOffset += 4;
    if (flags & 0x200) runOffset += 4;
    if (flags & 0x400) return { flags: moof.readUInt32BE(runOffset), at: runOffset };
    return { flags: defaults, at: null };
  }
  return { flags: null, at: null }; // audio-only moof, never a video RAP
}

function isRap(first) {
  if (first.flags == null) return false;
  const dependsOn = (first.flags >>> 24) & 0x3;
  const nonSync = (first.flags & 0x10000) !== 0;
  return dependsOn === 2 && !nonSync;
}

function fragmentTracks(moof, scales, requireAV) {
  const tracks = [];
  for (const traf of boxes(moof, 8).filter(b => b.type === 'traf')) {
    const children = boxes(moof, traf.body, traf.end);
    const tfhd = children.find(b => b.type === 'tfhd');
    const tfdt = children.find(b => b.type === 'tfdt');
    const trun = children.find(b => b.type === 'trun');
    assert.ok(tfhd && tfdt && trun);
    const id = moof.readUInt32BE(tfhd.body + 4);
    const scale = scales.get(id);
    assert.ok(scale);
    const version = moof[tfdt.body];
    assert.ok(version === 0 || version === 1);
    const at = tfdt.body + 4;
    const decode = version === 1 ? moof.readBigUInt64BE(at) : BigInt(moof.readUInt32BE(at));
    tracks.push({ id, scale, version, at, decode, trun });
  }
  assert.ok(tracks.length > 0, 'a fragment must contain a recognized media track');
  if (requireAV) assert.equal(tracks.length, 2, 'this GOP fixture needs both A/V tracks');
  return tracks;
}

function atomizedMovie(data, {requireAV = true} = {}) {
  const top = boxes(data);
  const firstMoof = top.findIndex(b => b.type === 'moof');
  assert.ok(firstMoof > 0);
  const moov = top.find(b => b.type === 'moov');
  assert.ok(moov && moov.end <= top[firstMoof].start);
  const init = data.subarray(0, top[firstMoof].start);
  const moovBytes = data.subarray(moov.start, moov.end);
  const scales = timescales(moovBytes), videoId = videoTrackId(moovBytes);
  const fragments = [];
  for (let i = firstMoof; i + 1 < top.length; i++) {
    if (top[i].type !== 'moof') continue;
    assert.equal(top[i + 1].type, 'mdat', 'only complete adjacent moof+mdat is an eligible fragment');
    const moof = data.subarray(top[i].start, top[i].end);
    fragments.push({ begin: top[i].start, end: top[i + 1].end,
      firstSample: firstSampleFlags(moof,videoId),
      tracks: fragmentTracks(moof, scales, requireAV) });
  }
  assert.ok(fragments.length >= 4, 'need several independent GOPs');
  return { init, fragments };
}

function sliceFragments(data, movie, begin, count, rebase) {
  assert.ok(begin >= 0 && count >= 1 && begin + count <= movie.fragments.length);
  const selected = movie.fragments.slice(begin, begin + count);
  assert.ok(isRap(selected[0].firstSample), 'window must start on verified independent RAP');
  for (let i = 1; i < selected.length; i++) {
    assert.equal(selected[i - 1].end, selected[i].begin, 'missing byte coverage is forbidden');
    for (const track of selected[i].tracks) {
      const before = selected[i - 1].tracks.find(x => x.id === track.id);
      assert.ok(before && track.decode >= before.decode, 'must not move decode clocks backward');
    }
  }
  const commonClock = Math.min(...selected[0].tracks.map(t => Number(t.decode) / t.scale));
  const output = [movie.init];
  for (const fragment of selected) {
    const bytes = Buffer.from(data.subarray(fragment.begin, fragment.end));
    if (rebase) for (const track of fragment.tracks) {
      // Shift all track clocks by the SAME time; independently zeroing each
      // track would silently destroy A/V skew. Round toward zero and fail on
      // underflow. Production must bound the rounding error and precision.
      const shift = BigInt(Math.floor(commonClock * track.scale));
      assert.ok(track.decode >= shift);
      const delta = track.decode - shift;
      const at = track.at;
      if (track.version === 1) bytes.writeBigUInt64BE(delta, at);
      else {
        assert.ok(delta <= 0xffffffffn);
        bytes.writeUInt32BE(Number(delta), at);
      }
    }
    output.push(bytes);
  }
  return { data: Buffer.concat(output), commonClock };
}

function run(binary, args, maxBuffer = 48 * 1024 * 1024) {
  const result = spawnSync(binary, args, { windowsHide: true, encoding: null,
    timeout: 45000, maxBuffer });
  assert.equal(result.status, 0, `${result.error?.message || ''} ${String(result.stderr).slice(-1000)}`);
  return result.stdout;
}
function probe(file, args) {
  return JSON.parse(run(ffprobe.path, ['-v','error', ...args, '-of','json',file]).toString());
}
function decodedFrames(file) {
  const data = run(ffmpeg, ['-v','error','-i',file,'-map','0:v:0',
    '-f','framemd5','-'], 10 * 1024 * 1024).toString();
  return data.split(/\r?\n/).filter(line => /^0,/.test(line)).map(line => line.split(',').at(-1).trim());
}
function fixture(directory, codec, {everyFrame = false} = {}) {
  const file = path.join(directory, `${codec}${everyFrame ? '-every-frame' : ''}.mp4`);
  const hevc = codec === 'hevc';
  run(ffmpeg, ['-v','error','-nostdin','-y',
    '-f','lavfi','-i','testsrc2=size=96x64:rate=10:duration=6',
    '-f','lavfi','-i','sine=frequency=750:sample_rate=48000:duration=6',
    '-map','0:v:0','-map','1:a:0',
    '-c:v',hevc ? 'libx265' : 'libx264', '-threads','2',
    ...(hevc ? ['-pix_fmt','yuv420p10le','-x265-params',
      'pools=none:frame-threads=1:log-level=error:keyint=10:min-keyint=10:scenecut=0',
      '-tag:v','hvc1','-color_primaries','bt2020','-color_trc','smpte2084',
      '-colorspace','bt2020nc'] : ['-pix_fmt','yuv420p','-g','10','-keyint_min','10','-sc_threshold','0']),
    '-c:a','aac','-b:a','96k','-avoid_negative_ts','make_zero',
    '-movflags',`${everyFrame ? 'frag_every_frame' : 'frag_keyframe'}+empty_moov+default_base_moof`,'-f','mp4',file]);
  return file;
}

for (const codec of ['h264','hevc']) test(`synthetic ${codec} fMP4: contiguous middle GOPs with shared clock rebase decode without video or audio drift`,
  { timeout: 90000 }, t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lvl-warm-fragment-proof-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const full = fixture(directory, codec);
    const bytes = fs.readFileSync(full), movie = atomizedMovie(bytes);
    const subset = movie.fragments.slice(2, 4);
    assert.equal(subset.length, 2);
    assert.ok(subset.every(fragment => isRap(fragment.firstSample)),
      'each output fragment begins at independent video random access');
    const unshifted = sliceFragments(bytes,movie,2,2,false);
    const shifted = sliceFragments(bytes,movie,2,2,true);
    const originalWindow = path.join(directory,'late-original.mp4');
    const rebasedWindow = path.join(directory,'late-rebased.mp4');
    fs.writeFileSync(originalWindow,unshifted.data);
    fs.writeFileSync(rebasedWindow,shifted.data);
    const origV = probe(full,['-select_streams','v:0','-show_entries','packet=pts_time,dts_time,flags','-show_packets']).packets;
    const lateV = probe(originalWindow,['-select_streams','v:0','-show_entries','packet=pts_time,dts_time,flags','-show_packets']).packets;
    const shiftV = probe(rebasedWindow,['-select_streams','v:0','-show_entries','packet=pts_time,dts_time,flags','-show_packets']).packets;
    const origA = probe(originalWindow,['-select_streams','a:0','-show_entries','packet=pts_time,dts_time','-show_packets']).packets;
    const shiftA = probe(rebasedWindow,['-select_streams','a:0','-show_entries','packet=pts_time,dts_time','-show_packets']).packets;
    assert.ok(lateV.length >= 12 && origA.length > 50);
    assert.ok(lateV[0].flags.startsWith('K'), 'selected middle fragment actually starts on a RAP');
    assert.equal(shiftV.length,lateV.length,'no dropped video packets after rebasing');
    assert.equal(shiftA.length,origA.length,'no dropped audio packets after rebasing');
    for (const [before,after] of [[lateV,shiftV],[origA,shiftA]]) for (let i=0;i<before.length;i++) {
      assert.ok(Math.abs((Number(before[i].pts_time)-Number(after[i].pts_time))-shifted.commonClock) < 0.00004,
        'rebasing changes PTS by the same common clock for every video/audio packet');
      assert.ok(Math.abs((Number(before[i].dts_time)-Number(after[i].dts_time))-shifted.commonClock) < 0.00004,
        'rebasing changes DTS by the same common clock for every video/audio packet');
    }
    assert.ok(Number(lateV[0].pts_time) > 1.5,'the unrebased prefix has a later MP4 timeline');
    assert.ok(Math.abs(Number(shiftV[0].dts_time)) < 0.25,'rebased GOP is near relative zero');
    const wholeHashes = decodedFrames(full), lateHashes = decodedFrames(originalWindow), shiftedHashes = decodedFrames(rebasedWindow);
    assert.deepEqual(shiftedHashes,lateHashes,'all selected frames decode identically after rebasing');
    assert.ok(wholeHashes.join(',').includes(lateHashes.slice(0,8).join(',')),
      'middle subset contains the exact decoded source frames');
    const v = probe(rebasedWindow,['-select_streams','v:0','-show_entries',
      'stream=codec_name,pix_fmt,color_primaries,color_transfer','-show_streams']).streams[0];
    assert.equal(v.codec_name, codec === 'hevc' ? 'hevc' : 'h264');
    if (codec === 'hevc') {
      assert.equal(v.pix_fmt,'yuv420p10le');
      assert.equal(v.color_primaries,'bt2020');
      assert.equal(v.color_transfer,'smpte2084');
    }
    assert.equal(origV.filter(p => p.flags.startsWith('K')).length >= 4, true);
  });

test('warm reconstruction refuses holes and uncommitted tail atoms', { timeout: 90000 }, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lvl-warm-reject-proof-'));
  t.after(() => fs.rmSync(directory,{recursive:true,force:true}));
  const file = fixture(directory,'h264');
  const bytes = fs.readFileSync(file), movie = atomizedMovie(bytes);
  const hole = { ...movie, fragments:movie.fragments.map(f => ({ ...f })) };
  hole.fragments[3].begin++;
  assert.throws(() => sliceFragments(bytes,hole,2,2,true),/missing byte coverage/);
  const unknownRap = { ...movie, fragments:movie.fragments.map(f => ({ ...f })) };
  unknownRap.fragments[2].firstSample = { flags: 0x1010000 };
  assert.throws(() => sliceFragments(bytes,unknownRap,2,2,true),/verified independent RAP/);
  const uncommitted = bytes.subarray(0,movie.fragments[3].end-1);
  assert.throws(() => boxes(uncommitted),/complete bounded atom/);
});

test('genuine middle-frame fragments must fail random-access validation', { timeout: 90000 }, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lvl-warm-rap-reject-'));
  t.after(() => fs.rmSync(directory,{recursive:true,force:true}));
  const file = fixture(directory,'h264',{everyFrame:true});
  const bytes = fs.readFileSync(file), movie = atomizedMovie(bytes, {requireAV:false});
  const nonRap = movie.fragments.findIndex((fragment,index) => index > 1 &&
    !isRap(fragment.firstSample));
  assert.ok(nonRap > 0, 'fragment boundaries are not automatically sync samples');
  assert.throws(() => sliceFragments(bytes,movie,nonRap,1,true),/verified independent RAP/);
});

test('active recorder offers private bounded H264 RAP windows and retains leased bytes through session deletion',
  { timeout: 90000 }, async t => {
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'lvl-warm-reader-'));
    t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
    const sid='99f137aa-ae45-46df-97de-f2c907d1641c';
    const groupDir=path.join(directory,sid);
    const sourceIdentity='synthetic-source-only';
    const cache=createRemuxSegmentCache({sessionsRoot:directory,enabled:()=>true,
      allowance:async()=>({allowed:true,availableBytes:10**9})});
    const identity={sessionId:sid,sourceIdentity,fileIndex:1,startSeconds:0,
      effectiveStartSeconds:0,videoMode:'copy',audioMode:'aac',audioTrack:1,
      videoCodec:'h264',audioCodec:'aac',audioChannels:2};
    const recorder=cache.begin(identity);
    assert.match(recorder.producerToken,/^[a-f0-9]{48}$/);
    const full=fixture(directory,'h264');
    const original=fs.readFileSync(full);
    const output=Readable.from((function*(){
      for(let i=0;i<original.length;i+=257)yield original.subarray(i,i+257);
    })()).pipe(recorder.transform);
    output.resume();
    await once(output,'end');
    let window=null;
    for(let attempt=0;attempt<40&&!window;attempt++){
      window=await cache.lookupWarmWindow({sessionId:sid,sourceIdentity,fileIndex:1,
        producerToken:recorder.producerToken,startSeconds:2.34});
      if(!window)await new Promise(resolve=>setTimeout(resolve,5));
    }
    assert.ok(window,'complete committed GOPs must be readable while producer is active');
    assert.ok(window.bytes>0&&window.bytes<=16*1024*1024);
    assert.ok(window.windowStartSeconds<=2.34&&window.windowEndSeconds>2.34);
    assert.equal(window.baseSeconds,0);
    assert.equal(window.sourceGeneration,recorder.producerToken);
    assert.equal(await cache.lookupWarmWindow({sessionId:sid,sourceIdentity:'wrong',fileIndex:1,
      producerToken:recorder.producerToken,startSeconds:2.34}),null);
    assert.equal(await cache.lookupWarmWindow({sessionId:sid,sourceIdentity,fileIndex:2,
      producerToken:recorder.producerToken,startSeconds:2.34}),null);
    assert.equal(await cache.lookupWarmWindow({sessionId:sid,sourceIdentity,fileIndex:1,
      producerToken:'0'.repeat(48),startSeconds:2.34}),null);
    const segments=[];
    for(const range of window.ranges){
      const segment=Buffer.alloc(range.end-range.start+1);
      const {bytesRead}=await window.handle.read(segment,0,segment.length,range.start);
      assert.equal(bytesRead,segment.length);
      segments.push(segment);
    }
    assert.equal(Buffer.concat(segments).length,window.bytes);
    const warmFile=path.join(directory,'warm-reader.mp4');
    fs.writeFileSync(warmFile,Buffer.concat(segments));
    const packets=probe(warmFile,['-select_streams','v:0','-show_packets',
      '-show_entries','packet=pts_time,flags']).packets;
    assert.ok(packets.length>0&&packets[0].flags.startsWith('K'));
    assert.ok(decodedFrames(warmFile).length>0);
    await cache.dropSession(sid);
    assert.ok(fs.readdirSync(groupDir).some(name=>name.startsWith('.lvl-remux-')),
      'leased Windows file handle defers cache directory deletion');
    assert.equal(await cache.lookupWarmWindow({sessionId:sid,sourceIdentity,fileIndex:1,
      producerToken:recorder.producerToken,startSeconds:2.34}),null);
    await window.release();
    await window.release();
    await recorder.finish({success:false});
    assert.deepEqual(fs.readdirSync(groupDir),[],
      'last reader lease closes and completes deferred cache cleanup');
  });
