// Checks the native input and staged Android payload before any signed APK build.
// No build, staging, network access or installation is performed here.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import { assertFileInventory, checkedJson, hashFile, listOrdinaryFiles,
  readVersionIdentity, verifyReviewedInputs } from "../../scripts/release-provenance.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const ABIS = ["arm64-v8a", "x86_64"];
const ELF_MACHINE = { "arm64-v8a": 183, x86_64: 62 };
const TOOLS = [["node", "node", "libnode_exec.so"], ["ffmpeg", "ffmpeg", "libffmpeg_exec.so"], ["ffmpeg", "ffprobe", "libffprobe_exec.so"]];
const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const fail = (message) => { throw new Error(`Android release: ${message}`); };

export function verifyPinnedExtensionSource(projectRoot = ROOT) {
  const pin = checkedJson(path.join(projectRoot, 'ext-runner', 'suwayomi.json'));
  if (typeof pin.commit !== 'string' || !/^[0-9a-f]{40}$/.test(pin.commit)) {
    fail('invalid pinned extension API source commit');
  }
  const checkout = path.join(projectRoot, 'ext-runner', '.vendor', 'suwayomi');
  const vendor = path.join(projectRoot, 'ext-runner', '.vendor', 'src', 'main', 'java');
  let current, dirty;
  try {
    const invoke = (args) => execFileSync('git', ['-C', checkout, ...args], {
      encoding: 'utf8', windowsHide: true, timeout: 20_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    current = invoke(['rev-parse', '--verify', 'HEAD^{commit}']);
    // The source-copy helper traverses the vendor checkout's filesystem; an
    // untracked Java/Kotlin file would otherwise enter generated Gradle source.
    dirty = invoke(['status', '--porcelain', '--untracked-files=all']);
  } catch { fail('pinned extension API checkout is missing or unreadable'); }
  if (current !== pin.commit || dirty) fail('extension API vendor source differs from its pinned Git commit');
  return { commit: pin.commit, inventory: listOrdinaryFiles(vendor) };
}
export function readAndroidVersion(file = path.join(ROOT, "android/app-version.json")) {
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!/^\d+\.\d+\.\d+$/.test(value.version || "") ||
      !Number.isSafeInteger(value.versionCode) || value.versionCode < 205 || value.versionCode > 2147483647 ||
      !/^\d+\.\d+\.\d+$/.test(value.desktopSourceVersion || "") ||
      !/^android-v\d+$/.test(value.runtimeGeneration || "")) fail("invalid Android app-version.json");
  const [major, minor, patch] = value.version.split(".").map(Number);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch) ||
      minor >= 100 || patch >= 100) fail("Android version components exceed Gradle versionCode bounds");
  return value;
}

// Android's independent user-facing release notes are compiled into its staging
// folder and used as the Android release body; Windows' root CHANGELOG.md stays
// untouched. There is no extra tracked Markdown release-notes file.
export function androidReleaseNotes(version, date) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    fail("invalid Android release notes version/date");
  }
  return [
    "# LVL for Android",
    "",
    `## ${version} — ${date}`,
    "",
    "- Add a phone-friendly Library for local videos and series.",
    "- Add video playback with audio and subtitle controls.",
    "- Add reading for local comics and connected comic sources.",
    "- Add device-local Android settings and update notifications.",
    "",
  ].join("\n");
}

// Mutate only the disposable Android staging folder; never the shared Windows
// checkout's package, lockfile or changelog.
export function stampAndroidRuntime(appDir, { version, runtimeGeneration, date = new Date().toISOString().slice(0, 10) }) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || !/^android-v\d+$/.test(runtimeGeneration)) {
    fail("invalid runtime version stamp");
  }
  for (const filename of ["package.json", "package-lock.json"]) {
    const target = path.join(appDir, filename);
    const json = JSON.parse(fs.readFileSync(target, "utf8"));
    json.version = version;
    if (filename === "package-lock.json") {
      if (!json.packages?.[""]) fail("staged lockfile is missing root package");
      json.packages[""].version = version;
    }
    fs.writeFileSync(target, JSON.stringify(json, null, 2) + "\n");
  }
  fs.writeFileSync(path.join(appDir, "CHANGELOG.md"), androidReleaseNotes(version, date));
  fs.writeFileSync(path.join(appDir, ".lvl-android-runtime-generation"), runtimeGeneration + "\n");
}

