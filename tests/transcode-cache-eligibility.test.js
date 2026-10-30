import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import ffmpegPath from 'ffmpeg-static';
import ffprobe from 'ffprobe-static';
import { createTranscodePlan, transcodeVideoFilter } from '../shared/media/media-compat.js';
import { hardwareVideoEncodingArgs } from '../backend/media/hardware-transcode.js';
import { createRemuxSegmentCache } from '../backend/media/remux-segment-cache.js';
import { ENCODED_CACHE_LIMITS, evaluateEncodedH264CacheEligibility } from '../backend/media/transcode-cache-eligibility.js';
import { pruneExitedTranscodes } from '../backend/media/transcode-slot-lifecycle.js';

const SESSION = 'cd178568-edcb-47fb-85f1-e6ee11fa1b33';
const SOURCE = 'ab'.repeat(20);
const FFMPEG_DIGEST = 'fd'.repeat(32);
const AUDIO_FILTER = 'asetpts=PTS-STARTPTS,aresample=async=1:first_pts=0';

function mediaFixture(video = {}) {
  return {
    durationSeconds: 6,
    video: {
      codec: 'hevc', profile: 'Main', pixelFormat: 'yuv420p', width: 64, height: 64,
      frameRate: 10, colorTransfer: 'bt709', colorPrimaries: 'bt709',
      colorSpace: 'bt709', dolbyVision: null, ...video,
    },
    audioTracks: [{ codec: 'aac', channels: 2 }],
  };
}

function candidate(overrides = {}) {
  const media = overrides.media || mediaFixture();
  const startSeconds = overrides.startSeconds ?? 1;
  const plan = overrides.plan || createTranscodePlan(media, { startSeconds, videoMode: 'h264' });
  return {
    sessionId: SESSION, sourceIdentity: SOURCE, fileIndex: 0, sourceLength: 150_000,
    verifiedProbe: true, media, plan, startSeconds, effectiveStartSeconds: startSeconds,
    remainingDuration: media.durationSeconds - startSeconds, audioTrackOrder: 0,
    videoEncoder: 'libx264', videoEncodingArgs: hardwareVideoEncodingArgs('libx264', media.video.height),
    videoFilter: transcodeVideoFilter(plan), audioFilter: AUDIO_FILTER,
    ffmpegFingerprint: FFMPEG_DIGEST, availableCacheBytes: 128 * 1024 * 1024,
    reservedSourceBytes: 0, estimatedOutputBytes: 1024 * 1024, activeTranscodes: 0,
    ...overrides,
  };
}

function run(binary, args, options = {}) {
  const command = spawnSync(binary, args, { encoding: null, maxBuffer: 16 * 1024 * 1024,
    timeout: 25_000, windowsHide: true, ...options });
  assert.equal(command.status, 0, `FFmpeg fixture failed: ${String(command.stderr).slice(-2000)}`);
  return command.stdout;
}

function probe(file) {
  const bytes = run(ffprobe.path, ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,pix_fmt,width,height,avg_frame_rate,color_transfer,color_primaries,color_space',
    '-of', 'json', file]);
  return JSON.parse(bytes.toString()).streams[0];
}

function fromProbe(raw) {
  const [n, d] = String(raw.avg_frame_rate).split('/').map(Number);
  return mediaFixture({ codec: raw.codec_name, pixelFormat: raw.pix_fmt,
    width: raw.width, height: raw.height, frameRate: n / d,
    colorTransfer: raw.color_transfer, colorPrimaries: raw.color_primaries,
    colorSpace: raw.color_space });
}

