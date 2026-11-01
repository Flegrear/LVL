// The player's subtitle, source and audio menus.
import { escapeHtml } from "../ui/ui.js";
import { normalizeAudioMode, planCompatibleAudio } from "../../shared/media/audio-policy.js";
import { state, video } from "../../app.js";
import { $ } from "../app/dom.js";
import {
  absolutePlaybackSeconds, clearPlayerControlsHideTimer, openTranscodeAt, playerIsPlaying,
  restartTranscodeAt, resumePlayback, revealPlayerControls, schedulePlayerControlsHide,
  setPlayerLoading, stopPlayerLoadingAnimation,
} from "./player-core.js";
import {
  currentSourceTracks, normalizeTrackLanguage, preferredSourceTracks, rememberSeriesAudioTrack,
} from "./player-tracks.js";
import { renderSubtitles, renderTracks, subtitleRenderMemo, trackLanguageName } from "./subtitle-display.js";
import {
  embeddedSubtitleImportKey, embeddedSubtitleImports, embeddedSubtitleLabel,
  renderEmbeddedSubtitleControls,
} from "./embedded-subtitles.js";
import { resetAudioSync, scheduleAudioSync, updatePlayerSyncStatus } from "./audio-sync.js";
import { floatingDesktopWindow } from "./floating-player.js";
import { playLibraryEpisode } from "./torrent-playback.js";
import { currentChapterSources, librarySourceDetails } from "../library/library-data.js";

const storedAudioMode = localStorage.getItem("lvl-audio-output-mode");
const legacySurroundMode = localStorage.getItem("lvl-surround-output");
export let audioOutputMode = ["auto", "stereo", "surround"].includes(storedAudioMode) ? storedAudioMode
  : legacySurroundMode === "0" ? "stereo" : legacySurroundMode === "1" ? "surround" : "auto";
// Session-only language intent; never rewrite a user's saved Language/Learning preferences.
export let preferredAudioLanguage = "";

export function closePlayerPopovers(except = null) {
  const speedMenu = $("#player-speed-menu");
  if (speedMenu && speedMenu !== except) {
    speedMenu.hidden = true;
    $("#speed-select")?.setAttribute("aria-expanded", "false");
  }
  ["#player-source-menu", "#player-audio-menu", "#player-subtitle-menu"].forEach((selector) => {
    const node = $(selector);
    if (node && node !== except) {
      node.hidden = true;
      if (selector === "#player-subtitle-menu") {
        $("#player-toggle-subs")?.setAttribute("aria-expanded", "false");
        $("#floating-player-captions")?.setAttribute("aria-expanded", "false");
      }
    }
  });
}

export function renderPlayerSubtitleMenu() {
  const menu = $("#player-subtitle-menu");
  if (!menu) return;
  const embedded = (state.currentMediaProbe?.subtitleTracks || []).filter((track) =>
    track?.textBased && Number.isInteger(Number(track.streamIndex)));
  const attached = preferredSourceTracks();
  const renderRow = (label, description, active, attrs, action) =>
    `<button type="button" role="menuitem" class="player-popover-row${active ? " is-active" : ""}" ${attrs}>
      <div><strong>${escapeHtml(label)}</strong><small>${escapeHtml(description)}</small></div><span>${escapeHtml(action)}</span></button>`;
  menu.innerHTML = `<div class="player-popover-head"><span>Captions</span><button type="button" class="player-caption-customize" role="menuitem" data-caption-customize>Customize</button></div>`
    + renderRow("All captions", "Hide every subtitle overlay", !state.subtitlesVisible, "data-caption-off", state.subtitlesVisible ? "Hide all" : "Hidden")
    + (embedded.length ? `<div class="player-popover-head"><span>Embedded in video</span></div>`
      + embedded.map((track, index) => {
        const imported = attached.find((item) => Number(item.embeddedStreamIndex) === Number(track.streamIndex));
        const active = state.subtitlesVisible && Boolean(imported?.visible);
        const loading = embeddedSubtitleImports.has(embeddedSubtitleImportKey(state.currentSource, Number(track.streamIndex)));
        return renderRow(embeddedSubtitleLabel(track, index), trackLanguageName(normalizeTrackLanguage(track.language)),
          active, `data-caption-embedded="${Number(track.streamIndex)}"`,
          active ? "Hide" : loading ? "Loading…" : "Show");
      }).join("") : "")
    + (attached.some((track) => track.origin !== "embedded") ? `<div class="player-popover-head"><span>Added tracks</span></div>`
      + attached.filter((track) => track.origin !== "embedded").map((track) => renderRow(track.label,
        trackLanguageName(normalizeTrackLanguage(track.language)), state.subtitlesVisible && track.visible,
        `data-caption-track="${escapeHtml(track.id)}" aria-pressed="${state.subtitlesVisible && track.visible}"`, state.subtitlesVisible && track.visible ? "Hide" : "Show")).join("") : "");
}

