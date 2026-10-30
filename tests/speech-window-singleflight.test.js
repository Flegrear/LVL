import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';

// Exercise the production handler without opening ports, databases or FFmpeg.
// This intentionally extracts only the speech path; HTTP/client behavior is
// represented by independently closable request/response event emitters.
const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const start = server.indexOf('const SPEECH_WINDOW_MAX_SECONDS =');
const stop = server.indexOf('\nfunction decodeSpeechAudio(', start);
assert.ok(start !== -1 && stop > start);

const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function fixture() {
  const sessions = new Map();
  let lastSession = null;
  const decodes = [];
  const probeCalls = [];
  let decodedSamples = new Int16Array(80_000);
  let decodeHook = () => deferred();
  let probeHook = () => Promise.resolve({ audioTracks: [{ codec: 'aac' }, { codec: 'ac3' }], durationSeconds: 180 });
  const context = vm.createContext({
    Buffer, Map, WeakMap, AbortController, Date, queueMicrotask,
    SPEECH_FRAME_MS: 10, SPEECH_SAMPLE_RATE: 16_000, TORRENT_SESSION_TTL_MS: 60_000,
    ffmpegPath: 'simulated-ffmpeg',
    torrentSessions: sessions,
    boundedInteger(value, min, max) {
      const number = Number(value);
      return Number.isSafeInteger(number) && number >= min && number <= max ? number : undefined;
    },
    methodNotAllowed: () => { throw Error('unexpected method rejection'); },
    speechTapeCoverage: () => [],
    speechTapeActivity: () => null,
    async probeTorrentFile(session, index) {
      probeCalls.push([session, index]);
      return probeHook(session, index);
    },
    decodeSpeechAudio(session, fileIndex, options) {
      const job = decodeHook({ session, fileIndex, options });
      decodes.push({ session, fileIndex, options, job });
      return job.promise;
    },
    speechActivityFromPcm(pcm) {
      assert.equal(pcm, decodedSamples);
      return new Uint8Array([12, 30, 45, 72]);
    },
    json(res, status, value) {
      if (res.destroyed || res.writableEnded) throw Error('responded to closed HTTP client');
      res.status = status;
      res.value = value;
      res.writableEnded = true;
    },
  });
  vm.runInContext(server.slice(start, stop), context);
  const makeSession = id => {
    const session = { id, state: 'ready', torrent: {} };
    sessions.set(id, session);
    lastSession = session;
    return session;
  };
  function request(session, { fileIndex = 0, audio = 0, startSeconds = 10, duration = 15 } = {}) {
    const req = new EventEmitter();
    req.method = 'GET';
    req.aborted = false;
    const res = new EventEmitter();
    res.destroyed = false;
    res.writableEnded = false;
    const url = new URL('http://127.0.0.1/speech');
    url.searchParams.set('audio', String(audio));
    url.searchParams.set('start', String(startSeconds));
    url.searchParams.set('duration', String(duration));
    const promise = context.speechActivityWindow(req, res, session, fileIndex, url);
    return { req, res, promise,
      close() { res.destroyed = true; res.emit('close'); req.aborted = true; req.emit('aborted'); },
    };
  }
  const jobsRunning = () => vm.runInContext('activeSpeechJobs', context);
  return { sessions, decodes, probeCalls, makeSession, request, jobsRunning,
    get pcm() { return decodedSamples; },
    set decodeHook(fn) { decodeHook = fn; },
    set probeHook(fn) { probeHook = fn; },
    get inflightCount() {
      context.__inspectionSession = lastSession;
      return vm.runInContext('speechWindowInflight.get(__inspectionSession)?.size ?? 0', context);
    },
    cacheSize() { return vm.runInContext('speechWindowCache.size', context); },
    invalidate(session) { context.invalidateSpeechWindowSession(session); },
    retainUnclosedChild(child) { context.__unclosedChild = child; vm.runInContext('speechUnclosedChildren.add(__unclosedChild)', context); },
    releaseUnclosedChild(child) { context.__unclosedChild = child; vm.runInContext('speechUnclosedChildren.delete(__unclosedChild)', context); },
  };
}

test('RED: simultaneous identical normalized speech windows perform exactly one decode', async () => {
  const f = fixture();
  const session = f.makeSession('same-session');
  const a = f.request(session, { audio: 0, startSeconds: 12.004, duration: 15 });
  const b = f.request(session, { audio: 0, startSeconds: 12.003, duration: 15 });
  await flush();
  assert.equal(f.decodes.length, 1, 'simultaneous equal rounded windows must join one producer');
  f.decodes[0].job.resolve(f.pcm);
  await Promise.all([a.promise, b.promise]);
  assert.equal(a.res.status, 200);
  assert.equal(b.res.status, 200);
  assert.deepEqual(a.res.value, b.res.value);
  assert.equal(f.jobsRunning(), 0);
});

