// Private, same-session progressive fMP4 recorder. Complete exact-plan outputs
// can replay through HTMLMediaElement. An active producer also exposes bounded
// MSE windows only when video RAP flags AND H.264 IDR bytes are verified,
// the fragments are contiguous, and a following RAP bounds the playable end.
// Incomplete or incompatible sections remain unavailable to native video.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';

const SESSION=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_HEADER=16;
const MAX_PENDING=8*1024*1024;
const RESERVE_CHUNK=4*1024*1024;
const MAX_ATOM_BYTES=128*1024*1024;
const MAX_INIT_BYTES=4*1024*1024;
const MAX_MOOF_BYTES=1024*1024;
const MAX_INDEX_FRAGMENTS=16384;
const MAX_WARM_WINDOW_BYTES=16*1024*1024;
const MAX_RAP_SAMPLE_CHECK_BYTES=512*1024;
const MAX_OPEN_READERS=8;
const MAX_COMPLETE_FINALIZATION_WAIT_MS=1500;
const TOKEN=/^[a-f0-9]{48}$/;
const DEFAULT_ENTRY_CAP=20*1024*1024*1024;
const supported=new Set(['ftyp','free','moov','moof','mdat','sidx','mfra','skip','styp']);

// Feasibility-only policy for a possible independent *local-file* remux worker.
// Not wired into the HTTP path. It deliberately does not open inputs, fetch
// torrent pieces, spawn FFmpeg, or grant access to the warm-window endpoint.
// A future owner must prove that the source is locally verified, honor the
// lease's abort signal, and still pass the normal recorder's disk allowance,
// exact-plan identity and MP4/IDR validation before exposing any bytes.
export function createRemuxRunAheadController({
  maxAheadSeconds=180,maxOutputBytes=64*1024*1024,maxWallMs=30_000,
}={}) {
  if(!Number.isFinite(maxAheadSeconds)||maxAheadSeconds<1||maxAheadSeconds>300
    ||!Number.isSafeInteger(maxOutputBytes)||maxOutputBytes<4096||maxOutputBytes>96*1024*1024
    ||!Number.isSafeInteger(maxWallMs)||maxWallMs<100||maxWallMs>120_000)
    throw Error('Unbounded run-ahead policy');
  let active=null,activeGeneration=null,closed=false;
  const finiteTime=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
  function acquire({identity,sourceGeneration,expectedSourceGeneration,
    sourceFileBytes,verifiedLocalBytes,verifiedLocalFile,localInputOnly,
    playheadSeconds,startSeconds,endSeconds,durationSeconds,estimatedOutputBytes,
    availableCacheBytes,reservedSourceBytes=0,activeTranscodes=0,maxTranscodes=2}={}) {
    if(closed||active||!identity||!SESSION.test(String(identity.sessionId))
      ||typeof identity.sourceIdentity!=='string'||identity.sourceIdentity.length<4
      ||!Number.isSafeInteger(identity.fileIndex)||identity.fileIndex<0
      ||identity.videoMode!=='copy'||identity.videoCodec!=='h264'
      ||!TOKEN.test(String(sourceGeneration))||sourceGeneration!==expectedSourceGeneration
      ||verifiedLocalFile!==true||localInputOnly!==true
      ||!Number.isSafeInteger(sourceFileBytes)||sourceFileBytes<=0
      ||sourceFileBytes>DEFAULT_ENTRY_CAP
      ||verifiedLocalBytes!==sourceFileBytes
      ||![playheadSeconds,startSeconds,endSeconds,durationSeconds].every(finiteTime)
      ||startSeconds<playheadSeconds||endSeconds<=startSeconds
      ||endSeconds>durationSeconds||endSeconds-playheadSeconds>maxAheadSeconds
      ||!Number.isSafeInteger(estimatedOutputBytes)||estimatedOutputBytes<=0
      ||!Number.isSafeInteger(availableCacheBytes)||availableCacheBytes<0
      ||!Number.isSafeInteger(reservedSourceBytes)||reservedSourceBytes<0
      ||!Number.isSafeInteger(activeTranscodes)||activeTranscodes<0
      ||!Number.isSafeInteger(maxTranscodes)||maxTranscodes<1||maxTranscodes>2
      ||activeTranscodes>=maxTranscodes) return null;
    // This is only a snapshot admission check, NOT a disk reservation:
    // the existing recorder must independently obtain its shared allowance
    // on every 4 MiB reservation as other workers and sessions write.
    const headroom=availableCacheBytes-reservedSourceBytes;
    const limit=Math.min(maxOutputBytes,Math.floor(headroom));
    if(limit<4096||estimatedOutputBytes>Math.floor(limit/2))return null;
    const controller=new AbortController();
    let bytes=0,untilSeconds=startSeconds,released=false;
    const reason=message=>Error('Run-ahead '+message);
    const cancel=why=>{
      if(!controller.signal.aborted)controller.abort(reason(why));
    };
    const lease={
      signal:controller.signal,
      // Progress is advisory; only a verifier downstream can prove RAP/clock
      // correctness. Byte and time caps here simply stop runaway producers.
      observe({outputBytes=0,producedUntilSeconds=untilSeconds,
        generation=sourceGeneration}={}) {
        if(released||controller.signal.aborted)return false;
        if(generation!==sourceGeneration) {cancel('source generation changed');return false;}
        if(!Number.isSafeInteger(outputBytes)||outputBytes<0
          ||!finiteTime(producedUntilSeconds)||producedUntilSeconds<untilSeconds
          ||producedUntilSeconds>endSeconds
          ||outputBytes>limit-bytes) {
          cancel('output quota or clock exceeded');return false;
        }
        bytes+=outputBytes;untilSeconds=producedUntilSeconds;
        return true;
      },
      cancel,
      release() {
        if(released)return;
        released=true;
        clearTimeout(timeout);
        cancel('lease released');
        if(active===lease){active=null;activeGeneration=null;}
      },
      get bytes(){return bytes;},
      get untilSeconds(){return untilSeconds;},
      get maxBytes(){return limit;},
    };
    const timeout=setTimeout(()=>cancel('wall-clock deadline exceeded'),maxWallMs);
    timeout.unref?.();
    active=lease;
    activeGeneration=sourceGeneration;
    return lease;
  }
  return {
    acquire,
    cancelGeneration(sourceGeneration) {
      // No lease reuse while a previous producer has not acknowledged abort
      // and released its slot. This prevents overlapping stale writers.
      if(active&&sourceGeneration!==activeGeneration)
        active.cancel('source generation changed');
    },
    cancel(){active?.cancel('controller cancelled');},
    close(){closed=true;active?.cancel('controller closed');},
    get busy(){return Boolean(active);},
    get closed(){return closed;},
  };
}

