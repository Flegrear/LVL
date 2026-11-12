// Warm the existing bounded server/browser image cache for the next chapters.
// This is deliberately sequential and byte-limited: a source can have very
// large pages and preloading must never compete without bounds with reading.
export const CHAPTER_PRELOAD_LIMITS = Object.freeze({
  maxChapters: 3,
  maxPagesPerChapter: 120,
  maxBytes: 128 * 1024 * 1024,
});

const live = (signal, isCurrent) => !signal?.aborted && isCurrent();

// Optional JSON lookups share the reader's cancellation lifetime. Foreground
// chapter opening keeps its independent API/retry path.
export async function requestChapterPreloadJson(url, { signal, fetcher = fetch } = {}) {
  if (signal?.aborted) return null;
  const timeout = AbortSignal.timeout(30_000);
  const combined = signal && typeof AbortSignal.any === "function"
    ? AbortSignal.any([signal, timeout]) : signal || timeout;
  const response = await fetcher(url, {
    signal: combined, headers: { Accept: "application/json" }, cache: "no-store", priority: "low",
  });
  if (combined.aborted) {
    void Promise.resolve(response?.body?.cancel?.()).catch(() => {});
    return null;
  }
  if (!response?.ok) {
    void Promise.resolve(response?.body?.cancel?.()).catch(() => {});
    throw Error("Chapter prefetch source unavailable");
  }
  return response.json();
}

// Resolve must return an already-verified { readerId, pages } or null. It is
// responsible for choosing the same linked provider, never just another copy.
// fetchPage returns the normal local /api/reader/... image HTTP Response.
export async function preloadChapterImages({ targets = [], resolve, fetchPage, signal,
  isCurrent = () => true, limits = CHAPTER_PRELOAD_LIMITS } = {}) {
  const summary = { chapters: 0, pages: 0, bytes: 0, truncated: false };
  if (typeof resolve !== "function" || typeof fetchPage !== "function") return summary;
  const maxChapters = Math.max(0, Math.min(3, Number(limits.maxChapters) || 0));
  const maxPages = Math.max(0, Math.min(200, Number(limits.maxPagesPerChapter) || 0));
  const maxBytes = Math.max(0, Math.min(256 * 1024 * 1024, Number(limits.maxBytes) || 0));
  if (!maxChapters || !maxPages || !maxBytes) return summary;
  for (const target of targets.slice(0, maxChapters)) {
    if (!live(signal, isCurrent)) break;
    let chapter;
    try { chapter = await resolve(target); } catch { continue; }
    if (!live(signal, isCurrent)) break;
    if (!chapter || !/^(?:f[0-9a-f]{16}|ex-[0-9a-f]{20})$/.test(chapter.readerId || "")) continue;
    const pages = Math.max(0, Math.floor(Number(chapter.pages) || 0));
    if (!pages) continue;
    summary.chapters++;
    if (pages > maxPages) summary.truncated = true;
    for (let at = 0; at < Math.min(pages, maxPages); at += 1) {
      if (!live(signal, isCurrent)) return summary;
      if (summary.bytes >= maxBytes) { summary.truncated = true; return summary; }
      let response = null;
      let stream = null;
      let onAbort = null;
      let completed = false;
      let canceled = false;
      const cancel = () => {
        if (canceled || completed) return;
        canceled = true;
        // The stream's reader owns the lock while reading. Do not wait for a
        // server's cancel acknowledgement before exiting optional preloading.
        try {
          const result = stream ? stream.cancel() : response?.body?.cancel?.();
          void Promise.resolve(result).catch(() => {});
        } catch { /* best-effort teardown */ }
      };
      try {
        response = await fetchPage(chapter.readerId, at, signal);
        if (!live(signal, isCurrent)) { cancel(); return summary; }
        if (!response?.ok || !/^image\//i.test(response.headers?.get?.("content-type") || "")) {
          cancel();
          break;
        }
        const declared = Number(response.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > maxBytes - summary.bytes) {
          cancel();
          summary.truncated = true;
          return summary;
        }
        // Drain one response and discard chunks. The server's image cache and
        // the HTTP Cache-Control header retain the bytes, not JavaScript memory.
        stream = response.body?.getReader?.();
        // Streaming exists on supported browsers. Never allocate a whole
        // untrusted image in an unbounded arrayBuffer fallback.
        if (!stream) { cancel(); break; }
        onAbort = () => cancel();
        signal?.addEventListener("abort", onAbort, { once: true });
        let bytes = 0;
        while (live(signal, isCurrent)) {
          const { done, value } = await stream.read();
          if (done) break;
          bytes += value?.byteLength || 0;
          if (summary.bytes + bytes > maxBytes) {
            cancel();
            summary.truncated = true;
            return summary;
          }
        }
        if (!live(signal, isCurrent)) { cancel(); return summary; }
        completed = true;
        summary.pages++;
        summary.bytes += bytes;
      } catch {
        // This chapter's source can be temporarily offline; don't retry or
        // trigger a different provider in the background.
        cancel();
        break;
      } finally {
        if (onAbort) signal?.removeEventListener("abort", onAbort);
        try { stream?.releaseLock?.(); } catch {}
      }
    }
  }
  return summary;
}
