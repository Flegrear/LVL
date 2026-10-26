import test from "node:test";
import assert from "node:assert/strict";
import { hardwareVideoEncodingArgs, detectHardwareH264Encoder } from "../backend/media/hardware-transcode.js";

test("GPU transcode controls use bitrate options, software retains quality-based encoding", () => {
  const hardware = hardwareVideoEncodingArgs("h264_amf", 2160);
  assert.deepEqual(hardware.slice(0, 2), ["-c:v", "h264_amf"]);
  assert.ok(hardware.includes("18000k"));
  assert.equal(hardware.includes("-crf"), false);
  const software = hardwareVideoEncodingArgs("libx264", 1080);
  assert.ok(software.includes("-crf"));
  assert.ok(software.includes("21"));
});

test("devices without Windows hardware encoders use the CPU path", async () => {
  assert.equal(await detectHardwareH264Encoder(null), null);
  assert.equal(await detectHardwareH264Encoder("ffmpeg", { platform: "linux" }), null);
});
