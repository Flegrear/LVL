// A release page advertises independent platform versions through one manifest.
// Unchanged platform downloads stay at their original, verified release URLs.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { verifyReleaseDirectory } from "../android/tools/release-assets.mjs";
import AdmZip from "adm-zip";

const REPO = "Flegrear/LVL";
const PREFIX = `https://github.com/${REPO}/releases/download/`;
const TAG = /^release-\d{4}-\d{2}-\d{2}\.[1-9]\d*$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const HASH = /^[a-f0-9]{64}$/;
const SMALL = 64 * 1024;
const APK_LIMIT = 400 * 1024 * 1024;
const WINDOWS_LIMIT = 2 * 1024 * 1024 * 1024;
const fail = (message) => { throw new Error(`Combined release: ${message}`); };
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const jsonFile = (file) => JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
const isObject = (value) => value && typeof value === "object" && !Array.isArray(value);
const equalSet = (left, right) => left.length === right.length && [...left].sort().every((v, i) => v === [...right].sort()[i]);
const gh = (args) => execFileSync("gh", args, { encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 180_000 });
const api = (route) => JSON.parse(gh(["api", `repos/${REPO}/${route}`]));

function version(value, android = false) {
  if (typeof value !== "string" || !VERSION.test(value) ||
      value.split(".").some((part) => !Number.isSafeInteger(Number(part)) || Number(part) > (android ? 9999 : 2147483647))) fail("invalid platform version");
  return value;
}
function checkAsset(record, name, platformVersion, platform, limit) {
  if (!isObject(record) || record.name !== name || typeof record.url !== "string" ||
      !Number.isSafeInteger(record.size) || record.size <= 0 || record.size > limit || !HASH.test(record.sha256 || "")) fail(`invalid asset: ${name}`);
  if (!record.url.startsWith(PREFIX)) fail(`foreign asset URL: ${name}`);
  const tail = record.url.slice(PREFIX.length).split("/");
  const source = tail[0];
  const legacy = `${platform === "android" ? "android-v" : "v"}${platformVersion}`;
  if (tail.length !== 2 || tail[1] !== name || (source !== legacy && !TAG.test(source)) || record.url !== `${PREFIX}${source}/${name}`) fail(`invalid source URL: ${name}`);
  return source;
}
export function platformAssets(platform, entry) {
  return platform === "windows" ? [entry.asset, entry.checksums] : [entry.apks.arm64, entry.apks.x86_64, entry.checksums, entry.notice];
}
export function validateManifest(manifest) {
  if (!isObject(manifest) || manifest.schemaVersion !== 1 || typeof manifest.tag !== "string" || !TAG.test(manifest.tag) ||
      !isObject(manifest.platforms) || !equalSet(Object.keys(manifest.platforms), ["windows", "android"])) fail("invalid schema, release tag or platform inventory");
  const windows = manifest.platforms.windows;
  const android = manifest.platforms.android;
  if (!isObject(windows) || !isObject(android)) fail("missing platform entries");
  version(windows.version);
  version(android.version, true);
  if (!["patch", "installer"].includes(windows.kind)) fail("invalid Windows update kind");
  const name = windows.kind === "patch" ? `LVL-update-v${windows.version}.zip` : "LVL-Setup.exe";
  const winSource = checkAsset(windows.asset, name, windows.version, "windows", WINDOWS_LIMIT);
  if (![`${name}.sha256`, "SHA256SUMS"].includes(windows.checksums?.name) ||
      checkAsset(windows.checksums, windows.checksums.name, windows.version, "windows", SMALL) !== winSource) fail("Windows checksum source mismatch");
  if (!Number.isSafeInteger(android.versionCode) || android.versionCode < 205 || android.versionCode > 2147483647 ||
      !isObject(android.apks) || !equalSet(Object.keys(android.apks), ["arm64", "x86_64"])) fail("invalid Android version code or ABIs");
  const sources = ["arm64", "x86_64"].map((abi) => checkAsset(android.apks[abi], `LVL-${android.version}-${abi}.apk`, android.version, "android", APK_LIMIT));
  sources.push(checkAsset(android.checksums, "SHA256SUMS", android.version, "android", SMALL));
  sources.push(checkAsset(android.notice, "LVL-Android-RELEASE-NOTICE.txt", android.version, "android", SMALL));
  if (new Set(sources).size !== 1) fail("Android source tags disagree");
  const attached = currentAssets(manifest);
  if (new Set(attached.map((a) => a.name)).size !== attached.length) fail("duplicate current release asset names");
  if (Buffer.byteLength(JSON.stringify(manifest), "utf8") > SMALL) fail("manifest exceeds size limit");
  return manifest;
}
export function currentAssets(manifest) {
  return Object.entries(manifest.platforms).flatMap(([platform, entry]) => platformAssets(platform, entry))
    .filter((asset) => asset.url.startsWith(`${PREFIX}${manifest.tag}/`));
}
function ordinaryFile(file, max = WINDOWS_LIMIT) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > max) fail(`missing or invalid file: ${file}`);
  return stat;
}
export function verifyCombinedDirectory(dir) {
  ordinaryFile(path.join(dir, "LVL-release.json"), SMALL);
  const manifest = validateManifest(jsonFile(path.join(dir, "LVL-release.json")));
  const assets = currentAssets(manifest);
  if (!equalSet(fs.readdirSync(dir), ["LVL-release.json", ...assets.map((a) => a.name)])) fail("combined asset inventory mismatch");
  for (const asset of assets) {
    const file = path.join(dir, asset.name);
    if (ordinaryFile(file).size !== asset.size || sha256(fs.readFileSync(file)) !== asset.sha256) fail(`asset hash or size mismatch: ${asset.name}`);
  }
  return manifest;
}
export function releaseTitle(manifest) {
  validateManifest(manifest);
  return `LVL Windows ${manifest.platforms.windows.version} - Android ${manifest.platforms.android.version}`;
}
export function releaseNotes(manifest, installerUrl = `${PREFIX}v0.2.0/LVL-Setup.exe`, changes = {}) {
  validateManifest(manifest);
  if (!installerUrl.startsWith(PREFIX) || !installerUrl.endsWith("/LVL-Setup.exe")) fail("invalid base installer URL");
  const { windows, android } = manifest.platforms;
  const installer = windows.kind === "installer" ? windows.asset.url : installerUrl;
  return `Windows ${windows.version} · Android ${android.version}\n\n`
    + `- **Windows:** [Download the installer](${installer}).${windows.kind === "patch" ? " This installs the base version; use Settings → Updates for the current version." : ""}\n`
    + `- **Android:** [Download for phones and tablets (ARM64)](${android.apks.arm64.url}) or [emulators (x86_64)](${android.apks.x86_64.url}). Android 12 or newer; each APK includes everything needed.\n\n`
    + "Each app checks its own version. A release for one platform does not reinstall the unchanged app on another platform.\n\n"
    + ["windows", "android"].map((platform) => `**${platform === "windows" ? "Windows" : "Android"} ${manifest.platforms[platform].version}:**${changes[platform] ? `\n${changes[platform]}` : " unchanged."}`).join("\n\n") + "\n";
}
export function changelogSection(text, value) {
  version(value);
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => new RegExp(`^## ${value.replaceAll(".", "\\.")} — \\d{4}-\\d{2}-\\d{2}$`).test(line));
  if (start < 0) fail("review artifact lacks its version's release notes");
  const next = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  const section = lines.slice(start + 1, next < 0 ? undefined : next).join("\n").trim();
  if (!section || Buffer.byteLength(section, "utf8") > SMALL) fail("review artifact release notes are empty or too large");
  return section;
}
function compare(left, right) {
  const a = version(left).split(".").map(Number), b = version(right).split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}
