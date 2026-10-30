import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const start = app.indexOf("function stopPlaybackIfHiddenAfterNavigation(");
const end = app.indexOf("\n// restoreScroll:", start);
assert.ok(start >= 0 && end > start);

function fixture({ initialView = "watch", siteFloat = false, desktop = false, pendingDesktop = false, nativePip = false } = {}) {
  const actions = [];
  const controller = { abort(reason) { actions.push(`abort:${reason}`); } };
  const video = { pause() { actions.push("pause"); } };
  const context = vm.createContext({
    $: (selector) => selector === "#view-watch" ? { classList: { contains: () => siteFloat } } : null,
    document: { pictureInPictureElement: nativePip ? video : null },
    viewActive: (name) => name === initialView,
    video,
    floatingDesktopWindow: desktop ? {} : null,
    floatingDesktopPending: pendingDesktop,
    playbackLoadRequestId: 12,
    libraryPlaybackResolveController: controller,
    libraryPlaybackPendingMagnet: "magnet:?xt=test",
    clearBufferingTimer: () => actions.push("stop-buffering"),
    stopTransferStats: () => actions.push("stop-transfer-polling"),
    cancelTranscodeStart: () => {},
    resetRecoveryDisplay: () => actions.push("reset-diagnostics"),
  });
  vm.runInContext(app.slice(start, end), context);
  return { context, actions, run: (destination) => vm.runInContext(`stopPlaybackIfHiddenAfterNavigation(${JSON.stringify(destination)})`, context) };
}

test("Home during unresolved Watch load cancels pending work and stops invisible audio", () => {
  const f = fixture();
  f.run("home");
  assert.equal(f.context.playbackLoadRequestId, 13, "the original async source identity must be invalidated");
  assert.deepEqual(f.actions, ["abort:left player without floating playback", "pause", "stop-buffering", "stop-transfer-polling", "reset-diagnostics"]);
  assert.equal(f.context.libraryPlaybackResolveController, null);
  assert.equal(f.context.libraryPlaybackPendingMagnet, "");
  assert.match(app, /updateFloatingPlayback\(view\);\s*stopPlaybackIfHiddenAfterNavigation\(view\);/,
    "floating visibility is decided before cancellation");
  assert.match(app, /view === "watch" && state\.currentSource\?\.sessionId && !state\.transferStatsTimer\)\s*startTransferStats\(/,
    "returning to Watch restarts torrent stats polling after the hidden-view stop");
  assert.match(app, /if \(loadId !== playbackLoadRequestId[^\n]*\) return false;/,
    "a pending torrent start must refuse to autoplay after the ID changes");
});

test("Visible in-app floating and actual/pending desktop PiP are never cancelled", () => {
  for (const options of [{ siteFloat: true }, { desktop: true }, { pendingDesktop: true }, { nativePip: true }]) {
    const f = fixture(options);
    f.run("library");
    assert.deepEqual(f.actions, [], `preserve requested floating playback: ${JSON.stringify(options)}`);
    assert.equal(f.context.playbackLoadRequestId, 12);
  }
});

test("Returning to Watch or navigating elsewhere from an already hidden page does not stop playback", () => {
  const f = fixture();
  f.run("watch");
  assert.deepEqual(f.actions, []);
  const home = fixture({ initialView: "home" });
  home.run("library");
  assert.deepEqual(home.actions, []);
});

test("An awaited source startup cannot later autoplay after Home invalidated its request", async () => {
  const f = fixture();
  let finishStorageCheck;
  const waitStorage = new Promise((resolve) => { finishStorageCheck = resolve; });
  f.context.playerStorageLimit = () => waitStorage;
  const from = app.indexOf("async function playTorrentFile(");
  const to = app.indexOf("  const previousSessionId =", from);
  assert.ok(from > 0 && to > from);
  // Execute the real async entry/await/stale-ID check. An invalid request must
  // stop before any call that selects a media source or plays the video.
  vm.runInContext(app.slice(from, to) + "  return true;\n}", f.context);
  const pending = vm.runInContext("playTorrentFile({}, {length:123})", f.context);
  f.run("home");
  finishStorageCheck(0);
  assert.equal(await pending, false);
  assert.equal(f.context.playbackLoadRequestId, 14);
  assert.deepEqual(f.actions, ["abort:another source selected", "pause", "stop-buffering", "stop-transfer-polling", "reset-diagnostics"],
    "direct play supersedes the pending Library controller before Home cancels this new generation");
});
