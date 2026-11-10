import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertFileInventory, assertReleaseVersion, checkedJson, hashFile, listOrdinaryFiles,
  readVersionIdentity, verifyReviewedInputs } from '../scripts/release-provenance.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const mustExist = [
  'LVL.exe', 'installed-app.json', 'server.js', 'app.js', 'index.html',
  'package.json', 'CHANGELOG.md', 'assets/platform/favicon.ico',
  'assets/brand/dark/lvl_app_icon_dark.svg', 'shared/subtitles/subtitle-text.js',
  'runtime/node.exe', 'runtime/LICENSE.txt', 'runtime/update-apply.mjs',
  'runtime/windows-install-transaction.mjs',
  'runtime/FFMPEG_LICENSE.txt', 'runtime/FFPROBE_LICENSE.txt',
  'node_modules/ffmpeg-static/ffmpeg.exe',
  'node_modules/ffprobe-static/bin/win32/x64/ffprobe.exe',
  'THIRD_PARTY_NOTICES.txt',
  // The Comics extension runner (ext-runner/build.mjs) and its own Java runtime.
  'ext-runner/lvl-ext-runner.jar', 'ext-runner/NOTICE.txt',
  'ext-runner/runtime/bin/java.exe', 'ext-runner/runtime/release', 'ext-runner/runtime/legal/java.base/LICENSE',
];

const forbiddenTop = new Set([
  '.git', 'docs', 'devtools', 'tests', 'scripts', 'installer', 'data', '.cos-subagent',
  'package-lock.json', 'node_modules-source', 'learning', 'frontend/learning', 'backend/learning',
]);
const privateFile = /(?:\.sqlite(?:3)?(?:-(?:shm|wal))?|\.db(?:-(?:shm|wal))?|\.log|\.pem|\.p12|\.pfx)$/i;
const dependencyTestFile = /^(?:test(?:[-_.].*)?|.*\.(?:test|spec)\.(?:[cm]?js|tsx?|jsx)|vitest\.config\.[cm]?js)$/i;
const dependencyDevelopmentDir = new Set(['test', 'tests', '__tests__', 'devtools', 'docs', 'benchmarks', 'examples', 'coverage', '.github', '.history']);
// Package docs, type definitions, TypeScript sources and source maps never run.
const dependencyDocumentation = /\.(?:md|markdown|map|d\.[cm]?ts|[cm]?ts)$/i;
const licenceFile = /^(?:licen[sc]e|copying|copyright|notice)(?:[._-].*)?$/i;

function walk(folder, root, files = []) {
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    const absolute = path.join(folder, entry.name);
    const relative = path.relative(root, absolute).replaceAll('\\', '/');
    assert.ok(!entry.isSymbolicLink(), `Symlink in staged installer: ${relative}`);
    if (entry.isDirectory()) walk(absolute, root, files);
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`Unexpected special file in payload: ${relative}`);
  }
  return files;
}