export function validatePlatformAdvance(platform, entry, published, fresh) {
  if (!["windows", "android"].includes(platform)) fail("invalid platform admission request");
  version(entry.version, platform === "android");
  if (platform === "android" && (!Number.isSafeInteger(entry.versionCode) || entry.versionCode < 205 || entry.versionCode > 2147483647))
    fail("Android admission requires a valid versionCode");
  // Public Android names and installation codes must describe a single
  // monotone history. A conflicting public history cannot be resolved merely
  // by retaining an older signed APK or choosing a new calendar release tag.
  if (platform === "android") {
    for (let i = 0; i < published.length; i++) {
      const earlier = published[i];
      version(earlier.version, true);
      if (!Number.isSafeInteger(earlier.versionCode) || earlier.versionCode < 205 || earlier.versionCode > 2147483647)
        fail("published Android release has an invalid versionCode");
      for (let j = 0; j < i; j++) {
        const other = published[j];
        const order = compare(earlier.version, other.version);
        const codeOrder = Math.sign(earlier.versionCode - other.versionCode);
        if (order !== codeOrder) fail("conflicting published Android version/code history");
      }
    }
  }
  for (const previous of published) {
    const difference = compare(entry.version, previous.version);
    if (difference < 0 || (fresh && difference === 0)) fail(`${platform} version must ${fresh ? "advance" : "not regress"} relative to published releases`);
    if (platform === "android") {
      if (fresh && entry.versionCode <= previous.versionCode) fail("Android versionCode must advance");
      if (!fresh && entry.versionCode < previous.versionCode) fail("retained Android versionCode would regress below a published installation code");
      if (!fresh && difference === 0 && entry.versionCode !== previous.versionCode) fail("retained Android versionCode differs from published version");
    }
  }
}

