import { planCompatibleAudio, normalizeAudioMode } from "./audio-policy.js";
import { browserVideoProfileSafe } from "./video-profile.js";

const HDR_TRANSFERS = new Map([
  ["smpte2084", "pq"],
  ["smpte-st-2084", "pq"],
  ["arib-std-b67", "hlg"],
]);

const FRIENDLY_AUDIO_CODECS = new Set(["aac", "mp3", "opus", "vorbis", "flac"]);

export const MEDIA_COMPATIBILITY_LIMITS = Object.freeze({
  surroundChannels: 6,
  // HEVC/AV1 are only remuxed when the client explicitly says its browser can decode them.
  // This keeps the server from claiming hardware acceleration that depends on OS codecs,
  // GPU drivers, browser build and the active output device.
  requiresClientCodecOptIn: ["hevc", "av1"],
  fallbackVideoCodec: "h264",
  fallbackAudioCodec: "aac",
  hdrFallback: "tone-map-to-sdr",
});

export function normalizeMediaCodec(value) {
  const codec = String(value || "").trim().toLowerCase();
  if (["h264", "avc", "avc1"].includes(codec)) return "h264";
  if (["h265", "hevc", "hvc1", "hev1"].includes(codec)) return "hevc";
  if (["av01", "av1"].includes(codec)) return "av1";
  return codec;
}

export function inferVideoCodecFromName(value) {
  const text = String(value || "");
  if (/\b(?:h[ ._-]?265|x265|hevc)\b/i.test(text)) return "hevc";
  if (/\b(?:h[ ._-]?264|x264|avc)\b/i.test(text)) return "h264";
  if (/\bav1\b/i.test(text)) return "av1";
  return "";
}

export function videoBitDepth(video) {
  const raw = Number(video?.bitsPerRawSample ?? video?.bits_per_raw_sample);
  if (Number.isFinite(raw) && raw > 0) return raw;
  const format = String(video?.pixelFormat ?? video?.pix_fmt ?? "").toLowerCase();
  const explicit = /(?:p|le|be)(9|10|12|14|16)(?:le|be)?\b/.exec(format)?.[1];
  if (explicit) return Number(explicit);
  const packed = /\bp0?(10|12|16)(?:le|be)?\b/.exec(format)?.[1];
  if (packed) return Number(packed);
  if (format) return 8;
  return null;
}

export function hdrKind(video) {
  const transfer = String(video?.colorTransfer ?? video?.color_transfer ?? "").toLowerCase();
  if (HDR_TRANSFERS.has(transfer)) return HDR_TRANSFERS.get(transfer);
  if (String(video?.colorPrimaries ?? video?.color_primaries ?? "").toLowerCase() === "bt2020" && (videoBitDepth(video) || 0) >= 10) return "unknown-hdr";
  return null;
}

function h264BrowserSafe(video) {
  if (!browserVideoProfileSafe(video, "h264")) return false;
  const depth = videoBitDepth(video);
  if (depth && depth > 8) return false;
  const pixel = String(video?.pixelFormat ?? video?.pix_fmt ?? "").toLowerCase();
  if (!pixel) return true;
  return /^(?:yuvj?420p|nv12)$/.test(pixel);
}

function mainProfileCopySafe(video, codec) {
  if (!browserVideoProfileSafe(video, codec)) return false;
  const depth = videoBitDepth(video);
  const pixel = String(video?.pixelFormat ?? video?.pix_fmt ?? "").toLowerCase();
  // 'hvc1 Main10' and the AV1 Profile 0 MIME strings offered by the client
  // guarantee neither 12-bit decoding nor chroma formats beyond 4:2:0.
  return (depth === null || depth <= 10)
    && (!pixel || /^(?:yuvj?420p(?:10le|10be)?|nv12|p010le)$/.test(pixel));
}

export function browserFriendlyAudioCodec(codec) {
  return FRIENDLY_AUDIO_CODECS.has(normalizeMediaCodec(codec));
}

