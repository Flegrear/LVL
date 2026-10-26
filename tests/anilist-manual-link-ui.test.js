import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { seriesAniList } from "../frontend/anilist/anilist-library.js";
import { ANILIST_MANUAL_ID_VERIFY, parseManualAniListId,
  planVerifiedManualAniListSeason } from "../frontend/anilist/anilist-manual-season-link.js";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const from = app.indexOf("function titleProgressMarkup(");
const handlerFrom = app.indexOf("let anilistTitleManualLinkSerial = 0;");
const end = app.indexOf("\nfunction titleAboutMarkup(", handlerFrom);
assert.ok(from > 0 && handlerFrom > from && end > handlerFrom);

function setup({ confirm = true, episodes = 26, localCode = "S01E01", codeOnly = false,
  asyncVerify = false, remoteId = 14719, accountPresent = true } = {}) {
  const firstAccount = { userId: 42, token: "TEST-OAUTH-TOKEN" };
  let account = accountPresent ? firstAccount : null;
  const media = { id: remoteId, format: "TV", episodes, seasonYear: 2012,
    title: { english: "JoJo's Bizarre Adventure (TV)" }, relations: { edges: [] } };
  const meta = { id: "tt2359704", name: "JoJo's Bizarre Adventure", releaseInfo: "2012–",
    seasons: [{ season: 1, count: 26, episodes: [{ episode: 1, released: "2012-10-06" }] }] };
  const entry = { id: "jojo-video", watchedChapters: { [localCode]: true },
    episodes: [{ code: localCode, season: codeOnly ? null : Number(localCode.slice(1, 3)),
      episode: codeOnly ? null : Number(localCode.split("E")[1]) }] };
  const series = { key: "jojo", title: "JoJo's Bizarre Adventure", mediaKind: "anime", type: "series",
    catalogId: "tt2359704", seasons: new Map([[1, []]]), sources: [entry] };
  const status = { textContent: "", isConnected: true, classList: { toggle: () => {} } };
  const selected = { value: "1" };
  const pasted = { value: "https://anilist.co/anime/14719" };
  const calls = [];
  const writes = [];
  let finishVerify = null;
  const ctx = vm.createContext({
    Date, Number, Object, Promise, RegExp, Set, localStorage: {},
    seriesAniList, parseManualAniListId, ANILIST_MANUAL_ID_VERIFY, planVerifiedManualAniListSeason,
    catalogSeriesView: { meta, seasons: [{ season: 1 }] },
    readAniListAccount: () => account,
    titleSubject: () => ({ series }),
    $: (id) => ({ "#title-anilist-link-id": pasted, "#title-anilist-link-season": selected,
      "#title-anilist-link-results": status })[id],
    fetchJson: async (url) => { calls.push(["catalog", url]); return { meta }; },
    anilistGraphql: async (token, query, variables) => {
      calls.push(["AniList", query, variables]);
      assert.equal(token, firstAccount.token);
      if (asyncVerify) await new Promise((resolve) => { finishVerify = resolve; });
      return { Media: media };
    },
    window: { confirm: () => { calls.push(["confirm"]); return confirm; } },
    chapterCode: (s, e) => `S${String(s).padStart(2, "0")}E${String(e).padStart(2, "0")}`,
    updateLibrarySeriesEntries: (key, update) => {
      assert.equal(key, series.key); update(entry); writes.push(structuredClone(entry));
    },
    toast: (message) => calls.push(["toast", message]),
  });
  vm.runInContext(app.slice(from, handlerFrom), ctx);
  vm.runInContext(app.slice(handlerFrom, end), ctx);
  const link = vm.runInContext("handleTitleAniListLink", ctx);
  const markup = vm.runInContext("titleProgressMarkup", ctx);
  const event = { target: { closest: (selector) => selector === "[data-title-anilist-link]" ? {} : null } };
  return { entry, series, status, selected, pasted, calls, writes, media, meta,
    link: () => link(event), markup: () => markup({ series, id: meta.id }, {}),
    changeAccount: (next) => { account = next; }, completeVerification: () => finishVerify?.(),
    changeTitle: (next) => { series.key = next; } };
}

