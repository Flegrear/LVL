// Sources LVL has no engine of its own for, through the extension runner.
// Same shape as the engines in source-engines.js: search, chapters, pages;
// page images also come through the runner (some extensions unscramble them there).
// The extension's file is downloaded from the repository once per version, and again
// when its code doesn't run (the repository may have fixed it under the same version).
// A site check (Cloudflare) is passed in LVL's hidden browser or its Verify window;
// the runner then gets that browser's cookies and user agent.
import fs from "node:fs";
import path from "node:path";
import { normalizeUnitNumber } from "../../shared/reading/units.js";
import { chapterNumber, volumeNumber } from "./chapter-names.js";
import { cleanTitle, fail as failure } from "./source-site.js";
import { validSitePath } from "./ext-sources.js";
import { sniffImage } from "../reader/pages.js";

const MAX_APK = 20 * 1024 * 1024;
const SEARCH_LIMIT = 20;

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

// runner: createExtRunner(); dir: where APKs are kept; findExtension(pkg) -> { pkg, version, apk, fingerprint? };
// remote: LVL's site requests (downloads, and siteCookies for checks).
export function createRunnerEngine({ runner, dir, findExtension, remote }) {
  async function apkFor(source, { fresh = false } = {}) {
    const ext = await findExtension(source.pkg);
    if (!ext) throw failure(`${source.extension || source.name} isn't in the repository any more`, 404);
    if (!/^https:\/\//.test(String(ext.apk || ""))) throw failure("The repository doesn't link this extension's file");
    const file = path.join(dir, `${safeName(ext.pkg)}-v${safeName(ext.version)}.apk`);
    if (fresh) fs.rmSync(file, { force: true });
    if (!fs.existsSync(file)) {
      const response = await remote.request(ext.apk, { accept: "application/vnd.android.package-archive,*/*", maxBytes: MAX_APK, timeoutMs: 60_000 });
      if (!response.ok) throw failure(`The extension file couldn't be downloaded (HTTP ${response.status})`);
      fs.mkdirSync(dir, { recursive: true });
      const partial = `${file}.part`;
      fs.writeFileSync(partial, response.buffer);
      fs.renameSync(partial, file);
      // Older versions of this extension's file.
      for (const name of fs.readdirSync(dir)) {
        if (name.startsWith(`${safeName(ext.pkg)}-v`) && name.endsWith(".apk") && path.join(dir, name) !== file) fs.rmSync(path.join(dir, name), { force: true });
      }
    }
    // A file downloaded again under the same version is loaded again.
    const stat = fs.statSync(file);
    return { file, key: `${ext.pkg}@${ext.version}#${stat.size}-${Math.round(stat.mtimeMs)}`, fingerprint: String(ext.fingerprint || "") };
  }

  async function ready(source, options) {
    const { file, key, fingerprint } = await apkFor(source, options);
    const loaded = await runner.load(file, key, { fingerprint });
    if (!loaded.sources.some((item) => String(item.id) === String(source.id))) throw failure(`The ${source.extension || source.name} extension no longer has this source`, 404);
    return loaded;
  }

  // A repository can re-publish an extension under the same version (a fixed build).
  // When the kept file's code doesn't link or verify, it is downloaded again, once per
  // extension while LVL runs, and the request is tried once more.
  const refetched = new Set();
  async function using(source, task) {
    try {
      await ready(source);
      return await withCheck(source, task);
    } catch (error) {
      if (error.code !== "extension-code" || refetched.has(source.pkg)) throw error;
      refetched.add(source.pkg);
      await ready(source, { fresh: true });
      return withCheck(source, task);
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
