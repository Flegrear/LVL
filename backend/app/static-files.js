// The files the server hands to the browser: the fixed table and serveStatic.
import fs from "node:fs";
import path from "node:path";
import { mime, root } from "../../server.js";

export const PUBLIC_ASSETS = new Map([
  ["/", { file: "index.html", cacheControl: "no-store" }],
  ["/index.html", { file: "index.html", cacheControl: "no-store" }],
  ["/home", { file: "index.html", cacheControl: "no-store" }],
  ["/watch", { file: "index.html", cacheControl: "no-store" }],
  ["/library", { file: "index.html", cacheControl: "no-store" }],
  ["/calendar", { file: "index.html", cacheControl: "no-store" }],
  ["/title", { file: "index.html", cacheControl: "no-store" }],
  ["/study", { file: "index.html", cacheControl: "no-store" }],
  ["/review", { file: "index.html", cacheControl: "no-store" }],
  ["/test", { file: "index.html", cacheControl: "no-store" }],
  ["/tests", { file: "index.html", cacheControl: "no-store" }],
  ["/settings", { file: "index.html", cacheControl: "no-store" }],
  // AniList OAuth implicit grant returns its bearer token in a URL fragment;
  // the SPA consumes it entirely in the browser. Node never receives it.
  ["/anilist/callback", { file: "index.html", cacheControl: "no-store" }],
  ["/app.js", { file: "app.js", cacheControl: "no-cache" }],
  ["/lvl-ratings.js", { file: "frontend/recommendations/lvl-ratings.js", cacheControl: "no-cache" }],
  ["/frontend/recommendations/lvl-ratings.js", { file: "frontend/recommendations/lvl-ratings.js", cacheControl: "no-cache" }],
  ["/anime-catalog-match.js", { file: "frontend/catalog/anime-catalog-match.js", cacheControl: "no-cache" }],
  ["/calendar-view.js", { file: "frontend/calendar/calendar-view.js", cacheControl: "no-cache" }],
  ["/calendar-surface.js", { file: "frontend/calendar/calendar-surface.js", cacheControl: "no-cache" }],
  ["/frontend/calendar/calendar-view.js", { file: "frontend/calendar/calendar-view.js", cacheControl: "no-cache" }],
  ["/frontend/calendar/calendar-surface.js", { file: "frontend/calendar/calendar-surface.js", cacheControl: "no-cache" }],
  ["/anilist-auto-client.js", { file: "frontend/anilist/anilist-auto-client.js", cacheControl: "no-cache" }],
  ["/anilist-score-sync.js", { file: "frontend/anilist/anilist-score-sync.js", cacheControl: "no-cache" }],
  ["/title-public-ratings.js", { file: "frontend/catalog/title-public-ratings.js", cacheControl: "no-cache" }],
  ["/anilist-watch-sync.js", { file: "frontend/anilist/anilist-watch-sync.js", cacheControl: "no-cache" }],
  ["/anilist-unwatch.js", { file: "frontend/anilist/anilist-unwatch.js", cacheControl: "no-cache" }],
  ["/anilist-test-sync.js", { file: "frontend/anilist/anilist-test-sync.js", cacheControl: "no-cache" }],
  ["/browser-media.js", { file: "frontend/player/browser-media.js", cacheControl: "no-cache" }],
  ["/audio-policy.js", { file: "shared/media/audio-policy.js", cacheControl: "no-cache" }],
  ["/video-profile.js", { file: "shared/media/video-profile.js", cacheControl: "no-cache" }],
  ["/playback-recovery.js", { file: "frontend/player/playback-recovery.js", cacheControl: "no-cache" }],
  ["/playback-diagnostics.js", { file: "frontend/player/playback-diagnostics.js", cacheControl: "no-cache" }],
  ["/core.js", { file: "learning/browser/core.js", cacheControl: "no-cache" }],
  ["/review-scheduler.js", { file: "learning/browser/review-scheduler.js", cacheControl: "no-cache" }],
  ["/styles.css", { file: "frontend/styles/styles.css", cacheControl: "no-cache" }],
  ["/calendar.css", { file: "frontend/calendar/calendar.css", cacheControl: "no-cache" }],
  ["/frontend/calendar/calendar.css", { file: "frontend/calendar/calendar.css", cacheControl: "no-cache" }],
  ["/ui.css", { file: "frontend/styles/ui.css", cacheControl: "no-cache" }],
  ["/ui.js", { file: "frontend/ui/ui.js", cacheControl: "no-cache" }],
  ["/home-feed.js", { file: "frontend/catalog/home-feed.js", cacheControl: "no-cache" }],
  ["/series-sources.js", { file: "shared/media/series-sources.js", cacheControl: "no-cache" }],
  ["/subtitle-sync.js", { file: "shared/subtitles/subtitle-sync.js", cacheControl: "no-cache" }],
  ["/subtitle-stream.js", { file: "shared/subtitles/subtitle-stream.js", cacheControl: "no-cache" }],
  ["/watch-discovery.js", { file: "frontend/catalog/watch-discovery.js", cacheControl: "no-cache" }],
  ["/learn.js", { file: "learning/browser/learn.js", cacheControl: "no-cache" }],
  ["/recs-ui.js", { file: "frontend/recommendations/recs-ui.js", cacheControl: "no-cache" }],
  ["/frontend/recommendations/recs-ui.js", { file: "frontend/recommendations/recs-ui.js", cacheControl: "no-cache" }],
  ["/anilist-library.js", { file: "frontend/anilist/anilist-library.js", cacheControl: "no-cache" }],
  ["/language-settings.js", { file: "shared/settings/language-settings.js", cacheControl: "no-cache" }],
  ["/ui-i18n.js", { file: "frontend/ui/ui-i18n.js", cacheControl: "no-cache" }],
  ["/vocabulary-meanings.js", { file: "learning/browser/vocabulary-meanings.js", cacheControl: "no-cache" }],
  ["/favicon.ico", { file: "assets/platform/favicon.ico", cacheControl: "no-cache" }],
  ["/icon.svg", { file: "assets/platform/icon.svg", cacheControl: "no-cache" }],
  ["/apple-touch-icon.png", { file: "assets/platform/apple-touch-icon.png", cacheControl: "no-cache" }],
  ["/site.webmanifest", { file: "assets/platform/site.webmanifest", cacheControl: "no-cache" }],
  ["/frontend/catalog/anime-catalog-match.js", { file: "frontend/catalog/anime-catalog-match.js", cacheControl: "no-cache" }],
  ["/frontend/anilist/anilist-auto-client.js", { file: "frontend/anilist/anilist-auto-client.js", cacheControl: "no-cache" }],
  ["/frontend/anilist/anilist-auto-association.js", { file: "frontend/anilist/anilist-auto-association.js", cacheControl: "no-cache" }],
  ["/frontend/anilist/anilist-manual-season-link.js", { file: "frontend/anilist/anilist-manual-season-link.js", cacheControl: "no-cache" }],
  ["/frontend/anilist/anilist-score-sync.js", { file: "frontend/anilist/anilist-score-sync.js", cacheControl: "no-cache" }],
  ["/frontend/catalog/title-public-ratings.js", { file: "frontend/catalog/title-public-ratings.js", cacheControl: "no-cache" }],
  ["/frontend/anilist/anilist-watch-sync.js", { file: "frontend/anilist/anilist-watch-sync.js", cacheControl: "no-cache" }],
  ["/frontend/anilist/anilist-unwatch.js", { file: "frontend/anilist/anilist-unwatch.js", cacheControl: "no-cache" }],
  ["/frontend/anilist/anilist-test-sync.js", { file: "frontend/anilist/anilist-test-sync.js", cacheControl: "no-cache" }],
  ["/frontend/player/browser-media.js", { file: "frontend/player/browser-media.js", cacheControl: "no-cache" }],
  ["/frontend/player/remux-mse.js", { file: "frontend/player/remux-mse.js", cacheControl: "no-cache" }],
  ["/frontend/player/embedded-subtitle-default.js", { file: "frontend/player/embedded-subtitle-default.js", cacheControl: "no-cache" }],
  ["/frontend/player/media-startup.js", { file: "frontend/player/media-startup.js", cacheControl: "no-cache" }],
  ["/shared/html.js", { file: "shared/html.js", cacheControl: "no-cache" }],
  ["/shared/media/audio-policy.js", { file: "shared/media/audio-policy.js", cacheControl: "no-cache" }],
  ["/shared/media/video-profile.js", { file: "shared/media/video-profile.js", cacheControl: "no-cache" }],
  ["/frontend/player/playback-recovery.js", { file: "frontend/player/playback-recovery.js", cacheControl: "no-cache" }],
  ["/frontend/player/playback-diagnostics.js", { file: "frontend/player/playback-diagnostics.js", cacheControl: "no-cache" }],
  ["/learning/browser/core.js", { file: "learning/browser/core.js", cacheControl: "no-cache" }],
  ["/learning/browser/review-scheduler.js", { file: "learning/browser/review-scheduler.js", cacheControl: "no-cache" }],
  ["/frontend/styles/styles.css", { file: "frontend/styles/styles.css", cacheControl: "no-cache" }],
  ["/frontend/styles/ui.css", { file: "frontend/styles/ui.css", cacheControl: "no-cache" }],
  ["/frontend/ui/ui.js", { file: "frontend/ui/ui.js", cacheControl: "no-cache" }],
  ["/frontend/catalog/home-feed.js", { file: "frontend/catalog/home-feed.js", cacheControl: "no-cache" }],
  ["/shared/media/series-sources.js", { file: "shared/media/series-sources.js", cacheControl: "no-cache" }],
  ["/shared/subtitles/subtitle-sync.js", { file: "shared/subtitles/subtitle-sync.js", cacheControl: "no-cache" }],
  ["/shared/subtitles/subtitle-stream.js", { file: "shared/subtitles/subtitle-stream.js", cacheControl: "no-cache" }],
  ["/frontend/catalog/watch-discovery.js", { file: "frontend/catalog/watch-discovery.js", cacheControl: "no-cache" }],
  ["/learning/browser/learn.js", { file: "learning/browser/learn.js", cacheControl: "no-cache" }],
  ["/frontend/anilist/anilist-library.js", { file: "frontend/anilist/anilist-library.js", cacheControl: "no-cache" }],
  ["/shared/settings/language-settings.js", { file: "shared/settings/language-settings.js", cacheControl: "no-cache" }],
  ["/frontend/ui/ui-i18n.js", { file: "frontend/ui/ui-i18n.js", cacheControl: "no-cache" }],
  ["/frontend/features/feature-host.js", { file: "frontend/features/feature-host.js", cacheControl: "no-cache" }],
  ["/frontend/features/registry.js", { file: "frontend/features/registry.js", cacheControl: "no-cache" }],
  ["/frontend/player/performance-trace.js", { file: "frontend/player/performance-trace.js", cacheControl: "no-cache" }],
  ["/frontend/player/stream-status.js", { file: "frontend/player/stream-status.js", cacheControl: "no-cache" }],
  ["/frontend/player/progressive-seek.js", { file: "frontend/player/progressive-seek.js", cacheControl: "no-cache" }],
  ["/frontend/player/torrent-piece-wait.js", { file: "frontend/player/torrent-piece-wait.js", cacheControl: "no-cache" }],
  ["/frontend/updates/update-view.js", { file: "frontend/updates/update-view.js", cacheControl: "no-cache" }],
  ["/learning/browser/vocabulary-meanings.js", { file: "learning/browser/vocabulary-meanings.js", cacheControl: "no-cache" }],
]);

