// Release source proofs are derived from the reviewed Git commit, never the
// mutable index or the set of paths currently visible in a working directory.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isSetupSourceFile, isRunnerReleaseSourceFile,
  requiredRunnerBuildEntries, reviewedAndroidReleaseFiles } from './release-inputs.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const REQUIRED_APP = Object.freeze(['app.js', 'index.html', 'server.js', 'package.json', 'CHANGELOG.md']);
const WINDOWS_BUILD = Object.freeze([
  'package-lock.json', 'launcher/Launcher.cs', 'launcher/LvlUpdater.cs',
  'launcher/LvlPopup.cs', 'runtime/update-apply.mjs',
  'runtime/windows-install-transaction.mjs', 'installer/notices.mjs',
  'installer/setup.iss', 'installer/build.ps1', 'installer/stage.mjs',
  'installer/verify.mjs', 'scripts/release-inputs.mjs',
  'scripts/release-provenance.mjs', 'scripts/release-gates.mjs',
]);
const ANDROID_BUILD = Object.freeze([
  'package-lock.json', 'runtime/update-apply.mjs',
  'runtime/windows-install-transaction.mjs',
  'scripts/release-inputs.mjs', 'scripts/release-provenance.mjs',
  'scripts/release-gates.mjs',
  ...reviewedAndroidReleaseFiles,
]);

export const sha256Bytes = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
export function hashFile(file) { return sha256Bytes(fs.readFileSync(file)); }

function git(root, args, encoding = 'utf8') {
  return execFileSync('git', ['-C', root, ...args], {
    encoding, windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 20_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function ordinary(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.startsWith('/') ||
      relative.includes('\\') || relative.split('/').some(v => !v || v === '.' || v === '..')) {
    throw new Error(`Unsafe release source path: ${relative}`);
  }
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat || stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
      throw new Error(`Missing, linked or special release source: ${relative}`);
    }
  }
  if (!fs.lstatSync(current).isFile()) throw new Error(`Release source is not a file: ${relative}`);
  return current;
}

function actualApplicationFiles(root) {
  const found = [];
  for (const name of [...REQUIRED_APP]) {
    const absolute = path.join(root, name);
    if (fs.existsSync(absolute)) found.push(name);
  }
  function walk(relative) {
    const absolute = path.join(root, relative);
    const stat = fs.lstatSync(absolute, { throwIfNoEntry: false });
    if (!stat) return;
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
      if (isSetupSourceFile(relative)) throw new Error(`Linked/special installed input: ${relative}`);
      return;
    }
    if (stat.isFile()) {
      if (isSetupSourceFile(relative)) found.push(relative);
      return;
    }
    for (const entry of fs.readdirSync(absolute)) {
      const child = `${relative}/${entry}`;
      if (entry.startsWith('.') || !isSetupSourceFile(`${child}/probe`)) {
        if (isSetupSourceFile(child)) walk(child);
        continue;
      }
      walk(child);
    }
  }
  for (const directory of ['assets', 'backend', 'frontend', 'shared']) walk(directory);
  return [...new Set(found)].sort();
}

function actualRunnerSources(root) {
  const src = path.join(root, 'ext-runner/src/main');
  const found = [];
  if (fs.existsSync(src)) for (const entry of listOrdinaryFiles(src)) {
    const relative = `ext-runner/src/main/${entry.path}`;
    if (isRunnerReleaseSourceFile(relative)) found.push(relative);
    else throw new Error(`Unreviewed extension runner source: ${relative}`);
  }
  return found;
}

export function assertApprovedAndroidCompileInputs(root, reviewedPaths, allowed) {
  const allowedSet = new Set(allowed);
  for (const relative of reviewedPaths) {
    if (relative.startsWith('android/') && !allowedSet.has(relative)) {
      throw new Error(`Android commit contains unapproved release input: ${relative}`);
    }
  }
  for (const directory of ['android/app/src/main', 'android/app/src/release', 'android/app/libs']) {
    const sourceRoot = path.join(root, directory);
    if (!fs.existsSync(sourceRoot)) continue;
    for (const entry of listOrdinaryFiles(sourceRoot)) {
      const relative = `${directory}/${entry.path}`;
      if (!allowedSet.has(relative)) throw new Error(`Unreviewed Android compile input: ${relative}`);
    }
  }
}

