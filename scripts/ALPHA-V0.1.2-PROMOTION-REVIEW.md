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

**Preparation evidence:** The reviewed private source was committed at `5ff6a43`; the public candidate's implementation was selectively committed at `c87a81b` before the final documentation update. **Public Node regression: 1,466/1,466 PASS**, no failures/skips; focused release-inputs/installer-isolation/updater/changelog checks **21/21 PASS**. Production source-only staging enumerated **182 files** and included all four new progressive runtime modules and `CHANGELOG.md`, with **zero tests, private recovery scripts, user files, SQLite, logs or Git metadata**. Existing 41 `learning/data/` resources remain as legitimate application inputs. Syntax validation and staged `git diff --check` also passed. The old remote promotion branch was replaced with `origin/alpha-v0.1.2` after verifying the replacement; `origin/main` remained unchanged.

**Follow-up long-pause review (2026-10-30/31):** A fresh JJK E5 completed source eventually returned a fully indexed MP4 after browser refresh, but an earlier long pause left Watch stuck. The completed MP4 write itself spanned ~43 seconds; download completion and status-discovery timings remain uncertain. Private source fix `da36d4b` was selectively ported here: bounded progressive section HTTP body (8s), nonsticky recovery locks after source replacement, late Pause-intent protection, one-way native fallback for unready GOPs, and long-pause resume using a verified complete MP4 instead of another FFmpeg worker where possible. SSE subscriptions now count as active viewer leases so a **connected** paused player does not have its ordinary 30-minute torrent session expired; a fully disconnected/suspended browser still needs further lifecycle/reconnect design. This fixes source-proven risks but **does not constitute a user-witnessed E5 post-fix long-pause acceptance**. No private operator recovery/UUID spoofing or personal cache files were copied.

**Follow-up release checks:** Full candidate Node suite **1,474/1,474 PASS** (zero failures/skips), installer/source isolation and updater contracts **21/21 PASS**, 182 staged runtime inputs, zero leaked private recovery/user files and `git diff --check` clean. Only the reviewed Watch frontend, SSE viewer lifetime and portable regression tests were added to the preexisting branch; no chronological readiness scheduler, installer binary or public main/release update is claimed.

1. Existing `0.1.14` staged source already exercised fully verified H264/HEVC indexed MP4 seeking, byte-range `206`, subtitle/audio switching and updater/source integration in automated tests. New code additionally exposes individually decoded sections before torrent completion and corrects gap/long-pause failure paths.
2. A downloaded-only position must stay dim until actual local hash verification, FFprobe + video IDR, selected AAC audio and original movie-clock evidence exist. Never fill a gap visually just to make the timeline continuous.
3. Real Jujutsu Kaisen E4 private QA confirmed corrected gap seeking after refresh, and the complete MP4 delivered presented frames near requested 110 s and 326 s in isolated Edge; **E5/new incomplete-episode chronological readiness, long-form resource measurements, source/audio/subtitle combinations and installer upgrade remain open**.
4. Before main: ensure the changed player modules have explicit HTTP static-route access, all imports resolve inside the packaged payload, private recovery code/fixtures are absent, Node/full installer contracts pass, updater fallback remains correct, and user verifies a fresh-episode Watch flow with no phantom loader, gap error, stale audio or pause/autoplay regression.
5. Preserve live private port5000, independent QA port5013, comics port5002, installed LVL port4273, and user media. **A review-branch push is not a public release**; no changes to `main`, installer publication, tags, release notes ledger or actual installed application without later sign-off.

The matching user-facing feature changes are recorded under `0.1.14` in `CHANGELOG.md`; **do not add STREAM-03 there as shipped functionality**.
