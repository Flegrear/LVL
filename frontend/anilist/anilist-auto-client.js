// AniList OAuth implicit grant and GraphQL writes, entirely in the user's
// browser. The token is never sent to LVL's local Node server or exported with
// the Library. The user's AniList authorization is independent of public-list
// imports in Settings > Recommendations.
export const ANILIST_OAUTH_PENDING = "lvl-anilist-oauth-pending-v1";
export const ANILIST_OAUTH_STORAGE = "lvl-anilist-oauth-v1";
export const ANILIST_SYNC_PREFERENCES = "lvl-anilist-sync-preferences-v1";
export const ANILIST_SYNC_QUEUE = "lvl-anilist-sync-queue-v1";
export const ANILIST_GRAPHQL_URL = "https://graphql.anilist.co";
export const ANILIST_CALLBACK_PATH = "/anilist/callback";
// As of mid-2026 AniList's usual implicit redirect can return
// unsupported_grant_type. Its first-party Auth PIN page is the local-only
// alternative; no client secret is sent by LVL or distributed to users.
export const ANILIST_PIN_REDIRECT = "https://anilist.co/api/v2/oauth/pin";
// One shared public AniList application Client ID for every LVL installation.
// It is not a secret. The Settings field remains available for custom builds.
export const LVL_ANILIST_CLIENT_ID = "53636";
const CLIENT_ID_PATTERN = /^[0-9]{1,20}$/;
const LOCAL_OAUTH_WINDOW_MS = 10 * 60_000;

export function readAniListPreference(storage) {
  let saved = {};
  try { saved = JSON.parse(storage.getItem(ANILIST_SYNC_PREFERENCES) || "{}") || {}; } catch {}
  const clientId = String(saved.clientId || LVL_ANILIST_CLIENT_ID);
  return {
    clientId: CLIENT_ID_PATTERN.test(clientId) ? clientId : "",
    enabled: saved.enabled === true,
    threshold: Number.isInteger(Number(saved.threshold)) && Number(saved.threshold) >= 1 && Number(saved.threshold) <= 100 ? Number(saved.threshold) : 80,
    lastPull: Math.max(0, Number(saved.lastPull) || 0),
    lastPush: Math.max(0, Number(saved.lastPush) || 0),
  };
}

export function writeAniListPreference(storage, update) {
  const previous = readAniListPreference(storage);
  const merged = { ...previous, ...update };
  if (!CLIENT_ID_PATTERN.test(String(merged.clientId || ""))) merged.clientId = "";
  storage.setItem(ANILIST_SYNC_PREFERENCES, JSON.stringify(merged));
  return readAniListPreference(storage);
}

export function readAniListAccount(storage, at = Date.now()) {
  try {
    const account = JSON.parse(storage.getItem(ANILIST_OAUTH_STORAGE) || "null");
    if (!account?.token || typeof account.token !== "string" || !Number.isInteger(account.userId)
        || !account.username || !Number.isFinite(account.expiresAt) || account.expiresAt <= at + 60_000) return null;
    return account;
  } catch { return null; }
}

/** Get the authorization page for AniList's first-party PIN redirect. */
export function startAniListPinAuthorization(clientId) {
  const id = String(clientId || "").trim();
  if (!CLIENT_ID_PATTERN.test(id)) throw new Error("The AniList application Client ID is missing.");
  const url = new URL("https://anilist.co/api/v2/oauth/authorize");
  url.searchParams.set("client_id", id);
  url.searchParams.set("response_type", "token");
  // AniList's published implicit authorization example specifies only these
  // two parameters; redirect comes from the developer application's setting.
  return url.toString();
}

/** Start the observed working AniList implicit flow in the SAME browser tab.
 * AniList's documented authorization request only needs client_id and
 * response_type. The Redirect URL is registered once per shared application.
 * AniList's observed response omits state, so bind the return to a recent
 * locally initiated authorization in this tab and validate the JWT audience
 * and issue time instead of accepting unsolicited callback fragments.
 */
