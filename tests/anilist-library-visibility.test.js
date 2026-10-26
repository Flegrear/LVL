import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../frontend/styles/styles.css", import.meta.url), "utf8");

test("AniList summary is removed, but the imported-anime filter remains accessible from Library actions", () => {
  assert.doesNotMatch(html, /id="library-anilist-summary"|imported titles -/);
  assert.equal((html.match(/id="library-show-anilist"/g) || []).length, 1);
  assert.match(app, /libraryView\.filter = "anime";\s*libraryView\.status = "any";\s*libraryView\.query = ""/);
});

test("Library cards retain episode count and genuine public score without substituting personal ratings", () => {
  const card = app.slice(app.indexOf("function libraryCardItem("), app.indexOf("\nfunction libraryMoreButton(", app.indexOf("function libraryCardItem(")));
  assert.match(card, /chapters/);
  assert.match(card, /publicAverage/);
  assert.doesNotMatch(card, /anilistRatingText\(anilist\)/);
  const progress = app.slice(app.indexOf("function titleProgressMarkup("), app.indexOf("\nfunction titleAboutMarkup(", app.indexOf("function titleProgressMarkup(")));
  assert.doesNotMatch(progress, /AniList episodes watched|AniList rating|ui-stat-group title-stats/, "User removed the redundant title stat cards");
  assert.match(progress, /Link AniList manually/, "Keep a compact identity-link fallback for unverified seasons");
  assert.doesNotMatch(progress, /This anime season is not linked to AniList|Search AniList/);
  assert.doesNotMatch(progress, /episode\.progress = \{/);
});
