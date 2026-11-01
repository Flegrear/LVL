// The player outside the Watch page: the floating player, the desktop window and the borderless pop-up.
import { formatTime } from "../../learning/browser/core.js";
import { toast } from "../ui/ui.js";
import { floatingPrefs, frame, POPUP_HANDOFF, popupPlayer, state, video } from "../../app.js";
import { APP_DB_MIGRATION_KEY } from "../app/saved-state.js";
import { $ } from "../app/dom.js";
import { fetchJson, postJson } from "../app/http.js";
import { switchView, viewActive } from "../app/navigation.js";
import {
  absolutePlaybackSeconds, playerIsPlaying, playerWantsMuted, resetRecoveryDisplay, resumePlayback,
  setPlayerMutePreference, stopPlayerLoadingAnimation, suspendPlayerForPopup, togglePlayback,
  updateCompatControls,
} from "./player-core.js";
import { closePlayerPopovers } from "./player-menus.js";
import { seekTo } from "./subtitle-display.js";
import { playLibraryEpisode } from "./torrent-playback.js";
import { recordWatchProgress } from "../watch/watched-status.js";
import { linePreview } from "../learning/study-decks.js";

// A single live video/subtitle DOM is shared by the normal, site-floating and
// browser-managed always-on-top Document PiP surfaces. No playback recreation.
export const FLOAT_AUTO_KEY = "lvl-floating-auto-v1";

let floatingManual = false;
let floatingSiteBounds = null;
export let floatingDesktopWindow = null;
export let floatingDesktopPending = false;
let floatingSeekScrubbing = false;
let floatingFrameAnchor = null;
let floatingDesiredDesktop = false;
let floatingControlsIdleTimer = null;
let floatingControlHeld = false;
let floatingControlsLastActivityAt = 0;

function scheduleFloatingControlsIdle(delayMs) {
  floatingControlsIdleTimer = window.setTimeout(() => {
    floatingControlsIdleTimer = null;
    const actions = $("#floating-player-actions");
    if (!actions || actions.hidden) return;
    if (floatingControlHeld || floatingSeekScrubbing || $("#player-subtitle-menu")?.hidden === false) {
      floatingControlsLastActivityAt = Date.now();
      scheduleFloatingControlsIdle(2000);
      return;
    }
    const remaining = 2000 - (Date.now() - floatingControlsLastActivityAt);
    if (remaining > 0) {
      scheduleFloatingControlsIdle(remaining);
      return;
    }
    actions.classList.add("is-idle");
  }, delayMs);
}

function revealFloatingControls() {
  const actions = $("#floating-player-actions");
  if (!actions || actions.hidden) return;
  actions.classList.remove("is-idle");
  floatingControlsLastActivityAt = Date.now();
  // Pointermove may fire dozens of times a second. One pending timer is enough:
  // when it fires, it checks the last actual activity before fading controls.
  if (floatingControlsIdleTimer === null) scheduleFloatingControlsIdle(2000);
}

function floatMayDisplay() {
  return frame.classList.contains("has-video") && !video.ended && !linePreview.active && !linePreview.pending;
}

export function updateFloatingControls() {
  const actions = $("#floating-player-actions");
  if (actions) {
    const wasHidden = actions.hidden;
    actions.hidden = !$("#view-watch")?.classList.contains("is-floating") && !floatingDesktopWindow
      && !frame.classList.contains("is-popup-window");
    if (!actions.hidden && wasHidden) revealFloatingControls();
    if (actions.hidden) {
      window.clearTimeout(floatingControlsIdleTimer);
      floatingControlsIdleTimer = null;
      floatingControlHeld = false;
      actions.classList.remove("is-idle");
    }
  }
  const pause = $("#floating-player-pause");
  if (pause) {
    pause.classList.toggle("is-playing", playerIsPlaying());
    pause.setAttribute("aria-label", playerIsPlaying() ? "Pause video" : "Play video");
  }
  const mute = $("#floating-player-mute");
  if (mute) {
    mute.classList.toggle("is-muted", playerWantsMuted() || video.volume === 0);
    mute.setAttribute("aria-label", playerWantsMuted() || video.volume === 0 ? "Unmute" : "Mute");
  }
  const volume = $("#floating-player-volume");
  if (volume) volume.value = String(playerWantsMuted() ? 0 : video.volume);
  const progress = $("#floating-player-progress");
  const durationMs = state.mediaDurationMs || (Number.isFinite(video.duration) && video.duration > 0 ? video.duration * 1000 : 0);
  const elapsed = Math.max(0, absolutePlaybackSeconds());
  if (progress) {
    progress.max = String(Math.max(1, durationMs / 1000));
    if (!floatingSeekScrubbing) progress.value = String(Math.min(elapsed, durationMs / 1000 || elapsed));
  }
  const time = $("#floating-player-time");
  if (time) time.textContent = `${formatTime((floatingSeekScrubbing ? Number(progress?.value) || 0 : elapsed) * 1000)} / ${durationMs ? formatTime(durationMs) : "--:--"}`;
}

