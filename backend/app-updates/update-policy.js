// When installed LVL updates, and how far a download has got.
//
// The Windows launcher finds, downloads, verifies and installs updates. On its
// own it installs as soon as an automatic check finds one, which closes LVL in
// the middle of a video. So the server keeps the automatic preference itself,
// leaves the launcher's own automatic mode off, and asks it to install only
// when no video has been open for a while. It also reads the size of the file
// the launcher is downloading, so the window can show a progress bar.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
// The launcher downloads into %TEMP%\LVL-update-<Guid "N">\<asset name>.
const DOWNLOAD_FOLDER = /^LVL-update-[0-9a-f]{32}$/;
const RELEASE_API = "https://api.github.com/repos/Flegrear/LVL/releases/tags/v";
const MAX_RELEASE_JSON = 512 * 1024;
const DAY_MS = 24 * 60 * 60_000;
export const IDLE_BEFORE_INSTALL_MS = 2 * 60_000;
// After a failed automatic install, wait this long before trying the same version again.
export const AUTO_RETRY_MS = 6 * 60 * 60_000;
const SIZE_RETRY_MS = 5 * 60_000;
const INSTALL_START_LIMIT_MS = 3 * 60_000;

export const updateAssetName = (version, patch) => patch ? `LVL-update-v${version}.zip` : "LVL-Setup.exe";

// The newest download of `version` the launcher is writing. Read-only: exact
// folder and file names only, never links, nothing older than `since`.
export function findDownload(tempDirs, version, { since = 0, fsImpl = fs } = {}) {
  if (!VERSION.test(String(version || ""))) return null;
  let best = null;
  for (const dir of new Set(tempDirs.filter(Boolean).map((item) => path.resolve(item)))) {
    let names;
    try { names = fsImpl.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!DOWNLOAD_FOLDER.test(name)) continue;
      const folder = path.join(dir, name);
      let info;
      try { info = fsImpl.lstatSync(folder); } catch { continue; }
      if (!info.isDirectory() || info.isSymbolicLink() || info.mtimeMs < since) continue;
      for (const patch of [true, false]) {
        const asset = updateAssetName(version, patch);
        let file;
        try { file = fsImpl.lstatSync(path.join(folder, asset)); } catch { continue; }
        if (!file.isFile() || file.isSymbolicLink()) continue;
        if (!best || file.mtimeMs > best.mtimeMs) best = { asset, patch, bytes: file.size, mtimeMs: file.mtimeMs };
      }
    }
  }
  return best;
}

