import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForServer(port, child) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`test server exited early with code ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/ui.css`, { method: "HEAD" });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("test server did not become ready");
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill();
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

test("runtime Home and player assets are served; developer previews stay private", { timeout: 20_000 }, async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "language-video-learner-static-"));
  const port = await freePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: projectRoot,
    env: { ...process.env, PORT: String(port), LANGUAGE_VIDEO_LEARNER_DATA_ROOT: dataRoot },
    stdio: "ignore",
    windowsHide: true,
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitForServer(port, child);
    const served = [
      ["/ui.css", "text/css", "frontend/styles/ui.css"],
      ["/ui.js", "text/javascript", "frontend/ui/ui.js"],
      ["/home-feed.js", "text/javascript", "frontend/catalog/home-feed.js"],
      ["/lvl-ratings.js", "text/javascript", "frontend/recommendations/lvl-ratings.js"],
      ["/frontend/recommendations/lvl-ratings.js", "text/javascript", "frontend/recommendations/lvl-ratings.js"],
      ["/anime-catalog-match.js", "text/javascript", "frontend/catalog/anime-catalog-match.js"],
      ["/browser-media.js", "text/javascript", "frontend/player/browser-media.js"],
      ["/audio-policy.js", "text/javascript", "shared/media/audio-policy.js"],
      ["/video-profile.js", "text/javascript", "shared/media/video-profile.js"],
      ["/playback-recovery.js", "text/javascript", "frontend/player/playback-recovery.js"],
      ["/playback-diagnostics.js", "text/javascript", "frontend/player/playback-diagnostics.js"],
      ["/series-sources.js", "text/javascript", "shared/media/series-sources.js"],
      ["/subtitle-sync.js", "text/javascript", "shared/subtitles/subtitle-sync.js"],
      ["/subtitle-stream.js", "text/javascript", "shared/subtitles/subtitle-stream.js"],
      ["/watch-discovery.js", "text/javascript", "frontend/catalog/watch-discovery.js"],
      ["/calendar-view.js", "text/javascript", "frontend/calendar/calendar-view.js"],
      ["/frontend/calendar/calendar-view.js", "text/javascript", "frontend/calendar/calendar-view.js"],
      ["/frontend/calendar/calendar-surface.js", "text/javascript", "frontend/calendar/calendar-surface.js"],
      ["/calendar.css", "text/css", "frontend/calendar/calendar.css"],
      ["/anilist-test-sync.js", "text/javascript", "frontend/anilist/anilist-test-sync.js"],
      ["/anilist-unwatch.js", "text/javascript", "frontend/anilist/anilist-unwatch.js"],
      ["/title-public-ratings.js", "text/javascript", "frontend/catalog/title-public-ratings.js"],
      ["/review-scheduler.js", "text/javascript", "learning/browser/review-scheduler.js"],
    ["/learn.js", "text/javascript", "learning/browser/learn.js"],
      ["/recs-ui.js", "text/javascript", "frontend/recommendations/recs-ui.js"],
      ["/frontend/recommendations/recs-ui.js", "text/javascript", "frontend/recommendations/recs-ui.js"],
      ["/anilist-library.js", "text/javascript", "frontend/anilist/anilist-library.js"],
      ["/icon.svg", "image/svg\\+xml", "assets/platform/icon.svg"],
      ["/site.webmanifest", "application/manifest\\+json", "assets/platform/site.webmanifest"],
      ["/title", "text/html", "index.html"],
      ["/calendar", "text/html", "index.html"],
    ];
    for (const [route, type, file] of served) {
      const response = await fetch(base + route);
      assert.equal(response.status, 200, route);
      assert.match(response.headers.get("content-type"), new RegExp(`^${type}`), route);
      assert.equal(response.headers.get("x-content-type-options"), "nosniff", route);
      assert.equal(await response.text(), fs.readFileSync(path.join(projectRoot, file), "utf8"), `${route} serves ${file}`);
    }

    const head = await fetch(`${base}/ui.js`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(Number(head.headers.get("content-length")), fs.statSync(path.join(projectRoot, "frontend/ui/ui.js")).size);

    const favicon = await fetch(`${base}/favicon.ico`);
    assert.equal(favicon.status, 200);
    assert.equal(favicon.headers.get("content-type"), "image/x-icon");
    assert.ok(Buffer.from(await favicon.arrayBuffer()).equals(fs.readFileSync(path.join(projectRoot, "assets/platform/favicon.ico"))), "/favicon.ico serves the icon file");

    for (const [url, type, file] of [
      ["/apple-touch-icon.png", "image/png", "assets/platform/apple-touch-icon.png"],
      ["/brand/app_icon_dark_192.png", "image/png", "assets/brand/dark/app_icon_dark_192.png"],
      ["/brand/app_icon_dark_512.png", "image/png", "assets/brand/dark/app_icon_dark_512.png"],
      ["/brand/lvl_favicon_light.svg", "image/svg+xml", "assets/brand/light/lvl_favicon_light.svg"],
      ["/brand/lvl_wordmark_with_name_dark_bg.svg", "image/svg+xml", "assets/brand/dark/lvl_wordmark_with_name_dark_bg.svg"],
    ]) {
      const result = await fetch(base + url);
      assert.equal(result.status, 200, url);
      assert.ok(result.headers.get("content-type")?.startsWith(type), url);
      assert.ok(Buffer.from(await result.arrayBuffer()).equals(fs.readFileSync(path.join(projectRoot, file))), `${url} serves the original brand asset`);
    }

    const home = await (await fetch(`${base}/home`)).text();
    assert.match(home, /<link rel="stylesheet" href="\/ui\.css" \/>/);
    assert.match(home, /id="home-tabs" class="ui-tabs" role="tablist"/);

    // A nested OAuth callback route MUST use root-relative assets. Otherwise
    // ./app.js resolves to /anilist/app.js (404) and tokens remain in the URL.
    const callback = await (await fetch(`${base}/anilist/callback`)).text();
    for (const asset of ["/app.js", "/styles.css", "/ui.css"]) {
      assert.match(callback, new RegExp(`(?:src|href)="${asset.replace(".", "\\.")}"`), `Callback must load ${asset} from the application root`);
      const url = new URL(asset, `${base}/anilist/callback`);
      const response = await fetch(url);
      assert.equal(response.status, 200, `OAuth callback must load ${url.pathname}`);
    }
    assert.match(callback, /window\.__lvlAniListOAuthResponse = \{ hash: window\.location\.hash \}/,
      "Callback should capture OAuth fragment before any external script loads");
    assert.match(callback, /window\.history\.replaceState\(\{ view: "settings" \}, "", "\/settings"\)/,
      "Callback must scrub the URL fragment immediately");

    for (const route of ["/server.js", "/media-compat.js", "/package.json", "/tests/ui.test.js", "/data/language-video-learner.sqlite3", "/..%2Fserver.js", "/components.json", "/components", "/components.html", "/components.js", "/components-types.js", "/components-legacy.js", "/devtools/gallery/components.js", "/recovery-demo", "/recovery-preview.js", "/devtools/recovery/recovery-preview.js"]) {
      const response = await fetch(base + route);
      assert.equal(response.status, 404, `${route} must not be served`);
    }
  } finally {
    await stopServer(child);
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});