function clampSiteFloatBounds(bounds) {
  const maxWidth = Math.max(180, Math.min(window.innerWidth - 16, (window.innerHeight - 16) * 16 / 9));
  const width = Math.min(maxWidth, Math.max(Math.min(260, maxWidth), Number(bounds?.width) || 380));
  const height = width * 9 / 16;
  return {
    width,
    x: Math.min(Math.max(8, Number(bounds?.x) || 8), Math.max(8, window.innerWidth - width - 8)),
    y: Math.min(Math.max(8, Number(bounds?.y) || 8), Math.max(8, window.innerHeight - height - 8)),
  };
}

function positionSiteFloating() {
  const watch = $("#view-watch");
  if (!watch) return;
  if (!floatingSiteBounds) {
    const width = Math.min(380, Math.max(180, window.innerWidth - 16));
    floatingSiteBounds = {
      width,
      x: Math.max(8, window.innerWidth - width - 16),
      y: Math.max(8, window.innerHeight - width * 9 / 16 - 16),
    };
  }
  floatingSiteBounds = clampSiteFloatBounds(floatingSiteBounds);
  watch.style.left = `${floatingSiteBounds.x}px`;
  watch.style.top = `${floatingSiteBounds.y}px`;
  watch.style.width = `${floatingSiteBounds.width}px`;
}

function showSiteFloating(show) {
  const watch = $("#view-watch");
  watch?.classList.toggle("is-floating", Boolean(show));
  frame.style.cursor = show ? "grab" : "";
  if (show) positionSiteFloating();
  else if (watch) {
    // Fixed-position popup geometry must not constrain the normal Watch layout.
    watch.style.left = "";
    watch.style.top = "";
    watch.style.width = "";
    closePlayerPopovers();
  }
  updateFloatingControls();
}

function restoreDocumentFloating({ closeWindow = false } = {}) {
  const pip = floatingDesktopWindow;
  floatingDesktopWindow = null;
  frame.classList.remove("is-document-pip");
  if (floatingFrameAnchor?.parentNode) {
    floatingFrameAnchor.parentNode.insertBefore(frame, floatingFrameAnchor);
    floatingFrameAnchor.remove();
  }
  floatingFrameAnchor = null;
  const placeholder = $("#floating-player-placeholder");
  if (placeholder) placeholder.hidden = true;
  if (closeWindow && pip && !pip.closed) pip.close();
  updateFloatingControls();
}

function closeDesktopFloating() {
  floatingDesiredDesktop = false;
  if (typeof popupPlayer !== "undefined" && popupPlayer.open) void takeBackPopupPlayer();
  if (floatingDesktopWindow) restoreDocumentFloating({ closeWindow: true });
  if (document.pictureInPictureElement === video) {
    void document.exitPictureInPicture().catch(() => {});
  }
}

// Going to Watch ends a float the user asked for.
export function clearManualFloating() {
  floatingManual = false;
}

function popupPlayableSource() {
  const source = state.currentSource;
  return source?.kind === "torrent" && /^[0-9a-f]{40}$/.test(String(source.libraryId || ""))
    && Number.isInteger(Number(source.fileIndex)) && Number(source.fileIndex) >= 0;
}

