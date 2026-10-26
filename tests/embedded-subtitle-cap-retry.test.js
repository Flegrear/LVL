import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { subtitleWindowStart, EMBEDDED_WINDOW_SECONDS,
  embeddedSubtitleSeekStart } from "../shared/subtitles/subtitle-stream.js";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const from = app.indexOf("const embeddedSubtitleImports = new Map();");
const until = app.indexOf("\nlet initialEmbeddedSubtitleSource", from);
assert.ok(from >= 0 && until > from);
const importerCode = app.slice(from, until);

test("transient 429 FFmpeg capacity rejection retries after a few seconds, not a minute", async () => {
  let now = 100_000;
  let sent = 0;
  const source = { kind: "torrent", sessionId: "test-session", fileIndex: 1, sourceTag: "chapter" };
  const state = { currentSource: source, subtitlesVisible: true };
  const context = vm.createContext({
    state,
    Date: { now: () => now }, AbortController, TextDecoder,
    window: { setTimeout: () => 1, clearTimeout() {} },
    currentSourceTracks: () => [],
    absolutePlaybackSeconds: () => 175,
    subtitleWindowStart, embeddedSubtitleSeekStart, EMBEDDED_WINDOW_SECONDS,
    embeddedSubtitleLabel: () => "English",
    renderEmbeddedSubtitleControls() {},
    renderSubtitleWorkspace() {},
    $: () => ({ textContent: "" }),
    fetch: async () => {
      sent++;
      return { ok: false, status: 429, text: async () => '{"error":"Subtitle extractor busy"}' };
    },
  });
  vm.runInContext(importerCode, context);
  const importTrack = vm.runInContext("importEmbeddedSubtitleTrack", context);
  const meta = { streamIndex: 3, language: "en" };
  assert.equal(await importTrack(meta, null, { automatic: true, startSeconds: 175 }), false);
  assert.equal(sent, 1);
  now += 2_500;
  assert.equal(await importTrack(meta, null, { automatic: true, startSeconds: 175 }), false);
  assert.equal(sent, 1, "busy requests are still briefly rate-limited");
  now += 600;
  assert.equal(await importTrack(meta, null, { automatic: true, startSeconds: 175 }), false);
  assert.equal(sent, 2, "the new request can run shortly after the cap clears");
});

test("nonzero resume uses focused six-second subtitle extraction in both probe paths", () => {
  const calls = [...app.matchAll(/enableDefaultEmbeddedSubtitles\((?:probedMedia|media), startAtSeconds, \{ urgent: startAtSeconds >= 12 \}\)/g)];
  assert.equal(calls.length, 2, "immediate and delayed metadata both honor resume position");
  assert.match(importerCode, /focused \? embeddedSubtitleSeekStart\(seekPosition\)/,
    "urgent startup must seek a small distance before the resumed playhead");
});
