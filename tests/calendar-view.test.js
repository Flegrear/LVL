import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { calendarAddDays, calendarAniListIds, calendarDateKey, calendarLibraryEvents, calendarMatchLibrary,
  calendarTorrentLookup, calendarTorrentSummary, calendarWeekStart, createCalendarView, validCalendarDate } from "../frontend/calendar/calendar-view.js";

const index = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const app = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../frontend/calendar/calendar.css", import.meta.url), "utf8");
const surface = fs.readFileSync(new URL("../frontend/calendar/calendar-surface.js", import.meta.url), "utf8");

const makeSeries = (other = {}) => ({
  key: "frieren", title: "Frieren: Beyond Journey's End", catalogId: "tt22248376",
  type: "series", mediaKind: "anime", coverUrl: "https://example.test/frieren.jpg",
  sources: [{ watchedChapters: { S01E01: false }, episodes: [{ code: "S01E01", progress: { finished: true } }] }],
  ...other,
});
const chapterMap = () => new Map([["tt22248376", { chapters: [
  { season: 1, episode: 1, released: "2026-10-13", name: "Past and Present" },
  { season: 1, episode: 1, released: "2026-10-13", name: "Duplicate source" },
  { season: 1, episode: 2, released: "2026-10-14", name: "For the Future" },
  { season: 1, episode: 3, released: "2026-02-30", name: "Invalid" },
  { season: 1, episode: 4, released: "", name: "No date" },
] , seasons: [{ season: 0, episodes: [{ episode: 1, released: "2026-10-15", name: "Special" }] }] }]]);

test("Calendar handles dates, ISO validity, leap days and local Monday start", () => {
  assert.equal(calendarDateKey(calendarWeekStart(new Date(2026, 9, 14, 12))), "2026-10-12");
  assert.equal(calendarDateKey(calendarWeekStart(new Date(2026, 9, 18, 12))), "2026-10-12");
  assert.equal(calendarDateKey(calendarAddDays(new Date(2026, 11, 31, 12), 1)), "2027-01-01");
  assert.equal(validCalendarDate("2024-02-29"), true);
  for (const bad of ["2026-02-29", "2026-02-30", "2026-13-01", "2026-00-10", "2026/10/15", "not-a-date"])
    assert.equal(validCalendarDate(bad), false, `Do not display invalid air date ${bad}`);
});

test("Calendar reuses authoritative catalog dates, dedupes episodes and respects manual unwatch", () => {
  const events = calendarLibraryEvents([makeSeries()], chapterMap());
  assert.deepEqual(events.map((row) => row.code), ["S01E01", "S01E02", "S00E01"]);
  assert.deepEqual(events.map((row) => row.date), ["2026-10-13", "2026-10-14", "2026-10-15"]);
  assert.equal(events[0].watched, false, "Manual unwatch overrides stale finished position");
  assert.equal(events[0].time, null, "Date-only catalog must never invent broadcast hour");
  assert.equal(events[0].preview, false);
  assert.equal(calendarLibraryEvents([makeSeries({ type: "movie" })], chapterMap()).length, 0);
});

test("Public releases match saved titles only through ids or exact year/title, and respect unwatch", () => {
  const event = { id: "anilist:600", providerId: "1234", source: "AniList",
    type: "anime", title: "Frieren", code: "S01E01", date: "2026-10-13" };
  const library = [makeSeries({ sources: [{ anilist: { anilistId: 1234 }, watchedChapters: { S01E01: false },
    episodes: [{ code: "S01E01", progress: { finished: true } }] }] })];
  assert.deepEqual(calendarMatchLibrary([event], library).map((row) => [row.inMyList, row.seriesKey, row.watched]),
    [[true, "frieren", false]]);
  assert.equal(calendarMatchLibrary([{ ...event, providerId: "9999", title: "Unrelated" }], library)[0].inMyList, false);
});

