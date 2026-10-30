import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../frontend/styles/styles.css", import.meta.url), "utf8");
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const ui = readFileSync(new URL("../frontend/ui/ui.js", import.meta.url), "utf8");

test("Core build locks Learning off before first paint, regardless of saved preference", () => {
  assert.match(html, /document\.documentElement\.dataset\.learningMode = "off"/);
  assert.match(app, /const LEARNING_DEV_ENABLED = false/);
  assert.match(app, /let learningEnabled = LEARNING_DEV_ENABLED && localStorage\.getItem\(LEARNING_ENABLED_KEY\) !== "0"/);
  const start = app.indexOf("const LEARNING_DEV_ENABLED = false;");
  const end = app.indexOf("\n// OAuth's implicit token", start);
  for (const saved of [null, "0", "1"]) {
    const writes = [];
    const context = vm.createContext({
      localStorage: { getItem: () => saved, setItem: (...args) => writes.push(args) },
      document: { documentElement: { dataset: {} } },
    });
    vm.runInContext(app.slice(start, end), context);
    assert.equal(vm.runInContext("learningEnabled", context), false);
    assert.equal(context.document.documentElement.dataset.learningMode, "off");
    assert.equal(writes.length, 0, "Do not rewrite the previous Learning preference");
  }
  assert.match(html, /Learning features<\/h2>/);
  assert.match(html, /Coming soon\. Your saved learning data is preserved\./);
  assert.doesNotMatch(html, /id="settings-learning-enabled"|Enable Learning/);
  assert.doesNotMatch(app, /settings-learning-enabled/);
  assert.match(app, /localStorage\.setItem\(LEARNING_ENABLED_KEY, next \? "1" : "0"\)/);
  const toggleStart = app.indexOf("function setLearningEnabled(enabled)");
  const toggleEnd = app.indexOf("\nasync function handleSubtitleFiles", toggleStart);
  const changes = [];
  const context = vm.createContext({
    LEARNING_DEV_ENABLED: false,
    learningEnabled: false,
    localStorage: { setItem: (...args) => changes.push(args) },
    document: { documentElement: { dataset: { learningMode: "off" } } },
  });
  vm.runInContext(app.slice(toggleStart, toggleEnd) + "\nsetLearningEnabled(true)", context);
  assert.equal(context.learningEnabled, false, "Even a direct setter call cannot unlock a core build");
  assert.equal(context.document.documentElement.dataset.learningMode, "off");
  assert.equal(changes.length, 0);
});

test("Off state hides learning navigation and coach, not video captions or playback", () => {
  for (const view of ["home", "library", "watch", "settings"]) assert.match(html, new RegExp(`data-view="${view}"`));
  for (const view of ["study", "review", "test"]) {
    assert.match(css, new RegExp(`html\\[data-learning-mode="off"\\] \\.nav-btn\\[data-view="${view}"\\]`));
  }
  for (const selector of ["#player-loop-line", "#player-swap-languages", "#settings-tab-coach", "#settings-panel-coach", "#view-study", "#view-review", "#view-test", ".library-vocab"]) {
    assert.ok(css.includes(`html[data-learning-mode="off"] ${selector}`), `Learning hides ${selector}`);
  }
  for (const selector of [".subtitle-dock", "#subtitle-overlay", "#player-toggle-subs", "#subtitle-style-dialog", "#subtitle-web-dialog"]) {
    assert.ok(!css.includes(`html[data-learning-mode="off"] ${selector}`),
      `Captions and their controls stay available with Learning off: ${selector}`);
  }
  assert.match(css, /html\[data-learning-mode="off"\] \[data-learning-only\]/);
  assert.match(html, /id="settings-subdl-form" class="settings-card"/);
  assert.doesNotMatch(html, /id="settings-subdl-form" class="settings-card" data-learning-only/);
  assert.match(html, /id="settings-base-language"/);
  assert.match(html, /id="settings-subdl-key"/);
  assert.match(html, /id="video" playsinline/);
  assert.match(html, /id="player-audio-switcher"/);
  assert.match(html, /id="watch-autoplay-next"/);
  assert.match(ui, /\.filter\(\(tab\) => !tab.hidden && !tab.disabled\)/);
});