export function openPlayerSubtitleManager() {
  closePlayerPopovers();
  renderTracks();
  renderEmbeddedSubtitleControls();
  $("#player-subtitle-dialog")?.showModal();
}

export function renderPlayerSourceMenu() {
  const menu = $("#player-source-menu");
  if (!menu) return;
  const sources = currentChapterSources();
  $("#player-source-switcher")?.setAttribute("data-tooltip", sources.length > 1 ? `Video sources (${sources.length})` : "Video source");
  if (!sources.length) {
    menu.innerHTML = `<div class="player-popover-head"><span>Video sources</span><span>1</span></div><div class="player-popover-row is-active"><div><strong>${escapeHtml(state.currentSource?.title || "Current source")}</strong><small>No other sources are saved for this chapter.</small></div><span>Playing</span></div>`;
    return;
  }
  menu.innerHTML = `<div class="player-popover-head"><span>Video sources</span><span>${sources.length}</span></div>${sources.map(({ entry, episode }, index) => {
    const details = librarySourceDetails(entry, episode);
    const active = entry.id === state.currentSource?.libraryId && Number(episode.fileIndex) === Number(state.currentSource?.fileIndex);
    return `<button class="player-popover-row${active ? " is-active" : ""}" type="button" data-source-index="${index}">
      <div><strong>${escapeHtml(details.releaseName)}</strong><small>${escapeHtml([details.providers, details.quality !== "UNKNOWN" ? details.quality : "", details.voices, details.peers ? `${details.peers} peers` : null].filter(Boolean).join(", "))}</small></div>
      <span>${active ? "Playing" : "Switch"}</span>
    </button>`;
  }).join("")}`;
  menu.querySelectorAll("[data-source-index]").forEach((button) => button.addEventListener("click", () => {
    const target = sources[Number(button.dataset.sourceIndex)];
    if (!target) return;
    const resumeAtSeconds = absolutePlaybackSeconds();
    menu.hidden = true;
    void playLibraryEpisode(target.entry.id, Number(target.episode.fileIndex), { resumeAtSeconds });
  }));
}

function audioTrackLabel(track, index) {
  const language = String(track?.language || "").toUpperCase();
  const title = String(track?.title || "").trim();
  const codec = String(track?.codec || "audio").toUpperCase();
  const channels = Number(track?.channels) > 0 ? `${track.channels}ch` : "";
  return {
    title: title || (language ? `${language} audio` : `Audio ${index + 1}`),
    meta: [language, codec, channels].filter(Boolean).join(", "),
  };
}

function renderAudioPlaybackDetails() {
  const media = state.currentMediaProbe;
  const track = media?.audioTracks?.[state.selectedAudioTrack] || media?.audioTracks?.[0] || media?.audio;
  if (!media || !track) return '<p class="player-audio-info-note">Audio details are not available for this source.</p>';
  const converted = video.dataset.mode === "transcode";
  const audio = converted ? planCompatibleAudio(track, {
    audioMode: audioOutputMode, startSeconds: state.transcodeRequestedStartSeconds,
  }) : null;
  const bitrate = (value) => Number(value) > 0 ? `${Math.round(Number(value) / 1000)} kbps` : "Unknown";
  const channels = (value) => Number(value) > 0 ? `${value} channels` : "Unknown";
  const originalCodec = String(track.codec || "Unknown").toUpperCase();
  const outputCodec = converted ? String(audio.outputCodec || "Unknown").toUpperCase() : originalCodec;
  const source = [track.language?.toUpperCase(), originalCodec, channels(track.channels), bitrate(track.bitRate)].filter(Boolean).join(" - ");
  const output = [outputCodec, channels(converted ? audio.channels : track.channels), converted && audio.codec !== "copy" ? `${audio.bitRate.replace("k", " kbps")} target` : "Original encoded stream"].join(" - ");
  const videoMode = converted ? (state.transcodeContext?.forceH264 ? "Video conversion" : state.transcodeContext?.copyVideo ? "Video remux (planned)" : "Video conversion (planned)") : "Direct playback";
  const resolution = media.video?.width && media.video?.height ? `${media.video.width}×${media.video.height}` : "Unknown resolution";
  const hdr = media.video?.colorTransfer ? ` - ${String(media.video.colorTransfer).toUpperCase()} source transfer` : "";
  const dvProfile = media.video?.dolbyVision?.profile;
  const dvNote = Number.isInteger(dvProfile) ? ` - Dolby Vision P${dvProfile} source (DV enhancements not verified)` : "";
  const originalVideo = String(media.video?.codec || "Unknown").toUpperCase();
  const videoCopied = !converted || (state.transcodeContext?.copyVideo && !state.transcodeContext?.forceH264);
  const outputVideo = videoCopied ? `${originalVideo} encoded video retained (planned)`
    : `H.264 conversion (planned)${hdr ? " - SDR BT.709 target" : ""}`;
  return `<dl class="player-audio-info-grid">
    <dt>Source</dt><dd>${escapeHtml(String(media.format || "Unknown container"))} - ${escapeHtml(originalVideo)} - ${escapeHtml(resolution)}${escapeHtml(hdr)}${escapeHtml(dvNote)}</dd>
    <dt>Audio track</dt><dd>${escapeHtml(source)}</dd>
    <dt>Playback path</dt><dd>${escapeHtml(videoMode)}</dd>
    <dt>Video output</dt><dd>${escapeHtml(outputVideo)}</dd>
    <dt>Audio output</dt><dd>${escapeHtml(output)}</dd>
  </dl>`;
}

