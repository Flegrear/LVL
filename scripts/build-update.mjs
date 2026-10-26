// Source-only incremental LVL release archive. It never edits Git history or
// publishes a release; every archive byte comes from an audited HEAD Git blob.
// Usage: node scripts/build-update.mjs --from v0.1.0 [--out-dir dist]
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import { isSetupSourceFile } from "./release-inputs.mjs";

const DEFAULT_ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const VERSION = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const HASH = /^[0-9a-f]{40,64}$/;
const SHA256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_ZIP_BYTES = 80 * 1024 * 1024;
const MAX_FILE_COUNT = 2048;
const MAX_DIFF_BYTES = 8 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 512 * 1024;

// An incremental payload never carries an installer, a binary runtime, native
// modules, generated executables or unreviewed developer fixtures.
const unsafeFile = /\.(?:exe|dll|sys|node|msi|msp|msix|appx|bat|cmd|ps1|vbs|wsf|com|scr|so|dylib|jar|zip|7z|rar|tar|tgz|gz)$/i;
const developerFile = /(?:^|\/)(?:__tests__|tests?|specs?|fixtures?|devtools|docs|examples|benchmarks|coverage)(?:\/|$)|(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const safeToIgnore = /^(?:README(?:\.[^/]*)?|\.gitignore|\.gitattributes|\.editorconfig|LICENSE(?:\.[^/]*)?|docs\/.*|tests\/.*|devtools\/.*)$/i;
const windowsReserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function versionParts(value) {
  const match = VERSION.exec(String(value || ""));
  if (!match) throw new Error(`Expected a plain three-part version (e.g. 0.1.1), got: ${String(value)}`);
  const parts = match.slice(1).map(Number);
  if (!parts.every((number) => Number.isSafeInteger(number) && number <= 2147483647))
    throw new Error(`Version exceeds supported limits: ${value}`);
  return { value: parts.join("."), parts };
}

function compareVersions(left, right) {
  const a = versionParts(left).parts;
  const b = versionParts(right).parts;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}

export function validatePatchPath(name) {
  if (typeof name !== "string" || !name || name.length > 240 || name.startsWith("/")
    || name.includes("\\") || name.includes(":") || /[\x00-\x1f\x7f<>"|?*]/.test(name))
    throw new Error(`Unsafe Git/ZIP path: ${JSON.stringify(name)}`);
  const segments = name.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".."
    || segment.startsWith(".") || segment.endsWith(".") || segment.endsWith(" ")
    || windowsReserved.test(segment) || Buffer.byteLength(segment, "utf8") > 255))
    throw new Error(`Unsafe Git/ZIP path: ${JSON.stringify(name)}`);
  return name;
}

function git(repoRoot, args, maxBuffer = MAX_DIFF_BYTES) {
  try {
    return execFileSync("git", ["-C", repoRoot, ...args], {
      encoding: "buffer", windowsHide: true, timeout: 20_000, maxBuffer,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const detail = String(error.stderr || error.message || "").trim().slice(0, 700);
    throw new Error(`Git ${args[0]} failed: ${detail || "unknown error"}`);
  }
}

function gitText(repoRoot, args) {
  return git(repoRoot, args, 64 * 1024).toString("utf8").trim();
}

function readGitBlob(repoRoot, revision, relative, limit = MAX_FILE_BYTES) {
  validatePatchPath(relative);
  const listed = git(repoRoot, ["ls-tree", "-z", "--full-tree", revision, "--", relative]);
  const lines = listed.toString("utf8").split("\0").filter(Boolean);
  if (lines.length !== 1) throw new Error(`Missing or ambiguous tracked source blob: ${relative}`);
  const found = /^(\d{6}) (\w+) ([0-9a-f]{40,64})\t(.+)$/.exec(lines[0]);
  if (!found || found[4] !== relative || found[2] !== "blob" || found[1] !== "100644" || !HASH.test(found[3]))
    throw new Error(`Unsupported file mode, symlink, or object for patch: ${relative}`);
  const bytes = Number(gitText(repoRoot, ["cat-file", "-s", found[3]]));
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > limit)
    throw new Error(`Patch source exceeds ${limit} bytes: ${relative} (${bytes})`);
  const content = git(repoRoot, ["cat-file", "blob", found[3]], limit + 1024);
  if (content.length !== bytes) throw new Error(`Git blob size mismatch for ${relative}`);
  return content;
}

function parsedJson(bytes, label) {
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("must be a JSON object");
    return value;
  } catch (error) {
    throw new Error(`Invalid ${label}: ${error.message}`);
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function onlyVersionChanged(oldValue, newValue, fromVersion, toVersion, lockfile = false) {
  if (oldValue.version !== fromVersion || newValue.version !== toVersion) return false;
  const oldCopy = structuredClone(oldValue);
  const newCopy = structuredClone(newValue);
  delete oldCopy.version;
  delete newCopy.version;
  if (lockfile) {
    if (oldCopy.packages?.[""]?.version !== fromVersion
      || newCopy.packages?.[""]?.version !== toVersion) return false;
    delete oldCopy.packages[""].version;
    delete newCopy.packages[""].version;
  }
  return stableJson(oldCopy) === stableJson(newCopy);
}

// -z gives literal paths (including tabs/quotes) and marks true renames rather
// than accidentally treating a move as a safe addition.
function changedEntries(repoRoot, oldCommit) {
  const data = git(repoRoot, ["diff", "--no-ext-diff", "--name-status", "-z", "--find-renames",
    oldCommit, "HEAD", "--"], MAX_DIFF_BYTES).toString("utf8").split("\0");
  const changes = [];
  for (let i = 0; i < data.length && data[i];) {
    const status = data[i++];
    if (!/^(?:A|M|D|T|R\d{1,3}|C\d{1,3})$/.test(status))
      throw new Error(`Unsupported Git diff status: ${status}`);
    const from = data[i++];
    if (from === undefined) throw new Error("Truncated Git diff paths");
    validatePatchPath(from);
    const to = /^[RC]/.test(status) ? data[i++] : null;
    if (/^[RC]/.test(status) && to === undefined) throw new Error("Truncated Git rename/copy");
    if (to !== null) validatePatchPath(to);
    changes.push({ status, from, to });
    if (changes.length > MAX_FILE_COUNT * 4) throw new Error("Too many changed paths for an incremental patch");
  }
  return changes;
}

function inspectChangedPath(relative, change) {
  if (safeToIgnore.test(relative)) return "ignore";
  if (/^package-lock\.json$/i.test(relative)) return "lockfile";
  if (/^(?:launcher|installer|runtime|node_modules|scripts|\.github|build|dist)\//i.test(relative)
    || /^installed-app\.json$/i.test(relative) || /^THIRD_PARTY_NOTICES\.txt$/i.test(relative))
    throw new Error(`Full installer required: ${relative} changed (${change}). Launcher, runtime, packaging and dependencies cannot be patched.`);
  if (developerFile.test(relative)) return "ignore";
  if (unsafeFile.test(relative)) throw new Error(`Full installer required: binary/runtime file changed: ${relative}`);
  if (!isSetupSourceFile(relative))
    throw new Error(`Full installer or source review required: unapproved change ${relative} (${change})`);
  return "include";
}

/** Build one patch from an existing release tag to committed HEAD.
 * No Git writes, no worktree bytes, and no overwrite of existing release assets.
 * @returns {{archivePath:string, checksumPath:string, checksum:string, manifest:object}}
 */
export function buildUpdate({ repoRoot = DEFAULT_ROOT, fromVersion, toVersion = null,
  outputDir = null } = {}) {
  if (!fromVersion) throw new Error("A prior release tag is mandatory: --from v0.1.0");
  const from = versionParts(fromVersion).value;
  const root = fs.realpathSync(path.resolve(repoRoot));
  const gitRoot = fs.realpathSync(path.resolve(gitText(root, ["rev-parse", "--show-toplevel"])));
  if (root.toLowerCase() !== gitRoot.toLowerCase())
    throw new Error("Build root must be the exact Git repository root");
  const tag = `refs/tags/v${from}`;
  const oldCommit = gitText(root, ["rev-parse", "--verify", `${tag}^{commit}`]);
  const headCommit = gitText(root, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (oldCommit === headCommit) throw new Error("No new commit since the prior release tag");
  try {
    git(root, ["merge-base", "--is-ancestor", oldCommit, headCommit], 64 * 1024);
  } catch {
    throw new Error(`Old release tag v${from} is not an ancestor of HEAD; cannot form a safe patch`);
  }

  const oldPackage = parsedJson(readGitBlob(root, oldCommit, "package.json", 1024 * 1024), "tagged package.json");
  const newPackageBytes = readGitBlob(root, headCommit, "package.json", 1024 * 1024);
  const newPackage = parsedJson(newPackageBytes, "HEAD package.json");
  if (oldPackage.version !== from) throw new Error(`Old version mismatch: tag v${from} contains package.json ${oldPackage.version}`);
  const to = versionParts(newPackage.version).value;
  if (newPackage.version !== to || compareVersions(to, from) <= 0)
    throw new Error(`Candidate HEAD package version ${newPackage.version} must be newer than ${from}`);
  if (toVersion !== null && versionParts(toVersion).value !== to)
    throw new Error(`Target version mismatch: requested ${toVersion} but HEAD package.json is ${to}`);
  if (!onlyVersionChanged(oldPackage, newPackage, from, to))
    throw new Error("Full installer required: package.json changed beyond version (dependencies, Node/runtime, scripts or metadata)");

  const changed = changedEntries(root, oldCommit);
  const files = new Map();
  const casefold = new Map();
  let totalBytes = 0;
  let changedPackage = false;
  for (const change of changed) {
    const source = change.from;
    const destination = change.to;
    if (destination !== null) {
      const a = inspectChangedPath(source, change.status);
      const b = inspectChangedPath(destination, change.status);
      if (a === "ignore" && b === "ignore") continue;
      throw new Error(`Full installer required: renamed/copied source is not supported: ${source} -> ${destination}`);
    }
    const kind = inspectChangedPath(source, change.status);
    if (kind === "ignore") continue;
    if (kind === "lockfile") {
      if (change.status !== "M") throw new Error("Full installer required: package-lock.json was added/deleted/replaced");
      const prior = parsedJson(readGitBlob(root, oldCommit, source, 16 * 1024 * 1024), "tagged package-lock.json");
      const after = parsedJson(readGitBlob(root, headCommit, source, 16 * 1024 * 1024), "HEAD package-lock.json");
      if (!onlyVersionChanged(prior, after, from, to, true))
        throw new Error("Full installer required: package-lock.json dependency tree changed");
      continue; // Installer has runtime node_modules, never ships lockfile.
    }
    if (change.status === "D") throw new Error(`Full installer required: deletion of installed source ${source} (deletes not supported)`);
    if (change.status !== "A" && change.status !== "M")
      throw new Error(`Full installer required: unsupported Git change ${change.status} on ${source}`);
    if (files.size >= MAX_FILE_COUNT) throw new Error(`Patch exceeds ${MAX_FILE_COUNT} files`);
    const folded = source.normalize("NFC").toLowerCase();
    if (casefold.has(folded)) throw new Error(`Case-insensitive archive path collision: ${source} and ${casefold.get(folded)}`);
    casefold.set(folded, source);
    const contents = source === "package.json" ? newPackageBytes : readGitBlob(root, headCommit, source);
    if (contents.length > MAX_FILE_BYTES) throw new Error(`Oversized patch file: ${source}`);
    totalBytes += contents.length;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error(`Patch exceeds ${MAX_TOTAL_BYTES} uncompressed bytes`);
    files.set(source, contents);
    if (source === "package.json") changedPackage = true;
  }
  if (!changedPackage) throw new Error("Updated HEAD package.json must be included in every versioned patch");
  const manifest = { format: "lvl-patch-v1", fromVersion: from, toVersion: to,
    files: [...files].sort(([a], [b]) => a.localeCompare(b, "en")).map(([relative, contents]) =>
      ({ path: relative, sha256: SHA256(contents) })), deletes: [] };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8");
  if (manifestBytes.length > MAX_MANIFEST_BYTES) throw new Error("Oversized update manifest");
  const zip = new AdmZip();
  zip.addFile("manifest.json", manifestBytes);
  for (const item of manifest.files) zip.addFile(item.path, files.get(item.path));
  const zipBytes = zip.toBuffer();
  if (zipBytes.length > MAX_ZIP_BYTES) throw new Error("Compressed patch exceeds safety limit");

  const filename = `LVL-update-v${to}.zip`;
  const checksum = SHA256(zipBytes);
  const destination = path.resolve(outputDir || path.join(root, "dist"));
  const withinRepo = path.relative(root, destination).replaceAll("\\", "/");
  if (!withinRepo || (withinRepo !== ".." && !withinRepo.startsWith("../")
    && /^(?:assets|backend|frontend|learning|shared|launcher|installer|runtime|node_modules|scripts|tests)(?:\/|$)/i.test(withinRepo)))
    throw new Error("Patch output cannot overwrite the repository root or application/installer source directories");
  const archivePath = path.join(destination, filename);
  const checksumPath = `${archivePath}.sha256`;
  if (fs.existsSync(archivePath) || fs.existsSync(checksumPath))
    throw new Error(`Release asset already exists; refusing to overwrite: ${filename}`);
  fs.mkdirSync(destination, { recursive: true });
  const nonce = randomUUID();
  const tempArchive = path.join(destination, `.${filename}.${nonce}.tmp`);
  const tempChecksum = `${tempArchive}.sha256`;
  let wroteArchive = false;
  let wroteChecksum = false;
  try {
    fs.writeFileSync(tempArchive, zipBytes, { flag: "wx" });
    fs.writeFileSync(tempChecksum, `${checksum} *${filename}\n`, { flag: "wx" });
    fs.renameSync(tempArchive, archivePath); wroteArchive = true;
    fs.renameSync(tempChecksum, checksumPath); wroteChecksum = true;
  } catch (error) {
    if (wroteArchive && !wroteChecksum) fs.rmSync(archivePath, { force: true });
    throw error;
  } finally {
    fs.rmSync(tempArchive, { force: true });
    fs.rmSync(tempChecksum, { force: true });
  }
  return { archivePath, checksumPath, checksum, manifest };
}

function cli() {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    const name = ({ "--from": "fromVersion", "--to": "toVersion", "--out": "outputDir",
      "--out-dir": "outputDir", "--root": "repoRoot" })[key];
    if (!name || !args[i + 1] || args[i + 1].startsWith("--") || options[name] !== undefined)
      throw new Error("Usage: node scripts/build-update.mjs --from v0.1.0 [--to 0.1.1] [--out-dir dist] [--root repo]");
    options[name] = args[++i];
  }
  const result = buildUpdate(options);
  console.log(`Built ${path.basename(result.archivePath)} (${result.manifest.files.length} reviewed files)\n${result.checksumPath}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { cli(); } catch (error) { console.error(`LVL patch build rejected: ${error.message}`); process.exitCode = 1; }
}
