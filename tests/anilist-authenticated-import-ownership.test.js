import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { anilistInfo, importedEntryId, planAniListLibrary, seriesAniList,
  verifiedAniListLibraryIdentity } from "../frontend/anilist/anilist-library.js";
import { resolveAniListEpisode } from "../frontend/anilist/anilist-watch-sync.js";

const source = readFileSync(new URL("../app.js", import.meta.url), "utf8");
function section(begin, end) {
  const from = source.indexOf(begin);
  const to = source.indexOf(end, from + begin.length);
  assert.ok(from > 0 && to > from, `Missing application seam ${begin}`);
  return source.slice(from, to);
}

const show = {
  showId: "anilist:270000", anilistId: 270000, title: "Witch Hat Atelier",
  imdbId: "tt32550889", type: "series", year: 2026,
  seasons: [{ season: 1, anilistId: 270000, episodes: 13, format: "ONA",
    status: "CURRENT", progress: 8, score: 8.9 }],
};

test("Account-owned AniList media needs an exact saved catalog or explicit source identity", () => {
  const saved = { catalogId: "tt32550889", sources: [{ id: "saved" }] };
  assert.equal(verifiedAniListLibraryIdentity(saved, show), true);
  assert.equal(verifiedAniListLibraryIdentity({ ...saved, catalogId: "tt7654321" }, show), false,
    "matching names cannot authorize an unrelated title's progress or score edits");
  assert.equal(verifiedAniListLibraryIdentity({ catalogId: "", sources: [{
    externalSource: "ANILIST", externalId: "270000",
  }] }, show), true);
  assert.equal(verifiedAniListLibraryIdentity({ catalogId: "", sources: [{
    externalSource: "ANILIST", externalId: "999999",
  }] }, show), false);
});

function fixture({ authenticatedAt = 456789, responseAt = 456789, currentAccount = true,
  catalogId = "tt32550889", alreadyImported = false } = {}) {
  const account = { userId: 52, token: "synthetic-token", username: "fixture" };
  const entry = { id: "saved", title: "Witch Hat Atelier", catalogId,
    watchedChapters: {}, episodes: [], anilist: null };
  const series = { key: "witch hat atelier", title: entry.title, catalogId,
    type: "series", mediaKind: "anime", sources: [entry], aliases: [] };
  if (alreadyImported) entry.anilist = anilistInfo(show);
  let writes = 0;
  const context = vm.createContext({
    state: { library: [entry] },
    localStorage: { setItem() {} },
    ANILIST_LIBRARY_KEY: "last-list-refresh", anilistLibraryRun: null,
    readAniListAccount: () => currentAccount ? account : null,
    syncAniListAuthenticatedRatings: async () => ({ settings: {
      anilist: { syncedAt: authenticatedAt },
    } }),
    fetchJson: async () => ({ syncedAt: responseAt, shows: [show] }),
    applyAniListLibrary: undefined, // Supplied by the real source declaration below.
    planAniListLibrary, buildLibrarySeries: () => [series], librarySeriesKey: (title) => title.toLowerCase(),
    verifiedAniListLibraryIdentity, importedEntryId,
    saveLibrary: () => { writes++; },
    $: () => ({ classList: { contains: () => false } }),
    viewActive: () => false, updateLibrarySummary() {}, refreshTitlePage() {},
    recsUi: { invalidateRatings() {} },
    setToolStatus() {}, toast() {},
    calendarUi: { refresh() {} },
    console: { warn() {} },
  });
  vm.runInContext(section("function syncAniListLibrary(", "\n// Once per AniList sync:"), context);
  vm.runInContext(section("function applyAniListLibrary(", "\n// Unlinking AniList:"), context);
  vm.runInContext(section("function applyAniListRemoteWatchHistory(", "\nasync function syncAniListAuto("),
    Object.assign(context, { seriesAniList, resolveAniListEpisode,
      explicitlyUnwatchedChapter: () => false }));
  return { account, entry, series, context, get writes() { return writes; } };
}

test("A just-verified same-account import turns cached 8/13 into eight local watched chapters", async () => {
  const env = fixture({ alreadyImported: true });
  assert.equal(seriesAniList(env.series, env.account.userId), null,
    "unscoped legacy imports must not have implicit ownership before refresh");
  await env.context.syncAniListLibrary({ quiet: true });
  assert.equal(env.entry.anilist.accountUserId, env.account.userId);
  assert.equal(seriesAniList(env.series, env.account.userId).seasons[0].progress, 8);
  assert.equal(Object.keys(env.entry.watchedChapters).length, 8);
  assert.ok(env.entry.watchedChapters.S01E08);
  assert.equal(env.entry.watchedChapters.S01E09, undefined);
  assert.ok(env.writes >= 2, "authenticated Library import also updates local watched markers immediately");
});

test("Stale or unauthenticated imports remain display-only, even for an exact title", async () => {
  for (const options of [{ authenticatedAt: 0 }, { responseAt: 456790 }, { currentAccount: false }]) {
    const env = fixture(options);
    await env.context.syncAniListLibrary({ quiet: true });
    assert.equal(env.entry.anilist.accountUserId, null);
    assert.equal(seriesAniList(env.series, env.account.userId), null);
    assert.equal(env.context.applyAniListRemoteWatchHistory(new Map([[270000,
      { mediaId: 270000, progress: 8, status: "CURRENT" }]]), env.account.userId), false);
    assert.deepEqual(env.entry.watchedChapters, {});
  }
});

test("An authenticated but ambiguous title match must not permit local progress writes", async () => {
  const env = fixture({ catalogId: "tt7654321" });
  await env.context.syncAniListLibrary({ quiet: true });
  assert.equal(env.entry.anilist.accountUserId, null);
  assert.equal(seriesAniList(env.series, env.account.userId), null);
});