test("Missing AniList links render only a collapsed compact URL/ID fallback, not the huge search panel", () => {
  const env = setup();
  const markup = env.markup();
  assert.match(markup, /<details class="title-anilist-manual"/);
  assert.match(markup, /<summary>Link AniList manually<\/summary>/);
  assert.match(markup, /id="title-anilist-link-id"/);
  assert.match(markup, /data-title-anilist-link/);
  assert.match(markup, /<option value="1">1<\/option>/);
  assert.doesNotMatch(markup, /This anime season is not linked|Search AniList|Find anime|title-anilist-link__candidate/);
  assert.equal(setup({ accountPresent: false }).markup(), "");
  env.entry.anilistManualLinks = [{ userId: 42, season: 1, anilistId: 14719,
    episodes: 26, format: "TV", title: "JoJo's Bizarre Adventure" }];
  assert.equal(env.markup(), "", "Already linked seasons have no fallback");
  assert.match(app, /\$\("#title-progress"\)\?\.addEventListener\("click", \(event\) => \{ void handleTitleAniListLink\(event\); \}\)/);
});

test("Confirmed exact ID association persists only local account/season metadata with no remote mutations", async () => {
  const env = setup();
  await env.link();
  assert.equal(env.writes.length, 1);
  assert.equal(env.calls.filter((call) => call[0] === "AniList").length, 1);
  assert.equal(env.calls.find((call) => call[0] === "AniList")[1], ANILIST_MANUAL_ID_VERIFY);
  assert.deepEqual(JSON.parse(JSON.stringify(env.calls.find((call) => call[0] === "AniList")[2])), { id: 14719 });
  assert.deepEqual(JSON.parse(JSON.stringify(env.entry.anilistManualLinks.map((part) =>
    [part.userId, part.season, part.anilistId, part.episodes, part.format]))), [[42, 1, 14719, 26, "TV"]]);
  assert.doesNotMatch(JSON.stringify(env.entry), /TEST-OAUTH-TOKEN|"progress"|"status"/);
  assert.match(env.calls.find((call) => call[0] === "catalog")[1], /tt2359704/);
});

test("Invalid ID, declined confirmation, wrong count, and code-only watched overflow never save", async () => {
  const invalid = setup(); invalid.pasted.value = "https://evil.test/anime/14719";
  await invalid.link();
  assert.equal(invalid.writes.length, 0);
  assert.match(invalid.status.textContent, /valid AniList/);
  const cancelled = setup({ confirm: false });
  await cancelled.link();
  assert.equal(cancelled.writes.length, 0);
  const mismatch = setup({ episodes: 24 });
  await mismatch.link();
  assert.equal(mismatch.writes.length, 0);
  assert.match(mismatch.status.textContent, /complete catalog season/);
  const unwatchedOverflow = setup({ localCode: "S01E27", codeOnly: true });
  await unwatchedOverflow.link();
  assert.equal(unwatchedOverflow.writes.length, 0);
  assert.match(unwatchedOverflow.status.textContent, /fewer episodes/);
});

test("Account change, season change or removed title during ID verification cancels local write", async () => {
  for (const change of [
    (env) => env.changeAccount({ userId: 43, token: "OTHER" }),
    (env) => { env.selected.value = "2"; },
    (env) => { env.pasted.value = "9999"; },
    (env) => env.changeTitle("different-title"),
  ]) {
    const env = setup({ asyncVerify: true });
    const pending = env.link();
    await new Promise((resolve) => setImmediate(resolve));
    change(env);
    env.completeVerification();
    await pending;
    assert.equal(env.writes.length, 0);
  }
});

test("Typing a different AniList ID never silently overwrites an existing linked season", async () => {
  const env = setup();
  env.entry.anilistManualLinks = [{ userId: 42, season: 1, anilistId: 2222, format: "TV", episodes: 26 }];
  await env.link();
  assert.equal(env.writes.length, 0);
  assert.match(env.status.textContent, /cannot be verified/);
});
