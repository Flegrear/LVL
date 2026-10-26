import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
function slice(start, end) {
  const from = app.indexOf(start);
  const to = app.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from);
  return app.slice(from, to);
}

const lookup = slice("function explicitlyUnwatchedChapter(", "\nfunction watchEpisodeStatus(");
const resume = slice("function seriesResumePoint(", "\n// Every saved chapter");
const next = slice("function seriesNextUp(", "\nfunction seriesActivityAt(");
const chapterResume = slice("function chapterResumeMs(", "\n// The page's chapter list");

function fixture({ positionMs = 950_000, finished = false, unwatched = true, duplicate = false } = {}) {
  const episode = { fileIndex: 1, code: "S01E02", progress: { positionMs, durationMs: 1_000_000, finished, updatedAt: 300 } };
  const entry = { id: "source-a", title: "Series", seriesKey: "series", episodes: [episode], watchedChapters: {} };
  const second = { id: "source-b", title: "Series", seriesKey: "series", episodes: [], watchedChapters: { S01E02: false } };
  if (!duplicate && unwatched) entry.watchedChapters.S01E02 = false;
  const library = duplicate ? [entry, second] : [entry];
  if (!unwatched) library.forEach(item => { item.watchedChapters = {}; });
  const series = { key: "series", type: "series", sources: library, seasons: new Map() };
  const context = vm.createContext({
    state: { library },
    librarySeriesKey: value => String(value).toLowerCase(),
    libraryOrderedChapters: () => [],
    libraryChapterName: item => item.code === "S01E02" ? "S1 E2" : "",
  });
  vm.runInContext(`${lookup}\n${resume}\n${next}\n${chapterResume}`, context);
  return { episode, entry, series, next: vm.runInContext("seriesNextUp", context),
    chapter: vm.runInContext("chapterResumeMs", context), context };
}

test("unwatched near-end episode replays from start rather than an unfinishable last 5 seconds", () => {
  const f = fixture();
  const action = f.next(f.series);
  assert.equal(action.label, "Replay S1 E2");
  assert.equal(action.atMs, 0);
  assert.equal(f.chapter(f.episode.progress, f.series, "S01E02"), 0);
  assert.equal(f.episode.progress.positionMs, 950_000, "Historical resume data must stay preserved");
});

test("negative watched override on another saved source outranks stale finished progress", () => {
  const f = fixture({ finished: true, duplicate: true });
  const action = f.next(f.series);
  assert.equal(action.label, "Replay S1 E2");
  assert.equal(action.atMs, 0);
  assert.equal(f.chapter(f.episode.progress, f.series, "S01E02"), 0);
});

test("a deliberately unwatched episode still resumes its genuine mid-episode position", () => {
  const f = fixture({ positionMs: 370_000 });
  assert.equal(f.next(f.series).label, "Resume S1 E2");
  assert.equal(f.next(f.series).atMs, 365_000);
  assert.equal(f.chapter(f.episode.progress, f.series, "S01E02"), 365_000);
});

test("normal in-progress episodes remain unchanged and explicit unwatch is required for replay", () => {
  const f = fixture({ unwatched: false });
  assert.equal(f.next(f.series).label, "Resume S1 E2");
  assert.equal(f.next(f.series).atMs, 945_000);
  assert.equal(f.chapter(f.episode.progress, f.series, "S01E02"), 945_000);
});
