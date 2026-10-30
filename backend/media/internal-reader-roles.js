// Optional STREAM-01 diagnostic identity for requests made by LVL's own
// FFprobe/FFmpeg children. There is deliberately NO torrent piece scheduling
// or HTTP admission policy here. The /stream route must behave normally if
// the token is absent, expired or unrecognized.
//
// Integration (requires server.js owner approval):
//   const lease = roles.issue(session, fileIndex, 'subtitle');
//   const source = lease?.urlFor(ownLocalStreamUrl) || ownLocalStreamUrl;
//   // release on the physical FFmpeg/FFprobe close, including abort/error
//   const role = roles.classify(session, fileIndex, requestUrl.searchParams.get('lvl_reader'));
//   streamHealth.begin(session, { fileIndex, start, end, role });
//
// A token is a *diagnostic bearer tag*, NOT authentication/authorization.
// Never accept a plain role query/header from a caller or classify an ordinary
// browser request as foreground based on Range, User-Agent or loopback IP.
import { randomBytes } from 'node:crypto';

const ROLES = new Set(['probe', 'subtitle', 'speech', 'conversion']);
const TOKEN = /^[a-f0-9]{48}$/;
const PARAM = 'lvl_reader';
const MAX_LEASES = 32;
const MAX_REQUESTS = 512;
const TTL_MS = 10 * 60 * 1000;

export function createInternalReaderRoles({
  now = Date.now, createToken = () => randomBytes(24).toString('hex'),
  maxLeasesPerSession = MAX_LEASES, maxRequestsPerLease = MAX_REQUESTS,
  ttlMs = TTL_MS, port = null,
} = {}) {
  const registrations = new WeakMap();
  const capacity = Math.max(1, Math.min(MAX_LEASES, Math.trunc(maxLeasesPerSession) || MAX_LEASES));
  const requestLimit = Math.max(1, Math.min(MAX_REQUESTS, Math.trunc(maxRequestsPerLease) || MAX_REQUESTS));
  const duration = Math.max(1000, Math.min(TTL_MS, Math.trunc(ttlMs) || TTL_MS));

  const prune = (map, time) => {
    for (const [key, entry] of map) if (entry.expiresAt <= time || entry.requests >= requestLimit)
      map.delete(key);
  };

  const issue = (session, fileIndex, role) => {
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535
      || !session || typeof session !== 'object' || !Number.isSafeInteger(fileIndex)
      || fileIndex < 0 || typeof session.id !== 'string'
      || !/^[0-9a-f-]{36}$/i.test(session.id) || !ROLES.has(role)) return null;
    const time = now();
    if (!Number.isFinite(time)) return null;
    let map = registrations.get(session);
    if (!map) { map = new Map(); registrations.set(session, map); }
    prune(map, time);
    if (map.size >= capacity) return null;
    const token = createToken();
    if (typeof token !== 'string' || !TOKEN.test(token) || map.has(token)) return null;
    const entry = { fileIndex, role, expiresAt: time + duration, requests: 0 };
    map.set(token, entry);
    let released = false;
    return {
      // This is deliberately confined to localhost; never put the token in an
      // external URL, and never expose it in streamHealth snapshots/logs.
      urlFor(rawUrl) {
        const url = new URL(rawUrl);
        if (released || url.protocol !== 'http:' || url.hostname !== '127.0.0.1'
          || url.port !== String(port)
          || url.pathname !== `/api/torrents/${encodeURIComponent(session.id)}/files/${fileIndex}/stream`)
          throw new Error('Reader-role URL must be a local torrent stream');
        url.searchParams.set(PARAM, token);
        return url.toString();
      },
      release() {
        if (released) return;
        released = true;
        if (map.get(token) === entry) map.delete(token);
      },
    };
  };

  const classify = (session, fileIndex, token) => {
    if (!session || typeof session !== 'object' || !Number.isSafeInteger(fileIndex)
      || typeof token !== 'string' || !TOKEN.test(token)) return 'unknown';
    const map = registrations.get(session);
    if (!map) return 'unknown';
    prune(map, now());
    const entry = map.get(token);
    if (!entry || entry.fileIndex !== fileIndex) return 'unknown';
    entry.requests += 1;
    if (entry.requests >= requestLimit) map.delete(token);
    return entry.role;
  };

  // Always invoke on actual session removal. Same-id replacement stays
  // isolated even before invalidation because the WeakMap key is the object.
  const clear = session => { if (session && typeof session === 'object') registrations.delete(session); };
  return { issue, classify, clear };
}
