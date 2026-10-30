import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { torrentSeekPieceStatus } from "../frontend/player/torrent-piece-wait.js";

const app = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
const sourceSlice = (from, to) => {
  const start = app.indexOf(from);
  const end = app.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `Missing production player path: ${from}`);
  return app.slice(start, end);
};

test("switching episodes immediately clears and hides the old decoded frame until NEW source loadeddata", () => {
  const events = [];
  const listeners = new Map();
  const classes = new Set(["has-video"]);
  let src = "blob:video-one";
  const video = {
    get src() { return src; }, set src(value) { src = value; },
    currentSrc: "blob:video-one", readyState: 4, videoWidth: 1920, style: { visibility: "" },
    pause() { events.push("pause"); },
    removeAttribute(name) { if (name === "src") src = ""; },
    load() { events.push("unload old decoder"); this.currentSrc = ""; this.readyState = 0; },
    addEventListener(type, callback) { listeners.set(type, callback); },
  };
  const frame = { classList: {
    add(value) { classes.add(value); }, remove(value) { classes.delete(value); },
    contains(value) { return classes.has(value); },
  } };
  const source = { sessionId: "video-one" };
  const state = { currentSource: source };
  const context = vm.createContext({
    video, frame, state, playbackLoadRequestId: 1,
    closeRemuxMseSession() {}, cancelTranscodeStart() {}, clearAutoNext() {},
    resetRecoveryDisplay() {}, recoveryBusy: false,
    finishPlayerLoading() {},
    recordWatchProgress() { events.push("saved progress"); },
  });
  const beginning = app.indexOf("function beginSourceTransition(");
  assert.ok(beginning >= 0);
  const helper = app.indexOf("function preserveCurrentFrameForTranscodeSeek(");
  assert.ok(helper > 0 && helper < beginning, "a source-frame gate must exist before switching sources");
  vm.runInContext(`let sourceFrameGate = null;\n${app.slice(helper, app.indexOf("function finishPlayerLoading(", beginning))}`, context);
  vm.runInContext("beginSourceTransition()", context);
  assert.equal(events[0], "saved progress", "save outgoing episode before unloading it");
  assert.equal(src, "", "unload old decoder before new metadata/identity fetching");
  assert.equal(video.style.visibility, "hidden", "the old picture may not sit behind video2's logo");
  assert.ok(classes.has("source-transition"));
  const next = { sessionId: "video-two" };
  state.currentSource = next;
  src = "blob:video-two";
  video.currentSrc = src;
  video.readyState = 2;
  video.videoWidth = 1920;
  vm.runInContext("expectNewVideoFrame()", context);
  // A stale decoded frame event from source1 must not release source2's gate.
  const observed = video.currentSrc;
  video.currentSrc = "blob:video-one";
  listeners.get("loadeddata")?.();
  assert.equal(video.style.visibility, "hidden");
  video.currentSrc = observed;
  listeners.get("loadeddata")?.();
  assert.equal(video.style.visibility, "", "new source's first decoded frame can be shown");
  // The initial gate has been cleared. A later MSE -> native fallback for this
  // SAME episode must still create a fresh guard against delayed old events.
  const currentEpisode = state.currentSource;
  const oldSrc = video.currentSrc;
  src = "blob:video-two-native";
  vm.runInContext("expectNewVideoFrame()", context);
  assert.equal(vm.runInContext("sourceFrameGate?.src", context), src,
    "each new decoder/FFmpeg URL must re-arm the source gate");
  assert.equal(video.style.visibility, "hidden", "never reveal stale frame while fallback starts");
  assert.equal(state.currentSource, currentEpisode);
  video.currentSrc = oldSrc;
  listeners.get("loadeddata")?.();
  assert.equal(video.style.visibility, "hidden", "old source frame can't unlock fallback");
  video.currentSrc = src;
  listeners.get("loadeddata")?.();
  assert.equal(video.style.visibility, "", "native fallback frame releases the new guard");
});

