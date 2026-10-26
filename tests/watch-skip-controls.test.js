import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../frontend/styles/styles.css", import.meta.url), "utf8");

function extract(from, to) {
  const start = app.indexOf(from);
  const end = app.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, `Missing section ${from}`);
  return app.slice(start, end);
}

function fixture() {
  let visible = true;
  let at = 65;
  const calls = [];
  const requests = [];
  const listeners = new Map();
  const nodes = Object.fromEntries(["#watch-skip-intro", "#watch-skip-credits",
    "#player-timeline-segments", "#player-timeline-summary"].map((name) => [name, {
    title: "", textContent: "", innerHTML: "", attributes: {},
    setAttribute(key, value) { this.attributes[key] = value; },
  }]));
  const entry = {
    catalogId: "tt1234567", catalogType: "series",
    episodes: [{ fileIndex: 2, code: "S01E03" }],
  };
  const state = {
    mediaDurationMs: 1_440_000, pendingSeek: null,
    currentSource: { kind: "torrent", libraryId: "source-a", fileIndex: 2 },
  };
  const video = { paused: false, addEventListener(name, listener) { listeners.set(name, listener); } };
  const context = vm.createContext({
    state, watchPendingSelection: null,
    video,
    localStorage: { getItem: () => null, setItem() {} },
    $: (name) => nodes[name],
    viewActive: () => visible,
    libraryEntryById: () => entry,
    absolutePlaybackSeconds: () => at,
    presentedSubtitleSeconds: () => null,
    seekPlayerTo: (seconds) => { calls.push(["seek", seconds]); },
    playAdjacentChapter: async (direction) => { calls.push(["next", direction]); },
    currentCatalogNeighbors: () => ({ next: { code: "S01E04" } }),
    currentChapterNavigation: () => ({ next: null }),
    markPlaybackMotion() {}, prefetchUpcomingChapter() {}, loadMoreEmbeddedSubtitles() {},
    renderSubtitles() {}, updateCompatControls() {}, checkAudioSyncCoverage() {}, recordWatchProgress() {},
    learningEnabled: false,
    formatTime: (milliseconds) => {
      const seconds = Math.floor(milliseconds / 1000);
      return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
    },
    fetch: (url, options) => new Promise((resolve) => {
      requests.push({ url: String(url), options, resolve });
    }),
    AbortController, URLSearchParams,
  });
  vm.runInContext(extract("// SkipDB is a lightweight", "\nfunction prefetchUpcomingChapter()"), context);
  const run = (name) => vm.runInContext(name.includes("(") ? name : `${name}()`, context);
  const complete = async (segments, index = requests.length - 1) => {
    requests[index].resolve({ ok: true, json: async () => ({ segments }) });
    await new Promise((resolve) => setImmediate(resolve));
  };
  const wireTimeupdate = () => {
    const from = app.indexOf('video.addEventListener("timeupdate", () => {');
    const end = app.indexOf('\n});', from) + '\n});'.length;
    assert.ok(from >= 0 && end > from, "player timeupdate listener exists");
    vm.runInContext(app.slice(from, end), context);
  };
  const tick = () => {
    assert.ok(listeners.has("timeupdate"), "player timeupdate handler must be registered");
    listeners.get("timeupdate")();
  };
  return { context, state, entry, video, nodes, requests, calls, run, complete, wireTimeupdate, tick,
    setPosition: (value) => { at = value; },
    setVisible: (value) => { visible = value; },
  };
}

function confirmed(start, end) {
  return { match: "exact", confidence: .95, start_ms: start * 1000, end_ms: end * 1000 };
}

