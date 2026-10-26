import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../frontend/styles/styles.css", import.meta.url), "utf8");

test("Player captions remain accessible with Learning off, with all advanced controls in a modal", () => {
  assert.match(html, /id="player-toggle-subs"[^>]*aria-controls="player-subtitle-menu"/);
  assert.match(html, /id="player-subtitle-menu"[^>]*role="menu"/);
  const dialog = html.slice(html.indexOf('<dialog id="player-subtitle-dialog"'),
    html.indexOf("</dialog>", html.indexOf('<dialog id="player-subtitle-dialog"')) + 9);
  for (const id of ["embedded-subtitle-tracks", "find-subtitles-web", "subtitle-add-file",
    "sync-subtitles", "subtitle-dock-style", "subtitle-manager-close", "track-list"]) {
    assert.ok(dialog.includes(`id="${id}"`), `Subtitle dialog preserves ${id}`);
  }
  const hidden = css.slice(css.indexOf('html[data-learning-mode="off"] .nav-btn'),
    css.indexOf(".settings-hint", css.indexOf('html[data-learning-mode="off"] .nav-btn')));
  for (const selector of [".subtitle-dock", "#subtitle-overlay", "#player-toggle-subs",
    "#subtitle-style-dialog", "#subtitle-web-dialog", "#player-subtitle-dialog"]) {
    assert.ok(!hidden.includes(selector), `Learning OFF cannot hide ${selector}`);
  }
  assert.match(app, /function renderSubtitles\(\)\s*\{[\s\S]*?if \(!state\.subtitlesVisible\)/);
  assert.match(app, /if \(isTarget && learningEnabled\) appendLearningCue/);
  assert.match(app, /loadMoreEmbeddedSubtitles\(\);\s*renderSubtitles\(\)/);
});

test("Captions menu shows independent Show/Hide actions for embedded and added tracks", () => {
  const from = app.indexOf("function renderPlayerSubtitleMenu() {");
  const to = app.indexOf("\nfunction openPlayerSubtitleManager()", from);
  assert.ok(from >= 0 && to > from);
  const menu = { innerHTML: "" };
  const state = { currentMediaProbe: { subtitleTracks: [{ streamIndex: 3, textBased: true, language: "en", title: "English CC" }] },
    currentSource: {}, subtitlesVisible: true };
  vm.runInNewContext(app.slice(from, to) + "\nrenderPlayerSubtitleMenu();", {
    $: () => menu, state,
    preferredSourceTracks: () => ["Spanish subtitles", "French subtitles", "German subtitles", "Italian subtitles"]
      .map((label, i) => ({ id: `ext-${i}`, label, language: "es", origin: "external", visible: true })),
    embeddedSubtitleImports: new Map(),
    embeddedSubtitleImportKey: () => "key",
    embeddedSubtitleLabel: (track) => track.title,
    trackLanguageName: (lang) => lang === "en" ? "English" : "Spanish",
    normalizeTrackLanguage: (lang) => lang,
    escapeHtml: (value) => String(value),
    Number,
  });
  for (const label of ["Captions", "Customize", "All captions", "Hide all", "Embedded in video", "English CC", "Added tracks",
    "Spanish subtitles", "French subtitles", "German subtitles", "Italian subtitles", "Hide", "Show"]) {
    assert.ok(menu.innerHTML.includes(label), `Menu includes ${label}`);
  }
  assert.match(menu.innerHTML, /data-caption-customize/);
  assert.doesNotMatch(menu.innerHTML, /showing|available|Exact timing|Subtitle options|<span>More<\/span>/);
});

test("Four enabled subtitle tracks render together without a hidden display cap", () => {
  const from = app.indexOf("function renderSubtitles() {");
  const to = app.indexOf("\nfunction trackLanguageName(", from);
  assert.ok(from >= 0 && to > from);
  const tracks = ["en", "es", "fr", "it"].map((language, index) => ({
    id: `track-${index}`, language, visible: true,
    cue: { id: `cue-${index}`, text: `Subtitle ${index + 1}` },
  }));
  const overlay = {
    lines: [],
    set innerHTML(value) { this.lines = []; },
    append(line) { this.lines.push(line); },
  };
  vm.runInNewContext(app.slice(from, to) + "\nrenderSubtitles();", {
    $: () => overlay,
    state: { subtitlesVisible: true, targetLanguage: "es", baseLanguage: "en", subtitleStyle: { romanization: false } },
    preferredSourceTracks: () => tracks,
    activeTrack: () => tracks[0],
    getActiveCue: (track) => track.cue,
    comparisonCueForTrack: (track) => track.cue,
    normalizeTrackLanguage: (language) => language,
    isRomanizableLanguage: () => false,
    learningEnabled: false, learningRevision: 0,
    video: { paused: true },
    document: { createElement: () => ({}) },
    subtitleRenderMemo: { key: "" },
  });
  assert.deepEqual(overlay.lines.map((line) => line.textContent),
    ["Subtitle 1", "Subtitle 2", "Subtitle 3", "Subtitle 4"]);
});

test("Library navigation hands off to the configured floating mode, rather than directly creating another stream", async () => {
  const from = app.indexOf("async function navigateWatchToLibrary(openDestination) {");
  const to = app.indexOf('\n$("#settings-float-auto")?.addEventListener', from);
  assert.ok(from >= 0 && to > from);
  const order = [];
  const video = { paused: false, readyState: 3, requestPictureInPicture: async () => {
    order.push("request-pip");
    return { width: 340 };
  } };
  const document = { pictureInPictureEnabled: true, pictureInPictureElement: null };
  const context = vm.createContext({ video, document, HTMLMediaElement: { HAVE_CURRENT_DATA: 2 },
    viewActive: (view) => view === "watch", console: { warn: () => {} } });
  vm.runInContext(app.slice(from, to), context);
  const navigate = vm.runInContext("navigateWatchToLibrary", context);
  await navigate(() => order.push("library"));
  assert.deepEqual(order, ["library"]);
  order.length = 0;
  video.requestPictureInPicture = async () => { order.push("pip-rejected"); throw Error("Unsupported source"); };
  await navigate(() => order.push("library"));
  assert.deepEqual(order, ["library"]);
  order.length = 0;
  video.paused = true;
  await navigate(() => order.push("library"));
  assert.deepEqual(order, ["library"], "Paused playback does not force a PiP window");
  assert.match(app, /\["library", "calendar"\]\.includes\(button\.dataset\.view\) && viewActive\("watch"\)/,
    "Calendar and Library navigation should both pass through the floating-playback navigation handler");
  assert.match(app, /if \(key \|\| catalogId\) void navigateWatchToLibrary/);
  assert.match(app, /else if \(catalogId\) openTitlePage\(\{ id: catalogId, type: button\.dataset\.watchCatalogType/);
});

test("Player loading reveals title artwork without the old spinner, stage copy, or percentage", () => {
  assert.match(html, /<h1 id="media-title" class="ui-visually-hidden"/);
  assert.doesNotMatch(html, /class="panel-head watch-titlebar"/);
  assert.doesNotMatch(html, /id="video-loading-media-title"/);
  assert.doesNotMatch(html, /id="video-loading-copy"/);
  assert.doesNotMatch(html, /class="video-loading-statusline"|class="video-loading-activity"|id="video-loading-percent"/);
  assert.match(html, /id="video-loading-brand" class="video-loading-brand"/);
  assert.match(html, /id="video-loading-logo-ghost" class="video-loading-brand__ghost"/);
  assert.match(html, /id="video-loading-logo-fill" class="video-loading-brand__fill"/);
  assert.match(css, /\.video-loading-brand__ghost\s*\{[^}]*filter:grayscale\(1\)/);
  assert.match(css, /\.video-loading-brand__fill\s*\{[^}]*clip-path:inset\(0 calc\(100% - var\(--logo-fill,0%\)\)/, "logo fills separately from network-stage progress");
  assert.match(html, /class="video-loading-fallback" aria-hidden="true"/);
  assert.match(css, /\.video-loading:has\(\.video-loading-brand:not\(\[hidden\]\)\) \.video-loading-fallback/);
  assert.match(css, /\.video-loading-title\s*\{[^}]*position:absolute; width:1px; height:1px/);
  assert.match(css, /\.video-loading\.is-error \.video-loading-title\s*\{[^}]*position:static/);
  assert.match(css, /\.video-loading\s*\{[^}]*background:radial-gradient\(/);
  assert.doesNotMatch(css, /\.video-loading\s*\{[^}]*border:/, "No visible loader card outline");
  assert.match(app, /function setPlayerLoadingTitle\(entry = null, fallbackTitle = ""\)/);
  assert.match(app, /setPlayerLoadingTitle\(entry\);/);
  assert.match(css, /\.watch-title-info\s*\{[^}]*grid-template-columns:clamp\(190px,19%,275px\)/);
  assert.match(app, /class="watch-info-title-link" data-watch-title-details/);
  assert.doesNotMatch(app, />View full details/);
});