test("A saved first season tracks sequel episodes with their own season art and title", () => {
  const library = [makeSeries({ key: "opm", title: "One Punch Man", catalogId: "tt4508902",
    sources: [{ externalSource: "ANILIST", externalId: "100", anilistId: 100,
      anilist: { seasons: [{ anilistId: 100, season: 1 }] } }] })];
  assert.deepEqual(calendarAniListIds(library), [100]);
  const releases = [
    { id: "anilist:330", providerId: "300", linkedAniListIds: [100], type: "anime",
      title: "One Punch Man Season 3", artwork: "https://example.test/season3.jpg", date: "2026-10-23", code: "EP 4", source: "AniList" },
    { id: "anilist:999", providerId: "999", type: "anime", title: "Unrelated anime",
      date: "2026-10-23", code: "EP 4", source: "AniList" },
  ];
  const [sequel, unrelated] = calendarMatchLibrary(releases, library);
  assert.equal(sequel.inMyList, true);
  assert.equal(sequel.seriesKey, "opm");
  assert.equal(sequel.title, "One Punch Man Season 3");
  assert.equal(sequel.artwork, "https://example.test/season3.jpg");
  assert.equal(sequel.fallbackArtwork, "https://example.test/frieren.jpg");
  assert.equal(unrelated.inMyList, false);
});

test("Month cards use episode artwork and retain a second image when the first fails", async () => {
  const root = { innerHTML: "", addEventListener() {} };
  const calendar = createCalendarView({ root, notice: { hidden: true, addEventListener() {} },
    getSeries: () => [makeSeries({ sources: [{ externalSource: "ANILIST", externalId: "100" }] })],
    getChapterList: () => null, openTitle() {}, storage: { getItem: () => null, setItem() {} },
    now: () => new Date(2026, 9, 23, 12),
    fetchReleases: async () => ({ events: [{ id: "anilist:330", providerId: "300", linkedAniListIds: [100],
      type: "anime", title: "One Punch Man Season 3", source: "AniList", code: "EP 4", date: "2026-10-23",
      artwork: "https://example.test/season3.jpg" }] }),
  });
  calendar.activate();
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(root.innerHTML, /src="https:\/\/example\.test\/season3\.jpg"/);
  assert.match(root.innerHTML, /data-calendar-image-alternate="https:\/\/example\.test\/frieren\.jpg"/);
  assert.match(root.innerHTML, /One Punch Man Season 3/);
  assert.match(root.innerHTML, /EP 4/);
});

test("Broken episode artwork falls back through show art before using a placeholder", () => {
  const listeners = new Map();
  createCalendarView({ root: { addEventListener: (event, callback) => listeners.set(event, callback) },
    getSeries: () => [], getChapterList: () => null, openTitle() {},
    storage: { getItem: () => null, setItem() {} } });
  const img = { tagName: "IMG", src: "https://example.test/episode.jpg", dataset: {
    calendarImageTitle: "One Punch Man", calendarImageAlternate: "https://example.test/season3.jpg",
    calendarImageLast: "https://example.test/season1.jpg",
  } };
  listeners.get("error")({ target: img });
  assert.equal(img.src, "https://example.test/season3.jpg");
  listeners.get("error")({ target: img });
  assert.equal(img.src, "https://example.test/season1.jpg");
  listeners.get("error")({ target: img });
  assert.match(img.src, /.+/, "The final placeholder should still be provided");
  assert.equal(img.dataset.calendarImageFallback, "final");
});

test("Torrent status uses exact catalog episode identity and distinguishes missing sources from provider outages", () => {
  assert.deepEqual(calendarTorrentLookup({ catalogId: "tt22248376", code: "S01E02", type: "anime" }),
    { type: "series", id: "tt22248376:1:2" });
  assert.deepEqual(calendarTorrentLookup({ catalogId: "tt1234567", type: "movie" }),
    { type: "movie", id: "tt1234567" });
  assert.equal(calendarTorrentLookup({ catalogId: "tt22248376", code: "EP 2", type: "anime" }), null);
  assert.equal(calendarTorrentLookup({ catalogId: "", code: "S01E02", type: "series" }), null);
  assert.match(calendarTorrentSummary({ streams: [{ peers: 12 }, { peers: 8 }], providers: [{ ok: true }] }), /2 torrent sources - up to 12 reported peers/);
  assert.match(calendarTorrentSummary({ streams: [], providers: [{ ok: true }] }), /No torrents found/);
  assert.match(calendarTorrentSummary({ streams: [], providers: [{ ok: false }] }), /providers unavailable/);
});

