import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SERVER_FEATURES } from "../backend/features/registry.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
// Part B modules are served through backend/features/registry.js, not server.js.
const featureAssets = SERVER_FEATURES.flatMap((feature) => feature.assets || []);

test("organized browser imports resolve through the local static asset allowlist", () => {
  const served = new Map(
    [...server.matchAll(/^\s*\["(\/[^"]+\.js)", \{ file: "([^"]+\.js)", cacheControl:/gm)]
      .map(([, url, file]) => [url, file]),
  );
  for (const [url, asset] of featureAssets) if (url.endsWith(".js")) served.set(url, asset.file);
  const visited = new Set();
  const visit = (url) => {
    if (visited.has(url)) return;
    visited.add(url);
    const file = served.get(url);
    assert.ok(file, `Browser import ${url} must have an explicit local static route`);
    const absolute = path.resolve(root, file);
    assert.ok(fs.existsSync(absolute), `Browser route ${url} must serve an existing file: ${file}`);
    assert.ok(absolute.startsWith(root + path.sep), `No browser import can escape project root: ${file}`);
    const code = fs.readFileSync(absolute, "utf8");
    for (const [, spec] of code.matchAll(/\b(?:from\s*|import\s*)["'](\.\.?\/[^"']+\.js)["']/g)) {
      const next = new URL(spec, `http://127.0.0.1:4173${url}`).pathname;
      visit(next);
    }
  };
  visit("/app.js");
  assert.ok(visited.has("/frontend/calendar/calendar-view.js"));
  assert.ok(visited.has("/frontend/recommendations/recs-ui.js"));
  assert.ok(visited.has("/frontend/ui/ui.js"));
  assert.ok(visited.has("/shared/subtitles/subtitle-sync.js"));
  assert.ok(visited.has("/frontend/features/feature-host.js"));
  assert.ok(visited.has("/frontend/features/registry.js"));
  assert.ok(visited.size > 20, `Expected complete browser module graph, found only ${visited.size}`);
});

test("feature-registry assets point to existing files inside the project", () => {
  for (const [url, asset] of featureAssets) {
    const fullPath = path.resolve(root, asset.file);
    assert.ok(fullPath.startsWith(root + path.sep), `${url} must remain inside project root`);
    assert.ok(fs.existsSync(fullPath) && fs.statSync(fullPath).isFile(), `${url} must point to a regular file: ${asset.file}`);
  }
});

test("static routes refer only to existing reviewed files, including grouped icons and styles", () => {
  const routes = [...server.matchAll(/^\s*\["([^"]+)", \{ file: "([^"]+)", cacheControl:/gm)];
  assert.doesNotMatch(server, /file: "devtools\//,
    "developer-only demo routes must never enter the release server");
  assert.ok(routes.length > 70, "Expected the complete explicit static asset allowlist");
  for (const [, url, file] of routes) {
    const fullPath = path.resolve(root, file);
    assert.ok(fullPath.startsWith(root + path.sep), `${url} must remain inside project root`);
    assert.ok(fs.statSync(fullPath).isFile(), `${url} must point to a regular file: ${file}`);
  }
  for (const asset of ["favicon.ico", "icon.svg", "apple-touch-icon.png", "site.webmanifest"]) {
    assert.match(server, new RegExp(`\\["/${asset.replace(".", "\\.")}", \\{ file: "assets/platform/${asset.replace(".", "\\.")}"`));
  }
});

test("supplied brand exports are organized by theme without changing public URLs", () => {
  const brand = path.join(root, "assets", "brand");
  const groups = { dark: 21, light: 21, marks: 4 };
  for (const [group, expectedCount] of Object.entries(groups)) {
    const files = fs.readdirSync(path.join(brand, group));
    assert.equal(files.length, expectedCount, `${group} retains all supplied artwork`);
    for (const filename of files) {
      assert.ok(
        group === "marks" ? filename.startsWith("lvl_v_mark_") : filename.includes(`_${group}`),
        `${group}/${filename} should be in the correct group`,
      );
    }
  }
  assert.match(server, /file: `assets\/brand\/\$\{theme\}\/\$\{name\}`/);
  assert.match(server, /file: `assets\/brand\/marks\/\$\{name\}`/);
});

test("fresh Alpha 0.1 source contains required modules but no inherited alpha-v0.2 setup", () => {
  for (const relative of [
    "backend/media/transcode-start.js", "frontend/anilist/anilist-auto-association.js",
    "frontend/anilist/anilist-manual-season-link.js", "shared/subtitles/subtitle-stream.js",
    "CHANGELOG.md", "assets/platform/favicon.ico",
  ]) assert.ok(fs.statSync(path.join(root, relative)).isFile(), `Preserve ${relative}`);
  assert.equal(fs.existsSync(path.join(root, "installer/alpha-v0.2")), false,
    "new public installer will be authored independently rather than copying the old setup");
  assert.equal(fs.existsSync(path.join(root, "browser-extension")), false,
    "disabled Coach helper must not enter the first media-only alpha");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(pkg.name, "lvl");
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/, "release source uses versioned tags");
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  assert.equal(lock.version, pkg.version, "package lockfile tracks the release version");
});
