// Sync the supplied LVL brand exports into the stable filenames used by
// browsers, tray/launcher builds, and the installer. Do not redraw the logo.
// Run: node launcher/make-icon.mjs [optional-favicon-preview.png]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const brand = path.join(root, "assets", "brand");
const platform = path.join(root, "assets", "platform");
const files = [
  ["favicon_dark.ico", "favicon.ico"],
  ["lvl_favicon_dark.svg", "icon.svg"],
  ["app_icon_dark_180.png", "apple-touch-icon.png"],
];
for (const [source, target] of files) {
  const from = path.join(brand, "dark", source);
  if (!fs.existsSync(from)) throw new Error(`Missing LVL brand source: ${from}`);
  fs.mkdirSync(platform, { recursive: true });
  fs.copyFileSync(from, path.join(platform, target));
}
if (process.argv[2]) {
  const preview = path.resolve(process.argv[2]);
  fs.copyFileSync(path.join(brand, "dark", "favicon_dark_256.png"), preview);
}
console.log("Synced LVL brand icons: favicon.ico, icon.svg, apple-touch-icon.png");
