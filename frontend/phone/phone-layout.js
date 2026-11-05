// Phone layout, registered in frontend/features/registry.js. On touch screens up to 680px
// wide (phones and the Android app) phone.css moves the main navigation to a bar at the
// bottom of the screen; this module slides that bar away while the page scrolls down and
// brings it back when it scrolls up, reaches the top, or a new page opens. Desktop windows
// and tablets keep their layout: everything sits behind PHONE_QUERY.
import { startAndroidBridge } from "./android-bridge.js";
import { createDoubleTapSeekController } from "../player/phone-seek-input.js";
import { startPhoneShell } from "./shell-ui.js";
import { startPhoneCatalogUI } from "./catalog-ui.js";

export const PHONE_QUERY = "(max-width: 680px) and (hover: none) and (pointer: coarse)";
// Near the top of a page the bar always shows.
export const SHOW_NEAR_TOP_PX = 72;
// Smaller movements (a finger resting on the screen, momentum jitter) change nothing.
export const MIN_SCROLL_DELTA_PX = 8;

const TEXT_FIELD = 'input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="file"]):not([type="color"]), textarea, [contenteditable=""], [contenteditable="true"]';

// Where the bar should be after the page scrolled to y. state: { hidden, lastY }.
// lastY only moves when a change counts, so slow scrolling still adds up.
export function navAfterScroll(state, y) {
  const top = Math.max(0, Number(y) || 0);
  if (top <= SHOW_NEAR_TOP_PX) return { hidden: false, lastY: top };
  const delta = top - state.lastY;
  if (Math.abs(delta) < MIN_SCROLL_DELTA_PX) return state;
  return { hidden: delta > 0, lastY: top };
}

export function isTextField(element) {
  return Boolean(element?.matches?.(TEXT_FIELD));
}

