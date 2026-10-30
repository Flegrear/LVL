import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const styles = readFileSync(new URL("../frontend/styles/styles.css", import.meta.url), "utf8");
const panel = html.slice(html.indexOf('id="settings-panel-storage"'), html.indexOf('id="settings-panel-updates"'));

test("Storage has one native, enabled-by-default playback cache switch directly under the shared player budget", () => {
  assert.ok(panel.length > 0, "Storage settings panel must exist");
  const budgetIndex = panel.indexOf('id="storage-player-gb"');
  const budgetNoteIndex = panel.indexOf('id="storage-player-budget-note"');
  const switchIndex = panel.indexOf('id="storage-remux-cache-enabled"');
  const clipsIndex = panel.indexOf('id="storage-clip-gb"');
  assert.ok(budgetIndex >= 0 && budgetIndex < budgetNoteIndex && budgetNoteIndex < switchIndex && switchIndex < clipsIndex,
    "the switch must follow player storage, before learning-only clip storage");
  assert.equal(panel.match(/id="storage-remux-cache-enabled"/g)?.length, 1, "one stable JS selector");
  assert.match(panel, /<label class="ui-switch settings-switch-row storage-cache-option__toggle" for="storage-remux-cache-enabled">\s*<input id="storage-remux-cache-enabled" type="checkbox" checked aria-describedby="storage-remux-cache-description"\s*\/>/);
  assert.match(panel, /<span class="ui-switch__track" aria-hidden="true"><\/span>/);
  assert.match(panel, /<small id="storage-remux-cache-description">/);
});

test("Storage copy describes shared source/indexed/remux budget and on/off effects without promising early seek", () => {
  assert.match(panel, /id="storage-player-budget-note"[^>]*>Torrent downloads, indexed seekable video and playback cache share this one storage limit\./);
  const from = panel.indexOf('id="storage-remux-cache-description"');
  const description = panel.slice(from, panel.indexOf("</small>", from));
  assert.ok(from >= 0, "linked accessible description must exist");
  assert.match(description, /<b>On \(default\):<\/b>[\s\S]*fully seekable H\.264 file/);
  assert.match(description, /Preparation uses CPU and disk within the player budget/);
  assert.match(description, /Unsupported videos keep normal playback/);
  assert.match(description, /<b>Off:<\/b>[\s\S]*No background seek conversion/);
  assert.doesNotMatch(description, /faster repeat seeks|Repeat seeks may take longer/);
  assert.doesNotMatch(panel.slice(panel.indexOf('id="tip-storage-player"'), panel.indexOf('id="storage-player-usage"')),
    /When you switch to another video, the previous download is deleted\./);
  assert.match(panel.slice(panel.indexOf('id="tip-storage-player"'), panel.indexOf('id="storage-player-usage"')),
    /eligible fully downloaded SDR episodes may be converted once into a fully seekable file/);
});

test("cache switch styling extends the existing black-and-white LVL Settings switch", () => {
  assert.match(styles, /\.storage-cache-option__toggle\s*\{[^}]*display:flex;[^}]*align-items:flex-start/);
  assert.match(styles, /\.storage-cache-option__mode\s*\{\s*display:block;/);
  assert.match(styles, /\.storage-row__note\s*\{[^}]*color:#8f8f8f;/);
});
