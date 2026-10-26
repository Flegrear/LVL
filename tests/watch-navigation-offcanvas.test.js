import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../frontend/styles/styles.css", import.meta.url), "utf8");
const uiCss = readFileSync(new URL("../frontend/styles/ui.css", import.meta.url), "utf8");

test("Home tabs, hero copy and shelf cards share the compact page gutter instead of the old 48px inset", () => {
  assert.match(uiCss, /--ui-gutter: clamp\(16px, 3\.4vw, 48px\)/, "UI default inset explains the old desktop gap");
  assert.match(css, /\.app-main\s*\{[^}]*--app-gutter:clamp\(12px,1\.3vw,20px\);\s*--ui-gutter:var\(--app-gutter\);/, "App must override UI inset for every view");
  assert.match(uiCss, /\.ui-topbar\s*\{[^}]*padding: 0 var\(--ui-gutter\)/);
  assert.match(uiCss, /\.ui-hero__content\s*\{[^}]*left: var\(--ui-gutter\)/);
  assert.match(uiCss, /\.ui-shelf__head\s*\{[^}]*margin: 0 var\(--ui-gutter\)/);
  assert.match(uiCss, /\.ui-shelf__track\s*\{[^}]*padding: 6px var\(--ui-gutter\)/);
  assert.match(css, /@media \(max-width: 680px\)[\s\S]*?\.app-main\s*\{\s*--app-gutter:10px; --ui-gutter:16px;/, "Mobile keeps the established 16px inset");
});

test("Shared hamburger lives inside the topbar before Home and Watch, not in a floating Watch control", () => {
  const main = html.indexOf('<main class="app-main">');
  const topbar = html.indexOf('<header id="home-topbar" class="ui-topbar home-topbar app-topbar">');
  const launcher = html.indexOf('id="app-sidebar-toggle"');
  const endTopbar = html.indexOf("</header>", topbar);
  const home = html.indexOf('<section id="view-home"');
  const watch = html.indexOf('<section id="view-watch"');
  assert.ok(main >= 0 && main < topbar && topbar < launcher && launcher < endTopbar);
  assert.ok(endTopbar < home && home < watch, "The same toolbar is available on every view");
  assert.equal((html.match(/id="app-sidebar-toggle"/g) || []).length, 1);
  assert.doesNotMatch(html, /id="watch-sidebar-toggle"/, "Watch must not have a separate floating launcher");
});

test("Desktop navigation overlays a full-width shell, including Watch theater mode", () => {
  assert.match(css, /\.app-shell,\s*\.app-shell\.sidebar-expanded\s*\{[^}]*display:block;\s*width:100%;/);
  assert.doesNotMatch(css, /\.app-shell(?:\.sidebar-expanded)?\s*\{[^}]*grid-template-columns:/, "The old sidebar grid track must not return");
  assert.match(css, /\.app-sidebar\s*\{[^}]*position:fixed;[^}]*transform:translateX\(-100%\);[^}]*visibility:hidden/);
  assert.match(css, /\.sidebar-expanded \.app-sidebar\s*\{[^}]*transform:translateX\(0\);[^}]*visibility:visible/);
  assert.match(css, /\.app-shell\.sidebar-expanded::before\s*\{[^}]*position:fixed;[^}]*z-index:35/);
  assert.match(css, /\.watch-player-layout\.has-chapters\.is-theater\s*\{\s*grid-template-columns:minmax\(0,1fr\);/);
  assert.doesNotMatch(css, /\.watch-sidebar-toggle/, "A floating hamburger must not return");
});

function setup({ watch = true, home = true, width = 1280 } = {}) {
  const from = app.indexOf("function setSidebarExpanded(");
  const until = app.indexOf('\nframe.addEventListener("pointerenter"', from);
  assert.ok(from >= 0 && until > from, "The real shared navigation handlers can be evaluated");
  const state = { expanded: false, watch, home, width, focus: null, saved: [], events: {}, navigated: [] };
  const node = (name) => ({
    name, listeners: {}, attributes: {},
    setAttribute(key, value) { this.attributes[key] = value; },
    addEventListener(event, handler) { this.listeners[event] = handler; },
    focus() { state.focus = name; },
  });
  const normal = node("drawer hamburger");
  const launcher = node("shared topbar hamburger");
  const sectionLauncher = node("section topbar hamburger");
  const homeButton = node("LVL topbar logo");
  const side = node("side nav");
  const shell = node("shell");
  shell.classList = {
    contains: (name) => name === "sidebar-expanded" && state.expanded,
    toggle: (name, value) => { assert.equal(name, "sidebar-expanded"); state.expanded = value; },
  };
  const elements = { ".app-shell": shell, ".app-sidebar": side, "#sidebar-toggle": normal,
    "#app-sidebar-toggle": launcher, "#section-sidebar-toggle": sectionLauncher,
    "#section-home-button": homeButton,
    "#view-home": { classList: { contains: () => state.home } } };
  const win = { innerWidth: width, addEventListener(event, listener) { state.events[`window:${event}`] = listener; } };
  const document = { addEventListener(event, listener) { state.events[`document:${event}`] = listener; } };
  const localStorage = { setItem(key, value) { state.saved.push([key, value]); } };
  const context = vm.createContext({
    $, window: win, document, localStorage, persistPreferences: () => {},
    t: (label) => label, viewActive: (view) => view === "watch" && state.watch,
    switchView: (view) => state.navigated.push(view),
    closeUpdateNotificationPopover() { state.notificationPopoverClosed = true; },
  });
  function $(selector) { assert.ok(elements[selector], `Known selector: ${selector}`); return elements[selector]; }
  vm.runInContext(app.slice(from, until), context);
  return { state, shell, side, normal, launcher, sectionLauncher, homeButton, win, context };
}

