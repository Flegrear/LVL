// Third-party Comics browser checks cannot be safely loaded using Chromium
// until the actual socket endpoints, redirects, scripts and subresources can
// be verified against the public-address policy. Normal direct fetch stays enabled.

import fs from "node:fs";
import path from "node:path";
import { checkUrl } from "./remote-fetch.js";

// Retained for callers that imported the previous browser cooldown constant.
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

const protectedSiteError = () => Object.assign(
  new Error("This site requires a browser check that LVL can't complete. Try another source."),
  { status: 502, code: "blocked" },
);

// Chromium can resolve a public hostname to a private socket after LVL checked
// its DNS, and its redirects, script requests, WebSockets and service workers
// cannot be confined by a URL-only CDP event. Until an enforceable browser
// network boundary exists, never start Chromium or use the separate Android
// browser transport for these third-party Comics requests.
export function createSourceBrowser({ dir, executable = findBrowser() } = {}) {
  void dir;
  void executable;
  const refuse = async (url, options = {}) => {
    options.signal?.throwIfAborted();
    checkUrl(url);
    throw protectedSiteError();
  };
  return Object.freeze({
    available: false,
    request: refuse,
    openVisible: refuse,
    siteCookies: refuse,
    stop() {},
    running: () => false,
    checkOpen: () => false,
    verifyState: () => ({ open: false, passed: false }),
  });
}

// The hardened Node remote transport validates each redirect and the address
// actually used by each socket. Do not swap it for a separately resolving
// browser or silently retry via Chromium after a verification failure.
export function withBrowserFallback(remote, browser, { checkHost, isBotCheck } = {}) {
  void checkHost; // DNS-only prechecks cannot authorize a browser connection.
  const challenged = typeof isBotCheck === "function" ? isBotCheck : () => false;
  const refuse = (url, signal) => {
    signal?.throwIfAborted();
    checkUrl(url);
    throw protectedSiteError();
  };
  return {
    async request(url, options = {}) {
      options.signal?.throwIfAborted();
      checkUrl(url);
      const mode = options.browser || "auto";
      if (mode === "always") refuse(url, options.signal);
      const response = await remote.request(url, options);
      options.signal?.throwIfAborted();
      if (mode === "never" || !challenged(response)) return response;
      // A site blocked the public-socket transport. Do not try an unverified
      // browser with independent DNS/redirect/subresource destinations.
      refuse(url, options.signal);
    },
    usesBrowser: () => false,
    async openCheck(url, options = {}) { refuse(url, options.signal); },
    // A read-only status report does not authorize any browser navigation.
    verifyState: () => browser?.verifyState?.() || { open: false, passed: false },
    async siteCookies(url, options = {}) { refuse(url, options.signal); },
    stop: () => browser?.stop?.(),
  };
}
