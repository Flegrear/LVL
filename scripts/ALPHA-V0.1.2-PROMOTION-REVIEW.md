# LVL review candidate: `alpha-v0.1.2`

**Candidate review only — not a merged, tagged, installed or published release.**

## Version and target

- **Review branch label:** `alpha-v0.1.2`, renamed from `promotion/alpha-dev-v0.1.14` at the user's request.
- **Actual next public release version, if accepted:** `0.1.14`. Public `main`/latest release was `v0.1.13` at preparation time; a `0.1.2` version would be a downgrade. Do not infer the version from the branch label.
- **Next main promotion recommendation:** the reviewed core-media and shared feature-seam fixes on this branch, **only after real-device QA**. A later release can implement chronological decoding priority; do not imply that sequencing is in this candidate.
- The earlier staged baseline already contains selected media, subtitles, catalog and Windows updater fixes, including a full-installer fallback requirement for launcher-source changes.

## Additional reviewed runtime changes over the prior promotion candidate

| Group | Files | Purpose |
| --- | --- | --- |
| Full Watch/UI | `app.js`, `index.html`, `frontend/styles/styles.css`, `frontend/player/progressive-seek.js` | Independent GOP MSE seeking, frame/clock proof, conservative bright ranges, exact buffered-gap recovery, full-indexed MP4 handoff |
| Verified local source/cache | `backend/media/progressive-verified-source.js`, `backend/media/verified-torrent-range.js`, `backend/media/progressive-index-cache.js` | Hash-bitfield-proven local input, supported independent MKV clusters, committed FFprobe/IDR/AAC GOPs; no optional peer/network readers |
| Backend route/lifecycle | `server.js` | Progressive status/section/SSE and authenticated source/audio identity, FFmpeg resource priority, full-indexed MP4 availability, safe static module serving |
| Existing shared seams | `frontend/features/feature-host.js`, `frontend/catalog/anime-catalog-match.js`, `backend/integrations/anilist.js` | Reviewed Home/Library/reader hooks and navigation, conservative year disambiguation, shared rate-limited AniList queries |

The complete existing `0.1.14` staging baseline is retained (including `launcher/LvlUpdater.cs`, `package.json`, lockfile, installer/updater files and existing runtime modules). **Do not copy the entire private repository or merge its Git history.**

## Excluded from public candidate

- The private one-time live-torrent rescue mechanism: `LVL_PRIVATE_SESSION_RECOVERY_MANIFEST`, reused torrent UUIDs, `recoveryProtected`, private shutdown/store-preservation flags. These were useful for the private QA port5000 but are not normal LVL product functionality.
- Personal databases, BitTorrent downloads, caches, credentials, `.alpha-runtime`, `.worktrees`, debug logs, user data, build/dist outputs, private QA reports/roadmap copies and historical promotion inventories.
- Dedicated private-session reattachment helpers and disposable browser scripts under `tests/tools/`; keep only focused portable Node regression tests required to defend promoted runtime behavior.
- The proposed **STREAM-03 chronological first-to-last seek-ready scheduling**. Current independent sections may become ready out of order when bitfield-verified islands appear first. A future optimization will prioritize earliest eligible sections without falsifying readiness or preventing user-requested distant GOPs.

## Review findings and acceptance gates

1. Existing `0.1.14` staged source already exercised fully verified H264/HEVC indexed MP4 seeking, byte-range `206`, subtitle/audio switching and updater/source integration in automated tests. New code additionally exposes individually decoded sections before torrent completion and corrects gap/long-pause failure paths.
2. A downloaded-only position must stay dim until actual local hash verification, FFprobe + video IDR, selected AAC audio and original movie-clock evidence exist. Never fill a gap visually just to make the timeline continuous.
3. Real Jujutsu Kaisen E4 private QA confirmed corrected gap seeking after refresh, and the complete MP4 delivered presented frames near requested 110 s and 326 s in isolated Edge; **E5/new incomplete-episode chronological readiness, long-form resource measurements, source/audio/subtitle combinations and installer upgrade remain open**.
4. Before main: ensure the changed player modules have explicit HTTP static-route access, all imports resolve inside the packaged payload, private recovery code/fixtures are absent, Node/full installer contracts pass, updater fallback remains correct, and user verifies a fresh-episode Watch flow with no phantom loader, gap error, stale audio or pause/autoplay regression.
5. Preserve live private port5000, independent QA port5013, comics port5002, installed LVL port4273, and user media. **A review-branch push is not a public release**; no changes to `main`, installer publication, tags, release notes ledger or actual installed application without later sign-off.

The matching user-facing feature changes are recorded under `0.1.14` in `CHANGELOG.md`; **do not add STREAM-03 there as shipped functionality**.
