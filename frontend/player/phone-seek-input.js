// Phone seek input is deliberately UI-only. The existing movie-clock seekPlayerTo
// remains the sole authority for remux/MSE/keyframe/audio/subtitle transitions.
// No new HTTP request is made by a preview. Call dispose on source/view teardown.
const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const clamp = (value, max) => Math.max(0, Math.min(Math.max(0, number(max)), number(value)));

export function createTimelineScrubController({
  range, frame = globalThis.window,
  onPreview, onCommit, onScrubbingChange = () => {},
  cancelObsoleteSeek = () => {},
  onHidePreview = () => {},
  scheduleFrame = callback => frame.requestAnimationFrame(callback),
  cancelFrame = id => frame.cancelAnimationFrame(id),
} = {}) {
  if (!range || typeof onPreview !== "function" || typeof onCommit !== "function"
      || typeof scheduleFrame !== "function" || typeof cancelFrame !== "function")
    throw new TypeError("Timeline scrub needs range, preview, commit and animation frame callbacks");
  let active = false, pointerId = null, scheduled = null, pending = null;
  let transaction = 0, lastCommit = null, disposed = false, ignoreChange = false;
  let finishing = false, committing = false, restoredRangeValue = null;
  const value = () => clamp(range.value, range.max);
  const drain = () => {
    scheduled = null;
    if (disposed || pending === null) return;
    const next = pending;
    pending = null;
    onPreview(next);
  };
  const preview = seconds => {
    pending = clamp(seconds, range.max);
    if (scheduled === null) scheduled = scheduleFrame(drain);
  };
  const begin = (id = null) => {
    if (disposed || active) return false;
    transaction++;
    active = true;
    ignoreChange = false;
    restoredRangeValue = null;
    pointerId = id;
    lastCommit = null;
    onScrubbingChange(true);
    preview(value());
    return true;
  };
  const finish = (commit = true) => {
    if (disposed || !active) return false;
    // Real onHidePreview calls updateCompatControls() after scrubbing becomes
    // false. That writes the OLD movie clock back into range.value. Capture
    // the user's selected destination before invoking either lifecycle hook.
    const target = commit ? value() : null;
    const finishingTransaction = transaction;
    active = false;
    pointerId = null;
    finishing = true;
    try {
      onScrubbingChange(false);
      if (scheduled !== null) { cancelFrame(scheduled); scheduled = null; }
      pending = null;
      onHidePreview();
      if (commit && !disposed && transaction === finishingTransaction && !ignoreChange)
        doCommit(target);
      else if (!commit) ignoreChange = true;
      if (commit && !disposed && transaction === finishingTransaction && !ignoreChange) {
        // pointerup -> native change is common on Android. If a lifecycle
        // callback restored the old clock, its synthetic/late change is NOT
        // a second user seek. Distinct change-only accessibility targets are.
        const after = value();
        restoredRangeValue = Math.abs(after - target) >= 0.0005 ? after : null;
      }
    } finally {
      finishing = false;
    }
    return true;
  };
  const doCommit = seconds => {
    const target = clamp(seconds, range.max);
    if (lastCommit && lastCommit.transaction === transaction && Math.abs(lastCommit.seconds - target) < 0.0005)
      return false;
    lastCommit = { transaction, seconds: target };
    const committedTransaction = transaction;
    // A cancelled finger drag must not kill the outgoing playable stream.
    // Only an actual committed target invalidates the previous seek attempt.
    committing = true;
    try {
      cancelObsoleteSeek();
      onCommit(target);
    } finally {
      committing = false;
      if (!disposed && transaction === committedTransaction && !ignoreChange) {
        // A commit callback can also repaint the native range (possibly
        // restoring the pre-seek clock while the media source reopens).
        // Quarantine that value until a fresh user input or changed target.
        const after = value();
        restoredRangeValue = Math.abs(after - target) >= 0.0005 ? after : null;
      }
    }
    return true;
  };
  const onPointerDown = event => {
    if (event.isPrimary === false || active || (event.button !== undefined && event.button !== 0)) return;
    begin(event.pointerId ?? null);
  };
  const matching = event => pointerId === null || event.pointerId === pointerId;
  const onPointerUp = event => { if (active && matching(event)) finish(true); };
  const onPointerCancel = event => { if (active && matching(event)) finish(false); };
  const onInput = () => {
    if (!active) begin(null); // native range keyboard and browser without pointer events
    preview(value());
  };
  const onChange = () => {
    if (finishing || committing || disposed) return;
    if (active) finish(true);
    else if (!ignoreChange) {
      const target = value();
      // The released thumb can be overwritten by updateCompatControls before
      // Chromium dispatches its terminal change. Ignore that restored value,
      // but do not suppress the NEXT genuinely different change-only action.
      if (restoredRangeValue !== null && Math.abs(target - restoredRangeValue) < 0.0005) return;
      if (restoredRangeValue !== null && lastCommit?.transaction === transaction
          && Math.abs(target - lastCommit.seconds) < 0.0005) return;
      // Even if Chromium repeats the committed thumb value before the old
      // playback clock, keep the old-clock guard until a NEW target appears.
      restoredRangeValue = null;
      // Some accessibility/native range controls dispatch only "change".
      // doCommit itself suppresses a duplicate at the same target in this
      // transaction, but a DIFFERENT target is a new action even without
      // pointerdown/input. Comparing transaction alone silently ate all
      // subsequent change-only seeks.
      doCommit(target);
    }
  };
  const onBlur = () => { if (active) finish(false); };
  const onMove = event => {
    if (!active || !matching(event)) return;
    preview(value()); // never read layout or compute subtitles during pointermove
  };
  const observers = [
    [range, "pointerdown", onPointerDown],
    [range, "pointermove", onMove],
    [range, "input", onInput],
    [range, "change", onChange],
    [range, "blur", onBlur],
    [frame, "pointerup", onPointerUp],
    [frame, "pointercancel", onPointerCancel],
  ];
  for (const [node, name, callback] of observers) node.addEventListener(name, callback);
  return Object.freeze({
    get scrubbing() { return active; },
    preview, begin, finish,
    cancel() {
      if (active) finish(false);
      else {
        if (scheduled !== null) cancelFrame(scheduled);
        scheduled = null; pending = null;
        onHidePreview();
      }
      transaction++;
      lastCommit = null;
      restoredRangeValue = null;
      ignoreChange = true; // late native change from cancelled source must not seek
    },
    dispose() {
      if (disposed) return;
      this.cancel();
      disposed = true;
      for (const [node, name, callback] of observers) node.removeEventListener(name, callback);
    },
  });
}