test('distinct normalized windows preserve 2-job limit even when identical clients join', async () => {
  const f = fixture(), session = f.makeSession('two-windows');
  const a = f.request(session, { startSeconds: 10 });
  const b = f.request(session, { startSeconds: 40 });
  const duplicate = f.request(session, { startSeconds: 10 });
  await flush();
  assert.equal(f.decodes.length, 2);
  const rejected = f.request(session, { startSeconds: 70 });
  await rejected.promise;
  assert.equal(rejected.res.status, 429);
  f.decodes.forEach(({ job }) => job.resolve(f.pcm));
  await Promise.all([a.promise, duplicate.promise, b.promise]);
  assert.equal(f.jobsRunning(), 0);
  assert.equal(f.cacheSize(), 2);
});

test('completed windows are cached once; track identity, file and rounded window separate results', async () => {
  const f = fixture(), session = f.makeSession('cache');
  const first = f.request(session, { startSeconds: 1, duration: 14 });
  await flush();
  f.decodes[0].job.resolve(f.pcm);
  await first.promise;
  const repeat = f.request(session, { startSeconds: 1, duration: 14 });
  await repeat.promise;
  assert.equal(f.decodes.length, 1, 'completed exact window uses cached value');
  assert.deepEqual(repeat.res.value, first.res.value);
  const altered = [f.request(session, { startSeconds: 1, duration: 14, audio: 1 }),
    f.request(session, { startSeconds: 1, duration: 14, fileIndex: 1 })];
  await flush();
  assert.equal(f.decodes.length, 3, 'different track or file opens distinct producers');
  f.decodes.slice(1).forEach(({ job }) => job.resolve(f.pcm));
  await Promise.all(altered.map(item => item.promise));
  assert.equal(f.cacheSize(), 3);
});

test('short decoded audio retains HTTP 422 for all joined callers and is not cached', async () => {
  const f = fixture(), session = f.makeSession('short');
  const a = f.request(session), b = f.request(session);
  await flush();
  f.decodes[0].job.resolve(new Int16Array(500));
  await Promise.all([a.promise, b.promise]);
  assert.equal(a.res.status, 422);
  assert.equal(b.res.status, 422);
  assert.equal(a.res.value.error, 'No audio was decoded in this range');
  assert.equal(f.cacheSize(), 0);
});

test('disconnect during a slow metadata probe never starts a decode', async () => {
  const f = fixture(), session = f.makeSession('pending-probe');
  const pending = deferred();
  f.probeHook = () => pending.promise;
  const client = f.request(session);
  await flush();
  client.close();
  pending.resolve({ audioTracks: [{ codec: 'aac' }], durationSeconds: 180 });
  await client.promise;
  assert.equal(f.decodes.length, 0);
  assert.equal(f.jobsRunning(), 0);
  assert.equal(client.req.listenerCount('aborted'), 0);
  assert.equal(client.res.listenerCount('close'), 0);
});

test('failed metadata probe after client disconnect does not emit an orphan rejection or response', async () => {
  const f = fixture(), session = f.makeSession('probe-error-disconnected');
  const pending = deferred();
  f.probeHook = () => pending.promise;
  const client = f.request(session);
  await flush();
  client.close();
  pending.reject(Error('metadata unavailable after disconnect'));
  await client.promise;
  assert.equal(f.decodes.length, 0);
  assert.equal(client.res.status, undefined);
});

test('RED: metadata-phase subscribers are bounded and disconnect without waiting for the shared probe', async () => {
  const f = fixture(), session = f.makeSession('metadata-cap');
  const probe = deferred();
  f.probeHook = () => probe.promise;
  const clients = Array.from({ length: 17 }, () => f.request(session));
  try {
    await flush();
    assert.equal(clients[16].res.status, 429, '17th pending metadata consumer must be rejected immediately');
    const disconnected = clients[0];
    disconnected.close();
    await flush();
    let finished = false;
    void disconnected.promise.then(() => { finished = true; });
    await flush();
    assert.equal(finished, true, 'disconnected waiter must not remain blocked on a shared metadata probe');
  } finally {
    clients.forEach(client => { if (!client.res.writableEnded && !client.res.destroyed) client.close(); });
    probe.resolve({ audioTracks: [{ codec: 'aac' }], durationSeconds: 180 });
    await Promise.allSettled(clients.map(client => client.promise));
  }
  assert.equal(f.decodes.length, 0);
});

