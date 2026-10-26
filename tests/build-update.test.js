import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import { buildUpdate, validatePatchPath } from "../scripts/build-update.mjs";
import { isSetupSourceFile } from "../scripts/release-inputs.mjs";

const builder = fileURLToPath(new URL("../scripts/build-update.mjs", import.meta.url));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function git(folder, ...args) {
  return execFileSync("git", ["-C", folder, ...args], {
    encoding: "utf8", timeout: 15_000, windowsHide: true, maxBuffer: 6 * 1024 * 1024,
  }).trim();
}

function write(folder, relative, data) {
  const location = path.join(folder, ...relative.split("/"));
  fs.mkdirSync(path.dirname(location), { recursive: true });
  fs.writeFileSync(location, data);
}

function packageData(version = "0.1.0", dependencies = { "demo-dep": "^1.2.3" }) {
  return { name: "lvl-fixture", version, private: true, type: "module", engines: { node: ">=22.17.0" },
    scripts: { start: "node server.js" }, dependencies };
}

function lockData(version = "0.1.0", dependencies = { "demo-dep": "^1.2.3" }) {
  return { name: "lvl-fixture", version, lockfileVersion: 3,
    packages: { "": { name: "lvl-fixture", version, dependencies },
      "node_modules/demo-dep": { version: "1.2.3", resolved: "https://example.test/demo-dep-1.2.3.tgz" } } };
}