function ordinaryFile(file) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink() || !stat.size) fail(`missing or invalid file: ${file}`);
  return stat;
}

export function checkElf(file, abi) {
  const stat = ordinaryFile(file);
  if (stat.size < 64) fail(`truncated ELF: ${file}`);
  const fd = fs.openSync(file, "r");
  const head = Buffer.alloc(64);
  try {
    if (fs.readSync(fd, head, 0, 64, 0) !== 64) fail(`truncated ELF: ${file}`);
    if (head.subarray(0, 4).toString("hex") !== "7f454c46" || head[4] !== 2 || head[5] !== 1 ||
        head.readUInt16LE(18) !== ELF_MACHINE[abi]) fail(`wrong 64-bit ELF architecture for ${abi}: ${file}`);
    const programOffset = head.readBigUInt64LE(32);
    const programEntrySize = head.readUInt16LE(54);
    const programCount = head.readUInt16LE(56);
    if (programEntrySize !== 56 || programCount < 1 || programCount > 128 ||
        programOffset < 64n || programOffset + BigInt(programCount * programEntrySize) > BigInt(stat.size)) {
      fail(`missing or truncated ELF program headers for ${abi}: ${file}`);
    }
    let loadSegments = 0;
    const entry = Buffer.alloc(56);
    for (let index = 0; index < programCount; index++) {
      if (fs.readSync(fd, entry, 0, 56, Number(programOffset) + index * 56) !== 56) {
        fail(`truncated ELF program header for ${abi}: ${file}`);
      }
      if (entry.readUInt32LE(0) !== 1) continue;
      loadSegments++;
      const offset = entry.readBigUInt64LE(8);
      const virtualAddress = entry.readBigUInt64LE(16);
      const alignment = entry.readBigUInt64LE(48);
      if (alignment < 16384n || alignment % 16384n !== 0n ||
          offset % 16384n !== virtualAddress % 16384n) {
        fail(`ELF PT_LOAD segment is not 16 KB page compatible for ${abi}: ${file}`);
      }
    }
    if (!loadSegments) fail(`ELF has no loadable segments for ${abi}: ${file}`);
  } finally { fs.closeSync(fd); }
  return { sha256: sha256(file), bytes: stat.size };
}

