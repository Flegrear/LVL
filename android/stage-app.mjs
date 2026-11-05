// Stages what the Android app ships: LVL's app files, production dependencies and the
// Android builds of Node and FFmpeg. Gradle reads the result from build/android-stage.
//
// Usage: node android/stage-app.mjs [--abi x86_64] [--abi arm64-v8a] [--skip-npm]
// Release: node android/stage-app.mjs --release --abi x86_64 --abi arm64-v8a
//
// - App files are the installer's own selection (scripts/release-inputs.mjs).
// - Dependencies come from `npm ci --omit=dev --ignore-scripts`: no desktop FFmpeg download,
//   no native WebRTC build.
// - Two dependencies don't work on Android as published, and get small staged changes:
//   ffprobe-static exits the process on platforms it doesn't know, so it learns FFPROBE_BIN
//   (the same override ffmpeg-static has as FFMPEG_BIN); webrtc-polyfill loads a native
//   WebRTC addon that has no Android build, so it becomes a stub without WebRTC. WebTorrent
//   then skips WebRTC peers and keeps TCP, UDP trackers and DHT.
// - Native binaries go in jniLibs as lib*_exec.so, the only form Android extracts to the
//   folder where an app may run its own executables.
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import { isSetupSourceFile } from "../scripts/release-inputs.mjs";
import { checkNativeSources, readAndroidVersion, stampAndroidRuntime } from "./tools/release-check.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STAGE = path.join(ROOT, "build", "android-stage");
const APP = path.join(STAGE, "app");
const ASSETS = path.join(STAGE, "assets");
const JNILIBS = path.join(STAGE, "jniLibs");
const NATIVE = path.join(ROOT, "build", "android-native");

// Immutable upstream sources of the LGPL command-line programs shipped inside
// every *release* APK. Sources remain in APK assets, not the app-code ZIP.
const NATIVE_SOURCES = [
  { name: "ffmpeg-7.1.5.tar.xz", url: "https://ffmpeg.org/releases/ffmpeg-7.1.5.tar.xz",
    sha256: "de668509caf9e35e3cd162473441fdb29538c6d96ed080292b3cf9e6fc5d558f", maxBytes: 40 * 1024 * 1024 },
  { name: "libwebp-1.6.0.tar.gz", url: "https://storage.googleapis.com/downloads.webmproject.org/releases/webp/libwebp-1.6.0.tar.gz",
    sha256: "e4ab7009bf0629fd11982d4c2aa83964cf244cffba7347ecd39019a9e38c4564", maxBytes: 25 * 1024 * 1024 },
];
const SOURCE_RECIPES = ["Dockerfile", "build-node.sh", "build-ffmpeg.sh", "docker-build.ps1"];
const nativeSha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

function readNativeFile(file, maxBytes, description) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink() || !stat.size || stat.size > maxBytes) {
    throw new Error(`Missing, non-ordinary or oversized ${description}`);
  }
  return fs.readFileSync(file);
}

