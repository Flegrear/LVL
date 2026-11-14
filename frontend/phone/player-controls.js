// Phone-only player popover lifecycle. This module does not own playback,
// caption visibility, track selection, seeking, or the tap/double-tap gesture.
// Those actions stay in app.js / phone-layout / player-seeking.
import { translateUi } from "../ui/ui-i18n.js";

export const CAPTION_APPEARANCE_FIELDS = Object.freeze([
  "subtitle-style-font",
  "subtitle-style-weight",
  "subtitle-style-size",
  "subtitle-style-shadow",
  "subtitle-style-color",
  "subtitle-style-background",
  "subtitle-style-position",
  "subtitle-style-romanization",
]);

export const PHONE_PLAYER_TOUCH_QUERY = "(hover: none) and (pointer: coarse)";

// A deterministic viewport and player-content width contract for the matching
// portrait CSS. Core phone Watch has a 10px gutter on each side. At 320px,
// speed moves to landscape/wider mode rather than squeezing six touch targets.
export function portraitPlayerControlGeometry(width, { gutter = 10 } = {}) {
  const w = Number(width), inset = Number(gutter);
  if (!Number.isFinite(w) || w <= 0 || !Number.isFinite(inset) || inset < 0)
    throw new RangeError("Positive viewport and nonnegative gutter are required");
  const compact = w <= 340;
  const target = w <= 360 ? 40 : 44;
  const buttons = compact ? 6 : 7;
  const gap = w <= 360 ? 3 : 4;
  const padding = 6;
  return Object.freeze({
    width: w, available: Math.max(0, w - 2 * inset), target, buttons, gap, padding,
    required: buttons * target + (buttons - 1) * gap + padding * 2,
    speedVisible: !compact,
  });
}

// The original controls move into a single labelled overflow surface when
// fullscreen cannot fit them. Its trigger always counts toward the width.
export const FULLSCREEN_ESSENTIAL_CONTROLS = Object.freeze([
  "player-seek-back", "compat-play", "player-seek-forward",
  "player-audio-switcher", "player-toggle-subs", "player-fullscreen",
]);
export const FULLSCREEN_PRIORITY_CONTROLS = Object.freeze([
  "player-source-switcher", "player-mute", "player-next-chapter",
  "player-prev-chapter", "player-float",
]);

// rowWidth is ACTUAL available DOM width, after fullscreen insets. The
// returned layout is independently testable against the source DOM at
// 320/360/412 and landscape widths, without inventing browser measurements.
export function fullscreenPlayerRowBudget(rowWidth, { target = 44 } = {}) {
  const width = Number(rowWidth);
  if (!Number.isFinite(width) || width <= 0) throw new RangeError("A positive fullscreen row width is required");
  const size = Number(target);
  if (!Number.isFinite(size) || size < 40) throw new RangeError("Touch targets must be at least 40px");
  const gap = width <= 360 ? 3 : 4;
  const capacity = Math.max(0, Math.floor((width + gap) / (size + gap)));
  return Object.freeze({ width, target: size, gap, capacity,
    occupied: (count) => count * size + Math.max(0, count - 1) * gap });
}

function nodeInside(target, nodes) {
  return nodes.some((node) => node && (node === target || node.contains?.(target)));
}

/**
 * Install once after the actual player DOM exists.
 *
 * Integration must call the real app.js closePlayerPopovers callback so all
 * player menus share one state. The callback only closes menu UI; it MUST NOT
 * change state.subtitlesVisible or any track.visible value. F connects its
 * hidePlayerControls and navigation paths to onControlsHidden/onNavigation.
 *
 * B double-tap contract: listen to pointerdown in CAPTURE but never prevent
 * default / stop propagation, never call play/pause, never schedule a delayed
 * single tap. Thus B exclusively arbitrates click vs double-tap and the old
 * phone-layout tap handler remains the only controls toggle.
 */
