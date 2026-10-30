import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
const begin = server.indexOf("function shouldRetryErroredTorrentSession(");
const end = server.indexOf("\nasync function createTorrentSession(", begin);
assert.ok(begin >= 0 && end > begin);
const context = vm.createContext({});
vm.runInContext(server.slice(begin, end), context);
const shouldRetry = (session, index = null) =>
  vm.runInContext("shouldRetryErroredTorrentSession(session, index)", vm.createContext({
    shouldRetryErroredTorrentSession: context.shouldRetryErroredTorrentSession, session, index,
  }));

test("magnet-only retry recreates errored peer/tracker sessions", () => {
  assert.equal(shouldRetry({ state: "error", safety: { ok: true } }), true);
  assert.equal(shouldRetry({ state: "error" }), true);
  assert.equal(shouldRetry({ state: "ready", safety: { ok: true } }), false);
  assert.match(server, /if \(shouldRetryErroredTorrentSession\(existingSession, preferredFileIndex\)\) \{\s*await removeTorrentSession\(existingSession\.id\)/);
});

test("known unsafe torrents remain blocked unless the user requests a different file", () => {
  assert.equal(shouldRetry({ state: "error", safety: { ok: false } }), false);
  assert.equal(shouldRetry({ state: "error", safety: { ok: false } }, 0), true);
});