export async function refreshPopupAvailability() {
  if (POPUP_HANDOFF) return;
  try { popupPlayer.available = Boolean((await fetchJson("/api/popup/status")).available); } catch { popupPlayer.available = false; }
}

// Starts the pop-up program hidden, so the first pop-out only loads the page. After an
// update, an installed LVL downloads the program first; until then the browser's pop-up is used.
export function warmPopupPlayer() {
  if (POPUP_HANDOFF || popupPlayer.warmed) return;
  popupPlayer.warmed = true;
  void postJson("/api/popup/warm", {}).then((answer) => {
    popupPlayer.available = Boolean(answer?.available);
    // Still downloading: ask again on the next play.
    if (!popupPlayer.available && answer?.downloading) popupPlayer.warmed = false;
  }).catch(() => { popupPlayer.warmed = false; });
}

function popupStorageSnapshot() {
  const out = {};
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key && (/^lvl[-_]/i.test(key) || key === APP_DB_MIGRATION_KEY || key === "blackline-db-preferences-v2")) out[key] = localStorage.getItem(key);
    }
  } catch {}
  return out;
}

async function openPopupPlayer() {
  const source = state.currentSource;
  const playback = {
    libraryId: source.libraryId, fileIndex: Number(source.fileIndex), title: source.title || "",
    positionSeconds: Math.max(0, absolutePlaybackSeconds()), paused: !playerIsPlaying(),
    volume: video.volume, muted: playerWantsMuted(), rate: video.playbackRate || 1,
  };
  floatingDesiredDesktop = true;
  floatingDesktopPending = true;
  try {
    const opened = await postJson("/api/popup/open", { playback, storage: popupStorageSnapshot() });
    if (!floatingDesiredDesktop) {
      void postJson("/api/popup/close", {}).catch(() => {});
      return false;
    }
    popupPlayer.open = true;
    popupPlayer.id = opened.id;
    suspendPlayerForPopup();
    frame.classList.add("is-popped-out");
    const placeholder = $("#floating-player-placeholder");
    if (placeholder) placeholder.hidden = false;
    showSiteFloating(false);
    updateFloatingControls();
    schedulePopupPoll();
    return true;
  } catch (error) {
    console.warn("Pop-up player unavailable:", error);
    popupPlayer.available = false;
    return null;
  } finally {
    floatingDesktopPending = false;
  }
}

function schedulePopupPoll() {
  window.clearTimeout(popupPlayer.pollTimer);
  popupPlayer.pollTimer = window.setTimeout(() => { void pollPopupPlayer(); }, 1000);
}

// The video comes back to LVL's window: drop a loading or error panel left from before.
function clearPlayerPanelForPopupReturn() {
  resetRecoveryDisplay();
  const overlay = $("#video-loading");
  if (overlay && !overlay.hidden) {
    overlay.classList.remove("is-error");
    overlay.hidden = true;
    stopPlayerLoadingAnimation();
  }
}

async function pollPopupPlayer() {
  if (!popupPlayer.open) return;
  let status = null;
  try { status = await fetchJson("/api/popup/status"); } catch {}
  if (!popupPlayer.open) return;
  if (status && status.id !== popupPlayer.id) {
    finishPopupPlayer({ action: "close" });
    return;
  }
  if (status?.result) {
    finishPopupPlayer(status.result);
    return;
  }
  // The pop-up plays; this window keeps Continue Watching current.
  if (Number.isFinite(status?.position)) recordWatchProgress({ positionSeconds: status.position, playing: true });
  schedulePopupPoll();
}

