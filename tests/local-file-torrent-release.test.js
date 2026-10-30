import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const begin = app.indexOf('$("#video-input").addEventListener("change",');
const end = app.indexOf('\n$("#subtitle-input").addEventListener', begin);
assert.ok(begin > 0 && end > begin);

test("opening a local video invalidates pending torrent work and releases its session", () => {
  const previous = { kind: "torrent", sessionId: "abandoned", fileIndex: 1 };
  const state = { currentSource: previous, currentMediaProbe: { audioTracks: [{ language: "Japanese" }] }, selectedAudioTrack: 2 };
  const actions = [];
  let change;
  const ctx = vm.createContext({
    state, watchPendingSelection: "episode", playbackLoadRequestId: 7,
    libraryPlaybackPendingMagnet: "magnet:old",
    libraryPlaybackResolveController: { abort(reason) { actions.push(`abort:${reason}`); } },
    $: () => ({ addEventListener(_name, listener) { change = listener; } }),
    setWatchTheaterMode() {},
    URL: { createObjectURL: () => "blob:local-file" },
    normalizeCollectionTitle: () => "Test Episode",
    setPlayerLoadingTitle() {}, stopTransferStats() {}, updateTransferStats() {},
    resetAudioSync() {},
    releaseTorrentSession(sessionId) {
      actions.push(`release:${sessionId}:${state.currentSource.kind}`);
      return Promise.resolve();
    },
    applyLanguagePreferencesToTracks() {}, updatePlayerIdentity() {},
    setMediaSource(media) { actions.push(`play:${media.src}`); },
    switchView() {}, renderWatchChapters() {},
  });
  vm.runInContext(app.slice(begin, end), ctx);
  const event = { target: { files: [{ name: "Test Episode.mkv" }], value: "test" } };
  change(event);
  assert.equal(state.currentSource.kind, "local");
  assert.equal(state.currentMediaProbe, null, "new local video must not show the previous torrent's audio tracks");
  assert.equal(state.selectedAudioTrack, 0);
  assert.equal(ctx.playbackLoadRequestId, 8);
  assert.equal(ctx.libraryPlaybackResolveController, null);
  assert.equal(ctx.libraryPlaybackPendingMagnet, "");
  assert.equal(event.target.value, "");
  assert.deepEqual(actions, ["abort:local file selected", "release:abandoned:local", "play:blob:local-file"]);
});
