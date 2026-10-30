import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const first = app.indexOf("function renderRecoveryOverlay() {");
const last = app.indexOf("\nfunction ", first + 10);
assert.ok(first > 0 && last > first);
const code = app.slice(first, last);

function overlayFixture({ error = true, detail = "" } = {}) {
  const message = { hidden: true, textContent: "" };
  const loading = { classList: { contains(name) { return error && name === "is-error"; } } };
  const context = vm.createContext({
    state: { loadingDetail: detail },
    recoveryDisplayPhase: "", recoveryStallDiagnosis: null,
    currentStreamDiagnosis: () => null,
    $: (selector) => selector === "#video-recovery-message" ? message
      : selector === "#video-loading" ? loading : null,
  });
  vm.runInContext(code, context);
  vm.runInContext("renderRecoveryOverlay()", context);
  return message;
}

test("terminal sync errors display specific failure detail rather than an opaque title", () => {
  const message = overlayFixture({ detail: "Torrent seek preflight returned HTTP 422" });
  assert.equal(message.hidden, false);
  assert.equal(message.textContent, "Torrent seek preflight returned HTTP 422");
});

test("loading and ordinary recovery overlays do not expose a stale terminal detail", () => {
  const message = overlayFixture({ error: false, detail: "old HTTP 422" });
  assert.equal(message.hidden, true);
  assert.equal(message.textContent, "");
});

test("terminal details use textContent with a bounded length", () => {
  const message = overlayFixture({ detail: "<script>".repeat(100) });
  assert.equal(message.hidden, false);
  assert.equal(message.textContent.length, 240);
  assert.equal(message.textContent.startsWith("<script>"), true);
});
