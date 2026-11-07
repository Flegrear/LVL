// Builds LVL's extension runner into ext-runner/build/dist:
//   lvl-ext-runner.jar, lib/*.jar, runtime/ (a Java runtime with only the modules
//   the runner uses, made with jlink) and NOTICE.txt.
// The JDK is the Eclipse Temurin pinned in jdk.json (jdk.mjs downloads it once), for
// Gradle and jlink alike: the runtime ships in LVL's installer, and Temurin's licence
// allows that. LVL_RUNNER_JDK=<folder> uses another JDK (local experiments only).
// Needs network for the first build.
// Usage: node ext-runner/build.mjs [--skip-fetch] [--skip-runtime]
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureJdk, JDK_PIN, releaseInfo } from "./jdk.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "build", "dist");
const pin = JSON.parse(fs.readFileSync(path.join(here, "suwayomi.json"), "utf8"));
const args = new Set(process.argv.slice(2));

// JDK modules the runner and the extensions use: images and fonts (java.desktop), the
// manifest XML, preferences, TLS with EC keys, other charsets and locales (sites'
// dates), zip file systems (bytecode fixes), and what GraalJS and Kotlin need.
export const MODULES = Object.freeze([
  "java.base", "java.desktop", "java.logging", "java.management", "java.naming", "java.net.http", "java.prefs",
  "java.sql", "java.xml", "jdk.charsets", "jdk.crypto.ec", "jdk.localedata", "jdk.unsupported", "jdk.zipfs",
]);

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { stdio: "inherit", timeout: 20 * 60_000, shell: false, ...options });
  if (result.status !== 0) throw new Error(`${path.basename(command)} ${commandArgs.slice(0, 3).join(" ")} failed (${result.status ?? result.error?.message})`);
}

async function javaHome() {
  const override = process.env.LVL_RUNNER_JDK;
  if (override) {
    if (!fs.existsSync(path.join(override, "bin", jlinkName()))) throw new Error(`LVL_RUNNER_JDK has no bin/${jlinkName()}: ${override}`);
    console.warn(`Using LVL_RUNNER_JDK (${releaseInfo(override).IMPLEMENTOR || "unknown vendor"}); don't ship this build unless its licence allows it.`);
    return override;
  }
  return ensureJdk();
}
const jlinkName = () => (process.platform === "win32" ? "jlink.exe" : "jlink");

// A Java runtime's system properties ({ "java.vendor": "Eclipse Adoptium", … }). jlink's
// "release" file only lists the version and modules, so ask the runtime itself.
function runtimeProps(runtime) {
  const java = path.join(runtime, "bin", process.platform === "win32" ? "java.exe" : "java");
  if (!fs.existsSync(java)) return {};
  const probe = spawnSync(java, ["-XshowSettings:properties", "-version"], { encoding: "utf8", timeout: 60_000 });
  return Object.fromEntries([...`${probe.stderr}${probe.stdout}`.matchAll(/^\s+([\w.]+) = (.*)$/gm)].map((match) => [match[1], match[2].trim()]));
}

function sizeOf(target) {
  if (!fs.existsSync(target)) return 0;
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) return stat.size;
  return fs.readdirSync(target).reduce((sum, name) => sum + sizeOf(path.join(target, name)), 0);
}
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function notice() {
  return [
    "LVL extension runner",
    "",
    "Runs Mihon/Tachiyomi extensions for LVL's Comics section. It contains code from",
    `Suwayomi-Server (${pin.repo.replace(/\.git$/, "")}), commit ${pin.commit}:`,
    "- AndroidCompat and the suwayomi.* helpers, under the Mozilla Public License 2.0",
    "  (https://mozilla.org/MPL/2.0/). The source of those files is available at the",
    "  commit above; LVL's changed versions are in LVL's ext-runner folder.",
    "- The Tachiyomi source API (eu.kanade.tachiyomi.*), under the Apache License 2.0.",
    "The libraries in lib/ keep their own licences. Some jars carry their licence text;",
    "the installed LVL lists every jar in its THIRD_PARTY_NOTICES.txt.",
    "runtime/ is a Java runtime made with jlink from Eclipse Temurin (OpenJDK) "
      + `${runtimeProps(path.join(dist, "runtime"))["java.runtime.version"] || JDK_PIN.release},`,
    `under ${JDK_PIN.license}; its notices are in runtime/legal/.`,
    "",
  ].join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const home = await javaHome();
  console.log(`JDK: ${home}`);
  if (!args.has("--skip-fetch")) run(process.execPath, [path.join(here, "fetch.mjs")]);
  const gradlew = path.join(here, ".vendor", "suwayomi", process.platform === "win32" ? "gradlew.bat" : "gradlew");
  run(gradlew, ["-p", here, "dist", "--console=plain", "--no-daemon"], { env: { ...process.env, JAVA_HOME: home }, shell: process.platform === "win32" });
  if (!args.has("--skip-runtime")) {
    const runtime = path.join(dist, "runtime");
    // build/dist/runtime is this script's own output.
    fs.rmSync(runtime, { recursive: true, force: true });
    run(path.join(home, "bin", jlinkName()), ["--add-modules", MODULES.join(","), "--strip-debug", "--no-header-files", "--no-man-pages",
      "--compress=zip-6", "--output", runtime]);
    const made = runtimeProps(runtime);
    console.log(`runtime/: ${made["java.vendor"] || "?"} ${made["java.runtime.version"] || "?"}`);
    if (!process.env.LVL_RUNNER_JDK && made["java.vendor"] !== JDK_PIN.implementor) throw new Error(`runtime/ was made from ${made["java.vendor"] || "an unknown JDK"}, not ${JDK_PIN.vendor}`);
  }
  fs.writeFileSync(path.join(dist, "NOTICE.txt"), notice());
  const parts = { "lvl-ext-runner.jar": path.join(dist, "lvl-ext-runner.jar"), "lib/": path.join(dist, "lib"), "runtime/": path.join(dist, "runtime") };
  for (const [name, target] of Object.entries(parts)) console.log(`${name.padEnd(20)} ${mb(sizeOf(target))}`);
  console.log(`${"total".padEnd(20)} ${mb(sizeOf(dist))}`);
}