function commitEntries(root, commit) {
  if (!/^[0-9a-f]{40,64}$/i.test(commit || '')) throw new Error('Explicit full reviewed commit ID required');
  const resolved = git(root, ['rev-parse', '--verify', `${commit}^{commit}`]).trim();
  if (resolved.toLowerCase() !== commit.toLowerCase()) throw new Error('Reviewed commit is not an exact commit ID');
  const objectFormat = git(root, ['rev-parse', '--show-object-format']).trim();
  if (!['sha1', 'sha256'].includes(objectFormat)) throw new Error('Unsupported Git object format');
  const output = git(root, ['ls-tree', '-r', '-z', '--full-tree', commit], 'buffer');
  const entries = new Map();
  for (const raw of output.toString('utf8').split('\0').filter(Boolean)) {
    const match = /^(\d+) (blob|commit) ([0-9a-f]+)\t(.+)$/s.exec(raw);
    if (!match || entries.has(match[4])) throw new Error('Malformed reviewed Git tree entry');
    entries.set(match[4], { mode: match[1], kind: match[2], oid: match[3] });
  }
  return { entries, objectFormat, commit: resolved };
}

export function verifyReviewedInputs({ root = ROOT, reviewedCommit, platform = 'windows',
  extraPaths = null, requireAppRoots = true } = {}) {
  root = path.resolve(root);
  if (!['windows', 'android'].includes(platform)) throw new Error('Invalid release platform');
  const { entries, objectFormat, commit } = commitEntries(root, reviewedCommit);
  const appFiles = [...entries.keys()].filter(isSetupSourceFile).sort();
  for (const required of REQUIRED_APP) {
    if (!appFiles.includes(required)) throw new Error(`Reviewed commit lacks required source: ${required}`);
  }
  if (requireAppRoots) for (const prefix of ['assets/', 'backend/', 'frontend/', 'shared/']) {
    if (!appFiles.some(p => p.startsWith(prefix))) throw new Error(`Reviewed commit lacks installed source root: ${prefix}`);
  }
  const actual = actualApplicationFiles(root);
  for (const relative of actual) if (!appFiles.includes(relative)) {
    throw new Error(`Unreviewed installed input in working tree: ${relative}`);
  }
  const runnerFiles = extraPaths !== null ? [] : [...entries.keys()].filter(isRunnerReleaseSourceFile);
  if (extraPaths === null) {
    for (const required of requiredRunnerBuildEntries) {
      if (!runnerFiles.includes(required)) throw new Error(`Reviewed commit lacks extension runner input: ${required}`);
    }
    for (const local of actualRunnerSources(root)) if (!runnerFiles.includes(local)) {
      throw new Error(`Unreviewed extension runner input: ${local}`);
    }
    if (platform === 'android') assertApprovedAndroidCompileInputs(root, entries.keys(), reviewedAndroidReleaseFiles);
  }
  const additional = extraPaths ?? (platform === 'windows' ? WINDOWS_BUILD : ANDROID_BUILD);
  const selected = [...new Set([...appFiles, ...additional, ...runnerFiles])].sort();
  const inventory = [];
  for (const relative of selected) {
    const entry = entries.get(relative);
    if (!entry || entry.kind !== 'blob' || !['100644', '100755'].includes(entry.mode)) {
      throw new Error(`Missing, linked or special file in reviewed commit: ${relative}`);
    }
    const bytes = fs.readFileSync(ordinary(root, relative));
    const objectId = crypto.createHash(objectFormat)
      .update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if (objectId !== entry.oid) throw new Error(`Release input differs from reviewed commit: ${relative}`);
    inventory.push({ path: relative, blob: entry.oid, sha256: sha256Bytes(bytes), bytes: bytes.length });
  }
  return { schemaVersion: 1, mode: 'release', platform, reviewedCommit: commit,
    objectFormat, appFiles, inputs: inventory };
}

