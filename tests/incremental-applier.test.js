import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import AdmZip from "adm-zip";
import { applyIncrementalPatch, isPatchSourcePath, recoverInterruptedPatch } from "../runtime/update-apply.mjs";
import { isSetupSourceFile } from "../scripts/release-inputs.mjs";

const hash = (data) => createHash("sha256").update(data).digest("hex");
function fixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lvl-public-patch-fixture-"));
  const appRoot = path.join(tmp, "installed-public-lvl");
  fs.mkdirSync(appRoot);
  const originalPackage = { name: "lvl", version: "0.1.0", type: "module" };
  const marker = {
    schemaVersion: 1, appId: "lvl-public", installType: "per-user", version: "0.1.0",
    port: 4273, dataRoot: "%LOCALAPPDATA%\\LVL\\data",
    browserProfile: "%LOCALAPPDATA%\\LVL\\browser-profile",
  };
  const oldFiles = {
    "app.js": "console.log('old app');\n",
    "server.js": "console.log('old server');\n",
    "index.html": "<title>Old LVL</title>\n",
    "package.json": JSON.stringify(originalPackage) + "\n",
    "CHANGELOG.md": "initial\n",
    "frontend/old.css": ".old{color:red}\n",
    "backend/keep.js": "export const keep = true;\n",
    "runtime/node.exe": "BUNDLED NODE BINARY DO NOT CHANGE",
    "node_modules/adm-zip/index.js": "PREINSTALLED RUNTIME DEPENDENCY",
    "LVL.exe": "FAKE PUBLIC EXE NEVER EXECUTED",
    "data/progress.sqlite3": "PRIVATE LIBRARY DATA PRESERVED",
    "installed-app.json": JSON.stringify(marker) + "\n",
  };
  for (const [relative, content] of Object.entries(oldFiles)) {
    const filename = path.join(appRoot, ...relative.split("/"));
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, content);
  }
  function makeZip({
    files = {
      "package.json": JSON.stringify({ ...originalPackage, version: "0.1.1" }) + "\n",
      "app.js": "console.log('patched');\n",
      "frontend/new.css": ".new{color:green}\n",
    },
    deletes = ["frontend/old.css"], manifestEdits = {},
    extras = [], fromVersion = "0.1.0", toVersion = "0.1.1",
  } = {}) {
    const payload = new AdmZip();
    const declaration = Object.entries(files).map(([member, contents]) =>
      ({ path: member, sha256: hash(Buffer.from(contents)) }));
    const manifest = {
      format: "lvl-patch-v1", fromVersion, toVersion,
      files: declaration, deletes, ...manifestEdits,
    };
    payload.addFile("manifest.json", Buffer.from(JSON.stringify(manifest)));
    for (const [relative, content] of Object.entries(files))
      payload.addFile(relative, Buffer.from(content));
    for (const [relative, content] of extras) payload.addFile(relative, Buffer.from(content));
    const zipPath = path.join(tmp, "release-" + Math.random().toString(16).slice(2) + ".zip");
    payload.writeZip(zipPath);
    return { zipPath, manifest, checksum: hash(fs.readFileSync(zipPath)) };
  }
  function read(name) { return fs.readFileSync(path.join(appRoot, ...name.split("/")), "utf8"); }
  function remove() {
    // Fixture is always a unique OS temp location, never actual LVL install.
    assert.ok(path.basename(tmp).startsWith("lvl-public-patch-fixture-"));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return { appRoot, tmp, makeZip, read, remove, oldFiles };
}

function fakeLifecycle(fixture, calls) {
  return {
    requestQuit: async (root) => {
      assert.equal(root, fixture.appRoot);
      assert.match(fixture.read("app.js"), /old app/, "ZIP preflight and quit occur before application writes");
      calls.push("quit");
    },
    waitForParent: async (pid) => {
      assert.equal(pid, 12255);
      calls.push("wait");
    },
    relaunch: async (root) => {
      assert.equal(root, fixture.appRoot);
      calls.push("relaunch");
    },
  };
}
async function inFixture(callback) {
  const f = fixture();
  try { return await callback(f); } finally { f.remove(); }
}
const options = (f, zip, calls, extra = {}) => ({
  appRoot: f.appRoot, zipPath: zip.zipPath,
  fromVersion: "0.1.0", toVersion: "0.1.1",
  parentPid: 12255, zipSha256: zip.checksum,
  ...fakeLifecycle(f, calls), ...extra,
});