// The pop-up ended (Return, ✕, the video ended, or LVL's window took it back): continue here
// from where it was. Return continues playing on Watch; ✕ leaves it paused, as before.
function finishPopupPlayer(result = {}) {
  if (!popupPlayer.open) return;
  popupPlayer.open = false;
  popupPlayer.id = null;
  window.clearTimeout(popupPlayer.pollTimer);
  floatingDesiredDesktop = false;
  frame.classList.remove("is-popped-out");
  const placeholder = $("#floating-player-placeholder");
  if (placeholder) placeholder.hidden = true;
  clearPlayerPanelForPopupReturn();
  const seconds = Number(result.positionSeconds);
  if (Number.isFinite(seconds) && seconds > 0) {
    recordWatchProgress({ force: true, positionSeconds: seconds, playing: false });
    seekTo(seconds * 1000);
  }
  floatingManual = false;
  if (result.action === "return") {
    if (!viewActive("watch")) switchView("watch");
    if (!result.paused) resumePlayback();
  }
  updateFloatingControls();
}

async function takeBackPopupPlayer() {
  if (!popupPlayer.open) return;
  let result = null;
  try { result = (await postJson("/api/popup/close", {})).result; } catch {}
  finishPopupPlayer({ ...(result || {}), action: "return" });
}

// Another video started in LVL's window: the pop-up closes without moving this one.
export function dismissPopupPlayer() {
  if (!popupPlayer.open) return;
  popupPlayer.open = false;
  popupPlayer.id = null;
  window.clearTimeout(popupPlayer.pollTimer);
  frame.classList.remove("is-popped-out");
  const placeholder = $("#floating-player-placeholder");
  if (placeholder) placeholder.hidden = true;
  void postJson("/api/popup/close", {}).catch(() => {});
}

// In the pop-up window.
let popupReportTimer = null;

export function popupHost(message) {
  try { window.chrome?.webview?.postMessage(message); } catch {}
}

