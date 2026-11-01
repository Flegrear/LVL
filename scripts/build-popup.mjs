// Builds LVL's pop-up player window (launcher/LvlPopup.cs) into build/popup:
//   LVL-Popup.exe, Microsoft.Web.WebView2.Core.dll, Microsoft.Web.WebView2.WinForms.dll,
//   WebView2Loader.dll (x64), WEBVIEW2-LICENSE.txt and WEBVIEW2-NOTICE.txt.
// The WebView2 SDK is the NuGet package pinned below, checked by SHA-256 (BSD-3-Clause).
// The WebView2 runtime itself comes with Windows 10 and 11 and is not bundled.
// Uses the .NET Framework C# compiler, like the launcher. Windows only.
// Usage: node scripts/build-popup.mjs [--out <folder>]
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const WEBVIEW2_SDK = Object.freeze({
  version: "1.0.4314.35",
  url: "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/1.0.4314.35/microsoft.web.webview2.1.0.4314.35.nupkg",
  sha256: "90778deb1b77e36292828b4b5833c9255c27533f40e0ddd55891ae718944edc4",
});
// [file in the package, name in the output]
const FILES = [
  ["lib/net462/Microsoft.Web.WebView2.Core.dll", "Microsoft.Web.WebView2.Core.dll"],
  ["lib/net462/Microsoft.Web.WebView2.WinForms.dll", "Microsoft.Web.WebView2.WinForms.dll"],
  ["runtimes/win-x64/native/WebView2Loader.dll", "WebView2Loader.dll"],
  ["LICENSE.txt", "WEBVIEW2-LICENSE.txt"],
  ["NOTICE.txt", "WEBVIEW2-NOTICE.txt"],
];

async function sdkPackage(cache) {
  const file = path.join(cache, `microsoft.web.webview2.${WEBVIEW2_SDK.version}.nupkg`);
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  if (fs.existsSync(file) && hash(fs.readFileSync(file)) === WEBVIEW2_SDK.sha256) return file;
  const response = await fetch(WEBVIEW2_SDK.url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`WebView2 SDK download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = hash(bytes);
  if (actual !== WEBVIEW2_SDK.sha256) throw new Error(`WebView2 SDK has SHA-256 ${actual}, expected ${WEBVIEW2_SDK.sha256}`);
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(`${file}.part`, bytes);
  fs.renameSync(`${file}.part`, file);
  return file;
}

export function compiler(env = process.env) {
  const windows = env.WINDIR || env.SystemRoot || "C:\\Windows";
  for (const folder of ["Framework64", "Framework"]) {
    const csc = path.join(windows, "Microsoft.NET", folder, "v4.0.30319", "csc.exe");
    if (fs.existsSync(csc)) return csc;
  }
  throw new Error("The Windows .NET Framework C# compiler (csc.exe) is unavailable");
}

export async function buildPopup({ out = path.join(root, "build", "popup"), cache = path.join(root, "build", "popup-cache") } = {}) {
  if (process.platform !== "win32") throw new Error("The pop-up player window is built on Windows only");
  const zip = new AdmZip(await sdkPackage(cache));
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  for (const [from, to] of FILES) {
    const entry = zip.getEntry(from);
    if (!entry) throw new Error(`The WebView2 SDK package has no ${from}`);
    fs.writeFileSync(path.join(out, to), entry.getData());
  }
  const icon = path.join(root, "assets", "platform", "favicon.ico");
  execFileSync(compiler(), [
    "/nologo", "/utf8output", "/target:winexe", "/optimize+", "/platform:x64", "/warn:4",
    `/out:${path.join(out, "LVL-Popup.exe")}`, `/win32icon:${icon}`,
    "/reference:System.dll", "/reference:System.Drawing.dll", "/reference:System.Windows.Forms.dll",
    "/reference:System.Web.Extensions.dll",
    `/reference:${path.join(out, "Microsoft.Web.WebView2.Core.dll")}`,
    `/reference:${path.join(out, "Microsoft.Web.WebView2.WinForms.dll")}`,
    path.join(root, "launcher", "LvlPopup.cs"),
  ], { stdio: "inherit", timeout: 120_000, windowsHide: true });
  return out;
}

// The release asset an installed LVL downloads (backend/media/popup-program.js): the six
// files at the top level, plus "<sha256> *<name>" in <zip>.sha256, as the setup's checksum.
export function zipPopup(out, zipPath) {
  const archive = new AdmZip();
  for (const [, name] of FILES) archive.addFile(name, fs.readFileSync(path.join(out, name)));
  archive.addFile("LVL-Popup.exe", fs.readFileSync(path.join(out, "LVL-Popup.exe")));
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  archive.writeZip(zipPath);
  const hash = createHash("sha256").update(fs.readFileSync(zipPath)).digest("hex");
  fs.writeFileSync(`${zipPath}.sha256`, `${hash} *${path.basename(zipPath)}\n`);
  return hash;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const option = (name) => { const at = process.argv.indexOf(name); return at > 0 && process.argv[at + 1] ? path.resolve(process.argv[at + 1]) : null; };
  const out = await buildPopup(option("--out") ? { out: option("--out") } : {});
  for (const name of fs.readdirSync(out)) console.log(`${name.padEnd(40)} ${fs.statSync(path.join(out, name)).size} B`);
  if (option("--zip")) console.log(`${path.basename(option("--zip"))} SHA-256 ${zipPopup(out, option("--zip"))}`);
}