test("already buffered MSE seek keeps branded logo hidden while waiting for its exact displayed frame", () => {
  const calls = [];
  const frames = new Map();
  const timers = [];
  const overlay = { hidden: true, aria: null,
    getAttribute() { return this.aria; },
    setAttribute(_key, value) { this.aria = value; },
    removeAttribute() { this.aria = null; },
  };
  const loading = { hidden: true, classList: { contains: () => false } };
  let nextId = 0;
  const video = { src: "blob:cached", dataset: { mode: "transcode" }, muted: false,
    paused: false, seeking: false, currentTime: 2,
    requestVideoFrameCallback(callback) { frames.set(++nextId, callback); return nextId; },
    cancelVideoFrameCallback(id) { frames.delete(id); },
    play() { return Promise.resolve(); }, pause() {},
  };
  const source = { sessionId: "video-one" }, context = { copyVideo: true };
  const state = { transcodeBaseOffsetSeconds: 10, currentSource: source, transcodeContext: context,
    pendingSeek: null, currentMs: 12_000 };
  const session = { contains: (seconds) => seconds === 15 };
  const ctx = vm.createContext({
    video, state, playbackLoadRequestId: 1,
    frame: { classList: { add() {}, remove() {} } },
    $: (selector) => selector === "#subtitle-overlay" ? overlay : loading,
    window: { clearTimeout() {}, setTimeout(cb) { timers.push(cb); return timers.length; } },
    playerIsPlaying: () => true, playerWantsMuted: () => false,
    invalidateSubtitleFrameClock() {}, renderSubtitles() {}, updateCompatControls() {},
    setPlayerLoading() { calls.push("branded-logo"); }, finishPlayerLoading() {},
    schedulePresentedSubtitleFrame() {}, scheduleAudioSync() {}, audioSync: { key: "" },
    scheduleTranscodeSeek() {}, formatTime: () => "00:25",
    hideLoadingForBufferedSeek() { loading.hidden = true; calls.push("hide-existing-loading"); },
  });
  const part = sourceSlice("function cancelRemuxMseWarmSeek(", "function cancelTranscodeStart(");
  vm.runInContext(`let remuxMseSession = null; let remuxMseWarmSeek = null;\n${part}`, ctx);
  vm.runInContext("remuxMseSession = " + "null", ctx);
  ctx.__session = session;
  vm.runInContext("remuxMseSession = __session", ctx);
  assert.equal(vm.runInContext("seekInsideRemuxMse(25)", ctx), true);
  assert.equal(calls.includes("branded-logo"), false, "cached in-SourceBuffer seek cannot show the spinner/logo");
  assert.equal(loading.hidden, true);
  assert.equal(video.muted, true, "exact target frame gate must still mute A/V preroll");
  const frameCallback = [...frames.values()][0];
  assert.ok(frameCallback);
  video.currentTime = 15;
  frameCallback(0, { mediaTime: 15 });
  assert.equal(video.muted, false);
  assert.equal(state.pendingSeek, null);
});

test("rapid second MSE seek supersedes old frame callback without replacing decoder or loader", () => {
  const frames = new Map(), calls = [];
  let frameSerial = 0;
  const video = { src: "blob:existing-decoder", currentTime: 5, paused: false,
    dataset: { mode: "transcode" }, muted: false, seeking: false,
    requestVideoFrameCallback(fn) { frames.set(++frameSerial, fn); return frameSerial; },
    cancelVideoFrameCallback(id) { frames.delete(id); }, pause() {}, play() { return Promise.resolve(); } };
  const source = {}, context = {};
  const state = { currentSource: source, transcodeContext: context,
    transcodeBaseOffsetSeconds: 10, pendingSeek: null, currentMs: 15000 };
  const session = { contains: (s) => s === 5 || s === 10 };
  const overlay = { getAttribute() { return null; }, setAttribute() {}, removeAttribute() {} };
  const ctx = vm.createContext({ state, video, playbackLoadRequestId: 1,
    frame: { classList: { add() {}, remove() {} } },
    $: () => overlay,
    window: { setTimeout() { return 1; }, clearTimeout() {} },
    playerIsPlaying: () => true, playerWantsMuted: () => false,
    invalidateSubtitleFrameClock() {}, renderSubtitles() {}, updateCompatControls() {},
    finishPlayerLoading() {}, schedulePresentedSubtitleFrame() {},
    audioSync: { key: "" }, hideLoadingForBufferedSeek() {},
    scheduleAudioSync() {}, scheduleTranscodeSeek(s) { calls.push(["reopen", s]); },
  });
  vm.runInContext("let remuxMseSession = null; let remuxMseWarmSeek = null;\n" +
    sourceSlice("function cancelRemuxMseWarmSeek(", "function cancelTranscodeStart("), ctx);
  ctx.__session = session;
  vm.runInContext("remuxMseSession = __session", ctx);
  assert.equal(vm.runInContext("seekInsideRemuxMse(15)", ctx), true);
  const staleCallback = frames.get(1);
  assert.equal(vm.runInContext("seekInsideRemuxMse(20)", ctx), true,
    "second buffered seek must not be blocked by the first frame callback");
  assert.equal(video.currentTime, 10);
  assert.equal(state.pendingSeek?.target, 20);
  staleCallback(0, { mediaTime: 5 });
  assert.equal(state.pendingSeek?.target, 20, "late old callback cannot complete new seek");
  frames.get(2)(0, { mediaTime: 10 });
  assert.equal(state.pendingSeek, null);
  assert.deepEqual(calls, []);
});