export function renderPlayerAudioMenu() {
  const menu = $("#player-audio-menu");
  if (!menu) return;
  const tracks = Array.isArray(state.currentMediaProbe?.audioTracks) ? state.currentMediaProbe.audioTracks : [];
  if (!tracks.length) {
    $("#player-audio-switcher")?.setAttribute("data-tooltip", "Audio track");
    menu.innerHTML = `<div class="player-popover-head"><span>Audio tracks</span><span>0</span></div><div class="player-popover-row"><div><strong>No audio track found</strong><small>This video may be silent, or its details couldn't be read.</small></div><span>—</span></div>`;
    return;
  }
  const activeAudioLabel = audioTrackLabel(tracks[state.selectedAudioTrack] || tracks[0], state.selectedAudioTrack || 0);
  $("#player-audio-switcher")?.setAttribute("data-tooltip", `Audio: ${activeAudioLabel.title}`);
  const detailsOpen = Boolean(menu.querySelector(".player-audio-info")?.open);
  const outputOption = `<label class="player-audio-mode">Audio output <select id="player-audio-output-mode" aria-label="Audio output mode">
    <option value="auto"${audioOutputMode === "auto" ? " selected" : ""}>Auto - best compatible</option>
    <option value="stereo"${audioOutputMode === "stereo" ? " selected" : ""}>Stereo</option>
    <option value="surround"${audioOutputMode === "surround" ? " selected" : ""}>Up to 5.1</option>
  </select></label>`;
  menu.innerHTML = `<div class="player-popover-head"><span>Audio tracks</span><span>${tracks.length}</span></div>${outputOption}${tracks.map((track, index) => {
    const label = audioTrackLabel(track, index);
    return `<button class="player-popover-row${index === state.selectedAudioTrack ? " is-active" : ""}" type="button" data-audio-index="${index}"><div><strong>${escapeHtml(label.title)}</strong><small>${escapeHtml(label.meta)}</small></div><span>${index === state.selectedAudioTrack ? "Playing" : "Use"}</span></button>`;
  }).join("")}<details class="player-audio-info"${detailsOpen ? " open" : ""}><summary>Playback information</summary>${renderAudioPlaybackDetails()}</details>`;
  menu.querySelectorAll("[data-audio-index]").forEach((button) => button.addEventListener("click", () => {
    const index = Number(button.dataset.audioIndex);
    if (!Number.isInteger(index) || !tracks[index]) return;
    menu.hidden = true;
    // A click on the currently playing Original/Dub track is still an explicit
    // preference. Store it even when no transcode/switch is necessary.
    if (index === state.selectedAudioTrack) {
      rememberSeriesAudioTrack(tracks[index], index);
      return;
    }
    void switchAudioTrack(index, { remember: true });
  }));
  menu.querySelector("#player-audio-output-mode")?.addEventListener("change", (event) => {
    const next = normalizeAudioMode(event.target.value);
    if (next === audioOutputMode) return;
    audioOutputMode = next;
    localStorage.setItem("lvl-audio-output-mode", next);
    const at = absolutePlaybackSeconds();
    const source = state.currentSource;
    if (video.dataset.mode === "transcode") void restartTranscodeAt(at, { wasPlaying: playerIsPlaying() });
    else if (video.dataset.mode === "torrent-direct" && source?.sessionId && source.fileIndex != null && next === "stereo" && Number(tracks[state.selectedAudioTrack]?.channels) > 2) {
      // An explicitly requested downmix cannot be applied to unmodified direct audio.
      void switchAudioTrack(state.selectedAudioTrack, { force: true });
    }
    renderPlayerAudioMenu();
  });
}

