// Intro and outro skips, and the episode timeline.
import { formatTime } from "../../shared/subtitles/subtitle-text.js";
import { episodeAutoSkip, state, video } from "../../app.js";
import { $ } from "../app/dom.js";
import { viewActive } from "../app/navigation.js";
import { absolutePlaybackSeconds, seekPlayerTo } from "./player-core.js";
import { watchPendingSelection } from "./torrent-playback.js";
import { currentCatalogNeighbors, playAdjacentChapter } from "../watch/episode-navigation.js";
import { currentChapterNavigation, libraryEntryById } from "../library/library-data.js";

// SkipDB is a lightweight, optional source of episode timestamps. A single
// anonymous request is made for a known IMDb episode; there is no audio scan,
// torrent read, persistent cache or speculative time-based skipping.
let episodeSkipKey = "";
let episodeSkipTimes = { intro: null, outro: null };
let episodeSkipController = null;
let episodeSkipFetchState = "idle";

export function setEpisodeAutoSkip(kind, enabled) {
  episodeAutoSkip[kind] = Boolean(enabled);
  localStorage.setItem(kind === "intro" ? "lvl-auto-skip-intro" : "lvl-auto-skip-ending", enabled ? "1" : "0");
  renderEpisodeSkipOptions();
  applyEpisodeAutoSkips();
}

function checkedSkipInterval(value, duration, type) {
  // SkipDB reports "agnostic" for timestamps not tied to a particular cut.
  // These are suitable for a user-initiated skip only, never automatic seeking.
  if (!value || !["exact", "shifted", "agnostic"].includes(value.match)
    || !Number.isFinite(Number(value.confidence)) || Number(value.confidence) < .65) return null;
  const start = Number(value.start_ms) / 1000;
  const end = Number(value.end_ms) / 1000;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start + 4
    || end > duration + 1) return null;
  if (type === "intro" && (start > duration * .4 || end > duration * .5)) return null;
  if (type === "outro" && start < duration * .6) return null;
  return { start, end: Math.min(end, duration), match: value.match };
}

function currentEmbeddedChapterSkips(duration) {
  const probe = state.currentMediaProbe;
  const actualDuration = Number(probe?.durationSeconds);
  // The container's own chapters can be exact only for the same file/cut.
  // A stale probe or different selected output duration must never authorize
  // automatic seeking (rounding allows the duration displayed in whole seconds).
  if (!Number.isFinite(actualDuration) || actualDuration <= 0 ||
    !Number.isFinite(duration) || Math.abs(actualDuration - duration) > 1.1) {
    return { intro: null, outro: null };
  }
  const chapters = probe?.embeddedSkipMarkers;
  return {
    intro: checkedSkipInterval(chapters?.intro, duration, "intro"),
    outro: checkedSkipInterval(chapters?.outro, duration, "outro"),
  };
}

function currentEpisodeSkipIdentity() {
  if (!viewActive("watch") || watchPendingSelection) return null;
  const source = state.currentSource;
  if (source?.kind !== "torrent" || source.fileIndex === null || source.fileIndex === undefined) return null;
  const entry = libraryEntryById(source.libraryId);
  const catalogId = String(entry?.catalogId || source.catalogId || "");
  const episode = entry?.episodes?.find((item) => Number(item.fileIndex) === Number(source.fileIndex));
  // Library chapter labels are authoritative for a pack whose filenames are
  // numbered across seasons. Accept both S1E3 and zero-padded S01E03 codes.
  const code = entry?.chapterLabels?.[String(source.fileIndex)]?.code || episode?.code || source.episode?.code || "";
  const match = String(code).match(/^S(\d{1,2})E(\d{1,4})$/i);
  const duration = Math.round(state.mediaDurationMs / 1000);
  if (duration < 300 || duration > 18_000) return null;
  const hasProviderIdentity = Boolean(match && /^tt\d{5,12}$/.test(catalogId)
    && entry?.catalogType !== "movie" && source.catalogType !== "movie");
  // Explicit OP/ED chapters originate from this exact selected file, so they
  // also work when an IMDb episode match is unavailable. Never transfer them
  // from an old media probe: source transitions clear currentMediaProbe.
  const chapters = currentEmbeddedChapterSkips(duration);
  if (!hasProviderIdentity && !chapters.intro && !chapters.outro) return null;
  return {
    key: `${source.libraryId}:${source.sessionId || ""}:${source.fileIndex}:${source.sourceTag || ""}|${hasProviderIdentity ? catalogId : "chapter"}|${hasProviderIdentity ? match[0] : ""}|${duration}`,
    imdbId: hasProviderIdentity ? catalogId : null,
    season: hasProviderIdentity ? Number(match[1]) : null,
    episode: hasProviderIdentity ? Number(match[2]) : null,
    duration,
  };
}

