// One admission owner for Home, title search, and stream provider fan-outs.
// Identical cold requests share their producer even when every distinct-key
// slot is occupied. An HTTP waiter never owns or cancels that shared producer.
// Completed results are cached by their respective catalog modules, not here.
export const MAX_COLD_PROVIDER_KEYS = 32;

export function createColdProviderAdmission({ maxDistinct = MAX_COLD_PROVIDER_KEYS } = {}) {
  const capacity = Number.isSafeInteger(maxDistinct) && maxDistinct > 0
    ? Math.min(maxDistinct, MAX_COLD_PROVIDER_KEYS) : MAX_COLD_PROVIDER_KEYS;
  const inFlight = new Map();
  return {
    run(key, producer) {
      if (typeof key !== "string" || !key || typeof producer !== "function")
        throw new TypeError("A cold provider request needs a distinct key and producer");
      const existing = inFlight.get(key);
      if (existing) return existing;
      if (inFlight.size >= capacity) {
        const error = new Error("Catalog providers are busy. Try again shortly.");
        error.statusCode = 503;
        error.retryAfterSeconds = 2;
        return Promise.reject(error);
      }
      // Register before invoking producer to make reentrant/concurrent callers
      // share a single owner. Provider failure and abort both release this key.
      const request = Promise.resolve().then(producer);
      inFlight.set(key, request);
      void request.finally(() => {
        // A settled request must never delete a newer generation's same key.
        if (inFlight.get(key) === request) inFlight.delete(key);
      }).catch(() => {});
      return request;
    },
    pendingCount() { return inFlight.size; },
  };
}

export const catalogProviderAdmission = createColdProviderAdmission();
