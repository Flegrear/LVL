import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");

function sourceBetween(start, end) {
  const at = app.indexOf(start);
  const until = app.indexOf(end, at + start.length);
  assert.ok(at >= 0 && until > at, `production seam ${start} exists`);
  return app.slice(at, until);
}

test("failed audio-track preflight must not advertise a dub that never became audible", async () => {
  const previousUrl = "http://localhost/transcode?audio=0&start=30";
  const video = { dataset: { mode: "transcode" }, src: previousUrl, paused: false };
  const subtitle = { id: "external", visible: true, exactMedia: false,
    syncSource: "audio", syncMode: "constant", offsetMs: 0,
    syncAnchors: [{ atMs: 30_000, offsetMs: 4_000 }],
    cues: [{ startMs: 25_000, endMs: 27_000, text: "Subtitle still here" }],
    audioSync: { status: "synced", windows: 2 }, syncFollowsId: "master" };
  const initialSync = structuredClone(subtitle);
  const painted = [];
  const remembered = [];
  const overlay = { hidden: false, classList: { removed: [], remove(name) { this.removed.push(name); } } };
  let resumed = 0;
  const state = {
    currentSource: { sessionId: "session1", fileIndex: 0 },
    currentMediaProbe: { audioTracks: [
      { language: "jpn", codec: "aac" },
      { language: "eng", codec: "ac3" },
    ] },
    selectedAudioTrack: 0,
    transcodeContext: { baseUrl: "/api/torrents/session1/files/0/transcode",
      sessionId: "session1", fileIndex: 0, audioIndex: 0, copyVideo: true },
    tracks: [subtitle],
  };
  const ctx = vm.createContext({
    state, video, preferredAudioLanguage: "jpn",
    playerIsPlaying: () => true, absolutePlaybackSeconds: () => 30,
    setPlayerLoading() {}, audioTrackLabel: () => ({ title: "English" }),
    $: () => overlay, stopPlayerLoadingAnimation() {},
    resumePlayback() { resumed += 1; video.paused = false; },
    currentSourceTracks: () => state.tracks,
    // Simulate production's invalidation of audio-derived timing when a dub changes.
    resetAudioSync() {
      subtitle.syncSource = "";
      subtitle.syncAnchors = [];
      subtitle.audioSync = { status: "waiting", windows: 0 };
      delete subtitle.syncFollowsId;
    },
    subtitleRenderMemo: { key: "cached" },
    renderSubtitles() {
      const offset = subtitle.syncAnchors[0]?.offsetMs || 0;
      painted.push(subtitle.cues.filter((cue) => 30_000 >= cue.startMs + offset && 30_000 <= cue.endMs + offset).map((cue) => cue.text));
    },
    updatePlayerSyncStatus() {}, renderPlayerAudioMenu() {}, scheduleAudioSync() {},
    rememberSeriesAudioTrack: (...args) => remembered.push(args),
    // An unsupported keyframe timeline can fail closed, correctly leaving the old video URL.
    openTranscodeAt: async (_target, options) => {
      video.paused = true;
      options.onPreflightFailure({ wasPlaying: true });
      return false;
    },
  });
  vm.runInContext(sourceBetween("let audioTrackSwitchGeneration = 0;", "\nfunction updateChapterButtons("), ctx);
  await vm.runInContext("switchAudioTrack(1, { remember: true })", ctx);
  assert.equal(video.src, previousUrl, "rejected transcode preflight retains the old audio stream");
  assert.equal(state.selectedAudioTrack, 0,
    "audio menu and synchronized subtitle model must reflect the audio actually playing");
  assert.equal(state.transcodeContext.audioIndex, 0,
    "subsequent seeks must not silently change to an audio dub the user never heard");
  assert.equal(subtitle.syncSource, initialSync.syncSource, "failed preflight restores original subtitle sync type");
  assert.deepEqual(JSON.parse(JSON.stringify(subtitle.syncAnchors)), initialSync.syncAnchors, "failed preflight restores prior subtitle timing");
  assert.equal(subtitle.syncFollowsId, initialSync.syncFollowsId, "follow relationship survives rollback");
  assert.equal(subtitle.audioSync.status, "synced");
  assert.deepEqual(painted.at(-1), ["Subtitle still here"], "old playback immediately repaints its visible cue");
  assert.equal(remembered.length, 0, "an unsuccessful manual dub selection must not be saved");
  assert.equal(resumed, 1, "an interrupted, previously playing video must be resumed after rollback");
  assert.equal(video.paused, false);
  assert.equal(overlay.hidden, true, "preflight's terminal loader must not cover restored playback");
  assert.ok(overlay.classList.removed.includes("is-error"));
});

