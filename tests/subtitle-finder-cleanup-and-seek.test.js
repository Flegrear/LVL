import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../frontend/styles/styles.css", import.meta.url), "utf8");

function sourceBetween(begin, end) {
  const from = app.indexOf(begin);
  const to = app.indexOf(end, from + begin.length);
  assert.ok(from >= 0 && to > from, `Missing source: ${begin}`);
  return app.slice(from, to);
}

test("Subtitle finder omits deprecated description, Learning pair, and internal search details", () => {
  const dialog = html.slice(html.indexOf('<dialog id="subtitle-web-dialog"'), html.indexOf('<dialog id="subtitle-style-dialog"'));
  for (const old of ["CAPTIONS / DISCOVER", "Search in any language without changing", "Select languages individually", "Use learning pair", "subtitle-language-help"]) {
    assert.ok(!dialog.includes(old), `Remove ${old}`);
  }
  assert.match(dialog, /id="subtitle-language"/);
  assert.match(dialog, /data-subtitle-lang-toggle="JA"/);
  assert.match(dialog, /id="subtitle-web-results"/);
  const search = sourceBetween("async function performWebSubtitleSearch(", "async function searchWebSubtitles(");
  assert.doesNotMatch(search, /fromProviders|queriesTried|versions of the title/);
  assert.match(search, /renderWebSubtitleResults\(state\.webSubtitleResults\)/);
  assert.match(search, /parseSubtitleFinderLanguages\(\$\("#subtitle-language"\)\.value\)/);
  assert.doesNotMatch(search, /auto \? subtitleSearchLanguages/);
  assert.doesNotMatch(app, /\$\("#subtitle-language-pair"\)/);
  assert.match(app, /saveCurrentEpisodeAnalysis\(\);/);
});

test("Result cards show anime, provider/source, season, episode and language without filenames", () => {
  const container = { innerHTML: "", querySelectorAll: () => [] };
  const context = vm.createContext({
    $: (selector) => selector === "#subtitle-web-results" ? container : null,
    empty: () => "",
    escapeHtml: (value) => String(value).replaceAll("<", "&lt;"),
    subtitleResultPresentation: () => ({ anime: "Blue Box", source: "OpenSubtitles, WEBRIP", season: "01", episode: "02", language: "JA", file: "Blue.Box.S01E02.1080p.WEB.H264-KAWAII.srt" }),
  });
  vm.runInContext(sourceBetween("function renderWebSubtitleResults(", "function subtitleResultPresentation("), context);
  vm.runInContext("renderWebSubtitleResults([{}])", context);
  for (const detail of ["Blue Box", "S01 E02", "OpenSubtitles, WEBRIP", "SOURCE", "SEASON", "EPISODE", "LANGUAGE", "JA"]) {
    assert.ok(container.innerHTML.includes(detail), `Show ${detail}`);
  }
  assert.doesNotMatch(container.innerHTML, /KAWAII|\.srt|subtitle-result-file|<b>ANIME<\/b>/);
  assert.match(css, /\.subtitle-result-facts span[^\n]*var\(--font-sans\)/);
  assert.doesNotMatch(css, /\.subtitle-result-facts span[^\n]*var\(--font-mono\)/);
  assert.match(css, /\.subtitle-finder-dialog \.tool-result-copy > strong[^\n]*var\(--font-sans\)/);
});

test("Audio sync timer retains the earliest seek check instead of being postponed by playing", () => {
  const queued = [];
  const cleared = [];
  let current = 1000;
  const context = vm.createContext({
    Date: { now: () => current },
    audioSyncSource: () => ({ sessionId: "one", fileIndex: 0 }),
    audioSyncTracks: () => [{ id: "subtitle" }],
    audioSync: { timer: 0, timerDueAt: 0 },
    window: {
      clearTimeout: (id) => cleared.push(id),
      setTimeout: (callback, delay) => { const id = queued.length + 1; queued.push({ id, callback, delay }); return id; },
    },
    runAudioSyncStep: () => {},
  });
  vm.runInContext(sourceBetween("function scheduleAudioSync(", "function currentLibraryEpisode("), context);
  vm.runInContext("scheduleAudioSync(800)", context);
  current += 20;
  vm.runInContext("scheduleAudioSync(1500)", context);
  assert.equal(queued.length, 1, "playing must not postpone a faster seek timer");
  assert.equal(queued[0].delay, 800);
  current += 20;
  vm.runInContext("scheduleAudioSync(300)", context);
  assert.equal(queued.length, 2, "an earlier deadline takes priority");
  assert.ok(cleared.includes(1));
  queued[1].callback();
  assert.equal(context.audioSync.timer, 0);
  assert.equal(context.audioSync.timerDueAt, 0);
  assert.match(app, /if \(audioSync\.key\) scheduleAudioSync\(400\)/);
});
