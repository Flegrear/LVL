// Synthetic release-gate evidence for seeked copy-video + encoded audio.
// Exercises format/timebase/codec cases absent from the original remux tests.
// The named production tests remain unchanged. Fixtures are tiny, local and
// ephemeral; no torrents, playback server or installed application are used.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

const TIMEOUT = 25_000;
const MAX_BUFFER = 3 * 1024 * 1024;
const SEEK_POINTS = [5.37, 8.19];

function command(binary, args, timeout = TIMEOUT) {
  const result = spawnSync(binary, args, {
    windowsHide: true, encoding: "utf8", timeout, maxBuffer: MAX_BUFFER,
  });
  assert.equal(result.status, 0,
    `${path.basename(binary)} exited ${result.status}: ${result.error?.message || result.stderr || args.join(" ")}`);
  return result.stdout;
}

const ffmpeg = (args, timeout) => command(ffmpegPath,
  ["-hide_banner", "-loglevel", "error", "-nostdin", ...args], timeout);
const probe = (args) => JSON.parse(command(ffprobeStatic.path, ["-v", "error", ...args]));

function withFixture(name, exercise) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lvl-seek-edge-"));
  try { return exercise(dir); }
  finally {
    // Never touch application, installed, or source data.
    assert.ok(path.basename(dir).startsWith("lvl-seek-edge-"), `Unexpected cleanup target for ${name}`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function makeSource(dir, config) {
  const source = path.join(dir, `source.${config.ext || "mkv"}`);
  const hasAudio = config.audio !== null;
  const h265 = config.video === "hevc";
  const videoArgs = [
    "-c:v", h265 ? "libx265" : "libx264", "-threads", "2",
    "-preset", "ultrafast", "-g", String(config.variableGop ? 240 : 100),
    "-keyint_min", String(config.variableGop ? 1 : 100),
    ...(h265
      ? ["-pix_fmt", "yuv420p10le", "-x265-params",
        "pools=1:frame-threads=1:keyint=100:min-keyint=100:scenecut=0:log-level=error"]
      : ["-pix_fmt", "yuv420p", "-bf", "3", "-x264-params", "scenecut=0"]),
    ...(config.variableGop ? ["-force_key_frames", "0,1.44,3.96,7.28,9.64"] : []),
    ...(h265 ? ["-color_primaries", "bt2020", "-color_trc", "smpte2084",
      "-colorspace", "bt2020nc"] : []),
  ];
  const filter = config.vfr
    ? ["-vf", "select=not(mod(n\\,2))+not(mod(n\\,7))", "-fps_mode:v", "vfr"]
    : config.timestampOffset
      ? ["-vf", `setpts=PTS+${config.timestampOffset}/TB`]
      : [];
  const audioFilter = [
    ...(config.silenceUntilFive ? ["volume=if(lt(t\\,5)\\,0\\,1):eval=frame"] : []),
    ...(config.timestampOffset ? [`asetpts=PTS+${config.timestampOffset}/TB`] : []),
  ];
  ffmpeg([
    "-y", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=25",
    ...(hasAudio ? ["-f", "lavfi", "-i", "sine=frequency=730:sample_rate=48000"] : []),
    "-t", "12", "-map", "0:v:0", ...(hasAudio ? ["-map", "1:a:0"] : []),
    ...filter, ...videoArgs,
    ...(hasAudio ? ["-c:a", config.audio,
      ...(audioFilter.length ? ["-af", audioFilter.join(",")] : [])] : ["-an"]),
    ...(config.containerOffset != null ? ["-output_ts_offset", String(config.containerOffset),
      "-avoid_negative_ts", "disabled"] : []),
    source,
  ], 40_000);
  return source;
}

function videoPackets(file, seek = null) {
  const data = probe([
    ...(seek != null ? ["-read_intervals", `${seek}%+0.1`] : []),
    "-select_streams", "v:0", "-show_packets",
    "-show_entries", "packet=pts_time,dts_time,flags",
    "-of", "json", file,
  ]);
  return (data.packets || []).map((packet) => ({
    pts: Number(packet.pts_time), dts: Number(packet.dts_time),
    key: String(packet.flags || "").includes("K"),
  })).filter((packet) => Number.isFinite(packet.pts));
}

function firstDecodedHash(file, seek = null) {
  const result = ffmpeg([
    ...(seek == null ? [] : ["-ss", String(seek)]),
    "-i", file, "-map", "0:v:0", "-frames:v", "1",
    "-pix_fmt", "yuv420p", "-f", "framemd5", "-",
  ]);
  const line = result.split(/\r?\n/).find((row) => /^0,/.test(row));
  assert.ok(line, `Missing decoded first frame for ${path.basename(file)}`);
  return line.split(",").at(-1).trim();
}

function firstDecodedPts(file) {
  const frames = probe([
    "-select_streams", "v:0", "-show_entries", "frame=best_effort_timestamp_time",
    "-show_frames", "-of", "json", file,
  ]).frames || [];
  const start = Number(frames[0]?.best_effort_timestamp_time);
  assert.ok(frames.length > 0 && Number.isFinite(start),
    `Missing first decoded video PTS for ${path.basename(file)}`);
  return start;
}

function audioPackets(file) {
  const result = probe([
    "-select_streams", "a:0", "-show_entries", "packet=pts_time,duration_time",
    "-show_packets", "-of", "json", file,
  ]);
  return (result.packets || []).map((entry) => ({
    pts: Number(entry.pts_time),
    duration: Number(entry.duration_time),
  })).filter((entry) => Number.isFinite(entry.pts));
}

function audioRms(file, fromSeconds) {
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-ss", String(fromSeconds),
    "-i", file, "-map", "0:a:0", "-t", "0.3", "-ac", "1", "-ar", "16000",
    "-f", "s16le", "pipe:1"];
  const result = spawnSync(ffmpegPath, args, {
    windowsHide: true, timeout: TIMEOUT, maxBuffer: MAX_BUFFER,
  });
  assert.equal(result.status, 0, result.stderr?.toString() || result.error?.message);
  const data = result.stdout;
  assert.ok(data.length >= 2 * 16000 * 0.25, "Expected 300ms of decoded PCM");
  let squared = 0;
  for (let i = 0; i < data.length - 1; i += 2) {
    const sample = data.readInt16LE(i) / 32768;
    squared += sample * sample;
  }
  return Math.sqrt(squared / (data.length / 2));
}

function remux(source, output, seek, { hevc = false, audio = true } = {}) {
  // Match the server's copy-video path precisely, including noaccurate_seek
  // and make_zero. Optional audio is deliberately mapped with '?'.
  ffmpeg([
    "-noaccurate_seek", "-ss", String(seek), "-i", source,
    "-map", "0:v:0", "-map", "0:a:0?", "-c:v", "copy",
    ...(hevc ? ["-tag:v", "hvc1"] : []),
    "-c:a", "aac", "-b:a", "128k", "-ac", "2",
    ...(audio ? ["-af", "aresample=async=1"] : []),
    "-t", "3.3", "-avoid_negative_ts", "make_zero",
    "-movflags", "frag_keyframe+empty_moov+default_base_moof",
    "-f", "mp4", "-y", output,
  ]);
}

function assertAudioContinuity(file, context) {
  const packets = audioPackets(file);
  assert.ok(packets.length > 40, `${context}: too few output AAC packets`);
  const deltas = packets.slice(1).map((packet, index) => packet.pts - packets[index].pts);
  assert.ok(deltas.every((delta) => delta > 0), `${context}: non-monotonic/duplicate AAC PTS`);
  const largest = Math.max(...deltas);
  assert.ok(largest < 0.12, `${context}: audio packet hole ${largest.toFixed(4)}s`);
  const min = Math.min(...packets.map((packet) => packet.pts));
  assert.ok(min > -0.15 && min < 0.25, `${context}: audio starts at unexpected ${min}s`);
  return { count: packets.length, largest };
}

function assertKeyframeMatch(source, output, seek, label) {
  const packets = videoPackets(source, seek);
  assert.ok(packets.length > 0 && packets[0].key,
    `${label}: FFprobe input seek must return a verified preceding keyframe`);
  const origin = packets[0].pts;
  const outHash = firstDecodedHash(output);
  const originHash = firstDecodedHash(source, origin);
  assert.equal(outHash, originHash,
    `${label}: remux first decoded frame must match FFprobe selected keyframe PTS ${origin}s`);
  const firstOutputPts = firstDecodedPts(output);
  assert.ok(firstOutputPts > -0.15 && firstOutputPts < 0.2,
    `${label}: output first video PTS must be zero-based, got ${firstOutputPts}s`);
  assert.ok(Math.abs(origin - firstOutputPts - seek) > 0.05,
    `${label}: actual source→output time mapping must account for copied-keyframe preroll`);
  assert.ok(Math.abs(origin - seek) > 0.05, `${label}: test must include a visible preroll`);
  return origin;
}

for (const config of [
  { name: "H264+B-frames MKV / AC3, five seconds of silence", ext: "mkv", video: "h264", audio: "ac3", silenceUntilFive: true },
  { name: "H264+B-frames MP4 / AAC", ext: "mp4", video: "h264", audio: "aac" },
  { name: "HEVC Main10 HDR10 MKV / AC3", ext: "mkv", video: "hevc", audio: "ac3" },
  { name: "H264 MP4 / AAC with irregular keyframe gaps", ext: "mp4", video: "h264", audio: "aac", variableGop: true },
  { name: "H264 MKV / AC3 variable-frame-rate", ext: "mkv", video: "h264", audio: "ac3", vfr: true },
  { name: "H264 MKV with no audio track", ext: "mkv", video: "h264", audio: null },
]) {
  test(`copied seek first-frame provenance and AAC continuity: ${config.name}`,
    { timeout: 80_000 }, () => withFixture(config.name, (dir) => {
      const source = makeSource(dir, config);
      const inputStreams = probe(["-show_entries",
        "stream=codec_type,codec_name,pix_fmt,color_primaries,color_transfer,color_space",
        "-show_streams", "-of", "json", source]).streams;
      if (config.video === "hevc") {
        const video = inputStreams.find((stream) => stream.codec_type === "video");
        assert.equal(video.codec_name, "hevc");
        assert.equal(video.pix_fmt, "yuv420p10le");
        assert.equal(video.color_transfer, "smpte2084");
        assert.equal(video.color_primaries, "bt2020");
      }
      if (config.audio === null) assert.equal(inputStreams.some((stream) => stream.codec_type === "audio"), false);
      if (config.variableGop) {
        const keyframes = videoPackets(source).filter((packet) => packet.key).map((packet) => packet.pts);
        const gops = keyframes.slice(1).map((value, index) => value - keyframes[index]);
        assert.ok(gops.length >= 3 && Math.max(...gops) - Math.min(...gops) > 0.5,
          "variable-GOP fixture must have uneven preceding-keyframe spacing");
      }
      if (config.vfr) {
        const pts = videoPackets(source).map((packet) => packet.pts).sort((a, b) => a - b);
        const intervals = pts.slice(1).map((value, index) => value - pts[index]).filter((delta) => delta > 0.005);
        assert.ok(intervals.length > 50 && Math.max(...intervals) > 1.8 * Math.min(...intervals),
          "VFR fixture must actually contain different inter-frame time deltas");
      }
      const origins = [];
      for (const [index, seek] of SEEK_POINTS.entries()) {
        const output = path.join(dir, `copy-${index}.mp4`);
        remux(source, output, seek, { hevc: config.video === "hevc", audio: config.audio !== null });
        const context = `${config.name}, seek ${seek}s`;
        origins.push(assertKeyframeMatch(source, output, seek, context));
        const actualOutput = probe(["-show_entries", "stream=codec_type,codec_name,pix_fmt,color_transfer,color_primaries",
          "-show_streams", "-of", "json", output]).streams;
        assert.equal(actualOutput.find((entry) => entry.codec_type === "video")?.codec_name,
          config.video === "hevc" ? "hevc" : "h264", `${context}: copy stream codec intact`);
        if (config.video === "hevc") {
          const copiedHdr = actualOutput.find((entry) => entry.codec_type === "video");
          assert.equal(copiedHdr?.color_transfer, "smpte2084",
            "explicit copied HDR10 must remain PQ, not silently converted to SDR");
          assert.equal(copiedHdr?.color_primaries, "bt2020",
            "explicit copied HDR10 must retain BT.2020 primaries");
          assert.equal(copiedHdr?.pix_fmt, "yuv420p10le",
            "explicit copied HDR10 must retain 10-bit pixel depth");
        }
        if (config.audio === null) {
          assert.equal(actualOutput.some((entry) => entry.codec_type === "audio"), false,
            `${context}: optional audio map must not fabricate an audio track`);
        } else {
          assert.equal(actualOutput.find((entry) => entry.codec_type === "audio")?.codec_name, "aac");
          assertAudioContinuity(output, context);
          if (config.silenceUntilFive && index === 0) {
            const quiet = audioRms(output, 0.2);
            const audible = audioRms(output, 1.8);
            assert.ok(quiet < 0.002 && audible > Math.max(quiet * 20, 0.01),
              `${context}: 5s silent head should persist before speech onset (${quiet} -> ${audible})`);
          }
        }
      }
      // Different seeks must not collapse to the same keyframe indefinitely.
      assert.ok(origins[1] > origins[0], `${config.name}: later seek must advance the lookup origin`);
    }));
}

test("repeated backward/forward remux seeks have stable keyframes and no accumulating AAC timestamp gaps", {
  timeout: 80_000,
}, () => withFixture("stress remux seeks", (dir) => {
  const source = makeSource(dir, { ext: "mkv", video: "h264", audio: "ac3", silenceUntilFive: true });
  const previous = new Map();
  for (const [i, seek] of [5.37, 8.19, 5.37, 8.19, 4.89, 5.37].entries()) {
    const output = path.join(dir, `stress-${i}.mp4`);
    remux(source, output, seek);
    const label = `stress #${i}, seek ${seek}`;
    const origin = assertKeyframeMatch(source, output, seek, label);
    const frame = firstDecodedHash(output);
    if (previous.has(seek)) {
      assert.equal(frame, previous.get(seek).frame, `${label}: same seek must return same decoded frame`);
      assert.equal(origin, previous.get(seek).origin, `${label}: probe origin must remain deterministic`);
    }
    previous.set(seek, { origin, frame });
    assertAudioContinuity(output, label);
  }
}));

test("container timestamp offsets, including negative starts, expose the FFprobe/FFmpeg clock basis", {
  timeout: 80_000,
}, () => withFixture("offset timestamps", (dir) => {
  for (const [label, offset] of [["positive", 1.25], ["negative", -0.75]]) {
    const sub = path.join(dir, label);
    fs.mkdirSync(sub);
    const source = makeSource(sub, { ext: "mkv", video: "h264", audio: "aac", containerOffset: offset });
    const input = probe(["-show_entries", "format=start_time", "-show_format", "-of", "json", source]);
    const firstSource = videoPackets(source)[0];
    assert.ok(Number.isFinite(firstSource.pts), `${label} source must have decodable timestamp`);
    const output = path.join(sub, "remux.mp4");
    remux(source, output, 5.37);
    const seekPackets = videoPackets(source, 5.37);
    assert.ok(seekPackets[0]?.key, `${label} seek must identify a keyframe`);
    // Some containers add start_time to input -ss while FFprobe
    // -read_intervals returns absolute PTS: using a keyframe's raw PTS as
    // FFmpeg's input-seek parameter can choose a DIFFERENT frame.
    const firstOutput = firstDecodedHash(output);
    const lookupFrame = firstDecodedHash(source, seekPackets[0].pts);
    const matches = firstOutput === lookupFrame;
    const start = Number(input.format?.start_time);
    assert.ok(Number.isFinite(start), `${label}: format start_time must be a number`);
    assert.ok(firstOutput.length >= 16 && lookupFrame.length >= 16);
    assertAudioContinuity(output, `${label} timestamp offset ${offset}s`);
    const relativeTimeHash = firstDecodedHash(source, seekPackets[0].pts - start);
    assert.equal(firstOutput, relativeTimeHash,
      `${label}: FFmpeg input seek must subtract nonzero format start_time from FFprobe's absolute PTS`);
    if (start > 0.5) {
      assert.equal(matches, false,
        "positive-offset fixture must catch the false assumption that raw FFprobe PTS is relative input seek");
    }
    console.log(`offset ${label}: formatStart=${start}s, ffprobeKeyframe=${seekPackets[0].pts}s, decodedFrameMatches=${matches}`);
  }
}));
