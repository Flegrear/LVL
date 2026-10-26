import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import ffmpeg from "ffmpeg-static";
import ffprobe from "ffprobe-static";
import { browserVideoProfileSafe, dolbyVisionFromProbe } from "../shared/media/video-profile.js";
import { selectBrowserPlayback } from "../frontend/player/browser-media.js";
import { createTranscodePlan, transcodeVideoFilter } from "../shared/media/media-compat.js";

function execute(binary, args) {
  const run = spawnSync(binary, args, { windowsHide: true, timeout: 20_000, encoding: "utf8" });
  assert.equal(run.status, 0, `${args.join(" ")}: ${run.stderr || run.error?.message}`);
  return run.stdout;
}

test("HEVC/AV1 browser and server reject unsupported advertised profiles", () => {
  for (const [codec, profile] of [["hevc", "Rext"], ["av1", "High"], ["av1", "Professional"]]) {
    const video = { codec, profile, pixelFormat: "yuv420p10le", colorTransfer: "smpte2084" };
    assert.equal(browserVideoProfileSafe(video, codec), false);
    assert.equal(selectBrowserPlayback({ file: { name: "episode.mkv" }, media: { video }, canPlayType: () => "probably" }).mode, "transcode");
    const plan = createTranscodePlan({ video }, { videoMode: "copy", clientHevc: true, clientAv1: true });
    assert.equal(plan.video.mode, "h264");
    assert.equal(plan.video.toneMapToSdr, true);
  }
  assert.equal(browserVideoProfileSafe({ profile: "Main 10" }, "hevc"), true);
  assert.equal(browserVideoProfileSafe({ profile: "Main" }, "av1"), true);
  assert.equal(browserVideoProfileSafe({ profile: "High 10" }, "h264"), false);
  assert.equal(browserVideoProfileSafe({ profile: "High 10" }, "avc"), false, "H.264 aliases cannot bypass profile checks");
  assert.equal(selectBrowserPlayback({ file: { name: "movie.mp4" },
    media: { video: { codec: "avc", profile: "High 10" } }, canPlayType: () => "probably" }).mode, "transcode");
});

