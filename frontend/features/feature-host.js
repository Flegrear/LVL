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
//     views: [{ id: "reader", route: "/reader", label: "Reader", keepQuery: true,
//               nav: { icon: "<svg …/>", after: "library", key: "" },
//               mount(section, ctx) {}, activate(section, ctx) {}, deactivate(section, ctx) {}, onKey(event, ctx) {} }],
//     homeCategories: [{ id: "comics", label: "Comics", render({ hero, rows }, ctx) {} }],
//     settingsTabs: [{ id: "sources", label: "Sources", render(panel, ctx) {} }],
//     libraryFilters: [{ id: "manga", label: "Manga", render(list, ctx) {},
//                        statusLabels: { CURRENT: "Reading", REPEATING: "Rereading" },
//                        statuses(options, ctx) { return { any: 3, CURRENT: 2 }; } }],
//     hooks: { "title:render"(payload, ctx) {}, "storage:render"(payload, ctx) {} },
//   }
// keepQuery: the view keeps its "?…" part in the URL. Sidebar clicks open the
// bare route; the feature navigates inside itself with
// ctx.switchView(id, { query: "?title=…" }); reload and Back keep the query.
// nav.after: put the nav button right after a core button (default: before Settings).
// homeCategories: extra tabs in Home's top bar; the feature renders hero and rows.
// Each view route also needs a server page route (backend/features registry
// asset that serves index.html) so reloading the page works.

