// Visible AniList catalog portraits only. The existing image is authoritative
// until a same-ID local MangaDex proxy cover fully decodes and has more pixels.
// Library, provider, pinned and local artwork never receive this marker.
const ANILIST_IMAGE = /^https:\/\/s\d+\.anilist\.co\/file\/anilistcdn\/media\/manga\/cover\/[^\s?#]+\.(?:jpe?g|png|webp)$/i;
const MAX_SCAN = 160;
const MAX_PER_MOUNT = 24;
const MAX_REQUESTS = 2;
const MAX_WAITING = 32;
const MAX_WAIT_MS = 20_000;
const MAX_RESPONSE = 2 * 1024 * 1024;
const POSITIVE_MS = 30 * 60_000;
const NEGATIVE_MS = 10 * 60_000;
const ERROR_MS = 60_000;
const cache = new Map();
const mounted = new WeakMap();
const owners = new WeakMap();
const activeMounts = new Set();
const jobs = new Map();
const waiting = [];
let requests = 0;

export function catalogArtworkMark(anilistId, cover) {
  const id = Number(anilistId);
  const url = String(cover || "");
  return Number.isSafeInteger(id) && id > 0 && id <= 9_999_999_999 && ANILIST_IMAGE.test(url)
    ? { id: String(id), url } : null;
}

const canUse = (image) => image?.isConnected
  && image.getAttribute("data-comics-art-original") === image.getAttribute("src")
  && image.getAttribute("src") === image.currentSrc
  && image.complete && image.naturalWidth > 0;

function save(key, value, ms) {
  cache.delete(key);
  cache.set(key, { value, until: Date.now() + ms });
  // Cached Blob values are bounded by the backend's 2 MiB cap. Retain at
  // most 16 candidate images across all Home/browse shelves (~32 MiB worst case).
  while (cache.size > 16) cache.delete(cache.keys().next().value);
}

// The local route takes only an integer ID. No arbitrary remote URL or browser
// MangaDex access is permitted; the backend verifies the exact AniList crosswalk.
export async function decodeArtworkCandidate(id, {
  fetchImpl = globalThis.fetch, ImageImpl = globalThis.Image,
  urlApi = globalThis.URL, timeoutMs = 19_000,
} = {}) {
  const signal = AbortSignal.timeout(timeoutMs);
  const response = await fetchImpl(`/api/comics/work/anilist-${id}/artwork`, {
    method: "GET", headers: { Accept: "image/jpeg,image/png,image/webp" },
    signal, cache: "default",
  });
  if (!response.ok) throw Object.assign(new Error("Cover unavailable"), { status: response.status });
  const type = String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!["image/jpeg", "image/png", "image/webp"].includes(type)) throw new Error("Unexpected image MIME");
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > MAX_RESPONSE) throw new Error("Oversize cover");
  // A local proxy is also subject to a client-side streaming size cap, even
  // when Content-Length is absent or misleading.
  const pieces = [];
  let received = 0;
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing cover response body");
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_RESPONSE) throw new Error("Oversize cover");
      pieces.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const blob = new Blob(pieces, { type });
  if (blob.size > MAX_RESPONSE || !blob.size || blob.type && blob.type !== type) throw new Error("Invalid cover bytes");
  const objectUrl = urlApi.createObjectURL(blob);
  try {
    const probe = new ImageImpl();
    probe.src = objectUrl;
    await Promise.race([probe.decode(), new Promise((_, reject) => {
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })]);
    const width = Number(probe.naturalWidth);
    const height = Number(probe.naturalHeight);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 100 || height < 100
      || width > 8192 || height > 12000 || width / height < 0.4 || width / height > 1.2)
      throw new Error("Invalid image dimensions");
    // Reuse these exact verified bytes for presentation. Pointing the mounted
    // image back at the HTTP endpoint would make a second real GET in Edge.
    return { width, height, blob };
  } finally {
    urlApi.revokeObjectURL(objectUrl);
  }
}

function drainRequests() {
  while (requests < MAX_REQUESTS && waiting.length) {
    const job = waiting.shift();
    if (jobs.get(job.id) !== job) continue;
    if (Date.now() - job.created > MAX_WAIT_MS || ![...job.waiters].some(signal => !signal?.aborted)) {
      jobs.delete(job.id);
      job.resolve(null);
      continue;
    }
    requests++;
    // Queueing and HTTP/stream/decode share one 20-second wall-clock budget.
    // A cover waited 15s gets at most 5s of remaining network/decode time.
    const remainingMs = Math.max(1, Math.min(19_000, job.created + MAX_WAIT_MS - Date.now()));
    void decodeArtworkCandidate(job.id, { timeoutMs: remainingMs }).then(value => {
      save(job.id, value, POSITIVE_MS);
      job.resolve(value);
    }).catch(error => {
      // 404 means no exact verified cover. Offline, rate limits and server
      // timeouts are retried after a short pause, without a 10-minute miss.
      save(job.id, null, error?.status === 404 ? NEGATIVE_MS : ERROR_MS);
      job.resolve(null);
    }).finally(() => {
      jobs.delete(job.id);
      requests--;
      drainRequests();
    });
  }
}

