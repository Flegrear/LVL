import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter, once } from 'node:events';
import { spawn as spawnProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createTranscodePlan, transcodeVideoFilter } from '../shared/media/media-compat.js';
import { pruneExitedTranscodes } from '../backend/media/transcode-slot-lifecycle.js';

const code = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const begin = code.indexOf('async function transcodeTorrentFile(');
const end = code.indexOf('\nfunction boundedInteger(', begin);
assert.ok(begin > 0 && end > begin, 'exercise live conversion handler, not rewritten stop logic');

function fixture({ autoCloseOnStdout = true, realChild = false, maxJobs = 1 } = {}) {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'lvl-transcode-cancel-'));
  const partial = path.join(folder, 'incomplete.part');
  const calls = { signals: [], released: 0, finish: [], open: 0, closed: 0, children: [], timers: [] };
  const session = { id: 'b39272b5-724c-4389-966a-8e3e1ac339a7', infoHash: 'f00d0123456789abcdef0123456789abcdef0123',
    torrent: { files: [{ name: 'short.mp4', length: 1_000_000 }] } };
  const sessions = new Map([[session.id, session]]);
  const media = { durationSeconds: 90, video: { codec: 'h264', height: 240 }, audioTracks: [{ codec: 'ac3', channels: 2 }] };
  const cache = {
    async openComplete() { return null; },
    begin() {
      writeFileSync(partial, Buffer.from('partial'));
      return { producerToken: 'synthetic', transform: new PassThrough({ highWaterMark: 1024 }),
        async finish({ success }) {
          calls.finish.push(success);
          if (!success) rmSync(partial, { force: true });
        } };
    },
  };
  const ctx = vm.createContext({
    path, pipeline, AbortController, Number, String, Set, port: 5000,
    MAX_TORRENT_VIDEO_BYTES: 20 * 1024 ** 3, MAX_TRANSCODE_JOBS: maxJobs,
    VIDEO_EXTENSIONS: new Set(['.mp4']), rejectOversizeVideo: () => false,
    ffmpegPath: 'synthetic-ffmpeg', getCachedMediaProbe: () => media,
    copiedSeekOrigin: async (_session, _file, start) => ({ verified: true, effectiveStartSeconds: start }),
    createTranscodePlan, transcodeVideoFilter, videoTranscodeEncoder: async () => 'libx264',
    hardwareVideoEncodingArgs: () => ['-c:v', 'libx264'],
    remuxSegmentCache: cache, activeTranscodes: new Set(), pruneExitedTranscodes, torrentSessions: sessions,
    scheduleSessionExpiry() {}, trackOpenStream(_session, res) { calls.open++; res.once('close', () => calls.closed++); },
    internalTorrentSource() { return { url: 'http://127.0.0.1:5000/internal', release() { calls.released++; } }; },
    SPEECH_SAMPLE_RATE: 16000, speechTapeWriter: () => ({ push() {}, end() {} }),
    setTimeout(fn, delay) { const timer = { fn, delay, unref() {} }; calls.timers.push(timer); return timer; },
    clearTimeout(timer) { const index = calls.timers.indexOf(timer); if (index !== -1) calls.timers.splice(index, 1); },
    spawn() {
      if (realChild) {
        const script = `const block=Buffer.alloc(65536,97);function pump(){while(process.stdout.write(block)){}process.stdout.once('drain',pump)}pump();setInterval(()=>{},1000);`;
        const child = spawnProcess(process.execPath, ['-e', script], {
          windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
        });
        const kill = child.kill.bind(child);
        child.kill = (signal = 'SIGTERM') => { calls.signals.push(signal); return kill(signal); };
        calls.children.push(child);
        return child;
      }
      const child = new EventEmitter();
      child.killed = false;
      child.stdout = new PassThrough({ highWaterMark: 1024 });
      child.stderr = new PassThrough();
      child.stdio = [null, child.stdout, child.stderr, null];
      child.kill = (signal = 'SIGTERM') => { calls.signals.push(signal); child.killed = true; return true; };
      if (autoCloseOnStdout) child.stdout.once('close', () => queueMicrotask(() => child.emit('close', 1)));
      calls.children.push(child);
      return child;
    },
    json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); },
  });
  vm.runInContext(code.slice(begin, end), ctx);
  const handler = vm.runInContext('transcodeTorrentFile', ctx);
  function request(at) {
    const req = Object.assign(new EventEmitter(), { method: 'GET', headers: {}, aborted: false });
    const res = new PassThrough({ highWaterMark: 1024 });
    res.status = null;
    res.headersSent = false;
    res.writeHead = (status) => { res.status = status; res.headersSent = true; };
    res.flushHeaders = () => {};
    const url = new URL(`http://localhost/api/torrents/${session.id}/files/0/transcode?start=${at}&video=copy&audio=0`);
    return { req, res, started: handler(req, res, session, 0, url) };
  }
  return { request, calls, partial, active: ctx.activeTranscodes,
    cleanup() {
      for (const child of calls.children) {
        child.stdout.destroy();
        if (realChild && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
      rmSync(folder, { recursive: true, force: true });
    } };
}

test('HTTP abort unblocks FFmpeg stdout and settles child close, slot, recorder .part and diagnostic reader', async (t) => {
  const f = fixture(); t.after(f.cleanup);
  const first = f.request(10); await first.started;
  assert.equal(first.res.status, 200);
  assert.equal(f.active.size, 1);
  assert.equal(existsSync(f.partial), true);
  // Neither HTTP socket nor recorder is consuming fast enough. This makes
  // FFmpeg stdout wait behind real Node stream backpressure during a seek.
  for (let i = 0; i < 40; i++) f.calls.children[0].stdout.write(Buffer.alloc(64 * 1024));
  assert.equal(f.calls.children[0].stdout.writableNeedDrain, true);
  first.res.destroy();
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(f.calls.signals, ['SIGTERM'], 'the first abort sends exactly one graceful termination');
  assert.equal(f.calls.children[0].stdout.destroyed, true, 'unread FFmpeg stdout must be explicitly unblocked on client disconnect');
  assert.equal(f.active.size, 0, 'the child close event, not kill(), releases the conversion slot');
  assert.deepEqual(f.calls.finish, [false], 'an interrupted movie is never cached as complete');
  assert.equal(existsSync(f.partial), false, 'aborted .part recorder must be removed');
  assert.equal(f.calls.released, 1, 'internal reader lease must be released');
  assert.equal(f.calls.closed, 1, 'tracked client response closes once');
  const second = f.request(25); await second.started;
  assert.equal(second.res.status, 200, 'new conversion is admitted, not HTTP 429');
  second.res.destroy();
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(f.active.size, 0);
});

test('stubborn live FFmpeg is escalated to SIGKILL but slot remains reserved until child close', async (t) => {
  const f = fixture({ autoCloseOnStdout: false }); t.after(f.cleanup);
  const first = f.request(10); await first.started;
  first.res.destroy();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.active.size, 1, 'a kill request is not process closure');
  const blocked = f.request(25); await blocked.started;
  assert.equal(blocked.res.status, 429, 'never over-admit a truly live child');
  const escalation = f.calls.timers.find(timer => timer.delay === 2_000);
  assert.ok(escalation, 'cancel must schedule one bounded forced-kill escalation');
  escalation.fn();
  assert.deepEqual(f.calls.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(f.active.size, 1);
  f.calls.children[0].emit('close', 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.active.size, 0);
  assert.equal(f.calls.released, 1);
  assert.deepEqual(f.calls.finish, [false]);
  assert.equal(existsSync(f.partial), false);
});

test('a real OS child writing against backpressure closes after its HTTP consumer disconnects', { timeout: 8_000 }, async (t) => {
  const f = fixture({ realChild: true }); t.after(f.cleanup);
  const first = f.request(10); await first.started;
  const child = f.calls.children[0];
  assert.ok(child.pid > 0, 'use a genuine subprocess and genuine Node stdio pipes');
  const childClosed = once(child, 'close');
  // Allow time for Node child startup and for the unconsumed PassThrough HTTP
  // socket to saturate, so stdout.pipe(recorder).pipe(res) must pause.
  const deadline = Date.now() + 3_000;
  while (child.stdout.readableFlowing !== false && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(child.stdout.readableFlowing, false, 'actual child stdout is backpressured');
  first.res.destroy();
  await Promise.race([
    childClosed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('subprocess close was blocked by abandoned stdout')), 2_500)),
  ]);
  assert.equal(child.stdout.destroyed, true);
  assert.equal(f.active.size, 0);
  assert.deepEqual(f.calls.finish, [false]);
  assert.equal(f.calls.released, 1);
  assert.equal(existsSync(f.partial), false);
});

