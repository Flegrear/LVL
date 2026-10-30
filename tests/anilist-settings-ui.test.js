import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { ANILIST_OAUTH_PENDING, readAniListPreference, startAniListLocalAuthorization } from "../frontend/anilist/anilist-auto-client.js";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const styles = readFileSync(new URL("../frontend/styles/styles.css", import.meta.url), "utf8");

const recsPanel = html.slice(
  html.indexOf('<div id="settings-panel-recs"'),
  html.indexOf('<div id="settings-panel-recs"') + 14000,
);
const start = recsPanel.indexOf('<section id="anilist-auto-settings"');
const end = recsPanel.indexOf("</section>", start);
const authorized = recsPanel.slice(start, end + "</section>".length);

test("Only the authorized AniList account row has sync and disconnect actions", () => {
  assert.ok(start >= 0 && end > start, "Authorized sync section exists under Settings › Tracking");
  assert.match(html, /id="settings-tab-recs"[^>]*data-i18n="Tracking">Tracking<\/button>/);
  assert.ok(recsPanel.indexOf('id="recs-anilist-form"') < start, "The existing username form stays above authorized sync");
  assert.ok(recsPanel.indexOf('id="recs-anilist-linked"') < start, "Public profile summary remains above authorized sync");
  assert.ok(end < recsPanel.indexOf('id="recs-letterboxd-form"'), "Authorized sync is grouped with AniList, not Letterboxd");
  assert.match(recsPanel, /<form id="recs-anilist-form"[^>]*>[\s\S]*?<input id="recs-anilist-name"[^>]*>[\s\S]*?<button[^>]+type="submit"[^>]*>Link<\/button>\s*<\/form>/);
  assert.doesNotMatch(recsPanel, /id="recs-anilist-sync"|id="recs-anilist-unlink"/,
    "Do not duplicate Sync now or Unlink above Reconnect AniList");
  assert.equal((authorized.match(/>Sync now<\/button>/g) || []).length, 1);
  assert.equal((authorized.match(/>Disconnect<\/button>/g) || []).length, 1);
  assert.doesNotMatch(authorized, /The username link above|One-time setup:/, "Remove the long account sync introduction");
  assert.doesNotMatch(authorized, /<form\s+id="recs-anilist-form"/i, "Authorized controls are independent from the public username form");
  assert.match(authorized, /<form id="anilist-auto-pin-form"/, "PIN credential entry uses its own form");
});

test("Account actions, state, and accessible status are present and uniquely identified", () => {
  const requiredIds = [
    "anilist-auto-settings", "anilist-auto-title", "anilist-auto-state",
    "anilist-auto-connect", "anilist-auto-disconnect", "anilist-auto-sync",
    "anilist-auto-redirect-url",
    "anilist-auto-enabled", "anilist-score-sync-enabled", "anilist-auto-threshold", "anilist-auto-threshold-help",
    "anilist-auto-client-settings", "anilist-auto-client-id",
    "anilist-auto-status", "anilist-auto-pin-form", "anilist-auto-pin",
    "anilist-auto-pin-submit", "anilist-auto-pin-help",
  ];
  for (const id of requiredIds) {
    assert.equal(html.match(new RegExp(`id="${id}"`, "g"))?.length, 1, `#${id} should be unique`);
    assert.ok(authorized.includes(`id="${id}"`), `#${id} belongs to AniList account sync`);
  }
  assert.match(authorized, /id="anilist-auto-settings"[^>]+aria-labelledby="anilist-auto-title"/);
  assert.match(authorized, /<button id="anilist-auto-connect"[^>]*type="button"[^>]*>Authorize account sync<\/button>/);
  assert.match(authorized, /<details id="anilist-auto-pin-fallback"/, "Keep manual PIN/token paste behind optional details");
  assert.match(authorized, /id="anilist-auto-pin" type="password"/, "Tokens are not plain-text inputs");
  assert.match(authorized, /Connect token/, "Manual authorization requires an explicit user action");
  assert.match(authorized, /The default Client ID is 53636;[\s\S]*AniList provides a separate access token/, "Explain the difference between a Client ID and an access token");
  assert.match(authorized, /<button id="anilist-auto-disconnect"[^>]*type="button" disabled>Disconnect<\/button>/);
  assert.match(authorized, /<button id="anilist-auto-sync"[^>]*type="button"[^>]*disabled>Sync now<\/button>/);
  assert.match(authorized, /id="anilist-auto-status"[^>]+role="status"[^>]+aria-live="polite"[^>]+aria-atomic="true"/);
  assert.match(authorized, /id="anilist-auto-state"[^>]*>Not authorized<\/span>/);
  assert.match(authorized, /registered Redirect URL must match this address exactly, including the port/);
  const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  assert.match(app, /redirect\.textContent = window\.location\.origin \+ ANILIST_CALLBACK_PATH/, "Callback help must use the real launch origin, not a fixed port");
});

test("Auto-sync is optional and the user can edit an 80% completion threshold", () => {
  assert.match(authorized, /<label[^>]+for="anilist-auto-enabled">[\s\S]*?<input id="anilist-auto-enabled" type="checkbox"\s*\/>/);
  assert.match(authorized, /Sync watched episodes automatically/);
  const enabled = authorized.match(/<input id="anilist-auto-enabled"[^>]*>/)?.[0] || "";
  assert.doesNotMatch(enabled, /\bchecked\b/, "Writeback must not be enabled without consent");
  assert.match(authorized, /<label[^>]+for="anilist-auto-threshold">/);
  const threshold = authorized.match(/<input id="anilist-auto-threshold"[^>]*>/)?.[0] || "";
  assert.match(threshold, /type="number"/);
  assert.match(threshold, /min="1"/);
  assert.match(threshold, /max="100"/);
  assert.match(threshold, /value="80"/);
  assert.match(threshold, /aria-describedby="anilist-auto-threshold-help"/);
  assert.match(authorized, /id="anilist-auto-threshold-help"[^>]*>[^<]*Default 80%/);
});