test('removing a session during shared metadata probe replies 410 to connected clients without decoding', async () => {
  const f = fixture(), session = f.makeSession('removed-before-probe');
  const probe = deferred();
  f.probeHook = () => probe.promise;
  const a = f.request(session);
  const b = f.request(session);
  await flush();
  f.sessions.delete(session.id);
  f.invalidate(session);
  await Promise.all([a.promise, b.promise]);
  for (const client of [a, b]) {
    assert.equal(client.res.status, 410);
    assert.equal(client.res.writableEnded, true);
    assert.equal(client.req.listenerCount('aborted'), 0);
    assert.equal(client.res.listenerCount('close'), 0);
  }
  probe.reject(Error('the now-irrelevant shared probe failed'));
  await flush();
  assert.equal(f.decodes.length, 0);
});

test('producer errors reach all live subscribers without caching failure; retry creates new job', async () => {
  const f = fixture(), session = f.makeSession('errors');
  const a = f.request(session), b = f.request(session);
  await flush();
  assert.equal(f.decodes.length, 1);
  f.decodes[0].job.reject(Object.assign(Error('decode failed'), { statusCode: 504 }));
  const results = await Promise.allSettled([a.promise, b.promise]);
  assert.deepEqual(results.map(result => result.status), ['rejected', 'rejected']);
  assert.equal(f.cacheSize(), 0);
  assert.equal(f.jobsRunning(), 0);
  const retry = f.request(session);
  await flush();
  assert.equal(f.decodes.length, 2);
  f.decodes[1].job.resolve(f.pcm);
  await retry.promise;
  assert.equal(retry.res.status, 200);
});

test('one disconnected subscriber does not cancel remaining subscriber or write after close', async () => {
  const f = fixture(), session = f.makeSession('clients');
  const a = f.request(session), b = f.request(session);
  await flush();
  a.close();
  f.decodes[0].job.resolve(f.pcm);
  await Promise.all([a.promise, b.promise]);
  assert.equal(a.res.status, undefined);
  assert.equal(b.res.status, 200);
  assert.equal(f.decodes.length, 1);
  assert.equal(a.req.listenerCount('aborted'), 0);
  assert.equal(a.res.listenerCount('close'), 0);
  assert.equal(b.req.listenerCount('aborted'), 0);
});

test('last subscriber disconnect signals cancellation, clears inflight, releases the job slot', async () => {
  const f = fixture(), session = f.makeSession('cancel');
  let cancellationCount = 0;
  f.decodeHook = ({ options }) => {
    const work = deferred();
    options.signal?.addEventListener('abort', () => {
      cancellationCount++;
      work.reject(Object.assign(Error('cancelled'), { statusCode: 499 }));
    }, { once: true });
    return work;
  };
  const a = f.request(session), b = f.request(session);
  await flush();
  a.close();
  assert.equal(cancellationCount, 0, 'remaining live client owns producer');
  b.close();
  await Promise.allSettled([a.promise, b.promise]);
  assert.equal(cancellationCount, 1);
  assert.equal(f.jobsRunning(), 0);
  assert.equal(f.cacheSize(), 0);
});

test('session removal invalidates cached windows and cancels outstanding subscribers', async () => {
  const f = fixture(), session = f.makeSession('removed');
  const cached = f.request(session, { startSeconds: 12 });
  await flush();
  f.decodes[0].job.resolve(f.pcm);
  await cached.promise;
  assert.equal(f.cacheSize(), 1);
  let aborts = 0;
  f.decodeHook = ({ options }) => {
    const pending = deferred();
    options.signal.addEventListener('abort', () => {
      aborts++;
      pending.reject(Object.assign(Error('session removed'), { statusCode: 499 }));
    }, { once: true });
    return pending;
  };
  const left = f.request(session, { startSeconds: 33 });
  const right = f.request(session, { startSeconds: 33 });
  await flush();
  assert.equal(f.jobsRunning(), 1);
  f.sessions.delete(session.id);
  f.invalidate(session);
  await Promise.allSettled([left.promise, right.promise]);
  await flush();
  assert.equal(aborts, 1);
  assert.equal(f.cacheSize(), 0);
  assert.equal(f.inflightCount, 0);
  assert.equal(f.jobsRunning(), 0);
  for (const client of [left, right]) {
    assert.equal(client.res.status, 410, 'live subscriber must receive a terminal source-gone response');
    assert.equal(client.res.writableEnded, true);
    assert.equal(client.res.value.error, 'Audio source changed; request a fresh window');
    assert.equal(client.req.listenerCount('aborted'), 0);
    assert.equal(client.res.listenerCount('close'), 0);
  }
});

