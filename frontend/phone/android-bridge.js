// Android app bridge, started by phone-layout.js only inside LVL's Android app, where
// MainActivity provides window.LvlAndroid. It connects the web player to Android:
// - Back closes whatever is open (fullscreen, a dialog, a popover) before leaving the page.
// - Playback state goes to the app, which keeps the screen on while a video plays, shows
//   media controls on the lock screen and in notifications, and offers picture-in-picture.
// - The app sends play, pause and seek from those controls, and switches the page to a
//   video-only layout while it is in picture-in-picture.
// - On a phone a new video starts in fullscreen.
// - Downloads the page makes from blob or data URLs are saved to Downloads by the app,
//   because the WebView can't read those URLs once the page has revoked them.
import * as sharedOverlayHost from "../ui/overlay-host.js";

const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const activeBridges = new WeakMap();
const PLAYBACK_EVENTS = ["play", "playing", "pause", "ended", "emptied", "loadedmetadata", "seeked", "ratechange", "durationchange", "waiting"];
// A phone held either way (tablets keep the page around the player).
export const AUTO_FULLSCREEN_QUERY = "(hover: none) and (pointer: coarse) and (max-width: 680px), (hover: none) and (pointer: coarse) and (max-height: 680px)";

// Reader requests are allowed only on the comic route with an actually mounted reader.
// Turning it off remains permitted after closing the reader or navigating away.
export function requestReaderImmersive(win, on) {
  const native = win?.LvlAndroid;
  const doc = win?.document;
  if (!native?.setReaderImmersive || !doc) return false;
  if (on && (win.location?.pathname !== "/comic" || !doc.querySelector?.(".reader") ||
      doc.documentElement.classList.contains("android-fullscreen") ||
      doc.documentElement.classList.contains("android-pip"))) return false;
  try { native.setReaderImmersive(Boolean(on)); return true; } catch { return false; }
}

const visible = (element) => Boolean(element && !element.hidden && element.getClientRects().length);