// Exact/shifted timestamps match this stream length. Agnostic timestamps are
// real crowdsourced episode markers, but no source-duration comparison is
// possible. Show their simple timeline labels; NEVER auto-skip them.
export function episodeTimelineRanges() {
  const identity = currentEpisodeSkipIdentity();
  if (!identity || identity.key !== episodeSkipKey) return [];
  const duration = identity.duration;
  const ranges = [];
  for (const [kind, label, interval] of [
    ["opening", "Opening", episodeSkipTimes.intro],
    ["ending", "Ending", episodeSkipTimes.outro],
  ]) {
    if (interval && ["exact", "shifted", "agnostic"].includes(interval.match)) {
      const unverified = interval.match === "agnostic";
      ranges.push({ kind, label,
        start: interval.start, end: interval.end, unverified });
    }
  }
  // Footage after the ending remains playable, without another tooltip/tag.
  // Skipping continues to preserve after-credit scenes in applyEpisodeAutoSkips.
  return ranges;
}

let episodeTimelineRenderKey = "";
export function renderEpisodeTimelineSegments() {
  const layer = $("#player-timeline-segments");
  const summary = $("#player-timeline-summary");
  if (!layer) return;
  const ranges = episodeTimelineRanges();
  // Chapter markers share the episode clock. A direct torrent's native
  // duration can grow with the partial download and is not a valid total.
  const duration = Math.round((Number(state.mediaDurationMs) || 0) / 1000);
  const renderKey = JSON.stringify([duration, ranges]);
  if (renderKey === episodeTimelineRenderKey) return;
  episodeTimelineRenderKey = renderKey;
  layer.innerHTML = duration ? ranges.map(({ kind, start, end }) => {
    const left = (start / duration * 100).toFixed(3);
    const width = ((end - start) / duration * 100).toFixed(3);
    return `<span class="player-timeline-segment player-timeline-segment--${kind}" style="left:${left}%;width:${width}%"></span>`;
  }).join("") : "";
  if (summary) {
    summary.textContent = ranges.length
      ? ranges.map(({ label, start, end }) => `${label}: ${formatTime(start * 1000)} to ${formatTime(end * 1000)}`).join("; ")
      : "";
  }
}

function renderEpisodeSkipOptions() {
  const intro = $("#watch-skip-intro");
  const credits = $("#watch-skip-credits");
  if (!intro || !credits) return;
  intro.setAttribute("aria-pressed", String(episodeAutoSkip.intro));
  credits.setAttribute("aria-pressed", String(episodeAutoSkip.outro));
  // Keep the controls visually simple. A pressed control stores the user's
  // preference; the existing source-matching safety gate still governs seeks.
  intro.textContent = "Skip intro";
  credits.textContent = "Skip ending";
  intro.title = "Automatically skip a matching opening when available";
  credits.title = "Automatically skip a matching ending when available";
}

