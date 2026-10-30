import test from 'node:test';
import assert from 'node:assert/strict';
import { createRemuxMseSession } from '../frontend/player/remux-mse.js';

function atom(type, length) {
  const bytes = new Uint8Array(length);
  new DataView(bytes.buffer).setUint32(0, length);
  bytes.set([...type].map(c => c.charCodeAt(0)), 4);
  return bytes;
}

function mediaWithLargeMdat(mdatLength) {
  const ftyp = atom('ftyp', 12);
  const moov = atom('moov', 28);
  moov.set([97, 118, 99, 67, 1, 0x64, 0, 0x28], 12);
  const moof = atom('moof', 16);
  const mdat = atom('mdat', mdatLength);
  const media = new Uint8Array(ftyp.length + moov.length + moof.length + mdat.length);
  let at = 0;
  for (const bytes of [ftyp, moov, moof, mdat]) { media.set(bytes, at); at += bytes.length; }
  return media;
}

function syntheticPlayer(t) {
  const previousMediaSource = globalThis.MediaSource;
  const create = URL.createObjectURL;
  const revoke = URL.revokeObjectURL;
  let mse;
  let session;
  let fail;
  const appends = [];
  class Buffer extends EventTarget {
    updating = false;
    buffered = {length: 1, start: () => 0, end: () => 10};
    appendBuffer(bytes) {
      this.updating = true;
      appends.push(bytes.byteLength);
      queueMicrotask(() => { this.updating = false; this.dispatchEvent(new Event('updateend')); });
    }
    remove() { queueMicrotask(() => this.dispatchEvent(new Event('updateend'))); }
  }
  class Source extends EventTarget {
    constructor() {
      super();
      mse = this;
      this.readyState = 'closed';
      queueMicrotask(() => {
        this.readyState = 'open';
        this.dispatchEvent(new Event('sourceopen'));
      });
    }
    addSourceBuffer() { return new Buffer(); }
    endOfStream() { this.readyState = 'ended'; }
    static isTypeSupported() { return true; }
  }
  globalThis.MediaSource = Source;
  URL.createObjectURL = () => 'blob:synthetic-mse';
  URL.revokeObjectURL = () => {};
  t.after(() => {
    session?.close();
    globalThis.MediaSource = previousMediaSource;
    URL.createObjectURL = create;
    URL.revokeObjectURL = revoke;
  });
  async function run(bytes, {networkFailure = false, paused = false,
    mode = 'copy', allowEncodedH264 = false, hdr = false} = {}) {
    const failures = [];
    const video = new EventTarget();
    video.currentTime = 0;
    video.paused = paused;
    let calls = 0;
    const fetchImpl = async () => new Response(new ReadableStream({
      pull(controller) {
        calls++;
        if (calls === 1) controller.enqueue(bytes);
        else if (networkFailure) controller.error(Error('Unexpected network EOF during pause'));
        else controller.close();
      },
    }), {
      headers: {
        'X-Media-Video-Source-Codec': mode === 'h264' ? 'hevc' : 'h264',
        'X-Media-Video-Mode': mode,
        'X-Media-Video-Output-Codec': 'h264',
        'X-Media-Audio-Output-Codec': 'aac',
        ...(hdr ? {'X-Media-HDR-Source': 'hdr10'} : {}),
      },
    });
    fail = (error) => failures.push(error.message || String(error));
    session = createRemuxMseSession({
      video, url: '/synthetic/transcode', fetchImpl,
      isCurrent: () => true, onFailure: fail, allowEncodedH264,
    });
    const timeout = Date.now() + 2500;
    while (!(networkFailure ? appends.length >= 2 : session.ended) &&
      !failures.length && Date.now() < timeout)
      await new Promise(resolve => setTimeout(resolve, 4));
    if (networkFailure) await new Promise(resolve => setTimeout(resolve, 30));
    return {failures, appends, video, ended: session.ended,
      needsResumeRefresh: session.needsResumeRefresh, readyState: mse?.readyState};
  }
  return {run};
}

