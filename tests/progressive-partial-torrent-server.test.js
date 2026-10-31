import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';
import {Readable,PassThrough} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {verifyTorrentFileByteRange} from '../backend/media/verified-torrent-range.js';

const server=readFileSync(new URL('../server.js',import.meta.url),'utf8');
const begin=server.indexOf('async function serveProgressiveSeek(');
const end=server.indexOf('\nfunction streamTorrentFile(',begin);
const helperBegin=server.indexOf('function startProgressiveWhenNewPieces(');
const helperEnd=server.indexOf('function emitProgressiveReady(',helperBegin);
assert.ok(begin>0&&end>begin&&helperBegin>0&&helperEnd>helperBegin);
const src=server.slice(begin,end),helper=server.slice(helperBegin,helperEnd);
const sessionId='12345678-1234-4234-8234-123456789abc';
const sectionId='b'.repeat(64),identityKey='a'.repeat(64);

function fixture({island=false}={}){
  const pieceLength=16*1024,all=256,verified=128;
  const bits=Array.from({length:all},(_,i)=>i<verified);
  if(island){bits[3]=false;bits[4]=false;}
  const file={name:'incomplete.mkv',path:'incomplete.mkv',offset:0,
    length:pieceLength*all,downloaded:pieceLength*verified,done:false};
  const torrent={files:[file],pieceLength,bitfield:{get:i=>bits[i]},
    length:file.length,destroyed:false};
  const session={id:sessionId,infoHash:'f'.repeat(40),torrent};
  const sessions=new Map([[sessionId,session]]);
  const calls={starts:0,readers:0,releases:0};
  const bytes=Buffer.from('fully-validated-standalone-section');
  let statusName='partial',canContinue=true,enabled=true;
  const sourceByteEnd=pieceLength*64-1;
  const cache={
    status:async()=>({status:statusName,complete:false,identityKey,
      canContinue,verifiedSourceBytes:pieceLength*verified,
      ranges:[{id:sectionId,sequence:0,start:0,end:2,
        mediaStart:0,initHash:identityKey,
        videoCodecString:'avc1.42c01e',bytes:bytes.length}]}),
    async start(){calls.starts++;},
    async open(){calls.readers++;return{bytes:bytes.length,
      start:island?4:0,end:island?5:2,
      ...(island?{sourceKind:'isolated-cluster',
        sourceRanges:[{start:0,end:pieceLength-1},
          {start:pieceLength*5,end:pieceLength*7-1}]}:{sourceByteEnd}),
      handle:{createReadStream:({autoClose})=>{
        assert.equal(autoClose,false);return Readable.from([bytes]);}},
      async release(){calls.releases++;}};},
  };
  const ctx=vm.createContext({
    path,VIDEO_EXTENSIONS:new Set(['.mkv']),
    torrentRoot:path.resolve('/disposable-synthetic-source'),
    torrentSessions:sessions,progressiveIndexCache:cache,
    progressiveStarts:new Map(),activeTranscodes:new Set(),MAX_TRANSCODE_JOBS:2,
    storage:{limits:()=>({remuxCacheEnabled:enabled})},
    verifyTorrentFileByteRange,isTorrentFileFullyVerified:()=>false,
    safeTorrentRelativePath:()=>true,
    localVerifiedTorrentInputPath:(session,index)=>path.resolve('/disposable-synthetic-source',session.id,session.torrent.files[index].path),
    getCachedMediaProbe:()=>({durationSeconds:8}),
    trackOpenStream:()=>{},pipeline,
    json(res,status,body){res.writeHead(status);res.end(JSON.stringify(body));},
  });
  vm.runInContext(helper+'\n'+src,ctx);
  const handler=vm.runInContext('serveProgressiveSeek',ctx);
  async function request(action='window'){
    const tail=action==='status'?'status':'window/'+sectionId;
    const url=new URL(`http://localhost/api/torrents/${sessionId}/files/0/progressive/${tail}`);
    const req=Object.assign(new EventEmitter(),{method:'GET',aborted:false,headers:{range:'bytes=0-5'}});
    const res=new PassThrough();res.status=null;res.headers=null;
    res.writeHead=(status,headers={})=>{res.status=status;res.headers=headers;return res;};
    const chunks=[];res.on('data',chunk=>chunks.push(Buffer.from(chunk)));
    await handler(req,res,session,0,url,action==='status');
    return {status:res.status,headers:res.headers,
      body:Buffer.concat(chunks).toString('utf8')};
  }
  return {request,calls,bits,session,file,pieceLength,sourceByteEnd,
    setStatus(value,continuation){statusName=value;canContinue=continuation;},
    setEnabled(value){enabled=value;}};
}

test('a hash-verified completed GOP in an unfinished torrent file is HTTP readable, never a speculative Range',async()=>{
  const f=fixture();
  assert.equal(f.file.done,false,'whole episode is still downloading');
  assert.equal(f.file.downloaded<f.file.length,true);
  const res=await f.request();
  assert.equal(res.status,200);
  assert.equal(res.headers['Accept-Ranges'],'none',
    'an independent GOP is not an arbitrary byte-Range of a partial MP4');
  assert.match(res.body,/fully-validated-standalone-section/);
  assert.equal(f.calls.releases,1);
});

test('if any hash piece required for a previously ready GOP is revoked before HTTP begins, fail closed',async()=>{
  const f=fixture();
  const first=await f.request();assert.equal(first.status,200);
  f.bits[10]=false;
  const denied=await f.request();
  assert.equal(denied.status,404);
  assert.equal(f.calls.releases,2,'pin always released even on invalidated source');
});

test('a distant MKV Cluster is readable across a missing gap ONLY when both separate source byte ranges are verified',async()=>{
  const f=fixture({island:true});
  assert.equal(f.file.done,false);
  assert.equal(f.bits[3],false);
  assert.equal(f.bits[4],false);
  const valid=await f.request();
  assert.equal(valid.status,200,
    'missing intervening pieces need not block an independently decoded verified distant GOP');
  f.bits[6]=false;
  const revoked=await f.request();
  assert.equal(revoked.status,404,
    'a revoked isolated Cluster piece must withdraw exactly its published ready window');
  assert.equal(f.calls.releases,2);
});

test('an extended verified prefix may restart conversion once per new byte horizon, never on repeated status polls',async()=>{
  const f=fixture();
  for(let i=0;i<50;i++)assert.equal((await f.request('status')).status,200);
  assert.equal(f.calls.starts,1,'same hash-verified prefix cannot trigger 50 full re-encodes');
  f.bits[128]=true;
  f.setStatus('partial',true);
  // This synthetic status fixture keeps the same horizon until an actual
  // newly verified prefix is reflected by the cache's verifiedSourceBytes.
  for(let i=0;i<10;i++)await f.request('status');
  assert.equal(f.calls.starts,1);
  f.setStatus('partial',false);
  await f.request('status');
  assert.equal(f.calls.starts,1,'interrupted partial cannot retry without new proven source bytes');
});
