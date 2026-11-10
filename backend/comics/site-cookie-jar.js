// Bounded in-memory cookies for untrusted source sites.
// Parsing, public/private suffixes, host-only matching, Path and Secure
// semantics are owned by the maintained cookie library.
import {
  Cookie, CookieJar, MemoryCookieStore, canonicalDomain, defaultPath, domainMatch, pathMatch,
} from 'tough-cookie';

export function createSiteCookieJar({ now = Date.now, maxHosts = 300, maxPerHost = 60 } = {}) {
  const memory = new MemoryCookieStore();
  const jar = new CookieJar(memory, {
    rejectPublicSuffixes: true,
    prefixSecurity: 'silent',
    allowSecureOnLocal: false,
    // Example/test hostnames must remain usable without enabling cross-domain
    // cookies on real public or private suffixes (rejectPublicSuffixes stays on).
    allowSpecialUseDomain: true,
  });
  // Metadata only: CookieJar/MemoryCookieStore own the actual Cookie objects.
  const expirations = new WeakMap();
  const sites = new Map();
  // Quota eviction follows the most recent successful Set-Cookie for each
  // stored (domain, path, key) identity. CookieJar intentionally preserves
  // the original creationIndex on replacement; never mutate that RFC order.
  const evictionRecency = new Map();
  let recencySequence = 0;
  const cookieIdentity = (cookie) => JSON.stringify([cookie.domain, cookie.path, cookie.key]);
  const hostLimit = Math.max(1, Number.isFinite(maxHosts) ? Math.floor(maxHosts) : 300);
  const perHostLimit = Math.max(1, Number.isFinite(maxPerHost) ? Math.floor(maxPerHost) : 60);
  const validName = (name) => /^[!#$%&'*+.^_`|~0-9A-Za-z_-]{1,100}$/.test(name);

  function allCookies() {
    let result;
    let failure;
    memory.getAllCookies((err, cookies) => { failure = err; result = cookies; });
    if (failure) throw failure;
    return result || [];
  }
  function remove(cookie) {
    memory.removeCookie(cookie.domain, cookie.path, cookie.key, (error) => {
      if (error) throw error;
    });
    evictionRecency.delete(cookieIdentity(cookie));
  }
  function removeDomain(domain) {
    for (const cookie of allCookies())
      if (cookie.domain === domain) evictionRecency.delete(cookieIdentity(cookie));
    memory.removeCookies(domain, null, (error) => { if (error) throw error; });
    sites.delete(domain);
  }
  function expired(cookie, stamp) {
    let deadline = expirations.get(cookie);
    if (deadline === undefined) {
      // Only for cookies already in this synchronous in-memory store.
      // Do not use lastAccessed (getCookiesSync updates it using wall time).
      deadline = cookie.expiryTime(cookie.creation instanceof Date ? cookie.creation : new Date(stamp));
      expirations.set(cookie, deadline ?? Infinity);
    }
    return deadline !== undefined && deadline <= stamp;
  }
  function cleanEmptyDomains() {
    // MemoryCookieStore.removeCookie removes keys but intentionally leaves
    // empty path and domain tables. Remove those through its public API too.
    for (const domain of Object.keys(memory.idx)) {
      const paths = memory.idx[domain];
      for (const path of Object.keys(paths)) {
        if (Object.keys(paths[path]).length === 0)
          memory.removeCookies(domain, path, (error) => { if (error) throw error; });
      }
      if (Object.keys(memory.idx[domain] || {}).length === 0) removeDomain(domain);
    }
  }
  function compact(stamp = now()) {
    for (const cookie of allCookies()) if (expired(cookie, stamp)) remove(cookie);
    cleanEmptyDomains();
    let cookies = allCookies();
    // A rejected or removed identity never retains recency metadata. New
    // records discovered in the library store start with its creation order.
    const live = new Set(cookies.map(cookieIdentity));
    for (const identity of evictionRecency.keys())
      if (!live.has(identity)) evictionRecency.delete(identity);
    const byDomain = new Map();
    for (const cookie of cookies) {
      const identity = cookieIdentity(cookie);
      if (!evictionRecency.has(identity)) evictionRecency.set(identity, ++recencySequence);
      const bucket = byDomain.get(cookie.domain) || [];
      bucket.push(cookie);
      byDomain.set(cookie.domain, bucket);
    }
    for (const bucket of byDomain.values()) {
      bucket.sort((a, b) =>
        evictionRecency.get(cookieIdentity(a)) - evictionRecency.get(cookieIdentity(b)));
      while (bucket.length > perHostLimit) remove(bucket.shift());
    }
    cleanEmptyDomains();
    cookies = allCookies();
    const present = new Set(cookies.map((cookie) => cookie.domain));
    for (const domain of sites.keys()) if (!present.has(domain)) sites.delete(domain);
    for (const domain of present) if (!sites.has(domain)) sites.set(domain, true);
    while (sites.size > hostLimit) removeDomain(sites.keys().next().value);
  }
  const overlaps = (leftDomain, leftHostOnly, rightDomain, rightHostOnly) => {
    if (leftHostOnly && rightHostOnly) return leftDomain === rightDomain;
    if (leftHostOnly) return domainMatch(leftDomain, rightDomain);
    if (rightHostOnly) return domainMatch(rightDomain, leftDomain);
    return domainMatch(leftDomain, rightDomain) || domainMatch(rightDomain, leftDomain);
  };
  function store(url, lines) {
    if (!lines) return;
    const stamp = now();
    compact(stamp);
    const host = canonicalDomain(url.hostname);
    if (!host) return;
    for (const line of [].concat(lines)) {
      if (typeof line !== 'string' || line.length > 4096 || /[\r\n]/.test(line)) continue;
      const parsed = Cookie.parse(line);
      if (!parsed || !validName(parsed.key) || parsed.value.length > 2000) continue;
      // Keep the browser-like maximum lifetime from the previous jar.
      if (typeof parsed.maxAge === 'number' && parsed.maxAge > 400 * 86400)
        parsed.maxAge = 400 * 86400;
      // The library performs actual Domain/public-suffix/prefix admission.
      const requestedDomain = canonicalDomain(parsed.domain || host);
      const requestedPath = parsed.path?.startsWith('/') ? parsed.path : defaultPath(url.pathname || '/');
      const hostOnly = !parsed.domain;
      if (!requestedDomain || !requestedPath) continue;
      if (url.protocol !== 'https:') {
        // CookieJar does not prevent an insecure sibling Domain response
        // shadowing an HTTPS host-only Secure cookie. Defend overlapping
        // names/scopes before touching the store, including deletion cookies.
        const shadow = allCookies().some((existing) =>
          existing.secure && existing.key === parsed.key && !expired(existing, stamp)
          && overlaps(requestedDomain, hostOnly, existing.domain, existing.hostOnly)
          && (pathMatch(requestedPath, existing.path) || pathMatch(existing.path, requestedPath)));
        if (shadow) continue;
      }
      let accepted;
      try { accepted = jar.setCookieSync(parsed, url, { now: new Date(stamp), ignoreError: true }); }
      catch { continue; }
      if (!accepted) continue;
      // Max-Age takes precedence over Expires; use injected clock even when
      // the library's getCookiesSync uses the system clock for lastAccessed.
      const expiry = accepted.expiryTime(new Date(stamp));
      expirations.set(accepted, expiry ?? Infinity);
      if (expiry !== undefined && expiry <= stamp) {
        remove(accepted);
      } else {
        const identity = cookieIdentity(accepted);
        evictionRecency.delete(identity);
        evictionRecency.set(identity, ++recencySequence);
        sites.delete(accepted.domain);
        sites.set(accepted.domain, true);
      }
      compact(stamp); // includes expired-only/first-seen and replacement paths
    }
  }
  function header(url) {
    const stamp = now();
    compact(stamp);
    const matched = jar.getCookiesSync(url, { expire: false, sort: true })
      .filter((cookie) => !expired(cookie, stamp));
    for (const cookie of matched) {
      if (sites.has(cookie.domain)) {
        sites.delete(cookie.domain);
        sites.set(cookie.domain, true);
      }
    }
    return matched.map((cookie) => cookie.cookieString()).join('; ');
  }
  return { store, header };
}