test('verified H264 encoded output is appendable only with explicit opt-in, without admitting HDR/copy confusion', async t => {
  const {run} = syntheticPlayer(t);
  const bytes = mediaWithLargeMdat(1024);
  const allowed = await run(bytes,{mode:'h264',allowEncodedH264:true});
  assert.deepEqual(allowed.failures, []);
  assert.ok(allowed.appends.length >= 2);
});

test('H264 encoded output is rejected without opt-in, and HDR stays excluded even with opt-in', async t => {
  const {run} = syntheticPlayer(t);
  const denied = await run(mediaWithLargeMdat(1024),{mode:'h264'});
  assert.match(denied.failures.join(','), /Unsupported remux output/);
  const rejectedHdr = await run(mediaWithLargeMdat(1024),{mode:'h264',allowEncodedH264:true,hdr:true});
  assert.match(rejectedHdr.failures.join(','), /Unsupported remux output/);
});

test('a single network read larger than 4 MiB still parses its tiny init and streams valid fragments', async t => {
  const {run} = syntheticPlayer(t);
  const observed = await run(mediaWithLargeMdat(5 * 1024 * 1024));
  assert.deepEqual(observed.failures, []);
  assert.equal(observed.ended, true);
  assert.ok(observed.appends.length >= 2);
});

test('a large valid 17 MiB mdat is streamed in bounded appends without treating bitrate as corruption', async t => {
  const {run} = syntheticPlayer(t);
  const observed = await run(mediaWithLargeMdat(17 * 1024 * 1024));
  assert.deepEqual(observed.failures, []);
  assert.equal(observed.ended, true);
  assert.ok(observed.appends.length >= 2);
  assert.ok(Math.max(...observed.appends) < 5 * 1024 * 1024,
    'avoid keeping 17 MiB media atoms in the JS append queue');
});

test('a transient connection error during an intentional pause keeps buffered playback until actually exhausted', async t => {
  const {run} = syntheticPlayer(t);
  const observed = await run(mediaWithLargeMdat(1024), {networkFailure: true, paused: true});
  assert.deepEqual(observed.failures, [], 'no native restart while paused over already-decoded content');
  assert.equal(observed.needsResumeRefresh, true,
    'the buffered paused frame does not prove the failed producer can resume after a long idle');
  observed.video.paused = false;
  observed.video.currentTime = 7;
  observed.video.dispatchEvent(new Event('timeupdate'));
  assert.deepEqual(observed.failures, [], 'no restart while the requested frame remains buffered');
  observed.video.currentTime = 9.6;
  observed.video.dispatchEvent(new Event('timeupdate'));
  assert.deepEqual(observed.failures, ['Unexpected network EOF during pause'],
    'recover through the normal native path once playback reaches uncached content');
});

test('MSE distinguishes fully ended producer from a still-live buffered producer during long pause', async t => {
  const {run} = syntheticPlayer(t);
  const observed = await run(mediaWithLargeMdat(1024));
  assert.equal(observed.ended, true);
  assert.equal(observed.needsResumeRefresh, true,
    'a completed stream must not be mistaken for a still-live producer based on TimeRanges alone');
});

