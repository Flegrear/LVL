import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../frontend/styles/styles.css", import.meta.url), "utf8");
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
const watch = html.slice(html.indexOf('<section id="view-watch"'), html.indexOf('<dialog id="player-subtitle-dialog"'));

test("Watch keeps compact download/upload amounts and adds progress above them only on hover or focus", () => {
  assert.match(watch, /<div id="player-transfer-stats" class="player-transfer-stats" tabindex="0" role="group"[^>]* hidden>/);
  assert.match(watch, /<span id="player-download-target" class="player-transfer-progress" aria-hidden="true">↓ 0 B \/ —<\/span>/);
  assert.match(watch, /class="player-transfer-down"/);
  assert.match(watch, /<span id="player-downloaded">↓ 0 B<\/span>/);
  assert.match(watch, /<span id="player-uploaded">↑ 0 B<\/span>/);
  assert.doesNotMatch(watch, /player-transfer-tooltip|Transfer totals|aria-describedby="player-transfer-tooltip"/);
  assert.equal(watch.match(/id="player-download-target"/g)?.length, 1);
});

test("hover/focus shows the progress line above the existing unchanged counters without reflow or popup", () => {
  assert.match(css, /\.player-transfer-stats\s*\{[^}]*position:relative;[^}]*font:500 11px\/1\.2 var\(--font-sans\)/);
  assert.match(css, /\.player-transfer-progress\s*\{[^}]*position:absolute;[^}]*bottom:calc\(100% \+ 6px\);[^}]*visibility:hidden;[^}]*font:inherit;/);
  assert.match(css, /\.player-transfer-stats:is\(:hover,:focus-visible\) \.player-transfer-progress\s*\{[^}]*visibility:visible;/);
  assert.doesNotMatch(css, /\.player-transfer-down:is\(:hover,:focus-visible\)/);
  assert.doesNotMatch(css, /\.player-transfer-tooltip(?:__\w+)?/);
});

test("download counter and matching selected episode total use current file within a pack", () => {
  assert.match(app, /payload\?\.files\?\.find\(\(file\) => Number\(file\.index\) === selectedFileIndex\)/);
  assert.match(app, /const down = Number\(hasSelectedFile \? selectedFile\?\.downloaded : payload\?\.downloaded\) \|\| 0;/);
  assert.match(app, /\$\("#player-downloaded"\)\.textContent = `↓ \$\{formatTransferBytes\(down\)\}`/);
  assert.match(app, /\$\("#player-uploaded"\)\.textContent = `↑ \$\{formatTransferBytes\(up\)\}`/);
  assert.match(app, /target\.textContent = `↓ \$\{formatTransferBytes\(down\)\} \/ \$\{hasTotal \? formatTransferBytes\(totalBytes\) : "—"\}`/);
  assert.match(server, /length: torrent\.length \|\| 0,/);
  assert.match(server, /downloaded: file\.downloaded,/);
});

test("Packs show selected episode progress and size, not the aggregate 8+ GB torrent", () => {
  const start = app.indexOf("function formatTransferBytes(");
  const end = app.indexOf("\nfunction stopTransferStats(", start);
  assert.ok(start > 0 && end > start, "transfer update functions remain separately testable");
  const nodes = Object.fromEntries([
    "#player-transfer-stats", "#player-transfer-down", "#player-downloaded",
    "#player-download-target", "#player-uploaded",
  ].map((selector) => [selector, {
    textContent: "", hidden: false, attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
  }]));
  const state = { currentSource: { kind: "torrent", fileIndex: 2 } };
  const context = vm.createContext({
    state, $: (selector) => nodes[selector], updateLoadingTransferDetail() {},
  });
  vm.runInContext(app.slice(start, end), context);
  const pack = {
    length: 9 * 1024 ** 3, downloaded: 3 * 1024 ** 3, uploaded: 197 * 1024,
    files: [
      { index: 0, length: 1024 ** 3, downloaded: 1024 ** 3 },
      { index: 2, length: 500 * 1024 ** 2, downloaded: 64 * 1024 ** 2 },
    ],
  };
  context.updateTransferStats(pack);
  assert.equal(nodes["#player-downloaded"].textContent, "↓ 64.0 MB");
  assert.equal(nodes["#player-download-target"].textContent, "↓ 64.0 MB / 500.0 MB");
  assert.equal(nodes["#player-uploaded"].textContent, "↑ 197 KB");
  assert.equal(nodes["#player-transfer-stats"].hidden, false);
  assert.match(nodes["#player-transfer-stats"].attributes["aria-label"], /Downloaded 64\.0 MB; total to download 500\.0 MB/);
  state.currentSource.fileIndex = 0;
  context.updateTransferStats(pack);
  assert.equal(nodes["#player-download-target"].textContent, "↓ 1.00 GB / 1.00 GB", "switching pack episodes must update both amounts");
  state.currentSource.fileIndex = 99;
  context.updateTransferStats(pack);
  assert.equal(nodes["#player-download-target"].textContent, "↓ 0 B / —", "unknown pack files must never display the entire torrent size");
  state.currentSource = null;
  context.updateTransferStats(null);
  assert.equal(nodes["#player-transfer-stats"].hidden, true);
  assert.equal(nodes["#player-download-target"].textContent, "↓ 0 B / —", "no stale pack total after leaving Watch");
});
