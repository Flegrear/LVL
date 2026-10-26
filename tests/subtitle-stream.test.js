import test from "node:test";
import assert from "node:assert/strict";
import { subtitleWindowStart, completedWebVttText, embeddedSubtitleCovers, embeddedSubtitleCoverageEnd, embeddedSubtitleSeekStart, mergeSubtitleWindows, embeddedTrackMatchesSource } from "../shared/subtitles/subtitle-stream.js";

test("focused embedded seek only caches its actual offset range, retaining legacy aligned windows", () => {
  assert.equal(embeddedSubtitleSeekStart(175.8), 169);
  assert.equal(embeddedSubtitleSeekStart(5), 0);
  const track = { embeddedCompletedWindows: [0], embeddedCompletedRanges: [{ start: 539, end: 719 }] };
  assert.equal(embeddedSubtitleCovers(track, 178), true);
  assert.equal(embeddedSubtitleCovers(track, 180), false);
  assert.equal(embeddedSubtitleCovers(track, 538), false);
  assert.equal(embeddedSubtitleCovers(track, 539), true);
  assert.equal(embeddedSubtitleCovers(track, 718.999), true);
  assert.equal(embeddedSubtitleCovers(track, 719), false);
  assert.equal(embeddedSubtitleCoverageEnd(track, 171), 180);
  assert.equal(embeddedSubtitleCoverageEnd(track, 700), 719);
  assert.equal(embeddedSubtitleCoverageEnd(track, 719), null);
});

test("embedded subtitle windows follow the playback position", () => {
  assert.equal(subtitleWindowStart(0), 0);
  assert.equal(subtitleWindowStart(179), 0);
  assert.equal(subtitleWindowStart(181), 180);
  assert.equal(subtitleWindowStart(1911), 1800);
});

test("streaming subtitle parser waits until the whole cue has arrived", () => {
  const first = "WEBVTT\n\n00:03:05.000 --> 00:03:07.000\nHel";
  assert.equal(completedWebVttText(first), "WEBVTT\n\n");
  const complete = first + "lo there\n\n00:03:11.000 --> 00:03:12.000\nWor";
  assert.equal(completedWebVttText(complete), "WEBVTT\n\n00:03:05.000 --> 00:03:07.000\nHello there\n\n");
  assert.equal(completedWebVttText(complete, true).endsWith("\n\n"), true);
});

test("embedded cue windows combine across seeks without duplicates and keep chronological order", () => {
  const first = [{ startMs: 180_500, endMs: 182_000, text: "Hello" }];
  const second = [{ ...first[0] }, { startMs: 360_000, endMs: 361_000, text: "Again" }];
  const merged = mergeSubtitleWindows(first, second, "embedded");
  assert.equal(merged.length, 2);
  assert.equal(merged[0].startMs, 180500);
  assert.equal(merged[1].startMs, 360000);
  assert.equal(mergeSubtitleWindows(merged, second, "embedded").length, 2);
});

test("embedded subtitle stream belongs to its media file, not a same-title release with the same stream number", () => {
  const source = {
    kind: "torrent", sourceTag: "Show · S01E01", libraryId: "aaaa", sessionId: "old",
    fileIndex: 2, fileName: "Show.S01E01.mkv",
  };
  const track = { origin: "embedded", embeddedStreamIndex: 3, source };
  assert.equal(embeddedTrackMatchesSource(track, {
    ...source, sessionId: "new",
  }), true, "reopened session for same torrent/file keeps its embedded captions");
  assert.equal(embeddedTrackMatchesSource(track, {
    ...source, libraryId: "bbbb", sessionId: "new",
  }), false, "same title/stream number from a different torrent must not reuse captions");
  assert.equal(embeddedTrackMatchesSource(track, {
    ...source, fileIndex: 1,
  }), false, "different episode file must not reuse captions");
  assert.equal(embeddedTrackMatchesSource(track, {
    ...source, fileName: "Show.S01E01.DifferentCut.mkv",
  }), false, "different media file name in same torrent must not reuse captions");
  assert.equal(embeddedTrackMatchesSource({ ...track, source: { ...source, fileIndex: null } }, {
    ...source, fileIndex: 0,
  }), false, "a missing original file index is not interchangeable with episode index zero");
  assert.equal(embeddedTrackMatchesSource(track, {
    ...source, fileIndex: "",
  }), false, "a blank requested file index must not select the first episode");
  assert.equal(embeddedTrackMatchesSource(track, {
    ...source, fileIndex: Number.MAX_SAFE_INTEGER + 1,
  }), false);
});