test("Development-only toggle retains Learning data and does not stop core subtitle synchronization", () => {
  const start = app.indexOf("function setLearningEnabled(enabled)");
  const end = app.indexOf("\nasync function handleSubtitleFiles", start);
  assert.ok(start >= 0 && end > start);
  const storage = new Map();
  let mode = "";
  let renders = 0;
  let subtitles = 0;
  let stopped = 0;
  let clipRestarts = 0;
  const playback = { paused: false };
  const context = vm.createContext({
    LEARNING_DEV_ENABLED: true,
    learningEnabled: true,
    explicitlyUnwatchedChapter: () => false,
    LEARNING_ENABLED_KEY: "blackline-learning-enabled",
    localStorage: { setItem: (key, value) => storage.set(key, value) },
    document: { documentElement: { dataset: {} } },
    window: { clearTimeout: () => {} },
    video: playback,
    frame: { classList: { contains: (value) => value === "has-video" } },
    audioSync: { timer: 0 },
    clipPlanner: { timer: 0 },
    scheduleClipStep: () => { clipRestarts += 1; },
    $: () => null,
    voiceChat: { providerConversationId: "", providerLive: false, liveStarting: false },
    voiceRecognition: null,
    stopVoiceSpeech: () => { stopped += 1; },
    stopStudySounds: () => { stopped += 1; },
    settingsView: { tab: "coach" },
    viewActive: () => false,
    switchView: () => {},
    renderSettingsTabs: () => { mode = "settings refreshed"; },
    renderSubtitles: () => { subtitles += 1; },
    renderAll: () => { renders += 1; },
    state: { wordColoring: false, studySource: "chapter" },
    ensureLearningPreset: () => {},
  });
  vm.runInContext(app.slice(start, end), context);
  const toggle = vm.runInContext("setLearningEnabled", context);
  toggle(false);
  assert.equal(storage.get("blackline-learning-enabled"), "0");
  assert.equal(context.document.documentElement.dataset.learningMode, "off");
  assert.equal(context.settingsView.tab, "general");
  assert.equal(stopped, 2);
  assert.equal(subtitles, 1);
  assert.equal(renders, 0);
  assert.equal(mode, "settings refreshed");
  toggle(true);
  assert.equal(storage.get("blackline-learning-enabled"), "1");
  assert.equal(context.document.documentElement.dataset.learningMode, "on");
  assert.equal(renders, 1);
  assert.equal(subtitles, 2);
  assert.doesNotMatch(app.slice(start, end), /clearTimeout\(audioSync\.timer\)/,
    "Disabling Learning must not interrupt ordinary subtitle-to-audio synchronization");
  assert.doesNotMatch(app.slice(start, end), /"subtitle-style-dialog"|"subtitle-web-dialog"/,
    "Disabling Learning must not close core subtitle dialogs");
  assert.equal(clipRestarts, 1, "Active playback resumes learning clips on re-enable");
  toggle(false);
  playback.paused = true;
  toggle(true);
  assert.equal(clipRestarts, 1, "Paused video does not start clip extraction");
});

test("Automatic subtitle-to-audio alignment stays scheduled with Learning disabled; card generation does not", () => {
  const start = app.indexOf("function scheduleAudioSync(");
  const end = app.indexOf("\nfunction currentLibraryEpisode()", start);
  const scheduled = [];
  const context = vm.createContext({
    learningEnabled: false,
    audioSyncSource: () => ({ sessionId: "s", fileIndex: 0 }),
    audioSyncTracks: () => [{ id: "subtitle-track" }],
    audioSync: { timer: 0 },
    window: { clearTimeout: () => {}, setTimeout: (fn, delay) => { scheduled.push(delay); return 1; } },
  });
  vm.runInContext(app.slice(start, end) + "\nscheduleAudioSync(500)", context);
  assert.deepEqual(scheduled, [500]);
  const syncStart = app.indexOf("async function runAudioSyncStep()");
  const syncEnd = app.indexOf("\nfunction applyAudioSync()", syncStart);
  assert.doesNotMatch(app.slice(syncStart, syncEnd), /!learningEnabled/,
    "Subtitle audio alignment itself is core media functionality");
  const analysisStart = app.indexOf("function saveCurrentEpisodeAnalysis()");
  assert.match(app.slice(analysisStart, analysisStart + 140), /if \(!learningEnabled\) return/,
    "Core mode must not silently analyze vocabulary or create cards when captions load");
  assert.match(app, /const repaired = learningEnabled \? refreshEpisodeCardPairs\(\) : 0/);
  assert.match(app, /scheduleAudioSync\(1500\);\s*if \(learningEnabled\) scheduleClipStep\(5000\)/);
});

