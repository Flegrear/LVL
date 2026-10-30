# LVL Changelog

## 0.1.14 — 2026-10-30

- Add full-episode indexed seeking for fully verified compatible H.264 and HEVC SDR torrents, with disk-safe cache, accurate presented frames, and a default-on Settings switch.
- Improve fast local seeking, pause/resume, source switching, recovery messages, FFmpeg cleanup, and truthful playback progress and duration.
- Improve selected dub and channel handling, embedded subtitle priority, seek synchronization, ASS text fidelity, and chapter detection.
- Fix newer Jujutsu Kaisen seasons linking to the original Library series; add missing anime cover fallback, safer Library/calendar updates, and Watch/Settings UI refinements.
- Improve diagnostic safety, playback telemetry, and Windows updater TLS initialization.

## 0.1.13 — 2026-10-26

- Stabilize subtitles and remember audio choices across episodes.
- Simplify Settings and improve daily update checks.

## 0.1.12 — 2026-10-26

- Fix subtitles disappearing when switching audio tracks by restoring saved, dub-specific subtitle timing.
- Preserve the previous subtitle alignment when an audio-track change fails to start.
- Keep embedded subtitle extraction active when its track is selected while still loading.

## 0.1.11 — 2026-10-26

- Updater fixes: separate manual update checking from the Install action.
- Clarify the difference between incremental ZIP updates and full setup upgrades in Settings.
- Exercise the verified, in-place incremental update path from LVL Alpha 0.1.1 without downloading another setup.

## 0.1.1 — 2026-10-26

- Updater test: verify that installed LVL Alpha 0.1.0 detects and installs a tagged release from GitHub.
- Deliver a complete in-place installer update to exercise the initial upgrade path.
- Replace the placeholder changelog with release notes shown inside LVL.

## 0.1.0 — 2026-10-26

- Initial public LVL Alpha release with local video playback, subtitle customization, Library and discovery features.
- Introduce update settings and support for future incremental releases.
