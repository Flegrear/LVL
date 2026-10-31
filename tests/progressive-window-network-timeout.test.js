/**
 * Real private Watch requestWindow code, with a fully synthetic HTTP body.
 * A stale, never-finishing window response must release its abortable read;
 * neither the active user torrent nor an HTTP server is touched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const app=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8');
const start=app.indexOf('  const requestWindow = async ({ segment, context: selected, signal }) => {');
const end=app.indexOf('\n  const loader = createStandaloneProgressiveMseLoader(',start);
assert.ok(start>0&&end>start,'test the real bounded Watch progressive window reader');
const source=app.slice(start,end)+'\nrequestWindow;';

test('a server response that never finishes its MP4 body is aborted within a finite deadline',async()=>{
  const sourceContext={sourceKey:'torrent:synthetic:0',generation:2,audioIndex:0,audioMode:'auto'};
  const controller=new AbortController();
  let aborted=0,requestSeen=false;
  const ctx=vm.createContext({
    sameProgressiveSource:()=>true,
    context:sourceContext,
    transcode:{sessionId:'synthetic',fileIndex:0},
    encodeURIComponent,
    AbortSignal:{any:AbortSignal.any.bind(AbortSignal),timeout:()=>AbortSignal.timeout(35)},
    fetch(_url,{signal}){
      requestSeen=true;
      return Promise.resolve({ok:true,headers:{get(name){return {
        'Content-Length':'1024',
        'Content-Type':'video/mp4',
        'X-LVL-Progressive-Source':'synthetic',
        'X-LVL-Progressive-Start-Seconds':'10',
        'X-LVL-Progressive-End-Seconds':'12',
      }[name]??null;}},arrayBuffer(){return new Promise((_resolve,reject)=>{
        signal.addEventListener('abort',()=>{aborted++;reject(Error('HTTP body aborted'));},{once:true});
      });}});
    },
    Uint8Array,Number,Math,Error,
  });
  const reader=vm.runInContext(source,ctx);
  const started=Date.now();
  // AbortSignal.timeout() deliberately uses an unref'd timer in Node; keep
  // the synthetic test loop alive independently of the worker's runtime.
  const keepAlive=setTimeout(()=>{},180);
  try { await assert.rejects(reader({
    segment:{id:'a'.repeat(64),startSeconds:10,endSeconds:12,bytes:1024},
    context:sourceContext,signal:controller.signal,
  }),/aborted/); } finally {clearTimeout(keepAlive);}
  assert.equal(requestSeen,true);
  assert.equal(aborted,1);
  assert.ok(Date.now()-started<1200,'network response must not lock the player indefinitely');
});

test('a source change aborts the same pending MP4 body independently of deadline',async()=>{
  const sourceContext={sourceKey:'torrent:synthetic:0',generation:2,audioIndex:0,audioMode:'auto'};
  const controller=new AbortController();
  let pendingAbort;
  const ctx=vm.createContext({
    sameProgressiveSource:()=>true,context:sourceContext,
    transcode:{sessionId:'synthetic',fileIndex:0},encodeURIComponent,
    AbortSignal:{any:AbortSignal.any.bind(AbortSignal),timeout:()=>AbortSignal.timeout(100)},
    fetch(_url,{signal}){return Promise.resolve({ok:true,
      headers:{get:name=>({'Content-Length':'1024','Content-Type':'video/mp4',
        'X-LVL-Progressive-Source':'synthetic',
        'X-LVL-Progressive-Start-Seconds':'10',
        'X-LVL-Progressive-End-Seconds':'12'}[name]??null)},
      arrayBuffer(){return new Promise((_resolve,reject)=>{
        signal.addEventListener('abort',()=>reject(Error('source abort')),{once:true});
        pendingAbort=true;
      });},
    });},Uint8Array,Number,Math,Error,
  });
  const reader=vm.runInContext(source,ctx);
  const promise=reader({segment:{startSeconds:10,endSeconds:12,bytes:1024},
    context:sourceContext,signal:controller.signal});
  const keepAlive=setTimeout(()=>{},180);
  while(!pendingAbort) await new Promise(resolve=>setImmediate(resolve));
  controller.abort();
  try { await assert.rejects(promise,/source abort/); }
  finally { clearTimeout(keepAlive); }
});
