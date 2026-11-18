// Bounded, repeatable handoff for the server owner's shutdown path. The server
// owns signal handlers and its listen socket; this module owns only the exact
// resource objects passed at creation. It never exits the process.

let admissionClosed = false;
export function mediaAdmissionsClosed() { return admissionClosed; }

// The main server owns its foreground transcode Set. Metadata FFprobe and
// subtitle FFmpeg are separate producers: register their *actual* child
// objects before returning to the event loop so shutdown can stop and drain
// them even when an HTTP request has already gone away.
const ownedMediaChildren = new Set();
export function registerMediaShutdownChild(child) {
  if (!child || typeof child.once !== 'function') throw new TypeError('Expected an owned media child');
  if (admissionClosed) {
    // A spawn racing the final admission check is still ours to retire.
    void stopChild(child, 2500);
    return false;
  }
  ownedMediaChildren.add(child);
  child.once('close', () => {
    child.closeConfirmed = true;
    ownedMediaChildren.delete(child);
  });
  child.once('error', () => {
    if (Number.isSafeInteger(child.pid) && child.pid > 0) return;
    child.spawnFailure = true;
    ownedMediaChildren.delete(child);
  });
  return true;
}
export function mediaShutdownChildCount() { return ownedMediaChildren.size; }

function stopChild(child, timeoutMs) {
  return new Promise(resolve => {
    if (!child || child.closeConfirmed === true || child.spawnFailure === true) {
      resolve(true);
      return;
    }
    let settled = false;
    let killTimer = null;
    let deadline = null;
    const complete = closed => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      clearTimeout(deadline);
      child.off?.('close', onClose);
      child.off?.('error', onError);
      resolve(closed);
    };
    const onClose = () => { child.closeConfirmed = true; complete(true); };
    const onError = () => {
      if (!Number.isSafeInteger(child.pid) || child.pid <= 0) complete(true);
    };
    child.once?.('close', onClose);
    child.on?.('error', onError);
    try { if (child.exitCode == null && child.signalCode == null) child.kill?.('SIGTERM'); } catch {}
    // After cancellation there is no response consumer left to drain paused
    // media output. Read to EOF to allow ChildProcess 'close' to arrive.
    const pipes = [child.stdout, child.stderr, child.stdio?.[3]]
      .filter(pipe => pipe && typeof pipe.on === 'function');
    for (const pipe of pipes) {
      try { pipe.resume?.(); } catch {}
    }
    killTimer = setTimeout(() => {
      if (child.exitCode == null && child.signalCode == null) {
        try { child.kill?.('SIGKILL'); } catch {}
      } else {
        // A confirmed exited child can still hold a never-ending synthetic
        // pipe. Break those handles without ever signalling a recycled PID.
        for (const pipe of pipes) {
          if (!pipe.readableEnded && !pipe.destroyed) try { pipe.destroy?.(); } catch {}
        }
      }
    }, Math.min(2000, Math.max(100, timeoutMs / 2)));
    deadline = setTimeout(() => complete(false), timeoutMs);
    killTimer.unref?.();
    deadline.unref?.();
  });
}

export function createMediaResourceShutdown({
  popupWindow = null, popupProgram = null, activeTranscodes = null,
  torrentSessions = null, removeTorrentSession = null,
  drainBorrowers = [],
  timeoutMs = 6500,
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30_000)
    throw new RangeError('Invalid bounded media shutdown timeout');
  let operation = null;
  return function shutdownMediaResources() {
    if (operation) return operation;
    // Reserve the singleton synchronously, before any async disposal begins.
    // All participating admission paths consult this gate after their own
    // awaits; it must close before the first cancellation starts.
    admissionClosed = true;
    const tracked = [...ownedMediaChildren];
    const children = [...new Set([...(activeTranscodes || []), ...tracked])];
    const sessions = [...(torrentSessions || [])];
    const drains = [...drainBorrowers];
    operation = (async () => {
      const popupStop = Promise.resolve().then(() => popupWindow?.dispose?.() ?? popupWindow?.stop?.() ?? true);
      const programStop = Promise.resolve().then(() => popupProgram?.dispose?.() ?? true);
      const childStops = children.map(child => stopChild(child, timeoutMs));
      const sessionStops = sessions.map(([id, session]) => Promise.resolve().then(() => {
        // Recheck at the mutating boundary, after pending microtasks. An
        // Android download ID may already represent a newer incarnation.
        if (!removeTorrentSession || torrentSessions?.get(id) !== session) return true;
        return removeTorrentSession(id);
      }));
      const borrowerStops = drains.map(drain => Promise.resolve().then(() => drain()));
      const all = Promise.allSettled([popupStop, programStop, ...childStops, ...sessionStops, ...borrowerStops]);
      let timer;
      const expired = new Promise(resolve => {
        timer = setTimeout(() => resolve(null), timeoutMs);
        timer.unref?.();
      });
      const results = await Promise.race([all, expired]);
      clearTimeout(timer);
      return {
        complete: Array.isArray(results) && results.every(value =>
          value.status === 'fulfilled' && value.value !== false && value.value?.complete !== false),
        childCount: children.length,
        registeredChildCount: tracked.length,
        confirmedChildren: Array.isArray(results) ? childStops.filter((_, i) =>
          results[i + 2]?.status === 'fulfilled' && results[i + 2].value === true).length : 0,
        sessionCount: sessions.length,
        borrowerDrainCount: drains.length,
        timedOut: !results,
      };
    })();
    return operation;
  };
}
