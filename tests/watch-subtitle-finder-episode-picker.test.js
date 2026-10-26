import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const styles = readFileSync(new URL("../frontend/styles/styles.css", import.meta.url), "utf8");

function between(start, end) {
  const from = app.indexOf(start);
  const to = app.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `Source bounds for ${start}`);
  return app.slice(from, to);
}

function finderHarness() {
  const values = new Map([
    ["#subtitle-query", "Frieren"],
    ["#subtitle-language", "ES"],
    ["#subtitle-type", "tv"],
    ["#subtitle-season", "1"],
    ["#subtitle-episode", "4"],
    ["#subtitle-web-results", ""],
  ]);
  const elements = new Map([...values].map(([key, value]) => [key, { value, focus() {} }]));
  const storage = new Map();
  const payloads = [];
  const context = vm.createContext({
    state: { subdlKey: "", wyzieKey: "", subsourceKey: "", currentSource: { catalogId: "tt222", fileName: "Frieren.S01E04.mkv" } },
    $: (key) => elements.get(key),
    $$: () => [],
    localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    preferredLanguagePair: () => ["JA", "EN"],
    subtitleFallbackQueries: () => [],
    postJson: async (_url, payload) => { payloads.push(payload); return { results: [] }; },
    setToolStatus() {},
    subtitleReleaseScore: () => 0,
    renderWebSubtitleResults() {},
    languageName: (value) => value,
  });
  vm.runInContext(between("function subtitleSearchLanguages() {", "function saveSubtitlePreferences(")
    + between("async function performWebSubtitleSearch(", "async function searchWebSubtitles("), context);
  return { context, elements, storage, payloads, search: vm.runInContext("performWebSubtitleSearch", context),
    parse: vm.runInContext("parseSubtitleFinderLanguages", context) };
}

test("manual subtitle finder searches Spanish or any language without changing the learning pair", async () => {
  const h = finderHarness();
  assert.equal(h.elements.get("#subtitle-language").value, "ES");
  await h.search();
  assert.equal(h.payloads[0].language, "ES");
  assert.equal(h.storage.get("lvl-subtitle-finder-languages"), "ES");
  h.elements.get("#subtitle-language").value = "RU,FR";
  await h.search();
  assert.equal(h.payloads[1].language, "RU,FR");
  assert.equal(vm.runInContext("subtitleSearchLanguages()", h.context), "JA,EN");
  assert.equal(h.storage.get("lvl-subtitle-finder-languages"), "RU,FR");
  await h.search({ auto: true });
  assert.equal(h.payloads[2].language, "RU,FR", "Automatic subtitle lookup uses the chosen finder languages, not Learning preferences");
});

test("finder rejects malformed or excessive codes and exposes quick independent language chips", () => {
  const h = finderHarness();
  assert.deepEqual(Array.from(h.parse("ES, ES, RU")), ["ES", "RU"]);
  for (const value of ["", "EN,FR,ES,DE,JA", "english", "E5"]) {
    assert.equal(h.parse(value), null, `Reject invalid language list ${value}`);
  }
  assert.doesNotMatch(html, /id="subtitle-language"[^>]*readonly/);
  assert.match(html, /data-subtitle-lang-toggle="ES"/);
  assert.match(html, /data-subtitle-lang-toggle="JA"/);
  assert.doesNotMatch(html, /id="subtitle-language-pair"|CAPTIONS \/ DISCOVER|subtitle-language-help|Search in any language without changing your learning languages/);
});

test("watch body reveals no more than three ranked episode-only sources; play stays an explicit target", () => {
  const markup = between("function renderWatchChapters() {", "async function findWatchEpisodeSources(");
  const search = between("async function findWatchEpisodeSources(", "let autoNextInterval");
  const clicks = between('$("#watch-chapters-body")?.addEventListener("click"', '$$("[data-study-category]")');
  assert.match(markup, /\.sort\(\(a, b\) => b\.peers - a\.peers\)\.slice\(0, 3\)/);
  assert.match(markup, /data-watch-episode-sources=/);
  assert.match(markup, /data-watch-episode="/);
  assert.match(markup, /data-watch-episode-source-index=/);
  assert.match(search, /\.\.\.groups\.episodeFiles, \.\.\.groups\.others/);
  assert.doesNotMatch(search, /\.\.\.groups\.packs/);
  assert.match(clicks, /if \(selector\)[\s\S]*?renderWatchChapters\(\)/);
  assert.match(clicks, /if \(chosen\.kind === "saved"\)/);
  assert.match(clicks, /addCatalogChapterSource\(view, action\.catalog, chosen\.stream/);
});

test("theater fits the viewport height with symmetric spare side space and chapters below", () => {
  assert.match(styles, /\.watch-player-layout\.is-theater \.video-frame\s*\{[^}]*width:min\(100%,calc\(\(100dvh - var\(--ui-topbar-h,64px\) - 52px\) \* 16 \/ 9\)\);[^}]*max-width:100%;[^}]*min-height:0;[^}]*margin-inline:auto;/);
  assert.match(styles, /\.watch-player-layout\.has-chapters\.is-theater\s*\{\s*grid-template-columns:minmax\(0,1fr\);/);
  assert.match(styles, /\.watch-player-layout\.is-theater \.watch-side-rail/);
  assert.match(styles, /\.watch-episode__sources\[hidden\]\s*\{\s*display:none;/);
});

test("episode play area is integrated into the card without a separately outlined inset button", () => {
  assert.match(styles, /\.watch-episode__shell\s*\{[^}]*grid-template-columns:minmax\(0,1fr\) 48px;/);
  assert.match(styles, /\.watch-episode__play\s*\{[^}]*margin:0;[^}]*border:0;[^}]*border-radius:0;[^}]*background:transparent;/);
  const render = between("function renderWatchChapters()", "async function findWatchEpisodeSources(");
  assert.match(render, /class="watch-episode__details"[^>]*data-watch-episode-sources=/);
  assert.match(render, /class="watch-episode__play" data-watch-episode=/);
  assert.match(render, /<strong>Episode sources<\/strong>/);
  assert.doesNotMatch(render, /Top \$\{candidates\.length\} by peers/);
  assert.match(render, /catalog: chapter\.id \? chapter : null, entry, series, list: cached, current/);
  assert.match(render, /\$\{upcoming \|\| \(!current && !best && !chapter\.id\) \? 'disabled' : ""\}/);
  assert.match(render, /title="\$\{current \? "Return to playing episode"/);
  assert.match(render, /\$\{icon\("play"\)\}<\/button>/, "The currently playing episode still uses the same visible play glyph");
  assert.doesNotMatch(render, /icon\("volume-2"\)/, "Unknown icon name must not cause an empty current-episode play area");
  const clicks = between('$("#watch-chapters-body")?.addEventListener("click"', '$$("[data-study-category]")');
  assert.match(clicks, /if \(action\.current\) \{\s*switchView\("watch"\);\s*if \(video\.paused\) resumePlayback\(\);\s*return;/,
    "Current episode play must return to its player or resume without restarting its stream");
});