async function downloadPinnedSource(source, destination) {
  // No arbitrary mirror, environment URL, HTTP downgrade, or cross-host redirect.
  // Each source has a fixed approved origin, bounded transfer and exact hash.
  const origin = new URL(source.url);
  const partial = destination + `.partial-${process.pid}-${crypto.randomBytes(5).toString("hex")}`;
  const started = Date.now();
  let current = origin;
  try {
    for (let redirects = 0; redirects <= 2; redirects++) {
      const remaining = 125_000 - (Date.now() - started);
      if (remaining <= 0) throw new Error(`Timed out downloading ${source.name}`);
      const response = await new Promise((resolve, reject) => {
        const req = https.get(current, {
          headers: { "User-Agent": "LVL-Android-source/0.1.0", Accept: "application/octet-stream" },
          timeout: Math.min(20_000, remaining), signal: AbortSignal.timeout(remaining),
        }, resolve);
        req.on("timeout", () => req.destroy(new Error(`Timed out downloading ${source.name}`)));
        req.on("error", reject);
      });
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        const redirect = new URL(response.headers.location || "", current);
        response.resume();
        if (redirect.protocol !== "https:" || redirect.hostname !== origin.hostname ||
            redirect.port !== origin.port || redirect.username || redirect.password || redirects === 2) {
          throw new Error(`Unapproved redirect for ${source.name}`);
        }
        current = redirect;
        continue;
      }
      if (response.statusCode !== 200 || Number(response.headers["content-length"] || 0) > source.maxBytes) {
        response.resume();
        throw new Error(`Invalid HTTP response or oversized ${source.name} source archive`);
      }
      let bytes = 0;
      const hash = crypto.createHash("sha256");
      const gate = new Transform({ transform(chunk, _encoding, done) {
        bytes += chunk.length;
        if (bytes > source.maxBytes) return done(new Error(`Oversized ${source.name} source archive`));
        hash.update(chunk);
        done(null, chunk);
      } });
      await pipeline(response, gate, fs.createWriteStream(partial, { flags: "wx" }));
      if (!bytes || hash.digest("hex") !== source.sha256) {
        throw new Error(`SHA-256 hash mismatch for downloaded ${source.name}`);
      }
      if (fs.existsSync(destination)) throw new Error(`Source cache already exists: ${source.name}`);
      fs.renameSync(partial, destination);
      return;
    }
  } finally {
    fs.rmSync(partial, { force: true });
  }
}