export function checkNativeSources(dir) {
  const result = {};
  let commonVersions = null;
  let commonLicenses = null;
  for (const abi of ABIS) {
    result[abi] = {};
    for (const [kind, binary] of TOOLS) {
      const file = path.join(dir, kind, abi, binary);
      result[abi][binary] = checkElf(file, abi);
    }
    const nodeInfoFile = path.join(dir, "node", abi, "BUILDINFO.txt");
    const ffmpegInfoFile = path.join(dir, "ffmpeg", abi, "BUILDINFO.txt");
    ordinaryFile(nodeInfoFile);
    ordinaryFile(ffmpegInfoFile);
    const nodeInfo = fs.readFileSync(nodeInfoFile, "utf8");
    const ffmpegInfo = fs.readFileSync(ffmpegInfoFile, "utf8");
    const nodeVersion = new RegExp(`^node (\\d+\\.\\d+\\.\\d+) for Android ${abi} \\(API (\\d+)\\), built `).exec(nodeInfo);
    const ffmpegVersion = new RegExp(`^FFmpeg (\\d+\\.\\d+\\.\\d+) \\+ libwebp (\\d+\\.\\d+\\.\\d+) for Android ${abi} \\(API (\\d+)\\), built `).exec(ffmpegInfo);
    const ffmpegSource = ffmpegVersion?.[1].replaceAll(".", "\\.");
    const webpSource = ffmpegVersion?.[2].replaceAll(".", "\\.");
    if (!nodeVersion || !ffmpegVersion || nodeVersion[2] !== ffmpegVersion[3] ||
        !nodeInfo.includes(`size: ${result[abi].node.bytes} bytes (stripped)`) ||
        !nodeInfo.includes("LOAD segment alignment:") ||
        !ffmpegInfo.includes(`ffmpeg: ${result[abi].ffmpeg.bytes} bytes (stripped)`) ||
        !ffmpegInfo.includes(`ffprobe: ${result[abi].ffprobe.bytes} bytes (stripped)`) ||
        !/^License: LGPL version 2\.1 or later\s*$/m.test(ffmpegInfo) ||
        !new RegExp(`^libwebp-${webpSource}\\.tar\\.gz sha256 [a-f0-9]{64}\\s*$`, "m").test(ffmpegInfo) ||
        !new RegExp(`^ffmpeg-${ffmpegSource}\\.tar\\.xz sha256 [a-f0-9]{64}\\s*$`, "m").test(ffmpegInfo)) {
      fail(`native BUILDINFO does not match binaries, sources or LGPL build for ${abi}`);
    }
    const versions = [nodeVersion[1], ffmpegVersion[1], ffmpegVersion[2], nodeVersion[2]];
    if (commonVersions && JSON.stringify(commonVersions) !== JSON.stringify(versions)) {
      fail("native build versions or API levels differ between Android ABIs");
    }
    commonVersions = versions;
    for (const name of ["LICENSE.node.txt"]) ordinaryFile(path.join(dir, "node", abi, name));
    for (const name of ["LICENSE.ffmpeg.txt", "LICENSE.libwebp.txt"]) ordinaryFile(path.join(dir, "ffmpeg", abi, name));
    const licenseFiles = [path.join(dir, "node", abi, "LICENSE.node.txt"),
      path.join(dir, "ffmpeg", abi, "LICENSE.ffmpeg.txt"), path.join(dir, "ffmpeg", abi, "LICENSE.libwebp.txt")];
    const [nodeLicense, ffmpegLicense, webpLicense] = licenseFiles.map((file) => fs.readFileSync(file, "utf8"));
    if (!nodeLicense.startsWith("Node.js is licensed for use as follows:") ||
        !/GNU LESSER GENERAL PUBLIC LICENSE\s+Version 2\.1/.test(ffmpegLicense) ||
        !webpLicense.startsWith("Copyright (c) 2010, Google Inc.")) {
      fail(`native license notice content is invalid for ${abi}`);
    }
    const licenses = licenseFiles.map(sha256);
    if (commonLicenses && JSON.stringify(commonLicenses) !== JSON.stringify(licenses)) {
      fail("native license notices differ between Android ABIs");
    }
    commonLicenses = licenses;
  }
  return result;
}

