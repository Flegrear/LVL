import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const csc = path.join(process.env.WINDIR || "C:\\Windows", "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe");

test("the public updater compiles with the actual launcher and verifies version, URLs and checksums", {
  skip: process.platform !== "win32" || !fs.existsSync(csc),
  timeout: 20_000,
}, () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "lvl-updater-compile-"));
  const assembly = path.join(folder, "LVL-Library.dll");
  const runner = path.join(folder, "UpdaterProbe.exe");
  const probe = path.join(folder, "UpdaterProbe.cs");
  const source = String.raw`
using System;
using System.IO;
using System.Reflection;
using System.Net.Sockets;
using System.Text;
using System.Windows.Forms;

class UpdaterProbe {
  static object Invoke(Type type, string method, params object[] parameters) {
    return type.GetMethod(method, BindingFlags.NonPublic | BindingFlags.Static)
      .Invoke(null, parameters);
  }
  static void Require(bool value, string message) {
    if (!value) throw new Exception(message);
  }
  static string Send(string address, string request) {
    string[] parts = address.Split(':');
    using (TcpClient client = new TcpClient("127.0.0.1", int.Parse(parts[0]))) {
      client.ReceiveTimeout = 3000;
      byte[] payload = Encoding.UTF8.GetBytes(request.Replace("SECRET", parts[1]) + "\n");
      client.GetStream().Write(payload, 0, payload.Length);
      using (StreamReader reader = new StreamReader(client.GetStream(), Encoding.UTF8))
        return reader.ReadLine();
    }
  }
  static int Main(string[] args) {
    Assembly compiled = Assembly.LoadFrom(args[0]);
    Type type = compiled.GetType("LanguageVideoLearner.PackagedUpdater", true);
    Require((int)Invoke(type, "CompareVersions", "v0.1.10", "0.1.9") > 0, "numeric patch version");
    Require((int)Invoke(type, "CompareVersions", "0.2.0", "0.1.99") > 0, "numeric minor version");
    Require((int)Invoke(type, "CompareVersions", "old-version", "0.1.0") < 0, "reject malformed feed version");
    Require((bool)Invoke(type, "ValidAssetUrl", "https://github.com/Flegrear/LVL/releases/download/v0.1.1/LVL-Setup.exe"), "official release asset URL");
    Require((bool)Invoke(type, "ValidAssetUrl", "https://github.com/Flegrear/LVL/releases/download/v0.1.2/LVL-update-v0.1.2.zip"), "official patch URL");
    Require(!(bool)Invoke(type, "ValidAssetUrl", "https://github.com/Flegrear/old-repo/releases/download/v0.1.1/LVL-Setup.exe"), "other repositories forbidden");
    Require(!(bool)Invoke(type, "ValidAssetUrl", "http://github.com/Flegrear/LVL/releases/download/v0.1.1/LVL-Setup.exe"), "plaintext forbidden");
    Require(!(bool)Invoke(type, "ValidAssetUrl", "https://github.com/Flegrear/LVL/releases/download.evil/v0.1.1/LVL-Setup.exe"), "URL path prefix forbidden");
    string hash = new string('a', 64);
    string line = hash + " *LVL-Setup-0.1.1.exe";
    Require((string)Invoke(type, "ParseSha256", line, "LVL-Setup-0.1.1.exe") == hash, "named checksum matched");
    Require(Invoke(type, "ParseSha256", line, "other.exe") == null, "checksum must match exact setup filename");
    Require((string)Invoke(type, "ParseSha256", hash, "LVL-Setup-0.1.1.exe") == hash, "dedicated checksum accepted");
    Require((string)Invoke(type, "ParseSha256", hash + " *LVL-update-v0.1.2.zip", "LVL-update-v0.1.2.zip") == hash, "patch named checksum accepted");
    string fakeRoot = Path.Combine(Path.GetDirectoryName(args[0]), "isolated-updater-data");
    Directory.CreateDirectory(fakeRoot);
    Require(!(bool)type.GetMethod("IsInstalled").Invoke(null, new object[] {fakeRoot}), "source checkout has no installed marker");
    File.WriteAllText(Path.Combine(fakeRoot, "installed-app.json"), "{}");
    File.WriteAllText(Path.Combine(fakeRoot, "package.json"), "{\"version\":\"0.1.0\"}");
    Require((bool)type.GetMethod("IsInstalled").Invoke(null, new object[] {fakeRoot}), "fresh marker enables updates");
    Type logType = compiled.GetType("LanguageVideoLearner.Log", true);
    object log = Activator.CreateInstance(logType, new object[] {Path.Combine(fakeRoot, "logs")});
    using (Control invoker = new Control()) {
      object updater = Activator.CreateInstance(type, new object[] {fakeRoot, log, invoker, new Action<string>(delegate(string ignored) {})});
      string address = (string)type.GetMethod("BeginBridge").Invoke(updater, null);
      try {
        string status = Send(address, "{\"secret\":\"SECRET\",\"action\":\"status\"}");
        Require(status.Contains("\"installed\":true") && status.Contains("\"installedVersion\":\"0.1.0\""), "authenticated local status");
        Require(Send(address, "{\"secret\":\"wrong\",\"action\":\"status\"}") == null, "wrong secret cannot read status");
        string settings = Send(address, "{\"secret\":\"SECRET\",\"action\":\"settings\",\"automatic\":false,\"intervalDays\":7}");
        Require(settings.Contains("\"intervalDays\":1") && File.Exists(Path.Combine(fakeRoot, "lvl-update-settings.json")), "fixed daily settings persist within isolated LVL data root");
        Require(Send(address, "{\"secret\":\"SECRET\",\"action\":\"install\"}").Contains("No verified LVL update"), "cannot install without a verified release");
      } finally {
        type.GetMethod("EndBridge").Invoke(updater, null);
      }
    }
    Console.WriteLine("Updater isolated checks passed");
    return 0;
  }
}`;
  const compile = (args) => {
    const result = spawnSync(csc, args, { cwd: root, encoding: "utf8", timeout: 15_000, windowsHide: true });
    assert.equal(result.status, 0, `C# compilation failed: ${result.stderr || result.stdout || result.error?.message}`);
  };
  try {
    fs.writeFileSync(probe, source);
    compile([
      "/nologo", "/target:library", `/out:${assembly}`,
      "/r:System.dll", "/r:System.Drawing.dll", "/r:System.Windows.Forms.dll", "/r:System.Web.Extensions.dll",
      path.join(root, "launcher", "Launcher.cs"), path.join(root, "launcher", "LvlUpdater.cs"),
    ]);
    compile(["/nologo", "/target:exe", `/out:${runner}`, "/r:System.Windows.Forms.dll", probe]);
    const result = spawnSync(runner, [assembly], { encoding: "utf8", timeout: 5000, windowsHide: true });
    assert.equal(result.status, 0, `Updater security checks failed: ${result.stderr || result.stdout || result.error?.message}`);
    assert.match(result.stdout, /Updater isolated checks passed/);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
