import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const app = read("app.js");
const html = read("index.html");
const css = read("frontend/styles/styles.css");

function button(id) {
  const markup = html.match(new RegExp(`<button\\b(?=[^>]*\\bid="${id}")[^>]*>`, "i"))?.[0];
  assert.ok(markup, `Expected independently focusable button #${id}`);
  assert.match(markup, /\btype="button"/i);
  return markup;
}

test("sidebar has separate accessible Settings and notifications buttons, with a badge only on the bell", () => {
  const side = html.slice(html.indexOf('<nav class="side-nav"'), html.indexOf("</nav>"));
  assert.ok(side.length > 100);
  const settings = side.match(/<button\b[^>]*data-view="settings"[^>]*>[\s\S]*?<\/button>/)?.[0];
  assert.ok(settings, "Settings remains its own navigation button");
  assert.match(settings, /aria-label="Settings"/);
  const bell = button("sidebar-notifications");
  assert.match(bell, /aria-label="[^"]*[Nn]otification[^"]*"/);
  assert.match(bell, /aria-expanded="false"/);
  assert.match(bell, /aria-controls="app-notifications-popover"/);
  assert.ok(side.includes(bell), "bell shares the sidebar Settings region");
  assert.ok(side.indexOf(bell) > side.indexOf("</button>", side.indexOf('data-view="settings"')),
    "bell is an independent sibling, not a nested target inside Settings");
  assert.match(side, /id="sidebar-notification-count"[^>]*hidden/);
  assert.doesNotMatch(settings, /id="sidebar-notification-count"/, "badge belongs to bell, never Settings");
  // The split is the intentional expanded-navigation ratio, rather than two 50/50 buttons.
  assert.match(css, /\.nav-settings-actions\s*\{[^}]*display:flex/);
  const bellCss = css.match(/\.nav-notification-btn\s*\{([^}]*)\}/)?.[1] || "";
  assert.match(bellCss, /flex:0 0 40px/);
  assert.match(css, /\.nav-settings-actions \.nav-btn\[data-view="settings"\]\s*\{[^}]*flex:1 1 auto/);
  assert.match(html, /id="app-notifications-popover"[^>]*role="region"[^>]*aria-label="Notifications"[^>]*hidden/);
  button("app-notifications-close");
  button("app-notifications-settings");
});

test("Settings has independent Updates and Notifications tabs with linked tabpanels", () => {
  for (const name of ["updates", "notifications"]) {
    const tab = button(`settings-tab-${name}`);
    assert.match(tab, /role="tab"/);
    assert.match(tab, new RegExp(`aria-controls="settings-panel-${name}"`));
    const panel = html.match(new RegExp(`<[^>]+id="settings-panel-${name}"[^>]*>`))?.[0];
    assert.ok(panel, `Expected panel for ${name}`);
    assert.match(panel, /role="tabpanel"/);
    assert.match(panel, new RegExp(`aria-labelledby="settings-tab-${name}"`));
  }
  assert.ok(/SETTINGS_TABS\s*=\s*\[[^\]]*"updates"[^\]]*"notifications"/.test(app),
    "both Updates and Notifications must be independently navigable Settings views");
});

test("notification popup is solid black and Notification settings show only heading and toggle label", () => {
  const panel = html.slice(html.indexOf('id="settings-panel-notifications"'),
    html.indexOf('id="settings-panel-recs"'));
  assert.match(panel, /<h2 id="settings-notification-title">Notifications<\/h2>/);
  assert.match(panel, /id="settings-notification-update-alerts"[^>]*type="checkbox"/);
  assert.match(panel, /<strong>New version notifications<\/strong>/);
  assert.doesNotMatch(panel, /id="settings-notification-count"|id="settings-notification-status"|id="settings-notification-pending"|<small\b|0 pending|Only app update notifications|Notify when an LVL update/,
    "no counts, explanatory copy or pending notices in Settings");
  const popoverCss = css.match(/\.app-notifications-popover\s*\{([^}]*)\}/)?.[1] || "";
  assert.match(popoverCss, /background:#000(?:;|\s)/, "solid black popover surface");
  assert.match(css, /\.app-notifications-list\s*\{[^}]*background:#000/);
  assert.match(css, /\.app-notifications-settings\s*\{[^}]*background:#000/);
});

test("notifications expose an accessible closeable changelog dialog, never an external browser redirect", () => {
  const dialogs = [...html.matchAll(/<dialog\b[^>]*>/g)].map(([tag]) => tag);
  assert.ok(dialogs.some((tag) => /changelog/i.test(tag) && /aria-labelledby=/.test(tag)),
    "the full changelog opens in a labeled app dialog");
  assert.match(html, /<button\b[^>]*aria-label="Close [^"]*(?:[Cc]hange|[Rr]elease)[^"]*"/);
});

test("LVL has clean release identity while changelog may evolve in Git", () => {
  const changelog = read("CHANGELOG.md");
  assert.ok(typeof changelog === "string", "release history is source-owned, not remote-fetched on every check");
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.name, "lvl");
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/, "versioned releases must be plain semantic versions");
  assert.ok(/url\.pathname === "\/api\/app-updates\/changelog"/.test(read("server.js")),
    "the installed app must expose its bundled history to the local UI");
});