test('two overlapping rapid seeks abort independently and redundant abort events cannot double-kill or double-release', async (t) => {
  const f = fixture({ maxJobs: 2 }); t.after(f.cleanup);
  const a = f.request(10), b = f.request(25);
  await Promise.all([a.started, b.started]);
  assert.equal(f.active.size, 2);
  a.req.aborted = true;
  a.req.emit('aborted');
  a.res.destroy(); // Both events can arrive for the same disconnection.
  b.res.destroy();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.active.size, 0);
  assert.deepEqual(f.calls.signals, ['SIGTERM', 'SIGTERM']);
  assert.deepEqual(f.calls.finish, [false, false]);
  assert.equal(f.calls.released, 2);
  const c = f.request(85); await c.started;
  assert.equal(c.res.status, 200, 'new seek must be admitted after both earlier children actually close');
  c.res.destroy();
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(f.active.size, 0);
});

test('a healthy completed FFmpeg stream drains to HTTP finish without cancellation or truncated recorder', async (t) => {
  const f = fixture({ autoCloseOnStdout: false }); t.after(f.cleanup);
  const first = f.request(10); await first.started;
  const child = f.calls.children[0];
  const ended = once(first.res, 'finish');
  first.res.resume();
  child.stdout.end(Buffer.alloc(144 * 1024, 0x61));
  await ended;
  child.emit('close', 0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(first.res.writableFinished, true);
  assert.deepEqual(f.calls.signals, [], 'normal response close must never cancel its encoder');
  assert.equal(f.active.size, 0);
  assert.deepEqual(f.calls.finish, [true], 'EOF-complete stream can finalize its recorder');
  assert.equal(f.calls.released, 1);
});
