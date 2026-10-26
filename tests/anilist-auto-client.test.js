import assert from "node:assert/strict";
import test from "node:test";
import {
  ANILIST_OAUTH_PENDING, ANILIST_CALLBACK_PATH, ANILIST_GRAPHQL_URL, LVL_ANILIST_CLIENT_ID, readAniListPreference,
  writeAniListPreference, readAniListAccount, startAniListAuthorization,
  consumeAniListCallback, anilistGraphql, remoteAniListEntries,
  startAniListLocalAuthorization, consumeAniListLocalCallback,
  startAniListPinAuthorization, parseAniListPinToken, ANILIST_PIN_REDIRECT, ANILIST_SINGLE_PROGRESS_QUERY,
  ANILIST_LIST_QUERY, ANILIST_SAVE_PROGRESS,
} from "../frontend/anilist/anilist-auto-client.js";
import { planAniListWatchSync, reconcileAniListProgressQueue } from "../frontend/anilist/anilist-watch-sync.js";

const storage = () => {
  const map = new Map();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, value),
    removeItem: (key) => map.delete(key),
  };
};

test("Implicit OAuth request uses local callback and a pending login stored in the same browser tab", () => {
  const session = storage();
  const origin = "http://127.0.0.1:4173";
  const address = new URL(startAniListAuthorization({ clientId: "1234", origin, sessionStorage: session,
    now: 1000, nonce: "a".repeat(32) }));
  assert.equal(address.origin, "https://anilist.co");
  assert.equal(address.searchParams.get("client_id"), "1234");
  assert.equal(address.searchParams.get("response_type"), "token");
  assert.equal(address.searchParams.get("redirect_uri"), origin + ANILIST_CALLBACK_PATH);
  assert.equal(address.searchParams.get("state"), "a".repeat(32));
  assert.equal(JSON.parse(session.getItem(ANILIST_OAUTH_PENDING)).origin, origin);
  assert.throws(() => startAniListAuthorization({ clientId: "123", origin: "https://other.site", sessionStorage: session, nonce: "a".repeat(32) }));
});

test("Released LVL includes one shared AniList Client ID and no user-specific developer setup", () => {
  assert.equal(LVL_ANILIST_CLIENT_ID, "53636");
  const settings = readAniListPreference(storage());
  assert.equal(settings.clientId, LVL_ANILIST_CLIENT_ID);
  const session = storage();
  const url = new URL(startAniListAuthorization({ clientId: settings.clientId,
    origin: "http://127.0.0.1:4173", sessionStorage: session,
    now: 1000, nonce: "x".repeat(32) }));
  assert.equal(url.searchParams.get("client_id"), "53636");
  assert.equal(url.searchParams.get("redirect_uri"), "http://127.0.0.1:4173/anilist/callback");
});

test("AniList PIN flow uses official first-party redirect without a client secret", () => {
  assert.equal(ANILIST_PIN_REDIRECT, "https://anilist.co/api/v2/oauth/pin");
  const uri = new URL(startAniListPinAuthorization("53636"));
  assert.equal(uri.searchParams.get("client_id"), "53636");
  assert.equal(uri.searchParams.get("response_type"), "token");
  assert.equal(uri.searchParams.has("redirect_uri"), false, "Use the redirect registered with AniList");
  assert.equal(uri.searchParams.has("client_secret"), false);
  assert.throws(() => startAniListPinAuthorization("junk"), /Client ID/);
});

test("Local AniList login uses the working minimal authorization URL and remembers this tab's consent", () => {
  const session = storage();
  const origin = "http://127.0.0.1:4187";
  const url = new URL(startAniListLocalAuthorization({ clientId: "53636", origin, sessionStorage: session, now: 1700000000000 }));
  assert.equal(url.searchParams.get("client_id"), "53636");
  assert.equal(url.searchParams.get("response_type"), "token");
  assert.equal(url.searchParams.has("redirect_uri"), false);
  assert.equal(url.searchParams.has("state"), false, "AniList's observed minimal flow does not echo a state");
  assert.deepEqual(JSON.parse(session.getItem(ANILIST_OAUTH_PENDING)), {
    mode: "local-implicit", clientId: "53636", origin, issuedAt: 1700000000000,
  });
  assert.throws(() => startAniListLocalAuthorization({ clientId: "53636", origin: "https://not-local.example", sessionStorage: session }), /local/);
});