test("manual Check only discovers updates; Install is a distinct explicit action", async () => {
  const start = app.indexOf("function wireAppUpdateSettings() {");
  const end = app.indexOf("\nwireAppUpdateSettings();", start);
  assert.ok(start > 0 && end > start, "real Updates handler must remain testable");
  const requests = [];
  const statuses = [];
  const elements = new Map();
  for (const name of ["settings-app-updates-check", "settings-app-updates-install"]) {
    const listeners = {};
    elements.set(name, {
      addEventListener(event, callback) { listeners[event] = callback; },
      click() { return listeners.click(); },
    });
  }
  const vmContext = {
    $: (selector) => elements.get(selector.slice(1)) || null,
    appUpdateSettingsBusy: false, manualAppUpdateCheck: false,
    appUpdateSettingsSnapshot: { installed: true, available: true, availableVersion: "0.1.11", automatic: false },
    postJson: async (url, body) => { requests.push({ url, body }); return vmContext.appUpdateSettingsSnapshot; },
    paintAppUpdateSettings: () => {},
    setToolStatus: (...args) => statuses.push(args),
    settingsView: { tab: "updates" },
    setInterval: () => {},
  };
  vm.runInNewContext(app.slice(start, end) + "\nwireAppUpdateSettings();", vmContext);
  await elements.get("settings-app-updates-check").click();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/app-updates/check");
  assert.equal(requests[0].body.apply, false, "checking may not implicitly approve installation");
  assert.equal(vmContext.manualAppUpdateCheck, true);
  await elements.get("settings-app-updates-install").click();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].url, "/api/app-updates/install");
  assert.equal(Object.keys(requests[1].body).length, 0);
  assert.match(statuses.at(-1)[1], /Incremental updates apply without a setup wizard/i);
});