// Only model *verified MSE buffered* intervals, not torrent downloaded pieces.
// The stream remains pending, like a live FFmpeg producer parked far ahead.
async function restoredWindowHarness(t, {next = [], paused = false, holdSecondWindow = false} = {}) {
  const oldMediaSource = globalThis.MediaSource;
  const oldCreate = URL.createObjectURL, oldRevoke = URL.revokeObjectURL;
  const ranges = [[190, 200]];
  const byteStream = mediaWithLargeMdat(1024);
  const token = 'a'.repeat(48);
  const video = new EventTarget();
  video.currentTime = 190;
  video.readyState = 4;
  video.paused = true;
  video.seeking = false;
  let appends = 0, cancelled = false, current = true, closeRequested = false;
  let liveController = null;
  const failures = [];
  const windowUrls = [];
  const timeRanges = {
    get length() { return ranges.length; },
    start(i) { return ranges[i][0]; },
    end(i) { return ranges[i][1]; },
  };
  class TestBuffer extends EventTarget {
    get buffered() { return timeRanges; }
    get updating() { return false; }
    appendBuffer() {
      appends++;
      if (appends >= 3) ranges.splice(0, ranges.length, [30, 32], ...next);
      queueMicrotask(() => this.dispatchEvent(new Event('updateend')));
    }
    remove() { queueMicrotask(() => this.dispatchEvent(new Event('updateend'))); }
  }
  class TestMediaSource extends EventTarget {
    constructor() {
      super();
      this.readyState = 'closed';
      queueMicrotask(() => {
        this.readyState = 'open';
        this.dispatchEvent(new Event('sourceopen'));
      });
    }
    addSourceBuffer() { return new TestBuffer(); }
    endOfStream() { this.readyState = 'ended'; }
    static isTypeSupported() { return true; }
  }
  globalThis.MediaSource = TestMediaSource;
  URL.createObjectURL = () => 'blob:window-harness';
  URL.revokeObjectURL = () => {};
  const fetchImpl = async (url, {signal}) => {
    if (url.includes('remux-cache/window')) {
      windowUrls.push(url);
      if (holdSecondWindow && windowUrls.length === 2) {
        return new Promise((resolve, reject) => {
          if (signal.aborted) return reject(Error('Cancelled pending window'));
          signal.addEventListener('abort',
            () => reject(Error('Cancelled pending window')), {once: true});
        });
      }
      return new Response(byteStream, {
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Length': String(byteStream.length),
          'X-LVL-Window-Producer': token,
          'X-LVL-Window-Source-Generation': token,
          'X-LVL-Window-Base-Seconds': '0',
          'X-LVL-Window-Start-Seconds': '30',
          'X-LVL-Window-End-Seconds': '32',
        },
      });
    }
    return new Response(new ReadableStream({
      start(controller) { liveController = controller; controller.enqueue(byteStream); },
      cancel() { cancelled = true; },
    }), {headers: {
      'X-Media-Video-Mode': 'copy',
      'X-Media-Video-Source-Codec': 'h264',
      'X-Media-Audio-Output-Codec': 'aac',
      'X-LVL-Remux-Producer': token,
    }});
  };
  const session = createRemuxMseSession({
    video, url: '/synthetic/transcode',
    windowUrl: '/synthetic/remux-cache/window',
    onFailure: error => failures.push(error.message || String(error)),
    isCurrent: () => current, fetchImpl,
  });
  t.after(() => {
    closeRequested = true;
    session.close();
    globalThis.MediaSource = oldMediaSource;
    URL.createObjectURL = oldCreate;
    URL.revokeObjectURL = oldRevoke;
  });
  const deadline = Date.now() + 1500;
  while (appends < 2 && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(appends, 2, 'initial streaming MSE source is ready before historical restore');
  assert.equal(await session.restoreWindow(30.4, 0), true, 'verified historical RAP restored');
  video.currentTime = 30.4;
  video.paused = paused;
  video.dispatchEvent(new Event('playing'));
  return {video, session, ranges, failures, windowUrls,
    get liveController() { return liveController; },
    setCurrent(value) { current = value; },
    get appends() { return appends; },
    get cancelled() { return cancelled; },
    get closeRequested() { return closeRequested; }};
}

test('P1: isolated restored [30,32] falls back once at the approaching frozen edge', async t => {
  const h = await restoredWindowHarness(t);
  h.video.currentTime = 31.67;
  h.video.dispatchEvent(new Event('waiting'));
  await new Promise(resolve => setTimeout(resolve, 950));
  assert.deepEqual(h.failures, ['Cached GOP ended before next live GOP']);
  h.video.dispatchEvent(new Event('waiting'));
  assert.equal(h.failures.length, 1, 'one-way native fallback, no retry loop');
  assert.equal(h.windowUrls.length, 1, 'no independent producer or speculative cache lookup');
});

