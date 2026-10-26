import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const brand = path.join(root, "assets", "brand");
const read = (name) => fs.readFileSync(path.join(root, name));
const brandFile = (name) => path.join(brand, name.startsWith("lvl_v_mark_") ? "marks" : name.includes("_dark") ? "dark" : "light", name);

test("Supplied LVL masters replace all canonical browser and tray icon files", () => {
  for (const [canonical, source] of [
    ["assets/platform/favicon.ico", "favicon_dark.ico"],
    ["assets/platform/icon.svg", "lvl_favicon_dark.svg"],
    ["assets/platform/apple-touch-icon.png", "app_icon_dark_180.png"],
  ]) {
    assert.ok(read(canonical).equals(fs.readFileSync(brandFile(source))), canonical);
  }
  assert.match(read("assets/platform/icon.svg").toString(), /viewBox="0 0 1024 1024"/);
  assert.doesNotMatch(read("assets/platform/icon.svg").toString(), /viewBox="0 0 64 64"/);
});

test("All supplied dark/light PNG sizes and favicon variants remain unaltered", () => {
  assert.equal(["dark", "light", "marks"].reduce((sum, folder) =>
    sum + fs.readdirSync(path.join(brand, folder)).filter((file) => /\.(?:svg|png|ico)$/.test(file)).length, 0), 46);
  for (const theme of ["dark", "light"]) {
    for (const size of [180, 192, 256, 512]) checkPng(`app_icon_${theme}_${size}.png`, size);
    for (const size of [16, 32, 48, 64, 128, 256]) checkPng(`favicon_${theme}_${size}.png`, size);
    const ico = fs.readFileSync(brandFile(`favicon_${theme}.ico`));
    assert.equal(ico.readUInt16LE(0), 0, "ICO reserved marker");
    assert.equal(ico.readUInt16LE(2), 1, "ICO type");
    assert.ok(ico.readUInt16LE(4) >= 4, "ICO contains multiple resolutions");
  }
  checkPng("app_icon_dark_180.png", 180);
  const manifest = JSON.parse(read("assets/platform/site.webmanifest").toString());
  assert.deepEqual(manifest.icons.map(({ sizes }) => sizes), ["192x192", "512x512"]);
  assert.equal(manifest.theme_color, "#000000");
  assert.match(read("index.html").toString(), /rel="apple-touch-icon" href="\/apple-touch-icon\.png\?v=2" sizes="180x180"/);
});

function checkPng(file, dimension) {
  const png = fs.readFileSync(brandFile(file));
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", file);
  assert.equal(png.readUInt32BE(16), dimension, `${file} width`);
  assert.equal(png.readUInt32BE(20), dimension, `${file} height`);
}