test("Shared Client ID appears inside optional manual connection settings", () => {
  assert.match(authorized, /<details id="anilist-auto-pin-fallback"[^>]*>/);
  assert.match(authorized, /<summary>Manual connection<\/summary>/);
  assert.match(authorized, /<div id="anilist-auto-client-settings"/);
  assert.match(authorized, /<label[^>]+for="anilist-auto-client-id">/);
  const idField = authorized.match(/<input id="anilist-auto-client-id"[^>]*>/)?.[0] || "";
  assert.match(idField, /type="text"/);
  assert.match(idField, /inputmode="numeric"/);
  assert.match(idField, /autocomplete="off"/);
  assert.match(idField, /value="53636"/, "Show the default Client ID immediately");
  assert.match(idField, /aria-describedby="anilist-auto-pin-help"/);
  assert.match(authorized, /change it only if you registered your own AniList app/);
});

test("Scoped account panel styles wrap actions and stack settings on narrow screens", () => {
  for (const selector of [
    ".anilist-auto-settings", ".anilist-auto-heading", ".anilist-auto-actions", ".anilist-auto-pin-form",
    ".anilist-auto-options", ".anilist-auto-toggle-copy", ".anilist-auto-threshold",
    ".anilist-auto-client-settings", ".anilist-auto-status",
  ]) {
    assert.ok(styles.includes(selector), `Missing styling for ${selector}`);
  }
  assert.match(styles, /\.anilist-auto-actions\s*\{[^}]*flex-wrap:wrap;/);
  assert.match(styles, /\.anilist-auto-pin-form\s*\{[^}]*grid-template-columns:minmax\(0,1fr\) auto;/);
  assert.match(styles, /\.anilist-auto-settings > \.anilist-auto-status:not\(\[data-error="true"\]\)/, "Normal status updates remain available to screen readers without adding a paragraph to the layout");
  assert.match(styles, /\.anilist-auto-options\s*\{[^}]*grid-template-columns:/);
  assert.match(styles, /@media \(max-width:860px\)\s*\{[\s\S]*?\.anilist-auto-options\s*\{\s*grid-template-columns:minmax\(0,1fr\);/);
  assert.match(styles, /\.anilist-auto-client-settings > summary:focus-visible/);
});

test("AniList Connect works independently of main app startup and only navigates the same tab", () => {
  const inlineModule = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1] || "";
  assert.match(inlineModule, /from "\/anilist-auto-client\.js"/, "Independent login must load client code from the root even on nested paths");
  assert.match(inlineModule, /getElementById\("anilist-auto-connect"\).*addEventListener\("click"/, "Connect must be wired without app.js initialization");
  const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const handler = app.slice(app.indexOf("function wireAniListAutoSettings()"), app.indexOf("\nfunction syncAniListLibrary(", app.indexOf("function wireAniListAutoSettings()")));
  assert.doesNotMatch(handler, /getElementById\("anilist-auto-connect"\)|\$\("#anilist-auto-connect"\).*addEventListener/, "Main app must not register a duplicate Connect handler");

  let click;
  let navigation = null;
  const status = { textContent: "", dataset: {} };
  const elements = {
    "anilist-auto-connect": { addEventListener: (event, callback) => { assert.equal(event, "click"); click = callback; } },
    "anilist-auto-status": status,
    "anilist-auto-pin-fallback": { setAttribute: () => {} },
  };
  const store = new Map();
  const storage = {
    getItem: (key) => store.get(key) || null,
    setItem: (key, value) => store.set(key, value),
    removeItem: (key) => store.delete(key),
  };
  const localStorage = storage;
  const sessionStorage = storage;
  const code = inlineModule.replace(/^\s*import\s*\{[^}]+\}\s*from\s*"\/anilist-auto-client\.js";\s*/m, "");
  vm.runInNewContext(code, {
    document: { getElementById: (id) => elements[id] ?? null },
    readAniListPreference, startAniListLocalAuthorization,
    ANILIST_CALLBACK_PATH: "/anilist/callback", localStorage, sessionStorage,
    window: { location: { origin: "http://127.0.0.1:4187", assign: (value) => { navigation = value; } } },
  });
  assert.equal(typeof click, "function");
  click();
  const url = new URL(navigation);
  assert.equal(url.origin, "https://anilist.co");
  assert.equal(url.searchParams.get("client_id"), "53636");
  assert.equal(url.searchParams.get("response_type"), "token");
  assert.equal(JSON.parse(sessionStorage.getItem(ANILIST_OAUTH_PENDING)).origin, "http://127.0.0.1:4187");
  assert.match(status.textContent, /Opening AniList/);
});

test("Live AniList add/remove diagnostics remain hidden outside the isolated dev server and require a click", () => {
  const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  assert.match(authorized, /<details id="anilist-auto-dev-diagnostics"[^>]*hidden>/,
    "Real AniList writes must never be an always-visible default action");
  assert.match(app, /diagnostics\.hidden = window\.location\.port !== "4187" \|\| !account/);
  assert.match(app, /getElementById|\$\("#anilist-auto-dev-test"\)\?\.addEventListener\("click"/);
  assert.match(app, /stillConnected: \(\) => readAniListAccount\(localStorage\)\?\.token === account\.token/);
});