test('stale same-id session never joins or caches a previous session producer', async () => {
  const f = fixture();
  const old = f.makeSession('reused-id');
  const oldClient = f.request(old);
  await flush();
  const current = f.makeSession('reused-id');
  const currentClient = f.request(current);
  await flush();
  assert.equal(f.decodes.length, 2, 'session object identity separates old and new flights');
  f.decodes[0].job.resolve(f.pcm);
  await Promise.allSettled([oldClient.promise]);
  assert.equal(f.cacheSize(), 0, 'stale producer must not populate completed-result cache');
  f.decodes[1].job.resolve(f.pcm);
  await currentClient.promise;
  assert.equal(currentClient.res.status, 200);
  assert.equal(f.cacheSize(), 1);
});

test('bounded concurrent subscriber joins and bounded map cleanup', async () => {
  const f = fixture(), session = f.makeSession('bounded');
  const clients = Array.from({ length: 40 }, () => f.request(session));
  await flush();
  assert.equal(f.decodes.length, 1);
  assert.ok(f.inflightCount >= 0 && f.inflightCount <= 2, 'only finite active producer metadata allowed');
  assert.ok(clients.filter(client => client.res.status === 429).length > 0, 'subscriber fanout must be bounded');
  f.decodes[0].job.resolve(f.pcm);
  await Promise.allSettled(clients.map(client => client.promise));
  assert.equal(f.inflightCount, 0, 'no pending jobs left after resolution');
  assert.equal(f.jobsRunning(), 0);
});

test('completed-result cache is bounded at sixty windows, including after repeated distinct requests', async () => {
  const f = fixture(), session = f.makeSession('cache-bound');
  for (let i = 0; i < 70; i++) {
    const client = f.request(session, { startSeconds: i, duration: 10 });
    await flush();
    f.decodes[i].job.resolve(f.pcm);
    await client.promise;
    assert.equal(client.res.status, 200);
  }
  assert.equal(f.decodes.length, 70);
  assert.equal(f.cacheSize(), 60);
  assert.equal(f.jobsRunning(), 0);
  assert.equal(f.inflightCount, 0);
});

test('RED: real decoder cancellation holds its promise until the FFmpeg child actually closes', async () => {
  const start = server.indexOf('function decodeSpeechAudio(');
  const end = server.indexOf('\n// Anki decks', start);
  assert.ok(start > 0 && end > start);
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  let launchCount = 0;
  const context = vm.createContext({
    Buffer, AbortController, setTimeout, clearTimeout,
    SPEECH_SAMPLE_RATE: 16_000, ffmpegPath: 'fake-ffmpeg', port: 5000,
    speechUnclosedChildren: new Set(),
    spawn() { launchCount++; return child; },
  });
  vm.runInContext(server.slice(start, end), context);
  const controller = new AbortController();
  const promise = context.decodeSpeechAudio({ id: 'private-session' }, 0,
    { startSeconds: 10, seconds: 10, order: 0, signal: controller.signal });
  assert.equal(launchCount, 1);
  assert.equal(child.killed, false);
  let settled = false;
  void promise.then(() => { settled = true; }, () => { settled = true; });
  controller.abort();
  assert.equal(child.killed, true, 'the actual FFmpeg process must receive kill() on abort');
  await flush();
  assert.equal(settled, false, 'the producer slot must remain occupied until confirmed process close');
  child.emit('close', 1);
  await assert.rejects(promise, /Audio analysis cancelled/);
  assert.equal(settled, true);
});

