import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const ui = readFileSync(new URL("../frontend/recommendations/recs-ui.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");

test("Random source stays accessible while excess labels and helper text are removed", () => {
  assert.match(html, /id="settings-random-source" aria-label="Random selection mode"/);
  assert.doesNotMatch(html, /When I click Random|Opens a title immediately\. Uses your current category/);
});

test("subtitle provider names link to documented key instructions without exposing input fields", () => {
  for (const [id, url] of [
    ["settings-subdl-key", "https://subdl.com/api-doc"],
    ["settings-wyzie-key", "https://store.wyzie.io/redeem"],
    ["settings-subsource-key", "https://subsource.net/dashboard/api"],
  ]) {
    assert.ok(html.includes(`href="${url}" target="_blank" rel="noopener noreferrer"`), `Official link for ${id}`);
    assert.match(html, new RegExp(`id="${id}" type="password"[^>]*aria-label=`));
  }
});

test("ratings section is simplified without changing rating count or TMDB credit obligations", () => {
  assert.match(html, /id="recs-rated-count"/);
  assert.doesNotMatch(html, /id="recs-app-usage"|id="tip-recs-app"|>Rated here</);
  assert.doesNotMatch(ui, /#recs-app-usage|Picks update on their own|Picks update when you press Update now/);
  const tmdbCard = html.slice(html.indexOf('id="recs-tmdb-title"'), html.indexOf('id="recs-updates-title"'));
  assert.doesNotMatch(tmdbCard, /This product uses the TMDB API/);
  assert.match(html, /<summary>Credits<\/summary>/);
  assert.match(html, /This product uses the TMDB API but is not endorsed or certified by TMDB/);
  assert.match(html, /data:image\/svg\+xml;base64,/);
  assert.match(app, /"Reconnect required" : "Not authorized"/);
});
