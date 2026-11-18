// Browser decoder feedback is the only evidence that a structurally complete
// image is not actually displayable. No codec magic/footer check can prove it.
// Exactly one remote-cache repair is allowed per page load, after inspecting
// an independently downloaded, bounded image with a verified incarnation.
const MAX_FEEDBACK_IMAGE = 25 * 1024 * 1024;
const REMOTE_PAGE = /^\/api\/reader\/remote\/ex-[0-9a-f]{20}\/pages\/\d{1,4}$/;
const INCARNATION = /^[0-9a-f]{24}$/;

async function boundedImageBlob(response) {
  const stream = response.body?.getReader?.();
  if (!stream) {
    const blob = await response.blob();
    return blob.size <= MAX_FEEDBACK_IMAGE ? blob : null;
  }
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await stream.read();
      if (done) break;
      bytes += value?.byteLength || 0;
      if (bytes > MAX_FEEDBACK_IMAGE) {
        void Promise.resolve(stream.cancel()).catch(() => {});
        return null;
      }
      chunks.push(value);
    }
    return new Blob(chunks, { type: response.headers?.get?.("content-type") || "application/octet-stream" });
  } finally {
    try { stream.releaseLock(); } catch {}
  }
}

export async function decodeReaderImageBlob(blob) {
  if (typeof createImageBitmap === "function") {
    const decoded = await createImageBitmap(blob);
    try { if (!decoded.width || !decoded.height) throw Error("Empty image decode"); }
    finally { decoded.close?.(); }
    return;
  }
  // Old WebViews may lack createImageBitmap. Image.decode still forces the
  // actual browser raster decoder, not just an HTTP or container-length check.
  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = objectUrl;
    if (typeof image.decode === "function") {
      await image.decode();
    } else {
      await new Promise((resolve, reject) => {
        if (image.complete) return image.naturalWidth ? resolve() : reject(Error("Image decode failed"));
        image.addEventListener("load", resolve, { once: true });
        image.addEventListener("error", () => reject(Error("Image decode failed")), { once: true });
      });
    }
    if (!image.naturalWidth || !image.naturalHeight) throw Error("Empty image decode");
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export async function loadPageWithCacheRecovery(pageUrl, { loadImage,
  fetchImpl = globalThis.fetch, decodeBlob = decodeReaderImageBlob, signal } = {}) {
  if (typeof loadImage !== "function") throw TypeError("Reader image loader missing");
  try { return await loadImage(pageUrl); }
  catch (firstFailure) {
    if (signal?.aborted || !REMOTE_PAGE.test(pageUrl)) throw firstFailure;
    let response;
    try {
      response = await fetchImpl(pageUrl, { cache: "no-store",
        headers: { Accept: "image/*" }, signal });
    } catch { throw firstFailure; }
    if (!response?.ok || signal?.aborted) {
      try { await response?.body?.cancel?.(); } catch {}
      throw firstFailure;
    }
    const incarnation = response.headers?.get?.("X-LVL-Image-Incarnation") || "";
    const length = Number(response.headers?.get?.("content-length"));
    if (!INCARNATION.test(incarnation) || (Number.isFinite(length) && length > MAX_FEEDBACK_IMAGE)) {
      try { await response.body?.cancel?.(); } catch {}
      throw firstFailure;
    }
    let blob;
    try { blob = await boundedImageBlob(response); } catch { throw firstFailure; }
    if (signal?.aborted || !blob || blob.size < 16 || blob.size > MAX_FEEDBACK_IMAGE)
      throw firstFailure;
    let decoded = false;
    try { await decodeBlob(blob); decoded = true; }
    catch { /* only a verified decoder failure authorizes repair */ }
    if (decoded) {
      // The independently fetched incarnation decoded successfully; treat
      // the original img failure as transient. Retry image load once, without
      // evicting an otherwise good cache incarnation.
      return await loadImage(`${pageUrl}?reader-retry=1`);
    }
    // The independent browser decoder rejected this *exact observed*
    // incarnation. The server compares it to its current pointer and only
    // refetches if unchanged. A second decode failure surfaces normally.
    if (signal?.aborted) throw firstFailure;
    return loadImage(`${pageUrl}?cache-recover=${incarnation}`);
  }
}