export function inspectMediaCompatibility(media, { fileName = "" } = {}) {
  const video = media?.video || null;
  const codec = normalizeMediaCodec(video?.codec) || inferVideoCodecFromName(fileName) || null;
  const bitDepth = videoBitDepth(video);
  const hdr = hdrKind(video);
  const width = Number(video?.width) || null;
  const height = Number(video?.height) || null;
  const fourK = Boolean((width && width >= 3840) || (height && height >= 2160));
  const defaultVideoCopy = codec === "h264" && h264BrowserSafe(video || {});
  const firstAudio = media?.audioTracks?.[0] || media?.audio || null;
  const defaultAudioFriendly = !firstAudio?.codec || browserFriendlyAudioCodec(firstAudio.codec);
  return {
    video: {
      codec,
      profile: video?.profile || null,
      pixelFormat: video?.pixelFormat || video?.pix_fmt || null,
      bitDepth,
      hdr: Boolean(hdr),
      hdrKind: hdr,
      fourK,
      width,
      height,
      defaultCopySafe: defaultVideoCopy,
      hevcRemuxAvailableWithClientOptIn: codec === "hevc" && mainProfileCopySafe(video, codec),
      av1RemuxAvailableWithClientOptIn: codec === "av1" && mainProfileCopySafe(video, codec),
    },
    audio: {
      codec: normalizeMediaCodec(firstAudio?.codec) || null,
      channels: Number(firstAudio?.channels) || null,
      defaultBrowserFriendly: defaultAudioFriendly,
      surroundAvailable: Number(firstAudio?.channels) > 2,
    },
    defaultNeedsTranscode: Boolean(video && !defaultVideoCopy) || !defaultAudioFriendly,
    limits: MEDIA_COMPATIBILITY_LIMITS,
  };
}

function selectedAudioTrack(media, order) {
  const tracks = Array.isArray(media?.audioTracks) ? media.audioTracks : [];
  if (tracks.length) return tracks[order] || tracks[0] || null;
  return media?.audio || null;
}

function normalizedVideoMode(value) {
  const mode = String(value || "auto").trim().toLowerCase();
  return ["auto", "copy", "h264"].includes(mode) ? mode : "auto";
}

export function createTranscodePlan(media, {
  fileName = "",
  startSeconds = 0,
  audioTrackOrder = 0,
  audioMode = "stereo",
  videoMode = "auto",
  clientHevc = false,
  clientAv1 = false,
} = {}) {
  const sourceVideo = media?.video || null;
  const sourceCodec = normalizeMediaCodec(sourceVideo?.codec) || inferVideoCodecFromName(fileName);
  const requestedVideoMode = normalizedVideoMode(videoMode);
  const seeked = Number(startSeconds) > 0;
  const h264CopySafe = sourceCodec === "h264" && h264BrowserSafe(sourceVideo || {});
  const optInCopySafe = mainProfileCopySafe(sourceVideo, sourceCodec)
    && ((sourceCodec === "hevc" && clientHevc) || (sourceCodec === "av1" && clientAv1));
  // Explicit copy requests preserve the original (including HEVC 10-bit HDR)
  // when reopening a stream after a seek. Stream-copy seeks land on a nearby
  // keyframe; this is preferable to permanently downgrading HDR to H.264 SDR.
  const copySafe = (!seeked || requestedVideoMode === "copy") && (h264CopySafe || optInCopySafe);
  const copyRequested = requestedVideoMode === "copy" || requestedVideoMode === "auto";
  const copyVideo = copyRequested && copySafe;
  const sourceHdrKind = hdrKind(sourceVideo);

  let videoFallbackReason = null;
  if (!copyVideo && requestedVideoMode === "copy") {
    if (sourceVideo?.dolbyVision && !browserVideoProfileSafe(sourceVideo, sourceCodec)) videoFallbackReason = "dolby-vision-profile-not-browser-verified";
    else if (seeked) videoFallbackReason = "seek-requires-reencode";
    else if (sourceCodec === "hevc" && !clientHevc) videoFallbackReason = "hevc-client-opt-in-required";
    else if (sourceCodec === "av1" && !clientAv1) videoFallbackReason = "av1-client-opt-in-required";
    else videoFallbackReason = "source-video-not-safe-to-copy";
  }

  const track = selectedAudioTrack(media, audioTrackOrder);
  const audioPlan = planCompatibleAudio(track, { audioMode: normalizeAudioMode(audioMode), startSeconds });

  return {
    video: {
      sourceCodec: sourceCodec || null,
      mode: copyVideo ? "copy" : "h264",
      requestedMode: requestedVideoMode,
      tag: copyVideo && sourceCodec === "hevc" ? "hvc1" : null,
      bitDepth: videoBitDepth(sourceVideo),
      hdrKind: sourceHdrKind,
      toneMapToSdr: Boolean(!copyVideo && sourceHdrKind),
      keyframeSeek: Boolean(seeked && copyVideo),
      fallbackReason: videoFallbackReason,
    },
    audio: { ...audioPlan, track },
  };
}

export function transcodeVideoFilter(plan) {
  if (plan?.video?.mode === "copy") return null;
  if (plan?.video?.toneMapToSdr) {
    return "setpts=PTS-STARTPTS,zscale=t=linear:npl=100,format=gbrpf32le,tonemap=tonemap=hable:desat=0,zscale=p=bt709:t=bt709:m=bt709:r=tv,format=yuv420p";
  }
  return "setpts=PTS-STARTPTS,format=yuv420p";
}
