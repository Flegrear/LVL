// Android-only, per-torrent request-work scheduling. WebTorrent's synchronous
// _update -> _updateWireWrapper walks every peer on each piece-completion tick.
// Keeping the original _updateWire preserves all piece/selection/store rules.
const activeSchedulers = new WeakMap();

function inertHandle(reason) {
  return { enabled: false, supported: false, reason, dispose() {} };
}

export function attachTorrentRequestScheduler(torrent, {
  enabled = false,
  maxWiresPerTick = 4,
  maxTickMs = 6,
  schedule = setImmediate,
  cancel = clearImmediate,
  now = () => performance.now(),
} = {}) {
  if (!enabled) return inertHandle("disabled");
  if (!torrent || (typeof torrent !== "object" && typeof torrent !== "function"))
    return inertHandle("invalid_torrent");
  const current = activeSchedulers.get(torrent);
  if (current) return current;

  const originalUpdate = torrent._update;
  const originalWrapper = torrent._updateWireWrapper;
  const originalWire = torrent._updateWire;
  // Pin to the supported WebTorrent call shape rather than copying its private
  // piece-selection implementation. Unknown versions run wholly unchanged.
  if (torrent.destroyed || !Object.isExtensible(torrent) ||
      typeof originalUpdate !== "function" || typeof originalWrapper !== "function" ||
      typeof originalWire !== "function" ||
      !/this\._updateWireWrapper\s*\(/.test(Function.prototype.toString.call(originalUpdate)) ||
      !/this\.wires/.test(Function.prototype.toString.call(originalWrapper)) ||
      !/this\._updateWire\s*\(/.test(Function.prototype.toString.call(originalWrapper)))
    return inertHandle("unsupported_webtorrent_method_shape");
  if (!Number.isInteger(maxWiresPerTick) || maxWiresPerTick < 1 || maxWiresPerTick > 16 ||
      !Number.isFinite(maxTickMs) || maxTickMs <= 0 || maxTickMs > 20 ||
      typeof schedule !== "function" || typeof cancel !== "function" || typeof now !== "function")
    return inertHandle("invalid_scheduler_options");

  const updateDescriptor = Object.getOwnPropertyDescriptor(torrent, "_update");
  const wrapperDescriptor = Object.getOwnPropertyDescriptor(torrent, "_updateWireWrapper");
  if ((updateDescriptor && !updateDescriptor.configurable) ||
      (wrapperDescriptor && !wrapperDescriptor.configurable))
    return inertHandle("nonconfigurable_instance_method");

  let disposed = false;
  let pending = false;
  let scheduled = null;
  let round = null;
  let cursor = 0;
  let nextStart = 0;
  let dirty = false;

  function restore(key, ours, descriptor) {
    if (Object.getOwnPropertyDescriptor(torrent, key)?.value !== ours) return;
    if (descriptor) Object.defineProperty(torrent, key, descriptor);
    else delete torrent[key];
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (scheduled !== null) cancel(scheduled);
    scheduled = null;
    pending = false;
    dirty = false;
    round = null;
    torrent.removeListener?.("close", dispose);
    torrent.removeListener?.("error", dispose);
    restore("_update", requestUpdate, updateDescriptor);
    restore("_updateWireWrapper", requestWrapper, wrapperDescriptor);
    activeSchedulers.delete(torrent);
  }

  function queueTick() {
    if (disposed || scheduled !== null) return;
    scheduled = schedule(runTick);
  }

  function request() {
    if (disposed || torrent.destroyed) return;
    if (round !== null) dirty = true;
    else pending = true;
    queueTick();
  }

  function requestUpdate(...args) {
    if (this !== torrent || disposed) return Reflect.apply(originalUpdate, this, args);
    request(); // The pinned original _update has no synchronous result.
  }

  function requestWrapper(...args) {
    if (this !== torrent || disposed) return Reflect.apply(originalWrapper, this, args);
    request(); // Also covers direct wrapper callers.
  }

  function runTick() {
    scheduled = null;
    if (disposed || torrent.destroyed) { dispose(); return; }
    try {
      if (round === null) {
        if (!pending) return;
        pending = false;
        // One snapshot per round. The next round sees newly arrived wires.
        const wires = torrent.wires;
        if (!Array.isArray(wires)) throw new TypeError("WebTorrent wires changed shape");
        const start = wires.length ? nextStart % wires.length : 0;
        round = wires.slice(start).concat(wires.slice(0, start));
        nextStart = start + 1; // Rotate the first peer on every request round.
        cursor = 0;
      }
      const started = now();
      let attempted = 0;
      while (cursor < round.length && attempted < maxWiresPerTick &&
          (attempted === 0 || now() - started < maxTickMs)) {
        const wire = round[cursor++];
        attempted++;
        // Removed peers must never receive stale requests. The original method
        // still checks destroyed/choked status and the live piece selections.
        if (torrent.wires.includes(wire)) {
          Reflect.apply(originalWire, torrent, [wire]);
        }
        if (disposed || torrent.destroyed) { dispose(); return; }
      }
      if (cursor === round.length) {
        round = null;
        if (dirty) { dirty = false; pending = true; }
      }
      if (round !== null || pending) queueTick();
    } catch (error) {
      // A synchronous WebTorrent error has become asynchronous at this boundary.
      // Surface it on the torrent's existing error channel, then stop scheduling.
      dispose();
      // Disposal removes our own error listener. If no session owns the
      // torrent yet, EventEmitter would throw this error out of a later tick.
      // Only deliver it to an actual remaining owner.
      if (torrent.listenerCount?.("error") > 0) torrent.emit("error", error);
    }
  }

  const handle = { enabled: true, supported: true, reason: null, dispose };
  try {
    Object.defineProperty(torrent, "_update", {
      configurable: true, writable: true, enumerable: updateDescriptor?.enumerable ?? false,
      value: requestUpdate,
    });
    Object.defineProperty(torrent, "_updateWireWrapper", {
      configurable: true, writable: true, enumerable: wrapperDescriptor?.enumerable ?? false,
      value: requestWrapper,
    });
    torrent.once?.("close", dispose);
    torrent.once?.("error", dispose);
    activeSchedulers.set(torrent, handle);
  } catch {
    dispose();
    return inertHandle("instance_patch_failed");
  }
  return handle;
}