test("Local callback accepts an AniList-style state-less fragment only in the initiating tab", () => {
  const now = 1700000060000;
  const origin = "http://127.0.0.1:4187";
  const jwt = (aud = "53636", iat = 1700000030) => ["e30", Buffer.from(JSON.stringify({
    aud, iat, exp: 1700000060 + 31536000,
  })).toString("base64url"), "fakesignature"].join(".");
  const hash = (token) => `#access_token=${token}&token_type=Bearer&expires_in=31536000`;
  const pending = () => {
    const session = storage();
    startAniListLocalAuthorization({ clientId: "53636", origin, sessionStorage: session, now: now - 60000 });
    return session;
  };
  const session = pending();
  const result = consumeAniListLocalCallback({ hash: hash(jwt()), sessionStorage: session, origin, now });
  assert.equal(result.token, jwt());
  assert.equal(session.getItem(ANILIST_OAUTH_PENDING), null, "Callback must be single-use");
  assert.throws(() => consumeAniListLocalCallback({ hash: hash(jwt()), sessionStorage: session, origin, now }), /not requested/);
  assert.throws(() => consumeAniListLocalCallback({ hash: hash(jwt()), sessionStorage: storage(), origin, now }), /not requested/);
  assert.throws(() => consumeAniListLocalCallback({ hash: hash(jwt("different")), sessionStorage: pending(), origin, now }), /different or stale/);
  assert.throws(() => consumeAniListLocalCallback({ hash: hash(jwt("53636", 1699999000)), sessionStorage: pending(), origin, now }), /different or stale/);
  assert.throws(() => consumeAniListLocalCallback({ hash: hash(jwt()), sessionStorage: pending(), origin: "http://127.0.0.1:4173", now }), /not requested/);
  const expired = storage();
  startAniListLocalAuthorization({ clientId: "53636", origin, sessionStorage: expired, now: now - 11 * 60_000 });
  assert.throws(() => consumeAniListLocalCallback({ hash: hash(jwt()), sessionStorage: expired, origin, now }), /expired/);
  const denied = pending();
  assert.throws(() => consumeAniListLocalCallback({ hash: "#error=access_denied", sessionStorage: denied, origin, now }), /declined/);
});

test("PIN token import verifies format, expiry, and restricts full URLs to AniList", () => {
  const now = 1700000000000;
  const makeJwt = (exp) => ["e30", Buffer.from(JSON.stringify({ exp })).toString("base64url"), "signature"].join(".");
  const token = makeJwt(now / 1000 + 3600);
  assert.deepEqual(parseAniListPinToken(token, now), { token, expiresAt: now + 3600000 });
  assert.deepEqual(parseAniListPinToken(ANILIST_PIN_REDIRECT + "#access_token=" + token, now), { token, expiresAt: now + 3600000 });
  assert.throws(() => parseAniListPinToken("https://evil.example/#access_token=" + token, now), /official/);
  assert.throws(() => parseAniListPinToken(makeJwt(now / 1000 - 3600), now), /expired/);
  assert.throws(() => parseAniListPinToken("my password", now), /JWT/);
});

test("OAuth callback validates pending tab, state, token and expiry and only consumes once", () => {
  const session = storage();
  const origin = "http://127.0.0.1:4173";
  startAniListAuthorization({ clientId: "4", origin, sessionStorage: session, now: 1000, nonce: "b".repeat(32) });
  const hash = `#access_token=${"a".repeat(100)}&token_type=Bearer&expires_in=3600&state=${"b".repeat(32)}`;
  const data = consumeAniListCallback({ hash, sessionStorage: session, origin, now: 3000 });
  assert.equal(data.expiresAt, 3603000);
  assert.equal(data.token.length, 100);
  assert.equal(session.getItem(ANILIST_OAUTH_PENDING), null);
  assert.throws(() => consumeAniListCallback({ hash, sessionStorage: session, origin, now: 3000 }), /expired/);
  startAniListAuthorization({ clientId: "4", origin, sessionStorage: session, now: 1000, nonce: "b".repeat(32) });
  assert.throws(() => consumeAniListCallback({ hash: hash.replace("b".repeat(32), "c".repeat(32)), sessionStorage: session, origin, now: 3000 }), /different/);
  startAniListAuthorization({ clientId: "4", origin, sessionStorage: session, now: 1000, nonce: "b".repeat(32) });
  assert.throws(() => consumeAniListCallback({ hash: hash.replace(/&state=[^&]+/, ""), sessionStorage: session, origin, now: 3000 }), /different/, "Missing OAuth state must be rejected too");
});

