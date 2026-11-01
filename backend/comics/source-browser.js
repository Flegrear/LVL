// A headless browser for sites that answer LVL with a browser check
// (Cloudflare), like Mihon's WebView. It's started only when
// such a site is used and stopped after 10 idle minutes. Its profile lives in
// <data root>/runtime/source-browser and holds nothing but these sites' cookies.
// - Pages of the site itself are fetched by fetch() inside a tab on that site,
//   so the browser's own connection and cookies are used.
// - Images and other hosts are opened as a page in a scratch tab and the
//   response body is read through the DevTools protocol (no CORS involved).
// Every address is checked by the caller (remote-fetch) before it gets here.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const IDLE_MS = 10 * 60_000;
const TIMEOUT_MS = 90_000;
const IMAGE_TABS = 3;
// How long a site whose check the hidden browser couldn't pass fails at once.
export const BLOCKED_MS = 10 * 60_000;

export function findBrowser(env = process.env) {
  const roots = [env["ProgramFiles(x86)"], env.ProgramFiles, env.LOCALAPPDATA].filter(Boolean);
  const candidates = [env.LVL_SOURCE_BROWSER, ...roots.flatMap((root) => [
    path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(root, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(root, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
  ])].filter(Boolean);
  return candidates.find((file) => { try { return fs.statSync(file).isFile(); } catch { return false; } }) || null;
}

const fail = (message, status = 502) => Object.assign(new Error(message), { status });

// Client hints for the user agent: the brands a normal Edge/Chrome window sends
// ("HeadlessChrome" is a brand checks look for). null when the version is unknown.
export function userAgentMetadata(userAgent) {
  const full = /Chrome\/(\d+)\.([\d.]+)/.exec(String(userAgent || ""));
  if (!full) return null;
  const major = full[1];
  const fullVersion = `${full[1]}.${full[2]}`;
  const edge = /Edg\/([\d.]+)/.exec(userAgent);
  const brand = edge ? { brand: "Microsoft Edge", major: edge[1].split(".")[0], full: edge[1] } : { brand: "Google Chrome", major, full: fullVersion };
  return {
    brands: [{ brand: "Chromium", version: major }, { brand: brand.brand, version: brand.major }, { brand: "Not?A_Brand", version: "99" }],
    fullVersionList: [{ brand: "Chromium", version: fullVersion }, { brand: brand.brand, version: brand.full }, { brand: "Not?A_Brand", version: "99.0.0.0" }],
    fullVersion: brand.full, platform: /Windows/.test(userAgent) ? "Windows" : /Mac OS/.test(userAgent) ? "macOS" : "Linux", platformVersion: "10.0.0",
    architecture: "x86", bitness: "64", model: "", mobile: false, wow64: false,
  };
}

export function createSourceBrowser({ dir, executable = findBrowser() } = {}) {
  let state = null; // { child, ws, sessions, ... } while running
  let starting = null;
  let idleTimer = null;
  let lastUsed = 0;
  const blockedSites = new Map(); // origin -> time until which its check isn't tried again

  function touch() {
    lastUsed = Date.now();
    if (!idleTimer) {
      idleTimer = setInterval(() => { if (state && Date.now() - lastUsed > IDLE_MS) stop(); }, 60_000);
      idleTimer.unref?.();
    }
  }

  async function start() {
    if (!executable) throw fail("Reading this site needs Microsoft Edge or Google Chrome, which wasn't found", 503);
    fs.mkdirSync(dir, { recursive: true });
    const portFile = path.join(dir, "DevToolsActivePort");
    fs.rmSync(portFile, { force: true });
    const child = spawn(executable, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${dir}`, "--no-first-run", "--no-default-browser-check",
      "--disable-extensions", "--disable-sync", "--disable-background-networking", "--mute-audio", "--window-size=1280,900",
      // navigator.webdriver stays false, as in a normal window (checks look for it).
      "--disable-blink-features=AutomationControlled", "about:blank"], { stdio: "ignore", windowsHide: true });
    child.once("exit", () => { if (state?.child === child) cleanup(); });
    let port = null;
    let browserPath = null;
    for (let i = 0; i < 80 && !port; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      try { [port, browserPath] = fs.readFileSync(portFile, "utf8").split(/\r?\n/); } catch {}
    }
    if (!port) { child.kill(); throw fail("The browser for protected sites didn't start", 503); }
    const ws = new WebSocket(`ws://127.0.0.1:${port}${browserPath}`);
    await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", () => reject(fail("Couldn't connect to the browser", 503)), { once: true }); });
    const pending = new Map();
    const listeners = new Set();
    let nextId = 0;
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(fail(message.error.message || "Browser error")); else resolve(message.result || {});
        return;
      }
      for (const listener of listeners) listener(message);
    });
    ws.addEventListener("close", () => { for (const { reject } of pending.values()) reject(fail("The browser closed")); pending.clear(); if (state?.ws === ws) cleanup(); });
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { if (pending.delete(id)) reject(fail("The site took too long to answer", 504)); }, TIMEOUT_MS + 5000);
      pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
    const version = await send("Browser.getVersion");
    const userAgent = String(version.userAgent || "").replace("HeadlessChrome", "Chrome");
    state = { child, ws, send, listeners, userAgent, userAgentMetadata: userAgentMetadata(userAgent), siteTabs: new Map(), imageTabs: [], imageQueue: Promise.resolve() };
    return state;
  }

  async function ensure() {
    touch();
    if (state) return state;
    starting ||= start().finally(() => { starting = null; });
    return starting;
  }

  async function openTab(browser) {
    const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
    await browser.send("Network.setUserAgentOverride", { userAgent: browser.userAgent, acceptLanguage: "en-US,en;q=0.9",
      ...(browser.userAgentMetadata ? { userAgentMetadata: browser.userAgentMetadata } : {}) }, sessionId);
    await browser.send("Page.enable", {}, sessionId);
    await browser.send("Network.enable", {}, sessionId);
    return { targetId, sessionId, queue: Promise.resolve() };
  }

  // Opens url as a page in tab and returns the final document's response with
  // its body. A check page (403/503 HTML) is given time to pass and reload
  // itself, like a WebView would.
  async function navigate(browser, tab, url, referer) {
    const docs = [];
    let mainFrame = null;
    const listener = (message) => {
      if (message.sessionId !== tab.sessionId) return;
      const params = message.params || {};
      if (message.method === "Network.requestWillBeSent" && params.type === "Document" && (!mainFrame || params.frameId === mainFrame) && !docs.some((doc) => doc.requestId === params.requestId)) {
        docs.push({ requestId: params.requestId, frameId: params.frameId });
      }
      const doc = docs.find((item) => item.requestId === params.requestId);
      if (!doc) return;
      if (message.method === "Network.responseReceived") doc.response = params.response;
      else if (message.method === "Network.loadingFinished") doc.finished = Date.now();
      else if (message.method === "Network.loadingFailed") doc.failed = params.errorText || "failed";
    };
    browser.listeners.add(listener);
    try {
      const result = await browser.send("Page.navigate", { url, ...(referer ? { referrer: referer } : {}) }, tab.sessionId);
      if (result.errorText) throw fail(`The browser couldn't open it (${result.errorText})`);
      mainFrame = result.frameId || null;
      const deadline = Date.now() + TIMEOUT_MS;
      let last = null;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        last = docs.filter((doc) => !mainFrame || doc.frameId === mainFrame).at(-1);
        if (last?.failed) throw fail(`The browser couldn't load it (${last.failed})`);
        if (!last?.finished) continue;
        const checking = [403, 429, 503].includes(last.response?.status) && /html/i.test(last.response?.mimeType || "");
        // A check page: wait (up to 25 s) for the page it loads once passed.
        if (checking && Date.now() - last.finished < 25_000) continue;
        break;
      }
      if (!last?.finished) throw fail("The site took too long to answer", 504);
      const body = await browser.send("Network.getResponseBody", { requestId: last.requestId }, tab.sessionId);
      const buffer = Buffer.from(body.body || "", body.base64Encoded ? "base64" : "utf8");
      const response = last.response || {};
      return { status: response.status || 0, headers: Object.fromEntries(Object.entries(response.headers || {}).map(([key, value]) => [key.toLowerCase(), value])), buffer, url: response.url || url };
    } finally {
      browser.listeners.delete(listener);
    }
  }

  // A tab that stays on the site, so fetch() runs with its cookies.
  // A site whose check the hidden browser couldn't pass is remembered for BLOCKED_MS:
  // its next requests (covers come in tens) fail at once instead of waiting about 50 s
  // each, which also held the page's few connections so other requests waited.
  async function siteTab(browser, origin) {
    if ((blockedSites.get(origin) || 0) > Date.now()) throw Object.assign(fail("This site asks for a browser check that LVL can't pass"), { code: "blocked" });
    if (browser.siteTabs.has(origin)) return browser.siteTabs.get(origin);
    const pending = (async () => {
      const tab = await openTab(browser);
      const stillChecking = (page) => [403, 429, 503].includes(page.status) && /just a moment|attention required|challenge-platform/i.test(page.buffer.subarray(0, 6000).toString("utf8"));
      let home = await navigate(browser, tab, `${origin}/`);
      // A check often passes on the second load, once its first cookies are set.
      if (stillChecking(home)) { await new Promise((resolve) => setTimeout(resolve, 2000)); home = await navigate(browser, tab, `${origin}/`); }
      if (stillChecking(home)) {
        blockedSites.set(origin, Date.now() + BLOCKED_MS);
        throw Object.assign(fail("This site asks for a browser check that LVL can't pass"), { code: "blocked" });
      }
      return tab;
    })();
    browser.siteTabs.set(origin, pending);
    pending.catch(() => browser.siteTabs.delete(origin));
    return pending;
  }

  async function fetchInTab(browser, tab, url, options) {
    const init = { method: options.method || "GET", credentials: "include", headers: { ...(options.headers || {}) } };
    if (options.body !== undefined && options.body !== null) { init.body = options.body; if (options.contentType) init.headers["Content-Type"] = options.contentType; }
    const expression = `(async () => { const r = await fetch(${JSON.stringify(url)}, ${JSON.stringify(init)}); const b = new Uint8Array(await r.arrayBuffer());
      let s = ""; for (let i = 0; i < b.length; i += 32768) s += String.fromCharCode(...b.subarray(i, i + 32768));
      return { status: r.status, url: r.url, headers: Object.fromEntries(r.headers.entries()), body: btoa(s) }; })()`;
    const result = await browser.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, timeout: TIMEOUT_MS }, tab.sessionId);
    if (result.exceptionDetails) throw fail(`The browser couldn't load it (${String(result.exceptionDetails.exception?.description || "fetch failed").split("\n")[0]})`);
    const value = result.result.value;
    return { status: value.status, headers: value.headers, buffer: Buffer.from(value.body, "base64"), url: value.url };
  }

  // Runs task with a free scratch tab; at most IMAGE_TABS at once.
  async function withScratchTab(browser, task) {
    let tab = browser.imageTabs.find((item) => !item.busy);
    if (!tab && browser.imageTabs.length < IMAGE_TABS) { tab = await openTab(browser); browser.imageTabs.push(tab); }
    if (!tab) {
      await new Promise((resolve) => { browser.imageWaiters = [...(browser.imageWaiters || []), resolve]; });
      return withScratchTab(browser, task);
    }
    tab.busy = true;
    try { return await task(tab); } finally { tab.busy = false; browser.imageWaiters?.shift()?.(); }
  }

  // Same result shape as remote-fetch's request().
  async function request(url, options = {}) {
    const browser = await ensure();
    const target = new URL(url);
    const referer = options.referer ? new URL(options.referer) : null;
    const origin = referer && /^https?:$/.test(referer.protocol) ? referer.origin : target.origin;
    let result = null;
    const isCheck = (response) => [403, 429, 503].includes(response.status) && /just a moment|attention required|challenge-platform|cf-chl-/i.test(response.buffer.subarray(0, 6000).toString("utf8"));
    if (target.origin === origin) {
      const tab = await siteTab(browser, origin);
      result = await fetchInTab(browser, tab, target.href, options);
    }
    // Other hosts (images on a CDN), and GET pages the site checks again: load
    // them as a page, the only way a check can pass.
    if ((!result || isCheck(result)) && (options.method || "GET") === "GET") {
      if (referer && target.origin !== origin) await siteTab(browser, origin).catch(() => null);
      result = await withScratchTab(browser, (tab) => navigate(browser, tab, target.href, options.referer));
    }
    if (!result) throw fail("The browser couldn't load it");
    touch();
    const buffer = result.buffer;
    return { status: result.status, ok: result.status >= 200 && result.status < 300, url: result.url, headers: result.headers, buffer, viaBrowser: true,
      text: () => buffer.toString("utf8"), json: () => JSON.parse(buffer.toString("utf8")) };
  }

  function cleanup() {
    const current = state;
    state = null;
    try { current?.ws?.close(); } catch {}
    try { current?.child?.kill(); } catch {}
  }

  function stop() {
    clearInterval(idleTimer);
    idleTimer = null;
    cleanup();
  }

  // A normal window on the site with the same profile, for checks the hidden
  // browser can't pass (Mihon opens a WebView for this). LVL watches its page
  // through the DevTools port: once the site shows its own page instead of the
  // check, the cookies are in the profile, so LVL closes the window by itself.
  let visible = null; // { child, url, passed, startedAt }
  let lastVerify = null; // { url, passed, at } of the window that closed
  const CHECK_TITLE = /just a moment|attention required|un momento|un instant|einen moment|ddos-guard|security check|verificaci[oó]n|checking your browser/i;
  async function watchVisible(entry) {
    const portFile = path.join(dir, "DevToolsActivePort");
    const host = new URL(entry.url).hostname.split(".").slice(-2).join(".");
    let port = null;
    let clearSince = 0;
    while (visible === entry) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (visible !== entry) return;
      if (Date.now() - entry.startedAt > 10 * 60_000) { entry.child.kill(); return; } // left open: give up after 10 minutes
      if (!port) { try { port = fs.readFileSync(portFile, "utf8").split(/\r?\n/)[0]; } catch { continue; } }
      let pages = [];
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) });
        pages = (await response.json()).filter((item) => item.type === "page");
      } catch { continue; }
      const onSite = pages.find((item) => { try { return new URL(item.url).hostname.split(".").slice(-2).join(".") === host; } catch { return false; } });
      const passed = Boolean(onSite && onSite.title && !CHECK_TITLE.test(onSite.title));
      if (!passed) { clearSince = 0; continue; }
      // The site's own page for 2 s: the clearance cookie has been written.
      if (!clearSince) { clearSince = Date.now(); continue; }
      if (Date.now() - clearSince < 2000) continue;
      entry.passed = true;
      try {
        const version = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3000) })).json();
        const socket = new WebSocket(version.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
        socket.send(JSON.stringify({ id: 1, method: "Browser.close" }));
        setTimeout(() => { try { socket.close(); } catch {} if (visible === entry) entry.child.kill(); }, 3000);
      } catch { entry.child.kill(); }
      return;
    }
  }
  async function openVisible(url) {
    if (!executable) throw fail("Reading this site needs Microsoft Edge or Google Chrome, which wasn't found", 503);
    if (visible) return { open: true };
    // The user is passing the check by hand: try every site again afterwards.
    blockedSites.clear();
    stop();
    await new Promise((resolve) => setTimeout(resolve, 800));
    fs.mkdirSync(dir, { recursive: true });
    fs.rmSync(path.join(dir, "DevToolsActivePort"), { force: true });
    const child = spawn(executable, [`--user-data-dir=${dir}`, "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--window-size=1100,800", `--app=${url}`], { stdio: "ignore" });
    const entry = { child, url, passed: false, startedAt: Date.now() };
    visible = entry;
    const done = () => { if (visible === entry) { visible = null; lastVerify = { url, passed: entry.passed, at: Date.now() }; } };
    child.once("exit", done);
    child.once("error", done);
    void watchVisible(entry).catch(() => {});
    return { open: true };
  }
  // { open, passed }: whether the verify window is still open, and whether the last one saw the site's own page.
  const verifyState = () => (visible ? { open: true, passed: visible.passed } : { open: false, passed: Boolean(lastVerify?.passed), at: lastVerify?.at || null });

  async function guardedRequest(url, options) {
    if (visible) throw Object.assign(fail("Finish the check in the window that opened, close it, then search again", 409), { code: "check-open" });
    return request(url, options);
  }

  // The site's cookies after its check passed in the hidden browser (the profile also keeps
  // what the Verify window passed), as Set-Cookie strings, with the browser's user agent.
  // The extension runner sends them with its own requests.
  async function siteCookies(origin) {
    if (visible) throw Object.assign(fail("Finish the check in the window that opened, close it, then search again", 409), { code: "check-open" });
    const browser = await ensure();
    const site = new URL(origin).origin;
    await siteTab(browser, site);
    touch();
    const { cookies = [] } = await browser.send("Network.getCookies", { urls: [`${site}/`] }, (await siteTab(browser, site)).sessionId);
    const lines = cookies.map((cookie) => [`${cookie.name}=${cookie.value}`, cookie.domain ? `Domain=${cookie.domain}` : "", `Path=${cookie.path || "/"}`,
      cookie.expires > 0 ? `Expires=${new Date(cookie.expires * 1000).toUTCString()}` : "", cookie.secure ? "Secure" : "", cookie.httpOnly ? "HttpOnly" : ""].filter(Boolean).join("; "));
    return { cookies: lines, userAgent: browser.userAgent };
  }

  return { available: Boolean(executable), request: guardedRequest, siteCookies, stop: () => { stop(); }, openVisible, verifyState, checkOpen: () => Boolean(visible), running: () => Boolean(state) };
}

