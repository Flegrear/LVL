// Gets the Suwayomi-Server sources the runner reuses, at the commit in suwayomi.json,
// and copies only the parts it needs into .vendor/src:
// - AndroidCompat (Android APIs on the JVM) and its Config module, without the
//   Chromium WebView layer (KCEF) and without the 38 MB of bundled fonts
//   (Typeface falls back to Java's fonts when they are missing);
// - the Tachiyomi source API (eu.kanade.tachiyomi), without the local source, the
//   Cloudflare interceptor and the files LVL replaces (NetworkHelper, AppInfo, AppModule);
// - four small Suwayomi helpers (bytecode fixes, child-first class loader, Rx bridge).
// Nothing from Suwayomi is committed to LVL. Usage: node ext-runner/fetch.mjs
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pin = JSON.parse(fs.readFileSync(path.join(here, "suwayomi.json"), "utf8"));
const vendor = path.join(here, ".vendor");
const checkout = path.join(vendor, "suwayomi");
const out = path.join(vendor, "src", "main");

const SPARSE = [
  "/AndroidCompat/",
  "/server/src/main/kotlin/eu/kanade/tachiyomi/",
  "/server/src/main/kotlin/suwayomi/tachidesk/manga/impl/util/BytecodeEditor.kt",
  "/server/src/main/kotlin/suwayomi/tachidesk/manga/impl/util/ChildFirstURLClassLoader.kt",
  "/server/src/main/kotlin/suwayomi/tachidesk/manga/impl/util/lang/RxCoroutineBridge.kt",
  "/server/src/main/kotlin/suwayomi/tachidesk/manga/impl/util/lang/JsonObject.kt",
  "/gradle/",
  "/gradlew",
  "/gradlew.bat",
  "/LICENSE",
];

// [from (in the checkout), to (under .vendor/src/main), files to leave out (relative to from)]
const COPIES = [
  ["AndroidCompat/src/main/java", "java", [
    /^xyz\/nulldev\/androidcompat\/AndroidCompatInitializer\.kt$/,
    /^xyz\/nulldev\/androidcompat\/webkit\/(CefHelper|KcefHelper|KcefWebSettings|KcefWebViewProvider)\.kt$/,
    /^org\/chromium\//,
  ]],
  ["AndroidCompat/Config/src/main/java", "java", []],
  ["server/src/main/kotlin/eu/kanade/tachiyomi", "java/eu/kanade/tachiyomi", [
    /^source\/local\//,
    /^util\/storage\//,
    /^network\/interceptor\/CloudflareInterceptor\.kt$/,
    /^network\/NetworkHelper\.kt$/,
    /^(AppInfo|AppModule)\.kt$/,
    /^LICENSE$/,
  ]],
  ["server/src/main/kotlin/suwayomi", "java/suwayomi", []],
  ["AndroidCompat/src/main/resources", "resources", [/^font\//]],
];

function git(args, options = {}) {
  const result = spawnSync("git", args, { cwd: checkout, encoding: "utf8", timeout: 300_000, ...options });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim().slice(0, 400)}`);
  return result.stdout.trim();
}

function fetchCheckout() {
  fs.mkdirSync(checkout, { recursive: true });
  if (!fs.existsSync(path.join(checkout, ".git"))) {
    git(["init", "-q"]);
    git(["remote", "add", "origin", pin.repo]);
  }
  let head = "";
  try { head = git(["rev-parse", "HEAD"]); } catch { head = ""; }
  if (head === pin.commit) return false;
  git(["sparse-checkout", "set", "--no-cone", ...SPARSE]);
  git(["fetch", "-q", "--depth", "1", "--filter=blob:none", "origin", pin.commit]);
  git(["checkout", "-q", "--detach", "FETCH_HEAD"]);
  return true;
}

function walk(root, relative = "", files = []) {
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(root, child, files);
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

function copySelection() {
  // .vendor/src is made by this script only; it's rebuilt each time.
  fs.rmSync(path.join(vendor, "src"), { recursive: true, force: true });
  let count = 0;
  for (const [from, to, skip] of COPIES) {
    const source = path.join(checkout, from);
    for (const file of walk(source)) {
      if (skip.some((pattern) => pattern.test(file))) continue;
      const target = path.join(out, to, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(source, file), target);
      count += 1;
    }
  }
  return count;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fetched = fetchCheckout();
  const count = copySelection();
  console.log(`Suwayomi ${pin.commit.slice(0, 10)}${fetched ? " fetched" : " already present"}; ${count} files in .vendor/src`);
}