test('slow FFmpeg termination escalates once and reserves the slot until confirmed late close', async () => {
  const start = server.indexOf('function decodeSpeechAudio(');
  const end = server.indexOf('\n// Anki decks', start);
  const timers = [];
  const setFakeTimeout = (fn, ms) => {
    const handle = { ms, fn, active: true, unref() {} };
    timers.push(handle);
    return handle;
  };
  const clearFakeTimeout = handle => { if (handle) handle.active = false; };
  const fire = ms => {
    const timer = timers.find(item => item.ms === ms && item.active);
    assert.ok(timer, `expected active ${ms}ms timer`);
    timer.active = false;
    timer.fn();
  };
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killCalls = [];
  child.kill = (signal) => { child.killCalls.push(signal || 'SIGTERM'); return true; };
  const outstanding = new Set();
  const context = vm.createContext({
    Buffer, AbortController, setTimeout: setFakeTimeout, clearTimeout: clearFakeTimeout,
    SPEECH_SAMPLE_RATE: 16000, ffmpegPath: 'fake-ffmpeg', port: 5000,
    speechUnclosedChildren: outstanding, spawn() { return child; },
  });
  vm.runInContext(server.slice(start, end), context);
  const controller = new AbortController();
  const pending = context.decodeSpeechAudio({ id: 'bounded-fallback' }, 0,
    { startSeconds: 0, seconds: 10, order: 0, signal: controller.signal });
  let settled = false;
  void pending.then(() => { settled = true; }, () => { settled = true; });
  controller.abort();
  assert.deepEqual(child.killCalls, ['SIGTERM']);
  fire(2000);
  assert.deepEqual(child.killCalls, ['SIGTERM', 'SIGKILL']);
  assert.equal(settled, false);
  fire(8000);
  await assert.rejects(pending, /Audio analysis cancelled/);
  assert.equal(outstanding.size, 1, 'fallback must not release a possibly still-live child');
  child.emit('close', 1);
  assert.equal(outstanding.size, 0, 'only actual process close releases the orphan reservation');
  assert.equal(settled, true);
});

test('synchronous FFmpeg spawn failure rejects promptly without retaining a child reservation', async () => {
  const start = server.indexOf('function decodeSpeechAudio(');
  const end = server.indexOf('\n// Anki decks', start);
  const outstanding = new Set();
  const context = vm.createContext({
    Buffer, AbortController, setTimeout, clearTimeout,
    SPEECH_SAMPLE_RATE: 16000, ffmpegPath: 'fake-ffmpeg', port: 5000,
    speechUnclosedChildren: outstanding, spawn() { throw Error('spawn failed synchronously'); },
  });
  vm.runInContext(server.slice(start, end), context);
  await assert.rejects(context.decodeSpeechAudio({ id: 'failed-spawn' }, 0,
    { startSeconds: 0, seconds: 10, order: 0 }), /spawn failed synchronously/);
  assert.equal(outstanding.size, 0);
});

test('RED: cancelled child still terminating occupies its slot while unrelated work requests admission', async () => {
  const f = fixture(), session = f.makeSession('shutdown-slot');
  const children = [];
  f.decodeHook = ({ options }) => {
    const child = deferred();
    options.signal.addEventListener('abort', () => { child.killRequested = true; }, { once: true });
    children.push(child);
    return child;
  };
  const abandoned = f.request(session, { startSeconds: 0 });
  const other = f.request(session, { startSeconds: 20 });
  await flush();
  assert.equal(f.jobsRunning(), 2);
  abandoned.close();
  await abandoned.promise;
  assert.equal(children[0].killRequested, true);
  assert.equal(f.jobsRunning(), 2, 'one teardown pending and one active process still consume both slots');
  const newWindow = f.request(session, { startSeconds: 35 });
  await newWindow.promise;
  assert.equal(newWindow.res.status, 429);
  children[0].reject(Object.assign(Error('FFmpeg closed'), { statusCode: 499 }));
  children[1].resolve(f.pcm);
  await other.promise;
  await flush();
  assert.equal(f.jobsRunning(), 0);
});

test('post-deadline unconfirmed child remains an admission reservation even after its producer settled', async () => {
  const f = fixture(), session = f.makeSession('orphan-slot');
  const a = f.request(session, { startSeconds: 0 });
  const b = f.request(session, { startSeconds: 30 });
  await flush();
  assert.equal(f.jobsRunning(), 2);
  const stillAlive = {};
  // Simulate the decoder's bounded fallback: it rejects the HTTP producer
  // without observing process close, but retains that child in the orphan set.
  f.retainUnclosedChild(stillAlive);
  f.decodes[0].job.reject(Object.assign(Error('FFmpeg stop unconfirmed'), { statusCode: 504 }));
  await assert.rejects(a.promise);
  assert.equal(f.jobsRunning(), 1);
  const c = f.request(session, { startSeconds: 60 });
  await c.promise;
  assert.equal(c.res.status, 429, 'one running producer + one lingering child already consume both slots');
  assert.equal(f.decodes.length, 2);
  f.releaseUnclosedChild(stillAlive);
  const retry = f.request(session, { startSeconds: 60 });
  await flush();
  assert.equal(f.decodes.length, 3, 'only confirmed orphan removal restores capacity');
  f.decodes[1].job.resolve(f.pcm);
  f.decodes[2].job.resolve(f.pcm);
  await Promise.all([b.promise, retry.promise]);
  assert.equal(f.jobsRunning(), 0);
});