test("AniList absolute episode numbers gain an exact catalog chapter only for a unique airing date", async () => {
  const now = () => new Date(2026, 9, 14, 12);
  const publicRelease = { id: "anilist:202", providerId: "1234", source: "AniList", type: "anime",
    title: "Frieren", date: "2026-10-14", timestamp: Date.UTC(2026, 9, 14, 12), code: "EP 2" };
  const makeCalendar = (chapters) => {
    const listeners = new Map();
    const root = { innerHTML: "", addEventListener: (kind, callback) => listeners.set(kind, callback) };
    const calendar = createCalendarView({ root, notice: { hidden: true, addEventListener() {} },
      getSeries: () => [makeSeries({ sources: [{ anilist: { anilistId: 1234 } }] })],
      getChapterList: () => ({ chapters, seasons: [] }), openTitle() {},
      storage: { getItem: () => null, setItem() {} }, now,
      fetchReleases: async () => ({ events: [publicRelease] }),
    });
    calendar.activate();
    assert.match(root.innerHTML, /data-calendar-open-day="2026-10-14"/);
    listeners.get("click")({ target: { closest: () => ({ dataset: { calendarOpenDay: "2026-10-14" } }) } });
    return root;
  };
  const unique = makeCalendar([{ season: 1, episode: 2, released: "2026-10-14", name: "A Real Title" }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(unique.innerHTML, /data-calendar-event="anilist:202"/);
  assert.match(unique.innerHTML, /S01E02 - A Real Title/);
  assert.doesNotMatch(unique.innerHTML, /data-calendar-event="tt22248376:S01E02"/, "One event per matched chapter");

  const ambiguous = makeCalendar([
    { season: 1, episode: 2, released: "2026-10-14" },
    { season: 1, episode: 3, released: "2026-10-14" },
  ]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(ambiguous.innerHTML, /data-calendar-event="anilist:202"/);
  assert.match(ambiguous.innerHTML, /EP 2/, "Two chapters on one date must not create a guessed mapping");
});

test("Calendar sidebar and assets are wired without the removed release notification", () => {
  assert.match(index, /data-view="calendar" title="Calendar" aria-label="Calendar"/);
  assert.match(index, /id="view-calendar" class="view"/);
  assert.doesNotMatch(index, /calendar-release-alert|NEW EPISODE AIR DATE PASSED/);
  assert.match(index, /href="\/calendar\.css"/);
  assert.match(app, /calendar: "\/calendar"/);
  assert.match(app, /createCalendarView\(/);
  assert.match(app, /if \(view === "calendar"\) calendarUi\.activate\(\)/);
  assert.match(server, /\["\/calendar", \{ file: "index.html"/);
  assert.match(server, /\["\/calendar-view\.js", \{ file: "frontend\/calendar\/calendar-view\.js"/);
  assert.match(server, /\["\/calendar-surface\.js", \{ file: "frontend\/calendar\/calendar-surface\.js"/);
  assert.match(css, /\.calendar-page/);
  assert.doesNotMatch(css, /\.calendar-release-alert/);
  assert.doesNotMatch(app, /refreshNotice|calendar-release-alert/);
  assert.match(css, /\.calendar-week-layout/);
  assert.match(surface, /calendar-time-grid/);
  assert.doesNotMatch(css, /#[A-Fa-f0-9]{6}.*(?:pink|purple)/i);
});

test("Calendar offers only Month and Week, with untimed releases accessible in the weekly list", async () => {
  const listeners = new Map();
  const root = { innerHTML: "", addEventListener: (kind, callback) => listeners.set(kind, callback) };
  const storage = { getItem: () => null, setItem() {} };
  const calendar = createCalendarView({ root, getSeries: () => [makeSeries()],
    getChapterList: () => chapterMap().get("tt22248376"), openTitle: () => {},
    fetchReleases: async () => ({ events: [
      { id: "tmdb:movie:7", providerId: "7", title: "October Movie", type: "movie",
        date: "2026-10-16", code: "PREMIERE", episodeTitle: "Movie premiere", source: "TMDb" },
    ], coverage: { "AniList": { status: "ok" }, "TVmaze": { status: "ok" }, "TMDb": { status: "ok" } } }),
    storage, now: () => new Date(2026, 9, 14, 12) });
  calendar.activate();
  await new Promise((resolve) => setImmediate(resolve));
  assert.doesNotMatch(root.innerHTML, /data-calendar-scope=|All Anime|All anime/);
  assert.doesNotMatch(root.innerHTML, /All releases|data-calendar-source/);
  assert.match(root.innerHTML, /data-calendar-mode="week"/);
  assert.match(root.innerHTML, /data-calendar-mode="month"/);
  assert.doesNotMatch(root.innerHTML, /data-calendar-mode="(?:day|season)"/);
  assert.match(root.innerHTML, /data-calendar-type="anime"/);
  assert.match(root.innerHTML, /data-calendar-type="movie"/);
  assert.match(root.innerHTML, /data-calendar-type="series"/);
  assert.equal(calendar.getState().mode, "month");
  assert.match(root.innerHTML, /calendar-month-cells/);
  assert.doesNotMatch(root.innerHTML, /calendar-inspector/);
  assert.match(root.innerHTML, /Frieren: Beyond Journey&#39;s End/);
  assert.match(root.innerHTML, /calendar-month-event-art/);
  assert.match(root.innerHTML, /S01E02 - For the Future/);
  assert.doesNotMatch(root.innerHTML, /October Movie/, "Unlisted public premieres must not fill the calendar");
  assert.doesNotMatch(root.innerHTML, /NEW EPISODE AIR DATE PASSED|Source availability not verified/);

  listeners.get("click")({ target: { closest: () => ({ dataset: { calendarDate: "2026-10-14" } }) } });
  assert.equal(calendar.getState().mode, "week");
  assert.match(root.innerHTML, /calendar-week-layout/);
  assert.match(root.innerHTML, /calendar-time-grid/);
  assert.match(root.innerHTML, /calendar-quest-panel/);
  assert.match(root.innerHTML, /calendar-list__item/);
  assert.match(root.innerHTML, /calendar-week-untimed-art/);
  assert.doesNotMatch(root.innerHTML, /October Movie/);
  listeners.get("click")({ target: { closest: () => ({ dataset: { calendarMode: "week" } }) } });
  assert.match(root.innerHTML, /calendar-week-headers/);
  listeners.get("click")({ target: { closest: () => ({ dataset: { calendarMode: "month" } }) } });
  assert.match(root.innerHTML, /calendar-month-cells/);
  listeners.get("click")({ target: { closest: () => ({ dataset: { calendarMode: "season" } }) } });
  assert.equal(calendar.getState().mode, "month", "Retired view modes cannot be entered");
});

test("Large matched schedules load agenda rows in batches and Refresh bypasses the range cache", async () => {
  const listeners = new Map();
  const root = { innerHTML: "", addEventListener: (kind, callback) => listeners.set(kind, callback) };
  const notice = { innerHTML: "", hidden: true, addEventListener() {} };
  const calls = [];
  const calendar = createCalendarView({
    root, notice, getSeries: () => [makeSeries()], getChapterList: () => null, openTitle: () => {},
    storage: { getItem: () => null, setItem() {} },
    now: () => new Date(2026, 9, 14, 12),
    fetchReleases: async (args) => {
      calls.push(args);
      return { events: Array.from({ length: 200 }, (_, i) => ({
          id: `tvmaze:${i}`, providerId: String(i), catalogId: "tt22248376", title: `Show ${i}`,
        date: "2026-10-14", type: "series", code: "S01E01", episodeTitle: "Episode",
        source: "TVmaze",
      })), coverage: { TVmaze: { status: "ok" } } };
    },
  });
  listeners.get("click")({ target: { closest: () => ({ dataset: { calendarMode: "week" } }) } });
  calendar.activate();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((root.innerHTML.match(/class="calendar-list__item/g) || []).length, 80);
  assert.match(root.innerHTML, /Show more releases \(120 remaining\)/);

  const clickAttr = (name) => listeners.get("click")({ target: {
    closest: () => ({ dataset: {}, hasAttribute: (attribute) => attribute === name }),
  } });
  clickAttr("data-calendar-more");
  assert.equal((root.innerHTML.match(/class="calendar-list__item/g) || []).length, 160);
  assert.match(root.innerHTML, /Show more releases \(40 remaining\)/);
  clickAttr("data-calendar-retry");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 2);
  assert.equal(calls[1].force, true);
});

test("Month navigation fetches its visible range once and preserves list and type filters", async () => {
  const listeners = new Map();
  const root = { innerHTML: "", addEventListener: (kind, callback) => listeners.set(kind, callback) };
  const calls = [];
  const calendar = createCalendarView({
    root, notice: { hidden: true, addEventListener() {} }, getSeries: () => [makeSeries()], getChapterList: () => null,
    openTitle() {}, storage: { getItem: () => null, setItem() {} }, now: () => new Date(2026, 9, 18, 12),
    fetchReleases: async (args) => {
      calls.push(args);
      return { events: [{ id: `movie:${args.from}`, title: `Premiere ${args.from}`, type: "movie",
        date: args.from, code: "PREMIERE" }], coverage: { TMDb: { status: "ok" } } };
    },
  });
  calendar.activate();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.map(({ from, to }) => [from, to]), [["2026-09-28", "2026-11-01"]]);
  listeners.get("click")({ target: { closest: () => ({ dataset: { calendarNav: "next" }, hasAttribute: () => false }) } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.slice(-1).map(({ from, to }) => [from, to]), [["2026-10-26", "2026-12-06"]]);
  assert.equal(calendar.getState().publicCount, 1);
  assert.match(root.innerHTML, /calendar-month-view/);
  assert.doesNotMatch(root.innerHTML, /Premiere 2026/, "Unlisted provider results stay hidden");
  listeners.get("click")({ target: { closest: () => ({ dataset: { calendarType: "anime" } }) } });
  assert.equal((root.innerHTML.match(/class="calendar-month-cell/g) || []).length >= 35, true);
  assert.match(root.innerHTML, /0 releases/);
  assert.equal(calendar.getState().sourceMode, "list");
  assert.doesNotMatch(root.innerHTML, /data-calendar-source/);
});

test("An empty user list never requests the global public TV schedule", async () => {
  const root = { innerHTML: "", addEventListener() {} };
  let requests = 0;
  const calendar = createCalendarView({ root, notice: { hidden: true, addEventListener() {} },
    getSeries: () => [], getChapterList: () => null, openTitle() {},
    storage: { getItem: () => null, setItem() {} }, now: () => new Date(2026, 9, 19, 12),
    fetchReleases: async () => { requests++; return { events: [] }; },
  });
  calendar.activate();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests, 0);
  assert.doesNotMatch(root.innerHTML, /data-calendar-scope=|All Anime/);
});

test("Calendar excludes unsaved anime and no longer offers public All Anime scope", async () => {
  const listeners = new Map();
  const root = { innerHTML: "", addEventListener: (kind, callback) => listeners.set(kind, callback) };
  const calls = [];
  const show = makeSeries({ sources: [{ externalSource: "ANILIST", externalId: "100" }] });
  const releases = [
    { id: "anilist:saved", providerId: "300", linkedAniListIds: [100], type: "anime", source: "AniList",
      date: "2026-10-23", title: "Saved Season 3", code: "EP 4", artwork: "https://example.test/season3.jpg" },
    { id: "anilist:other", providerId: "400", type: "anime", source: "AniList",
      date: "2026-10-23", title: "Unsaved Seasonal Anime", code: "EP 2", artwork: "https://example.test/other.jpg" },
    { id: "tvmaze:news", type: "series", source: "TVmaze", date: "2026-10-23", title: "ABC News", code: "S01E02" },
    { id: "tmdb:film", type: "movie", source: "TMDb", date: "2026-10-23", title: "Public Movie", code: "PREMIERE" },
  ];
  const calendar = createCalendarView({ root, getSeries: () => [show], getChapterList: () => null,
    openTitle() {}, storage: { getItem: () => null, setItem() {} }, now: () => new Date(2026, 9, 23, 12),
    fetchReleases: async (args) => { calls.push(args); return { events: releases, coverage: { AniList: { status: "ok" } } }; },
  });
  calendar.activate();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls[0].scope, "list");
  assert.match(root.innerHTML, /Saved Season 3/);
  assert.doesNotMatch(root.innerHTML, /Unsaved Seasonal Anime|ABC News|Public Movie/);
  assert.equal(calendar.getState().sourceMode, "list");
  assert.match(root.innerHTML, /data-calendar-type="anime"/);
  assert.doesNotMatch(root.innerHTML, /All Anime|data-calendar-scope/);
  listeners.get("click")({ target: { closest: () => ({ dataset: { calendarScope: "anime-all" }, hasAttribute: () => false }) } });
  assert.equal(calls.length, 1, "An obsolete scope action must not trigger a public release request");
  assert.equal(calendar.getState().sourceMode, "list");
  assert.doesNotMatch(root.innerHTML, /Unsaved Seasonal Anime/);
});

test("An empty Library cannot trigger the removed public anime feed", async () => {
  const listeners = new Map();
  const root = { innerHTML: "", addEventListener: (kind, callback) => listeners.set(kind, callback) };
  let calls = 0;
  const calendar = createCalendarView({ root, getSeries: () => [], getChapterList: () => null,
    openTitle() {}, storage: { getItem: () => null, setItem() {} }, now: () => new Date(2026, 9, 23, 12),
    fetchReleases: () => { calls++; throw new Error("No public feed expected"); },
  });
  const click = (scope) => listeners.get("click")({ target: { closest: () => ({ dataset: { calendarScope: scope }, hasAttribute: () => false }) } });
  calendar.activate();
  assert.equal(calls, 0);
  click("anime-all");
  assert.equal(calls, 0);
  assert.equal(calendar.getState().sourceMode, "list");
  assert.doesNotMatch(root.innerHTML, /All Anime|data-calendar-scope|Current Public Anime/);
});

test("Calendar artwork is large enough to recognize in both views, agenda and details", () => {
  assert.match(css, /\.calendar-month-event-art\s*\{[^}]*width:45px;\s*height:62px/);
  assert.match(css, /\.calendar-agenda-art\s*\{[^}]*width:58px;\s*height:80px/);
  assert.match(css, /\.calendar-time-event-art\s*\{[^}]*width:38px;\s*height:49px/);
  assert.match(css, /\.calendar-week-untimed-art\s*\{[^}]*width:42px;\s*height:59px/);
  assert.match(css, /\.calendar-detail-poster\s*\{[^}]*width:90px;\s*height:126px/);
});

test("Week calendar uses one horizontal scroller for day headers, untimed cards and hourly events", () => {
  assert.match(css, /\.calendar-week-view\s*\{[^}]*overflow-x:auto;\s*overflow-y:hidden/);
  assert.match(css, /\.calendar-week-view \.calendar-timeline-scroll\s*\{[^}]*overflow-x:hidden;\s*overflow-y:auto/);
  assert.match(css, /\.calendar-week-headers\s*\{[^}]*padding-right:var\(--calendar-week-gutter,0px\)/);
  assert.match(css, /\.calendar-week-untimed\s*\{[^}]*padding-right:var\(--calendar-week-gutter,0px\)/);
  assert.match(surface, /class="calendar-week-headers"/);
  assert.match(surface, /class="calendar-week-untimed"/);
});

test("Torrent hover checks only the focused saved episode, then displays reported peer counts", async () => {
  const listeners = new Map();
  const tip = { hidden: true, textContent: "", style: {} };
  const root = { innerHTML: "", addEventListener: (kind, callback) => listeners.set(kind, callback),
    querySelector: (selector) => selector === ".calendar-torrent-tooltip" ? tip : null };
  const lookups = [];
  const calendar = createCalendarView({ root, notice: { hidden: true, addEventListener() {} },
    getSeries: () => [makeSeries()], getChapterList: () => chapterMap().get("tt22248376"),
    openTitle() {}, storage: { getItem: () => null, setItem() {} }, now: () => new Date(2026, 9, 14, 12),
    fetchReleases: async () => ({ events: [{ id: "unlisted", title: "ABC News", date: "2026-10-14", type: "series" }] }),
    checkTorrentAvailability: async (lookup) => {
      lookups.push(lookup);
      return { streams: [{ peers: 14 }, { peers: 5 }], providers: [{ ok: true }] };
    },
  });
  calendar.activate();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lookups.length, 0, "Opening the calendar never triggers torrent searches");
  assert.doesNotMatch(root.innerHTML, /ABC News/);
  const button = { dataset: { calendarEvent: "tt22248376:S01E02" } };
  listeners.get("focusin")({ target: { closest: () => button } });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(lookups, [{ type: "series", id: "tt22248376:1:2" }]);
  assert.match(tip.textContent, /2 torrent sources - up to 14 reported peers/);
  assert.equal(tip.hidden, false);
  listeners.get("focusout")({ target: { closest: () => button } });
  assert.equal(tip.hidden, true);
});

test("Growie-style release panel can be resized from the keyboard with a saved width", () => {
  const listeners = new Map();
  const saved = new Map();
  const root = { innerHTML: "", addEventListener: (kind, callback) => listeners.set(kind, callback) };
  const calendar = createCalendarView({ root, notice: { hidden: true, addEventListener() {} },
    getSeries: () => [], getChapterList: () => null, openTitle() {},
    storage: { getItem: (key) => saved.get(key), setItem: (key, value) => saved.set(key, value) },
    now: () => new Date(2026, 9, 18, 12), fetchReleases: async () => ({ events: [] }),
  });
  listeners.get("click")({ target: { closest: () => ({ dataset: { calendarMode: "week" } }) } });
  calendar.activate();
  assert.match(root.innerHTML, /data-calendar-resize role="separator"/);
  assert.match(root.innerHTML, /aria-valuenow="340"/);
  listeners.get("keydown")({ target: { closest: () => ({}) }, key: "ArrowRight", preventDefault() {} });
  assert.equal(calendar.getState().panelWidth, 364);
  assert.equal(saved.get("lvl-calendar-panel-width-v1"), "364");
  listeners.get("keydown")({ target: { closest: () => ({}) }, key: "Home", preventDefault() {} });
  assert.equal(calendar.getState().panelWidth, 240);
});

test("Navigating does not rescan saved shows, and catalog loads stay bounded and batch their redraws", async () => {
  const listeners = new Map();
  let paints = 0;
  let scans = 0;
  let markup = "";
  const root = { addEventListener: (kind, callback) => listeners.set(kind, callback),
    set innerHTML(value) { paints++; markup = value; }, get innerHTML() { return markup; } };
  const waiting = new Map();
  const shows = Array.from({ length: 12 }, (_, index) => makeSeries({
    key: `show-${index}`, catalogId: `tt${String(100000 + index)}`,
  }));
  const calendar = createCalendarView({ root, notice: { hidden: true, addEventListener() {} },
    getSeries: () => { scans++; return shows; },
    getChapterList: (id, callback) => { waiting.set(id, callback); return null; },
    openTitle() {}, storage: { getItem: () => null, setItem() {} },
    now: () => new Date(2026, 9, 18, 12), fetchReleases: async () => ({ events: [] }),
  });
  calendar.activate();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(waiting.size, 6, "Only six catalog requests should start together");
  for (const action of ["next", "previous", "next"])
    listeners.get("click")({ target: { closest: () => ({ dataset: { calendarNav: action }, hasAttribute: () => false }) } });
  listeners.get("click")({ target: { closest: () => ({ dataset: { calendarType: "anime" } }) } });
  assert.equal(scans, 1, "Period and filter changes should reuse the indexed library");

  const before = paints;
  for (const callback of [...waiting.values()]) callback({ chapters: [], seasons: [] });
  assert.equal(waiting.size, 12, "Completing requests makes room for the next batch");
  await new Promise((resolve) => setTimeout(resolve, 125));
  assert.ok(paints - before <= 2, "One burst of completed requests should trigger at most two redraws");
});