test('P1: restored [30,32] with distant [190,200] falls back before playback freezes', async t => {
  const h = await restoredWindowHarness(t, {next: [[190, 200]]});
  h.video.currentTime = 31.67;
  h.video.dispatchEvent(new Event('waiting'));
  await new Promise(resolve => setTimeout(resolve, 950));
  assert.deepEqual(h.failures, ['Cached GOP ended before next live GOP']);
});

test('P1: connected buffers and intentional pause never initiate a false native fallback', async t => {
  const h = await restoredWindowHarness(t, {next: [[32, 34]]});
  h.video.currentTime = 31.9;
  h.video.paused = false;
  h.video.dispatchEvent(new Event('timeupdate'));
  await new Promise(resolve => setTimeout(resolve, 650));
  assert.deepEqual(h.failures, [], 'contiguous data past verified window should play normally');
  h.ranges.splice(0, h.ranges.length, [30, 32], [190, 200]);
  h.video.paused = true;
  h.video.dispatchEvent(new Event('pause'));
  h.video.currentTime = 31.99;
  h.video.dispatchEvent(new Event('waiting'));
  await new Promise(resolve => setTimeout(resolve, 650));
  assert.deepEqual(h.failures, [], 'intentional pause must never restart the stream');
});

test('P1: no fallback until restored video is playable; old source/close cannot fire later', async t => {
  const h = await restoredWindowHarness(t, {paused: true});
  h.video.readyState = 1;
  h.video.paused = false;
  h.video.currentTime = 31.85;
  h.video.dispatchEvent(new Event('playing'));
  h.video.dispatchEvent(new Event('waiting'));
  await new Promise(resolve => setTimeout(resolve, 650));
  assert.deepEqual(h.failures, [], 'must not reopen native before playable MSE media');
  h.video.readyState = 4;
  h.video.dispatchEvent(new Event('playing'));
  h.setCurrent(false);
  await new Promise(resolve => setTimeout(resolve, 650));
  assert.deepEqual(h.failures, [], 'stale source generation cannot initiate fallback');
  h.session.close();
  h.video.dispatchEvent(new Event('waiting'));
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.deepEqual(h.failures, [], 'closed session cannot retain recovery callback');
});

test('P1: moving through a restored interval refreshes the bounded stall clock', async t => {
  const h = await restoredWindowHarness(t, {paused: true});
  let clock = Date.now();
  t.mock.method(Date, 'now', () => clock);
  h.video.paused = false;
  h.video.currentTime = 30.4;
  h.video.dispatchEvent(new Event('playing'));
  clock += 6000;
  h.video.currentTime = 30.8;
  h.video.dispatchEvent(new Event('timeupdate'));
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.deepEqual(h.failures, [],
    'progress inside the playable cached window must not be misdiagnosed as a 5s stall');
});

test('P1: cancelling pending restore releases live producer atom boundary without stale append', async t => {
  const h = await restoredWindowHarness(t, {paused: true, holdSecondWindow: true});
  const before = h.appends;
  assert.equal(before, 3, 'verified initial historical window appended');
  const blockedRestore = h.session.restoreWindow(30.5, 0);
  const deadline = Date.now() + 1200;
  while (h.windowUrls.length < 2 && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(h.windowUrls.length, 2, 'second window in flight');
  h.liveController.enqueue(mediaWithLargeMdat(128).subarray(40)); // next moof+mdat
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(h.appends, before, 'live append is parked at the atom boundary');
  h.session.cancelRestore();
  assert.equal(await blockedRestore, false, 'cancelled historical window cannot be installed');
  const unblockedDeadline = Date.now() + 1200;
  while (h.appends === before && Date.now() < unblockedDeadline)
    await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(h.appends, before + 1, 'live source resumed after cancellation');
  h.video.paused = false;
  h.video.currentTime = 31.75;
  h.video.dispatchEvent(new Event('playing'));
  await new Promise(resolve => setTimeout(resolve, 450));
  assert.deepEqual(h.failures, [], 'cancelled restore must not arm obsolete P1 fallback');
});
