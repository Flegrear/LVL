// Phone-only header/search behavior. The application already owns a single
// catalog-search form, input, result list and network request pipeline in app.js.
// This module only moves the existing triggers and retains the draft query.
export const PHONE_SHELL_QUERY = "(max-width: 680px) and (hover: none) and (pointer: coarse)";

const SEARCH_MARKUP = '<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>';
const activeHome = (doc) => Boolean(doc.getElementById("view-home")?.classList?.contains("is-active"));
const headerId = (doc) => activeHome(doc) ? "home-topbar" : "section-topbar";

// A new playback may legitimately restart its loading phase. Repeated updates
// inside that playback never make the logo fill, empty and falsely start again.
// Percentages are accepted ONLY from a verified byte/work count (0..100); the
// existing app.js stage estimates must NOT be passed as measuredPercent.
export function createPhoneLoadingState() {
  let identity = null;
  let percent = null;
  let ready = false;
  return {
    update({ identity: nextIdentity, measuredPercent = null, isReady = false } = {}) {
      if (nextIdentity !== undefined && nextIdentity !== identity) {
        identity = nextIdentity;
        percent = null;
        ready = false;
      }
      ready ||= Boolean(isReady);
      if (ready) percent = 100;
      else if (Number.isFinite(measuredPercent) && measuredPercent >= 0 && measuredPercent <= 100) {
        // A count reaching 100 before playable readiness would mislead the user.
        percent = Math.max(percent ?? 0, Math.min(99, measuredPercent));
      }
      return { identity, percent, ready, indeterminate: percent === null && !ready };
    },
  };
}

// Do not use two buttons/inputs to conduct two searches: all phone entry points
// click the existing Home/section trigger, so app.js owns search, results,
// aborts and keyboard navigation. Reopening restores only the draft query.
export function startPhoneShell(win = globalThis.window) {
  const doc = win?.document;
  const bell = doc?.getElementById?.("sidebar-notifications");
  const home = doc?.getElementById?.("view-home");
  const shell = doc?.getElementById?.("catalog-search-shell");
  const input = doc?.getElementById?.("catalog-search-input");
  const origin = bell?.parentElement;
  if (!bell || !home || !shell || !input || !origin || typeof win.matchMedia !== "function") return null;
  if (doc.getElementById("phone-top-search")) return null; // no duplicate IDs on double startup

  const originalNext = bell.nextElementSibling;
  const query = win.matchMedia(PHONE_SHELL_QUERY);
  const root = doc.documentElement;
  const button = doc.createElement("button");
  button.id = "phone-top-search";
  button.type = "button";
  button.className = "phone-top-search ui-icon-btn";
  button.innerHTML = SEARCH_MARKUP;
  button.setAttribute("aria-label", "Search titles");
  button.setAttribute("title", "Search titles");
  button.setAttribute("data-i18n-aria-label", "Search titles");
  button.setAttribute("aria-controls", "catalog-search-panel");
  button.setAttribute("aria-expanded", "false");
  let savedQuery = input.value || "";
  let restored = false;
  let disposed = false;

  const isPhone = () => query.matches;
  const place = () => {
    if (disposed) return;
    root.classList.toggle("phone-shell-active", isPhone());
    if (!isPhone()) {
      button.remove();
      if (bell.parentElement !== origin) origin.insertBefore(bell, originalNext?.parentElement === origin ? originalNext : null);
      return;
    }
    // The legacy phone layout used a bottom Search action; this replaces it.
    doc.getElementById("phone-nav-search")?.remove();
    const actions = doc.getElementById(headerId(doc))?.querySelector(".ui-topbar__actions");
    if (!actions) return;
    const pivot = actions.querySelector(".random-pick-trigger");
    if (button.parentElement !== actions || button.nextElementSibling !== bell) actions.insertBefore(button, pivot);
    if (bell.parentElement !== actions || bell.nextElementSibling !== pivot) actions.insertBefore(bell, pivot);
  };

  const restoreDraft = () => {
    if (disposed || !isPhone() || shell.hidden) return;
    button.setAttribute("aria-expanded", "true");
    if (savedQuery && input.value !== savedQuery) {
      input.value = savedQuery;
      // The existing input listener refreshes the existing result list/cache.
      // Never make an independent request from this module.
      input.dispatchEvent(new win.Event("input", { bubbles: true }));
    }
  };
  const requestRestore = () => {
    if (restored) return;
    restored = true;
    // app.js clears the input synchronously when its trigger first opens it.
    // Restore on the next microtask after that existing handler runs.
    win.queueMicrotask(() => { restored = false; restoreDraft(); });
  };

  const onSearch = () => {
    if (!isPhone()) return;
    place();
    doc.getElementById(activeHome(doc) ? "home-search-title" : "section-search-title")?.click();
    requestRestore();
  };
  const onInput = () => { if (isPhone()) savedQuery = input.value; };
  const onKey = (event) => {
    if (!isPhone() || event.key !== "Escape" || shell.hidden) return;
    // Existing app.js Escape handler closes results and restores focus to its
    // desktop trigger. On touch screens that trigger is hidden; focus our icon.
    win.queueMicrotask(() => { if (!disposed && shell.hidden) button.focus?.(); });
  };
  const onTabs = (event) => {
    const tab = event.target?.closest?.("#home-tabs .ui-tab");
    if (tab && isPhone()) tab.scrollIntoView?.({ block: "nearest", inline: "nearest", behavior: "smooth" });
  };
  const onShellChange = () => {
    button.setAttribute("aria-expanded", String(isPhone() && !shell.hidden));
    if (!shell.hidden) requestRestore();
  };

  button.addEventListener("click", onSearch);
  input.addEventListener("input", onInput);
  doc.addEventListener("keydown", onKey, true);
  doc.addEventListener("click", onTabs);
  const viewObserver = new win.MutationObserver(place);
  viewObserver.observe(home, { attributes: true, attributeFilter: ["class"] });
  const shellObserver = new win.MutationObserver(onShellChange);
  shellObserver.observe(shell, { attributes: true, attributeFilter: ["hidden"] });
  query.addEventListener?.("change", place);
  place();

  return {
    place,
    search: button,
    get query() { return savedQuery; },
    destroy() {
      disposed = true;
      button.remove();
      root.classList.remove("phone-shell-active");
      if (bell.parentElement !== origin) origin.insertBefore(bell, originalNext?.parentElement === origin ? originalNext : null);
      input.removeEventListener("input", onInput);
      doc.removeEventListener("keydown", onKey, true);
      doc.removeEventListener("click", onTabs);
      query.removeEventListener?.("change", place);
      viewObserver.disconnect();
      shellObserver.disconnect();
    },
  };
}
