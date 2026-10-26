import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// Checks the real Watch watchdog with deterministic time and no media/network.
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const start = app.indexOf("function beginRecoveryWatch(");
const end = app.indexOf("\nfunction stopRecoveryWatch(", start);
assert.ok(start >= 0 && end > start);

test("PiP playback remains stall-recoverable outside Watch; ordinary hidden Watch remains idle", () => {
  let now = 1_000;
  let tick = null;
  const recovery = [];
  const video = { paused: false, seeking: false, ended: false, readyState: 2 };
  const document = { pictureInPictureElement: null };
  const ctx = vm.createContext({
    Date: { now: () => now }, document, video,
    $: (selector) => selector === "#view-watch" ? { classList: { contains: () => false } } : null,
    state: { pendingSeek: null, mediaDurationMs: 120_000 },
    frame: { classList: { contains: (value) => value === "has-video" } },
    viewActive: () => false,
    currentRecoveryKey: () => "torrent:0",
    isPlaybackStallExpired: () => false,
    absolutePlaybackSeconds: () => 12,
    recoverPlayback: (reason) => { recovery.push(reason); },
    recoveryWatchTimer: null, recoveryWaitingSince: null,
    recoveryLastMotionAt: 0, recoveryLastPosition: -1, recoveryBusy: false,
    window: { setInterval: (cb) => { tick = cb; return 1; } },
  });
  vm.runInContext(app.slice(start, end), ctx);
  ctx.beginRecoveryWatch();
  now += 17_000;
  tick();
  assert.deepEqual(recovery, [], "Hidden Watch without PiP should not retry a source");
  document.pictureInPictureElement = video;
  tick();
  assert.deepEqual(recovery, ["stall"], "A visible PiP torrent must recover when playback freezes");
  recovery.length = 0;
  document.pictureInPictureElement = null;
  ctx.$ = (selector) => selector === "#view-watch" ? { classList: { contains: (value) => value === "is-floating" } } : null;
  tick();
  assert.deepEqual(recovery, ["stall"], "The in-app floating torrent also remains recoverable");
  recovery.length = 0;
  ctx.$ = (selector) => selector === "#view-watch" ? { classList: { contains: () => false } } : null;
  ctx.window.documentPictureInPicture = { window: {} };
  tick();
  assert.deepEqual(recovery, ["stall"], "Document PiP on the desktop keeps bounded torrent recovery active");
  recovery.length = 0;
  ctx.window.documentPictureInPicture = null;
  video.paused = true;
  tick();
  assert.deepEqual(recovery, [], "Explicitly paused PiP should not reconnect");
});