// app.js's area modules (it and they import each other by these paths).
export function addBuiltInAssets() {
  for (const file of [
    "frontend/anilist/anilist-sync.js",
    "frontend/app/dom.js",
    "frontend/app/http.js",
    "frontend/app/navigation.js",
    "frontend/app/saved-state.js",
    "frontend/catalog/catalog-search.js",
    "frontend/home/anime-browser.js",
    "frontend/home/home-page.js",
    "frontend/home/random-pick.js",
    "frontend/learning/clips.js",
    "frontend/learning/index.js",
    "frontend/learning/learning-state.js",
    "frontend/learning/learning-views.js",
    "frontend/learning/review-quiz.js",
    "frontend/learning/scored-tests.js",
    "frontend/learning/study-decks.js",
    "frontend/learning/study-page.js",
    "frontend/learning/study-vocabulary.js",
    "frontend/learning/vocabulary-cards.js",
    "frontend/learning/voice-coach.js",
    "frontend/library/library-backup.js",
    "frontend/library/library-data.js",
    "frontend/library/library-page.js",
    "frontend/player/audio-sync.js",
    "frontend/player/embedded-subtitles.js",
    "frontend/player/episode-skips.js",
    "frontend/player/floating-player.js",
    "frontend/player/player-core.js",
    "frontend/player/player-menus.js",
    "frontend/player/player-tracks.js",
    "frontend/player/phone-seek-input.js",
    "frontend/player/phone-seek-lifecycle.js",
    "frontend/player/video-conversion-capability.js",
    "frontend/player/fast-seek-state.js",
    "frontend/player/subtitle-display.js",
    "frontend/player/subtitle-pairing.js",
    "frontend/player/subtitle-search.js",
    "frontend/player/subtitle-style.js",
    "frontend/player/subtitle-timing.js",
    "frontend/player/torrent-playback.js",
    "frontend/settings/settings-page.js",
    "frontend/settings/storage-settings.js",
    "frontend/phone/shell-ui.js",
    "frontend/phone/shell.css",
    "frontend/phone/player-controls.js",
    "frontend/phone/player-controls.css",
    "frontend/phone/catalog-ui.js",
    "frontend/phone/catalog-ui.css",
    "frontend/title/title-chapters.js",
    "frontend/title/title-page.js",
    "frontend/ui/popup-menu.js",
    "frontend/updates/app-updates.js",
    "frontend/watch/episode-navigation.js",
    "frontend/watch/watch-page.js",
    "frontend/watch/watched-status.js",
  ]) PUBLIC_ASSETS.set(`/${file}`, { file, cacheControl: "no-cache" });

  // The only public /brand/* files are the fixed, vetted icon/wordmark exports.
  // No arbitrary filesystem paths are made available by this directory.
  for (const theme of ["dark", "light"]) {
    const brandNames = [
      ...[180, 192, 256, 512].map((size) => `app_icon_${theme}_${size}.png`),
      `favicon_${theme}.ico`,
      ...[16, 32, 48, 64, 128, 256].map((size) => `favicon_${theme}_${size}.png`),
      ...["app_icon", "favicon", "favicon_circle"].flatMap((name) => ["svg", "png"].map((ext) => `lvl_${name}_${theme}.${ext}`)),
      ...["wordmark", "wordmark_with_name"].flatMap((name) => ["svg", "png"].map((ext) => `lvl_${name}_${theme}_bg.${ext}`)),
    ];
    for (const name of brandNames) PUBLIC_ASSETS.set(`/brand/${name}`, { file: `assets/brand/${theme}/${name}`, cacheControl: "no-cache" });
  }
  for (const ink of ["black", "white"]) {
    for (const ext of ["svg", "png"]) {
      const name = `lvl_v_mark_${ink}_transparent.${ext}`;
      PUBLIC_ASSETS.set(`/brand/${name}`, { file: `assets/brand/marks/${name}`, cacheControl: "no-cache" });
    }
  }
}

export function serveStatic(req, res, url) {
  const asset = PUBLIC_ASSETS.get(url.pathname);
  if (!asset) {
    res.writeHead(404, { "Cache-Control": "no-store" });
    res.end(req.method === "HEAD" ? undefined : "Not found");
    return;
  }

  const fullPath = path.join(root, asset.file);
  fs.stat(fullPath, (statError, stat) => {
    if (statError || !stat.isFile()) {
      res.writeHead(404, { "Cache-Control": "no-store" });
      res.end(req.method === "HEAD" ? undefined : "Not found");
      return;
    }

    const headers = {
      "Content-Type": mime[path.extname(fullPath).toLowerCase()] || "application/octet-stream",
      "Content-Length": stat.size,
      "Cache-Control": asset.cacheControl,
      "X-Content-Type-Options": "nosniff",
    };
    if (req.method === "HEAD") {
      res.writeHead(200, headers);
      res.end();
      return;
    }

    fs.readFile(fullPath, (readError, data) => {
      if (readError) {
        res.writeHead(404, { "Cache-Control": "no-store" });
        res.end("Not found");
        return;
      }
      res.writeHead(200, headers);
      res.end(data);
    });
  });
}
