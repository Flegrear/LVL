import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = (name) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");

test("Recommendations settings advertise automatic daily refresh and explicit Update now", () => {
  const html = source("index.html");
  const recsUi = source("frontend/recommendations/recs-ui.js");
  const i18n = source("frontend/ui/ui-i18n.js");
  const section = html.slice(html.indexOf('<section class="settings-card recs-card" aria-labelledby="recs-updates-title">'),
    html.indexOf('<section class="settings-card recs-card" aria-labelledby="recs-data-title">'));

  assert.match(section, /id="recs-updates-title" data-i18n="Recommendations">Recommendations<\/h2>/);
  assert.match(section, /id="recs-refresh"[^>]*>Update now<\/button>/);
  assert.match(section, /Recommendations refresh automatically when you open LVL, at most once per day/);
  assert.match(section, /id="recs-see-picks"[^>]*data-i18n="See recommendations">See recommendations/);
  assert.doesNotMatch(section, /id="recs-mode"|id="recs-interval"|data-i18n="Manual"/,
    "Do not show stale manual/weekly toggles for a scheduler that always refreshes daily");
  assert.match(recsUi, /plural\(overview\.picks\.length, "recommendation"\)/);
  assert.doesNotMatch(recsUi, /\$\("#recs-mode"\)|\$\("#recs-interval"\)/);
  assert.match(i18n, /"See recommendations": "Ver recomendaciones"/);
});
