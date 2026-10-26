import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../frontend/styles/styles.css", import.meta.url), "utf8");
const between = (a, b) => {
  const start = app.indexOf(a);
  const end = app.indexOf(b, start + a.length);
  assert.ok(start >= 0 && end > start, `Missing source region ${a}`);
  return app.slice(start, end);
};

test("Watch anime card has no outside box and places editable local tracking beneath the facts", () => {
  assert.match(css, /\.watch-title-info\s*\{[^}]*padding:0; border:0; border-radius:0; background:transparent;/);
  assert.match(css, /\.watch-info-tracking\s*\{[^}]*border-top:1px solid #222;/);
  assert.match(app, /class="watch-info-facts"[\s\S]*?<\/dl>\s*\$\{tracking\}/);
  assert.match(app, /data-watch-tracking-status aria-label="Edit LVL tracking status"/);
  assert.match(app, /AniList status \(last synced\)/, "the local selector must not impersonate remote AniList data");
  assert.match(app, /"#watch-title-info"\)\?\.addEventListener\("change",/, "tracking status selector has a save handler");
});

test("Local tracking edits persist on every source, while autoplay promotion only changes Planning", () => {
  const statusLabels = { CURRENT: "Watching", REPEATING: "Rewatching", COMPLETED: "Completed",
    PLANNING: "Plan to watch", PAUSED: "Paused", DROPPED: "Dropped" };
  const sourceA = { id: "a", title: "Jujutsu Kaisen", seriesKey: "jjk" };
  const sourceB = { id: "b", title: "Jujutsu Kaisen", seriesKey: "jjk" };
  const series = { key: "jjk", mediaKind: "anime", sources: [sourceA, sourceB] };
  let saved = 0;
  let renders = 0;
  const ctx = vm.createContext({
    ANILIST_STATUS_LABELS: statusLabels,
    state: { library: [sourceA, sourceB], currentSource: { libraryId: "a" } },
    seriesAniList: () => ({ status: "PLANNING" }),
    buildLibrarySeries: () => [series],
    libraryEntryById: (id) => id === "a" ? sourceA : sourceB,
    librarySeriesKey: () => "jjk",
    saveLibrary: () => { saved++; },
    renderWatchInfo: () => { renders++; },
  });
  vm.runInContext(between("function watchTrackingStatus(", "\nfunction renderWatchInfo("), ctx);
  const get = () => vm.runInContext("watchTrackingStatus", ctx)(series);
  const set = (status, automatic = false) => vm.runInContext("setWatchTrackingStatus", ctx)("jjk", status, { automatic });
  assert.equal(get(), "PLANNING");
  assert.equal(set("CURRENT", true), true);
  assert.equal(get(), "CURRENT");
  assert.equal(sourceB.trackingStatus, "CURRENT");
  assert.equal(saved, 1);
  assert.equal(renders, 1);
  assert.equal(set("DROPPED"), true);
  assert.equal(get(), "DROPPED");
  assert.equal(set("CURRENT", true), false, "playing again does not override Dropped");
  assert.equal(get(), "DROPPED");
  assert.equal(set("PAUSED"), true);
  assert.equal(set("CURRENT", true), false, "playing again does not override Paused");
  assert.equal(set("COMPLETED"), true);
  assert.equal(set("CURRENT", true), false, "do not undo Completed");
  assert.equal(set("REPEATING"), true);
  assert.equal(set("CURRENT", true), false, "do not undo Rewatching");
  assert.equal(set("BOGUS"), false);
  assert.equal(saved, 5);
  assert.equal(renders, 5);
});

test("Playback promotes an anime from Planning only after genuine progress while playing", () => {
  const episode = { code: "S01E02", fileIndex: 3 };
  const entry = { id: "a", title: "Jujutsu Kaisen", seriesKey: "jjk", episodes: [episode] };
  const series = { key: "jjk", mediaKind: "anime", sources: [entry] };
  const state = { mediaDurationMs: 1_440_000, currentMs: 6_000, pendingSeek: null, library: [entry] };
  const video = { paused: false };
  let currentStatus = "PLANNING";
  const promotions = [];
  const context = vm.createContext({
    state, video, frame: { classList: { contains: () => true } },
    absolutePlaybackSeconds: () => state.currentMs / 1000,
    currentLibraryEpisode: () => ({ entry, episode }),
    explicitlyUnwatchedChapter: () => false,
    librarySeriesKey: () => "jjk",
    buildLibrarySeries: () => [series],
    watchTrackingStatus: () => currentStatus,
    setWatchTrackingStatus: (key, status, options) => { promotions.push([key, status, options.automatic]); currentStatus = status; },
    $: () => null,
    saveLibrary: () => {},
  });
  vm.runInContext(between("let watchProgressSavedAt = 0;", "\nfunction trackSyncKey("), context);
  const record = vm.runInContext("recordWatchProgress", context);
  video.paused = true;
  record();
  assert.equal(promotions.length, 0, "paused playback does not promote");
  video.paused = false;
  state.currentMs = 4_000;
  record();
  assert.equal(promotions.length, 0, "starting/loading does not promote");
  state.currentMs = 6_000;
  record();
  assert.deepEqual(promotions, [["jjk", "CURRENT", true]]);
  record();
  assert.equal(promotions.length, 1, "subsequent play events do not re-promote");
});
