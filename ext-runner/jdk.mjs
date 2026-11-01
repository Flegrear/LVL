// The JDK the extension runner is built with: Eclipse Temurin, pinned in
// jdk.json with its SHA-256. Its jlink output ships in LVL's installer, and Temurin's
// licence (GPLv2 with the Classpath Exception) allows shipping that trimmed runtime;
// Oracle's JDK licence (NFTC) only allows the unmodified JDK.
// Downloaded once into ext-runner/.vendor/jdk/<release> (git-ignored).
// Usage: node ext-runner/jdk.mjs   (prints the JDK folder)
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const JDK_PIN = JSON.parse(fs.readFileSync(path.join(here, "jdk.json"), "utf8"));
const vendor = path.join(here, ".vendor", "jdk");
const exe = (name) => (process.platform === "win32" ? `${name}.exe` : name);

// The JDK's "release" file: { IMPLEMENTOR, JAVA_VERSION, … }.
export function releaseInfo(home) {
  try {
    const text = fs.readFileSync(path.join(home, "release"), "utf8");
    return Object.fromEntries([...text.matchAll(/^(\w+)="?(.*?)"?$/gm)].map((match) => [match[1], match[2]]));
  } catch { return {}; }
}

export function isPinnedJdk(home, pin = JDK_PIN) {
  const info = releaseInfo(home);
  return fs.existsSync(path.join(home, "bin", exe("jlink"))) && info.IMPLEMENTOR === pin.implementor
    && String(info.JAVA_RUNTIME_VERSION || "").startsWith(pin.release.replace(/^jdk-/, ""));
}

async function download(url, file, sha256) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20 * 60_000) });
  if (!response.ok || !response.body) throw new Error(`Temurin download failed: HTTP ${response.status}`);
  const total = Number(response.headers.get("content-length")) || 0;
  const hash = createHash("sha256");
  const out = fs.createWriteStream(`${file}.part`);
  let done = 0;
  let shown = 0;
  for await (const chunk of response.body) {
    hash.update(chunk);
    if (!out.write(chunk)) await new Promise((resolve) => out.once("drain", resolve));
    done += chunk.length;
    if (total && done / total - shown >= 0.1) { shown = done / total; console.log(`Temurin: ${Math.round(shown * 100)}% of ${(total / 1024 / 1024).toFixed(0)} MB`); }
  }
  await new Promise((resolve, reject) => out.end((error) => (error ? reject(error) : resolve())));
  const actual = hash.digest("hex");
  if (actual !== sha256) {
    fs.rmSync(`${file}.part`, { force: true });
    throw new Error(`Temurin download has SHA-256 ${actual}, expected ${sha256}`);
  }
  fs.renameSync(`${file}.part`, file);
}

// Returns the pinned JDK's folder, downloading and unpacking it when it isn't there yet.
export async function ensureJdk(pin = JDK_PIN) {
  const home = path.join(vendor, pin.release);
  if (isPinnedJdk(home, pin)) return home;
  const entry = pin.downloads[`${process.platform}-${process.arch}`];
  if (!entry) throw new Error(`No Temurin JDK is pinned for ${process.platform}-${process.arch} in ext-runner/jdk.json`);
  fs.mkdirSync(vendor, { recursive: true });
  const archive = path.join(vendor, path.basename(new URL(entry.url).pathname));
  if (!fs.existsSync(archive)) await download(entry.url, archive, entry.sha256);
  const unpack = path.join(vendor, `${pin.release}.unpack`);
  fs.rmSync(unpack, { recursive: true, force: true });
  fs.mkdirSync(unpack, { recursive: true });
  // bsdtar (Windows 10+, macOS) reads zip and tar.gz alike.
  const tar = spawnSync(process.platform === "win32" ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar", ["-xf", archive, "-C", unpack], { stdio: "inherit", timeout: 10 * 60_000 });
  if (tar.status !== 0) throw new Error(`Unpacking ${path.basename(archive)} failed (${tar.status ?? tar.error?.message})`);
  const [top] = fs.readdirSync(unpack);
  fs.rmSync(home, { recursive: true, force: true });
  fs.renameSync(path.join(unpack, top), home);
  fs.rmSync(unpack, { recursive: true, force: true });
  if (!isPinnedJdk(home, pin)) throw new Error(`${home} isn't ${pin.vendor} ${pin.release}`);
  fs.rmSync(archive, { force: true });
  return home;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(await ensureJdk());
}