const siteOf = (host) => host.split(".").slice(-2).join(".");

// Requests go straight to the site; a site that answers with a browser check is
// remembered (for 12 h) and its requests, images included, go through the
// browser from then on. checkHost(url) must refuse local addresses: the
// browser does its own DNS, so the address is checked here first.
export function withBrowserFallback(remote, browser, { checkHost, isBotCheck, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const protectedSites = new Map();
  const viaBrowser = async (url, options) => {
    await checkHost(url);
    const body = options.form ? new URLSearchParams(options.form).toString() : options.json !== undefined ? JSON.stringify(options.json) : options.body;
    const contentType = options.form ? "application/x-www-form-urlencoded; charset=UTF-8" : options.json !== undefined ? "application/json" : options.contentType;
    const method = options.method || (body !== undefined && body !== null ? "POST" : "GET");
    let response = await browser.request(url, { ...options, method, body, contentType });
    // Overloaded sites (Cloudflare's 52x) often answer the next try.
    if (method === "GET" && [502, 503, 520, 521, 522, 523, 524].includes(response.status) && !isBotCheck(response)) {
      await sleep(2000);
      response = await browser.request(url, { ...options, method, body, contentType });
    }
    const maxBytes = Math.min(options.maxBytes || 8 * 1024 * 1024, 40 * 1024 * 1024);
    if (response.buffer.length > maxBytes) throw Object.assign(new Error("The page is too large"), { status: 502 });
    return response;
  };
  return {
    // options.browser: "always" (a site set to use the browser) or "never"; otherwise only after a check.
    async request(url, options = {}) {
      const host = new URL(String(url)).hostname;
      const site = siteOf(host);
      const mode = options.browser || "auto";
      if (mode === "always" && browser?.available) protectedSites.set(site, now() + 12 * 60 * 60_000);
      if (mode !== "never" && browser?.available && (protectedSites.get(site) || 0) > now()) return viaBrowser(url, options);
      const response = await remote.request(url, options);
      if (!isBotCheck(response) || !browser?.available || mode === "never") return response;
      protectedSites.set(site, now() + 12 * 60 * 60_000);
      return viaBrowser(url, options);
    },
    usesBrowser: (url) => (protectedSites.get(siteOf(new URL(String(url)).hostname)) || 0) > now(),
    async openCheck(url) {
      await checkHost(url);
      protectedSites.set(siteOf(new URL(String(url)).hostname), now() + 12 * 60 * 60_000);
      return browser.openVisible(url);
    },
    verifyState: () => browser?.verifyState?.() || { open: false, passed: false },
    // For the extension runner: the site's cookies once its check passed.
    async siteCookies(url) {
      if (!browser?.siteCookies) throw Object.assign(new Error("No browser is available for this site's check"), { status: 502, code: "blocked" });
      await checkHost(url);
      return browser.siteCookies(url);
    },
    stop: () => browser?.stop(),
  };
}