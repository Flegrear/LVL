// Packages verified, signed Gradle ABI splits for Android's ReleaseFeed contract.
// Signature evidence must be produced by build-release.ps1 after apksigner verification.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { ABIS, readAndroidVersion } from "./release-check.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HASH = /^[a-f0-9]{64}$/;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const digest = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const fail = (message) => { throw new Error(`Android release assets: ${message}`); };
function fileCheck(file) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink() || !stat.size) fail(`missing or invalid input: ${file}`);
  return stat;
}

// Android's first public channel deliberately has no incremental patch assets.
// Each Android review bundle or legacy Android release contains exactly two
// signed ABI-specific APKs, their distribution notice and matching SHA256SUMS.
// Combined publishing consumes this verified bundle alongside Windows assets.
export function assetNames(version) {
  if (!VERSION.test(version)) fail("version must be X.Y.Z");
  return [`LVL-${version}-arm64.apk`, `LVL-${version}-x86_64.apk`,
    "LVL-Android-RELEASE-NOTICE.txt", "SHA256SUMS"].sort();
}

export function verifyReleaseDirectory({ dir, version, evidence }) {
  const expected = assetNames(version);
  const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!stat?.isDirectory() || stat.isSymbolicLink()) fail("release asset directory is not ordinary");
  const names = fs.readdirSync(dir).sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    fail(`expected exactly the four Android APK-only assets for ${version}`);
  }
  const proof = JSON.parse(fs.readFileSync(evidence, "utf8"));
  if (proof.version !== version || !HASH.test(proof.signerSha256 || "") ||
    !proof.apks || Object.keys(proof.apks).sort().join(",") !== ABIS.slice().sort().join(",")) {
    fail("validated production signing evidence is missing or inconsistent");
  }
  const expectedHashes = new Map();
  for (const abi of ABIS) {
    const apkName = `LVL-${version}-${abi === "arm64-v8a" ? "arm64" : abi}.apk`;
    const apk = path.join(dir, apkName);
    if (fileCheck(apk).size > 400 * 1024 * 1024) fail("APK exceeds updater maximum");
    if (!HASH.test(proof.apks[abi] || "") || digest(apk) !== proof.apks[abi]) {
      fail(`signed ${abi} APK differs from its verified signing evidence`);
    }
    expectedHashes.set(apkName, proof.apks[abi]);
  }
  const notice = path.join(dir, "LVL-Android-RELEASE-NOTICE.txt");
  if (fileCheck(notice).size > 64 * 1024) fail("release notice is unexpectedly large");
  expectedHashes.set("LVL-Android-RELEASE-NOTICE.txt", digest(notice));
  const sumsFile = path.join(dir, "SHA256SUMS");
  if (fileCheck(sumsFile).size > 64 * 1024) fail("SHA256SUMS is unexpectedly large");
  const expectedSums = [...expectedHashes].sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([name, sha]) => `${sha}  ${name}\n`).join("");
  if (fs.readFileSync(sumsFile, "utf8") !== expectedSums) {
    fail("SHA256SUMS is incomplete, duplicated, reordered or mismatched");
  }
  return { version, signerSha256: proof.signerSha256, files: names, sha256: Object.fromEntries(expectedHashes) };
}

