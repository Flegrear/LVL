// Build-only GitHub Actions input artifact for the self-contained Android APKs.
// Nothing in this module creates a GitHub Release, reads signing keys or installs APKs.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import { checkNativeSources } from "./release-check.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ZIP = "LVL-android-native.zip";
const SUM = `${ZIP}.sha256`;
const MANIFEST = "LVL-android-native.build-manifest.json";
const ARTIFACT_NAME = "lvl-android-native-inputs";
const FORMAT = "lvl-android-native-artifact-v1";
const WORKFLOW = ".github/workflows/android-native.yml";
const REPO = "Flegrear/LVL";
const SHA256 = /^[a-f0-9]{64}$/;
const SHA40 = /^[a-f0-9]{40}$/;
const VERSION = { node: "24.22.2", ffmpeg: "7.1.5", libwebp: "1.6.0", api: 31 };
const RECIPES = [".github/workflows/android-native.yml", "android/native/Dockerfile", "android/native/build-node.sh", "android/native/build-ffmpeg.sh",
  "android/native/docker-build.ps1", "android/tools/release-check.mjs", "android/tools/native-artifact.mjs"];
const fail = (reason) => { throw new Error(`Android native artifact: ${reason}`); };
const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const fileDigest = (file) => digest(fs.readFileSync(file));
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
const ordinary = (file) => {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink() || !stat.size) fail(`missing or non-ordinary file: ${file}`);
  return stat;
};

export function expectedNativePaths() {
  const names = [];
  for (const abi of ["arm64-v8a", "x86_64"]) {
    for (const file of ["node", "BUILDINFO.txt", "LICENSE.node.txt"]) names.push(`node/${abi}/${file}`);
    for (const file of ["ffmpeg", "ffprobe", "BUILDINFO.txt", "LICENSE.ffmpeg.txt", "LICENSE.libwebp.txt"])
      names.push(`ffmpeg/${abi}/${file}`);
  }
  return names.sort();
}

function recipeHashes(root) {
  // The native workflow builds on Linux while APK releases verify on Windows.
  // Bind exact script text with canonical LF line endings, not Git's platform-
  // dependent checkout CRLF conversion. The Git source commit is pinned above.
  return Object.fromEntries(RECIPES.map((name) => {
    const contents = fs.readFileSync(path.join(root, ...name.split("/")), "utf8").replace(/\r\n/g, "\n");
    return [name, digest(Buffer.from(contents, "utf8"))];
  }));
}

function sourceInfo(root) {
  let first = null;
  for (const abi of ["arm64-v8a", "x86_64"]) {
    const node = fs.readFileSync(path.join(root, "node", abi, "BUILDINFO.txt"), "utf8");
    const ffmpeg = fs.readFileSync(path.join(root, "ffmpeg", abi, "BUILDINFO.txt"), "utf8");
    const source = {
      node: { version: VERSION.node, sha256: new RegExp(`^node-v${VERSION.node.replaceAll(".", "\\.")}\\.tar\\.xz sha256 ([a-f0-9]{64})$`, "m").exec(node)?.[1] },
      ffmpeg: { version: VERSION.ffmpeg, sha256: new RegExp(`^ffmpeg-${VERSION.ffmpeg.replaceAll(".", "\\.")}\\.tar\\.xz sha256 ([a-f0-9]{64})$`, "m").exec(ffmpeg)?.[1] },
      libwebp: { version: VERSION.libwebp, sha256: new RegExp(`^libwebp-${VERSION.libwebp.replaceAll(".", "\\.")}\\.tar\\.gz sha256 ([a-f0-9]{64})$`, "m").exec(ffmpeg)?.[1] },
    };
    if (!Object.values(source).every((part) => SHA256.test(part.sha256 || "")))
      fail(`missing matching Node/FFmpeg/libwebp source digest in ${abi} BUILDINFO`);
    if (!node.startsWith(`node ${VERSION.node} for Android ${abi} (API ${VERSION.api}),`) ||
        !ffmpeg.startsWith(`FFmpeg ${VERSION.ffmpeg} + libwebp ${VERSION.libwebp} for Android ${abi} (API ${VERSION.api}),`))
      fail(`native version or API differs from pinned build for ${abi}`);
    if (first && !same(first, source)) fail("source archive digests differ between ABIs");
    first = source;
  }
  return first;
}

function nativeEntries(nativeDir) {
  checkNativeSources(nativeDir);
  return expectedNativePaths().map((name) => {
    const file = path.join(nativeDir, ...name.split("/"));
    return { path: name, bytes: ordinary(file).size, sha256: fileDigest(file) };
  });
}

