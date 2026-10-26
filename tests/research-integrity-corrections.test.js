import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const serverSource = readFileSync(new URL("../server.js", import.meta.url), "utf8");
function method(start, end, context) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `${start} must be present`);
  const environment = vm.createContext(context);
  vm.runInContext(source.slice(a, b), environment);
  const name = start.match(/\bfunction (\w+)\(/)?.[1];
  assert.ok(name);
  return vm.runInContext(name, environment);
}

test("subtitle track used for cards never replaces the active playable source", () => {
  const original = { kind: "torrent", libraryId: "hash-a", fileIndex: 1, sourceTag: "A · S01E01" };
  const state = { currentSource: original, selectedTrackId: "one", tracks: [
    { id: "one", sourceTag: original.sourceTag },
    { id: "two", sourceTag: original.sourceTag, source: { kind: "torrent", libraryId: "wrong-video", fileIndex: 22 } },
    { id: "stale", sourceTag: "B · S01E02", source: { libraryId: "wrong" } },
  ] };
  let analysis = 0;
  let renders = 0;
  const select = method("function selectSubtitleTrackForCards(", "\nfunction activeSourceTag(", {
    state,
    currentSourceTracks: () => state.tracks.filter((track) => track.sourceTag === state.currentSource.sourceTag),
    saveCurrentEpisodeAnalysis: () => { analysis += 1; },
    renderSubtitleWorkspace: () => { renders += 1; },
  });
  assert.equal(select(state.tracks[1]), true);
  assert.equal(state.selectedTrackId, "two");
  assert.equal(state.currentSource, original, "source object identity, file index and playback URL are unchanged");
  assert.equal(select(state.tracks[2]), false, "stale episode track cannot be selected");
  assert.equal(state.selectedTrackId, "two");
  assert.equal(analysis, 1);
  assert.equal(renders, 1);
});

test("torrent source refresh retains verified AniList association and watched source progress", () => {
  const previous = {
    id: "hash-a", title: "Show", displayTitle: "Show", seriesKey: "show",
    anilist: { showId: "anilist:9", seasons: [{ season: 1, anilistId: 9, progress: 6 }] },
    anilistManualLinks: [{ userId: 12, anilistId: 9, season: 1 }],
    anilistAutoLinks: [{ userId: 12, anilistId: 9, season: 1 }],
    externalSource: "ANILIST", externalId: "9", watchedChapters: { S01E01: false },
    episodes: [{ fileIndex: 0, code: "S01E01", progress: { positionMs: 800, durationMs: 1000, finished: false },
      analysis: { words: ["hello"] }, subtitleSync: { EN: 100 } }],
  };
  const state = { library: [previous], autoArtwork: false };
  let saves = 0;
  const upsert = method("function upsertLibrarySession(", "\nfunction saveCurrentEpisodeAnalysis(", {
    state, crypto: { randomUUID: () => "unused" },
    libraryEntryById: (id) => state.library.find((item) => item.id === id),
    libraryFileScope: () => null,
    sortedVideoFiles: (files) => files,
    partitionTorrentVideos: (files) => ({ primary: files, extras: [] }),
    normalizeCollectionTitle: () => "Show",
    buildLibrarySeries: () => [],
    librarySeriesKey: (name) => name.toLowerCase(),
    episodeIdentity: () => ({ code: "S01E01", title: "Episode 1" }),
    sourceTagFor: () => "Show · S01E01",
    normalizeLibrarySourceMeta: (_incoming, existing) => existing,
    saveLibrary: () => { saves += 1; },
    $: () => null,
    updateLibrarySummary: () => {},
    Date,
  });
  const next = upsert({ infoHash: "hash-a", name: "Show", files: [{ index: 0, name: "Show.S01E01.mkv", length: 2000 }] });
  assert.equal(saves, 1);
  assert.deepEqual(next.anilist, previous.anilist);
  assert.deepEqual(next.anilistManualLinks, previous.anilistManualLinks);
  assert.deepEqual(next.anilistAutoLinks, previous.anilistAutoLinks);
  assert.equal(next.externalSource, "ANILIST");
  assert.equal(next.watchedChapters.S01E01, false);
  assert.equal(next.episodes[0].progress.positionMs, 800);
  assert.equal(next.episodes[0].subtitleSync.EN, 100);
  assert.deepEqual(next.episodes[0].analysis.words, ["hello"]);
});

