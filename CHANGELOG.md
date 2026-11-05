# LVL Changelog

## 0.2.4 — 2026-11-05

- Fix Windows update checks when Android releases appear between Windows versions.
- Improve Watch playback when seeking, pausing and returning to a video.
- Make phone browsing more comfortable with smaller posters and easier filters.
- Refine the comic reader and chapter navigation on smaller screens.
- Fix importing a public AniList list while a different account is connected.

## 0.2.3 — 2026-11-02

- Make Library rename prompts match the rest of LVL.
- Make confirmations for storage, imports and AniList changes open inside LVL.
- Keep the pop-up player available across updates without downloading it again for each version.

## 0.2.2 — 2026-11-01

- Add sync between your devices in Settings › Library: your Library, where you are in each video and chapter, your ratings and your comics, kept in a private GitHub repository.
- Add importing your library, sources and reading progress from a Mihon or Tachiyomi backup in Settings › Comics.
- Make the arrow keys skip back and forward in the player, and hide the pointer with the player controls until the mouse moves.
- Make the comic reader's arrows, side clicks and mouse wheel follow the reading direction.
- Refine Settings: fewer status labels, confirmations in LVL's own window, a simpler Comics switch and check marks for added sources.
- Fix the source details window staying open after adding a source.

## 0.2.1 — 2026-11-01

- Make the pop-up player a borderless window that stays above other apps, with no browser bar.
- Move the pop-up by dragging the video and resize it from its edges; it keeps the video's shape and remembers where you left it.
- Close the pop-up with Escape, ✕ or Return; playback continues in LVL from where the pop-up was.
- Remove the floating player choice from Settings: the pop-up is now the only floating player.

## 0.2.0 — 2026-10-31

- Add Comics: browse, search and read manga, manhwa and manhua, with their own tab on Home and in the Library.
- Read from your own files (CBZ or image folders) or from comic sources you add in Settings › Comics.
- Show a manga's chapters on its anime's page, and comics on series and movie pages.
- Rate comics by volume and keep your manga progress, status and score in sync with AniList.
- Add a switch in Settings › Comics to turn Comics off.
- Move ratings and AniList settings into Settings › Library.
- Move an anime's films into a Movies tab next to its seasons, and fix pages showing another title's films.

## 0.1.18 — 2026-10-31

- Fix two-way rating sync with AniList: your AniList scores now become your LVL ratings, and when both have a different score, AniList's is kept.
- Send LVL ratings to AniList on their own for anime that have no AniList score yet.
- Add Migrate scores from AniList to Settings, to copy your AniList scores into LVL at any time.

## 0.1.17 — 2026-10-31

- Make the whole episode seekable about a minute after it finishes downloading, instead of several minutes later.
- Fix short pauses with the loader during playback when LVL switched to a better copy of the video.
- Keep subtitle size and romanized text the same when switching or adding subtitle tracks during a video.
- Add a subtitle track from the video even when the current part of the episode has no lines; they appear as it plays.
- Remove the line count from subtitle tracks; it belongs to the Learning section.
- Block peers that send damaged data, so downloads don't keep fetching the same parts again.
- Check for updates every hour when automatic updates are on, so new versions arrive the same day.

## 0.1.16 — 2026-10-31

- Show a progress bar while an update downloads and installs.
- Show a notice when an update is ready, with Install now and Later, and confirm it after LVL restarts.
- Open Settings › Updates from the update notification in the bell menu.
- Make automatic updates wait until no video is open.
- Fix the error message and stuck "Installing…" button shown while LVL restarts after an update.
- Fix later parts of a paused video not becoming ready to seek until playback resumed.

## 0.1.15 — 2026-10-31

- Install every update in the background, without the Setup wizard; LVL restarts and reloads its window on its own.
- Remove downloaded update files and files left over from older versions after updating.

## 0.1.14 — 2026-10-31

- Seek instantly in compatible videos, including the parts of an episode that have already downloaded. The timeline shows which parts are ready. Turn it off in Settings › Storage.
- Fix seeking into parts of a video that aren't ready yet, and resuming after a long pause.
- Make seeking, pausing, resuming and switching sources faster and more reliable, with clearer error messages.
- Improve audio track choice, embedded subtitles, subtitle sync and text, and chapter detection.
- Fix newer seasons of some series linking to the original series in the Library; add fallback covers and safer Library and calendar updates.
- Refine Watch and Settings, and make the Windows updater more reliable.

## 0.1.13 — 2026-10-26

- Make subtitles more stable, and remember your audio choice across episodes.
- Simplify Settings and improve the daily update check.

## 0.1.12 — 2026-10-26

- Fix subtitles disappearing when you switch audio tracks; each dub keeps its own subtitle timing.
- Keep subtitles in sync when an audio track fails to switch.
- Fix built-in subtitles stopping when you pick them while they're still loading.

## 0.1.11 — 2026-10-26

- Separate checking for updates from installing them.
- Show in Settings whether an update installs inside the app or needs the full installer.
- Update from 0.1.1 inside the app, without downloading the installer again.

## 0.1.1 — 2026-10-26

- Test the updater: LVL 0.1.0 finds this release and installs it over the current version.
- Show release notes inside LVL.

## 0.1.0 — 2026-10-26

- First public alpha: video playback, customizable subtitles, the Library and discovery.
- Add update settings, and support for small updates installed inside the app.
