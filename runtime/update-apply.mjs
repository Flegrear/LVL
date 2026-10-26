/**
 * Detached public LVL patch worker. C# must first authenticate the ZIP against
 * release SHA256SUMS (manifest hashes alone DO NOT authenticate a publisher).
 *
 * Preferred C# CLI:
 * runtime/node.exe runtime/update-apply.mjs --app-root <absolute> --zip <absolute>
 *   --zip-sha256 <trustedSha256> --from <version> --to <version>
 *   --parent-pid <pid> --relaunch
 * Also accepts the earlier 5-positional-argument form for bootstrap migration.
 *
 * Root ZIP manifest.json:
 * {format:"lvl-patch-v1",fromVersion:"0.1.0",toVersion:"0.1.1",
 *  files:[{path:"app.js",sha256:"<64hex>"},...],deletes:[]}
 * ZIP file members exactly match files[] plus manifest.json. package.json
 * MUST be in files[] and declare toVersion. installed-app.json is updated by
 * this helper only after the content is installed and verified, not from ZIP.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";

const FORMAT = "lvl-patch-v1";
const TX = ".lvl-patch-transaction";
const ROOTS = ["assets/", "backend/", "frontend/", "learning/", "shared/"];
const TOP = new Set(["app.js", "index.html", "server.js", "package.json", "CHANGELOG.md"]);
const REQUIRED = new Set(["app.js", "index.html", "server.js", "package.json"]);
const MAX_ZIP = 256 * 1024 * 1024;
const MAX_UNPACKED = 384 * 1024 * 1024;
const MAX_MEMBER = 128 * 1024 * 1024;
const MAX_MEMBERS = 4096;
const HASH = /^[0-9a-f]{64}$/i;
const VERSION = /^(?:0|[1-9]\d{0,3})\.(?:0|[1-9]\d{0,3})\.(?:0|[1-9]\d{0,3})$/;
const RESERVED = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;
const BAD_SUFFIX = /(?:\.env|\.log|\.db|\.db-wal|\.db-shm|\.sqlite|\.sqlite3|\.sqlite3-wal|\.sqlite3-shm|\.pem|\.key|\.p12|\.pfx|\.bak|\.tmp)$/i;
const EXECUTABLE_SUFFIX = /\.(?:exe|dll|sys|node|msi|msp|msix|appx|bat|cmd|ps1|vbs|wsf|com|scr|so|dylib|jar|zip|7z|rar|tar|tgz|gz)$/i;
const DEVELOPMENT_PATH = /(?:^|\/)(?:__tests__|tests?|specs?|fixtures?|devtools|docs|examples|benchmarks|coverage)(?:\/|$)|(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/i;

function fail(message) { throw new Error("LVL patch: " + message); }
const sha = (value) => createHash("sha256").update(value).digest("hex");
const hashFile = (filename) => sha(fs.readFileSync(filename));
const isVersion = (v) => typeof v === "string" && VERSION.test(v);
function isUpgrade(from, to) {
  if (!isVersion(from) || !isVersion(to)) return false;
  const old = from.split(".").map(Number), next = to.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) if (old[i] !== next[i]) return next[i] > old[i];
  return false;
}
// Independent installed-runtime copy of scripts/release-inputs.mjs rules.
// scripts/ and the release generator are intentionally absent from installer.
export function isPatchSourcePath(name) {
  if (typeof name !== "string" || !name || name.length > 230
      || name.startsWith("/") || name.includes("\\") || name.includes(":")
      || name.includes("\0") || name.includes("//")) return false;
  const segments = name.split("/");
  if (segments.some((part) => !part || part === "." || part === ".."
      || part.startsWith(".") || /[<>:"|?*\x00-\x1f]/.test(part)
      || /[. ]$/.test(part) || RESERVED.test(part))) return false;
  if (name === "learning/build-presets.mjs" || BAD_SUFFIX.test(name)
      || EXECUTABLE_SUFFIX.test(name) || DEVELOPMENT_PATH.test(name)) return false;
  return TOP.has(name) || ROOTS.some((prefix) => name.startsWith(prefix));
}
function parseJson(data, limit, label) {
  if (!Buffer.isBuffer(data) || data.length === 0 || data.length > limit)
    fail(label + " missing or exceeds limit");
  let parsed;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)); }
  catch { fail(label + " must be valid UTF-8 JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    fail(label + " must be an object");
  return parsed;
}
function readJson(filename, limit, label) {
  if (!fs.existsSync(filename) || fs.statSync(filename).size > limit)
    fail(label + " missing or too large");
  return parseJson(fs.readFileSync(filename), limit, label);
}
function validateRoot(appRoot) {
  if (typeof appRoot !== "string" || !path.isAbsolute(appRoot))
    fail("app root must be absolute");
  const root = path.resolve(appRoot);
  if (!fs.existsSync(root) || !fs.lstatSync(root).isDirectory()
      || fs.lstatSync(root).isSymbolicLink()) fail("app root must be an ordinary directory");
  return root;
}
function safeLivePath(root, name, allowMissing = true) {
  if (name !== "installed-app.json" && !isPatchSourcePath(name))
    fail("path is outside release allowlist: " + name);
  let current = root;
  const parts = name.split("/");
  for (let i = 0; i < parts.length; i += 1) {
    current = path.join(current, parts[i]);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) {
      if (!allowMissing) fail("installed path missing: " + name);
      continue;
    }
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
      fail("symlink/special destination forbidden: " + name);
    if (i < parts.length - 1 && !stat.isDirectory())
      fail("non-directory ancestor: " + name);
    if (i === parts.length - 1 && !stat.isFile())
      fail("file destination is a directory: " + name);
  }
  if (!current.startsWith(root + path.sep)) fail("destination escaped app root");
  return current;
}
function installation(root, expectedVersion = null) {
  const marker = readJson(safeLivePath(root, "installed-app.json", false), 65536, "installed-app.json");
  if (marker.appId !== "lvl-public" || marker.schemaVersion !== 1
      || marker.installType !== "per-user" || marker.port !== 4273
      || !isVersion(marker.version)) fail("refusing non-public LVL installation");
  const pkg = readJson(safeLivePath(root, "package.json", false), 65536, "installed package.json");
  if (!isVersion(pkg.version) || (expectedVersion !== null
      && (marker.version !== expectedVersion || pkg.version !== expectedVersion)))
    fail("installed version does not match patch base");
  return { marker, pkg };
}
function decodePatch(zipPath, root, from, to, expectedSha) {
  if (!path.isAbsolute(zipPath)) fail("ZIP path must be absolute");
  const filename = path.resolve(zipPath);
  if (filename === root || filename.startsWith(root + path.sep))
    fail("ZIP download must be outside installation");
  const stat = fs.lstatSync(filename, { throwIfNoEntry: false });
  if (!stat || !stat.isFile() || stat.isSymbolicLink()
      || !stat.size || stat.size > MAX_ZIP) fail("missing/oversized ZIP");
  if (expectedSha !== null && (!HASH.test(expectedSha) || hashFile(filename) !== expectedSha.toLowerCase()))
    fail("trusted downloaded ZIP SHA-256 mismatch");
  let zip;
  try { zip = new AdmZip(filename); } catch { fail("could not parse ZIP"); }
  const entries = zip.getEntries();
  if (entries.length < 2 || entries.length > MAX_MEMBERS + 20)
    fail("ZIP entry count out of bounds");
  const byName = new Map(), seen = new Set(), directories = [];
  let bytes = 0;
  for (const entry of entries) {
    const name = entry.entryName;
    if (!name || name.includes("\\") || name.includes("\0") || name.startsWith("/"))
      fail("unsafe ZIP member path");
    const canonical = name.endsWith("/") ? name.slice(0, -1) : name;
    const folded = canonical.normalize("NFC").toLowerCase();
    if (seen.has(folded)) fail("duplicate/case-aliased ZIP entries");
    seen.add(folded);
    const unixKind = ((entry.header?.attr || 0) >>> 16) & 0o170000;
    if (unixKind === 0o120000) fail("ZIP symlink forbidden");
    if (entry.isDirectory) {
      if (!ROOTS.some((prefix) => canonical === prefix.slice(0, -1)
          || canonical.startsWith(prefix) || prefix.startsWith(canonical + "/"))
          || !isPatchSourcePath(canonical + "/check.js"))
        fail("unexpected ZIP directory");
      directories.push(canonical);
      continue;
    }
    if (name !== "manifest.json" && !isPatchSourcePath(name))
      fail("ZIP file outside release allowlist: " + name);
    const size = entry.header?.size, compressed = entry.header?.compressedSize;
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_MEMBER
        || !Number.isSafeInteger(compressed) || compressed < 0
        || (size > 1024 * 1024 && size > Math.max(1, compressed) * 200))
      fail("ZIP entry size or compression limit exceeded");
    bytes += size;
    if (bytes > MAX_UNPACKED) fail("ZIP uncompressed size limit exceeded");
    byName.set(name, entry);
  }
  const header = byName.get("manifest.json");
  if (!header || header.header.size > 256 * 1024) fail("missing bounded manifest.json");
  const manifest = parseJson(header.getData(), 256 * 1024, "manifest");
  if (manifest.format !== FORMAT || manifest.fromVersion !== from || manifest.toVersion !== to
      || !isUpgrade(from, to)) fail("invalid manifest format/version transition");
  if (!Array.isArray(manifest.files) || !Array.isArray(manifest.deletes)
      || !manifest.files.length || manifest.files.length + manifest.deletes.length > MAX_MEMBERS)
    fail("invalid manifest file/delete lists");
  const wanted = new Map(), deletes = [], caseNames = new Set();
  for (const item of manifest.files) {
    if (!item || typeof item !== "object" || Array.isArray(item)
        || !isPatchSourcePath(item.path) || typeof item.sha256 !== "string"
        || !HASH.test(item.sha256)) fail("invalid manifest file/hash");
    const folded = item.path.normalize("NFC").toLowerCase();
    if (caseNames.has(folded)) fail("duplicate/aliased manifest paths");
    caseNames.add(folded);
    wanted.set(item.path, item.sha256.toLowerCase());
  }
  for (const name of manifest.deletes) {
    if (!isPatchSourcePath(name) || TOP.has(name)
        || caseNames.has(name.normalize("NFC").toLowerCase()))
      fail("invalid or overlapping deleted path");
    caseNames.add(name.normalize("NFC").toLowerCase());
    deletes.push(name);
  }
  if (!wanted.has("package.json") || byName.size !== wanted.size + 1)
    fail("ZIP files must exactly equal manifest and include package.json");
  for (const directory of directories)
    if (![...wanted.keys()].some((name) => name.startsWith(directory + "/")))
      fail("ZIP directory has no declared file members: " + directory);
  const contents = new Map();
  for (const [name, expected] of wanted) {
    const entry = byName.get(name);
    if (!entry) fail("missing declared file: " + name);
    const data = entry.getData();
    if (!Buffer.isBuffer(data) || data.length > MAX_MEMBER || sha(data) !== expected)
      fail("ZIP file hash/decompression mismatch: " + name);
    contents.set(name, data);
  }
  const pkg = parseJson(contents.get("package.json"), 65536, "patched package");
  if (pkg.version !== to || pkg.name !== "lvl" || pkg.type !== "module")
    fail("patched package.json version/identity mismatch");
  return { contents, hashes: wanted, deletes };
}
function txFolder(root) { return path.join(root, TX); }
function txPath(tx, group, name) {
  return path.join(tx, group, ...name.split("/"));
}
function persistJournal(tx, journal) {
  const filename = path.join(tx, "journal.json");
  fs.writeFileSync(filename + ".new", JSON.stringify(journal) + "\n");
  fs.renameSync(filename + ".new", filename);
}
function inspectJournal(tx) {
  const record = readJson(path.join(tx, "journal.json"), 512 * 1024, "recovery journal");
  if (record.format !== FORMAT || !["preparing", "applying", "committed"].includes(record.state)
      || !isVersion(record.fromVersion) || !isVersion(record.toVersion)
      || !Array.isArray(record.records) || record.records.length > MAX_MEMBERS + 1)
    fail("invalid recovery journal");
  const keys = new Set();
  for (const item of record.records) {
    if (!item || (item.path !== "installed-app.json" && !isPatchSourcePath(item.path))
        || typeof item.existed !== "boolean" || (item.existed && !HASH.test(item.sha256 || ""))
        || keys.has(item.path.toLowerCase())) fail("unsafe recovery journal entry");
    keys.add(item.path.toLowerCase());
  }
  return record;
}
export function recoverInterruptedPatch(appRoot) {
  const root = validateRoot(appRoot), tx = txFolder(root);
  if (!fs.existsSync(tx)) return false;
  if (!fs.lstatSync(tx).isDirectory() || fs.lstatSync(tx).isSymbolicLink())
    fail("transaction storage is unsafe");
  const journal = inspectJournal(tx);
  if (journal.state === "applying") {
    // Idempotent rollback, repeatable after a crash *during* rollback.
    for (const item of journal.records) {
      const target = safeLivePath(root, item.path);
      if (item.existed) {
        const saved = txPath(tx, "backup", item.path);
        const old = fs.lstatSync(saved, { throwIfNoEntry: false });
        if (!old?.isFile() || old.isSymbolicLink() || hashFile(saved) !== item.sha256)
          fail("missing/corrupt rollback backup: " + item.path);
        const temp = txPath(tx, "restoring", item.path);
        fs.mkdirSync(path.dirname(temp), { recursive: true });
        fs.copyFileSync(saved, temp);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        if (fs.existsSync(target)) fs.unlinkSync(target);
        fs.renameSync(temp, target);
      } else if (fs.existsSync(target)) fs.unlinkSync(target);
    }
  }
  // Preparing cannot touch installed files; committed must not be rolled back.
  fs.rmSync(tx, { recursive: true, force: true });
  return true;
}
function installPrepared(root, patch, marker, fromVersion, toVersion, afterFile) {
  const tx = txFolder(root);
  if (fs.existsSync(tx)) fail("transaction still present");
  fs.mkdirSync(tx);
  const changes = [...patch.hashes.keys(), ...patch.deletes, "installed-app.json"];
  const journal = { format: FORMAT, state: "preparing", fromVersion, toVersion, records: [] };
  try {
    persistJournal(tx, journal);
    for (const [name, data] of patch.contents) {
      safeLivePath(root, name);
      const pending = txPath(tx, "pending", name);
      fs.mkdirSync(path.dirname(pending), { recursive: true });
      fs.writeFileSync(pending, data, { flag: "wx" });
      if (hashFile(pending) !== patch.hashes.get(name)) fail("staged hash mismatch: " + name);
    }
    const markerPending = txPath(tx, "pending", "installed-app.json");
    fs.mkdirSync(path.dirname(markerPending), { recursive: true });
    fs.writeFileSync(markerPending, JSON.stringify({ ...marker, version: toVersion }, null, 2) + "\n");
    for (const name of changes) {
      const target = safeLivePath(root, name);
      const exists = fs.existsSync(target);
      if (patch.deletes.includes(name) && !exists) fail("missing delete target: " + name);
      const row = { path: name, existed: exists };
      if (exists) {
        row.sha256 = hashFile(target);
        const backup = txPath(tx, "backup", name);
        fs.mkdirSync(path.dirname(backup), { recursive: true });
        fs.copyFileSync(target, backup, fs.constants.COPYFILE_EXCL);
        if (hashFile(backup) !== row.sha256) fail("backup verification mismatch: " + name);
      }
      journal.records.push(row);
    }
    journal.state = "applying";
    persistJournal(tx, journal); // durable intent BEFORE first mutation
    let index = 0;
    for (const name of changes) {
      const target = safeLivePath(root, name);
      if (fs.existsSync(target)) fs.unlinkSync(target);
      if (!patch.deletes.includes(name)) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.renameSync(txPath(tx, "pending", name), target);
      }
      afterFile?.(name, ++index);
    }
    for (const [name, expected] of patch.hashes)
      if (hashFile(safeLivePath(root, name, false)) !== expected)
        fail("installed file hash mismatch: " + name);
    for (const name of patch.deletes) if (fs.existsSync(safeLivePath(root, name)))
      fail("deleted file still present: " + name);
    installation(root, toVersion);
    journal.state = "committed";
    persistJournal(tx, journal);
    // A crash or transient Windows lock during *cleanup* must not turn an
    // already verified and committed update into a failed, stopped app. The
    // next patch discards this committed journal without reversing the update.
    try { fs.rmSync(tx, { recursive: true, force: true }); }
    catch { /* committed journal retained for safe later cleanup */ }
    return { installed: toVersion, replaced: patch.hashes.size, deleted: patch.deletes.length };
  } catch (error) {
    try { recoverInterruptedPatch(root); }
    catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "Patch failed and rollback needs manual repair");
    }
    throw error;
  }
}
function launchPublicAndAwait(root, args, timeoutMs = 12000) {
  const exe = path.join(root, "LVL.exe");
  const stat = fs.lstatSync(exe, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink()) fail("public launcher LVL.exe missing");
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd: root, windowsHide: true, stdio: "ignore" });
    let finished = false;
    const timer = setTimeout(() => {
      if (!finished) { finished = true; child.kill(); reject(new Error("public launcher quit timed out")); }
    }, timeoutMs);
    child.once("error", (error) => {
      if (!finished) { finished = true; clearTimeout(timer); reject(error); }
    });
    child.once("close", (code) => {
      if (!finished) {
        finished = true; clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error("public launcher quit returned " + code));
      }
    });
  });
}
async function quitPublic(root) { await launchPublicAndAwait(root, ["--quit", "--port", "4273"]); }
async function relaunchPublic(root) {
  const exe = path.join(root, "LVL.exe");
  const stat = fs.lstatSync(exe, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink()) fail("public LVL.exe missing");
  await new Promise((resolve, reject) => {
    const child = spawn(exe, ["--background", "--port", "4273"], {
      cwd: root, windowsHide: true, detached: true, stdio: "ignore",
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
async function waitParent(pid, timeoutMs = 90000) {
  if (!Number.isSafeInteger(pid) || pid < 1 || pid === process.pid)
    fail("launcher PID must be a different positive PID");
  const end = Date.now() + timeoutMs;
  for (;;) {
    try { process.kill(pid, 0); }
    catch (error) {
      if (error.code === "ESRCH") return;
      if (error.code !== "EPERM") throw error;
    }
    if (Date.now() >= end) fail("launcher did not exit within wait limit");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
// Tests supply fake process operations; the detached CLI always uses genuine
// public launcher commands and never launches an arbitrary executable.
export async function applyIncrementalPatch({
  appRoot, zipPath, fromVersion, toVersion, parentPid, zipSha256 = null,
  requestQuit = quitPublic, waitForParent = waitParent,
  relaunch = relaunchPublic, afterFile,
}) {
  const root = validateRoot(appRoot);
  if (!isUpgrade(fromVersion, toVersion)) fail("target must be a newer numeric version");
  // Fully authenticate/validate + decompress/hashes BEFORE signalling quit.
  const patch = decodePatch(zipPath, root, fromVersion, toVersion, zipSha256);
  const original = installation(root);
  const txn = txFolder(root);
  if (fs.existsSync(txn)) {
    const pending = inspectJournal(txn);
    const isThisInterruptedAttempt = pending.fromVersion === fromVersion && pending.toVersion === toVersion;
    const isEarlierCommittedAttempt = pending.state === "committed"
      && pending.toVersion === fromVersion
      && original.marker.version === fromVersion && original.pkg.version === fromVersion;
    if (!isThisInterruptedAttempt && !isEarlierCommittedAttempt)
      fail("different interrupted transaction requires operator recovery");
  } else if (original.marker.version !== fromVersion || original.pkg.version !== fromVersion) {
    fail("installed source version changed");
  }
  const exe = path.join(root, "LVL.exe");
  const exeStat = fs.lstatSync(exe, { throwIfNoEntry: false });
  if (!exeStat?.isFile() || exeStat.isSymbolicLink()) fail("expected public LVL.exe in app root");
  for (const name of [...patch.hashes.keys(), ...patch.deletes]) safeLivePath(root, name);
  for (const name of patch.deletes) if (!fs.existsSync(safeLivePath(root, name, false)))
    fail("delete target missing before shutdown: " + name);
  let stopped = false, installed = false;
  try {
    await requestQuit(root);
    await waitForParent(parentPid);
    stopped = true;
    if (fs.existsSync(txn)) recoverInterruptedPatch(root);
    const { marker } = installation(root, fromVersion);
    const result = installPrepared(root, patch, marker, fromVersion, toVersion, afterFile);
    installed = true;
    await relaunch(root);
    return result;
  } catch (error) {
    if (stopped && !installed && !fs.existsSync(txn)) {
      // Restart only if rollback completed and old metadata is consistent.
      try { installation(root, fromVersion); await relaunch(root); }
      catch (startError) {
        throw new AggregateError([error, startError], "Update rolled back but old LVL could not restart");
      }
    }
    throw error;
  }
}
async function cli(args) {
  let appRoot, zipPath, fromVersion, toVersion, pid, zipSha256 = null;
  if (args[0]?.startsWith("--")) {
    const names = new Map([
      ["--app-root", "appRoot"], ["--zip", "zipPath"], ["--from", "fromVersion"],
      ["--to", "toVersion"], ["--parent-pid", "pid"], ["--zip-sha256", "zipSha256"],
    ]);
    const options = {}, seen = new Set();
    for (let i = 0; i < args.length; i += 1) {
      const flag = args[i];
      if (flag === "--relaunch") {
        if (seen.has(flag)) fail("duplicate CLI option");
        seen.add(flag);
        continue;
      }
      if (!names.has(flag) || seen.has(flag) || i + 1 >= args.length)
        fail("invalid or repeated update CLI flag");
      seen.add(flag);
      options[names.get(flag)] = args[++i];
    }
    ({ appRoot, zipPath, fromVersion, toVersion, pid } = options);
    zipSha256 = options.zipSha256 || null;
    if (!seen.has("--relaunch")) fail("named update CLI must explicitly request relaunch");
  } else {
    const tail = args.slice(5);
    if (tail.length && (tail.length !== 2 || tail[0] !== "--zip-sha256"))
      fail("unsupported positional update CLI option");
    [appRoot, zipPath, fromVersion, toVersion, pid] = args;
    zipSha256 = tail.length ? tail[1] : null;
  }
  if (!appRoot || !zipPath || !fromVersion || !toVersion || !pid
      || !/^[1-9]\d{0,9}$/.test(pid))
    fail("usage: --app-root <root> --zip <zip> --zip-sha256 <digest> --from <version> --to <version> --parent-pid <pid> --relaunch");
  if (!HASH.test(zipSha256 || ""))
    fail("an externally verified ZIP SHA-256 is required for detached installation");
  const result = await applyIncrementalPatch({
    appRoot, zipPath, fromVersion, toVersion, parentPid: Number(pid),
    zipSha256,
  });
  process.stdout.write(JSON.stringify({ ok: true, ...result }) + "\n");
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  cli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof AggregateError
      ? error.message + ": " + error.errors.map((e) => e.message).join("; ")
      : error.message);
    process.exitCode = 1;
  });
