import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const mustExist = [
  'LVL.exe', 'installed-app.json', 'server.js', 'app.js', 'index.html',
  'package.json', 'CHANGELOG.md', 'assets/platform/favicon.ico',
  'assets/brand/dark/lvl_app_icon_dark.svg', 'learning/data/manifest.json',
  'runtime/node.exe', 'runtime/LICENSE.txt', 'runtime/update-apply.mjs',
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
  'package-lock.json', 'node_modules-source',
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

export function validatePayload(payload, { checkRuntime = false } = {}) {
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
  const installed = JSON.parse(fs.readFileSync(path.join(root, 'installed-app.json'), 'utf8'));
  assert.equal(installed.appId, 'lvl-public');
  assert.equal(installed.port, 4273);
  assert.equal(installed.installType, 'per-user');
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
  return { files: files.length, version: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version };
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
  console.log('Verified staging payload:', validatePayload(process.argv[2], { checkRuntime: true }));
}
