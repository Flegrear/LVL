import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';

const source=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
const start=source.indexOf('function localVerifiedTorrentInputPath(');
const end=source.indexOf('\n// Only a completed, verified, plan-matched indexed file',start);
assert.ok(start>0&&end>start,'use real private server local verified path resolver');
const root=path.resolve('/self-authored-lvl-store');
const ctx=vm.createContext({path,torrentRoot:root,
  safeTorrentRelativePath:value=>typeof value==='string'&&value.length>0
    &&!path.isAbsolute(value)&&!value.split(/[\\/]/).includes('..')});
vm.runInContext(source.slice(start,end),ctx);
const resolve=(session,index=0)=>vm.runInContext('localVerifiedTorrentInputPath',ctx)(session,index);

test('local-only cache uses WebTorrent addUID layout and cannot silently read nonexistent flat path',()=>{
  const id='12345678-1234-4234-8234-123456789abc';
  const hash='95ae9d8f'+'a'.repeat(32);
  const torrent={infoHash:hash,name:'synthetic-show.mkv',addUID:true,
    files:[{name:'synthetic-show.mkv',path:'synthetic-show.mkv'}]};
  assert.equal(resolve({id,torrent}),
    path.resolve(root,id,'synthetic-show.mkv - 95ae9d8f','synthetic-show.mkv'));
  torrent.addUID=false;
  assert.equal(resolve({id,torrent}),path.resolve(root,id,'synthetic-show.mkv'));
});

test('local cache rejects path traversal and unproven torrent identity',()=>{
  const id='12345678-1234-4234-8234-123456789abc';
  const torrent={infoHash:'a'.repeat(40),name:'safe',addUID:true,
    files:[{name:'safe.mkv',path:'../outside.mkv'}]};
  assert.equal(resolve({id,torrent}),null);
  torrent.files[0].path='safe.mkv';torrent.name='../../outside';
  assert.equal(resolve({id,torrent}),null);
  torrent.name='safe';torrent.infoHash='not-a-hash';
  assert.equal(resolve({id,torrent}),null);
});
