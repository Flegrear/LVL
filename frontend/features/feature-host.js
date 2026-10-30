// Browser extension seam. Features that live on their own lane (roadmap Part B:
// reader, franchises, reading sources) register in ./registry.js instead of
// editing index.html and app.js. app.js asks this host for extra views, nav
// buttons, Settings tabs, Library filters, styles, translations, keyboard
// handling and render hooks. A failing feature is logged and skipped; it never
// breaks core rendering.
//
// A feature module exports a plain object and has no side effects at import:
//   {
//     id: "reader",
//     styles: ["/frontend/reader/reader.css"],
//     translations: { es: { Reader: "Lector" } },
//     views: [{ id: "reader", route: "/reader", label: "Reader", nav: { icon: "<svg …/>" },
//               mount(section, ctx) {}, activate(section, ctx) {}, deactivate(section, ctx) {}, onKey(event, ctx) {} }],
//     settingsTabs: [{ id: "sources", label: "Sources", render(panel, ctx) {} }],
//     libraryFilters: [{ id: "manga", label: "Manga", render(list, ctx) {} }],
//     hooks: { "title:render"(payload, ctx) {}, "storage:render"(payload, ctx) {} },
//   }
// Each view route also needs a server page route (backend/features registry
// asset that serves index.html) so reloading the page works.

export const CORE_VIEWS = Object.freeze(["home", "watch", "library", "calendar", "study", "review", "test", "settings", "title"]);
export const CORE_ROUTES = Object.freeze(["/", "/home", "/watch", "/library", "/calendar", "/study", "/review", "/test", "/tests", "/settings", "/title", "/components"]);
export const CORE_SETTINGS_TABS = Object.freeze(["general", "coach", "library", "storage", "updates", "notifications", "recs"]);
export const CORE_LIBRARY_FILTERS = Object.freeze(["all", "series", "movie", "anime"]);
export const CLIENT_HOOKS = Object.freeze(["title:render", "storage:render"]);

const ID = /^[a-z][a-z0-9-]{1,31}$/;
const ROUTE = /^\/[a-z][a-z0-9-]*$/;

function problem(list, message) {
  list.push(message);
}

// Returns a list of problems; empty means valid. Tests call this with the real registry.
export function clientFeatureProblems(features) {
  const problems = [];
  if (!Array.isArray(features)) return ["CLIENT_FEATURES must be an array"];
  const taken = {
    feature: new Set(),
    view: new Set(CORE_VIEWS),
    route: new Set(CORE_ROUTES),
    tab: new Set(CORE_SETTINGS_TABS),
    filter: new Set(CORE_LIBRARY_FILTERS),
  };
  const claim = (kind, value, owner) => {
    if (taken[kind].has(value)) problem(problems, `${owner}: ${kind} "${value}" is already used`);
    taken[kind].add(value);
  };
  for (const feature of features) {
    const owner = `feature ${JSON.stringify(feature?.id)}`;
    if (typeof feature?.id !== "string" || !ID.test(feature.id)) { problem(problems, `${owner}: invalid id`); continue; }
    claim("feature", feature.id, owner);
    for (const href of feature.styles || []) {
      if (typeof href !== "string" || !href.startsWith("/") || href.includes("..") || href.startsWith("//")) problem(problems, `${owner}: invalid style ${JSON.stringify(href)}`);
    }
    if (feature.translations !== undefined && (typeof feature.translations !== "object" || !feature.translations)) problem(problems, `${owner}: translations must be an object`);
    for (const view of feature.views || []) {
      if (typeof view?.id !== "string" || !ID.test(view.id)) { problem(problems, `${owner}: invalid view id ${JSON.stringify(view?.id)}`); continue; }
      claim("view", view.id, owner);
      if (typeof view.route !== "string" || !ROUTE.test(view.route)) problem(problems, `${owner}: view "${view.id}" has an invalid route ${JSON.stringify(view.route)}`);
      else claim("route", view.route, owner);
      if (typeof view.label !== "string" || !view.label) problem(problems, `${owner}: view "${view.id}" needs a label`);
    }
    for (const tab of feature.settingsTabs || []) {
      if (typeof tab?.id !== "string" || !ID.test(tab.id)) { problem(problems, `${owner}: invalid Settings tab id ${JSON.stringify(tab?.id)}`); continue; }
      claim("tab", tab.id, owner);
      if (typeof tab.render !== "function") problem(problems, `${owner}: Settings tab "${tab.id}" needs render()`);
    }
    for (const filter of feature.libraryFilters || []) {
      if (typeof filter?.id !== "string" || !ID.test(filter.id)) { problem(problems, `${owner}: invalid Library filter id ${JSON.stringify(filter?.id)}`); continue; }
      claim("filter", filter.id, owner);
      if (typeof filter.render !== "function") problem(problems, `${owner}: Library filter "${filter.id}" needs render()`);
    }
    for (const hook of Object.keys(feature.hooks || {})) {
      if (!CLIENT_HOOKS.includes(hook)) problem(problems, `${owner}: unknown hook "${hook}"`);
    }
  }
  return problems;
}

