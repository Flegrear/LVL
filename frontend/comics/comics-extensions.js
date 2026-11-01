// Sections added to title pages, the Home "Comics" tab and Settings › Comics:
// C3 (links with anime), C4 (sources), C5 (ratings, AniList tracking, new
// chapters). Each entry is async and must not throw into the page.
import { mangaTitleSection } from "./comics-links.js";
import { videoComicsSection } from "./comics-video.js";
import { sourcesSettingsSection } from "./comics-sources.js";
import { anilistSettingsSection, newChaptersShelf, pushProgress, pushStatus } from "./comics-tracking.js";

export const COMIC_HOME_SECTIONS = [newChaptersShelf];  // (ctx) => Promise<string> (shelf markup or "")
export const COMIC_SETTINGS_SECTIONS = [sourcesSettingsSection, anilistSettingsSection]; // (holder, ctx) => void
// The "Manga" chip on title pages: after an anime's seasons, and on a manga's own page (core titleSections hook).
// "Comics": on series and movie pages that have no Manga chip.
export const TITLE_SECTIONS = [mangaTitleSection, videoComicsSection];
export const COMIC_HOOKS = {
  statusChanged: (workId, status, ctx) => pushStatus(workId, status, ctx),
  readerClosed: (workId, ctx, comic) => pushProgress(workId, ctx, { chaptersTotal: comic?.chapters ?? null }),
};