test("Dolby Vision profile/base-layer checks avoid pretending generic HEVC is a DV decoder", () => {
  const input = (profile, baseLayerCompatibilityId) => ({ video: {
    codec: "hevc", profile: "Main 10", pixelFormat: "yuv420p10le", colorTransfer: "smpte2084",
    dolbyVision: { profile, baseLayerCompatibilityId },
  } });
  assert.deepEqual(dolbyVisionFromProbe({ side_data_list: [{
    side_data_type: "DOVI configuration record", dv_profile: 5, dv_bl_signal_compatibility_id: 0,
  }] }), { profile: 5, baseLayerCompatibilityId: 0 });
  assert.equal(dolbyVisionFromProbe({ side_data_list: [] }), null);
  for (const [profile, compatible, safe] of [[5, 0, false], [7, 6, true], [8, 1, true], [8, 4, true], [8, 0, false], [8, null, false]]) {
    const media = input(profile, compatible);
    const browser = selectBrowserPlayback({ file: { name: "movie.mkv" }, media, canPlayType: () => "probably" });
    const server = createTranscodePlan(media, { videoMode: "copy", clientHevc: true });
    assert.equal(browser.mode, safe ? "remux" : "transcode", `DV profile ${profile}/${compatible}`);
    assert.equal(server.video.mode, safe ? "copy" : "h264", `server agrees on DV ${profile}/${compatible}`);
    if (!safe) assert.equal(server.video.fallbackReason, "dolby-vision-profile-not-browser-verified");
  }
  const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  assert.match(server, /stream_side_data_list=side_data_type,dv_profile,dv_bl_signal_compatibility_id/);
  assert.match(server, /dolbyVision: dolbyVisionFromProbe\(video\)/);
  assert.match(server, /\["\/video-profile\.js", \{ file: "shared\/media\/video-profile\.js"/);
});

test("Bundled FFmpeg can copy Main AV1 into MP4 without H.264 re-encoding", { timeout: 25_000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lvl-av1-copy-"));
  try {
    const input = path.join(dir, "input.mkv");
    const output = path.join(dir, "output.mp4");
    execute(ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=15:duration=0.4",
      "-c:v", "libaom-av1", "-cpu-used", "8", "-threads", "2", "-frames:v", "6", input]);
    const plan = createTranscodePlan({ video: { codec: "av1", profile: "Main", pixelFormat: "yuv420p" } },
      { videoMode: "copy", clientAv1: true });
    assert.equal(plan.video.mode, "copy");
    execute(ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", input, "-c:v", "copy", "-an", output]);
    const stream = JSON.parse(execute(ffprobe.path, ["-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=codec_name,profile,pix_fmt", "-of", "json", output])).streams[0];
    assert.equal(stream.codec_name, "av1");
    assert.equal(stream.profile, "Main");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("New shared playback modules remain available for the fresh package manifest", () => {
  for (const module of ["audio-policy.js", "video-profile.js"]) {
    assert.ok(fs.statSync(new URL(`../shared/media/${module}`, import.meta.url)).isFile(),
      `Fresh source snapshot includes ${module}`);
  }
});

test("Real HDR10/HLG HEVC remux retains 10-bit transfer; SDR fallback decodes as BT.709", { timeout: 65_000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lvl-video-quality-"));
  try {
    for (const [kind, transfer] of [["pq", "smpte2084"], ["hlg", "arib-std-b67"]]) {
      const source = path.join(dir, `${kind}.mkv`);
      const copied = path.join(dir, `${kind}-copy.mp4`);
      const converted = path.join(dir, `${kind}-sdr.mp4`);
      execute(ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=20:duration=0.5",
        "-vf", `format=yuv420p10le,setparams=color_primaries=bt2020:color_trc=${transfer}:colorspace=bt2020nc`,
        "-c:v", "libx265", "-threads", "2", "-x265-params", "pools=none:frame-threads=1:log-level=error",
        "-pix_fmt", "yuv420p10le", "-color_primaries", "bt2020", "-color_trc", transfer,
        "-colorspace", "bt2020nc", "-t", "0.5", source]);
      const video = { codec: "hevc", profile: "Main 10", pixelFormat: "yuv420p10le", colorTransfer: transfer, colorPrimaries: "bt2020" };
      // Exercise the exact extra FFprobe section request used by the server;
      // unrecognized show_entries sections otherwise break all media probing.
      const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
      const entries = server.match(/"-show_entries", "([^"]+)"/)?.[1];
      assert.ok(entries?.includes("stream_side_data_list="));
      const probed = JSON.parse(execute(ffprobe.path, ["-v", "error", "-show_entries", entries,
        "-of", "json", source]));
      assert.equal(probed.streams?.[0]?.codec_name, "hevc");
      const preservedPlan = createTranscodePlan({ video }, { videoMode: "copy", clientHevc: true });
      assert.equal(preservedPlan.video.mode, "copy");
      execute(ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", source,
        "-c:v", "copy", "-tag:v", "hvc1", "-an", copied]);
      const original = JSON.parse(execute(ffprobe.path, ["-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=codec_name,pix_fmt,color_transfer,color_primaries,codec_tag_string", "-of", "json", copied])).streams[0];
      assert.equal(original.codec_name, "hevc");
      assert.equal(original.pix_fmt, "yuv420p10le");
      assert.equal(original.color_transfer, transfer);
      assert.equal(original.color_primaries, "bt2020");
      assert.equal(original.codec_tag_string, "hvc1");

      const fallback = createTranscodePlan({ video }, { videoMode: "h264" });
      assert.equal(fallback.video.toneMapToSdr, true);
      execute(ffmpeg, ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", source,
        "-vf", transcodeVideoFilter(fallback), "-c:v", "libx264", "-threads", "2", "-preset", "ultrafast",
        "-pix_fmt", "yuv420p", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", converted]);
      const sdr = JSON.parse(execute(ffprobe.path, ["-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=codec_name,pix_fmt,color_transfer,color_primaries,color_space", "-of", "json", converted])).streams[0];
      assert.equal(sdr.codec_name, "h264");
      assert.equal(sdr.pix_fmt, "yuv420p");
      assert.equal(sdr.color_transfer, "bt709");
      assert.equal(sdr.color_primaries, "bt709");
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