test("MSE priming error uses one-way native recovery, never retries the same failing MSE mode", () => {
  const handlers = new Map();
  const calls = [];
  const attempt = {
    fallbackToNative() { calls.push("native fallback"); return true; },
    retryTransient() { calls.push("repeated MSE retry"); return true; },
  };
  const state = { pendingSeek: { priming: true, streamInstalled: true } };
  const video = { error: { code: 3 }, paused: true, pause() { calls.push("pause"); },
    addEventListener(type, callback) { handlers.set(type, callback); } };
  const context = vm.createContext({
    video, state, transcodeStartAttempt: attempt,
    isNewSourceFramePending: () => false,
    cancelTranscodeStart() { calls.push("cancel"); },
    setPlayerLoading() { calls.push("terminal sync error"); },
    currentRecoveryKey: () => null,
    frame: { classList: { remove() {} } },
    $: () => ({ hidden: false }),
  });
  vm.runInContext(sourceSlice('video.addEventListener("error", () => {', '\n$("#compat-play").addEventListener('), context);
  handlers.get("error")();
  assert.deepEqual(calls, ["native fallback"], "MSE decode error must not exhaust retries on MSE");
});

test("exhausted current media error reports decoder code and observed HTTP status without a duplicate FFmpeg request", () => {
  const handlers = new Map(), events = [];
  const video = { currentSrc: "http://127.0.0.1:5000/api/torrents/SECRET/files/1/transcode", error: { code: 4 },
    paused: true, pause() { events.push("pause"); },
    addEventListener(type, handler) { handlers.set(type, handler); } };
  const ctx = vm.createContext({
    video, state: { pendingSeek: { priming: true, streamInstalled: true } },
    transcodeStartAttempt: { fallbackToNative: () => false, retryTransient: () => false },
    isNewSourceFramePending: () => false,
    cancelTranscodeStart() { events.push("cancel"); },
    setPlayerLoading(_progress, title, detail, options) { events.push({ title, detail, error: options.error }); },
    performance: { getEntriesByName(name, kind) { events.push("timing"); assert.equal(name, video.currentSrc);
      assert.equal(kind, "resource"); return [{ responseStatus: 429 }]; } },
  });
  vm.runInContext(sourceSlice('video.addEventListener("error", () => {', '\n$("#compat-play").addEventListener('), ctx);
  handlers.get("error")();
  const failure = events.find(item => item?.title);
  assert.equal(failure.title, "Video synchronization unavailable");
  assert.match(failure.detail, /Media error 4 \(native\)/);
  assert.match(failure.detail, /HTTP 429/);
  assert.doesNotMatch(failure.detail, /SECRET/, "do not display torrent URLs or session identifiers");
  assert.deepEqual(events.filter(item => typeof item === "string"), ["timing", "cancel", "pause"]);
});