test("applies only hashed allowlisted sources, deletes selected static files, commits marker last, relaunches", async () => {
  await inFixture(async (f) => {
    const zip = f.makeZip();
    const calls = [];
    const installed = await applyIncrementalPatch(options(f, zip, calls, {
      afterFile: (name) => {
        if (name === "installed-app.json") {
          assert.match(f.read("app.js"), /patched/, "files installed before marker");
        } else {
          assert.match(f.read("installed-app.json"), /0\.1\.0/, "marker never advances before content");
        }
      },
    }));
    assert.deepEqual(calls, ["quit", "wait", "relaunch"]);
    assert.deepEqual(installed, { installed: "0.1.1", replaced: 3, deleted: 1 });
    assert.match(f.read("app.js"), /patched/);
    assert.match(f.read("frontend/new.css"), /color:green/);
    assert.equal(fs.existsSync(path.join(f.appRoot, "frontend", "old.css")), false);
    assert.equal(JSON.parse(f.read("package.json")).version, "0.1.1");
    assert.equal(JSON.parse(f.read("installed-app.json")).version, "0.1.1");
    for (const untouched of ["LVL.exe", "runtime/node.exe", "node_modules/adm-zip/index.js",
      "backend/keep.js", "data/progress.sqlite3"]) assert.equal(f.read(untouched), f.oldFiles[untouched]);
    assert.equal(fs.existsSync(path.join(f.appRoot, ".lvl-patch-transaction")), false);
  });
});

test("exact static allowlist matches setup inputs but rejects hostile Windows paths", () => {
  for (const name of ["app.js", "index.html", "server.js", "package.json", "CHANGELOG.md",
    "assets/images/logo.png", "backend/catalog/detail.js", "frontend/styles/styles.css",
    "learning/data/words.tsv", "shared/media/time.js"])
    assert.equal(isPatchSourcePath(name), isSetupSourceFile(name));
  for (const name of [
    "runtime/update-apply.mjs", "runtime/node.exe", "LVL.exe", "installed-app.json",
    "node_modules/adm-zip/index.js", "tests/a.js", "installer/stage.mjs", "scripts/release-inputs.mjs",
    "data/private.db", ".git/config", "docs/README.md", "README.md", "learning/build-presets.mjs",
    "frontend/.env", "frontend/.hidden.js", "backend/logs/today.log",
    "assets/../data/private.txt", "../LVL.exe", "/assets/icon.svg", "C:\\app.js",
    "backend\\media\\time.js", "assets//icon.svg", "frontend/COM1", "backend/aux.txt",
    "assets/evil.", "assets/evil ", "backend/file:stream", "frontend/test?.js",
    "assets/launcher.exe", "frontend/native.dll", "backend/scripts/repair.ps1",
    "frontend/__tests__/private.test.js", "assets/examples/demo.js",
  ]) assert.equal(isPatchSourcePath(name), false, "unsafe patch path: " + name);
});

test("rejects tampered content, ZIP checksum mismatch, mismatched versions and unlisted ZIP members before quit", async () => {
  await inFixture(async (f) => {
    const badCases = [
      () => {
        const zip = f.makeZip({ manifestEdits: { toVersion: "0.8.9" } });
        return zip;
      },
      () => f.makeZip({ files: {
        "package.json": JSON.stringify({ name: "lvl", version: "0.1.1", type: "module" }),
        "app.js": "safe",
      }, manifestEdits: { files: [
        { path: "app.js", sha256: "0".repeat(64) },
        { path: "package.json", sha256: hash(JSON.stringify({ name: "lvl", version: "0.1.1", type: "module" })) },
      ] } }),
      () => f.makeZip({ extras: [["assets/unknown.js", "unexpected"]] }),
      () => f.makeZip({ files: { "app.js": "missing package" } }),
      () => f.makeZip({ files: { "package.json": JSON.stringify({ name: "lvl", version: "0.2.9", type: "module" }) } }),
      () => f.makeZip({ manifestEdits: { format: "untrusted-v0" } }),
      () => f.makeZip({ manifestEdits: { deletes: ["runtime/node.exe"] } }),
      () => f.makeZip({ manifestEdits: { deletes: ["app.js"] } }),
      () => f.makeZip({ manifestEdits: { files: [
        { path: "../LVL.exe", sha256: "a".repeat(64) },
        { path: "package.json", sha256: "b".repeat(64) },
      ] } }),
      () => f.makeZip({ manifestEdits: { files: [
        { path: "package.json", sha256: "a".repeat(64) },
        { path: "BACKEND/main.js", sha256: "a".repeat(64) },
        { path: "backend/main.js", sha256: "a".repeat(64) },
      ] } }),
    ];
    for (let i = 0; i < badCases.length; i += 1) {
      const zip = badCases[i]();
      const calls = [];
      await assert.rejects(applyIncrementalPatch(options(f, zip, calls)),
        /LVL patch:/, "failed hostile case " + i);
      assert.deepEqual(calls, [], "invalid archive cannot request public launcher shutdown");
      assert.match(f.read("app.js"), /old app/);
      assert.equal(JSON.parse(f.read("installed-app.json")).version, "0.1.0");
    }
    const zip = f.makeZip();
    const calls = [];
    await assert.rejects(applyIncrementalPatch(options(f, zip, calls, { zipSha256: "f".repeat(64) })),
      /trusted downloaded ZIP SHA-256 mismatch/);
    assert.deepEqual(calls, []);
  });
});

