import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { CORE_LIBRARY_FILTERS, CORE_SETTINGS_TABS, CORE_VIEWS, clientFeatureProblems, createClientFeatureHost } from "../frontend/features/feature-host.js";
import { CLIENT_FEATURES } from "../frontend/features/registry.js";
import * as i18n from "../frontend/ui/ui-i18n.js";

const quiet = { error() {} };
const app = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");

// Minimal DOM: enough for the host's createElement/before/after/append calls.
function fakeDocument() {
  const make = (tag) => {
    const node = {
      tag, id: "", className: "", rel: "", href: "", type: "", title: "", textContent: "", innerHTML: "", hidden: false, tabIndex: 0,
      dataset: {}, attributes: {}, children: [], parent: null,
      setAttribute(name, value) { this.attributes[name] = String(value); },
      append(...items) { for (const item of items) { item.parent = this; this.children.push(item); } },
      before(item) { const list = this.parent.children; item.parent = this.parent; list.splice(list.indexOf(this), 0, item); },
      after(item) { const list = this.parent.children; item.parent = this.parent; list.splice(list.indexOf(this) + 1, 0, item); },
    };
    return node;
  };
  const head = make("head");
  const main = make("main");
  const nav = make("nav");
  const navSettings = make("div");
  nav.append(make("button"), navSettings);
  const lastView = make("section");
  lastView.id = "view-settings";
  main.append(lastView);
  const settingsTabs = make("div");
  const settingsMain = make("div");
  const recsPanel = make("div");
  recsPanel.id = "settings-panel-recs";
  settingsMain.append(recsPanel);
  const libraryTabs = make("div");
  const all = () => [...main.children, ...settingsMain.children];
  return {
    head, main, nav, navSettings, settingsTabs, settingsMain, libraryTabs,
    createElement: make,
    querySelector: (selector) => ({
      ".side-nav .nav-settings-actions": navSettings, ".side-nav": nav, "#settings-tabs": settingsTabs,
      "#library-filter": libraryTabs, main,
    })[selector] || null,
    querySelectorAll: (selector) => selector === "section.view" ? main.children.filter((node) => node.tag === "section")
      : selector === '[id^="settings-panel-"]' ? all().filter((node) => node.id.startsWith("settings-panel-")) : [],
  };
}

function readerFeature(calls) {
  return {
    id: "reader",
    styles: ["/frontend/reader/reader.css"],
    translations: { es: { Reader: "Lector", "Seam test string": "Cadena de prueba" } },
    views: [{
      id: "reader", route: "/reader", label: "Reader", nav: { icon: "<svg></svg>" },
      mount: (section) => calls.push(`mount:${section.id}`),
      activate: () => calls.push("activate"),
      deactivate: () => calls.push("deactivate"),
      onKey: (event) => event.key === "ArrowRight",
    }],
    settingsTabs: [{ id: "sources", label: "Sources", render: (panel) => calls.push(`settings:${panel.id}`) }],
    libraryFilters: [{ id: "manga", label: "Manga", render: (list) => { list.innerHTML = "manga list"; } }],
    hooks: {
      "title:render": (payload) => calls.push(`title:${payload.subject}`),
      "storage:render": () => { throw new Error("hook failure must be contained"); },
    },
  };
}

test("the real client feature registry is valid", () => {
  assert.deepEqual(clientFeatureProblems(CLIENT_FEATURES), []);
});

test("client feature validation reports collisions with core and between features", () => {
  const problems = clientFeatureProblems([
    { id: "a1", views: [{ id: "library", route: "/library", label: "X" }] },
    { id: "b1", settingsTabs: [{ id: "storage", render() {} }], libraryFilters: [{ id: "anime", render() {} }] },
    { id: "c1", views: [{ id: "reader", route: "/reader", label: "R" }] },
    { id: "d1", views: [{ id: "reader2", route: "/reader", label: "R" }], hooks: { "watch:render"() {} } },
    { id: "e1", styles: ["//evil.example/x.css"], libraryFilters: [{ id: "books" }] },
  ]);
  for (const expected of [/view "library" is already used/, /route "\/library" is already used/, /tab "storage" is already used/,
    /filter "anime" is already used/, /route "\/reader" is already used/, /unknown hook "watch:render"/, /invalid style/, /needs render\(\)/]) {
    assert.ok(problems.some((message) => expected.test(message)), `missing problem ${expected}: ${problems.join(" | ")}`);
  }
  assert.ok(CORE_VIEWS.includes("title") && CORE_SETTINGS_TABS.includes("recs") && CORE_LIBRARY_FILTERS.includes("all"));
});

test("an invalid feature is dropped and logged while valid ones stay", () => {
  const errors = [];
  const host = createClientFeatureHost([{ id: "bad", views: [{ id: "home", route: "/home", label: "H" }] }, readerFeature([])],
    { log: { error: (...args) => errors.push(args.join(" ")) } });
  assert.deepEqual(host.ids, ["reader"]);
  assert.match(errors.join("\n"), /"bad" ignored/);
});