function click(node, shell = null) {
  const target = { closest: (selector) =>
    (selector.includes("#app-sidebar-toggle") && node.name === "shared topbar hamburger")
    || (selector.includes("#section-sidebar-toggle") && node.name === "section topbar hamburger") ? node : null };
  const event = { preventDefault() {}, target };
  node.listeners.click(event);
  // Simulate the DOM click bubbling through .app-shell. This caught the bug
  // where opening the off-canvas drawer instantly dismissed it on the SAME click.
  shell?.listeners.click(event);
}

test("Topbar hamburger opens shared overlay and the drawer button restores header focus", () => {
  const { state, normal, launcher, shell } = setup();
  assert.equal(state.expanded, false);
  click(launcher, shell);
  assert.equal(state.expanded, true);
  assert.equal(state.focus, "drawer hamburger");
  assert.equal(normal.attributes["aria-expanded"], "true");
  assert.equal(launcher.attributes["aria-expanded"], "true");
  assert.equal(launcher.attributes["aria-label"], "Collapse navigation");
  click(normal);
  assert.equal(state.expanded, false);
  assert.equal(state.focus, "shared topbar hamburger");
  assert.equal(normal.attributes["aria-expanded"], "false");
  assert.equal(launcher.attributes["aria-label"], "Expand navigation");
  assert.deepEqual(state.saved, [], "Opening and closing the drawer must not persist across refreshes");
});

test("Clicking the section LVL logo invokes the existing Home navigation", () => {
  const bar = html.slice(html.indexOf('id="section-topbar"'), html.indexOf("</header>", html.indexOf('id="section-topbar"')));
  assert.match(bar, /<button id="section-home-button"[^>]*type="button"[^>]*aria-label="Home"/);
  assert.match(bar, /<button id="section-home-button"[\s\S]*?<img id="section-view-icon"[^>]*src="\/brand\/lvl_app_icon_dark\.svg" width="42" height="42"[^>]*\/>\s*<\/button>/);
  assert.ok(bar.indexOf('id="section-sidebar-toggle"') < bar.indexOf('id="section-home-button"'));
  assert.match(css, /\.section-home-button:focus-visible\s*\{\s*outline:2px solid #fff;/);
  const { state, homeButton, sectionLauncher } = setup({ watch: true, home: false });
  click(homeButton);
  assert.deepEqual(state.navigated, ["home"], "Watch navigation must use switchView, which cancels hidden pending loads");
  click(sectionLauncher);
  assert.equal(state.expanded, true, "hamburger still opens navigation independently");
});

test("refresh and SQLite hydration never reopen the previous drawer", () => {
  assert.doesNotMatch(app, /localStorage\.getItem\("blackline-sidebar-expanded"\)/);
  assert.doesNotMatch(app, /localStorage\.setItem\("blackline-sidebar-expanded"/);
  assert.doesNotMatch(app, /sidebarExpanded:\s*localStorage/);
  assert.doesNotMatch(app, /setSidebarExpanded\([^)]*prefs\.sidebarExpanded/);
  assert.match(app, /setSidebarExpanded\(false\);\s*applySubtitleStyle\(\);\s*renderAll\(\);/);
  const { state, launcher, shell } = setup();
  click(launcher, shell);
  assert.equal(state.expanded, true);
  // A fresh app instance starts with no saved expansion, regardless of the
  // state of the earlier instance or a legacy SQLite preferences field.
  assert.equal(setup().state.expanded, false);
  assert.deepEqual(state.saved, []);
});

test("Escape and scrim dismiss the drawer without hitting page or video controls", () => {
  const { state, launcher, shell } = setup();
  click(launcher, shell);
  state.events["document:keydown"]({ key: "Escape" });
  assert.equal(state.expanded, false);
  assert.equal(state.focus, "shared topbar hamburger");
  click(launcher, shell);
  shell.listeners.click({ target: { closest: () => null } });
  assert.equal(state.expanded, false, "Overlay scrim click closes the drawer");
});

test("The same hamburger opens and closes the overlay outside Watch; mobile remains horizontal", () => {
  const other = setup({ watch: false, home: false });
  click(other.sectionLauncher, other.shell);
  assert.equal(other.state.expanded, true);
  assert.equal(other.sectionLauncher.attributes["aria-expanded"], "true");
  other.shell.listeners.click({ target: { closest: () => null } });
  assert.equal(other.state.expanded, false, "Every desktop view dismisses on outside click");

  click(other.sectionLauncher, other.shell);
  other.state.events["document:keydown"]({ key: "Escape" });
  assert.equal(other.state.focus, "section topbar hamburger", "Escape returns focus to the visible section launcher");
  click(other.sectionLauncher, other.shell);
  click(other.normal);
  assert.equal(other.state.focus, "section topbar hamburger", "Closing the drawer restores section launcher focus");

  const mobile = setup({ width: 480 });
  click(mobile.launcher);
  assert.equal(mobile.state.expanded, false, "No off-canvas overlay on narrow/mobile views");
  assert.equal(mobile.normal.attributes["aria-expanded"], "false");
});