test('encoded output candidate is tied to exact source, probe, encoder, audio and clock', () => {
  const allowed = evaluateEncodedH264CacheEligibility(candidate());
  assert.equal(allowed.eligible, true);
  assert.equal(allowed.maxOutputBytes, ENCODED_CACHE_LIMITS.maxOutputBytes);
  assert.equal(allowed.identity.videoCodec, 'hevc');
  assert.equal(allowed.identity.videoMode, 'h264');
  assert.equal(allowed.identity.effectiveStartSeconds, 1);
  assert.equal(allowed.identity.audioTrack, 0);
  assert.equal(allowed.identity.videoEncoder, 'libx264');
  assert.equal(allowed.identity.ffmpegFingerprint, FFMPEG_DIGEST);
  assert.equal(allowed.identity.forcedKeyframes, 'expr:gte(t,n_forced*2)');
  const mutated = candidate({ startSeconds: 1.125 });
  assert.notDeepEqual(allowed.identity,
    evaluateEncodedH264CacheEligibility(mutated).identity,
    'a different requested frame origin cannot reuse a complete encoded output');
});

test('unverified SDR, Main10/HDR, Dolby Vision, hardware encoder and mismatched filters are never admitted', () => {
  const base = candidate();
  const forbidden = [
    { verifiedProbe: false },
    { media: mediaFixture({ pixelFormat: 'yuv420p10le' }) },
    { media: mediaFixture({ codec: 'av1' }) },
    { media: mediaFixture({ codec: 'h264' }) },
    { media: mediaFixture({ profile: 'Main 10' }) },
    { media: mediaFixture({ profile: null }) },
    { media: mediaFixture({ colorTransfer: 'smpte2084', colorPrimaries: 'bt2020', pixelFormat: 'yuv420p10le' }) },
    { media: mediaFixture({ colorTransfer: 'arib-std-b67' }) },
    { media: mediaFixture({ colorSpace: null }) },
    { media: mediaFixture({ dolbyVision: true }) },
    { media: mediaFixture({ width: 3840, height: 2160 }) },
    { media: mediaFixture({ frameRate: 120 }) },
    { videoEncoder: 'h264_nvenc' },
    { videoEncodingArgs: ['-c:v', 'libx264', '-crf', '0'] },
    { videoFilter: 'format=yuv420p' },
    { audioFilter: null },
    { ffmpegFingerprint: 'unknown' },
    { startSeconds: 1, effectiveStartSeconds: 0.85 },
    { remainingDuration: 180.5 },
    { sourceIdentity: 'name-or-file-path' },
    { sourceLength: 20 * 1024 ** 3 + 1 },
    { estimatedOutputBytes: ENCODED_CACHE_LIMITS.maxOutputBytes },
    { availableCacheBytes: 4096 },
    { reservedSourceBytes: 128 * 1024 ** 2 },
    { activeTranscodes: 1 },
    { activeTranscodes: undefined },
  ];
  for (const change of forbidden) {
    const input = candidate({ ...base, ...change });
    if ('media' in change) {
      // Rebuild the real plan from changed source metadata, never substitute
      // a stale SDR plan to manufacture an unsafe positive decision.
      input.plan = createTranscodePlan(change.media, { startSeconds: 1, videoMode: 'h264' });
      input.videoFilter = transcodeVideoFilter(input.plan);
    }
    assert.equal(evaluateEncodedH264CacheEligibility(input).eligible, false,
      `unsafe override incorrectly admitted: ${JSON.stringify(change)}`);
  }
});

test('metadata verification alone is insufficient: resource admission is bounded and cheap', () => {
  assert.equal(evaluateEncodedH264CacheEligibility(candidate({
    availableCacheBytes: 5 * 1024 * 1024, estimatedOutputBytes: 1024 * 1024,
  })).eligible, false);
  assert.equal(evaluateEncodedH264CacheEligibility(candidate({
    availableCacheBytes: 6 * 1024 * 1024, estimatedOutputBytes: 1024 * 1024,
  })).eligible, true);
  const input = candidate();
  const begin = performance.now();
  for (let i = 0; i < 2_000; i++) {
    assert.equal(evaluateEncodedH264CacheEligibility(input).eligible, true);
  }
  assert.ok(performance.now() - begin < 600,
    'a pure per-request cache decision must not add meaningful media startup latency');
});

