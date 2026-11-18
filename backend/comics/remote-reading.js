// A bounded on-disk cache for remote images (source pages, covers), and the
// MangaDex calls LVL still uses as catalog data: new-chapter notices and volume
// covers. MangaDex is no longer a reading source.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { sniffImage } from "../reader/pages.js";
import { MANGADEX_API } from "./mangadex.js";
import { discardResponseBody, readBoundedResponse } from "./response-body.js";
import { createImageCacheOwnership } from "./image-cache-ownership.js";
import { normalizeUnitNumber } from "../../shared/reading/units.js";

const MAX_IMAGE = 25 * 1024 * 1024;

// Container completeness checks reject the common cached truncations that
// retain a valid magic header. Not a full codec decode or pixel integrity proof.
export function completeImageContainer(buffer) {
  const type = sniffImage(buffer);
  if (!type || buffer.length < 16 || buffer.length > MAX_IMAGE) return false;
  if (type === "image/jpeg") return buffer.length >= 4 && buffer.readUInt16BE(buffer.length - 2) === 0xffd9;
  if (type === "image/gif") return buffer.length >= 14 && buffer[buffer.length - 1] === 0x3b;
  if (type === "image/webp")
    return buffer.readUInt32LE(4) + 8 === buffer.length && buffer.readUInt32LE(4) >= 4;
  if (type === "image/png") {
    if (buffer.length < 45 || buffer.toString("hex", 0, 8) !== "89504e470d0a1a0a") return false;
    let offset = 8, seenHeader = false, seenEnd = false;
    while (offset + 12 <= buffer.length) {
      const size = buffer.readUInt32BE(offset);
      if (size > buffer.length - offset - 12) return false;
      const kind = buffer.toString("ascii", offset + 4, offset + 8);
      if (!seenHeader && (kind !== "IHDR" || size !== 13)) return false;
      if (kind === "IHDR") seenHeader = true;
      offset += size + 12;
      if (kind === "IEND") { seenEnd = size === 0 && offset === buffer.length; break; }
    }
    return seenHeader && seenEnd;
  }
  if (type === "image/avif") {
    let offset = 0;
    while (offset + 8 <= buffer.length) {
      const size = buffer.readUInt32BE(offset);
      if (size < 8 || size > buffer.length - offset) return false;
      offset += size;
    }
    return offset === buffer.length;
  }
  return false;
}

async function fetchImage(url, { headers = {}, fetchImpl = globalThis.fetch } = {}) {
  const controller = new AbortController();
  const response = await fetchImpl(url, { headers,
    signal: AbortSignal.any([AbortSignal.timeout(30_000), controller.signal]) });
  if (!response.ok) {
    await discardResponseBody(response, () => controller.abort());
    throw Object.assign(new Error(`Image answered HTTP ${response.status}`), { status: 502 });
  }
  const buffer = await readBoundedResponse(response, MAX_IMAGE, "Image is too large", () => controller.abort());
  const type = sniffImage(buffer);
  if (!type || !completeImageContainer(buffer)) throw new Error("Incomplete image");
  return { buffer, type };
}