function children(bytes,from=8,to=bytes.length) {
  const values=[];
  for(let pos=from;pos+8<=to;) {
    let size=bytes.readUInt32BE(pos);
    const name=bytes.toString('ascii',pos+4,pos+8);
    let header=8;
    if(size===1) {
      if(pos+16>to)return null;
      const wide=bytes.readBigUInt64BE(pos+8);
      if(wide>BigInt(Number.MAX_SAFE_INTEGER))return null;
      size=Number(wide);header=16;
    }
    if(size<header||pos+size>to)return null;
    values.push({name,start:pos,end:pos+size,body:pos+header});
    pos+=size;
  }
  if(values.length && values.at(-1).end!==to)return null;
  return values;
}
function getTrackTimescales(moov) {
  const first=children(moov);
  if(!first?.some(x=>x.name==='mvex'))return null;
  const map=new Map();
  for(const trak of first.filter(x=>x.name==='trak')) {
    const track=children(moov,trak.body,trak.end);
    const tkhd=track?.find(x=>x.name==='tkhd');
    const mdia=track?.find(x=>x.name==='mdia');
    const mdiaChildren=mdia&&children(moov,mdia.body,mdia.end);
    const mdhd=mdiaChildren?.find(x=>x.name==='mdhd');
    const hdlr=mdiaChildren?.find(x=>x.name==='hdlr');
    if(!tkhd||!mdhd)return null;
    const tkhdVersion=moov[tkhd.body];
    const mdhdVersion=moov[mdhd.body];
    const idOffset=tkhd.body+(tkhdVersion===1?20:12);
    const timescaleOffset=mdhd.body+(mdhdVersion===1?20:12);
    if(idOffset+4>tkhd.end||timescaleOffset+4>mdhd.end)return null;
    const id=moov.readUInt32BE(idOffset);
    const scale=moov.readUInt32BE(timescaleOffset);
    if(!id||!scale||map.has(id))return null;
    map.set(id,scale);
    if(hdlr&&hdlr.body+12<=hdlr.end&&moov.toString('ascii',hdlr.body+8,hdlr.body+12)==='vide') {
      if(map.videoTrackId)return null;
      map.videoTrackId=id;
      const minf=mdiaChildren.find(x=>x.name==='minf');
      const stbl=minf&&children(moov,minf.body,minf.end)?.find(x=>x.name==='stbl');
      const stsd=stbl&&children(moov,stbl.body,stbl.end)?.find(x=>x.name==='stsd');
      if(stsd&&stsd.body+16<=stsd.end&&moov.readUInt32BE(stsd.body+4)===1){
        const sample=children(moov,stsd.body+8,stsd.end)?.[0];
        if(sample&&['avc1','hvc1','hev1'].includes(sample.name)&&sample.body+78<=sample.end){
          const config=children(moov,sample.body+78,sample.end)?.find(x=>
            x.name===(sample.name==='avc1'?'avcC':'hvcC'));
          const lengthOffset=config?.body+(sample.name==='avc1'?4:21);
          if(config&&lengthOffset<config.end){
            map.videoCodec=sample.name;
            map.videoNalLength=(moov[lengthOffset]&3)+1;
          }
        }
      }
    }
  }
  return map.size?map:null;
}
function firstVideoSample(moof,items,trackId,timescales) {
  if(trackId!==timescales.videoTrackId)return null;
  const tfhd=items.find(x=>x.name==='tfhd');
  const trun=items.find(x=>x.name==='trun');
  if(!tfhd||!trun||trun.body+8>trun.end)return null;
  const tfhdFlags=moof.readUInt32BE(tfhd.body)&0xffffff;
  // The trun data offset is relative to this moof only with
  // default-base-is-moof. Reject absolute or previous-traf base addressing.
  if((tfhdFlags&1)||!(tfhdFlags&0x20000))return null;
  let at=tfhd.body+8;
  if(tfhdFlags&1)at+=8;
  if(tfhdFlags&2)at+=4;
  if(tfhdFlags&8)at+=4;
  let defaultSize=null;
  if(tfhdFlags&16){if(at+4>tfhd.end)return null;defaultSize=moof.readUInt32BE(at);at+=4;}
  let defaultFlags=null;
  if(tfhdFlags&32){if(at+4>tfhd.end)return null;defaultFlags=moof.readUInt32BE(at);}
  const flags=moof.readUInt32BE(trun.body)&0xffffff;
  const count=moof.readUInt32BE(trun.body+4);
  if(!count||!(flags&1))return null;
  at=trun.body+8;
  if(at+4>trun.end)return null;
  const dataOffset=moof.readInt32BE(at);at+=4;
  let firstFlags=defaultFlags;
  if(flags&4){if(at+4>trun.end)return null;firstFlags=moof.readUInt32BE(at);at+=4;}
  if(flags&0x100)at+=4;
  let firstSize=defaultSize;
  if(flags&0x200){if(at+4>trun.end)return null;firstSize=moof.readUInt32BE(at);at+=4;}
  if(flags&0x400){if(at+4>trun.end)return null;firstFlags=moof.readUInt32BE(at);}
  const independent=firstFlags!==null&&((firstFlags>>>24)&3)===2&&(firstFlags&0x10000)===0;
  if(!independent||!Number.isSafeInteger(firstSize)||firstSize<=0||firstSize>MAX_ATOM_BYTES
    ||!Number.isSafeInteger(dataOffset)||dataOffset<moof.length)return null;
  return {independent:true,sampleOffset:dataOffset,sampleBytes:firstSize};
}
function decodeFragment(moof,timescales,previous) {
  const boxes=children(moof);
  const fragments=[];
  if(!boxes?.some(b=>b.name==='mfhd'))return null;
  for(const traf of boxes.filter(b=>b.name==='traf')) {
    const items=children(moof,traf.body,traf.end);
    const tfhd=items?.find(x=>x.name==='tfhd');
    const tfdt=items?.find(x=>x.name==='tfdt');
    const trun=items?.find(x=>x.name==='trun');
    if(!tfhd||!tfdt||!trun||tfhd.body+8>tfhd.end)return null;
    const id=moof.readUInt32BE(tfhd.body+4);
    if(!timescales.has(id)||tfdt.body+8>tfdt.end)return null;
    const version=moof[tfdt.body];
    if(version!==0&&version!==1)return null;
    const offset=tfdt.body+4;
    if(offset+(version===1?8:4)>tfdt.end)return null;
    const raw=version===1?moof.readBigUInt64BE(offset):BigInt(moof.readUInt32BE(offset));
    if(raw>BigInt(Number.MAX_SAFE_INTEGER))return null;
    const baseDecodeTime=Number(raw);
    if(previous.has(id)&&baseDecodeTime<previous.get(id))return null;
    if(fragments.some(x=>x.trackId===id))return null;
    const sample=firstVideoSample(moof,items,id,timescales);
    fragments.push({trackId:id,timescale:timescales.get(id),baseDecodeTime,
      ...(id===timescales.videoTrackId?{rap:sample}: {})});
  }
  return fragments.length?fragments:null;
}

