// Only images from a short reading window are decoded. Completion order is
// independent from reading order: a later image cannot appear past a missing
// preceding one, even when the provider/browser finishes requests out of order.
export function readerPageAtOffset(first, last, offset, pageBottom) {
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first > last) return null;
  let low = first, high = last;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (pageBottom(mid) > offset) high = mid;
    else low = mid + 1;
  }
  return low;
}

export function createOrderedReaderPages({
  pages, start = 0, load, onReveal, onBlocked = () => {}, onRelease = () => {},
  ahead = 2, behind = 4,
} = {}) {
  if (!Number.isSafeInteger(pages) || pages < 1 || typeof load !== "function" || typeof onReveal !== "function")
    throw new TypeError("Ordered reader requires a positive page count, load and reveal callbacks");
  const maxAhead = Math.min(3, Math.max(0, Math.trunc(ahead)));
  const maxBehind = Math.min(8, Math.max(0, Math.trunc(behind)));
  const valid = (n) => Number.isSafeInteger(n) && n >= 0 && n < pages;
  if (!valid(start)) throw new RangeError("Invalid reader start page");

  let closed = false;
  let position = start;
  let frontier = start;
  let lastBlocked = null;
  const entries = new Map();

  function release(n, entry) {
    entry.controller?.abort();
    if (entry.value) onRelease(n, entry.value);
    entries.delete(n);
  }

  function notifyBlocked() {
    if (closed || frontier >= pages) return;
    const entry = entries.get(frontier);
    const error = entry?.status === "failed" ? entry.error : null;
    if (lastBlocked?.page === frontier && lastBlocked?.error === error) return;
    lastBlocked = { page: frontier, error };
    onBlocked(frontier, error);
  }

  function drain() {
    while (!closed && frontier < pages) {
      const entry = entries.get(frontier);
      if (!entry || entry.status !== "loaded") break;
      entry.status = "visible";
      onReveal(frontier, entry.value);
      if (closed) return; // a wide page can synchronously rebuild the spread
      frontier++;
    }
    notifyBlocked();
  }

  function startLoad(n) {
    const controller = new AbortController();
    const entry = { status: "loading", controller, value: null, error: null };
    entries.set(n, entry);
    // Call synchronously: the first requested image is the chapter's first
    // unresolved page, ahead of any speculative requests.
    let promise;
    try { promise = load(n, controller.signal); }
    catch (error) { promise = Promise.reject(error); }
    Promise.resolve(promise).then((value) => {
      if (closed || entries.get(n) !== entry || controller.signal.aborted) {
        if (value) onRelease(n, value);
        return;
      }
      entry.value = value;
      entry.status = "loaded";
      if (n < frontier) {
        entry.status = "visible"; // a page previously read and evicted
        onReveal(n, value);
      } else drain();
      if (!closed) pump();
    }, (error) => {
      if (closed || entries.get(n) !== entry || controller.signal.aborted) return;
      entry.status = "failed";
      entry.error = error instanceof Error ? error : Error(String(error || "Page unavailable"));
      notifyBlocked();
    });
  }

  function prune() {
    for (const [n, entry] of entries) {
      if (n < position - maxBehind || n > position + maxAhead) release(n, entry);
    }
  }

  function pump() {
    if (closed) return;
    prune();
    for (let n = position; n <= Math.min(pages - 1, position + maxAhead); n++) {
      if (!entries.has(n)) startLoad(n);
    }
  }

  function progress(n) {
    // Scroll/resize/restore events never bypass an unresolved predecessor.
    if (closed || !valid(n) || n >= frontier) return false;
    position = n;
    pump();
    return true;
  }

  function jump(n) {
    // An explicit slider/thumbnail/route navigation owns a new start page.
    if (closed || !valid(n)) return false;
    for (const [index, entry] of entries) release(index, entry);
    position = n;
    frontier = n;
    lastBlocked = null;
    notifyBlocked();
    pump();
    return true;
  }

  function retry(n) {
    if (closed || !valid(n)) return false;
    const entry = entries.get(n);
    if (!entry || entry.status !== "failed" || (n >= frontier && n !== frontier)) return false;
    release(n, entry);
    lastBlocked = null;
    notifyBlocked();
    startLoad(n);
    return true;
  }

  function close() {
    if (closed) return;
    closed = true;
    for (const [n, entry] of entries) release(n, entry);
    lastBlocked = null;
  }

  notifyBlocked();
  pump();
  return {
    progress, jump, retry, close,
    get visibleThrough() { return frontier - 1; },
    get blockingPage() { return frontier < pages ? frontier : null; },
    get retained() { return entries.size; },
    get currentPosition() { return position; },
    get isClosed() { return closed; },
  };
}
