import assert from "node:assert/strict";
import test from "node:test";
import { createRecsService } from "../backend/recommendations/recs-service.js";
import { fakeAniList, media, memoryStore } from "./recs-fixtures.js";
import { ANILIST_AUTH_LIBRARY_QUERY } from "../frontend/anilist/anilist-auto-client.js";

const anime = media(715, { title: { english: "Test Series", romaji: "Test Series" }, format: "TV", seasonYear: 2019, episodes: 12 });
const snapshot = (id = 42, lists = [{ entries: [
  { status: "CURRENT", progress: 3, score: 8.5, updatedAt: 1_700_000_000, media: anime },
] }]) => ({
  Viewer: { id, name: "viewer42" },
  MediaListCollection: { user: { id, name: "viewer42" }, lists },
});

test("Authenticated list query gets Viewer, user ID and media scores without querying a username", () => {
  assert.match(ANILIST_AUTH_LIBRARY_QUERY, /Viewer\s*\{ id name \}/);
  assert.match(ANILIST_AUTH_LIBRARY_QUERY, /MediaListCollection\(userId: \$id, type: ANIME\)/);
  assert.match(ANILIST_AUTH_LIBRARY_QUERY, /score\(format: POINT_10_DECIMAL\)/);
  assert.match(ANILIST_AUTH_LIBRARY_QUERY, /media \{ id idMal format seasonYear episodes isAdult/);
  assert.doesNotMatch(ANILIST_AUTH_LIBRARY_QUERY, /userName|access_token|bearer/i);
});

test("Authenticated Library/recommendations link imports Viewer data, including custom lists, without public username lookup", async () => {
  const store = memoryStore();
  const client = fakeAniList({ list: [], anime: { 715: anime } });
  client.userList = async () => { throw new Error("Public username lookup must not be attempted"); };
  const service = createRecsService({ store, anilist: client });
  const authorized = snapshot(42, [
    { name: "Watching", entries: [{ status: "CURRENT", progress: 3, score: 8.5, updatedAt: 1_700_000_000, media: anime }] },
    { name: "Custom", entries: [{ status: "CURRENT", progress: 3, score: 8.5, updatedAt: 1_700_000_000, media: anime }] },
  ]);
  authorized.scoreSyncEnabled = true;
  const response = service.linkAuthenticatedAniList(authorized);
  assert.equal(response.settings.anilist.username, "viewer42");
  assert.equal(response.settings.anilist.count, 1, "Repeated entries in custom lists must count once");
  assert.equal(store.settings().anilist.authenticated, true);
  assert.equal(store.settings().anilist.scoreSync, true, "Only the opt-in authenticated owner enables score precedence");
  assert.deepEqual(service.titleRatings({ title: "Test Series" }).ratings.map((r) => [r.source, r.score, r.progress]),
    [["anilist", 8.5, 3]]);
  await assert.rejects(() => service.syncAniList(), /authenticated AniList list/);
  const library = await service.anilistLibrary();
  assert.equal(library.shows.length, 1);
  assert.equal(library.shows[0].seasons[0].progress, 3);
  // Unrelated refreshes must not overwrite this authenticated data via public username lookup.
  await service.refresh({ trigger: "manual" });
  assert.equal(store.settings().anilist.authenticated, true);
});

test("Incomplete or mismatched account snapshot is rejected without replacing existing ratings", () => {
  const store = memoryStore();
  const service = createRecsService({ store, anilist: fakeAniList({ list: [], anime: { 715: anime } }) });
  service.linkAuthenticatedAniList(snapshot());
  const oldSettings = structuredClone(store.settings().anilist);
  for (const bad of [
    { Viewer: { id: 43, name: "other" }, MediaListCollection: { user: { id: 42, name: "viewer42" }, lists: [] } },
    { Viewer: { id: 42, name: "viewer42" }, MediaListCollection: undefined },
    { Viewer: { id: 42, name: "viewer42" }, MediaListCollection: { lists: [{}] } },
    { Viewer: { id: 42, name: "viewer42" }, MediaListCollection: { lists: [{ entries: [] }], user: { id: 99, name: "wrong" } } },
  ]) assert.throws(() => service.linkAuthenticatedAniList(bad), /invalid|incomplete/);
  assert.deepEqual(store.settings().anilist, oldSettings);
  assert.equal(service.titleRatings({ title: "Test Series" }).ratings[0].progress, 3);
});

test("Conflicting duplicate AniList entries and malformed scores never replace an existing account snapshot", () => {
  const store = memoryStore();
  const service = createRecsService({ store, anilist: fakeAniList({ anime: { 715: anime } }) });
  service.linkAuthenticatedAniList(snapshot());
  const baseline = structuredClone(store.ratings());
  const valid = { status: "CURRENT", progress: 3, score: 8.5, updatedAt: 1_700_000_000, media: anime };
  for (const lists of [
    [{ entries: [valid, { ...valid, score: 6 }] }],
    [{ entries: [{ ...valid, score: 11 }] }],
    [{ entries: [{ ...valid, media: { ...anime, id: null } }] }],
  ]) assert.throws(() => service.linkAuthenticatedAniList(snapshot(42, lists)), /incomplete|conflicting/);
  assert.deepEqual(store.ratings(), baseline);
});

test("Valid empty authenticated account removes previous AniList ratings but leaves app ratings alone", () => {
  const store = memoryStore();
  const service = createRecsService({ store, anilist: fakeAniList({ list: [], anime: { 715: anime } }) });
  service.linkAuthenticatedAniList(snapshot());
  service.linkAuthenticatedAniList(snapshot(43, []));
  assert.equal(store.settings().anilist.userId, 43);
  assert.equal(store.settings().anilist.count, 0);
  assert.equal(service.titleRatings({ title: "Test Series" }).ratings.length, 0);
});
