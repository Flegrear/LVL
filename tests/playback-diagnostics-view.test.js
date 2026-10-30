import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { addRecoveryEvent, recoveryEpisodeCode } from "../frontend/player/playback-diagnostics.js";
import { createPlaybackRecoveryState, recordPlaybackProgress, requestPlaybackRecovery, playbackRetryStrategy } from "../frontend/player/playback-recovery.js";
import { classifyPlaybackStreamStatus } from "../frontend/player/stream-status.js";

const app = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../frontend/styles/styles.css", import.meta.url), "utf8");

function section(from, to) {
  const first = app.indexOf(from);
  const last = app.indexOf(to, first + from.length);
  assert.ok(first >= 0 && last > first, `Missing source section: ${from}`);
  return app.slice(first, last);
}

test("Recovery history is bounded and never copies URLs, magnets, titles or raw exceptions", () => {
  let events = [];
  for (let i = 0; i < 55; i++) {
    events = addRecoveryEvent(events, {
      type: "retry", reason: "magnet:?xt=private", plan: "https://secret", attempt: i, seconds: 12.7, now: 1000 + i,
      rawError: "Authorization: Bearer secret", sourceId: "secret-file", title: "private episode",
    });
  }
  assert.equal(events.length, 40);
  assert.equal(events[0].at, 1015);
  assert.deepEqual(Object.keys(events[0]).sort(), ["at", "attempt", "label", "plan", "reason", "seconds"]);
  assert.equal(events[0].reason, "");
  assert.equal(events[0].plan, "Other");
  assert.equal(events[0].seconds, 13);
  assert.doesNotMatch(JSON.stringify(events), /magnet|secret|private|Bearer|https/);
  assert.strictEqual(addRecoveryEvent(events, { type: "https://unsafe" }), events, "Unknown event types are ignored");
  assert.equal(recoveryEpisodeCode("Blue.Box.S01E02.mkv - magnet:?secret"), "S01E02");
  assert.equal(recoveryEpisodeCode("https://unsafe/private"), "Current video");
});

