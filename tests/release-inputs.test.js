import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isSetupSourceFile } from "../scripts/release-inputs.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("docs and developer demo directories are absent from the release source", () => {
  assert.equal(fs.existsSync(path.join(root, "docs")), false,
    "the new app source must not retain an internal docs directory");
  assert.equal(fs.existsSync(path.join(root, "devtools")), false,
    "the public app must not retain an old developer gallery or recovery demo");
  const ignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
  assert.match(ignore, /^\/docs\/$/m);
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  assert.doesNotMatch(readme, /\]\((?:\.\/)?docs\//);
});

test("setup source allowlist includes the latest application but never documentation or private data", () => {
  for (const file of [
    "app.js", "server.js", "index.html", "package.json", "CHANGELOG.md",
    "backend/media/transcode-start.js", "frontend/anilist/anilist-auto-association.js",
    "frontend/anilist/anilist-manual-season-link.js", "shared/subtitles/subtitle-stream.js",
    "assets/platform/favicon.ico", "learning/data/en.words.tsv",
  ]) {
    assert.equal(isSetupSourceFile(file), true, `${file} is needed by the application`);
    assert.equal(fs.statSync(path.join(root, file)).isFile(), true, `${file} exists`);
  }
  for (const file of [
    "docs/INSTALL.md", "docs/RELEASE_CHECKLIST.md", "docs/anything.md",
    "README.md", "tests/release-inputs.test.js", "devtools/gallery/components.js",
    "installer/old/setup.iss", "scripts/build-glosses.mjs", "learning/build-presets.mjs", ".git/config",
    "data/library.sqlite3", "build/temp.bin", "dist/LVL-Setup.exe",
    "backend/.env", "frontend/debug.log", "learning/data/secret.pem",
    "backend/../../docs/INSTALL.md", "assets\\..\\docs\\ROADMAP.md",
    "C:\\temp\\server.js", "assets//favicon.ico", "./server.js",
  ]) assert.equal(isSetupSourceFile(file), false, `${file} cannot be bundled`);
});
