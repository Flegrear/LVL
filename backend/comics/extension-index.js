// Mihon extension repositories, such as keiyoushi. repo.json
// names the repository and its signing-key fingerprint and points at index.pb:
// a gzipped protobuf. Field numbers were read from the live keiyoushi index:
//   index: 1 name, 2 short name, 3 fingerprint, 4 links, 101 { 1: extension }*
//   extension: 1 name, 2 package, 3 urls { 1 apk, 2 icon }, 4 lib version,
//     5 version code, 6 version name, 7 content rating (1 safe, 2 mixed, 3 adult),
//     8 source { 1 id (64-bit), 2 name, 3 lang, 4 base URL }*
// Extensions are Android code: LVL reads which theme each one is built on
// (apk-theme.js) and runs its own version of that theme (source-engines.js).
import zlib from "node:zlib";

const MAX_COMPRESSED = 8 * 1024 * 1024;
const MAX_INDEX = 40 * 1024 * 1024;
const RATING = { 1: "safe", 2: "mixed", 3: "adult" };

function reader(bytes) {
  let pos = 0;
  const varint = () => {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (pos >= bytes.length || shift > 63n) throw new Error("Malformed index");
      const byte = bytes[pos++];
      result |= BigInt(byte & 0x7f) << shift;
      if (!(byte & 0x80)) return result;
      shift += 7n;
    }
  };
  return {
    done: () => pos >= bytes.length,
    // Yields [field, wireType, value]; value is a BigInt (varint) or a byte view.
    next() {
      const key = varint();
      const field = Number(key >> 3n);
      const wire = Number(key & 7n);
      if (wire === 0) return [field, wire, varint()];
      if (wire === 2) {
        const length = Number(varint());
        if (pos + length > bytes.length) throw new Error("Malformed index");
        const value = bytes.subarray(pos, pos + length);
        pos += length;
        return [field, wire, value];
      }
      if (wire === 1 || wire === 5) { pos += wire === 1 ? 8 : 4; return [field, wire, null]; }
      throw new Error("Malformed index");
    },
  };
}

const text = (bytes) => new TextDecoder().decode(bytes);
function fields(bytes, handle) {
  const read = reader(bytes);
  while (!read.done()) handle(...read.next());
}

function decodeSource(bytes) {
  const source = { id: "", name: "", lang: "", baseUrl: "" };
  fields(bytes, (field, wire, value) => {
    if (field === 1 && wire === 0) source.id = BigInt.asIntN(64, value).toString();
    else if (wire === 2) source[({ 2: "name", 3: "lang", 4: "baseUrl" })[field]] = text(value);
  });
  delete source.undefined;
  return source;
}

function decodeExtension(bytes) {
  const ext = { name: "", pkg: "", lang: "", version: "", versionCode: 0, lib: "", rating: "safe", nsfw: false, apk: "", icon: "", sources: [] };
  fields(bytes, (field, wire, value) => {
    if (field === 1 && wire === 2) ext.name = text(value);
    else if (field === 2 && wire === 2) ext.pkg = text(value);
    else if (field === 3 && wire === 2) fields(value, (sub, subWire, url) => { if (subWire === 2 && sub === 1) ext.apk = text(url); else if (subWire === 2 && sub === 2) ext.icon = text(url); });
    else if (field === 4 && wire === 2) ext.lib = text(value);
    else if (field === 5 && wire === 0) ext.versionCode = Number(value);
    else if (field === 6 && wire === 2) ext.version = text(value);
    else if (field === 7 && wire === 0) ext.rating = RATING[Number(value)] || "mixed";
    else if (field === 8 && wire === 2) ext.sources.push(decodeSource(value));
  });
  // eu.kanade.tachiyomi.extension.<lang>.<name>
  ext.lang = /^eu\.kanade\.tachiyomi\.extension\.([a-z]{2,3}(?:[-_][a-zA-Z]{2,4})?|all)\./.exec(ext.pkg)?.[1] || ext.sources[0]?.lang || "";
  ext.nsfw = ext.rating === "adult";
  return ext;
}

export function decodeIndex(buffer) {
  let bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = new Uint8Array(zlib.gunzipSync(bytes, { maxOutputLength: MAX_INDEX }));
  const index = { name: "", shortName: "", fingerprint: "", website: "", extensions: [] };
  fields(bytes, (field, wire, value) => {
    if (wire !== 2) return;
    if (field === 1) index.name = text(value);
    else if (field === 2) index.shortName = text(value);
    else if (field === 3) index.fingerprint = text(value);
    else if (field === 4) fields(value, (sub, subWire, link) => { if (sub === 1 && subWire === 2) index.website = text(link); });
    else if (field === 101) fields(value, (sub, subWire, ext) => { if (sub === 1 && subWire === 2) index.extensions.push(decodeExtension(ext)); });
  });
  return index;
}