// Exported for narrow release tests; importing the module must not execute the
// ordinary CLI staging (npm, extension fetch, native copy). No extra helper file.
export async function stageNativeReleaseAssets({ projectRoot = ROOT, assetsDir = ASSETS,
  nativeDir = NATIVE, cacheDir = path.join(projectRoot, "build", "android-source-cache") } = {}) {
  const sourceDir = path.join(assetsDir, "lvl-native-source");
  const licenseDir = path.join(assetsDir, "lvl-native-licenses");
  if (fs.existsSync(sourceDir) || fs.existsSync(licenseDir)) {
    throw new Error("Native release asset destination must be empty");
  }
  const licenses = new Map();
  const buildRecords = new Map();
  for (const abi of ["arm64-v8a", "x86_64"]) {
    for (const [name, kind, max] of [["LICENSE.node.txt", "node", 512 * 1024],
      ["LICENSE.ffmpeg.txt", "ffmpeg", 128 * 1024], ["LICENSE.libwebp.txt", "ffmpeg", 32 * 1024]]) {
      const content = readNativeFile(path.join(nativeDir, kind, abi, name), max, `${abi} ${name}`);
      if (licenses.has(name) && !licenses.get(name).equals(content)) {
        throw new Error(`Native original license differs between ABIs: ${name}`);
      }
      licenses.set(name, content);
    }
    for (const kind of ["node", "ffmpeg"]) {
      const file = `BUILDINFO.${kind}.${abi}.txt`;
      buildRecords.set(file, readNativeFile(path.join(nativeDir, kind, abi, "BUILDINFO.txt"),
        128 * 1024, `${abi} ${kind} build record`));
    }
  }
  if (!licenses.get("LICENSE.node.txt").toString("utf8").startsWith("Node.js is licensed for use as follows:") ||
      !licenses.get("LICENSE.ffmpeg.txt").toString("utf8").includes("GNU LESSER GENERAL PUBLIC LICENSE") ||
      !licenses.get("LICENSE.libwebp.txt").toString("utf8").startsWith("Copyright (c) 2010, Google Inc.")) {
    throw new Error("Invalid original native license notice");
  }
  const notice = readNativeFile(path.join(projectRoot, "android", "RELEASE-NOTICE.txt"),
    64 * 1024, "Android release notice");
  const recipes = new Map(SOURCE_RECIPES.map(name => [name,
    readNativeFile(path.join(projectRoot, "android", "native", name), 128 * 1024, `build recipe ${name}`)]));
  fs.mkdirSync(cacheDir, { recursive: true });
  const archivePaths = new Map();
  for (const source of NATIVE_SOURCES) {
    const cached = path.join(cacheDir, source.name);
    if (!fs.existsSync(cached)) await downloadPinnedSource(source, cached);
    const bytes = readNativeFile(cached, source.maxBytes, `upstream ${source.name}`);
    if (nativeSha256(bytes) !== source.sha256) throw new Error(`SHA-256 hash mismatch for cached ${source.name}`);
    archivePaths.set(source.name, cached);
  }
  // No general-purpose archive extractor: select only these known licensed
  // upstream members from already hash-verified source archives, with hard caps.
  const extract = (archive, member, maxBytes) => {
    const archivePath = archivePaths.get(archive);
    // npm can put GNU tar ahead of Windows tar on PATH. A drive-qualified
    // archive name would be interpreted as a remote host by GNU tar.
    const content = execFileSync("tar", ["-xOf", path.basename(archivePath), member],
      { cwd: path.dirname(archivePath), windowsHide: true, timeout: 20_000, maxBuffer: maxBytes + 4096 });
    if (!content.length || content.length > maxBytes) throw new Error(`Invalid upstream archive member ${member}`);
    return content;
  };
  // The bundled FFmpeg LGPL text comes from the checked native build's
  // COPYING.LGPLv2.1 output; this Windows tar lacks an XZ decoder, so source
  // authenticity is established by the pinned full-archive SHA-256 instead.
  if (!extract("libwebp-1.6.0.tar.gz", "libwebp-1.6.0/COPYING", 32 * 1024)
    .equals(licenses.get("LICENSE.libwebp.txt"))) {
    throw new Error("Original native license differs from verified upstream source archive");
  }
  const patents = extract("libwebp-1.6.0.tar.gz", "libwebp-1.6.0/PATENTS", 64 * 1024);
  const readme = [
    "LVL for Android 0.1.0: corresponding source and native build instructions",
    "",
    "Each Android APK is a ZIP archive. Open it and locate assets/lvl-native-source/",
    "for the complete original ffmpeg-7.1.5.tar.xz and libwebp-1.6.0.tar.gz",
    "source archives, build recipes, per-ABI build records, and SHA256SUMS.",
    "Original license texts and the libwebp patent grant are in",
    "assets/lvl-native-licenses/. The separate Node.js 24.22.2 executable",
    "has its complete third-party LICENSE.node.txt in that directory.",
    "",
    "The original upstream FFmpeg and libwebp archives are unmodified.",
    "The Android executable binaries were built with Android NDK r28c (API 31)",
    "and Ubuntu 24.04, using the included Dockerfile, build-node.sh,",
    "build-ffmpeg.sh and docker-build.ps1 recipes from the same LVL revision.",
    "For either ABI, build the Dockerfile as android/native/Dockerfile, then run",
    "build-ffmpeg.sh with arm64 or x86_64 inside that build environment,",
    "mounting writable /build (source cache/objects) and /out (build results).",
    "Its exact configure flags, enabled components, static libwebp build,",
    "strip commands and toolchain settings are in build-ffmpeg.sh; the script",
    "independently fetches these fixed archives and verifies their hashes.",
    "Place the included archives under /build/cache to reuse them offline.",
    "The command also builds FFprobe. Per-ABI BUILDINFO.ffmpeg.*.txt files",
    "record compiler/API, archive digests and resulting executable details.",
    "The included build-node.sh documents the separate Node.js build and its",
    "reproducible V8 trap-handler source adjustment.",
    "",
  ].join("\n");
  const sourceFiles = new Map([...NATIVE_SOURCES.map(spec => [spec.name,
    fs.readFileSync(archivePaths.get(spec.name))]), ...recipes, ...buildRecords]);
  const sums = [...sourceFiles].sort(([a], [b]) => a.localeCompare(b, "en"))
    .map(([name, content]) => `${nativeSha256(content)}  ${name}\n`).join("");
  const licenseFiles = new Map([...licenses,
    ["PATENTS.libwebp.txt", patents], ["LVL-Android-RELEASE-NOTICE.txt", notice]]);
  try {
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.mkdirSync(licenseDir, { recursive: true });
    for (const [name, content] of sourceFiles) fs.writeFileSync(path.join(sourceDir, name), content, { flag: "wx" });
    fs.writeFileSync(path.join(sourceDir, "README.txt"), readme, { flag: "wx" });
    fs.writeFileSync(path.join(sourceDir, "SHA256SUMS"), sums, { flag: "wx" });
    for (const [name, content] of licenseFiles) fs.writeFileSync(path.join(licenseDir, name), content, { flag: "wx" });
  } catch (error) {
    fs.rmSync(sourceDir, { recursive: true, force: true });
    fs.rmSync(licenseDir, { recursive: true, force: true });
    throw error;
  }
  return { archiveSha256: Object.fromEntries(NATIVE_SOURCES.map(source => [source.name, source.sha256])),
    sourceFileCount: sourceFiles.size, licenseFileCount: licenseFiles.size,
    bytes: [...sourceFiles.values(), ...licenseFiles.values()].reduce((n, b) => n + b.length, 0) +
      Buffer.byteLength(readme) + Buffer.byteLength(sums) };
}