/** Recheck the prepared independent platform manifest before public transition.
 * Release workflows hold the shared repository-wide publication concurrency
 * authority while calling this and making the subsequent GitHub draft public.
 */
export function validatePreparedReleaseAdmission(manifest, published) {
  validateManifest(manifest);
  if (!isObject(published) || !Array.isArray(published.windows) || !Array.isArray(published.android))
    fail("invalid published platform admission inventory");
  for (const platform of ["windows", "android"]) {
    const entry = manifest.platforms[platform];
    const sources = platformAssets(platform, entry).map((record) => record.url.slice(PREFIX.length).split("/")[0]);
    const attachedCount = sources.filter((source) => source === manifest.tag).length;
    if (attachedCount && attachedCount !== sources.length)
      fail(`${platform} mixes retained and fresh asset sources`);
    validatePlatformAdvance(platform, entry, published[platform], attachedCount === sources.length);
  }
  return manifest;
}
export function selectWindowsBase(candidates, target) {
  version(target);
  let best = null;
  for (const candidate of candidates) {
    version(candidate.version);
    if (!(/^v\d+\.\d+\.\d+$/.test(candidate.ref) || TAG.test(candidate.ref))) fail("invalid Windows patch source ref");
    if (compare(candidate.version, target) < 0 && (!best || compare(candidate.version, best.version) > 0)) best = candidate;
  }
  return best;
}
export function latestWindowsInstaller(candidates) {
  let selected = null;
  for (const candidate of candidates) {
    if (!candidate.installerUrl) continue;
    const url = candidate.installerUrl;
    const source = url.startsWith(PREFIX) ? url.slice(PREFIX.length).split("/")[0] : "";
    if (!(TAG.test(source) || source === `v${version(candidate.version)}`) || url !== `${PREFIX}${source}/LVL-Setup.exe`) fail("invalid published installer URL");
    if (!selected || compare(candidate.version, selected.version) > 0) selected = candidate;
  }
  if (!selected) fail("no published full Windows installer is available");
  return selected.installerUrl;
}
// Injected readers permit offline fixture coverage of the same complete
// combined+legacy inventory scanned by the legacy publication workflows.
export async function publishedPlatforms({
  getPage = (page) => api(`releases?per_page=20&page=${page}`),
  getManifest = async (record) => validateManifest(JSON.parse((await downloadSmall(recordFromApi(record))).toString("utf8"))),
  readAndroidTag = (tag) => JSON.parse(execFileSync("git", ["show", `${tag}:android/app-version.json`], { encoding: "utf8", windowsHide: true })),
} = {}) {
  const candidates = { windows: [], android: [] };
  for (let page = 1; page <= 10; page++) {
    const releases = await getPage(page);
    if (!Array.isArray(releases) || releases.length > 20) fail("invalid published release page");
    for (const release of releases) {
      if (release.draft || release.prerelease) continue;
      const tag = release.tag_name;
      if (TAG.test(tag)) {
        if (!Array.isArray(release.assets)) fail("invalid combined release assets");
        const rows = release.assets.filter((asset) => asset.name === "LVL-release.json");
        if (rows.length !== 1) fail("published combined manifest missing");
        const manifest = await getManifest(rows[0]);
        if (manifest.tag !== tag) fail("published combined manifest tag mismatch");
        for (const platform of ["windows", "android"]) {
          const entry = manifest.platforms[platform];
          const payload = platform === "windows" ? entry.asset : entry.apks.arm64;
          candidates[platform].push({ version: entry.version, ref: payload.url.slice(PREFIX.length).split("/")[0], versionCode: entry.versionCode,
            ...(platform === "windows" && entry.kind === "installer" ? { installerUrl: entry.asset.url } : {}) });
        }
      } else if (/^v\d+\.\d+\.\d+$/.test(tag)) {
        const value = version(tag.slice(1));
        if (!Array.isArray(release.assets)) fail("invalid legacy Windows release assets");
        if (release.assets.some((asset) => ["LVL-Setup.exe", `LVL-update-v${value}.zip`].includes(asset.name))) candidates.windows.push({ version: value, ref: tag,
          ...(release.assets.some((asset) => asset.name === "LVL-Setup.exe" && asset.browser_download_url === `${PREFIX}${tag}/LVL-Setup.exe`) ? { installerUrl: `${PREFIX}${tag}/LVL-Setup.exe` } : {}) });
      } else if (/^android-v\d+\.\d+\.\d+$/.test(tag)) {
        const value = version(tag.slice(9), true);
        if (!Array.isArray(release.assets)) fail("invalid legacy Android release assets");
        if (release.assets.some((asset) => asset.name === `LVL-${value}-arm64.apk`)) {
          const config = await readAndroidTag(tag);
          if (config.version !== value || !Number.isInteger(config.versionCode) || config.versionCode < 205 || config.versionCode > 2147483647) fail("published Android source version/code mismatch");
          candidates.android.push({ version: value, ref: tag, versionCode: config.versionCode });
        }
      }
    }
    if (releases.length < 20) return candidates;
  }
  fail("published platform search exceeded 200 releases");
}
function recordFromFile(tag, dir, name) {
  const file = path.join(dir, name);
  const size = ordinaryFile(file).size;
  return { name, url: `${PREFIX}${tag}/${name}`, size, sha256: sha256(fs.readFileSync(file)) };
}
function recordFromApi(asset) {
  if (!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest || "")) fail("published asset lacks a verified GitHub SHA256 digest");
  return { name: asset.name, url: asset.browser_download_url, size: asset.size, sha256: asset.digest.slice(7) };
}
function checkSums(text, records) {
  const lines = new Map();
  const content = text.replace(/^\uFEFF/, "").trim();
  if (/^[a-f0-9]{64}$/i.test(content) && records.length === 1) {
    if (content.toLowerCase() !== records[0].sha256) fail("dedicated checksum does not match its payload");
    return;
  }
  for (const line of content.split(/\r?\n/)) {
    const match = /^([a-fA-F0-9]{64})\s+\*?([^\r\n]+)$/.exec(line);
    if (!match || lines.has(match[2])) fail("malformed or duplicate checksum entry");
    lines.set(match[2], match[1].toLowerCase());
  }
  for (const record of records) if (lines.get(record.name) !== record.sha256) fail(`checksum disagrees with ${record.name}`);
}
async function downloadSmall(record) {
  if (!record.url.startsWith(PREFIX) || record.size > SMALL) fail("invalid metadata download");
  const response = await fetch(record.url, { signal: AbortSignal.timeout(60_000), headers: { "User-Agent": "LVL-release" } });
  if (!response.ok) fail(`metadata download failed: HTTP ${response.status}`);
  const chunks = []; let total = 0;
  for await (const chunk of response.body) { total += chunk.length; if (total > SMALL) fail("metadata download exceeds limit"); chunks.push(chunk); }
  const bytes = Buffer.concat(chunks);
  if (bytes.length !== record.size || sha256(bytes) !== record.sha256) fail("published metadata digest mismatch");
  return bytes;
}
export function validateBuildIdentity(run, artifact, platform, sourceCommit) {
  const expectedWorkflow = platform === "windows" ? ".github/workflows/release.yml" : ".github/workflows/android-release.yml";
  const prefix = platform === "windows" ? "lvl-windows-release-review" : "lvl-android-signed-review";
  if (run.repository?.full_name !== REPO || run.head_repository?.full_name !== REPO || run.path !== expectedWorkflow ||
      run.event !== "workflow_dispatch" || run.head_branch !== "main" || run.head_sha !== sourceCommit || run.status !== "completed" || run.conclusion !== "success" ||
      !Number.isSafeInteger(run.id) || !Number.isSafeInteger(run.run_attempt) ||
      artifact.expired !== false || artifact.name !== `${prefix}-${run.id}-${run.run_attempt}` || artifact.workflow_run?.head_sha !== sourceCommit ||
      !/^sha256:[a-f0-9]{64}$/.test(artifact.digest || "")) fail(`untrusted ${platform} build artifact identity`);
}
async function retainedPlatform(platform, tag) {
  if (!(TAG.test(tag) || (platform === "windows" ? /^v\d+\.\d+\.\d+$/ : /^android-v\d+\.\d+\.\d+$/).test(tag))) fail("invalid retained release tag");
  const release = api(`releases/tags/${tag}`);
  if (release.tag_name !== tag || release.draft || release.prerelease) fail("retained source must be a published stable release");
  const find = (name) => {
    const rows = release.assets.filter((asset) => asset.name === name);
    if (rows.length !== 1) fail(`retained release is missing ${name}`);
    return recordFromApi(rows[0]);
  };
  let entry;
  if (TAG.test(tag)) {
    const manifest = validateManifest(JSON.parse((await downloadSmall(find("LVL-release.json"))).toString("utf8")));
    if (manifest.tag !== tag) fail("retained combined release identity mismatch");
    entry = manifest.platforms[platform];
  } else if (platform === "windows") {
    const value = version(tag.slice(1));
    const patch = `LVL-update-v${value}.zip`;
    const name = release.assets.some((asset) => asset.name === patch) ? patch : "LVL-Setup.exe";
    entry = { version: value, kind: name === patch ? "patch" : "installer", asset: find(name), checksums: find(`${name}.sha256`) };
  } else {
    const value = version(tag.slice(9), true);
    const config = JSON.parse(execFileSync("git", ["show", `${tag}:android/app-version.json`], { encoding: "utf8", windowsHide: true }));
    if (config.version !== value) fail("retained Android source identity mismatch");
    entry = { version: value, versionCode: config.versionCode, apks: { arm64: find(`LVL-${value}-arm64.apk`), x86_64: find(`LVL-${value}-x86_64.apk`) }, checksums: find("SHA256SUMS"), notice: find("LVL-Android-RELEASE-NOTICE.txt") };
  }
  // Cross-check every referenced record against its immutable published inventory.
  const inventories = new Map([[tag, release]]);
  for (const record of platformAssets(platform, entry)) {
    const source = record.url.slice(PREFIX.length).split("/")[0];
    if (!inventories.has(source)) inventories.set(source, api(`releases/tags/${source}`));
    const original = inventories.get(source);
    if (original.draft || original.prerelease) fail("retained payload is not published stable");
    const rows = original.assets.filter((asset) => asset.name === record.name);
    const official = rows.length === 1 ? recordFromApi(rows[0]) : null;
    if (!official || ["name", "url", "size", "sha256"].some((key) => official[key] !== record[key])) fail("retained payload inventory changed");
  }
  const payloads = platform === "windows" ? [entry.asset] : [entry.apks.arm64, entry.apks.x86_64, entry.notice];
  checkSums((await downloadSmall(entry.checksums)).toString("utf8"), payloads);
  return entry;
}
function copyReview(platform, dir, tag, sourceCommit, out) {
  const evidence = jsonFile(path.join(dir, "build-evidence.json"));
  const config = platform === "windows" ? jsonFile("package.json") : jsonFile("android/app-version.json");
  if (evidence.repository !== REPO || evidence.sourceCommit !== sourceCommit || evidence.eventName !== "workflow_dispatch" || evidence.gitRef !== "refs/heads/main" || evidence.version !== config.version) fail("review build/source identity mismatch");
  const assets = path.join(dir, "assets");
  let entry;
  if (platform === "windows") {
    if (evidence.format !== "lvl-windows-review-v1" || !["patch", "full"].includes(evidence.mode)) fail("invalid Windows build evidence");
    const name = evidence.mode === "patch" ? `LVL-update-v${config.version}.zip` : "LVL-Setup.exe";
    if (!equalSet(fs.readdirSync(assets), [name, `${name}.sha256`])) fail("invalid Windows review inventory");
    entry = { version: config.version, kind: evidence.mode === "patch" ? "patch" : "installer", asset: recordFromFile(tag, assets, name), checksums: recordFromFile(tag, assets, `${name}.sha256`) };
  } else {
    if (evidence.format !== "lvl-android-signed-review-v1" || evidence.versionCode !== config.versionCode || evidence.runtimeGeneration !== config.runtimeGeneration ||
        evidence.desktopSourceVersion !== config.desktopSourceVersion || evidence.signerSha256 !== process.env.LVL_ANDROID_CERT_SHA256?.toLowerCase() ||
        evidence.nativeArtifactId !== process.env.LVL_ANDROID_NATIVE_ARTIFACT_ID || evidence.nativeZipSha256 !== process.env.LVL_ANDROID_NATIVE_SHA256?.toLowerCase()) fail("Android signing/native provenance mismatch");
    const signature = path.join(dir, "signature-evidence.json");
    if (sha256(fs.readFileSync(signature)) !== evidence.signatureEvidenceSha256) fail("Android signature evidence changed");
    const proof = verifyReleaseDirectory({ dir: assets, version: config.version, evidence: signature });
    if (proof.signerSha256 !== evidence.signerSha256) fail("Android signer mismatch");
    entry = { version: config.version, versionCode: config.versionCode, apks: { arm64: recordFromFile(tag, assets, `LVL-${config.version}-arm64.apk`), x86_64: recordFromFile(tag, assets, `LVL-${config.version}-x86_64.apk`) }, checksums: recordFromFile(tag, assets, "SHA256SUMS"), notice: recordFromFile(tag, assets, "LVL-Android-RELEASE-NOTICE.txt") };
  }
  if (!equalSet(Object.keys(evidence.assetHashes || {}), platformAssets(platform, entry).map((a) => a.name))) fail("review evidence asset inventory differs");
  for (const record of platformAssets(platform, entry)) {
    if (evidence.assetHashes[record.name] !== record.sha256) fail("review evidence hash mismatch");
    fs.copyFileSync(path.join(assets, record.name), path.join(out, record.name), fs.constants.COPYFILE_EXCL);
  }
  checkSums(fs.readFileSync(path.join(assets, entry.checksums.name), "utf8"), platform === "windows" ? [entry.asset] : [entry.apks.arm64, entry.apks.x86_64, entry.notice]);
  return entry;
}
function downloadReview(platform, runId, sourceCommit, dir) {
  if (!/^[1-9]\d{0,15}$/.test(runId)) fail("invalid build run ID");
  const run = api(`actions/runs/${runId}`);
  const artifacts = api(`actions/runs/${runId}/artifacts?per_page=100`);
  const prefix = platform === "windows" ? "lvl-windows-release-review" : "lvl-android-signed-review";
  const matches = artifacts.artifacts.filter((a) => a.name === `${prefix}-${run.id}-${run.run_attempt}`);
  if (matches.length !== 1) fail("missing or duplicate build artifact");
  validateBuildIdentity(run, matches[0], platform, sourceCommit);
  const zip = execFileSync("gh", ["api", `repos/${REPO}/actions/artifacts/${matches[0].id}/zip`],
    { windowsHide: true, maxBuffer: 1024 * 1024 * 1024, timeout: 300_000 });
  if (`sha256:${sha256(zip)}` !== matches[0].digest) fail("Actions artifact ZIP digest changed");
  const version = jsonFile(platform === "windows" ? "package.json" : "android/app-version.json").version;
  const allowed = platform === "windows" ? ["build-evidence.json", "assets/LVL-Setup.exe", "assets/LVL-Setup.exe.sha256", `assets/LVL-update-v${version}.zip`, `assets/LVL-update-v${version}.zip.sha256`]
    : ["build-evidence.json", "signature-evidence.json", "assets/SHA256SUMS", "assets/LVL-Android-RELEASE-NOTICE.txt", `assets/LVL-${version}-arm64.apk`, `assets/LVL-${version}-x86_64.apk`];
  const entries = new AdmZip(zip).getEntries();
  const seen = new Set(); let total = 0;
  if (entries.length > 12) fail("too many build artifact entries");
  for (const entry of entries) {
    if (entry.isDirectory) { if (entry.entryName !== "assets/") fail("unexpected artifact directory"); continue; }
    total += entry.header.size;
    if (!allowed.includes(entry.entryName) || seen.has(entry.entryName) || total > 1024 * 1024 * 1024 || ((entry.header.attr >>> 16) & 0xf000) === 0xa000) fail("invalid artifact entry");
    seen.add(entry.entryName);
    const file = path.join(dir, entry.entryName);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, entry.getData(), { flag: "wx" });
  }
  const evidence = jsonFile(path.join(dir, "build-evidence.json"));
  if (String(evidence.workflowRunId) !== String(run.id) || evidence.workflowAttempt !== run.run_attempt) fail("artifact evidence belongs to a different run");
}
async function prepare(opts) {
  if (!TAG.test(opts.tag || "") || !/^[a-f0-9]{40}$/.test(opts.commit || "")) fail("exact combined tag and source commit required");
  const out = path.resolve(opts.out);
  fs.mkdirSync(out, { recursive: true });
  if (fs.readdirSync(out).length) fail("combined output directory must be empty");
  const platforms = {};
  const changes = {};
  const published = await publishedPlatforms();
  for (const platform of ["windows", "android"]) {
    const run = opts[`${platform}-run`]; const retained = opts[`${platform}-release`];
    if (Boolean(run) === Boolean(retained)) fail(`choose exactly one ${platform} build run or retained release`);
    if (run) {
      const dir = path.join(path.dirname(out), `${platform}-review`);
      if (fs.existsSync(dir)) fail("build review destination must not exist");
      downloadReview(platform, run, opts.commit, dir);
      platforms[platform] = copyReview(platform, dir, opts.tag, opts.commit, out);
      changes[platform] = changelogSection(jsonFile(path.join(dir, "build-evidence.json")).releaseNotes, platforms[platform].version);
    } else platforms[platform] = await retainedPlatform(platform, retained);
    validatePlatformAdvance(platform, platforms[platform], published[platform], Boolean(run));
  }
  const manifest = validateManifest({ schemaVersion: 1, tag: opts.tag, platforms });
  fs.writeFileSync(path.join(out, "LVL-release.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  verifyCombinedDirectory(out);
  fs.writeFileSync(path.join(path.dirname(out), "release-notes.txt"), releaseNotes(manifest, latestWindowsInstaller(published.windows), changes));
  fs.writeFileSync(path.join(path.dirname(out), "release-title.txt"), releaseTitle(manifest));
  return manifest;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2); const command = args.shift(); const opts = {};
    for (let i = 0; i < args.length; i += 2) {
      if (!/^--[a-z-]+$/.test(args[i]) || !args[i + 1] || opts[args[i].slice(2)]) fail("invalid arguments");
      opts[args[i].slice(2)] = args[i + 1];
    }
    if (command === "prepare") console.log(JSON.stringify(await prepare(opts)));
    else if (command === "verify" && opts.dir) console.log(JSON.stringify(verifyCombinedDirectory(opts.dir)));
    else if (command === "admit" && opts.dir) {
      const manifest = verifyCombinedDirectory(opts.dir);
      validatePreparedReleaseAdmission(manifest, await publishedPlatforms());
      console.log(JSON.stringify({ admitted: true, tag: manifest.tag }));
    }
    else if (["windows-base", "windows-admit", "android-admit"].includes(command) && opts.version) {
      const published = await publishedPlatforms();
      const platform = command === "android-admit" ? "android" : "windows";
      if (platform === "android" && (!/^[1-9]\d*$/.test(opts["version-code"] || "") || Number(opts["version-code"]) > 2147483647)) fail("Android admission needs --version-code");
      // windows-base also serves trusted manual build-only dispatches. A
      // previously published version may be rebuilt for review, but only an
      // explicit publication admission may require advancing it.
      if (command !== "windows-base") validatePlatformAdvance(platform, { version: opts.version,
        ...(platform === "android" ? { versionCode: Number(opts["version-code"]) } : {}) }, published[platform], true);
      if (command !== "windows-base") { console.log(JSON.stringify({ admitted: true, version: opts.version })); }
      else {
        const selected = selectWindowsBase(published.windows, opts.version);
        if (selected) {
          const source = JSON.parse(execFileSync("git", ["show", `${selected.ref}:package.json`], { encoding: "utf8", windowsHide: true }));
          if (source.version !== selected.version) fail("published Windows payload source version mismatch");
        }
        console.log(JSON.stringify(selected));
      }
    } else fail("expected prepare, verify, admit, windows-base, windows-admit or android-admit");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