// Older repositories: index.min.json with { name, pkg, lang, code, version, nsfw, apk, sources }.
export function fromJsonIndex(list, base) {
  return (Array.isArray(list) ? list : []).filter((item) => item && item.pkg).map((item) => ({
    name: String(item.name || "").replace(/^Tachiyomi:\s*/, ""), pkg: item.pkg, lang: item.lang || "", version: item.version || "", versionCode: Number(item.code) || 0,
    lib: "", rating: item.nsfw ? "adult" : "safe", nsfw: Boolean(item.nsfw), apk: item.apk ? `${base}/apk/${item.apk}` : "", icon: `${base}/icon/${item.pkg}.png`,
    sources: (item.sources || []).map((source) => ({ id: String(source.id), name: source.name || "", lang: source.lang || "", baseUrl: source.baseUrl || "" })),
  }));
}

async function download(url, fetchImpl) {
  const response = await fetchImpl(url, { headers: { "User-Agent": "LVL (local app)" }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > MAX_COMPRESSED) throw new Error("The index is too large");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > MAX_COMPRESSED) throw new Error("The index is too large");
  return bytes;
}

// url: the repository base (".../repo"), or its repo.json / index.min.json.
export async function fetchRepository(url, { fetchImpl = globalThis.fetch } = {}) {
  const base = String(url).replace(/\/(?:repo\.json|index\.min\.json|index\.pb)$/i, "").replace(/\/+$/, "");
  let meta = null;
  try { meta = JSON.parse(text(await download(`${base}/repo.json`, fetchImpl))); } catch { meta = null; }
  let extensions;
  let fingerprint = meta?.meta?.signingKeyFingerprint || "";
  let indexFingerprint = "";
  if (meta?.index_v2 && /^https:\/\//.test(meta.index_v2)) {
    const index = decodeIndex(await download(meta.index_v2, fetchImpl));
    extensions = index.extensions;
    indexFingerprint = index.fingerprint;
    fingerprint ||= index.fingerprint;
  } else {
    extensions = fromJsonIndex(JSON.parse(text(await download(`${base}/index.min.json`, fetchImpl))), base);
  }
  // Placeholder entries that ask old apps to update aren't extensions.
  extensions = extensions.filter((ext) => ext.sources.length || ext.apk);
  return {
    url: base, name: meta?.meta?.name || "", website: meta?.meta?.website || "", fingerprint,
    // repo.json and index.pb should name the same signing key.
    fingerprintMatches: !indexFingerprint || !meta?.meta?.signingKeyFingerprint || indexFingerprint === meta.meta.signingKeyFingerprint,
    extensions,
  };
}

export function filterExtensions(extensions, { q = "", lang = "", source = "", adult = false, limit = 100, offset = 0 } = {}) {
  const needle = String(q).trim().toLowerCase();
  const list = extensions.filter((ext) => (adult || !ext.nsfw)
    && (!source || ext.sources.some((item) => String(item.id) === String(source)))
    && (!lang || (source
      ? ext.sources.some((item) => String(item.id) === String(source) && (item.lang === lang || item.lang === "all"))
      : ext.lang === lang || ext.lang === "all" || ext.sources.some((item) => item.lang === lang)))
    && (!needle || ext.name.toLowerCase().includes(needle) || ext.sources.some((item) =>
      (!source || String(item.id) === String(source)) && item.baseUrl.toLowerCase().includes(needle))));
  return { total: list.length, items: list.slice(offset, offset + limit) };
}


// Repositories are read at most every 6 hours; a failed refresh keeps the last list.
export function createRepositoryCache({ load = (url) => fetchRepository(url), ttlMs = 6 * 60 * 60_000, now = Date.now } = {}) {
  const entries = new Map();
  return {
    async get(url, { force = false } = {}) {
      const entry = entries.get(url);
      if (entry?.pending) return entry.pending;
      if (entry?.value && !force && now() - entry.at < ttlMs) return entry.value;
      const pending = load(url).then((value) => { entries.set(url, { value, at: now() }); return value; }, (error) => {
        if (entry?.value) { entries.set(url, { ...entry, pending: null }); return { ...entry.value, stale: true, error: error.message }; }
        entries.delete(url);
        throw error;
      });
      entries.set(url, { ...entry, pending });
      return pending;
    },
  };
}