export function releaseAssets({ apkDir, outDir, version, evidence, patch = null,
  notice = path.join(ROOT, "build/android-stage/assets/lvl-native-licenses/LVL-Android-RELEASE-NOTICE.txt") }) {
  if (patch != null) fail("Android incremental patches are not part of the initial signed APK-only release channel");
  if (!VERSION.test(version)) fail("version must be X.Y.Z");
  const configured = readAndroidVersion();
  if (version !== configured.version) fail("release version must match android/app-version.json");
  const versionCode = configured.versionCode;
  const metadata = JSON.parse(fs.readFileSync(path.join(apkDir, "output-metadata.json"), "utf8"));
  if (metadata.applicationId !== "io.github.flegrear.lvl" || metadata.variantName !== "release" ||
      metadata.artifactType?.type !== "APK" || metadata.elements?.length !== ABIS.length) fail("expected two production APK splits");
  const declaredApks = metadata.elements.map((element) => element.outputFile);
  const directoryEntries = fs.readdirSync(apkDir);
  if (new Set(declaredApks).size !== ABIS.length ||
      directoryEntries.length !== ABIS.length + 1 ||
      !directoryEntries.includes("output-metadata.json") ||
      directoryEntries.some((name) => name !== "output-metadata.json" && !declaredApks.includes(name))) {
    fail("release APK directory includes missing, duplicate, debug or unexpected build files");
  }
  const proof = JSON.parse(fs.readFileSync(evidence, "utf8"));
  if (proof.version !== version || !HASH.test(proof.signerSha256 || "") ||
    !proof.apks || Object.keys(proof.apks).sort().join(",") !== ABIS.slice().sort().join(",")) {
    fail("missing validated signer evidence");
  }
  const expected = new Map();
  for (const abi of ABIS) {
    const rows = metadata.elements.filter((entry) => entry.filters?.length === 1 &&
      entry.filters[0].filterType === "ABI" && entry.filters[0].value === abi);
    if (rows.length !== 1 || rows[0].versionName !== version || rows[0].versionCode !== versionCode ||
        !/^app-[A-Za-z0-9_-]+-release\.apk$/.test(rows[0].outputFile)) fail(`invalid APK metadata for ${abi}`);
    const file = path.join(apkDir, rows[0].outputFile);
    fileCheck(file);
    if (!HASH.test(proof.apks[abi] || "") || digest(file) !== proof.apks[abi]) fail(`APK signature evidence has changed for ${abi}`);
    expected.set(`LVL-${version}-${abi === "arm64-v8a" ? "arm64" : abi}.apk`, file);
  }
  fileCheck(notice);
  expected.set("LVL-Android-RELEASE-NOTICE.txt", notice);
  const absoluteOut = path.resolve(outDir);
  if ([apkDir, path.dirname(apkDir), path.dirname(evidence)].map((dir) => path.resolve(dir)).includes(absoluteOut)) fail("unsafe output folder");
  fs.mkdirSync(absoluteOut, { recursive: true });
  if (fs.readdirSync(absoluteOut).length) fail("output directory must be empty");
  for (const [name, source] of expected) fs.copyFileSync(source, path.join(absoluteOut, name));
  const sums = [...expected.keys()].sort().map((name) => `${digest(path.join(absoluteOut, name))}  ${name}\n`).join("");
  fs.writeFileSync(path.join(absoluteOut, "SHA256SUMS"), sums);
  return verifyReleaseDirectory({ dir: absoluteOut, version, evidence });
}

function argsToOptions(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!["--apk-dir", "--out-dir", "--verify-out", "--version", "--evidence", "--notice"].includes(argv[i]) || !argv[i + 1] || opts[argv[i]]) fail("expected --apk-dir + --out-dir OR --verify-out, plus --version and --evidence");
    opts[argv[i]] = argv[i + 1];
  }
  for (const name of ["--version", "--evidence"]) if (!opts[name]) fail(`missing ${name}`);
  if (opts["--verify-out"]) {
    if (opts["--apk-dir"] || opts["--out-dir"] || opts["--notice"]) fail("--verify-out cannot package assets");
    return { verify: true, dir: opts["--verify-out"], version: opts["--version"], evidence: opts["--evidence"] };
  }
  if (!opts["--apk-dir"] || !opts["--out-dir"]) fail("packaging requires --apk-dir and --out-dir");
  return { apkDir: opts["--apk-dir"], outDir: opts["--out-dir"], version: opts["--version"], evidence: opts["--evidence"], notice: opts["--notice"] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const opts = argsToOptions(process.argv.slice(2));
    console.log(JSON.stringify(opts.verify ? verifyReleaseDirectory(opts) : releaseAssets(opts)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
