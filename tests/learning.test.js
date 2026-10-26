import test from "node:test";
import assert from "node:assert/strict";
import { learningPresetBundle } from "../learning/presets.js";
import { alignCueArtifacts, processCueArtifact } from "../learning/subtitle-processing.js";

test("learning presets expose requested tier sizes", async () => {
  const bundle = await learningPresetBundle("ES", { wordSize: 100, phraseSize: 100 });
  assert.equal(bundle.language, "ES");
  assert.equal(bundle.words.length, 100);
  assert.equal(bundle.phrases.length, 100);
  assert.equal(bundle.words[0].rank, 1);
  assert.equal(bundle.phrases[99].rank, 100);
});

test("subtitle artifact processing normalizes and fingerprints cues", () => {
  const artifact = processCueArtifact({
    id: "target",
    language: "ES",
    cues: [
      { id: "a", startMs: 1000, endMs: 2000, text: "¡Hola!" },
      { id: "b", startMs: 3000, endMs: 4000, text: "¿Cómo estás?" },
    ],
  });
  assert.equal(artifact.cueCount, 2);
  assert.equal(artifact.cues[0].normalizedText, "hola");
  assert.match(artifact.fingerprint, /^[a-f0-9]{24}$/);
});

test("subtitle alignment finds a stable constant offset and combined timeline", () => {
  const result = alignCueArtifacts([
    {
      id: "base",
      language: "EN",
      exactMedia: true,
      cues: [
        { id: "b1", startMs: 1000, endMs: 2000, text: "Hello" },
        { id: "b2", startMs: 4000, endMs: 5000, text: "Again" },
        { id: "b3", startMs: 7000, endMs: 8000, text: "Bye" },
      ],
    },
    {
      id: "target",
      language: "ES",
      cues: [
        { id: "t1", startMs: 0, endMs: 1000, text: "Hola" },
        { id: "t2", startMs: 3000, endMs: 4000, text: "Otra vez" },
        { id: "t3", startMs: 6000, endMs: 7000, text: "Adiós" },
      ],
    },
  ]);
  const target = result.tracks.find((track) => track.id === "target");
  assert.equal(result.referenceTrackId, "base");
  assert.equal(target.offsetMs, 1000);
  assert.equal(target.rejected, false);
  assert.equal(result.timeline.length, 3);
  assert.equal(result.timeline[0].items.length, 2);
});

test("subtitle alignment adapts across a mid-episode cut instead of forcing one offset", () => {
  let cursor = 0;
  const candidateCues = Array.from({ length: 48 }, (_, index) => {
    cursor += [3100, 4700, 2600, 5900, 3800, 5200][index % 6];
    return { id: `t${index}`, startMs: cursor, endMs: cursor + 1400, text: `Target ${index}` };
  });
  const referenceCues = candidateCues.map((cue, index) => ({
    id: `b${index}`,
    startMs: cue.startMs + (index < 24 ? 1000 : 9000),
    endMs: cue.endMs + (index < 24 ? 1000 : 9000),
    text: `Base ${index}`,
  }));
  const result = alignCueArtifacts([
    { id: "base", language: "EN", exactMedia: true, cues: referenceCues },
    { id: "target", language: "JA", cues: candidateCues },
  ]);
  const target = result.tracks.find((track) => track.id === "target");
  assert.equal(target.rejected, false);
  assert.equal(target.mode, "piecewise-step");
  assert.ok(target.anchors.length >= 2);
  assert.ok(target.anchors.some((anchor) => Math.abs(anchor.offsetMs - 1000) <= 500));
  assert.ok(target.anchors.some((anchor) => Math.abs(anchor.offsetMs - 9000) <= 500));
  assert.equal(result.alignmentModel.cutJumps, true);
  const pairedUnits = result.timeline.filter((unit) => unit.items.length === 2);
  assert.ok(pairedUnits.length >= 40);
});

test("subtitle alignment corrects gradual clock-rate drift", () => {
  let cursor = 0;
  const candidateCues = Array.from({ length: 72 }, (_, index) => {
    cursor += [2500, 4100, 3300, 5700, 2900, 4600, 3600][index % 7];
    return { id: `t${index}`, startMs: cursor, endMs: cursor + 1300, text: `Target ${index}` };
  });
  const referenceCues = candidateCues.map((cue, index) => ({
    id: `b${index}`,
    startMs: Math.round(cue.startMs * 1.04 + 3000),
    endMs: Math.round(cue.endMs * 1.04 + 3000),
    text: `Base ${index}`,
  }));
  const result = alignCueArtifacts([
    { id: "base", language: "EN", exactMedia: true, cues: referenceCues },
    { id: "target", language: "JA", cues: candidateCues },
  ]);
  const target = result.tracks.find((track) => track.id === "target");
  assert.equal(target.rejected, false);
  assert.equal(target.mode, "linear-drift");
  assert.equal(result.alignmentModel.drift, "linear");
  assert.equal(target.matchedPairs, 72);
  assert.ok(Math.abs(target.anchors[0].offsetMs - 3100) <= 100);
  assert.ok(Math.abs(target.anchors.at(-1).offsetMs - 13944) <= 150);
});

test("subtitle alignment rejects unrelated sparse timing patterns", () => {
  const referenceCues = Array.from({ length: 30 }, (_, index) => ({
    id: `b${index}`, startMs: index * 7000 + 1000, endMs: index * 7000 + 2200, text: `Base ${index}`,
  }));
  const candidateCues = Array.from({ length: 30 }, (_, index) => ({
    id: `t${index}`, startMs: index * 11300 + 45000, endMs: index * 11300 + 46300, text: `Target ${index}`,
  }));
  const result = alignCueArtifacts([
    { id: "base", language: "EN", exactMedia: true, cues: referenceCues },
    { id: "target", language: "JA", cues: candidateCues },
  ]);
  const target = result.tracks.find((track) => track.id === "target");
  assert.equal(target.rejected, true);
});