class Mp4Index {
  constructor(maxFragments=MAX_INDEX_FRAGMENTS){this.size=0;this.safeBytes=0;this.stage='ftyp';this.header=Buffer.alloc(0);
    this.maxFragments=maxFragments;
    this.box=null;this.timescales=null;this.pending=null;this.fragments=[];this.previous=new Map();this.invalid=false;}
  get complete(){return !this.invalid&&!this.box&&!this.header.length&&!this.pending
    &&this.timescales&&this.fragments.length>0&&this.stage==='fragments';}
  add(bytes) {
    let cursor=0;
    while(cursor<bytes.length) {
      if(!this.box) {
        const needed=(this.header.length>=8&&this.header.readUInt32BE(0)===1?16:8)-this.header.length;
        const take=Math.min(needed,bytes.length-cursor);
        this.header=Buffer.concat([this.header,bytes.subarray(cursor,cursor+take)]);
        cursor+=take;
        if(this.header.length<8 || (this.header.readUInt32BE(0)===1&&this.header.length<16))continue;
        let length=this.header.readUInt32BE(0);
        const kind=this.header.toString('ascii',4,8);
        if(length===1){
          const wide=this.header.readBigUInt64BE(8);
          if(wide>BigInt(Number.MAX_SAFE_INTEGER))throw Error('oversize MP4 atom');
          length=Number(wide);
        }
        if(!supported.has(kind)||length<this.header.length||length>MAX_ATOM_BYTES||length===0)
          throw Error('unbounded/unknown MP4 atom');
        if((kind==='moov'&&length>MAX_INIT_BYTES)||(kind==='moof'&&length>MAX_MOOF_BYTES)
          ||(kind==='ftyp'&&length>512))throw Error('oversize MP4 metadata atom');
        const start=this.size;
        this.box={kind,length,start,remaining:length-this.header.length,
          collected:['ftyp','moov','moof'].includes(kind)?[this.header]:null};
        this.size+=this.header.length;this.header=Buffer.alloc(0);
        if(this.box.remaining===0)this.endBox();
        continue;
      }
      const take=Math.min(this.box.remaining,bytes.length-cursor);
      if(this.box.collected)this.box.collected.push(bytes.subarray(cursor,cursor+take));
      this.box.remaining-=take;this.size+=take;cursor+=take;
      if(this.box.remaining===0)this.endBox();
    }
  }
  endBox(){
    const b=this.box;this.box=null;
    if(b.kind==='ftyp'){
      if(this.stage!=='ftyp')throw Error('unexpected MP4 file type');
      this.stage='moov';
    }else if(b.kind==='moov'){
      if(this.stage!=='moov')throw Error('unexpected MP4 init');
      this.timescales=getTrackTimescales(Buffer.concat(b.collected));
      if(!this.timescales)throw Error('invalid fMP4 track timescales');
      this.stage='fragments';this.safeBytes=this.size;
    }else if(b.kind==='moof'){
      if(this.stage!=='fragments'||this.pending)throw Error('unexpected MP4 fragment');
      const tracks=decodeFragment(Buffer.concat(b.collected),this.timescales,this.previous);
      if(!tracks)throw Error('unverified fragment decode timestamp');
      this.pending={offset:b.start,tracks};
    }else if(b.kind==='mdat'){
      if(!this.pending||this.stage!=='fragments')throw Error('unpaired MP4 media');
      if(this.fragments.length>=this.maxFragments)throw Error('MP4 fragment count cap reached');
      const entry={offset:this.pending.offset,end:this.size,bytes:this.size-this.pending.offset,
        tracks:this.pending.tracks};
      for(const track of entry.tracks)this.previous.set(track.trackId,track.baseDecodeTime);
      this.fragments.push(entry);this.pending=null;this.safeBytes=this.size;
    }else if((b.kind==='sidx'||b.kind==='mfra'||b.kind==='styp')&&this.stage!=='fragments')
      throw Error('MP4 index before init');
  }
}