test("Preferences and user tokens do not share the Library store", () => {
  const local = storage();
  assert.deepEqual(readAniListPreference(local), { clientId: "53636", enabled: false, threshold: 80, lastPull: 0, lastPush: 0 });
  const saved = writeAniListPreference(local, { clientId: "12", enabled: false, threshold: 95 });
  assert.equal(saved.clientId, "12");
  assert.equal(saved.enabled, false);
  assert.equal(saved.threshold, 95);
  const accountKey = "lvl-anilist-oauth-v1";
  local.setItem(accountKey, JSON.stringify({ token: "abc", userId: 44, username: "tester", expiresAt: Date.now() + 3600000 }));
  assert.equal(readAniListAccount(local)?.username, "tester");
  assert.equal(readAniListAccount(local, Date.now() + 3600_001), null);
});

test("Authenticated GraphQL requests only send bearer token to AniList, detect errors and handle rate limits", async () => {
  let request;
  const successful = await anilistGraphql("token", "query { Viewer { name } }", {}, async (url, options) => {
    request = { url, options };
    return { ok: true, status: 200, json: async () => ({ data: { Viewer: { name: "User" } } }) };
  });
  assert.equal(successful.Viewer.name, "User");
  assert.equal(request.url, ANILIST_GRAPHQL_URL);
  assert.equal(request.options.headers.Authorization, "Bearer token");
  assert.equal(request.options.credentials, "omit");
  await assert.rejects(() => anilistGraphql("token", "", {}, async () => ({ status: 429, headers: { get: () => "90" } })), /limit/);
  await assert.rejects(() => anilistGraphql("token", "query{}", {}, async () => ({ status: 401 })), /authorization expired/);
  await assert.rejects(() => anilistGraphql("token", "query{}", {}, async () => ({ status: 403 })), (error) => {
    assert.match(error.message, /temporarily unavailable/i);
    assert.equal(error.retryAfter, 5 * 60_000);
    assert.notEqual(error.authFailed, true, "AniList 403 may be a temporary outage; credentials must be retained");
    return true;
  });
});

test("AniList's real HTTP 404 Not Found on absent MediaList is a safe null only for exact prewrite query", async () => {
  // Observed with an actual public AniList user who has no list entry:
  // HTTP 404 {data:{MediaList:null},errors:[{status:404,message:'Not Found.'}]}.
  // The authenticated collection must independently prove an entry absent.
  const missing = { data: { MediaList: null }, errors: [{ status: 404, message: "Not Found." }] };
  const absent = async () => ({ status: 404, ok: false, json: async () => missing });
  assert.deepEqual(await anilistGraphql("mock-token", ANILIST_SINGLE_PROGRESS_QUERY,
    { id: 42, mediaId: 14719 }, absent), { MediaList: null });
  await assert.rejects(() => anilistGraphql("mock-token", ANILIST_LIST_QUERY, {}, absent), /connected account's list \(HTTP 404\)/,
    "A general list error cannot masquerade as an absent individual entry");
  await assert.rejects(() => anilistGraphql("mock-token", "query { MediaList { id } }", {}, absent), /HTTP 404/,
    "Only the exact audited single-entry prewrite query accepts this response");
  for (const malformed of [
    { data: { MediaList: null }, errors: [{ status: 404, message: "Private User" }] },
    { data: { MediaList: null }, errors: [{ status: 500, message: "Not Found." }] },
    { data: {}, errors: [{ status: 404, message: "Not Found." }] },
    { errors: [{ status: 404, message: "Not Found." }] },
    { data: { MediaList: null }, errors: [{ status: 404, message: "Not Found." }, { status: 404, message: "Other error" }] },
  ]) {
    await assert.rejects(() => anilistGraphql("mock-token", ANILIST_SINGLE_PROGRESS_QUERY, {},
      async () => ({ status: 404, ok: false, json: async () => malformed })), /HTTP 404/,
      "Permission errors, incomplete responses, ambiguous errors must never create a list entry");
  }
});