test("Skip controls occupy the space directly beneath the player, not another overlay", () => {
  const frameEnd = html.indexOf('<div class="watch-skip-options"');
  assert.ok(frameEnd > html.indexOf('id="video-frame"'));
  assert.ok(frameEnd < html.indexOf('class="transport-strip watch-transport"'));
  for (const id of ["watch-skip-intro", "watch-skip-credits", "watch-autoplay-inline"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(css, /\.watch-skip-options \{[^}]*display:flex/);
  assert.match(css, /\.watch-skip-action\[aria-pressed="true"\] \{/);
  assert.doesNotMatch(html, /id="watch-autoplay-inline"[^>]*type="checkbox"/);
  assert.match(css, /html\[data-learning-mode="off"\] \.watch-transport,/,
    "the unused learning toolbar must not leave a blank row under the skip buttons");
  assert.match(html, /id="watch-autoplay-next"/, "the original Settings preference is retained");
});

test("Verified opening and ending segments are solid pale blue; control group and scrollbars stay black and white", () => {
  assert.match(css, /\.player-timeline-segment--opening,\.player-timeline-segment--ending\s*\{\s*background:#9ed6ff;/,
    "both sourced opening and ending share the same pale blue");
  assert.doesNotMatch(css, /\.player-timeline-segment\.is-estimated/, "no guessed range styling remains");
  assert.match(css, /\.watch-skip-options\s*\{[^}]*border:0;[^}]*background:transparent;/,
    "playback options have no enclosing border or surface");
  assert.match(css, /\.watch-skip-action\[aria-pressed="true"\]\s*\{[^}]*color:#fff;[^}]*background:#171717;/);
  assert.match(css, /\.watch-skip-action::before\s*\{[^}]*width:13px;[^}]*color:transparent;/, "unselected options reserve the tick slot");
  assert.match(css, /\.watch-skip-action\[aria-pressed="true"\]::before\s*\{ color:#fff; \}/,
    "pressed states display a free-standing white tick, without a checkbox");
  assert.match(css, /html,\s*\.watch-chapters__body,[\s\S]*?scrollbar-color:#484848 #000;/,
    "Episodes and other Watch scroll areas have a black track");
  assert.match(css, /\.watch-chapters__body,[\s\S]*?::-webkit-scrollbar-track\s*\{\s*background:#000;/,
    "Chromium draws the black track for Episodes as well");
});

test("Automatic skips require active playback, run once per identified interval, and preserve post-credit scenes", async () => {
  const h = fixture();
  h.video.paused = true;
  h.run('setEpisodeAutoSkip("intro", true)');
  h.run('setEpisodeAutoSkip("outro", true)');
  h.run("refreshEpisodeSkipOptions");
  await h.complete({ intro: confirmed(60, 150), outro: confirmed(1310, 1370) });
  assert.deepEqual(h.calls, [], "never auto-seek during a pause");
  h.video.paused = false;
  h.run("refreshEpisodeSkipOptions");
  assert.deepEqual(h.calls, [["seek", 150]]);
  h.run("refreshEpisodeSkipOptions");
  assert.equal(h.calls.length, 1, "the same marker must not start a seek loop");
  h.setPosition(1320);
  h.run("refreshEpisodeSkipOptions");
  assert.deepEqual(h.calls.at(-1), ["seek", 1370], "existing post-credit footage is preserved");
  h.run("refreshEpisodeSkipOptions");
  assert.equal(h.calls.length, 2);
});

test("Verified community timestamps skip through the real timeupdate callback, with no seek while paused", async () => {
  const h = fixture();
  // A public duration-aware SkipDB episode: Breaking Bad S1E1, exact 3500s cut.
  h.entry.catalogId = "tt0903747";
  h.entry.episodes[0].code = "S1E1"; // Common non-padded chapter labels are also valid.
  h.state.mediaDurationMs = 3_500_000;
  h.setPosition(232);
  h.run('setEpisodeAutoSkip("intro", true)');
  h.wireTimeupdate();
  h.video.paused = true;
  h.tick();
  assert.equal(h.requests.length, 1);
  assert.equal(new URL(h.requests[0].url).searchParams.get("duration"), "3500");
  assert.equal(h.nodes["#watch-skip-intro"].textContent, "Skip intro");
  await h.complete({
    intro: { ...confirmed(229.5, 246.5), confidence: .9 },
    outro: { ...confirmed(3434, 3500), confidence: .9 },
  });
  assert.deepEqual(h.calls, [], "verified data must not seek through paused playback");
  assert.equal(h.nodes["#watch-skip-intro"].textContent, "Skip intro");
  h.video.paused = false;
  h.tick();
  assert.deepEqual(h.calls, [["seek", 246.5]], "playing through a confirmed intro automatically skips it");
  h.tick();
  assert.equal(h.calls.length, 1, "subsequent timeupdate events cannot repeat the seek");
  h.setPosition(3440);
  h.run('setEpisodeAutoSkip("outro", true)');
  assert.deepEqual(h.calls.at(-1), ["next", 1], "confirmed EOF credits safely hand off to the next episode");
});

test("Library chapterLabels provide episode identity when the current source has no parsed episode code", () => {
  const h = fixture();
  h.entry.episodes = [{ fileIndex: 2, code: "S01E99" }];
  h.entry.chapterLabels = { 2: { code: "S1E3" } };
  h.state.currentSource.episode = null;
  h.run("refreshEpisodeSkipOptions");
  assert.equal(h.requests.length, 1);
  assert.equal(new URL(h.requests[0].url).searchParams.get("episode"), "3", "catalog chapter labels beat a stale inferred filename/episode number");
});

test("Missing SkipDB data preserves a simple user preference label without seeking", async () => {
  const h = fixture();
  h.run('setEpisodeAutoSkip("intro", true)');
  h.run("refreshEpisodeSkipOptions");
  assert.equal(h.nodes["#watch-skip-intro"].textContent, "Skip intro");
  h.requests[0].resolve({ ok: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.nodes["#watch-skip-intro"].attributes["aria-pressed"], "true");
  assert.equal(h.nodes["#watch-skip-intro"].textContent, "Skip intro");
  h.run("refreshEpisodeSkipOptions");
  assert.equal(h.requests.length, 1, "no repeated failed provider request on every frame");
  assert.deepEqual(h.calls, [], "a saved preference cannot seek without verified timing");
});

test("Timeline delimiters show only opening and ending without covering seek input", async () => {
  const h = fixture();
  h.run("refreshEpisodeSkipOptions");
  assert.equal(h.nodes["#player-timeline-segments"].innerHTML, "", "no guessed markers while SkipDB is unresolved");
  assert.equal(h.nodes["#player-timeline-summary"].textContent, "", "no guessed timeline labels");
  await h.complete({ intro: confirmed(60, 150), outro: confirmed(1310, 1370) });
  const markers = h.nodes["#player-timeline-segments"].innerHTML;
  assert.match(markers, /player-timeline-segment--opening" style="left:4\.167%;width:6\.250%"/);
  assert.match(markers, /player-timeline-segment--ending" style="left:90\.972%;width:4\.167%"/);
  assert.doesNotMatch(markers, /after-credits/);
  assert.equal(h.nodes["#player-timeline-summary"].textContent, "Opening: 1:00 to 2:30; Ending: 21:50 to 22:50");
  assert.match(html, /id="player-progress-played"[\s\S]*id="player-timeline-segments"[\s\S]*id="compat-progress"/);
  assert.match(html, /id="compat-progress"[^>]*aria-describedby="player-timeline-summary"/);
  assert.match(css, /\.player-timeline-segments\s*\{[^}]*pointer-events:none;/);

  h.state.currentSource.fileIndex = 3;
  h.entry.episodes.push({ fileIndex: 3, code: "S01E04" });
  h.run("refreshEpisodeSkipOptions");
  assert.equal(h.nodes["#player-timeline-segments"].innerHTML, "", "switching episodes clears old chapter markers immediately");
  assert.equal(h.nodes["#player-timeline-summary"].textContent, "", "old episode labels never leak into a new source");
});

test("Agnostic community markers have clean display labels and still never auto-skip", async () => {
  const h = fixture();
  h.run('setEpisodeAutoSkip("intro", true)');
  h.run('setEpisodeAutoSkip("outro", true)');
  h.run("refreshEpisodeSkipOptions");
  await h.complete({
    intro: { ...confirmed(60, 150), match: "agnostic" },
    outro: { ...confirmed(1310, 1370), match: "agnostic" },
  });
  assert.match(h.nodes["#player-timeline-segments"].innerHTML, /player-timeline-segment--opening/);
  assert.match(h.nodes["#player-timeline-segments"].innerHTML, /player-timeline-segment--ending/);
  assert.match(h.nodes["#player-timeline-summary"].textContent, /Opening: 1:00 to 2:30/);
  assert.match(h.nodes["#player-timeline-summary"].textContent, /Ending: 21:50 to 22:50/);
  assert.doesNotMatch(h.nodes["#player-timeline-segments"].innerHTML, /after-credits/, "unmatched-cut outro does not imply a post-credits region");
  assert.deepEqual(h.calls, [], "never auto-skip agnostic timings even with both options enabled");
  assert.equal(h.nodes["#watch-skip-intro"].textContent, "Skip intro");
  assert.equal(h.nodes["#watch-skip-credits"].textContent, "Skip ending");
  assert.doesNotMatch(h.nodes["#watch-skip-intro"].title, /unverified/i);

  const nearEof = fixture();
  nearEof.run("refreshEpisodeSkipOptions");
  await nearEof.complete({ intro: confirmed(60, 150), outro: confirmed(1320, 1439) });
  assert.match(nearEof.nodes["#player-timeline-segments"].innerHTML, /player-timeline-segment--ending/);
  assert.doesNotMatch(nearEof.nodes["#player-timeline-segments"].innerHTML, /after-credits/, "one second after the ending is not a bonus segment");

  const missing = fixture();
  missing.run("refreshEpisodeSkipOptions");
  await missing.complete({ intro: { ...confirmed(60, 150), confidence: .3 }, outro: null });
  assert.equal(missing.nodes["#player-timeline-segments"].innerHTML, "", "low-confidence timings do not draw an intro");
  assert.deepEqual(missing.calls, [], "unverified ranges never auto-seek");
});

test("JJK S1E2 community metadata is displayed simply, never auto-skipped without cut match", async () => {
  const h = fixture();
  h.entry.catalogId = "tt12343534";
  h.entry.episodes[0].code = "S01E02";
  h.run('setEpisodeAutoSkip("intro", true)');
  h.run('setEpisodeAutoSkip("outro", true)');
  h.run("refreshEpisodeSkipOptions");
  // Public SkipDB response for IMDb tt12343534 / S1E2, a 24-minute stream.
  await h.complete({
    intro: { start_ms: 346000, end_ms: 436000, match: "agnostic", confidence: .75 },
    outro: { start_ms: 1336000, end_ms: 1425900, match: "agnostic", confidence: .75 },
  });
  const ranges = h.run("episodeTimelineRanges");
  assert.equal(ranges.length, 2);
  assert.equal(ranges[0].start, 346);
  assert.equal(ranges[1].start, 1336);
  assert.doesNotMatch(h.nodes["#player-timeline-summary"].textContent, /cut not verified/);
  assert.deepEqual(h.calls, [], "community markers do not grant automatic seek without matched source duration");
});

test("No default guessed regions appear even for identifiable episodes with known duration", () => {
  const h = fixture();
  h.run("refreshEpisodeSkipOptions");
  const ranges = h.run("episodeTimelineRanges");
  assert.equal(ranges.length, 0);
  assert.equal(h.nodes["#player-timeline-segments"].innerHTML, "");
  h.run('setEpisodeAutoSkip("intro", true)');
  h.run('setEpisodeAutoSkip("outro", true)');
  assert.deepEqual(h.calls, [], "enabling auto skip never causes a guess-based seek");
  h.entry.episodes = [];
  h.state.currentSource.episode = null;
  h.run("refreshEpisodeSkipOptions");
  assert.equal(h.nodes["#player-timeline-segments"].innerHTML, "", "films and unrecognized sources do not receive fabricated episode markers");
  assert.doesNotMatch(app, /Opening \(estimated\)|Ending \(estimated\)/, "there is no estimated label or range generator");
});

test("Verified single-sided timestamps paint only that interval, never make up the missing opposite marker", async () => {
  const h = fixture();
  h.run("refreshEpisodeSkipOptions");
  await h.complete({ intro: confirmed(60, 150), outro: null });
  assert.match(h.nodes["#player-timeline-segments"].innerHTML, /player-timeline-segment--opening/);
  assert.doesNotMatch(h.nodes["#player-timeline-segments"].innerHTML, /player-timeline-segment--ending|after-credits/);
  const endingOnly = fixture();
  endingOnly.run("refreshEpisodeSkipOptions");
  await endingOnly.complete({ intro: null, outro: confirmed(1320, 1439) });
  assert.doesNotMatch(endingOnly.nodes["#player-timeline-segments"].innerHTML, /player-timeline-segment--opening/);
  assert.match(endingOnly.nodes["#player-timeline-segments"].innerHTML, /player-timeline-segment--ending/);
});

test("Normal and theater players keep controls inset, use nearly square corners and have no bright frame outline", () => {
  assert.match(css, /\.video-frame\s*\{[^}]*border:0;\s*border-radius:6px;\s*box-shadow:0 24px 90px rgba\(0,0,0,\.72\);/);
  assert.doesNotMatch(css, /0 0 0 1px #1d1d1d/);
  assert.match(css, /\.watch-player-layout\.is-theater \.compat-controls\s*\{[^}]*clamp\(18px,2\.5vw,32px\)/);
  assert.match(css, /\.compat-controls\s*\{[^}]*padding:82px clamp\(18px,2vw,30px\) 20px;/);
});

test("Seek hover labels stay inside player edges and use simple timestamp - Opening/Ending", () => {
  const bubble = { hidden: true, textContent: "", style: {}, offsetWidth: 220 };
  const context = vm.createContext({
    $: (selector) => selector === "#player-scrub-time" ? bubble : null,
    compatProgress: { max: "1440", getBoundingClientRect: () => ({ width: 600 }) },
    episodeTimelineRanges: () => [
      { start: 60, end: 150, label: "Opening" },
      { start: 1370, end: 1440, label: "Ending" },
    ],
    formatTime: (ms) => `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`,
  });
  vm.runInContext(extract("function showScrubTime(", "\nfunction endScrub()"), context);
  vm.runInContext("showScrubTime(60)", context);
  assert.equal(bubble.textContent, "1:00 - Opening");
  assert.ok(parseFloat(bubble.style.left) >= 116);
  vm.runInContext("showScrubTime(1439)", context);
  assert.equal(bubble.textContent, "23:59 - Ending");
  assert.ok(parseFloat(bubble.style.left) <= 484, "right edge cannot clip the seek bubble");
  assert.match(css, /\.player-scrub-time\s*\{[^}]*max-width:calc\(100% - 12px\)/);
});

test("One anonymous duration-aware lookup produces contextual intro and post-credits actions", async () => {
  const h = fixture();
  h.run("refreshEpisodeSkipOptions");
  assert.equal(h.requests.length, 1);
  const url = new URL(h.requests[0].url);
  assert.equal(url.hostname, "api.skipdb.tv");
  assert.equal(url.searchParams.get("imdb_id"), "tt1234567");
  assert.equal(url.searchParams.get("season"), "1");
  assert.equal(url.searchParams.get("episode"), "3");
  assert.equal(url.searchParams.get("duration"), "1440");
  assert.equal(h.requests[0].options.credentials, "omit");
  await h.complete({ intro: confirmed(60, 150), outro: confirmed(1310, 1370) });
  assert.equal(h.nodes["#watch-skip-intro"].attributes["aria-pressed"], "false");
  h.setPosition(0);
  h.run("refreshEpisodeSkipOptions");
  h.run('setEpisodeAutoSkip("intro", true)');
  assert.deepEqual(h.calls, [], "a cold open before an opening must not be skipped");
  h.setPosition(65);
  h.run("refreshEpisodeSkipOptions");
  assert.deepEqual(h.calls, [["seek", 150]]);
  h.setPosition(1320);
  h.run("refreshEpisodeSkipOptions");
  assert.equal(h.requests.length, 1, "no requests on every timeupdate");
  h.run('setEpisodeAutoSkip("outro", true)');
  assert.deepEqual(h.calls.at(-1), ["seek", 1370]);
});

test("Out-of-range or weak metadata never authorizes a blind skip", async () => {
  const h = fixture();
  h.run("refreshEpisodeSkipOptions");
  await h.complete({ intro: { ...confirmed(60, 150), match: "out-of-range" },
    outro: { ...confirmed(1310, 1370), confidence: .3 } });
  h.setPosition(1320);
  h.run('setEpisodeAutoSkip("intro", true)');
  h.run('setEpisodeAutoSkip("outro", true)');
  h.run("refreshEpisodeSkipOptions");
  assert.equal(h.nodes["#watch-skip-intro"].attributes["aria-pressed"], "true");
  assert.equal(h.nodes["#watch-skip-credits"].attributes["aria-pressed"], "true");
  assert.equal(h.nodes["#watch-skip-intro"].textContent, "Skip intro", "controls stay visually simple despite unavailable timings");
  assert.deepEqual(h.calls, []);
});

test("Hunter x Hunter duration-agnostic manual skip markers are usable without automatic seeking", async () => {
  const h = fixture();
  h.entry.catalogId = "";
  h.state.currentSource.catalogId = "tt2098220";
  h.entry.episodes = [];
  h.state.currentSource.episode = { code: "S01E03" };
  h.run("refreshEpisodeSkipOptions");
  assert.equal(new URL(h.requests[0].url).searchParams.get("imdb_id"), "tt2098220");
  await h.complete({
    intro: { ...confirmed(45, 125), match: "agnostic", confidence: .75 },
    outro: { ...confirmed(1310, 1390), match: "agnostic", confidence: .75 },
  });
  assert.equal(h.nodes["#watch-skip-intro"].attributes["aria-pressed"], "false");
  h.setPosition(1320);
  h.run("refreshEpisodeSkipOptions");
  assert.equal(h.nodes["#watch-skip-credits"].attributes["aria-pressed"], "false");
  assert.deepEqual(h.calls, [], "data only offers a button; it never skips automatically");
});

test("A confirmed outro ending at EOF advances only to the known next chapter", async () => {
  const h = fixture();
  h.setPosition(1380);
  h.run("refreshEpisodeSkipOptions");
  await h.complete({ intro: null, outro: confirmed(1330, 1439) });
  h.run('setEpisodeAutoSkip("outro", true)');
  assert.deepEqual(h.calls, [["next", 1]]);
});

test("An obsolete timestamp request cannot enable another episode's skip buttons", async () => {
  const h = fixture();
  h.run("refreshEpisodeSkipOptions");
  const oldRequest = h.requests[0];
  h.state.currentSource.fileIndex = 3;
  h.entry.episodes.push({ fileIndex: 3, code: "S01E04" });
  h.run("refreshEpisodeSkipOptions");
  assert.equal(oldRequest.options.signal.aborted, true);
  await h.complete({ intro: confirmed(60, 150) }, 0);
  h.run('setEpisodeAutoSkip("intro", true)');
  assert.deepEqual(h.calls, [], "late markers for the wrong episode must not skip");
  h.setVisible(false);
  h.run("refreshEpisodeSkipOptions");
  assert.equal(h.requests[1].options.signal.aborted, true);
});

test("The Watch and Settings autoplay switches share one preference and cancel countdown when off", () => {
  const settings = { checked: true, listeners: [] };
  const inline = { pressed: "true", listeners: [], setAttribute(_key, value) { this.pressed = value; } };
  const stored = [];
  const ctx = vm.createContext({
    $: (name) => name === "#watch-autoplay-next" ? settings : name === "#watch-autoplay-inline" ? inline : null,
    autoNextEnabled: true,
    localStorage: { setItem: (...args) => stored.push(args) },
    cancelAutoNext: () => stored.push(["cancelled"]),
  });
  for (const node of [settings, inline]) node.addEventListener = (_, listener) => node.listeners.push(listener);
  vm.runInContext(extract('const autoNextToggle = $("#watch-autoplay-next")', '\n$("#player-retry-source")'), ctx);
  inline.listeners[0]();
  assert.equal(settings.checked, false);
  assert.equal(inline.pressed, "false");
  assert.deepEqual(stored, [["lvl-autoplay-next", "0"], ["cancelled"]]);
  settings.checked = true;
  settings.listeners[0]();
  assert.equal(inline.pressed, "true");
  assert.deepEqual(stored.at(-1), ["lvl-autoplay-next", "1"]);
});