test("audio rollback never resumes after the user explicitly paused during preflight", async () => {
  const video = { dataset: { mode: "transcode" }, src: "http://localhost/previous", paused: false };
  const source = { sessionId: "source", fileIndex: 0 };
  const state = { currentSource: source, selectedAudioTrack: 0, currentMediaProbe: {
    audioTracks: [{ language: "jpn" }, { language: "eng" }],
  }, transcodeContext: { baseUrl: "previous", copyVideo: true } };
  let resumes = 0;
  const ctx = vm.createContext({ state, video, preferredAudioLanguage: "jpn",
    absolutePlaybackSeconds: () => 22, playerIsPlaying: () => true,
    currentSourceTracks: () => [], resetAudioSync() {},
    setPlayerLoading() {}, audioTrackLabel: () => ({ title: "English" }),
    $: () => ({ hidden: false, classList: { remove() {} } }),
    stopPlayerLoadingAnimation() {}, resumePlayback() { resumes++; },
    renderSubtitles() {}, updatePlayerSyncStatus() {}, renderPlayerAudioMenu() {}, scheduleAudioSync() {},
    subtitleRenderMemo: { key: "" },
    openTranscodeAt: async (_target, options) => {
      video.paused = true;
      options.onPreflightFailure({ wasPlaying: false });
      return false;
    },
  });
  vm.runInContext(sourceBetween("let audioTrackSwitchGeneration = 0;", "\nfunction updateChapterButtons("), ctx);
  await vm.runInContext("switchAudioTrack(1)", ctx);
  assert.equal(state.selectedAudioTrack, 0);
  assert.equal(resumes, 0);
  assert.equal(video.paused, true);
});

test("audio-track preflight never reports a scheduled busy retry as a completed dub switch", () => {
  const start = app.indexOf("async function openTranscodeAt(");
  const end = app.indexOf("\nfunction playerIsPlaying()", start);
  assert.ok(start > 0 && end > start);
  assert.match(app.slice(start, end), /const retryTransient[\s\S]*?if \(onPreflightFailure\) return false;/,
    "audio switches should retain their old playable stream instead of committing an unresolved retry");
});

test("only a successfully started explicit audio selection is saved for the current series", async () => {
  const source = { sessionId: "session-a", fileIndex: 7, seriesKey: "apothecary-diaries" };
  const state = { currentSource: source, selectedAudioTrack: 0,
    currentMediaProbe: { audioTracks: [
      { language: "jpn", title: "Original" }, { language: "eng", title: "Dub" },
    ] }, transcodeContext: null };
  const video = { dataset: { mode: "torrent-direct" }, src: "/api/video" };
  const saved = [];
  const ctx = vm.createContext({
    state, video, preferredAudioLanguage: "", playerIsPlaying: () => true,
    absolutePlaybackSeconds: () => 12, setPlayerLoading() {},
    audioTrackLabel: () => ({ title: "Dub" }), resetAudioSync() {},
    renderPlayerAudioMenu() {}, scheduleAudioSync() {},
    currentSourceTracks: () => [], subtitleRenderMemo: { key: "" },
    rememberSeriesAudioTrack: (track, index, selectedSource) => saved.push({ track, index, selectedSource }),
    openTranscodeAt: async () => true,
  });
  vm.runInContext(sourceBetween("let audioTrackSwitchGeneration = 0;", "\nfunction updateChapterButtons("), ctx);
  await vm.runInContext("switchAudioTrack(1, { remember: true })", ctx);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].index, 1);
  assert.equal(saved[0].selectedSource, source, "manual choice is tied to the series being watched");
  await vm.runInContext("switchAudioTrack(0, { force: true })", ctx);
  assert.equal(saved.length, 1, "automatic playback refinement must never replace a user preference");
  assert.match(app, /switchAudioTrack\(index, \{ remember: true \}\)/,
    "the actual audio menu marks user selections as persistent");
});