async function candidateFor(id, signal) {
  const previous = cache.get(id);
  if (previous?.until > Date.now()) {
    cache.delete(id);
    cache.set(id, previous);
    return previous.value;
  }
  if (signal?.aborted) return null;
  let job = jobs.get(id);
  if (!job) {
    if (waiting.length >= MAX_WAITING) return null;
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    job = { id, created: Date.now(), promise, resolve, waiters: new Set() };
    jobs.set(id, job);
    waiting.push(job);
  }
  job.waiters.add(signal);
  signal?.addEventListener("abort", () => job.waiters.delete(signal), { once: true });
  drainRequests();
  return signal ? Promise.race([job.promise, new Promise(resolve => {
    signal.addEventListener("abort", () => resolve(null), { once: true });
  })]) : job.promise;
}

function creditMangaDex(image) {
  const holder = image.closest(".anime-browser-art, .ui-card__media");
  if (!holder || holder.querySelector("[data-comics-cover-credit]")) return null;
  const credit = image.ownerDocument.createElement("small");
  credit.setAttribute("data-comics-cover-credit", "");
  credit.textContent = "MangaDex";
  credit.title = "Cover artwork via MangaDex";
  credit.style.cssText = "position:absolute;right:3px;bottom:3px;z-index:5;pointer-events:none;background:rgba(0,0,0,.85);color:white;border-radius:2px;padding:1px 3px;font:9px/1.25 sans-serif";
  // Browser-grid slots are block-level; cards already use position:relative.
  if (!holder.style.position) holder.style.position = "relative";
  holder.append(credit);
  return credit;
}

export function artworkShouldReplace({ naturalWidth, targetWidth, candidateWidth, candidateHeight }) {
  return naturalWidth > 0 && targetWidth > naturalWidth * 1.04
    && candidateWidth > naturalWidth * 1.1
    && candidateWidth >= targetWidth
    && candidateHeight > 0;
}

