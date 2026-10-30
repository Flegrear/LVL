import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ffmpeg from 'ffmpeg-static';
import ffprobe from 'ffprobe-static';
import { createIndexedVideoCache, indexedCacheEligibility } from '../backend/media/indexed-video-cache.js';

function details(overrides = {}) {
  const session = { id: 'a1234567-1234-4123-8123-123456789abc', infoHash: 'd'.repeat(40),
    torrent: { pieceLength: 1048576, bitfield: { get: () => true },
      files: [{ name: 'Episode.mkv', offset: 0, length: 16384, downloaded: 16384, done: true }] } };
  return { enabled: true, session, fileIndex: 0, audioIndex: 0, audioMode: 'auto',
    media: { durationSeconds: 3.5, video: { codec: 'h264', profile: 'High', pixelFormat: 'yuv420p',
      bitDepth: 8, width: 160, height: 90, colorTransfer: 'bt709', colorPrimaries: 'bt709', colorSpace: 'bt709' },
      audioTracks: [{ codec: 'aac', channels: 2 }], compatibility: { video: { hdr: false } } }, ...overrides };
}

test('complete verified ordinary H264 High 8-bit SDR MKV is indexed-copy eligible; HDR and unsafe variants are not', () => {
  const x = details();
  const info = indexedCacheEligibility(x);
  assert.equal(info.eligible, true);
  assert.equal(info.identity.videoStrategy, 'copy');
  assert.equal(info.identity.channels, 2);
  for (const video of [
    { pixelFormat: 'yuv420p10le', bitDepth: 10 }, { pixelFormat: 'yuv422p' },
    { profile: 'High 10', bitDepth: 10 }, { hdrKind: 'hdr10' },
    { colorPrimaries: 'bt2020' }, { colorTransfer: 'smpte2084' },
  ]) {
    assert.equal(indexedCacheEligibility({ ...x, media: {
      ...x.media, video: { ...x.media.video, ...video },
    } }).eligible, false, JSON.stringify(video));
  }
  assert.equal(indexedCacheEligibility({ ...x, session: { ...x.session,
    torrent: { ...x.session.torrent, bitfield: { get: () => false } } } }).eligible, false);
});

test('real verified H264/AAC MKV produces faststart MP4 with unchanged video frames and AAC audio',
  { skip: !ffmpeg || !ffprobe?.path, timeout: 45000 }, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lvl-indexed-h264-copy-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const source = path.join(root, 'Episode.mkv');
    const generated = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=duration=3.5:size=160x90:rate=24',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3.5',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast',
      '-c:a', 'aac', '-ac', '2', source], { timeout: 15000 });
    assert.equal(generated.status, 0, String(generated.stderr).slice(-800));
    const x = details();
    x.session.torrent.files[0].length = (await stat(source)).size;
    x.session.torrent.files[0].downloaded = x.session.torrent.files[0].length;
    const info = indexedCacheEligibility(x);
    assert.equal(info.eligible, true);
    const spawns = [];
    const cache = createIndexedVideoCache({ sessionsRoot: root, enabled: () => true,
      allowance: async () => ({ allowed: true }), sourceUrl: () => ({ url: source }),
      ffmpegPath: ffmpeg, ffprobePath: ffprobe.path, isCurrent: () => true,
      spawn: (binary, args, opts) => { spawns.push({ binary, args }); return spawn(binary, args, opts); },
      checkEveryMs: 100 });
    t.after(() => cache.stopAll());
    await cache.build(info);
    const ready = await cache.finished(info);
    assert.ok(ready, 'atomic final output must pass FFprobe validations');
    const ffArgs = spawns.find(s => s.binary === ffmpeg).args;
    assert.deepEqual(ffArgs.slice(ffArgs.indexOf('-c:v'), ffArgs.indexOf('-c:v') + 2), ['-c:v', 'copy'],
      'already compatible H264 must not be unnecessarily reencoded');
    const bytes = await readFile(ready.file);
    const atoms = [];
    for (let i = 0; i + 8 <= bytes.length;) {
      const length = bytes.readUInt32BE(i);
      if (length < 8 || length > bytes.length - i) break;
      atoms.push(bytes.toString('ascii', i + 4, i + 8)); i += length;
    }
    assert.ok(atoms.indexOf('ftyp') >= 0 && atoms.indexOf('moov') < atoms.indexOf('mdat'));
    const hashFrames = file => {
      const p = spawnSync(ffmpeg, ['-v', 'error', '-i', file, '-map', '0:v:0',
        '-f', 'framemd5', '-'], { timeout: 15000 });
      assert.equal(p.status, 0, String(p.stderr).slice(-500));
      return String(p.stdout).split(/\r?\n/).filter(s => s && !s.startsWith('#'))
        .map(line => line.split(',').at(-1).trim());
    };
    assert.deepEqual(hashFrames(ready.file), hashFrames(source), 'all decoded frames survive bit-exact remux');
  });