export function assertReleaseVersion({ packageVersion, lockVersion, lockRootVersion,
  candidateVersion, marker = null, platform = 'windows' }) {
  for (const [key, value] of Object.entries({ packageVersion, lockVersion, lockRootVersion, candidateVersion })) {
    if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
      throw new Error(`Invalid ${key} release version`);
    }
  }
  if (packageVersion !== lockVersion || packageVersion !== lockRootVersion ||
      packageVersion !== candidateVersion) throw new Error('Package, lockfile and candidate release versions disagree');
  if (marker !== null) {
    if (platform !== 'windows' || !marker || typeof marker !== 'object' || Array.isArray(marker) ||
        marker.schemaVersion !== 1 || marker.appId !== 'lvl-public' || marker.port !== 4273 ||
        marker.installType !== 'per-user' || marker.version !== candidateVersion ||
        marker.dataRoot !== '%LOCALAPPDATA%\\LVL\\data' ||
        marker.browserProfile !== '%LOCALAPPDATA%\\LVL\\browser-profile') {
      throw new Error('Installed marker identity or version disagrees with Windows release');
    }
  }
  return candidateVersion;
}

export function checkedJson(file) {
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error(`Malformed release metadata: ${file}`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid release metadata object: ${file}`);
  return value;
}

export function readVersionIdentity(root, candidateVersion, platform = 'windows') {
  const pkg = checkedJson(path.join(root, 'package.json'));
  const locked = checkedJson(path.join(root, 'package-lock.json'));
  return assertReleaseVersion({ packageVersion: pkg.version, lockVersion: locked.version,
    lockRootVersion: locked.packages?.['']?.version, candidateVersion, platform });
}

export function listOrdinaryFiles(root) {
  if (!fs.lstatSync(root, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Missing inventory root: ${root}`);
  const entries = [];
  function walk(absolute, relative) {
    for (const ent of fs.readdirSync(absolute, { withFileTypes: true })) {
      const rel = relative ? `${relative}/${ent.name}` : ent.name;
      if (ent.isSymbolicLink()) throw new Error(`Linked generated release file: ${rel}`);
      if (ent.isDirectory()) walk(path.join(absolute, ent.name), rel);
      else if (ent.isFile()) {
        const file = path.join(absolute, ent.name);
        const stat = fs.statSync(file);
        entries.push({ path: rel, sha256: hashFile(file), bytes: stat.size });
      } else throw new Error(`Special generated release file: ${rel}`);
    }
  }
  walk(root, '');
  return entries.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

export function assertFileInventory(root, inventory, { exclusions = [] } = {}) {
  if (!Array.isArray(inventory) || !inventory.every(entry => entry && typeof entry.path === 'string' &&
    /^[a-f\d]{64}$/.test(entry.sha256) && Number.isSafeInteger(entry.bytes) && entry.bytes >= 0)) {
    throw new Error('Malformed release hash inventory');
  }
  const current = listOrdinaryFiles(root).filter(entry => !exclusions.includes(entry.path));
  if (JSON.stringify(current) !== JSON.stringify(inventory)) throw new Error(`Generated stage inventory mismatch: ${root}`);
  return current;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const argv = process.argv.slice(2);
    if (argv[0] !== 'verify' || argv.length !== 7 || argv[1] !== '--platform' ||
        argv[3] !== '--reviewed-commit' || argv[5] !== '--version') {
      throw new Error('Usage: node scripts/release-provenance.mjs verify --platform windows|android --reviewed-commit <full-id> --version X.Y.Z');
    }
    const [platform, reviewedCommit, candidateVersion] = [argv[2], argv[4], argv[6]];
    const proof = verifyReviewedInputs({ reviewedCommit, platform });
    if (platform === 'windows') readVersionIdentity(ROOT, candidateVersion);
    else {
      const configured = checkedJson(path.join(ROOT, 'android/app-version.json'));
      if (configured.version !== candidateVersion) throw new Error('Android candidate release version disagreement');
      const desktop = checkedJson(path.join(ROOT, 'package.json'));
      if (desktop.version !== configured.desktopSourceVersion) throw new Error('Android desktop source version disagreement');
      readVersionIdentity(ROOT, desktop.version, 'android');
    }
    console.log(JSON.stringify({ reviewedCommit: proof.reviewedCommit, platform,
      sourceInputs: proof.inputs.length, candidateVersion }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
