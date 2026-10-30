// FFmpeg can exit on Windows while Node still waits for an extra stdio pipe
// to close. Count live encoder processes, not ChildProcess objects whose
// close event is still pending. This is an admission-time safety net; normal
// close handlers still own cache finalization and response drain.
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
    if (knownExited || (hasPid && !alive(job.pid))) {
      active.delete(job);
      removed++;
    }
  }
  return removed;
}
