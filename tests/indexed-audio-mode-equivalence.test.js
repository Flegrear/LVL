import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const server=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
const from=server.indexOf('function equivalentIndexedAudioMode(');
const to=server.indexOf('\nasync function serveIndexedSeek(',from);
assert.ok(from>0&&to>from,'exercise actual indexed MP4 alias policy, not test duplication');
const context=vm.createContext({});
vm.runInContext(server.slice(from,to),context);
const equivalent=vm.runInContext('equivalentIndexedAudioMode',context);

test('Auto selects already verified full-stereo MP4 when output is provably identical',()=>{
  const media={audioTracks:[{codec:'aac',channels:2},{codec:'aac',channels:6},{codec:'aac',channels:1}]};
  assert.equal(equivalent(media,0,'auto'),'stereo');
  assert.equal(equivalent(media,2,'auto'),'stereo');
  assert.equal(equivalent(media,0,'stereo'),'stereo');
  assert.equal(equivalent(media,0,'surround'),'surround','do not override an explicit output identity');
  assert.equal(equivalent(media,1,'auto'),'auto','surround Auto must not alias reduced stereo');
  assert.equal(equivalent(media,1,'stereo'),'stereo');
});

test('never identify unproven/missing track metadata as stereo',()=>{
  for(const value of [undefined,null,0,2.5,9,'unknown']){
    const media={audioTracks:[{channels:value}]};
    assert.equal(equivalent(media,0,'auto'),'auto');
  }
  assert.equal(equivalent(null,0,'auto'),'auto');
});

test('both full MP4 status and actual byte-range endpoint use same canonical plan',()=>{
  const from=server.indexOf('async function serveIndexedSeek(');
  const to=server.indexOf('\nasync function serveProgressiveSeek(',from);
  const route=server.slice(from,to);
  assert.match(route,/audioMode:\s*equivalentIndexedAudioMode\(media,audioIndex,audioMode\)/);
  assert.match(route,/indexedVideoCache\.status\(params/);
  assert.match(route,/indexedVideoCache\.finished\(state\.info\)/);
  assert.match(route,/audioMode=\$\{audioMode\}/,'public URL retains user-selected requested output mode');
});