async function stageApp() {
const argv = process.argv.slice(2);
const abis = argv.flatMap((arg, i) => (arg === "--abi" && argv[i + 1] ? [argv[i + 1]] : []));
if (!abis.length) abis.push("x86_64");
const skipNpm = argv.includes("--skip-npm");
const release = argv.includes("--release");
const androidVersion = readAndroidVersion();
const desktopVersion = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
if (desktopVersion !== androidVersion.desktopSourceVersion) {
  throw new Error("Desktop source version changed; review android/app-version.json before packaging");
}
// (--version X.Y.Z, read below, is for local update tests.)
// --app-root <dir> (tests only): LVL's own files (server, pages, package.json) come from that
// checkout, for example another lane merged for a test; the Android preload and the native
// parts stay this checkout's.
const appRootArg = argv.flatMap((arg, i) => (arg === "--app-root" && argv[i + 1] ? [argv[i + 1]] : []))[0] || null;
const APP_ROOT = appRootArg ? path.resolve(appRootArg) : ROOT;
if (abis.some((abi) => !["x86_64", "arm64-v8a"].includes(abi)) || new Set(abis).size !== abis.length) {
  throw new Error("Choose distinct supported --abi values: x86_64 and arm64-v8a");
}
if (release && (abis.length !== 2 || !abis.includes("x86_64") || !abis.includes("arm64-v8a") || skipNpm || appRootArg || argv.includes("--version"))) {
  throw new Error("Release staging requires both ABIs, fresh dependencies and the current checkout");
}

const log = (...parts) => console.log("[stage]", ...parts);
const inside = (dir, target) => path.resolve(target).startsWith(path.resolve(dir) + path.sep);
function removeInStage(target) {
  if (!inside(STAGE, target)) throw new Error(`Refusing to remove outside the stage folder: ${target}`);
  fs.rmSync(target, { recursive: true, force: true });
}

// 0. The Comics extension API the APK compiles (android/app/build.gradle.kts) comes from
// the pinned Suwayomi sources, fetched by the extension runner's own script.
if (!fs.existsSync(path.join(ROOT, "ext-runner", ".vendor", "src", "main", "java", "eu", "kanade", "tachiyomi"))) {
  log("fetching the extension API sources (ext-runner/fetch.mjs)");
  const fetched = spawnSync(process.execPath, [path.join(ROOT, "ext-runner", "fetch.mjs")], { cwd: ROOT, stdio: "inherit" });
  if (fetched.status !== 0) throw new Error(`ext-runner/fetch.mjs failed (exit ${fetched.status})`);
}

// 1. App files: tracked and new (not ignored) files in the working tree, so a development
// build has what is being worked on; a release build stages a clean checkout of its tag.
const listed = execFileSync("git", ["-C", APP_ROOT, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" })
  .split("\0").filter(Boolean);
const appFiles = [...new Set(listed)].filter((rel) => isSetupSourceFile(rel) && fs.existsSync(path.join(APP_ROOT, rel))).sort();
if (APP_ROOT !== ROOT) log(`TEST BUILD: LVL's files from ${APP_ROOT}`);
if (!skipNpm) removeInStage(APP);
fs.mkdirSync(APP, { recursive: true });
// With --skip-npm the dependencies stay; app files from an earlier stage are cleared so a
// removed or renamed file doesn't linger in the APK.
if (skipNpm) {
  for (const entry of fs.readdirSync(APP)) if (entry !== "node_modules") removeInStage(path.join(APP, entry));
}
for (const rel of [...appFiles, "package-lock.json"]) {
  const to = path.join(APP, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(path.join(APP_ROOT, rel), to);
}
// Android-only start-up adjustments, loaded before server.js (see the file's comment).
fs.copyFileSync(path.join(ROOT, "android", "server-preload.cjs"), path.join(APP, "android-preload.cjs"));
// In-app updates: the app runs android/update-apply.mjs, which uses the installer's release
// path rules (runtime/update-apply.mjs). Patches never contain android/ or runtime/ files,
// so these change only with a new APK.
for (const rel of ["android/update-apply.mjs", "runtime/update-apply.mjs"]) {
  fs.mkdirSync(path.dirname(path.join(APP, rel)), { recursive: true });
  fs.copyFileSync(path.join(ROOT, rel), path.join(APP, rel));
}
log(`${appFiles.length} app files`);

// 2. Production dependencies.
if (!skipNpm) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npm, ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: APP, stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) throw new Error(`npm ci failed (exit ${result.status})`);
}
const modules = path.join(APP, "node_modules");
if (!fs.existsSync(modules)) throw new Error("node_modules is missing; run without --skip-npm once");

// 3. Android adjustments.
for (const dir of ["ffprobe-static/bin", "node-datachannel", "utp-native/prebuilds", "bufferutil/prebuilds", "utf-8-validate/prebuilds"]) {
  removeInStage(path.join(modules, dir));
}
const fsExt = path.join(modules, "fs-native-extensions", "prebuilds");
if (fs.existsSync(fsExt)) {
  for (const name of fs.readdirSync(fsExt)) if (!name.startsWith("android-")) removeInStage(path.join(fsExt, name));
}
const probeIndex = path.join(modules, "ffprobe-static", "index.js");
// The published module calls process.exit(1) on platforms it doesn't know ("android"),
// which would stop LVL's server while it loads. Report the bundled ffprobe, or none.
// Any earlier version of this header is replaced, so re-staging with --skip-npm stays current.
const probeHeader = "// LVL for Android: the app passes its bundled ffprobe in FFPROBE_BIN.\n" +
  "if (process.env.FFPROBE_BIN || require('os').platform() === 'android') { exports.path = process.env.FFPROBE_BIN || null; return; }\n";
const probeSource = fs.readFileSync(probeIndex, "utf8").replace(/^\/\/ LVL for Android:.*\r?\n(?:if \(process\.env\.FFPROBE_BIN.*\r?\n)?/, "");
fs.writeFileSync(probeIndex, probeHeader + probeSource);
fs.writeFileSync(path.join(modules, "webrtc-polyfill", "index.js"), [
  "// LVL for Android: no WebRTC. simple-peer reports WEBRTC_SUPPORT = false, so WebTorrent",
  "// uses TCP peers, UDP trackers and DHT only.",
  ...["RTCPeerConnection", "RTCSessionDescription", "RTCIceCandidate", "RTCIceTransport", "RTCDataChannel",
    "RTCSctpTransport", "RTCDtlsTransport", "RTCCertificate"].map((name) => `export const ${name} = undefined;`),
  "export default {};",
  "",
].join("\n"));
let pruned = 0;
(function prune(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) prune(full);
    else if (/\.(map|d\.ts|d\.mts|d\.cts|md|markdown)$/i.test(entry.name) && !/^license/i.test(entry.name)) { fs.rmSync(full); pruned += 1; }
  }
})(modules);
log(`pruned ${pruned} map, type and readme files`);

// 4. One zip for the app, plus a manifest the app uses to know when to unpack again.
// --version X.Y.Z is reserved for synthetic update tests; normal and signed release
// staging always embed the independent Android identity, not the desktop release.
const testVersion = argv.flatMap((arg, i) => (arg === "--version" && argv[i + 1] ? [argv[i + 1]] : []))[0] || null;
if (testVersion && !/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(testVersion)) throw new Error(`--version must be x.y.z, not ${testVersion}`);
const version = testVersion || androidVersion.version;
stampAndroidRuntime(APP, { version, runtimeGeneration: androidVersion.runtimeGeneration });
if (testVersion) log(`TEST BUILD: staged as version ${testVersion}`);
else log(`ANDROID BUILD: ${version} (APK versionCode ${androidVersion.versionCode}; desktop sources ${desktopVersion})`);
fs.mkdirSync(ASSETS, { recursive: true });
const zipPath = path.join(ASSETS, "lvl-app.zip");
const zip = new AdmZip();
zip.addLocalFolder(APP);
zip.writeZip(zipPath);
const sha256 = crypto.createHash("sha256").update(fs.readFileSync(zipPath)).digest("hex");
fs.writeFileSync(path.join(ASSETS, "lvl-app.json"), JSON.stringify({
  version, versionCode: testVersion ? null : androidVersion.versionCode,
  runtimeGeneration: androidVersion.runtimeGeneration,
  ...(testVersion ? { testVersionOverride: true } : {}),
  sha256, stagedAt: new Date().toISOString(),
}, null, 2) + "\n");
log(`lvl-app.zip ${(fs.statSync(zipPath).size / 1048576).toFixed(1)} MB, sha256 ${sha256.slice(0, 12)}`);

// 5. Native binaries.
removeInStage(JNILIBS);
for (const abi of abis) {
  const outDir = path.join(JNILIBS, abi);
  fs.mkdirSync(outDir, { recursive: true });
  for (const [from, to] of [["node/node", "libnode_exec.so"], ["ffmpeg/ffmpeg", "libffmpeg_exec.so"], ["ffmpeg/ffprobe", "libffprobe_exec.so"]]) {
    const [kind, file] = from.split("/");
    const source = path.join(NATIVE, kind, abi, file);
    if (fs.existsSync(source)) {
      if (release && (!fs.statSync(source).isFile() || fs.statSync(source).size === 0)) throw new Error(`Invalid native release binary: ${source}`);
      fs.copyFileSync(source, path.join(outDir, to));
      log(`${abi}/${to} ${(fs.statSync(source).size / 1048576).toFixed(1)} MB`);
    } else {
      if (release) throw new Error(`Missing native release binary: ${source}`);
      log(`${abi}/${to} missing (${path.relative(ROOT, source)} not built yet)`);
    }
  }
}

// Release-only, after verifying both ABI-native inputs. Debug stage never
// downloads source archives, and neither folder enters lvl-app.zip.
removeInStage(path.join(ASSETS, "lvl-native-source"));
removeInStage(path.join(ASSETS, "lvl-native-licenses"));
if (release) {
  checkNativeSources(NATIVE);
  const nativeDistribution = await stageNativeReleaseAssets();
  log(`native source/licenses embedded in APK assets: ${nativeDistribution.bytes} bytes`);
}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await stageApp();
}
