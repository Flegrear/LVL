import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../frontend/styles/styles.css", import.meta.url), "utf8");

function trailerCode() {
  const start = app.indexOf("function openTitleTrailer(");
  const end = app.indexOf("\n// The first chapter", start);
  assert.ok(start > 0 && end > start);
  return app.slice(start, end);
}

test("Trailer hero keeps external fallback when native dialogs are unavailable", () => {
  const code = trailerCode();
  const ctx = vm.createContext({ HTMLDialogElement: undefined });
  vm.runInContext(code, ctx);
  assert.equal(ctx.openTitleTrailer("bad", "https://www.youtube.com/watch?v=bad"), false);
  assert.equal(ctx.openTitleTrailer("abcdef12345", "https://www.youtube.com/watch?v=abcdef12345"), false,
    "Browsers without native modal support keep the regular YouTube link");
  assert.match(code, /youtube-nocookie\.com\/embed\//);
  assert.match(code, /dialog\.showModal\(\)/);
  assert.match(code, /frame\.removeAttribute\("src"\)/, "closing should stop trailer playback");
  assert.match(app, /title-trailer" data-trailer-id=[\s\S]*?target="_blank" rel="noopener noreferrer"/,
    "original hero link still opens on YouTube when native dialog is unsupported");
  assert.match(app, /openTitleTrailer\(trailer\.dataset\.trailerId, trailer\.href\)/);
});

test("Trailer modal has larger plain X outside YouTube picture with no redundant heading or footer", () => {
  const code = trailerCode();
  class Element {
    constructor(tagName) {
      this.tagName = tagName;
      this.children = [];
      this.attributes = {};
      this.listeners = new Map();
      this.open = false;
    }
    setAttribute(name, value) { this.attributes[name] = value; }
    removeAttribute(name) { delete this[name]; delete this.attributes[name]; }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    append(...nodes) { this.children.push(...nodes); }
    querySelector(selector) {
      return this.children.find((node) => selector === "." + node.className) || null;
    }
    dispatch(name, event) { this.listeners.get(name)?.(event); }
    focus() { this.focused = true; }
    showModal() { this.open = true; }
    close() { this.open = false; this.dispatch("close", { target: this }); }
  }
  const body = new Element("body");
  const document = { body, createElement: (name) => new Element(name) };
  const ctx = vm.createContext({
    HTMLDialogElement: class HTMLDialogElement {},
    document,
    $: () => body.children.find((node) => node.id === "title-trailer-dialog") || null,
  });
  vm.runInContext(code, ctx);
  assert.equal(ctx.openTitleTrailer("abcdef12345", "https://www.youtube.com/watch?v=abcdef12345"), true);
  const dialog = body.children[0];
  assert.equal(dialog.attributes["aria-label"], "Trailer video");
  assert.equal(dialog.children.length, 2, "only iframe and overlay close button remain");
  const [frame, close] = dialog.children;
  assert.equal(frame.tagName, "iframe");
  assert.equal(frame.src, "https://www.youtube-nocookie.com/embed/abcdef12345?autoplay=1&rel=0");
  assert.equal(frame.allowFullscreen, true);
  assert.equal(close.tagName, "button");
  assert.equal(close.textContent, "×");
  assert.equal(close.attributes["aria-label"], "Close trailer");
  assert.equal(close.title, "Close trailer");
  assert.equal(close.focused, true, "keyboard focus begins on the dialog's close control rather than YouTube iframe");
  close.dispatch("click", { target: close });
  assert.equal(dialog.open, false);
  assert.equal(frame.src, undefined, "closing removes the iframe URL to stop playback");
  assert.equal(ctx.openTitleTrailer("abcdefghijk", "https://www.youtube.com/watch?v=abcdefghijk"), true);
  assert.equal(body.children.length, 1, "reopening reuses the same modal");
  dialog.dispatch("click", { target: dialog });
  assert.equal(dialog.open, false, "backdrop click closes the dialog");
  assert.equal(frame.src, undefined);
  assert.match(code, /document\.createElement\("dialog"\)/, "native dialog retains built-in Escape handling");
  assert.doesNotMatch(code, /Watch on YouTube|label\.textContent = "Trailer"|close\.textContent = "Close"/);
  assert.match(css, /\.title-trailer-dialog\s*\{[^}]*overflow:visible; padding:44px 0 0; border:0;[^}]*background:transparent;/);
  assert.match(css, /\.title-trailer-dialog__frame\s*\{[^}]*border:0;[^}]*border-radius:0;/);
  assert.match(css, /\.title-trailer-dialog__close\s*\{[^}]*position:absolute;[^}]*z-index:2;[^}]*top:0; right:0;/);
  assert.match(css, /\.title-trailer-dialog__close\s*\{[^}]*border:0; border-radius:0; background:transparent;[^}]*font:400 40px/);
  assert.match(css, /\.title-trailer-dialog__close:focus-visible\s*\{[^}]*outline:2px/);
});
