import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../frontend/styles/styles.css", import.meta.url), "utf8");
const from = app.indexOf("// A single live video/subtitle DOM");
const to = app.indexOf("// restoreScroll:", from);
assert.ok(from >= 0 && to > from);
const floatingCode = app.slice(from, to);

function classList(initial = []) {
  const set = new Set(initial);
  return { contains: (name) => set.has(name), add: (name) => set.add(name),
    remove: (name) => set.delete(name), toggle: (name, value) => value ? set.add(name) : set.delete(name) };
}

function harness({ scope = "site", legacyScope = null, auto = true, pipAvailable = true, classicAvailable = true } = {}) {
  const nodes = new Map();
  const watch = { classList: classList(), style: {} };
  nodes.set("#view-watch", watch);
  const actions = { hidden: true, classList: classList() };
  nodes.set("#floating-player-actions", actions);
  const pause = { classList: classList(), setAttribute(name, value) { this[name] = value; } };
  const mute = { classList: classList(), setAttribute(name, value) { this[name] = value; } };
  nodes.set("#floating-player-pause", pause);
  nodes.set("#floating-player-mute", mute);
  nodes.set("#floating-player-volume", { value: "0" });
  const progress = { value: "0", max: "1" };
  const time = { textContent: "" };
  nodes.set("#floating-player-progress", progress);
  nodes.set("#floating-player-time", time);
  const placeholder = { hidden: true };
  nodes.set("#floating-player-placeholder", placeholder);
  const operations = [];
  const home = {
    insertBefore(node, sibling) {
      operations.push(sibling === frame ? "anchor-placed" : "frame-restored");
      node.parentNode = home;
      frame.parentNode = home;
    },
  };
  const frame = { classList: classList(["has-video"]), parentNode: home, style: {} };
  const video = { paused: false, ended: false, volume: .6, muted: false, currentTime: 25, duration: 120,
    pause() { this.paused = true; }, requestPictureInPicture: async () => {
    operations.push("native-pip"); return true;
  } };
  const pip = {
    closed: false, listeners: new Map(),
    document: {
      head: { append() {} },
      body: { append(node) { assert.equal(node, frame); operations.push("frame-moved"); node.parentNode = this; } },
      createElement: () => ({ textContent: "" }),
    },
    addEventListener(name, cb) { this.listeners.set(name, cb); },
    close() { this.closed = true; operations.push("pip-closed"); this.listeners.get("pagehide")?.(); },
  };
  const pipApi = {
    window: null,
    requestWindow: async (options) => {
      pipApi.lastOptions = options;
      operations.push("request-window");
      pipApi.window = pip;
      return pip;
    },
  };
  const storage = new Map([[ "lvl-floating-auto-v1", auto ? "1" : "0" ]]);
  if (scope !== null) storage.set("lvl-floating-scope-v2", scope);
  if (legacyScope !== null) storage.set("lvl-floating-scope-v1", legacyScope);
  const timers = new Map();
  let timerId = 0;
  let now = 1_000_000;
  const windowListeners = new Map();
  const document = {
    pictureInPictureElement: null, pictureInPictureEnabled: classicAvailable,
    querySelectorAll: () => [],
    createComment: () => ({ parentNode: null, remove() { this.parentNode = null; } }),
    exitPictureInPicture: async () => { document.pictureInPictureElement = null; },
  };
  const window = { innerWidth: 1200, innerHeight: 900,
    documentPictureInPicture: pipAvailable ? pipApi : null,
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay, dueAt: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    addEventListener(type, callback) { windowListeners.set(type, [...(windowListeners.get(type) || []), callback]); },
    removeEventListener(type, callback) { windowListeners.set(type, (windowListeners.get(type) || []).filter((fn) => fn !== callback)); },
  };
  const context = vm.createContext({
    window, document, video, frame, state: { mediaDurationMs: 120000 },
    Date: { now: () => now },
    absolutePlaybackSeconds: () => video.currentTime,
    playerIsPlaying: () => !video.paused,
    playerWantsMuted: () => video.muted,
    formatTime: (ms) => `${Math.floor(ms / 60000).toString().padStart(2, "0")}:${Math.floor(ms / 1000 % 60).toString().padStart(2, "0")}`,
    linePreview: { active: false, pending: false },
    localStorage: { getItem: (key) => storage.get(key) || null },
    $: (selector) => nodes.get(selector) || null,
    toast: (msg) => operations.push(msg),
    closePlayerPopovers: () => {},
    console: { warn: () => {} },
    viewActive: (name) => name === "watch" && false,
  });
  vm.runInContext(floatingCode, context);
  return { context, pip, video, frame, document, window, watch, actions, operations, placeholder, pause, mute, progress, time, timers,
    fireTimer() {
      const [id, timer] = timers.entries().next().value || [];
      assert.ok(timer, "Expected pending idle timer");
      timers.delete(id);
      now = Math.max(now, timer.dueAt);
      timer.fn();
      return timer.delay;
    },
    advanceTime(ms) { now += ms; },
    setPreference(key, value) { vm.runInContext(`floatingPrefs.${key} = ${JSON.stringify(value)};`, context); },
    async settle() { await new Promise((resolve) => setImmediate(resolve)); },
    run: (js) => vm.runInContext(js, context) };
}