function makeRepo(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lvl-patch-test-"));
  const repo = path.join(root, "repo");
  const dist = path.join(root, "out");
  fs.mkdirSync(repo);
  git(repo, "init", "--quiet");
  git(repo, "config", "user.email", "test@example.invalid");
  git(repo, "config", "user.name", "Isolated LVL test");
  git(repo, "config", "core.autocrlf", "false");
  write(repo, "package.json", JSON.stringify(packageData(), null, 2) + "\n");
  write(repo, "package-lock.json", JSON.stringify(lockData(), null, 2) + "\n");
  write(repo, "app.js", "export const build = 'old';\n");
  write(repo, "frontend/unchanged.js", "export const untouched = true;\n");
  write(repo, "README.md", "Initial release\n");
  write(repo, "tests/local.test.js", "only for developers\n");
  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "-m", "Base fixture");
  git(repo, "tag", "v0.1.0");
  const commit = (message = "Candidate") => {
    git(repo, "add", "-A");
    git(repo, "commit", "--quiet", "-m", message);
  };
  const bump = (to = "0.1.1") => {
    write(repo, "package.json", JSON.stringify(packageData(to), null, 2) + "\n");
    write(repo, "package-lock.json", JSON.stringify(lockData(to), null, 2) + "\n");
  };
  try { return callback({ repo, dist, root, write: (relative, data) => write(repo, relative, data), commit, bump, git: (...args) => git(repo, ...args) }); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function inspectPatch(archivePath, checksumPath) {
  const zipBytes = fs.readFileSync(archivePath);
  const zip = new AdmZip(zipBytes);
  const entries = zip.getEntries();
  assert.ok(entries.every((entry) => !entry.isDirectory), "Patch ZIP must have no extra directory entries");
  const manifestEntry = zip.getEntry("manifest.json");
  assert.ok(manifestEntry, "manifest must be located at the ZIP root");
  const manifest = JSON.parse(manifestEntry.getData().toString("utf8"));
  const paths = entries.filter((entry) => !entry.isDirectory).map((entry) => entry.entryName).sort();
  assert.deepEqual(paths, ["manifest.json", ...manifest.files.map((entry) => entry.path)].sort(),
    "zip has no extra runtime, dependencies, test or installer entries");
  for (const file of manifest.files) {
    assert.ok(isSetupSourceFile(file.path), `Only release-inputs allowlisted source enters patch: ${file.path}`);
    const contents = zip.getEntry(file.path)?.getData();
    assert.ok(contents);
    assert.equal(file.sha256, digest(contents), `SHA256 for ${file.path} covers exact archive bytes`);
  }
  assert.deepEqual(manifest.deletes, []);
  const sha = digest(zipBytes);
  assert.equal(fs.readFileSync(checksumPath, "utf8"), `${sha} *${path.basename(archivePath)}\n`);
  return { zip, manifest, sha, paths };
}

test("versioned patch ZIP contains precisely HEAD-reviewed source, manifest hashes and named checksum", () => makeRepo(({ repo, dist, write, bump, commit }) => {
  bump();
  write("app.js", "export const build = 'committed';\n");
  write("frontend/catalog/new.js", "export const newItem = 'committed';\n");
  write("CHANGELOG.md", "# 0.1.1\n");
  write("README.md", "Updated docs not in installed payload\n");
  write("tests/local.test.js", "private tests excluded\n");
  commit();
  // Uncommitted edits must not silently change released bytes.
  write("app.js", "export const privateDraft = true;\n");
  write("frontend/catalog/new.js", "export const privateDraft = true;\n");
  const result = buildUpdate({ repoRoot: repo, fromVersion: "v0.1.0", toVersion: "0.1.1", outputDir: dist });
  assert.equal(path.basename(result.archivePath), "LVL-update-v0.1.1.zip");
  assert.equal(path.basename(result.checksumPath), "LVL-update-v0.1.1.zip.sha256");
  const { zip, manifest, paths } = inspectPatch(result.archivePath, result.checksumPath);
  assert.deepEqual(paths, ["CHANGELOG.md", "app.js", "frontend/catalog/new.js", "manifest.json", "package.json"]);
  assert.deepEqual(Object.keys(manifest), ["format", "fromVersion", "toVersion", "files", "deletes"]);
  assert.equal(manifest.format, "lvl-patch-v1");
  assert.equal(manifest.fromVersion, "0.1.0");
  assert.equal(manifest.toVersion, "0.1.1");
  assert.match(zip.getEntry("app.js").getData().toString("utf8"), /committed/);
  assert.doesNotMatch(zip.getEntry("app.js").getData().toString("utf8"), /privateDraft/);
  assert.equal(JSON.parse(zip.getEntry("package.json").getData().toString("utf8")).version, "0.1.1");
  assert.equal(result.checksum, digest(fs.readFileSync(result.archivePath)));
}));

test("ZIP entry path validator blocks traversal, alternate Windows separators, device names and streams", () => {
  assert.equal(validatePatchPath("frontend/catalog/verified.js"), "frontend/catalog/verified.js");
  for (const name of ["/app.js", "../app.js", "assets/../app.js", "assets/./secret",
    "assets//secret", "assets\\..\\app.js", "C:/app.js", "frontend/CON.txt",
    "frontend/nul", "frontend/.private", "frontend/entry:secret", "frontend/file?.js",
    "frontend/file\0.txt", "frontend/path\nname", "frontend/evil.", "frontend/evil "])
    assert.throws(() => validatePatchPath(name), /Unsafe Git\/ZIP path/, name);
});

test("patch refuses overwriting existing archive or checksum without changing the original assets", () => makeRepo(({ repo, dist, bump, commit }) => {
  bump(); commit();
  const first = buildUpdate({ repoRoot: repo, fromVersion: "0.1.0", outputDir: dist });
  const zip = fs.readFileSync(first.archivePath);
  const checksum = fs.readFileSync(first.checksumPath);
  assert.throws(() => buildUpdate({ repoRoot: repo, fromVersion: "v0.1.0", outputDir: dist }), /already exists|overwrite/);
  assert.deepEqual(fs.readFileSync(first.archivePath), zip);
  assert.deepEqual(fs.readFileSync(first.checksumPath), checksum);
}));

test("version tag must exist, match committed old package, be ancestor and be older than candidate", () => {
  makeRepo(({ repo, dist, bump, commit, git: run }) => {
    bump(); commit();
    assert.throws(() => buildUpdate({ repoRoot: repo, fromVersion: "0.0.9", outputDir: dist }), /Git rev-parse failed/);
    assert.throws(() => buildUpdate({ repoRoot: repo, fromVersion: "v0.1.0", toVersion: "0.1.2", outputDir: dist }), /Target version mismatch/);
    assert.throws(() => buildUpdate({ repoRoot: repo, fromVersion: "0.1.0-evil", outputDir: dist }), /three-part version/);
    run("tag", "v0.0.9", "v0.1.0");
    assert.throws(() => buildUpdate({ repoRoot: repo, fromVersion: "0.0.9", outputDir: dist }), /Old version mismatch/);
  });
  makeRepo(({ repo, dist, commit }) => {
    write(repo, "README.md", "No version bump yet\n"); commit();
    assert.throws(() => buildUpdate({ repoRoot: repo, fromVersion: "0.1.0", outputDir: dist }), /must be newer/);
  });
});

test("an existing tag on another Git branch cannot serve as a patch ancestor", () => makeRepo((ctx) => {
  ctx.bump();
  ctx.commit("New candidate HEAD");
  const original = ctx.git("branch", "--show-current");
  ctx.git("checkout", "--quiet", "-b", "unrelated-tag", "v0.1.0");
  ctx.write("README.md", "Sibling release branch\n");
  ctx.commit("Sibling commit");
  ctx.git("tag", "v0.0.9");
  ctx.git("checkout", "--quiet", original);
  assert.throws(() => buildUpdate({ repoRoot: ctx.repo, fromVersion: "0.0.9", outputDir: ctx.dist }),
    /not an ancestor of HEAD/);
}));

test("unsupported dependency, engine and npm script changes require a new full setup", () => {
  for (const update of [
    (ctx) => ctx.write("package.json", JSON.stringify({ ...packageData("0.1.1"),
      dependencies: { "demo-dep": "^99.0.0" } })),
    (ctx) => ctx.write("package.json", JSON.stringify({ ...packageData("0.1.1"),
      engines: { node: ">=24.0.0" } })),
    (ctx) => ctx.write("package.json", JSON.stringify({ ...packageData("0.1.1"),
      scripts: { start: "node new-server.js" } })),
    (ctx) => { ctx.write("package-lock.json", JSON.stringify(lockData("0.1.1", { "demo-dep": "^99.0.0" }))); },
  ]) {
    makeRepo((ctx) => {
      ctx.bump();
      update(ctx);
      ctx.commit();
      assert.throws(() => buildUpdate({ repoRoot: ctx.repo, fromVersion: "0.1.0", outputDir: ctx.dist }),
        /Full installer required/);
      assert.ok(!fs.existsSync(ctx.dist), "Rejection must not create release assets");
    });
  }
});

test("installer, launcher, runtime and build-system modifications require full installer fallback", () => {
  for (const name of ["launcher/Launcher.cs", "installer/setup.iss", "runtime/node.exe",
    "node_modules/demo-dep/index.js", "scripts/build-glosses.mjs", "installed-app.json", ".github/workflows/release.yml"]) {
    makeRepo((ctx) => {
      ctx.bump();
      ctx.write(name, "unsupported updated payload\n");
      ctx.commit();
      assert.throws(() => buildUpdate({ repoRoot: ctx.repo, fromVersion: "0.1.0", outputDir: ctx.dist }),
        /Full installer required|Unsafe Git\/ZIP path/);
    });
  }
});

test("deletions, renames and executable binary additions never produce a source patch", () => {
  makeRepo((ctx) => {
    ctx.bump();
    fs.rmSync(path.join(ctx.repo, "app.js"));
    ctx.commit();
    assert.throws(() => buildUpdate({ repoRoot: ctx.repo, fromVersion: "0.1.0", outputDir: ctx.dist }),
      /deletion|Full installer required/);
  });
  makeRepo((ctx) => {
    ctx.bump();
    fs.renameSync(path.join(ctx.repo, "app.js"), path.join(ctx.repo, "frontend", "renamed.js"));
    ctx.commit();
    assert.throws(() => buildUpdate({ repoRoot: ctx.repo, fromVersion: "0.1.0", outputDir: ctx.dist }),
      /rename|renamed|deletion|Full installer required/i);
  });
  for (const relative of ["assets/unsafe.exe", "backend/native.node", "shared/data.zip"]) {
    makeRepo((ctx) => {
      ctx.bump(); ctx.write(relative, Buffer.from("MZbinary")); ctx.commit();
      assert.throws(() => buildUpdate({ repoRoot: ctx.repo, fromVersion: "0.1.0", outputDir: ctx.dist }),
        /Full installer required/);
    });
  }
});

test("Git tracked symlink objects and executable-mode changes cannot enter a patch", () => {
  makeRepo((ctx) => {
    ctx.bump();
    const contents = execFileSync("git", ["-C", ctx.repo, "hash-object", "-w", "--stdin"], {
      input: Buffer.from("../outside-private.txt"), encoding: "utf8", timeout: 10_000,
    }).trim();
    ctx.git("update-index", "--add", "--cacheinfo", `120000,${contents},frontend/unsafe.js`);
    ctx.git("add", "package.json", "package-lock.json");
    ctx.git("commit", "--quiet", "-m", "Symlink git blob");
    assert.throws(() => buildUpdate({ repoRoot: ctx.repo, fromVersion: "0.1.0", outputDir: ctx.dist }),
      /symlink|Unsupported file mode|Full installer required/);
  });
});

test("large Git blobs and source test fixtures under otherwise allowed roots are handled safely", () => {
  makeRepo((ctx) => {
    ctx.bump();
    ctx.write("frontend/__tests__/private.test.js", "PRIVATE TEST\n");
    ctx.write("backend/controllers/routine.spec.js", "PRIVATE TEST\n");
    ctx.write("frontend/app.js", "export const valid = true;\n");
    ctx.commit();
    const { archivePath, checksumPath } = buildUpdate({ repoRoot: ctx.repo, fromVersion: "0.1.0", outputDir: ctx.dist });
    const { paths } = inspectPatch(archivePath, checksumPath);
    assert.deepEqual(paths, ["frontend/app.js", "manifest.json", "package.json"]);
  });
  makeRepo((ctx) => {
    ctx.bump();
    ctx.write("assets/too-large.bin", Buffer.alloc(16 * 1024 * 1024 + 1, 4));
    ctx.commit();
    assert.throws(() => buildUpdate({ repoRoot: ctx.repo, fromVersion: "0.1.0", outputDir: ctx.dist }),
      /exceeds.*bytes|Oversized/);
  });
});

test("CLI validates arguments and can build only within synthetic temp repository output", () => makeRepo((ctx) => {
  ctx.bump(); ctx.commit();
  const run = spawnSync(process.execPath, [builder, "--root", ctx.repo, "--from", "v0.1.0",
    "--to", "0.1.1", "--out-dir", ctx.dist], {
    encoding: "utf8", timeout: 20_000, windowsHide: true,
  });
  assert.equal(run.status, 0, `CLI rejected valid patch: ${run.stderr}`);
  assert.match(run.stdout, /LVL-update-v0\.1\.1\.zip/);
  inspectPatch(path.join(ctx.dist, "LVL-update-v0.1.1.zip"),
    path.join(ctx.dist, "LVL-update-v0.1.1.zip.sha256"));
  const invalid = spawnSync(process.execPath, [builder, "--root", ctx.repo, "--from", "v0.1.0",
    "--to", "0.2.1", "--out-dir", path.join(ctx.root, "invalid-output")], {
    encoding: "utf8", timeout: 20_000, windowsHide: true,
  });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /Target version mismatch/);
}));
