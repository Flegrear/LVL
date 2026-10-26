import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../frontend/styles/styles.css", import.meta.url), "utf8");

function section(first, next) {
  const start = app.indexOf(first);
  const end = app.indexOf(next, start + first.length);
  assert.ok(start >= 0 && end > start, `Missing section: ${first}`);
  return app.slice(start, end);
}

test("Watch keeps playback speed and transfer totals in the player, clear of the shared header", () => {
  const header = html.slice(html.indexOf('<header id="home-topbar"'), html.indexOf("</header>"));
  const watch = html.slice(html.indexOf('<section id="view-watch"'), html.indexOf('<dialog id="player-subtitle-dialog"'));
  assert.doesNotMatch(header, /id="watch-topbar-speed"|id="speed-select"/);
  assert.match(watch, /id="player-audio-switcher"[\s\S]*id="player-transfer-stats"[\s\S]*id="compat-time"[\s\S]*id="speed-select"/);
  assert.doesNotMatch(watch, /id="player-buffered"|id="watch-autoplay-next"|id="player-quality"|id="media-quality"|id="tip-timeline"/);
  assert.match(html, /id="settings-panel-general"[\s\S]*?id="watch-autoplay-next"/);
  assert.doesNotMatch(css, /#view-watch:not\(\.is-floating\)\s*\{\s*margin-top:calc\(var\(--ui-topbar-h\) \* -1\)/);
  assert.match(watch, /id="player-transfer-stats"/);
  assert.match(watch, /id="speed-select" class="player-speed-trigger" type="button"/);
  assert.match(watch, /id="player-speed-menu" class="player-speed-menu" role="menu"/);
  assert.match(css, /\.player-speed-menu button\s*\{[^}]*background:transparent/);
  assert.match(css, /\.player-transfer-stats\s*\{[^}]*font:500 11px\/1\.2 var\(--font-sans\)/);
  assert.match(app, /textContent = `↓ \$\{formatTransferBytes\(down\)\}`/);
  assert.match(app, /textContent = `↑ \$\{formatTransferBytes\(up\)\}`/);
  assert.doesNotMatch(app, /class="watch-info-eyebrow">ABOUT THIS/);
});

test("Current video identity uses series name and numbered chapter only inside the player", () => {
  const elements = Object.fromEntries(["#media-title", "#player-now-title", "#app-topbar-view-label"].map((key) => [key, { textContent: "" }]));
  const context = { $: (key) => elements[key], viewActive: (name) => name === "watch" };
  vm.runInNewContext(section("function updatePlayerIdentity(", "\nconst storedAudioMode =")
    + '\nupdatePlayerIdentity("My Anime", { code: "S01E21", title: "Episode title" });', context);
  assert.equal(elements["#media-title"].textContent, "My Anime");
  assert.equal(elements["#player-now-title"].textContent, "My Anime: S1 E21");
  assert.equal(elements["#app-topbar-view-label"].textContent, "");
});

test("Library only tags repeated torrent files, preserving different files in a season pack", () => {
  const context = vm.createContext({});
  vm.runInContext(section("function libraryTorrentFileKey(", "\nfunction libraryCodecLabel("), context);
  const ref = (id, fileIndex, magnet = "") => ({ entry: { id, magnet }, episode: { fileIndex } });
  const hash = "a".repeat(40);
  const other = "b".repeat(40);
  const results = vm.runInContext("repeatedLibrarySourceIndexes", context)([
    ref(hash, 0), ref(hash, 0), ref(hash, 1), ref(other, 0),
    ref("some-other-entry", 0, `magnet:?xt=urn:btih:${hash}`),
    ref("some-other-entry", 1, `magnet:?xt=urn:btih:${hash}`),
    ref("unverified-entry", 0),
  ]);
  assert.deepEqual([...results], [1, 4, 5]);
  assert.equal(vm.runInContext("repeatedLibrarySourceTag", context)(true).includes("Same source/content"), true);
});