test('actual FFmpeg HEVC SDR -> H264 + AAC fMP4 is eligible only after probe, indexed and replayed intact',
  { timeout: 60_000 }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lvl-encoded-cache-synthetic-'));
    t.after(async () => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, SESSION));
    const input = path.join(root, 'input.mkv');
    run(ffmpegPath, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=10:duration=6',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=6',
      '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx265', '-threads', '1',
      '-x265-params', 'pools=1:frame-threads=1:log-level=error', '-pix_fmt', 'yuv420p',
      '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
      '-c:a', 'aac', '-y', input]);
    const actual = probe(input);
    assert.deepEqual([actual.codec_name, actual.pix_fmt, actual.color_transfer,
      actual.color_primaries, actual.color_space], ['hevc', 'yuv420p', 'bt709', 'bt709', 'bt709']);
    const media = fromProbe(actual);
    const plan = createTranscodePlan(media, { startSeconds: 1, videoMode: 'h264' });
    const args = [
      '-v', 'error', '-ss', '1', '-i', input, '-map', '0:v:0', '-map', '0:a:0?',
      ...hardwareVideoEncodingArgs('libx264', media.video.height),
      '-pix_fmt', 'yuv420p', '-vf', transcodeVideoFilter(plan),
      '-force_key_frames', 'expr:gte(t,n_forced*2)',
      '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-af', AUDIO_FILTER,
      '-t', '5', '-avoid_negative_ts', 'make_zero',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1',
    ];
    const encoded = run(ffmpegPath, args);
    assert.ok(encoded.length > 5_000);
    const admission = evaluateEncodedH264CacheEligibility(candidate({
      media, plan, sourceLength: (await fs.stat(input)).size,
      videoFilter: transcodeVideoFilter(plan),
      availableCacheBytes: 64 * 1024 * 1024,
    }));
    assert.equal(admission.eligible, true, admission.reason);
    const manager = createRemuxSegmentCache({ sessionsRoot: root, enabled: () => true,
      maxEntryBytes: admission.maxOutputBytes,
      allowance: async () => ({ allowed: true, availableBytes: 64 * 1024 * 1024 }),
    });
    const recording = manager.begin(admission.identity);
    assert.ok(recording);
    const outputs = [];
    const stream = Readable.from(Array.from({ length: Math.ceil(encoded.length / 251) },
      (_, i) => encoded.subarray(i * 251, (i + 1) * 251))).pipe(recording.transform);
    stream.on('data', chunk => outputs.push(Buffer.from(chunk)));
    await once(stream, 'end');
    assert.deepEqual(Buffer.concat(outputs), encoded, 'optional recorder cannot modify playback bytes');
    await recording.finish({ success: true });
    const complete = await manager.lookupComplete(admission.identity);
    assert.ok(complete, 'a completed, verified encoded fMP4 is reusable by its exact key');
    assert.equal(complete.bytes, encoded.length);
    assert.deepEqual(await fs.readFile(complete.file), encoded);
    assert.ok(complete.fragments.length >= 3, 'fixture forces repeat H264 IDRs');
    assert.ok(complete.fragments.every(fragment => fragment.tracks.every(track =>
      Number.isSafeInteger(track.baseDecodeTime) && track.timescale > 0)));
    const window = await manager.lookupWarmWindow({ sessionId: SESSION, fileIndex: 0,
      sourceIdentity: SOURCE, producerToken: recording.producerToken, startSeconds: 2.1 });
    assert.equal(window, null, 'encoded output has complete-only replay; partial MSE seeks remain disabled');
    assert.equal(await manager.lookupComplete({ ...admission.identity, startSeconds: 1.125 }), null);
    await manager.dropSession(SESSION);
  });