test("Remote AniList list is indexed by AniList ID, without requiring public username", () => {
  const list = remoteAniListEntries({ MediaListCollection: { lists: [{ entries: [
    { mediaId: 9, progress: 4, status: "CURRENT", media: { episodes: 12, format: "TV" } },
  ] }] } });
  assert.deepEqual(list.get(9), { mediaId: 9, progress: 4, status: "CURRENT", episodes: 12 });
});

test("Incomplete AniList collections cannot masquerade as empty lists permitting remote creation", () => {
  assert.equal(remoteAniListEntries({ MediaListCollection: { lists: [] } }).size, 0,
    "An explicit empty list is a valid account snapshot");
  assert.equal(remoteAniListEntries({ MediaListCollection: { lists: [{ entries: [] }] } }).size, 0);
  for (const invalid of [
    null,
    {},
    { MediaListCollection: null },
    { MediaListCollection: { lists: null } },
    { MediaListCollection: { lists: [{}] } },
    { MediaListCollection: { lists: [null] } },
    { MediaListCollection: { lists: [{ entries: [null] }] } },
    { MediaListCollection: { lists: [{ entries: [{ progress: 0, status: "CURRENT" }] }] } },
    { MediaListCollection: { lists: [{ entries: [{ mediaId: "9", progress: 0 }] }] } },
  ]) assert.throws(() => remoteAniListEntries(invalid), /incomplete watch list/i);
});

test("A malformed or missing AniList progress stays present but unsafe, never silently becomes zero", () => {
  const entries = [
    { mediaId: 100, progress: null, status: "CURRENT", media: { episodes: 12 } },
    { mediaId: 101, status: "CURRENT", media: { episodes: 12 } },
    { mediaId: 102, progress: "0", status: "CURRENT", media: { episodes: 12 } },
    { mediaId: 103, progress: -1, status: "CURRENT", media: { episodes: 12 } },
    { mediaId: 104, progress: 1.5, status: "CURRENT", media: { episodes: 12 } },
    { mediaId: 105, progress: Number.NaN, status: "CURRENT", media: { episodes: 12 } },
    { mediaId: 106, progress: Number.POSITIVE_INFINITY, status: "CURRENT", media: { episodes: 12 } },
    { mediaId: 107, progress: {}, status: "CURRENT", media: { episodes: 12 } },
    { mediaId: 108, progress: 0, status: "CURRENT", media: { episodes: null } },
    { mediaId: 109, progress: 1, status: "CURRENT", media: { episodes: 24 } },
  ];
  const list = remoteAniListEntries({ MediaListCollection: { lists: [{ entries }] } });
  for (let mediaId = 100; mediaId <= 107; mediaId++) {
    assert.equal(list.has(mediaId), true, `Unsafe media ${mediaId} must not look like a missing entry`);
    assert.deepEqual(list.get(mediaId), {
      mediaId, progress: null, progressKnown: false, status: "CURRENT", episodes: 12,
    });
  }
  assert.deepEqual(list.get(108), { mediaId: 108, progress: 0, status: "CURRENT", episodes: null });
  assert.deepEqual(list.get(109), { mediaId: 109, progress: 1, status: "CURRENT", episodes: 24 });
});

test("An unsafe duplicate AniList row never becomes writable by a later valid duplicate", () => {
  const entries = [
    { mediaId: 88, progress: null, media: { episodes: 12 } },
    { mediaId: 88, progress: 0, media: { episodes: 12 } },
  ];
  for (const rows of [entries, [...entries].reverse()]) {
    const list = remoteAniListEntries({ MediaListCollection: { lists: [{ entries: rows }] } });
    assert.equal(list.has(88), true);
    assert.equal(list.get(88).progress, null);
    assert.equal(list.get(88).progressKnown, false);
  }
});

test("The per-media pre-write AniList query is read-only and requests current progress and episode count", () => {
  assert.match(ANILIST_SINGLE_PROGRESS_QUERY, /^query \(\$id: Int!, \$mediaId: Int!\)/);
  assert.match(ANILIST_SINGLE_PROGRESS_QUERY, /MediaList\(userId: \$id, mediaId: \$mediaId\)/);
  assert.match(ANILIST_SINGLE_PROGRESS_QUERY, /mediaId progress status media \{ episodes \}/);
  assert.doesNotMatch(ANILIST_SINGLE_PROGRESS_QUERY, /mutation|SaveMediaListEntry/);
});

