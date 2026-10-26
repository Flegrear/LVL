import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../frontend/styles/styles.css", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

test("Subtitle modal uses an accessible upper-right X, not an inline Close action", () => {
  const dialog = html.slice(html.indexOf('<dialog id="player-subtitle-dialog"'),
    html.indexOf("</dialog>", html.indexOf('<dialog id="player-subtitle-dialog"')));
  assert.match(dialog, /id="subtitle-manager-close" class="dialog-close subtitle-dock-close"[^>]*aria-label="Close subtitles"[^>]*>×<\/button>/);
  assert.ok(dialog.indexOf('id="subtitle-dock-style"') < dialog.indexOf('id="subtitle-manager-close"'),
    "Close button follows the actions and is positioned at the header corner");
  assert.doesNotMatch(dialog, />Close<\/button>/, "no extra inline Close text action");
  assert.match(css, /\.player-subtitle-dialog \.subtitle-dock-head\s*\{[^}]*position:sticky;[^}]*padding-right:58px;/,
    "header actions reserve a clear space for the close button");
  assert.match(css, /\.player-subtitle-dialog \.subtitle-dock-close\s*\{[^}]*top:11px; right:12px;/);
  assert.match(app, /\$\("#subtitle-manager-close"\)\?\.addEventListener\("click", \(\) => \$\("#player-subtitle-dialog"\)\?\.close\(\)\)/,
    "X activates the existing modal close path");
});

test("Watch lists every catalog special without putting specials first in autoplay order", () => {
  const start = app.indexOf("function catalogChapterListFrom(meta) {");
  const end = app.indexOf("\n// Catalog art", start);
  assert.ok(start >= 0 && end > start);
  const sandbox = vm.createContext({});
  vm.runInContext(app.slice(start, end), sandbox);
  const from = vm.runInContext("catalogChapterListFrom", sandbox);
  const specialEpisodes = Array.from({ length: 26 }, (_, index) => ({ episode: index + 1, name: `Special ${index + 1}` }));
  const regularEpisodes = Array.from({ length: 13 }, (_, index) => ({ episode: index + 1, name: `Episode ${index + 1}` }));
  const result = from({ seasons: [
    { season: 0, count: 26, episodes: specialEpisodes },
    { season: 1, count: 13, episodes: regularEpisodes },
  ] });
  assert.deepEqual(Array.from(result.seasons, (item) => [item.season, item.episodes.length]), [[0, 26], [1, 13]]);
  assert.equal(result.chapters.length, 13);
  assert.ok(result.chapters.every((episode) => episode.season === 1));
  assert.match(app, /for \(const season of cached\.seasons \|\| \[\]\)/,
    "Watch must display both regular and catalog Specials");
  assert.match(app, /season === 0 \? "Specials" : `Season \$\{season\}`/);
});

test("subtitle manager closes on outside backdrop clicks only, not when clicking contents", () => {
  const start = app.indexOf('$("#player-subtitle-dialog")?.addEventListener("click", (event) => {');
  const end = app.indexOf('\n$("#player-subtitle-dialog")?.addEventListener("close"', start);
  assert.ok(start >= 0 && end > start);
  let callback = null;
  let closes = 0;
  const dialog = { close: () => { closes += 1; }, getBoundingClientRect: () => ({ left: 100, top: 100, right: 300, bottom: 300 }) };
  vm.runInNewContext(app.slice(start, end), { $: () => ({ addEventListener: (_type, cb) => { callback = cb; } }) });
  assert.equal(typeof callback, "function");
  callback({ currentTarget: dialog, target: { nested: true }, clientX: 0, clientY: 0 });
  callback({ currentTarget: dialog, target: dialog, clientX: 175, clientY: 195 });
  assert.equal(closes, 0, "Inside text, controls, and the dialog surface remain open");
  callback({ currentTarget: dialog, target: dialog, clientX: 50, clientY: 195 });
  assert.equal(closes, 1, "Clicking the modal backdrop closes it");
  for (const [clientX, clientY] of [[305, 195], [150, 85], [150, 310]]) {
    callback({ currentTarget: dialog, target: dialog, clientX, clientY });
  }
  assert.equal(closes, 4, "Outside clicks close on any side of the subtitle modal");
});