// Closes the topmost open thing; true when something was closed.
export function closeTopmost(doc, { registry = sharedOverlayHost } = {}) {
  if (doc.fullscreenElement) {
    doc.exitFullscreen?.().catch(() => {});
    return true;
  }
  const dialogs = [...doc.querySelectorAll("dialog[open]")];
  const modals = dialogs.filter(node => node.matches?.(":modal"));
  const registered = typeof registry?.getTopOverlayOwner === "function"
    ? registry.getTopOverlayOwner(doc) : null;
  const registeredNode = registered?.element || registered?.node;
  const registeredNativeModal = Boolean(registered && (registered.kind === "modal"
    || registered.kind === "native-dialog" || registered.kind === "dialog"
    || registeredNode?.matches?.(":modal")));
  // Native :modal top-layer order is not DOM sibling order. The shared
  // registry can order ONLY the modal elements that actually registered.
  // An unknown native modal may be above its latest registered predecessor:
  // do not synthesize Escape or close a background popup/dialog on Back.
  if (modals.length > 1) {
    const known = typeof registry?.listOverlayOwners === "function"
      ? registry.listOverlayOwners(doc).map(owner => owner?.element || owner?.node)
      : [];
    if (!registered || modals.some(modal => !known.includes(modal)))
      return false;
  }
  // Typed shared ownership has priority when installed. Never dismiss a
  // background menu behind an active native top-layer dialog; its native Back
  // fallback stays below. This path runs instead of, not in addition to,
  // dispatching a synthetic Escape.
  if (registered && !registeredNativeModal && typeof registry?.dismissTopOverlay === "function"
    && (!modals.length || registeredNode && modals.some(node => node.contains?.(registeredNode)))) {
    return registry.dismissTopOverlay(doc, { reason: "android-back" }) === true;
  }
  // A newer menu/search/notification can be above an older native dialog.
  // Deliver one real cancellable Escape to the app's LIFO overlay owner first,
  // exactly as the Back key would. It consumes the event only for the top
  // transient layer; the fallback below retains native dialog semantics.
  const target = doc.activeElement && doc.activeElement !== doc.body ? doc.activeElement : doc;
  const escape = new (doc.defaultView?.KeyboardEvent || KeyboardEvent)("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true });
  target.dispatchEvent(escape);
  if (escape.defaultPrevented) return true;
  const focusedDialog = doc.activeElement?.closest?.("dialog[open]");
  // When the typed owner is an actual native modal, its recorded opening
  // order outranks DOM sibling order. With multiple unregistered modals and
  // no focused top-layer proof, fail closed rather than dismissing behind it.
  const dialog = registeredNativeModal && dialogs.includes(registeredNode)
    ? registeredNode
    : dialogs.includes(focusedDialog) ? focusedDialog
      : dialogs.length === 1 ? dialogs[0] : null;
  if (dialogs.length && !dialog) return false;
  if (dialog) {
    const close = dialog.querySelector(":scope > .dialog-close, [data-close-dialog]");
    if (close) close.click();
    else dialog.close();
    return true;
  }
  const notifications = doc.getElementById("app-notifications-popover");
  if (visible(notifications)) {
    doc.getElementById("app-notifications-close")?.click();
    return true;
  }
  return false;
}

export function playbackSnapshot(doc) {
  const video = doc.getElementById("video");
  if (!video) return { hasVideo: false, playing: false };
  return {
    hasVideo: Boolean(video.currentSrc) && video.readyState > 0,
    playing: !video.paused && !video.ended,
    width: video.videoWidth || 0,
    height: video.videoHeight || 0,
    position: Number.isFinite(video.__lvlAbsoluteTime?.())
      ? video.__lvlAbsoluteTime() : Number.isFinite(video.currentTime) ? video.currentTime : 0,
    duration: Number.isFinite(video.__lvlDurationSeconds?.())
      ? video.__lvlDurationSeconds() : Number.isFinite(video.duration) ? video.duration : 0,
    rate: video.playbackRate || 1,
    title: (doc.getElementById("player-now-title")?.textContent || "").trim().slice(0, 200),
    // The Watch page shows a video (also while it's loading): turning the phone opens fullscreen.
    videoOpen: Boolean(doc.getElementById("view-watch")?.classList?.contains("is-active") && doc.getElementById("video-frame")?.classList?.contains("has-video")),
  };
}

export function runMediaCommand(doc, command, value) {
  const video = doc.getElementById("video");
  if (!video) return false;
  const click = (id, fallback) => { const button = doc.getElementById(id); if (button) button.click(); else fallback?.(); };
  const toggle = () => click("compat-play", () => (video.paused ? video.play().catch(() => {}) : video.pause()));
  switch (command) {
    case "toggle": toggle(); return true;
    case "play": if (video.paused) toggle(); return true;
    case "pause": if (!video.paused) toggle(); return true;
    case "forward": {
      // The existing button owns seekPlayerBy() on the absolute movie clock.
      // Without its owner, changing decoder currentTime would seek within a
      // transcode window, not by ten seconds of the movie. Fail closed.
      const button = doc.getElementById("player-seek-forward");
      if (!button) return false;
      button.click();
      return true;
    }
    case "rewind": {
      const button = doc.getElementById("player-seek-back");
      if (!button) return false;
      button.click();
      return true;
    }
    case "seek": {
      if (!Number.isFinite(value) || value < 0 || !doc.dispatchEvent) return false;
      // The controller resolves absolute movie time through the active media
      // source (transcode offset, verified GOP, indexed seek or native MP4).
      // Decoder currentTime is a window clock and cannot accept movie seconds.
      const EventType = doc.defaultView?.CustomEvent || globalThis.CustomEvent;
      if (!EventType) return false;
      const event = new EventType("lvl:media-session-seek", { cancelable: true, detail: { seconds: value } });
      doc.dispatchEvent(event);
      return event.defaultPrevented;
    }
    default: return false;
  }
}

function blobToBase64(blob, win) {
  return new Promise((resolve, reject) => {
    const reader = new win.FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Incremental limit before allocating a Blob or invoking FileReader. */
export async function limitedResponseBlob(response, win, limit = MAX_DOWNLOAD_BYTES) {
  if (!response.ok) throw new Error("The download couldn't be read");
  const advertised = response.headers?.get?.("content-length");
  if (advertised != null && advertised !== "" && Number(advertised) > limit)
    throw new Error("The file is too large to save (50 MiB limit)");
  const reader = response.body?.getReader?.();
  if (!reader) throw new Error("This WebView can't stream downloads");
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw new Error("The file is too large to save (50 MiB limit)");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel?.().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock?.();
  }
  return new win.Blob(chunks, { type: response.headers?.get?.("content-type") || "application/octet-stream" });
}

export function startAndroidBridge(win = globalThis.window) {
  if (win && activeBridges.has(win)) return activeBridges.get(win);
  const native = win?.LvlAndroid;
  const doc = win?.document;
  if (!native || !doc) return null;
  const root = doc.documentElement;
  // A passive native acknowledgement keeps CSS in sync without echoing requests.
  // E's reader owns scroll/page/chrome state; this class must never hide its content.
  const acknowledgeReaderImmersive = (on) => root.classList.toggle("android-reader-immersive", Boolean(on));

  // Playback state: sent on player events and title changes, never on every timeupdate.
  let lastSent = "";
  const report = () => {
    const snapshot = playbackSnapshot(doc);
    const text = JSON.stringify(snapshot);
    if (text === lastSent) return;
    lastSent = text;
    try { native.playbackState(text); } catch {}
  };
  const video = doc.getElementById("video");
  for (const type of PLAYBACK_EVENTS) video?.addEventListener(type, report);
  const title = doc.getElementById("player-now-title");
  if (title && win.MutationObserver) new win.MutationObserver(report).observe(title, { childList: true, characterData: true, subtree: true });

  // Fullscreen in the app is the app's own (MainActivity.setAppFullscreen): the page lays the
  // video frame over the window (html.android-fullscreen, phone.css) and the app hides the
  // system bars and turns the screen. The web Fullscreen API needs a tap at that moment, which
  // a torrent that takes a while to start no longer has.
  const setFullscreen = (on) => { try { native.setFullscreen(Boolean(on)); } catch {} };
  // On a phone a new video plays fullscreen right away, as video apps do. Once per video:
  // after the user leaves fullscreen it stays that way until another video starts or the
  // player is left.
  const phone = win.matchMedia?.(AUTO_FULLSCREEN_QUERY);
  const watch = doc.getElementById("view-watch");
  const frame = doc.getElementById("video-frame");
  let fullscreenOffered = null;
  video?.addEventListener("play", () => {
    // New player loads publish a stable file owner. The fallback retains the
    // legacy bridge contract for pages without that source-owner integration.
    const key = video.__lvlSourceOwner || `${video.currentSrc || video.src || ""}|${(title?.textContent || "").trim()}`;
    if (!key || key === fullscreenOffered) return;
    fullscreenOffered = key;
    if (!phone?.matches || doc.fullscreenElement || root.classList.contains("android-pip") || root.classList.contains("android-fullscreen")) return;
    report();
    setFullscreen(true);
  });
  const observe = (element) => {
    if (element && win.MutationObserver) new win.MutationObserver(() => {
      if (watch && !watch.classList.contains("is-active")) fullscreenOffered = null;
      report();
    }).observe(element, { attributes: true, attributeFilter: ["class"] });
  };
  observe(watch);
  observe(frame);
  // The player's fullscreen button toggles the app's fullscreen.
  doc.addEventListener("click", (event) => {
    if (!event.target?.closest?.("#player-fullscreen")) return;
    event.preventDefault();
    event.stopPropagation();
    if (doc.fullscreenElement) { doc.exitFullscreen?.().catch(() => {}); return; }
    report();
    setFullscreen(!root.classList.contains("android-fullscreen"));
  }, true);

  // The floating-player button opens Android's picture-in-picture instead.
  doc.addEventListener("click", (event) => {
    if (!event.target?.closest?.("#player-float")) return;
    event.preventDefault();
    event.stopPropagation();
    try { native.enterPictureInPicture(); } catch {}
  }, true);

  // Downloads from blob: and data: URLs. The page creates a detached link and clicks it,
  // and may revoke the URL right after, so the Blob is kept from createObjectURL on.
  const blobs = new Map();
  const create = win.URL.createObjectURL.bind(win.URL);
  const revoke = win.URL.revokeObjectURL.bind(win.URL);
  win.URL.createObjectURL = (object) => { const url = create(object); if (object instanceof win.Blob) blobs.set(url, object); return url; };
  win.URL.revokeObjectURL = (url) => { blobs.delete(url); revoke(url); };
  const click = win.HTMLAnchorElement.prototype.click;
  win.HTMLAnchorElement.prototype.click = function lvlAndroidClick(...args) {
    const href = this.href || "";
    const blob = this.hasAttribute("download") ? blobs.get(href) : null;
    if (!blob && !(this.hasAttribute("download") && href.startsWith("data:"))) return click.apply(this, args);
    const name = this.getAttribute("download") || "download";
    // Large data: URLs are already materialized strings. Reject before fetch()
    // can decode them into another unbounded object; allow regular small data URLs.
    if (!blob && href.length > Math.ceil(MAX_DOWNLOAD_BYTES / 3) * 4 + 1024) {
      try { native.downloadFailed(name, "The file is too large to save (50 MiB limit)"); } catch {}
      return undefined;
    }
    const source = blob ? Promise.resolve(blob) : win.fetch(href).then((response) => limitedResponseBlob(response, win));
    source.then((file) => {
      if (file.size > MAX_DOWNLOAD_BYTES) throw new Error("The file is too large to save");
      return blobToBase64(file, win).then((data) => native.saveDownload(name, file.type || "application/octet-stream", data));
    }).catch((error) => { try { native.downloadFailed(name, String(error?.message || error)); } catch {} });
    return undefined;
  };

  win.lvlAndroid = Object.freeze({
    back: () => closeTopmost(doc),
    pip: (on) => { root.classList.toggle("android-pip", Boolean(on)); report(); },
    fullscreen: (on) => { root.classList.toggle("android-fullscreen", Boolean(on)); report(); },
    requestReaderImmersive: (on) => requestReaderImmersive(win, on),
    readerImmersive: acknowledgeReaderImmersive,
    media: (command, value) => {
      const handled = runMediaCommand(doc, String(command), Number(value));
      if (handled && command === "seek") report();
      return handled;
    },
    playback: () => playbackSnapshot(doc),
  });
  activeBridges.set(win, win.lvlAndroid);
  report();
  return win.lvlAndroid;
}
