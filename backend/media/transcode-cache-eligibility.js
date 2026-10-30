// Conservative, side-effect-free admission for *completed* H.264 encode output.
// The caller owns FFprobe provenance, FFmpeg execution and storage reservations.
// A positive result does not validate fMP4 bytes: the existing recorder must
// still verify every moof/mdat, complete EOF and (for warm windows) H.264 IDR.
import { hardwareVideoEncodingArgs } from './hardware-transcode.js';
import { hdrKind, normalizeMediaCodec, transcodeVideoFilter, videoBitDepth } from '../../shared/media/media-compat.js';

export const ENCODED_CACHE_LIMITS = Object.freeze({
  maxDurationSeconds: 180,
  maxOutputBytes: 64 * 1024 * 1024,
  maxPixels: 1920 * 1080,
  maxFrameRate: 60,
  minimumReservationBytes: 4 * 1024 * 1024,
});

const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/i;
const TORRENT_INFO_HASH = /^[0-9a-f]{40}$/i;
const MAX_SOURCE_BYTES = 20 * 1024 * 1024 * 1024;
const FINITE_TIME = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const deny = reason => ({ eligible: false, reason });

export function evaluateEncodedH264CacheEligibility({
  sessionId, sourceIdentity, fileIndex, sourceLength,
  media, verifiedProbe = false, plan, startSeconds, effectiveStartSeconds,
  remainingDuration, audioTrackOrder, videoEncoder, videoEncodingArgs,
  videoFilter, audioFilter, ffmpegFingerprint,
  // These values are an admission snapshot, not a storage reservation. The
  // writer must enforce the hard output cap and recheck the shared allowance.
  availableCacheBytes, reservedSourceBytes, estimatedOutputBytes,
  activeTranscodes,
} = {}) {
  if (!SESSION.test(String(sessionId)) || !TORRENT_INFO_HASH.test(String(sourceIdentity))
    || !Number.isSafeInteger(fileIndex) || fileIndex < 0
    || !Number.isSafeInteger(sourceLength) || sourceLength < 1 || sourceLength > MAX_SOURCE_BYTES)
    return deny('invalid-source-identity');
  if (verifiedProbe !== true || !media?.video || !Array.isArray(media.audioTracks))
    return deny('unverified-probe');
  const video = media.video;
  const sourceCodec = normalizeMediaCodec(video.codec);
  // This completed-replay batch validates only HEVC Main SDR -> libx264.
  // Broader source-codec/profile reuse needs its own conversion-clock proof.
  if (sourceCodec !== 'hevc' || String(video.profile || '').trim().toLowerCase() !== 'main'
    || video.pixelFormat !== 'yuv420p' || videoBitDepth(video) !== 8
    || video.colorTransfer !== 'bt709' || video.colorPrimaries !== 'bt709'
    || video.colorSpace !== 'bt709' || video.dolbyVision !== null
    || hdrKind(video) !== null)
    return deny('unverified-sdr-color-or-depth');
  if (!Number.isSafeInteger(video.width) || !Number.isSafeInteger(video.height)
    || video.width < 16 || video.height < 16
    || video.width * video.height > ENCODED_CACHE_LIMITS.maxPixels
    || !Number.isFinite(video.frameRate) || video.frameRate < 1
    || video.frameRate > ENCODED_CACHE_LIMITS.maxFrameRate)
    return deny('video-resource-limit');
  if (plan?.video?.mode !== 'h264' || plan.video.sourceCodec !== sourceCodec
    || plan.video.bitDepth !== 8 || plan.video.hdrKind !== null
    || plan.video.toneMapToSdr !== false || plan.video.keyframeSeek !== false)
    return deny('unsafe-video-plan');
  if (videoEncoder !== 'libx264'
    || !Array.isArray(videoEncodingArgs)
    || JSON.stringify(videoEncodingArgs) !== JSON.stringify(hardwareVideoEncodingArgs('libx264', video.height))
    || videoFilter !== transcodeVideoFilter(plan)
    || videoFilter !== 'setpts=PTS-STARTPTS,format=yuv420p')
    return deny('unbound-encoder-options');
  if (!SHA.test(String(ffmpegFingerprint))) return deny('unversioned-ffmpeg');
  if (!FINITE_TIME(startSeconds) || !FINITE_TIME(effectiveStartSeconds)
    || effectiveStartSeconds !== startSeconds || !FINITE_TIME(remainingDuration)
    || remainingDuration < 0.25 || remainingDuration > ENCODED_CACHE_LIMITS.maxDurationSeconds
    || !FINITE_TIME(media.durationSeconds)
    || Math.abs(startSeconds + remainingDuration - media.durationSeconds) > 0.01)
    return deny('unverified-encoded-clock');
  const track = media.audioTracks[audioTrackOrder];
  if (!Number.isSafeInteger(audioTrackOrder) || audioTrackOrder < 0
    || !track || typeof track.codec !== 'string' || !track.codec.trim()
    || !Number.isSafeInteger(track.channels) || track.channels < 1 || track.channels > 8
    || plan.audio?.present !== true || plan.audio.track !== track
    || plan.audio.codec !== 'aac' || plan.audio.outputCodec !== 'aac'
    || ![1, 2, 6].includes(plan.audio.channels)
    || !['auto', 'stereo', 'surround'].includes(plan.audio.mode)
    || !['160k', '256k', '384k'].includes(plan.audio.bitRate)
    || audioFilter !== 'asetpts=PTS-STARTPTS,aresample=async=1:first_pts=0')
    return deny('unverified-audio-plan');
  if (!Number.isSafeInteger(activeTranscodes) || activeTranscodes !== 0
    || !Number.isSafeInteger(availableCacheBytes) || availableCacheBytes < 0
    || !Number.isSafeInteger(reservedSourceBytes) || reservedSourceBytes < 0
    || !Number.isSafeInteger(estimatedOutputBytes) || estimatedOutputBytes < 4096
    || estimatedOutputBytes > ENCODED_CACHE_LIMITS.maxOutputBytes / 2
    || availableCacheBytes - reservedSourceBytes
      < 2 * estimatedOutputBytes + ENCODED_CACHE_LIMITS.minimumReservationBytes)
    return deny('insufficient-resource-headroom');

  return {
    eligible: true,
    // A cap returned as data is NOT enforcement. The integration must stop
    // optional recording when this exact cap is reached without stopping HTTP.
    maxOutputBytes: ENCODED_CACHE_LIMITS.maxOutputBytes,
    identity: {
      sessionId, sourceIdentity, fileIndex, sourceLength,
      startSeconds, effectiveStartSeconds, remainingDuration,
      videoMode: 'h264', videoCodec: sourceCodec, outputCodec: 'h264',
      cachePolicy: 'verified-encoded-sdr-v1',
      sourceVideoProfile: video.profile || null,
      sourcePixelFormat: video.pixelFormat, sourceWidth: video.width,
      sourceHeight: video.height, sourceFrameRate: video.frameRate,
      sourceColorTransfer: video.colorTransfer,
      sourceColorPrimaries: video.colorPrimaries,
      sourceColorSpace: video.colorSpace,
      videoEncoder, videoEncodingArgs: videoEncodingArgs.join('\u0001'), videoFilter,
      // FFmpeg's deliberate two-second H.264 IDRs alter encoded bytes and must
      // be part of the exact replay key. The server must pass this expression
      // to -force_key_frames only for an eligible encoded cache plan.
      forcedKeyframes: 'expr:gte(t,n_forced*2)',
      audioTrack: audioTrackOrder, audioSourceCodec: track.codec,
      audioSourceChannels: track.channels, audioMode: plan.audio.mode,
      audioCodec: plan.audio.codec, audioChannels: plan.audio.channels,
      audioBitrate: plan.audio.bitRate, audioFilter,
      ffmpegFingerprint: ffmpegFingerprint.toLowerCase(),
    },
  };
}
