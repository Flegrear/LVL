// Server extension seam. Optional features (reader, franchises, reading
// sources) register in ./registry.js instead of
// editing server.js. server.js asks this host for extra static assets, API
// routes and start/stop hooks. Core routes always win: features are only asked
// about requests that core did not handle, and every feature route is local-only.
//
// A feature module exports a plain object and has no side effects at import:
//   {
//     id: "reader",
//     assets: [["/frontend/reader/reader.js", { file: "frontend/reader/reader.js", cacheControl: "no-cache" }]],
//     apiPrefixes: ["/api/reader"],
//     create(ctx) { return { handle(req, res, url) {}, start() {}, stop() {} }; },
//   }
// handle() returns true when it answered the request.

const FEATURE_ID = /^[a-z][a-z0-9-]{1,31}$/;
const API_PREFIX = /^\/api\/[a-z0-9-]+(?:\/[a-z0-9-]+)*$/;
const ASSET_ROUTE = /^\/[A-Za-z0-9._\-/]*$/;
const ASSET_FILE = /^(?:frontend|shared|assets|learning)\/[A-Za-z0-9._\-/]+$/;
const STOP_TIMEOUT_MS = 2000;

function fail(message) {
  throw new Error(`Server feature registry: ${message}`);
}

export function validateServerFeatures(features, { coreAssets = new Map() } = {}) {
  if (!Array.isArray(features)) fail("SERVER_FEATURES must be an array");
  const ids = new Set();
  const routes = new Map();
  const prefixes = new Map();
  for (const feature of features) {
    const id = feature?.id;
    if (typeof id !== "string" || !FEATURE_ID.test(id)) fail(`invalid feature id ${JSON.stringify(id)}`);
    if (ids.has(id)) fail(`duplicate feature id "${id}"`);
    ids.add(id);
    if (feature.create !== undefined && typeof feature.create !== "function") fail(`"${id}".create must be a function`);
    for (const entry of feature.assets || []) {
      const [route, asset] = Array.isArray(entry) ? entry : [];
      if (typeof route !== "string" || !ASSET_ROUTE.test(route) || route.includes("..")) fail(`"${id}" has an invalid asset route ${JSON.stringify(route)}`);
      const file = asset?.file;
      const pageRoute = file === "index.html";
      if (typeof file !== "string" || (!pageRoute && (!ASSET_FILE.test(file) || file.includes("..")))) {
        fail(`"${id}" asset ${route} must serve index.html or a file under frontend/, shared/, assets/ or learning/ (got ${JSON.stringify(file)})`);
      }
      if (typeof asset.cacheControl !== "string" || !asset.cacheControl) fail(`"${id}" asset ${route} needs a cacheControl value`);
      if (coreAssets.has(route)) fail(`"${id}" asset ${route} collides with a core route`);
      if (routes.has(route)) fail(`"${id}" asset ${route} collides with feature "${routes.get(route)}"`);
      routes.set(route, id);
    }
    for (const prefix of feature.apiPrefixes || []) {
      if (typeof prefix !== "string" || !API_PREFIX.test(prefix)) fail(`"${id}" has an invalid API prefix ${JSON.stringify(prefix)}`);
      for (const [other, owner] of prefixes) {
        if (prefix === other || prefix.startsWith(`${other}/`) || other.startsWith(`${prefix}/`)) {
          fail(`"${id}" API prefix ${prefix} overlaps ${other} from "${owner}"`);
        }
      }
      prefixes.set(prefix, id);
    }
  }
  return { ids, routes, prefixes };
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((resolve) => { timer = setTimeout(resolve, ms); }),
  ]);
}

export function createServerFeatureHost(features = [], { coreAssets = new Map(), log = console } = {}) {
  const { prefixes } = validateServerFeatures(features, { coreAssets });
  const byId = new Map(features.map((feature) => [feature.id, feature]));
  const assets = new Map();
  for (const feature of features) {
    for (const [route, asset] of feature.assets || []) assets.set(route, Object.freeze({ file: asset.file, cacheControl: asset.cacheControl }));
  }
  const instances = new Map();
  const failed = new Map();
  // A factory failure is terminal for this init; only a failed start hook is
  // eligible for a later explicit start() retry.
  const lifecycle = new Map();
  let helpers = null;
  let stopped = false;
  let startup = null;
  let generation = 0;

  function featureForPath(pathname) {
    for (const [prefix, id] of prefixes) {
      if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return byId.get(id);
    }
    return null;
  }

  return Object.freeze({
    assets,
    ids: Object.freeze([...byId.keys()]),
    featureForPath: (pathname) => featureForPath(String(pathname || ""))?.id || null,

    // ctx: { db, getMeta, setMeta, dataRoot, port, root, json, readJsonBody, methodNotAllowed, rejectNonLocal }
    init(ctx = {}) {
      helpers = ctx;
      generation += 1;
      stopped = false;
      startup = null;
      instances.clear();
      failed.clear();
      lifecycle.clear();
      for (const feature of features) {
        try {
          const instance = feature.create ? feature.create(ctx) || {} : {};
          instances.set(feature.id, instance);
          lifecycle.set(feature.id, typeof instance.start === "function" ? "pending" : "ready");
        } catch (error) {
          failed.set(feature.id, error);
          lifecycle.set(feature.id, "factory-failed");
          log.error?.(`Feature "${feature.id}" failed to create; its routes answer 503:`, error);
        }
      }
    },

    async handleApi(req, res, url) {
      const feature = featureForPath(url.pathname);
      if (!feature) return false;
      if (helpers?.rejectNonLocal?.(req, res)) return true;
      const instance = instances.get(feature.id);
      if (failed.has(feature.id) || !instance || lifecycle.get(feature.id) !== "ready") {
        helpers?.json?.(res, 503, { error: `${feature.id} is unavailable` });
        return true;
      }
      if (typeof instance.handle !== "function") return false;
      return Boolean(await instance.handle(req, res, url));
    },

    start() {
      if (stopped) return Promise.resolve();
      if (startup) return startup;
      const owner = generation;
      const run = (async () => {
        for (const [id, instance] of instances) {
          if (stopped || owner !== generation) return;
          if (!["pending", "start-failed"].includes(lifecycle.get(id))) continue;
          lifecycle.set(id, "starting");
          try {
            await instance.start();
            if (!stopped && owner === generation && lifecycle.get(id) === "starting") lifecycle.set(id, "ready");
          } catch (error) {
            if (stopped || owner !== generation || lifecycle.get(id) !== "starting") continue;
            lifecycle.set(id, "start-failed");
            log.warn?.(`Feature "${id}" start hook failed:`, error?.message || error);
          }
        }
      })();
      startup = run;
      run.then(() => { if (startup === run) startup = null; },
        () => { if (startup === run) startup = null; });
      return run;
    },

    async stop({ timeoutMs = STOP_TIMEOUT_MS } = {}) {
      stopped = true;
      generation += 1;
      for (const id of instances.keys()) lifecycle.set(id, "stopped");
      for (const [id, instance] of instances) {
        try {
          await withTimeout(instance.stop?.(), timeoutMs);
        } catch (error) {
          log.warn?.(`Feature "${id}" stop hook failed:`, error?.message || error);
        }
      }
    },
  });
}
