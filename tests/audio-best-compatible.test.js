import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { planCompatibleAudio } from "../shared/media/audio-policy.js";
import { createTranscodePlan } from "../shared/media/media-compat.js";
import { selectBrowserPlayback } from "../frontend/player/browser-media.js";

const app = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");

test("Auto preserves safe AAC/MP3 remux audio, but not incompatible or seeked audio", () => {
  for (const codec of ["aac", "mp3"]) {
    const original = planCompatibleAudio({ codec, channels: 2 }, { audioMode: "auto" });
    assert.equal(original.codec, "copy");
    assert.equal(original.outputCodec, codec);
    assert.equal(original.bitRate, null);
    const seeked = planCompatibleAudio({ codec, channels: 2 }, { startSeconds: 15.34 });
    assert.equal(seeked.codec, "aac");
    assert.equal(seeked.reason, "seek-timestamp-safety");
  }
  for (const codec of ["opus", "flac", "ac3", "eac3", "dts", "truehd"]) {
    const fallback = planCompatibleAudio({ codec, channels: 6 });
    assert.equal(fallback.codec, "aac", `${codec} is not MP4 stream-copied`);
    assert.equal(fallback.channels, 6);
    assert.equal(fallback.bitRate, "384k");
  }
});

test("Auto and explicit stereo/5.1 bound channel counts and keep FFmpeg startup valid without metadata", () => {
  for (const channels of [1, 2, 6, 8]) {
    const track = { codec: "truehd", channels };
    const auto = planCompatibleAudio(track);
    assert.equal(auto.channels, Math.min(channels, 6));
    assert.equal(planCompatibleAudio(track, { audioMode: "surround" }).channels, Math.min(channels, 6));
    assert.equal(planCompatibleAudio(track, { audioMode: "stereo" }).channels, Math.min(channels, 2));
  }
  const unknown = createTranscodePlan(null, { audioMode: "auto" });
  assert.equal(unknown.audio.channels, 2, "uncached FFprobe startup cannot produce FFmpeg -ac 0");
  assert.equal(unknown.audio.bitRate, "160k");
  const source = { video: { codec: "h264", pixelFormat: "yuv420p" },
    audioTracks: [{ codec: "aac", channels: 8, channelLayout: "7.1" }] };
  assert.equal(createTranscodePlan(source, { audioMode: "auto" }).audio.channels, 6);
  assert.equal(createTranscodePlan(source, { audioMode: "auto" }).audio.codec, "aac");
  assert.equal(createTranscodePlan(source, { audioMode: "stereo" }).audio.channels, 2);
});

test("Browser direct selection accounts for requested audio channel output and track index", () => {
  const input = { file: { name: "episode.mp4" }, media: {
    video: { codec: "h264", pixelFormat: "yuv420p" },
    audioTracks: [{ codec: "aac", channels: 6 }, { codec: "mp3", channels: 2, language: "jpn" }],
  }, canPlayType: () => "probably" };
  assert.equal(selectBrowserPlayback(input).mode, "direct");
  assert.equal(selectBrowserPlayback({ ...input, audioMode: "stereo" }).mode, "remux");
  assert.equal(selectBrowserPlayback({ ...input, audioTrackOrder: 1 }).mode, "remux");
  assert.equal(selectBrowserPlayback({ ...input, media: { ...input.media,
    audioTracks: [{ codec: "truehd", channels: 8 }] } }).mode, "remux");
  const webm = { file: { name: "episode.webm" }, media: { video: { codec: "vp9" }, audioTracks: [{ codec: "opus", channels: 2 }] }, canPlayType: () => "probably" };
  assert.equal(selectBrowserPlayback(webm).mode, "direct", "native WebM Opus must not be needlessly re-encoded");
  assert.equal(selectBrowserPlayback({ ...webm, audioTrackOrder: 1 }).mode, "transcode", "a second track cannot be selected by HTMLMediaElement alone");
});

test("Existing audio-track icon houses expandable truthful playback information, no extra button", () => {
  const begin = app.indexOf("function renderAudioPlaybackDetails()");
  const end = app.indexOf("\nfunction renderPlayerAudioMenu()", begin);
  assert.ok(begin > 0 && end > begin);
  const details = app.slice(begin, end);
  const context = vm.createContext({
    state: { currentMediaProbe: {
      format: "matroska", video: { width: 3840, height: 2160, colorTransfer: "smpte2084" },
      audioTracks: [{ codec: "truehd", channels: 8, bitRate: null, language: "jpn" }],
    }, selectedAudioTrack: 0, transcodeBaseOffsetSeconds: 48,
      transcodeContext: { copyVideo: true } },
    video: { dataset: { mode: "transcode" } },
    audioOutputMode: "auto", planCompatibleAudio,
    escapeHtml: (value) => String(value).replaceAll("<", "&lt;"),
  });
  vm.runInContext(details, context);
  let text = vm.runInContext("renderAudioPlaybackDetails()", context);
  assert.match(text, /TRUEHD.*8 channels.*Unknown/s);
  assert.match(text, /AAC.*6 channels.*384 kbps target/s);
  assert.doesNotMatch(text, /Converted to compatible lossy AAC|not a measurement of speakers|Re-encoded for safe timing/);
  context.video.dataset.mode = "torrent-direct";
  text = vm.runInContext("renderAudioPlaybackDetails()", context);
  assert.match(text, /Original encoded stream/);
  assert.doesNotMatch(text, /Converted to compatible lossy AAC/);
  assert.match(app, /<details class="player-audio-info"/);
  assert.match(app, /<summary>Playback information<\/summary>/);
  assert.match(app, /id="player-audio-output-mode"/);
  assert.doesNotMatch(app, /id="player-playback-info-button"/);
});