function clientFixture({ stored = {}, changelog = { entries: [] } } = {}) {
  const storage = new Map(Object.entries(stored));
  const nodes = new Map();
  const documentListeners = {};
  const requests = [];
  const navigations = [];
  let focus = null;
  function createNode(tag = "div") {
    const listeners = {};
    const attributes = {};
    const node = {
      tagName: tag.toUpperCase(), textContent: "", hidden: true, checked: false, open: false,
      style: {}, children: [], attributes,
      append(...items) { this.children.push(...items); },
      replaceChildren(...items) { this.children = items; },
      addEventListener(type, callback) { listeners[type] = callback; },
      setAttribute(name, value) { attributes[name] = String(value); },
      getAttribute(name) { return attributes[name] ?? null; },
      getBoundingClientRect() { return { top: 280, right: 230 }; },
      focus() { focus = this; },
      showModal() { this.open = true; },
      close() { this.open = false; },
      click() { return listeners.click?.({ target: this }); },
      change() { return listeners.change?.({ target: this }); },
      toggle() { return listeners.toggle?.({ target: this }); },
    };
    return node;
  }
  const ids = ["settings-notification-update-alerts", "sidebar-notification-count", "sidebar-notifications",
    "app-notifications-list", "app-notifications-popover", "app-notifications-close",
    "app-notifications-settings", "app-changelog-dialog", "app-changelog-history",
    "app-changelog-intro", "app-changelog-close", "settings-app-updates-changelog-details",
    "settings-app-updates-changelog-inline"];
  for (const id of ids) nodes.set(id, createNode(id === "app-changelog-dialog" ? "dialog" : "button"));
  const context = vm.createContext({
    $: (selector) => nodes.get(selector.slice(1)) ?? null,
    document: {
      createElement: createNode,
      addEventListener(event, callback) { documentListeners[event] = callback; },
    },
    window: { innerWidth: 1024, innerHeight: 768 },
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
    },
    settingsView: { tab: "general" },
    renderSettingsTabs() {},
    switchView: (route) => navigations.push(route),
    refreshAppUpdateSettings: async () => {},
    appUpdateSettingsSnapshot: null,
    paintAppUpdateSettings: (report) => {
      context.appUpdateSettingsSnapshot = report;
      context.__report = report;
      vm.runInContext("paintUpdateNotifications(__report)", context);
    },
    postJson: async (url, body) => { requests.push({ url, body }); return { ...context.appUpdateSettingsSnapshot }; },
    fetchJson: async (url) => {
      requests.push({ url, method: "GET" });
      assert.equal(url, "/api/app-updates/changelog");
      return changelog;
    },
    setInterval() {},
    console: { warn() {} },
    Date,
  });
  const start = app.indexOf("// Update notifications are deliberately scoped");
  const end = app.indexOf("\nfunction formatStorage(", start);
  assert.ok(start >= 0 && end > start, "notification state/wiring source seam available");
  vm.runInContext(app.slice(start, end), context);
  return {
    node: (id) => nodes.get(id),
    storage, requests, navigations,
    get focused() { return focus; },
    paint: (report) => {
      context.appUpdateSettingsSnapshot = report;
      context.__report = report;
      vm.runInContext("paintUpdateNotifications(__report)", context);
    },
    run: (script) => vm.runInContext(script, context),
    keydown: (key) => {
      let prevented = false;
      documentListeners.keydown?.({ key, preventDefault() { prevented = true; } });
      return prevented;
    },
  };
}

test("notification badge and rows are derived only from a real installed pending update", () => {
  const f = clientFixture();
  const badge = f.node("sidebar-notification-count");
  for (const report of [
    null,
    { installed: false, available: true, availableVersion: "0.3.0" },
    { installed: true, available: false, availableVersion: "0.3.0" },
    { installed: true, available: true, availableVersion: "" },
    { installed: true, checking: true, available: false },
  ]) {
    f.paint(report);
    assert.equal(badge.hidden, true, "no badge for source mode, stale data, or unfinished checks");
    assert.equal(f.node("app-notifications-list").children[0]?.textContent, "No notifications");
  }
  f.paint({ installed: true, available: true, availableVersion: "0.2.5", automatic: true });
  assert.equal(badge.hidden, false);
  assert.equal(badge.textContent, "1");
  assert.match(f.node("sidebar-notifications").getAttribute("aria-label"), /1 app update available/);
  assert.equal(f.node("app-notifications-list").children.length, 1);
  assert.equal(f.node("app-notifications-list").children[0].tagName, "BUTTON", "a pending update remains accessible from the bell");
  assert.match(f.node("app-notifications-list").children[0].children[0].textContent, /LVL 0\.2\.5 available/);

  const toggle = f.node("settings-notification-update-alerts");
  toggle.checked = false;
  toggle.change();
  assert.equal(f.storage.get("lvl-available-update-notifications-v1"), "0");
  assert.equal(badge.hidden, true);
  assert.equal(f.node("app-notifications-list").children[0]?.textContent, "Notifications disabled");
  assert.equal(f.requests.filter((item) => item.url === "/api/app-updates/install").length, 0);
});