export const CORE_VIEWS = Object.freeze(["home", "watch", "library", "calendar", "study", "review", "test", "settings", "title"]);
export const CORE_NAV_VIEWS = Object.freeze(["home", "watch", "library", "calendar", "study", "review", "test", "settings"]);
export const CORE_ROUTES = Object.freeze(["/", "/home", "/watch", "/library", "/calendar", "/study", "/review", "/test", "/tests", "/settings", "/title", "/components"]);
export const CORE_SETTINGS_TABS = Object.freeze(["general", "coach", "library", "storage", "updates", "notifications", "recs"]);
export const CORE_LIBRARY_FILTERS = Object.freeze(["all", "series", "movie", "anime"]);
export const CORE_HOME_CATEGORIES = Object.freeze(["all", "movie", "tv", "anime"]);
export const CLIENT_HOOKS = Object.freeze(["title:render", "storage:render"]);
// Library status list keys (the "My lists" sidebar); a filter's statusLabels rename them.
export const LIBRARY_STATUSES = Object.freeze(["CURRENT", "COMPLETED", "PLANNING", "PAUSED", "DROPPED", "REPEATING"]);

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
    home: new Set(CORE_HOME_CATEGORIES),
    "title subject": new Set(),
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
      if (view.keepQuery !== undefined && typeof view.keepQuery !== "boolean") problem(problems, `${owner}: view "${view.id}" keepQuery must be true or false`);
      if (view.nav?.after !== undefined && !CORE_NAV_VIEWS.includes(view.nav.after)) problem(problems, `${owner}: view "${view.id}" nav.after must be one of ${CORE_NAV_VIEWS.join(", ")}`);
      if (view.nav?.key !== undefined && (typeof view.nav.key !== "string" || view.nav.key.length > 3)) problem(problems, `${owner}: view "${view.id}" nav.key must be up to 3 characters`);
      if (view.navHighlight !== undefined && typeof view.navHighlight !== "function" && !CORE_NAV_VIEWS.includes(view.navHighlight)) {
        problem(problems, `${owner}: view "${view.id}" navHighlight must be a core nav view or a function`);
      }
    }
    for (const category of feature.homeCategories || []) {
      if (typeof category?.id !== "string" || !ID.test(category.id)) { problem(problems, `${owner}: invalid Home category id ${JSON.stringify(category?.id)}`); continue; }
      claim("home", category.id, owner);
      if (typeof category.label !== "string" || !category.label) problem(problems, `${owner}: Home category "${category.id}" needs a label`);
      if (typeof category.render !== "function") problem(problems, `${owner}: Home category "${category.id}" needs render()`);
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
      if (filter.allGroup !== undefined && typeof filter.allGroup !== "function") problem(problems, `${owner}: Library filter "${filter.id}" allGroup must be a function`);
      if (filter.statuses !== undefined && typeof filter.statuses !== "function") problem(problems, `${owner}: Library filter "${filter.id}" statuses must be a function`);
      if (filter.statusLabels !== undefined) {
        const labels = filter.statusLabels;
        const valid = labels && typeof labels === "object" && !Array.isArray(labels)
          && Object.entries(labels).every(([key, value]) => LIBRARY_STATUSES.includes(key) && typeof value === "string" && value.trim() && value.length <= 40);
        if (!valid) problem(problems, `${owner}: Library filter "${filter.id}" statusLabels must map ${LIBRARY_STATUSES.join(", ")} to short labels`);
      }
    }
    for (const hook of Object.keys(feature.hooks || {})) {
      if (!CLIENT_HOOKS.includes(hook)) problem(problems, `${owner}: unknown hook "${hook}"`);
    }
    for (const section of feature.titleSections || []) {
      if (typeof section?.id !== "string" || !ID.test(section.id)) { problem(problems, `${owner}: invalid title section id ${JSON.stringify(section?.id)}`); continue; }
      if (typeof section.available !== "function" || typeof section.render !== "function") problem(problems, `${owner}: title section "${section.id}" needs available() and render()`);
    }
    // Title pages a feature owns: /title?f=<id>&item=<item>.
    for (const subject of feature.titleSubjects || []) {
      if (typeof subject?.id !== "string" || !ID.test(subject.id)) { problem(problems, `${owner}: invalid title subject id ${JSON.stringify(subject?.id)}`); continue; }
      claim("title subject", subject.id, owner);
      if (typeof subject.describe !== "function") problem(problems, `${owner}: title subject "${subject.id}" needs describe()`);
      if (subject.mount !== undefined && typeof subject.mount !== "function") problem(problems, `${owner}: title subject "${subject.id}" mount must be a function`);
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
  const homes = accepted.flatMap((feature) => (feature.homeCategories || []).map((category) => ({ category, feature })));
  const titleSections = accepted.flatMap((feature) => (feature.titleSections || []).map((section) => ({ section, feature })));
  const titleSubjects = accepted.flatMap((feature) => (feature.titleSubjects || []).map((subject) => ({ subject, feature })));
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
      key.textContent = String(view.nav?.key || "");
      const icon = doc.createElement("span");
      icon.className = "nav-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.innerHTML = String(view.nav?.icon || "");
      const label = doc.createElement("span");
      label.className = "nav-label";
      label.setAttribute("data-i18n", view.label.toUpperCase());
      label.textContent = view.label.toUpperCase();
      button.append(key, icon, label);
      const anchor = view.nav?.after ? doc.querySelector(`.side-nav .nav-btn[data-view="${view.nav.after}"]`) : null;
      if (anchor) {
        // Several features after the same button keep their registration order.
        let last = anchor;
        while (last.nextElementSibling?.dataset?.navAfter === view.nav.after) last = last.nextElementSibling;
        button.dataset.navAfter = view.nav.after;
        last.after(button);
      } else if (navAnchor) navAnchor.before(button);
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
    const homeTabs = doc.querySelector("#home-tabs");
    for (const { category, feature } of homes) {
      if (!homeTabs) break;
      const button = doc.createElement("button");
      button.type = "button";
      button.id = `home-tab-${category.id}`;
      button.className = "ui-tab";
      button.setAttribute("role", "tab");
      button.dataset.value = category.id;
      button.dataset.feature = feature.id;
      button.setAttribute("aria-selected", "false");
      button.setAttribute("aria-controls", "home-panel");
      button.tabIndex = -1;
      button.setAttribute("data-i18n", category.label);
      button.textContent = category.label;
      homeTabs.append(button);
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
    homeCategoryIds: Object.freeze(homes.map(({ category }) => category.id)),
    keepsQuery: (id) => views.some(({ view }) => view.id === id && view.keepQuery === true),
    // Core nav button to highlight for a feature view without its own button (nav: false).
    navFor(id) {
      const entry = views.find(({ view }) => view.id === id);
      if (!entry?.view.navHighlight) return "";
      const value = typeof entry.view.navHighlight === "function"
        ? guarded(log, `${entry.feature.id} navHighlight`, () => entry.view.navHighlight(ctx), "")
        : entry.view.navHighlight;
      return CORE_NAV_VIEWS.includes(value) ? value : "";
    },
    // Groups that features add to the Library's "All" view. allGroup(options) is
    // synchronous (from the feature's own cache) and returns
    // { shown, statuses: { CURRENT: n, … } counted before the status filter, html }.
    libraryAllGroups(options = {}) {
      const groups = [];
      for (const { filter, feature } of filters) {
        if (typeof filter.allGroup !== "function") continue;
        const group = guarded(log, `${feature.id} Library group`, () => filter.allGroup(options, ctx), null);
        if (!group || !Number.isFinite(group.shown)) continue;
        groups.push({ id: filter.id, label: filter.label || filter.id, shown: group.shown, statuses: group.statuses || {}, html: String(group.html || "") });
      }
      return groups;
    },
    libraryFilterStatuses(filterId, options = {}) {
      const entry = filters.find((item) => item.filter.id === filterId);
      if (!entry) return {};
      // The filter's own list may hold more than its "All" group (entries shown on a video card there).
      if (typeof entry.filter.statuses === "function") return guarded(log, `${entry.feature.id} Library statuses`, () => entry.filter.statuses(options, ctx) || {}, {});
      if (typeof entry.filter.allGroup !== "function") return {};
      return guarded(log, `${entry.feature.id} Library statuses`, () => entry.filter.allGroup(options, ctx)?.statuses || {}, {});
    },
    // The status list's names while a feature filter is selected ({} keeps core's names).
    libraryStatusLabels(filterId) {
      const entry = filters.find((item) => item.filter.id === filterId);
      return { ...(entry?.filter.statusLabels || {}) };
    },
    viewLabel: (id) => views.find(({ view }) => view.id === id)?.view.label || "",
    install,
    showView,
    // Returns true when a feature owns the selected Home category; it then fills hero and rows.
    showHomeCategory(category, targets) {
      const entry = homes.find((item) => item.category.id === category);
      if (!entry) return false;
      guarded(log, `${entry.feature.id} Home category`, () => entry.category.render(targets, ctx));
      return true;
    },
    showSettingsTab(tab, visible = true) {
      const entry = tabs.find((item) => item.tab.id === tab);
      const panel = panels.get(tab);
      if (!entry || !panel || !visible) return false;
      guarded(log, `${entry.feature.id} Settings tab`, () => entry.tab.render(panel, ctx));
      return true;
    },
    // Returns true when a feature owns the selected filter; it then fills the list itself.
    // options: { query, sort, status } from the core Library toolbar.
    showLibraryFilter(filter, list, options = {}) {
      const entry = filters.find((item) => item.filter.id === filter);
      if (!entry) return false;
      guarded(log, `${entry.feature.id} Library filter`, () => entry.filter.render(list, ctx, options));
      return true;
    },
    // Title page sections next to the seasons (e.g. "Manga"). available(payload)
    // returns null (hidden), true, or a count shown on the chip.
    titleSectionChips(payload = {}) {
      const chips = [];
      for (const { section, feature } of titleSections) {
        const available = guarded(log, `${feature.id} title section`, () => section.available(payload, ctx), null);
        if (available === null || available === false || available === undefined) continue;
        chips.push({ id: section.id, label: section.label || section.id, count: typeof available === "number" ? available : null });
      }
      return chips;
    },
    renderTitleSection(id, element, payload = {}) {
      const entry = titleSections.find((item) => item.section.id === id);
      if (!entry || !element) return false;
      guarded(log, `${entry.feature.id} title section`, () => entry.section.render(element, payload, ctx));
      return true;
    },
    // A title page a feature owns: describe(item) gives the hero's content, or
    // null while loading (the feature calls ctx.refreshTitlePage() when ready),
    // or { missing: true }. Unknown subjects are missing.
    titleSubjectInfo(id, item) {
      const entry = titleSubjects.find((candidate) => candidate.subject.id === id);
      if (!entry) return { missing: true };
      const info = guarded(log, `${entry.feature.id} title subject`, () => entry.subject.describe(String(item), ctx), { missing: true });
      if (info === null || info === undefined) return null;
      if (info.missing) return { missing: true };
      return { ...info, name: String(info.name || "Untitled") };
    },
    mountTitleSubject(id, parts, item) {
      const entry = titleSubjects.find((candidate) => candidate.subject.id === id);
      if (!entry?.subject.mount) return false;
      guarded(log, `${entry.feature.id} title subject`, () => entry.subject.mount(parts, String(item), ctx));
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
