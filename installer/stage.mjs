// Positive release-file enumeration. No repository recursion into .git,
// tests, docs, devtools, user data, or locally installed npm dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSetupSourceFile } from '../scripts/release-inputs.mjs';

const sourceRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const roots = Object.freeze(['assets', 'backend', 'frontend', 'learning', 'shared']);
const entries = Object.freeze(['app.js', 'index.html', 'server.js', 'package.json', 'CHANGELOG.md']);

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
    if (!isSetupSourceFile(entry) || !fs.statSync(path.join(root, entry)).isFile()) {
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

export function stageReleaseSources(root, destination) {
  const paths = releaseSourceFiles(root);
  fs.mkdirSync(destination, { recursive: true });
  for (const relative of paths) {
    const output = path.join(destination, relative);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.copyFileSync(path.join(root, relative), output, fs.constants.COPYFILE_EXCL);
  }
  return paths;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destination = process.argv[2];
  if (!destination) throw new Error('Usage: node installer/stage.mjs <empty payload dir>');
  const real = path.resolve(destination);
  if (real === sourceRoot || !real.startsWith(sourceRoot + path.sep)) {
    throw new Error('Release staging must remain in the current checkout');
  }
  if (fs.existsSync(real) && fs.readdirSync(real).length) throw new Error('Release stage must start empty');
  const selected = stageReleaseSources(sourceRoot, real);
  console.log(`Staged ${selected.length} reviewed app source files.`);
}
