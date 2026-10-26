import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../frontend/styles/styles.css", import.meta.url), "utf8");
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");

const theaterStart = app.indexOf('function setWatchTheaterMode(enabled) {');
const theaterEnd = app.indexOf('$("#player-fullscreen").addEventListener("click", async () =>', theaterStart);
assert.ok(theaterStart >= 0 && theaterEnd > theaterStart, "Theater mode is bound beside the fullscreen player control");
const theaterController = app.slice(theaterStart, theaterEnd);

function fixture(initialValue) {
  const classes = () => {
    const contents = new Set();
    return {
      contains: (name) => contents.has(name),
      toggle: (name, enabled) => {
        if (enabled === undefined ? !contents.has(name) : enabled) contents.add(name);
        else contents.delete(name);
      },
    };
  };
  const layout = { classList: classes() };
  const button = {
    classList: classes(),
    attributes: {},
    dataset: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(name, callback) { assert.equal(name, "click"); this.click = callback; },
  };
  const values = new Map(initialValue === undefined ? [] : [["lvl-watch-theater-mode", initialValue]]);
  const writes = [];
  let revealCount = 0;
  vm.runInNewContext(theaterController, {
    $: (selector) => ({ "#watch-player-layout": layout, "#player-theater": button })[selector],
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { writes.push([key, value]); values.set(key, value); },
    },
    revealPlayerControls: () => { revealCount += 1; },
  });
  return { layout, button, values, writes, get revealCount() { return revealCount; } };
}

test("Theater control sits beside fullscreen with keyboard and pressed-state hints", () => {
  const controls = html.match(/<button id="player-theater"[^>]*>/)?.[0] || "";
  assert.match(controls, /aria-pressed="false"/);
  assert.match(controls, /aria-keyshortcuts="T"/);
  assert.match(controls, /aria-label="Theater mode"/);
  assert.ok(html.indexOf('id="player-float"') < html.indexOf('id="player-theater"'));
  assert.ok(html.indexOf('id="player-theater"') < html.indexOf('id="player-fullscreen"'));
  assert.match(app, /if \(key === "t" && !event\.ctrlKey && !event\.metaKey && !event\.altKey\)/);
  assert.match(app, /else await frame\.requestFullscreen\(\)/, "Fullscreen still applies only to the original video frame");
});

test("Theater starts in normal mode despite old saved preference and toggles without persistence", () => {
  const initial = fixture("1");
  assert.equal(initial.layout.classList.contains("is-theater"), false);
  assert.equal(initial.button.classList.contains("is-active"), false);
  assert.equal(initial.button.attributes["aria-pressed"], "false");
  assert.equal(initial.button.attributes["aria-label"], "Theater mode");
  initial.button.click();
  assert.equal(initial.layout.classList.contains("is-theater"), true);
  assert.equal(initial.button.classList.contains("is-active"), true);
  assert.equal(initial.button.attributes["aria-pressed"], "true");
  assert.equal(initial.button.dataset.tooltip, "Exit theater mode");
  initial.button.click();
  assert.equal(initial.layout.classList.contains("is-theater"), false);
  assert.equal(initial.button.attributes["aria-pressed"], "false");
  assert.equal(initial.button.dataset.tooltip, "Theater mode");
  assert.deepEqual(initial.writes, [], "Theater choice belongs only to the current playback");
  assert.equal(initial.revealCount, 2, "switching mode keeps the video controls visible");

  const defaultMode = fixture();
  assert.equal(defaultMode.layout.classList.contains("is-theater"), false);
  defaultMode.button.click();
  assert.equal(defaultMode.layout.classList.contains("is-theater"), true);
  assert.equal(defaultMode.button.attributes["aria-pressed"], "true");
  assert.equal(defaultMode.button.dataset.tooltip, "Exit theater mode");
  assert.deepEqual(defaultMode.writes, []);
});

test("Every new torrent chapter and local file returns to the default split Watch layout", () => {
  const torrentStart = app.indexOf("function setCurrentTorrentSource(session, file) {");
  const torrentEnd = app.indexOf("\nlet playbackLoadRequestId =", torrentStart);
  assert.ok(torrentStart >= 0 && torrentEnd > torrentStart);
  assert.match(app.slice(torrentStart, torrentEnd), /setWatchTheaterMode\(false\)/);
  const libraryStart = app.indexOf("function preparePlayerForLibraryLoad(");
  const libraryEnd = app.indexOf("\nasync function resolveTorrentMagnet(", libraryStart);
  assert.ok(libraryStart >= 0 && libraryEnd > libraryStart);
  assert.match(app.slice(libraryStart, libraryEnd), /setWatchTheaterMode\(false\)/);
  const localStart = app.indexOf('$("#video-input").addEventListener("change"');
  const localEnd = app.indexOf('$("#subtitle-input").addEventListener(', localStart);
  assert.ok(localStart >= 0 && localEnd > localStart);
  assert.match(app.slice(localStart, localEnd), /setWatchTheaterMode\(false\)/);
});

test("Theater reflows the chapter rail below the video and remains single-column on small screens", () => {
  assert.match(css, /\.watch-player-layout\.has-chapters\.is-theater\s*\{\s*grid-template-columns:minmax\(0,1fr\);\s*\}/);
  assert.match(css, /\.watch-player-layout\.is-theater \.watch-side-rail > \.watch-chapters\s*\{\s*grid-column:1 \/ -1;/);
  assert.match(css, /\.watch-player-layout\.is-theater \.watch-episode-list\s*\{[^}]*auto-fill/);
  assert.match(css, /@media \(max-width:680px\)[\s\S]*?\.watch-player-layout\.is-theater \.watch-side-rail\s*\{\s*grid-template-columns:minmax\(0,1fr\);/);
  assert.match(css, /\.watch-player-layout\.has-chapters:not\(\.is-theater\) \.player-control-row \.player-volume/, "Theater restores player volume and metadata on medium desktops");
});

test("Theater player sits below the header and reserves viewport space so Library cannot peek beneath it", () => {
  assert.match(css, /\.watch-player-layout\.is-theater \.video-frame\s*\{[^}]*margin-block-start:20px;/);
  assert.match(css, /\.watch-player-layout\.is-theater \.video-frame\s*\{[^}]*scroll-margin-top:calc\(var\(--ui-topbar-h,64px\) \+ 48px\)/);
  assert.match(css, /\.watch-player-layout\.is-theater \.watch-player-main\s*\{\s*min-height:calc\(100dvh - var\(--ui-topbar-h,64px\) \+ 24px\)/);
  assert.match(css, /\.watch-player-layout\.is-theater \.video-frame \{ scroll-margin-top:calc\(58px \+ 48px \+ 48px\); \}/);
});
