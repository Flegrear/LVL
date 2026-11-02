// Where LVL's pop-up player program (LVL-Popup.exe and the WebView2 SDK libraries) comes
// from. A source checkout builds it with `node scripts/build-popup.mjs` (build/popup).
// An installed LVL downloads the pinned program release once
// (LVL-Popup-v<version>.zip), independently of the app version, checks it against the
// checksum published with it, the way the updater checks updates, and keeps it in
// <data root>/runtime/popup-program/<first 12 hex of the zip's SHA-256>/. In-app patches can't
// carry programs; this is how the pop-up still arrives with a patch. The copy from an
// older version keeps working until the new one is in place.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";

// What the zip holds, and what a folder needs to run the window.
export const POPUP_FILES = Object.freeze([
  "LVL-Popup.exe", "Microsoft.Web.WebView2.Core.dll", "Microsoft.Web.WebView2.WinForms.dll",
  "WebView2Loader.dll", "WEBVIEW2-LICENSE.txt", "WEBVIEW2-NOTICE.txt",
]);
const RUNNABLE = POPUP_FILES.filter((name) => /\.(?:exe|dll)$/.test(name));
export const RELEASE_DOWNLOADS = "https://github.com/Flegrear/LVL/releases/download";
// Reuse this published program across app updates; those releases contain only patches.
export const POPUP_RELEASE_VERSION = "0.2.2";
const MAX_ZIP_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
// After a failed download, the next try waits this long (LVL restarts try at once).
const RETRY_MS = 60 * 60_000;
const VERSION = /^\d+\.\d+\.\d+$/;

export const popupAssetName = (version) => `LVL-Popup-v${version}.zip`;
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const runnable = (dir) => Boolean(dir) && RUNNABLE.every((name) => fs.existsSync(path.join(dir, name)));

// Downloads come from LVL's GitHub releases; tests may point at a server on this PC.
export function releaseBase(env = process.env) {
  const override = String(env.LVL_POPUP_RELEASE_BASE || "").replace(/\/+$/, "");
  return /^http:\/\/127\.0\.0\.1:\d{2,5}(?:\/[\w.-]+)*$/.test(override) ? override : RELEASE_DOWNLOADS;
}

async function readLimited(response, limit) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw new Error(`The download is too large (${declared} bytes)`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error("The download is too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// root: LVL's folder; installed: an installed copy (installed-app.json), which downloads.
export function createPopupProgram({ root = "", dataRoot, programVersion = POPUP_RELEASE_VERSION, installed = false, env = process.env,
  fetchImpl = fetch, now = Date.now, log = console, platform = process.platform } = {}) {
  const version = programVersion;
  // runtime/popup is the window's own browser profile (server.js); programs live next to it.
  const store = path.join(dataRoot, "runtime", "popup-program");
  const pointer = path.join(store, "current.json");
  let current = null;
  let downloading = null;
  let lastError = "";
  let failedAt = 0;

  // A development build: LVL_POPUP_HOME, or build/popup in a source checkout.
  const built = () => [env.LVL_POPUP_HOME, root && path.join(root, "build", "popup")].filter(Boolean).find(runnable) || null;

  function readPointer() {
    try {
      const saved = JSON.parse(fs.readFileSync(pointer, "utf8"));
      if (!/^[0-9a-f]{64}$/.test(saved?.sha256) || !VERSION.test(saved?.version) || !/^[0-9a-f]{64}$/.test(saved?.exe)) return null;
      return { ...saved, dir: path.join(store, saved.sha256.slice(0, 12)), checked: false };
    } catch { return null; }
  }

  // The downloaded copy, when it is complete and its program is the one that was checked.
  function downloaded() {
    const saved = current || (current = readPointer());
    if (!saved || !runnable(saved.dir)) { current = null; return null; }
    if (!saved.checked) {
      try { saved.checked = sha256(fs.readFileSync(path.join(saved.dir, "LVL-Popup.exe"))) === saved.exe; } catch { saved.checked = false; }
      if (!saved.checked) { current = null; return null; }
    }
    return saved;
  }

  function home() {
    if (platform !== "win32") return null;
    return built() || downloaded()?.dir || null;
  }

  async function download() {
    const name = popupAssetName(version);
    const base = `${releaseBase(env)}/v${version}`;
    const get = async (file, limit) => {
      const response = await fetchImpl(`${base}/${file}`, { signal: AbortSignal.timeout(60_000), redirect: "follow" });
      if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
      return readLimited(response, limit);
    };
    const expected = String(await get(`${name}.sha256`, 1024)).trim().split(/\s+/)[0].toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error("The pop-up player's checksum file is malformed");
    const bytes = await get(name, MAX_ZIP_BYTES);
    const actual = sha256(bytes);
    if (actual !== expected) throw new Error(`The pop-up player download failed its SHA-256 check (got ${actual})`);
    const entries = new AdmZip(bytes).getEntries();
    const names = entries.map((entry) => entry.entryName).sort();
    // Exactly the known file names, no folders: nothing can be written anywhere else.
    if (entries.some((entry) => entry.isDirectory) || names.join("\n") !== [...POPUP_FILES].sort().join("\n"))
      throw new Error(`The pop-up player download has unexpected files: ${names.join(", ").slice(0, 200)}`);
    const dir = path.join(store, actual.slice(0, 12));
    const part = `${dir}.part`;
    fs.rmSync(part, { recursive: true, force: true });
    fs.mkdirSync(part, { recursive: true });
    for (const entry of entries) {
      const data = entry.getData();
      if (data.length > MAX_FILE_BYTES) throw new Error(`${entry.entryName} in the pop-up player download is too large`);
      fs.writeFileSync(path.join(part, entry.entryName), data);
    }
    let kept = false;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { kept = runnable(dir); if (!kept) throw new Error("The old pop-up player files are in use"); }
    if (kept) fs.rmSync(part, { recursive: true, force: true });
    else fs.renameSync(part, dir);
    const saved = { version, sha256: actual, exe: sha256(fs.readFileSync(path.join(dir, "LVL-Popup.exe"))), installedAt: now() };
    fs.writeFileSync(`${pointer}.part`, JSON.stringify(saved));
    fs.renameSync(`${pointer}.part`, pointer);
    current = { ...saved, dir, checked: true };
    // Copies from earlier versions; one still running is removed next time.
    for (const other of fs.readdirSync(store, { withFileTypes: true })) {
      if (!other.isDirectory() || other.name === path.basename(dir)) continue;
      try { fs.rmSync(path.join(store, other.name), { recursive: true, force: true }); } catch {}
    }
    log.info?.(`Pop-up player ${version} downloaded and checked`);
    return current;
  }

  // Makes sure the pinned program is here (installed copies download it once).
  async function ensure() {
    if (!installed || platform !== "win32" || !VERSION.test(String(version)) || built()) return home();
    const have = downloaded();
    if (have?.version === version) return have.dir;
    if (!downloading) {
      if (failedAt && now() - failedAt < RETRY_MS) return have?.dir || null;
      fs.mkdirSync(store, { recursive: true });
      downloading = download().then((saved) => { lastError = ""; failedAt = 0; return saved.dir; })
        .catch((error) => {
          lastError = String(error.message || error).slice(0, 300);
          failedAt = now();
          log.warn?.("Pop-up player download:", lastError);
          return downloaded()?.dir || null;
        })
        .finally(() => { downloading = null; });
    }
    return downloading;
  }

  return {
    home, ensure,
    status: () => ({ downloading: Boolean(downloading), version: downloaded()?.version || (built() ? "source" : null), lastError }),
  };
}
