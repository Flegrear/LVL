import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const from = app.indexOf("// A copied video fragment begins at the keyframe");
const to = app.indexOf("// A converted stream is re-opened", from);
assert.ok(from > 0 && to > from, "production transcode client code is present");
const code = app.slice(from, to);
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fixture({ frames = true, response, start = 5.37, initialMute = false, playRejects = false } = {}) {
  const calls = [];
  let now = 100000;
  let nextId = 0;
  const callbackQueue = new Map();
  const timers = new Map();
  let aborted = 0;
  let deferredResolve;
  let preflightIndex = 0;
  let remainingPlayFailures = playRejects === "once" || playRejects === "not-allowed-once" ? 1 : playRejects ? Infinity : 0;
  const result = response === undefined
    ? { verified: true, requestedStartSeconds: start, effectiveStartSeconds: 4, prerollSeconds: start - 4 }
    : response;
  const frameClasses = new Set();
  const overlayAttributes = new Map([["aria-live", "polite"]]);
  const overlay = {
    getAttribute: (name) => overlayAttributes.get(name) ?? null,
    setAttribute: (name, value) => overlayAttributes.set(name, value),
    removeAttribute: (name) => overlayAttributes.delete(name),
  };
  const video = {
    paused: true, muted: initialMute, volume: 0.62, currentTime: 0, readyState: 0, currentSrc: "prior.mp4",
    dataset: { mode: "transcode" }, src: "prior.mp4",
    play() {
      calls.push("play");
      const failed = playRejects === "not-allowed-unmuted" ? !this.muted : remainingPlayFailures-- > 0;
      this.paused = failed;
      if (!failed) return Promise.resolve();
      return Promise.reject(playRejects === "not-allowed" || playRejects === "not-allowed-once" || playRejects === "not-allowed-unmuted"
        ? Object.assign(new Error("play() blocked"), { name: "NotAllowedError" })
        : new Error("temporary media stream failure"));
    },
    pause() { calls.push("pause"); this.paused = true; },
    load() { calls.push(["load", this.src]); this.currentTime = 0; this.currentSrc = this.src; this.readyState = 0; },
    addEventListener(type, fn) {
      if (type === "timeupdate") this.timeupdate = fn;
      if (type === "error") this.errorHandler = fn;
      if (type === "loadeddata") this.loadeddata = fn;
    },
    removeEventListener(type, fn) {
      if (this.timeupdate === fn) this.timeupdate = null;
      if (this.loadeddata === fn) this.loadeddata = null;
    },
    ...(frames ? {
      requestVideoFrameCallback(fn) { const id = ++nextId; callbackQueue.set(id, fn); return id; },
      cancelVideoFrameCallback(id) { callbackQueue.delete(id); },
    } : {}),
  };
  const source = { kind: "torrent", sessionId: "abcdef00", libraryId: "known-source", fileIndex: 2 };
  const state = {
    currentSource: source, selectedAudioTrack: 2, currentMs: 0,
    transcodeBaseOffsetSeconds: 0, transcodeContext: {
      baseUrl: "/api/torrents/abcdef00/files/2/transcode",
      sessionId: "abcdef00", fileIndex: 2, audioIndex: 2, copyVideo: true,
    },
    pendingSeek: null, mediaDurationMs: 200000, loadingProgress: 10,
  };
  const frame = {
    classList: {
      add(value) { frameClasses.add(value); },
      remove(value) { frameClasses.delete(value); },
      contains(value) { return frameClasses.has(value); },
    },
  };
  const window = {
    setTimeout(fn, delay) { const id = ++nextId; timers.set(id, { fn, due: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const ctx = vm.createContext({
    window, frame, state, video, AbortController, AbortSignal,
    $: (selector) => selector === "#subtitle-overlay" ? overlay : null,
    URLSearchParams, Number,
    playbackLoadRequestId: 1, transcodePauseSnapshot: null,
    fetchJson(_url, opts) {
      calls.push(["preflight", _url, opts.signal]);
      opts.signal.addEventListener("abort", () => { aborted++; }, { once: true });
      const next = Array.isArray(result) ? result[Math.min(preflightIndex++, result.length - 1)] : result;
      if (next === "deferred") return new Promise((resolve) => { deferredResolve = resolve; });
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(next);
    },
    transcodeQuery(seconds, index) {
      return new URLSearchParams({ start: seconds.toFixed(3), audio: String(index), video: "copy", hevc: "1" });
    },
    absolutePlaybackSeconds: () => state.pendingSeek ? state.pendingSeek.target
      : state.transcodeBaseOffsetSeconds + video.currentTime,
    setPlayerLoading: (...args) => calls.push(["loader", ...args]),
    renderSubtitles: () => { calls.push(["subtitles", state.currentMs]); },
    updateCompatControls: () => calls.push(["controls", state.currentMs]),
    finishPlayerLoading: () => calls.push("ready"),
    clearTranscodeSeekFrame: () => calls.push("frame-cleared"),
    toast: (...args) => calls.push(["toast", ...args]),
    scheduleAudioSync: () => calls.push("audio-sync"),
    audioSync: { key: "session:2:2" },
    formatTime: (ms) => String(ms),
    setMediaSource: (args) => { video.src = args.src; video.load(); },
    libraryEntryById: (id) => id === "known-source" ? { magnet: "magnet:?xt=urn:btih:source" } : null,
    recoveryPlaybackRequested: false,
    playLibraryEpisode: (id, index, options) => {
      calls.push(["reopen-library", id, index, options.resumeAtSeconds]); return Promise.resolve(true);
    },
  });
  vm.runInContext(code, ctx);
  const run = (expression) => vm.runInContext(expression, ctx);
  return {
    run, state, video, frameClasses, calls, timers, overlay,
    get aborted() { return aborted; },
    resolve: (value) => deferredResolve?.(value),
    advance(milliseconds) {
      now += milliseconds;
      for (const [id, entry] of [...timers]) {
        if (entry.due <= now) { timers.delete(id); entry.fn(); }
      }
    },
    frame(mediaTime) {
      const [id, cb] = callbackQueue.entries().next().value;
      callbackQueue.delete(id);
      video.currentTime = mediaTime;
      cb(0, { mediaTime });
    },
    loadedData() {
      video.readyState = 2;
      video.loadeddata?.();
    },
    async open(seconds = start, options = { wasPlaying: true }) {
      return run("openTranscodeAt")(seconds, options);
    },
  };
}

test("copied HDR seek keeps original requested FFmpeg query, verifies clock, and hides/mutes GOP until target frame", async () => {
  const f = fixture();
  assert.equal(await f.open(), true);
  assert.equal(f.state.transcodeBaseOffsetSeconds, 4);
  assert.equal(f.state.transcodeRequestedStartSeconds, 5.37);
  assert.match(f.video.src, /start=5\.370/);
  assert.match(f.video.src, /video=copy/);
  assert.match(f.video.src, /hevc=1/, "copy and HDR codec hint stay intact");
  assert.equal(f.video.muted, true);
  assert.equal(f.video.volume, 0.62);
  assert.equal(f.frameClasses.has("is-sync-preroll"), true);
  assert.equal(f.state.pendingSeek.target, 5.37);
  f.frame(1.2);
  assert.equal(f.video.muted, true, "early video keyframe is never audible");
  f.frame(1.37);
  assert.equal(f.video.muted, false);
  assert.equal(f.frameClasses.has("is-sync-preroll"), false);
  assert.equal(f.state.pendingSeek, null);
  assert.ok(f.calls.includes("ready"));
  assert.equal(f.video.paused, false);
  assert.equal(f.state.currentMs, 5370);
  assert.equal(f.calls.filter((c) => c[0] === "preflight").length, 1);
});

test("paused source remains paused after silent preroll; changes to preferred mute survive", async () => {
  const f = fixture({ initialMute: true });
  await f.open(5.37, { wasPlaying: false });
  assert.equal(f.state.pendingSeek.wasPlaying, false);
  f.run("setPlayerMutePreference(false)");
  assert.equal(f.video.muted, true, "preference changes never unmute preroll");
  f.frame(1.37);
  assert.equal(f.video.paused, true);
  assert.equal(f.video.muted, false, "new user preference is restored");
  assert.equal(f.video.volume, 0.62);
});

test("rapid repeated seeks abort and ignore stale preflight responses", async () => {
  const f = fixture({ response: "deferred" });
  const old = f.open(5.37, { wasPlaying: true });
  await tick();
  assert.equal(f.calls.filter((call) => call[0] === "preflight").length, 1);
  f.run("cancelTranscodeStart()");
  f.state.transcodeContext = { ...f.state.transcodeContext };
  f.resolve({ verified: true, requestedStartSeconds: 5.37, effectiveStartSeconds: 4 });
  assert.equal(await old, false);
  assert.equal(f.video.src, "prior.mp4");
  assert.equal(f.state.pendingSeek, null);
  assert.equal(f.aborted, 1);
});

test("unverified or rejected source preflight fails closed without video restart", async () => {
  for (const response of [
    { verified: false, requestedStartSeconds: 5.37, effectiveStartSeconds: 4 },
    { verified: true, requestedStartSeconds: 5.37, effectiveStartSeconds: 5.8 },
    new Error("ffprobe unavailable"),
  ]) {
    const f = fixture({ response });
    assert.equal(await f.open(), false);
    assert.equal(f.video.src, "prior.mp4");
    assert.equal(f.frameClasses.has("is-sync-preroll"), false);
    assert.equal(f.state.pendingSeek, null);
    assert.ok(f.calls.some((item) => item[0] === "loader" && item[1] === 100));
  }
});

test("no-frame-callback browsers use timeupdate fallback; watchdog retries stalled preroll before final failure", async () => {
  const f = fixture({ frames: false });
  assert.equal(await f.open(), true);
  f.video.currentTime = 1.39;
  f.video.timeupdate();
  assert.equal(f.frameClasses.has("is-sync-preroll"), false);
  const stalled = fixture();
  await stalled.open();
  stalled.advance(45000);
  assert.equal(stalled.state.pendingSeek.target, 5.37);
  assert.equal(stalled.calls.some((c) => c[0] === "loader" && c[1] === 100), false,
    "the logo remains visible during the first watchdog recovery");
  stalled.advance(700);
  await tick();
  assert.equal(stalled.calls.filter((c) => c[0] === "preflight").length, 2);
  stalled.advance(45000);
  stalled.advance(1400);
  await tick();
  stalled.advance(45000);
  assert.equal(stalled.frameClasses.has("is-sync-preroll"), false);
  assert.equal(stalled.video.paused, true);
  assert.ok(stalled.calls.some((c) => c[0] === "loader" && c[1] === 100));
});

test("zero-second or re-encoded transcode starts without an extra keyframe lookup", async () => {
  const f = fixture({ start: 0, response: { verified: true, requestedStartSeconds: 0, effectiveStartSeconds: 0 } });
  assert.equal(await f.open(0), true);
  assert.equal(f.calls.some((c) => c[0] === "preflight"), false);
  assert.equal(f.video.muted, false);
  assert.equal(f.frameClasses.has("is-sync-preroll"), false);
});

test("paused copied seek at an exact keyframe does not finish before decoder loadeddata", async () => {
  const start = 8;
  const f = fixture({ start, response: {
    verified: true, requestedStartSeconds: start, effectiveStartSeconds: start, prerollSeconds: 0,
  } });
  assert.equal(await f.open(start, { wasPlaying: false }), true);
  assert.equal(f.state.pendingSeek?.priming, true, "a URL assignment alone is not a decoded frame");
  assert.equal(f.calls.includes("ready"), false, "keep branded loading while paused source buffers");
  assert.equal(f.video.paused, true);
  f.loadedData();
  assert.equal(f.state.pendingSeek, null, "a current decoded frame releases the paused seek");
  assert.equal(f.calls.filter((entry) => entry === "ready").length, 1);
  assert.equal(f.video.paused, true, "loadeddata must never autoplay an intentionally paused source");
});

test("a copied seek landing precisely on a keyframe retries a rejected Play before hiding the logo", async () => {
  const start = 8;
  const f = fixture({ start, playRejects: "once", response: {
    verified: true, requestedStartSeconds: start, effectiveStartSeconds: start, prerollSeconds: 0,
  } });
  assert.equal(await f.open(start), true);
  assert.equal(f.state.pendingSeek?.priming, true, "a failed Play does not prematurely complete the seek");
  assert.equal(f.calls.some((entry) => entry[0] === "loader" && entry[1] === 100), false);
  f.advance(700);
  await tick();
  assert.equal(f.state.pendingSeek, null, "the next verified stream completed after Play succeeded");
  assert.equal(f.video.paused, false);
  assert.match(f.video.src, /video=copy/);
  assert.match(f.video.src, /start=8\.000/);
  assert.equal(f.calls.filter((entry) => entry[0] === "preflight").length, 2);
  assert.equal(f.calls.filter((entry) => entry === "ready").length, 1);
  assert.equal(f.calls.some((entry) => entry[0] === "loader" && entry[1] === 100), false);
});

test("no-preroll Play rejection exhausts at most two automatic retries and becomes actionable", async () => {
  const f = fixture({ start: 0, playRejects: true });
  assert.equal(await f.open(0), true);
  for (const delay of [700, 1400]) {
    assert.equal(f.state.pendingSeek?.priming, true);
    assert.equal(f.calls.some((entry) => entry[0] === "loader" && entry[1] === 100), false);
    f.advance(delay);
    await tick();
  }
  assert.equal(f.state.pendingSeek, null);
  assert.equal(f.video.paused, true);
  assert.equal(f.timers.size, 0);
  assert.equal(f.calls.filter((entry) => entry === "play").length, 3);
  assert.ok(f.calls.some((entry) => entry[0] === "loader" && entry[1] === 100));
  f.advance(45_000);
  await tick();
  assert.equal(f.calls.filter((entry) => entry === "play").length, 3, "failed request is not restarted forever");
});

test("browser user-gesture denial never retries FFmpeg, and one direct Play resumes the exact window", async () => {
  const f = fixture({ start: 0, initialMute: true, playRejects: "not-allowed-once" });
  assert.equal(await f.open(0), true);
  assert.equal(f.calls.filter(c => c === "play").length, 1);
  assert.equal(f.calls.some(c => Array.isArray(c) && c[0] === "loader" && c[2] === "Video synchronization unavailable"), false);
  assert.equal(f.run("transcodeStartAttempt.awaitingUserGesture"), true);
  f.advance(45_000);
  assert.equal(f.calls.filter(c => c === "play").length, 1, "autoplay rejection is not a seek stall");
  assert.equal(f.run("transcodeStartAttempt.resumeAfterGesture()"), true);
  await tick();
  assert.equal(f.calls.filter(c => c === "play").length, 2);
  assert.ok(f.calls.includes("ready"));
  assert.equal(f.state.pendingSeek, null);
});

test("sound-autoplay rejection automatically starts the SAME media stream muted, without a second click", async () => {
  const f = fixture({ start: 0, playRejects: "not-allowed-unmuted" });
  assert.equal(await f.open(0), true);
  await tick();
  assert.equal(f.video.muted, true, "mute just the current decoder, not the user's site preferences");
  assert.equal(f.calls.filter(c => c === "play").length, 2);
  assert.equal(f.calls.filter(c => Array.isArray(c) && c[0] === "preflight").length, 0);
  assert.equal(f.state.pendingSeek, null, "finish playback startup after the muted play resolves");
  assert.ok(f.calls.includes("ready"));
  assert.equal(f.video.paused, false);
  assert.equal(f.calls.some(c => Array.isArray(c) && c[0] === "loader" && c[2] === "Playback needs a click"), false);
});

test("true autoplay prohibition even while already muted still requires a real user click", async () => {
  const f = fixture({ start: 0, initialMute: true, playRejects: "not-allowed" });
  assert.equal(await f.open(0), true);
  await tick();
  assert.equal(f.calls.filter(c => c === "play").length, 1);
  assert.equal(f.run("transcodeStartAttempt.awaitingUserGesture"), true);
  assert.ok(f.calls.some(c => Array.isArray(c) && c[0] === "loader" && c[2] === "Playback needs a click"));
});

test("preroll waits for explicit Play after NotAllowedError and preserves muted GOP protection", async () => {
  const f = fixture({ playRejects: "not-allowed-once" });
  assert.equal(await f.open(), true);
  await tick();
  assert.equal(f.run("transcodeStartAttempt.awaitingUserGesture"), true);
  assert.equal(f.video.muted, true);
  assert.equal(f.frameClasses.has("is-sync-preroll"), true);
  assert.equal(f.run("transcodeStartAttempt.resumeAfterGesture()"), true);
  await tick();
  f.frame(1.37);
  assert.equal(f.state.currentMs, 5370);
  assert.equal(f.video.muted, false);
  assert.equal(f.state.pendingSeek, null);
  assert.equal(f.calls.filter(c => c === "play").length, 2);
});

test("gesture replay cannot revive a previous episode or retry a repeated browser policy denial", async () => {
  const stale = fixture({ start: 0, initialMute: true, playRejects: "not-allowed" });
  await stale.open(0);
  const directPlay = stale.run("transcodeStartAttempt.resumeAfterGesture");
  stale.state.currentSource = { kind: "torrent", sessionId: "replacement", fileIndex: 3 };
  assert.equal(directPlay(), false);
  assert.equal(stale.calls.filter(c => c === "play").length, 1);

  const repeatedlyDenied = fixture({ start: 0, initialMute: true, playRejects: "not-allowed" });
  await repeatedlyDenied.open(0);
  assert.equal(repeatedlyDenied.run("transcodeStartAttempt.resumeAfterGesture()"), true);
  await tick();
  assert.equal(repeatedlyDenied.run("transcodeStartAttempt.awaitingUserGesture"), true);
  assert.ok(repeatedlyDenied.calls.some(c => Array.isArray(c) && c[0] === "loader"
    && c[2] === "Playback could not start"),
  "a second denial after the user's click must not misleadingly ask for the first click again");
  repeatedlyDenied.advance(45_000);
  await tick();
  assert.equal(repeatedlyDenied.calls.filter(c => c === "play").length, 2);
  assert.equal(repeatedlyDenied.calls.filter(c => Array.isArray(c) && c[0] === "loader" && c[2] === "Video synchronization unavailable").length, 0);
});

test("busy copied-seek origin retries automatically with the brand loader, then preserves exact HDR timestamp", async () => {
  const busy = new Error("Copied-video seek probe is busy");
  busy.httpStatus = 429;
  const f = fixture({ response: busy });
  assert.equal(await f.open(), true, "a busy origin schedules recovery, not a visible failure");
  assert.equal(f.calls.filter((entry) => entry[0] === "preflight").length, 1);
  assert.equal(f.state.pendingSeek.target, 5.37);
  assert.equal(f.video.src, "prior.mp4", "do not launch an unverified fragment");
  assert.ok(f.calls.some((entry) => entry[0] === "loader" && entry[1] === 20));
  f.advance(700);
  await tick();
  assert.equal(f.calls.filter((entry) => entry[0] === "preflight").length, 2);
  f.advance(1400);
  await tick();
  assert.equal(f.calls.filter((entry) => entry[0] === "preflight").length, 3);
  f.advance(3000);
  await tick();
  assert.equal(f.calls.filter((entry) => entry[0] === "preflight").length, 3, "strictly bounded after two automatic retries");
  assert.equal(f.state.pendingSeek, null);
  assert.ok(f.calls.some((entry) => entry[0] === "loader" && entry[1] === 100), "persistent failure becomes actionable");
});

test("an initial HTTP 429 is automatically recovered when the previous FFmpeg job releases its slot", async () => {
  const busy = new Error("Copied-video seek probe is busy");
  busy.httpStatus = 429;
  const f = fixture({ response: [busy, {
    verified: true, requestedStartSeconds: 5.37, effectiveStartSeconds: 4.0, prerollSeconds: 1.37,
  }] });
  assert.equal(await f.open(), true);
  assert.equal(f.video.src, "prior.mp4");
  assert.equal(f.state.pendingSeek.wasPlaying, true);
  f.advance(700);
  await tick();
  assert.match(f.video.src, /video=copy/);
  assert.equal(f.state.transcodeBaseOffsetSeconds, 4);
  assert.equal(f.video.muted, true);
  f.frame(1.37);
  assert.equal(f.state.currentMs, 5370);
  assert.equal(f.state.pendingSeek, null);
  assert.equal(f.video.paused, false);
  assert.equal(f.calls.filter((c) => c[0] === "preflight").length, 2);
  assert.equal(f.calls.some((c) => c[0] === "loader" && c[1] === 100), false,
    "a successful automatic retry must never flash the error panel");
});

test("a media failure during muted preroll retries once without displaying a terminal error or replaying obsolete seeks", async () => {
  const f = fixture({ playRejects: true });
  assert.equal(await f.open(), true);
  await tick();
  assert.equal(f.state.pendingSeek.target, 5.37);
  assert.equal(f.calls.filter((entry) => entry[0] === "preflight").length, 1);
  assert.equal(f.calls.some((entry) => entry[0] === "loader" && entry[1] === 100), false);
  f.advance(700);
  await tick();
  assert.equal(f.calls.filter((entry) => entry[0] === "preflight").length, 2);
  f.run("cancelTranscodeStart()"); // User navigated away during the second retry.
  f.advance(1400);
  await tick();
  assert.equal(f.calls.filter((entry) => entry[0] === "preflight").length, 2, "stale request must not auto-restart");
  assert.equal(f.video.muted, false, "muted preroll does not leak into the next media source");
});

test("only a current priming error is retried; an intentional pause preserves requested paused state", async () => {
  const f = fixture();
  assert.equal(await f.open(5.37, { wasPlaying: false }), true);
  f.run("transcodeStartAttempt.retryTransient(new Error('temporary stream failure'))");
  assert.equal(f.state.pendingSeek.wasPlaying, false);
  f.advance(700);
  await tick();
  f.frame(1.37);
  assert.equal(f.video.paused, true, "a paused seek must not autoplay after recovery");
  assert.equal(f.calls.some((entry) => entry[0] === "loader" && entry[1] === 100), false);
});

test("expired 30-minute torrent session reacquires the SAME saved episode instead of terminal synchronization error", async () => {
  const expired = new Error("Torrent session not found or expired");
  expired.httpStatus = 404;
  const f = fixture({ response: expired });
  assert.equal(await f.open(5.37, { wasPlaying: true, verifySession: true }), true);
  assert.deepEqual(f.calls.filter(call => Array.isArray(call) && call[0] === "reopen-library"),
    [["reopen-library", "known-source", 2, 5.37]]);
  assert.equal(f.state.pendingSeek, null, "obsolete FFmpeg seek is cancelled before the new Library session");
  assert.equal(f.video.src, "prior.mp4", "expired URL must never be loaded");
  assert.equal(f.calls.some(call => Array.isArray(call) && call[0] === "loader" && call[1] === 100), false,
    "do not show a synchronization failure when the source can be recreated");
});

test("copy keyframe preflight 410 also reacquires an expired current source once", async () => {
  const expired = new Error("Source session has expired");
  expired.httpStatus = 410;
  const f = fixture({ response: expired });
  assert.equal(await f.open(5.37, { wasPlaying: true }), true);
  assert.equal(f.calls.filter(call => Array.isArray(call) && call[0] === "reopen-library").length, 1);
  assert.equal(f.calls.some(call => Array.isArray(call) && call[0] === "loader" && call[1] === 100), false);
});

test("session expiry cannot autoplay an intentionally paused seek, a different source, or a non-expiry 404", async () => {
  const expired = new Error("Torrent session not found or expired");
  expired.httpStatus = 404;
  const paused = fixture({ response: expired });
  assert.equal(await paused.open(5.37, { wasPlaying: false }), false);
  assert.equal(paused.calls.some(call => Array.isArray(call) && call[0] === "reopen-library"), false);

  const unrelated = new Error("Metadata not found");
  unrelated.httpStatus = 404;
  const other = fixture({ response: unrelated });
  assert.equal(await other.open(), false);
  assert.equal(other.calls.some(call => Array.isArray(call) && call[0] === "reopen-library"), false);

  const stale = fixture({ response: "deferred" });
  const pending = stale.open(5.37, { wasPlaying: true });
  await tick();
  stale.state.currentSource = { ...stale.state.currentSource, sessionId: "new-episode" };
  stale.resolve({ verified: true, requestedStartSeconds: 5.37, effectiveStartSeconds: 4 });
  assert.equal(await pending, false);
  assert.equal(stale.calls.some(call => Array.isArray(call) && call[0] === "reopen-library"), false);
});