export function verifyAndroidStageProvenance(stage, { reviewedCommit, candidateVersion,
  projectRoot = ROOT, releaseInputPaths = null } = {}) {
  if (!reviewedCommit || !candidateVersion) fail('explicit reviewed commit and candidate version required');
  const assets = path.join(stage, 'assets');
  const app = path.join(stage, 'app');
  const manifest = checkedJson(path.join(assets, 'lvl-app.json'));
  const receiptPath = path.join(assets, 'lvl-stage-provenance.json');
  const receipt = checkedJson(receiptPath);
  if (receipt.schemaVersion !== 1 || receipt.mode !== 'release' || receipt.platform !== 'android' ||
      receipt.reviewedCommit !== reviewedCommit || receipt.candidateVersion !== candidateVersion ||
      manifest.reviewedCommit !== reviewedCommit || manifest.version !== candidateVersion ||
      manifest.releaseProvenanceSha256 !== hashFile(receiptPath)) {
    fail('Android staged provenance identity or receipt digest mismatch');
  }
  const configured = readAndroidVersion(path.join(projectRoot, 'android', 'app-version.json'));
  const desktopVersion = checkedJson(path.join(projectRoot, 'package.json')).version;
  if (configured.version !== candidateVersion ||
      configured.desktopSourceVersion !== desktopVersion || receipt.desktopSourceVersion !== desktopVersion) {
    fail('Android candidate and desktop source metadata disagree');
  }
  readVersionIdentity(projectRoot, desktopVersion, 'android');
  const reviewed = verifyReviewedInputs({ root: projectRoot, reviewedCommit,
    platform: 'android', extraPaths: releaseInputPaths });
  if (JSON.stringify(receipt.sourceInputs) !== JSON.stringify(reviewed.inputs)) {
    fail('Android reviewed source inventory differs from staged receipt');
  }
  if (releaseInputPaths === null) {
    const vendor = verifyPinnedExtensionSource(projectRoot);
    if (receipt.suwayomiCommit !== vendor.commit ||
        JSON.stringify(receipt.generatedExtensionApi) !== JSON.stringify(vendor.inventory)) {
      fail('Android generated extension API source inventory differs from staged release');
    }
  }
  assertFileInventory(app, receipt.app);
  assertFileInventory(path.join(stage, 'jniLibs'), receipt.jniLibs);
  const generated = listOrdinaryFiles(assets).filter(entry =>
    !['lvl-app.zip', 'lvl-app.json', 'lvl-stage-provenance.json'].includes(entry.path));
  if (JSON.stringify(generated) !== JSON.stringify(receipt.nativeAssets)) {
    fail('Android generated native asset inventory differs from staged receipt');
  }
  for (const relative of reviewed.appFiles) {
    if (relative === 'package.json' || relative === 'CHANGELOG.md') continue;
    const source = reviewed.inputs.find(item => item.path === relative);
    if (hashFile(path.join(app, relative)) !== source.sha256) {
      fail(`Android app source differs from reviewed commit after transformations: ${relative}`);
    }
  }
  for (const [staged, original] of [['android-preload.cjs', 'android/server-preload.cjs'],
    ['android/update-apply.mjs', 'android/update-apply.mjs'],
    ['runtime/update-apply.mjs', 'runtime/update-apply.mjs'],
    ['runtime/windows-install-transaction.mjs', 'runtime/windows-install-transaction.mjs']]) {
    if (hashFile(path.join(app, staged)) !== reviewed.inputs.find(item => item.path === original)?.sha256) {
      fail(`Android runtime adaptation differs from reviewed commit: ${staged}`);
    }
  }
  const archive = path.join(assets, 'lvl-app.zip');
  if (hashFile(archive) !== manifest.sha256) fail('Android staged zip hash differs from app manifest');
  const zip = new AdmZip(archive);
  const embedded = zip.getEntries().filter(entry => !entry.isDirectory).map(entry => {
    const name = entry.entryName.replaceAll('\\', '/');
    if (name.startsWith('/') || name.split('/').some(part => !part || part === '.' || part === '..')) {
      fail(`Unsafe Android app ZIP entry: ${name}`);
    }
    const contents = entry.getData();
    return { path: name, sha256: crypto.createHash('sha256').update(contents).digest('hex'), bytes: contents.length };
  }).sort((a, b) => a.path.localeCompare(b.path, 'en'));
  if (JSON.stringify(embedded) !== JSON.stringify(receipt.app)) {
    fail('Embedded Android app ZIP differs from the inventory of staged app files');
  }
  return { reviewedCommit, appFiles: receipt.app.length, nativeAssets: generated.length };
}

