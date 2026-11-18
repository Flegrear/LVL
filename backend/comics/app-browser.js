// Comics in LVL's Android app: the hidden browser that sites behind a browser check
// (Cloudflare) need, with the same interface as source-browser.js, but provided by the app.
// The app's extension host makes the request with its OkHttp client, which shares the
// WebView's cookies and user agent and passes Cloudflare checks in a hidden WebView, as
// Mihon does; a check that needs a person opens LVL's Verify screen in the app.
// The host is reached the same way as for extensions (LVL_EXT_HOST_SOCKET).
import { createExtRunner } from "./ext-runner.js";
import { checkUrl } from "./remote-fetch.js";

const MAX_BYTES = 40 * 1024 * 1024;

// runner: an extension-runner client connected to the app's host (tests pass a fake).
export function createAppBrowser({ dataDir, hostSocket = process.env.LVL_EXT_HOST_SOCKET || "", runner = null } = {}) {
  const client = runner || createExtRunner({ hostSocket, dataDir, home: null, java: null });
  let verify = { open: false, passed: false, at: null, revision: null };
  let refreshing = null;
  let opening = null;
  let verifyGeneration = 0;
  let stopped = false;

  const fail = (message, status = 502, code = "") => Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
  const requireLive = () => {
    if (stopped) throw fail("The browser host was stopped", 503, "stopped");
  };
  const checkOpenError = () => fail("Finish the check on the Verify screen, close it, then search again", 409, "check-open");
  const staleError = () => fail("Browser verification changed. Try again.", 409, "stale");
  const epochError = () => fail("The browser host cannot prove its verification epoch", 409, "verification-epoch-unavailable");
  const validRevision = (value) => Number.isSafeInteger(value) && value >= 0;
  const normalizedUrl = (value) => {
    // Retain the established public-address syntax gate. The native host still
    // owns public DNS/socket/redirect enforcement; this is not an alternative.
    const parsed = checkUrl(value);
    parsed.hash = ""; // HTTP never sends a fragment; OkHttp canonicalizes it away.
    return parsed;
  };
  const updateVerify = (state) => {
    verify = { open: Boolean(state?.open),
      passed: validRevision(state?.revision) && Boolean(state?.passed),
      at: state?.at || null, revision: validRevision(state?.revision) ? state.revision : null };
  };

  // UI polls are only presentation state. Every data-bearing operation needs
  // a FRESH native closed revision even when the cached UI says closed.
  async function ensureVerifyClosed() {
    requireLive();
    // An older verifyState reply can report closed while native openVisible
    // has not acknowledged the new screen. Wait for that exact opening intent
    // before considering any public request or cookie export.
    if (opening) await opening.catch(() => {});
    requireLive();
    const generation = verifyGeneration;
    if (!client.available()) throw fail("The browser host is unavailable", 503, "unavailable");
    const state = await client.call("verifyState", {}, { timeoutMs: 10_000 });
    requireLive();
    if (generation !== verifyGeneration) throw staleError();
    updateVerify(state);
    if (state?.open !== false || state?.pending !== false) throw checkOpenError();
    if (!validRevision(state?.revision)) throw epochError();
    return { generation, revision: state.revision };
  }

  async function verifyHandoff(epoch) {
    requireLive();
    if (epoch.generation !== verifyGeneration) throw staleError();
    const current = await ensureVerifyClosed();
    requireLive();
    if (current.generation !== epoch.generation || current.revision !== epoch.revision)
      throw staleError();
  }

  async function request(url, { method = "GET", body = null, contentType = "", headers = {}, referer = "", accept = "", lang = "", maxBytes = 8 * 1024 * 1024, timeoutMs = 60_000 } = {}) {
    const target = normalizedUrl(url);
    const epoch = await ensureVerifyClosed();
    const boundedBytes = Math.min(MAX_BYTES, Math.max(1, Number.isFinite(maxBytes) ? Math.floor(maxBytes) : 8 * 1024 * 1024));
    const sent = {
      ...(accept ? { Accept: accept } : {}),
      ...(lang ? { "Accept-Language": `${lang},en;q=0.8` } : {}),
      ...(contentType && body !== null && body !== undefined ? { "Content-Type": contentType } : {}),
      ...headers,
    };
    const result = await client.call("browserRequest", {
      url: target.href, method, headers: sent, referer: referer || "",
      verificationRevision: epoch.revision, verificationUrl: target.href,
      ...(body !== null && body !== undefined ? { body: Buffer.from(body).toString("base64") } : {}),
      maxBytes: boundedBytes,
    }, { timeoutMs: timeoutMs + 35_000 });
    // The native host's byte-budget is necessary but not sufficient: treat the
    // RPC payload as untrusted until its encoded size is bounded here as well.
    // A native Verify begin/close can happen without any Node openVisible call.
    requireLive();
    if (epoch.generation !== verifyGeneration
      || result?.verificationRevision !== epoch.revision
      || result?.verificationUrl !== target.href) throw staleError();
    // A redirect may not silently change the cookie/source origin at handoff.
    // Public socket/redirect validation still belongs to the native transport.
    let finalUrl;
    try {
      if (typeof result?.url !== "string") throw staleError();
      finalUrl = normalizedUrl(result.url);
    } catch { throw staleError(); }
    if (finalUrl.origin !== target.origin) throw staleError();
    const encoded = result?.data ?? "";
    if (typeof encoded !== "string" || encoded.length > Math.ceil(boundedBytes / 3) * 4 + 4)
      throw fail("Browser response exceeds the size limit", 413, "too-large");
    const buffer = Buffer.from(encoded, "base64");
    if (buffer.length > boundedBytes) throw fail("Browser response exceeds the size limit", 413, "too-large");
    await verifyHandoff(epoch);
    const status = Number(result?.status) || 0;
    return {
      status, ok: status >= 200 && status < 300, url: finalUrl.href,
      headers: Object.fromEntries(Object.entries(result?.headers || {}).map(([name, value]) => [name.toLowerCase(), value])),
      buffer, text: () => buffer.toString("utf8"), json: () => JSON.parse(buffer.toString("utf8")),
    };
  }

  // The state the UI polls: the last answer from the app, refreshed in the background.
  function verifyState() {
    if (stopped) return verify;
    if (!refreshing && client.available()) {
      const generation = verifyGeneration;
      refreshing = client.call("verifyState", {}, { timeoutMs: 10_000 })
        .then((state) => { if (!stopped && generation === verifyGeneration) updateVerify(state); })
        .catch(() => {})
        .finally(() => { refreshing = null; });
    }
    return verify;
  }

  return {
    available: client.available(),
    request,
    async siteCookies(url) {
      const target = normalizedUrl(url);
      const epoch = await ensureVerifyClosed();
      const value = await client.call("siteCookies", {
        url: target.href, verificationRevision: epoch.revision,
        verificationUrl: target.href,
      }, { timeoutMs: 70_000 });
      requireLive();
      if (epoch.generation !== verifyGeneration
        || value?.verificationRevision !== epoch.revision
        || value?.verificationUrl !== target.href) throw staleError();
      await verifyHandoff(epoch);
      return value;
    },
    async openVisible(url) {
      // Ignore a poll started before this new Verify session.
      requireLive();
      const target = normalizedUrl(url);
      const generation = ++verifyGeneration;
      // Fail closed immediately, before the async native open acknowledges.
      verify = { open: true, passed: false, at: null, revision: null };
      const task = (async () => {
        const state = await client.call("openVisible", { url: target.href }, { timeoutMs: 15_000 });
        requireLive();
        if (generation !== verifyGeneration) return { open: false, superseded: true };
        verify = { open: Boolean(state?.open), passed: false, at: null, revision: null };
        return { open: verify.open };
      })();
      opening = task;
      try { return await task; }
      finally { if (opening === task) opening = null; }
    },
    verifyState,
    checkOpen: () => verify.open,
    running: () => client.running(),
    stop: () => {
      stopped = true;
      ++verifyGeneration;
      verify = { open: false, passed: false, at: null, revision: null };
      return client.stop();
    },
  };
}
