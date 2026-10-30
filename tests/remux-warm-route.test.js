import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable,PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { readFileSync } from 'node:fs';
import { EventEmitter,once } from 'node:events';
import vm from 'node:vm';

const source=readFileSync(new URL('../server.js',import.meta.url),'utf8');
const begin=source.indexOf('async function serveRemuxWarmWindow(');
const end=source.indexOf('\nasync function transcodeTorrentFile(',begin);
assert.ok(begin>=0&&end>begin,'test actual server window endpoint');
assert.match(source,/remux-cache\\\/window/);

function fixture(t,{hit=true,wrongBytes=false}={}){
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'lvl-private-warm-route-'));
  t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
  const file=path.join(folder,'verified-fragments.mp4');
  fs.writeFileSync(file,Buffer.from('INIT-GAP-COMMITTED-WINDOW-END'));
  const token='a'.repeat(48);
  const session={id:'aacd1234-cd56-42f1-8a56-444444444444',
    infoHash:'private-info-hash',torrent:{files:[{length:2048}]}};
  const calls={lookup:[],release:0,tracked:0};
  const ctx=vm.createContext({
    Number,Buffer,Readable,pipeline,
    trackOpenStream(){calls.tracked++;},
    methodNotAllowed(res,methods){res.writeHead(405,{'Allow':methods.join(', ')});res.end();},
    json(res,status,data){res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));},
    remuxSegmentCache:{
      async lookupWarmWindow(args){
        calls.lookup.push(args);
        if(!hit)return null;
        const handle=await fs.promises.open(file,'r');
        return {handle,initBytes:4,bytes:wrongBytes?10:4+9,
          ranges:wrongBytes?[{start:0,end:10000}]:[{start:0,end:3},{start:9,end:17}],
          baseSeconds:4,windowStartSeconds:6,windowEndSeconds:7,
          producerToken:token,sourceGeneration:token,
          async release(){calls.release++;await handle.close();}};
      },
    },
  });
  vm.runInContext(source.slice(begin,end),ctx);
  async function request(method='GET',qs=`producer=${token}&start=6.37`){
    const req=Object.assign(new EventEmitter(),{method});
    const res=new PassThrough();
    res.status=0;res.headers={};
    res.writeHead=(status,headers)=>{res.status=status;res.headers=headers;};
    const chunks=[];
    res.on('data',buffer=>chunks.push(Buffer.from(buffer)));
    const done=once(res,'end');
    const url=new URL(`http://127.0.0.1/api/torrents/${session.id}/files/0/remux-cache/window?${qs}`);
    await vm.runInContext('serveRemuxWarmWindow',ctx)(req,res,session,0,url);
    await done;
    return {res,body:Buffer.concat(chunks)};
  }
  return {request,calls,token,session};
}

test('same-session MSE route streams only the bounded verified init and RAP window, releasing FileHandle',async t=>{
  const f=fixture(t);
  const {res,body}=await f.request();
  assert.equal(res.status,200);
  assert.equal(body.toString(),'INITCOMMITTED');
  assert.equal(res.headers['Content-Length'],String(body.length));
  assert.equal(res.headers['X-LVL-Window-Base-Seconds'],'4');
  assert.equal(res.headers['X-LVL-Window-Start-Seconds'],'6');
  assert.equal(res.headers['X-LVL-Window-End-Seconds'],'7');
  assert.equal(res.headers['X-LVL-Window-Producer'],f.token);
  assert.equal(res.headers['X-LVL-Window-Source-Generation'],f.token);
  assert.equal(f.calls.lookup[0].sessionId,f.session.id);
  assert.equal(f.calls.lookup[0].sourceIdentity,f.session.infoHash);
  assert.equal(f.calls.lookup[0].startSeconds,6.37);
  assert.equal(f.calls.lookup[0].maxWindowBytes,16*1024*1024);
  assert.equal(f.calls.release,1);
  assert.equal(f.calls.tracked,1);
});

test('invalid/missing/forged cached window requests fail before any media bytes are streamed',async t=>{
  const f=fixture(t,{hit:false});
  for(const query of ['producer=abc&start=6.37',
    `producer=${f.token}&start=-2`,
    `producer=${f.token}&start=2e20`,
    `producer=${f.token}&start=6.123456`]){
    const {res}=await f.request('GET',query);
    assert.equal(res.status,400);
  }
  const head=await f.request('HEAD');
  assert.equal(head.res.status,405);
  const miss=await f.request();
  assert.equal(miss.res.status,404);
  assert.equal(f.calls.lookup.length,1,'only valid GET is forwarded');
  assert.equal(f.calls.release,0);
});

test('reader truncation during HTTP transfer destroys partial response and releases the Windows file lease',async t=>{
  const f=fixture(t,{wrongBytes:true});
  const req=Object.assign(new EventEmitter(),{method:'GET'});
  const res=new PassThrough();
  let status=0;
  res.writeHead=(code)=>{status=code;};
  res.on('data',()=>{});
  res.on('error',()=>{}); // expected pipeline cancellation after source truncation
  const closed=new Promise(resolve=>res.once('close',resolve));
  const url=new URL(`http://127.0.0.1/api/torrents/${f.session.id}/files/0/remux-cache/window?producer=${f.token}&start=6.37`);
  const begin=source.indexOf('async function serveRemuxWarmWindow(');
  const end=source.indexOf('\nasync function transcodeTorrentFile(',begin);
  const context=vm.createContext({
    Number,Buffer,Readable,pipeline,
    remuxSegmentCache:{lookupWarmWindow:async()=>{
      const folder=fs.mkdtempSync(path.join(os.tmpdir(),'lvl-short-reader-'));
      t.after(()=>fs.rmSync(folder,{recursive:true,force:true}));
      const file=path.join(folder,'short.mp4');
      fs.writeFileSync(file,Buffer.from('too-short'));
      const handle=await fs.promises.open(file,'r');
      return {handle,bytes:1000,ranges:[{start:0,end:999}],
        baseSeconds:0,windowStartSeconds:1,windowEndSeconds:2,
        producerToken:f.token,sourceGeneration:f.token,
        async release(){f.calls.release++;await handle.close();}};
    }},
    trackOpenStream(){f.calls.tracked++;},
    json(){throw Error('unexpected error response');},methodNotAllowed(){throw Error('unexpected method')},
  });
  vm.runInContext(source.slice(begin,end),context);
  await vm.runInContext('serveRemuxWarmWindow',context)(req,res,f.session,0,url);
  await closed;
  assert.equal(status,200,'truncated media may only be detected after header flush');
  assert.equal(res.destroyed,true);
  assert.equal(f.calls.release,1,'failed transfer must close the pinned handle');
});