test("Learning routes, cue rendering, exposure and keyboard shortcuts are gated, while playback progress remains", () => {
  assert.match(app, /if \(!learningEnabled && \["study", "review", "test"\]\.includes\(view\)\) view = "home"/);
  assert.match(app, /function renderSubtitles\(\)\s*\{[\s\S]*?if \(!state\.subtitlesVisible\)/);
  assert.match(app, /if \(isTarget && learningEnabled\) appendLearningCue\(line, cue, track\); else line\.textContent = cue\.text/);
  assert.match(app, /if \(!learningEnabled \|\| !cue \|\| normalizeTrackLanguage/);
  assert.match(app, /video\.addEventListener\("timeupdate",[\s\S]*?loadMoreEmbeddedSubtitles\(\)/);
  assert.match(app, /checkAudioSyncCoverage\(\);\s*recordWatchProgress\(\)/);
  assert.match(app, /if \(!audioSyncSource\(\) \|\| !audioSyncTracks\(\)\.length\) return/);
  assert.match(app, /function scheduleClipStep\(delayMs = 6000\) \{\s*if \(!learningEnabled\) return/);
  assert.match(app, /async function runAudioSyncStep\(\) \{\s*const source = audioSyncSource\(\)/);
  assert.match(app, /const ranges = await audioReadyRanges\(source\);\s*if \(audioSync\.generation !== generation \|\| audioSyncKey\(\) !== key\) return/,
    "a completed audio probe must not mutate state from a newer audio-dub generation");
  assert.match(app, /if \(learningEnabled && state\.loopLine && !video\.paused\)/);
  assert.match(app, /if \(learningEnabled && key === "g"\)/);
  assert.match(app, /recordWatchProgress\(\);/);
});

test("Title page removes the redundant summary stat tiles in either learning mode", () => {
  const start = app.indexOf("function titleProgressMarkup(subject, info) {");
  const end = app.indexOf("\nfunction titleAboutMarkup", start);
  assert.ok(start >= 0 && end > start);
  const series = {
    type: "series", seasons: new Map([[1, [{ episode: { analysis: { words: [{ value: "Hello" }] } } }]]]),
    extras: [], sources: [{ id: "a", lastPlayedAt: 0, watchedChapters: { S01E01: true } }],
  };
  const context = vm.createContext({
    learningEnabled: true,
    explicitlyUnwatchedChapter: () => false,
    state: { cards: [{ sourceLibraryId: "a" }] },
    libraryOrderedChapters: () => [{ code: "S01E01", sources: [{ episode: { progress: { finished: true } } }] }],
    groupLibraryChapters: () => [],
    seriesResumePoint: () => null,
    seriesAniList: () => ({ status: "CURRENT" }),
    ANILIST_STATUS_LABELS: { CURRENT: "Watching" },
    anilistProgressText: () => "S1E8 of 13",
    anilistWatchedSummary: () => ({ watched: 8, total: 13 }),
    anilistRatingText: () => "Your rating: 8.9/10",
    escapeHtml: (value) => String(value),
  });
  vm.runInContext(app.slice(start, end), context);
  const render = vm.runInContext("titleProgressMarkup", context);
  const enabled = render({ series }, { chapterTotal: 14 });
  assert.equal(enabled, "", "Do not show redundant progress cards for linked titles");

  context.learningEnabled = false;
  const disabled = render({ series }, { chapterTotal: 14 });
  assert.equal(disabled, "", "Stats remain removed when learning is disabled");
  assert.match(css, /html\[data-learning-mode="off"\] \[data-learning-only\]/);
  series.type = "movie";
  const movie = render({ series }, {});
  assert.equal(movie, "", "Movies also omit the redundant stat tiles");
  assert.match(app.slice(start, end), /<details class="title-anilist-manual"/);
  assert.match(app.slice(start, end), /data-title-anilist-link/, "Compact AniList manual linking remains accessible");
});
