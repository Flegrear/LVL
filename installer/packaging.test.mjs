import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseSourceFiles, stageReleaseSources } from './stage.mjs';
import { validatePayload } from './verify.mjs';

const installerDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(installerDir);
const setup = fs.readFileSync(path.join(installerDir, 'setup.iss'), 'utf8');
const script = fs.readFileSync(path.join(installerDir, 'build.ps1'), 'utf8');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');
const updater = fs.readFileSync(path.join(root, 'launcher/LvlUpdater.cs'), 'utf8');

test('setup is public Alpha 0.1, preserves private install and deletes stray development folders on upgrade', () => {
  assert.match(setup, /AppId=\{\{D3C04C52-7A8E-4DC7-9B0A-1EAF4B4A8B8B\}/);
  assert.doesNotMatch(setup, /BDBEA73B-33B5-4DC7-8509-AF6A4FD5173B/i);
  assert.match(setup, /DefaultDirName=\{localappdata\}\\Programs\\LVL/);
  assert.match(setup, /PrivilegesRequired=lowest/);
  assert.match(setup, /Parameters: "--port 4273"/);
  assert.match(setup, /OutputBaseFilename=LVL-Setup(?:\r?\n|$)/);
  assert.match(setup, /#define LauncherName "LVL\.exe"/, 'installer and installed launcher must have distinct names');
  for (const dir of ['tests', 'devtools', 'docs']) {
    assert.ok(setup.includes('Type: filesandordirs; Name: "{app}\\' + dir + '"'), 'Upgrade must delete only public app ' + dir);
  }
  for (const dir of ['assets', 'backend', 'frontend', 'learning', 'shared']) {
    assert.ok(setup.includes('Type: filesandordirs; Name: "{app}\\' + dir + '"'),
      'Uninstall must clean source files added by incremental updates: ' + dir);
  }
  assert.match(setup, /Get-CimInstance Win32_Process/);
  assert.match(setup, /RestartAfterAutomaticUpgrade/);
  assert.match(setup, /\{param:LVLRestart\|0\}/);
  assert.match(setup, /--background --port 4273/);
  assert.match(setup, /\[IO\.Path\]::GetFullPath\(\$_\.ExecutablePath\)/);
  assert.match(setup, /& \$target --quit --port 4273/);
});

test('builder selects only positive source files, includes checked runtime and notices', () => {
  assert.match(script, /stage\.mjs/);
  assert.match(script, /verify\.mjs/);
  assert.match(script, /notices\.mjs/);
  assert.match(script, /npm ci --omit=dev/);
  assert.match(script, /nodeHash = '[0-9a-f]{64}'/);
  assert.match(script, /Assert-Hash \$part \$Expected/);
  assert.match(script, /installed-app\.json/);
  assert.match(script, /LvlUpdater\.cs/);
  assert.match(script, /Get-Command node.exe/);
  assert.match(script, /Write-Host "Built LVL setup v\$\(\$package\.version\): \$setupExe"/);
  assert.match(script, /\$setupExe = Join-Path \$distRoot 'LVL-Setup\.exe'/);
  assert.match(script, /LVL-Setup\.exe\.sha256/, 'build must generate the new installer checksum');
  assert.match(script, /runtime\\update-apply\.mjs/);
  assert.match(script, /Launcher-stamped\.cs/);
});

test('one canonical LVL-Setup.exe release asset and distinct installed LVL.exe launcher', () => {
  assert.match(setup, /#define LauncherName "LVL\.exe"/);
  assert.match(setup, /^OutputBaseFilename=LVL-Setup\s*$/m);
  assert.match(script, /\$setupExe = Join-Path \$distRoot 'LVL-Setup\.exe'/);
  assert.match(script, /LVL-Setup\.exe\.sha256/);
  assert.match(script, /'LVL\.exe', 'LVL\.exe\.sha256', 'LVL-Setup\.exe', 'LVL-Setup\.exe\.sha256'/,
    'builder must clean stale artifacts from old naming schemes');
  assert.match(workflow, /Test-Path dist\/LVL-Setup\.exe/);
  assert.doesNotMatch(workflow, /Copy-Item dist\/LVL\.exe/,
    'GitHub Releases must not publish a second installer under the internal launcher name');
  assert.match(updater, /name\.Equals\("LVL-Setup\.exe", StringComparison\.OrdinalIgnoreCase\)/);
  assert.doesNotMatch(updater, /name\.Equals\("LVL\.exe", StringComparison\.OrdinalIgnoreCase\)/);
});

test('source enumeration excludes devtools, docs, tests, generators, caches and private data', () => {
  const files = releaseSourceFiles(root);
  assert.ok(files.length > 60);
  assert.ok(files.includes('server.js'));
  assert.ok(files.includes('learning/presets.js'));
  assert.ok(files.includes('learning/data/NOTICE.md'), 'Data attribution is preserved');
  assert.ok(files.includes('assets/platform/site.webmanifest'));
  for (const file of files) {
    assert.doesNotMatch(file, /^(?:docs|devtools|tests|scripts|installer|data|node_modules)\//);
    assert.doesNotMatch(file, /(?:\.mjs|\.log|\.db|\.sqlite3)$/);
  }
  assert.ok(!files.includes('learning/build-presets.mjs'));
  assert.ok(!files.some((item) => item.includes('run-synthetic-subtitle')));
});

test('stage copy from a fake repository rejects unrelated files and symlinks', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lvl-install-stage-test-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const input = path.join(temp, 'source');
  const output = path.join(temp, 'payload');
  for (const rootFile of ['app.js', 'index.html', 'server.js', 'package.json', 'CHANGELOG.md']) {
    fs.mkdirSync(input, { recursive: true });
    fs.writeFileSync(path.join(input, rootFile), rootFile);
  }
  for (const folder of ['assets', 'backend', 'frontend', 'learning', 'shared']) {
    fs.mkdirSync(path.join(input, folder), { recursive: true });
    fs.writeFileSync(path.join(input, folder, 'live.js'), folder);
  }
  for (const folder of ['tests', 'devtools', 'docs', 'scripts']) {
    fs.mkdirSync(path.join(input, folder));
    fs.writeFileSync(path.join(input, folder, 'secret.js'), 'private');
  }
  const selected = stageReleaseSources(input, output);
  assert.equal(selected.length, 10);
  assert.ok(fs.existsSync(path.join(output, 'learning', 'live.js')));
  assert.ok(!fs.existsSync(path.join(output, 'tests')));
  assert.ok(!fs.existsSync(path.join(output, 'devtools')));
  assert.ok(!fs.existsSync(path.join(output, 'docs')));
  assert.ok(!fs.existsSync(path.join(output, 'scripts')));
});

test('payload verifier detects forbidden root folders and missing binary', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lvl-install-verify-test-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  assert.throws(() => validatePayload(temp), /Missing installer payload input/);
  fs.mkdirSync(path.join(temp, 'tests'));
  assert.throws(() => validatePayload(temp), /Forbidden file\/folder.*tests/);
});