test("mock-only AniList lifecycle: absent list entry -> create 1 -> advance 2 and 3 -> acknowledge safely", async () => {
  const mediaId = 8701;
  const userId = 7601;
  const token = "mock-token-not-an-actual-credential";
  const episodes = 12;
  const records = new Map();
  const calls = [];
  let nextEntryId = 9000;

  // All requests MUST use this injected fake; never use the default fetch or
  // a real token. The mock models one AniList media's list-entry lifecycle.
  const mockFetch = async (url, options) => {
    assert.equal(url, ANILIST_GRAPHQL_URL);
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    assert.equal(options.credentials, "omit");
    const { query, variables } = JSON.parse(options.body);
    calls.push({ query, variables: structuredClone(variables) });
    let data;
    if (query === ANILIST_LIST_QUERY) {
      assert.deepEqual(variables, { id: userId });
      data = { Viewer: { id: userId }, MediaListCollection: { lists: [{ entries: [...records.values()] }] } };
    } else if (query === ANILIST_SINGLE_PROGRESS_QUERY) {
      assert.deepEqual(variables, { id: userId, mediaId });
      data = { MediaList: records.get(mediaId) || null };
    } else if (query === ANILIST_SAVE_PROGRESS) {
      assert.equal(variables.mediaId, mediaId);
      assert.equal(Number.isInteger(variables.progress), true);
      assert.ok(variables.progress >= 1 && variables.progress <= episodes);
      assert.equal(Object.hasOwn(variables, "score"), false);
      assert.equal(Object.hasOwn(variables, "rating"), false);
      const prior = records.get(mediaId);
      assert.ok(!prior || variables.progress > prior.progress,
        "the normal watched-progress path must never reset or decrease progress");
      const entry = {
        id: prior?.id || ++nextEntryId, mediaId, progress: variables.progress,
        status: variables.status || prior?.status || "CURRENT",
        score: prior?.score ?? 9.5, media: { episodes, format: "TV" },
      };
      records.set(mediaId, entry);
      data = { SaveMediaListEntry: {
        mediaId, progress: entry.progress, status: entry.status, updatedAt: 1730000000,
      } };
    } else {
      assert.fail("Unrecognized mock GraphQL operation; deletion is NOT implemented");
    }
    return { ok: true, status: 200, json: async () => ({ data }) };
  };

  const list = async () => {
    const result = await anilistGraphql(token, ANILIST_LIST_QUERY, { id: userId }, mockFetch);
    assert.equal(result.Viewer.id, userId);
    return remoteAniListEntries(result);
  };
  assert.equal((await list()).has(mediaId), false, "the title was never on this user's list");
  assert.equal((await anilistGraphql(token, ANILIST_SINGLE_PROGRESS_QUERY,
    { id: userId, mediaId }, mockFetch)).MediaList, null, "direct query verifies entry absence");

  const seasons = [{ anilistId: mediaId, season: 1, episodes, format: "TV", title: "Never Watched" }];
  const watchedChapters = {};
  let queue = [];
  for (const episode of [1, 2, 3]) {
    watchedChapters[`S01E0${episode}`] = episode;
    const snapshot = await list();
    // Only an EXPLICITLY COMPLETE remote list plus the per-media query can
    // authorize this synthetic zero for a truly absent AniList list entry.
    const remote = snapshot.has(mediaId)
      ? [{ ...snapshot.get(mediaId), anilistId: mediaId }]
      : [{ anilistId: mediaId, progress: 0, status: "PLANNING", episodes: null }];
    const plan = planAniListWatchSync({
      seasons, seriesKey: "never-watched", watchedChapters, queue, remote,
      allowStatusUpdates: true,
    });
    assert.equal(plan.queue.length, 1, "retain the pending completion before a server acknowledgment");
    assert.deepEqual(plan.updates, [{
      mediaId, progress: episode, ...(episode === 1 ? { status: "CURRENT" } : {}),
    }]);

    const latest = await anilistGraphql(token, ANILIST_SINGLE_PROGRESS_QUERY,
      { id: userId, mediaId }, mockFetch);
    assert.equal(latest.MediaList?.progress ?? 0, episode - 1,
      "pre-write per-media snapshot agrees with each safe update");
    const response = await anilistGraphql(token, ANILIST_SAVE_PROGRESS, plan.updates[0], mockFetch);
    assert.equal(response.SaveMediaListEntry.progress, episode);
    const acknowledged = reconcileAniListProgressQueue({
      queue: plan.queue, remote: [{ ...records.get(mediaId), anilistId: mediaId }],
    });
    assert.deepEqual(acknowledged.updates, []);
    assert.deepEqual(acknowledged.queue, [], "confirmed remote progress clears only acknowledged completions");
    queue = acknowledged.queue;
  }
  assert.deepEqual(records.get(mediaId), {
    id: 9001, mediaId, progress: 3, status: "CURRENT", score: 9.5,
    media: { episodes, format: "TV" },
  });
  assert.deepEqual((await list()).get(mediaId), {
    mediaId, progress: 3, status: "CURRENT", episodes,
  });
  assert.deepEqual(calls.filter((call) => call.query === ANILIST_SAVE_PROGRESS)
    .map((call) => call.variables.progress), [1, 2, 3],
  "the mock must observe only increasing progress mutations");
  assert.equal(calls.some((call) => /DeleteMediaListEntry/.test(call.query)), false,
    "this lifecycle uses no remote deletion or reset");
});