export function mountCatalogArtwork(root, { observerFactory = globalThis.IntersectionObserver } = {}) {
  if (!root?.querySelectorAll) return () => {};
  const existing = mounted.get(root);
  if (existing && !existing.disposed) {
    existing.enroll();
    return existing.dispose;
  }
  const controller = new AbortController();
  const records = new Map();
  const pending = [];
  const visible = new Set();
  let disposed = false, admitted = 0, running = 0, scanOffset = 0;
  let observer;
  const state = { root, get disposed() { return disposed; }, enroll, dispose };
  const isCurrent = (record) => !disposed && owners.get(record.image) === state
    && root.isConnected && root.contains(record.image)
    && record.image.dataset.comicsArtId === record.id
    && record.image.dataset.comicsArtOriginal === record.original
    && canUse(record.image);
  function releaseRecord(record) {
    record.controller.abort();
    clearTimeout(record.waitTimer);
    visible.delete(record);
    observer?.unobserve(record.image);
    const image = record.image;
    if (owners.get(image) === state) {
      owners.delete(image);
      image.removeAttribute("data-comics-art-queued");
      // A completed Blob URL may already have been revoked after `load`.
      // Restore an owned upgraded image before releasing its controller.
      if (record.adopted && image.getAttribute("src") === record.adopted) {
        // If this DOM image was reused for a new catalog ID, its *new* verified
        // AniList source wins over the previous cover when the old owner exits.
        const current = catalogArtworkMark(image.dataset.comicsArtId, image.dataset.comicsArtOriginal);
        image.src = current?.url || record.original;
        image.removeAttribute("data-comics-art-upgraded");
        if (image.dataset.fallbackSrc === record.original) delete image.dataset.fallbackSrc;
      }
      record.credit?.remove();
    }
    record.releaseBlob?.();
    records.delete(image);
  }
  const load = async (record) => {
    if (!isCurrent(record)) return;
    const { image, original, id } = record;
    const targetWidth = image.getBoundingClientRect().width * (globalThis.devicePixelRatio || 1);
    if (!targetWidth || targetWidth <= image.naturalWidth * 1.04) return;
    const candidate = await candidateFor(id, record.controller.signal);
    if (!candidate || !isCurrent(record)) return;
    if (!artworkShouldReplace({ naturalWidth: image.naturalWidth, targetWidth, candidateWidth: candidate.width, candidateHeight: candidate.height })) return;
    const blobUrl = globalThis.URL.createObjectURL(candidate.blob);
    record.adopted = blobUrl;
    const release = () => {
      if (record.blobReleased) return;
      record.blobReleased = true;
      globalThis.URL.revokeObjectURL(blobUrl);
    };
    record.releaseBlob = release;
    image.dataset.fallbackSrc = original; // existing shared fallback restores real AniList art on error
    const failed = () => {
      release();
      if (owners.get(image) === state && image.getAttribute("src") === blobUrl) {
        record.credit?.remove();
        image.removeAttribute("data-comics-art-upgraded");
      }
      record.controller.abort();
    };
    image.addEventListener("error", failed, { once: true, signal: record.controller.signal });
    image.addEventListener("load", () => { release(); record.controller.abort(); }, { once: true, signal: record.controller.signal });
    image.src = blobUrl;
    image.setAttribute("data-comics-art-upgraded", "mangadex");
    record.credit = creditMangaDex(image);
  };
  const pump = () => {
    while (!disposed && running < MAX_REQUESTS && pending.length) {
      const record = pending.shift();
      record.stage = "running";
      running++;
      void load(record).catch(() => {}).finally(() => {
        running--;
        admitted--;
        record.stage = "done";
        if (!disposed) { admitVisible(); pump(); }
      });
    }
  };
  const schedule = (record) => {
    if (disposed || record.stage !== "queued" || owners.get(record.image) !== state) return;
    clearTimeout(record.waitTimer);
    pending.push(record);
    pump();
  };
  function admitVisible() {
    for (const record of visible) {
      if (disposed || admitted >= MAX_PER_MOUNT) break;
      visible.delete(record);
      if (record.stage !== "observed" || owners.get(record.image) !== state) continue;
      const image = record.image;
      if (!root.contains(image) || !image.getClientRects().length
        || globalThis.getComputedStyle?.(image)?.visibility === "hidden") continue;
      record.stage = "queued";
      observer?.unobserve(image);
      image.dataset.comicsArtQueued = "1";
      admitted++;
      if (image.complete) schedule(record);
      else {
        image.addEventListener("load", () => schedule(record), { once: true, signal: record.controller.signal });
        // A broken/lazy original cannot pin one of the 24 admission slots.
        record.waitTimer = setTimeout(() => {
          if (disposed || record.stage !== "queued") return;
          record.stage = "done";
          record.controller.abort();
          admitted--;
          admitVisible();
        }, 12_000);
      }
    }
  }
  if (typeof observerFactory === "function") {
    observer = new observerFactory((entries) => {
      for (const item of entries) {
        const record = records.get(item.target);
        if (!record || record.stage !== "observed") continue;
        if (item.isIntersecting) visible.add(record);
        else visible.delete(record);
      }
      admitVisible();
    }, { rootMargin: "60px" });
  }
  function enroll() {
    if (disposed) return;
    // One bounded batch per render. Later shelf additions advance the cursor.
    const candidates = Array.from(root.querySelectorAll("img[data-comics-art-id][data-comics-art-original]"));
    if (!candidates.length) return;
    if (scanOffset >= candidates.length) scanOffset = 0;
    const batch = candidates.slice(scanOffset, scanOffset + MAX_SCAN);
    scanOffset = (scanOffset + MAX_SCAN) % candidates.length;
    for (const image of batch) {
      const mark = catalogArtworkMark(image.dataset.comicsArtId, image.dataset.comicsArtOriginal);
      const old = records.get(image);
      if (old && (!mark || mark.id !== old.id || mark.url !== old.original)) releaseRecord(old);
      if (!mark || records.has(image)) continue;
      const previousOwner = owners.get(image);
      if (previousOwner && previousOwner !== state && !previousOwner.disposed && previousOwner.root.isConnected) continue;
      if (previousOwner && previousOwner !== state) previousOwner.releaseImage(image);
      if (image.getAttribute("src") !== mark.url) continue;
      const record = { image, id: mark.id, original: mark.url, controller: new AbortController(), stage: "observed" };
      records.set(image, record);
      owners.set(image, state);
      if (observer) observer.observe(image);
      else {
        // Old WebView: evaluate the current viewport only on an explicit mount.
        const rect = image.getBoundingClientRect();
        if (rect.width > 0 && rect.bottom >= 0 && rect.top <= (globalThis.innerHeight || 0)) visible.add(record);
      }
    }
    admitVisible();
  }
  state.releaseImage = image => { const record = records.get(image); if (record) releaseRecord(record); };
  function dispose() {
    if (disposed) return;
    disposed = true;
    observer?.disconnect();
    controller.abort();
    pending.length = 0;
    visible.clear();
    for (const record of [...records.values()]) releaseRecord(record);
    if (mounted.get(root) === state) mounted.delete(root);
    activeMounts.delete(state);
  }
  mounted.set(root, state);
  activeMounts.add(state);
  globalThis.addEventListener?.("pagehide", dispose, { once: true, signal: controller.signal });
  enroll();
  return dispose;
}

// Called at actual grid/body replacement boundaries; includes overlapping
// child mounts so no detached root can retain image listeners or Blob URLs.
export function disposeCatalogArtwork(root) {
  if (!root) return;
  for (const state of [...activeMounts]) {
    if (state.root === root || root.contains?.(state.root)) state.dispose();
  }
}