test("native HEVC Main10 SDR decode rejection switches to H264 once while retaining exact seek and audio intent", () => {
  const handlers=new Map(),calls=[];
  const context={baseUrl:"/api/torrents/test/files/1/transcode",copyVideo:true,forceH264:false,audioIndex:1};
  const source={sessionId:"test",fileIndex:1};
  const state={
    currentMediaProbe:{video:{codec:"hevc",pixelFormat:"yuv420p10le"},compatibility:{video:{hdr:false}}},
    currentSource:source,transcodeContext:context,
    pendingSeek:{target:84.5,wasPlaying:false,priming:true,streamInstalled:true},
  };
  const video={currentSrc:"http://127.0.0.1:5000/api/torrents/test/files/1/transcode",error:{code:4},
    paused:true,pause(){calls.push("pause");},addEventListener(type,cb){handlers.set(type,cb);}};
  const env=vm.createContext({
    state,video,transcodeStartAttempt:{fallbackToNative:()=>false,retryTransient:()=>false},
    isNewSourceFramePending:()=>false,
    performance:{getEntriesByName:()=>[{responseStatus:200}]},
    openTranscodeAt(target,options){calls.push({target,options});return Promise.resolve(true);},
    cancelTranscodeStart(){calls.push("cancel");},
    setPlayerLoading(){calls.push("error");},
  });
  vm.runInContext(sourceSlice('video.addEventListener("error", () => {', '\n$("#compat-play").addEventListener('),env);
  handlers.get("error")();
  assert.equal(context.forceH264,true,"unsupported HEVC copy must not be retried forever");
  assert.equal(calls.length,1,"only one compatibility fallback can be scheduled");
  assert.equal(calls[0].target,84.5);
  assert.equal(calls[0].options.wasPlaying,false,"paused seek must remain paused");
  assert.equal(calls[0].options.forceNative,true);
  assert.equal(context.audioIndex,1);
  handlers.get("error")();
  assert.equal(calls.filter(c=>typeof c==="object").length,1,"no second codec downgrade");
});

test("confirmed HTTP 200 HEVC decoder rejection skips redundant copy retries before one H264 fallback", () => {
  const handlers = new Map(), calls = [];
  const context = { copyVideo: true, forceH264: false, audioIndex: 1 };
  const state = {
    currentMediaProbe: { video: { codec: "hevc", pixelFormat: "yuv420p10le" },
      compatibility: { video: { hdr: false } } },
    transcodeContext: context,
    pendingSeek: { target: 85, wasPlaying: true, priming: true, streamInstalled: true },
  };
  const video = { currentSrc: "http://127.0.0.1:5000/transcode", error: { code: 4 },
    paused: false, pause() {}, addEventListener(type, callback) { handlers.set(type, callback); } };
  const env = vm.createContext({
    state, video, isNewSourceFramePending: () => false,
    transcodeStartAttempt: { fallbackToNative: () => false,
      retryTransient: () => { calls.push("repeat same HEVC conversion"); return true; } },
    performance: { getEntriesByName: () => [{ responseStatus: 200 }] },
    openTranscodeAt(target, options) { calls.push({ target, options }); return Promise.resolve(true); },
    cancelTranscodeStart() { calls.push("cancel"); }, setPlayerLoading() { calls.push("terminal"); },
  });
  vm.runInContext(sourceSlice('video.addEventListener("error", () => {', '\n$("#compat-play").addEventListener('), env);
  handlers.get("error")();
  assert.equal(context.forceH264, true);
  assert.equal(calls.filter((entry) => typeof entry === "object").length, 1);
  assert.equal(calls.includes("repeat same HEVC conversion"), false,
    "a successfully served but unsupported HEVC payload needs no duplicate copy attempts");
});

test("missing pieces prevent false HEVC downgrade, then the same seek resumes when its range fills", () => {
  const state = {
    currentSource: { sessionId: "private-session", fileIndex: 1 },
    transcodeContext: { sessionId: "private-session", fileIndex: 1, copyVideo: true,
      forceH264: false, audioIndex: 2 },
    mediaDurationMs: 1374_970,
  };
  const events = [];
  const ctx = vm.createContext({
    state, video: { pause() { events.push("pause"); } },
    torrentSeekPieceStatus, Date,
    decodeBase64Bytes: (raw) => new Uint8Array(Buffer.from(raw, "base64")),
    cancelTranscodeStart() { events.push("cancel prior stream"); },
    setPlayerLoading(_percent, title, detail, options) {
      events.push({ title, detail, error: options.error });
    },
    openTranscodeAt(target, options) {
      events.push({ target, options }); return Promise.resolve(true);
    },
  });
  const start = app.indexOf("let latestTorrentPieceSnapshot = null;");
  const end = app.indexOf("\nfunction invalidateStreamStatus()", start);
  assert.ok(start > 0 && end > start);
  vm.runInContext(app.slice(start, end), ctx);
  const missing = new Uint8Array(120).fill(255);
  missing.fill(0, 3, 20);
  ctx.__snapshot = { source: state.currentSource, sessionId: "private-session", fileIndex: 1,
    at: Date.now(), map: Buffer.from(missing).toString("base64"), durationSeconds: 1374.97 };
  vm.runInContext("latestTorrentPieceSnapshot = __snapshot", ctx);
  assert.equal(vm.runInContext("waitForMissingTorrentSeek(108, true)", ctx), true);
  assert.equal(events.find((entry) => entry.title)?.title, "Waiting for torrent data");
  assert.equal(state.transcodeContext.forceH264, false);
  vm.runInContext("resumeWaitingTorrentSeek({}, state.currentSource)", ctx);
  assert.equal(events.some((entry) => entry.target === 108), false, "do not retry the same absent piece");
  missing.fill(255);
  ctx.__snapshot.map = Buffer.from(missing).toString("base64");
  ctx.__snapshot.at = Date.now();
  vm.runInContext("resumeWaitingTorrentSeek({}, state.currentSource)", ctx);
  const reopened = events.find((entry) => entry.target === 108);
  assert.ok(reopened);
  assert.equal(reopened.options.wasPlaying, true);
  assert.equal(reopened.options.forceNative, true);
  assert.equal(state.transcodeContext.audioIndex, 2);
  assert.equal(state.transcodeContext.forceH264, false);
  vm.runInContext("resumeWaitingTorrentSeek({}, state.currentSource)", ctx);
  assert.equal(events.filter((entry) => entry.target === 108).length, 1,
    "only one resume is launched for the verified bucket transition");
});