test("site-only automatic floating stays inside LVL and clamps drag/resize to the viewport", () => {
  const h = harness();
  h.run('updateFloatingPlayback("library")');
  assert.equal(h.watch.classList.contains("is-floating"), true);
  assert.equal(h.actions.hidden, false);
  assert.equal(h.operations.includes("request-window"), false);
  assert.match(h.watch.style.width, /px$/, "Floating mode sets popup dimensions");
  const bounds = h.run("clampSiteFloatBounds({width:9000,x:-100,y:5000})");
  assert.equal(bounds.width, 1184);
  assert.equal(bounds.x, 8);
  assert.ok(bounds.y <= 900 - bounds.width * 9 / 16 - 8);
  h.run('updateFloatingPlayback("watch")');
  assert.equal(h.watch.classList.contains("is-floating"), false);
  for (const key of ["left", "top", "width"]) assert.equal(h.watch.style[key], "", "Normal Watch clears " + key);
  assert.equal(h.frame.style.cursor, "");
});

test("X only closes the popup and pauses; the separate Return control navigates to Watch", () => {
  const start = app.indexOf('$("#floating-player-return")?.addEventListener("click"');
  const end = app.indexOf('$("#floating-player-pause")?.addEventListener("click"', start);
  const closeStart = app.indexOf('$("#floating-player-close")?.addEventListener("click"');
  const closeEnd = app.indexOf('\nvideo.addEventListener("ended"', closeStart);
  assert.ok(start >= 0 && end > start && closeStart >= 0 && closeEnd > closeStart);
  const handlers = new Map();
  const calls = [];
  const video = { pause() { calls.push("pause"); } };
  const context = vm.createContext({
    $: (name) => ({ addEventListener: (_type, handler) => handlers.set(name, handler) }),
    video, closeDesktopFloating: () => calls.push("close-desktop"),
    showSiteFloating: (visible) => calls.push("site-" + visible),
    switchView: (name) => calls.push("view-" + name),
    floatingManual: true,
  });
  vm.runInContext(app.slice(start, end) + "\n" + app.slice(closeStart, closeEnd), context);
  handlers.get("#floating-player-close")();
  assert.deepEqual(calls, ["pause", "close-desktop", "site-false"], "X must not switch routes");
  assert.equal(context.floatingManual, false);
  calls.length = 0;
  handlers.get("#floating-player-return")();
  assert.deepEqual(calls, ["close-desktop", "view-watch"]);
});

