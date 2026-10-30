import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
function slice(begin, end) {
  const from = app.indexOf(begin);
  const to = app.indexOf(end, from + begin.length);
  assert.ok(from > 0 && to > from, `missing code seam: ${begin}`);
  return app.slice(from, to);
}
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

test("A subtitle download finishing after an episode switch does not attach Episode A cues to B", async () => {
  const sourceA = { title: "Episode A" };
  const sourceB = { title: "Episode B" };
  const result = { url: "https://example.test/a.srt", label: "A English.srt", language: "EN" };
  const downloaded = deferred();
  const attached = [];
  const button = { textContent: "Add", disabled: false };
  const state = { currentSource: sourceA, webSubtitleResults: [result] };
  const ctx = vm.createContext({
    state, webSubtitleResultsSource: sourceA,
    postJson: async () => downloaded.promise,
    addSubtitleText: (...args) => { attached.push(args); return { added: true }; },
    renderSubtitleWorkspace() {}, subtitleReleaseScore: () => 10,
    setToolStatus() {},
  });
  vm.runInContext(slice("async function importWebSubtitle(", "\nfunction empty("), ctx);
  const pending = ctx.importWebSubtitle(0, button);
  state.currentSource = sourceB;
  downloaded.resolve({ text: "1\n00:00:01,000 --> 00:00:03,000\nEpisode A text", filename: "A.srt" });
  assert.equal(await pending, false);
  assert.equal(attached.length, 0);
  assert.equal(button.disabled, false, "a stale download must not leave its button stuck loading");
});

test("Late subtitle search and delayed local file read cannot overwrite another episode", async () => {
  const a = { title: "Episode A" };
  const b = { title: "Episode B" };
  const search = deferred();
  const rendered = [];
  const field = (value) => ({ value, focus() {}, innerHTML: "" });
  const elements = { "#subtitle-query": field("Episode A"), "#subtitle-language": field("EN"),
    "#subtitle-type": field("tv"), "#subtitle-season": field("1"), "#subtitle-episode": field("2"),
    "#subtitle-web-results": field("") };
  const state = { currentSource: a, webSubtitleResults: [], subdlKey: "" };
  const ctx = vm.createContext({
    state, webSubtitleSearchRevision: 0, webSubtitleResultsSource: null,
    $: (selector) => elements[selector],
    parseSubtitleFinderLanguages: () => ["EN"],
    localStorage: { setItem() {} }, syncSubtitleFinderLanguageChips() {},
    subtitleFallbackQueries: () => [],
    setToolStatus() {},
    postJson: async () => search.promise,
    subtitleReleaseScore: () => 10,
    renderWebSubtitleResults: (results) => rendered.push(results),
  });
  vm.runInContext(slice("async function performWebSubtitleSearch(", "\nasync function searchWebSubtitles("), ctx);
  const pending = ctx.performWebSubtitleSearch();
  state.currentSource = b;
  search.resolve({ results: [{ label: "A subtitles" }] });
  await pending;
  assert.equal(state.webSubtitleResults.length, 0);
  assert.equal(rendered.length, 0);

  const read = deferred();
  const attached = [];
  const fileCtx = vm.createContext({
    state: { currentSource: a },
    addSubtitleText: (...args) => attached.push(args),
    renderSubtitleWorkspace() {}, $: () => ({ textContent: "" }),
  });
  vm.runInContext(slice("async function handleSubtitleFiles(", "\nfunction addSubtitleText("), fileCtx);
  const importing = fileCtx.handleSubtitleFiles([{ name: "a.srt", text: () => read.promise }]);
  fileCtx.state.currentSource = b;
  read.resolve("A subtitle");
  await importing;
  assert.deepEqual(attached, []);
});

test("Show Romanized Text switch rerenders the same paused cue immediately", () => {
  const cue = { id: "cue-1", text: "日本語", romanizedText: "nihongo" };
  const track = { id: "japanese", language: "JA", visible: true, cues: [cue] };
  const state = { subtitlesVisible: true, targetLanguage: "JA", baseLanguage: "EN",
    subtitleStyle: { romanization: true }, wordColoring: false, pauseAfterCue: false, lastCueId: null };
  const overlay = { nodes: [], set innerHTML(_value) { this.nodes = []; }, append(node) { this.nodes.push(node); } };
  const ctx = vm.createContext({
    state, subtitleRenderMemo: { key: "" }, learningRevision: 0, learningEnabled: false,
    $: () => overlay,
    preferredSourceTracks: () => [track], activeTrack: () => track,
    getActiveCue: () => cue, comparisonCueForTrack: () => cue,
    normalizeTrackLanguage: (v) => v,
    isRomanizableLanguage: () => true,
    document: { createElement: () => ({ className: "", textContent: "" }) },
  });
  vm.runInContext(slice("function renderSubtitles()", "\nfunction trackLanguageName("), ctx);
  ctx.renderSubtitles();
  assert.deepEqual(overlay.nodes.map((node) => node.textContent), ["日本語", "nihongo"]);
  state.subtitleStyle.romanization = false;
  ctx.renderSubtitles();
  assert.deepEqual(overlay.nodes.map((node) => node.textContent), ["日本語"]);
});
