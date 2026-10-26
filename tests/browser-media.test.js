import test from "node:test";
import assert from "node:assert/strict";
import { directVideoDecision, selectBrowserPlayback, selectBrowserPlaybackWithCapabilities, browserCanPlay } from "../frontend/player/browser-media.js";

const supports = (codec) => codec.includes("avc1") || codec.includes("hvc1");
test("native HEVC 4K HDR bitstreams play directly when device supports 10-bit HEVC", () => {
  const result = directVideoDecision({
    file: { name: "sample.hevc.2160p.mp4", needsTranscode: true },
    media: { video: { codec: "hevc", height: 2160, pixelFormat: "yuv420p10le", bitDepth: 10 }, audio: { codec: "aac" } },
    canPlayType: supports,
  });
  assert.equal(result.direct, true);
});
test("HEVC without native codec and MKV containers transcode", () => {
  const media = { video: { codec: "hevc", pixelFormat: "yuv420p10le" }, audio: { codec: "aac" } };
  assert.equal(directVideoDecision({ file: { name: "movie.mp4" }, media, canPlayType: () => "" }).direct, false);
  assert.equal(directVideoDecision({ file: { name: "movie.mkv" }, media, canPlayType: supports }).direct, false);
});
test("H.264 high-10 does not silently fail in browser, and unsupported audio transcodes", () => {
  assert.equal(directVideoDecision({ file: { name: "movie.mp4" }, media: { video: { codec: "h264", bitDepth: 10 } }, canPlayType: supports }).direct, false);
  assert.equal(directVideoDecision({ file: { name: "movie.mp4" }, media: { video: { codec: "h264" }, audio: { codec: "dts" } }, canPlayType: supports }).direct, false);
});
test("unknown high efficiency video isn't forced through an unsupported native decoder", () => {
  assert.equal(directVideoDecision({ file: { name: "Movie.HEVC.HDR.mp4", needsTranscode: true }, canPlayType: () => "" }).direct, false);
});

test("HEVC in MKV preserves original HDR video via MP4 remux", () => {
  const decision = selectBrowserPlayback({
    file: { name: "show.S01E02.2160p.mkv", needsTranscode: true },
    media: { video: { codec: "hevc", pixelFormat: "yuv420p10le", colorTransfer: "smpte2084" }, audio: { codec: "eac3", channels: 6 } },
    canPlayType: supports,
  });
  assert.equal(decision.mode, "remux");
  assert.equal(decision.copyVideo, true);
});

test("unsupported audio alone triggers remux and hardware-ineligible HEVC transcodes", () => {
  const input = { video: { codec: "hevc", pixelFormat: "yuv420p10le" }, audio: { codec: "dts", channels: 6 } };
  assert.equal(selectBrowserPlayback({ file: { name: "movie.mp4" }, media: input, canPlayType: supports }).mode, "remux");
  assert.equal(selectBrowserPlayback({ file: { name: "movie.mkv" }, media: input, canPlayType: () => "" }).mode, "transcode");
});

test("MOV with compatible H.264 is remuxed because the browser MP4 check does not validate MOV packaging", () => {
  assert.equal(selectBrowserPlayback({
    file: { name: "camera.mov" },
    media: { video: { codec: "h264", pixelFormat: "yuv420p" }, audio: { codec: "aac" } },
    canPlayType: supports,
  }).mode, "remux");
});

test("codec capability never accepts the string no as supported", () => {
  assert.equal(browserCanPlay('video/mp4; codecs="hvc1"', () => "no"), false);
  assert.equal(browserCanPlay('video/mp4; codecs="hvc1"', () => "maybe"), true);
  assert.equal(selectBrowserPlayback({ file: { name: "movie.mp4" }, media: { video: { codec: "h264" } }, canPlayType: () => "no" }).mode, "transcode");
});

test("device capability rejects advertised HEVC when the real resolution is unsupported", async () => {
  const seen = [];
  const input = {
    file: { name: "movie.2160p.mkv" },
    media: {
      video: { codec: "hevc", pixelFormat: "yuv420p10le", width: 3840, height: 2160, frameRate: 24 },
      audio: { codec: "aac" }, bitRate: 15_000_000,
    },
    canPlayType: supports,
    decodingInfo: async (config) => { seen.push(config); return { supported: false, smooth: false, powerEfficient: false }; },
  };
  const result = await selectBrowserPlaybackWithCapabilities(input);
  assert.equal(result.mode, "transcode");
  assert.equal(result.reason, "device-decoding-unsupported");
  assert.equal(seen[0].video.width, 3840);
  assert.match(seen[0].video.contentType, /hvc1/);
});

test("device capability errors do not prevent a browser-supported remux", async () => {
  const result = await selectBrowserPlaybackWithCapabilities({
    file: { name: "movie.mkv" },
    media: { video: { codec: "hevc", width: 1920, height: 1080 }, audio: { codec: "aac" } },
    canPlayType: supports,
    decodingInfo: async () => { throw new Error("Unavailable in this context"); },
  });
  assert.equal(result.mode, "remux");
});

test("10-bit browser codec probes cannot authorize 12-bit or 4:2:2 HEVC/AV1", async () => {
  const seen = [];
  const input = {
    file: { name: "archive.mp4" },
    canPlayType: (codec) => {
      seen.push(codec);
      return "probably";
    },
    decodingInfo: async () => { throw new Error("A 12-bit source must not reach MediaCapabilities"); },
  };
  for (const codec of ["hevc", "av1"]) {
    for (const pixelFormat of ["yuv420p12le", "yuv422p10le"]) {
      const media = { video: { codec, pixelFormat, width: 3840, height: 2160 }, audio: { codec: "aac" } };
      assert.equal(selectBrowserPlayback({ ...input, media }).mode, "transcode", `${codec} ${pixelFormat}`);
      assert.equal((await selectBrowserPlaybackWithCapabilities({ ...input, media })).mode, "transcode");
    }
  }
  assert.equal(seen.length, 0, "A supported 10-bit profile does not validate unsupported bit depth or chroma");
  assert.equal(selectBrowserPlayback({
    ...input, media: { video: { codec: "hevc", pixelFormat: "yuv420p10le" }, audio: { codec: "aac" } },
  }).mode, "direct", "HEVC Main10 4:2:0 still plays directly when supported");
});

test("VP9 WebM browser probe cannot certify VP9 Profile 2 or higher bit depth", () => {
  const decision = selectBrowserPlayback({
    file: { name: "movie.webm" },
    media: { video: { codec: "vp9", pixelFormat: "yuv420p10le" }, audio: { codec: "opus" } },
    canPlayType: () => "probably",
  });
  assert.equal(decision.mode, "transcode");
});
