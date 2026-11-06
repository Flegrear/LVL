// Phone-only player popover lifecycle. This module does not own playback,
// caption visibility, track selection, seeking, or the tap/double-tap gesture.
// Those actions stay in app.js / phone-layout / player-seeking.

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

// Keep a single fullscreen transport row. Secondary controls remain in the
// original DOM for ordinary playback; fullscreen does not expose an overflow
// drawer or download metrics.
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
  const originalRowChildren = row ? [...row.children] : [];
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

  const expanded = (value) => {
    for (const button of triggers) button?.setAttribute?.("aria-expanded", String(value));
  };
  const hasPopover = () => popovers.some((node) => !node.hidden);
  const hasDialog = () => Boolean(manager?.open || appearance?.open);
  const isOpen = () => hasPopover() || hasDialog();
  const dismiss = ({ includeDialogs = true, reason = "outside" } = {}) => {
    if (disposed) return false;
    const menusOpen = hasPopover();
    const dialogsOpen = includeDialogs && hasDialog();
    const hadOpen = menusOpen || dialogsOpen;
    if (!hadOpen) return false;
    // Delegate all ordinary menus to the existing shared close routine. Do
    // not alter the selected captions or saved appearance settings here.
    if (menusOpen) {
      closePopovers?.();
      for (const node of popovers) node.hidden = true;
      expanded(false);
    }
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
    if (nodeInside(event.target, [...popovers, ...triggers, manager, appearance])) return;
    // Do not intercept player taps or B's double tap/drag gestures. A
    // pointerdown on the video closes the menu immediately and still reaches
    // the existing video gesture controller.
    dismiss({ reason: event.target === video ? "video" : "outside" });
  };
  const onKeyDown = (event) => {
    if (!touch() || !["Escape", "BrowserBack", "GoBack"].includes(event.key) || !isOpen()) return;
    dismiss({ reason: "escape-or-back" });
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
        doc.getElementById("player-audio-menu")?.hidden === false) {
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
  // Keep original controls and their listeners/state. Only the timestamp moves
  // beside the fullscreen timeline; leaving fullscreen restores its parent.
  const restoreRow = () => {
    if (!row) return;
    for (const node of originalRowChildren) node.classList?.remove("phone-fullscreen-extra");
    if (time && timeParent) timeParent.append(time);
    delete row.dataset.fullscreenSingleRow;
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
    const byId = new Map(originalRowChildren.filter((node) => node.id).map((node) => [node.id, node]));
    const essential = FULLSCREEN_ESSENTIAL_CONTROLS.map((id) => byId.get(id)).filter(Boolean);
    const inline = new Set(essential);
    const speed = originalRowChildren.find((node) => node.classList?.contains("player-speed"));
    const priority = [...FULLSCREEN_PRIORITY_CONTROLS.map((id) => byId.get(id)), speed].filter(Boolean);
    for (const node of priority) {
      if (inline.size >= Math.max(essential.length, budget.capacity)) break;
      if (!node.hidden) inline.add(node);
    }
    if (time && timeline) timeline.append(time);
    for (const node of originalRowChildren)
      node.classList?.toggle("phone-fullscreen-extra", !inline.has(node));
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
    onAndroidBack() { return dismiss({ reason: "android-back" }); },
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
