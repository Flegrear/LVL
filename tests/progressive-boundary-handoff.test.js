/**
 * Real app.js progressive boundary handoff regressions.
 *
 * Extract the actual helper declarations into an isolated VM and provide
 * deterministic HTMLMediaElement/TimeRanges and deferred append results.
 * Tests never start the app, touch a torrent, or change any production file.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

function actualHelper(name) {
  const match = new RegExp(`^(?:async\\s+)?function\\s+${name}\\s*\\(`, 'm').exec(app);
  assert.ok(match, `Missing app.js helper ${name}; test the actual implementation`);
  const end = app.indexOf('\n}', match.index);
  assert.ok(end > match.index, `Unterminated app.js helper ${name}`);
  return app.slice(match.index, end + 2);
}

const helpers = ['progressiveBufferEndAroundCurrent',
  'continueProgressiveOrRecover'].map(actualHelper).join('\n');
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

function timeRanges(ranges) {
  return {
    length: ranges.length,
    start(index) {
      if (!Number.isInteger(index) || index < 0 || index >= ranges.length)
        throw new RangeError('TimeRanges.start index');
      return ranges[index][0];
    },
    end(index) {
      if (!Number.isInteger(index) || index < 0 || index >= ranges.length)
        throw new RangeError('TimeRanges.end index');
      return ranges[index][1];
    },
  };
}

function environment({
  currentTime = 11.69, metadataEnd = 12,
  buffered = [[0, 8.5], [10, 11.72]],
  indexedReady = false, playing = true, append,
} = {}) {
  const currentSource = { id: 'selected-video' };
  const transcodeContext = { sessionId: 'synthetic-session', fileIndex: 0, audioIndex: 0 };
  const loader = {
    currentWindow: { id: 'gop-5', endSeconds: metadataEnd, initHash: 'verified-init' },
  };
  const calls = { append: 0, indexed: [], native: [] };
  const video = {
    dataset: { progressive: '1', mode: 'transcode' },
    currentTime, paused: !playing, ended: false,
    buffered: timeRanges(buffered),
    currentSrc: 'blob:verified-window', src: 'blob:verified-window',
  };
  const state = {
    currentSource, transcodeContext, mediaDurationMs: 96_000,
    pendingSeek: null, transcodeBaseOffsetSeconds: 0,
  };
  const context = vm.createContext({
    video, state,
    progressiveMseLoader: loader,
    progressiveSeekReady: {
      source: currentSource, context: transcodeContext, generation: 9,
      audioIndex: 0, audioMode: 'auto',
    },
    progressiveContinueController: null,
    progressiveSeekController: null,
    progressiveBoundaryAttempt: null,
    progressiveBoundaryRecovery: null,
    progressiveBoundaryRecoveryPending: false,
    progressiveRecoveryPending: false,
    remuxMseCacheAllowed: true,
    playbackLoadRequestId: 9,
    playerIsPlaying: () => !video.paused,
    absolutePlaybackSeconds: () => Number(video.currentTime),
    readyIndexedVideo: () => indexedReady,
    openIndexedSeekAt: (seconds, options) => {
      calls.indexed.push({ seconds, options });
      return true;
    },
    restartTranscodeAt: (seconds, options) => {
      calls.native.push({ seconds, options });
      return Promise.resolve(true);
    },
    extendProgressivePlayback: options => {
      calls.append++;
      return append ? append(options) : Promise.resolve(false);
    },
    progressiveSeekContext: () => ({
      sourceKey: 'torrent:synthetic-session:0', generation: 9,
      audioIndex: 0, audioMode: 'auto', durationSeconds: 96,
    }),
    isNewSourceFramePending: () => false,
    Number, Math, Promise, AbortController,
  });
  vm.runInContext(helpers, context);
  return {
    video, state, context, calls, loader,
    actualBufferedEnd: () => vm.runInContext('progressiveBufferEndAroundCurrent()', context),
    handoff: args => vm.runInContext(
      `continueProgressiveOrRecover(${JSON.stringify(args)})`, context),
  };
}

test('a GOP buffered through 11.72s uses 11.72, even when its metadata ends at 12s', () => {
  const env = environment();
  assert.equal(env.actualBufferedEnd(), 11.72,
    'the browser may expose fewer buffered frames than the verified GOP metadata');
  env.video.currentTime = 7.5;
  assert.equal(env.actualBufferedEnd(), 8.5,
    'choose the buffered interval containing the current playhead, not the last interval');
});

test('failed append after the last timeupdate recovers at the real buffer edge', async () => {
  const pending = deferred();
  const env = environment({ append: () => pending.promise });
  const work = env.handoff({ force: true, fromEnded: false });
  await flush();
  assert.equal(env.calls.append, 1, 'start exactly one adjacent verified GOP append');
  assert.equal(env.calls.native.length, 0,
    'preserve the current source while the next window is still in flight');
  // No additional timeupdate is fired after this asynchronous rejection:
  // Chromium can be stalled at 11.72 even though metadata says 12.00.
  pending.resolve(false);
  await work;
  await flush();
  assert.equal(env.calls.native.length, 1,
    'a resolved-false append must itself trigger one bounded fallback');
  assert.equal(env.calls.indexed.length, 0);
  assert.ok(env.calls.native[0].seconds >= 11.60
    && env.calls.native[0].seconds <= 11.80,
  'recover at the last playable movie frame, before the unbuffered metadata tail');
  assert.equal(env.calls.native[0].options.wasPlaying, true,
    'continuation must preserve user play intent');
  assert.equal(env.calls.native[0].options.forceNative,true,
    'failed GOP continuation may not re-enter the same optional MSE producer');
});

test('a delayed GOP response after the viewer intentionally paused cannot auto-play or reopen FFmpeg',async()=>{
  const pending=deferred();
  const env=environment({append:()=>pending.promise});
  env.handoff({force:true});
  await flush();
  env.video.paused=true;
  pending.resolve(false);
  await flush();
  assert.equal(env.calls.native.length,0);
  assert.equal(env.calls.indexed.length,0);
  assert.equal(vm.runInContext('progressiveBoundaryAttempt',env.context),null,
    'the single-flight recovery lock releases after a late completion');
});

test('source replacement clears the old recovery lock without allowing stale completion to restart playback',async()=>{
  const pending=deferred();
  let calls=0;
  const env=environment({append:()=>++calls===1?pending.promise:Promise.resolve(true)});
  env.handoff({force:true});
  await flush();
  env.context.progressiveBoundaryAttempt=null;
  env.context.progressiveMseLoader={currentWindow:{id:'gop-new',endSeconds:12}};
  assert.equal(env.handoff({force:true}),true,
    'new verified player must not remain blocked by its predecessor lock');
  await flush();
  pending.resolve(false);
  await flush();
  assert.equal(calls,2);
  assert.equal(env.calls.native.length+env.calls.indexed.length,0,
    'obsolete response cannot restart or override a new source');
});

test('failed GOP append chooses ready full indexed MP4 before another native FFmpeg', async () => {
  const env = environment({ indexedReady: true });
  await env.handoff({ force: true, fromEnded: false });
  await flush();
  assert.equal(env.calls.indexed.length, 1);
  assert.equal(env.calls.native.length, 0);
  assert.equal(env.calls.indexed[0].options.wasPlaying, true);
});

test('concurrent boundary notifications cannot start duplicate append or fallback', async () => {
  const pending = deferred();
  const env = environment({ indexedReady: true, append: () => pending.promise });
  const first = env.handoff({ force: true, fromEnded: false });
  await flush();
  const second = env.handoff({ force: true, fromEnded: false });
  await flush();
  assert.equal(env.calls.append, 1, 'the first in-flight append owns this GOP boundary');
  assert.equal(env.calls.indexed.length + env.calls.native.length, 0,
    'an ignored duplicate must not switch readers while append is pending');
  pending.resolve(false);
  await Promise.all([first, second]);
  await flush();
  assert.equal(env.calls.indexed.length, 1, 'recover once after append fails');
  assert.equal(env.calls.native.length, 0);
});

test('a successful append keeps the progressive MSE reader alive', async () => {
  const env = environment({ append: async () => true, indexedReady: true });
  await env.handoff({ force: true, fromEnded: false });
  await flush();
  assert.equal(env.calls.append, 1);
  assert.equal(env.calls.indexed.length + env.calls.native.length, 0,
    'a successfully extended SourceBuffer must not need a reader swap');
});

test('a stale completed append cannot recover a different selected video or generation', async () => {
  const pending = deferred();
  const env = environment({ append: () => pending.promise, indexedReady: true });
  const work = env.handoff({ force: true, fromEnded: false });
  await flush();
  env.state.currentSource = { id: 'next-video' };
  env.state.transcodeContext = { sessionId: 'next-session', fileIndex: 1 };
  env.context.playbackLoadRequestId++;
  pending.resolve(false);
  await work;
  await flush();
  assert.equal(env.calls.indexed.length + env.calls.native.length, 0,
    'old append completion must never replace a successor source');
});

test('an old loader or stopped progressive mode cannot restart playback', async () => {
  const pending = deferred();
  const env = environment({ append: () => pending.promise });
  const work = env.handoff({ force: true, fromEnded: false });
  await flush();
  env.context.progressiveMseLoader = { currentWindow: { endSeconds: 20 } };
  delete env.video.dataset.progressive;
  pending.resolve(false);
  await work;
  await flush();
  assert.equal(env.calls.indexed.length + env.calls.native.length, 0,
    'replaced/closed progressive MSE must make the old boundary callback inert');
});

test('early GOP ended event resumes playing through a recovered reader', async () => {
  const env = environment({ playing: false, indexedReady: true });
  await env.handoff({ force: true, fromEnded: true });
  await flush();
  assert.equal(env.calls.indexed.length, 1);
  assert.equal(env.calls.indexed[0].options.wasPlaying, true,
    'HTMLMediaElement may be paused at early EOF; ended is a playback continuation');
});
