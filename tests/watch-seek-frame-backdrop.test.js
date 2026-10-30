import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../frontend/styles/styles.css", import.meta.url), "utf8");
const begin = app.indexOf("function preserveCurrentFrameForTranscodeSeek(");
const end = app.indexOf("\nfunction clearPreviousVideoFrame(", begin);
assert.ok(begin > 0 && end > begin);

test("cold same-episode seek uses a dimmed frozen preview until new decoder, without capturing a new episode", () => {
  const drawings = [];
  const canvas = { hidden: true, width: 640, height: 360,
    getContext() { return { fillRect(...args) { drawings.push(["background", ...args]); },
      drawImage(...args) { drawings.push(["frame", ...args]); } }; } };
  const state = { currentSource: { kind: "torrent" } };
  const video = { videoWidth: 1920, videoHeight: 1080, readyState: 4 };
  const ctx = vm.createContext({
    state, video, document: { getElementById: id => id === "video-seek-freeze" ? canvas : null },
  });
  vm.runInContext(app.slice(begin, end), ctx);
  vm.runInContext("preserveCurrentFrameForTranscodeSeek()", ctx);
  assert.equal(canvas.hidden, false);
  assert.equal(drawings.filter(d => d[0] === "frame").length, 1);
  vm.runInContext("preserveCurrentFrameForTranscodeSeek()", ctx);
  assert.equal(drawings.filter(d => d[0] === "frame").length, 1,
    "replacement/retry must not snapshot an incomplete new decoder over the previous backdrop");
  vm.runInContext("clearTranscodeSeekFrame()", ctx);
  assert.equal(canvas.hidden, true);
  state.currentSource = { kind: "local" };
  vm.runInContext("preserveCurrentFrameForTranscodeSeek()", ctx);
  assert.equal(canvas.hidden, true, "a different non-torrent source must never retain an old episode image");
});

test("frozen picture exists only under a cold conversion; new decoded frame or source switch clears it", () => {
  assert.match(html, /id="video-seek-freeze"[^>]*aria-hidden="true" hidden/);
  assert.match(css, /\.video-seek-freeze\[hidden\]\s*\{\s*display:none/);
  assert.match(app, /if \(!initialize && typeof preserveCurrentFrameForTranscodeSeek === "function"\)\s*preserveCurrentFrameForTranscodeSeek\(\);/);
  assert.match(app, /function clearPreviousVideoFrame\(\) \{\s*clearTranscodeSeekFrame\(\)/);
  assert.match(app, /sourceFrameGate = null;[\s\S]{0,350}if \(!state\.pendingSeek\?\.priming\) clearTranscodeSeekFrame\(\);/);
});

test("a cold seek snapshots the old decoded frame before pause and debounce", () => {
  const from = app.indexOf("function scheduleTranscodeSeek(");
  const to = app.indexOf("\n// While a seek is waiting", from);
  assert.ok(from > 0 && to > from);
  const events = [];
  const ctx = vm.createContext({
    state: { currentSource: { kind: "torrent" }, transcodeContext: { audioIndex: 0 },
      transcodeBaseOffsetSeconds: 0, pendingSeek: null, currentMs: 0 },
    video: { paused: false, pause() { events.push("pause"); this.paused = true; } },
    remuxMseSession: null, playbackLoadRequestId: 1,
    bufferedRemuxSeekTarget: () => false,
    preserveCurrentFrameForTranscodeSeek: () => events.push("snapshot"),
    invalidateStreamStatus() {}, cancelTranscodeStart() {},
    clearWaitingTorrentSeek() {}, setPlayerLoading() {}, formatTime: () => "1:05",
    renderSubtitles() {}, updateCompatControls() {},
    window: { clearTimeout() {}, setTimeout() { return 1; } },
  });
  vm.runInContext(app.slice(from, to), ctx);
  vm.runInContext("scheduleTranscodeSeek(65)", ctx);
  assert.deepEqual(events.slice(0, 2), ["snapshot", "pause"],
    "capture must precede the debounce, old-source cancellation and pause");
});

test("new-source loadeddata cannot erase a frozen image while the requested GOP is still in hidden preroll", () => {
  const from = app.indexOf("let sourceFrameGate = null;");
  const to = app.indexOf("\nfunction beginSourceTransition(", from);
  const handlers = {};
  const canvas = { hidden: false };
  const source = { kind: "torrent" };
  const video = { src: "https://local/current", currentSrc: "https://local/current", readyState: 4,
    style: {}, addEventListener(type, fn) { handlers[type] = fn; } };
  const frame = { classList: { remove() {} } };
  const ctx = vm.createContext({ video, frame, source, playbackLoadRequestId: 3,
    state: { currentSource: source, pendingSeek: { target: 65, priming: true } },
    document: { getElementById(id) { return id === "video-seek-freeze" ? canvas : null; } },
    finishPlayerLoading() {},
  });
  vm.runInContext(app.slice(from, to), ctx);
  vm.runInContext("sourceFrameGate = { src: video.src, source: state.currentSource, loadId: playbackLoadRequestId }", ctx);
  handlers.loadeddata();
  assert.equal(canvas.hidden, false, "do not drop backdrop until target frame can be shown");
});
