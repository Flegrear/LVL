// Optional phone-player callbacks. Registered once at the app boundary so the
// shared player modules can cancel touch gestures without importing app.js.
let activeCallbacks = null;

export function registerPhonePlayerLifecycle({ cancelScrub = null, onControlsHidden = null } = {}) {
  const callbacks = {
    cancelScrub: typeof cancelScrub === "function" ? cancelScrub : null,
    onControlsHidden: typeof onControlsHidden === "function" ? onControlsHidden : null,
  };
  activeCallbacks = callbacks;
  // A later registration must not be removed by an older cleanup.
  return () => { if (activeCallbacks === callbacks) activeCallbacks = null; };
}

export function cancelPhoneTimelineScrub() {
  activeCallbacks?.cancelScrub?.();
}

export function notifyPhonePlayerControlsHidden() {
  activeCallbacks?.onControlsHidden?.();
}