export function startPhoneLayout(win = globalThis.window) {
  const doc = win?.document;
  if (!doc?.documentElement || typeof win.matchMedia !== "function") return null;
  const root = doc.documentElement;
  if (/\bLVL-Android\//.test(win.navigator?.userAgent || "")) root.classList.add("lvl-android");
  const query = win.matchMedia(PHONE_QUERY);
  let state = { hidden: false, lastY: win.scrollY || 0 };
  let typing = false;
  let pending = false;
  // While a text field has focus the on-screen keyboard shrinks the page, and the bar
  // would sit on top of it, so it steps aside until typing ends.
  const apply = () => root.classList.toggle("phone-nav-hidden", query.matches && (state.hidden || typing));
  const show = () => { state = { hidden: false, lastY: win.scrollY || 0 }; apply(); };
  win.addEventListener("scroll", () => {
    if (pending || !query.matches) return;
    pending = true;
    win.requestAnimationFrame(() => {
      pending = false;
      state = navAfterScroll(state, win.scrollY || 0);
      apply();
    });
  }, { passive: true });
  doc.addEventListener("focusin", (event) => { typing = isTextField(event.target); apply(); });
  doc.addEventListener("focusout", () => { typing = false; apply(); });
  // A tap on the bar or Back opens another page; it starts with the bar showing.
  doc.addEventListener("click", (event) => { if (event.target?.closest?.(".side-nav")) show(); });
  win.addEventListener("popstate", show);
  query.addEventListener?.("change", show);
  apply();
  return { show, state: () => ({ ...state, typing }) };
}

export const phoneLayoutFeature = Object.freeze({
  id: "phone",
  styles: ["/frontend/phone/phone.css"],
  start: () => {
    startPhoneLayout();
    // Phone stylesheet order is intentional: base phone -> shell/player ->
    // catalog presentation. The discovery controls reuse production forms and
    // the topbar's existing search; they do not register another search input.
    for (const href of ["/frontend/phone/shell.css", "/frontend/phone/player-controls.css", "/frontend/phone/catalog-ui.css"]) {
      if (!document.head?.querySelector?.(`link[href="${href}"]`)) {
        const sheet = document.createElement("link");
        sheet.rel = "stylesheet";
        sheet.href = href;
        document.head?.append(sheet);
      }
    }
    startPhoneShell();
    startPhoneCatalogUI();
    startTouchPlayer();
    if (globalThis.window?.LvlAndroid) startAndroidBridge();
  },
});

// Touch screens (the Android app, phone browsers) of any width.
export const TOUCH_QUERY = "(hover: none) and (pointer: coarse)";

// The player's controls appear while a mouse moves over the video and hide when it leaves,
// and a click on the video plays or pauses (app.js). A finger doesn't hover: it "enters" and
// "leaves" with every tap, so on a touch screen the controls never stayed up and each tap
// paused or played. Here a tap on the video shows the controls, or hides them when they're
// up, as in video apps; the play button among them plays and pauses.
export function startTouchPlayer(win = globalThis.window) {
  const doc = win?.document;
  const frame = doc?.getElementById?.("video-frame");
  const video = doc?.getElementById?.("video");
  if (!frame || !video || typeof win.matchMedia !== "function") return null;
  const touch = win.matchMedia(TOUCH_QUERY);
  const byFinger = (event) => touch.matches && (event.pointerType === "touch" || event.pointerType === "pen");
  let hiddenAtDown = true;
  const Pointer = win.PointerEvent || win.Event;
  // As a mouse would: moving shows the controls (and starts their 3 s timer), leaving hides them.
  const show = () => frame.dispatchEvent(new Pointer("pointermove", { bubbles: true, pointerType: "mouse" }));
  const hide = () => frame.dispatchEvent(new Pointer("pointerleave", { pointerType: "mouse" }));
  for (const type of ["pointerenter", "pointerleave"]) {
    frame.addEventListener(type, (event) => { if (byFinger(event)) event.stopImmediatePropagation(); }, true);
  }
  frame.addEventListener("pointerdown", (event) => { if (byFinger(event)) hiddenAtDown = frame.classList.contains("controls-hidden"); }, true);
  const onSingleTap = () => { if (hiddenAtDown) show(); else hide(); };
  const seekBack = doc.getElementById?.("player-seek-back");
  const seekForward = doc.getElementById?.("player-seek-forward");
  const doubleTap = touch.matches && seekBack && seekForward
    ? createDoubleTapSeekController({ surface: video, frame: win, backButton: seekBack,
      forwardButton: seekForward, onSingleTap }) : null;
  if (!doubleTap) frame.addEventListener("click", (event) => {
    if (event.target !== video || !byFinger(event)) return;
    event.stopImmediatePropagation();
    onSingleTap();
  }, true);
  startSubtitleLift(win, frame);
  return { show, hide, doubleTap, dispose: () => doubleTap?.dispose() };
}

// On a phone the controls cover a large part of the video (a third in landscape fullscreen,
// half of the small upright player), and the subtitle line sat under them. While they're shown
// the line moves just above them, as in video apps (phone.css uses --touch-controls-lift); the
// position chosen in the subtitle settings still applies when it's higher.
export function controlsLift(frame, controls, row) {
  const height = Number(frame?.clientHeight) || 0;
  if (!height || !controls) return 0;
  // offsetTop ignores the controls' slide-in transform, so it's the same shown or hidden.
  const top = (Number(controls.offsetTop) || 0) + (row ? Number(row.offsetTop) || 0 : 0);
  return Math.max(0, Math.min(height, Math.round(height - top + 6)));
}

function startSubtitleLift(win, frame) {
  const doc = win.document;
  const controls = doc.getElementById?.("compat-controls");
  if (!controls || typeof win.ResizeObserver !== "function") return;
  const update = () => {
    const row = controls.querySelector?.(".player-timeline-row") || null;
    frame.style.setProperty("--touch-controls-lift", `${controlsLift(frame, controls, row)}px`);
  };
  new win.ResizeObserver(update).observe(controls);
  new win.ResizeObserver(update).observe(frame);
  update();
}

const SEARCH_ICON = '<span class="nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></svg></span><span class="nav-label">SEARCH</span>';

// On phones the bell sits in the top bar, where the search icon was, and Search takes the
// bell's place at the end of the bottom bar; it opens the same search box in the top bar.
// Home and the other pages have their own top bar, so the bell follows the one that shows.
// Home's tabs scroll sideways (phone.css), and a chosen tab scrolls fully into view.
export function startPhoneHeader(win = globalThis.window) {
  const doc = win?.document;
  const bell = doc?.getElementById?.("sidebar-notifications");
  const homeView = doc?.getElementById?.("view-home");
  if (!bell || !homeView || typeof win.matchMedia !== "function") return null;
  const query = win.matchMedia(PHONE_QUERY);
  const origin = { parent: bell.parentElement, next: bell.nextElementSibling };
  const onHome = () => homeView.classList.contains("is-active");

  const search = doc.createElement("button");
  search.type = "button";
  search.id = "phone-nav-search";
  search.className = "phone-nav-search";
  search.setAttribute("aria-label", "Search titles");
  search.setAttribute("data-i18n-aria-label", "Search titles");
  search.innerHTML = SEARCH_ICON;
  search.addEventListener("click", () => doc.getElementById(onHome() ? "home-search-title" : "section-search-title")?.click());

  function place() {
    if (!query.matches) {
      search.remove();
      if (bell.parentElement !== origin.parent) origin.parent.insertBefore(bell, origin.next?.parentElement === origin.parent ? origin.next : null);
      return;
    }
    const actions = doc.getElementById(onHome() ? "home-topbar" : "section-topbar")?.querySelector(".ui-topbar__actions");
    if (actions && bell.parentElement !== actions) actions.insertBefore(bell, actions.querySelector(".random-pick-trigger"));
    if (search.parentElement !== origin.parent) origin.parent.insertBefore(search, origin.next?.parentElement === origin.parent ? origin.next : null);
  }

  new win.MutationObserver(place).observe(homeView, { attributes: true, attributeFilter: ["class"] });
  query.addEventListener?.("change", place);
  doc.addEventListener("click", (event) => {
    const tab = event.target?.closest?.(".ui-tabs .ui-tab");
    if (tab && query.matches) tab.scrollIntoView?.({ block: "nearest", inline: "nearest", behavior: "smooth" });
  });
  place();
  return { place, search };
}