test("changing audio output during a pending playing seek must retain play intent", () => {
  const oldPosition = 192;
  const attempts = [];
  let changeOutput;
  const menu = {
    innerHTML: "", hidden: false,
    querySelector(selector) {
      if (selector === "#player-audio-output-mode") return {
        addEventListener(type, handler) { if (type === "change") changeOutput = handler; },
      };
      return null;
    },
    querySelectorAll: () => [],
  };
  const state = {
    currentSource: { sessionId: "s", fileIndex: 1 },
    currentMediaProbe: { audioTracks: [{ language: "eng", codec: "aac", channels: 6 }] },
    selectedAudioTrack: 0,
    transcodeContext: { audioIndex: 0, baseUrl: "/api/transcode" },
    pendingSeek: { target: oldPosition, wasPlaying: true, priming: true },
  };
  const ctx = vm.createContext({
    state, video: { dataset: { mode: "transcode" }, paused: true, volume: 0.6 },
    audioOutputMode: "auto", localStorage: { setItem() {} },
    normalizeAudioMode: (value) => value, audioTrackLabel: () => ({ title: "English", meta: "5.1" }),
    renderAudioPlaybackDetails: () => "", escapeHtml: (value) => value,
    $: (selector) => selector === "#player-audio-menu" ? menu : { setAttribute() {} },
    absolutePlaybackSeconds: () => oldPosition,
    playerIsPlaying: () => Boolean(state.pendingSeek?.wasPlaying),
    restartTranscodeAt: (time, options) => { attempts.push({ time, ...options }); },
  });
  vm.runInContext(sourceBetween("function renderPlayerAudioMenu()", "\nasync function switchAudioTrack("), ctx);
  vm.runInContext("renderPlayerAudioMenu()", ctx);
  assert.ok(changeOutput, "real audio output select registers a change listener");
  changeOutput({ target: { value: "stereo" } });
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].time, oldPosition, "movie time is preserved");
  assert.equal(attempts[0].wasPlaying, true,
    "pendingSeek.wasPlaying=true takes priority over the internally paused media element");
});

test("an ended event from the old transcode during a debounced seek must not advance the episode", () => {
  const playerTimeupdate = app.indexOf('video.addEventListener("timeupdate", () => {');
  const from = app.indexOf('video.addEventListener("ended", () => {', playerTimeupdate);
  const to = app.indexOf('video.addEventListener("seeking",', from);
  assert.ok(from >= 0 && to > from, "real media ended handler found");
  const events = new Map();
  let advanced = 0;
  const state = {
    // Seek already requested near end; the current media element still
    // represents the old fragment during the 280 ms debounce.
    pendingSeek: { target: 149, wasPlaying: true, timer: 1 },
    mediaDurationMs: 150_000,
  };
  const video = { addEventListener(name, callback) { events.set(name, callback); },
    paused: true, dataset: { mode: "transcode" } };
  const ctx = vm.createContext({
    state, video, cancelTranscodeStart() {}, setPlayerLoading() {},
    isNewSourceFramePending: () => false,
    stopRecoveryWatch() {}, recordWatchProgress() {},
    startAutoNext() { advanced++; },
    absolutePlaybackSeconds: () => state.pendingSeek?.target ?? 0,
    recoverPlayback: async () => {},
  });
  vm.runInContext(app.slice(from, to), ctx);
  events.get("ended")();
  assert.equal(advanced, 0,
    "an outgoing fragment cannot auto-advance while the user is seeking within the current episode");
  assert.equal(state.pendingSeek.target, 149, "the queued seek remains intact");
});

