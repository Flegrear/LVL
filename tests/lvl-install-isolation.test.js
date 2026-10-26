import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
const launcher = readFileSync(new URL("../launcher/Launcher.cs", import.meta.url), "utf8");
const setup = readFileSync(new URL("../installer/setup.iss", import.meta.url), "utf8");

test("public LVL and private Alpha never share torrent orphan-cleanup directories", () => {
  assert.match(server, /const torrentShareRoot = path\.join\(os\.tmpdir\(\), "lvl-public-torrents"\)/);
  assert.doesNotMatch(server, /language-video-learner-torrents/);
  assert.match(server, /storage\.clearOrphans\(\)/,
    "cleanup is kept, but scoped to the new public namespace");
});

test("stable public launcher identity and data/profile are isolated while port stays 4273", () => {
  assert.match(launcher, /public int Port = 4273;/);
  assert.match(launcher, /Local\\\\LVL-Public-/);
  assert.match(launcher, /Path\.Combine\(Environment\.GetFolderPath\(Environment\.SpecialFolder\.LocalApplicationData\), "LVL", "data"\)/);
  assert.match(launcher, /Path\.Combine\(Environment\.GetFolderPath\(Environment\.SpecialFolder\.LocalApplicationData\), "LVL", "browser-profile"\)/);
  assert.match(launcher, /info\.EnvironmentVariables\["LANGUAGE_VIDEO_LEARNER_DATA_ROOT"\] = dataRoot;/);
  assert.match(setup, /DefaultDirName=\{localappdata\}\\Programs\\LVL/);
  assert.match(setup, /AppId=\{\{D3C04C52-7A8E-4DC7-9B0A-1EAF4B4A8B8B\}/);
});
