// Alpha release QA: synthetic, deterministic media only; no server, torrent,
// installed app, browser, user media or historical test modifications.
// FFmpeg commands match the server copy-video/audio-output and ASS window paths.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import { parseSubtitle } from "../learning/browser/core.js";

const FFMPEG_TIMEOUT = 32_000;
const MAX_BUFFER = 4 * 1024 * 1024;

function run(binary, args, { binaryOut = false, timeout = FFMPEG_TIMEOUT } = {}) {
  const result = spawnSync(binary, args, {
    encoding: binaryOut ? null : "utf8", windowsHide: true,
    timeout, maxBuffer: MAX_BUFFER,
  });
  const stderr = binaryOut ? result.stderr?.toString("utf8") : result.stderr;
  assert.equal(result.status, 0,
    (result.error?.message || stderr || "Unexpected FFmpeg/FFprobe exit") +
    "\narguments: " + args.join(" "));
  return result.stdout;
}
const ff = (args, options) => run(ffmpegStatic, ["-hide_banner", "-loglevel", "error", "-nostdin", ...args], options);
const fp = (args) => JSON.parse(run(ffprobeStatic.path, ["-v", "error", ...args]));

function inScratch(fn) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "lvl-qa-av-switch-"));
  try { return fn(temp); }
  finally {
    assert.equal(path.dirname(temp), os.tmpdir(), "Only private system temporary files may be removed");
    assert.ok(path.basename(temp).startsWith("lvl-qa-av-switch-"));
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

function streams(file) {
  return fp(["-show_streams", "-show_entries",
    "stream=index,codec_type,codec_name,channels,channel_layout,pix_fmt,color_primaries,color_transfer,color_space",
    "-of", "json", file]).streams || [];
}

function packets(file, kind = "a:0") {
  return (fp(["-select_streams", kind, "-show_packets",
    "-show_entries", "packet=pts_time,duration_time,flags",
    "-of", "json", file]).packets || [])
    .map((p) => ({ pts: Number(p.pts_time), duration: Number(p.duration_time), flags: String(p.flags || "") }))
    .filter((p) => Number.isFinite(p.pts));
}

function assertPacketClock(file, label) {
  const ps = packets(file, "a:0");
  assert.ok(ps.length >= 35, label + " should have many audio packets");
  const gaps = ps.slice(1).map((p, i) => p.pts - ps[i].pts);
  assert.ok(gaps.every((gap) => gap > 0), label + ": AAC PTS must increase strictly");
  const maxGap = Math.max(...gaps);
  assert.ok(maxGap < 0.12, label + ": audible timestamp hole = " + maxGap);
  assert.ok(ps[0].pts >= -0.15 && ps[0].pts < 0.3,
    label + ": first audio PTS must start near fragment 0: " + ps[0].pts);
  return { start: ps[0].pts, maxGap, packets: ps.length };
}

function pcmAt(file, seek = 0.4, duration = 0.55) {
  const data = ff(["-ss", String(seek), "-i", file, "-map", "0:a:0",
    "-ac", "1", "-ar", "8000", "-t", String(duration), "-f", "s16le", "pipe:1"],
  { binaryOut: true });
  assert.ok(data.length >= 2000, "PCM sample must be present");
  // Keep normalized fractional PCM values: Int16Array.from would truncate
  // every sample in [-1,1] to zero and falsely report silent/wrong tracks.
  return Float64Array.from({ length: Math.floor(data.length / 2) }, (_, i) => data.readInt16LE(i * 2) / 32768);
}

function toneStrength(data, hertz) {
  // Absolute DFT magnitude at the known fixture frequency, divided by N.
  // Unlike RMS, this proves which source track the selected mapping decoded.
  const size = data.length;
  let real = 0, imag = 0;
  for (let i = 0; i < size; i += 1) {
    const angle = 2 * Math.PI * hertz * i / 8000;
    real += data[i] * Math.cos(angle);
    imag -= data[i] * Math.sin(angle);
  }
  return Math.hypot(real, imag) / size;
}

function hashFrame(file, seek = null) {
  const data = ff([...(seek == null ? [] : ["-ss", String(seek)]),
    "-i", file, "-map", "0:v:0", "-frames:v", "1",
    "-pix_fmt", "yuv420p", "-f", "framemd5", "-"]);
  const first = data.split(/\r?\n/).find((line) => /^0,/.test(line));
  assert.ok(first, "first frame hash absent: " + file);
  return first.split(",").at(-1).trim();
}

function firstVideoPts(file) {
  const frames = fp(["-select_streams", "v:0", "-show_frames",
    "-show_entries", "frame=best_effort_timestamp_time", "-of", "json", file]).frames || [];
  assert.ok(frames.length > 0, "No video frames");
  const pts = Number(frames[0].best_effort_timestamp_time);
  assert.ok(Number.isFinite(pts));
  return pts;
}

function makeDualAudioSource(dir) {
  const source = path.join(dir, "two-dubs.mkv");
  // The second source is genuinely 5.1(side), not merely tagged as 5.1.
  ff(["-y",
    "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=25",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-f", "lavfi", "-i", "sine=frequency=1320:sample_rate=48000",
    "-filter_complex",
      "[2:a]pan=5.1(side)|FL=c0|FR=c0|FC=c0|LFE=c0|SL=c0|SR=c0[surround]",
    "-map", "0:v:0", "-map", "1:a:0", "-map", "[surround]",
    "-t", "14", "-c:v", "libx264", "-threads", "2", "-preset", "ultrafast",
    "-g", "100", "-keyint_min", "100", "-sc_threshold", "0", "-bf", "2",
    "-c:a:0", "aac", "-b:a:0", "160k", "-ac:a:0", "2",
    "-c:a:1", "ac3", "-b:a:1", "384k",
    source], { timeout: 40_000 });
  const audio = streams(source).filter((stream) => stream.codec_type === "audio");
  assert.deepEqual(audio.map((s) => [s.codec_name, s.channels]), [["aac", 2], ["ac3", 6]]);
  return source;
}

function transcodeAt(source, destination, seek, track, outputChannels, duration = 3) {
  ff(["-noaccurate_seek", "-ss", String(seek), "-i", source,
    "-map", "0:v:0", "-map", "0:a:" + track, "-c:v", "copy",
    "-c:a", "aac", "-b:a", outputChannels > 2 ? "384k" : "160k",
    "-ac", String(outputChannels), "-af", "aresample=async=1",
    "-t", String(duration), "-avoid_negative_ts", "make_zero",
    "-movflags", "frag_keyframe+empty_moov+default_base_moof",
    "-f", "mp4", "-y", destination]);
}

test("actual AAC stereo / AC3 5.1 audio switching preserves selected dub, channel layout, and packet PTS", {
  timeout: 70_000,
}, () => inScratch((dir) => {
  const source = makeDualAudioSource(dir);
  const sequence = [
    { audio: 0, channels: 2, seek: 5.37, tone: 440 },
    { audio: 1, channels: 6, seek: 5.37, tone: 1320 },
    { audio: 1, channels: 2, seek: 5.37, tone: 1320 },
    { audio: 0, channels: 2, seek: 8.17, tone: 440 },
    { audio: 1, channels: 6, seek: 8.17, tone: 1320 },
  ];
  const frameAt = new Map();
  for (const [index, mode] of sequence.entries()) {
    const output = path.join(dir, "switch-" + index + ".mp4");
    transcodeAt(source, output, mode.seek, mode.audio, mode.channels);
    const label = "audio=" + mode.audio + ",channels=" + mode.channels + ",seek=" + mode.seek;
    const track = streams(output).find((s) => s.codec_type === "audio");
    assert.equal(track?.codec_name, "aac", label);
    assert.equal(track?.channels, mode.channels, label);
    assert.match(String(track?.channel_layout), mode.channels === 6 ? /5\.1/ : /stereo/, label);
    assertPacketClock(output, label);
    const samples = pcmAt(output);
    const wanted = toneStrength(samples, mode.tone);
    const unexpected = toneStrength(samples, mode.tone === 440 ? 1320 : 440);
    assert.ok(wanted > 0.003 && wanted > unexpected * 8,
      label + ": wrong dub audible (wanted=" + wanted + ",other=" + unexpected + ")");
    const currentFrame = hashFrame(output);
    if (frameAt.has(mode.seek)) assert.equal(currentFrame, frameAt.get(mode.seek),
      "audio switch cannot shift copied video first frame");
    frameAt.set(mode.seek, currentFrame);
    assert.ok(Math.abs(firstVideoPts(output)) < 0.2, label + ": output video PTS not zero-based");
  }
}));

test("reopening a seeked transcode after a simulated five-minute pause keeps audio identity and clocks", {
  timeout: 60_000,
}, () => inScratch((dir) => {
  const source = makeDualAudioSource(dir);
  let logicalNow = 500_000;
  const resumeMovieAt = 7.13;
  const outputs = [];
  for (const [index, audio] of [1, 1, 0, 1].entries()) {
    const output = path.join(dir, "resume-" + index + ".mp4");
    transcodeAt(source, output, resumeMovieAt, audio, audio === 1 ? 6 : 2, 2.5);
    const clock = assertPacketClock(output, "resume " + index);
    outputs.push({ frame: hashFrame(output), audio, pts: firstVideoPts(output), clock });
    if (index === 0) logicalNow += 5 * 60_000; // No real-time sleep or installed playback.
    assert.ok(logicalNow >= 500_000);
  }
  assert.equal(logicalNow, 800_000, "exercise exactly 5 minutes of simulated paused wall-clock time");
  assert.ok(outputs.every((item) => item.frame === outputs[0].frame),
    "reopening or switching audio at one movie timestamp must not shift first video frame");
  assert.ok(outputs.every((item) => Math.abs(item.pts - outputs[0].pts) < 0.05),
    "reopening at same timestamp must not add audio/video PTS offset per attempt");
  assert.ok(outputs.every((item) => Math.abs(item.clock.start - outputs[0].clock.start) < 0.08),
    "audio PTS start must not change after pause/reopen or switching audio tracks");
  assert.deepEqual(outputs.map((entry) => entry.audio), [1, 1, 0, 1]);
}));

test("combined HEVC Main10 HDR10 and genuinely VFR stream preserves video content and color through a seek", {
  timeout: 70_000,
}, () => inScratch((dir) => {
  const source = path.join(dir, "hdr-vfr.mkv");
  ff(["-y", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=25",
    "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000",
    "-t", "12", "-map", "0:v:0", "-map", "1:a:0",
    "-vf", "select=not(mod(n\\,2))+not(mod(n\\,7))", "-fps_mode:v", "vfr",
    "-c:v", "libx265", "-threads", "2", "-preset", "ultrafast",
    "-pix_fmt", "yuv420p10le",
    "-x265-params", "pools=1:frame-threads=1:keyint=50:min-keyint=50:scenecut=0:log-level=error",
    "-color_primaries", "bt2020", "-color_trc", "smpte2084", "-colorspace", "bt2020nc",
    "-c:a", "ac3", "-b:a", "192k", source], { timeout: 40_000 });
  const sourcePts = packets(source, "v:0").map((p) => p.pts).sort((a, b) => a - b);
  const intervals = sourcePts.slice(1).map((p, i) => p - sourcePts[i]);
  assert.ok(Math.max(...intervals) > Math.min(...intervals) * 1.8, "fixture must actually be VFR");
  const output = path.join(dir, "hdr-vfr-seek.mp4");
  ff(["-noaccurate_seek", "-ss", "5.37", "-i", source, "-map", "0:v:0", "-map", "0:a:0",
    "-c:v", "copy", "-tag:v", "hvc1", "-c:a", "aac", "-b:a", "160k", "-ac", "2",
    "-af", "aresample=async=1", "-t", "3",
    "-avoid_negative_ts", "make_zero",
    "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", "-y", output]);
  const s = streams(output).find((entry) => entry.codec_type === "video");
  assert.deepEqual([s.codec_name, s.pix_fmt, s.color_primaries, s.color_transfer, s.color_space],
    ["hevc", "yuv420p10le", "bt2020", "smpte2084", "bt2020nc"],
    "HDR remux must preserve HEVC 10-bit/PQ/BT.2020 stream metadata");
  const seek = fp(["-read_intervals", "5.37%+0.1", "-select_streams", "v:0",
    "-show_packets", "-show_entries", "packet=pts_time,flags", "-of", "json", source]);
  const nearest = seek.packets?.[0];
  assert.ok(nearest?.flags?.startsWith("K"), "FFprobe must identify a preceding keyframe");
  assert.equal(hashFrame(output), hashFrame(source, Number(nearest.pts_time)),
    "HDR remux first decoded frame must be exactly the source seek keyframe");
  assertPacketClock(output, "HDR+VFR");
  const outputPts = packets(output, "v:0").map((p) => p.pts).sort((a, b) => a - b);
  const outputIntervals = outputPts.slice(1).map((p, i) => p - outputPts[i]);
  assert.ok(outputIntervals.length > 20 && Math.max(...outputIntervals) > Math.min(...outputIntervals) * 1.8,
    "VFR temporal spacing must survive copy/remux");
}));

test("ASS→WebVTT focused seek six seconds before playback preserves cues at new boundary and absolute clock", {
  timeout: 50_000,
}, () => inScratch((dir) => {
  const subtitles = path.join(dir, "markers.srt");
  const video = path.join(dir, "sub-ass.mkv");
  fs.writeFileSync(subtitles,
    "1\n00:00:05,900 --> 00:00:06,430\nOverlap six-second start\n\n" +
    "2\n00:00:06,020 --> 00:00:06,300\nAfter first start\n\n" +
    "3\n00:00:11,880 --> 00:00:12,330\nOverlap next boundary\n\n" +
    "4\n00:00:12,030 --> 00:00:12,530\nAfter next start\n\n" +
    "5\n00:00:17,910 --> 00:00:18,300\nLater cue\n\n", "utf8");
  ff(["-y", "-f", "lavfi", "-i", "color=black:size=48x48:rate=5",
    "-i", subtitles, "-t", "20", "-map", "0:v:0", "-map", "1:0",
    "-c:v", "libx264", "-threads", "2", "-preset", "ultrafast",
    "-g", "10", "-c:s", "ass", video]);
  assert.equal(streams(video).find((s) => s.codec_type === "subtitle")?.codec_name, "ass");
  const all = parseSubtitle(ff(["-i", video, "-map", "0:1", "-f", "webvtt", "pipe:1"]), "baseline");
  assert.equal(all.length, 5, "control: source contains every intentional cue");
  for (const target of [12.18, 18.09]) {
    // Exactly the Alpha server's focused seek flags, with 6s of preroll.
    const start = Math.floor(target - 6);
    const vtt = ff(["-ss", String(start), "-i", video, "-map", "0:1",
      "-t", "180", "-output_ts_offset", String(start), "-f", "webvtt", "pipe:1"]);
    const extracted = parseSubtitle(vtt, "window-" + target);
    const close = all.filter((cue) => cue.startMs >= start * 1000 && cue.startMs <= target * 1000 + 200);
    assert.ok(close.length > 0, "fixture must place cue start between focused seek and target");
    for (const expected of close) {
      const actual = extracted.find((cue) => cue.text === expected.text);
      assert.ok(actual, "Missing ASS cue after focused seek " + start + ": " + expected.text + "\n" + vtt);
      assert.ok(Math.abs(actual.startMs - expected.startMs) < 130,
        "Absolute subtitle cue time shifted at start " + start + ": " + expected.text +
        " (" + actual.startMs + " vs " + expected.startMs + ")");
    }
    // An ASS cue may begin just *before* the window's 6-second preroll
    // boundary yet still be displayed after that boundary. Silent omissions
    // leave the first seconds of post-seek playback captionless.
    const overlaps = all.filter((cue) => cue.startMs < start * 1000 && cue.endMs > start * 1000);
    for (const expected of overlaps) {
      assert.ok(extracted.some((cue) => cue.text === expected.text),
        "Dropped ASS cue spanning focused seek start " + start + ": " + expected.text + "\n" + vtt);
    }
  }
}));
