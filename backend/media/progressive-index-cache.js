/**
 * Optional progressive, independently readable H.264/AAC fMP4 GOP cache.
 *
 * INTEGRATION (not connected to the live server by this module):
 *   const cache = createProgressiveIndexCache({sessionsRoot: torrentRoot,
 *     ffmpegPath, ffprobePath, enabled: () => storage.limits().remuxCacheEnabled,
 *     allowance: bytes => storage.playerCacheAllowance({additionalBytes:bytes}),
 *     isCurrent: identity => /* session+source+audio still current * / true,
 *     foregroundBusy: () => activeTranscodes.size >= MAX_TRANSCODE_JOBS,
 *     onSpawn: child => activeTranscodes.add(child),
 *     onClose: child => activeTranscodes.delete(child),
 *     onReady: window => /* notify status update; NO unverified seek claim * / null });
 *   const params = {session,fileIndex,media,audioIndex,audioMode,
 *     inputPath: safeAbsoluteLocalPathInsideThisSession};
 *   cache.start(params);                     // explicit async opt-in, never HEAD
 *   await cache.status(params);              // READ ONLY: {status,ranges:[{id,start,end,...}]}
 *   const reader = await cache.open(params, sectionId); // pinned {handle,file,bytes,...,release}
 *   // Serve reader.handle via bounded GET, close on HTTP completion/abort.
 *
 * Every ready range is one separately FFprobe-validated init+complete moof/mdat
 * (no native 206 on an unfinished whole-episode MP4). Video packets and decoded
 * frames MUST begin with H.264 IDR. AAC, track count/channels, real time stamps,
 * disk quota and exact source identity are checked BEFORE the index is committed.
 * Never use byte-download percentages as video time or seek readiness. Each GOP
 * is bounded at its actual decoded end; crossing a gap requires a new window.
 * The caller must independently keep its MediaSource codec/init/epoch and audio
 * clocks compatible across windows; this module does not change a video element.
 *
 * Initial stage only admits WHOLE, BitTorrent-hash-verified local H264 8-bit SDR
 * or HEVC Main10 SDR; partial-source verified-piece provenance is not yet solved.
 * A local absolute file path under sessionsRoot/<sessionUUID> is mandatory:
 * FFmpeg must not fetch peers/network input during optional background work.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn as systemSpawn } from 'node:child_process';
import { indexedCacheEligibility } from './indexed-video-cache.js';
import { isTorrentFileFullyVerified } from './verified-torrent-file.js';
import { verifyTorrentFileByteRange } from './verified-torrent-range.js';

const MAX_ATOM = 32 * 1024 * 1024;
const MAX_INIT = 4 * 1024 * 1024;
const MAX_WINDOW = 32 * 1024 * 1024;
const MAX_WINDOWS = 7200;
const MAX_PROBE_JSON = 4 * 1024 * 1024;
const MAX_VERIFY_FILES_PARALLEL = 16;
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const HEX = /^[a-f\d]{64}$/;
const AVC = /^avc1\.[a-f\d]{6}$/i;
const EMPTY = Object.freeze([]);
const RELEASED = Symbol('cancelled');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const finite = value => Number.isFinite(value) && value >= 0;

export function progressiveIndexEligibility(params, verifiedSource=null) {
  let base = indexedCacheEligibility(params);
  let sourceMode='complete';
  let prefixEvidence=null;
  if(verifiedSource&&(base.eligible||base.reason==='source-incomplete')){
    // Reuse the exact conservative codec/audio/HDR policy by making a verified
    // PREFIX logical file view. This does not mutate the actual torrent file;
    // the independent bitfield inspector proved every overlapping SHA1 piece.
    // Only the logical prefix has `.done`, never the real incomplete torrent.
    const proof=verifiedSource.inspect(params);
    const file=params.session?.torrent?.files?.[params.fileIndex];
    if(!proof?.eligible||!file){
      if(!base.eligible)return {eligible:false,reason:'verified-prefix-unavailable'};
    }else{
    const viewFiles=[...params.session.torrent.files];
    viewFiles[params.fileIndex]={...file,length:proof.verifiedPrefix.bytes,
      downloaded:proof.verifiedPrefix.bytes,done:true};
    const viewSession={...params.session,torrent:{...params.session.torrent,files:viewFiles}};
    base=indexedCacheEligibility({...params,session:viewSession});
    if(!base.eligible)return base;
    prefixEvidence=proof;sourceMode='verified-prefix';
    }
  }
  if (!base.eligible) return base;
  const originalFile=params.session?.torrent?.files?.[params.fileIndex];
  const identity = { ...base.identity,
    ...(sourceMode==='verified-prefix'?{sourceLength:originalFile.length,
      sourceMode:'verified-prefix'}:{}),
    // New identity namespace fails closed on legacy windows without their
    // content hash and strict per-fragment verification metadata.
    cacheVersion: 'progressive-index-h264-avc-aac-hashed-gop-v2',
  };
  const sourceVerified=sourceMode==='verified-prefix'
    ?()=>{
      if(prefixEvidence.sourceComplete)
        return isTorrentFileFullyVerified(params.session?.torrent,params.fileIndex);
      const limit=prefixEvidence.verifiedPrefix.end;
      return verifyTorrentFileByteRange(params.session?.torrent,params.fileIndex,
        {start:0,end:limit}).verified===true;
    }:base.sourceVerified;
  return {eligible:true,identity,key:hash(JSON.stringify(identity)),sourceVerified,
    torrent:params.session?.torrent,
    verifiedSourceBytes:prefixEvidence?.verifiedPrefix.bytes||identity.sourceLength,
    sourceFullyVerified:sourceMode==='complete'||prefixEvidence?.sourceComplete===true,
    sourceMode,
    verifySection:sourceMode==='verified-prefix'
      ?item=>Number.isSafeInteger(item?.sourceByteEnd)
        &&item.sourceByteEnd>=0&&item.sourceByteEnd<identity.sourceLength
        &&verifyTorrentFileByteRange(params.session?.torrent,params.fileIndex,
          {start:0,end:item.sourceByteEnd}).verified===true
      :()=>true};
}

function boxes(bytes, from=8, to=bytes.length) {
  const result=[];
  for(let i=from;i<to;) {
    if(i+8>to)return null;
    const size=bytes.readUInt32BE(i),name=bytes.toString('ascii',i+4,i+8);
    const wide=size===1;
    if(wide && i+16>to)return null;
    const length=wide?Number(bytes.readBigUInt64BE(i+8)):size;
    const header=wide?16:8;
    if(!Number.isSafeInteger(length)||length<header||i+length>to)return null;
    result.push({name,start:i,end:i+length,body:i+header});i+=length;
  }
  return result;
}

function avcTrack(init) {
  // Read AVC DecoderConfigurationRecord, video track ID and NAL length size
  // from actual moov. FFprobe's key_frame flag alone cannot prove an IDR.
  const header=boxes(init,0);
  const moov=header?.find(b=>b.name==='moov');
  if(!moov)return null;
  const children=boxes(init,moov.body,moov.end);
  if(!children?.some(b=>b.name==='mvex'))return null;
  let video=null,audioCount=0;
  for(const trak of children.filter(b=>b.name==='trak')) {
    const items=boxes(init,trak.body,trak.end);
    const mdia=items?.find(b=>b.name==='mdia');
    const tkhd=items?.find(b=>b.name==='tkhd');
    if(!mdia||!tkhd)return null;
    const mdias=boxes(init,mdia.body,mdia.end);
    const hdlr=mdias?.find(b=>b.name==='hdlr');
    const mdhd=mdias?.find(b=>b.name==='mdhd');
    if(!hdlr||!mdhd)return null;
    const kind=init.toString('ascii',hdlr.body+8,hdlr.body+12);
    if(kind==='soun'){audioCount++;continue;}
    if(kind!=='vide'||video)return null;
    const idAt=tkhd.body+(init[tkhd.body]===1?20:12);
    const scaleAt=mdhd.body+(init[mdhd.body]===1?20:12);
    if(idAt+4>tkhd.end||scaleAt+4>mdhd.end)return null;
    const id=init.readUInt32BE(idAt),timescale=init.readUInt32BE(scaleAt);
    const minf=mdias.find(b=>b.name==='minf');
    const stbl=minf&&boxes(init,minf.body,minf.end)?.find(b=>b.name==='stbl');
    const stsd=stbl&&boxes(init,stbl.body,stbl.end)?.find(b=>b.name==='stsd');
    const sample=stsd&&boxes(init,stsd.body+8,stsd.end)?.[0];
    if(!id||!timescale||!sample||sample.name!=='avc1')return null;
    const avcc=boxes(init,sample.body+78,sample.end)?.find(b=>b.name==='avcC');
    if(!avcc||avcc.body+5>avcc.end)return null;
    const nalLength=(init[avcc.body+4]&3)+1;
    if(![1,2,3,4].includes(nalLength))return null;
    const codecString='avc1.'+init.subarray(avcc.body+1,avcc.body+4).toString('hex');
    video={id,timescale,nalLength,codecString};
  }
  return video&&audioCount===1?video:null;
}

function fragmentVideoRAP(moof,mdat,track) {
  const top=boxes(moof,0);
  const trafs=top&&boxes(moof,top[0].body,top[0].end);
  if(!top||top.length!==1||top[0].name!=='moof'||!trafs)return null;
  let chosen=null;
  for(const traf of trafs.filter(x=>x.name==='traf')) {
    const items=boxes(moof,traf.body,traf.end);
    const tfhd=items?.find(x=>x.name==='tfhd');
    const trun=items?.find(x=>x.name==='trun');
    const tfdt=items?.find(x=>x.name==='tfdt');
    if(!tfhd||!trun||!tfdt)return null;
    if(moof.readUInt32BE(tfhd.body+4)!==track.id)continue;
    if(chosen)return null;
    const tfhdFlags=moof.readUInt32BE(tfhd.body)&0xffffff;
    const trunFlags=moof.readUInt32BE(trun.body)&0xffffff;
    if((tfhdFlags&1)||!(tfhdFlags&0x20000)||!(trunFlags&1)
      ||!moof.readUInt32BE(trun.body+4))return null;
    let at=tfhd.body+8;
    if(tfhdFlags&2)at+=4;
    if(tfhdFlags&8)at+=4;
    let defaultSize=null,defaultFlags=null;
    if(tfhdFlags&16){defaultSize=moof.readUInt32BE(at);at+=4;}
    if(tfhdFlags&32)defaultFlags=moof.readUInt32BE(at);
    at=trun.body+8;
    const dataOffset=moof.readInt32BE(at);at+=4;
    let flags=defaultFlags;
    if(trunFlags&4){flags=moof.readUInt32BE(at);at+=4;}
    if(trunFlags&0x100)at+=4;
    let size=defaultSize;
    if(trunFlags&0x200){size=moof.readUInt32BE(at);at+=4;}
    if(trunFlags&0x400)flags=moof.readUInt32BE(at);
    if(flags==null||((flags>>>24)&3)!==2||(flags&0x10000)
      ||!Number.isSafeInteger(size)||size<5||size>512*1024)return null;
    // data-offset references the full moof+mdat pair; reject any missing bytes.
    const pair=Buffer.concat([moof,mdat]);
    if(dataOffset<moof.length+8||dataOffset+size>pair.length)return null;
    const sample=pair.subarray(dataOffset,dataOffset+size);
    let idr=false;
    for(let i=0;i+track.nalLength<sample.length;) {
      const length=sample.readUIntBE(i,track.nalLength);i+=track.nalLength;
      if(length<1||i+length>sample.length)return null;
      const kind=sample[i]&31;
      if(kind===1)return null;
      if(kind===5){idr=true;break;}
      i+=length;
    }
    if(!idr)return null;
    const version=moof[tfdt.body];
    if(version!==0&&version!==1)return null;
    const decodeAt=tfdt.body+4;
    if(decodeAt+(version===1?8:4)>tfdt.end)return null;
    const units=version===1?Number(moof.readBigUInt64BE(decodeAt)):moof.readUInt32BE(decodeAt);
    if(!Number.isSafeInteger(units))return null;
    chosen={decodeSeconds:units/track.timescale};
  }
  return chosen;
}

class AtomParser {
  constructor(maxWindowBytes,onReject=()=>{}){this.pending=Buffer.alloc(0);this.init=[];this.initBytes=0;
    this.moof=null;this.track=null;this.onReject=onReject;
    this.maxWindowBytes=maxWindowBytes;this.sectionIndex=0;}
  feed(chunk) {
    if(this.pending.length+chunk.length>this.maxWindowBytes+MAX_INIT+MAX_ATOM)
      throw Error('MP4 parser memory cap');
    this.pending=Buffer.concat([this.pending,chunk]);
    const completed=[];
    while(this.pending.length>=8){
      const raw=this.pending.readUInt32BE(0),wide=raw===1;
      if(wide&&this.pending.length<16)break;
      const size=wide?Number(this.pending.readBigUInt64BE(8)):raw;
      const kind=this.pending.toString('ascii',4,8);
      if(!Number.isSafeInteger(size)||size<(wide?16:8)||size>MAX_ATOM)throw Error('Invalid MP4 atom');
      if(this.pending.length<size)break;
      const box=this.pending.subarray(0,size);
      this.pending=this.pending.subarray(size);
      if(!this.track){
        if(!['ftyp','moov','free'].includes(kind)||this.initBytes+size>MAX_INIT)
          throw Error('Unexpected MP4 init');
        this.init.push(box);this.initBytes+=size;
        if(kind==='moov'){
          const init=Buffer.concat(this.init,this.initBytes);
          this.track=avcTrack(init);
          if(!this.track)throw Error('Unsupported AVC/AAC MP4 init');
          this.init=init;
        }
      }else if(kind==='moof'){
        if(this.moof)throw Error('Unpaired media fragment');
        this.moof=box;
      }else if(kind==='mdat'){
        if(!this.moof)throw Error('Media atom missing fragment');
        const moof=this.moof;this.moof=null;
        const bytes=this.init.length+moof.length+box.length;
        if(bytes>this.maxWindowBytes)throw Error('GOP window byte cap');
        const rap=fragmentVideoRAP(moof,box,this.track);
        if(rap)completed.push({ bytes:Buffer.concat([this.init,moof,box],bytes),
          initHash:hash(this.init),videoCodecString:this.track.codecString,
          rap,sequence:this.sectionIndex });
        else this.onReject?.('fragment-no-idr');
        this.sectionIndex++;
      }else if(!['styp','free','sidx','mfra'].includes(kind)||this.moof){
        throw Error('Unexpected fragment atom');
      }
    }
    return completed;
  }
}

async function probeWindow(ffprobePath, spawn, file, job) {
  if(job.cancelled)return null;
  let child;
  try{child=spawn(ffprobePath,['-v','error','-show_streams','-show_packets',
    '-show_frames','-of','json',file],{windowsHide:true,stdio:['ignore','pipe','pipe']});}
  catch{return null;}
  job.probe=child;
  let output='',stderr='',failed=false,timeout;
  const exit=new Promise(resolve=>{
    child.stdout?.on('data',block=>{
      if(failed)return;
      if(output.length+block.length>MAX_PROBE_JSON){
        failed=true;try{child.kill('SIGTERM');}catch{}
        return;
      }
      output+=String(block);
    });
    child.stderr?.on('data',chunk=>{if(stderr.length<1024)stderr+=String(chunk).slice(0,1024-stderr.length);});
    child.once('error',()=>{failed=true;});
    child.once('close',code=>resolve(code));
  });
  timeout=setTimeout(()=>{failed=true;try{child.kill('SIGKILL');}catch{}},12000);
  timeout.unref?.();
  if(job.cancelled)try{child.kill('SIGTERM');}catch{}
  const code=await exit;
  clearTimeout(timeout);job.probe=null;
  if(code!==0||failed||job.cancelled)return null;
  try{return {...JSON.parse(output),__probeWarnings:stderr};}catch{return null;}
}

function verifiedWindow(probe,info,rap) {
  const streams=Array.isArray(probe?.streams)?probe.streams:EMPTY;
  const video=streams.filter(s=>s.codec_type==='video');
  const audio=streams.filter(s=>s.codec_type==='audio');
  // When both -show_packets AND -show_frames are requested, FFprobe emits one
  // `packets_and_frames` array with `type`, not separate arrays. Missing this
  // distinction caused the genuine RED fixture to fail closed for every GOP.
  const combined=probe?.packets_and_frames||EMPTY;
  const frames=probe?.frames||combined.filter(x=>x.type==='frame');
  const packets=probe?.packets||combined.filter(x=>x.type==='packet');
  const vframes=frames.filter(f=>f.media_type==='video');
  const vpackets=packets.filter(p=>p.codec_type==='video');
  const apackets=packets.filter(p=>p.codec_type==='audio');
  if(video.length!==1||audio.length!==1||video[0].codec_name!=='h264'
    ||video[0].pix_fmt!=='yuv420p'||audio[0].codec_name!=='aac'
    ||Number(audio[0].channels)!==info.identity.channels
    ||Number(video[0].width)!==info.identity.videoWidth
    ||Number(video[0].height)!==info.identity.videoHeight
    ||vframes.length<1||vpackets.length<1||apackets.length<1
    ||Number(vframes[0].key_frame)!==1
    ||!String(vpackets[0].flags||'').includes('K'))return null;
  const first=Number(vframes[0].best_effort_timestamp_time);
  const starts=vpackets.map(p=>Number(p.pts_time));
  // FFprobe often does not emit `duration_time` for fragmented video packets.
  // The last *actually decoded* presented-frame timestamp is therefore the
  // conservative ready bound. Never invent one frame's future duration.
  const frameTimes=vframes.map(f=>Number(f.best_effort_timestamp_time));
  const audioStarts=apackets.map(p=>Number(p.pts_time));
  if(!finite(first)||!starts.every(finite)||!frameTimes.every(finite)
    ||!audioStarts.every(a=>Number.isFinite(a)&&a>=-0.1)
    ||!Number.isFinite(rap.decodeSeconds))return null;
  const start=Math.min(first,...starts);
  const end=Math.max(...frameTimes);
  if(!finite(start)||!finite(end)||end<=start+0.05||end-start>60
    ||Math.abs(start-rap.decodeSeconds)>2
    ||end>info.identity.duration+1
    ||Math.min(...audioStarts)>end+0.1||Math.max(...audioStarts)<start-0.2)return null;
  return {start:+start.toFixed(5),end:+end.toFixed(5),mediaStart:+first.toFixed(5),
    baseSeconds:0,seekOffsetSeconds:0,
    decodedVideoFrames:vframes.length,firstAudioPTS:Math.min(...audioStarts)};
}

export function createProgressiveIndexCache({sessionsRoot,ffmpegPath,ffprobePath,
  enabled=()=>false,allowance=async()=>({allowed:false}),sourceUrl=null,
  verifiedSource=null,
  isCurrent=()=>false,foregroundBusy=()=>false,spawn=systemSpawn,
  onSpawn=()=>{},onClose=()=>{},onReady=()=>{},
  onDiagnostic=()=>{},
  maxWindowBytes=MAX_WINDOW,maxWindows=MAX_WINDOWS,
  ffmpegInputArgs=EMPTY,
  removeProgressiveDir=(dir,options)=>fs.rm(dir,options),purgeRetryMs=2000,
  maxWallMs=2*60*60*1000,maxIdleMs=90_000,
}={}) {
  if(!path.isAbsolute(sessionsRoot||'')||!ffmpegPath||!ffprobePath
    ||!Number.isSafeInteger(maxWindowBytes)||maxWindowBytes<4096||maxWindowBytes>MAX_WINDOW
    ||!Number.isSafeInteger(maxWindows)||maxWindows<1||maxWindows>MAX_WINDOWS
    ||!Number.isSafeInteger(maxWallMs)||maxWallMs<50||maxWallMs>24*60*60*1000
    ||!Number.isSafeInteger(maxIdleMs)||maxIdleMs<50||maxIdleMs>60*60*1000)
    throw Error('Invalid progressive-index configuration');
  const jobs=new Map(),pendingPurges=new Set(),verifiedContents=new Map();
  const retiredWindows=new Set();
  let retiredTimer=null;
  const attemptedPrefixBytes=new Map();
  let purgeTimer=null,purgeRetryRunning=false,purgeRun=null;
  const diagnose=(code)=>{try{onDiagnostic(code);}catch{}};
  let purging=false;
  function folder(info){return path.join(sessionsRoot,info.identity.sessionId,'progressive-index',info.key);}
  function where(info,id){return path.join(folder(info),id+'.mp4');}
  function valid(info){return !purging&&!pendingPurges.has(path.dirname(folder(info)))&&enabled()
    &&isCurrent(info.identity)&&info.sourceVerified?.()===true;}
  function idFor(info,sequence,clusterStart=null,revisionSourceEnd=null){return hash(info.key+':'+(
    Number.isSafeInteger(clusterStart)?'island:'+clusterStart+':':'')+sequence+
    (Number.isSafeInteger(revisionSourceEnd)?':revision:'+revisionSourceEnd:''));}
  function retryRetiredWindows(){
    if(retiredTimer||!retiredWindows.size)return;
    retiredTimer=setTimeout(async()=>{
      retiredTimer=null;
      for(const file of [...retiredWindows]){
        try{await fs.rm(file,{force:true,maxRetries:1,retryDelay:100});
          retiredWindows.delete(file);verifiedContents.delete(file);
        }catch{/* Windows Range readers can pin an older committed GOP. */}
      }
      retryRetiredWindows();
    },1000);
    retiredTimer.unref?.();
  }
  const toInfo=params=>progressiveIndexEligibility({...params,enabled:enabled()},verifiedSource);
  function snapshot(stat){
    return [stat.size,stat.mtimeMs,stat.ctimeMs,stat.birthtimeMs,stat.ino,stat.dev,stat.mode].join(':');
  }
  function metadataSafe(item,info){
    const offset=item?.timelineOffsetSeconds??0;
    return HEX.test(String(item?.id))&&HEX.test(String(item.initHash))
      && HEX.test(String(item.contentSha256))&&AVC.test(String(item.videoCodecString))
      &&Number.isSafeInteger(item.sequence)&&item.sequence>=0&&item.sequence<maxWindows
      &&item.id===idFor(info,item.sequence,item.sourceClusterStart??null,
        item.revisionSourceEnd??null)
      &&(item.revisionSourceEnd===undefined||(
        Number.isSafeInteger(item.revisionSourceEnd)&&item.revisionSourceEnd>=0
        &&item.revisionSourceEnd<info.identity.sourceLength))
      &&finite(item.start)&&finite(item.end)&&item.end>item.start+0.05
      &&item.end<=info.identity.duration+1&&finite(item.mediaStart)
      &&finite(offset)
      &&offset>=0&&offset<=info.identity.duration
      &&Math.abs(item.mediaStart+offset-item.start)<=0.25
      &&item.mediaStart+offset<=item.end+0.05
      &&item.baseSeconds===offset&&item.seekOffsetSeconds===0
      &&Number.isSafeInteger(item.bytes)&&item.bytes>=1024&&item.bytes<=maxWindowBytes
      &&item.videoCodec==='h264'&&item.audioCodec==='aac'&&item.container==='fmp4'
      &&item.sourceVerified===true&&item.initVerified===true
      &&item.independentlyDecodable===true&&item.keyframeStart===true
      &&item.movieClockVerified===true
      &&(item.sourceKind==='isolated-cluster'
        ?Number.isSafeInteger(item.sourceClusterStart)
          &&item.sourceClusterStart>=0
          &&Array.isArray(item.sourceRanges)&&item.sourceRanges.length===2
          &&item.sourceRanges.every(r=>Number.isSafeInteger(r.start)
            &&Number.isSafeInteger(r.end)&&r.start>=0&&r.end>=r.start
            &&r.end<info.identity.sourceLength)
          &&item.sourceRanges[0].start===0
          &&item.sourceRanges[0].end<item.sourceRanges[1].start
          &&item.sourceRanges[1].start===item.sourceClusterStart
          &&item.timelineOffsetSeconds>0
        :info.sourceMode!=='verified-prefix'||(Number.isSafeInteger(item.sourceByteEnd)
          &&item.sourceByteEnd>=0&&item.sourceByteEnd<info.identity.sourceLength));
  }
  async function checkContent(file,handle,stat,expectedHash){
    // A warm snapshot never avoids stat metadata checks. A cold/replaced file
    // is hashed from the SAME pinned handle that was opened and size-checked.
    // A bounded 64KiB block prevents 24-minute full-cache integrity checks
    // from loading every segment into memory.
    const mark=snapshot(stat);
    const seen=verifiedContents.get(file);
    if(seen?.mark===mark&&seen?.hash===expectedHash)return true;
    const digest=crypto.createHash('sha256');
    const block=Buffer.allocUnsafe(64*1024);
    for(let offset=0;offset<stat.size;){
      const length=Math.min(block.length,stat.size-offset);
      const {bytesRead}=await handle.read(block,0,length,offset);
      if(bytesRead!==length)return false;
      digest.update(block.subarray(0,bytesRead));offset+=bytesRead;
    }
    const after=await handle.stat();
    if(snapshot(after)!==mark)return false;
    const computed=digest.digest('hex');
    if(computed!==expectedHash){verifiedContents.delete(file);return false;}
    verifiedContents.set(file,{mark,hash:computed});
    return true;
  }
  async function checkFile(file,item){
    let handle;
    try{
      const link=await fs.lstat(file);
      if(!link.isFile()||link.isSymbolicLink()||link.size!==item.bytes)return false;
      const seen=verifiedContents.get(file);
      // For a 24-minute episode this avoids reopening 700+ unchanged MP4
      // handles on every 3-second status request, while retaining one lstat
      // mutation/inode/mtime check for every advertised section.
      if(seen?.mark===snapshot(link)&&seen?.hash===item.contentSha256)return true;
      handle=await fs.open(file,'r');
      const stat=await handle.stat();
      return stat.isFile()&&stat.size===item.bytes
        &&await checkContent(file,handle,stat,item.contentSha256);
    }catch{return false;}
    finally{await handle?.close().catch(()=>{});}
  }
  async function readIndex(info){
    if(!valid(info))return {ranges:[],complete:false};
    try{
      const saved=JSON.parse(await fs.readFile(path.join(folder(info),'index.json'),'utf8'));
      if(JSON.stringify(saved.identity)!==JSON.stringify(info.identity)
        ||!Array.isArray(saved.ranges)||saved.ranges.length>maxWindows)return {ranges:[],complete:false};
      const results=[],ids=new Set(),sequences=new Set();
      let previous=null;
      for(const item of saved.ranges){
        const verified=item.sourceKind==='isolated-cluster'
          ?item.sourceRanges?.every(({start,end})=>verifyTorrentFileByteRange(
            info.torrent,info.identity.fileIndex,{start,end}).verified===true)
          :info.verifySection(item);
        const scopedSequence=(item.sourceKind==='isolated-cluster'
          ?item.sourceClusterStart+':':'')+item.sequence;
        if(!metadataSafe(item,info)||!verified
          ||ids.has(item.id)||sequences.has(scopedSequence)
          ||previous&&item.start<previous.end-0.005
          ||previous&&item.videoCodecString!==previous.videoCodecString)
          return {ranges:[],complete:false};
        ids.add(item.id);sequences.add(scopedSequence);previous=item;
        results.push(item);
      }
      // Strictly bound concurrent file handles for long 24-minute episodes.
      // Reject the entire status if ANY segment is unavailable or invalid;
      // never advertise an unchecked slot as instant-seekable.
      for(let index=0;index<results.length;index+=MAX_VERIFY_FILES_PARALLEL){
        const block=results.slice(index,index+MAX_VERIFY_FILES_PARALLEL);
        const checks=await Promise.all(block.map(item=>checkFile(where(info,item.id),item)));
        if(checks.some(ok=>!ok))return {ranges:[],complete:false};
      }
      return valid(info)?{ranges:results,complete:saved.complete===true}: {ranges:[],complete:false};
    }catch{return {ranges:[],complete:false};}
  }
  async function status(params){
    const info=toInfo(params);
    if(!info.eligible)return {status:info.reason,ranges:[],readyRanges:[]};
    const record=await readIndex(info);
    const {ranges,complete}=record;
    const job=jobs.get(info.key);
    const lastAttempt=attemptedPrefixBytes.get(info.key)||0;
    const prefixProgress=info.sourceFullyVerified?info.identity.sourceLength:info.verifiedSourceBytes;
    const triedCurrentPrefix=info.sourceMode==='verified-prefix'
      &&lastAttempt>=prefixProgress;
    return {status:job?'building':complete?'ready':ranges.length?'partial':
        triedCurrentPrefix?'waiting-for-pieces':'waiting',
      ranges,readyRanges:ranges,complete:!job&&complete,identityKey:info.key,
      sourceKey:info.key,audioIndex:info.identity.audioIndex,
      audioMode:info.identity.audioMode,duration:info.identity.duration,
      sourceMode:info.sourceMode,verifiedSourceBytes:info.verifiedSourceBytes,
      indexedSourceBytes:ranges.reduce((max,item)=>
        Math.max(max,Number.isSafeInteger(item.sourceByteEnd)?item.sourceByteEnd+1:0),0),
      canContinue:info.sourceMode==='verified-prefix'&&!job&&ranges.length>0
        &&!triedCurrentPrefix&&(info.verifiedSourceBytes>ranges.reduce((max,item)=>
          Math.max(max,Number.isSafeInteger(item.sourceByteEnd)?item.sourceByteEnd+1:0),0)
          ||info.sourceFullyVerified&&ranges.at(-1).end<info.identity.duration-0.25),
      sourceVerified:true,initVerified:ranges.length>0,videoCodec:'h264',
      audioCodec:'aac',container:'fmp4'};
  }
  async function open(params,sectionId){
    const info=toInfo(params);
    if(!info.eligible||!HEX.test(String(sectionId)))return null;
    const item=(await readIndex(info)).ranges.find(r=>r.id===sectionId);
    if(!item||!valid(info))return null;
    let handle;
    try{
      handle=await fs.open(where(info,item.id),'r');
      const stat=await handle.stat();
      if(!valid(info)||!stat.isFile()||stat.size!==item.bytes
        ||!await checkContent(where(info,item.id),handle,stat,item.contentSha256))
        throw Error('Cache invalidated');
      let released=false;
      return {...item,handle,file:where(info,item.id),async release(){
        if(released)return;released=true;await handle.close().catch(()=>{});
      }};
    }catch{await handle?.close().catch(()=>{});return null;}
  }
  async function openWindow(params,atSeconds){
    if(!finite(atSeconds))return null;
    const state=await status(params);
    const item=state.ranges.find(x=>x.start<=atSeconds+0.001&&x.end>=atSeconds+0.1);
    return item?open(params,item.id):null;
  }
  async function sourcePath(params,info,lease=null){
    // Never use the internal torrent HTTP streaming API for background work:
    // resolving an unverified MKV byte range must NEVER initiate a download.
    const provided=lease?.inputPath||(params.inputPath || sourceUrl?.(info.identity));
    const input=typeof provided==='string'?provided:provided?.url;
    if(typeof input!=='string'||!path.isAbsolute(input))return null;
    const root=await fs.realpath(sessionsRoot);
    const home=await fs.realpath(path.join(sessionsRoot,info.identity.sessionId));
    // A UUID session directory symlink must not redirect the offline decoder
    // beyond the player's scoped storage tree.
    if(path.relative(root,home).toLowerCase()!==info.identity.sessionId.toLowerCase())return null;
    const real=await fs.realpath(input);
    const relative=path.relative(home,real);
    if(!relative||relative.startsWith('..')||path.isAbsolute(relative))return null;
    const stat=await fs.stat(real);
    const expected=lease?.bytes??info.identity.sourceLength;
    return stat.isFile()&&stat.size===expected?real:null;
  }
  async function cancelJob(job){
    if(job.cancelled)return;
    job.cancelled=true;job.resolveCancel(RELEASED);
    job.abortController?.abort();
    for(const child of [job.child,job.probe]){
      if(child&&!child.exitCode)try{child.kill('SIGTERM');}catch{}
    }
    job.escalation=setTimeout(()=>{
      for(const child of [job.child,job.probe]){
        if(child&&child.exitCode===null)try{child.kill('SIGKILL');}catch{}
      }
    },2000);
    job.escalation.unref?.();
  }
  async function stopSession(id){
    await Promise.all([...jobs.values()].filter(j=>j.info.identity.sessionId===id)
      .map(async j=>{await cancelJob(j);await j.done;}));
  }
  async function stopAll(){await Promise.all([...jobs.values()].map(async j=>{
    await cancelJob(j);await j.done;
  }));}
  function schedulePurgeRetry(){
    if(purgeTimer||!pendingPurges.size)return;
    purgeTimer=setTimeout(()=>{purgeTimer=null;void retryPendingPurges();},Math.max(10,purgeRetryMs));
    purgeTimer.unref?.();
  }
  async function retryPendingPurges(){
    if(purgeRetryRunning)return;
    purgeRetryRunning=true;
    try{
      for(const dir of [...pendingPurges]){
        try{
          await removeProgressiveDir(dir,{recursive:true,force:true,maxRetries:2,retryDelay:100});
          pendingPurges.delete(dir);
        }catch{/* Windows reader may still pin this exact indexed-only directory. */}
      }
    }finally{purgeRetryRunning=false;schedulePurgeRetry();}
  }
  async function purgeAll(){
    if(purgeRun)return purgeRun;
    purging=true;
    purgeRun=(async()=>{
      await stopAll();
      const sessions=await fs.readdir(sessionsRoot,{withFileTypes:true}).catch(()=>[]);
      for(const entry of sessions){
        if(!entry.isDirectory()||!UUID.test(entry.name))continue;
        pendingPurges.add(path.join(sessionsRoot,entry.name,'progressive-index'));
      }
      await retryPendingPurges();
      verifiedContents.clear();
      retiredWindows.clear();
      clearTimeout(retiredTimer);retiredTimer=null;
    })();
    try{await purgeRun;}finally{purging=false;purgeRun=null;}
  }
  async function start(params,{sourceKind='prefix',afterStartBytes=0}={}){
    const info=toInfo(params);
    if(!info.eligible||!valid(info)||foregroundBusy()||jobs.size)return;
    const prefixProgress=info.sourceFullyVerified?info.identity.sourceLength:info.verifiedSourceBytes;
    if(sourceKind!=='island'&&info.sourceMode==='verified-prefix'
      &&(attemptedPrefixBytes.get(info.key)||0)>=prefixProgress)return;
    const job={info,cancelled:false,child:null,probe:null,escalation:null,
      abortController:new AbortController()};
    job.cancel=new Promise(resolve=>{job.resolveCancel=resolve;});
    job.done=new Promise(resolve=>{job.resolveDone=resolve;});
    jobs.set(info.key,job); // single-flight BEFORE any async admission/probe
    job.wallTimer=setTimeout(()=>{diagnose('background-walltime-cap');void cancelJob(job);},maxWallMs);
    job.wallTimer.unref?.();
    const refreshIdle=()=>{
      clearTimeout(job.idleTimer);
      job.idleTimer=setTimeout(()=>{diagnose('background-idle-cap');void cancelJob(job);},maxIdleMs);
      job.idleTimer.unref?.();
    };
    refreshIdle();
    try{
      const existing=await Promise.race([readIndex(info),job.cancel]);
      if(job.cancelled||!valid(info))return;
      const already=existing&&Array.isArray(existing.ranges)?existing.ranges:[];
      if(existing?.complete)return;
      if(info.sourceMode==='verified-prefix'&&!info.sourceFullyVerified){
        // The prefix lease is a fully local, bounded immutable snapshot;
        // retain until FFmpeg+FFprobe finish, then delete only its temp copy.
        job.lease=sourceKind==='island'
          ?await verifiedSource.materializeClusterIsland({...params,
            afterStartBytes,signal:job.abortController.signal})
          :await verifiedSource.materialize({...params,signal:job.abortController.signal});
        if(job.lease===RELEASED||!job.lease?.sourceVerified?.())return;
      }
      const input=await sourcePath(params,info,job.lease);
      if(!input||job.cancelled||!valid(info)||foregroundBusy())return;
      const admission=await Promise.race([allowance(maxWindowBytes),job.cancel]);
      if(admission===RELEASED||!admission?.allowed||job.cancelled||foregroundBusy())return;
      const dir=folder(info);
      await fs.mkdir(dir,{recursive:true});
      const args=['-hide_banner','-loglevel','error','-nostdin',
        ...ffmpegInputArgs,'-i',input,'-map','0:v:0','-map',`0:a:${info.identity.audioIndex}`,
        // Genuine anime MKVs can carry a timecode metadata stream. FFmpeg's
        // MP4 muxer may manufacture a third tmcd/text track even when ONLY
        // the video+selected audio were mapped, making strict two-track
        // AVC/AAC GOP proof reject every segment. Drop metadata/timecode and
        // chapters from the *optional* seek rendition, not from subtitles or
        // source selection. Keep only the actual mapped video+audio streams.
        '-map_metadata','-1','-map_chapters','-1','-write_tmcd','0',
        ...(info.identity.videoStrategy==='copy'?['-c:v','copy']:
          ['-c:v','libx264','-threads:v','2','-preset','veryfast','-crf','23',
            '-pix_fmt','yuv420p','-g','48','-keyint_min','48','-sc_threshold','0',
            '-bf','0','-force_key_frames','expr:gte(t,n_forced*2)',
            '-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709']),
        '-c:a','aac','-ac',String(info.identity.channels),'-b:a',info.identity.bitrate,
        '-af',job.lease?.sourceKind==='isolated-cluster'
          ?'aresample=async=1':'asetpts=PTS-STARTPTS,aresample=async=1:first_pts=0',
        '-avoid_negative_ts','make_zero',
        '-movflags','frag_keyframe+empty_moov+default_base_moof',
        '-f','mp4','pipe:1'];
      if(job.cancelled||!valid(info)||foregroundBusy())return;
      if(sourceKind!=='island'&&info.sourceMode==='verified-prefix')
        attemptedPrefixBytes.set(info.key,prefixProgress);
      const child=spawn(ffmpegPath,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});
      job.child=child;
      child.stderr?.resume?.();
      const exited=new Promise(resolve=>{
        child.once('error',()=>{void cancelJob(job);});
        child.once('close',code=>{
          try{onClose(child,info.identity);}catch{}
          resolve(code);
        });
      });
      try{onSpawn(child,info.identity);}catch{await cancelJob(job);}
      const parser=new AtomParser(maxWindowBytes,diagnose);
      const ranges=[...already];
      try{
        for await(const chunk of child.stdout){
          refreshIdle();
          if(job.cancelled||!valid(info)||job.lease&&!job.lease.sourceVerified()
            ||foregroundBusy()){
            await cancelJob(job);break;
          }
          const candidates=parser.feed(chunk);
          for(const candidate of candidates){
            if(job.cancelled||!valid(info)||job.lease&&!job.lease.sourceVerified())break;
            const clusterStart=job.lease?.sourceKind==='isolated-cluster'
              ?job.lease.sourceIdentity.clusterStart:null;
            const sourceByteEnd=job.lease?job.lease.bytes-1:info.identity.sourceLength-1;
            const prior=ranges.find(item=>item.sequence===candidate.sequence
              &&(item.sourceClusterStart??null)===clusterStart);
            if(prior&&((prior.sourceByteEnd??sourceByteEnd)>=sourceByteEnd
              ||clusterStart!==null))continue;
            // A longer verified prefix may finish an earlier truncated GOP.
            // Publish a NEW immutable revision ID rather than overwriting a
            // FileHandle-pinned MP4 that a Windows HTTP reader still owns.
            const revisionSourceEnd=prior?sourceByteEnd:null;
            const id=idFor(info,candidate.sequence,clusterStart,revisionSourceEnd);
            if(ranges.some(item=>item.id===id))continue;
            if(ranges.length>=maxWindows) {await cancelJob(job);break;}
            if(candidate.bytes.length>maxWindowBytes){diagnose('window-oversize');continue;}
            const gate=await Promise.race([allowance(candidate.bytes.length+65536),job.cancel]);
            if(gate===RELEASED||!gate?.allowed) {await cancelJob(job);break;}
            const part=path.join(dir,id+'.part.mp4');
            const ready=where(info,id);
            let published=false;
            try{
              const writer=await fs.open(part,'wx');
              try{await writer.writeFile(candidate.bytes);await writer.sync();}
              finally{await writer.close();}
              if(job.cancelled||!valid(info)||job.lease&&!job.lease.sourceVerified())break;
              const probe=await probeWindow(ffprobePath,spawn,part,job);
              const interval=verifiedWindow(probe,info,candidate.rap);
              let offset=0;
              if(job.lease?.sourceKind==='isolated-cluster'&&interval){
                // FFmpeg resets isolated MKV Cluster PTS to zero even with
                // -copyts. Reconstruct EXACT movie clock solely from the
                // original MKV FFprobe-decoded IDR and output decoded IDR;
                // never approximate timing from torrent byte positions.
                offset=job.lease.decodedFirstFramePTS-interval.mediaStart;
                const sourceVideoDuration=job.lease.decodedLastFramePTS
                  -job.lease.decodedFirstFramePTS;
                const outputVideoDuration=interval.end-interval.mediaStart;
                const sourceAudioOffset=job.lease.decodedFirstAudioPTS
                  -job.lease.decodedFirstFramePTS;
                const outputAudioOffset=interval.firstAudioPTS-interval.mediaStart;
                if(!Number.isFinite(offset)||offset<=0||offset>info.identity.duration
                  ||Math.abs(sourceVideoDuration-outputVideoDuration)>0.15
                  ||Math.abs(sourceAudioOffset-outputAudioOffset)>0.15
                  ||interval.decodedVideoFrames!==job.lease.decodedVideoFrames
                  ||interval.end+offset>info.identity.duration+0.25)
                  offset=NaN;
              }
              if(!interval||!Number.isFinite(offset)||job.cancelled||!valid(info)
                ||job.lease&&!job.lease.sourceVerified()){
                diagnose('probe-rejected:'+JSON.stringify({
                  keys:probe&&Object.keys(probe),
                  combinedCount:probe?.packets_and_frames?.length,
                  combinedHeads:probe?.packets_and_frames?.slice(0,3)?.map(x=>({
                    type:x.type,media_type:x.media_type,codec_type:x.codec_type,
                    key_frame:x.key_frame,flags:x.flags,pts_time:x.pts_time,
                    duration_time:x.duration_time,best_effort_timestamp_time:x.best_effort_timestamp_time,
                  })),
                  streamTypes:probe?.streams?.map(s=>[s.codec_type,s.codec_name,s.pix_fmt,s.channels]),
                  firstFrame:probe?.frames?.find(f=>f.media_type==='video')&&
                    (({key_frame,pict_type,best_effort_timestamp_time})=>({key_frame,pict_type,best_effort_timestamp_time}))
                      (probe.frames.find(f=>f.media_type==='video')),
                  firstVideoPacket:probe?.packets?.find(p=>p.codec_type==='video')&&
                    (({flags,pts_time,duration_time})=>({flags,pts_time,duration_time}))
                      (probe.packets.find(p=>p.codec_type==='video')),
                  firstAudio:probe?.packets?.find(p=>p.codec_type==='audio')?.pts_time,
                  rap:candidate.rap,
                  warnings:probe?.__probeWarnings,
                }));continue;
              }
              const range={id,sequence:candidate.sequence,...interval,
                start:+(interval.start+offset).toFixed(5),
                end:+(interval.end+offset).toFixed(5),
                timelineOffsetSeconds:+offset.toFixed(5),
                baseSeconds:+offset.toFixed(5),
                ...(revisionSourceEnd!==null?{revisionSourceEnd}:{}),
                ...(job.lease?.sourceKind==='isolated-cluster'
                  ?{sourceKind:'isolated-cluster',
                    sourceClusterStart:job.lease.sourceIdentity.clusterStart,
                    sourceRanges:job.lease.sourceRanges.map(r=>({...r}))}
                  :info.sourceMode==='verified-prefix'
                    ?{sourceByteEnd:job.lease?job.lease.bytes-1:info.identity.sourceLength-1}:{}),
                contentSha256:hash(candidate.bytes),
                initHash:candidate.initHash,videoCodecString:candidate.videoCodecString,
                videoCodec:'h264',audioCodec:'aac',container:'fmp4',
                sourceVerified:true,initVerified:true,independentlyDecodable:true,
                keyframeStart:true,movieClockVerified:true,bytes:candidate.bytes.length};
              // Never atomically publish a candidate that would invalidate an
              // existing source's already-ready windows. A previous GOP (from
              // a shorter prefix or disjoint Cluster) can cover the same movie
              // time on a later attempt, or have different codec/init setup.
              // Fail only this candidate closed; never corrupt/rewrite the
              // existing manifest and make earlier bright sections disappear.
              if(prior&&!(range.start>=prior.start-0.05
                &&range.start<=prior.start+0.1&&range.end>prior.end+0.02)){
                diagnose('revision-does-not-extend-verified-gop');continue;
              }
              if(ranges.some(other=>other!==prior&&(
                range.start<other.end-0.005&&range.end>other.start+0.005
                ||other.videoCodecString!==range.videoCodecString
                ||other.initHash!==range.initHash))){
                diagnose('overlap-or-incompatible-init');continue;
              }
              await fs.rename(part,ready);
              if(job.cancelled||!valid(info)||job.lease&&!job.lease.sourceVerified())break;
              const priorPosition=prior?ranges.indexOf(prior):-1;
              if(priorPosition>=0)ranges.splice(priorPosition,1);
              ranges.push(range);
              ranges.sort((a,b)=>a.start-b.start);
              const temp=path.join(dir,'index.json.tmp');
              const file=await fs.open(temp,'w');
              try{await file.writeFile(JSON.stringify({identity:info.identity,ranges,complete:false}));
                await file.sync();}finally{await file.close();}
              if(job.cancelled||!valid(info)||job.lease&&!job.lease.sourceVerified()){
                ranges.splice(ranges.indexOf(range),1);
                if(priorPosition>=0)ranges.push(prior);
                ranges.sort((a,b)=>a.start-b.start);
                break;}
              await fs.rename(temp,path.join(dir,'index.json'));
              published=true;
              if(prior){retiredWindows.add(where(info,prior.id));retryRetiredWindows();}
              // Publication stores a content hash and a strict identity;
              // readers still verify actual bytes on cold/replaced file pins.
              try{onReady({...range,identityKey:info.key});}catch{}
            }finally{
              await fs.rm(part,{force:true}).catch(()=>{});
              if(!published)await fs.rm(ready,{force:true}).catch(()=>{});
            }
          }
        }
      }catch(error){diagnose('parser-or-pipe:'+String(error?.message||error));await cancelJob(job);}
      const code=await exited;
      // FFmpeg may finish with an extra audio-only atom after the final video
      // GOP. Do not demand one playable video window per *all* moofs; require
      // verified video-frame coverage of the entire movie clock instead.
      const continuous=ranges.length>0 && ranges.every((item,index)=>
          index===0||item.start>=ranges[index-1].start
          &&item.start-ranges[index-1].end<=0.25)
        && ranges.every(item=>item.initHash===ranges[0].initHash)
        && ranges[0].start<=0.25
        && ranges.at(-1).end>=info.identity.duration-0.25;
      if(code===0&&!job.cancelled&&valid(info)&&info.sourceFullyVerified&&!parser.moof
        &&parser.pending.length===0&&continuous){
        const temp=path.join(dir,'index.json.tmp');
        const file=await fs.open(temp,'w');
        try{await file.writeFile(JSON.stringify({identity:info.identity,ranges,complete:true}));
          await file.sync();}finally{await file.close();}
        if(!job.cancelled&&valid(info))await fs.rename(temp,path.join(dir,'index.json'));
      }
    }catch(error){diagnose('background-error:'+String(error?.message||error));}
    finally{
      await job.lease?.release?.().catch(()=>{});
      clearTimeout(job.escalation);
      clearTimeout(job.wallTimer);clearTimeout(job.idleTimer);
      if(jobs.get(info.key)===job)jobs.delete(info.key);
      job.resolveDone();
    }
  }
  return {eligibility:toInfo,start,status,open,openWindow,stopAll,stopSession,purgeAll};
}
