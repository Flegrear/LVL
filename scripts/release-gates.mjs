// Source-only release gates for the legacy Windows and Android channels.
// Publication workflows create drafts, download their assets, and call these
// checks before making a release public. No command here creates a release.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const REPOSITORY = "Flegrear/LVL";
const PREFIX = `https://github.com/${REPOSITORY}/releases/download/`;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const HASH = /^[a-f0-9]{64}$/;
const MiB = 1024 * 1024;
const fail = (message) => { throw new Error(`Release gate: ${message}`); };

function expected({ kind, mode, version, tag }) {
  if (typeof version !== "string" || !VERSION.test(version) ||
      version.split(".").some((value) => !Number.isSafeInteger(Number(value)) || Number(value) > 2147483647))
    fail("invalid canonical version");
  if (kind === "windows") {
    if (!["full", "patch"].includes(mode) || tag !== `v${version}`) fail("Windows mode or release tag mismatch");
    const payload = mode === "full" ? "LVL-Setup.exe" : `LVL-update-v${version}.zip`;
    return { payloads: [payload], checksum: `${payload}.sha256`,
      max: { [payload]: mode === "full" ? 2048 * MiB : 80 * MiB, [`${payload}.sha256`]: 64 * 1024 } };
  }
  if (kind === "android") {
    if (mode !== undefined && mode !== null && mode !== "" || tag !== `android-v${version}`)
      fail("Android release tag or mode mismatch");
    const payloads = [`LVL-${version}-arm64.apk`, `LVL-${version}-x86_64.apk`, "LVL-Android-RELEASE-NOTICE.txt"];
    return { payloads, checksum: "SHA256SUMS", max: Object.fromEntries(
      [...payloads.map((name) => [name, name.endsWith(".apk") ? 400 * MiB : 64 * 1024]), ["SHA256SUMS", 64 * 1024]]) };
  }
  fail("unsupported platform");
}

function ordinaryFile(file, max) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > max)
    fail(`missing or invalid asset: ${path.basename(file)}`);
  return stat;
}

function digestFile(file) {
  const hash = createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const chunk = Buffer.allocUnsafe(MiB);
    for (;;) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!n) return hash.digest("hex");
      hash.update(chunk.subarray(0, n));
    }
  } finally { fs.closeSync(fd); }
}

function inventory(dir, names, limits) {
  const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!stat?.isDirectory() || stat.isSymbolicLink()) fail("missing or invalid asset directory");
  const present = fs.readdirSync(dir);
  if (present.length !== names.length || names.some((name) => !present.includes(name)))
    fail("asset inventory missing or contains an unexpected file");
  const result = new Map();
  for (const name of names) {
    const file = path.join(dir, name);
    const info = ordinaryFile(file, limits[name]);
    result.set(name, { name, size: info.size, sha256: digestFile(file) });
  }
  return result;
}

function checksumContents(dir, metadata, spec, kind) {
  const text = fs.readFileSync(path.join(dir, spec.checksum), "utf8");
  const expectedText = kind === "windows"
    ? `${metadata.get(spec.payloads[0]).sha256} *${spec.payloads[0]}\n`
    : spec.payloads.slice().sort().map((name) => `${metadata.get(name).sha256}  ${name}\n`).join("");
  if (text !== expectedText) fail("checksum contents, filenames or payload digest mismatch");
}

/** Verify exact local asset inventory and checksum content before creating a draft. */
export function verifyLocalRelease(opts) {
  const spec = expected(opts);
  const names = [...spec.payloads, spec.checksum];
  const metadata = inventory(opts.localDir, names, spec.max);
  checksumContents(opts.localDir, metadata, spec, opts.kind);
  return { assets: names, metadata };
}

/** Verify both downloaded draft bytes and REST metadata while the release is still a draft. */
export function verifyDraftRelease(opts) {
  const local = verifyLocalRelease(opts);
  const spec = expected(opts);
  const names = [...spec.payloads, spec.checksum];
  const release = opts.release;
  if (!release || release.tag_name !== opts.tag || release.draft !== true || release.prerelease !== false)
    fail("draft release tag, identity or state mismatch");
  if (!Array.isArray(release.assets) || release.assets.length !== names.length ||
      names.some((name) => release.assets.filter((asset) => asset?.name === name).length !== 1))
    fail("draft API asset inventory is incomplete or unexpected");
  const downloaded = inventory(opts.remoteDir, names, spec.max);
  checksumContents(opts.remoteDir, downloaded, spec, opts.kind);
  for (const name of names) {
    const original = local.metadata.get(name);
    const received = downloaded.get(name);
    const api = release.assets.find((asset) => asset.name === name);
    if (api.browser_download_url !== `${PREFIX}${opts.tag}/${name}`)
      fail(`draft asset URL mismatch: ${name}`);
    if (api.size !== original.size || received.size !== original.size)
      fail(`draft asset size mismatch: ${name}`);
    if (!HASH.test(original.sha256) || api.digest !== `sha256:${original.sha256}`)
      fail(`draft API digest mismatch: ${name}`);
    if (received.sha256 !== original.sha256)
      fail(`remote downloaded bytes differ: ${name}`);
  }
  return { assets: names };
}

function parse(argv) {
  const command = argv.shift();
  if (!["verify-local", "verify-draft"].includes(command)) fail("expected verify-local or verify-draft");
  const options = {};
  const keys = new Map([["--kind", "kind"], ["--version", "version"], ["--mode", "mode"],
    ["--tag", "tag"], ["--local-dir", "localDir"], ["--remote-dir", "remoteDir"], ["--release-json", "releaseJson"]]);
  for (let index = 0; index < argv.length; index += 2) {
    const key = keys.get(argv[index]);
    if (!key || !argv[index + 1] || argv[index + 1].startsWith("--") || key in options)
      fail("invalid verification arguments");
    options[key] = argv[index + 1];
  }
  for (const name of ["kind", "version", "tag", "localDir"])
    if (!options[name]) fail(`missing required option ${name}`);
  if (command === "verify-draft") {
    if (!options.remoteDir || !options.releaseJson) fail("draft requires downloaded assets and release JSON");
    options.release = JSON.parse(fs.readFileSync(options.releaseJson, "utf8").replace(/^\uFEFF/, ""));
  } else if (options.remoteDir || options.releaseJson) fail("local verification cannot accept remote options");
  return { command, options };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { command, options } = parse(process.argv.slice(2));
    const result = command === "verify-draft" ? verifyDraftRelease(options) : verifyLocalRelease(options);
    console.log(JSON.stringify({ verified: true, assets: result.assets }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
