/*
 * LVL's in-app update for the Android app (the Windows app uses runtime/update-apply.mjs).
 * It reads the same release patch (lvl-patch-v1) and uses the same path rules, but never
 * changes the running app: it writes a patched copy next to it, which the app swaps in
 * while the server is stopped (and swaps back if the new version doesn't start).
 *
 * The app checks the ZIP against the release's SHA256SUMS first and passes that digest:
 * node android/update-apply.mjs --app <dir> --next <dir> --zip <file> --zip-sha256 <hex>
 *   --from <version> --to <version>
 * Prints one JSON line ({ ok: true, ... }) and exits 0 once <next> is complete.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import { isPatchSourcePath } from "../runtime/update-apply.mjs";

const FORMAT = "lvl-patch-v1";
export const READY_MARKER = ".lvl-update-ready";
const MAX_ZIP = 256 * 1024 * 1024;
const MAX_UNPACKED = 384 * 1024 * 1024;
const MAX_MEMBER = 128 * 1024 * 1024;
const MAX_MEMBERS = 4096;
const HASH = /^[0-9a-f]{64}$/;
const VERSION = /^(?:0|[1-9]\d{0,3})\.(?:0|[1-9]\d{0,3})\.(?:0|[1-9]\d{0,3})$/;

const fail = (message) => { throw new Error(`LVL update: ${message}`); };
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

function newer(from, to) {
  if (!VERSION.test(String(from)) || !VERSION.test(String(to))) return false;
  const a = from.split(".").map(Number), b = to.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return b[i] > a[i];
  return false;
}

function readVersion(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")).version; } catch { return null; }
}

// The patch, fully read and checked: every member is in the manifest with its hash, and
// the other way round.
export function readPatch(zipFile, { zipSha256, from, to }) {
  const stat = fs.lstatSync(zipFile, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink() || !stat.size || stat.size > MAX_ZIP) fail("the download is missing or too large");
  if (!HASH.test(String(zipSha256 || "")) || sha256(fs.readFileSync(zipFile)) !== zipSha256) fail("the download doesn't match the release checksum");
  let zip;
  try { zip = new AdmZip(zipFile); } catch { fail("the download isn't a readable ZIP"); }
  const entries = zip.getEntries();
  if (entries.length < 2 || entries.length > MAX_MEMBERS + 20) fail("the patch has too many or too few entries");
  const members = new Map();
  const seen = new Set();
  let total = 0;
  for (const entry of entries) {
    const name = entry.entryName;
    const kind = ((entry.header?.attr || 0) >>> 16) & 0o170000;
    if (kind === 0o120000) fail(`links aren't allowed in a patch: ${name}`);
    const folded = name.replace(/\/$/, "").normalize("NFC").toLowerCase();
    if (seen.has(folded)) fail(`the patch lists ${name} twice`);
    seen.add(folded);
    if (entry.isDirectory) {
      if (!isPatchSourcePath(`${name.replace(/\/$/, "")}/check.js`)) fail(`unexpected folder in the patch: ${name}`);
      continue;
    }
    if (name !== "manifest.json" && !isPatchSourcePath(name)) fail(`the patch has a file LVL doesn't install: ${name}`);
    const size = entry.header?.size;
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_MEMBER) fail(`${name} is too large`);
    total += size;
    if (total > MAX_UNPACKED) fail("the patch unpacks too large");
    const data = entry.getData();
    if (data.length !== size) fail(`${name} didn't unpack completely`);
    members.set(name, data);
  }
  let manifest;
  try { manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(members.get("manifest.json") || Buffer.alloc(0))); }
  catch { fail("the patch has no readable manifest"); }
  if (manifest?.format !== FORMAT) fail("the patch format isn't supported");
  if (manifest.fromVersion !== from || manifest.toVersion !== to || !newer(from, to)) fail(`the patch is for ${manifest.fromVersion} to ${manifest.toVersion}, not ${from} to ${to}`);
  if (!Array.isArray(manifest.files) || !Array.isArray(manifest.deletes ?? [])) fail("the patch manifest is incomplete");
  const files = new Map();
  for (const item of manifest.files) {
    const name = item?.path;
    if (!isPatchSourcePath(name) || files.has(name) || !HASH.test(String(item?.sha256 || ""))) fail(`the manifest has an invalid file: ${name}`);
    const data = members.get(name);
    if (!data) fail(`the patch is missing ${name}`);
    if (sha256(data) !== item.sha256) fail(`${name} doesn't match its checksum`);
    files.set(name, data);
  }
  if (members.size !== files.size + 1) fail("the patch has files its manifest doesn't list");
  if (!files.has("package.json") || readJsonVersion(files.get("package.json")) !== to) fail(`the patch's package.json isn't version ${to}`);
  const deletes = [];
  for (const name of manifest.deletes ?? []) {
    if (!isPatchSourcePath(name) || files.has(name) || deletes.includes(name)) fail(`the manifest has an invalid delete: ${name}`);
    deletes.push(name);
  }
  return { files, deletes };
}

function readJsonVersion(data) {
  try { return JSON.parse(data.toString("utf8")).version; } catch { return null; }
}

// A path inside root whose existing parts are ordinary folders (and the file, if present, an ordinary file).
function destination(root, name) {
  let current = root;
  const parts = name.split("/");
  for (let i = 0; i < parts.length; i += 1) {
    current = path.join(current, parts[i]);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) continue;
    const last = i === parts.length - 1;
    if (stat.isSymbolicLink() || (last ? !stat.isFile() : !stat.isDirectory())) fail(`${name} can't be written in the app folder`);
  }
  if (!current.startsWith(root + path.sep)) fail(`${name} is outside the app folder`);
  return current;
}

export function prepareUpdate({ app, next, zip, zipSha256, from, to }) {
  for (const [label, value] of [["--app", app], ["--next", next], ["--zip", zip]]) {
    if (typeof value !== "string" || !path.isAbsolute(value)) fail(`${label} must be an absolute path`);
  }
  const appRoot = path.resolve(app);
  const nextRoot = path.resolve(next);
  const zipFile = path.resolve(zip);
  if (path.dirname(nextRoot) !== path.dirname(appRoot) || nextRoot === appRoot) fail("the new copy must be next to the app folder");
  if (zipFile.startsWith(appRoot + path.sep) || zipFile.startsWith(nextRoot + path.sep)) fail("the download must be outside the app folders");
  const appStat = fs.lstatSync(appRoot, { throwIfNoEntry: false });
  if (!appStat?.isDirectory() || appStat.isSymbolicLink()) fail("the app folder is missing");
  const installed = readVersion(path.join(appRoot, "package.json"));
  if (installed !== from) fail(`the app is on ${installed || "an unknown version"}, not ${from}`);

  // Check everything before writing anything.
  const patch = readPatch(zipFile, { zipSha256, from, to });
  for (const name of patch.deletes) {
    const stat = fs.lstatSync(path.join(appRoot, ...name.split("/")), { throwIfNoEntry: false });
    if (!stat?.isFile()) fail(`${name} isn't in the app, so it can't be removed`);
  }

  fs.rmSync(nextRoot, { recursive: true, force: true });
  try {
    fs.cpSync(appRoot, nextRoot, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
    fs.rmSync(path.join(nextRoot, READY_MARKER), { force: true });
    for (const [name, data] of patch.files) {
      const target = destination(nextRoot, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data);
    }
    for (const name of patch.deletes) fs.rmSync(destination(nextRoot, name));
    // Read back what was written.
    for (const [name, data] of patch.files) {
      if (sha256(fs.readFileSync(path.join(nextRoot, ...name.split("/")))) !== sha256(data)) fail(`${name} didn't write correctly`);
    }
    if (readVersion(path.join(nextRoot, "package.json")) !== to) fail(`the new copy isn't version ${to}`);
    const marker = path.join(nextRoot, READY_MARKER);
    fs.writeFileSync(marker, JSON.stringify({ from, to, files: patch.files.size, at: new Date().toISOString() }) + "\n");
    const handle = fs.openSync(marker, "r+");
    try { fs.fsyncSync(handle); } finally { fs.closeSync(handle); }
  } catch (error) {
    fs.rmSync(nextRoot, { recursive: true, force: true });
    throw error;
  }
  return { from, to, files: patch.files.size, deletes: patch.deletes.length };
}

function cli(args) {
  const names = new Map([["--app", "app"], ["--next", "next"], ["--zip", "zip"], ["--zip-sha256", "zipSha256"], ["--from", "from"], ["--to", "to"]]);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = names.get(args[i]);
    if (!key || key in options || i + 1 >= args.length) fail("usage: --app <dir> --next <dir> --zip <file> --zip-sha256 <hex> --from <version> --to <version>");
    options[key] = args[i + 1];
  }
  if (names.size !== Object.keys(options).length) fail("usage: --app <dir> --next <dir> --zip <file> --zip-sha256 <hex> --from <version> --to <version>");
  const result = prepareUpdate(options);
  process.stdout.write(JSON.stringify({ ok: true, ...result }) + "\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { cli(process.argv.slice(2)); } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: error.message }) + "\n");
    process.exitCode = 1;
  }
}
