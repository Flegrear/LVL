import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cardMarkup } from "../frontend/ui/ui.js";

const styles = readFileSync(new URL("../frontend/styles/styles.css", import.meta.url), "utf8");
const ui = readFileSync(new URL("../frontend/styles/ui.css", import.meta.url), "utf8");

test("Library cards constrain long titles and AniList metadata within their grid tracks", () => {
  const html = cardMarkup({
    key: "sao", title: "Sword Art Online the Movie - Progressive - Aria of a Starless Night",
    meta: ["Anime series", "2021", "S1 E23 of 23", "Your rating: 9.8"],
    badge: "COMPLETED",
  }, { primaryAction: "library" });
  assert.match(html, /class="ui-card ui-card--poster"/);
  assert.match(html, /class="ui-card__title"/);
  assert.match(html, /class="ui-card__meta"><span class="ui-meta">/);
  assert.match(ui, /\.ui-card__hit\s*\{[^}]*min-width:\s*0\s*;/);
  assert.match(ui, /\.ui-card__body\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(ui, /\.ui-card__title\s*\{[^}]*min-width:\s*0/);
  assert.match(ui, /\.ui-card__meta\s*\{[^}]*max-width:\s*100%\s*;[^}]*overflow:\s*hidden/);
  assert.match(ui, /\.ui-card__meta \.ui-meta\s*\{[^}]*width:\s*100%\s*;[^}]*overflow:\s*hidden/);
  assert.match(styles, /\.lib-grid \.ui-card__meta \.ui-meta\s*\{[^}]*display:flex;[^}]*flex-wrap:wrap;/);
  assert.match(styles, /\.lib-grid \.ui-card__meta \.ui-meta > \* \+ \*::before\s*\{\s*display:none;/);
});

test("connected AniList accounts show Reconnect rather than the initial authorization label", () => {
  const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  assert.match(app, /connect\.textContent = account \? "Reconnect AniList" : "Authorize account sync"/);
  assert.match(app, /connect\.title = account \? `Already connected as/);
});