test("importing an old backup only adds new titles and cards, never resets local learning data", () => {
  const liveEpisode = { fileIndex: 0, code: "S01E01", progress: { finished: true } };
  const current = { id: "live", displayTitle: "Current", watchedChapters: { S01E01: true }, episodes: [liveEpisode], anilist: { showId: "1" } };
  const state = { library: [current], cards: [{ id: "keep", front: "new" }], known: new Set(["known-now"]),
    learningExposure: { word: { encounters: 7 } }, testResults: [{ id: "new-test", score: 100 }], homeLoaded: false };
  let librarySaves = 0;
  const merge = method("function mergeImportedLibrary(", "\n// Your AniList list", {
    state, discardedAutoCardKeys: new Set(), crypto: { randomUUID: () => "random" },
    persistDiscardedAutoCardKeys: () => {}, saveLearningExposure: () => {}, saveTestResults: () => {},
    migrateLearningState: () => {}, backfillPersistedChapterAutoCards: () => {},
    saveLibrary: () => { librarySaves += 1; }, saveState: () => {},
    $: () => null, updateLibrarySummary: () => {}, renderStats: () => {}, Date,
  });
  const count = merge({ library: [
    { id: "live", displayTitle: "Old", title: "Old", watchedChapters: { S01E01: false }, episodes: [] },
    { id: "added", displayTitle: "Backup title", title: "Backup title", episodes: [] },
  ], cards: [{ id: "keep", front: "old" }, { id: "add-card", front: "new-from-backup" }],
  known: ["known-then"], learningExposure: { word: { encounters: 1 }, other: { encounters: 3 } },
  testResults: [{ id: "new-test", score: 0 }, { id: "old-test", score: 80 }] });
  assert.equal(count, 1);
  assert.equal(librarySaves, 1);
  assert.equal(state.library.find((entry) => entry.id === "live").displayTitle, "Current");
  assert.deepEqual(state.library.find((entry) => entry.id === "live").episodes, [liveEpisode]);
  assert.equal(state.library.find((entry) => entry.id === "live").anilist.showId, "1");
  assert.equal(state.cards.find((card) => card.id === "keep").front, "new");
  assert.ok(state.cards.find((card) => card.id === "add-card"));
  assert.deepEqual([...state.known].sort(), ["known-now", "known-then"]);
  assert.equal(state.learningExposure.word.encounters, 7);
  assert.equal(state.learningExposure.other.encounters, 3);
  assert.equal(state.testResults.find((result) => result.id === "new-test").score, 100);
  assert.equal(state.testResults.find((result) => result.id === "old-test").score, 80);
});

test("a potentially destructive clip quota reduction needs a second explicit confirmation", async () => {
  const calls = [];
  const statuses = [];
  let confirm = false;
  const save = method("async function saveStorageLimits(", "\n// The player storage limit", {
    postJson: async (_url, changes) => {
      calls.push(changes);
      if (!changes.confirmClipEviction) throw Object.assign(new Error("preview"), { status: 409,
        data: { error: "clip_budget_confirmation_required", usedBytes: 3_000_000_000,
          requestedBytes: 1_000_000_000, clipCount: 14 } });
      return { limits: { playerBytes: 22_000_000_000 } };
    },
    window: { confirm: () => confirm },
    formatStorage: (bytes) => `${Math.round(bytes / 1_000_000_000)} GB`,
    setToolStatus: (_selector, message) => statuses.push(message),
    paintStorageReport: () => {}, playerStorageLimitCache: {}, Date,
  });
  await save({ clipGB: 1 });
  assert.equal(calls.length, 1, "declined consent causes no repeated write");
  assert.ok(statuses.at(-1).includes("unchanged"));
  confirm = true;
  await save({ clipGB: 1 });
  assert.equal(calls.length, 3);
  assert.equal(calls[2].confirmClipEviction, true);
  assert.equal(statuses.at(-1), "Saved");
});

test("torrent inactivity expiry never destroys an active long-running stream", () => {
  const start = serverSource.indexOf("function scheduleSessionExpiry(");
  const end = serverSource.indexOf("\n// How much of each stretch", start);
  assert.ok(start >= 0 && end > start);
  const timers = new Map();
  let nextId = 0;
  let deleted = 0;
  const environment = vm.createContext({
    TORRENT_SESSION_TTL_MS: 30 * 60_000,
    setTimeout: (callback, ms) => {
      assert.equal(ms, 30 * 60_000);
      const id = ++nextId;
      timers.set(id, callback);
      return { id, unref() {} };
    },
    clearTimeout: (timer) => { if (timer) timers.delete(timer.id); },
    removeTorrentSession: async () => { deleted += 1; },
  });
  vm.runInContext(serverSource.slice(start, end), environment);
  const schedule = vm.runInContext("scheduleSessionExpiry", environment);
  const session = { id: "live", openStreams: 1 };
  schedule(session);
  assert.equal(timers.size, 1);
  [...timers.values()][0]();
  assert.equal(deleted, 0, "active playback survives initial 30-minute expiry");
  assert.equal(timers.size, 1, "new expiry is scheduled while video remains open");
  session.openStreams = 0;
  [...timers.values()][0]();
  assert.equal(deleted, 1, "idle session is cleaned up after its later deadline");
});