function checkManifest(manifest, { sourceSha, projectRoot }) {
  if (manifest?.format !== FORMAT || manifest.repository !== REPO || manifest.workflow !== WORKFLOW ||
      !SHA40.test(manifest.sourceCommit || "") || manifest.sourceCommit !== sourceSha ||
      !same(manifest.versions, VERSION) || !SHA256.test(manifest.zipSha256 || "") ||
      !same(Object.keys(manifest.recipes || {}).sort(), [...RECIPES].sort()) ||
      !same(manifest.recipes, recipeHashes(projectRoot))) {
    fail("build manifest repository, source commit, recipe or version hash mismatch");
  }
  if (!Array.isArray(manifest.entries) || !same(manifest.entries.map((entry) => entry.path), expectedNativePaths()) ||
      manifest.entries.some((entry) => !positiveInteger(entry.bytes) || !SHA256.test(entry.sha256 || "")))
    fail("build manifest must contain exactly sixteen pinned native inputs");
  for (const name of ["node", "ffmpeg", "libwebp"]) {
    if (manifest.sources?.[name]?.version !== VERSION[name] ||
        !SHA256.test(manifest.sources?.[name]?.sha256 || "")) fail(`missing pinned ${name} source archive hash`);
  }
}

export function makeNativeBundle({ nativeDir, outDir, sourceSha, projectRoot = ROOT }) {
  if (!SHA40.test(sourceSha || "")) fail("a trusted 40-character source commit is required");
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length) fail("native bundle output must be empty");
  const entries = nativeEntries(nativeDir);
  const sources = sourceInfo(nativeDir);
  const archive = new AdmZip();
  for (const entry of entries) {
    const bytes = fs.readFileSync(path.join(nativeDir, ...entry.path.split("/")));
    if (bytes.length !== entry.bytes || digest(bytes) !== entry.sha256) fail("native input changed during packaging");
    archive.addFile(entry.path, bytes);
  }
  const archiveEntries = archive.getEntries().filter((entry) => !entry.isDirectory).map((entry) => entry.entryName).sort();
  if (!same(archiveEntries, expectedNativePaths())) fail("native ZIP contains unexpected paths");
  const zipBytes = archive.toBuffer();
  if (zipBytes.length > 200 * 1024 * 1024) fail("native input ZIP exceeds size cap");
  const manifest = { format: FORMAT, repository: REPO, workflow: WORKFLOW, sourceCommit: sourceSha,
    versions: { ...VERSION }, recipes: recipeHashes(projectRoot), sources, entries, zipSha256: digest(zipBytes) };
  checkManifest(manifest, { sourceSha, projectRoot });
  fs.mkdirSync(outDir, { recursive: true });
  for (const name of [ZIP, SUM, MANIFEST]) if (fs.existsSync(path.join(outDir, name))) fail("refusing to overwrite native artifact");
  fs.writeFileSync(path.join(outDir, ZIP), zipBytes, { flag: "wx" });
  fs.writeFileSync(path.join(outDir, SUM), `${manifest.zipSha256}  ${ZIP}\n`, { flag: "wx" });
  fs.writeFileSync(path.join(outDir, MANIFEST), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
  return { manifest };
}

export function verifyNativeBundle({ bundleDir, expectedZipSha, sourceSha, projectRoot = ROOT, extractDir }) {
  if (!SHA256.test(expectedZipSha || "")) fail("explicit pinned native ZIP SHA-256 is required");
  if (!SHA40.test(sourceSha || "")) fail("verified native workflow commit SHA is required");
  if (!same(fs.readdirSync(bundleDir).sort(), [ZIP, SUM, MANIFEST].sort())) fail("native artifact contains unexpected files");
  if (ordinary(path.join(bundleDir, MANIFEST)).size > 1024 * 1024 ||
      ordinary(path.join(bundleDir, SUM)).size > 256) fail("native checksum or build manifest exceeds its size cap");
  const manifest = JSON.parse(fs.readFileSync(path.join(bundleDir, MANIFEST), "utf8"));
  checkManifest(manifest, { sourceSha, projectRoot });
  if (manifest.zipSha256 !== expectedZipSha) fail("native ZIP SHA differs from approved pin");
  const zipFile = path.join(bundleDir, ZIP);
  if (ordinary(zipFile).size > 200 * 1024 * 1024 || fileDigest(zipFile) !== expectedZipSha) fail("native ZIP SHA mismatch");
  if (fs.readFileSync(path.join(bundleDir, SUM), "utf8") !== `${expectedZipSha}  ${ZIP}\n`) fail("native checksum file mismatch");
  const archive = new AdmZip(zipFile);
  const entries = archive.getEntries();
  // Directory records are harmless; never extract them or arbitrary ZIP paths.
  const names = entries.filter((entry) => !entry.isDirectory).map((entry) => entry.entryName).sort();
  if (!same(names, expectedNativePaths()) || new Set(names).size !== 16 ||
      entries.some((entry) => entry.isDirectory && !/^(?:node|ffmpeg)\/(?:arm64-v8a|x86_64)?\/?$/.test(entry.entryName)))
    fail("native ZIP inventory differs from approved sixteen files");
  for (const item of manifest.entries) {
    const bytes = archive.getEntry(item.path)?.getData();
    if (!bytes || bytes.length !== item.bytes || digest(bytes) !== item.sha256) fail(`native ZIP input hash mismatch: ${item.path}`);
  }
  if (extractDir) {
    if (fs.existsSync(extractDir) && fs.readdirSync(extractDir).length) fail("extraction destination must be empty");
    fs.mkdirSync(extractDir, { recursive: true });
    for (const item of manifest.entries) {
      const destination = path.join(extractDir, ...item.path.split("/"));
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, archive.getEntry(item.path).getData(), { flag: "wx" });
    }
    if (!same(nativeEntries(extractDir), manifest.entries) || !same(sourceInfo(extractDir), manifest.sources))
      fail("extracted ELF, source or license provenance differs from build manifest");
  }
  return { zipSha256: expectedZipSha, sourceCommit: sourceSha, count: 16 };
}