// Asset sizes of one GitHub release, by asset name.
export async function fetchReleaseAssets(version, { fetchImpl = fetch, timeoutMs = 12_000 } = {}) {
  if (!VERSION.test(String(version || ""))) throw new Error("Invalid version");
  const response = await fetchImpl(RELEASE_API + version, {
    headers: { accept: "application/vnd.github+json", "user-agent": "LVL" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Release lookup answered ${response.status}`);
  if (Number(response.headers?.get?.("content-length")) > MAX_RELEASE_JSON) throw new Error("Release details are too large");
  const text = await response.text();
  if (text.length > MAX_RELEASE_JSON) throw new Error("Release details are too large");
  const assets = JSON.parse(text)?.assets;
  const sizes = {};
  for (const asset of Array.isArray(assets) ? assets : []) {
    if (typeof asset?.name === "string" && Number.isSafeInteger(asset.size) && asset.size > 0) sizes[asset.name] = asset.size;
  }
  return sizes;
}

export function createUpdatePolicy({
  request,                       // (action, fields) => launcher status; rejects on errors
  prefsFile,                     // JSON file holding { automatic }
  isBusy = () => false,          // true while a video is open or converting
  patchCapable = () => true,     // the install can apply in-app patches
  tempDirs = [process.env.TMP, process.env.TEMP, os.tmpdir()],
  releaseAssets = fetchReleaseAssets,
  now = Date.now,
  log = () => {},
  fsImpl = fs,
} = {}) {
  let automatic = readPrefs();
  let download = null;           // { version, since } from install request to launch
  let launched = null;           // { version, at } the launcher started installing
  let failed = null;             // { version, error } the last install that failed
  let idleSince = null;
  let ticking = false;
  const autoAttempts = new Map(); // version -> time of the last automatic attempt
  const sizes = new Map();        // version -> { sizes, at } or { pending, at }

  function readPrefs() {
    try {
      const value = JSON.parse(fsImpl.readFileSync(prefsFile, "utf8"));
      return typeof value?.automatic === "boolean" ? value.automatic : null;
    } catch { return null; }
  }
  function savePrefs() {
    try {
      fsImpl.mkdirSync(path.dirname(prefsFile), { recursive: true });
      const temp = `${prefsFile}.${process.pid}.tmp`;
      fsImpl.writeFileSync(temp, JSON.stringify({ automatic }));
      fsImpl.renameSync(temp, prefsFile);
    } catch (error) { log(`Could not save update preferences: ${error.message}`); }
  }

  function sizeOf(version, asset) {
    if (!VERSION.test(String(version || ""))) return null;
    const known = sizes.get(version);
    if (known?.sizes) return known.sizes[asset] ?? null;
    if (known && now() - known.at < SIZE_RETRY_MS) return null;
    const entry = { pending: true, at: now() };
    sizes.set(version, entry);
    Promise.resolve().then(() => releaseAssets(version))
      .then((found) => { sizes.set(version, { sizes: found, at: now() }); })
      .catch((error) => { entry.pending = false; log(`Update size unavailable: ${error.message}`); });
    return null;
  }

  // Remember transitions the window may poll too slowly to see.
  function observe(native) {
    if (native?.downloading) {
      if (!download) download = { version: native.availableVersion, since: now() };
      return;
    }
    if (!download) return;
    if (native?.error) failed = { version: download.version, error: String(native.error) };
    else launched = { version: download.version, at: now() };
    download = null;
  }

  function phase(native) {
    if (!native?.installed) return "idle";
    if (native.downloading) return "downloading";
    // The launcher stops this server when the install starts. Still answering
    // minutes later means the install never got going.
    if (launched && now() - launched.at > INSTALL_START_LIMIT_MS) {
      failed = { version: launched.version, error: "The update didn't start installing." };
      launched = null;
    }
    if (launched) return "installing";
    if (failed && failed.version === native.availableVersion) return "failed";
    if (native.available && native.availableVersion) return "ready";
    return "idle";
  }

  function progress(native) {
    if (!native?.downloading) return null;
    const version = String(native.availableVersion || "");
    const file = findDownload(tempDirs, version, { since: (download?.since ?? now() - 60 * 60_000) - 60_000, fsImpl });
    if (!file) return { bytes: 0, total: null, kind: null };
    return { bytes: file.bytes, total: sizeOf(version, file.asset), kind: file.patch ? "patch" : "installer" };
  }

  // The size of the update that Install would download, once known.
  function readySize(native) {
    const version = String(native?.availableVersion || "");
    const patchSize = patchCapable() ? sizeOf(version, updateAssetName(version, true)) : null;
    if (patchSize) return { bytes: patchSize, kind: "patch" };
    const known = sizes.get(version)?.sizes;
    if (!known) return null;
    const full = known[updateAssetName(version, false)];
    return full ? { bytes: full, kind: "installer" } : null;
  }

  function present(native) {
    const current = phase(native);
    return {
      ...native,
      automatic: automatic ?? Boolean(native?.automatic),
      update: {
        phase: current,
        version: current === "installing" ? launched.version : native?.availableVersion || null,
        progress: current === "downloading" ? progress(native) : null,
        size: current === "ready" ? readySize(native) : null,
        error: current === "failed" ? failed.error : null,
        installsWhenIdle: Boolean(automatic) && current === "ready",
      },
    };
  }

  async function status() {
    const native = await request("status");
    observe(native);
    return present(native);
  }

  async function install({ auto = false } = {}) {
    const native = await request("install");
    download = { version: native.availableVersion, since: now() };
    launched = null;
    failed = null;
    if (auto) autoAttempts.set(String(native.availableVersion), now());
    return present(native);
  }

  async function setAutomatic(value) {
    automatic = Boolean(value);
    savePrefs();
    // Never let the launcher install on its own: it doesn't know whether a video is open.
    let native = await request("settings", { automatic: false, intervalDays: 1 });
    if (automatic && !native.checking && !native.downloading) native = await request("check", { apply: false });
    return present(native);
  }

  async function check(apply) {
    const native = await request("check", { apply: Boolean(apply) });
    observe(native);
    return present(native);
  }

  async function handle(action, fields = {}) {
    if (action === "status") return status();
    if (action === "settings") return setAutomatic(fields.automatic);
    if (action === "check") return check(fields.apply);
    if (action === "install") return install();
    throw Object.assign(new Error("Unknown updater action"), { statusCode: 400 });
  }

  // Runs every 30 s: moves the automatic preference over from the launcher,
  // checks once a day, and installs when no video has been open for 2 minutes.
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      if (isBusy()) idleSince = null;
      else if (idleSince === null) idleSince = now();
      let native = await request("status");
      observe(native);
      if (automatic === null) {
        automatic = Boolean(native.automatic);
        savePrefs();
      }
      if (native.automatic) native = await request("settings", { automatic: false, intervalDays: 1 });
      if (!automatic || native.checking || native.downloading || download || launched) return;
      const lastChecked = Date.parse(native.lastCheckedAt || "") || 0;
      if (now() - lastChecked >= DAY_MS) {
        await request("check", { apply: false });
        return;
      }
      const version = String(native.availableVersion || "");
      if (!native.available || !version || idleSince === null || now() - idleSince < IDLE_BEFORE_INSTALL_MS) return;
      if (now() - (autoAttempts.get(version) || 0) < AUTO_RETRY_MS) return;
      log(`Installing LVL ${version} automatically (no video open)`);
      await install({ auto: true });
    } catch (error) {
      log(`Automatic update step skipped: ${error.message}`);
    } finally {
      ticking = false;
    }
  }

  return { handle, status, install, setAutomatic, check, tick, get automatic() { return automatic; } };
}
