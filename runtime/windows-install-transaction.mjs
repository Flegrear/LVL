/**
 * Installed, offline Windows target lease and full-installer recovery worker.
 * The lease is outside the app tree, so replacing runtime/ or LVL.exe cannot
 * free a target while a detached installer is still using it.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const LEASE_FORMAT = "lvl-windows-install-owner-v1";
const FULL_FORMAT = "lvl-windows-full-transaction-v1";
const FULL_TX = ".lvl-full-transaction";
const VERSION = /^(?:0|[1-9]\d{0,3})\.(?:0|[1-9]\d{0,3})\.(?:0|[1-9]\d{0,3})$/;
const TOKEN = /^[0-9a-f]{32}$/i;
const NATIVE_PROOF_FORMAT = "lvl-windows-process-proof-v1";
const OS_BIRTH_TICKS = /^\d{15,20}$/;
const STALE_GRACE_MS = 15_000;
const REQUIRED_STAGE = ["LVL.exe", "installed-app.json", "package.json", "server.js",
  "app.js", "index.html", "runtime/node.exe", "runtime/update-apply.mjs",
  "runtime/windows-install-transaction.mjs"];
const MANAGED = ["LVL.exe", "installed-app.json", "package.json", "server.js",
  "app.js", "index.html", "CHANGELOG.md", "THIRD_PARTY_NOTICES.txt",
  "assets", "backend", "frontend", "shared", "node_modules", "runtime",
  "ext-runner", "learning", "tests", "devtools", "docs"];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function reject(message) { throw new Error("LVL installation: " + message); }
function sha(input) { return createHash("sha256").update(input).digest("hex"); }
function safeRoot(value, create = false) {
  if (typeof value !== "string" || !path.isAbsolute(value)) reject("absolute target required");
  const root = path.resolve(value);
  if (create && !fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
  const stat = fs.lstatSync(root, { throwIfNoEntry: false });
  if (!stat?.isDirectory() || stat.isSymbolicLink()) reject("target is not an ordinary directory");
  return root;
}
function hasMatchingLease(root, token) {
  const owner = leaseOwner(root);
  return owner && !owner.initializing && owner.token === token;
}
export function canonicalInstallTarget(value) {
  if (typeof value !== "string" || !path.isAbsolute(value))
    reject("canonical target requires an absolute path");
  let cursor = path.resolve(value), missing = [];
  // Resolve the physical EXISTING ancestor. A junction on any parent changes
  // the physical installation even if its final child doesn't yet exist.
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) reject("cannot resolve installation parent");
    missing.unshift(path.basename(cursor));
    cursor = parent;
  }
  const physical = fs.realpathSync.native(cursor);
  const resolved = path.resolve(physical, ...missing);
  return process.platform === "win32"
    ? resolved.replace(/[\\/]+$/, "").toLowerCase()
    : resolved.replace(/\/$/, "");
}
export function installLeasePath(value) {
  const canonical = canonicalInstallTarget(value);
  const key = sha(canonical).slice(0, 32);
  return path.join(path.dirname(canonical), ".lvl-install-" + key + ".lock");
}
function atomicJson(filename, content) {
  const temp = filename + "." + randomUUID().replaceAll("-", "") + ".new";
  const fd = fs.openSync(temp, "wx", 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(content) + "\n");
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  try { fs.renameSync(temp, filename); }
  catch (error) { try { fs.unlinkSync(temp); } catch {} throw error; }
}
function readJson(filename) {
  const stat = fs.lstatSync(filename, { throwIfNoEntry: false });
  if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) reject("unsafe or missing journal");
  return JSON.parse(fs.readFileSync(filename, "utf8"));
}
function leaseOwner(root) {
  const dir = installLeasePath(root);
  if (!fs.existsSync(dir)) return null;
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) reject("unsafe target lease");
  try {
    const owner = readJson(path.join(dir, "owner.json"));
    if (owner.format !== LEASE_FORMAT || owner.target !== canonicalInstallTarget(root)
        || !TOKEN.test(owner.token) || !Number.isInteger(owner.pid) || owner.pid <= 0
        || !OS_BIRTH_TICKS.test(owner.startTicks)
        || (owner.executablePath !== undefined
          && (typeof owner.executablePath !== "string" || !path.isAbsolute(owner.executablePath)
            || owner.executablePath !== canonicalInstallTarget(owner.executablePath))))
      reject("invalid target lease");
    return owner;
  } catch (error) {
    if (Date.now() - stat.birthtimeMs < STALE_GRACE_MS) return { initializing: true };
    throw error;
  }
}
// Inno extracts the very same packaged launcher as a private temporary proof
// candidate before it has extracted root/LVL.exe. The issuer supplies the
// SHA-256 of those embedded bytes. This verifier binds candidate to the same
// temporary directory as the packaged Node helper/script, not any caller-
// selected copied executable. It never trusts a missing/redirected candidate.
export function verifySetupBootstrap(image, digest, scriptFile = fileURLToPath(import.meta.url)) {
  if (process.platform !== "win32" || typeof image !== "string" || !path.isAbsolute(image)
      || !/^[a-f0-9]{64}$/.test(digest) || typeof scriptFile !== "string"
      || !path.isAbsolute(scriptFile)) return null;
  try {
    const scriptDir = path.dirname(scriptFile);
    const directory = fs.lstatSync(scriptDir);
    const script = fs.lstatSync(scriptFile);
    const candidate = fs.lstatSync(image);
    if (!directory.isDirectory() || directory.isSymbolicLink()
        || !script.isFile() || script.isSymbolicLink()
        || !candidate.isFile() || candidate.isSymbolicLink()
        || candidate.size < 16_384 || candidate.size > 32 * 1024 * 1024
        || path.basename(image).toLowerCase() !== "lvl.exe"
        || canonicalInstallTarget(image) !== canonicalInstallTarget(path.join(scriptDir, "LVL.exe"))
        || canonicalInstallTarget(path.dirname(image)) !== canonicalInstallTarget(scriptDir)
        || sha(fs.readFileSync(image)) !== digest) return null;
    return { helper: image, sha256: digest };
  } catch { return null; }
}

// An inspect plan is not a proof. The scriptFile seam is exclusively for
// deterministic planner tests; the real inspect runner below never forwards
// an externally selected scriptFile, and native C# must separately attest.
export function planNativeProcessInspection(pid, root, {
  bootstrap = null, scriptFile = fileURLToPath(import.meta.url),
} = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !root || !path.isAbsolute(root)
      || process.platform !== "win32") return null;
  try {
    // A truly fresh Inno target may not exist until the first extraction.
    // Canonicalize its existing ancestor, but do not create or mutate it just
    // to prove the setup parent before the installation lease is acquired.
    if (fs.existsSync(root)) safeRoot(root);
    const physicalRoot = canonicalInstallTarget(root);
    const approvedBootstrap = bootstrap
      ? verifySetupBootstrap(bootstrap.helper, bootstrap.sha256, scriptFile) : null;
    if (bootstrap && (!approvedBootstrap
        || canonicalInstallTarget(path.dirname(approvedBootstrap.helper)) === physicalRoot))
      return null;
    const helper = approvedBootstrap?.helper || path.join(root, "LVL.exe");
    const file = fs.lstatSync(helper, { throwIfNoEntry: false });
    if (!file?.isFile() || file.isSymbolicLink()
        || canonicalInstallTarget(helper) !== (approvedBootstrap
          ? canonicalInstallTarget(approvedBootstrap.helper)
          : canonicalInstallTarget(path.join(physicalRoot, "LVL.exe"))))
      return null;
    const argv = ["--inspect-process", "--pid", String(pid), "--app-root", physicalRoot];
    if (approvedBootstrap) argv.push("--bootstrap-image", approvedBootstrap.helper,
      "--bootstrap-sha256", approvedBootstrap.sha256);
    return { helper, argv, options: {
      cwd: approvedBootstrap ? path.dirname(helper) : physicalRoot,
      shell: false, windowsHide: true, timeout: 3500,
      encoding: "utf8", maxBuffer: 4096,
    } };
  } catch { return null; }
}

// Read-only process query. No shell, PID-name matching, guessed birth or new
// binary. undefined = ambiguous (keep lease); null = verified dead.
export function inspectNativeProcess(pid, root, { run = spawnSync, bootstrap = null } = {}) {
  try {
    const plan = planNativeProcessInspection(pid, root, { bootstrap });
    if (!plan) return undefined;
    const response = run(plan.helper, plan.argv, plan.options);
    if (response.error || response.status !== 0 || typeof response.stdout !== "string"
        || Buffer.byteLength(response.stdout) > 4096) return undefined;
    return parseNativeProcessProof(response.stdout, pid);
  } catch { return undefined; }
}

// The installer uses its already-reviewed temporary launcher to wait for the
// exact installed image and ext-runner executables to exit after the installed
// launcher's ordinary --quit request. This observer never kills a PID or uses
// process names, WMI, PowerShell, a shell, or another unreviewed binary.
export function awaitNativeInstalledStop(root, {
  bootstrap = null, run = spawnSync,
} = {}) {
  try {
    const plan = planNativeProcessInspection(process.pid, root, { bootstrap });
    if (!plan) return false;
    const argv = ["--await-stopped", "--app-root", plan.argv[4]];
    if (bootstrap) argv.push("--bootstrap-image", plan.helper,
      "--bootstrap-sha256", bootstrap.sha256);
    const result = run(plan.helper, argv, {
      ...plan.options, timeout: 35_000,
    });
    return !result.error && result.status === 0 && result.stdout === ""
      && (!result.stderr || result.stderr === "");
  } catch { return false; }
}

// Pure validation seam used by deterministic contract tests; it is not process
// observation and never grants authority without a real native CLI response.
export function parseNativeProcessProof(response, pid) {
  try {
    if (!Number.isSafeInteger(pid) || pid <= 0 || typeof response !== "string"
        || Buffer.byteLength(response) > 4096) return undefined;
    // The C# helper emits exactly one JSON line. No preface, blank records or
    // control characters may precede a process identity decision.
    const value = response.endsWith("\n") ? response.slice(0, -1) : response;
    if (!value || /[\r\n\0]/.test(value) || value !== value.trim()) return undefined;
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
        || parsed.format !== NATIVE_PROOF_FORMAT || parsed.pid !== pid
        || typeof parsed.alive !== "boolean") return undefined;
    if (!parsed.alive) {
      if (Object.keys(parsed).length !== 3) return undefined;
      return null;
    }
    if (Object.keys(parsed).length !== 5) return undefined;
    if (!OS_BIRTH_TICKS.test(parsed.startTicks)
        || BigInt(parsed.startTicks) > 3155378975999999999n
        || typeof parsed.executablePath !== "string"
        || !path.isAbsolute(parsed.executablePath)
        || parsed.executablePath.length > 2048
        || parsed.executablePath !== canonicalInstallTarget(parsed.executablePath))
      return undefined;
    return { pid, startTicks: parsed.startTicks, executablePath: parsed.executablePath };
  } catch { return undefined; }
}
function processTicks(pid, root) {
  const observed = inspectNativeProcess(pid, root);
  return observed === undefined ? undefined : observed === null ? null : observed.startTicks;
}
export function inspectInstallLease(root, { getTicks = processTicks, bootstrap = null } = {}) {
  const owner = leaseOwner(root);
  if (!owner) return { busy: false };
  if (owner.initializing) return { busy: true, initializing: true };
  const proof = getTicks === processTicks ? inspectNativeProcess(owner.pid, root, { bootstrap }) : undefined;
  const ticks = getTicks === processTicks
    ? (proof === undefined ? undefined : proof === null ? null : proof.startTicks)
    : getTicks(owner.pid);
  const imageMismatch = proof && owner.executablePath
    && proof.executablePath !== owner.executablePath;
  const unknown = ticks === undefined || Boolean(imageMismatch);
  return { busy: unknown || ticks === owner.startTicks,
    identityUnavailable: unknown, observedStartTicks: ticks ?? null,
    stale: !unknown && ticks !== owner.startTicks,
    phase: owner.phase, token: owner.token, owner };
}
function reclaimStaleLease(root, getTicks, bootstrap = null) {
  const leaseDir = installLeasePath(root), guard = leaseDir + ".reclaim";
  try { fs.mkdirSync(guard); } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
  try {
    const state = inspectInstallLease(root, { getTicks, bootstrap });
    if (!state.stale || !state.owner) return false;
    const retired = guard + "." + randomUUID().replaceAll("-", "") + ".old";
    fs.renameSync(leaseDir, retired);
    // Only the same former lease may be retired. If the contender race made
    // the directory change, restore it and fail closed.
    const moved = readJson(path.join(retired, "owner.json"));
    if (moved.token !== state.owner.token || moved.startTicks !== state.owner.startTicks
        || moved.executablePath !== state.owner.executablePath
        || moved.target !== state.owner.target || moved.pid !== state.owner.pid
        || moved.phase !== state.owner.phase || moved.version !== state.owner.version
        || moved.createdAt !== state.owner.createdAt) {
      fs.renameSync(retired, leaseDir);
      reject("target lease changed during stale reclamation");
    }
    fs.rmSync(retired, { recursive: true, force: true });
    return true;
  } finally { fs.rmSync(guard, { recursive: true, force: true }); }
}
export function acquireInstallLease(rootValue, {
  token = randomUUID().replaceAll("-", ""), pid = process.pid,
  startTicks = null, phase = "downloading", getTicks = processTicks, bootstrap = null,
} = {}) {
  const root = safeRoot(rootValue, true), dir = installLeasePath(root);
  const proof = getTicks === processTicks ? inspectNativeProcess(pid, root, { bootstrap }) : undefined;
  const birth = startTicks ?? (getTicks === processTicks
    ? proof?.startTicks : getTicks(pid));
  if (!TOKEN.test(token) || !OS_BIRTH_TICKS.test(String(birth || ""))
      || (getTicks === processTicks
        && (proof === undefined || proof === null || proof.startTicks !== String(birth))))
    reject("owner identity unavailable");
  for (let attempt = 0; attempt < 2; attempt++) {
    if (fs.existsSync(dir + ".reclaim")) reject("target lease reclamation is in progress");
    try { fs.mkdirSync(dir); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const state = inspectInstallLease(root, { getTicks, bootstrap });
      if (!state.stale || !reclaimStaleLease(root, getTicks, bootstrap))
        reject("another installation owns this target");
      continue;
    }
    try {
      if (fs.existsSync(dir + ".reclaim")) reject("target lease reclamation is in progress");
      const owner = { format: LEASE_FORMAT, target: canonicalInstallTarget(root),
        token, pid, startTicks: String(birth), phase, createdAt: new Date().toISOString() };
      if (proof?.executablePath) owner.executablePath = proof.executablePath;
      atomicJson(path.join(dir, "owner.json"), owner);
      return owner;
    } catch (error) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw error;
    }
  }
  reject("cannot acquire installation target");
}
export function updateInstallLease(root, token, changes) {
  const owner = leaseOwner(root);
  if (!owner || owner.initializing || owner.token !== token) reject("installation lease token does not match");
  const next = { ...owner, ...changes };
  if (next.token !== token || next.target !== canonicalInstallTarget(root))
    reject("cannot change installation identity");
  atomicJson(path.join(installLeasePath(root), "owner.json"), next);
  return next;
}
export function releaseInstallLease(root, token) {
  const owner = leaseOwner(root);
  if (!owner) return false;
  if (owner.initializing || owner.token !== token) reject("installation lease belongs to another attempt");
  fs.rmSync(installLeasePath(root), { recursive: true, force: true });
  return true;
}
export async function awaitInstallLease(root, token, {
  maxMs = 6000, requiredPhase = null, pause = sleep,
} = {}) {
  const end = Date.now() + maxMs;
  do {
    const owner = leaseOwner(root);
    if (owner && !owner.initializing && owner.token !== token)
      reject("target belongs to a different installation");
    // Installed 0.3.2 saves the same token in "downloading" BEFORE launching
    // Setup, then publishes "detached-child" only AFTER Process.Start returns.
    // Do not rebind while that older parent can still overwrite PID/birth/phase.
    if (owner && !owner.initializing && owner.token === token
        && (requiredPhase === null || owner.phase === requiredPhase)) return owner;
    await pause(30);
  } while (Date.now() < end);
  reject("detached installation ownership was not transferred");
}
function fullTx(root) { return path.join(root, FULL_TX); }
function filename(root, group, name) { return path.join(fullTx(root), group, name); }
function checkEntry(value) {
  const stat = fs.lstatSync(value, { throwIfNoEntry: false });
  if (!stat) return null;
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
    reject("reparse/special file in installation: " + value);
  return stat;
}
function entryDigest(value) {
  const stat = checkEntry(value);
  if (!stat) return null;
  const hash = createHash("sha256");
  if (stat.isFile()) {
    hash.update("F");
    const fd = fs.openSync(value, "r");
    try {
      const buf = Buffer.allocUnsafe(128 * 1024);
      let read;
      while ((read = fs.readSync(fd, buf, 0, buf.length, null)) > 0)
        hash.update(buf.subarray(0, read));
    } finally { fs.closeSync(fd); }
  } else {
    hash.update("D");
    for (const name of fs.readdirSync(value).sort()) {
      hash.update(name + "\0");
      hash.update(entryDigest(path.join(value, name)));
    }
  }
  return hash.digest("hex");
}
function fullJournal(root) {
  const record = readJson(filename(root, "", "journal.json"));
  if (record.format !== FULL_FORMAT || !TOKEN.test(record.token) || !VERSION.test(record.version)
      || !["preparing", "bootstrap-ready", "backing-up", "installing",
        "awaiting-restart", "acknowledged", "restoring", "rollback-ready", "rolled-back"].includes(record.state)
      || !Array.isArray(record.rows) || record.rows.length !== MANAGED.length) reject("bad full-install journal");
  // These are raw SHA-256 digests of the exact two staged recovery executables,
  // captured before the first mutation. Recovery must never accept a pair
  // without both expected immutable preparation identities.
  if (!record.recoveryPair || typeof record.recoveryPair !== "object"
      || Array.isArray(record.recoveryPair)
      || !/^[0-9a-f]{64}$/.test(record.recoveryPair.nodeSha256 ?? "")
      || !/^[0-9a-f]{64}$/.test(record.recoveryPair.helperSha256 ?? ""))
    reject("missing or invalid recovery bootstrap identity");
  for (let i = 0; i < MANAGED.length; i++) {
    const row = record.rows[i];
    if (row.name !== MANAGED[i] || (row.old !== null && !/^[0-9a-f]{64}$/.test(row.old))
        || (row.next !== null && !/^[0-9a-f]{64}$/.test(row.next)))
      reject("bad full-install recovery entry");
  }
  return record;
}
function verifyFullStage(root, version) {
  const pending = filename(root, "pending", "");
  if (!checkEntry(pending)?.isDirectory()) reject("full setup staging is missing");
  for (const required of REQUIRED_STAGE) {
    if (!checkEntry(path.join(pending, required))?.isFile())
      reject("full setup staging misses " + required);
  }
  const marker = readJson(path.join(pending, "installed-app.json"));
  const pkg = readJson(path.join(pending, "package.json"));
  if (marker.schemaVersion !== 1 || marker.appId !== "lvl-public"
      || marker.port !== 4273 || marker.installType !== "per-user"
      || marker.dataRoot !== "%LOCALAPPDATA%\\LVL\\data"
      || marker.browserProfile !== "%LOCALAPPDATA%\\LVL\\browser-profile"
      || marker.version !== version || pkg.version !== version
      || pkg.name !== "lvl" || pkg.type !== "module") reject("staged full installer identity mismatch");
  const node = fs.readFileSync(path.join(pending, "runtime", "node.exe"));
  const exe = fs.readFileSync(path.join(pending, "LVL.exe"));
  if (node.toString("ascii", 0, 2) !== "MZ" || exe.toString("ascii", 0, 2) !== "MZ")
    reject("staged full installer has invalid native files");
  const entries = fs.readdirSync(pending);
  if (entries.some((name) => !MANAGED.includes(name))) reject("unexpected top-level installer file");
}
export function prepareFullInstallation(rootValue, version, token) {
  const root = safeRoot(rootValue, true);
  if (!VERSION.test(version) || !TOKEN.test(token)) reject("invalid full-install request");
  const owner = leaseOwner(root);
  if (!owner || owner.token !== token) reject("full setup does not own target");
  const tx = fullTx(root);
  if (!fs.existsSync(tx) || !checkEntry(tx).isDirectory()) reject("full setup staging not found");
  if (fs.existsSync(filename(root, "", "journal.json")))
    reject("an earlier full installation needs recovery");
  verifyFullStage(root, version);
  const rows = MANAGED.map((name) => ({
    name, old: entryDigest(path.join(root, name)),
    next: entryDigest(filename(root, "pending", name)),
  }));
  const recoveryPair = {};
  // The startup repair worker cannot depend on runtime/node.exe: a hard
  // process death can interrupt the runtime directory swap. Pin an independent
  // bootstrap runtime + transaction code before the first live mutation.
  for (const relative of ["node.exe", "windows-install-transaction.mjs"]) {
    const src = filename(root, "pending", path.join("runtime", relative));
    const dst = filename(root, "recovery", relative);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
    const stagedDigest = sha(fs.readFileSync(src));
    if (entryDigest(src) !== entryDigest(dst) || stagedDigest !== sha(fs.readFileSync(dst)))
      reject("recovery bootstrap copy verification failed: " + relative);
    recoveryPair[relative === "node.exe" ? "nodeSha256" : "helperSha256"] = stagedDigest;
  }
  const journal = { format: FULL_FORMAT, state: "preparing", version, token,
    recoveryPair, rows };
  atomicJson(filename(root, "", "journal.json"), journal);
  return journal;
}
function assertEntryDigest(value, expected, phase) {
  const actual = entryDigest(value);
  if (actual !== expected) reject(phase + " verification mismatch: " + value);
}
export function recoverFullInstallation(rootValue, {
  permitPendingRestart = false, afterRestore,
} = {}) {
  const root = safeRoot(rootValue);
  if (!fs.existsSync(filename(root, "", "journal.json"))) return false;
  const journal = fullJournal(root);
  if (journal.state === "acknowledged" || journal.state === "rolled-back") {
    try { fs.rmSync(fullTx(root), { recursive: true, force: true }); }
    catch { /* the recovery Node executable may still be running inside this tree */ }
    if (hasMatchingLease(root, journal.token)) releaseInstallLease(root, journal.token);
    return true;
  }
  if (journal.state === "awaiting-restart" && permitPendingRestart) return false;
  if (journal.state === "preparing") {
    const launcher = journal.rows.find((row) => row.name === "LVL.exe");
    const liveHash = entryDigest(path.join(root, "LVL.exe"));
    if (liveHash === launcher.next && liveHash !== launcher.old) {
      // Power died after the ATOMIC native bootstrap replacement but before
      // the follow-up journal write. The new Launcher.cs sees 'preparing' and
      // safely reaches this independently staged repair worker.
      journal.state = "bootstrap-ready";
      atomicJson(filename(root, "", "journal.json"), journal);
    } else {
      if (liveHash !== launcher.old)
        reject("preparing journal has an unknown launcher identity");
      // A crash before bootstrap promotion left the previous installation
      // entirely intact; an old 0.2.6 launcher remains usable.
      // No live item was swapped. If a detached helper still holds staging,
      // retain the exact attempt lease and journal for explicit recovery;
      // releasing the lease after partial cleanup would admit another writer.
      fs.rmSync(fullTx(root), { recursive: true, force: true });
      if (fs.existsSync(fullTx(root)))
        reject("preparing cleanup is incomplete; preserve target ownership");
      if (hasMatchingLease(root, journal.token)) releaseInstallLease(root, journal.token);
      return true;
    }
  }
  if (journal.rows.every((row) => row.old === null)) {
    // Fresh installation has no previous executable to restore. Finish every
    // verified staged item, keeping the already-promoted native launcher.
    for (const row of journal.rows) {
      const live = path.join(root, row.name), pending = filename(root, "pending", row.name);
      if (entryDigest(live) === row.next) continue;
      assertEntryDigest(pending, row.next, "fresh-install recovery source");
      if (checkEntry(live)) fs.rmSync(live, { recursive: true, force: true });
      if (row.next !== null) fs.renameSync(pending, live);
      afterRestore?.(row.name);
    }
    for (const row of journal.rows)
      assertEntryDigest(path.join(root, row.name), row.next, "recovered fresh install");
    journal.state = "awaiting-restart";
    atomicJson(filename(root, "", "journal.json"), journal);
    return true;
  }
  // Validate the complete backup/old-live source BEFORE removing a new tree.
  for (const row of journal.rows) {
    const backup = filename(root, "backup", row.name), live = path.join(root, row.name);
    if (row.old === null) continue;
    if (checkEntry(backup)) assertEntryDigest(backup, row.old, "backup");
    else assertEntryDigest(live, row.old, "previous installation");
  }
  journal.state = "restoring";
  atomicJson(filename(root, "", "journal.json"), journal);
  // Restore every non-bootstrap tree first. This keeps the NEW recovery-aware
  // launcher available through a crash during restoration.
  for (const row of journal.rows.filter((entry) => entry.name !== "LVL.exe")) {
    const backup = filename(root, "backup", row.name), live = path.join(root, row.name);
    if (checkEntry(backup)) {
      if (checkEntry(live)) fs.rmSync(live, { recursive: true, force: true });
      fs.renameSync(backup, live);
    } else if (row.old === null && checkEntry(live)) {
      fs.rmSync(live, { recursive: true, force: true });
    }
    if (row.old !== null) assertEntryDigest(live, row.old, "restored");
    afterRestore?.(row.name);
  }
  journal.state = "rollback-ready";
  atomicJson(filename(root, "", "journal.json"), journal);
  afterRestore?.("__rollback-ready__");
  const oldLauncher = journal.rows.find((row) => row.name === "LVL.exe");
  const launcher = path.join(root, "LVL.exe");
  if (oldLauncher.old !== null && entryDigest(launcher) !== oldLauncher.old) {
    const backup = filename(root, "backup", "LVL.exe");
    assertEntryDigest(backup, oldLauncher.old, "original stable launcher");
    const replacement = filename(root, "recovery", "restored-launcher.exe");
    fs.copyFileSync(backup, replacement);
    assertEntryDigest(replacement, oldLauncher.old, "prepared old launcher");
    // Atomic replacement is the LAST live mutation: legacy 0.2.6 understands
    // none of these journals but now has a fully coherent old app/runtime.
    fs.renameSync(replacement, launcher);
  }
  assertEntryDigest(launcher, oldLauncher.old, "restored stable launcher");
  journal.state = "rolled-back";
  atomicJson(filename(root, "", "journal.json"), journal);
  try { fs.rmSync(fullTx(root), { recursive: true, force: true }); }
  catch { /* recovery runner may still hold its dedicated node.exe */ }
  if (hasMatchingLease(root, journal.token))
    updateInstallLease(root, journal.token, { phase: "rolled-back" });
  return true;
}
export function commitFullInstallation(rootValue, version, token, {
  afterMove, beforeFirstLiveSwap, observeStopped,
} = {}) {
  const root = safeRoot(rootValue), journal = fullJournal(root);
  if (journal.token !== token || journal.version !== version || journal.state !== "preparing")
    reject("full setup has no matching prepared journal");
  verifyFullStage(root, version);
  for (const row of journal.rows)
    assertEntryDigest(filename(root, "pending", row.name), row.next, "prepared staging");
  try {
    // Copy the old EXE without removing its live entrypoint. Atomically
    // publish the verified recovery-aware launcher before touching runtime,
    // package metadata or any application directory.
    const executableRow = journal.rows.find((row) => row.name === "LVL.exe");
    if (executableRow.old !== null) {
      const original = filename(root, "backup", "LVL.exe");
      fs.mkdirSync(path.dirname(original), { recursive: true });
      fs.copyFileSync(path.join(root, "LVL.exe"), original, fs.constants.COPYFILE_EXCL);
      assertEntryDigest(original, executableRow.old, "old bootstrap backup");
    }
    const newExecutable = filename(root, "pending", "LVL.exe");
    assertEntryDigest(newExecutable, executableRow.next, "new stable bootstrap");
    // The outer Inno stop observation can precede substantial verification
    // and backup work. Recheck the same prepared attempt immediately before
    // the FIRST live mutation, without granting authority to a basename.
    beforeFirstLiveSwap?.();
    const owner = leaseOwner(root);
    // The exported direct transaction API predates signed Inno staging: its
    // acquireInstallLease() owner begins in "downloading" and may prepare and
    // commit under the SAME lease and verified journal. Do not reinterpret it
    // as an Inno staging lease. Signed CLI commits always pass observeStopped,
    // and therefore still require "staging" plus the exact native parent and
    // final quiet proof; no other phase or changed attempt is admitted.
    const directPreparedOwner = !observeStopped && owner?.phase === "downloading";
    if (!owner || owner.initializing || owner.token !== token
        || (owner.phase !== "staging" && !directPreparedOwner))
      reject("prepared installation lease changed before first live swap");
    if (observeStopped && observeStopped() !== true)
      reject("legacy owner restarted before first live swap");
    // This is a fail-closed final observation, not an atomic OS launch barrier.
    // A start after observation may still contend with Windows file locking;
    // failure must retain verified recovery state instead of continuing.
    fs.renameSync(newExecutable, path.join(root, "LVL.exe"));
    afterMove?.("bootstrap", "LVL.exe");
    journal.state = "bootstrap-ready";
    atomicJson(filename(root, "", "journal.json"), journal);
    journal.state = "backing-up";
    atomicJson(filename(root, "", "journal.json"), journal);
    for (const row of journal.rows.filter((entry) => entry.name !== "LVL.exe")) {
      const live = path.join(root, row.name);
      assertEntryDigest(live, row.old, "source before backup");
      if (row.old !== null) {
        const backup = filename(root, "backup", row.name);
        fs.mkdirSync(path.dirname(backup), { recursive: true });
        fs.renameSync(live, backup);
      }
      afterMove?.("backup", row.name);
    }
    journal.state = "installing";
    atomicJson(filename(root, "", "journal.json"), journal);
    for (const row of journal.rows.filter((entry) => entry.name !== "LVL.exe")) {
      if (row.next !== null) {
        fs.renameSync(filename(root, "pending", row.name), path.join(root, row.name));
      }
      afterMove?.("install", row.name);
    }
    for (const row of journal.rows) assertEntryDigest(path.join(root, row.name), row.next, "new installation");
    journal.state = "awaiting-restart";
    atomicJson(filename(root, "", "journal.json"), journal);
    updateInstallLease(root, token, { phase: "awaiting-restart", version });
    return { version, state: journal.state };
  } catch (error) {
    try { recoverFullInstallation(root); }
    catch (rollback) { throw new AggregateError([error, rollback], "Full install failed; recovery remains on disk"); }
    throw error;
  }
}
export function cancelFullInstallation(rootValue, token) {
  const root = safeRoot(rootValue), owner = leaseOwner(root);
  if (!owner || owner.initializing || owner.token !== token)
    reject("cannot cancel another owner's installation");
  const tx = fullTx(root), journalPath = filename(root, "", "journal.json");
  if (fs.existsSync(journalPath)) {
    const journal = fullJournal(root);
    if (journal.token !== token) reject("newer installation owns recovery journal");
    if (journal.state === "awaiting-restart") reject("new installation awaits restart acknowledgement");
    recoverFullInstallation(root);
  }
  if (fs.existsSync(tx)) {
    if (!checkEntry(tx).isDirectory()) reject("unsafe full-install transaction");
    fs.rmSync(tx, { recursive: true, force: true });
  }
  releaseInstallLease(root, token);
  return true;
}
export function acknowledgeFreshInstallation(rootValue, version, token) {
  const root = safeRoot(rootValue), journal = fullJournal(root);
  if (journal.token !== token || journal.version !== version ||
      journal.rows.some((row) => row.old !== null))
    reject("fresh install may not retire any previous application");
  return acknowledgeFullInstallation(root, version);
}
export function acknowledgeFullInstallation(rootValue, version) {
  const root = safeRoot(rootValue), tx = fullTx(root);
  if (!fs.existsSync(filename(root, "", "journal.json"))) return false;
  const journal = fullJournal(root);
  if (journal.state === "acknowledged" && journal.version === version)
    return recoverFullInstallation(root);
  if (journal.state !== "awaiting-restart" || journal.version !== version)
    reject("full installation has not reached restart confirmation");
  for (const row of journal.rows) assertEntryDigest(path.join(root, row.name), row.next, "restarted installation");
  journal.state = "acknowledged";
  atomicJson(filename(root, "", "journal.json"), journal);
  fs.rmSync(tx, { recursive: true, force: true });
  if (hasMatchingLease(root, journal.token)) releaseInstallLease(root, journal.token);
  return true;
}
async function cli(args) {
  const [action, ...rest] = args;
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i]?.startsWith("--") || !rest[i + 1] || options[rest[i]])
      reject("invalid installer helper arguments");
    options[rest[i]] = rest[i + 1];
  }
  const root = options["--app-root"], token = options["--token"],
    version = options["--version"];
  if (!root || !path.isAbsolute(root)) reject("full installer must name an absolute target");
  const requestedBootstrap = options["--bootstrap-native"] || options["--bootstrap-sha256"];
  const bootstrap = requestedBootstrap
    ? verifySetupBootstrap(options["--bootstrap-native"], options["--bootstrap-sha256"]) : null;
  if (requestedBootstrap && !bootstrap)
    reject("untrusted or missing installer-embedded native process proof");
  if (action === "recover-startup") {
    const parent = Number(options["--launcher-pid"]);
    const launcherPort = Number(options["--launcher-port"] || "4273");
    if (!Number.isInteger(launcherPort) || launcherPort <= 1024 || launcherPort > 65535)
      reject("invalid recovering launcher port");
    const expectedBirth = options["--launcher-start-ticks"];
    const ready = options["--ready-file"];
    const expectedLauncher = canonicalInstallTarget(path.join(root, "LVL.exe"));
    const launcher = inspectNativeProcess(parent, root);
    if (!Number.isSafeInteger(parent) || parent < 1 || parent !== process.ppid
        || !OS_BIRTH_TICKS.test(expectedBirth || "")
        || !launcher || launcher.startTicks !== expectedBirth
        || launcher.executablePath !== expectedLauncher)
      reject("native recovery must originate from its live, exact launcher process");
    if (!ready || !/^launch-[0-9a-f]{32}\.ready$/.test(path.basename(ready))
        || path.resolve(path.dirname(ready)) !== path.resolve(filename(root, "recovery", "")))
      reject("native startup handshake is outside owned recovery files");
    const journal = fullJournal(root);
    if (!["preparing", "bootstrap-ready", "backing-up", "installing", "restoring",
      "rollback-ready"].includes(journal.state))
      reject("journal does not require native startup repair");
    fs.writeFileSync(ready, "READY\n", { flag: "wx" });
    const limit = Date.now() + 15000;
    while (true) {
      const current = inspectNativeProcess(parent, root);
      if (current === undefined) reject("recovery launcher process identity became unavailable");
      if (current === null || current.startTicks !== expectedBirth) break;
      if (current.executablePath !== expectedLauncher)
        reject("recovery launcher executable identity changed");
      if (Date.now() > limit) reject("recovery launcher did not exit");
      await sleep(50);
    }
    const owner = acquireInstallLease(root, { phase: "recovering" });
    try {
      recoverFullInstallation(root);
      if (options["--relaunch"] === "yes") {
        const executable = path.join(root, "LVL.exe");
        const stat = checkEntry(executable);
        if (!stat?.isFile()) reject("recovered application launcher is missing");
        await new Promise((resolve, rejectStart) => {
          const child = spawn(executable, ["--background", "--port", String(launcherPort)], {
            cwd: root, windowsHide: true, detached: true, stdio: "ignore",
          });
          child.once("error", rejectStart);
          child.once("spawn", () => { child.unref(); resolve(); });
        });
      }
    } finally { releaseInstallLease(root, owner.token); }
  } else if (action === "reserve") {
    if (fs.existsSync(path.join(root, ".lvl-patch-transaction")))
      reject("previous incremental installation must finish recovery before full setup");
    const pid = Number(options["--owner-pid"]);
    if (pid !== process.ppid)
      reject("installer helper must be a direct child of the claimed setup process");
    const expectedSetupImage = options["--owner-image"];
    if (typeof expectedSetupImage !== "string" || !path.isAbsolute(expectedSetupImage))
      reject("installer must name its exact native executable image");
    const setup = inspectNativeProcess(pid, root, { bootstrap });
    if (!setup || !setup.executablePath
        || setup.executablePath !== canonicalInstallTarget(expectedSetupImage))
      reject("cannot verify exact setup process PID, OS birth and executable image");
    const { startTicks, executablePath } = setup;
    let reservedToken = token;
    if (token) {
      // Wait until the previous updater has completed its token-matched
      // detached-child publication. A matching "downloading" token is NOT
      // evidence the older launcher has finished writing the owner record.
      await awaitInstallLease(root, token, { requiredPhase: "detached-child" });
      // The detached bootstrap is a prior, DIFFERENT process. Its identity
      // becomes stale when it exits. Replace both the PID and OS birth ticks
      // with the verified live setup process before Inno extracts anything.
      updateInstallLease(root, token, {
        pid, startTicks, executablePath, phase: "staging", setupPid: pid,
      });
    } else {
      reservedToken = acquireInstallLease(root, {
        pid, startTicks, phase: "staging", bootstrap,
      }).token;
    }
    if (fs.existsSync(filename(root, "", "journal.json"))) {
      recoverFullInstallation(root);
    }
    // A process killed during extraction may leave an incomplete pending
    // tree without a journal. The target is now exclusively leased: reset
    // that disposable staging area before Inno extracts this attempt.
    if (fs.existsSync(fullTx(root))) {
      const stat = checkEntry(fullTx(root));
      if (!stat?.isDirectory()) reject("unsafe previous full setup staging");
      fs.rmSync(fullTx(root), { recursive: true, force: true });
    }
    const output = options["--token-output"];
    if (output) {
      if (!path.isAbsolute(output) || path.resolve(output).startsWith(root + path.sep))
        reject("unsafe lease token output");
      fs.writeFileSync(output, reservedToken, { flag: "wx", mode: 0o600 });
    }
    process.stdout.write("reserved\n");
  } else if (action === "preflight-stop" || action === "await-stop") {
    // The old installed --quit MUST run before writing 'preparing': older
    // launchers do not know the new recovery/quit exception. This preflight
    // waits for that old --quit child to exit under the exact staging lease.
    // The later await-stop is a second native check of the prepared journal.
    const owner = leaseOwner(root);
    const parent = owner && !owner.initializing
      ? inspectNativeProcess(owner.pid, root, { bootstrap }) : undefined;
    if (!bootstrap || !TOKEN.test(token || "") || !owner || owner.initializing
        || owner.token !== token || owner.pid !== process.ppid
        || !OS_BIRTH_TICKS.test(owner.startTicks)
        || !parent || parent.startTicks !== owner.startTicks
        || parent.executablePath !== owner.executablePath)
      reject("native process stop check requires the live, prepared setup owner");
    if (action === "preflight-stop") {
      if (owner.phase !== "staging" || fs.existsSync(filename(root, "", "journal.json")))
        reject("legacy quit preflight requires staging lease before any recovery journal");
    } else {
      const journal = fullJournal(root);
      if (journal.token !== token || journal.state !== "preparing")
        reject("native process stop check requires this attempt's prepared journal");
    }
    if (!awaitNativeInstalledStop(root, { bootstrap }))
      reject("owned launcher or extension runner has not stopped");
  } else if (action === "prepare-full") {
    prepareFullInstallation(root, version, token);
  } else if (action === "commit-full") {
    // The native waiter was already required after the old app's --quit.
    // Re-check immediately before the journal's first live swap, because a
    // launcher may have started again between Inno's stop callback and commit.
    // Installed/API recovery callers without the Inno bootstrap keep their
    // original journal/state admission path.
    if (bootstrap && !awaitNativeInstalledStop(root, { bootstrap }))
      reject("installed executable or runner restarted before full commit");
    commitFullInstallation(root, version, token, {
      observeStopped: bootstrap ? () => {
        // The signed Inno bootstrap must still be the child of the exact
        // native setup owner with unchanged OS birth and executable image.
        const owner = leaseOwner(root);
        const parent = inspectNativeProcess(process.ppid, root, { bootstrap });
        return Boolean(owner && !owner.initializing
          && owner.token === token && owner.phase === "staging"
          && owner.pid === process.ppid && parent
          && parent.pid === owner.pid && parent.startTicks === owner.startTicks
          && parent.executablePath === owner.executablePath
          && awaitNativeInstalledStop(root, { bootstrap }));
      } : undefined,
    });
  } else if (action === "rollback-full") {
    recoverFullInstallation(root);
  } else if (action === "cancel-full") {
    cancelFullInstallation(root, token);
  } else if (action === "ack-fresh") {
    acknowledgeFreshInstallation(root, version, token);
  } else if (action === "ack-full") {
    acknowledgeFullInstallation(root, version);
  } else if (action === "ack-any") {
    const launcherPid = Number(options["--launcher-pid"]);
    const expectedBirth = options["--launcher-start-ticks"];
    const launcher = inspectNativeProcess(launcherPid, root);
    if (!Number.isSafeInteger(launcherPid) || launcherPid <= 0
        || launcherPid !== process.ppid || !OS_BIRTH_TICKS.test(expectedBirth || "")
        || !launcher || launcher.startTicks !== expectedBirth
        || launcher.executablePath !== canonicalInstallTarget(path.join(root, "LVL.exe")))
      reject("restart acknowledgement requires exact parent PID, OS birth and installed launcher path");
    let acknowledged = false;
    if (fs.existsSync(filename(root, "", "journal.json")))
      acknowledged = acknowledgeFullInstallation(root, version);
    // Patch compatibility: the patch worker's own journal/restore rules own
    // patch acknowledgements. No copied/publisher-side package is needed.
    const { acknowledgeIncrementalPatch, cleanupCommittedIncrementalPatch } = await import("./update-apply.mjs");
    if (acknowledgeIncrementalPatch(root, version)) acknowledged = true;
    if (cleanupCommittedIncrementalPatch(root, version)) acknowledged = true;
    const owner = leaseOwner(root);
    if (acknowledged && owner && !owner.initializing && owner.phase === "awaiting-restart"
        && owner.version === version) releaseInstallLease(root, owner.token);
  } else reject("unknown full installer helper action");
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  cli(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
