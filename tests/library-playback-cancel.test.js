import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../app.js", import.meta.url), "utf8");
function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `Missing production seam: ${start}`);
  return source.slice(from, to);
}

const resolverSource = section("async function resolveTorrentMagnet(", "\nasync function playLibraryEpisode(");
const librarySource = section("async function playLibraryEpisode(", "\nasync function resolveMagnet(");
const catalogSource = section("async function addCatalogChapterSource(", "\nfunction catalogFetchAllLabel(");

test("cancelling a magnet read aborts its initial HTTP POST, not just later polling", async () => {
  const controller = new AbortController();
  let initialSignal;
  let requests = 0;
  const context = vm.createContext({
    AbortSignal, Date, setTimeout, clearTimeout,
    postJson: async (_url, _body, options) => {
      requests++;
      initialSignal = options.signal;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("Request aborted")), { once: true });
      });
    },
    fetchJson: () => { throw new Error("Unexpected poll after cancellation"); },
  });
  vm.runInContext(resolverSource, context);
  const resolveMagnet = vm.runInContext("resolveTorrentMagnet", context);
  const pending = resolveMagnet("magnet:?xt=urn:btih:test", null, { signal: controller.signal });
  assert.equal(requests, 1);
  assert.ok(initialSignal, "Initial POST should receive a composed AbortSignal");
  controller.abort("navigated away");
  await assert.rejects(pending, /aborted/);
  assert.equal(initialSignal.aborted, true);
  assert.equal(requests, 1);
});

test("abort during unresolved magnet polling prevents a stale GET and UI update", async () => {
  const controller = new AbortController();
  let polled = 0;
  let progress = 0;
  const context = vm.createContext({
    AbortSignal, Date, setTimeout, clearTimeout,
    postJson: async () => ({ id: "stale", state: "resolving" }),
    fetchJson: async () => { polled++; throw new Error("Poll from obsolete source"); },
  });
  vm.runInContext(resolverSource, context);
  const resolveMagnet = vm.runInContext("resolveTorrentMagnet", context);
  await assert.rejects(resolveMagnet("magnet:?xt=urn:btih:stale", () => {
    progress++;
    controller.abort("different episode selected");
  }, { signal: controller.signal }), { name: "AbortError" }).catch(async error => {
    // Browsers may use the caller's abort reason as-is, rather than a DOMException.
    assert.match(String(error), /abort|different episode/i);
  });
  assert.equal(progress, 1);
  assert.equal(polled, 0);
});

test("selecting a new Library episode cancels the previous resolution but plays the newest", async () => {
  const entry = { id: "series", magnet: "magnet:?xt=urn:btih:series", episodes: [
    { fileIndex: 1, code: "S01E01" }, { fileIndex: 2, code: "S01E02" },
  ] };
  const requests = [];
  const loaded = [];
  const statuses = { "#media-status": { textContent: "" } };
  const context = vm.createContext({
    AbortController, Number,
    libraryEntryById: () => entry,
    playbackLoadRequestId: 0,
    libraryPlaybackResolveController: null,
    preparePlayerForLibraryLoad: (_entry, episode) => loaded.push(episode.code),
    resolveTorrentMagnet: (_magnet, _progress, options) => new Promise((resolve, reject) => {
      requests.push({ options, resolve });
      options.signal.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true });
    }),
    $: key => statuses[key] || null,
    recoveryBusy: false,
    setPlayerLoading() {},
    upsertLibrarySession() {},
    playTorrentFile: async (_session, file, { requestId }) => {
      loaded.push(`played:${file.index}:${requestId}`);
      return true;
    },
    console: { error: error => { throw error; } },
  });
  vm.runInContext(librarySource, context);
  const play = vm.runInContext("playLibraryEpisode", context);
  const first = play("series", 1);
  const second = play("series", 2);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].options.signal.aborted, true);
  assert.equal(requests[1].options.signal.aborted, false);
  requests[1].resolve({ id: "new-session", files: [{ index: 2, name: "episode2.mkv" }] });
  assert.equal(await first, false, "Obsolete cancellation should be silent");
  assert.equal(await second, true);
  assert.deepEqual(loaded, ["S01E01", "S01E02", "played:2:2"]);
  assert.equal(statuses["#media-status"].textContent, "LIBRARY - RESOLVING S01E02");
  assert.equal(vm.runInContext("libraryPlaybackResolveController", context), null);
  assert.match(source, /if \(requestId === null\) \{\s*libraryPlaybackResolveController\?\.abort\("another source selected"\)/,
    "Direct torrent selection also cancels an unfinished Library resolution");
});