test("Windows case-colliding ZIP entries, forbidden extra paths, and duplicate manifest names fail before quitting", async () => {
  await inFixture(async (f) => {
    const cases = [
      f.makeZip({ files: {
        "package.json": JSON.stringify({ name: "lvl", type: "module", version: "0.1.1" }),
        "frontend/A.js": "first",
      }, extras: [["frontend/a.js", "different case"]] }),
      f.makeZip({ files: {
        "package.json": JSON.stringify({ name: "lvl", type: "module", version: "0.1.1" }),
        "frontend/app.js": "legal",
      }, extras: [["node_modules/adm-zip/index.js", "tamper dependency"]] }),
      f.makeZip({ files: {
        "package.json": JSON.stringify({ name: "lvl", type: "module", version: "0.1.1" }),
        "assets/duplicates.js": "source",
      }, manifestEdits: { files: [
        { path: "package.json", sha256: "a".repeat(64) },
        { path: "assets/duplicates.js", sha256: "a".repeat(64) },
        { path: "assets/DUPLICATES.js", sha256: "a".repeat(64) },
      ] } }),
    ];
    for (const zip of cases) {
      const calls = [];
      await assert.rejects(applyIncrementalPatch(options(f, zip, calls)), /LVL patch:/);
      assert.deepEqual(calls, []);
    }
    assert.equal(f.read("app.js"), f.oldFiles["app.js"]);
    assert.equal(f.read("node_modules/adm-zip/index.js"), f.oldFiles["node_modules/adm-zip/index.js"]);
    assert.equal(f.read("installed-app.json"), f.oldFiles["installed-app.json"]);
  });
});

test("transaction automatically rolls back every changed, created and deleted file after mid-apply failure", async () => {
  await inFixture(async (f) => {
    const zip = f.makeZip();
    const calls = [];
    await assert.rejects(applyIncrementalPatch(options(f, zip, calls, {
      afterFile: (name, index) => { if (index === 4) throw new Error("simulated I/O interruption"); },
    })), /simulated I\/O interruption/);
    assert.deepEqual(calls, ["quit", "wait", "relaunch"], "old app relaunches only after successful rollback");
    assert.equal(f.read("app.js"), f.oldFiles["app.js"]);
    assert.equal(f.read("frontend/old.css"), f.oldFiles["frontend/old.css"]);
    assert.equal(fs.existsSync(path.join(f.appRoot, "frontend/new.css")), false);
    assert.equal(f.read("package.json"), f.oldFiles["package.json"]);
    assert.equal(f.read("installed-app.json"), f.oldFiles["installed-app.json"]);
    assert.equal(fs.existsSync(path.join(f.appRoot, ".lvl-patch-transaction")), false);
  });
});