test('actual FFmpeg HDR10 Main10 source cannot qualify for SDR encoded cache',
  { timeout: 60_000 }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lvl-hdr-cache-deny-'));
    t.after(async () => fs.rm(root, { recursive: true, force: true }));
    const input = path.join(root, 'hdr.mkv');
    run(ffmpegPath, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=8:duration=2',
      '-c:v', 'libx265', '-threads', '1',
      '-x265-params', 'pools=1:frame-threads=1:log-level=error', '-pix_fmt', 'yuv420p10le',
      '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc',
      '-an', '-y', input]);
    const actual = probe(input);
    assert.deepEqual([actual.codec_name, actual.pix_fmt, actual.color_transfer],
      ['hevc', 'yuv420p10le', 'smpte2084']);
    const media = fromProbe(actual);
    const plan = createTranscodePlan(media, { startSeconds: 1, videoMode: 'h264' });
    assert.equal(plan.video.toneMapToSdr, true);
    assert.equal(evaluateEncodedH264CacheEligibility(candidate({ media, plan,
      videoFilter: transcodeVideoFilter(plan), sourceLength: (await fs.stat(input)).size,
    })).eligible, false);
  });

// Execute the real HTTP conversion handler with disposable media and spies.
// This checks the production wiring, not merely the isolated eligibility helper.
const serverSource = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const handlerStart = serverSource.indexOf('async function transcodeTorrentFile(');
const handlerEnd = serverSource.indexOf('\nfunction boundedInteger(', handlerStart);
assert.ok(handlerStart > 0 && handlerEnd > handlerStart, 'server conversion handler must be testable');

function encodedServerFixture({ video = {}, sourceVerified = true, cacheEnabled = true,
  retireAfterFingerprint = false } = {}) {
  const media = mediaFixture(video);
  const session = {
    id: SESSION, infoHash: SOURCE,
    torrent: { files: [{ name: 'author-owned-synthetic.mkv', length: 100_000 }] },
  };
  const cachedOutput = Buffer.from('owned verified-complete synthetic mp4');
  const calls = { admissions: [], allowance: [], lookups: [], begins: [],
    spawns: [], frames: [], releases: 0, verification: 0, torrentGets: 0 };
  let cached = false;
  let activeSession = session;
  const cache = {
    async openComplete(identity) {
      calls.lookups.push(identity);
      if (!cached) return null;
      return {
        bytes: cachedOutput.length,
        handle: { createReadStream() { return Readable.from([cachedOutput]); } },
        async release() { calls.releases++; },
      };
    },
    begin(identity, options) {
      calls.begins.push({ identity, options });
      return { transform: new PassThrough(), producerToken: 'private-encoder-producer',
        async finish() {} };
    },
  };
  const ctx = vm.createContext({
    path, Number, Math, Set, AbortController, setTimeout, clearTimeout, port: 5000,
    ffmpegPath: 'owned-synthetic-ffmpeg',
    exactFfmpegFingerprint: async () => {
      if (retireAfterFingerprint) activeSession = null;
      return FFMPEG_DIGEST;
    },
    MAX_TORRENT_VIDEO_BYTES: 20 * 1024 ** 3, MAX_TRANSCODE_JOBS: 2,
    VIDEO_EXTENSIONS: new Set(['.mkv']), SPEECH_SAMPLE_RATE: 16_000,
    rejectOversizeVideo() { return false; },
    getCachedMediaProbe() { return media; },
    createTranscodePlan, transcodeVideoFilter, hardwareVideoEncodingArgs,
    evaluateEncodedH264CacheEligibility(options) {
      calls.admissions.push(options);
      return evaluateEncodedH264CacheEligibility(options);
    },
    storage: {
      limits() { return { remuxCacheEnabled: cacheEnabled }; },
      async playerCacheAllowance(options) {
        calls.allowance.push(options);
        return { allowed: true, availableBytes: 64 * 1024 * 1024 };
      },
    },
    torrentSessions: { get(id) { calls.torrentGets++; return id === SESSION ? activeSession : null; } },
    isTorrentFileFullyVerified(torrent, index) {
      calls.verification++;
      assert.equal(torrent, session.torrent);
      assert.equal(index, 0);
      return sourceVerified;
    },
    videoTranscodeEncoder: async () => 'libx264',
    activeTranscodes: new Set(), pruneExitedTranscodes,
    remuxSegmentCache: cache, pipeline,
    scheduleSessionExpiry() {}, trackOpenStream() {},
    speechTapeWriter() { return { push() {}, end() {} }; },
    spawn(_binary, args) {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdio = [null, child.stdout, child.stderr, new PassThrough()];
      child.killed = false;
      child.kill = () => { child.killed = true; };
      calls.spawns.push({ args, child });
      return child;
    },
    json(res, status, data) {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    },
  });
  vm.runInContext(serverSource.slice(handlerStart, handlerEnd), ctx);
  const handler = vm.runInContext('transcodeTorrentFile', ctx);
  return {
    media, calls, setCached(value) { cached = value; },
    async request(start = 1) {
      const req = new EventEmitter();
      const res = new PassThrough();
      res.responseHeaders = null;
      res.writeHead = (status, headers) => {
        res.responseStatus = status;
        res.responseHeaders = headers;
      };
      res.flushHeaders = () => {};
      const chunks = [];
      res.on('data', chunk => chunks.push(Buffer.from(chunk)));
      const ended = once(res, 'end');
      const url = new URL(`http://localhost/api/torrents/${SESSION}/files/0/transcode?start=${start}&video=h264&audio=0`);
      await handler(req, res, session, 0, url);
      const spawned = calls.spawns.at(-1);
      if (!spawned && !res.writableEnded)
        throw Error('Server returned without sending an HTTP response or closing the stale session');
      if (spawned && !spawned.child.stdout.writableEnded) {
        spawned.child.stdout.end(Buffer.from('owned synthetic FFmpeg fMP4 stream'));
        spawned.child.stdout.once('end', () => spawned.child.emit('close', 0));
      }
      await ended;
      // The handler releases a cached FileHandle from pipeline().finally,
      // which runs after the response's `end` event has been observed.
      await new Promise(resolve => setImmediate(resolve));
      return { headers: res.responseHeaders, status: res.responseStatus,
        bytes: Buffer.concat(chunks) };
    },
  };
}

