import { normalizeAudioMode } from "../../shared/media/audio-policy.js";
import { browserVideoProfileSafe } from "../../shared/media/video-profile.js";

// Browser capabilities are device-dependent (Edge's HEVC support depends on
// installed OS codecs and GPU). Probe the actual video element, never assume
// an extension means that decoding will succeed.
const HEVC_8_BIT = 'video/mp4; codecs="hvc1.1.6.L120.B0"';
const HEVC_10_BIT = 'video/mp4; codecs="hvc1.2.4.L153.B0"';
const AV1_8_BIT = 'video/mp4; codecs="av01.0.12M.08"';
const AV1_10_BIT = 'video/mp4; codecs="av01.0.12M.10"';

export function browserCanPlay(codec, canPlayType) {
  try {
    const result = canPlayType?.(codec);
    return result === true || ["maybe", "probably"].includes(String(result || "").toLowerCase());
  } catch { return false; }
}

const MP4_EXTENSIONS = new Set([".mp4", ".m4v", ".mov"]);
const DIRECT_MP4_EXTENSIONS = new Set([".mp4", ".m4v"]);
const WEB_EXTENSIONS = new Set([".webm", ".ogv", ".ogg"]);
const VIDEO_CONTAINERS = new Set([...MP4_EXTENSIONS, ...WEB_EXTENSIONS, ".mkv", ".avi", ".ts", ".m2ts"]);

function audioFriendlyForContainer(codec, extension) {
  if (!codec) return true;
  if (MP4_EXTENSIONS.has(extension)) return ["aac", "mp3"].includes(codec);
  if (extension === ".webm") return ["opus", "vorbis"].includes(codec);
  if (extension === ".ogv" || extension === ".ogg") return codec === "vorbis";
  return false;
}

// The fixed MIME strings below identify Main/Main10 4:2:0 decoders. A browser
// that says it supports Main10 has not advertised 12-bit or 4:2:2/4:4:4 support.
function mainProfilePixelsSupported(pixelFormat, depth) {
  return depth <= 10 && (!pixelFormat || /^(?:yuvj?420p(?:10le|10be)?|nv12|p010le)$/.test(pixelFormat));
}