// ---- Image cache v3. Every admitted image is an immutable, random-named
// incarnation with a tiny atomic pointer proving the entire admitted length,
// SHA-256 bytes and canonical source/key revision. The old unproven
// <sha1(key)>.img format is NEVER read or upgraded into authority: a legacy
// cache hit simply refetches, without touching the user's Library files.
export function createImageCache({ dir, maxBytes = 1024 ** 3,
  lockAttempts = 24, lockDelayMs = 25 } = {}) {
  let writes = 0;
  const pending = new Map();
  let pruning = null;
  let maintenanceBarrier = Promise.resolve();
  const owner = createImageCacheOwnership({ dir, attempts: lockAttempts, delayMs: lockDelayMs });
  const sha = (data) => crypto.createHash("sha256").update(data).digest("hex");
  const slot = (key) => sha(`image-cache-v3:\0${String(key)}`);
  const pointer = (key) => path.join(dir, `${slot(key)}.proof`);
  const blobFile = (key, incarnation) => path.join(dir, `${slot(key)}.${incarnation}.img`);
  const isId = (value) => /^[0-9a-f]{24}$/.test(String(value || ""));
  const safeStat = (stat) => stat?.isFile() && !stat.isSymbolicLink();
  const sameStat = (a, b) => safeStat(a) && safeStat(b) && a.dev === b.dev
    && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
  const validated = (image) => {
    const buffer = image?.buffer;
    const type = Buffer.isBuffer(buffer) ? sniffImage(buffer) : null;
    if (!type || image.type !== type || !completeImageContainer(buffer))
      throw new Error("Invalid or oversized image cache payload");
    return { buffer, type };
  };

  async function readProof(key) {
    try {
      const target = pointer(key);
      const stat = await fs.lstat(target);
      if (!safeStat(stat) || stat.size > 1024) return null;
      const raw = await fs.readFile(target, "utf8");
      const proof = JSON.parse(raw);
      if (proof?.version !== 3 || proof.keyDigest !== sha(String(key))
        || proof.sourceRevision !== sha(String(key))
        || !isId(proof.incarnation) || !/^[0-9a-f]{64}$/.test(proof.digest || "")
        || !Number.isSafeInteger(proof.length) || proof.length < 16 || proof.length > MAX_IMAGE
        || !/^image\/(?:png|jpeg|webp|gif|avif)$/.test(proof.type || "")) return null;
      return { proof, raw };
    } catch { return null; }
  }
  async function verified(key) {
    const found = await readProof(key);
    if (!found) return null;
    try {
      const target = blobFile(key, found.proof.incarnation);
      const before = await fs.lstat(target);
      if (!safeStat(before) || before.size !== found.proof.length) return null;
      const buffer = await fs.readFile(target);
      const after = await fs.lstat(target);
      if (!sameStat(before, after) || buffer.length !== found.proof.length
        || sha(buffer) !== found.proof.digest || sniffImage(buffer) !== found.proof.type
        || !completeImageContainer(buffer)) return null;
      // A concurrent publisher can retire a pointer while this image is read.
      // In that case do not report its incarnation as the current cache entry.
      if ((await fs.readFile(pointer(key), "utf8")) !== found.raw) return null;
      return { buffer, type: found.proof.type, incarnation: found.proof.incarnation };
    } catch { return null; }
  }
  async function publish(key, fetched, lease) {
    await owner.assertOwner(lease);
    const { buffer, type } = validated(fetched);
    // A published proof and its immutable blob are active borrower data.
    // Reclaim only unreferenced cache entries, and bypass cache admission if
    // the whole new incarnation cannot fit alongside the existing proofs.
    const used = await pruneFiles(lease, Math.max(0, maxBytes - buffer.length - 350));
    if (used + buffer.length + 350 > maxBytes) return { buffer, type };
    const incarnation = crypto.randomBytes(12).toString("hex");
    const target = blobFile(key, incarnation);
    const imageTemp = `${target}.tmp`;
    const proofTemp = `${pointer(key)}.${incarnation}.tmp`;
    let ownsImageTemp = false, ownsProofTemp = false;
    try {
      // Never replace an existing incarnation's bytes, including a held
      // borrower's file. A full new immutable file precedes its proof pointer.
      await owner.assertOwner(lease);
      await fs.writeFile(imageTemp, buffer, { flag: "wx" });
      ownsImageTemp = true;
      // Rename replaces an existing target on supported filesystems. Another
      // process or a forced nonce collision may already own this incarnation;
      // an exclusive same-directory hard link fails closed with EEXIST.
      try { await fs.link(imageTemp, target); }
      catch (error) {
        // Some removable/network filesystems cannot make hard links.
        // Display the freshly verified page without publishing a cache proof.
        if (["EPERM", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EXDEV"].includes(error?.code))
          return { buffer, type };
        throw error; // EEXIST means an existing incarnation must never change.
      }
      const proof = { version: 3, keyDigest: sha(String(key)),
        sourceRevision: sha(String(key)), incarnation, length: buffer.length,
        digest: sha(buffer), type };
      await fs.writeFile(proofTemp, JSON.stringify(proof), { flag: "wx" });
      ownsProofTemp = true;
      await owner.assertOwner(lease);
      await fs.rename(proofTemp, pointer(key));
    } finally {
      // A failed exclusive write means another process owns this temp name.
      // Never remove it through this request's failure path.
      try {
        await owner.assertOwner(lease);
        if (ownsImageTemp) await fs.rm(imageTemp, { force: true }).catch(() => {});
        if (ownsProofTemp) await fs.rm(proofTemp, { force: true }).catch(() => {});
      } catch { /* changed ownership never authorizes cleanup */ }
      // A failed publication leaves at most an unreferenced cache blob.
      // Do not unlink by pathname here: another publisher may have claimed
      // the same nonce, or a replacement may have appeared while awaiting IO.
      // Maintenance may reclaim only a separately proven orphan later.
    }
    // Keep the established batched quota-maintenance cadence rather than
    // rescanning every image and proof for every page the reader opens.
    // Exception: a single incarnation already consumes a large budget share.
    if (++writes % 40 === 0 || buffer.length >= maxBytes / 8) schedulePrune();
    return { buffer, type, incarnation };
  }
  const cacheName = (name) => /^[0-9a-f]{64}\.proof$/.test(name)
    || /^[0-9a-f]{64}\.[0-9a-f]{24}\.img$/.test(name);
  async function snapshot() {
    const names = (await fs.readdir(dir).catch((error) => {
      if (error?.code === "ENOENT") return [];
      throw error; // unknown or denied listing cannot grant cleanup authority
    })).filter(cacheName);
    const rows = await Promise.all(names.map(async (name) => ({
      name, stat: await fs.lstat(path.join(dir, name)).catch((error) => {
        if (error?.code === "ENOENT") return null;
        throw error;
      }),
    })));
    return rows.filter((row) => safeStat(row.stat));
  }
  async function retire(lease, row) {
    await owner.assertOwner(lease);
    const target = path.join(dir, row.name);
    const current = await fs.lstat(target).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!sameStat(current, row.stat)) return false;
    try {
      await fs.unlink(target);
      return true;
    } catch (error) {
      if (["EPERM", "EACCES", "EBUSY", "ENOENT"].includes(error?.code)) return false;
      throw error;
    }
  }
  async function pruneFiles(lease, budget = maxBytes) {
    await owner.assertOwner(lease);
    const rows = await snapshot();
    let total = rows.reduce((sum, row) => sum + row.stat.size, 0);
    const live = new Set(), unknown = new Set();
    // Never evict an image named by any current proof. A malformed proof
    // protects all blobs in its slot: opaque data is never cleanup authority.
    for (const row of rows.filter((entry) => entry.name.endsWith(".proof"))) {
      const base = row.name.slice(0, -6);
      try {
        const proof = JSON.parse(await fs.readFile(path.join(dir, row.name), "utf8"));
        if (proof?.version === 3 && isId(proof.incarnation)
          && Number.isSafeInteger(proof.length) && proof.length >= 16 && proof.length <= MAX_IMAGE
          && /^[0-9a-f]{64}$/.test(proof.digest || ""))
          live.add(`${base}.${proof.incarnation}.img`);
        else unknown.add(base);
      } catch { unknown.add(base); }
    }
    for (const row of rows.filter((entry) => entry.name.endsWith(".img"))
      .sort((a, b) => a.stat.atimeMs - b.stat.atimeMs)) {
      if (total <= budget) break;
      if (live.has(row.name) || unknown.has(row.name.slice(0, 64))) continue;
      if (await retire(lease, row)) total -= row.stat.size;
    }
    return total;
  }
  const exclusiveMaintenance = (action) => {
    const before = [...pending.values()];
    const task = maintenanceBarrier.catch(() => {}).then(async () => {
      // A remote image fetch can be stalled indefinitely. Maintenance must
      // acquire the filesystem lease after a bounded local wait; old network
      // work is fenced by the persisted epoch, not an endless process wait.
      await Promise.race([Promise.allSettled(before),
        new Promise((resolve) => setTimeout(resolve, 300))]);
      return owner.withOwner(action);
    });
    maintenanceBarrier = task.catch(() => {});
    return task;
  };
  const prune = () => exclusiveMaintenance((lease) => pruneFiles(lease));
  function schedulePrune() {
    if (pruning) return;
    pruning = prune().catch(() => {}).finally(() => { pruning = null; });
  }
  function enqueue(key, load, expectedIncarnation = null) {
    const name = pointer(key);
    const previous = pending.get(name);
    if (previous && expectedIncarnation === null) return previous;
    const barrier = maintenanceBarrier;
    const job = (async () => {
      await barrier;
      if (previous) await previous.catch(() => {});
      let initial;
      try {
        initial = await owner.withOwner(async () => ({
          current: await verified(key), proof: await readProof(key),
          epoch: await owner.epoch(),
        }));
      } catch (error) {
        if (!owner.isUnavailable(error)) throw error;
        // A conflicting or stale maintenance lease cannot give cached bytes,
        // create a pointer, or authorize destructive cleanup.
        return validated(await load());
      }
      if (expectedIncarnation === null && initial.current) return initial.current;
      if (expectedIncarnation !== null) {
        // A decoder may retire only the incarnation it actually observed.
        // A different/current publisher, including another reader, wins.
        if (initial.current && initial.current.incarnation !== expectedIncarnation) return initial.current;
        if (initial.proof?.proof.incarnation !== expectedIncarnation)
          throw Object.assign(new Error("Image cache incarnation changed; retry page"), { status: 409 });
      }
      // Fetch and validate externally; no network request may hold a shared
      // filesystem owner gate or block another reader's local cache cleanup.
      const fetched = validated(await load());
      try {
        return await owner.withOwner(async (lease) => {
          if (await owner.epoch() !== initial.epoch) return fetched;
          const current = await verified(key);
          if (expectedIncarnation === null && current) return current;
          if (expectedIncarnation !== null && current
            && current.incarnation !== expectedIncarnation) return current;
          const latest = await readProof(key);
          if (expectedIncarnation !== null && latest?.proof.incarnation !== expectedIncarnation)
            throw Object.assign(new Error("Image cache incarnation changed; retry page"), { status: 409 });
          return publish(key, fetched, lease);
        });
      } catch (error) {
        if (owner.isUnavailable(error)) return fetched;
        throw error;
      }
    })().finally(() => { if (pending.get(name) === job) pending.delete(name); });
    pending.set(name, job);
    return job;
  }
  return {
    get: (key, load) => enqueue(key, load),
    recover(key, expectedIncarnation, load) {
      if (!isId(expectedIncarnation))
        return Promise.reject(Object.assign(new Error("Unverified image-cache incarnation"), { status: 409 }));
      return enqueue(key, load, expectedIncarnation);
    },
    async usage() {
      return owner.withOwner(async () => {
        const rows = await snapshot();
        return { bytes: rows.reduce((sum, row) => sum + row.stat.size, 0),
          files: rows.filter((row) => row.name.endsWith(".img")).length, maxBytes };
      });
    },
    async clear() {
      return exclusiveMaintenance(async (lease) => {
        await owner.bumpEpoch(lease);
        // Completed buffers are already copied out of the cache under owner
        // lock. Windows busy/unlinked replacements are retained fail-closed.
        for (const row of await snapshot()) await retire(lease, row);
      });
    },
    prune,
  };
}

// ---- MangaDex reading
export const MANGADEX_LANGS = Object.freeze({ es: ["es", "es-la"], "es-419": ["es-la", "es"], pt: ["pt-br", "pt"], zh: ["zh", "zh-hk"], en: ["en"] });
export function mangadexLanguages(languages = []) {
  return [...new Set(languages.flatMap((code) => MANGADEX_LANGS[String(code).toLowerCase()] || [String(code).toLowerCase()]))]
    .filter((code) => /^[a-z]{2}(?:-[a-z]{2})?$/.test(code)).slice(0, 6);
}

export function createMangaDexReader({ endpoint = MANGADEX_API, fetchImpl = globalThis.fetch, userAgent = "LVL (local app)" } = {}) {
  const getJson = async (url) => {
    const response = await fetchImpl(url, { headers: { Accept: "application/json", "User-Agent": userAgent }, signal: AbortSignal.timeout(20_000) });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.result === "error") throw Object.assign(new Error(payload?.errors?.[0]?.detail || `MangaDex answered HTTP ${response.status}`), { status: 502 });
    return payload;
  };
  return {
    async latest(mangadexId, languages) {
      if (!/^[0-9a-f-]{36}$/i.test(String(mangadexId || ""))) return [];
      const params = new URLSearchParams({ limit: "10", "order[readableAt]": "desc" });
      for (const code of mangadexLanguages(languages)) params.append("translatedLanguage[]", code);
      for (const rating of ["safe", "suggestive"]) params.append("contentRating[]", rating);
      const payload = await getJson(`${endpoint}/manga/${mangadexId}/feed?${params}`);
      return (payload.data || []).map((item) => ({
        id: `md-${item.id}`, chapter: normalizeUnitNumber(item.attributes?.chapter), volume: normalizeUnitNumber(item.attributes?.volume),
        language: item.attributes?.translatedLanguage || "", externalUrl: item.attributes?.externalUrl || "", publishedAt: item.attributes?.readableAt || null,
      })).filter((item) => item.chapter);
    },
    image: (url) => fetchImage(url, { headers: { "User-Agent": userAgent }, fetchImpl }),
  };
}
