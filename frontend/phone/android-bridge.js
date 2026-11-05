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

const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
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
export function closeTopmost(doc) {
  if (doc.fullscreenElement) {
    doc.exitFullscreen?.().catch(() => {});
    return true;
  }
  const dialogs = [...doc.querySelectorAll("dialog[open]")];
  const dialog = dialogs[dialogs.length - 1];
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
  // Menus, the search panel and other popovers close on Escape; their handlers call
  // preventDefault when they handle it.
  const target = doc.activeElement && doc.activeElement !== doc.body ? doc.activeElement : doc;
  const escape = new (doc.defaultView?.KeyboardEvent || KeyboardEvent)("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true });
  target.dispatchEvent(escape);
  return escape.defaultPrevented;
}

export function playbackSnapshot(doc) {
  const video = doc.getElementById("video");
  if (!video) return { hasVideo: false, playing: false };
  return {
    hasVideo: Boolean(video.currentSrc) && video.readyState > 0,
    playing: !video.paused && !video.ended,
    width: video.videoWidth || 0,
    height: video.videoHeight || 0,
    position: Number.isFinite(video.currentTime) ? video.currentTime : 0,
    duration: Number.isFinite(video.duration) ? video.duration : 0,
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
    case "forward": click("player-seek-forward", () => { video.currentTime += 10; }); return true;
    case "rewind": click("player-seek-back", () => { video.currentTime = Math.max(0, video.currentTime - 10); }); return true;
    case "seek": if (Number.isFinite(value) && value >= 0) video.currentTime = value; return true;
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

export function startAndroidBridge(win = globalThis.window) {
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
    const key = (title?.textContent || "").trim() || video.currentSrc;
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
    const source = blob ? Promise.resolve(blob) : win.fetch(href).then((response) => response.blob());
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
    media: (command, value) => runMediaCommand(doc, String(command), Number(value)),
    playback: () => playbackSnapshot(doc),
  });
  report();
  return win.lvlAndroid;
}
