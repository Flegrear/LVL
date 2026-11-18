// FFmpeg may exit before its stdout, stderr and auxiliary speech pipe drain.
// Admission must retain ownership until the child closes, or until a known
// exited process has had every readable pipe explicitly drained/destroyed.
export function isTranscodeProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0); // Existence probe only: signal 0 never kills.
    return true;
  } catch (error) {
    // A permission error is not evidence that a process exited.
    return error?.code !== 'ESRCH';
  }
}

export function pruneExitedTranscodes(active, alive = isTranscodeProcessAlive) {
  let removed = 0;
  for (const job of active) {
    const knownExited = (job.exitCode !== null && job.exitCode !== undefined)
      || (job.signalCode !== null && job.signalCode !== undefined);
    const hasPid = Number.isSafeInteger(job.pid) && job.pid > 0;
    const pipes = [job.stdout, job.stderr, job.stdio?.[3]].filter(pipe =>
      pipe && typeof pipe.on === 'function');
    const drained = pipes.length > 0 && pipes.every(pipe =>
      pipe.readableEnded === true || pipe.destroyed === true);
    // A PID observation is never ownership proof (it can be recycled, and
    // exiting does not imply trailing media bytes have drained). Keep the
    // optional alive parameter for the legacy API, without using it to evict.
    if ((job.spawnFailure === true && !hasPid) || job.closeConfirmed === true
        || (knownExited && drained)) {
      active.delete(job);
      removed++;
    }
  }
  return removed;
}

// 'exit' proves the process ended, but Node may emit the last stdout data
// afterwards. FFprobe JSON is safe to parse only after 'close' drains stdio.
// A child whose process exited but whose pipes never close must still release
// its owner within a bounded interval, as a failed probe (never success).
export function waitForChildStdioDrain(child, {
  onError = () => {}, onTimeout = () => {}, timeoutMs = 0, afterExitMs = 2000,
} = {}) {
  return new Promise(resolve => {
    let settled = false;
    let timeout = null;
    let afterExit = null;
    let exited = false;
    let exitCode = null;
    const streams = [child.stdout, child.stderr].filter(stream =>
      stream && typeof stream.on === 'function');
    const noProcess = () => !Number.isSafeInteger(child.pid) || child.pid <= 0;
    const settle = code => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(afterExit);
      resolve(code);
    };
    const failUndrained = () => {
      if (settled) return;
      settle(null);
      // The child is known to have no process. Break orphaned pipe handles so
      // a never-closing stdio stream cannot pin shutdown or future probes.
      for (const stream of [child.stdout, child.stderr]) {
        try { stream?.destroy?.(); } catch {}
      }
    };
    const settleIfDrained = () => {
      // A real ChildProcess may delay 'close' while its process has exited.
      // A successful exit plus actual EOF on every readable stdio pipe is
      // equivalent proof of completed FFprobe output. Neither exit alone nor
      // stdout alone is sufficient; stderr must also have drained.
      if (exited && streams.length > 0
        && streams.every(stream => stream.readableEnded === true))
        settle(exitCode);
    };
    for (const stream of streams) stream.on('end', settleIfDrained);
    child.once('close', settle);
    child.once('exit', code => {
      if (settled) return;
      exited = true;
      exitCode = code;
      // The process is physically gone. Leave time for pipe drain without
      // allowing the wall timer to signal an exited (possibly reused) PID.
      clearTimeout(timeout);
      settleIfDrained();
      if (settled) return;
      afterExit = setTimeout(failUndrained, Math.max(1, afterExitMs));
      afterExit.unref?.();
    });
    // Keep the listener to absorb harmless late errors after a terminal event.
    child.on('error', error => {
      if (settled) return;
      try { onError(error); } catch {}
      if (noProcess()) failUndrained();
    });
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        if (settled) return;
        try { onTimeout(); } catch {}
        // A failed spawn has no physical process and may omit both events.
        // A running child stays owned until 'exit' or 'close' proves teardown.
        if (noProcess()) failUndrained();
      }, timeoutMs);
      timeout.unref?.();
    }
  });
}
