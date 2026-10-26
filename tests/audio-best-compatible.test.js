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
  assert.match(app, /function preferredAudioTrackIndex\(media\)/);
  assert.match(app, /preferredAudioLanguage = String\(tracks\[index\]\.language/);
  assert.match(app, /if \(!pending\.wasPlaying\) \{\s*complete\(\);/);
  assert.match(app, /await video\.play\(\);/, "a resumed copied stream must confirm Play before declaring ready");
  assert.match(app, /if \(retryTransient\(error\)\) return true;/,
    "a transient new-stream error must take the bounded retry path, not silently swallow Play rejection");
  const start = app.indexOf("function preferredAudioTrackIndex(");
  const end = app.indexOf("\nfunction transcodeQuery(", start);
  const context = vm.createContext({ preferredAudioLanguage: "jpn" });
  vm.runInContext(app.slice(start, end), context);
  assert.equal(vm.runInContext('preferredAudioTrackIndex({audioTracks:[{language:"eng"},{language:"jpn"}]})', context), 1);
  assert.equal(vm.runInContext('preferredAudioTrackIndex({audioTracks:[{language:"eng"}]})', context), 0,
    "unavailable preferred language must fall back rather than select the wrong index");
});