test("a failed switch from direct torrent playback restores its direct clock and audio", async () => {
  const src = "http://localhost/api/torrents/s/files/0/stream";
  const video = { dataset: { mode: "torrent-direct" }, src, currentTime: 42, paused: false };
  const state = {
    currentSource: { sessionId: "s", fileIndex: 0 },
    currentMediaProbe: { audioTracks: [{ language: "jpn" }, { language: "eng" }] },
    selectedAudioTrack: 0, transcodeContext: null, transcodeBaseOffsetSeconds: 0,
  };
  const ctx = vm.createContext({
    state, video, preferredAudioLanguage: "jpn",
    playerIsPlaying: () => true, absolutePlaybackSeconds: () => 42,
    setPlayerLoading() {}, audioTrackLabel: () => ({ title: "English" }),
    $: () => null, stopPlayerLoadingAnimation() {},
    resetAudioSync() {}, renderPlayerAudioMenu() {}, scheduleAudioSync() {},
    currentSourceTracks: () => [], subtitleRenderMemo: { key: "" },
    renderSubtitles() {}, updatePlayerSyncStatus() {},
    openTranscodeAt: async () => false,
  });
  vm.runInContext(sourceBetween("let audioTrackSwitchGeneration = 0;", "\nfunction updateChapterButtons("), ctx);
  await vm.runInContext("switchAudioTrack(1)", ctx);
  assert.equal(video.src, src, "failed conversion did not replace direct video");
  assert.equal(video.dataset.mode, "torrent-direct",
    "currentTime remains movie-relative rather than being interpreted as a transcode fragment");
  assert.equal(state.transcodeContext, null, "the next seek must retain direct-stream behavior");
  assert.equal(state.selectedAudioTrack, 0, "the audible dub never changed");
});

test("a stale audio-switch failure must not rollback a newer successful dub", async () => {
  const video = { dataset: { mode: "transcode" }, src: "/transcode?audio=0", paused: false };
  const state = {
    currentSource: { sessionId: "session1", fileIndex: 0 },
    currentMediaProbe: { audioTracks: [
      { language: "jpn" }, { language: "eng" }, { language: "spa" },
    ] },
    selectedAudioTrack: 0,
    transcodeContext: { baseUrl: "/transcode", audioIndex: 0, sessionId: "session1", fileIndex: 0 },
  };
  const waits = [];
  const ctx = vm.createContext({
    state, video, preferredAudioLanguage: "jpn",
    playerIsPlaying: () => true, absolutePlaybackSeconds: () => 42,
    setPlayerLoading() {}, audioTrackLabel: (_, i) => ({ title: String(i) }),
    resetAudioSync() {}, renderPlayerAudioMenu() {}, scheduleAudioSync() {},
    currentSourceTracks: () => [], subtitleRenderMemo: { key: "" },
    renderSubtitles() {}, updatePlayerSyncStatus() {},
    openTranscodeAt: () => new Promise((resolve) => waits.push(resolve)),
  });
  vm.runInContext(sourceBetween("let audioTrackSwitchGeneration = 0;", "\nfunction updateChapterButtons("), ctx);
  const first = vm.runInContext("switchAudioTrack(1)", ctx);
  const second = vm.runInContext("switchAudioTrack(2)", ctx);
  assert.equal(waits.length, 2);
  video.src = "/transcode?audio=2";
  waits[1](true);
  await second;
  waits[0](false);
  await first;
  assert.equal(state.selectedAudioTrack, 2,
    "an older failed request cannot overwrite the newer selected dub");
  assert.equal(state.transcodeContext.audioIndex, 2,
    "a stale error must not poison subsequent seeks or audio synchronization");
});

