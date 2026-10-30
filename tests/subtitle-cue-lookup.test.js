import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createSubtitleCueLookup } from "../shared/subtitles/subtitle-sync.js";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");

test("Video-frame caption lookup preserves earliest matching overlapping cue, seeks and gaps", () => {
  const bounds = (cue) => ({ startMs: cue.startMs, endMs: cue.endMs });
  const lookup = createSubtitleCueLookup(bounds);
  const track = { cues: [
    { id: "a", startMs: 100, endMs: 300 },
    { id: "b", startMs: 200, endMs: 500 },
    { id: "c", startMs: 520, endMs: 900 },
  ] };
  for (const at of [0, 100, 199, 200, 300, 301, 400, 500, 510, 520, 899, 900, 901, 300, 120]) {
    const expected = track.cues.find((cue) => cue.startMs <= at && at <= cue.endMs) || null;
    assert.equal(lookup(track, at), expected, `frame ${at}`);
  }
});

test("Cut-aware nonmonotonic cue intervals retain the original stable source order", () => {
  const lookup = createSubtitleCueLookup((cue, track) => {
    const offset = track.syncAnchors[cue.section].offsetMs;
    return { startMs: cue.startMs + offset, endMs: cue.endMs + offset };
  });
  const track = { syncAnchors: [{ offsetMs: 10_000 }, { offsetMs: -10_000 }], cues: [
    { id: "early", section: 0, startMs: 12_000, endMs: 35_000 },
    { id: "cut", section: 1, startMs: 35_000, endMs: 40_000 },
  ] };
  assert.equal(lookup(track, 24_000).id, "early", "the earlier original cue keeps precedence under a negative offset cut");
  assert.equal(lookup(track, 29_000).id, "early");
  assert.equal(lookup(track, 30_000).id, "early");
  track.syncAnchors = [{ offsetMs: 0 }, { offsetMs: 0 }];
  assert.equal(lookup(track, 24_000).id, "early", "a new alignment revision invalidates the timing index");
  track.cues = [{ id: "new", section: 0, startMs: 35_000, endMs: 50_000 }];
  assert.equal(lookup(track, 24_000), null, "a replaced extracted subtitle window cannot reuse stale bounds");
});

test("Playback-frame queries do not recompute thousands of subtitle offsets", () => {
  let calls = 0;
  const lookup = createSubtitleCueLookup((cue, track) => {
    calls++;
    return { startMs: cue.startMs + track.offsetMs, endMs: cue.endMs + track.offsetMs };
  });
  const track = { offsetMs: 500, cues: Array.from({ length: 4000 }, (_, i) => ({
    id: i, startMs: i * 1200, endMs: i * 1200 + 950,
  })) };
  for (let i = 0; i < 2000; i++) {
    const at = 3_000_000 + i * 400;
    const expected = track.cues.find((cue) => at >= cue.startMs + track.offsetMs && at <= cue.endMs + track.offsetMs) || null;
    assert.equal(lookup(track, at), expected);
  }
  assert.equal(calls, track.cues.length, "offsets are computed once instead of on every displayed frame");
  track.offsetMs += 100;
  lookup(track, 3_000_100);
  assert.equal(calls, 2 * track.cues.length, "manual subtitle timing edits invalidate indexed frame bounds");
  assert.match(app, /const indexedActiveSubtitleCue = createSubtitleCueLookup\(cuePlaybackBounds\)/);
  assert.match(app, /function getActiveCue\(track, currentMs = state\.currentMs\) \{\s*return indexedActiveSubtitleCue\(track, currentMs\);/);
});
