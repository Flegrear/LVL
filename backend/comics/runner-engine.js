// Sources LVL has no engine of its own for, through the extension runner.
// Same shape as the engines in source-engines.js: search, chapters, pages;
// page images also come through the runner (some extensions unscramble them there).
// The extension's file is downloaded from the repository once per version, and again
// when its code doesn't run (the repository may have fixed it under the same version).
// A site check (Cloudflare) is passed in LVL's hidden browser or its Verify window;
// the runner then gets that browser's cookies and user agent.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { normalizeUnitNumber } from "../../shared/reading/units.js";
import { chapterNumber, volumeNumber } from "./chapter-names.js";
import { cleanTitle, fail as failure } from "./source-site.js";
import { validSitePath } from "./ext-sources.js";
import { sniffImage } from "../reader/pages.js";

const MAX_APK = 20 * 1024 * 1024;
const SEARCH_LIMIT = 20;
const SIGNER = /^(?:[0-9a-f]{64}|(?:[0-9a-f]{2}:){31}[0-9a-f]{2})$/i;
const PACKAGE = /^[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)+$/;
const trustFailure = (message) => failure(message, 403, "extension-trust");

// Extension URLs are usually site paths ("/series/x"); some are full addresses or ids.
// Those are kept as "/~r/<encoded>" so LVL's path checks accept them.
export function toLvlPath(url) {
  const value = String(url ?? "");
  return value.startsWith("/") && !value.startsWith("/~r/") && validSitePath(value) ? value : `/~r/${encodeURIComponent(value)}`;
}
export function fromLvlPath(lvlPath) {
  const value = String(lvlPath ?? "");
  if (!value.startsWith("/~r/")) return value;
  try { return decodeURIComponent(value.slice(4)); } catch { return value; }
}