export function createRemuxSegmentCache({sessionsRoot,enabled=()=>false,allowance=async()=>({allowed:false}),
  maxEntryBytes=DEFAULT_ENTRY_CAP,maxIndexFragments=MAX_INDEX_FRAGMENTS}={}) {
  if(!path.isAbsolute(sessionsRoot||''))throw Error('remux cache requires scoped absolute sessionsRoot');
  const sessions=new Map();
  const retiredGroups=new Set();
  const cap=Math.min(DEFAULT_ENTRY_CAP,Math.max(4096,Number(maxEntryBytes)||DEFAULT_ENTRY_CAP));
  const fragmentCap=Math.min(MAX_INDEX_FRAGMENTS,Math.max(1,Number(maxIndexFragments)||MAX_INDEX_FRAGMENTS));
  const valid=(id)=>SESSION.test(String(id?.sessionId||''))&&typeof id.sourceIdentity==='string'
    &&id.sourceIdentity.length>=4&&id.sourceIdentity.length<=200
    &&Number.isSafeInteger(id.fileIndex)&&id.fileIndex>=0
    &&Number.isFinite(id.startSeconds)&&id.startSeconds>=0
    &&Number.isFinite(id.effectiveStartSeconds)&&id.effectiveStartSeconds>=0
    &&id.effectiveStartSeconds<=id.startSeconds+0.001;
  function keyFor(identity){
    // Keys bind every conversion choice (including audio track, timestamps,
    // codec tag, output channels) and the private source identity.
    return crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
  }
  function groupFor(sessionId){
    let group=sessions.get(sessionId);
    if(!group){group={id:sessionId,dir:path.join(sessionsRoot,sessionId,
      '.lvl-remux-'+crypto.randomBytes(12).toString('hex')),
      entries:new Map(),pins:0,retired:false,cleanupPromise:null};
      sessions.set(sessionId,group);
    }
    return group;
  }
  function begin(identity,{maxEntryBytes:requestedMaxEntryBytes}={}){
    if(!valid(identity)||!enabled())return null;
    // An encoded output may opt into a smaller hard cap than the shared
    // recorder's global maximum. An invalid limit fails closed; an oversized
    // request never weakens the global cap. The cap applies only to the
    // optional disk recording, never to bytes forwarded to the browser.
    if(requestedMaxEntryBytes!==undefined&&(!Number.isSafeInteger(requestedMaxEntryBytes)
      ||requestedMaxEntryBytes<4096))return null;
    const entryCap=requestedMaxEntryBytes===undefined?cap:Math.min(cap,requestedMaxEntryBytes);
    const group=groupFor(identity.sessionId);
    const key=keyFor(identity);
    if(group.entries.has(key))return null; // never overwrite a current/full record
    const index=new Mp4Index(fragmentCap);
    const record={key,identity,complete:false,active:true,bytes:0,index,
      producerToken:crypto.randomBytes(24).toString('hex'),
      path:path.join(group.dir,key+'.part'),readyPath:path.join(group.dir,key+'.mp4'),
      pending:0,queue:[],pumping:false,pumpPromise:null,handle:null,
      disabled:false,closed:false,finalized:false};
    let resolveFinalization;
    record.finalization=new Promise(resolve=>{resolveFinalization=resolve;});
    let finalizationSettled=false;
    const settleFinalization=()=>{
      if(finalizationSettled)return;
      finalizationSettled=true;resolveFinalization();
    };
    record.settleFinalization=settleFinalization;
    group.entries.set(key,record);
    async function stopAndDiscard(){
      record.disabled=true;record.queue.length=0;record.pending=0;
      try{
        if(record.handle){await record.handle.close().catch(()=>{});record.handle=null;}
        if(group.pins||group.retired)return; // reader lease or group retirement handles physical removal
        await fs.rm(record.path,{force:true}).catch(()=>{});
        await fs.rm(record.readyPath,{force:true}).catch(()=>{});
        await fs.rm(path.join(group.dir,key+'.json'),{force:true}).catch(()=>{});
        await fs.rm(path.join(group.dir,key+'.json.tmp'),{force:true}).catch(()=>{});
        if(group.entries.get(key)===record)group.entries.delete(key);
        try{await fs.rmdir(group.dir);}catch{}
      }finally{settleFinalization();}
    }
    async function initialize(){
      const gate=await allowance(RESERVE_CHUNK,identity);
      if(!enabled()||!gate?.allowed||gate.availableBytes<RESERVE_CHUNK)return false;
      // A cryptographically random exclusive subdirectory prevents untrusted
      // torrent filenames from colliding with cache files.
      await fs.mkdir(path.join(sessionsRoot,identity.sessionId),{recursive:true});
      await fs.mkdir(group.dir,{recursive:true});
      record.handle=await fs.open(record.path,'wx');
      return true;
    }
    record.discard=stopAndDiscard;
    let budgetBytes=0;
    async function pump(){
      if(record.pumping)return record.pumpPromise;
      record.pumping=true;
      record.pumpPromise=(async()=>{
        try{
          if(!record.handle && !(await initialize()))throw Error('cache budget disabled');
          while(record.queue.length&&!record.disabled){
            if(!enabled())throw Error('cache toggled off');
            const blocks=[];
            let size=0;
            while(record.queue.length&&size<256*1024){
              const block=record.queue.shift();blocks.push(block);size+=block.length;
            }
            record.pending-=size;
            if(record.bytes+size>entryCap)throw Error('entry disk cap reached');
            if(budgetBytes<size){
              const gate=await allowance(Math.max(RESERVE_CHUNK,size),identity);
              if(!gate?.allowed || gate.availableBytes<Math.max(RESERVE_CHUNK,size))
                throw Error('shared player budget exhausted');
              budgetBytes=RESERVE_CHUNK;
            }
            budgetBytes-=size;
            const chunk=blocks.length===1?blocks[0]:Buffer.concat(blocks,size);
            let written=0;
            while(written<chunk.length){
              const result=await record.handle.write(chunk,written,chunk.length-written,record.bytes+written);
              if(!result.bytesWritten)throw Error('short cache write');
              written+=result.bytesWritten;
            }
            index.add(chunk);
            record.bytes+=chunk.length;
          }
        }catch{
          record.disabled=true;
        }finally{
          record.pumping=false;
          if(record.disabled)await stopAndDiscard();
        }
      })();
      return record.pumpPromise;
    }
    function capture(bytes){
      if(record.disabled||record.closed)return;
      if(!enabled()||record.pending+bytes.length>MAX_PENDING||record.bytes+record.pending+bytes.length>entryCap){
        record.disabled=true;record.queue.length=0;
        if(!record.pumping)void stopAndDiscard();
        return;
      }
      record.queue.push(Buffer.from(bytes));
      record.pending+=bytes.length;
      if(!record.pumping)void pump();
    }
    const transform=new Transform({transform(chunk,_enc,cb){
      // Deliver original bytes immediately. Disk/I/O never block FFmpeg or
      // the browser; an overwhelmed cache is sacrificed instead of buffering.
      capture(chunk);
      cb(null,chunk);
    }});
    record.transform=transform;
    async function finish({success=false}={}){
      if(record.finalized)return record.finalization;
      record.finalized=true;record.closed=true;
      try{
        if(record.pumpPromise)await record.pumpPromise;
        if(record.pumping&&record.pumpPromise)await record.pumpPromise;
        if(record.disabled)return;
        if(!success){
          // Interrupted streams have verified *fragments*, not a native
          // seekable movie. Without a proven MSE consumer those bytes provide
          // no playable reuse and only compete with unfinished source pieces.
          await stopAndDiscard();
          return;
        }
        try{
          if(record.handle){
            await record.handle.sync();
            await record.handle.close();record.handle=null;
          } else throw Error('No complete MP4 output recorded');
          const ready=Boolean(index.complete&&record.bytes===index.size);
          // A clean FFmpeg process exit does not certify that its MP4 output
          // ended on a complete fragment boundary. Never retain an unusable
          // `.part` / metadata or block a later request for this same seek.
          if(!ready)throw Error('MP4 output did not end at a verified fragment boundary');
          const metadata={complete:true,bytes:record.bytes,safeBytes:index.safeBytes,
            fragments:index.fragments,sourceRedacted:true};
          await fs.rename(record.path,record.readyPath);
          const metaFile=path.join(group.dir,key+'.json');
          await fs.writeFile(metaFile+'.tmp',JSON.stringify(metadata)+'\n',{flag:'wx'});
          await fs.rename(metaFile+'.tmp',metaFile);
          record.complete=ready;
        }catch{await stopAndDiscard();}
      }finally{record.active=false;settleFinalization();}
    }
    return {transform,finish,producerToken:record.producerToken};
  }
  async function removeGroup(group){
    if(group.pins||!group.retired)return;
    if(group.cleanupPromise)return group.cleanupPromise;
    group.cleanupPromise=(async()=>{
      try {
        // FileHandle leases are closed before unlink. Retry transient Windows
        // sharing violations and retain retired identity for later retry.
        await fs.rm(group.dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});
        retiredGroups.delete(group);
      }finally{group.cleanupPromise=null;}
    })();
    return group.cleanupPromise;
  }
  async function releaseLease(group,handle){
    await handle.close().catch(()=>{});
    group.pins=Math.max(0,group.pins-1);
    if(group.pins)return;
    if(group.retired){await removeGroup(group).catch(()=>{});return;}
    for(const record of [...group.entries.values()]){
      if(record.disabled&&!record.pumping)await record.discard();
    }
  }
  async function acquireRecordFile(group,record,file,minimumBytes){
    if(group.retired||record.disabled||!enabled()||group.pins>=MAX_OPEN_READERS)return null;
    group.pins++;
    let handle;
    try{
      handle=await fs.open(file,'r');
      const stat=await handle.stat();
      if(group.retired||record.disabled||!enabled()||!stat.isFile()
        ||stat.size<minimumBytes)throw Error('retired or incomplete cache file');
      let released=false;
      return {handle,async release(){
        if(released)return;
        released=true;
        await releaseLease(group,handle);
      }};
    }catch{
      if(handle)await handle.close().catch(()=>{});
      group.pins--;
      if(group.retired&&!group.pins)await removeGroup(group).catch(()=>{});
      return null;
    }
  }
  async function lookupComplete(identity){
    if(!valid(identity)||!enabled())return null;
    const record=sessions.get(identity.sessionId)?.entries.get(keyFor(identity));
    if(!record?.complete||record.active||record.disabled)return null;
    try{
      const stat=await fs.stat(record.readyPath);
      if(!stat.isFile()||stat.size!==record.bytes)return null;
      return {file:record.readyPath,bytes:record.bytes,fragments:record.index.fragments};
    }catch{return null;}
  }
  async function openComplete(identity){
    if(!valid(identity)||!enabled())return null;
    const group=sessions.get(identity.sessionId);
    const record=group?.entries.get(keyFor(identity));
    // The HTTP response may reach EOF before FFmpeg emits close and the
    // optional recorder finishes fsync/rename. Wait briefly only for a
    // producer whose output has fully drained; never wait on live streaming.
    if(record?.active&&!record.disabled&&record.transform?.writableFinished
      &&record.transform?.readableEnded){
      let deadline;
      try{
        await Promise.race([record.finalization,new Promise(resolve=>{
          deadline=setTimeout(resolve,MAX_COMPLETE_FINALIZATION_WAIT_MS);
        })]);
      }finally{clearTimeout(deadline);}
    }
    if(group?.retired||group?.entries.get(keyFor(identity))!==record)return null;
    if(!record?.complete||record.active||record.disabled)return null;
    const lease=await acquireRecordFile(group,record,record.readyPath,record.bytes);
    if(!lease)return null;
    const stat=await lease.handle.stat();
    if(stat.size!==record.bytes){await lease.release();return null;}
    return {...lease,bytes:record.bytes};
  }
  async function verifiedH264Rap(handle,fragment,track,config){
    const rap=track.rap;
    if(!rap?.independent||config.videoCodec!=='avc1'
      ||![1,2,3,4].includes(config.videoNalLength)
      ||rap.sampleBytes>MAX_RAP_SAMPLE_CHECK_BYTES)return false;
    const sampleAt=fragment.offset+rap.sampleOffset;
    if(!Number.isSafeInteger(sampleAt)||sampleAt<fragment.offset+8
      ||sampleAt+rap.sampleBytes>fragment.end)return false;
    const data=Buffer.allocUnsafe(rap.sampleBytes);
    const {bytesRead}=await handle.read(data,0,data.length,sampleAt);
    if(bytesRead!==data.length)return false;
    for(let at=0;at+config.videoNalLength<data.length;){
      const nalBytes=data.readUIntBE(at,config.videoNalLength);
      at+=config.videoNalLength;
      if(nalBytes===0||at+nalBytes>data.length)return false;
      const type=data[at]&0x1f;
      if(type===5)return true; // actual H.264 IDR, not just an MP4 sync flag
      if(type===1)return false; // non-IDR VCL before any IDR
      at+=nalBytes;
    }
    return false;
  }
  async function lookupWarmWindow({sessionId,fileIndex,sourceIdentity,producerToken,startSeconds,
    maxWindowBytes=MAX_WARM_WINDOW_BYTES}={}){
    if(!SESSION.test(String(sessionId))||!Number.isSafeInteger(fileIndex)||fileIndex<0
      ||typeof sourceIdentity!=='string'||!TOKEN.test(String(producerToken))
      ||!Number.isFinite(startSeconds)||startSeconds<0||!enabled())return null;
    const group=sessions.get(sessionId);
    if(!group||group.retired)return null;
    const record=[...group.entries.values()].find(candidate=>
      candidate.producerToken===producerToken&&candidate.identity.fileIndex===fileIndex
      &&candidate.identity.sourceIdentity===sourceIdentity
      // Encoded H.264 outputs may replay only after verified complete EOF.
      // Their encoded timeline is not yet approved for partial MSE seeks.
      &&candidate.identity.videoMode==='copy'&&!candidate.disabled);
    if(!record)return null;
    const index=record.index,config=index.timescales;
    if(!config||config.videoCodec!=='avc1'||!config.videoTrackId||!config.videoNalLength)return null;
    const fragments=index.fragments.slice(); // immutable committed prefix; never expose in-flight mdat
    if(fragments.length<2||fragments.length>MAX_INDEX_FRAGMENTS)return null;
    const initBytes=fragments[0].offset;
    if(initBytes<=0||initBytes>MAX_INIT_BYTES||!Number.isSafeInteger(initBytes))return null;
    const origin=record.identity.effectiveStartSeconds;
    const raps=[];
    for(let i=0;i<fragments.length;i++){
      const video=fragments[i].tracks.find(track=>track.trackId===config.videoTrackId);
      if(!video?.rap?.independent)continue;
      const time=origin+video.baseDecodeTime/video.timescale;
      if(!Number.isFinite(time))return null;
      raps.push({i,video,time});
    }
    const eligible=raps.filter(rap=>rap.time<=startSeconds+0.001);
    const rap=eligible.at(-1);
    const next=rap&&raps.find(candidate=>candidate.i>rap.i&&candidate.time>startSeconds+0.2);
    if(!rap||!next||startSeconds-rap.time>15)return null;
    const selected=fragments.slice(rap.i,next.i);
    if(!selected.length||!selected.some(fragment=>fragment.tracks.some(track=>
      track.trackId!==config.videoTrackId)))return null;
    for(let i=1;i<selected.length;i++){
      if(selected[i-1].end!==selected[i].offset)return null;
    }
    const first=selected[0],last=selected.at(-1);
    const totalBytes=initBytes+last.end-first.offset;
    const cap=Math.min(MAX_WARM_WINDOW_BYTES,Math.max(4096,Number(maxWindowBytes)||MAX_WARM_WINDOW_BYTES));
    if(totalBytes>cap||last.end>index.safeBytes)return null;
    const lease=await acquireRecordFile(group,record,record.complete?record.readyPath:record.path,last.end);
    if(!lease)return null;
    try{
      if(!await verifiedH264Rap(lease.handle,first,rap.video,config)){
        await lease.release();return null;
      }
      return {...lease,initBytes,bytes:totalBytes,
        ranges:[{start:0,end:initBytes-1},{start:first.offset,end:last.end-1}],
        baseSeconds:origin,windowStartSeconds:rap.time,windowEndSeconds:next.time,
        producerToken:record.producerToken,sourceGeneration:record.producerToken};
    }catch{await lease.release();return null;}
  }
  async function dropSession(sessionId){
    if(!SESSION.test(String(sessionId)))return;
    const group=sessions.get(sessionId);
    if(!group)return;
    sessions.delete(sessionId);
    group.retired=true;retiredGroups.add(group);
    for(const record of group.entries.values()){
      record.disabled=true;record.queue.length=0;
      record.settleFinalization?.();
      if(record.pumpPromise)await record.pumpPromise.catch(()=>{});
      if(record.handle)await record.handle.close().catch(()=>{});
    }
    // Never remove the WebTorrent store, only this instance's generated
    // unguessable cache subdirectory inside the exact UUID session.
    if(!group.pins)await removeGroup(group);
  }
  async function purgeIdle(){
    // Disabling the option stops cache writers, NOT the original video
    // stream: their Transform still forwards every byte untouched. Even a
    // paused/idle FFmpeg cannot keep disabled cache bytes indefinitely.
    for(const id of [...sessions.keys()])await dropSession(id);
    for(const group of [...retiredGroups])if(!group.pins)await removeGroup(group);
  }
  async function debugEntries(sessionId){
    const group=sessions.get(sessionId);
    if(!group)return [];
    return [...group.entries.values()].map(e=>({complete:e.complete,
      fragments:e.index.fragments.map(f=>({...f})),safeBytes:e.index.safeBytes,bytes:e.bytes}));
  }
  return {begin,lookupComplete,openComplete,lookupWarmWindow,dropSession,purgeIdle,debugEntries};
}
