import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createServerFeatureHost, validateServerFeatures } from "../backend/features/feature-host.js";
import { SERVER_FEATURES } from "../backend/features/registry.js";

const quiet = { error() {}, warn() {} };
const coreAssets = new Map([["/app.js", { file: "app.js", cacheControl: "no-cache" }]]);

function fakeRes() {
  return { status: 0, body: null };
}
const helpers = (overrides = {}) => ({
  json: (res, status, body) => { res.status = status; res.body = body; },
  rejectNonLocal: () => false,
  ...overrides,
});

test("the real server feature registry is valid and doesn't collide with core assets", () => {
  const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  const core = new Map([...server.matchAll(/^\s*\["(\/[^"]*)", \{ file: "([^"]+)", cacheControl: "([^"]+)" \}\]/gm)]
    .map(([, url, file, cacheControl]) => [url, { file, cacheControl }]));
  assert.ok(core.size > 70);
  assert.doesNotThrow(() => validateServerFeatures(SERVER_FEATURES, { coreAssets: core }));
});

test("server feature validation rejects unsafe or conflicting registrations with a clear message", () => {
  const cases = [
    [[{ id: "Reader" }], /invalid feature id/],
    [[{ id: "reader" }, { id: "reader" }], /duplicate feature id "reader"/],
    [[{ id: "reader", apiPrefixes: ["/reader"] }], /invalid API prefix/],
    [[{ id: "reader", apiPrefixes: ["/api/reader"] }, { id: "books", apiPrefixes: ["/api/reader/books"] }], /overlaps \/api\/reader from "reader"/],
    [[{ id: "reader", assets: [["/app.js", { file: "frontend/reader/x.js", cacheControl: "no-cache" }]] }], /collides with a core route/],
    [[{ id: "reader", assets: [["/x.js", { file: "server.js", cacheControl: "no-cache" }]] }], /must serve index\.html or a file under/],
    [[{ id: "reader", assets: [["/x.js", { file: "frontend/../server.js", cacheControl: "no-cache" }]] }], /must serve index\.html or a file under/],
    [[{ id: "reader", assets: [["/x.js", { file: "frontend/reader/x.js" }]] }], /needs a cacheControl/],
    [[{ id: "reader", create: 1 }], /create must be a function/],
  ];
  for (const [features, message] of cases) {
    assert.throws(() => validateServerFeatures(features, { coreAssets }), message);
  }
  assert.doesNotThrow(() => validateServerFeatures([{ id: "reader",
    assets: [["/reader", { file: "index.html", cacheControl: "no-store" }], ["/frontend/reader/reader.js", { file: "frontend/reader/reader.js", cacheControl: "no-cache" }]],
    apiPrefixes: ["/api/reader"] }], { coreAssets }));
});

test("feature API routes are dispatched by prefix, guarded as local-only, and core paths are ignored", async () => {
  const seen = [];
  const host = createServerFeatureHost([{
    id: "reader",
    assets: [["/reader", { file: "index.html", cacheControl: "no-store" }]],
    apiPrefixes: ["/api/reader"],
    create: (ctx) => ({ handle: (req, res, url) => { seen.push([url.pathname, ctx.dataRoot]); ctx.json(res, 200, { ok: true }); return true; } }),
  }], { coreAssets, log: quiet });
  assert.deepEqual([...host.assets.keys()], ["/reader"]);
  let rejected = 0;
  host.init(helpers({ dataRoot: "D", rejectNonLocal: (req, res) => { if (req.foreign) { rejected += 1; res.status = 403; return true; } return false; } }));
  assert.equal(await host.handleApi({}, fakeRes(), new URL("http://x/api/library")), false);
  assert.equal(await host.handleApi({}, fakeRes(), new URL("http://x/api/readers")), false, "prefix must match a whole path segment");
  const res = fakeRes();
  assert.equal(await host.handleApi({}, res, new URL("http://x/api/reader/books/1")), true);
  assert.deepEqual(seen, [["/api/reader/books/1", "D"]]);
  assert.equal(res.status, 200);
  const blocked = fakeRes();
  assert.equal(await host.handleApi({ foreign: true }, blocked, new URL("http://x/api/reader")), true);
  assert.equal(blocked.status, 403);
  assert.equal(rejected, 1);
  assert.equal(seen.length, 1, "a rejected request never reaches the feature");
});

test("a feature that fails to start answers 503 without affecting other features", async () => {
  const host = createServerFeatureHost([
    { id: "broken", apiPrefixes: ["/api/broken"], create() { throw new Error("boom"); } },
    { id: "books", apiPrefixes: ["/api/books"], create: (ctx) => ({ handle: (req, res) => { ctx.json(res, 200, {}); return true; } }) },
  ], { log: quiet });
  host.init(helpers());
  const broken = fakeRes();
  assert.equal(await host.handleApi({}, broken, new URL("http://x/api/broken/x")), true);
  assert.equal(broken.status, 503);
  const books = fakeRes();
  assert.equal(await host.handleApi({}, books, new URL("http://x/api/books")), true);
  assert.equal(books.status, 200);
});

test("start and stop hooks run once each; a hanging stop is bounded and errors are contained", async () => {
  const calls = [];
  const host = createServerFeatureHost([
    { id: "one", create: () => ({ start: () => calls.push("start-one"), stop: () => new Promise(() => {}) }) },
    { id: "two", create: () => ({ start() { throw new Error("no"); }, stop: () => calls.push("stop-two") }) },
  ], { log: quiet });
  host.init(helpers());
  await host.start();
  const began = Date.now();
  await host.stop({ timeoutMs: 50 });
  assert.ok(Date.now() - began < 1000);
  assert.deepEqual(calls, ["start-one", "stop-two"]);
});

test("server.js wires the feature host: assets, API fallback after core, start and stop", () => {
  const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  assert.match(server, /import \{ SERVER_FEATURES \} from "\.\/backend\/features\/registry\.js";/);
  assert.match(server, /createServerFeatureHost\(SERVER_FEATURES, \{ coreAssets: PUBLIC_ASSETS \}\)/);
  assert.match(server, /for \(const \[route, asset\] of serverFeatures\.assets\) PUBLIC_ASSETS\.set\(route, asset\);/);
  assert.match(server, /let handled = await handleApi\(req, res, url\);\s*if \(!handled && !res\.headersSent\) handled = await serverFeatures\.handleApi\(req, res, url\);/);
  assert.match(server, /rejectNonLocal: localRequestRejected/);
  assert.match(server, /await serverFeatures\.stop\(\);/);
  assert.match(server, /void serverFeatures\.start\(\);/);
});