function guarded(log, label, fn, fallback) {
  try {
    return fn();
  } catch (error) {
    log.error?.(`Feature ${label} failed:`, error);
    return fallback;
  }
}

export function createClientFeatureHost(features = [], { log = console } = {}) {
  // Drop invalid features one by one so a single mistake can't take down the app.
  const accepted = [];
  for (const feature of Array.isArray(features) ? features : []) {
    const problems = clientFeatureProblems([...accepted, feature]);
    if (problems.length) log.error?.(`Feature ${JSON.stringify(feature?.id)} ignored:`, problems.join("; "));
    else accepted.push(feature);
  }
  const views = accepted.flatMap((feature) => (feature.views || []).map((view) => ({ view, feature })));
  const tabs = accepted.flatMap((feature) => (feature.settingsTabs || []).map((tab) => ({ tab, feature })));
  const filters = accepted.flatMap((feature) => (feature.libraryFilters || []).map((filter) => ({ filter, feature })));
  const sections = new Map();
  const panels = new Map();
  const mounted = new Set();
  let ctx = {};
  let activeView = "";

  function install(doc, context = {}) {
    ctx = context;
    if (!doc) return;
    for (const feature of accepted) {
      if (feature.translations) guarded(log, `${feature.id} translations`, () => context.registerTranslations?.(feature.translations));
      for (const href of feature.styles || []) {
        const link = doc.createElement("link");
        link.rel = "stylesheet";
        link.href = href;
        link.dataset.feature = feature.id;
        doc.head?.append(link);
      }
    }
    const lastView = [...doc.querySelectorAll("section.view")].pop();
    const navAnchor = doc.querySelector(".side-nav .nav-settings-actions");
    const nav = doc.querySelector(".side-nav");
    let insertAfter = lastView;
    for (const { view, feature } of views) {
      const section = doc.createElement("section");
      section.id = `view-${view.id}`;
      section.className = "view";
      section.dataset.feature = feature.id;
      section.setAttribute("aria-label", view.label);
      if (insertAfter) insertAfter.after(section);
      else doc.querySelector("main")?.append(section);
      insertAfter = section;
      sections.set(view.id, section);
      if (view.nav === false || !nav) continue;
      const button = doc.createElement("button");
      button.type = "button";
      button.className = "nav-btn";
      button.dataset.view = view.id;
      button.dataset.feature = feature.id;
      button.title = view.label;
      button.setAttribute("aria-label", view.label);
      button.setAttribute("data-i18n-title", view.label);
      button.setAttribute("data-i18n-aria-label", view.label);
      const key = doc.createElement("span");
      key.className = "nav-key";
      const icon = doc.createElement("span");
      icon.className = "nav-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.innerHTML = String(view.nav?.icon || "");
      const label = doc.createElement("span");
      label.className = "nav-label";
      label.setAttribute("data-i18n", view.label.toUpperCase());
      label.textContent = view.label.toUpperCase();
      button.append(key, icon, label);
      if (navAnchor) navAnchor.before(button);
      else nav.append(button);
    }
    const settingsTabs = doc.querySelector("#settings-tabs");
    let lastPanel = [...doc.querySelectorAll('[id^="settings-panel-"]')].pop();
    for (const { tab, feature } of tabs) {
      if (!settingsTabs || !lastPanel) break;
      const button = doc.createElement("button");
      button.type = "button";
      button.id = `settings-tab-${tab.id}`;
      button.className = "ui-tab";
      button.setAttribute("role", "tab");
      button.dataset.value = tab.id;
      button.dataset.feature = feature.id;
      button.setAttribute("aria-selected", "false");
      button.setAttribute("aria-controls", `settings-panel-${tab.id}`);
      button.tabIndex = -1;
      button.setAttribute("data-i18n", tab.label || tab.id);
      button.textContent = tab.label || tab.id;
      settingsTabs.append(button);
      const panel = doc.createElement("div");
      panel.id = `settings-panel-${tab.id}`;
      panel.className = "learn-panel";
      panel.setAttribute("role", "tabpanel");
      panel.setAttribute("aria-labelledby", button.id);
      panel.dataset.feature = feature.id;
      panel.hidden = true;
      lastPanel.after(panel);
      lastPanel = panel;
      panels.set(tab.id, panel);
    }
    const libraryTabs = doc.querySelector("#library-filter");
    for (const { filter, feature } of filters) {
      if (!libraryTabs) break;
      const button = doc.createElement("button");
      button.type = "button";
      button.id = `library-filter-${filter.id}`;
      button.className = "ui-tab";
      button.setAttribute("role", "tab");
      button.dataset.value = filter.id;
      button.dataset.feature = feature.id;
      button.setAttribute("aria-selected", "false");
      button.setAttribute("aria-controls", "library-list");
      button.tabIndex = -1;
      button.setAttribute("data-i18n", filter.label || filter.id);
      button.textContent = filter.label || filter.id;
      libraryTabs.append(button);
    }
  }

  function showView(view) {
    for (const { view: entry, feature } of views) {
      const section = sections.get(entry.id);
      if (!section) continue;
      if (entry.id === view) {
        if (!mounted.has(entry.id)) {
          mounted.add(entry.id);
          guarded(log, `${feature.id} mount`, () => entry.mount?.(section, ctx));
        }
        guarded(log, `${feature.id} activate`, () => entry.activate?.(section, ctx));
      } else if (activeView === entry.id) {
        guarded(log, `${feature.id} deactivate`, () => entry.deactivate?.(section, ctx));
      }
    }
    activeView = views.some(({ view: entry }) => entry.id === view) ? view : "";
  }

  return Object.freeze({
    ids: Object.freeze(accepted.map((feature) => feature.id)),
    viewRoutes: Object.freeze(Object.fromEntries(views.map(({ view }) => [view.id, view.route]))),
    settingsTabIds: Object.freeze(tabs.map(({ tab }) => tab.id)),
    libraryFilterIds: Object.freeze(filters.map(({ filter }) => filter.id)),
    viewLabel: (id) => views.find(({ view }) => view.id === id)?.view.label || "",
    install,
    showView,
    showSettingsTab(tab, visible = true) {
      const entry = tabs.find((item) => item.tab.id === tab);
      const panel = panels.get(tab);
      if (!entry || !panel || !visible) return false;
      guarded(log, `${entry.feature.id} Settings tab`, () => entry.tab.render(panel, ctx));
      return true;
    },
    // Returns true when a feature owns the selected filter; it then fills the list itself.
    showLibraryFilter(filter, list) {
      const entry = filters.find((item) => item.filter.id === filter);
      if (!entry) return false;
      guarded(log, `${entry.feature.id} Library filter`, () => entry.filter.render(list, ctx));
      return true;
    },
    handleKey(event) {
      const entry = views.find(({ view }) => view.id === activeView);
      if (!entry?.view.onKey) return false;
      return Boolean(guarded(log, `${entry.feature.id} keys`, () => entry.view.onKey(event, ctx), false));
    },
    run(hook, payload = {}) {
      for (const feature of accepted) {
        const fn = feature.hooks?.[hook];
        if (typeof fn === "function") guarded(log, `${feature.id} ${hook}`, () => fn(payload, ctx));
      }
    },
  });
}