test('real server handler admits exact verified SDR encode and forwards 2s forced-keyframe plan with 64MiB recorder cap', async () => {
  const fixture = encodedServerFixture();
  const result = await fixture.request();
  assert.equal(result.status, 200);
  assert.equal(result.headers['X-Media-Video-Mode'], 'h264');
  assert.equal(result.headers['X-Media-Start-Seconds'], '1');
  assert.equal(result.headers['X-Media-Effective-Start-Seconds'], '1');
  assert.equal(result.bytes.toString(), 'owned synthetic FFmpeg fMP4 stream');
  assert.equal(fixture.calls.verification, 1);
  assert.equal(fixture.calls.allowance.length, 1, 'verified source must request shared storage allowance');
  assert.ok(fixture.calls.torrentGets >= 2,
    'pending cache admission must revalidate the active session after the FFmpeg fingerprint');
  assert.equal(fixture.calls.admissions.length, 1);
  assert.equal(fixture.calls.admissions[0].verifiedProbe, true);
  assert.equal(fixture.calls.admissions[0].videoEncoder, 'libx264');
  assert.equal(fixture.calls.admissions[0].ffmpegFingerprint, FFMPEG_DIGEST);
  assert.equal(fixture.calls.begins.length, 1);
  const { identity, options } = fixture.calls.begins[0];
  assert.equal(identity.videoMode, 'h264');
  assert.equal(identity.videoCodec, 'hevc');
  assert.equal(identity.forcedKeyframes, 'expr:gte(t,n_forced*2)');
  assert.equal(options.maxEntryBytes, 64 * 1024 * 1024);
  assert.deepEqual(fixture.calls.lookups[0], identity);
  assert.equal(fixture.calls.allowance.length, 1);
  assert.equal(fixture.calls.allowance[0].additionalBytes,
    2 * Math.ceil(100_000 * 5 / 6) + 4 * 1024 * 1024);
  assert.equal(fixture.calls.allowance[0].reservedSourceBytes, 0);
  const args = fixture.calls.spawns[0].args;
  const at = args.indexOf('-force_key_frames');
  assert.ok(at > 0, 'eligible production conversion explicitly forces repeat IDRs');
  assert.equal(args[at + 1], identity.forcedKeyframes);
  assert.ok(args.includes('libx264'));
  assert.ok(args.includes('setpts=PTS-STARTPTS,format=yuv420p'));
});

