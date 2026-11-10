// Warm the existing bounded server/browser image cache for the next chapters.
// This is deliberately sequential and byte-limited: a source can have very
// large pages and preloading must never compete without bounds with reading.
export const CHAPTER_PRELOAD_LIMITS = Object.freeze({
  maxChapters: 3,
  maxPagesPerChapter: 120,
  maxBytes: 128 * 1024 * 1024,
});

const live = (signal, isCurrent) => !signal?.aborted && isCurrent();

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
      try {
        const response = await fetchPage(chapter.readerId, at, signal);
        if (!live(signal, isCurrent)) return summary;
        if (!response?.ok || !/^image\//i.test(response.headers?.get?.("content-type") || "")) break;
        const declared = Number(response.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > maxBytes - summary.bytes) {
          await response.body?.cancel?.();
          summary.truncated = true;
          return summary;
        }
        // Drain one response and discard chunks. The server's image cache and
        // the HTTP Cache-Control header retain the bytes, not JavaScript memory.
        const stream = response.body?.getReader?.();
        let bytes = 0;
        if (stream) {
          while (live(signal, isCurrent)) {
            const { done, value } = await stream.read();
            if (done) break;
            bytes += value?.byteLength || 0;
            if (summary.bytes + bytes > maxBytes) {
              await stream.cancel().catch(() => {});
              summary.truncated = true;
              return summary;
            }
          }
          if (!live(signal, isCurrent)) { await stream.cancel().catch(() => {}); return summary; }
        } else {
          bytes = (await response.arrayBuffer()).byteLength;
          if (summary.bytes + bytes > maxBytes) { summary.truncated = true; return summary; }
        }
        summary.pages++;
        summary.bytes += bytes;
      } catch {
        // This chapter's source can be temporarily offline; don't retry or
        // trigger a different provider in the background.
        break;
      }
    }
  }
  return summary;
}