test("watch resume position must not freeze at stale presented frame while background audio advances", () => {
  // Chromium may throttle requestVideoFrameCallback while a background video
  // continues playing audio. Keep the actual media position for Continue
  // Watching while allowing captions to follow the last presented frame.
  const episode = { code: "S01E01", fileIndex: 0 };
  const entry = { seriesKey: "show" };
  const state = { currentMs: 5_000, pendingSeek: null, mediaDurationMs: 120_000, library: [] };
  const handlers = new Map();
  const video = { currentTime: 63, paused: false, dataset: { mode: "torrent-direct" },
    addEventListener(name, listener) { handlers.set(name, listener); } };
  const start = app.indexOf("function recordWatchProgress(");
  const end = app.indexOf("\nfunction trackSyncKey(", start);
  const clockStart = app.indexOf('video.addEventListener("timeupdate", () => {');
  const clockEnd = app.indexOf('video.addEventListener("ended", () => {', clockStart);
  assert.ok(start >= 0 && end > start && clockStart >= 0 && clockEnd > clockStart);
  const ctx = vm.createContext({
    state, video, learningEnabled: false, Date: { now: () => 100_000 },
    isNewSourceFramePending: () => false,
    watchProgressSavedAt: 0,
    explicitUnwatchCompletionArmed: new Set(),
    currentLibraryEpisode: () => ({ entry, episode }),
    frame: { classList: { contains: () => true } },
    explicitlyUnwatchedChapter: () => false, buildLibrarySeries: () => [],
    saveLibrary() {}, $: () => null,
    absolutePlaybackSeconds: () => 63,
    presentedSubtitleSeconds: () => 5,
    refreshEpisodeSkipOptions() {}, markPlaybackMotion() {},
    prefetchUpcomingChapter() {}, loadMoreEmbeddedSubtitles() {}, renderSubtitles() {},
    updateCompatControls() {}, checkAudioSyncCoverage() {},
  });
  vm.runInContext(app.slice(start, end), ctx);
  vm.runInContext(app.slice(clockStart, clockEnd), ctx);
  handlers.get("timeupdate")();
  assert.equal(state.currentMs, 5_000,
    "ordinary playback keeps the last presented frame while its decoder stalls");
  assert.equal(episode.progress?.positionMs, 63_000,
    "background playback progress must use the actual media position, not a stale subtitle frame");
});

test("old video ended during copied-seek preflight must not cancel the new seek", () => {
  const timeupdate = app.indexOf('video.addEventListener("timeupdate", () => {');
  const from = app.indexOf('video.addEventListener("ended", () => {', timeupdate);
  const to = app.indexOf('video.addEventListener("seeking",', from);
  const handlers = new Map();
  const state = { pendingSeek: { target: 120, wasPlaying: true, priming: true,
    streamInstalled: false }, mediaDurationMs: 180_000 };
  let cancelled = 0;
  const loading = [];
  const video = { dataset: {}, src: "/old-fragment?start=30", paused: true,
    addEventListener(name, handler) { handlers.set(name, handler); },
    pause() { this.paused = true; },
  };
  vm.runInNewContext(app.slice(from, to), {
    state, video, cancelTranscodeStart() { cancelled++; },
    isNewSourceFramePending: () => false,
    setPlayerLoading(...args) { loading.push(args); },
    recoverPlayback() {}, stopRecoveryWatch() {},
    absolutePlaybackSeconds: () => 120, recordWatchProgress() {}, startAutoNext() {},
  });
  handlers.get("ended")();
  assert.equal(cancelled, 0,
    "outgoing stream's late end before the new video URL is installed cannot abort keyframe preflight");
  assert.ok(state.pendingSeek?.priming, "new seek remains in progress");
  assert.equal(loading.some((item) => item[0] === 100), false,
    "do not show a terminal new-stream failure for the old stream");
});

test("old video media error during copied-seek preflight must not consume bounded retry attempts", () => {
  const from = app.indexOf('video.addEventListener("error", () => {',
    app.indexOf('video.addEventListener("timeupdate", () => {'));
  const to = app.indexOf('$("#compat-play").addEventListener', from);
  const handlers = new Map();
  const state = { pendingSeek: { target: 120, wasPlaying: true, priming: true,
    streamInstalled: false } };
  const video = { src: "/old-fragment?start=30",
    error: new Error("old fragment cancelled"),
    paused: true, addEventListener(name, handler) { handlers.set(name, handler); },
    pause() {},
  };
  let retries = 0;
  let cancelled = 0;
  vm.runInNewContext(app.slice(from, to), {
    state, video, isNewSourceFramePending: () => false, transcodeStartAttempt: {
      retryTransient() { retries++; return true; },
    },
    cancelTranscodeStart() { cancelled++; },
    setPlayerLoading() {}, recoverPlayback() {},
  });
  handlers.get("error")();
  assert.equal(retries, 0,
    "old media errors must not consume retry budget for a replacement that has not been loaded");
  assert.equal(cancelled, 0);
  assert.ok(state.pendingSeek?.priming);
});
