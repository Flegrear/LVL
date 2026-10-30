import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { performance } from 'node:perf_hooks';
import ffmpegPath from 'ffmpeg-static';
import { createRemuxSegmentCache } from '../backend/media/remux-segment-cache.js';

const SID = 'ab178568-edcb-47fb-85f1-e6ee11fa1b33';
const SOURCE = '0123456789abcdef0123456789abcdef01234567';

function identity(videoMode = 'h264', startSeconds = 1) {
  return {
    sessionId: SID, sourceIdentity: SOURCE, sourceLength: 100_000,
    fileIndex: 0, startSeconds, effectiveStartSeconds: startSeconds,
    videoMode, videoCodec: videoMode === 'copy' ? 'h264' : 'hevc',
    audioTrack: 0, audioCodec: 'aac', audioChannels: 2,
  };
}

let syntheticMp4;
function mp4() {
  if (!syntheticMp4) {
    const result = spawnSync(ffmpegPath, [
      '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=96x64:rate=10:duration=3',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3',
      '-c:v', 'libx264', '-threads', '1', '-preset', 'ultrafast',
      '-g', '10', '-keyint_min', '10', '-sc_threshold', '0',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-f', 'mp4', 'pipe:1',
    ], { encoding: null, maxBuffer: 8 * 1024 * 1024, timeout: 20_000, windowsHide: true });
    assert.equal(result.status, 0, String(result.stderr));
    assert.ok(result.stdout.length > 4096);
    syntheticMp4 = result.stdout;
  }
  return syntheticMp4;
}

async function setup(t, { globalCap = 64 * 1024 * 1024, allowance } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lvl-record-cap-synthetic-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, SID));
  const cache = createRemuxSegmentCache({
    sessionsRoot: root, enabled: () => true, maxEntryBytes: globalCap,
    allowance: allowance || (async () => ({ allowed: true, availableBytes: 64 * 1024 * 1024 })),
  });
  return { root, cache };
}

async function send(recorder, data, chunkSize = 233) {
  assert.ok(recorder, 'recorder must be admitted');
  const output = [];
  const chunks = [];
  for (let i = 0; i < data.length; i += chunkSize) chunks.push(data.subarray(i, i + chunkSize));
  const stream = Readable.from(chunks).pipe(recorder.transform);
  stream.on('data', bytes => output.push(Buffer.from(bytes)));
  await once(stream, 'end');
  await recorder.finish({ success: true });
  assert.deepEqual(Buffer.concat(output), data,
    'cache quota exhaustion must never truncate or modify the browser stream');
}

async function fullyEmitWithoutFinalizing(recorder, data) {
  const received = [];
  const stream = Readable.from([data]).pipe(recorder.transform);
  stream.on('data', bytes => received.push(Buffer.from(bytes)));
  await once(stream, 'end');
  assert.deepEqual(Buffer.concat(received), data);
  assert.equal(recorder.transform.writableFinished, true);
  assert.equal(recorder.transform.readableEnded, true);
}

test('per-record exact byte cap retains only an EOF-verified complete encoded movie', async t => {
  const data = mp4();
  const { cache } = await setup(t);
  const encoded = identity();
  const recorder = cache.begin(encoded, { maxEntryBytes: data.length });
  await send(recorder, data);
  const hit = await cache.openComplete(encoded);
  assert.ok(hit, 'exactly equal cap is allowed');
  assert.equal(hit.bytes, data.length);
  const fromDisk = Buffer.alloc(hit.bytes);
  const { bytesRead } = await hit.handle.read(fromDisk, 0, fromDisk.length, 0);
  assert.equal(bytesRead, data.length);
  assert.deepEqual(fromDisk, data);
  await hit.release();
  await cache.dropSession(SID);
});

test('per-record cap exceeding by one byte discards optional fragments and permits a full retry', async t => {
  const data = mp4();
  const { root, cache } = await setup(t);
  const encoded = identity();
  const oversize = cache.begin(encoded, { maxEntryBytes: data.length - 1 });
  await send(oversize, data, 197);
  assert.equal(await cache.openComplete(encoded), null,
    'a successful FFmpeg EOF cannot promote truncated/over-cap cache to complete');
  assert.deepEqual(await cache.debugEntries(SID), []);
  assert.deepEqual(await fs.readdir(path.join(root, SID)), [],
    'over-cap partial .part, metadata and directory must be discarded');

  const retry = cache.begin(encoded, { maxEntryBytes: data.length });
  assert.ok(retry, 'a quota miss must not lock out an identical replay attempt');
  await send(retry, data, 101);
  assert.equal((await cache.lookupComplete(encoded))?.bytes, data.length);
  await cache.dropSession(SID);
});

test('global cap cannot be increased per record; original copy record keeps legacy limit', async t => {
  const data = mp4();
  const globalCap = data.length - 1;
  const { cache } = await setup(t, { globalCap });
  const largeOption = identity();
  await send(cache.begin(largeOption, { maxEntryBytes: data.length + 1_000_000 }), data);
  assert.equal(await cache.lookupComplete(largeOption), null,
    'per-record override must never exceed global cap');

  const noOption = identity('copy', 2);
  await send(cache.begin(noOption), data);
  assert.equal(await cache.lookupComplete(noOption), null,
    'legacy copy recording still obeys the global cap');
  await cache.dropSession(SID);
});

