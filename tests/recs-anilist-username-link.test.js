import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { linkAniListUsername } from "../frontend/recommendations/recs-ui.js";

const recsUi = readFileSync(new URL("../frontend/recommendations/recs-ui.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../frontend/styles/ui.css", import.meta.url), "utf8");

test("Link for the connected AniList Viewer imports the private list directly without public 404", async () => {
  const calls = [];
  const result = await linkAniListUsername({
    username: "My_Anime", connectedUsername: "my_anime",
    importConnectedAniList: async () => { calls.push("authenticated browser import"); return { settings: { anilist: { count: 121 } } }; },
    postJson: async () => { calls.push("public username API"); throw new Error("AniList returned HTTP 404."); },
  });
  assert.deepEqual(calls, ["authenticated browser import"]);
  assert.equal(result.authenticated, true);
  assert.equal(result.data.settings.anilist.count, 121);
});

test("Link for another AniList username stays public and never uses connected user's OAuth", async () => {
  const calls = [];
  const result = await linkAniListUsername({
    username: "friend", connectedUsername: "my_anime",
    importConnectedAniList: async () => { throw new Error("Must not access a different account with own token"); },
    postJson: async (url, body) => { calls.push([url, body]); return { settings: { anilist: { count: 19 } } }; },
  });
  assert.equal(result.authenticated, false);
  assert.deepEqual(calls, [["/api/recs/anilist/link", { username: "friend" }]]);
});

test("Public 404 gives the private-list recovery path; other failures stay unmodified", async () => {
  await assert.rejects(() => linkAniListUsername({ username: "private", postJson: async () => {
    throw new Error("AniList returned HTTP 404.");
  } }), /connect AniList below to import a private list/i);
  await assert.rejects(() => linkAniListUsername({ username: "busy", postJson: async () => {
    throw new Error("Rate limit reached");
  } }), /Rate limit reached/);
});

test("Public Link never starts an unintended authenticated pull after importing its own snapshot", () => {
  const section = recsUi.slice(recsUi.indexOf('$("#recs-anilist-form")?.addEventListener'),
    recsUi.indexOf('$("#recs-anilist-sync")?.addEventListener'));
  assert.match(section, /onAniListChange\(true, ratingsStatus, \{ skipAuthPull: true \}\)/);
  assert.doesNotMatch(section, /skipAuthPull: useViewer/);
});

test("Shared UI-Elements toast preserves the dark border and alert icon without white left glow", () => {
  assert.match(css, /\.ui-toast\s*\{[^}]*border: 1px solid var\(--ui-line-strong\)/);
  assert.match(css, /\.ui-toast--error\s*\{\s*border-color: var\(--ui-line-strong\);\s*\}/);
  assert.doesNotMatch(css, /\.ui-toast--error\s*\{[^}]*border-left\s*:\s*3px/);
});