function harness() {
  const nodes = {};
  const make = (id) => nodes[id] = {
    hidden: true,
    textContent: "",
    open: false,
    children: [],
    removeAttribute(name) { if (name === "open") this.open = false; },
    replaceChildren(...children) { this.children = children; },
    style: { setProperty() {} },
    classList: {
      values: new Set(),
      contains(name) { return this.values.has(name); },
      toggle(name, enabled) { if (enabled) this.values.add(name); else this.values.delete(name); },
    },
  };
  for (const id of ["video-loading", "video-loading-title", "video-loading-actions",
    "video-loading-brand", "video-loading-fallback",
    "video-recovery-message", "video-recovery-meta", "video-recovery-details",
    "video-recovery-events", "media-status"]) make(id);
  const actions = [];
  const context = vm.createContext({
    $: (id) => nodes[id.replace(/^#/, "")],
    document: { createElement: () => ({ textContent: "" }), pictureInPictureElement: null },
    state: { loadingProgress: 10, currentSource: { kind: "torrent", sourceTag: "Blue Box - S01E02" }, transcodeContext: null, pendingSeek: null },
    video: { dataset: { mode: "torrent-direct" }, error: null, ended: false, currentTime: 15 },
    watchPendingSelection: null,
    addRecoveryEvent, recoveryEpisodeCode, createPlaybackRecoveryState,
    classifyPlaybackStreamStatus,
    HTMLMediaElement: { HAVE_FUTURE_DATA: 3 },
    requestPlaybackRecovery, playbackRetryStrategy, recordPlaybackProgress,
    playbackRecovery: createPlaybackRecoveryState("source-a", 0),
    playbackLoadRequestId: 0,
    recoveryBusy: false,
    recoveryWaitingSince: null,
    recoveryLastMotionAt: 0,
    recoveryLastPosition: -1,
    window: { clearTimeout() {} },
    formatTime: (ms) => `00:${String(Math.round(ms / 1000)).padStart(2, "0")}`,
    absolutePlaybackSeconds: () => 15,
    playerLoadingHideTimer: 0, playerLoadingVisualProgress: 0,
    updatePlayerLoadingAnimation: () => {},
    currentRecoveryKey: () => "source-a",
    viewActive: () => true,
    floatingDesktopWindow: null,
    floatingDesktopPending: false,
    currentChapterSources: () => [],
    stopRecoveryWatch: () => actions.push("watch-stopped"),
    toast: (message) => actions.push(message),
    reloadDirectTorrentAt: () => { actions.push("restart-direct"); return true; },
    forceCompatibilityTranscode: () => {},
    restartTranscodeAt: async () => {},
    failPlaybackRecoverySwitch: () => {},
    playLibraryEpisode: async () => true,
    finishPlayerLoading: () => actions.push("loader-finished"),
    setTimeout: () => 1,
    console: { warn() {} },
  });
  vm.runInContext(section('let recoveryDisplayPhase = "";', "\nfunction currentRecoveryKey()"), context);
  vm.runInContext(section("function setPlayerLoading(", "\nfunction updateLoadingTransferDetail("), context);
  vm.runInContext(section("async function recoverPlayback(", "\nfunction scheduleBufferingIndicator("), context);
  return { nodes, context, actions, run: (expression) => vm.runInContext(expression, context) };
}

test("Recovering shows the normal LVL logo loader with no visible diagnostics until a genuine failure", async () => {
  const h = harness();
  await h.run('recoverPlayback("stall")');
  assert.ok(h.nodes["video-loading"].classList.contains("is-recovering"));
  assert.equal(h.nodes["video-loading-title"].textContent, "Restoring playback");
  assert.equal(h.nodes["video-loading-actions"].hidden, true);
  assert.equal(h.nodes["video-recovery-message"].hidden, true, "no visible recovery log during a retry");
  assert.equal(h.nodes["video-recovery-meta"].hidden, true, "no episode, clock, or retry number displayed");
  assert.equal(h.nodes["video-recovery-details"].hidden, true);
  assert.doesNotMatch(css, /\.video-loading\.is-recovering\s+\.video-loading-brand\s*\{\s*display:none/);
  assert.doesNotMatch(css, /\.video-loading:is\(\.is-recovering,\.is-error\) \.video-loading-brand/);
  assert.doesNotMatch(css, /\.video-loading\.is-recovering\s+\.video-loading-title\s*\{\s*position:static/);
  assert.match(css, /\.video-loading\.is-error \.video-loading-brand \{ display:none; \}/);
  assert.match(css, /\.video-loading-brand \{ position:relative;/);
  h.run('setPlayerLoading(30, "Buffering")');
  assert.equal(h.nodes["video-loading-title"].textContent, "Restoring playback", "later buffering events do not show diagnostic text");
  assert.equal(h.nodes["video-recovery-meta"].hidden, true);
  await h.run('recoverPlayback("stall")');
  assert.ok(h.nodes["video-loading"].classList.contains("is-error"));
  assert.ok(!h.nodes["video-loading"].classList.contains("is-recovering"));
  assert.equal(h.nodes["video-loading-actions"].hidden, false);
  assert.equal(h.nodes["video-loading-title"].textContent, "Playback unavailable");
  assert.match(h.nodes["video-recovery-meta"].textContent, /1 source attempted/);
  assert.equal(h.nodes["video-recovery-details"].hidden, false);
  assert.ok(h.nodes["video-recovery-events"].children.length >= 3);
  const eventText = h.nodes["video-recovery-events"].children.map((entry) => entry.textContent).join(" ");
  assert.match(eventText, /Playback interrupted/);
  assert.match(eventText, /Retrying current source/);
  assert.match(eventText, /Playback stopped safely/);
  assert.doesNotMatch(eventText, /source-a|Blue Box|magnet/);
  h.run('setPlayerLoading(40, "Buffering")');
  assert.ok(h.nodes["video-loading"].classList.contains("is-error"), "failure survives a delayed loader update");
  assert.equal(h.nodes["video-loading-title"].textContent, "Playback unavailable");
  assert.ok(h.actions.includes("watch-stopped"));
});

test("Only real forward playback closes a recovery overlay; initial media readiness cannot claim success", async () => {
  const h = harness();
  await h.run('recoverPlayback("stall")');
  vm.runInContext(section("function markPlaybackMotion(", "\nfunction beginRecoveryWatch("), h.context);
  h.context.absolutePlaybackSeconds = () => 15;
  h.run("markPlaybackMotion()");
  assert.equal(h.run("recoveryDisplayPhase"), "recovering", "first motion sample only anchors the playhead");
  h.context.absolutePlaybackSeconds = () => 15.5;
  h.run("markPlaybackMotion()");
  assert.equal(h.run("recoveryDisplayPhase"), "");
  assert.ok(h.actions.includes("loader-finished"));
  assert.match(h.run("recoveryDisplayEvents.at(-1).label"), /Playback restored/);
  assert.equal(h.nodes["video-recovery-meta"].hidden, true);
});

test("recovery overlay stays visible until the new source presents an actual decoder frame", async () => {
  const h = harness();
  await h.run('recoverPlayback("stall")');
  h.context.video.requestVideoFrameCallback = () => 1;
  h.context.presentedSubtitleSeconds = () => null;
  vm.runInContext(section("function markPlaybackMotion(", "\nfunction beginRecoveryWatch("), h.context);
  h.context.absolutePlaybackSeconds = () => 15;
  h.run('markPlaybackMotion()');
  h.context.absolutePlaybackSeconds = () => 15.5;
  h.run('markPlaybackMotion()');
  assert.equal(h.run('recoveryDisplayPhase'), 'recovering',
    'timeupdate alone is not proof of the first decoded frame');
  h.context.presentedSubtitleSeconds = () => 15.75;
  h.context.absolutePlaybackSeconds = () => 15.8;
  h.run('markPlaybackMotion()');
  assert.equal(h.run('recoveryDisplayPhase'), '',
    'matching presented frame and clock can confirm restoration');
});

test("Delayed media errors cannot restart hidden Watch, but active PiP may recover", async () => {
  const h = harness();
  h.context.viewActive = () => false;
  await h.run('recoverPlayback("error")');
  assert.equal(h.run("playbackRecovery.retryCount"), 0);
  assert.ok(!h.actions.includes("restart-direct"), "there must be no hidden audio restart");
  h.context.document.pictureInPictureElement = h.context.video;
  await h.run('recoverPlayback("error")');
  assert.equal(h.run("playbackRecovery.retryCount"), 1);
  assert.ok(h.actions.includes("restart-direct"), "visible native PiP still gets playback recovery");
});

test("measured torrent starvation prevents a misleading codec fallback after browser error 3", async () => {
  const h = harness();
  h.context.video.error = { code: 3 };
  h.context.video.paused = false;
  h.context.video.readyState = 2;
  h.context.forceCompatibilityTranscode = async () => { h.actions.push("compatibility"); return true; };
  h.run(`streamStatusHealth = { peers: 0, activeReaderCount: 1, readers: [
    { role: 'unknown', ageMs: 9000, nextPiecePresent: false, firstPiecePresent: true }
  ] }; streamStatusAt = Date.now(); recoveryWaitingSince = Date.now();`);
  await h.run('recoverPlayback("error")');
  assert.ok(h.actions.includes("restart-direct"));
  assert.ok(!h.actions.includes("compatibility"));
  assert.match(h.nodes["video-recovery-message"].textContent, /No peers/);
  assert.equal(h.nodes["video-recovery-message"].hidden, false, "the measured reason is visible while restoring");
  assert.equal(h.nodes["video-loading-actions"].hidden, true, "existing Retry and Choose source are failure actions");
});

test("expired or absent reader evidence leaves existing genuine codec fallback intact", async () => {
  const h = harness();
  h.context.video.error = { code: 3 };
  h.context.video.paused = false;
  h.context.video.readyState = 2;
  h.context.forceCompatibilityTranscode = async () => { h.actions.push("compatibility"); return true; };
  h.run(`streamStatusHealth = { peers: 0, activeReaderCount: 1,
    readers: [{ nextPiecePresent: false }] }; streamStatusAt = Date.now() - 10_000;
    recoveryWaitingSince = Date.now();`);
  await h.run('recoverPlayback("error")');
  assert.ok(h.actions.includes("compatibility"));
  assert.equal(h.nodes["video-recovery-message"].hidden, true);
});

test("Alternative-source recovery is recorded as a switch, not an unbounded same-source retry", async () => {
  const h = harness();
  h.context.currentChapterSources = () => [{ entry: { id: "b" }, episode: { fileIndex: 2 } }];
  h.context.playbackRecoverySourceKey = (id, index) => `${id}:${index}`;
  await h.run('recoverPlayback("error")');
  await h.run('recoverPlayback("error")');
  assert.equal(h.run("recoveryDisplayPhase"), "recovering");
  assert.equal(h.nodes["video-recovery-meta"].hidden, true, "alternate source retries also display only the branded loader");
  assert.match(h.nodes["video-recovery-meta"].textContent, /Source switch 1/, "the incident metadata remains recorded for failure details");
  assert.equal(h.run("recoveryDisplayEvents.at(-1).label"), "Trying another source");
  assert.equal(h.run("playbackRecovery.sourceSwitches"), 1);
});

test("a rejected long-pause transcode restart cannot leave Reconnecting playback stuck while paused", async () => {
  const h = harness();
  const pending = [];
  h.context.video.dataset.mode = "transcode";
  h.context.video.paused = true;
  h.context.restartTranscodeAt = async () => false; // Verified seek lookup rejected or expired session.
  h.context.window.setTimeout = (callback) => { pending.push(callback); return pending.length; };
  await h.run('recoverPlayback("error")');
  assert.equal(h.run("recoveryDisplayPhase"), "recovering");
  assert.equal(pending.length, 1, "failed playback must schedule one bounded follow-up even when paused");
  assert.equal(h.nodes["video-recovery-meta"].hidden, true);
  assert.match(h.nodes["video-recovery-meta"].textContent, /Retry 1/, "never show Retry 0 after a reset");
  pending.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.run("recoveryDisplayPhase"), "failed", "recovery must reach a usable error state instead of hanging");
  assert.equal(h.nodes["video-loading-actions"].hidden, false, "offer Retry/Choose source once exhausted");
  assert.equal(pending.length, 0, "an exhausted source cannot loop forever");
});

test("Error display remains compact and is only accessible during a genuine failed recovery", () => {
  const markup = html.slice(html.indexOf('id="video-loading"'), html.indexOf('id="player-up-next"'));
  for (const id of ["video-recovery-message", "video-recovery-meta", "video-recovery-details", "video-recovery-events"]) {
    assert.match(markup, new RegExp(`id="${id}"`));
  }
  assert.match(markup, /<summary>Details<\/summary>/);
  assert.match(markup, /id="player-retry-source"/);
  assert.match(markup, /id="player-choose-source"/);
  assert.doesNotMatch(markup, /Diagnostics|Report error|Copy log|data-error-token/);
  assert.match(css, /\.video-recovery-events \{[^}]*max-height:145px/);
  assert.match(app, /if \(!recoveryBusy\) resetRecoveryDisplay\(\)/, "manual new sources discard previous error context");
  assert.match(app, /recoveryDisplayPhase === "recovering" && !recoveryBusy/, "recovery ends only after actual forward playback");
  const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  assert.match(server, /\["\/playback-diagnostics\.js", \{ file: "frontend\/player\/playback-diagnostics\.js"/);
  assert.ok(fs.statSync(new URL("../frontend/player/playback-diagnostics.js", import.meta.url)).isFile(),
    "the diagnostics module must exist in the clean source for the new package manifest");
});