export function validatePayload(payload, { checkRuntime = false, candidateVersion = null,
  reviewedCommit = null, sourceReceipt = null, sourceRoot = ROOT } = {}) {
  const root = path.resolve(payload);
  assert.ok(fs.statSync(root).isDirectory());
  for (const name of forbiddenTop) assert.ok(!fs.existsSync(path.join(root, name)), `Forbidden file/folder in payload: ${name}`);
  const files = walk(root, root);
  for (const relative of mustExist) assert.ok(files.includes(relative), `Missing installer payload input: ${relative}`);
  for (const relative of files) {
    if (relative.startsWith('node_modules/')) {
      const segments = relative.split('/');
      const file = segments.at(-1);
      assert.ok(!segments.slice(2, -1).some((segment) => dependencyDevelopmentDir.has(segment.toLowerCase())),
        `Developer-only npm dependency directory in setup: ${relative}`);
      assert.ok(!dependencyTestFile.test(file), `Dependency test file in setup: ${relative}`);
      assert.ok(!privateFile.test(relative), `Private dependency file in setup: ${relative}`);
      assert.ok(!dependencyDocumentation.test(file) || licenceFile.test(file), `Dependency documentation or typings in setup: ${relative}`);
      const prebuild = segments.indexOf('prebuilds');
      assert.ok(prebuild < 0 || segments[prebuild + 1] === 'win32-x64', `Native build for another platform in setup: ${relative}`);
      continue;
    }
    assert.ok(!privateFile.test(relative), `Private payload file: ${relative}`);
    assert.ok(!relative.startsWith('.'), `Dotfile in payload: ${relative}`);
  }
  assert.equal(fs.readFileSync(path.join(root, 'LVL.exe')).toString('ascii', 0, 2), 'MZ', 'Launcher must be a Windows PE executable');
  assert.equal(fs.readFileSync(path.join(root, 'runtime', 'node.exe')).toString('ascii', 0, 2), 'MZ', 'Node must be a Windows PE executable');
  const installed = checkedJson(path.join(root, 'installed-app.json'));
  const pkg = checkedJson(path.join(root, 'package.json'));
  assertReleaseVersion({ packageVersion: pkg.version, lockVersion: pkg.version,
    lockRootVersion: pkg.version, candidateVersion: candidateVersion || pkg.version, marker: installed });
  const releaseMode = Boolean(candidateVersion || reviewedCommit || sourceReceipt);
  let sourceProof = null;
  if (releaseMode) {
    if (!candidateVersion || !reviewedCommit || !sourceReceipt) {
      throw new Error('Release verification needs candidate version, reviewed commit and source receipt');
    }
    readVersionIdentity(sourceRoot, candidateVersion);
    const receipt = checkedJson(sourceReceipt);
    const expected = verifyReviewedInputs({ root: sourceRoot, reviewedCommit, platform: 'windows' });
    if (receipt.schemaVersion !== 1 || receipt.mode !== 'release' ||
        receipt.platform !== 'windows' || receipt.reviewedCommit !== reviewedCommit ||
        path.resolve(receipt.sourceRoot || '') !== path.resolve(sourceRoot) ||
        JSON.stringify(receipt.appFiles) !== JSON.stringify(expected.appFiles) ||
        JSON.stringify(receipt.inputs) !== JSON.stringify(expected.inputs)) {
      throw new Error('Installer release source receipt does not match reviewed commit');
    }
    // Installed source helpers are copied unchanged from the reviewed commit.
    // They must be bound before generated/runtime files establish the payload
    // inventory, otherwise an altered helper becomes the accepted baseline.
    for (const relative of [...expected.appFiles,
      'runtime/update-apply.mjs', 'runtime/windows-install-transaction.mjs']) {
      const input = expected.inputs.find(entry => entry.path === relative);
      if (!input || !files.includes(relative) || hashFile(path.join(root, relative)) !== input.sha256) {
        throw new Error(`Installer staged app source differs from reviewed commit: ${relative}`);
      }
    }
    sourceProof = { reviewedCommit, sourceInputs: expected.inputs, payload: listOrdinaryFiles(root) };
  }
  if (checkRuntime) {
    const node = path.join(root, 'runtime', 'node.exe');
    const version = execFileSync(node, ['--version'], { encoding: 'utf8', timeout: 10000, windowsHide: true }).trim();
    assert.match(version, /^v22\./, 'Bundled Node runtime must be a tested Node 22 release');
    const arch = execFileSync(node, ['-p', 'process.arch'], { encoding: 'utf8', timeout: 10000, windowsHide: true }).trim();
    assert.equal(arch, 'x64');
    for (const relative of ['server.js', 'app.js']) {
      execFileSync(node, ['--check', path.join(root, relative)], { timeout: 15000, windowsHide: true });
    }
    for (const binary of ['node_modules/ffmpeg-static/ffmpeg.exe', 'node_modules/ffprobe-static/bin/win32/x64/ffprobe.exe']) {
      const versionInfo = execFileSync(path.join(root, binary), ['-version'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
      assert.match(versionInfo, /^ff(?:mpeg|probe) version/im);
    }
    checkRunner(root);
  }
  assert.ok(files.filter((file) => /^ext-runner\/lib\/[^/]+\.jar$/.test(file)).length >= 40, 'The extension runner needs its library jars');
  return { files: files.length, version: pkg.version, ...(sourceProof ? { provenance: sourceProof } : {}) };
}

export function recheckReleasePayload(payload, receiptFile, { reviewedCommit, candidateVersion }) {
  const receipt = checkedJson(receiptFile);
  if (receipt.schemaVersion !== 1 || receipt.mode !== 'release' || receipt.platform !== 'windows' ||
      receipt.reviewedCommit !== reviewedCommit || receipt.candidateVersion !== candidateVersion) {
    throw new Error('Windows post-compilation release receipt identity mismatch');
  }
  assertFileInventory(path.resolve(payload), receipt.generatedPayload);
  return { reviewedCommit, candidateVersion, generatedFiles: receipt.generatedPayload.length };
}

// The bundled runner is Eclipse Temurin 21 (its licence allows shipping the jlink
// runtime) and starts: it answers {"ready":true}, then quits when its input closes.
function checkRunner(root) {
  const runner = path.join(root, 'ext-runner');
  const java = path.join(runner, 'runtime', 'bin', 'java.exe');
  const settings = spawnSync(java, ['-XshowSettings:properties', '-version'], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  const output = `${settings.stderr}${settings.stdout}`;
  assert.match(output, /^\s+java\.vendor = Eclipse Adoptium\r?$/m, 'The runner runtime must be Eclipse Temurin');
  assert.match(output, /^\s+java\.runtime\.version = 21\./m, 'The runner runtime must be Java 21');
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'lvl-verify-runner-'));
  try {
    const started = spawnSync(java, ['-Xmx384m', '-cp', `${path.join(runner, 'lvl-ext-runner.jar')}${path.delimiter}${path.join(runner, 'lib', '*')}`,
      'lvl.runner.MainKt', '--data', data], { input: '', encoding: 'utf8', timeout: 120000, windowsHide: true });
    assert.equal(started.status, 0, `The extension runner didn't start: ${String(started.stderr || started.error || '').slice(-400)}`);
    assert.match(started.stdout, /^\{"ready":true/m, 'The extension runner must answer ready');
  } finally {
    fs.rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Usage: node installer/verify.mjs <payload>');
  const argv = process.argv.slice(3);
  const options = { checkRuntime: true };
  let outputReceipt = null;
  let existingReceipt = null;
  for (let i = 0; i < argv.length; i += 2) {
    if (i + 1 >= argv.length) throw new Error('Missing release validation option value');
    const flag = argv[i];
    if (flag === '--candidate-version') options.candidateVersion = argv[i + 1];
    else if (flag === '--reviewed-commit') options.reviewedCommit = argv[i + 1];
    else if (flag === '--source-receipt') options.sourceReceipt = argv[i + 1];
    else if (flag === '--output-receipt') outputReceipt = argv[i + 1];
    else if (flag === '--recheck-receipt') existingReceipt = argv[i + 1];
    else throw new Error(`Unexpected payload verification option: ${flag}`);
  }
  if (existingReceipt) {
    if (!options.reviewedCommit || !options.candidateVersion || options.sourceReceipt || outputReceipt) {
      throw new Error('Post-compilation release check requires reviewed commit, candidate version and only existing receipt');
    }
    console.log('Verified unchanged compiled release inputs:', recheckReleasePayload(
      process.argv[2], existingReceipt, options));
    process.exit(0);
  }
  if (Boolean(outputReceipt) !== Boolean(options.reviewedCommit)) {
    throw new Error('Windows release verification requires an output receipt');
  }
  const result = validatePayload(process.argv[2], options);
  if (outputReceipt) {
    const receipt = { schemaVersion: 1, platform: 'windows', mode: 'release',
      reviewedCommit: options.reviewedCommit, candidateVersion: options.candidateVersion,
      sourceInputs: result.provenance.sourceInputs, generatedPayload: result.provenance.payload };
    fs.writeFileSync(outputReceipt, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  }
  console.log('Verified staging payload:', { files: result.files, version: result.version,
    ...(result.provenance ? { reviewedCommit: result.provenance.reviewedCommit } : { mode: 'development' }) });
}