function popupReport(action = "") {
  if (!POPUP_HANDOFF) return;
  const body = { token: POPUP_HANDOFF.token, positionSeconds: Math.max(0, absolutePlaybackSeconds()), paused: !playerIsPlaying(), ...(action ? { action } : {}) };
  void fetch("/api/popup/report", { method: "POST", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => {});
}

export function finishPopupWindow(action) {
  window.clearInterval(popupReportTimer);
  popupReportTimer = null;
  popupReport(action);
  video.pause();
}

export async function startPopupPlayback() {
  const playback = POPUP_HANDOFF?.playback;
  if (!playback) return;
  document.body.append(frame);
  frame.classList.add("is-document-pip", "is-popup-window");
  updateFloatingControls();
  video.volume = playback.volume;
  setPlayerMutePreference(playback.muted);
  const started = await playLibraryEpisode(playback.libraryId, playback.fileIndex, { resumeAtSeconds: playback.positionSeconds });
  if (!started) {
    finishPopupWindow("close");
    return;
  }
  video.playbackRate = playback.rate;
  if (playback.paused) video.pause();
  popupReportTimer = window.setInterval(() => { if (frame.classList.contains("has-video")) popupReport(); }, 1000);
  window.addEventListener("pagehide", () => popupReport("close"), { once: true });
}

// This function MUST be called synchronously during a click/keypress when
// requesting PiP: browsers require transient user activation.
async function openDesktopFloating() {
  const popupReady = typeof popupPlayer !== "undefined";
  if (floatingDesktopPending || floatingDesktopWindow || (popupReady && popupPlayer.open) || document.pictureInPictureElement === video) return true;
  if (!floatMayDisplay()) return false;
  if (popupReady && popupPlayer.available && popupPlayableSource()) {
    const opened = await openPopupPlayer();
    if (opened !== null) return opened;
    // The pop-up program failed: the browser's own pop-up below.
  }
  floatingDesiredDesktop = true;
  floatingDesktopPending = true;
  try {
    if (window.documentPictureInPicture?.requestWindow) {
      // Chromium owns the PiP origin/title strip. We cannot hide that native
      // chrome, but its redundant "back to tab" button can be suppressed: LVL
      // already provides its own Return control inside the floating player.
      const pip = await window.documentPictureInPicture.requestWindow({ width: 460, height: 302, disallowReturnToOpener: true });
      if (!floatingDesiredDesktop) { pip.close(); return false; }
      floatingDesktopWindow = pip;
      const styles = [...document.querySelectorAll('link[rel="stylesheet"],style')];
      styles.forEach((node) => {
        const clone = node.cloneNode(true);
        if (node.tagName === "LINK") clone.href = node.href;
        pip.document.head.append(clone);
      });
      const base = pip.document.createElement("style");
      base.textContent = `html,body{height:100%;width:100%;margin:0;overflow:hidden;background:#000}
        body{display:block;padding:0} #video-frame{position:relative;display:block!important;width:100%!important;
        height:100dvh!important;min-height:0!important;aspect-ratio:auto!important;margin:0!important;
        border:0!important;border-radius:0!important;box-shadow:none!important}
        #compat-controls{display:none!important} #floating-player-actions{display:flex!important}`;
      pip.document.head.append(base);
      if (!floatingFrameAnchor) {
        floatingFrameAnchor = document.createComment("LVL live video home");
        frame.parentNode.insertBefore(floatingFrameAnchor, frame);
      }
      frame.classList.add("is-document-pip");
      pip.document.body.append(frame);
      const placeholder = $("#floating-player-placeholder");
      if (placeholder) placeholder.hidden = false;
      pip.addEventListener("pagehide", () => {
        if (floatingDesktopWindow !== pip) return;
        restoreDocumentFloating();
        // The browser's own window close must not leave invisible audio playing
        // on a hidden Watch route.
        floatingManual = false;
        if (!viewActive("watch")) video.pause();
      }, { once: true });
      showSiteFloating(false);
      updateFloatingControls();
      return true;
    }
    // Classic video PiP remains a fallback on Chromium versions without
    // Document PiP; its browser-provided controls cannot show LVL subtitles.
    if (document.pictureInPictureEnabled && typeof video.requestPictureInPicture === "function") {
      await video.requestPictureInPicture();
      if (!floatingDesiredDesktop) { await document.exitPictureInPicture().catch(() => {}); return false; }
      showSiteFloating(false);
      return true;
    }
    throw new Error("This browser does not support a desktop picture-in-picture window.");
  } catch (error) {
    console.warn("Floating desktop player unavailable:", error);
    if (floatMayDisplay()) showSiteFloating(true);
    toast("Desktop popup unavailable; showing the player inside LVL instead.", { tone: "error" });
    return false;
  } finally {
    floatingDesktopPending = false;
  }
}

export function updateFloatingPlayback(destination) {
  const leaving = destination !== "watch";
  const shouldFloat = floatMayDisplay() && (floatingManual || (leaving && floatingPrefs.auto && !video.paused));
  if (!leaving && !floatingManual) {
    closeDesktopFloating();
    showSiteFloating(false);
    return;
  }
  if (!shouldFloat) {
    showSiteFloating(false);
    return;
  }
  if (floatingPrefs.scope === "desktop") {
    showSiteFloating(false);
    if (!floatingDesktopWindow && !floatingDesktopPending && !(typeof popupPlayer !== "undefined" && popupPlayer.open) && document.pictureInPictureElement !== video) void openDesktopFloating();
  } else {
    closeDesktopFloating();
    showSiteFloating(true);
  }
}

export function wireFloatingPlayer() {
  $("#settings-float-auto")?.addEventListener("change", (event) => {
    floatingPrefs.auto = event.target.checked;
    localStorage.setItem(FLOAT_AUTO_KEY, floatingPrefs.auto ? "1" : "0");
  });
  $("#settings-float-auto").checked = floatingPrefs.auto;

  $("#player-float")?.addEventListener("click", () => {
    if (!floatMayDisplay()) return;
    floatingManual = true;
    void openDesktopFloating();
  });
  $("#floating-player-return")?.addEventListener("click", () => {
    if (typeof POPUP_HANDOFF !== "undefined" && POPUP_HANDOFF) {
      finishPopupWindow("return");
      return;
    }
    floatingManual = false;
    closeDesktopFloating();
    switchView("watch");
  });
  $("#floating-player-placeholder-return")?.addEventListener("click", () => {
    floatingManual = false;
    closeDesktopFloating();
    switchView("watch");
  });
  $("#floating-player-pause")?.addEventListener("click", () => {
    togglePlayback();
    updateFloatingControls();
  });
  $("#floating-player-back")?.addEventListener("click", () => seekTo(Math.max(0, absolutePlaybackSeconds() - 10) * 1000));
  $("#floating-player-forward")?.addEventListener("click", () => seekTo((absolutePlaybackSeconds() + 10) * 1000));
  $("#floating-player-mute")?.addEventListener("click", () => {
    setPlayerMutePreference(!playerWantsMuted());
    updateCompatControls();
    updateFloatingControls();
  });
  $("#floating-player-volume")?.addEventListener("input", (event) => {
    video.volume = Math.max(0, Math.min(1, Number(event.target.value) || 0));
    setPlayerMutePreference(video.volume === 0);
    updateCompatControls();
    updateFloatingControls();
  });
  const floatingProgress = $("#floating-player-progress");
  floatingProgress?.addEventListener("pointerdown", () => { floatingSeekScrubbing = true; });
  floatingProgress?.addEventListener("input", () => {
    floatingSeekScrubbing = true;
    updateFloatingControls();
  });
  floatingProgress?.addEventListener("change", (event) => {
    const seconds = Number(event.target.value);
    floatingSeekScrubbing = false;
    if (Number.isFinite(seconds)) seekTo(Math.max(0, seconds) * 1000);
    updateFloatingControls();
  });
  floatingProgress?.addEventListener("pointercancel", () => { floatingSeekScrubbing = false; updateFloatingControls(); });
  $("#floating-player-close")?.addEventListener("click", () => {
    if (typeof POPUP_HANDOFF !== "undefined" && POPUP_HANDOFF) {
      finishPopupWindow("close");
      return;
    }
    floatingManual = false;
    video.pause();
    closeDesktopFloating();
    showSiteFloating(false);
  });
  video.addEventListener("ended", () => {
    floatingManual = false;
    closeDesktopFloating();
    showSiteFloating(false);
  });
  video.addEventListener("play", updateFloatingControls);
  video.addEventListener("pause", updateFloatingControls);
  video.addEventListener("volumechange", updateFloatingControls);
  video.addEventListener("timeupdate", updateFloatingControls);
}

// The in-app window moves from any non-control interior point, and resizes from
// each edge/corner. Keep its 16:9 shape and the opposite edge anchored.
// Native desktop PiP uses the browser's own window movement and resizing.
export function siteFloatEdge(rect, x, y) {
  const border = 12;
  const vertical = y - rect.top <= border ? "n" : rect.bottom - y <= border ? "s" : "";
  const horizontal = x - rect.left <= border ? "w" : rect.right - x <= border ? "e" : "";
  return vertical + horizontal;
}

function resizedSiteFloatBounds(original, edge, dx, dy) {
  const ratio = 16 / 9;
  const horizontal = edge.includes("e") ? dx : edge.includes("w") ? -dx : 0;
  const vertical = edge.includes("s") ? dy * ratio : edge.includes("n") ? -dy * ratio : 0;
  const delta = !horizontal ? vertical : !vertical ? horizontal
    : Math.abs(horizontal) >= Math.abs(vertical) ? horizontal : vertical;
  const height = original.width / ratio;
  const right = original.x + original.width;
  const bottom = original.y + height;
  const maxHorizontal = edge.includes("w") ? right - 8 : window.innerWidth - original.x - 8;
  const maxVertical = (edge.includes("n") ? bottom - 8 : window.innerHeight - original.y - 8) * ratio;
  const maxWidth = Math.max(180, Math.min(window.innerWidth - 16, (window.innerHeight - 16) * ratio, maxHorizontal, maxVertical));
  const width = Math.max(Math.min(260, maxWidth), Math.min(maxWidth, original.width + delta));
  return {
    width,
    x: edge.includes("w") ? right - width : original.x,
    y: edge.includes("n") ? bottom - width / ratio : original.y,
  };
}

let suppressFloatingClick = false;
let activeSiteFloatGesture = false;
function beginSiteFloatGesture(event) {
  if (event.button !== 0 || activeSiteFloatGesture || !$("#view-watch")?.classList.contains("is-floating")) return;
  // Player buttons and sliders must win over the resize band, even near a corner.
  if (event.target.closest?.("button,input,select,textarea,a,label,[role='button'],[contenteditable],.player-popover")) return;
  const handle = event.currentTarget;
  const edge = siteFloatEdge(handle.getBoundingClientRect(), event.clientX, event.clientY);
  if (!floatingSiteBounds) positionSiteFloating();
  const original = { ...floatingSiteBounds };
  const startX = event.clientX;
  const startY = event.clientY;
  let moved = false;
  activeSiteFloatGesture = true;
  const move = (pointer) => {
    if (pointer.pointerId !== event.pointerId) return;
    // Edge can lose capture while the window is being resized. A move with no
    // held mouse button must never continue resizing after release.
    if (pointer.buttons === 0) { stop(pointer); return; }
    const dx = pointer.clientX - startX;
    const dy = pointer.clientY - startY;
    if (!moved && Math.hypot(dx, dy) < 4) return;
    moved = true;
    suppressFloatingClick = true;
    if (!edge) {
      floatingSiteBounds = { ...original, x: original.x + dx, y: original.y + dy };
    } else {
      floatingSiteBounds = resizedSiteFloatBounds(original, edge, dx, dy);
    }
    positionSiteFloating();
  };
  const stop = (pointer) => {
    if (pointer.type !== "blur" && pointer.pointerId !== event.pointerId) return;
    if (!activeSiteFloatGesture) return;
    activeSiteFloatGesture = false;
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", stop);
    handle.removeEventListener("pointercancel", stop);
    handle.removeEventListener("lostpointercapture", stop);
    window.removeEventListener("pointerup", stop);
    window.removeEventListener("pointercancel", stop);
    window.removeEventListener("blur", stop);
    if (pointer.type !== "lostpointercapture") {
      try { handle.releasePointerCapture?.(event.pointerId); } catch {}
    }
    if (moved) window.setTimeout(() => { suppressFloatingClick = false; }, 0);
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", stop);
  handle.addEventListener("pointercancel", stop);
  handle.addEventListener("lostpointercapture", stop);
  window.addEventListener("pointerup", stop);
  window.addEventListener("pointercancel", stop);
  window.addEventListener("blur", stop);
  // Capture from mouse-down, not after the 4px threshold. Otherwise releasing
  // outside a corner may never dispatch pointerup to the resizing frame.
  try { handle.setPointerCapture?.(event.pointerId); } catch {}
  if (edge) event.preventDefault();
}
export function wireFloatingFrame() {
  frame.addEventListener("pointerenter", revealFloatingControls);
  frame.addEventListener("pointermove", revealFloatingControls);
  frame.addEventListener("pointerdown", (event) => {
    if ($("#floating-player-actions")?.hidden) return;
    floatingControlHeld = Boolean(event.target.closest?.(".floating-player-bottom"));
    revealFloatingControls();
  });
  window.addEventListener("pointerup", () => { floatingControlHeld = false; });
  window.addEventListener("pointercancel", () => { floatingControlHeld = false; });
  frame.addEventListener("keydown", revealFloatingControls);
  frame.addEventListener("focusin", revealFloatingControls);
  frame.addEventListener("pointerdown", beginSiteFloatGesture);
  frame.addEventListener("pointermove", (event) => {
    if (!$("#view-watch")?.classList.contains("is-floating") || event.buttons) return;
    const edge = siteFloatEdge(frame.getBoundingClientRect(), event.clientX, event.clientY);
    frame.style.cursor = edge === "n" || edge === "s" ? "ns-resize"
      : edge === "e" || edge === "w" ? "ew-resize"
      : edge === "nw" || edge === "se" ? "nwse-resize"
      : edge ? "nesw-resize" : "grab";
  });
  frame.addEventListener("click", (event) => {
    if (!suppressFloatingClick) return;
    suppressFloatingClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  frame.addEventListener("pointerleave", () => {
    if ($("#view-watch")?.classList.contains("is-floating")) frame.style.cursor = "grab";
  });
  window.addEventListener("resize", () => {
    if ($("#view-watch")?.classList.contains("is-floating")) positionSiteFloating();
  });
}