// Entries chosen while LVL had its own engines for these themes were saved
// in that engine's form; the extensions use another. Each rewrite leaves a path already
// in the extension's form unchanged. The other removed themes saved the extension's form.
export const LEGACY_ENGINE_PATHS = Object.freeze({
  // "/vinland-saga#z8dyLlYR" (LVL kept the API id) -> "/vinland-saga"
  mangak: (path) => path.replace(/#[\w-]{1,40}$/, ""),
  // "/series/<slug>#<id>" -> the extension's "<slug>#<id>"
  iken: (path) => { const match = /^\/series\/([^/#]+)#(\d{1,12})$/.exec(path); return match ? toLvlPath(`${match[1]}#${match[2]}`) : path; },
});

const safeName = (value) => String(value || "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);

function absolute(url, base) {
  if (!url) return "";
  try { return new URL(String(url), `${base}/`).href; } catch { return ""; }
}

// The extension's chapter number when it gives one (0 or more), else read from the name.
export function runnerChapter(item, mangaTitle = "") {
  const name = cleanTitle(item?.name);
  const given = Number(item?.number);
  const chapter = Number.isFinite(given) && given >= 0 ? normalizeUnitNumber(String(given)) : chapterNumber(name, mangaTitle);
  return {
    path: toLvlPath(item?.url), name, chapter: chapter ?? chapterNumber(name, mangaTitle), volume: volumeNumber(name),
    date: Number(item?.date) > 0 ? Number(item.date) : null, group: String(item?.scanlator || "").slice(0, 120),
  };
}

// runner: createExtRunner(); dir: where APKs are kept; findExtension(pkg) -> trusted repository entry
// { pkg, version, apk, fingerprint, sources }. Repository identities are mandatory for executable code.
// remote: LVL's site requests (downloads, and siteCookies for checks).
export function createRunnerEngine({ runner, dir, findExtension, remote }) {
  // Downloads AND native admissions of one package must not race each other,
  // even when repository sources of that package are opened concurrently.
  // The lease is held through the native load and verified receipt, rather
  // than exposing a downloaded but not-yet-admitted APK to another borrower.
  // Keep old content addresses intact: the native runner may borrow them.
  const packageLeases = new Map();
  const preferred = new Map();
  const withPackageLease = (pkg, action) => {
    const previous = packageLeases.get(pkg) || Promise.resolve();
    const pending = previous.catch(() => {}).then(action);
    const lease = pending.catch(() => {});
    packageLeases.set(pkg, lease);
    void lease.finally(() => { if (packageLeases.get(pkg) === lease) packageLeases.delete(pkg); });
    return pending;
  };
  async function apkFor(source, { fresh = false } = {}) {
    const ext = await findExtension(source.pkg);
    if (!ext) throw failure(`${source.extension || source.name} isn't in the repository any more`, 404);
    if (!PACKAGE.test(String(ext.pkg || "")) || ext.pkg !== source.pkg
      || !ext.sources?.some((item) => String(item.id) === String(source.id)))
      throw trustFailure("The extension's repository package or source identity changed");
    if (!SIGNER.test(String(ext.fingerprint || "")))
      throw trustFailure("The extension repository has no valid approved SHA-256 signing fingerprint");
    const fingerprint = String(ext.fingerprint).replaceAll(":", "").toLowerCase();
    if (!/^https:\/\//.test(String(ext.apk || ""))) throw failure("The repository doesn't link this extension's file");
    const authority = `${ext.pkg}@${ext.version}#${fingerprint}`;
    const prefix = `${safeName(ext.pkg)}-v${safeName(ext.version)}-s${fingerprint}-`;
    // ready() owns the package lease across this download AND native admission.
    // No nested lease: another reader waits for the first verified receipt.
    {
      fs.mkdirSync(dir, { recursive: true });
      let file = null;
      let digest = null;
      // Reuse only an immutable, content-addressed candidate under the exact
      // repository package+version+signer authority. Native runner.load still
      // verifies the APK publisher/package before code is admitted.
      if (!fresh) {
        const names = fs.readdirSync(dir).filter((name) =>
          name.startsWith(prefix) && /^[0-9a-f]{64}\.apk$/.test(name.slice(prefix.length)));
        const preferredFile = preferred.get(authority);
        names.sort((a, b) => {
          if (path.join(dir, a) === preferredFile) return -1;
          if (path.join(dir, b) === preferredFile) return 1;
          const modified = (name) => { try { return fs.statSync(path.join(dir, name)).mtimeMs; } catch { return 0; } };
          return modified(b) - modified(a);
        });
        for (const name of names) {
          const candidate = path.join(dir, name);
          try {
            const stat = fs.lstatSync(candidate);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_APK) continue;
            const actual = createHash("sha256").update(fs.readFileSync(candidate)).digest("hex");
            if (actual !== name.slice(prefix.length, -4)) continue;
            // A previously accepted candidate needs an exact native admission
            // marker. A downloaded but not-yet-admitted candidate is not an
            // authority for another caller; ready() holds the package lease
            // until native verification and the receipt are complete.
            if (preferred.get(authority) !== candidate) {
              const admitted = JSON.parse(fs.readFileSync(`${candidate}.verified`, "utf8"));
              if (admitted.authority !== authority || admitted.digest !== actual) continue;
            }
            file = candidate;
            digest = actual;
            break;
          } catch { /* corrupted or concurrently retired cache entry */ }
        }
      }
      if (!file) {
        const response = await remote.request(ext.apk, {
          accept: "application/vnd.android.package-archive,*/*",
          maxBytes: MAX_APK, timeoutMs: 60_000, httpsOnly: true, browser: "never",
        });
        if (!response.ok) throw failure(`The extension file couldn't be downloaded (HTTP ${response.status})`);
        if (!Buffer.isBuffer(response.buffer) || response.buffer.length < 1 || response.buffer.length > MAX_APK)
          throw trustFailure("The extension file has invalid bytes");
        digest = createHash("sha256").update(response.buffer).digest("hex");
        file = path.join(dir, `${prefix}${digest}.apk`);
        const partial = path.join(dir, `${prefix}${randomBytes(12).toString("hex")}.part`);
        try {
          fs.writeFileSync(partial, response.buffer, { flag: "wx" });
          // Hard-link is exclusive, unlike rename replacement. Another native
          // borrower can keep its prior accepted APK and no stale .part wins.
          try { fs.linkSync(partial, file); }
          catch (error) { if (error.code !== "EEXIST") throw error; }
          const published = fs.readFileSync(file);
          if (createHash("sha256").update(published).digest("hex") !== digest)
            throw trustFailure("Cached extension bytes conflict with the verified content address");
        } finally {
          try { fs.rmSync(partial, { force: true }); } catch { /* no borrower owns the unaccepted partial */ }
        }
      }
      return { file, key: `${authority}#${digest}`, fingerprint, packageName: ext.pkg };
    }
  }

  async function ready(source, options) {
    return withPackageLease(source.pkg, async () => {
      const { file, key, fingerprint, packageName } = await apkFor(source, options);
      const loaded = await runner.load(file, key, { fingerprint, packageName });
      if (!loaded.sources.some((item) => String(item.id) === String(source.id))) throw failure(`The ${source.extension || source.name} extension no longer has this source`, 404);
      const digest = key.slice(key.lastIndexOf("#") + 1);
      const authority = key.slice(0, key.lastIndexOf("#"));
      // This admission receipt is separate from the executable APK: rejected
      // downloaded content is never reused merely because bytes reached disk.
      // Existing verified receipts may be retained by concurrent borrowers.
      try {
        fs.writeFileSync(`${file}.verified`, JSON.stringify({ authority, digest }), { flag: "wx" });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const existing = JSON.parse(fs.readFileSync(`${file}.verified`, "utf8"));
        if (existing.authority !== authority || existing.digest !== digest)
          throw trustFailure("Conflicting extension admission receipt");
      }
      // Do NOT advance the preferred borrowed APK merely because the download
      // reached disk. Only an accepted native load and exact requested source
      // can promote the candidate. Failed fresh loads keep the last accepted
      // immutable content available to subsequent ordinary calls.
      preferred.set(authority, file);
      return loaded;
    });
  }

  // A repository can re-publish an extension under the same version (a fixed build).
  // When the kept file's code doesn't link or verify, it is downloaded again, once per
  // extension while LVL runs, and the request is tried once more.
  const refetched = new Set();
  const refreshing = new Map();
  // A failed refresh is shared by the requests that were already started
  // when it failed, even if a package-serialized native load delays their
  // extension-code catch. Later requests must NOT inherit that failure:
  // unrelated old operations may stay in runner.call for an arbitrarily long
  // time, and active package counts can otherwise starve all future retries.
  // Per-package request ordinals and disjoint failed intervals make each
  // failure belong to one cohort only. An unrelated old runner.call must not
  // pin the receipts of every later independent failed retry.
  const issued = new Map();
  const activeRequests = new Map();
  const failedRefreshes = new Map();
  const lastFailedThrough = new Map();
  function retireDrainedFailures(pkg) {
    const active = activeRequests.get(pkg);
    const failed = failedRefreshes.get(pkg);
    if (!failed) return;
    // An old, still-active operation can retain its own failed receipt, but
    // must never prevent a later independent generation from retrying.
    const outstanding = failed.filter((entry) =>
      active && [...active].some((ordinal) => ordinal >= entry.from && ordinal <= entry.through));
    if (outstanding.length) failedRefreshes.set(pkg, outstanding);
    else failedRefreshes.delete(pkg);
  }
  async function using(source, task) {
    const pkg = source.pkg;
    const ordinal = (issued.get(pkg) || 0) + 1;
    issued.set(pkg, ordinal);
    if (!activeRequests.has(pkg)) activeRequests.set(pkg, new Set());
    activeRequests.get(pkg).add(ordinal);
    try {
      try {
        await ready(source);
        return await withCheck(source, task);
      } catch (error) {
        if (error.code !== "extension-code") throw error;
        // Historical cohorts take priority: a delayed original borrower must
        // observe its shared failure, even if a newer request has since
        // successfully refreshed the package.
        let cohort = failedRefreshes.get(pkg)?.find((entry) =>
          ordinal >= entry.from && ordinal <= entry.through);
        // Never initiate another refetch once one signed fresh admission
        // succeeded; historical failed callers may still see their own error.
        if (!cohort && refetched.has(pkg)) throw error;
        if (!cohort) cohort = refreshing.get(pkg);
        if (!cohort) {
          const refresh = ready(source, { fresh: true }).then((loaded) => {
            refetched.add(pkg);
            return loaded;
          });
          cohort = { promise: refresh, from: null, through: null };
          refreshing.set(pkg, cohort);
          const owned = cohort;
          // Rejected cohorts keep only the ordinals that already existed at
          // rejection. Later arrivals may immediately open a new refresh.
          // This settlement observer consumes both outcomes (no dangling
          // unhandled rejection) and never cancels an active native borrower.
          void refresh.then(
            () => {
              if (refreshing.get(pkg) === owned) refreshing.delete(pkg);
            },
            () => {
              owned.from = (lastFailedThrough.get(pkg) || 0) + 1;
              owned.through = issued.get(pkg);
              lastFailedThrough.set(pkg, owned.through);
              const failures = failedRefreshes.get(pkg) || [];
              failures.push(owned);
              failedRefreshes.set(pkg, failures);
              if (refreshing.get(pkg) === owned) refreshing.delete(pkg);
              retireDrainedFailures(pkg);
            },
          );
        }
        await cohort.promise;
        return await withCheck(source, task);
      }
    } finally {
      const active = activeRequests.get(pkg);
      active?.delete(ordinal);
      if (active?.size === 0) activeRequests.delete(pkg);
      retireDrainedFailures(pkg);
      // All request/cohort ordinals may restart only after no package call or
      // refresh can still refer to an older generation.
      if (!activeRequests.has(pkg) && !refreshing.has(pkg) && !failedRefreshes.has(pkg)) {
        issued.delete(pkg);
        lastFailedThrough.delete(pkg);
      }
    }
  }

  // A site check: pass it in LVL's browser, give the runner that browser's cookies, try once more.
  async function withCheck(source, task) {
    try { return await task(); } catch (error) {
      if (error.code !== "blocked") throw error;
      if (!remote.siteCookies) throw failure(`${source.name} asks for a browser check (Cloudflare)`, 502, "blocked");
      let jar;
      try { jar = await remote.siteCookies(source.baseUrl || source.repoBaseUrl); } catch (problem) {
        throw failure(`${source.name} asks for a browser check (Cloudflare)`, 502, problem.code === "check-open" ? "check-open" : "blocked");
      }
      await runner.call("cookies", { url: source.baseUrl || source.repoBaseUrl, cookies: jar.cookies, userAgent: jar.userAgent });
      try { return await task(); } catch (again) {
        if (again.code === "blocked") throw failure(`${source.name} asks for a browser check (Cloudflare)`, 502, "blocked");
        throw again;
      }
    }
  }

  return {
    id: "runner",
    name: "Extension",
    async browse(source, { mode = "popular", query = "", page = 1 } = {}) {
      if (!["popular", "latest", "search"].includes(mode) || !Number.isInteger(page) || page < 1 || page > 20) throw failure("Invalid source page", 400);
      const result = await using(source, () => runner.call(mode, { source: String(source.id), ...(mode === "search" ? { query } : {}), page }));
      return {
        hasNextPage: Boolean(result?.hasNextPage),
        items: (result?.mangas || []).slice(0, SEARCH_LIMIT).map((manga) => ({
          path: toLvlPath(manga.url), title: cleanTitle(manga.title), cover: absolute(manga.thumbnail, source.baseUrl),
        })).filter((item) => item.title && item.path),
      };
    },
    async search(source, query) {
      const result = await using(source, () => runner.call("search", { source: String(source.id), query, page: 1 }));
      return (result?.mangas || []).slice(0, SEARCH_LIMIT).map((manga) => ({
        path: toLvlPath(manga.url), title: cleanTitle(manga.title), cover: absolute(manga.thumbnail, source.baseUrl),
      })).filter((item) => item.title);
    },
    async chapters(source, lvlPath, { title = "" } = {}) {
      const list = await using(source, () => runner.call("chapters", { source: String(source.id), url: fromLvlPath(lvlPath), title }));
      return (Array.isArray(list) ? list : []).map((item) => runnerChapter(item, title)).filter((item) => item.path);
    },
    async pages(source, lvlPath) {
      const pages = await using(source, () => runner.call("pages", { source: String(source.id), url: fromLvlPath(lvlPath) }));
      const list = (Array.isArray(pages) ? pages : []).map((page) => ({ index: Number(page.index) || 0, url: String(page.url || ""), imageUrl: page.imageUrl ? String(page.imageUrl) : "" }));
      return { referer: `${source.baseUrl}/`, images: list.map((page) => page.imageUrl || `runner:${page.index}`), runner: list };
    },
    // One page image, fetched by the extension's own client.
    async image(source, page) {
      const result = await using(source, () => runner.call("image", { source: String(source.id), index: page.index, url: page.url, imageUrl: page.imageUrl || "" }, { timeoutMs: 120_000 }));
      const buffer = Buffer.from(String(result?.data || ""), "base64");
      if (!buffer.length) throw failure("The page image is empty");
      // The type comes from the bytes: some image servers label pages text/plain (Asmodeus, Kewn).
      const type = sniffImage(buffer);
      if (!type) throw failure("Not an image");
      return { type, buffer };
    },
  };
}
