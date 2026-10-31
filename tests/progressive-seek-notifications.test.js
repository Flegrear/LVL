import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {EventEmitter} from 'node:events';
import path from 'node:path';
import vm from 'node:vm';

const server=readFileSync(new URL('../server.js',import.meta.url),'utf8');
const app=readFileSync(new URL('../app.js',import.meta.url),'utf8');
const ID='12345678-1234-4234-8234-123456789abc';
const KEY='a'.repeat(64);
const CUT=(source,start,end)=>{
  const a=source.indexOf(start),b=source.indexOf(end,a+start.length);
  assert.ok(a>=0&&b>a,`${start} must exist before ${end}`);
  return source.slice(a,b);
};

test('committed-GOP SSE only notifies subscribed identity; navigation closes the subscription',()=>{
  const excerpt=CUT(server,'const progressiveReadyListeners = new Map();',
    'const progressiveVerifiedSource = createProgressiveVerifiedSource({');
  const start=excerpt.indexOf('const progressiveVerifiedSource =');
  assert.ok(start<0,'initialization must remain outside extracted notifier functions');
  const context=vm.createContext({Map,Set,JSON});
  vm.runInContext(excerpt,context);
  const emit=vm.runInContext('emitProgressiveReady',context);
  const close=vm.runInContext('closeProgressiveReadyListeners',context);
  const response=()=>{
    const res={destroyed:false,writableEnded:false,output:[],
      write(chunk){this.output.push(String(chunk));},
      end(){this.writableEnded=true;}};
    return res;
  };
  const a=response(),b=response();
  vm.runInContext('progressiveReadyListeners.set("'+KEY+'",new Set())',context);
  const watchers=vm.runInContext('progressiveReadyListeners.get("'+KEY+'")',context);
  watchers.add({sessionId:ID,res:a});
  watchers.add({sessionId:'other-session',res:b});
  emit({identityKey:'b'.repeat(64),id:'bad'});
  assert.equal(a.output.length,0);
  emit({identityKey:KEY,id:'gop-verified'});
  assert.match(a.output.join(''),/event: ready/);
  assert.equal(a.output.length,1);
  close(ID);
  assert.equal(a.writableEnded,true);
  assert.equal(b.writableEnded,false);
  emit({identityKey:KEY,id:'next'});
  assert.equal(a.output.length,1,'old source cannot receive future ready GOP events');
  assert.equal(b.output.length,2);
});

test('actual progressive/events route only opens bounded GET event stream after cache identity proof',async()=>{
  const source=CUT(server,'async function serveProgressiveSeek(', '\nfunction streamTorrentFile(',);
  const listeners=new Map();
  const session={id:ID,infoHash:'f'.repeat(40),torrent:{files:[{name:'a.mkv',path:'a.mkv',length:4096}]}};
  const cache={status:async()=>({status:'building',identityKey:KEY})};
  const ctx=vm.createContext({
    path,VIDEO_EXTENSIONS:new Set(['.mkv']),torrentRoot:path.resolve('/safe'),
    storage:{limits:()=>({remuxCacheEnabled:true})},progressiveIndexCache:cache,
    progressiveReadyListeners:listeners,
    trackOpenStream(session,res,index){
      session.openStreams=(session.openStreams||0)+1;
      session.activeStreamFiles ||=new Map();
      session.activeStreamFiles.set(index,(session.activeStreamFiles.get(index)||0)+1);
      res.once('close',()=>{
        session.openStreams--;
        const remain=session.activeStreamFiles.get(index)-1;
        if(remain)session.activeStreamFiles.set(index,remain);
        else session.activeStreamFiles.delete(index);
      });
    },
    safeTorrentRelativePath:()=>true,getCachedMediaProbe:()=>({durationSeconds:20}),
    localVerifiedTorrentInputPath:(session,index)=>path.resolve('/safe',session.id,session.torrent.files[index].path),
    json(res,status,payload){res.writeHead(status);res.end(JSON.stringify(payload));},
  });
  vm.runInContext(source,ctx);
  const route=vm.runInContext('serveProgressiveSeek',ctx);
  const make=(method='GET')=>{
    const req=Object.assign(new EventEmitter(),{method,aborted:false});
    const res=Object.assign(new EventEmitter(),{status:0,body:'',destroyed:false,writableEnded:false,
      writeHead(code,headers){this.status=code;this.headers=headers;return this;},
      write(chunk){this.body+=String(chunk);return true;},
      end(chunk=''){this.body+=String(chunk);this.writableEnded=true;this.emit('close');},
    });
    const url=new URL(`http://localhost/api/torrents/${ID}/files/0/progressive/events`);
    return {req,res,url};
  };
  const head=make('HEAD');
  await route(head.req,head.res,session,0,head.url,false);
  assert.equal(head.res.status,404);
  const get=make();
  await route(get.req,get.res,session,0,get.url,false);
  assert.equal(get.res.status,200);
  assert.match(get.res.headers['Content-Type'],/text\/event-stream/);
  assert.equal(listeners.get(KEY)?.size,1);
  assert.equal(session.openStreams,1,'connected paused Watch counts as a session reader lease');
  get.res.end();
  assert.equal(listeners.has(KEY),false);
  assert.equal(session.openStreams,0,'closed EventSource returns session to ordinary expiry policy');
});

test('frontend ready event invalidates status immediately but does not trust unverified event payload as bright time',()=>{
  const code=CUT(app,'function closeProgressiveEventStream() {','function progressiveSeekContext()');
  const streams=[];
  class EventSource {
    constructor(url){this.url=url;this.closed=false;this.events=new Map();streams.push(this);}
    addEventListener(event,handler){this.events.set(event,handler);}
    close(){this.closed=true;}
    deliver(event){this.events.get('ready')?.({data:JSON.stringify(event)});}
  }
  const context={sessionId:ID,fileIndex:0,audioIndex:0};
  const sourceObject={libraryId:'dummy'};
  const expected={sourceKey:`torrent:${ID}:0`,generation:2,
    audioIndex:0,audioMode:'auto',durationSeconds:96};
  const checks=[];
  const ctx=vm.createContext({
    window:{EventSource},state:{currentSource:sourceObject,transcodeContext:context},
    progressiveEventStream:null,progressiveEventKey:'',
    progressiveRefreshAfterPending:false,progressiveSeekStatusAt:400,
    progressiveSeekStatusPending:false,remuxMseCacheAllowed:true,
    progressiveSeekContext:()=>expected,
    checkProgressiveSeekCache:()=>checks.push('refetch'),
    encodeURIComponent,
  });
  vm.runInContext(code,ctx);
  const connect=vm.runInContext('ensureProgressiveEventStream',ctx);
  connect({status:'building',identityKey:KEY},expected,context,sourceObject);
  assert.equal(streams.length,1);
  streams[0].deliver({start:55,end:77,verified:false});
  assert.deepEqual(checks,['refetch']);
  assert.equal(ctx.progressiveSeekStatusAt,0);
  assert.equal(ctx.progressiveSeekReady,undefined,
    'SSE event metadata never becomes a displayed bright segment without a new verified status');
  ctx.state.currentSource={libraryId:'new-source'};
  streams[0].deliver({id:'stale'});
  assert.equal(streams[0].closed,true);
  assert.deepEqual(checks,['refetch']);
});