function applyEpisodeAutoSkips() {
  if (video.paused || state.pendingSeek || !episodeSkipKey || !viewActive("watch")
    || currentEpisodeSkipIdentity()?.key !== episodeSkipKey) return;
  const at = absolutePlaybackSeconds();
  const opening = episodeSkipTimes.intro;
  const ending = episodeSkipTimes.outro;
  if (episodeAutoSkip.intro && opening && ["exact", "shifted"].includes(opening.match)
    && episodeAutoSkip.attemptedIntro !== episodeSkipKey
    && at >= opening.start && at < opening.end - 3) {
    episodeAutoSkip.attemptedIntro = episodeSkipKey;
    seekPlayerTo(opening.end);
  } else if (episodeAutoSkip.outro && ending && ["exact", "shifted"].includes(ending.match)
    && episodeAutoSkip.attemptedOutro !== episodeSkipKey
    && at >= ending.start && at < ending.end - 2) {
    episodeAutoSkip.attemptedOutro = episodeSkipKey;
    const remaining = Math.max(0, state.mediaDurationMs / 1000 - ending.end);
    if (remaining >= 12) seekPlayerTo(ending.end);
    else if (currentCatalogNeighbors()?.next || currentChapterNavigation().next) void playAdjacentChapter(1);
    else seekPlayerTo(Math.max(0, state.mediaDurationMs / 1000 - 1));
  }
}

export function refreshEpisodeSkipOptions() {
  const identity = currentEpisodeSkipIdentity();
  const key = identity?.key || "";
  const chapters = identity ? currentEmbeddedChapterSkips(identity.duration) : { intro: null, outro: null };
  if (key !== episodeSkipKey) {
    episodeSkipController?.abort();
    episodeSkipController = null;
    episodeSkipKey = key;
    episodeSkipTimes = chapters;
    // Two verified local markers require no community lookup, so their
    // controls are immediately ready rather than left in a false loading state.
    episodeSkipFetchState = !identity ? "idle"
      : identity.imdbId && (!chapters.intro || !chapters.outro) ? "loading" : "loaded";
    renderEpisodeTimelineSegments();
    episodeAutoSkip.attemptedIntro = "";
    episodeAutoSkip.attemptedOutro = "";
    if (identity?.imdbId && (!chapters.intro || !chapters.outro)) {
      const controller = new AbortController();
      episodeSkipController = controller;
      const query = new URLSearchParams({
        imdb_id: identity.imdbId, season: String(identity.season),
        episode: String(identity.episode), duration: String(identity.duration), adjust: "conservative",
      });
      void fetch(`https://api.skipdb.tv/api/segments?${query}`, {
        signal: controller.signal, credentials: "omit", referrerPolicy: "no-referrer",
      }).then((response) => response.ok ? response.json() : null).then((payload) => {
        if (controller.signal.aborted || episodeSkipKey !== key
          || currentEpisodeSkipIdentity()?.key !== key) return;
        episodeSkipFetchState = payload ? "loaded" : "unavailable";
        const latestChapters = currentEmbeddedChapterSkips(identity.duration);
        episodeSkipTimes = {
          intro: latestChapters.intro || checkedSkipInterval(payload?.segments?.intro, identity.duration, "intro"),
          outro: latestChapters.outro || checkedSkipInterval(payload?.segments?.outro, identity.duration, "outro"),
        };
        renderEpisodeTimelineSegments();
        renderEpisodeSkipOptions();
        applyEpisodeAutoSkips();
      }).catch(() => {
        if (controller.signal.aborted || episodeSkipKey !== key) return;
        episodeSkipFetchState = "unavailable";
        renderEpisodeSkipOptions();
      }); // Missing service or unsupported episode leaves controls inactive.
    }
  }
  // An asynchronous probe can reveal a verified chapter after the provider
  // request began. Prefer that same-file marker without issuing another API
  // request or displacing a previously valid provider interval.
  let chapterChanged = false;
  for (const kind of ["intro", "outro"]) {
    if (!chapters[kind]) continue;
    if (episodeSkipTimes[kind]?.start !== chapters[kind].start ||
      episodeSkipTimes[kind]?.end !== chapters[kind].end ||
      episodeSkipTimes[kind]?.match !== chapters[kind].match) chapterChanged = true;
    episodeSkipTimes[kind] = chapters[kind];
  }
  if (chapterChanged) renderEpisodeTimelineSegments();
  renderEpisodeSkipOptions();
  applyEpisodeAutoSkips();
}