test("native media error never converts HDR or HTTP 429 into a speculative lossy codec fallback", () => {
  for(const {hdr,status} of [{hdr:true,status:200},{hdr:false,status:429}]){
    const handlers=new Map(),calls=[];
    const context={baseUrl:"/api/torrents/test/files/1/transcode",copyVideo:true,forceH264:false};
    const state={currentMediaProbe:{video:{codec:"hevc"},compatibility:{video:{hdr}}},
      transcodeContext:context,pendingSeek:{target:12,wasPlaying:true,priming:true,streamInstalled:true}};
    const env=vm.createContext({
      state,video:{currentSrc:"http://127.0.0.1:5000/transcode",error:{code:4},
        paused:false,pause(){calls.push("pause");},addEventListener(type,cb){handlers.set(type,cb);}},
      transcodeStartAttempt:{fallbackToNative:()=>false,retryTransient:()=>false},
      isNewSourceFramePending:()=>false,performance:{getEntriesByName:()=>[{responseStatus:status}]},
      cancelTranscodeStart(){calls.push("cancel");},openTranscodeAt(){calls.push("converted");},
      setPlayerLoading(){calls.push("terminal");},
    });
    vm.runInContext(sourceSlice('video.addEventListener("error", () => {', '\n$("#compat-play").addEventListener('),env);
    handlers.get("error")();
    assert.equal(context.forceH264,false);
    assert.equal(calls.includes("converted"),false);
    assert.ok(calls.includes("terminal"));
  }
});

test("old media events cannot finish, restart or fail a newer episode's branded loader", () => {
  for (const type of ["timeupdate", "ended", "seeking", "canplay", "playing", "play", "error", "waiting", "stalled", "pause"]) {
    const handlers = new Map(), events = [];
    const ctx = vm.createContext({
      isNewSourceFramePending: () => true,
      sourceFrameGate: { src: "blob:video-two" },
      video: { currentSrc: "blob:video-one", error: { code: 3 }, paused: true,
        addEventListener(name, callback) { handlers.set(name, callback); } },
      state: { pendingSeek: null },
      finishPlayerLoading() { events.push("wrong source revealed"); },
      recoverPlayback() { events.push("wrong source recovered"); },
      startAutoNext() { events.push("wrong source auto-next"); },
      setPlayerLoading() { events.push("wrong source failed"); },
    });
    const start = app.lastIndexOf(`video.addEventListener("${type}", () => {`);
    const end = app.indexOf('\n});', start);
    assert.ok(start >= 0 && end > start);
    vm.runInContext(app.slice(start, end + 4), ctx);
    handlers.get(type)();
    assert.deepEqual(events, [], `old ${type} event must not affect video2`);
  }
});

