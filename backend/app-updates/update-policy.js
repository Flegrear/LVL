// When installed LVL updates, and how far a download has got.
//
// The Windows launcher finds, downloads, verifies and installs updates. On its
// own it installs as soon as an automatic check finds one, which closes LVL in
// the middle of a video. So the server keeps the automatic preference itself,
// leaves the launcher's own automatic mode off, and asks it to install only
// when no video has been open for a while. Native status supplies the exact
// verified release asset and bytes of its own download attempt for the UI.
//
// LVL's Android app answers the same requests. It reports its own download
// progress (download) and update size (availableSize), and autoInstall: false
// for a new app version, which Android asks the user to confirm.
import fs from "node:fs";
import path from "node:path";

const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
// Keep the persisted automatic-update preference on the supported daily
// discovery cadence. A browser notification refresh is not permission to
// change the native launcher's one-day check policy.
export const CHECK_INTERVAL_MS = 24 * 60 * 60_000;
export const IDLE_BEFORE_INSTALL_MS = 2 * 60_000;
// After a failed automatic install, wait this long before trying the same version again.
export const AUTO_RETRY_MS = 6 * 60 * 60_000;
const INSTALL_START_LIMIT_MS = 3 * 60_000;
const APK_PENDING_PHASES = new Set(["created", "committing", "awaiting-confirmation", "reported-success"]);
const APK_TERMINAL_PHASES = new Set(["cancelled", "failed", "unknown"]);

// Only the native updater knows which asset and verified release manifest were
// selected. Semantic app versions do not identify GitHub release tags/assets.
// A new digest for the same app version is immediately a different asset.
const PUBLIC_SHA = /^[a-f0-9]{64}$/;
const PUBLIC_TAG = /^(?:v\d+\.\d+\.\d+|release-\d{4}-\d{2}-\d{2}\.[1-9]\d*)$/;
const PUBLIC_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
function verifiedAsset(native) {
  const asset = native?.availableAsset;
  if (!asset || (asset.version && asset.version !== native?.availableVersion)
      || !PUBLIC_TAG.test(String(asset.releaseTag || ""))
      || !PUBLIC_NAME.test(String(asset.assetName || ""))
      || !PUBLIC_SHA.test(String(asset.sha256 || ""))
      || asset.identity !== `sha256:${asset.sha256}`
      || !Number.isSafeInteger(asset.size) || asset.size <= 0
      || !["patch", "installer"].includes(asset.kind)) return null;
  return { releaseTag: asset.releaseTag, assetName: asset.assetName,
    sha256: asset.sha256, size: asset.size, kind: asset.kind, identity: asset.identity };
}

const publicAttempt = (native) => /^[a-zA-Z0-9_-]{8,100}$/.test(String(native?.attemptId || ""))
  ? native.attemptId : null;

