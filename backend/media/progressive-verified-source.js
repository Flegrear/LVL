/**
 * Local-only, hash-bitfield-verified source input for progressive video indexing.
 *
 * This module intentionally NEVER calls WebTorrent.file.createReadStream,
 * WebTorrent.select, internal torrent HTTP, or any network API. Its materialized
 * MKV input contains only source bytes whose *every overlapping torrent
 * piece* was already hash-verified before, during and after the copy.
 * The selected torrent file need NOT have file.done=true / 100% downloaded.
 *
 * API:
 *   inspectProgressiveVerifiedSource({session,fileIndex,maxPrefixBytes,...})
 *     -> {eligible,reason,verifiedPrefix:{start:0,end,bytes},
 *         islands:[{start,end,bytes,decodable:false}],
 *         mediaTimingProven:false,networkReaderAllowed:false,sourceComplete}
 *   createProgressiveVerifiedSource({sessionsRoot,allowance,isCurrent,...})
 *     -> {inspect(params),materialize(params),materializeClusterIsland(params)}
 *   await materialize({session,fileIndex,inputPath,audioIndex,audioMode,signal})
 *     -> {inputPath,bytes,sourceKey,sourceIdentity,sourceVerified(),
 *         mediaTimingProven:false,networkReaderAllowed:false,release()} | null
 *
 * Lease inputPath is an immutable, bounded local .mkv snapshot; hand it to
 * FFmpeg by filesystem path, NEVER replace the source with HTTP peer readers.
 * Retain the lease until the FFmpeg child and probes fully close, then release
 * it; sourceVerified must be checked before publication and as FFmpeg runs.
 * Actual MKV demux headers, per-track timestamp, AVC IDR, AAC and the browser's
 * presented frame remain UNPROVEN here: existing progressive-index-cache's
 * independently decoded FFprobe + H264 NAL/IDR verification must still pass.
 * It is NOT SAFE to concatenate arbitrary disjoint MKV byte islands across
 * missing ranges: codec headers, packet timing and audio preroll cannot be
 * assumed intact. Advisory islands are not independently ready. The narrow
 * exception is a complete, explicitly sized, verified Matroska Cluster with
 * a separately verified EBML/Info/Tracks header. materializeClusterIsland()
 * reconstructs only that proven local input and FFprobe-checks its original
 * decoded keyframe/audio clocks; downstream FFprobe/IDR/remux checks must
 * STILL pass before the section can be published as seekable.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import { verifyTorrentFileByteRange } from './verified-torrent-range.js';

const UUID=/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const HASH=/^[\da-f]{40}$/i;
const DEFAULT_PREFIX=64*1024*1024;
const DEFAULT_CHUNK=64*1024;
const MAX_SCAN_PIECES=8192;
const MAX_CLUSTER=8*1024*1024;
const MAX_HEADER=1024*1024;
const CLUSTER_ID=Buffer.from([0x1f,0x43,0xb6,0x75]);
const safe=value=>Number.isSafeInteger(value)&&value>=0;
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const fail=(reason,extras={})=>({eligible:false,reason,verifiedPrefix:null,islands:[],
  mediaTimingProven:false,networkReaderAllowed:false,sourceComplete:false,...extras});

async function abortableAllowance(allowance,bytes,signal){
  if(signal?.aborted)return null;
  let onAbort;
  const canceled=new Promise(resolve=>{onAbort=()=>resolve(null);
    signal?.addEventListener('abort',onAbort,{once:true});});
  try{return await Promise.race([Promise.resolve().then(()=>allowance(bytes)),canceled]);}
  catch{return null;}
  finally{signal?.removeEventListener('abort',onAbort);}
}

function identityFor({session,fileIndex,audioIndex=0,audioMode='auto',generation=0},end){
  const file=session.torrent.files[fileIndex];
  return Object.freeze({sessionId:session.id,infoHash:session.infoHash.toLowerCase(),
    fileIndex,fileName:file.name,fileLength:file.length,fileOffset:file.offset,
    pieceLength:session.torrent.pieceLength,prefixEnd:end,
    audioIndex,audioMode,generation});
}

export function inspectProgressiveVerifiedSource({session,fileIndex,
  maxPrefixBytes=DEFAULT_PREFIX,maxScanPieces=MAX_SCAN_PIECES,
  audioIndex=0,audioMode='auto',generation=0}={}){
  try{
    const torrent=session?.torrent,file=torrent?.files?.[fileIndex];
    if(!UUID.test(String(session?.id))||!HASH.test(String(session?.infoHash))
      ||!safe(fileIndex)||!file||torrent.destroyed===true
      ||!safe(file.offset)||!safe(file.length)||file.length<1
      ||!safe(torrent.pieceLength)||torrent.pieceLength<1
      ||!Number.isSafeInteger(maxPrefixBytes)||maxPrefixBytes<4096||maxPrefixBytes>512*1024*1024
      ||!Number.isSafeInteger(maxScanPieces)||maxScanPieces<1||maxScanPieces>MAX_SCAN_PIECES
      ||!safe(audioIndex)||audioIndex>64
      ||!['auto','stereo','surround'].includes(audioMode)
      ||!safe(generation)||generation>Number.MAX_SAFE_INTEGER-1
      ||typeof torrent.bitfield?.get!=='function')return fail('invalid-source');
    const pieceLength=torrent.pieceLength,first=Math.floor(file.offset/pieceLength);
    const last=Math.floor((file.offset+file.length-1)/pieceLength);
    const maxEnd=Math.min(file.length, maxPrefixBytes);
    if(!Number.isSafeInteger(last)||last<first)return fail('invalid-source');
    let bytes=0,used=0,runStart=null,runEnd=null;
    const islands=[];
    // First verified island MUST start at file byte zero to contain actual
    // MKV EBML/Tracks headers, and only this prefix can be fed to FFmpeg.
    for(let piece=first;piece<=last&&used<maxScanPieces;piece++,used++){
      const begin=Math.max(0,piece*pieceLength-file.offset);
      const end=Math.min(file.length,(piece+1)*pieceLength-file.offset);
      const check=verifyTorrentFileByteRange(torrent,fileIndex,{start:begin,end:end-1});
      const verified=check.verified===true;
      if(verified&&runStart===null)runStart=begin;
      if(verified)runEnd=end;
      if(!verified&&runStart!==null){
        islands.push({start:runStart,end:runEnd-1,bytes:runEnd-runStart,decodable:false});
        runStart=null;runEnd=null;
      }
      if(bytes===begin && verified && end<=maxEnd)bytes=end;
      // The initial flat decoder input is capped, but its remaining *fully
      // verified* pieces are still candidates for independently decodable
      // later MKV Clusters. Never confuse the bounded prefix snapshot size
      // with the horizon of actually hash-verified torrent pieces.
    }
    if(runStart!==null)islands.push({start:runStart,end:runEnd-1,
      bytes:runEnd-runStart,decodable:false});
    if(bytes<4096)return fail('verified-prefix-unavailable',{islands});
    const evidence=verifyTorrentFileByteRange(torrent,fileIndex,{start:0,end:bytes-1});
    if(!evidence.verified)return fail('verified-prefix-revoked',{islands});
    const sourceIdentity=identityFor({session,fileIndex,audioIndex,audioMode,generation},bytes-1);
    const clusterCandidates=[];
    for(const island of islands){
      if(island.start!==0){clusterCandidates.push(island);continue;}
      // One contiguous verified run can extend beyond the bounded first
      // FFmpeg prefix input. Continue scanning its later complete Clusters
      // via local-only verified EBML header + independent cluster leases,
      // rather than falsely stranding all playback after the first 64MiB.
      if(island.end+1>bytes){
        clusterCandidates.push({start:bytes,end:island.end,
          bytes:island.end+1-bytes,decodable:false});
      }
    }
    return {eligible:true,reason:'verified-local-prefix',
      verifiedPrefix:{start:0,end:bytes-1,bytes},
      islands:clusterCandidates,
      sourceComplete:evidence.fileComplete,
      mediaTimingProven:false,networkReaderAllowed:false,
      sourceIdentity,sourceKey:sha(JSON.stringify(sourceIdentity)),
      firstPiece:evidence.firstPiece,lastPiece:evidence.lastPiece};
  }catch{return fail('invalid-source');}
}

// Strict bounded EBML element reader. Unknown-size (all ones) is accepted for
// the outer Matroska Segment ONLY, never an arbitrary later Cluster: a window
// can be isolated only when its exact byte end is known and already verified.
function ebmlElement(bytes,offset){
  if(offset>=bytes.length)return null;
  const idFirst=bytes[offset];
  let idLen=1,mask=0x80;
  while(idLen<=4&&!(idFirst&mask)){mask>>=1;idLen++;}
  if(idLen>4||offset+idLen>=bytes.length)return null;
  let id=0;
  for(let i=0;i<idLen;i++)id=id*256+bytes[offset+i];
  const sizeOffset=offset+idLen,first=bytes[sizeOffset];
  let sizeLen=1,sizeMask=0x80;
  while(sizeLen<=8&&!(first&sizeMask)){sizeMask>>=1;sizeLen++;}
  if(sizeLen>8||sizeOffset+sizeLen>bytes.length)return null;
  let size=BigInt(first&(sizeMask-1));
  for(let i=1;i<sizeLen;i++)size=(size<<8n)|BigInt(bytes[sizeOffset+i]);
  const unknown=size===(1n<<BigInt(7*sizeLen))-1n;
  if(size>BigInt(Number.MAX_SAFE_INTEGER)&&!unknown)return null;
  const dataStart=sizeOffset+sizeLen;
  const end=unknown?null:dataStart+Number(size);
  return {id,start:offset,dataStart,end,unknown};
}

function matroskaHeaderLength(prefix){
  const ebml=ebmlElement(prefix,0);
  if(ebml?.id!==0x1a45dfa3||ebml.unknown||!safe(ebml.end)
    ||ebml.end>=prefix.length)return null;
  const segment=ebmlElement(prefix,ebml.end);
  if(segment?.id!==0x18538067)return null;
  let cursor=segment.dataStart,info=false,tracks=false;
  while(cursor+8<=prefix.length){
    const member=ebmlElement(prefix,cursor);
    if(!member)return null;
    if(member.id===0x1f43b675){
      if(!info||!tracks)return null;
      return cursor;
    }
    if(member.unknown||!safe(member.end)||member.end>prefix.length)return null;
    if(member.id===0x1549a966)info=true;
    if(member.id===0x1654ae6b)tracks=true;
    cursor=member.end;
  }
  return null;
}

function completeCluster(bytes,at){
  const cluster=ebmlElement(bytes,at);
  if(cluster?.id!==0x1f43b675||cluster.unknown||!safe(cluster.end)
    ||cluster.end>bytes.length||cluster.end<=cluster.dataStart+4
    ||cluster.end-at>MAX_CLUSTER)return null;
  let cursor=cluster.dataStart,timecode=null,blocks=0;
  while(cursor<cluster.end){
    const element=ebmlElement(bytes,cursor);
    if(!element||element.unknown||!safe(element.end)||element.end>cluster.end)return null;
    if(element.id===0xe7){
      const n=element.end-element.dataStart;
      if(!n||n>8)return null;
      let value=0n;
      for(let i=element.dataStart;i<element.end;i++)value=value*256n+BigInt(bytes[i]);
      if(value>BigInt(Number.MAX_SAFE_INTEGER))return null;
      timecode=Number(value);
    }
    if(element.id===0xa3)blocks++;
    cursor=element.end;
  }
  return timecode!==null&&blocks>0 ?{start:at,end:cluster.end,timecode,blocks}:null;
}

async function readLocalExact(file,at,length){
  if(!safe(at)||!safe(length)||length>MAX_CLUSTER)return null;
  const bytes=Buffer.alloc(length);
  let cursor=0;
  while(cursor<length){
    const {bytesRead}=await file.read(bytes,cursor,Math.min(65536,length-cursor),at+cursor);
    if(bytesRead<=0)return null;
    cursor+=bytesRead;
  }
  return bytes;
}

async function probeIsolatedCluster(ffprobePath,inputPath,audioIndex,signal){
  if(!ffprobePath||signal?.aborted)return null;
  let child;
  try{child=spawn(ffprobePath,['-v','error','-show_streams','-show_frames',
    '-show_entries','stream=index,codec_name,codec_type:frame=stream_index,media_type,key_frame,best_effort_timestamp_time',
    '-of','json',inputPath],{windowsHide:true,stdio:['ignore','pipe','pipe']});}
  catch{return null;}
  let output='',failed=false;
  const kill=()=>{failed=true;try{child.kill('SIGTERM');}catch{}};
  const onAbort=()=>kill();
  signal?.addEventListener('abort',onAbort,{once:true});
  const timer=setTimeout(kill,10000);timer.unref?.();
  const code=await new Promise(resolve=>{
    child.stdout.on('data',bytes=>{
      if(failed)return;
      if(output.length+bytes.length>1024*1024){kill();return;}
      output+=String(bytes);
    });
    child.stderr.resume();
    child.once('error',kill);
    child.once('close',resolve);
  });
  clearTimeout(timer);signal?.removeEventListener('abort',onAbort);
  if(code!==0||failed||signal?.aborted)return null;
  try{
    const data=JSON.parse(output);
    const video=(data.streams||[]).filter(x=>x.codec_type==='video');
    const audio=(data.streams||[]).filter(x=>x.codec_type==='audio');
    const frames=(data.frames||[]).filter(x=>x.media_type==='video');
    const track=audio[audioIndex];
    const audioFrames=(data.frames||[]).filter(x=>x.media_type==='audio'
      &&x.stream_index===track?.index);
    if(video.length!==1||!['h264','hevc'].includes(video[0].codec_name)
      ||!track||frames.length<2||Number(frames[0].key_frame)!==1)return null;
    const first=Number(frames[0].best_effort_timestamp_time);
    const last=Number(frames.at(-1).best_effort_timestamp_time);
    const audioFirst=Number(audioFrames[0]?.best_effort_timestamp_time);
    if(!Number.isFinite(first)||!Number.isFinite(last)||first<0||last<=first
      ||first>4*3600||last>4*3600
      ||!Number.isFinite(audioFirst)||audioFirst<0)return null;
    return {firstDecodedVideoPTS:first,lastDecodedVideoPTS:last,
      firstDecodedAudioPTS:audioFirst,decodedVideoFrames:frames.length,
      codec:video[0].codec_name};
  }catch{return null;}
}

export function createProgressiveVerifiedSource({sessionsRoot,
  maxPrefixBytes=DEFAULT_PREFIX,maxChunkBytes=DEFAULT_CHUNK,
  maxScanPieces=MAX_SCAN_PIECES,maxActive=1,
  ffprobePath=null,onDiagnostic=()=>{},
  allowance=async()=>({allowed:false}),isCurrent=()=>false}={}){
  if(!path.isAbsolute(sessionsRoot||'')
    ||!Number.isSafeInteger(maxChunkBytes)||maxChunkBytes<1024||maxChunkBytes>DEFAULT_CHUNK
    ||!safe(maxActive)||maxActive<1||maxActive>4
    ||!Number.isSafeInteger(maxPrefixBytes)||maxPrefixBytes<4096||maxPrefixBytes>512*1024*1024)
    throw Error('Invalid local verified source configuration');
  const active=new Set();
  const diagnostic=reason=>{try{onDiagnostic(reason);}catch{}};
  const inspect=params=>inspectProgressiveVerifiedSource({...params,maxPrefixBytes,maxScanPieces});
  async function materialize(params={}){
    if(active.size>=maxActive||params.signal?.aborted)return null;
    const evidence=inspect(params);
    if(!evidence.eligible||!isCurrent(evidence.sourceIdentity))return null;
    const session=params.session,file=session.torrent.files[params.fileIndex];
    const torrent=session.torrent;
    const original={session,torrent,file,bitfield:torrent.bitfield};
    const end=evidence.verifiedPrefix.end;
    const sourceVerified=()=>{
      if(params.signal?.aborted||session.torrent!==original.torrent
        ||torrent.destroyed===true||torrent.files?.[params.fileIndex]!==file
        ||torrent.bitfield!==original.bitfield
        ||session.infoHash.toLowerCase()!==evidence.sourceIdentity.infoHash
        ||!isCurrent(evidence.sourceIdentity))return false;
      return verifyTorrentFileByteRange(torrent,params.fileIndex,{start:0,end}).verified===true;
    };
    if(!sourceVerified())return null;
    const leaseToken={};active.add(leaseToken); // claim BEFORE any await
    let source=null,writer=null,staging=null,ready=null,dir=null;
    let successful=false;
    try{
      const budget=await abortableAllowance(allowance,
        evidence.verifiedPrefix.bytes+maxChunkBytes,params.signal);
      if(!budget?.allowed||!sourceVerified())return null;
      const root=await fs.realpath(sessionsRoot);
      const home=await fs.realpath(path.join(sessionsRoot,session.id));
      if(path.relative(root,home).toLowerCase()!==session.id.toLowerCase())return null;
      const sourceInput=params.inputPath;
      if(typeof sourceInput!=='string'||!path.isAbsolute(sourceInput))return null;
      const origin=await fs.realpath(sourceInput);
      const relative=path.relative(home,origin);
      if(!relative||relative.startsWith('..')||path.isAbsolute(relative))return null;
      source=await fs.open(origin,'r');
      const initialStat=await source.stat();
      if(!initialStat.isFile()||initialStat.size<evidence.verifiedPrefix.bytes
        ||!sourceVerified())return null;
      const area=path.join(home,'progressive-verified-source');
      await fs.mkdir(area,{recursive:true});
      dir=await fs.mkdtemp(path.join(area,'lease-'));
      staging=path.join(dir,'source.part');
      ready=path.join(dir,'verified-prefix.mkv');
      writer=await fs.open(staging,'wx');
      const block=Buffer.allocUnsafe(maxChunkBytes);
      const digest=crypto.createHash('sha256');
      let total=0;
      while(total<evidence.verifiedPrefix.bytes){
        if(!sourceVerified())return null;
        const count=Math.min(block.length,evidence.verifiedPrefix.bytes-total);
        const check=verifyTorrentFileByteRange(torrent,params.fileIndex,
          {start:total,end:total+count-1});
        if(!check.verified)return null;
        const {bytesRead}=await source.read(block,0,count,total);
        if(bytesRead!==count||!sourceVerified())return null;
        for(let done=0;done<count;){
          const {bytesWritten}=await writer.write(block,done,count-done,null);
          if(!bytesWritten)return null;
          done+=bytesWritten;
        }
        digest.update(block.subarray(0,count));total+=count;
      }
      if(!sourceVerified())return null;
      await writer.sync();await writer.close();writer=null;
      await fs.rename(staging,ready);
      const written=await fs.stat(ready);
      if(!written.isFile()||written.size!==total||!sourceVerified())return null;
      successful=true;
      let released=false;
      return {inputPath:ready,bytes:total,sourceKey:evidence.sourceKey,
        sourceIdentity:evidence.sourceIdentity,contentSha256:digest.digest('hex'),
        sourceVerified,networkReaderAllowed:false,mediaTimingProven:false,
        sourceComplete:evidence.sourceComplete,
        async release(){if(released)return;released=true;active.delete(leaseToken);
          await fs.rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100}).catch(()=>{});},
      };
    }catch{return null;}
    finally{
      await writer?.close().catch(()=>{});
      await source?.close().catch(()=>{});
      if(!successful){active.delete(leaseToken);
        if(dir)await fs.rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100}).catch(()=>{});}
    }
  }
  /**
   * Optional *single* complete MKV Cluster from an isolated verified island.
   * This is a strict EBML-header+whole-cluster local-only input, not an FFmpeg
   * seek/segment cache: even after standalone FFprobe decodes its first
   * keyframe, movie-clock and H264 raw IDR must be verified downstream.
   * Never concatenate noncontiguous clusters or approximate a time offset.
   */
  async function materializeClusterIsland(params={}){
    const evidence=inspect(params);
    if(!evidence.eligible||!evidence.islands.length||!ffprobePath||
      active.size>=maxActive||params.signal?.aborted||!isCurrent(evidence.sourceIdentity))return null;
    const original={session:params.session,torrent:params.session.torrent,
      file:params.session.torrent.files[params.fileIndex],
      bitfield:params.session.torrent.bitfield};
    let proofRanges=null;
    const stillCurrent=()=>params.signal?.aborted!==true
      &&original.session.torrent===original.torrent
      &&original.torrent.destroyed!==true
      &&original.torrent.bitfield===original.bitfield
      &&original.torrent.files?.[params.fileIndex]===original.file
      &&original.session.infoHash.toLowerCase()===evidence.sourceIdentity.infoHash
      &&isCurrent(evidence.sourceIdentity);
    const sourceVerified=()=>stillCurrent()&&Array.isArray(proofRanges)
      &&proofRanges.every(({start,end})=>verifyTorrentFileByteRange(
        original.torrent,params.fileIndex,{start,end}).verified===true);
    const leaseToken={};active.add(leaseToken);
    let source=null,writer=null,dir=null,success=false;
    try{
      const root=await fs.realpath(sessionsRoot);
      const home=await fs.realpath(path.join(sessionsRoot,params.session.id));
      if(path.relative(root,home).toLowerCase()!==params.session.id.toLowerCase())return null;
      if(!path.isAbsolute(params.inputPath||''))return null;
      const input=await fs.realpath(params.inputPath);
      const relative=path.relative(home,input);
      if(!relative||relative.startsWith('..')||path.isAbsolute(relative))return null;
      source=await fs.open(input,'r');
      const stat=await source.stat();
      if(!stat.isFile()||!stillCurrent())return null;
      const headerRead=Math.min(MAX_HEADER,evidence.verifiedPrefix.bytes);
      if(!verifyTorrentFileByteRange(original.torrent,params.fileIndex,
        {start:0,end:headerRead-1}).verified)return null;
      const headerRegion=await readLocalExact(source,0,headerRead);
      const headerLength=headerRegion&&matroskaHeaderLength(headerRegion);
      if(!safe(headerLength)||headerLength<32||headerLength>MAX_HEADER){diagnostic('invalid-ebml-prefix');return null;}
      const header=headerRegion.subarray(0,headerLength);
      for(const island of evidence.islands){
        if(!stillCurrent())return null;
        const candidateLength=Math.min(island.bytes,MAX_CLUSTER);
        if(candidateLength<128||stat.size<island.start+candidateLength)continue;
        if(!verifyTorrentFileByteRange(original.torrent,params.fileIndex,
          {start:island.start,end:island.start+candidateLength-1}).verified)continue;
        const islandData=await readLocalExact(source,island.start,candidateLength);
        if(!islandData||!stillCurrent())return null;
        for(let position=islandData.indexOf(CLUSTER_ID);position>=0;
          position=islandData.indexOf(CLUSTER_ID,position+4)){
          const cluster=completeCluster(islandData,position);
          if(!cluster)continue;
          const start=island.start+cluster.start,end=island.start+cluster.end-1;
          if(safe(params.afterStartBytes)&&start<params.afterStartBytes)continue;
          proofRanges=[{start:0,end:headerLength-1},{start,end}];
          if(!sourceVerified())return null;
          const count=header.length+cluster.end-cluster.start;
          const budget=await abortableAllowance(allowance,count+maxChunkBytes,params.signal);
          if(!budget?.allowed||!sourceVerified())return null;
          const area=path.join(home,'progressive-verified-source');
          await fs.mkdir(area,{recursive:true});
          dir=await fs.mkdtemp(path.join(area,'cluster-'));
          const staging=path.join(dir,'cluster.part');
          const ready=path.join(dir,'verified-island.mkv');
          writer=await fs.open(staging,'wx');
          const clusterBytes=islandData.subarray(cluster.start,cluster.end);
          const digest=sha(Buffer.concat([header,clusterBytes]));
          await writer.writeFile(header);await writer.writeFile(clusterBytes);
          await writer.sync();await writer.close();writer=null;
          if(!sourceVerified())return null;
          await fs.rename(staging,ready);
          const verifiedTime=await probeIsolatedCluster(ffprobePath,ready,
            params.audioIndex??0,params.signal);
          if(!verifiedTime||!sourceVerified()){diagnostic('unverified-cluster-decoding');return null;}
          success=true;
          const sourceIdentity=Object.freeze({...evidence.sourceIdentity,
            sourceKind:'isolated-cluster',clusterStart:start,clusterEnd:end,
            headerEnd:headerLength-1});
          const sourceKey=sha(JSON.stringify(sourceIdentity));
          let released=false;
          return {inputPath:ready,bytes:count,sourceKey,sourceIdentity,
            sourceRanges:proofRanges.map(({start,end})=>({start,end})),
            contentSha256:digest,sourceVerified,
            decodedFirstFramePTS:verifiedTime.firstDecodedVideoPTS,
            decodedLastFramePTS:verifiedTime.lastDecodedVideoPTS,
            decodedFirstAudioPTS:verifiedTime.firstDecodedAudioPTS,
            decodedVideoFrames:verifiedTime.decodedVideoFrames,
            videoCodec:verifiedTime.codec,clusterTimecode:cluster.timecode,
            sourceKind:'isolated-cluster',sourceComplete:false,
            networkReaderAllowed:false,mediaTimingProven:false,
            async release(){if(released)return;released=true;active.delete(leaseToken);
              await fs.rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100}).catch(()=>{});},
          };
        }
      }
      diagnostic('no-complete-verified-cluster');
      return null;
    }catch(error){diagnostic('island-failure:'+String(error?.message||error));return null;}
    finally{
      await writer?.close().catch(()=>{});
      await source?.close().catch(()=>{});
      if(!success){active.delete(leaseToken);
        if(dir)await fs.rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100}).catch(()=>{});}
    }
  }
  return {inspect,materialize,materializeClusterIsland,
    get activeCount(){return active.size;}};
}
