// Small-screen discovery controls. This module is deliberately independent of
// the catalogue/search implementation: the original forms still own values,
// submits, result fetching and selection. The global header search is untouched.
export const CATALOG_PHONE_QUERY = "(max-width: 680px) and (hover: none) and (pointer: coarse)";

const currentSeason = () => ["WINTER", "SPRING", "SUMMER", "FALL"][Math.floor(new Date().getMonth() / 3)];
export function discoveryDefaults(kind, year = new Date().getFullYear(), season = currentSeason()) {
  return kind === "anime"
    ? { search: "", year: String(year), season, sort: "POPULARITY_DESC", format: "TV", status: "", genre: "" }
    : { q: "", type: "", sort: "POPULARITY_DESC", status: "", genre: "", year: String(year), source: "" };
}

// The grid and shelf use actual CSS gap/gutter dimensions. Keep complete three
// column posters at 320px rather than stretching two posters beyond phone width.
export function phonePosterGeometry(viewport, gutter = 16, gap = 9) {
  const available = Math.max(0, Number(viewport) - 2 * gutter);
  return { available, columns: 3, gap, poster: Math.max(0, (available - 2 * gap) / 3) };
}

function controls(form) {
  return Array.from(form.querySelectorAll?.("input[name], select[name]") || []);
}
function selectedLabel(control) {
  const selected = control?.selectedOptions?.[0] || control?.options?.[control.selectedIndex];
  return String(selected?.textContent || control?.value || "").trim();
}
const humanize = (name) => ({ year: "Year", season: "Season", type: "Type", format: "Format", status: "Status", genre: "Genre", sort: "Rank", search: "Title", q: "Title", source: "Source" })[name] || name;

// Derive an active summary from the LIVE production inputs. In particular,
// hidden local title queries may be nonempty from a prior desktop session:
// reflect them here so no invisible filter is mistaken for an empty search.
export function discoveryFilterSummary(form, kind, defaults = discoveryDefaults(kind)) {
  const changed = [];
  const modifiedLabels = [];
  const defaultLabels = [];
  for (const control of controls(form)) {
    const name = control.name;
    if (!Object.hasOwn(defaults, name)) continue;
    const value = String(control.value ?? "");
    const modified = value !== defaults[name];
    if (modified) changed.push(name);
    if (!value && !modified) continue;
    if (name === "sort" && value === "POPULARITY_DESC" && !modified) continue;
    let label = "";
    if (name === "search" || name === "q") {
      if (value.trim()) label = `Title: ${value}`;
    } else if (name === "source") {
      if (value) label = `Source: ${String(control.dataset?.sourceLabel || value)}`;
    } else {
      label = `${humanize(name)}: ${selectedLabel(control)}`;
    }
    if (label) (modified ? modifiedLabels : defaultLabels).push(label);
  }
  // Show the choices the person actually changed BEFORE seasonal defaults.
  // A changed genre or formerly hidden local title must never disappear into +N.
  const active = [...modifiedLabels, ...defaultLabels];
  const concise = active.slice(0, 2).join(" · ") + (active.length > 2 ? ` · +${active.length - 2}` : "");
  return { changed: changed.length > 0, count: changed.length, text: concise || "All", detail: active.join(" · ") || "Default filters" };
}

function setControlValue(form, name, value) {
  const control = controls(form).find((entry) => entry.name === name);
  if (control) control.value = String(value);
}

function addControl(doc, className, text, attrs = {}) {
  const button = doc.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = text;
  for (const [name, value] of Object.entries(attrs)) button.setAttribute(name, value);
  return button;
}

