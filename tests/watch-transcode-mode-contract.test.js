import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createTranscodePlan } from "../shared/media/media-compat.js";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const start = app.indexOf("function transcodeQuery(");
const end = app.indexOf("\nfunction releaseNeedsAudioTranscode(", start);
assert.ok(start > 0 && end > start);

function query(capability, { hdr = false } = {}) {
  const context = { copyVideo: true, forceH264: false, audioIndex: 1 };
  const state = {
    transcodeContext: context, selectedAudioTrack: 1,
    currentMediaProbe: { video: { codec: "hevc", pixelFormat: "yuv420p10le", bitDepth: 10 },
      compatibility: { video: { bitDepth: 10, hdr } } },
  };
  const ctx = vm.createContext({ state, URLSearchParams, audioOutputMode: "stereo",
    normalizeAudioMode: value => value,
    video: { canPlayType: () => capability },
  });
  vm.runInContext(app.slice(start, end), ctx);
  const params = vm.runInContext("transcodeQuery", ctx)(143.5, 1);
  return { params, context };
}

test("HEVC Main10 without actual browser support requests explicit H264 (no copied-keyframe clock)", () => {
  const { params, context } = query("");
  assert.equal(params.get("video"), "h264");
  assert.equal(params.has("hevc"), false);
  assert.equal(context.forceH264, true, "persist actual effective video mode across retries");
  const backend = createTranscodePlan({ video: { codec: "hevc", profile: "Main 10", pixelFormat: "yuv420p10le" },
    audioTracks: [{ codec: "aac", channels: 2 }] }, {
    fileName: "S01E01.mkv", startSeconds: Number(params.get("start")),
    videoMode: params.get("video"), clientHevc: params.get("hevc") === "1",
  });
  assert.equal(backend.video.mode, "h264");
});

test("truly supported HEVC retains copy hint for verified keyframe seek", () => {
  const { params, context } = query("probably");
  assert.equal(params.get("video"), "copy");
  assert.equal(params.get("hevc"), "1");
  assert.equal(context.forceH264, false);
});