test("mock cleanup distinguishes remote deletion from progress reset; failed writes preserve queue", async () => {
  const mediaId = 8702;
  const seasons = [{ anilistId: mediaId, season: 1, episodes: 12, format: "TV", title: "Cleanup" }];
  const watchedChapters = { S01E01: 1, S01E02: 2, S01E03: 3 };
  const remote = [{ anilistId: mediaId, progress: 3, status: "CURRENT", episodes: 12 }];
  const pending = planAniListWatchSync({
    seasons, seriesKey: "cleanup", watchedChapters, remote,
  });
  assert.deepEqual(pending.queue, []);
  assert.deepEqual(pending.updates, [], "remote 3 cannot be lowered by an older local watch state");

  // A failed mutation must never count as a confirmation.
  const queuedNewWatch = planAniListWatchSync({
    seasons, seriesKey: "cleanup", watchedChapters: { ...watchedChapters, S01E04: 4 },
    remote,
  });
  const unchangedQueue = structuredClone(queuedNewWatch.queue);
  assert.deepEqual(queuedNewWatch.updates, [{ mediaId, progress: 4 }]);
  await assert.rejects(() => anilistGraphql("mock-token", ANILIST_SAVE_PROGRESS,
    queuedNewWatch.updates[0], async (_url, options) => {
      assert.deepEqual(JSON.parse(options.body).variables, { mediaId, progress: 4 });
      return { ok: false, status: 503 };
    }), /HTTP 503/);
  assert.deepEqual(queuedNewWatch.queue, unchangedQueue, "failed request leaves unsent episode eligible for retry");
  assert.deepEqual(reconcileAniListProgressQueue({
    queue: queuedNewWatch.queue, remote,
  }).queue, unchangedQueue);

  // Simulate somebody deleting the *list entry* outside LVL, rather than
  // calling SaveMediaListEntry(progress:0). No DeleteMediaListEntry is
  // exported/implemented in this client; clearing a local queue is NOT a
  // request to delete remote AniList data.
  assert.match(ANILIST_SAVE_PROGRESS, /SaveMediaListEntry\(/);
  assert.doesNotMatch(ANILIST_SAVE_PROGRESS, /DeleteMediaListEntry|progress:\s*0/);
  const remoteAfterExternalDelete = new Map(); // mock absent entry
  const clearedLocal = planAniListWatchSync({
    seasons, seriesKey: "cleanup", watchedChapters: {}, queue: [],
    remote: [...remoteAfterExternalDelete.values()],
  });
  assert.deepEqual(clearedLocal.queue, []);
  assert.deepEqual(clearedLocal.updates, [],
    "cleanup of local marks + queue cannot recreate an externally deleted entry");
  const staleLocal = planAniListWatchSync({
    seasons, seriesKey: "cleanup", watchedChapters, queue: [], remote: [],
  });
  assert.equal(staleLocal.queue.length, 3,
    "GAP: retaining the original local watched marks can recreate remote progress after the user deletes the list entry");
});