export function createDoubleTapSeekController({
  surface, backButton, forwardButton, onSingleTap,
  frame = globalThis.window, now = () => Date.now(),
  setTimer = (fn, ms) => frame.setTimeout(fn, ms),
  clearTimer = id => frame.clearTimeout(id),
  doubleTapMs = 280, moveTolerancePx = 18, pairTolerancePx = 92,
} = {}) {
  if (!surface || !backButton || !forwardButton || typeof onSingleTap !== "function")
    throw new TypeError("Double-tap controller requires video surface, real seek buttons and single tap handler");
  let pending = null, timer = null, press = null, disposed = false, ignoreUntil = 0;
  let fingers = new Set();
  const zone = x => {
    const rect = surface.getBoundingClientRect();
    if (!rect.width) return "center";
    const ratio = (x - rect.left) / rect.width;
    return ratio < 0.38 ? "left" : ratio > 0.62 ? "right" : "center";
  };
  const clearPending = () => {
    if (timer !== null) clearTimer(timer);
    timer = null; pending = null;
  };
  const fireSingle = () => {
    const single = pending;
    clearPending();
    if (single) onSingleTap();
  };
  const onDown = event => {
    if (disposed || (event.pointerType !== "touch" && event.pointerType !== "pen")
      || (event.button !== undefined && event.button !== 0)) return;
    fingers.add(event.pointerId);
    if (fingers.size > 1 || event.isPrimary === false) {
      press = null; clearPending(); return;
    }
    if (event.target !== surface) { press = null; clearPending(); return; }
    press = { id: event.pointerId, x: event.clientX, y: event.clientY,
      at: now(), zone: zone(event.clientX), cancelled: false };
  };
  const onMove = event => {
    if (!press || event.pointerId !== press.id) return;
    if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > moveTolerancePx)
      press.cancelled = true;
  };
  const onEnd = event => {
    if (event.pointerType !== "touch" && event.pointerType !== "pen") return;
    fingers.delete(event.pointerId);
    if (!press || event.pointerId !== press.id) return;
    const start = press;
    press = null;
    if (event.type === "pointercancel" || start.cancelled || fingers.size
        || Math.hypot(event.clientX - start.x, event.clientY - start.y) > moveTolerancePx) {
      clearPending(); return;
    }
    const endAt = now(), side = zone(event.clientX);
    if (side !== start.zone || endAt - start.at > 850) { clearPending(); return; }
    ignoreUntil = endAt + 650; // consume synthesized clicks, never toggle controls via the click path
    if (pending && pending.zone === side && side !== "center"
        && endAt - pending.at <= doubleTapMs
        && Math.abs(pending.x - event.clientX) <= pairTolerancePx) {
      clearPending();
      // Exactly the button's existing action; preserves configured delta and repeated taps.
      (side === "left" ? backButton : forwardButton).click();
      return;
    }
    if (pending) fireSingle();
    pending = { zone: side, x: event.clientX, at: endAt };
    timer = setTimer(fireSingle, doubleTapMs);
  };
  const onClick = event => {
    if (disposed || now() > ignoreUntil || event.detail === 0) return;
    event.preventDefault?.();
    event.stopImmediatePropagation?.();
  };
  const observe = [
    [surface, "pointerdown", onDown, true],
    [surface, "pointermove", onMove, true],
    [frame, "pointerup", onEnd, true],
    [frame, "pointercancel", onEnd, true],
    [surface, "click", onClick, true],
  ];
  for (const [target, kind, handler, capture] of observe) target.addEventListener(kind, handler, capture);
  return Object.freeze({
    cancel() { press = null; fingers.clear(); clearPending(); },
    dispose() {
      if (disposed) return;
      this.cancel(); disposed = true;
      for (const [target, kind, handler, capture] of observe) target.removeEventListener(kind, handler, capture);
    },
  });
}