export function createUpdatePolicy({
  request,                       // (action, fields) => launcher status; rejects on errors
  prefsFile,                     // JSON file holding { automatic }
  isBusy = () => false,          // true while a video is open or converting
  patchCapable = () => true,     // the install can apply in-app patches
  now = Date.now,
  log = () => {},
  fsImpl = fs,
} = {}) {
  let persistedPreferenceError = null;
  let automatic = readPrefs();
  let download = null;           // { version, since } from install request to launch
  let launched = null;           // { version, at } the launcher started installing
  let failed = null;             // { version, error } the last install that failed
  let idleSince = null;
  let ticking = false;
  // Every explicit foreground change owns a newer intent than an outstanding
  // automatic tick. A late native reply must not undo a manual install/check or
  // reuse an idle interval from a previous automatic preference generation.
  let intentRevision = 0;
  const autoAttempts = new Map(); // verified asset identity (legacy: version) -> retry time
  // The native bridge acknowledges mutations before its separate work finishes.
  // Serialize installations, foreground preferences and discovery operations,
  // then re-read native status under the gate before Install. The idempotent
  // background safety write (automatic:false) deliberately does not occupy the
  // foreground gate: it cannot authorize an install and is always the same
  // value as a concurrent foreground settings write. Status remains independent.
  let mutationTail = Promise.resolve();
  function serializeMutation(operation) {
    const running = mutationTail.then(operation, operation);
    mutationTail = running.catch(() => {});
    return running;
  }
  const retryKey = (native) => verifiedAsset(native)?.identity || `legacy:${native?.availableVersion || ""}`;
  function recordAutoAttempt(native) {
    const key = retryKey(native);
    autoAttempts.delete(key);
    autoAttempts.set(key, now());
    // An update policy can stay alive for months; the retry history is bounded.
    if (autoAttempts.size > 64) autoAttempts.delete(autoAttempts.keys().next().value);
  }

  function readPrefs() {
    try {
      const value = JSON.parse(fsImpl.readFileSync(prefsFile, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)
          || typeof value.automatic !== "boolean"
          || (value.intervalDays !== undefined && value.intervalDays !== 1)
          || Object.keys(value).some(key => key !== "automatic" && key !== "intervalDays")) {
        persistedPreferenceError = "Saved update settings use unsupported values. Choose a supported daily automatic or manual setting.";
        return false; // Conservative until user explicitly resolves the preference.
      }
      return value.automatic;
    } catch (error) {
      if (error?.code === "ENOENT") return null; // Actual first run: default below.
      persistedPreferenceError = "Saved update settings could not be read. Automatic discovery is paused until the preference is confirmed.";
      return false;
    }
  }
  function savePrefs() {
    try {
      fsImpl.mkdirSync(path.dirname(prefsFile), { recursive: true });
      const temp = `${prefsFile}.${process.pid}.tmp`;
      fsImpl.writeFileSync(temp, JSON.stringify({ automatic }));
      fsImpl.renameSync(temp, prefsFile);
    } catch (error) {
      log(`Could not save update preferences: ${error.message}`);
      throw Object.assign(new Error("Could not persist update preferences"), { statusCode: 503 });
    }
  }

  // Android journals its PackageInstaller attempt before handing off the APK.
  // It can outlive the server and the release feed, so the journal itself is
  // authoritative when there is no available version to compare against.
  // When another version is available, an older journal must not own its card.
  function matchingApkInstall(native) {
    const attempt = native?.apkInstall;
    if (!native?.installed || !attempt || typeof attempt !== "object" || native.autoInstall === true) return null;
    if (!VERSION.test(String(attempt.version || "")) || !Number.isInteger(attempt.sessionId) || attempt.sessionId < 0) return null;
    if (native.availableVersion && native.availableVersion !== attempt.version) return null;
    if (native.available && native.autoInstall !== false) return null;
    if (native.availableSize && native.availableSize.kind !== "installer") return null;
    // A previous failed journal must not take ownership of a newer retry
    // while the new APK is still downloading or fails before PackageInstaller.
    if (publicAttempt(native) && attempt.attemptId && attempt.attemptId !== native.attemptId) return null;
    return attempt;
  }

  // Remember transitions the window may poll too slowly to see.
  function observe(native) {
    if (native?.availableVersion && download && download.version !== native.availableVersion) download = null;
    if (native?.autoInstall === false ||
        (native?.availableVersion && launched && launched.version !== native.availableVersion)) launched = null;
    if (failed?.attemptId && publicAttempt(native) && failed.attemptId !== publicAttempt(native)) failed = null;

    const apk = matchingApkInstall(native);
    if (apk) {
      download = null;
      launched = null;
      // A new journal (including a fresh retry of the same version) supersedes
      // any old browser-observed error. Terminal outcomes remain durable in it.
      failed = null;
      return;
    }
    // Verification and storage failures can happen before PackageInstaller
    // creates its journal, and a browser may miss the entire download.
    // Never attribute an older, unrelated journal's error to a newer version.
    const newerOwnedAttempt = publicAttempt(native) && native?.apkInstall?.attemptId
      && native.apkInstall.attemptId !== native.attemptId;
    if (native?.autoInstall === false && (!native.apkInstall || newerOwnedAttempt)
        && !native.downloading && native.error && native.availableVersion) {
      failed = { version: native.availableVersion, error: String(native.error), attemptId: publicAttempt(native) };
      download = null;
      launched = null;
      return;
    }
    if (native?.downloading) {
      if (!download) download = { version: native.availableVersion, since: now(), android: native.autoInstall === false };
      return;
    }
    if (download) {
      if (native?.error) failed = { version: download.version, error: String(native.error), attemptId: publicAttempt(native) };
      else if (!download.android && native?.autoInstall !== false) launched = { version: download.version, at: now() };
      download = null;
    }
    // The native bridge reports a bounded attempt/version-matched failure
    // after Setup exits. Show its stage instead of overwriting it with the
    // three-minute generic watchdog; never treat a receipt as install success.
    if (native?.autoInstall !== false && !native?.downloading
        && native?.availableVersion && publicAttempt(native)
        && typeof native.error === "string"
        && native.error.startsWith("Verified Setup failed at ")) {
      failed = { version: native.availableVersion, error: native.error,
        attemptId: publicAttempt(native) };
      download = null;
      launched = null;
      return;
    }
    // The timeout is an explicit observation of the same clock/native state,
    // never a side effect of deriving a phase for presentation. An actually
    // live native installer must not be declared never-started by this timer.
    if (launched && !native?.installing && now() - launched.at > INSTALL_START_LIMIT_MS) {
      failed = { version: launched.version, error: "The update didn't start installing.", attemptId: publicAttempt(native) };
      launched = null;
    }
  }

  function phase(native) {
    if (!native?.installed) return { name: "idle" };
    if (native.downloading) return { name: "downloading", version: native.availableVersion };
    const apk = matchingApkInstall(native);
    if (apk) {
      if (APK_PENDING_PHASES.has(apk.phase)) return {
        name: "installing", version: apk.version,
        pendingConfirmation: apk.phase === "awaiting-confirmation" && apk.pendingConfirmation === true,
      };
      if (APK_TERMINAL_PHASES.has(apk.phase)) return {
        name: "failed", version: apk.version,
        error: apk.message || native.error || "Android couldn't confirm this update",
      };
    }
    if (launched) return { name: "installing", version: launched.version };
    if (failed && failed.version === native.availableVersion) return { name: "failed", version: failed.version, error: failed.error };
    if (native.available && native.availableVersion) return { name: "ready", version: native.availableVersion };
    return { name: "idle" };
  }

  function progress(native) {
    if (!native?.downloading) return null;
    const reported = native.download;
    const owned = publicAttempt(native);
    const asset = verifiedAsset(native);
    // Windows bytes must have a native public owner. Older Android bridges can
    // still display bytes without presenting an unverified percentage.
    if (!owned && native.autoInstall !== false) return { bytes: 0, total: null, kind: null };
    if (!reported || typeof reported !== "object"
        || (owned && reported.attemptId !== owned)
        || (asset && reported.assetIdentity && reported.assetIdentity !== asset.identity)
        || !Number.isSafeInteger(reported.bytes) || reported.bytes < 0
        || !["patch", "installer"].includes(reported.kind)) return { bytes: 0, total: null, kind: null };
    // Some older native Android bridges have a direct owned download counter
    // but no manifest identity. Their total is deliberately indeterminate.
    const total = owned && asset && reported.assetIdentity === asset.identity
      && reported.kind === asset.kind ? asset.size : null;
    return { bytes: reported.bytes, total, kind: reported.kind };
  }

  // The size of the update that Install would download, once known.
  function readySize(native) {
    const asset = verifiedAsset(native);
    if (asset && (asset.kind !== "patch" || patchCapable())) return { bytes: asset.size, kind: asset.kind };
    // Preserve pre-identity Android's installer presentation without guessing
    // any release tag; Windows legacy has no such native size field.
    if (native?.autoInstall === false && Number.isSafeInteger(native?.availableSize?.bytes)
        && native.availableSize.bytes > 0 && native.availableSize.kind === "installer")
      return { bytes: native.availableSize.bytes, kind: "installer" };
    return null;
  }

  function present(native) {
    const current = phase(native);
    return {
      ...native,
      automatic: automatic ?? Boolean(native?.automatic),
      preferencesError: persistedPreferenceError,
      update: {
        phase: current.name,
        version: current.version || native?.availableVersion || null,
        attemptId: publicAttempt(native) || (matchingApkInstall(native)?.attemptId ?? null),
        asset: verifiedAsset(native),
        progress: current.name === "downloading" ? progress(native) : null,
        size: current.name === "ready" ? readySize(native) : null,
        error: current.name === "failed" ? current.error : null,
        pendingConfirmation: Boolean(current.pendingConfirmation),
        installsWhenIdle: Boolean(automatic) && current.name === "ready" && native?.autoInstall !== false,
      },
    };
  }

  async function status() {
    const native = await request("status");
    observe(native);
    return present(native);
  }

  async function install({ auto = false, revision = null } = {}) {
    if (!auto) intentRevision += 1;
    return serializeMutation(async () => {
      // Another manual request, background tick or settings/check operation
      // may have completed while this call waited for the mutation gate.
      let native = await request("status");
      if (auto && revision !== intentRevision) return present(native);
      observe(native);
      if (native.downloading || native.installing || download || launched) return present(native);
      if (native.checking) return present(native);
      if (auto && (revision !== intentRevision || !automatic || isBusy() || idleSince === null ||
          now() - idleSince < IDLE_BEFORE_INSTALL_MS || native.autoInstall === false))
        return present(native);
      if (!native.available || !native.availableVersion) return present(native);
      native = await request("install");
      // A reply without downloading/installing confirmation must not manufacture
      // a download phase. Native may also report a synchronous failure.
      if (native.downloading) {
        download = { version: native.availableVersion, since: now(), android: native.autoInstall === false };
        launched = null;
        failed = null;
      } else if (native.installing) {
        download = null;
        launched = native.autoInstall === false ? null : { version: native.availableVersion, at: now() };
        failed = null;
      } else if (native.error && native.availableVersion) {
        download = null;
        launched = null;
        failed = { version: native.availableVersion, error: String(native.error), attemptId: publicAttempt(native) };
      }
      observe(native);
      if (auto && (native.downloading || native.installing)) recordAutoAttempt(native);
      return present(native);
    });
  }

  async function setAutomatic(value) {
    // The native bridge and browser may have different generations. Never
    // silently coerce a requested manual/automatic preference to a boolean.
    if (typeof value !== "boolean")
      throw Object.assign(new Error("automatic must be true or false"), { statusCode: 400 });
    const desired = value;
    const previous = automatic;
    if (automatic !== desired) idleSince = null;
    automatic = desired;
    const revision = ++intentRevision;
    try { savePrefs(); }
    catch (error) { automatic = previous; throw error; }
    persistedPreferenceError = null;
    // Never let the launcher install on its own: it doesn't know whether a video is open.
    return serializeMutation(async () => {
      let native = await request("settings", { automatic: false, intervalDays: 1 });
      if (revision !== intentRevision) return present(native);
      observe(native);
      if (automatic && !native.checking && !native.downloading && !native.installing) {
        native = await request("check", { apply: false });
        if (revision === intentRevision) observe(native);
      }
      return present(native);
    });
  }

  async function check(apply) {
    intentRevision += 1;
    return serializeMutation(async () => {
      // Discovery never delegates installation to the launcher. Explicit
      // installs go through the shared gate and the idle policy.
      const native = await request("check", { apply: false });
      observe(native);
      return present(native);
    });
  }

  async function handle(action, fields = {}) {
    if (action === "status") return status();
    if (action === "settings") {
      if (!fields || typeof fields !== "object" || Array.isArray(fields)
          || typeof fields.automatic !== "boolean"
          || (fields.intervalDays !== undefined && fields.intervalDays !== 1)
          || Object.keys(fields).some(key => key !== "automatic" && key !== "intervalDays"))
        throw Object.assign(new Error("Only an explicit automatic preference and daily interval are supported"), { statusCode: 400 });
      return setAutomatic(fields.automatic);
    }
    if (action === "check") return check(fields.apply);
    if (action === "install") return install();
    throw Object.assign(new Error("Unknown updater action"), { statusCode: 400 });
  }

  // Runs every 30 s: moves the automatic preference over from the launcher,
  // checks once per day, and installs when no video has been open for 2 minutes.
  function refreshIdle() {
    if (isBusy()) idleSince = null;
    else if (idleSince === null) idleSince = now();
  }
  async function tick() {
    if (ticking) return;
    ticking = true;
    const revision = intentRevision;
    try {
      refreshIdle();
      let native;
      try { native = await request("status"); }
      finally { refreshIdle(); }
      if (revision !== intentRevision) return;
      observe(native);
      if (automatic === null) {
        // Missing or unrecognized persisted settings use the documented daily
        // automatic default. Native automatic is deliberately disabled below
        // because it cannot honor the server's video-idle protection.
        automatic = true;
        savePrefs();
      }
      if (native.automatic) {
        // This is an idempotent safety override, not an Install or discovery
        // operation: every caller sets the launcher to *false*. It must not
        // monopolize the serialized foreground mutation gate while the native
        // bridge waits, or a user disabling automatic updates cannot return.
        // A concurrent foreground settings request makes the same safe write.
        try {
          native = await request("settings", { automatic: false, intervalDays: 1 });
          if (revision !== intentRevision) return;
          observe(native);
        }
        finally { refreshIdle(); }
      }
      if (revision !== intentRevision || !automatic ||
          native.checking || native.downloading || download || launched) return;
      const lastChecked = Date.parse(native.lastCheckedAt || "") || 0;
      if (now() - lastChecked >= CHECK_INTERVAL_MS) {
        try {
          const checked = await serializeMutation(async () => {
            if (revision !== intentRevision || !automatic) return null;
            return request("check", { apply: false });
          });
          if (checked && revision === intentRevision) observe(checked);
        }
        finally { refreshIdle(); }
        return;
      }
      const version = String(native.availableVersion || "");
      if (!native.available || !version || idleSince === null || now() - idleSince < IDLE_BEFORE_INSTALL_MS) return;
      // A new Android app version asks the user to confirm, so it waits for Install.
      if (native.autoInstall === false) return;
      if (now() - (autoAttempts.get(retryKey(native)) || 0) < AUTO_RETRY_MS) return;
      refreshIdle();
      if (revision !== intentRevision || idleSince === null ||
          now() - idleSince < IDLE_BEFORE_INSTALL_MS) return;
      log(`Installing LVL ${version} automatically (no video open)`);
      await install({ auto: true, revision });
    } catch (error) {
      log(`Automatic update step skipped: ${error.message}`);
    } finally {
      ticking = false;
    }
  }

  return { handle, status, install, setAutomatic, check, tick, get automatic() { return automatic; } };
}
