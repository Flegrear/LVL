import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");

function changelogRuntime(sourceRoot) {
  const start = server.indexOf("\nconst MAX_LOCAL_CHANGELOG_BYTES = ");
  const end = server.indexOf("\nfunction requestNativeUpdate(", start);
  assert.ok(start > 0 && end > start, "local changelog route must remain intact");
  return vm.runInNewContext(server.slice(start, end) +
    "\n({ parseLocalChangelog, localChangelogEndpoint, localRequestRejected })", {
    fs, path, root: sourceRoot, Buffer, console, port: 4273, Date,
    json(res, status, value, headers = {}) { res.status = status; res.value = value; res.headers = headers; },
    methodNotAllowed(res, allowed) { res.status = 405; res.allowed = allowed; return true; },
  });
}

function query(handler, { method = "GET", host = "127.0.0.1:4273", pathname = "/api/app-updates/changelog" } = {}) {
  const req = { method, headers: { host } };
  const res = {};
  if (!handler.localRequestRejected(req, res)) {
    handler.localChangelogEndpoint(req, res, new URL(pathname, "http://127.0.0.1:4273"));
  }
  return res;
}

test("changelog endpoint serves local bundled bytes, not live GitHub edits", () => {
  const response = query(changelogRuntime(root));
  assert.equal(response.status, 200);
  assert.equal(response.value.raw, changelog);
  assert.deepEqual(Array.from(response.value.entries, (entry) => entry.version),
    Array.from(changelogRuntime(root).parseLocalChangelog(changelog).entries, (entry) => entry.version));
  assert.equal(response.headers["X-Content-Type-Options"], "nosniff");
});

test("bundled changelog contains the published Alpha versions, with no TEST placeholder", () => {
  const parsed = changelogRuntime(root).parseLocalChangelog(changelog);
  assert.deepEqual(Array.from(parsed.entries, (entry) => entry.version), ["0.1.11", "0.1.1", "0.1.0"]);
  assert.equal(parsed.latest.version, "0.1.11");
  assert.match(parsed.entries[0].changes.join(" "), /Updater fixes/i);
  assert.doesNotMatch(changelog, /^##\s+TEST\b/m);
});

test("changelog versions are parsed numerically once real public releases exist", () => {
  const parsed = changelogRuntime(root).parseLocalChangelog([
    "# Changelog", "## 0.1.9 — 2026-10-24", "- Ninth",
    "## 0.1.10 — 2026-10-25", "- Tenth",
    "## Unreleased (next release)", "- Draft",
    "## 0.1.0 — 2026-10-23", "- First",
  ].join("\n"));
  assert.deepEqual(Array.from(parsed.entries, (entry) => entry.version),
    [null, "0.1.10", "0.1.9", "0.1.0"]);
  assert.equal(parsed.latest.version, "0.1.10");
});

test("local changelog only answers read-only requests from its own loopback origin", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "lvl-initial-changelog-"));
  try {
    const runtime = changelogRuntime(temp);
    assert.equal(query(runtime).status, 404);
    fs.writeFileSync(path.join(temp, "CHANGELOG.md"), "## 0.1.0 — 2026-10-25\n- First release");
    assert.equal(query(runtime).status, 200);
    assert.equal(query(runtime, { method: "POST" }).status, 405);
    assert.equal(query(runtime, { host: "evil.example:4273" }).status, 403);
    assert.equal(query(runtime, { pathname: "/api/app-updates/changelog?url=https://evil.example" }).status, 400);
    fs.writeFileSync(path.join(temp, "CHANGELOG.md"), "X".repeat(128 * 1024 + 1));
    assert.equal(query(runtime).status, 404);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("notification-only update polls cannot authorize a patch install; explicit checks can", async () => {
  const start = server.indexOf("\nasync function appUpdatesEndpoint(");
  const end = server.indexOf("\nasync function importAnkiDeck(", start);
  assert.ok(start > 0 && end > start, "native update API controller must remain available");
  const forwarded = [];
  let payload = null;
  const { appUpdatesEndpoint } = vm.runInNewContext(server.slice(start, end) +
      "\n({ appUpdatesEndpoint })", {
    UPDATE_BRIDGE: { port: 56789, secret: "fixture" },
    localChangelogEndpoint() { throw new Error("not a changelog request"); },
    async readJsonBody() { return payload; },
    async requestNativeUpdate(action, fields) { forwarded.push({ action, fields }); return { installed: true }; },
    methodNotAllowed(res) { res.status = 405; },
    json(res, status, value) { res.status = status; res.value = value; },
    URL,
  });
  async function check(body, pathname = "/api/app-updates/check") {
    payload = body;
    const req = { method: "POST", headers: {
      host: "127.0.0.1:4273", origin: "http://127.0.0.1:4273",
      "content-type": "application/json", "sec-fetch-site": "same-origin",
    } };
    const res = {};
    await appUpdatesEndpoint(req, res, new URL(pathname, "http://127.0.0.1:4273"));
    return res;
  }
  assert.equal((await check({ apply: false })).status, 200);
  assert.equal(forwarded.at(-1).action, "check");
  assert.equal(forwarded.at(-1).fields.apply, false, "notifications are read-only polls");
  assert.equal((await check({ apply: true })).status, 200);
  assert.equal(forwarded.at(-1).fields.apply, true, "manual check authorizes automatic patch application");
  const count = forwarded.length;
  for (const unsafe of [{}, { apply: "true" }, { apply: true, path: "evil" }, null]) {
    assert.equal((await check(unsafe)).status, 400);
  }
  assert.equal(forwarded.length, count, "invalid check bodies must not reach the native updater");
  assert.equal((await check({}, "/api/app-updates/install")).status, 200);
  assert.equal(forwarded.at(-1).action, "install");
});