let audioTrackSwitchGeneration = 0;
export async function switchAudioTrack(index, { force = false, remember = false } = {}) {
  const source = state.currentSource;
  if (!source?.sessionId || source.fileIndex === null || source.fileIndex === undefined) return;
  const tracks = Array.isArray(state.currentMediaProbe?.audioTracks) ? state.currentMediaProbe.audioTracks : [];
  if (!tracks[index]) return;
  if (!force && index === state.selectedAudioTrack && video.dataset.mode === "transcode") return;
  const wasPlaying = playerIsPlaying();
  const target = absolutePlaybackSeconds();
  const previous = {
    track: state.selectedAudioTrack,
    language: preferredAudioLanguage,
    context: state.transcodeContext,
    mode: video.dataset.mode,
    src: video.src,
  };
  // The new transcode can fail its keyframe preflight without replacing the
  // existing video. resetAudioSync() invalidates the old dub's timing while
  // switching, so retain it until the new stream is actually accepted.
  const previousSubtitleSync = currentSourceTracks().filter((track) => !track.exactMedia).map((track) => ({
    track,
    syncMode: track.syncMode,
    syncSource: track.syncSource,
    syncAnchors: (track.syncAnchors || []).map((anchor) => ({ ...anchor })),
    audioSync: track.audioSync ? { ...track.audioSync } : undefined,
    syncFollowsId: track.syncFollowsId,
    syncFollowing: track.syncFollowing,
    syncRejected: track.syncRejected,
  }));
  const generation = ++audioTrackSwitchGeneration;
  let rollbackPlayIntent = null;
  state.selectedAudioTrack = index;
  preferredAudioLanguage = String(tracks[index].language || "").trim().toLowerCase();
  const baseUrl = `/api/torrents/${encodeURIComponent(source.sessionId)}/files/${source.fileIndex}/transcode`;
  const requestedContext = { baseUrl, sessionId: source.sessionId, fileIndex: source.fileIndex, audioIndex: index,
    copyVideo: video.dataset.mode === "torrent-direct" || Boolean(state.transcodeContext?.copyVideo),
    forceH264: Boolean(state.transcodeContext?.forceH264) };
  state.transcodeContext = requestedContext;
  video.dataset.mode = "transcode";
  setPlayerLoading(22, "Switching audio", audioTrackLabel(tracks[index], index).title);
  resetAudioSync();
  const opened = await openTranscodeAt(target, {
    wasPlaying,
    onPreflightFailure: (failure) => { rollbackPlayIntent = failure.wasPlaying; },
  });
  // Verification can fail before the old media URL changes (for example a
  // copied HDR seek whose source clock cannot be proven). Keep the actual
  // audible dub in the menu and the next-seek transcode context. A stale
  // request must never roll back a later audio selection or active seek.
  if (!opened && generation === audioTrackSwitchGeneration
    && state.currentSource === source && state.transcodeContext === requestedContext
    && !state.pendingSeek && video.src === previous.src) {
    state.selectedAudioTrack = previous.track;
    preferredAudioLanguage = previous.language;
    state.transcodeContext = previous.context;
    video.dataset.mode = previous.mode;
    resetAudioSync();
    for (const saved of previousSubtitleSync) {
      Object.assign(saved.track, {
        syncMode: saved.syncMode, syncSource: saved.syncSource,
        syncAnchors: saved.syncAnchors, audioSync: saved.audioSync,
        syncFollowing: saved.syncFollowing, syncRejected: saved.syncRejected,
      });
      if (saved.syncFollowsId === undefined) delete saved.track.syncFollowsId;
      else saved.track.syncFollowsId = saved.syncFollowsId;
    }
    subtitleRenderMemo.key = "";
    renderSubtitles();
    updatePlayerSyncStatus();
    // The attempted stream was never installed: drop its fatal loader and
    // restore the original stream only if the user still wants it playing.
    const overlay = $("#video-loading");
    if (overlay) {
      overlay.classList.remove("is-error");
      overlay.hidden = true;
    }
    stopPlayerLoadingAnimation();
    state.loadingProgress = 100;
    if (rollbackPlayIntent === true && video.paused) resumePlayback();
  }
  if (opened && remember && generation === audioTrackSwitchGeneration
    && state.currentSource === source && state.selectedAudioTrack === index)
    rememberSeriesAudioTrack(tracks[index], index, source);
  renderPlayerAudioMenu();
  scheduleAudioSync(3000);
}

export function togglePlayerSubtitleMenu(event) {
  event.stopPropagation();
  if (!$("#view-watch")?.classList.contains("is-floating") && !floatingDesktopWindow) revealPlayerControls();
  const menu = $("#player-subtitle-menu");
  const opening = menu.hidden;
  closePlayerPopovers(opening ? menu : null);
  menu.hidden = !opening;
  $("#player-toggle-subs").setAttribute("aria-expanded", String(opening));
  $("#floating-player-captions")?.setAttribute("aria-expanded", String(opening));
  if (opening) {
    renderPlayerSubtitleMenu();
    clearPlayerControlsHideTimer();
  } else schedulePlayerControlsHide();
}