test("completed episodes have an unmistakable light selection while playing remains distinct", () => {
  assert.match(css, /\.watch-episode\.is-watched:not\(\.is-current\) \.watch-episode__shell\s*\{\s*background:#e7e7e7;\s*color:#121212;/);
  assert.match(css, /\.watch-episode\.is-current\.is-watched \.watch-episode__shell\s*\{[^}]*border-color:#eee;/);
  assert.match(app, /watch-episode\$\{current \? " is-current" : ""\}\$\{status\.watched \? " is-watched" : ""\}/);
});

test("loading identity guards follow the saved title but never render a redundant name", () => {
  const start = app.indexOf('let playerLoadingLibraryId = "";');
  const end = app.indexOf("\n// Loading stages", start);
  assert.ok(start >= 0 && end > start);
  const context = vm.createContext({});
  vm.runInContext(app.slice(start, end), context);
  const setTitle = vm.runInContext("setPlayerLoadingTitle", context);
  setTitle({ id: "lord", displayTitle: "Lord of Mysteries", coverUrl: "https://images.example/saved.jpg", catalogId: "tt28618556" });
  assert.equal(vm.runInContext("playerLoadingLibraryId", context), "lord");
  setTitle({ id: "different", title: "Different series", catalogId: "tt99999" });
  assert.equal(vm.runInContext("playerLoadingLibraryId", context), "different");
  setTitle(null, "Standalone film");
  assert.equal(vm.runInContext("playerLoadingLibraryId", context), "");
  assert.match(app, /function preparePlayerForLibraryLoad\([\s\S]*?setPlayerLoadingTitle\(entry\)/);
  assert.match(app, /function setCurrentTorrentSource\([\s\S]*?setPlayerLoadingTitle\(entry, session\.name\)/);
});

test("minimal progress fills with streaming stages and an older hide timer cannot hide the next source", () => {
  const begin = app.indexOf("let playerLoadingHideTimer = 0;");
  const end = app.indexOf("\nfunction updateLoadingTransferDetail(", begin);
  const finishBegin = app.indexOf("function finishPlayerLoading() {");
  const finishEnd = app.indexOf("\nfunction clearPlayerControlsHideTimer()", finishBegin);
  assert.ok(begin >= 0 && end > begin && finishBegin >= 0 && finishEnd > finishBegin);
  const vars = {};
  const states = new Set();
  const elements = { "#video-loading": { hidden: true,
    classList: { toggle: (key, enabled) => enabled ? states.add(key) : states.delete(key),
      contains: (key) => states.has(key) }, style: {
    setProperty: (key, value) => { vars[key] = value; },
  } }, "#video-loading-actions": { hidden: true },
  "#video-loading-title": { textContent: "" } };
  let timerId = 0;
  const timers = new Map();
  const state = { loadingProgress: 0, loadingDetail: "", loadingTransferDetail: "" };
  const sandbox = vm.createContext({ state, $: (key) => elements[key], currentRecoveryKey: () => null,
    recoveryDisplayPhase: "", renderRecoveryOverlay() {},
    frame: { classList: { remove() {} } },
    window: { setTimeout: (fn) => { timers.set(++timerId, fn); return timerId; },
      clearTimeout: (id) => timers.delete(id) },
  });
  vm.runInContext(app.slice(begin, end) + app.slice(finishBegin, finishEnd), sandbox);
  const loading = vm.runInContext("setPlayerLoading", sandbox);
  const finish = vm.runInContext("finishPlayerLoading", sandbox);
  loading(35, "Finding peers");
  assert.equal(vars["--load-fill"], "35%");
  loading(100, "Network failure", "", { error: true });
  assert.equal(vars["--load-fill"], "35%", "Error must not misleadingly show 100% complete");
  loading(72, "Buffering");
  finish();
  assert.equal(vars["--load-fill"], "100%");
  assert.equal(timers.size, 1);
  loading(4, "Next source");
  assert.equal(vars["--load-fill"], "4%");
  assert.equal(timers.size, 0, "Previous source's delayed finish was canceled");
  assert.equal(elements["#video-loading"].hidden, false);
  loading(43, "Rebuffering");
  loading(100, "Old source failed", "", { error: true });
  finish();
  assert.equal(vars["--load-fill"], "43%", "Late canplay must never hide an error or fake completion");
  assert.equal(timers.size, 0);
});