test("the explicit popup icon requests true cross-application desktop PiP even with site auto-popup selected", () => {
  const from = app.indexOf('$("#player-float")?.addEventListener("click"');
  const to = app.indexOf('$("#floating-player-return")?.addEventListener("click"', from);
  assert.ok(from > 0 && to > from);
  let click;
  const calls = [];
  const settings = { value: "site" };
  const context = vm.createContext({
    $: (selector) => selector === "#settings-float-scope" ? settings
      : { addEventListener: (_, handler) => { click = handler; } },
    floatMayDisplay: () => true,
    openDesktopFloating: () => { calls.push("desktop-pip"); return Promise.resolve(true); },
    floatingManual: false,
    floatingPrefs: { scope: "site" },
    FLOAT_SCOPE_KEY: "lvl-floating-scope-v2",
    localStorage: { setItem: (name, value) => calls.push(`${name}=${value}`) },
  });
  vm.runInContext(app.slice(from, to), context);
  click();
  assert.deepEqual(calls, ["lvl-floating-scope-v2=desktop", "desktop-pip"]);
  assert.equal(settings.value, "desktop");
  assert.equal(context.floatingManual, true);
});

test("floating captions reuse Watch's full track chooser and Customize dialog", () => {
  assert.match(html, /id="floating-player-captions"[^>]*aria-haspopup="menu"[^>]*aria-controls="player-subtitle-menu"/);
  assert.match(css, /#view-watch\.is-floating #player-subtitle-menu,[\s\S]*?top:44px;/);
  assert.match(css, /#view-watch\.is-floating \.watch-player-main > #player-subtitle-dialog\[open\]\s*\{\s*display:block !important; pointer-events:auto; cursor:default;/,
    "The modal cannot inherit the floating overlay's pointer-events:none or it becomes visible but unclickable");
  assert.match(app, /\$\("#player-toggle-subs"\)\.addEventListener\("click", togglePlayerSubtitleMenu\)/);
  assert.match(app, /\$\("#floating-player-captions"\)\?\.addEventListener\("click", togglePlayerSubtitleMenu\)/);
  assert.match(app, /if \(button\.hasAttribute\("data-caption-customize"\)\) \{ openPlayerSubtitleManager\(\); return; \}/);
  const start = app.indexOf("function togglePlayerSubtitleMenu(");
  const end = app.indexOf('\n$("#player-toggle-subs").addEventListener("click", togglePlayerSubtitleMenu)', start);
  assert.ok(start >= 0 && end > start);
  const menu = { hidden: true };
  const normal = { expanded: "", setAttribute(_name, value) { this.expanded = value; } };
  const floating = { expanded: "", setAttribute(_name, value) { this.expanded = value; } };
  let renders = 0;
  const context = vm.createContext({
    $: (selector) => ({
      "#view-watch": { classList: { contains: () => true } },
      "#player-subtitle-menu": menu,
      "#player-toggle-subs": normal,
      "#floating-player-captions": floating,
    })[selector],
    floatingDesktopWindow: null,
    closePlayerPopovers: () => {},
    renderPlayerSubtitleMenu: () => { renders += 1; },
    clearPlayerControlsHideTimer: () => {},
    schedulePlayerControlsHide: () => {},
  });
  vm.runInContext(app.slice(start, end), context);
  const event = { stopPropagation() {} };
  vm.runInContext("togglePlayerSubtitleMenu", context)(event);
  assert.equal(menu.hidden, false);
  assert.equal(normal.expanded, "true");
  assert.equal(floating.expanded, "true");
  assert.equal(renders, 1);
  vm.runInContext("togglePlayerSubtitleMenu", context)(event);
  assert.equal(menu.hidden, true);
  assert.equal(floating.expanded, "false");
});

test("borderless in-app floating is the default, including legacy saved desktop preferences", async () => {
  const fresh = harness({ scope: null, legacyScope: "desktop" });
  assert.equal(fresh.run("floatingPrefs.scope"), "site");
  fresh.run('updateFloatingPlayback("library")');
  assert.equal(fresh.watch.classList.contains("is-floating"), true);
  assert.ok(!fresh.operations.includes("request-window"), "no browser-origin title strip in default mode");
  assert.doesNotMatch(html, /id="player-pip"/, "remove the always-native PiP shortcut that bypassed borderless mode");
  assert.doesNotMatch(app, /\$\("#player-pip"\)/, "no hidden native PiP shortcut handler");
  const desktop = harness({ scope: "desktop" });
  assert.equal(desktop.run("floatingPrefs.scope"), "desktop");
  desktop.run('updateFloatingPlayback("library")');
  await desktop.settle();
  assert.ok(desktop.operations.includes("request-window"), "user-selected cross-app PiP is preserved");
  assert.match(html, /value="site">Borderless inside LVL/);
  assert.match(html, /value="desktop">Above other apps - Browser PiP \(browser title bar\)/);
  assert.match(html, /Browser PiP can float above other applications where supported/);
});

test("manual mode does not automatically pop out on departure, and paused playback cannot trigger auto popup", () => {
  const h = harness({ auto: false, scope: "desktop" });
  h.run('updateFloatingPlayback("library")');
  assert.deepEqual(h.operations, []);
  h.run("floatingManual = true; updateFloatingPlayback('library')");
  assert.ok(h.operations.includes("request-window"));
  const other = harness({ scope: "desktop" });
  other.video.paused = true;
  other.run('updateFloatingPlayback("library")');
  assert.deepEqual(other.operations, []);
});

test("document PiP receives the exact live video frame, preserves captions, and restores it on close", async () => {
  const h = harness({ scope: "desktop" });
  h.run('updateFloatingPlayback("library")');
  await h.settle();
  assert.deepEqual(h.operations.slice(0, 3), ["request-window", "anchor-placed", "frame-moved"]);
  assert.equal(h.window.documentPictureInPicture.lastOptions.disallowReturnToOpener, true, "omit Chromium's duplicate back-to-tab control; the native origin strip is not app-controlled");
  assert.equal(h.frame.classList.contains("is-document-pip"), true);
  assert.equal(h.placeholder.hidden, false);
  assert.equal(h.watch.classList.contains("is-floating"), false);
  assert.equal(h.actions.hidden, false);
  assert.equal(h.pip.document.body, h.frame.parentNode);
  h.run('updateFloatingPlayback("watch")');
  assert.equal(h.pip.closed, true);
  assert.equal(h.frame.classList.contains("is-document-pip"), false);
  assert.equal(h.placeholder.hidden, true);
  assert.ok(h.operations.includes("frame-restored"));
  assert.equal(h.video.paused, false, "Returning to Watch must not pause or replace the video");
});

test("closing the browser-owned desktop PiP window outside Watch restores frame and pauses without navigation", async () => {
  const h = harness({ scope: "desktop" });
  h.run('updateFloatingPlayback("library")');
  await h.settle();
  h.pip.close();
  assert.equal(h.video.paused, true);
  assert.equal(h.frame.classList.contains("is-document-pip"), false);
  assert.equal(h.placeholder.hidden, true);
  assert.ok(h.operations.includes("frame-restored"));
});

test("without Document PiP, native video PiP is used; unsupported browsers fall back to site-only", async () => {
  const native = harness({ scope: "desktop", pipAvailable: false });
  native.run('updateFloatingPlayback("library")');
  await native.settle();
  assert.deepEqual(native.operations, ["native-pip"]);
  const site = harness({ scope: "desktop", pipAvailable: false, classicAvailable: false });
  site.run('updateFloatingPlayback("library")');
  await site.settle();
  assert.equal(site.watch.classList.contains("is-floating"), true);
  assert.ok(site.operations.some((step) => step.includes("Desktop popup unavailable")));
});

test("floating UI keeps playback controls but removes the grip, rounds and limited drag area", () => {
  for (const id of ["floating-player-back", "floating-player-pause", "floating-player-forward",
    "floating-player-mute", "floating-player-volume", "floating-player-progress", "floating-player-time", "floating-player-return", "floating-player-close",
    "player-float", "settings-float-auto",
    "settings-float-scope"]) assert.ok(html.includes(`id="${id}"`), `Missing ${id}`);
  assert.doesNotMatch(html, /id="floating-player-resize"|id="floating-player-drag"/);
  assert.doesNotMatch(css, /\.floating-player-resize\s*\{/);
  assert.match(css, /#view-watch\.is-floating #video-frame\s*\{[^}]*border-radius:0;[^}]*cursor:grab;/);
  assert.match(css, /#view-watch\.is-floating #video-frame\s*\{[^}]*border:0;[^}]*border-radius:0; box-shadow:none;/,
    "The floating image must reach its edges without a colored outline or outer shadow");
  const chrome = html.slice(html.indexOf('id="floating-player-actions"'), html.indexOf('id="floating-player-back"'));
  assert.doesNotMatch(chrome, /FLOATING PLAYER|>LVL\s*<|>Return<|>Sound<|>Pause<|>−10<|>\+10</);
  assert.match(chrome, /id="floating-player-return" class="floating-player-action"[^>]*aria-label="Return to Watch"[^>]*><svg/);
  assert.match(chrome, /id="floating-player-close" class="floating-player-action"[^>]*aria-label="Close floating player"[^>]*><svg/);
  assert.match(chrome, /class="floating-player-bottom"[\s\S]*?class="floating-player-controls"/);
  assert.match(css, /\.floating-player-bottom\s*\{[^}]*background:linear-gradient\(transparent,/);
  assert.match(css, /\.floating-player-top\s*\{[^}]*background:transparent;/);
  assert.match(css, /\.floating-player-actions button\s*\{[^}]*border:0;[^}]*background:transparent;/);
  assert.match(css, /\.floating-player-actions \.floating-player-play\s*\{[^}]*background:#f3f3f3;/);
  assert.match(app, /localStorage\.setItem\(FLOAT_AUTO_KEY/);
  assert.match(app, /localStorage\.setItem\(FLOAT_SCOPE_KEY/);
  assert.match(app, /frame\.addEventListener\("pointerdown", beginSiteFloatGesture\)/);
  assert.match(app, /event\.target\.closest\?\.\("button,input,select,textarea,a,label,/);
});

test("all eight resize directions preserve 16:9 and anchor the opposite edges", () => {
  const h = harness();
  const from = app.indexOf("function siteFloatEdge(");
  const to = app.indexOf("\nlet suppressFloatingClick", from);
  assert.ok(from > 0 && to > from);
  vm.runInContext(app.slice(from, to), h.context);
  const bounds = { x: 400, y: 240, width: 400 };
  const ratio = 16 / 9;
  for (const [edge, dx, dy] of [
    ["e", 50, 0], ["w", -50, 0], ["s", 0, 50 / ratio], ["n", 0, -50 / ratio],
    ["se", 50, 25], ["sw", -50, 25], ["ne", 50, -25], ["nw", -50, -25],
  ]) {
    const result = h.run("resizedSiteFloatBounds(" + JSON.stringify(bounds) + ", " + JSON.stringify(edge) + ", " + dx + ", " + dy + ")");
    assert.ok(Math.abs(result.width - 450) < .01, edge + " expands by 50px");
    if (edge.includes("w")) assert.ok(Math.abs(result.x + result.width - 800) < .01, edge + ": opposite side stays fixed");
    else assert.equal(result.x, 400);
    if (edge.includes("n")) assert.ok(Math.abs(result.y + result.width / ratio - (240 + 400 / ratio)) < .01, edge + ": bottom stays fixed");
    else assert.equal(result.y, 240);
  }
  for (const [x, y, expected] of [
    [401, 241, "nw"], [600, 241, "n"], [799, 241, "ne"], [799, 350, "e"],
    [799, 464, "se"], [600, 464, "s"], [401, 464, "sw"], [401, 350, "w"], [600, 350, ""],
  ]) {
    assert.equal(h.run("siteFloatEdge({left:400,top:240,right:800,bottom:465}," + x + "," + y + ")"), expected);
  }
  const constrained = h.run('resizedSiteFloatBounds({x:980,y:760,width:200},"se",300,300)');
  assert.ok(constrained.width <= 212 && constrained.width / ratio <= 132, "Viewport bounds constrain both dimensions");
});

test("drag starts anywhere over video or empty chrome, but leaves buttons and clicks alone", () => {
  const from = app.indexOf("function siteFloatEdge(");
  const to = app.indexOf('\nwindow.addEventListener("resize", () => {', from);
  assert.ok(from > 0 && to > from);
  const listeners = new Map();
  let captures = 0;
  const frame = {
    style: {},
    getBoundingClientRect: () => ({ left: 100, top: 100, right: 480, bottom: 313.75 }),
    addEventListener(type, callback) { listeners.set(type, [...(listeners.get(type) || []), callback]); },
    removeEventListener(type, callback) { listeners.set(type, (listeners.get(type) || []).filter((item) => item !== callback)); },
    setPointerCapture() { captures += 1; },
    releasePointerCapture() { captures -= 1; },
    emit(type, event) { for (const callback of [...(listeners.get(type) || [])]) callback(event); },
  };
  const windowListeners = new Map();
  const fakeWindow = {
    innerWidth: 1000, innerHeight: 800, setTimeout: () => 1,
    addEventListener(type, callback) { windowListeners.set(type, [...(windowListeners.get(type) || []), callback]); },
    removeEventListener(type, callback) { windowListeners.set(type, (windowListeners.get(type) || []).filter((fn) => fn !== callback)); },
    emit(type, event) { for (const fn of [...(windowListeners.get(type) || [])]) fn(event); },
  };
  const ctx = vm.createContext({
    frame, floatingSiteBounds: { x: 100, y: 100, width: 380 },
    $: () => ({ classList: { contains: () => true }, hidden: true }),
    window: fakeWindow, revealFloatingControls() {},
    positionSiteFloating: () => {},
  });
  vm.runInContext(app.slice(from, to), ctx);
  const down = (x, y, closest = () => null) => ({
    button: 0, pointerId: 4, clientX: x, clientY: y,
    currentTarget: frame, target: { closest }, preventDefault() {},
  });
  frame.emit("pointerdown", down(240, 180, () => ({})));
  frame.emit("pointermove", { pointerId: 4, clientX: 320, clientY: 240, buttons: 1 });
  assert.equal(vm.runInContext("floatingSiteBounds.x", ctx), 100, "buttons and input ranges must not drag");
  frame.emit("pointerdown", down(479, 313, () => ({})));
  frame.emit("pointermove", { pointerId: 4, clientX: 600, clientY: 450, buttons: 1 });
  assert.equal(captures, 0, "a control at the corner must not capture the pointer");
  assert.equal(vm.runInContext("floatingSiteBounds.width", ctx), 380, "buttons near an edge must not resize");
  frame.emit("pointerdown", down(240, 180));
  frame.emit("pointerup", { pointerId: 4 });
  assert.equal(captures, 0, "a simple click is not captured or turned into a drag");
  frame.emit("pointerdown", down(240, 180));
  frame.emit("pointermove", { pointerId: 4, clientX: 320, clientY: 240, buttons: 1 });
  assert.equal(vm.runInContext("floatingSiteBounds.x", ctx), 180);
  assert.equal(vm.runInContext("floatingSiteBounds.y", ctx), 160);
  assert.equal(captures, 1);
  frame.emit("pointerup", { pointerId: 4 });
  assert.equal(captures, 0);
  let stopped = false;
  frame.emit("click", { preventDefault() { stopped = true; }, stopImmediatePropagation() {} });
  assert.equal(stopped, true, "release after moving must not toggle pause via a click");
  // Start at the bottom-right resize corner, release outside the frame.
  frame.emit("pointerdown", down(479, 313));
  assert.equal(captures, 1, "corner captures immediately on mouse-down");
  frame.emit("pointermove", { pointerId: 4, clientX: 500, clientY: 335, buttons: 1 });
  const resizedWidth = vm.runInContext("floatingSiteBounds.width", ctx);
  assert.ok(resizedWidth > 380);
  fakeWindow.emit("pointerup", { pointerId: 4, type: "pointerup" });
  assert.equal(captures, 0, "release outside cleans up capture");
  frame.emit("pointermove", { pointerId: 4, clientX: 650, clientY: 470, buttons: 1 });
  assert.equal(vm.runInContext("floatingSiteBounds.width", ctx), resizedWidth, "no sticky resize after release");
  frame.emit("pointerdown", down(479, 313));
  fakeWindow.emit("blur", { type: "blur" });
  assert.equal(captures, 0, "window focus loss ends the gesture");
  frame.emit("pointerdown", down(479, 313));
  frame.emit("pointermove", { pointerId: 4, clientX: 500, clientY: 335, buttons: 0 });
  assert.equal(captures, 0, "movement with button released stops the gesture");
  frame.emit("pointerdown", down(479, 313));
  frame.emit("pointercancel", { pointerId: 4, type: "pointercancel" });
  assert.equal(captures, 0, "pointer cancellation ends the gesture");
  frame.emit("pointerdown", down(479, 313));
  captures -= 1; // browser releases pointer capture before dispatching lostpointercapture
  frame.emit("lostpointercapture", { pointerId: 4, type: "lostpointercapture" });
  assert.equal(captures, 0, "lost capture must not leave a resize running");
  assert.equal(vm.runInContext("activeSiteFloatGesture", ctx), false);
});

test("popup bottom controls fade after 2s idle, reappear on activity and stay up while interacting", () => {
  const h = harness();
  h.run('updateFloatingPlayback("library")');
  assert.equal(h.actions.classList.contains("is-idle"), false);
  assert.equal(h.fireTimer(), 2000);
  assert.equal(h.actions.classList.contains("is-idle"), true);
  h.run("revealFloatingControls()");
  assert.equal(h.actions.classList.contains("is-idle"), false);
  const timerId = [...h.timers.keys()][0];
  h.advanceTime(700);
  for (let n = 0; n < 15; n += 1) h.run("revealFloatingControls()");
  assert.deepEqual([...h.timers.keys()], [timerId], "mouse movement reuses the pending idle timer");
  assert.equal(h.fireTimer(), 2000);
  assert.equal(h.actions.classList.contains("is-idle"), false, "the deadline follows the last activity");
  assert.equal(h.fireTimer(), 700);
  assert.equal(h.actions.classList.contains("is-idle"), true);
  h.run("revealFloatingControls()");
  h.run("floatingControlHeld = true");
  assert.equal(h.fireTimer(), 2000);
  assert.equal(h.actions.classList.contains("is-idle"), false, "don't fade during held controls");
  h.run("floatingControlHeld = false");
  assert.equal(h.fireTimer(), 2000);
  assert.equal(h.actions.classList.contains("is-idle"), true);
  h.run("revealFloatingControls()");
  h.run("floatingSeekScrubbing = true");
  h.fireTimer();
  assert.equal(h.actions.classList.contains("is-idle"), false, "seek thumb remains visible while dragging");
  h.run("floatingSeekScrubbing = false");
  h.fireTimer();
  assert.equal(h.actions.classList.contains("is-idle"), true);
  assert.match(css, /\.floating-player-actions\.is-idle \.floating-player-bottom\s*\{[^}]*opacity:0;[^}]*pointer-events:none;/);
  h.run('updateFloatingPlayback("watch")');
  assert.equal(h.timers.size, 0, "no idle timer left after restoring normal Watch");
});

test("floating controls sync icon state and time with the live player without replacing SVGs", () => {
  const h = harness();
  h.run("updateFloatingControls()");
  assert.equal(h.pause.classList.contains("is-playing"), true);
  assert.equal(h.pause["aria-label"], "Pause video");
  assert.equal(h.progress.max, "120");
  assert.equal(h.progress.value, "25");
  assert.equal(h.time.textContent, "00:25 / 02:00");
  h.video.paused = true;
  h.video.muted = true;
  h.run("updateFloatingControls()");
  assert.equal(h.pause.classList.contains("is-playing"), false);
  assert.equal(h.pause["aria-label"], "Play video");
  assert.equal(h.mute.classList.contains("is-muted"), true);
  assert.equal(h.mute["aria-label"], "Unmute");
  h.progress.value = "60";
  h.run("floatingSeekScrubbing = true; updateFloatingControls()");
  assert.equal(h.progress.value, "60", "progress drag should not snap back to playback");
  assert.equal(h.time.textContent, "01:00 / 02:00");
});