export function installPhonePlayerControls({
  win = globalThis.window,
  closePopovers = null,
  isTouch = null,
} = {}) {
  const doc = win?.document;
  if (!doc?.getElementById || !win?.addEventListener) return null;
  const frame = doc.getElementById("video-frame");
  const controls = doc.getElementById("compat-controls");
  const menu = doc.getElementById("player-subtitle-menu");
  if (!frame || !controls || !menu) return null;
  const touch = isTouch ?? (() => win.matchMedia?.(PHONE_PLAYER_TOUCH_QUERY)?.matches === true);
  if (!touch()) return null; // Desktop owns its original interaction and CSS.

  const video = doc.getElementById("video");
  const row = controls.querySelector?.(".player-control-row");
  const timeline = controls.querySelector?.(".player-timeline-row");
  const time = doc.getElementById("compat-time");
  const timeParent = time?.parentElement;
  const timeOriginalNextSibling = time?.nextSibling ?? null;
  const timeOriginalIndex = timeParent ? [...(timeParent.childNodes || timeParent.children || [])].indexOf(time) : -1;
  const originalRowChildren = row ? [...row.children] : [];
  let rowInFullscreen = false;
  const manager = doc.getElementById("player-subtitle-dialog");
  const appearance = doc.getElementById("subtitle-style-dialog");
  const appearanceControls = appearance?.querySelector?.(".subtitle-style-controls");
  const watch = doc.getElementById("view-watch");
  const triggers = [doc.getElementById("player-toggle-subs"),
    doc.getElementById("floating-player-captions")];
  const popovers = ["player-subtitle-menu", "player-source-menu",
    "player-audio-menu", "player-speed-menu"].map((id) => doc.getElementById(id)).filter(Boolean);
  let disposed = false;
  const root = doc.documentElement;
  const moreButton = doc.createElement("button");
  moreButton.id = "phone-player-more";
  moreButton.type = "button";
  moreButton.className = "player-tool phone-player-more-trigger";
  moreButton.textContent = "⋯";
  moreButton.hidden = true;
  moreButton.setAttribute("aria-label", "More playback controls");
  moreButton.setAttribute("data-i18n-aria-label", "More playback controls");
  moreButton.setAttribute("aria-controls", "phone-player-more-panel");
  moreButton.setAttribute("aria-expanded", "false");
  const morePanel = doc.createElement("div");
  morePanel.id = "phone-player-more-panel";
  morePanel.className = "player-popover phone-player-more-panel";
  morePanel.hidden = true;
  morePanel.setAttribute("role", "group");
  morePanel.setAttribute("aria-label", "More playback controls");
  morePanel.setAttribute("data-i18n-aria-label", "More playback controls");
  const moreHeading = doc.createElement("div");
  moreHeading.className = "phone-player-more-heading";
  moreHeading.textContent = "More controls";
  moreHeading.setAttribute("data-i18n", "More controls");
  morePanel.append(moreHeading);
  translateUi(moreButton);
  translateUi(morePanel);
  let lastOverflowFocus = null;

  const closeMore = ({ focusReturn = false } = {}) => {
    if (morePanel.hidden) return false;
    morePanel.hidden = true;
    moreButton.setAttribute("aria-expanded", "false");
    if (focusReturn && moreButton.isConnected) moreButton.focus?.();
    return true;
  };
  const openMore = () => {
    for (const node of popovers) node.hidden = true;
    closePopovers?.();
    morePanel.hidden = false;
    moreButton.setAttribute("aria-expanded", "true");
    const first = [...morePanel.children].find((node) =>
      node !== moreHeading && !node.hidden && !node.disabled && (node.matches?.("button, input, select") || node.querySelector?.("button, input, select")));
    (first?.matches?.("button, input, select") ? first : first?.querySelector?.("button, input, select"))?.focus?.();
  };
  moreButton.addEventListener("click", (event) => {
    event.stopPropagation?.();
    if (morePanel.hidden) openMore();
    else closeMore({ focusReturn: true });
  });
  moreButton.addEventListener("keydown", (event) => {
    if (!["Enter", " ", "Spacebar"].includes(event.key) || event.repeat) return;
    event.preventDefault?.();
    moreButton.click();
  });
  morePanel.addEventListener("focusin", (event) => {
    if (event.target !== morePanel) lastOverflowFocus = event.target;
  });

  const expanded = (value) => {
    for (const button of triggers) button?.setAttribute?.("aria-expanded", String(value));
  };
  const hasPopover = () => popovers.some((node) => !node.hidden);
  const hasDialog = () => Boolean(manager?.open || appearance?.open);
  const isOpen = () => hasPopover() || hasDialog() || !morePanel.hidden;
  const dismiss = ({ includeDialogs = true, reason = "outside" } = {}) => {
    if (disposed) return false;
    const menusOpen = hasPopover();
    const dialogsOpen = includeDialogs && hasDialog();
    const hadOpen = menusOpen || dialogsOpen || !morePanel.hidden;
    if (!hadOpen) return false;
    // Delegate all ordinary menus to the existing shared close routine. Do
    // not alter the selected captions or saved appearance settings here.
    if (menusOpen) {
      closePopovers?.();
      for (const node of popovers) node.hidden = true;
      expanded(false);
    }
    closeMore();
    if (dialogsOpen) {
      for (const dialog of [appearance, manager]) {
        if (dialog?.open) dialog.close?.();
      }
    }
    return hadOpen;
  };

  const onPointerDown = (event) => {
    if (!touch() || !isOpen()) return;
    // A click on a native <dialog> backdrop is retargeted to the dialog.
    // Content/scrollbar interactions inside its rectangle must not close it.
    if (event.target === manager || event.target === appearance) {
      const bounds = event.target.getBoundingClientRect?.();
      if (bounds && Number.isFinite(event.clientX) && Number.isFinite(event.clientY)
        && (event.clientX < bounds.left || event.clientX > bounds.right
          || event.clientY < bounds.top || event.clientY > bounds.bottom)) {
        dismiss({ reason: "dialog-backdrop" });
      }
      return;
    }
    if (nodeInside(event.target, [...popovers, ...triggers, manager, appearance, moreButton, morePanel])) return;
    // Do not intercept player taps or B's double tap/drag gestures. A
    // pointerdown on the video closes the menu immediately and still reaches
    // the existing video gesture controller.
    dismiss({ reason: event.target === video ? "video" : "outside" });
  };
  const dismissTop = () => {
    // Native dialogs have priority; leave the parent overflow invoker
    // connected so the browser can restore focus to its original element.
    if (hasDialog()) {
      const dialog = appearance?.open ? appearance : manager;
      dialog?.close?.();
      if (lastOverflowFocus?.isConnected && !morePanel.hidden && !doc.activeElement?.closest?.("dialog[open]"))
        lastOverflowFocus.focus?.();
      return true;
    }
    if (hasPopover()) {
      closePopovers?.();
      for (const node of popovers) node.hidden = true;
      expanded(false);
      if (!morePanel.hidden && lastOverflowFocus?.isConnected) lastOverflowFocus.focus?.();
      return true;
    }
    return closeMore({ focusReturn: true });
  };
  const onKeyDown = (event) => {
    if (!touch() || !["Escape", "BrowserBack", "GoBack"].includes(event.key) || !isOpen()) return;
    // The speed list has its own Arrow/Escape semantics and focus return.
    if (event.key === "Escape" && popovers.at(-1)?.hidden === false
        && popovers.at(-1)?.contains?.(event.target)) return;
    dismissTop();
    event.preventDefault?.();
    // Prevent an Escape handled here from also closing the floating player,
    // or a Back from navigating after dismissing only the panel.
    event.stopImmediatePropagation?.();
  };
  const onNavigate = () => { if (touch()) dismiss({ reason: "navigation" }); };
  const onControlsHidden = () => {
    // Choosing a track must not race the ordinary three-second chrome timer.
    // Keep the original audio menu and its parent controls interactive until
    // an explicit outside tap, Back or navigation closes it.
    if (touch() && frame.classList.contains("controls-hidden") &&
        (hasPopover() || !morePanel.hidden)) {
      frame.classList.remove("controls-hidden");
      return;
    }
    if (touch() && frame.classList.contains("controls-hidden"))
      // The ordinary three-second player chrome timer is NOT a request to
      // close a modal. It may fire while a person is reading/editing the
      // Appearance form or managing subtitle tracks. Only transient popovers
      // follow the chrome's auto-hide. Explicit outside/Back/navigation
      // dismissal still closes both dialogs and menus.
      dismiss({ reason: "controls-hidden", includeDialogs: false });
  };
  // Original nodes and listeners survive every fullscreen/resize cycle.
  const restoreRow = () => {
    if (!row || !rowInFullscreen) return;
    const focusBeforeRestore = doc.activeElement;
    const focusWasInOverflow = focusBeforeRestore === moreButton
      || morePanel.contains?.(focusBeforeRestore);
    rowInFullscreen = false;
    closeMore();
    if (hasPopover()) closePopovers?.();
    for (const node of originalRowChildren) {
      node.classList?.remove("phone-fullscreen-extra");
      row.append(node);
    }
    moreButton.remove?.();
    morePanel.remove?.();
    if (time && timeParent) {
      const siblings = [...(timeParent.childNodes || timeParent.children || [])].filter((node) => node !== time);
      const originalNextIsPresent = timeOriginalNextSibling &&
        (timeOriginalNextSibling.parentNode === timeParent || timeOriginalNextSibling.parentElement === timeParent);
      const before = originalNextIsPresent ? timeOriginalNextSibling : siblings[timeOriginalIndex] || null;
      if (before && timeParent.insertBefore) timeParent.insertBefore(time, before);
      else timeParent.append(time);
    }
    delete row.dataset.fullscreenSingleRow;
    if (focusWasInOverflow) doc.getElementById("player-fullscreen")?.focus?.();
    else if (focusBeforeRestore?.isConnected && originalRowChildren.some((node) =>
      node === focusBeforeRestore || node.contains?.(focusBeforeRestore))) focusBeforeRestore.focus?.();
  };
  const syncFullscreenRow = () => {
    if (!row || !touch()) return;
    if (!root.classList.contains("phone-player-fullscreen")) {
      restoreRow();
      return;
    }
    const rectWidth = Number(row.getBoundingClientRect?.().width) || Number(row.clientWidth)
      || Number(frame.clientWidth) || Math.max(0, Number(win.innerWidth) - 28);
    const target = Number(win.innerWidth) <= 360 ? 40 : 44;
    const budget = fullscreenPlayerRowBudget(rectWidth, { target });
    const focusedBeforeLayout = doc.activeElement;
    const byId = new Map(originalRowChildren.filter((node) => node.id).map((node) => [node.id, node]));
    // Reserve one full target for More before allocating visible actions.
    // At 320px the row fits five controls + More; audio moves into More.
    const inlineLimit = Math.max(0, budget.capacity - 1);
    const inline = new Set();
    const orderedEssentials = ["player-seek-back", "compat-play", "player-seek-forward",
      "player-fullscreen", "player-toggle-subs", "player-audio-switcher"];
    for (const id of orderedEssentials) {
      const node = byId.get(id);
      if (node && !node.hidden && inline.size < inlineLimit) inline.add(node);
    }
    const speed = originalRowChildren.find((node) => node.classList?.contains("player-speed"));
    const priority = [...FULLSCREEN_PRIORITY_CONTROLS.map((id) => byId.get(id)), speed].filter(Boolean);
    for (const node of priority) {
      if (inline.size >= inlineLimit) break;
      if (!node.hidden) inline.add(node);
    }
    if (time && timeline) timeline.append(time);
    controls.append(morePanel);
    translateUi(morePanel);
    translateUi(moreButton);
    for (const node of originalRowChildren) {
      node.classList?.toggle("phone-fullscreen-extra", !inline.has(node));
      if (inline.has(node)) row.append(node);
      else morePanel.append(node);
    }
    row.append(moreButton);
    moreButton.hidden = false;
    rowInFullscreen = true;
    if (morePanel.hidden === false && morePanel.children.length <= 1) closeMore({ focusReturn: true });
    if (focusedBeforeLayout === moreButton && moreButton.isConnected) moreButton.focus?.();
    if (focusedBeforeLayout?.isConnected && focusedBeforeLayout !== doc.activeElement) {
      const movedInline = [...inline].some((node) => node.contains?.(focusedBeforeLayout)
        || node === focusedBeforeLayout);
      if (movedInline || (!morePanel.hidden && morePanel.contains?.(focusedBeforeLayout)))
        focusedBeforeLayout.focus?.();
      else if (morePanel.hidden && originalRowChildren.some((node) => node.contains?.(focusedBeforeLayout)
        || node === focusedBeforeLayout)) moreButton.focus?.();
    }
    row.dataset.fullscreenSingleRow = "true";
  };
  const syncFullscreen = () => {
    if (disposed || !touch() || !root) return;
    // Android sets html.android-fullscreen. The web player may instead call
    // Element.requestFullscreen(), or fullscreen the video/ancestor, so look
    // at the document's real fullscreenElement rather than orientation.
    const full = root.classList.contains("android-fullscreen")
      || Boolean(doc.fullscreenElement || doc.webkitFullscreenElement);
    if (root.classList.contains("phone-player-fullscreen") !== full) {
      if (full) root.classList.add("phone-player-fullscreen");
      else root.classList.remove("phone-player-fullscreen");
    }
    syncFullscreenRow();
  };
  const onWatchChange = () => {
    if (watch && !watch.classList.contains("is-active")) dismiss({ reason: "view-left" });
  };
  const onDialogOpen = () => {
    if (!appearance?.open || !touch()) return;
    // Existing desktop form is the single source of truth, including all
    // eight settings and app.js localStorage persistence. Only scroll the
    // phone's control container; never clone/recreate or reset form values.
    if (appearanceControls) appearanceControls.scrollTop = 0;
  };
  const observer = win.MutationObserver ? new win.MutationObserver((records) => {
    for (const entry of records) {
      if (entry.target === frame) onControlsHidden();
      if (entry.target === watch) onWatchChange();
      if (entry.target === appearance) onDialogOpen();
      if (entry.target === root) syncFullscreen();
    }
  }) : null;
  observer?.observe(frame, { attributes: true, attributeFilter: ["class"] });
  if (watch) observer?.observe(watch, { attributes: true, attributeFilter: ["class", "hidden"] });
  if (appearance) observer?.observe(appearance, { attributes: true, attributeFilter: ["open"] });
  if (root) observer?.observe(root, { attributes: true, attributeFilter: ["class"] });
  doc.addEventListener("pointerdown", onPointerDown, true);
  doc.addEventListener?.("fullscreenchange", syncFullscreen);
  doc.addEventListener?.("webkitfullscreenchange", syncFullscreen);
  const onResize = () => { if (root?.classList.contains("phone-player-fullscreen")) syncFullscreenRow(); };
  win.addEventListener("resize", onResize);
  const resizeObserver = row && win.ResizeObserver ? new win.ResizeObserver(onResize) : null;
  resizeObserver?.observe?.(frame);
  win.addEventListener("keydown", onKeyDown, true);
  for (const type of ["popstate", "hashchange", "pagehide"]) win.addEventListener(type, onNavigate);
  // CSS is opt-in: imported stylesheet does not affect desktop unless this
  // actual phone lifecycle has been installed and matched a coarse pointer.
  root?.classList.add("phone-player-ui-ready");
  syncFullscreen();
  onDialogOpen();
  onControlsHidden();

  return Object.freeze({
    dismiss,
    isOpen,
    onControlsHidden,
    onNavigation: onNavigate,
    onAppearanceOpened: onDialogOpen,
    onFullscreenChange: syncFullscreen,
    onAndroidBack() { return touch() && isOpen() ? dismissTop() : false; },
    dispose() {
      if (disposed) return;
      dismiss({ reason: "dispose" });
      doc.removeEventListener("pointerdown", onPointerDown, true);
      doc.removeEventListener?.("fullscreenchange", syncFullscreen);
      doc.removeEventListener?.("webkitfullscreenchange", syncFullscreen);
      win.removeEventListener("resize", onResize);
      resizeObserver?.disconnect?.();
      win.removeEventListener("keydown", onKeyDown, true);
      for (const type of ["popstate", "hashchange", "pagehide"]) win.removeEventListener(type, onNavigate);
      observer?.disconnect();
      restoreRow();
      root?.classList.remove("phone-player-ui-ready");
      root?.classList.remove("phone-player-fullscreen");
      disposed = true;
    },
  });
}