test('a smaller encoded quota never changes a simultaneous ordinary copy recording', async t => {
  const data = mp4();
  const { cache } = await setup(t);
  const encoded = identity('h264', 1);
  const copied = identity('copy', 2);
  const encodedWriter = cache.begin(encoded, { maxEntryBytes: 4096 });
  const copyWriter = cache.begin(copied);
  assert.ok(encodedWriter && copyWriter);
  await Promise.all([send(encodedWriter, data, 71), send(copyWriter, data, 307)]);
  assert.equal(await cache.lookupComplete(encoded), null);
  const copyHit = await cache.lookupComplete(copied);
  assert.ok(copyHit, 'copy-video path remains independently replayable');
  assert.equal(copyHit.bytes, data.length);
  assert.deepEqual(await fs.readFile(copyHit.file), data);
  await cache.dropSession(SID);
});

test('per-record override preserves source-reserving shared budget gate', async t => {
  const data = mp4();
  const seen = [];
  const { root, cache } = await setup(t, {
    allowance: async (bytes, selected) => {
      seen.push({ bytes, session: selected.sessionId, source: selected.sourceIdentity,
        mode: selected.videoMode, fileIndex: selected.fileIndex });
      return { allowed: selected.videoMode === 'copy', availableBytes: 64 * 1024 * 1024 };
    },
  });
  const encoded = identity('h264', 1);
  await send(cache.begin(encoded, { maxEntryBytes: data.length }), data);
  assert.equal(await cache.openComplete(encoded), null,
    'a passing per-record cap cannot override the shared storage decision');
  assert.ok(seen.some(item => item.mode === 'h264'));
  assert.ok(seen.every(item => item.bytes >= 4 * 1024 * 1024 && item.session === SID
    && item.source === SOURCE && item.fileIndex === 0),
  'the existing allowance receives complete source ownership for every reservation');
  assert.deepEqual(await fs.readdir(path.join(root, SID)), []);

  const copied = identity('copy', 2);
  await send(cache.begin(copied), data);
  assert.equal((await cache.lookupComplete(copied))?.bytes, data.length,
    'the same shared budget handler still accepts normal copy requests');
  await cache.dropSession(SID);
});

test('invalid record caps are denied without allocating a writer or weakening default behavior', async t => {
  const { cache } = await setup(t);
  for (const maxEntryBytes of [0, -1, 4095, 4096.5, '8192', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(cache.begin(identity(), { maxEntryBytes }), null, String(maxEntryBytes));
  }
  const recorder = cache.begin(identity());
  await send(recorder, mp4());
  assert.ok(await cache.lookupComplete(identity()));
  await cache.dropSession(SID);
});

test('immediate identical complete lookup waits briefly for drained producer finalization', async t => {
  const data = mp4(), { cache } = await setup(t);
  const source = identity();
  const recorder = cache.begin(source, { maxEntryBytes: data.length });
  await fullyEmitWithoutFinalizing(recorder, data);
  const before = performance.now();
  const pending = cache.openComplete(source);
  await new Promise(resolve => setTimeout(resolve, 85));
  await recorder.finish({ success: true });
  const hit = await pending;
  assert.ok(hit, 'drained optional producer must become available without spawning another FFmpeg');
  assert.ok(performance.now() - before >= 65,
    'lookup must await the producer finalization rather than returning a stale null');
  assert.equal(hit.bytes, data.length);
  await hit.release();
  await cache.dropSession(SID);
});

test('active unended producers return immediately and failed finalization never creates a complete hit', async t => {
  const data = mp4(), { cache } = await setup(t);
  const active = identity();
  const writer = cache.begin(active);
  writer.transform.resume();
  writer.transform.write(data.subarray(0, 1024));
  const before = performance.now();
  assert.equal(await cache.openComplete(active), null);
  assert.ok(performance.now() - before < 550,
    'actively streaming writer may not hold repeat playback for the 1.5s finalization deadline');
  writer.transform.end();
  await writer.finish({ success: false });
  assert.equal(await cache.openComplete(active), null);

  const failed = identity('h264', 2);
  const interrupted = cache.begin(failed);
  await fullyEmitWithoutFinalizing(interrupted, data);
  const pending = cache.openComplete(failed);
  await new Promise(resolve => setTimeout(resolve, 55));
  await interrupted.finish({ success: false });
  assert.equal(await pending, null, 'failed EOF must never be replayed');
  assert.equal(await cache.lookupComplete(failed), null);
  await cache.dropSession(SID);
});

test('never-finalized complete output is bounded to 1500ms then fails closed',
  { timeout: 5_000 }, async t => {
    const data = mp4(), { cache } = await setup(t);
    const source = identity();
    const writer = cache.begin(source);
    await fullyEmitWithoutFinalizing(writer, data);
    const before = performance.now();
    assert.equal(await cache.openComplete(source), null);
    const elapsed = performance.now() - before;
    assert.ok(elapsed >= 1100 && elapsed < 2500,
      `post-EOF fallback must be bounded: observed ${elapsed}ms`);
    await writer.finish({ success: false });
    await cache.dropSession(SID);
  });

test('deleting a source session wakes an in-flight complete replay waiter and fails closed', async t => {
  const data = mp4(), { cache } = await setup(t);
  const source = identity();
  const writer = cache.begin(source);
  await fullyEmitWithoutFinalizing(writer, data);
  const before = performance.now();
  const pending = cache.openComplete(source);
  await new Promise(resolve => setTimeout(resolve, 55));
  await cache.dropSession(SID);
  assert.equal(await pending, null);
  assert.ok(performance.now() - before < 550,
    'session deletion must wake waiting complete-cache readers without delay');
  await writer.finish({ success: false });
});
