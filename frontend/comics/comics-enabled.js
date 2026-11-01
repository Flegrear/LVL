// Settings › Comics › Use Comics (on by default). When it's off, Comics is hidden
// everywhere except its Settings tab: the Home and Library tabs (comics.css), the
// Library's All view, the Manga and Comics chips on title pages, and comic pages.
// The server answers 409 for every other comics route and stops the extension runner,
// folder scans and downloads.
//
// The last known value is kept in localStorage, so the Comics tabs don't flash at
// start-up; the server's value wins once it arrives.
import { comicsApi } from "./comics-api.js";

const KEY = "lvl-comics-enabled";
const storage = () => { try { return typeof localStorage === "undefined" ? null : localStorage; } catch { return null; } };
let enabled = storage()?.getItem(KEY) !== "0";
let lastCtx = null;
let checked = null;

function apply() {
  if (typeof document !== "undefined") document.documentElement?.classList.toggle("comics-off", !enabled);
}
apply();

export const comicsEnabled = () => enabled;

// Returns true when the value changed.
export function setComicsEnabled(value) {
  const next = value !== false;
  const changed = next !== enabled;
  enabled = next;
  try { storage()?.setItem(KEY, enabled ? "1" : "0"); } catch {}
  apply();
  return changed;
}

// Redraws what shows Comics: the Library, the open title page. Home and the Library
// redraw on every visit, and their Comics tab hands over to "All" (leaveComicsTab).
export function refreshComicsPlaces(ctx = lastCtx) {
  ctx?.refreshLibrary?.();
  ctx?.refreshTitle?.();
  ctx?.refreshTitlePage?.();
}

// Asks the server once per page load. Callbacks pass their ctx so a change can redraw.
export function checkComicsEnabled(ctx = null, load = () => comicsApi.settings()) {
  if (ctx) lastCtx = ctx;
  if (!checked) {
    checked = Promise.resolve().then(load).then((settings) => {
      if (settings && setComicsEnabled(settings.enabled !== false)) refreshComicsPlaces();
    }).catch(() => {});
  }
  return checked;
}

// A hidden Comics tab that is still selected (Home, Library) switches to "All", once the
// view is on screen (core's tab click would otherwise open the view).
export function leaveComicsTab(viewSelector, allTabSelector) {
  setTimeout(() => {
    if (document.querySelector(viewSelector)?.classList.contains("is-active")) document.querySelector(allTabSelector)?.click();
  }, 0);
}

// Test hook: forget the server answer.
export function resetComicsEnabledCheck() { checked = null; lastCtx = null; }

if (typeof window !== "undefined" && typeof fetch === "function") void checkComicsEnabled();
