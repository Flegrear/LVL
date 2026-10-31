import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const begin = source.indexOf('async function serveIndexedSeek(');
const end = source.indexOf('async function serveProgressiveSeek(', begin);
assert.ok(begin > 0 && end > begin, 'actual indexed route is present');
const routeSource = source.slice(begin, end);
const helperBegin=source.indexOf('function startProgressiveWhenNewPieces(');
const helperEnd=source.indexOf('function emitProgressiveReady(',helperBegin);
assert.ok(helperBegin>=0&&helperEnd>helperBegin);
const admissionSource=source.slice(helperBegin,helperEnd);

function harness({ progressiveStatus = 'waiting', cacheEnabled = true, method = 'GET' } = {}) {
  const starts = [];
  const state = { progressiveStatus };
  const id = '12345678-1234-4234-8234-123456789abc';
  const session = {id, torrent:{files:[{name:'Sample.mkv',path:'Sample.mkv',length:4096}]}};
  const context = vm.createContext({
    path, VIDEO_EXTENSIONS: new Set(['.mkv']),
    torrentRoot: path.resolve('/isolated-verified-torrent-root'),
    storage: {limits: () => ({remuxCacheEnabled:cacheEnabled})},
    activeTranscodes:new Set(),progressiveActiveProcesses:new Set(),
    MAX_TRANSCODE_JOBS:2,progressiveStarts:new Map(),
    safeTorrentRelativePath: relative => relative === 'Sample.mkv',
    localVerifiedTorrentInputPath:()=>path.resolve('/isolated-verified-torrent-root',id,'Sample.mkv'),
    equivalentIndexedAudioMode:(_media,_index,mode)=>mode,
    getCachedMediaProbe: () => ({ durationSeconds: 16 }),
    progressiveIndexCache: {
      status: async () => ({status: state.progressiveStatus,
        identityKey:'a'.repeat(64),verifiedSourceBytes:4096}),
      start: async () => { starts.push('progressive'); },
    },
    indexedVideoCache: {
      status: async (_params, {start}) => {
        starts.push(start?'full-start':'full-read-only');
        return {status:'waiting'};
      },
    },
    json: (res, status, payload) => {res.status=status;res.body=payload;},
  });
  vm.runInContext(admissionSource,context);
  vm.runInContext(routeSource,context);
  const route = vm.runInContext('serveIndexedSeek',context);
  async function request() {
    const req={method,headers:{}},res={};
    const url=new URL(`http://localhost/api/torrents/${id}/files/0/indexed/status?audio=0&audioMode=auto`);
    await route(req,res,session,0,url,true);
    return res;
  }
  return {request,starts,state,claimProgressive(){
    const process={kind:'verified-gop-background'};
    context.activeTranscodes.add(process);
    context.progressiveActiveProcesses.add(process);
  }};
}

test('GET indexed/status arriving FIRST reserves spare converter for progressive GOP production', async()=>{
  const h=harness();
  const first=await h.request();
  assert.equal(first.status,200);
  assert.deepEqual(h.starts,['progressive','full-read-only']);
  h.state.progressiveStatus='building';
  await h.request();
  assert.deepEqual(h.starts,['progressive','full-read-only','full-read-only'],
    'before the progressive worker actually spawns, the full converter must not steal its slot');
  h.claimProgressive();
  await h.request();
  assert.deepEqual(h.starts,['progressive','full-read-only','full-read-only','full-start'],
    'a background full index may optimize using the second idle slot once progressive FFmpeg owns its priority slot');
});

test('a failed progressive admission cannot permanently starve the original complete-index encoder',async()=>{
  const h=harness({progressiveStatus:'waiting'});
  await h.request();
  assert.deepEqual(h.starts,['progressive','full-read-only'],
    'the first attempt prefers an independently ready GOP');
  // Simulate a local optional worker rejecting input or quota before it can
  // spawn. Status is still waiting but the same byte horizon was attempted.
  await h.request();
  assert.deepEqual(h.starts,['progressive','full-read-only','full-start'],
    'the second poll must retain the older full-MP4 optimization instead of getting stuck forever');
});

test('fully ready or ineligible progressive producer allows the original full index optimization',async()=>{
  for(const status of ['ready','source-incomplete','unsupported-video','partial']){
    const h=harness({progressiveStatus:status});
    await h.request();
    assert.deepEqual(h.starts,['full-start'],`full index fallback for ${status}`);
  }
});

test('indexed HEAD never starts any background conversion',async()=>{
  const h=harness({method:'HEAD'});
  await h.request();
  assert.deepEqual(h.starts,['full-read-only']);
});

test('Settings disabled never starts progressive or full index producer',async()=>{
  const h=harness({cacheEnabled:false});
  await h.request();
  // Server delegates the disabled state to the existing full-index admission;
  // the explicit progressive producer cannot start while Settings OFF.
  assert.equal(h.starts.includes('progressive'),false);
});

test('two optional encoders are not mistaken for two foreground players',()=>{
  const start=source.indexOf('const activeForegroundTranscodeCount = () =>');
  const end=source.indexOf('\nconst activeEmbeddedSubtitleJobs',start);
  assert.ok(start>=0&&end>start);
  const activeTranscodes=new Set();
  const indexedActiveProcesses=new Set();
  const progressiveActiveProcesses=new Set();
  const ctx=vm.createContext({activeTranscodes,indexedActiveProcesses,progressiveActiveProcesses,Math});
  vm.runInContext(source.slice(start,end),ctx);
  const count=vm.runInContext('activeForegroundTranscodeCount',ctx);
  const idx={},gop={},playerA={},playerB={};
  for(const [child,set] of [[idx,indexedActiveProcesses],[gop,progressiveActiveProcesses]]){
    activeTranscodes.add(child);set.add(child);
  }
  assert.equal(count(),0,'two optional FFmpeg children may coexist without self-cancellation');
  activeTranscodes.delete(idx);indexedActiveProcesses.delete(idx);
  activeTranscodes.add(playerA);
  assert.equal(count(),1,'one actual foreground plus one background is not a new foreground collision');
  activeTranscodes.delete(gop);progressiveActiveProcesses.delete(gop);
  activeTranscodes.add(playerB);
  assert.equal(count(),2,'two foreground children occupy both slots; new optional work must not start');
});