// Verified metadata is a prerequisite for actions/download-artifact. Never use the
// metadata's archive URL directly: download only by the approved ID + run ID.
export function validateArtifactMetadata({ artifact, run, workflow, artifactId, repository, repositoryId, now = Date.now() }) {
  const id = Number(artifactId);
  const repoId = Number(repositoryId);
  const created = Date.parse(artifact?.created_at || "");
  const expires = Date.parse(artifact?.expires_at || "");
  const runCreated = Date.parse(run?.created_at || "");
  // A successful re-run must not bless an artifact uploaded by an earlier,
  // unsuccessful attempt of the same workflow run ID.
  const attemptStarted = Date.parse(run?.run_started_at || "");
  if (!positiveInteger(id) || String(id) !== String(artifactId) || !positiveInteger(repoId) ||
      String(repoId) !== String(repositoryId) || repository !== REPO ||
      !positiveInteger(artifact?.id) || artifact.id !== id || artifact.name !== ARTIFACT_NAME ||
      !positiveInteger(artifact.size_in_bytes) || artifact.size_in_bytes > 250 * 1024 * 1024 ||
      artifact.expired !== false || !Number.isFinite(created) || !Number.isFinite(expires) ||
      created > now || expires <= now || expires <= created || expires - created > 90 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000)
    fail("artifact ID, name or expiry is invalid");
  const trustedRepo = (value) => value?.full_name === REPO && value?.id === repoId;
  // GitHub REST workflow runs use a plain path or a main-branch suffix,
  // depending on the endpoint/version. Do not accept arbitrary refs or trim
  // an unknown suffix: the workflow ID, path and branch checks also apply.
  const trustedWorkflowPath = [WORKFLOW, `${WORKFLOW}@main`, `${WORKFLOW}@refs/heads/main`].includes(run?.path);
  if (!trustedRepo(run?.repository) || !trustedRepo(run?.head_repository) ||
      artifact.workflow_run?.repository_id !== repoId || artifact.workflow_run?.head_repository_id !== repoId)
    fail("artifact or workflow run repository is not the trusted repository");
  if (!positiveInteger(run?.id) || artifact.workflow_run?.id !== run.id ||
      run.status !== "completed" || run.conclusion !== "success" || run.event !== "workflow_dispatch" ||
      run.head_branch !== "main" || !SHA40.test(run.head_sha || "") ||
      artifact.workflow_run?.head_sha !== run.head_sha ||
      artifact.workflow_run?.head_branch !== "main" ||
      !trustedWorkflowPath ||
      !positiveInteger(workflow?.id) || run.workflow_id !== workflow.id ||
      workflow.path !== WORKFLOW || workflow.state !== "active" ||
      !Number.isFinite(runCreated) || !Number.isFinite(attemptStarted) ||
      !positiveInteger(run?.run_attempt) || runCreated > attemptStarted ||
      attemptStarted > created || attemptStarted > now) {
    fail("artifact was not produced by a successful trusted main native workflow run");
  }
  return { runId: run.id, headSha: run.head_sha };
}

function parseArgs(argv) {
  const args = {};
  const command = argv.shift();
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith("--") || !argv[i + 1] || args[argv[i]]) fail("expected distinct --option value pairs");
    args[argv[i]] = argv[i + 1];
  }
  const exact = {
    pack: ["--native-dir", "--out-dir", "--source-sha"],
    "verify-bundle": ["--bundle-dir", "--sha", "--source-sha", "--extract-dir"],
    "verify-metadata": ["--artifact-file", "--run-file", "--workflow-file", "--artifact-id", "--repo", "--repo-id"],
  }[command];
  if (!exact || !same(Object.keys(args).sort(), [...exact].sort())) fail("invalid native artifact command or options");
  return { command, args };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { command, args } = parseArgs(process.argv.slice(2));
    const result = command === "pack"
      ? makeNativeBundle({ nativeDir: args["--native-dir"], outDir: args["--out-dir"], sourceSha: args["--source-sha"] })
      : command === "verify-bundle"
        ? verifyNativeBundle({ bundleDir: args["--bundle-dir"], expectedZipSha: args["--sha"],
          sourceSha: args["--source-sha"], extractDir: args["--extract-dir"] })
        : validateArtifactMetadata({ artifact: JSON.parse(fs.readFileSync(args["--artifact-file"], "utf8")),
          run: JSON.parse(fs.readFileSync(args["--run-file"], "utf8")),
          workflow: JSON.parse(fs.readFileSync(args["--workflow-file"], "utf8")),
          artifactId: args["--artifact-id"], repository: args["--repo"], repositoryId: args["--repo-id"] });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