test("recovers interrupted applying journal idempotently without touching user data, refuses corrupt backups", async () => {
  await inFixture(async (f) => {
    const tx = path.join(f.appRoot, ".lvl-patch-transaction");
    fs.mkdirSync(path.join(tx, "backup"), { recursive: true });
    const source = Buffer.from(f.oldFiles["app.js"]);
    fs.writeFileSync(path.join(tx, "backup", "app.js"), source);
    const journal = { format: "lvl-patch-v1", state: "applying",
      fromVersion: "0.1.0", toVersion: "0.1.1",
      records: [{ path: "app.js", existed: true, sha256: hash(source) }] };
    fs.writeFileSync(path.join(tx, "journal.json"), JSON.stringify(journal));
    fs.writeFileSync(path.join(f.appRoot, "app.js"), "partially installed new content");
    assert.equal(recoverInterruptedPatch(f.appRoot), true);
    assert.equal(f.read("app.js"), f.oldFiles["app.js"]);
    assert.equal(recoverInterruptedPatch(f.appRoot), false, "repeated recovery is harmless");
    assert.equal(f.read("data/progress.sqlite3"), f.oldFiles["data/progress.sqlite3"]);
    fs.mkdirSync(path.join(tx, "backup"), { recursive: true });
    fs.writeFileSync(path.join(tx, "backup", "app.js"), "CORRUPT");
    fs.writeFileSync(path.join(tx, "journal.json"), JSON.stringify(journal));
    fs.writeFileSync(path.join(f.appRoot, "app.js"), "new damaged content");
    assert.throws(() => recoverInterruptedPatch(f.appRoot), /missing\/corrupt rollback backup/);
    assert.equal(f.read("app.js"), "new damaged content",
      "fail closed rather than overwriting with corrupted backup");
    assert.equal(fs.existsSync(tx), true, "retain journal for operator repair");
  });
});

test("previously committed transaction cleanup cannot block a later incremental release", async () => {
  await inFixture(async (f) => {
    const zip1 = f.makeZip({ deletes: [], files: {
      "package.json": JSON.stringify({ name: "lvl", version: "0.1.1", type: "module" }) + "\n",
      "app.js": "console.log('release 0.1.1');\n",
    } });
    const calls1 = [];
    await applyIncrementalPatch(options(f, zip1, calls1));
    assert.equal(JSON.parse(f.read("installed-app.json")).version, "0.1.1");
    // Crash after the atomic 'committed' journal state but before cleanup.
    const transaction = path.join(f.appRoot, ".lvl-patch-transaction");
    fs.mkdirSync(transaction);
    fs.writeFileSync(path.join(transaction, "journal.json"), JSON.stringify({
      format: "lvl-patch-v1", fromVersion: "0.1.0", toVersion: "0.1.1",
      state: "committed", records: [],
    }));
    const zip2 = f.makeZip({
      fromVersion: "0.1.1", toVersion: "0.1.2", deletes: [],
      files: {
        "package.json": JSON.stringify({ name: "lvl", version: "0.1.2", type: "module" }) + "\n",
        "app.js": "console.log('release 0.1.2');\n",
      },
    });
    const calls2 = [];
    const result = await applyIncrementalPatch(options(f, zip2, calls2, {
      fromVersion: "0.1.1", toVersion: "0.1.2",
      requestQuit: async () => { calls2.push("quit"); },
      waitForParent: async () => { calls2.push("wait"); },
      relaunch: async () => { calls2.push("relaunch"); },
    }));
    assert.deepEqual(calls2, ["quit", "wait", "relaunch"]);
    assert.equal(result.installed, "0.1.2");
    assert.match(f.read("app.js"), /release 0\.1\.2/);
    assert.equal(JSON.parse(f.read("installed-app.json")).version, "0.1.2");
    assert.equal(fs.existsSync(transaction), false);
  });
});

test("named CLI fails before launcher shutdown when downloaded archive is invalid", async () => {
  await inFixture(async (f) => {
    const zip = f.makeZip({ extras: [["runtime/node.exe", "untrusted"]] });
    const script = new URL("../runtime/update-apply.mjs", import.meta.url);
    const process = spawnSync(globalThis.process.execPath, [
      new URL(script).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
      "--app-root", f.appRoot, "--zip", zip.zipPath, "--zip-sha256", zip.checksum,
      "--from", "0.1.0", "--to", "0.1.1", "--parent-pid", "12255", "--relaunch",
    ], { cwd: f.tmp, encoding: "utf8", windowsHide: true, timeout: 8000 });
    assert.equal(process.status, 1);
    assert.match(process.stderr, /outside release allowlist/);
    assert.match(f.read("app.js"), /old app/);
  });
});