export function checkStage(stage, version, { reviewedCommit = null, projectRoot = ROOT } = {}) {
  const provenance = verifyAndroidStageProvenance(stage,
    { reviewedCommit, candidateVersion: version, projectRoot });
  const configured = readAndroidVersion();
  const manifest = JSON.parse(fs.readFileSync(path.join(stage, "assets", "lvl-app.json"), "utf8"));
  if (manifest.version !== version || !/^[a-f0-9]{64}$/.test(manifest.sha256)) fail("staged app version or digest is invalid");
  // A synthetic --version stage is useful for local update QA but can NEVER be
  // accepted by the signed release preflight, even if it spells 0.1.0.
  if (manifest.testVersionOverride) fail("synthetic update-test stage cannot be released");
  if (manifest.version !== configured.version ||
      manifest.versionCode !== configured.versionCode) fail("staged Android version/code is not configured");
  const archive = path.join(stage, "assets", "lvl-app.zip");
  ordinaryFile(archive);
  if (sha256(archive) !== manifest.sha256) fail("staged app ZIP digest mismatch");
  const packaged = new AdmZip(archive);
  // Checking only loose stage/app files is not enough: the APK embeds this ZIP.
  // Fail if its actual server/runtime identity differs from what Settings reports.
  for (const name of ["package.json", "package-lock.json", "CHANGELOG.md", ".lvl-android-runtime-generation"]) {
    const embedded = packaged.getEntry(name)?.getData();
    if (!embedded || !embedded.equals(fs.readFileSync(path.join(stage, "app", name)))) {
      fail(`staged app ZIP identity differs from ${name}`);
    }
  }
  const staged = JSON.parse(fs.readFileSync(path.join(stage, "app", "package.json"), "utf8"));
  if (staged.version !== version) fail("staged package.json version mismatch");
  const locked = JSON.parse(fs.readFileSync(path.join(stage, "app", "package-lock.json"), "utf8"));
  if (locked.version !== version || locked.packages?.[""]?.version !== version ||
      !fs.readFileSync(path.join(stage, "app", "CHANGELOG.md"), "utf8").includes(`## ${version} —`) ||
      fs.readFileSync(path.join(stage, "app", ".lvl-android-runtime-generation"), "utf8").trim() !== configured.runtimeGeneration ||
      manifest.runtimeGeneration !== configured.runtimeGeneration) fail("staged Android runtime version metadata is inconsistent");
  const jni = {};
  for (const abi of ABIS) {
    jni[abi] = {};
    for (const [, , name] of TOOLS) jni[abi][name] = checkElf(path.join(stage, "jniLibs", abi, name), abi);
  }
  const entries = fs.readdirSync(path.join(stage, "jniLibs"));
  if (entries.some((name) => !ABIS.includes(name))) fail("staged native libraries contain an unexpected ABI");
  return { version, zipSha256: manifest.sha256, binaries: jni, provenance };
}

export function checkApkStageAssets(apk, stage) {
  ordinaryFile(apk);
  const packaged = new AdmZip(apk);
  const assets = path.join(stage, 'assets');
  const expected = listOrdinaryFiles(assets);
  if (!expected.some(entry => entry.path === 'lvl-stage-provenance.json') ||
      !expected.some(entry => entry.path === 'lvl-app.zip')) fail('missing reviewed APK payload inventory');
  for (const entry of expected) {
    const embedded = packaged.getEntry(`assets/${entry.path}`);
    if (!embedded || embedded.isDirectory ||
        crypto.createHash('sha256').update(embedded.getData()).digest('hex') !== entry.sha256) {
      fail(`Signed APK does not embed the reviewed stage asset: ${entry.path}`);
    }
  }
  return { apk: path.basename(apk), verifiedAssetCount: expected.length };
}

function argsToOptions(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!["--native-dir", "--stage-dir", "--version", "--reviewed-commit", "--apk"].includes(argv[i]) || !argv[i + 1] || o[argv[i]]) fail("usage: --native-dir <dir> [--stage-dir <dir> --version X.Y.Z --reviewed-commit <full-id> --apk <signed.apk>]");
    o[argv[i]] = argv[i + 1];
  }
  if (Boolean(o["--stage-dir"]) !== Boolean(o["--version"])) fail("--stage-dir requires --version, and vice versa");
  if (Boolean(o["--stage-dir"]) !== Boolean(o["--reviewed-commit"])) fail("staged release requires a reviewed commit");
  if (o["--apk"] && !o["--stage-dir"]) fail('signed APK verification requires a reviewed stage');
  return o;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const opts = argsToOptions(process.argv.slice(2));
    const native = checkNativeSources(path.resolve(opts["--native-dir"] || path.join(ROOT, "build/android-native")));
    const stage = opts["--stage-dir"] ? checkStage(path.resolve(opts["--stage-dir"]), opts["--version"],
      { reviewedCommit: opts["--reviewed-commit"] }) : null;
    const apk = opts["--apk"] ? checkApkStageAssets(path.resolve(opts["--apk"]), path.resolve(opts["--stage-dir"])) : null;
    console.log(JSON.stringify({ ok: true, native, stage, apk }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
