import test from "node:test";
import assert from "node:assert/strict";
import {
  createTranscodePlan,
  hdrKind,
  inspectMediaCompatibility,
  transcodeVideoFilter,
  videoBitDepth,
} from "../shared/media/media-compat.js";

const media = (video, audio = { codec: "aac", channels: 2 }) => ({
  video,
  audio,
  audioTracks: audio ? [audio] : [],
});

test("probe compatibility identifies 10-bit HDR 4K HEVC without claiming browser support", () => {
  const input = media({
    codec: "hevc",
    profile: "Main 10",
    pix_fmt: "yuv420p10le",
    width: 3840,
    height: 2160,
    color_transfer: "smpte2084",
    color_primaries: "bt2020",
  }, { codec: "eac3", channels: 6 });
  assert.equal(videoBitDepth(input.video), 10);
  assert.equal(hdrKind(input.video), "pq");
  const compatibility = inspectMediaCompatibility(input);
  assert.equal(compatibility.video.fourK, true);
  assert.equal(compatibility.video.hdr, true);
  assert.equal(compatibility.video.defaultCopySafe, false);
  assert.equal(compatibility.video.hevcRemuxAvailableWithClientOptIn, true);
  assert.equal(compatibility.audio.surroundAvailable, true);
  assert.equal(compatibility.defaultNeedsTranscode, true);
});

test("H.264 video is copied while incompatible audio alone is converted", () => {
  const plan = createTranscodePlan(media(
    { codec: "h264", pix_fmt: "yuv420p", width: 1920, height: 1080 },
    { codec: "eac3", channels: 6 },
  ));
  assert.equal(plan.video.mode, "copy", "audio conversion must not force a video encode");
  assert.equal(plan.audio.codec, "aac");
  assert.equal(plan.audio.channels, 2);
});

test("surround mode preserves 5.1 and copies AAC 5.1 when no conversion is needed", () => {
  const plan = createTranscodePlan(media(
    { codec: "h264", pix_fmt: "yuv420p" },
    { codec: "aac", channels: 6, channelLayout: "5.1" },
  ), { audioMode: "surround" });
  assert.equal(plan.video.mode, "copy");
  assert.equal(plan.audio.channels, 6);
  assert.equal(plan.audio.codec, "copy");
});

test("surround mode converts AC3/EAC3 to six-channel AAC instead of stereo", () => {
  const plan = createTranscodePlan(media(
    { codec: "h264", pix_fmt: "yuv420p" },
    { codec: "ac3", channels: 6 },
  ), { audioMode: "surround" });
  assert.equal(plan.video.mode, "copy");
  assert.equal(plan.audio.codec, "aac");
  assert.equal(plan.audio.channels, 6);
  assert.equal(plan.audio.bitRate, "384k");
});

test("HEVC HDR is remuxed losslessly only after client codec opt-in", () => {
  const input = media({ codec: "hevc", pix_fmt: "yuv420p10le", color_transfer: "smpte2084" });
  const fallback = createTranscodePlan(input, { videoMode: "copy" });
  assert.equal(fallback.video.mode, "h264");
  assert.equal(fallback.video.fallbackReason, "hevc-client-opt-in-required");
  assert.equal(fallback.video.toneMapToSdr, true);
  assert.match(transcodeVideoFilter(fallback), /tonemap/);

  const supported = createTranscodePlan(input, { videoMode: "copy", clientHevc: true });
  assert.equal(supported.video.mode, "copy");
  assert.equal(supported.video.tag, "hvc1");
  assert.equal(supported.video.toneMapToSdr, false, "stream copy keeps HDR metadata and 10-bit samples intact");
  assert.equal(transcodeVideoFilter(supported), null);
});

test("explicit stream copy at a seek retains fidelity and marks keyframe seek", () => {
  const plan = createTranscodePlan(media({ codec: "h264", pix_fmt: "yuv420p" }), {
    startSeconds: 123.5,
    videoMode: "copy",
  });
  assert.equal(plan.video.mode, "copy");
  assert.equal(plan.video.keyframeSeek, true);
  assert.equal(plan.audio.codec, "aac");
});

test("automatic seek stays conservative but explicitly copied HEVC HDR retains original bitstream", () => {
  const input = media({ codec: "hevc", pix_fmt: "yuv420p10le", color_transfer: "smpte2084" });
  const auto = createTranscodePlan(input, { startSeconds: 90, clientHevc: true });
  assert.equal(auto.video.mode, "h264");
  assert.equal(auto.video.toneMapToSdr, true);
  const copied = createTranscodePlan(input, { startSeconds: 90, videoMode: "copy", clientHevc: true });
  assert.equal(copied.video.mode, "copy");
  assert.equal(copied.video.keyframeSeek, true);
  assert.equal(copied.video.toneMapToSdr, false);
});

test("10-bit H.264 is not copied into the browser compatibility path", () => {
  const plan = createTranscodePlan(media({ codec: "h264", pix_fmt: "yuv420p10le" }));
  assert.equal(plan.video.mode, "h264");
  assert.equal(plan.video.bitDepth, 10);
  assert.equal(videoBitDepth({ pix_fmt: "p010le" }), 10);
});

test("server copy opt-in remains bounded by the browser's advertised Main10 and AV1 4:2:0 profiles", () => {
  for (const codec of ["hevc", "av1"]) {
    for (const pixelFormat of ["yuv420p12le", "yuv422p10le"]) {
      const input = media({ codec, pixelFormat });
      const compatibility = inspectMediaCompatibility(input);
      assert.equal(compatibility.video.bitDepth, pixelFormat.includes("12") ? 12 : 10);
      assert.equal(compatibility.video[codec === "hevc" ? "hevcRemuxAvailableWithClientOptIn" : "av1RemuxAvailableWithClientOptIn"], false);
      const requested = createTranscodePlan(input, { videoMode: "copy", clientHevc: true, clientAv1: true });
      assert.equal(requested.video.mode, "h264", `${codec} ${pixelFormat}`);
      assert.equal(requested.video.fallbackReason, "source-video-not-safe-to-copy");
    }
  }
  assert.equal(createTranscodePlan(media({ codec: "hevc", pix_fmt: "yuv420p10le" }), {
    videoMode: "copy", clientHevc: true,
  }).video.mode, "copy");
});