test("cache-backed warm MSE restoration defers logo until a verified disk miss", async () => {
  const timers = [];
  const calls = [];
  const source = { sessionId: "video-two" }, context = { audioIndex: 1, copyVideo: true };
  let restored = true;
  const mse = { cancelRestore() {}, async restoreWindow() { calls.push("cache lookup"); return restored; } };
  const state = { currentSource: source, transcodeContext: context, transcodeBaseOffsetSeconds: 10,
    pendingSeek: null, currentMs: 0 };
  const video = { paused: false, dataset: { mode: "transcode" },
    pause() { this.paused = true; } };
  const ctx = vm.createContext({
    window: { setTimeout(callback, ms) { timers.push(callback); calls.push(`timer:${ms}`); return timers.length; },
      clearTimeout() {} },
    playbackLoadRequestId: 3, state, video,
    invalidateStreamStatus() {}, bufferedRemuxSeekTarget: () => false,
    cancelTranscodeStart() {},
    hideLoadingForBufferedSeek() { calls.push("hide logo"); },
    setPlayerLoading() { calls.push("show logo"); },
    renderSubtitles() {}, updateCompatControls() {},
    seekInsideRemuxMse(target) { calls.push(`warm seek:${target}`); return true; },
    openTranscodeAt() { calls.push("native fallback"); },
    restartTranscodeAt() { calls.push("live remux fallback"); },
    formatTime: () => "00:25",
    forceNative: false,
  });
  vm.runInContext(`let remuxMseSession = __mse;\n${sourceSlice("function scheduleTranscodeSeek(", "// While a seek is waiting,")}`, Object.assign(ctx, { __mse: mse }));
  vm.runInContext("scheduleTranscodeSeek(25)", ctx);
  assert.ok(calls.includes("hide logo"));
  assert.equal(calls.includes("show logo"), false);
  await timers[0]();
  assert.ok(calls.includes("warm seek:25"));
  assert.equal(calls.includes("show logo"), false, "a verified disk cache restoration stays logo-free");

  restored = false;
  calls.length = 0;
  vm.runInContext("scheduleTranscodeSeek(26)", ctx);
  await timers.at(-1)();
  assert.ok(calls.includes("show logo"), "a failed cache lookup must expose actual uncached loading");
  assert.ok(calls.includes("live remux fallback"));
});

test("hover progress uses the selected pack file and resets on source change", () => {
  const labels = new Map();
  for (const name of ["#player-downloaded", "#player-uploaded", "#player-download-target", "#player-transfer-stats", "#player-transfer-down"])
    labels.set(name, { textContent: "", hidden: false, setAttribute() {} });
  const ctx = vm.createContext({
    $: name => labels.get(name) || null,
    state: { currentSource: { kind: "torrent", fileIndex: 1 } },
    updateLoadingTransferDetail() {},
  });
  vm.runInContext(sourceSlice("function formatTransferBytes(", "function stopTransferStats("), ctx);
  vm.runInContext("updateTransferStats({downloaded:1048576,uploaded:4096,length:8589934592,files:[{index:1,length:314572800,downloaded:1048576}]})", ctx);
  assert.equal(labels.get("#player-download-target").textContent, "↓ 1.0 MB / 300.0 MB");
  assert.equal(labels.get("#player-downloaded").textContent, "↓ 1.0 MB");
  assert.equal(labels.get("#player-uploaded").textContent, "↑ 4 KB");
  vm.runInContext("updateTransferStats()", ctx);
  assert.equal(labels.get("#player-download-target").textContent, "↓ 0 B / —");
  assert.equal(labels.get("#player-transfer-stats").hidden, true);
});

test("paused MSE decoder failure falls back once to native without resuming audio or changing source", () => {
  const calls = [];
  const video = { dataset: { mode: "transcode" }, src: "blob:current-mse", paused: true };
  const source = { kind: "torrent", sessionId: "video-two" };
  const ctx = vm.createContext({
    video, state: { currentSource: source, transcodeContext: { baseUrl: "/api/torrents/video-two/files/0/transcode" } },
    absolutePlaybackSeconds: () => 25.37,
    openTranscodeAt(target, options) { calls.push({ target, options }); },
  });
  const excerpt = sourceSlice("function fallbackActiveRemuxMseToNative(", "function seekInsideRemuxMse(");
  vm.runInContext(`let remuxMseSession = {objectUrl:'blob:current-mse'};\n${excerpt}`, ctx);
  assert.equal(vm.runInContext("fallbackActiveRemuxMseToNative()", ctx), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].target, 25.37);
  assert.equal(calls[0].options.wasPlaying, false, "user pause must not turn into hidden audio playback");
  assert.equal(calls[0].options.forceNative, true);
  video.src = "blob:other-episode";
  assert.equal(vm.runInContext("fallbackActiveRemuxMseToNative()", ctx), false);
  assert.equal(calls.length, 1, "old MSE failure must not restart a newer episode");
});
