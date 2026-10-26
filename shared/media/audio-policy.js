// Shared by browser playback information and the server's FFmpeg planner.
// An MP4 remux can carry AAC/MP3 unchanged; other codecs need a compatible
// output. Never copy audio on a nonzero FFmpeg seek without PTS verification.
export function normalizeAudioMode(value) {
  const mode = String(value || "auto").trim().toLowerCase();
  return ["auto", "stereo", "surround"].includes(mode) ? mode : "auto";
}

export function aacBitRate(channels) {
  if (channels >= 6) return "384k";
  if (channels >= 3) return "256k";
  return "160k";
}

export function planCompatibleAudio(track, { audioMode = "auto", startSeconds = 0 } = {}) {
  // Metadata can arrive after FFmpeg starts: retain a valid conservative
  // output instead of accidentally passing -ac 0 to FFmpeg.
  if (!track) return { present: false, codec: "aac", outputCodec: "aac", channels: 2, sourceChannels: 2, mode: normalizeAudioMode(audioMode), bitRate: "160k", reason: "metadata-unavailable" };
  const sourceCodec = String(track.codec || "").trim().toLowerCase();
  const sourceChannels = Math.max(1, Number(track.channels) || 2);
  const mode = normalizeAudioMode(audioMode);
  const channels = Math.min(sourceChannels, mode === "stereo" ? 2 : 6);
  const seeked = Number(startSeconds) > 0;
  const copy = !seeked && channels === sourceChannels && ["aac", "mp3"].includes(sourceCodec);
  return {
    present: true, sourceCodec: sourceCodec || null, sourceChannels, channels, mode,
    codec: copy ? "copy" : "aac", outputCodec: copy ? sourceCodec : "aac",
    bitRate: copy ? null : aacBitRate(channels),
    reason: copy ? "original" : seeked && ["aac", "mp3"].includes(sourceCodec) && channels === sourceChannels
      ? "seek-timestamp-safety" : channels < sourceChannels ? "channel-downmix" : "compatibility",
  };
}
