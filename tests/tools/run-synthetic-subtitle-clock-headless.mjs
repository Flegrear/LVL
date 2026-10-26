// One bounded headless run, synthetic-only origin and disposable browser profile.
// Does not connect to an existing browser, port 4273, or an LVL Library.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const profile = mkdtempSync(path.join(tmpdir(), "lvl-subtitle-isolated-browser-"));
const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const brave = "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe";
const browserExe = existsSync(edge) ? edge : brave;
const pw = process.env.LVL_PLAYWRIGHT_MODULE ||
  path.join(homedir(), ".codex", "tools", "playwright-edge", "node_modules", "playwright", "index.mjs");
let child, context, finished = false;

function stopIsolatedProcesses() {
  // Only processes containing this EXACT random temp profile path are eligible.
  const cmd = [
    "$needle=$env:LVL_HEADLESS_PROFILE;",
    "Get-CimInstance Win32_Process -Filter \"name='msedge.exe' or name='brave.exe'\" |",
    "Where-Object { $_.CommandLine -and $_.CommandLine.Contains($needle) } |",
    "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
  ].join(" ");
  spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd], {
    windowsHide: true, timeout: 5500,
    env: { ...process.env, LVL_HEADLESS_PROFILE: profile },
  });
  if (child?.pid && child.exitCode === null) {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"],
      { windowsHide: true, timeout: 5000 });
  }
}
async function cleanup() {
  if (finished) return;
  finished = true;
  try {
    if (context) await Promise.race([
      context.close(), new Promise((_, reject) =>
        setTimeout(() => reject(new Error("close deadline")), 4200)),
    ]);
  } catch (error) { console.error("Context cleanup:", error.message); }
  stopIsolatedProcesses();
  assert.ok(profile.startsWith(path.join(tmpdir(), "lvl-subtitle-isolated-browser-")));
  rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
  console.log("CLEANUP: isolated browser/server stopped, disposable profile removed");
}
function spawnSyntheticServer() {
  const serverFile = path.join(root, "tests", "tools", "synthetic-subtitle-clock-acceptance.mjs");
  child = spawn(process.execPath, [serverFile, "--serve"], {
    cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("Synthetic server timeout")), 16000);
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
      const found = output.match(/Synthetic-only harness:\s*(http:\/\/127\.0\.0\.1:\d+\/)/);
      if (found) {
        clearTimeout(timer);
        resolve(found[1]);
      }
    });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error("Synthetic server exited " + code)));
  });
}
function observe(page) {
  return page.evaluate(() => {
    const state = (id) => {
      const el = document.getElementById(id);
      const ranges = (r) => Array.from({ length: r.length }, (_, i) =>
        [Number(r.start(i).toFixed(3)), Number(r.end(i).toFixed(3))]);
      return {
        currentTime: Number(el.currentTime.toFixed(3)), duration: el.duration,
        readyState: el.readyState, paused: el.paused, seeking: el.seeking,
        seekable: ranges(el.seekable), buffered: ranges(el.buffered),
        error: el.error?.code ?? null,
      };
    };
    return {
      source: state("original"), copied: state("copied"),
      frames: {
        original: window.__capture.frames.original.slice(0, 14),
        copied: window.__capture.frames.copied.slice(0, 18),
      },
      events: window.__capture.events.slice(-65),
    };
  });
}
const watchdog = setTimeout(() => {
  console.error("BOUNDED TIMEOUT: killing synthetic-only children");
  stopIsolatedProcesses();
  process.exit(124);
}, 58000);
try {
  assert.ok(existsSync(browserExe), "No Edge/Brave binary installed");
  assert.ok(existsSync(pw), "No previously installed Playwright dependency");
  const { chromium } = await import(pathToFileURL(pw).href);
  const url = await spawnSyntheticServer();
  console.log("SYNTHETIC_ORIGIN:", url, "DISPOSABLE_PROFILE:", profile);
  context = await chromium.launchPersistentContext(profile, {
    executablePath: browserExe, headless: true,
    viewport: { width: 1100, height: 840 },
    args: ["--no-first-run", "--no-default-browser-check",
      "--disable-extensions", "--disable-background-networking",
      "--disable-component-update", "--mute-audio",
      "--autoplay-policy=no-user-gesture-required"],
  });
  const page = await context.newPage();
  const network = [];
  await page.route("**/*", (route) => {
    const requested = route.request().url();
    if (!requested.startsWith(url)) return route.abort();
    network.push(new URL(requested).pathname);
    return route.continue();
  });
  await page.addInitScript(() => {
    window.__capture = { events: [], frames: { original: [], copied: [] } };
    document.addEventListener("DOMContentLoaded", () => {
      for (const id of ["original", "copied"]) {
        const el = document.getElementById(id);
        const capture = window.__capture;
        for (const type of ["loadstart", "loadedmetadata", "loadeddata",
          "seeking", "seeked", "play", "playing", "pause", "waiting",
          "timeupdate", "error"]) {
          el.addEventListener(type, () => capture.events.push({
            id, type, t: Number(el.currentTime.toFixed(3)),
            paused: el.paused, readyState: el.readyState,
          }));
        }
        if (typeof el.requestVideoFrameCallback === "function") {
          const frame = (_, metadata) => {
            capture.frames[id].push({
              mediaTime: Number(metadata.mediaTime.toFixed(3)),
              presentedFrames: metadata.presentedFrames,
            });
            el.requestVideoFrameCallback(frame);
          };
          el.requestVideoFrameCallback(frame);
        }
      }
    }, { once: true });
  });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 12000 });
  await page.waitForFunction(() => ["original", "copied"].every((id) =>
    document.getElementById(id)?.readyState >= 1),
  null, { timeout: 12000 });
  await page.evaluate(() => {
    document.getElementById("original").pause();
    document.getElementById("copied").pause();
    document.getElementById("original").currentTime = 5.37;
  });
  await page.waitForFunction(() => {
    const v = document.getElementById("original");
    return !v.seeking && Math.abs(v.currentTime - 5.37) < .08;
  }, null, { timeout: 6000 });
  await page.waitForTimeout(350);
  const pausedNativeSeek = await observe(page);
  await page.evaluate(() => document.getElementById("copied").play());
  await page.waitForFunction(() =>
    window.__capture.frames.copied.length > 0 &&
    document.getElementById("copied").currentTime > .25,
  null, { timeout: 9000 });
  await page.evaluate(() => document.getElementById("copied").pause());
  await page.waitForTimeout(300);
  const copiedPrerollAndPause = await observe(page);
  const nativeFragmentSeekResult = await page.evaluate(async () => {
    const v = document.getElementById("copied");
    const target = Math.min(1.2, Math.max(.4, v.duration / 2));
    const result = new Promise((resolve) => {
      v.addEventListener("seeked", () => resolve("seeked"), { once: true });
      setTimeout(() => resolve("seek timeout 1600ms"), 1600);
    });
    v.currentTime = target;
    return result;
  });
  const copiedAfterNativeSeek = await observe(page);
  await page.evaluate(() => document.getElementById("copied").play());
  await page.waitForTimeout(500);
  await page.evaluate(() => document.getElementById("copied").pause());
  const copiedAfterResume = await observe(page);
  console.log("OBSERVED_JSON:", JSON.stringify({
    pausedNativeSeek, copiedPrerollAndPause, nativeFragmentSeekResult,
    copiedAfterNativeSeek, copiedAfterResume,
    networkPaths: [...new Set(network)],
  }));
  assert.ok(pausedNativeSeek.source.paused, "Native paused seek should stay paused");
  assert.ok(Math.abs(pausedNativeSeek.source.currentTime - 5.37) < .08);
  assert.ok(copiedPrerollAndPause.frames.copied.length, "Frame metadata actually observed");
  assert.ok(copiedPrerollAndPause.copied.currentTime > 0, "Fragment playback advanced");
  assert.ok(copiedPrerollAndPause.copied.paused, "Copied stream paused");
  assert.ok(copiedAfterResume.copied.paused, "Copied stream paused after resume");
  console.log("PASS: one isolated synthetic headless browser acceptance completed");
} catch (error) {
  console.error("ACCEPTANCE_ERROR:", error.stack || error);
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  try { await cleanup(); }
  catch (error) {
    console.error("CLEANUP_ERROR:", error.stack || error);
    process.exitCode = 1;
  }
}
