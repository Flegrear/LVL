import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { anilistInfo } from "../frontend/anilist/anilist-library.js";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../frontend/styles/styles.css", import.meta.url), "utf8");
const recs = readFileSync(new URL("../backend/recommendations/recs-service.js", import.meta.url), "utf8");

test("Watch uses matching pressed-pill toggles, with no checkboxes or redundant subtitle search", () => {
  const row = html.slice(html.indexOf('class="watch-skip-options"'), html.indexOf('class="transport-strip watch-transport"'));
  for (const id of ["watch-skip-intro", "watch-skip-credits", "watch-autoplay-inline"])
    assert.match(row, new RegExp(`id="${id}"[^>]*aria-pressed=`));
  assert.doesNotMatch(row, /type="checkbox"/);
  assert.match(css, /\.watch-skip-action\[aria-pressed="true"\]/);
  assert.match(css, /\.watch-skip-action::before\s*\{\s*content:"✓";[^}]*flex:0 0 13px; width:13px;[^}]*color:transparent;/, "disabled toggles reserve the invisible tick slot");
  assert.match(css, /\.watch-skip-action\[aria-pressed="true"\]::before\s*\{ color:#fff; \}/,
    "active skip/autoplay toggles show a free-standing white tick");
  assert.doesNotMatch(html, /id="subtitle-search-more"|Try more title variants/);
  assert.doesNotMatch(app, /\$\("#subtitle-search-more"\)/);
});

test("Audio details retain codec and playback path without long disclaimer prose", () => {
  const source = app.slice(app.indexOf("function renderAudioPlaybackDetails()"), app.indexOf("\nfunction renderPlayerAudioMenu()"));
  assert.match(source, /<dt>Audio output<\/dt>/);
  assert.match(source, /<dt>Playback path<\/dt>/);
  assert.doesNotMatch(source, /Re-encoded for safe timing|Output is planned, not a measurement|Converted to compatible lossy AAC/);
});

test("Non-home section topbar reuses the larger LVL brand icon next to the hamburger", () => {
  const bar = html.slice(html.indexOf('id="section-topbar"'), html.indexOf("</header>", html.indexOf('id="section-topbar"')));
  assert.ok(bar.indexOf('id="section-view-icon"') > bar.indexOf('id="section-sidebar-toggle"'));
  assert.match(bar, /id="section-view-icon"[^>]*src="\/brand\/lvl_app_icon_dark\.svg"[^>]*width="42" height="42"/);
  assert.match(css, /\.section-view-icon\s*\{[^}]*width:42px; height:42px; object-fit:contain;/);
  assert.doesNotMatch(app, /topbarIcon\.innerHTML = document\.querySelector/);
});

test("Library has a left status sidebar and a separate main toolbar without redundant banners", () => {
  const page = html.slice(html.indexOf('id="view-library"'), html.indexOf('id="view-title"'));
  assert.doesNotMatch(page, /id="library-summary"|id="library-anilist-summary"|id="library-add-title"/);
  assert.ok(page.indexOf('id="library-status-filter"') < page.indexOf('class="lib-main"'));
  for (const status of ["any", "CURRENT", "COMPLETED", "PLANNING", "PAUSED", "DROPPED", "REPEATING"])
    assert.match(page, new RegExp(`data-library-status="${status}"[^>]*aria-pressed=`));
  assert.ok(page.indexOf('id="library-add-magnet"') > page.indexOf('id="library-sort"'));
  assert.ok(page.indexOf('id="library-more"') > page.indexOf('id="library-add-magnet"'));
  assert.match(page, /id="library-add-magnet"[^>]*>Add magnet<\/button>/);
  assert.match(page, /id="library-show-anilist"/, "AniList discovery remains in overflow menu");
  assert.match(css, /\.lib-page \{[^}]*padding:6px/);
  assert.match(css, /\.lib-page \{[^}]*grid-template-columns:210px minmax\(0,1fr\)/);
  assert.match(css, /\.lib-page \{[^}]*width:100%; max-width:none; margin:0;/, "sidebar starts near the left gutter, not in a centered max-width wrapper");
  assert.match(css, /\.lib-status-option\[aria-pressed="true"\] \{[^}]*color:#fff;/);
  assert.match(css, /\.lib-status-option\[aria-pressed="true"\] \.lib-status-count \{ color:#fff; \}/);
  assert.doesNotMatch(css, /\.lib-status-option\[aria-pressed="true"\][^}]*#[bB]7[fF][aA]42/);
  assert.match(css, /@media \(max-width:860px\) \{[^}]*\.lib-page \{ grid-template-columns:minmax\(0,1fr\);/);
});

test("Library public score survives AniList import without misusing a personal rating", () => {
  const info = anilistInfo({ showId: "show", averageScore: 86.3, seasons: [
    { season: 1, score: 10, episodes: 12 }, { season: 2, score: 6, episodes: 12 },
  ] });
  assert.equal(info.averageScore, 86.3);
  const card = app.slice(app.indexOf("function libraryCardItem("), app.indexOf("\nfunction libraryMoreButton("));
  assert.match(card, /anilist\?\.averageScore/);
  assert.match(card, /\$\{knownEpisodes\} eps/);
  assert.doesNotMatch(card, /anilistRatingText\(anilist\)/);
  assert.match(recs, /averageScore: publicScores\.length/);
  assert.match(app, /function backfillAniListCommunityScores\(\)/);
  assert.match(app, /fillMissingAniListAverages\(state\.library, data\.shows\)/);
  assert.equal(anilistInfo({ showId: "none", averageScore: null }).averageScore, null);
});

test("Paused media errors do not replace a fully loaded player with recovery/error UI", () => {
  const start = app.indexOf('video.addEventListener("error", () => {');
  const end = app.indexOf('\n$("#compat-play")', start);
  assert.ok(start > 0 && end > start);
  const events = {};
  let recoveries = 0;
  const video = { paused: true, dataset: { mode: "transcode" } };
  const state = { loadingProgress: 100, pendingSeek: null };
  const context = vm.createContext({
    video, state,
    recoveryPlaybackRequested: false,
    currentRecoveryKey: () => "valid",
    recoveryBusy: false,
    recoverPlayback: () => { recoveries += 1; },
    frame: { classList: { remove() {} } },
    $: () => ({ hidden: false, textContent: "" }),
  });
  video.addEventListener = (event, fn) => { events[event] = fn; };
  vm.runInContext(app.slice(start, end), context);
  events.error();
  assert.equal(recoveries, 0);
  video.paused = false;
  events.error();
  assert.equal(recoveries, 1, "actual playing errors still request recovery");
});

test("Explicit resume clears an earlier failed overlay before using the normal logo loader", () => {
  const start = app.indexOf('video.addEventListener("play", () => {');
  const end = app.indexOf('\nvideo.addEventListener("pause"', start);
  assert.ok(start > 0 && end > start);
  let play;
  const calls = [];
  const context = vm.createContext({
    video: { addEventListener: (_, callback) => { play = callback; } },
    recoveryPlaybackRequested: false,
    recoveryPauseSerial: 0,
    recoveryDisplayPhase: "failed",
    state: { pendingSeek: null },
    resetRecoveryDisplay: () => calls.push("reset"),
    setPlayerLoading: (progress, title) => calls.push([progress, title]),
    resyncTranscodeAfterLongPause: () => calls.push("resume"),
  });
  vm.runInContext(app.slice(start, end), context);
  play();
  assert.deepEqual(calls, ["reset", [28, "Resuming playback"], "resume"]);
});