// Pass a specific form: app.js re-renders #anime-browser and Comics replaces
// #comic-browser on its built-in Reset, so the observer rebinds new forms only.
export function enhanceDiscoveryForm(form, kind, { doc = form?.ownerDocument, phone = () => true } = {}) {
  if (!form || !doc || form.dataset.phoneCatalogEnhanced === "true") return null;
  const section = form.closest?.(".anime-browser");
  if (!section) return null;
  const defaults = discoveryDefaults(kind);
  form.dataset.phoneCatalogEnhanced = "true";
  if (!form.id) form.id = `phone-${kind}-discovery-filters`;
  const bar = doc.createElement("div");
  bar.className = "phone-catalog-disclosure";
  bar.dataset.phoneCatalogKind = kind;
  const toggle = addControl(doc, "phone-catalog-disclosure__toggle", "Filters", {
    "aria-controls": form.id, "aria-expanded": "false", "aria-label": `${kind === "anime" ? "Anime" : "Comics"} filters`,
  });
  const summary = doc.createElement("span");
  summary.className = "phone-catalog-disclosure__summary";
  summary.id = `phone-${kind}-filter-summary`;
  toggle.setAttribute("aria-describedby", summary.id);
  const reset = addControl(doc, "phone-catalog-disclosure__reset", "Reset", { "aria-label": `Reset ${kind} filters` });
  bar.append(toggle, summary, reset);
  form.before(bar);
  let expanded = false;
  let destroyed = false;
  const render = () => {
    if (destroyed) return;
    const small = phone();
    form.hidden = small && !expanded;
    bar.hidden = !small;
    toggle.setAttribute("aria-expanded", String(small && expanded));
    const state = discoveryFilterSummary(form, kind, defaults);
    if (summary.textContent !== state.text) summary.textContent = state.text;
    summary.title = state.detail;
    reset.hidden = !state.changed;
    reset.disabled = !state.changed;
  };
  const onToggle = () => {
    expanded = !expanded;
    render();
    if (!expanded && form.contains?.(doc.activeElement)) toggle.focus();
  };
  const onReset = () => {
    if (kind === "comics") {
      // The comics owner intentionally replaces its entire form on Reset and
      // reloads with its own DEFAULT_FILTERS, including a fresh source state.
      const original = form.querySelector("[data-comic-browser-reset]");
      if (original) { original.click(); return; }
    }
    for (const [name, value] of Object.entries(defaults)) setControlValue(form, name, value);
    render();
    form.requestSubmit?.(); // one existing app submit; no parallel API request
  };
  const onField = () => {
    if (doc.defaultView?.queueMicrotask) doc.defaultView.queueMicrotask(render);
    else render();
  };
  const onKey = (event) => {
    if (event.key !== "Escape" || !expanded || !phone()) return;
    event.preventDefault();
    expanded = false;
    render();
    toggle.focus();
  };
  toggle.addEventListener("click", onToggle);
  reset.addEventListener("click", onReset);
  form.addEventListener("input", onField);
  form.addEventListener("change", onField);
  form.addEventListener("submit", onField);
  form.addEventListener("keydown", onKey);
  render();
  return {
    kind, form, bar, toggle, summary, reset, render,
    destroy() {
      destroyed = true;
      toggle.removeEventListener("click", onToggle);
      reset.removeEventListener("click", onReset);
      form.removeEventListener("input", onField);
      form.removeEventListener("change", onField);
      form.removeEventListener("submit", onField);
      form.removeEventListener("keydown", onKey);
      form.hidden = false;
      delete form.dataset.phoneCatalogEnhanced;
      bar.remove();
    },
  };
}

export function enhanceLibraryFilters(doc, { phone = () => true } = {}) {
  const page = doc?.querySelector?.("#view-library .lib-page");
  const status = page?.querySelector?.(".lib-status-sidebar");
  if (!status || page.dataset.phoneCatalogLibrary === "true") return null;
  page.dataset.phoneCatalogLibrary = "true";
  const heading = status.querySelector?.(".lib-status-sidebar__heading");
  const originalHeadingHidden = heading?.hidden;
  const render = () => {
    page.classList.remove("phone-library-filters-collapsed");
    if (heading) heading.hidden = phone() || Boolean(originalHeadingHidden);
  };
  render();
  return { render, destroy() {
    if (heading) heading.hidden = originalHeadingHidden;
    page.classList.remove("phone-library-filters-collapsed");
    delete page.dataset.phoneCatalogLibrary;
  } };
}

// One startup hook, required by F in frontend/phone/phone-layout.js.
export function startPhoneCatalogUI(win = globalThis.window) {
  const doc = win?.document;
  if (!doc?.querySelector || !win?.matchMedia) return null;
  const homeRows = doc.getElementById("home-rows");
  if (!homeRows) return null;
  if (doc.documentElement.dataset.phoneCatalogStarted === "true") return null;
  doc.documentElement.dataset.phoneCatalogStarted = "true";
  const media = win.matchMedia(CATALOG_PHONE_QUERY);
  const controllers = new Map();
  const isPhone = () => media.matches;
  const scan = () => {
    const forms = [
      ["anime", homeRows.querySelector("#anime-browser-form")],
      ["comics", homeRows.querySelector("#comic-browser [data-comic-browser]")],
    ];
    for (const [kind, form] of forms) {
      if (controllers.get(kind)?.form === form) continue;
      controllers.get(kind)?.destroy();
      controllers.delete(kind);
      if (form) controllers.set(kind, enhanceDiscoveryForm(form, kind, { doc, phone: isPhone }));
    }
  };
  const library = enhanceLibraryFilters(doc, { phone: isPhone });
  const onMedia = () => { scan(); for (const controller of controllers.values()) controller?.render(); library?.render(); };
  const observer = new win.MutationObserver(scan);
  observer.observe(homeRows, { subtree: true, childList: true });
  media.addEventListener?.("change", onMedia);
  scan();
  return { scan, library, controllers,
    destroy() {
      observer.disconnect();
      media.removeEventListener?.("change", onMedia);
      for (const controller of controllers.values()) controller?.destroy();
      controllers.clear();
      library?.destroy();
      delete doc.documentElement.dataset.phoneCatalogStarted;
    },
  };
}