// The browser and FFmpeg do different jobs: decide whether the *video* is
// decodable before deciding whether the original *container/audio* is usable.
// A supported HEVC video in MKV should be remuxed, not re-encoded to H.264.
export function selectBrowserPlayback({ file = {}, media = null, canPlayType = () => "", audioTrackOrder = 0, audioMode = "auto" } = {}) {
  const name = String(file.name || "").toLowerCase();
  const extension = name.match(/\.[^.]+$/)?.[0] || "";
  if (!VIDEO_CONTAINERS.has(extension)) {
    return { mode: "transcode", direct: false, reason: "container", copyVideo: false };
  }
  const video = media?.video || {};
  const codec = String(video.codec || "").toLowerCase();
  if (!browserVideoProfileSafe(video, codec)) {
    return { mode: "transcode", direct: false, copyVideo: false, reason: video.dolbyVision ? "dolby-vision-profile" : "unsupported-profile" };
  }
  const pixFmt = String(video.pixelFormat || "").toLowerCase();
  const depth = Number(video.bitDepth || video.bitsPerRawSample) || (/p10|10le|10be/.test(pixFmt) ? 10 : 8);
  const selectedTrack = media?.audioTracks?.[audioTrackOrder] || media?.audioTracks?.[0] || media?.audio || null;
  const audio = String(selectedTrack?.codec || "").toLowerCase();
  // Original audio remains untouched by native browser playback (including
  // WebM Opus/Vorbis). Only an explicit downmix or >5.1 layout forces conversion.
  const inputChannels = Number(selectedTrack?.channels) || 2;
  const audioNeedsConversion = Boolean(selectedTrack && inputChannels > (normalizeAudioMode(audioMode) === "stereo" ? 2 : 6));
  // HTMLMediaElement cannot reliably choose a different embedded audio track.
  // Use FFmpeg's selected-track map rather than directly playing track zero.
  const audioNeedsSelection = audioTrackOrder > 0;
  const mp4 = DIRECT_MP4_EXTENSIONS.has(extension);
  const result = (mode, reason) => ({
    mode, direct: mode === "direct", copyVideo: mode !== "transcode", reason,
  });
  let canDecodeMp4 = false;
  let directWebm = false;
  if (codec === "hevc" || codec === "h265") {
    if (!mainProfilePixelsSupported(pixFmt, depth)) return result("transcode", "unsupported-hevc-profile");
    canDecodeMp4 = browserCanPlay(depth > 8 ? HEVC_10_BIT : HEVC_8_BIT, canPlayType);
  }
  else if (codec === "av1") {
    if (!mainProfilePixelsSupported(pixFmt, depth)) return result("transcode", "unsupported-av1-profile");
    canDecodeMp4 = browserCanPlay(depth > 8 ? AV1_10_BIT : AV1_8_BIT, canPlayType);
    directWebm = browserCanPlay(depth > 8 ? 'video/webm; codecs="av01.0.12M.10"' : 'video/webm; codecs="av01.0.12M.08"', canPlayType);
  }
  else if (codec === "h264" || codec === "avc") {
    if (depth > 8 || (pixFmt && !/^(?:yuvj?420p|nv12)$/.test(pixFmt))) return result("transcode", "unsupported-avc-profile");
    canDecodeMp4 = browserCanPlay('video/mp4; codecs="avc1.640028"', canPlayType);
  }
  else if (codec === "vp9" || codec === "vp8") {
    // 'vp9' without a profile suffix only checks the 8-bit baseline profile.
    if (depth > 8 || !mainProfilePixelsSupported(pixFmt, depth)) return result("transcode", "unsupported-vpx-profile");
    directWebm = browserCanPlay('video/webm; codecs="' + (codec === "vp8" ? "vp8" : "vp9") + '"', canPlayType);
    if (extension === ".webm" && directWebm && audioFriendlyForContainer(audio, extension) && !audioNeedsConversion && !audioNeedsSelection) return result("direct", codec);
    return result("transcode", codec);
  }
  else if (codec) return result("transcode", "codec");
  if (canDecodeMp4) {
    if (mp4 && audioFriendlyForContainer(audio, extension) && !audioNeedsConversion && !audioNeedsSelection) return result("direct", codec);
    return result("remux", audioNeedsSelection ? "audio-selection" : audioNeedsConversion ? "audio-output" : audioFriendlyForContainer(audio, extension) ? "container" : "audio");
  }
  if (extension === ".webm" && directWebm && audioFriendlyForContainer(audio, extension) && !audioNeedsConversion && !audioNeedsSelection) return result("direct", codec);
  if (codec) return result("transcode", "unsupported-decoder");
  // If FFprobe fails, defer to the conservative server hint. Never guess
  // that a named HEVC/HDR source can run on this machine.
  if (/\b(?:hevc|h[. -]?265|x265|av1|1[026]bit|1[026]-bit|hdr|dovi|dolby.?vision)\b/i.test(name)) {
    return result("transcode", "unprobed-high-efficiency");
  }
  return result(mp4 && !file.needsTranscode ? "direct" : "transcode", "extension-hint");
}

export function directVideoDecision(options = {}) {
  return selectBrowserPlayback(options);
}

export async function selectBrowserPlaybackWithCapabilities({
  file = {}, media = null, canPlayType = () => "", decodingInfo = null, audioTrackOrder = 0, audioMode = "auto",
} = {}) {
  const selected = selectBrowserPlayback({ file, media, canPlayType, audioTrackOrder, audioMode });
  if (!selected.copyVideo || typeof decodingInfo !== "function") return selected;
  const video = media?.video;
  const codec = String(video?.codec || "").toLowerCase();
  const depth = Number(media?.compatibility?.video?.bitDepth) || Number(video?.bitDepth)
    || (/p10|10le|10be/i.test(String(video?.pixelFormat || "")) ? 10 : 8);
  const contentType = codec === "hevc" || codec === "h265" ? (depth > 8 ? HEVC_10_BIT : HEVC_8_BIT)
    : codec === "av1" ? (depth > 8 ? AV1_10_BIT : AV1_8_BIT)
    : codec === "h264" || codec === "avc" ? 'video/mp4; codecs="avc1.640028"' : "";
  const width = Number(video?.width);
  const height = Number(video?.height);
  if (!contentType || !width || !height) return selected;
  try {
    const capabilities = await decodingInfo({
      type: "file",
      video: {
        contentType, width, height,
        bitrate: Math.max(100_000, Number(media?.bitRate) || 8_000_000),
        framerate: Math.max(1, Number(video?.frameRate) || 24),
      },
    });
    if (capabilities?.supported === false) {
      return { mode: "transcode", direct: false, copyVideo: false, reason: "device-decoding-unsupported" };
    }
    return { ...selected, deviceInfo: capabilities?.supported
      ? { smooth: Boolean(capabilities.smooth), powerEfficient: Boolean(capabilities.powerEfficient) }
      : null };
  } catch {
    return selected;
  }
}
