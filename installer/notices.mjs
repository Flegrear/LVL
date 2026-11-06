import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const licenseName = /^(?:licen[sc]e|copying|copyright|notice)(?:[._-].*)?$/i;

function packagesInside(folder, result) {
  if (!fs.existsSync(folder)) return;
  for (const child of fs.readdirSync(folder, { withFileTypes: true })) {
    if (!child.isDirectory()) continue;
    const absolute = path.join(folder, child.name);
    if (child.name.startsWith('@')) {
      packagesInside(absolute, result);
      continue;
    }
    const manifest = path.join(absolute, 'package.json');
    if (fs.existsSync(manifest)) {
      const metadata = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      const licenses = fs.readdirSync(absolute, { withFileTypes: true })
        .filter((entry) => entry.isFile() && licenseName.test(entry.name))
        .map((entry) => path.join(absolute, entry.name));
      result.push({ name: metadata.name, version: metadata.version, license: metadata.license, root: absolute, licenses });
      packagesInside(path.join(absolute, 'node_modules'), result);
    }
  }
}

function binaryLicense(executable, destination, label) {
  const version = execFileSync(executable, ['-version'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
  const license = execFileSync(executable, ['-L'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
  // FFmpeg's `-L` spells out "GNU General Public License"; it does not
  // necessarily include the abbreviations GPL or LGPL. Match the actual
  // complete terms so valid GPLv3 binaries still get auditable notices.
  if (!version || !license || !/(?:\b(?:L?GPL)\b|GNU\s+(?:Lesser\s+)?General\s+Public\s+License)/i.test(license)) {
    throw new Error(`No auditable ${label} license output`);
  }
  fs.writeFileSync(destination, `${label} bundled executable\n\n${version}\n\n${license}\n\nSource: https://ffmpeg.org/download.html\nLicensing: https://ffmpeg.org/legal.html\n`);
}

// The file names inside a zip file (a jar), read from its central directory.
export function zipEntryNames(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const tail = Buffer.alloc(Math.min(size, 65557));
    fs.readSync(fd, tail, 0, tail.length, size - tail.length);
    let end = -1;
    for (let at = tail.length - 22; at >= 0; at -= 1) if (tail.readUInt32LE(at) === 0x06054b50) { end = at; break; }
    if (end < 0) throw new Error(`Not a zip file: ${file}`);
    const count = tail.readUInt16LE(end + 10);
    const length = tail.readUInt32LE(end + 12);
    const offset = tail.readUInt32LE(end + 16);
    if (count === 0xffff || length === 0xffffffff || offset === 0xffffffff) throw new Error(`ZIP64 files aren't supported: ${file}`);
    const directory = Buffer.alloc(length);
    fs.readSync(fd, directory, 0, length, offset);
    const names = [];
    for (let at = 0; at + 46 <= length && directory.readUInt32LE(at) === 0x02014b50;) {
      const nameLength = directory.readUInt16LE(at + 28);
      names.push(directory.toString('utf8', at + 46, at + 46 + nameLength));
      at += 46 + nameLength + directory.readUInt16LE(at + 30) + directory.readUInt16LE(at + 32);
    }
    if (names.length !== count) throw new Error(`Unreadable zip directory: ${file}`);
    return names;
  } finally {
    fs.closeSync(fd);
  }
}

// The Comics extension runner in ext-runner/: its own notice, the Java runtime's
// notices, and each library jar with the licence files inside it (most jars have none).
export function runnerNotices(payload) {
  const runner = path.join(payload, 'ext-runner');
  for (const required of ['NOTICE.txt', 'lvl-ext-runner.jar', path.join('runtime', 'legal')]) {
    if (!fs.existsSync(path.join(runner, required))) throw new Error(`The extension runner in the payload is missing ${required}`);
  }
  const jars = fs.readdirSync(path.join(runner, 'lib')).filter((name) => name.endsWith('.jar')).sort((a, b) => a.localeCompare(b));
  if (!jars.length) throw new Error('The extension runner in the payload has no libraries');
  const lines = [
    'LVL extension runner (Comics), installed in ext-runner/',
    'Full notice: ext-runner/NOTICE.txt (code from Suwayomi-Server under the MPL-2.0 and the Apache License 2.0)',
    'Java runtime: ext-runner/runtime/, made with jlink from Eclipse Temurin (OpenJDK), GPLv2 with the Classpath Exception',
    'Full notice: ext-runner/runtime/legal/',
    '',
    `Libraries in ext-runner/lib/ (${jars.length}):`,
  ];
  for (const jar of jars) {
    const licences = zipEntryNames(path.join(runner, 'lib', jar)).filter((name) => (!name.includes('/') || name.startsWith('META-INF/'))
      && !name.endsWith('/') && !name.endsWith('.class') && licenseName.test(name.split('/').at(-1)));
    lines.push(jar);
    for (const name of licences) lines.push(`Full notice: ext-runner/lib/${jar}!/${name}`);
    if (!licences.length) lines.push('No license text included in the jar; review upstream metadata before distribution.');
    lines.push('');
  }
  return lines;
}

export function makeNotices(payload) {
  const packages = [];
  packagesInside(path.join(payload, 'node_modules'), packages);
  if (packages.length < 5) throw new Error('Production dependencies were not installed before license generation.');
  const content = [
    'LVL — third-party dependency notices',
    'LVL original application code: GPL-3.0-or-later; full terms and scope in assets/licenses/.',
    'This file records the packages bundled with the installed application.',
    'Package-local LICENSE/NOTICE/COPYING files are kept alongside each dependency.',
    'Node runtime, FFmpeg and FFprobe have separate license texts under runtime/.',
    'The Comics extension runner and its libraries are listed at the end.',
    '',
  ];
  for (const pkg of packages.sort((a, b) => a.name.localeCompare(b.name))) {
    content.push(`${pkg.name}@${pkg.version}`, `License declaration: ${typeof pkg.license === 'string' ? pkg.license : JSON.stringify(pkg.license ?? 'see upstream package')}`);
    for (const file of pkg.licenses) {
      const relative = path.relative(payload, file).replaceAll('\\', '/');
      content.push(`Full notice: ${relative}`);
    }
    if (!pkg.licenses.length) content.push('No license text included by package author; review upstream metadata before distribution.');
    content.push('');
  }
  content.push(...runnerNotices(payload));
  const output = path.join(payload, 'THIRD_PARTY_NOTICES.txt');
  fs.writeFileSync(output, content.join('\n') + '\n');
  binaryLicense(path.join(payload, 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'), path.join(payload, 'runtime', 'FFMPEG_LICENSE.txt'), 'FFmpeg');
  binaryLicense(path.join(payload, 'node_modules', 'ffprobe-static', 'bin', 'win32', 'x64', 'ffprobe.exe'), path.join(payload, 'runtime', 'FFPROBE_LICENSE.txt'), 'FFprobe');
  return { packages: packages.length, noticePath: output };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const payload = process.argv[2];
  if (!payload) throw new Error('Usage: node installer/notices.mjs <payload>');
  const result = makeNotices(path.resolve(payload));
  console.log(`Wrote notices for ${result.packages} packages: ${result.noticePath}`);
}