export function startAniListLocalAuthorization({ clientId, origin, sessionStorage, now = Date.now() }) {
  const parsed = new URL(origin);
  const id = String(clientId || "").trim();
  if (!CLIENT_ID_PATTERN.test(id)) throw new Error("AniList application Client ID is missing.");
  if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(parsed.hostname))
    throw new Error("AniList login must be started from your local LVL application.");
  sessionStorage.setItem(ANILIST_OAUTH_PENDING, JSON.stringify({
    mode: "local-implicit", clientId: id, origin: parsed.origin, issuedAt: now,
  }));
  return startAniListPinAuthorization(id);
}

/** Consume the local callback once, never accepting an unrequested JWT. */
export function consumeAniListLocalCallback({ hash, sessionStorage, origin, now = Date.now() }) {
  let pending;
  try { pending = JSON.parse(sessionStorage.getItem(ANILIST_OAUTH_PENDING) || "null"); } catch {}
  sessionStorage.removeItem(ANILIST_OAUTH_PENDING);
  if (pending?.mode !== "local-implicit" || pending.origin !== origin
      || !CLIENT_ID_PATTERN.test(String(pending.clientId || ""))
      || !Number.isFinite(pending.issuedAt) || now < pending.issuedAt
      || now - pending.issuedAt > LOCAL_OAUTH_WINDOW_MS)
    throw new Error("AniList login was not requested in this browser tab, or expired. Connect again.");
  const params = new URLSearchParams(String(hash || "").replace(/^#/, ""));
  if (params.has("error")) throw new Error("AniList authorization was declined.");
  if (params.get("token_type")?.toLowerCase() !== "bearer")
    throw new Error("AniList did not return a bearer token.");
  const auth = parseAniListPinToken(params.get("access_token") || "", now);
  const expiresIn = Number(params.get("expires_in"));
  if (!Number.isFinite(expiresIn) || expiresIn < 60 || expiresIn > 400 * 86400)
    throw new Error("AniList returned an invalid token lifetime.");
  let claims;
  try {
    const value = auth.token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    claims = JSON.parse(atob(value.padEnd(Math.ceil(value.length / 4) * 4, "=")));
  } catch { throw new Error("AniList returned malformed token claims."); }
  const aud = Array.isArray(claims?.aud) ? claims.aud.map(String) : [String(claims?.aud ?? "")];
  const issuedAt = Number(claims?.iat) * 1000;
  if (!aud.includes(pending.clientId) || !Number.isFinite(issuedAt)
      || issuedAt < pending.issuedAt - 5 * 60_000 || issuedAt > now + 5 * 60_000)
    throw new Error("AniList returned a token for a different or stale authorization.");
  // Validation is complete only after an authenticated Viewer request to
  // AniList in connectVerifiedAniListAccount; JWT claims alone are untrusted.
  return auth;
}

/** Parse a token the user explicitly pasted from the official AniList PIN page. */
export function parseAniListPinToken(value, now = Date.now()) {
  let token = String(value || "").trim();
  if (token.startsWith("https://")) {
    const url = new URL(token);
    if (url.origin + url.pathname !== ANILIST_PIN_REDIRECT)
      throw new Error("Paste only the token from AniList's official authorization page.");
    token = new URLSearchParams(url.hash.slice(1)).get("access_token") || "";
  } else if (token.startsWith("#") || token.startsWith("access_token=")) {
    token = new URLSearchParams(token.replace(/^#/, "")).get("access_token") || "";
  }
  // JWT structure only, not signature validation: AniList's Viewer request
  // verifies the actual token before any local account state is persisted.
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token) || token.length > 4096)
    throw new Error("Paste the AniList access token (a JWT), not your password or Client Secret.");
  let claims;
  try {
    const segment = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    claims = JSON.parse(atob(segment.padEnd(Math.ceil(segment.length / 4) * 4, "=")));
  } catch {
    throw new Error("The AniList token has an invalid format.");
  }
  const expiresAt = Number(claims?.exp) * 1000;
  if (!Number.isFinite(expiresAt) || expiresAt <= now + 60_000 || expiresAt > now + 400 * 86400_000)
    throw new Error("The AniList token is expired or has an invalid expiration.");
  return { token, expiresAt };
}

export function startAniListAuthorization({ clientId, origin, sessionStorage, now = Date.now(), nonce }) {
  const id = String(clientId || "").trim();
  if (!CLIENT_ID_PATTERN.test(id)) throw new Error("Set an AniList application Client ID first.");
  const parsed = new URL(origin);
  if (!["127.0.0.1", "localhost"].includes(parsed.hostname) || parsed.protocol !== "http:")
    throw new Error("AniList login requires a locally hosted LVL page.");
  const state = String(nonce || "").trim();
  if (!/^[a-zA-Z0-9_-]{24,160}$/.test(state)) throw new Error("Could not create a secure login request.");
  sessionStorage.setItem(ANILIST_OAUTH_PENDING, JSON.stringify({ state, issuedAt: now, origin: parsed.origin }));
  const url = new URL("https://anilist.co/api/v2/oauth/authorize");
  url.searchParams.set("client_id", id);
  url.searchParams.set("response_type", "token");
  url.searchParams.set("redirect_uri", parsed.origin + ANILIST_CALLBACK_PATH);
  url.searchParams.set("state", state);
  return url.toString();
}

// Consume the URL fragment before the app router can replace the callback
// location. The fragment is NOT sent in HTTP requests or retained in history.
export function consumeAniListCallback({ hash, sessionStorage, origin, now = Date.now() }) {
  let pending = null;
  try { pending = JSON.parse(sessionStorage.getItem(ANILIST_OAUTH_PENDING) || "null"); } catch {}
  sessionStorage.removeItem(ANILIST_OAUTH_PENDING);
  if (!pending || pending.origin !== origin || !Number.isFinite(pending.issuedAt)
      || Math.abs(now - pending.issuedAt) > 10 * 60_000) throw new Error("AniList login expired. Please connect again.");
  const params = new URLSearchParams(String(hash || "").replace(/^#/, ""));
  if (params.has("error")) throw new Error("AniList authorization was declined.");
  if (params.get("state") !== pending.state)
    throw new Error("AniList returned a different authorization request.");
  const token = params.get("access_token") || "";
  if (!/^[a-zA-Z0-9_.\-]{40,4096}$/.test(token) || params.get("token_type")?.toLowerCase() !== "bearer")
    throw new Error("AniList did not return a valid authorization token.");
  const expiresIn = Number(params.get("expires_in") || 0);
  if (!Number.isFinite(expiresIn) || expiresIn < 60 || expiresIn > 400 * 86400)
    throw new Error("AniList returned an invalid token expiry.");
  return { token, expiresAt: now + expiresIn * 1000 };
}

export async function anilistGraphql(token, query, variables = {}, fetchImpl = fetch) {
  if (!token || typeof query !== "string") throw new Error("AniList account is not connected.");
  const response = await fetchImpl(ANILIST_GRAPHQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(20_000),
    referrerPolicy: "no-referrer",
    credentials: "omit",
  });
  if (response.status === 401) throw Object.assign(new Error("AniList authorization expired or was revoked. Reconnect your account."), { authFailed: true });
  // AniList can return 403 during an upstream disruption, not only when a
  // token is invalid. Retain authorization and pending progress for retry.
  if (response.status === 403) throw Object.assign(new Error("AniList is temporarily unavailable (HTTP 403). LVL will retry."), { retryAfter: 5 * 60_000 });
  if (response.status === 429) {
    const seconds = Number(response.headers?.get?.("retry-after") || 60);
    throw Object.assign(new Error("AniList rate limit reached. LVL will retry."), { retryAfter: Math.max(60, Math.min(600, seconds)) * 1000 });
  }
  // AniList GraphQL responds HTTP 404 + data.MediaList:null + a single
  // "Not Found." error when a user has no entry for the queried anime.
  // Only the dedicated single-entry preflight query may consume this precise
  // shape. The caller still requires a verified complete authenticated list
  // proving this media ID was absent before it can CREATE a new entry.
  // Never interpret a 404 "Private User", missing data or other errors as
  // absence; those must continue blocking mutations.
  if (response.status === 404 && query === ANILIST_SINGLE_PROGRESS_QUERY) {
    const missing = await response.json().catch(() => null);
    if (missing?.data && Object.hasOwn(missing.data, "MediaList")
      && missing.data.MediaList === null && missing.errors?.length === 1
      && Number(missing.errors[0]?.status) === 404
      && missing.errors[0]?.message === "Not Found.") return { MediaList: null };
    throw new Error(`AniList returned HTTP 404${missing?.errors?.[0]?.message ? `: ${String(missing.errors[0].message).slice(0, 120)}` : "."} No episode update was sent.`);
  }
  if (response.status === 404 && (query === ANILIST_LIST_QUERY || query === ANILIST_AUTH_LIBRARY_QUERY)) {
    // This isn't an absent *anime*; it is the account/list lookup itself.
    // Keep the watch queue untouched and give a useful recovery instruction.
    throw new Error("AniList couldn't read your connected account's list (HTTP 404). Reconnect AniList in Settings before retrying; no episode update was sent.");
  }
  if (!response.ok) throw new Error(`AniList returned HTTP ${response.status}.`);
  const payload = await response.json();
  if (payload?.errors?.length) {
    const message = String(payload.errors[0]?.message || "AniList query failed").slice(0, 250);
    throw new Error(message);
  }
  if (!payload?.data) throw new Error("AniList returned an empty response.");
  return payload.data;
}

export const ANILIST_VIEWER_QUERY = `query { Viewer { id name } }`;
// Complete authenticated list for Library/recommendations, including private
// entries. The browser sends *only the resulting non-credential list metadata*
// to LVL's local recommender; never the authorization header or bearer token.
export const ANILIST_AUTH_LIBRARY_QUERY = `query ($id: Int!) {
  Viewer { id name }
  MediaListCollection(userId: $id, type: ANIME) {
    user { id name }
    lists { entries {
      status progress score(format: POINT_10_DECIMAL) updatedAt
      media { id idMal format seasonYear episodes isAdult genres averageScore popularity title { romaji english } coverImage { extraLarge large } }
    } }
  }
}`;
export const ANILIST_LIST_QUERY = `query ($id: Int!) {
  Viewer { id }
  MediaListCollection(userId: $id, type: ANIME) {
    lists { entries { mediaId progress status updatedAt media { episodes format } } }
  }
}`;
// Optional narrow refresh before SaveMediaListEntry. Keep the same fields as
// the collection response so remoteAniListEntries' safety rules still apply.
export const ANILIST_SINGLE_PROGRESS_QUERY = `query ($id: Int!, $mediaId: Int!) {
  MediaList(userId: $id, mediaId: $mediaId) {
    id mediaId progress status media { episodes }
  }
}`;
export const ANILIST_SAVE_PROGRESS = `mutation ($mediaId: Int!, $progress: Int!, $status: MediaListStatus) {
  SaveMediaListEntry(mediaId: $mediaId, progress: $progress, status: $status) {
    id mediaId progress status updatedAt
  }
}`;

export function remoteAniListEntries(payload) {
  // A failed or partially resolved list query must never look like an empty
  // account. Callers may create a missing media entry after an exact preflight,
  // so require every list and entry to have the requested identity fields.
  const lists = payload?.MediaListCollection?.lists;
  if (!Array.isArray(lists) || lists.some((list) => !Array.isArray(list?.entries)))
    throw new Error("AniList returned an incomplete watch list; no changes were sent.");
  const entries = new Map();
  for (const list of lists) {
    for (const entry of list.entries) {
      const mediaId = entry?.mediaId;
      if (!Number.isSafeInteger(mediaId) || mediaId <= 0)
        throw new Error("AniList returned an incomplete watch list entry; no changes were sent.");
      // Crucially, an entry with invalid progress stays *present* in the Map.
      // The caller only invents progress=0 for absent IDs, so dropping this
      // record would make a malformed AniList response look like a new entry.
      const progressKnown = Number.isSafeInteger(entry.progress) && entry.progress >= 0;
      const episodes = Number.isSafeInteger(entry.media?.episodes) && entry.media.episodes > 0
        ? entry.media.episodes : null;
      const record = {
        mediaId, progress: progressKnown ? entry.progress : null,
        ...(progressKnown ? {} : { progressKnown: false }),
        status: entry.status || "", episodes,
      };
      // Duplicated entries cannot establish a trustworthy remote snapshot,
      // even if one copy says 0 and the other says a valid positive number.
      if (entries.has(mediaId)) entries.set(mediaId, {
        mediaId, progress: null, progressKnown: false,
        status: "", episodes: null,
      });
      else entries.set(mediaId, record);
    }
  }
  return entries;
}
