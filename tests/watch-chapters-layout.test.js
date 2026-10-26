import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const styles = readFileSync(new URL("../frontend/styles/styles.css", import.meta.url), "utf8");
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");

function divMarkup(start) {
  assert.ok(start >= 0, "Expected a div element");
  let depth = 0;
  const tags = /<div\b[^>]*>|<\/div\s*>/gi;
  tags.lastIndex = start;
  for (const tag of html.matchAll(tags)) {
    if (tag.index < start) continue;
    depth += tag[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return { start, end: tag.index + tag[0].length, markup: html.slice(start, tag.index + tag[0].length) };
  }
  throw new Error("Div was not closed");
}

test("episode rail stays beside the player while subtitle options fit below video in its own column", () => {
  const layout = divMarkup(html.indexOf('<div id="watch-player-layout"'));
  const main = divMarkup(html.indexOf('<div class="watch-player-main">', layout.start));
  assert.ok(main.end < layout.end, "Player main sits inside the two-column layout");
  assert.match(main.markup, /id="video-frame"/);
  assert.match(main.markup, /class="transport-strip watch-transport"/);
  assert.ok(main.markup.includes('class="panel side-panel subtitle-dock"'), "Subtitle options stay with the player instead of dropping below a tall sidebar");
  assert.ok(main.markup.indexOf('class="panel side-panel subtitle-dock"') > main.markup.indexOf('id="video-frame"'), "Subtitle options are below the video");
  for (const id of ["track-list", "embedded-subtitle-section", "find-subtitles-web", "subtitle-dock-style"]) {
    assert.ok(main.markup.includes(`id="${id}"`), `Subtitle control ${id} remains available`);
    assert.equal(html.match(new RegExp(`id="${id}"`, "g"))?.length, 1, `Subtitle control ${id} is unique`);
  }
  const rail = html.indexOf('<section id="watch-chapters"', layout.start);
  assert.ok(rail > main.end && rail < layout.end, "Episode rail sits to the right of the player main");
  assert.match(styles, /\.watch-player-layout\.has-chapters\s*\{\s*display:grid/);
  assert.match(styles, /@container watch-page \(max-width:1050px\)/, "Episode rail reflows with usable content width, including navigation drawer");
});

test("Episodes is one player-height surface; Seasons stays below as separate navigation", () => {
  assert.match(html, /id="watch-chapters"[\s\S]*?<strong>Episodes<\/strong>/);
  assert.doesNotMatch(html, /Episodes &amp; seasons/);
  assert.ok(html.indexOf('id="watch-chapters-body"') < html.indexOf('id="watch-seasons"'), "season tiles remain below the episode list");
  assert.match(styles, /@container watch-page \(min-width:1051px\)\s*\{[\s\S]*?\.watch-player-layout\.has-chapters:not\(\.is-theater\) \.watch-chapters\s*\{[^}]*height:var\(--watch-episode-player-height, min\(70vh,680px\)\);[^}]*max-height:var\(--watch-episode-player-height, min\(70vh,680px\)\);/);
  assert.match(styles, /\.watch-chapters:not\(\[hidden\]\)\s*\{ display:grid; grid-template-rows:auto minmax\(0,1fr\); \}/, "fixed-height grid track bounds episode list independently of content");
  assert.match(styles, /\.watch-chapters__body\s*\{[^}]*display:block; height:100%; min-height:0;[^}]*overflow-y:auto;/, "the overflow child fills only its bounded track");
  assert.doesNotMatch(html, /<details id="watch-chapters"/, "there is no collapse affordance");
  assert.doesNotMatch(app, /lvl-watch-chapters-open/, "obsolete open/collapse preference is not consulted");
  assert.match(app, /new ResizeObserver\(syncWatchEpisodeHeight\)\.observe\(frame\)/, "height follows the video when its width changes");
  const render = app.slice(app.indexOf("function renderWatchChapters()"), app.indexOf("\nasync function findWatchEpisodeSources(", app.indexOf("function renderWatchChapters()")));
  assert.match(render, /return `<ol class="watch-episode-list">/, "episode list does not draw its own accordion/container");
  assert.doesNotMatch(render, /<details class="watch-season"/, "no nested season accordion around each episode");
  assert.match(render, /const seasonsNode = \$\("#watch-seasons"\)/, "separate season switcher is retained");
  assert.match(styles, /\.watch-episode-list\s*\{[^}]*border:0;/, "no duplicate nested list outline");
});

test("Episodes list centers the cards and remains a bounded scroll area on wide, stacked and theater layouts", () => {
  assert.match(html, /id="watch-chapters-body" class="watch-chapters__body" role="region" aria-label="Episode list" tabindex="0"/, "episode list can be focused for keyboard navigation");
  assert.match(styles, /\.watch-chapters__body\s*\{[^}]*overflow-y:auto; overscroll-behavior-y:auto; scrollbar-gutter:stable both-edges;/,
    "both-sided scrollbar gutters center the episode cards and allow native wheel, touch and keyboard scroll");
  assert.match(styles, /\.watch-episode-list\s*\{[^}]*width:100%; min-width:0;/, "episode cards fill the centered inner rail");
  assert.match(styles, /\.watch-side-rail\s*\{[^}]*grid-template-columns:minmax\(0,1fr\);/, "wide side panel never sizes to the list's intrinsic content");
  assert.match(styles, /\.watch-chapters\s*\{[^}]*width:100%; box-sizing:border-box;/, "panel fills its column without asymmetric indent");
  assert.match(styles, /\.watch-player-layout\.has-chapters \.watch-chapters\s*\{ height:min\(70vh,680px\); max-height:min\(70vh,680px\); \}/,
    "normal layout has a finite height even before the video measurement");
  assert.match(styles, /@container watch-page \(max-width:1050px\)[\s\S]*?\.watch-player-layout\.has-chapters \.watch-chapters\s*\{ height:min\(75vh,760px\);/,
    "stacked panel has its own definite scroll track");
  assert.match(styles, /\.watch-player-layout\.has-chapters\.is-theater \.watch-chapters\s*\{ height:min\(80vh,840px\);/,
    "theater panel has its own definite scroll track");
});

test("Wheel and touchpad scroll inside Episodes without trapping the page at scroll limits", () => {
  const section = app.slice(app.indexOf("function scrollWatchEpisodesOnWheel("), app.indexOf("\nlet watchEpisodeContextCode ="));
  assert.match(section, /addEventListener\("wheel",[\s\S]*?\{ passive: false, capture: true \}/, "capture wheel before child buttons and only cancel while scrolling is possible");
  const context = vm.createContext({});
  vm.runInContext(section.slice(0, section.indexOf('\n$("#watch-chapters")?.addEventListener("wheel"')), context);
  const scroll = vm.runInContext("scrollWatchEpisodesOnWheel", context);
  const body = { scrollTop: 0, scrollHeight: 2200, clientHeight: 500 };
  let cancelled = 0;
  const wheel = (deltaY, deltaMode = 0) => ({ deltaY, deltaMode, preventDefault: () => { cancelled++; } });
  scroll(wheel(70), body);
  assert.equal(body.scrollTop, 70, "wheel works over content, independent of scrolling the whole page");
  scroll(wheel(3, 1), body);
  assert.equal(body.scrollTop, 124, "line-based mouse wheel deltas scroll correctly");
  scroll(wheel(1, 2), body);
  assert.equal(body.scrollTop, 624, "page-based assistive input scrolls the list");
  scroll(wheel(10000), body);
  assert.equal(body.scrollTop, 1700, "cannot scroll beyond last episode");
  const before = cancelled;
  scroll(wheel(40), body);
  assert.equal(cancelled, before, "at bottom, don't trap the wheel");
  scroll(wheel(-10000), body);
  assert.equal(body.scrollTop, 0);
  scroll(wheel(-40), body);
  assert.equal(cancelled, before + 1, "at top, don't trap an outward wheel movement");
  body.scrollHeight = 200;
  scroll(wheel(40), body);
  assert.equal(cancelled, before + 1, "no interception if episodes fit without overflow");
});

test("Library playback starts with the selected permanent episode rail visible during source discovery", () => {
  const start = app.indexOf("function preparePlayerForLibraryLoad(");
  const end = app.indexOf("\nasync function resolveTorrentMagnet(", start);
  assert.ok(start >= 0 && end > start);
  const entry = { id: "saved-anime", title: "Saved Anime" };
  const episode = { fileIndex: 2, code: "S01E03" };
  const events = [];
  const context = vm.createContext({
    watchPendingSelection: null,
    state: { loadingProgress: 0, currentMediaProbe: null, mediaDurationMs: 42, currentMs: 0 },
    setWatchTheaterMode: (enabled) => { assert.equal(enabled, false); events.push("normal"); },
    rememberWatchSelection: (libraryId, fileIndex) => {
      assert.equal(libraryId, entry.id);
      assert.equal(fileIndex, episode.fileIndex);
    },
    beginSourceTransition: () => {}, video: { pause: () => {} },
    cancelTranscodeStart: () => {},
    frame: { classList: { add: () => {} } },
    $: () => ({ hidden: true, textContent: "" }),
    revealPlayerControls: () => {}, updatePlayerIdentity: () => {}, setPlayerLoadingTitle: () => {},
    setPlayerLoading: () => {}, switchView: (view) => { assert.equal(view, "watch"); events.push("watch"); },
    renderWatchChapters: () => {
      events.push("rail");
      assert.equal(context.watchPendingSelection.libraryId, entry.id);
      assert.equal(context.watchPendingSelection.fileIndex, episode.fileIndex);
    },
  });
  vm.runInContext(app.slice(start, end), context);
  context.preparePlayerForLibraryLoad(entry, episode);
  assert.deepEqual(events, ["normal", "watch", "rail"]);

  const render = app.slice(app.indexOf("function renderWatchChapters()"), app.indexOf("\nlet autoNextInterval"));
  assert.match(render, /const source = watchPendingSelection \|\| state\.currentSource/);
  const source = app.slice(app.indexOf("function setCurrentTorrentSource("), app.indexOf("\nlet playbackLoadRequestId"));
  assert.match(source, /watchPendingSelection = null/);
  const playing = app.slice(app.indexOf("async function playTorrentFile("), app.indexOf("\nfunction preparePlayerForLibraryLoad("));
  assert.match(playing, /switchView\("watch"\);\s*renderWatchChapters\(\)/);
});

test("Watch fills available desktop space and has larger responsive season/episode controls", () => {
  assert.match(styles, /\.watch-page\s*\{\s*width:100%;\s*max-width:none;\s*container:watch-page \/ inline-size;/);
  assert.match(styles, /\.watch-player-layout\.has-chapters\s*\{[^}]*clamp\(350px,23vw,450px\)/);
  assert.match(styles, /\.watch-episode__details\s*\{[^}]*grid-template-columns:clamp\(65px,29%,116px\)/);
  assert.match(styles, /\.watch-episode__play\s*\{[^}]*cursor:pointer;/);
  assert.match(styles, /\.watch-episode__sources\[hidden\]\s*\{\s*display:none;/);
  assert.match(styles, /\.watch-season-tile\s*\{[^}]*aspect-ratio:1\.45\/1;/);
  assert.match(styles, /@container watch-subtitles \(min-width:900px\)/);
  assert.match(styles, /@media \(max-width:680px\)/);
});

test("Every desktop view shares the topbar hamburger and hidden YouTube-style drawer without reserving player width", () => {
  assert.match(styles, /\.app-shell,\.app-shell\.sidebar-expanded\s*\{[^}]*display:block;[^}]*width:100%;/, "Off-canvas nav must not create a page track or a ghost sidebar gap");
  assert.match(styles, /\.app-main\s*\{[^}]*--app-gutter:clamp\(12px,1\.3vw,20px\);[^}]*--ui-gutter:var\(--app-gutter\);[^}]*width:100%;[^}]*margin:0;[^}]*padding:0 var\(--app-gutter\) 54px;/, "Shared main content and UI elements use the same compact left/right gutter");
  assert.match(styles, /\.app-sidebar\s*\{[^}]*position:fixed;[^}]*transform:translateX\(-100%\); visibility:hidden; pointer-events:none;/);
  assert.match(styles, /\.sidebar-expanded \.app-sidebar\s*\{[^}]*transform:translateX\(0\); visibility:visible; pointer-events:auto;/);
  assert.match(styles, /\.app-shell\.sidebar-expanded::before\s*\{[^}]*position:fixed;[^}]*z-index:35;/);
  assert.match(styles, /\.app-topbar\s*\{\s*margin-inline:/);
  assert.match(styles, /\.app-shell:not\(:has\(#view-home\.is-active\)\) #section-topbar\s*\{\s*display:flex;/, "Every non-Home view uses its own searchable section topbar");
  const sharedHeader = html.indexOf('id="home-topbar"');
  assert.ok(sharedHeader > html.indexOf('<main class="app-main">') && sharedHeader < html.indexOf('id="view-home"'));
  assert.equal((html.match(/id="app-sidebar-toggle"/g) || []).length, 1);
  assert.match(html, /id="app-sidebar-toggle"[^>]+aria-controls="app-primary-nav"/);
  assert.ok(html.indexOf('id="app-sidebar-toggle"') > sharedHeader && html.indexOf('id="app-sidebar-toggle"') < html.indexOf('</header>', sharedHeader));
  assert.match(app, /for \(const launcher of \[\$\("#app-sidebar-toggle"\), \$\("#section-sidebar-toggle"\)\]\) launcher\?\.addEventListener\("click"/);
  assert.match(app, /event\.target\.closest\("\.app-sidebar, #app-sidebar-toggle"\)/, "Hamburger click must not dismiss its own just-opened drawer");
  assert.match(styles, /@media \(min-width:681px\)/, "Mobile keeps horizontal navigation");
  assert.match(app, /event\.key !== "Escape"/, "Escape dismisses the drawer");
  assert.match(styles, /\.sidebar-toggle\s*\{\s*display:none;\s*\}/, "Nonfunctional mobile drawer toggle is hidden");
});

test("Watch player controls adapt to usable video width, not just viewport width", () => {
  assert.match(styles, /\.watch-player-main\s*\{\s*container:watch-player-main \/ inline-size;/);
  assert.match(styles, /@container watch-player-main \(max-width:900px\)/);
  assert.match(styles, /@container watch-player-main \(max-width:620px\)/);
  assert.match(styles, /@container watch-player-main \(max-width:900px\)\s*\{[\s\S]*?\.player-control-row\s*\{\s*flex-wrap:wrap;/);
});

test("episode rail uses the same wide thumbnails and watched/progress overlays as Library", () => {
  assert.match(app, /const thumbnail = chapter\.thumbnail \|\| wideFallback/);
  assert.match(app, /data-fallback-src=/);
  assert.match(app, /class="lib-chapter-thumb watch-episode__thumb"/);
  assert.match(app, /class="lib-chapter-progress"/);
  assert.match(app, /class="lib-chapter-watched"/);
  assert.match(app, /refreshImages\(body\)/);
});

test("Watch starts directly with the player and title details link from the card below", () => {
  const header = html.slice(html.indexOf('<section class="panel player-panel">'), html.indexOf('<div id="watch-player-layout"'));
  assert.match(header, /<h1 id="media-title" class="ui-visually-hidden">/);
  assert.doesNotMatch(header, /watch-titlebar|media-episode-label|media-context|player-open-library|media-status/);
  assert.equal(html.match(/id="media-status"/g)?.length, 1);
  assert.match(app, /class="watch-info-facts"/);
  assert.match(app, /class="watch-info-genres"/);
  assert.match(app, /class="watch-info-title-link" data-watch-title-details/);
  assert.doesNotMatch(app, />View full details/);
  for (const label of ["First aired", "Episodes", "Runtime", "Starring", "Directed by"]) {
    assert.ok(app.includes(`"${label}"`), `${label} exists in title details`);
  }
});

test("Watch loads full chapter metadata independent of collapsing and exposes retry after a catalog error", () => {
  const start = app.indexOf("function renderWatchChapters()");
  const end = app.indexOf("\nlet autoNextInterval", start);
  const code = app.slice(start, end);
  assert.doesNotMatch(code, /root\.open|if \(!root\.open\)/, "metadata and episodes remain available without accordion state");
  assert.match(code, /data-watch-retry-chapters/);
  assert.match(app, /catalogChapterList\(catalogId, refreshWatchCatalogDetails\)/);
  assert.match(app, /watchCatalogIdFor\(series\)/);
});

test("Miruro-style Watch information stays separate from player and subtitles", () => {
  const layout = divMarkup(html.indexOf('<div id="watch-player-layout"'));
  const main = divMarkup(html.indexOf('<div class="watch-player-main">', layout.start));
  assert.ok(main.markup.includes('id="video-frame"'), "Original player remains");
  assert.ok(main.markup.includes('id="subtitle-overlay"'), "Original in-player subtitles remain");
  assert.ok(main.markup.includes('id="watch-title-info"'), "Description is below player transport");
  assert.ok(layout.markup.includes('id="watch-side-rail"'), "Right rail is present");
  for (const id of ["watch-chapters", "watch-seasons", "watch-related", "watch-recommended"]) {
    assert.ok(layout.markup.includes(`id="${id}"`), `Sidebar includes ${id}`);
  }
  assert.ok(!main.markup.includes('id="watch-related"'), "Suggestions do not cover the video");
  assert.match(app, /watchSidebarPicks\(state\.homeCatalog/);
  assert.match(app, /data-watch-title-details/);
  assert.match(app, /data-watch-title-id/);
  assert.match(app, /data-watch-season/);
});