test("FFmpeg seek-sync flags, chosen track mapping and output metadata remain explicit", () => {
  assert.match(server, /startSeconds > 0 && plan\.video\.mode === "copy" \? \["-noaccurate_seek"\]/);
  assert.match(server, /"-map", `0:a:\$\{audioTrackOrder\}\?`/);
  assert.match(server, /"-c:a", plan\.audio\.codec/);
  assert.match(server, /"X-Media-Audio-Output-Codec": plan\.audio\.outputCodec/);
  assert.match(app, /function preferredAudioTrackIndex\(media, source = state\.currentSource\)/);
  assert.match(app, /preferredAudioLanguage = String\(tracks\[index\]\.language/);
  assert.match(app, /if \(!pending\.wasPlaying\) \{\s*complete\(\);/);
  assert.match(app, /await video\.play\(\);/, "a resumed copied stream must confirm Play before declaring ready");
  assert.match(app, /if \(retryTransient\(error\)\) return true;/,
    "a transient new-stream error must take the bounded retry path, not silently swallow Play rejection");
  const start = app.indexOf("function audioTrackIdentity(");
  const end = app.indexOf("\nfunction transcodeQuery(", start);
  const context = vm.createContext({ preferredAudioLanguage: "jpn", state: { currentSource: null },
    sourceAudioPreferenceKey: () => "", seriesAudioPreferences: new Map() });
  vm.runInContext(app.slice(start, end), context);
  assert.equal(vm.runInContext('preferredAudioTrackIndex({audioTracks:[{language:"eng"},{language:"jpn"}]})', context), 1);
  assert.equal(vm.runInContext('preferredAudioTrackIndex({audioTracks:[{language:"eng"}]})', context), 0,
    "unavailable preferred language must fall back rather than select the wrong index");
});

test("selected dub persists across reload and next chapter, even when audio stream order changes", () => {
  const start = app.indexOf('const SERIES_AUDIO_PREFERENCES_KEY =');
  const end = app.indexOf("\nfunction transcodeQuery(", start);
  assert.ok(start >= 0 && end > start, "real per-series audio preference helpers are present");
  const disk = new Map();
  const storage = { getItem: (key) => disk.get(key) || null,
    setItem: (key, value) => disk.set(key, String(value)) };
  function session(seriesKey) {
    const state = { currentSource: { seriesKey, fileIndex: 0 }, currentMediaProbe: null };
    const ctx = vm.createContext({ state, localStorage: storage, preferredAudioLanguage: "", console });
    vm.runInContext(app.slice(start, end), ctx);
    return { state, ctx, select: (tracks) => {
      state.currentMediaProbe = { audioTracks: tracks };
      return vm.runInContext("preferredAudioTrackIndex(state.currentMediaProbe)", ctx);
    }, remember: (index) => vm.runInContext(`rememberSeriesAudioTrack(state.currentMediaProbe.audioTracks[${index}], ${index})`, ctx) };
  }
  const originalFirst = [{ language: "jpn", title: "Japanese Original" },
    { language: "eng", title: "English Dub" }];
  const englishFirst = [{ language: "en", title: "English Dub" },
    { language: "ja", title: "Japanese Original" }];
  const first = session("apothecary-diaries");
  assert.equal(first.select(originalFirst), 0);
  first.remember(1);
  assert.equal(first.select(originalFirst), 1, "same episode honors the explicit dub choice");
  const afterReload = session("apothecary-diaries");
  assert.equal(afterReload.select(originalFirst), 1, "a new browser page restores the saved dub");
  afterReload.state.currentSource.fileIndex = 1;
  assert.equal(afterReload.select(englishFirst), 0, "next chapter matches English dub by language/title, not old index");
  assert.equal(afterReload.select([{ language: "ja", title: "Japanese Original" }]), 0,
    "a missing preferred language safely falls back to the episode's available audio");
  assert.equal(session("different-series").select(originalFirst), 0,
    "the dub preference is for this series, not every unrelated show");
  afterReload.select(englishFirst);
  afterReload.remember(1);
  assert.equal(session("apothecary-diaries").select(originalFirst), 0,
    "changing back to Original is also remembered on future visits");
});

test("audio preferences distinguish two same-language tracks and safely fall back when metadata is unknown", () => {
  const start = app.indexOf('const SERIES_AUDIO_PREFERENCES_KEY =');
  const end = app.indexOf("\nfunction transcodeQuery(", start);
  const disk = new Map();
  const state = { currentSource: { seriesKey: "two-english-tracks" }, currentMediaProbe: { audioTracks: [
    { language: "eng", title: "Original English" }, { language: "eng", title: "English Commentary" },
  ] } };
  const ctx = vm.createContext({ state, localStorage: {
    getItem: (key) => disk.get(key) || null, setItem: (key, value) => disk.set(key, String(value)),
  }, preferredAudioLanguage: "", console });
  vm.runInContext(app.slice(start, end), ctx);
  vm.runInContext("rememberSeriesAudioTrack(state.currentMediaProbe.audioTracks[1], 1)", ctx);
  state.currentMediaProbe.audioTracks.reverse();
  assert.equal(vm.runInContext("preferredAudioTrackIndex(state.currentMediaProbe)", ctx), 0,
    "exact title wins over a reused audio index for two streams with the same language");
  state.currentMediaProbe.audioTracks = [{ language: "jpn" }, { language: "eng" }];
  assert.equal(vm.runInContext("preferredAudioTrackIndex(state.currentMediaProbe)", ctx), 1,
    "language alone is preferred when title metadata isn't available");
});

test("a remembered English dub cannot silently become English commentary after an episode switch", () => {
  const start = app.indexOf('const SERIES_AUDIO_PREFERENCES_KEY =');
  const end = app.indexOf("\nfunction transcodeQuery(", start);
  const disk = new Map();
  const state = { currentSource: { seriesKey: 'changing-language-tracks' },
    currentMediaProbe: { audioTracks: [
      { language: 'jpn', title: 'Japanese Original' },
      { language: 'eng', title: 'English Dub' },
    ] } };
  const ctx = vm.createContext({ state, localStorage: {
    getItem: key => disk.get(key) || null,
    setItem: (key, value) => disk.set(key, String(value)),
  }, preferredAudioLanguage: '', console });
  vm.runInContext(app.slice(start, end), ctx);
  vm.runInContext('rememberSeriesAudioTrack(state.currentMediaProbe.audioTracks[1],1)', ctx);
  state.currentMediaProbe.audioTracks[1] = { language: 'eng', title: 'English Commentary' };
  assert.equal(vm.runInContext('preferredAudioTrackIndex(state.currentMediaProbe)', ctx), 0,
    'a changed/removed dub must not automatically turn on director commentary at its old index');
});

test("the actual audio menu persists an explicit click on the already-playing Original track", () => {
  const start = app.indexOf("function renderPlayerAudioMenu() {");
  const end = app.indexOf("\nlet audioTrackSwitchGeneration = 0;", start);
  assert.ok(start >= 0 && end > start);
  const handlers = new Map();
  const menu = { hidden: false, innerHTML: "",
    querySelector() { return null; },
    querySelectorAll(selector) {
      assert.equal(selector, "[data-audio-index]");
      return [0, 1].map((index) => ({ dataset: { audioIndex: String(index) },
        addEventListener(type, listener) { handlers.set(index, listener); } }));
    },
  };
  const tracks = [{ language: "jpn", title: "Original" }, { language: "eng", title: "Dub" }];
  const state = { selectedAudioTrack: 0, currentMediaProbe: { audioTracks: tracks } };
  const remembered = [], switched = [];
  const ctx = vm.createContext({ state, audioOutputMode: "auto", audioTrackLabel: (track) => ({ title: track.title, meta: track.language }),
    renderAudioPlaybackDetails: () => "", escapeHtml: String,
    $: (selector) => selector === "#player-audio-menu" ? menu : { setAttribute() {} },
    rememberSeriesAudioTrack: (track, index) => remembered.push({ track, index }),
    switchAudioTrack: (index, options) => switched.push({ index, options }),
  });
  vm.runInContext(app.slice(start, end), ctx);
  vm.runInContext("renderPlayerAudioMenu()", ctx);
  handlers.get(0)();
  assert.equal(menu.hidden, true);
  assert.deepEqual(remembered, [{ track: tracks[0], index: 0 }],
    "clicking already-playing Original records intent, even without switching streams");
  assert.equal(switched.length, 0, "do not restart the existing audio stream");
  menu.hidden = false;
  handlers.get(1)();
  assert.equal(switched[0].index, 1);
  assert.equal(switched[0].options.remember, true, "a new dub is committed only after a successful switch");
});
