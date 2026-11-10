// Comics in LVL's Android app: the hidden browser that sites behind a browser check
// (Cloudflare) need, with the same interface as source-browser.js, but provided by the app.
// The app's extension host makes the request with its OkHttp client, which shares the
// WebView's cookies and user agent and passes Cloudflare checks in a hidden WebView, as
// Mihon does; a check that needs a person opens LVL's Verify screen in the app.
// The host is reached the same way as for extensions (LVL_EXT_HOST_SOCKET).
import { createExtRunner } from "./ext-runner.js";

const MAX_BYTES = 40 * 1024 * 1024;

// runner: an extension-runner client connected to the app's host (tests pass a fake).
export function createAppBrowser({ dataDir, hostSocket = process.env.LVL_EXT_HOST_SOCKET || "", runner = null } = {}) {
  const client = runner || createExtRunner({ hostSocket, dataDir, home: null, java: null });
  let verify = { open: false, passed: false, at: null };
  let refreshing = null;
  let verifyGeneration = 0;

  const fail = (message, status = 502, code = "") => Object.assign(new Error(message), { status, ...(code ? { code } : {}) });
  const checkOpenError = () => fail("Finish the check on the Verify screen, close it, then search again", 409, "check-open");
  const updateVerify = (state) => {
    verify = { open: Boolean(state?.open), passed: Boolean(state?.passed), at: state?.at || null };
  };

  // A cached poll can still say "open" after the native screen was closed.
  // Recheck before blocking a real request, while preserving the synchronous UI poll API.
  async function ensureVerifyClosed() {
    if (!verify.open) return;
    if (refreshing) await refreshing;
    if (verify.open && client.available()) {
      const generation = verifyGeneration;
      const state = await client.call("verifyState", {}, { timeoutMs: 10_000 });
      if (generation === verifyGeneration) updateVerify(state);
    }
    if (verify.open) throw checkOpenError();
  }

  async function request(url, { method = "GET", body = null, contentType = "", headers = {}, referer = "", accept = "", lang = "", maxBytes = 8 * 1024 * 1024, timeoutMs = 60_000 } = {}) {
    await ensureVerifyClosed();
    const sent = {
      ...(accept ? { Accept: accept } : {}),
      ...(lang ? { "Accept-Language": `${lang},en;q=0.8` } : {}),
      ...(contentType && body !== null && body !== undefined ? { "Content-Type": contentType } : {}),
      ...headers,
    };
    const result = await client.call("browserRequest", {
      url: String(url), method, headers: sent, referer: referer || "",
      ...(body !== null && body !== undefined ? { body: Buffer.from(body).toString("base64") } : {}),
      maxBytes: Math.min(maxBytes, MAX_BYTES),
    }, { timeoutMs: timeoutMs + 35_000 });
    const buffer = Buffer.from(String(result?.data || ""), "base64");
    const status = Number(result?.status) || 0;
    return {
      status, ok: status >= 200 && status < 300, url: String(result?.url || url),
      headers: Object.fromEntries(Object.entries(result?.headers || {}).map(([name, value]) => [name.toLowerCase(), value])),
      buffer, text: () => buffer.toString("utf8"), json: () => JSON.parse(buffer.toString("utf8")),
    };
  }

  // The state the UI polls: the last answer from the app, refreshed in the background.
  function verifyState() {
    if (!refreshing && client.available()) {
      const generation = verifyGeneration;
      refreshing = client.call("verifyState", {}, { timeoutMs: 10_000 })
        .then((state) => { if (generation === verifyGeneration) updateVerify(state); })
        .catch(() => {})
        .finally(() => { refreshing = null; });
    }
    return verify;
  }

  return {
    available: client.available(),
    request,
    async siteCookies(url) {
      await ensureVerifyClosed();
      return client.call("siteCookies", { url: String(url) }, { timeoutMs: 70_000 });
    },
    async openVisible(url) {
      // Ignore a poll started before this new Verify session.
      const generation = ++verifyGeneration;
      const state = await client.call("openVisible", { url: String(url) }, { timeoutMs: 15_000 });
      if (generation === verifyGeneration) verify = { open: Boolean(state?.open), passed: false, at: null };
      return { open: verify.open };
    },
    verifyState,
    checkOpen: () => verify.open,
    running: () => client.running(),
    stop: () => client.stop(),
  };
}