test("install adds the view, nav button, Settings tab and panel, Library tab, styles and strings", () => {
  const doc = fakeDocument();
  const calls = [];
  const host = createClientFeatureHost([readerFeature(calls)], { log: quiet });
  assert.deepEqual(host.viewRoutes, { reader: "/reader" });
  assert.deepEqual(host.settingsTabIds, ["sources"]);
  assert.deepEqual(host.libraryFilterIds, ["manga"]);
  host.install(doc, { registerTranslations: i18n.registerUiTranslations });
  const section = doc.main.children.find((node) => node.id === "view-reader");
  assert.ok(section && section.className === "view");
  const navButton = doc.nav.children.find((node) => node.dataset.view === "reader");
  assert.ok(navButton, "nav button added");
  assert.ok(doc.nav.children.indexOf(navButton) < doc.nav.children.indexOf(doc.navSettings), "nav button sits before Settings");
  assert.equal(navButton.className, "nav-btn");
  assert.equal(navButton.children.at(-1).attributes["data-i18n"], "READER");
  const tab = doc.settingsTabs.children.find((node) => node.id === "settings-tab-sources");
  assert.equal(tab.attributes.role, "tab");
  assert.equal(tab.attributes["aria-controls"], "settings-panel-sources");
  const panel = doc.settingsMain.children.find((node) => node.id === "settings-panel-sources");
  assert.ok(panel && panel.hidden === true);
  assert.equal(doc.libraryTabs.children[0].dataset.value, "manga");
  assert.equal(doc.head.children[0].href, "/frontend/reader/reader.css");
  assert.equal(i18n.t("Reader", {}, "es"), "Lector");
  assert.equal(i18n.t("READER", {}, "es"), "LECTOR");
  assert.equal(i18n.t("Seam test string", {}, "en"), "Seam test string");
});

test("views mount once, activate and deactivate; keys go only to the active feature view", () => {
  const doc = fakeDocument();
  const calls = [];
  const host = createClientFeatureHost([readerFeature(calls)], { log: quiet });
  host.install(doc, {});
  assert.equal(host.handleKey({ key: "ArrowRight" }), false, "inactive view gets no keys");
  host.showView("reader");
  host.showView("reader");
  assert.equal(host.handleKey({ key: "ArrowRight" }), true);
  assert.equal(host.handleKey({ key: "x" }), false);
  host.showView("home");
  assert.equal(host.handleKey({ key: "ArrowRight" }), false);
  assert.deepEqual(calls, ["mount:view-reader", "activate", "activate", "deactivate"]);
  assert.equal(host.viewLabel("reader"), "Reader");
  assert.equal(host.viewLabel("home"), "");
});

test("Library filters, Settings tabs and hooks route to the owning feature; errors are contained", () => {
  const doc = fakeDocument();
  const calls = [];
  const host = createClientFeatureHost([readerFeature(calls)], { log: quiet });
  host.install(doc, {});
  const list = { innerHTML: "core list" };
  assert.equal(host.showLibraryFilter("series", list), false);
  assert.equal(list.innerHTML, "core list");
  assert.equal(host.showLibraryFilter("manga", list), true);
  assert.equal(list.innerHTML, "manga list");
  assert.equal(host.showSettingsTab("sources", false), false, "hidden Settings view renders nothing");
  assert.equal(host.showSettingsTab("general", true), false);
  assert.equal(host.showSettingsTab("sources", true), true);
  assert.doesNotThrow(() => host.run("storage:render", {}));
  host.run("title:render", { subject: "jjk" });
  assert.deepEqual(calls, ["settings:settings-panel-sources", "title:jjk"]);
});

test("core translations can't be overridden by a feature", () => {
  i18n.registerUiTranslations({ es: { "Show answer": "otra cosa" } });
  assert.equal(i18n.t("Show answer", {}, "es"), "Mostrar respuesta");
});

test("app.js installs features before translating and wires every hook", () => {
  const install = app.indexOf("clientFeatures.install(document,");
  const translate = app.indexOf("installUiI18n({");
  const navBinding = app.indexOf("$$('.nav-btn').forEach((button) => button.addEventListener(");
  assert.ok(install > 0 && install < translate && translate < navBinding, "install → translate → bind nav");
  for (const hook of [
    "...clientFeatures.viewRoutes", "...clientFeatures.settingsTabIds", "...clientFeatures.libraryFilterIds",
    "clientFeatures.showView(view);", "clientFeatures.showLibraryFilter(libraryView.filter, list)",
    'clientFeatures.run("title:render"', 'clientFeatures.run("storage:render"', "clientFeatures.handleKey(event)",
    "clientFeatures.showSettingsTab(settingsView.tab", "clientFeatures.viewLabel(view)",
  ]) assert.ok(app.includes(hook), `app.js keeps the feature hook: ${hook}`);
});