test('real server handler replays identical verified SDR encoded cache without a second FFmpeg process', async () => {
  const fixture = encodedServerFixture();
  await fixture.request();
  assert.equal(fixture.calls.spawns.length, 1);
  const identity = fixture.calls.lookups[0];
  fixture.setCached(true);
  const replay = await fixture.request();
  assert.equal(replay.status, 200);
  assert.equal(replay.headers['X-LVL-Remux-Cache'], 'complete-hit');
  assert.equal(replay.headers['Content-Length'], String(replay.bytes.length));
  assert.equal(replay.bytes.toString(), 'owned verified-complete synthetic mp4');
  assert.equal(fixture.calls.spawns.length, 1, 'repeat exact seek requires no duplicate transcode');
  assert.equal(fixture.calls.begins.length, 1, 'complete replay never creates another cache writer');
  assert.deepEqual(fixture.calls.lookups[1], identity);
  assert.equal(fixture.calls.releases, 1, 'cache reader lease must close at HTTP EOF');
});

test('real server handler refuses encoded cache for HEVC Main10 HDR10 and retains original tonemap FFmpeg path', async () => {
  const fixture = encodedServerFixture({ video: {
    profile: 'Main 10', pixelFormat: 'yuv420p10le', colorTransfer: 'smpte2084',
    colorPrimaries: 'bt2020', colorSpace: 'bt2020nc',
  } });
  const result = await fixture.request();
  assert.equal(result.status, 200);
  assert.equal(result.headers['X-Media-HDR-Source'], 'pq');
  assert.equal(result.headers['X-Media-HDR-Output'], 'sdr-bt709');
  assert.equal(fixture.calls.admissions.length, 1, 'probe reaches pure denial policy');
  assert.equal(fixture.calls.lookups.length, 0);
  assert.equal(fixture.calls.begins.length, 0);
  const args = fixture.calls.spawns[0].args;
  assert.equal(args.includes('-force_key_frames'), false,
    'HDR paths must not adopt cache-only 2-second GOP settings');
  assert.ok(args.includes('bt709'));
  assert.ok(args.some(value => String(value).includes('tonemap=hable')));
});

test('real server handler skips all encoded cache work when torrent pieces remain unverified', async () => {
  const fixture = encodedServerFixture({ sourceVerified: false });
  const result = await fixture.request();
  assert.equal(result.status, 200);
  assert.equal(fixture.calls.verification, 1);
  assert.equal(fixture.calls.allowance.length, 0);
  assert.equal(fixture.calls.admissions.length, 0);
  assert.equal(fixture.calls.lookups.length, 0);
  assert.equal(fixture.calls.begins.length, 0);
  assert.equal(fixture.calls.spawns[0].args.includes('-force_key_frames'), false);
});

test('real server handler revalidates source generation after asynchronous FFmpeg fingerprint', async () => {
  const fixture = encodedServerFixture({ retireAfterFingerprint: true });
  const result = await fixture.request();
  assert.equal(result.status, 410, 'retired source should receive an explicit terminal response');
  assert.equal(fixture.calls.verification, 1);
  assert.ok(fixture.calls.torrentGets >= 2);
  assert.equal(fixture.calls.admissions.length, 0,
    'a session retired during asynchronous fingerprinting cannot reach cache admission');
  assert.equal(fixture.calls.begins.length, 0);
  assert.equal(fixture.calls.lookups.length, 0);
  assert.equal(fixture.calls.spawns.length, 0,
    'a retired torrent cannot start an FFmpeg child');
});
