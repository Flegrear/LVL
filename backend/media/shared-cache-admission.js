// One in-process byte-reservation ledger for optional media cache writers.
// This supplements (never replaces) the storage owner's configured quota and
// source-download headroom check. An allowance snapshot alone is not atomic
// when remux, indexed, progressive and verified-source writers race.
import path from 'node:path';

const roots = new Map();

export function createSharedCacheReservation({ sessionsRoot, allowance }) {
  if (!path.isAbsolute(sessionsRoot || '') || typeof allowance !== 'function')
    throw Error('A scoped shared media cache allowance is required');
  const root = path.resolve(sessionsRoot).toLowerCase();
  let state = roots.get(root);
  if (!state) {
    state = { reserved: 0, tail: Promise.resolve() };
    roots.set(root, state);
  }
  let balance = 0;
  let closed = false;
  let cancelPending;
  const cancelled = new Promise(resolve => { cancelPending = resolve; });
  const lease = {
    async reserve(bytes) {
      if (closed || !Number.isSafeInteger(bytes) || bytes <= 0) return false;
      // Serialize the allowance read AND reservation write across producers.
      // A different writer must see this pending lease even if it has not
      // created its output file yet.
      const previous = state.tail;
      let unlock;
      state.tail = new Promise(resolve => { unlock = resolve; });
      // A cancelled writer may be waiting behind another pending allowance.
      // Return to its caller immediately, but leave its turn in the ledger
      // queue until the predecessor really finishes. Otherwise a later writer
      // could overtake a still-live predecessor's storage snapshot.
      const entered = await Promise.race([
        previous.then(() => true), cancelled.then(() => false),
      ]);
      if (!entered) {
        void previous.then(unlock);
        return false;
      }
      let activeAllowanceStillRunning = false;
      try {
        if (closed) return false;
        const request = state.reserved + bytes;
        if (!Number.isSafeInteger(request)) return false;
        // A quota callback that has ACTUALLY started may have side effects,
        // including a disk usage scan. Cancellation returns promptly to its
        // owner but cannot allow the next writer to overtake that callback.
        // Hold this ledger turn until the in-flight callback settles; then
        // retire it without ever granting bytes to a released lease.
        const settledAllowance = Promise.resolve().then(() => allowance(request))
          .then(gate => ({ gate }), () => ({ failed: true }));
        const outcome = await Promise.race([
          settledAllowance, cancelled.then(() => ({ cancelled: true })),
        ]);
        if (outcome.cancelled) {
          activeAllowanceStillRunning = true;
          void settledAllowance.then(() => unlock());
          return false;
        }
        if (closed) return false;
        if (outcome.failed) return false;
        const gate = outcome.gate;
        if (gate?.allowed !== true || (Number.isFinite(gate.availableBytes)
          && gate.availableBytes < request)) return false;
        state.reserved += bytes;
        balance += bytes;
        return true;
      } catch { return false; }
      finally {
        if (!activeAllowanceStillRunning) unlock();
      }
    },
    // Only consume after the writer reports bytes actually persisted to its
    // scoped cache path. Storage's usage scan now owns those physical bytes.
    consume(bytes) {
      if (closed || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > balance) return false;
      balance -= bytes;
      state.reserved -= bytes;
      return true;
    },
    release() {
      if (closed) return;
      closed = true;
      cancelPending();
      state.reserved -= balance;
      balance = 0;
    },
    get reservedBytes() { return balance; },
    get released() { return closed; },
  };
  return lease;
}
