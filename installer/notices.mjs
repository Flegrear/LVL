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

export function makeNotices(payload) {
  const packages = [];
  packagesInside(path.join(payload, 'node_modules'), packages);
  if (packages.length < 5) throw new Error('Production dependencies were not installed before license generation.');
  const content = [
    'LVL — third-party dependency notices',
    'This file records the packages bundled with the installed application.',
    'Package-local LICENSE/NOTICE/COPYING files are kept alongside each dependency.',
    'Node runtime, FFmpeg and FFprobe have separate license texts under runtime/.',
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