test("failed catalog playback releases its source; alternate source is tried and retained only if playable", async () => {
  const removed = [];
  const played = [];
  const view = { meta: { id: "tt1234567", name: "Example" }, seasons: [] };
  const chapter = { season: 1, episode: 2, name: "Episode 2" };
  const ctx = vm.createContext({
    DOMException,
    playbackLoadRequestId: 0,
    manualCatalogPlaybackId: 0,
    viewActive: () => true,
    chapterCode: () => "S01E02",
    buttonText: () => "",
    resolveTorrentMagnet: async (magnet) => ({ id: magnet, name: magnet, files: [{ index: 1, video: true, name: "episode2.mkv" }] }),
    librarySeriesKeyForCatalog: () => "series",
    catalogMediaKind: () => "anime",
    chapterSourceMeta: () => ({}),
    upsertLibrarySession: (session) => ({ id: session.id }),
    releaseTorrentSession: async id => removed.push(id),
    playLibraryEpisode: async id => { played.push(id); ctx.playbackLoadRequestId++; return id === "valid"; },
    $: () => ({ classList: { contains: () => false } }),
    catalogSeriesView: null,
    updateLibrarySummary() {},
  });
  vm.runInContext(catalogSource, ctx);
  const add = vm.runInContext("addCatalogChapterSource", ctx);
  await assert.rejects(add(view, chapter, { magnet: "oversized", fileIdx: 1 }, { play: true, quiet: true }),
    /Couldn't start S01E02/);
  const result = await add(view, chapter, { magnet: "valid", fileIdx: 1 }, { play: true, quiet: true });
  assert.equal(result.id, "valid");
  assert.deepEqual(played, ["oversized", "valid"]);
  assert.deepEqual(removed, ["oversized"], "Only failed source is released; accepted source remains available");
});

test("superseded Library resolution releases an abandoned owned session with a different magnet", async () => {
  const entries = new Map([
    ["one", { id: "one", magnet: "magnet-one", episodes: [{ fileIndex: 1, code: "S01E01" }] }],
    ["two", { id: "two", magnet: "magnet-two", episodes: [{ fileIndex: 2, code: "S01E02" }] }],
  ]);
  const pending = [];
  const released = [];
  const ctx = vm.createContext({
    AbortController, Number, playbackLoadRequestId: 0,
    libraryPlaybackResolveController: null, libraryPlaybackPendingMagnet: "",
    libraryEntryById: id => entries.get(id),
    preparePlayerForLibraryLoad() {},
    resolveTorrentMagnet: (_magnet, _progress, options) => new Promise((resolve, reject) => {
      options.onSession({ id: `session-${_magnet}`, reused: false });
      pending.push({ options, resolve });
      options.signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
    }),
    releaseTorrentSession: async id => released.push(id),
    $: () => ({ textContent: "" }),
    recoveryBusy: false,
    setPlayerLoading() {},
    upsertLibrarySession() {},
    playTorrentFile: async () => true,
    console: { error: e => { throw e; } },
  });
  vm.runInContext(librarySource, ctx);
  const play = vm.runInContext("playLibraryEpisode", ctx);
  const old = play("one", 1);
  const newest = play("two", 2);
  pending[1].resolve({ id: "session-magnet-two", files: [{ index: 2, name: "second.mkv" }] });
  assert.equal(await old, false);
  assert.equal(await newest, true);
  assert.deepEqual(released, ["session-magnet-one"]);
});
