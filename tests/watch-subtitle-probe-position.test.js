import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const begin = app.indexOf("function embeddedSubtitleProbePosition(");
const end = app.indexOf("\nfunction renderEmbeddedSubtitleControls(", begin);
assert.ok(begin > 0 && end > begin);

test("late metadata loads captions at a paused user's latest seek target, not original episode start", () => {
  const state = { pendingSeek: { target: 600, wasPlaying: false }, currentMs: 0 };
  const ctx = vm.createContext({ state });
  vm.runInContext(app.slice(begin, end), ctx);
  const latest = vm.runInContext("embeddedSubtitleProbePosition(0)", ctx);
  assert.equal(latest, 600);
  assert.match(app, /const subtitlePosition = typeof embeddedSubtitleProbePosition === "function"[\s\S]*?enableDefaultEmbeddedSubtitles\(media, subtitlePosition,/);
  state.pendingSeek = null;
  state.currentMs = 504_000;
  assert.equal(vm.runInContext("embeddedSubtitleProbePosition(0)", ctx), 504,
    "a seek completed before metadata callback also retains the latest paused position");
  state.currentMs = Number.NaN;
  assert.equal(vm.runInContext("embeddedSubtitleProbePosition(72)", ctx), 72,
    "metadata fallback preserves an intentional nonzero startup resume");
});
