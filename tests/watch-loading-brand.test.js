import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const from = app.indexOf('let playerLoadingLibraryId = "";');
const to = app.indexOf("\n// Loading stages", from);
assert.ok(from >= 0 && to > from);
const loader = app.slice(from, to);

function createLoader() {
  const images = [];
  class Probe {
    constructor() { this.naturalWidth = 280; images.push(this); }
    set src(value) { this._src = value; }
    get src() { return this._src; }
  }
  const brand = { hidden: true, dataset: {} };
  const ghost = { src: "", removeAttribute(name) { if (name === "src") this.src = ""; } };
  const fill = { src: "", removeAttribute(name) { if (name === "src") this.src = ""; } };
  const nodes = {
    "#video-loading-brand": brand,
    "#video-loading-logo-ghost": ghost,
    "#video-loading-logo-fill": fill,
  };
  const context = vm.createContext({
    $: (key) => nodes[key], Image: Probe,
    playerLoadingVisualProgress: 0,
    drawPlayerLoadingProgress: () => {},
    updatePlayerLoadingAnimation: () => {},
  });
  vm.runInContext(loader, context);
  return { images, brand, ghost, fill, context, setArtwork: vm.runInContext("setPlayerLoadingArtwork", context) };
}

test("Logo loader reveals matching gray and color layers only after the artwork loads", () => {
  const { images, brand, ghost, fill, setArtwork } = createLoader();
  setArtwork("https://example.test/show-logo.png");
  assert.equal(brand.hidden, true);
  assert.equal(images.length, 1);
  images[0].onload();
  assert.equal(brand.hidden, false);
  assert.equal(ghost.src, "https://example.test/show-logo.png");
  assert.equal(fill.src, ghost.src);
  setArtwork("https://example.test/show-logo.png");
  assert.equal(images.length, 1, "Same title must reuse its in-flight or finished logo");
});

test("Old artwork requests cannot replace a new title or a logo-free local video", () => {
  const { images, brand, ghost, setArtwork } = createLoader();
  setArtwork("https://example.test/old.png");
  setArtwork("https://example.test/new.png");
  images[0].onload();
  assert.equal(brand.hidden, true, "Late completion from previous source is ignored");
  images[1].onload();
  assert.equal(ghost.src, "https://example.test/new.png");
  setArtwork("");
  assert.equal(brand.hidden, true);
  assert.equal(ghost.src, "");
  images[1].onload();
  assert.equal(brand.hidden, true, "A logo-free source stays on the spinner fallback");
});

test("Logo loader tries original catalog artwork if resized artwork fails", () => {
  const { images, brand, ghost, setArtwork } = createLoader();
  setArtwork("https://example.test/resized.png", "https://example.test/original.png");
  images[0].onerror();
  assert.equal(images[0].src, "https://example.test/original.png");
  images[0].onload();
  assert.equal(brand.hidden, false);
  assert.equal(ghost.src, "https://example.test/original.png");
});

test("a late-loading logo gets a visible grayscale-to-partial-color sweep after playback is ready", () => {
  const artwork = [];
  class Probe {
    constructor() { this.naturalWidth = 240; artwork.push(this); }
    set src(value) { this._src = value; }
    get src() { return this._src; }
  }
  const frames = new Map();
  const timers = new Map();
  let serial = 0;
  const vars = {};
  const overlay = {
    hidden: true,
    style: { setProperty(name, value) { vars[name] = value; } },
    classList: { toggle() {}, contains: () => false },
  };
  const brand = { hidden: true, dataset: {} };
  const logo = () => ({ src: "", removeAttribute(name) { if (name === "src") this.src = ""; } });
  const elements = {
    "#video-loading": overlay, "#video-loading-brand": brand,
    "#video-loading-logo-ghost": logo(), "#video-loading-logo-fill": logo(),
    "#video-loading-actions": { hidden: true }, "#video-loading-title": { textContent: "" },
  };
  const context = vm.createContext({
    $: (name) => elements[name] || null,
    Image: Probe,
    window: {
      requestAnimationFrame(callback) { const id = ++serial; frames.set(id, callback); return id; },
      cancelAnimationFrame(id) { frames.delete(id); },
      setTimeout(callback) { const id = ++serial; timers.set(id, callback); return id; },
      clearTimeout(id) { timers.delete(id); },
    },
    state: { loadingProgress: 0, loadingDetail: "" },
    frame: { classList: { remove() {} } },
    recoveryDisplayPhase: "", renderRecoveryOverlay() {}, currentRecoveryKey: () => null,
  });
  const a = app.indexOf('let playerLoadingLibraryId = "";');
  const b = app.indexOf("\nfunction updateLoadingTransferDetail(", a);
  const c = app.indexOf("function finishPlayerLoading() {");
  const d = app.indexOf("\nfunction clearPlayerControlsHideTimer()", c);
  vm.runInContext(app.slice(a, b) + app.slice(c, d), context);
  vm.runInContext('setPlayerLoadingArtwork("https://example.test/logo.png"); setPlayerLoading(68,"Connecting"); finishPlayerLoading();', context);
  assert.equal(brand.hidden, true, "artwork is genuinely still loading, not rendered as a full-color logo");
  const runTimers = () => { const jobs = [...timers.values()]; timers.clear(); jobs.forEach((job) => job()); };
  runTimers(); // canplay already fired but artwork has not arrived
  assert.equal(overlay.hidden, false, "logo request gets a bounded grace period after media readiness");
  artwork[0].onload();
  assert.equal(brand.hidden, false);
  assert.equal(vars["--logo-fill"], "0%", "colored logo starts fully masked, gray base remains visible");
  const tick = (time) => { for (const [key, callback] of [...frames]) { frames.delete(key); callback(time); } };
  for (let t = 16; t <= 512; t += 16) tick(t);
  const quarter = Number(vars["--logo-fill"].replace("%", ""));
  assert.ok(quarter > 15 && quarter < 35, `half a second must display a PARTIALLY colored logo (${quarter}%)`);
  runTimers();
  assert.equal(overlay.hidden, false, "cannot conceal before color finishes");
  for (let t = 528; t <= 1104; t += 16) tick(t);
  const halfway = Number(vars["--logo-fill"].replace("%", ""));
  assert.ok(halfway > 45 && halfway < 65 && halfway > quarter, `the image gradually reveals intermediate color: ${halfway}%`);
  for (let t = 1120; t <= 2304; t += 16) tick(t);
  assert.equal(vars["--logo-fill"], "100%");
  runTimers();
  assert.equal(overlay.hidden, true, "hide only after an actual visible sweep");
});