test("bell opens keyboard accessible pending notices, update notice opens full changelog modal", async () => {
  const server = read("server.js");
  const start = server.indexOf("function parseLocalChangelog(");
  const end = server.indexOf("\nfunction localChangelogEndpoint(", start);
  assert.ok(start >= 0 && end > start);
  const parse = vm.runInNewContext(server.slice(start, end) + "\nparseLocalChangelog");
  const history = parse(read("CHANGELOG.md"));
  const names = Array.from(history.entries, (entry) => entry.version || "Unreleased");
  assert.deepEqual(names, ["0.1.11", "0.1.1", "0.1.0"], "bundled release history lists the newest supported version first");

  const f = clientFixture({ changelog: history });
  f.paint({ installed: true, available: true, availableVersion: "0.2.5", automatic: true });
  const bell = f.node("sidebar-notifications");
  bell.click();
  assert.equal(f.node("app-notifications-popover").hidden, false);
  assert.equal(bell.getAttribute("aria-expanded"), "true");
  assert.equal(f.focused, f.node("app-notifications-popover"));
  assert.equal(f.keydown("Escape"), true, "Escape dismisses the popover");
  assert.equal(f.node("app-notifications-popover").hidden, true);
  assert.equal(bell.getAttribute("aria-expanded"), "false");
  assert.equal(f.focused, bell, "Escape restores keyboard focus to the bell");

  bell.click();
  const action = f.node("app-notifications-list").children[0];
  action.click();
  await new Promise((resolve) => setImmediate(resolve));
  const dialog = f.node("app-changelog-dialog");
  assert.equal(dialog.open, true);
  assert.equal(f.node("app-notifications-popover").hidden, true);
  const sections = f.node("app-changelog-history").children;
  assert.equal(sections.length, 3, "full release history is available in the dialog");
  assert.match(sections[0].children[0].textContent, /0\.1\.11/);
  assert.match(sections[1].children[0].textContent, /0\.1\.1/);
  assert.match(sections[2].children[0].textContent, /0\.1\.0/);
  assert.deepEqual(f.requests.filter((item) => item.method === "GET").map(({ url }) => url),
    ["/api/app-updates/changelog"], "read only bundled local release history");
  f.node("app-changelog-close").click();
  assert.equal(dialog.open, false, "close action dismisses the modal");
  assert.equal(f.requests.filter((item) => item.url === "/api/app-updates/install").length, 0,
    "opening release notes cannot trigger native installation");
  bell.click();
  f.node("app-notifications-settings").click();
  assert.equal(f.run("settingsView.tab"), "notifications", "bell shortcut selects Notifications, not Updates");
  assert.deepEqual(f.navigations, ["settings"]);
  assert.equal(f.node("app-notifications-popover").hidden, true);
});

test("notification-only checks are rate limited, and disabled alerts perform zero background checks", async () => {
  const f = clientFixture({ stored: { "lvl-available-update-notifications-v1": "0" } });
  const base = { installed: true, automatic: false, available: false, checking: false, downloading: false };
  f.paint(base);
  f.run("maybeCheckForUpdateNotifications(appUpdateSettingsSnapshot)");
  assert.equal(f.requests.length, 0, "disabled notices must never trigger an update check");
  f.node("settings-notification-update-alerts").checked = true;
  f.node("settings-notification-update-alerts").change();
  f.run("maybeCheckForUpdateNotifications(appUpdateSettingsSnapshot)");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.requests.filter((request) => request.url === "/api/app-updates/check").length, 1);
  const check = f.requests.find((request) => request.url === "/api/app-updates/check").body;
  assert.equal(check.apply, false, "notification-only checks must never authorize patch installation");
  assert.deepEqual(Object.keys(check), ["apply"], "notification-only requests carry no other commands");
  f.run("maybeCheckForUpdateNotifications(appUpdateSettingsSnapshot)");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.requests.filter((entry) => entry.url === "/api/app-updates/check").length, 1,
    "reopening Settings cannot initiate repeat update checks within the same day");
});

test("Updates Changelog renders same local history as notification modal", async () => {
  const server = read("server.js");
  const start = server.indexOf("function parseLocalChangelog(");
  const end = server.indexOf("\nfunction localChangelogEndpoint(", start);
  const parse = vm.runInNewContext(server.slice(start, end) + "\nparseLocalChangelog");
  const changelog = parse(read("CHANGELOG.md"));
  const f = clientFixture({ changelog });
  const details = f.node("settings-app-updates-changelog-details");
  details.open = true;
  details.toggle();
  await new Promise((resolve) => setImmediate(resolve));
  const inline = f.node("settings-app-updates-changelog-inline");
  assert.equal(inline.children.length, 3, "Updates settings displays all versioned release entries");
  f.run("void openUpdateChangelog()");
  await new Promise((resolve) => setImmediate(resolve));
  const modal = f.node("app-changelog-history");
  assert.deepEqual(inline.children.map((section) => section.children[0]?.textContent ?? section.textContent),
    modal.children.map((section) => section.children[0]?.textContent ?? section.textContent),
    "both UI surfaces must render the same newest-first changelog from the installed file");
  assert.deepEqual(f.requests.filter((entry) => entry.method === "GET").map((entry) => entry.url),
    ["/api/app-updates/changelog"], "only the bundled local changelog should be requested");
});
