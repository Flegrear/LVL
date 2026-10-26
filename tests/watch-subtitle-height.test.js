import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../frontend/styles/styles.css", import.meta.url), "utf8");
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");

test("Subtitle appearance exposes adjustable Height (position), including live preview", () => {
  assert.match(html, /HEIGHT \(POSITION\)[\s\S]*?id="subtitle-style-position-value"/);
  assert.match(html, /id="subtitle-style-position"[^>]*min="5" max="70" step="1" value="16"/);
  assert.match(html, /id="subtitle-style-preview"[\s\S]*?class="subtitle-preview-lines"/);
  assert.match(css, /\.subtitle-preview-lines\s*\{[^}]*bottom:var\(--subtitle-bottom,16%\)/);
  assert.match(css, /\.subtitle-overlay\s*\{[^}]*bottom:var\(--subtitle-bottom,16%\)/);
  assert.match(app, /"#subtitle-style-position",\s*"#subtitle-style-color"/m,
    "Height must be connected to the existing subtitle appearance events");
});

test("Changing Height moves captions, persists the preference, and clamps to the player bounds", () => {
  const values = {
    "#subtitle-style-font": { value: "sans" },
    "#subtitle-style-weight": { value: "700" },
    "#subtitle-style-size": { value: "100" },
    "#subtitle-style-shadow": { value: "40" },
    "#subtitle-style-background": { value: "0" },
    "#subtitle-style-color": { value: "#ffffff" },
    "#subtitle-style-romanization": { checked: false },
    "#subtitle-style-position": { value: "60" },
  };
  const properties = {};
  const saved = [];
  let preferencesWritten = 0;
  const defaults = { font: "sans", weight: 700, size: 100, secondary: 82, shadow: 40, background: 0,
    position: 16, color: "#ffffff", romanization: true };
  const state = { subtitleStyle: { ...defaults } };
  const source = app.slice(app.indexOf("function applySubtitleStyle({"), app.indexOf("\nasync function postJson(", app.indexOf("function applySubtitleStyle({")));
  assert.ok(source.startsWith("function applySubtitleStyle("));
  const context = vm.createContext({
    $: (selector) => values[selector],
    state, subtitleStyleDefaults: defaults,
    document: { documentElement: { style: { setProperty: (name, value) => { properties[name] = value; } } } },
    subtitleFontFamily: () => "Inter, sans-serif",
    subtitleShadowAmount: (value) => Number(value) || 0,
    subtitleShadowValue: () => "none",
    localStorage: { setItem: (...args) => saved.push(args) },
    persistPreferences: () => { preferencesWritten += 1; },
    renderSubtitleStyleControls: () => {},
    updatePlayerPreferenceButtons: () => {},
    ensureCurrentRomanization: () => {},
    renderSubtitles: () => {},
  });
  vm.runInContext(source, context);
  vm.runInContext("readSubtitleStyleControls()", context);
  assert.equal(state.subtitleStyle.position, 60);
  assert.equal(properties["--subtitle-bottom"], "60%");
  assert.equal(JSON.parse(saved.at(-1)[1]).position, 60);
  assert.equal(preferencesWritten, 1);
  values["#subtitle-style-position"].value = "100";
  vm.runInContext("readSubtitleStyleControls()", context);
  assert.equal(state.subtitleStyle.position, 70);
  assert.equal(properties["--subtitle-bottom"], "70%");
  values["#subtitle-style-position"].value = "5";
  vm.runInContext("readSubtitleStyleControls()", context);
  assert.equal(properties["--subtitle-bottom"], "5%");
  assert.equal(saved.length, 3);
});
