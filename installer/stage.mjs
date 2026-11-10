// Positive release-file enumeration. No repository recursion into .git,
// tests, docs, devtools, user data, or locally installed npm dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSetupSourceFile } from '../scripts/release-inputs.mjs';
import { verifyReviewedInputs, hashFile } from '../scripts/release-provenance.mjs';

const sourceRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const roots = Object.freeze(['assets', 'backend', 'frontend', 'shared']);
const entries = Object.freeze(['app.js', 'index.html', 'server.js', 'package.json', 'CHANGELOG.md']);
const sourceHelpers = Object.freeze(['runtime/update-apply.mjs', 'runtime/windows-install-transaction.mjs']);

function readChildren(root, relative, files) {
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (!isSetupSourceFile(child)) continue;
    if (entry.isSymbolicLink()) throw new Error(`Refusing symbolic link in release inputs: ${child}`);
    if (entry.isDirectory()) readChildren(root, child, files);
    else if (entry.isFile()) files.push(child);
    else throw new Error(`Refusing special file in release inputs: ${child}`);
  }
}

export function releaseSourceFiles(root = sourceRoot) {
  const selected = [];
  for (const entry of entries) {
    if (!isSetupSourceFile(entry) || !fs.lstatSync(path.join(root, entry)).isFile() ||
        fs.lstatSync(path.join(root, entry)).isSymbolicLink()) {
      throw new Error(`Missing or disallowed essential source: ${entry}`);
    }
    selected.push(entry);
  }
  for (const directory of roots) {
    if (!fs.statSync(path.join(root, directory)).isDirectory()) throw new Error(`Missing release source: ${directory}`);
    readChildren(root, directory, selected);
  }
  return selected.sort();
}

export function stageReleaseSources(root, destination, { reviewedCommit = null, receiptPath = null,
  extraPaths = null } = {}) {
  if (Boolean(reviewedCommit) !== Boolean(receiptPath)) {
    throw new Error('Release staging requires both reviewed commit and receipt destination');
  }
  const proof = reviewedCommit ? verifyReviewedInputs({ root, reviewedCommit, platform: 'windows', extraPaths }) : null;
  const paths = proof ? proof.appFiles : releaseSourceFiles(root);
  const helpers = proof ? sourceHelpers.filter(relative => proof.inputs.some(item => item.path === relative)) : [];
  if (proof && extraPaths === null && helpers.length !== sourceHelpers.length) {
    throw new Error('Release proof does not include both installed runtime helpers');
  }
  fs.mkdirSync(destination, { recursive: true });
  for (const relative of [...paths, ...helpers]) {
    const output = path.join(destination, relative);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.copyFileSync(path.join(root, relative), output, fs.constants.COPYFILE_EXCL);
    if (proof) {
      const expected = proof.inputs.find(item => item.path === relative);
      if (hashFile(output) !== expected.sha256) throw new Error(`Staged source changed during copying: ${relative}`);
    }
  }
  if (proof) {
    // Catch a source write that races the snapshot while files are being copied.
    verifyReviewedInputs({ root, reviewedCommit, platform: 'windows', extraPaths });
    const receipt = { ...proof, sourceRoot: path.resolve(root), stagedSourceFiles: paths.length + helpers.length };
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  }
  return paths;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const release = argv[0] === '--release';
  const destination = release ? argv[5] : argv[0];
  if ((release && (argv.length !== 6 || argv[1] !== '--reviewed-commit' || argv[3] !== '--receipt')) ||
      (!release && argv.length !== 1) || !destination) {
    throw new Error('Usage: node installer/stage.mjs [--release --reviewed-commit <full-id> --receipt <file>] <empty payload dir>');
  }
  const real = path.resolve(destination);
  if (real === sourceRoot || !real.startsWith(sourceRoot + path.sep)) {
    throw new Error('Release staging must remain in the current checkout');
  }
  if (fs.existsSync(real) && fs.readdirSync(real).length) throw new Error('Release stage must start empty');
  const selected = stageReleaseSources(sourceRoot, real,
    release ? { reviewedCommit: argv[2], receiptPath: path.resolve(argv[4]) } : {});
  console.log(release ? `Staged ${selected.length} app files verified against ${argv[2]}.`
    : `Development staging: ${selected.length} app files; no release provenance.`);
}
