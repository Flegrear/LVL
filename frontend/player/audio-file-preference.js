// Versioned, verified media-file audio selection. An array ordinal is never
// treated as a container stream UID, nor copied to another file by title alone.
import { mediaSourceOwnerKey } from "../../shared/subtitles/subtitle-stream.js";

export const FILE_AUDIO_PREFERENCES_SCHEMA = 2;
export const FILE_AUDIO_PREFERENCES_KEY = "lvl-file-audio-preferences-v2";

export function verifiedAudioFileOwner(source) {
  const owner = mediaSourceOwnerKey(source);
  return owner.startsWith("torrent:") && /^torrent:[a-f0-9]{40}:[0-9]+$/.test(owner)
    || owner.startsWith("local:") && owner.length > "local:".length ? owner : "";
}

export function verifiedContainerAudioStreamIndex(track) {
  // Only an explicit verified probe field identifies the actual stream. The
  // position in audioTracks is an audio-only ordinal, NOT an FFprobe stream UID.
  const raw = track?.streamIndex;
  // Coercion is not evidence: Number(false) and Number(" ") are both zero,
  // but neither is a container stream index supplied by FFprobe.
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0
    ? raw : null;
}

export function fileAudioChoice(source, track, ordinal, count, allTracks = null) {
  const fileOwner = verifiedAudioFileOwner(source);
  if (!fileOwner || !Number.isSafeInteger(ordinal) || ordinal < 0
    || !Number.isSafeInteger(count) || ordinal >= count) return null;
  const explicitLanguage = String(track?.language || "").trim().toLowerCase();
  const language = /^(?!und$|unknown$)[a-z]{2,3}$/.test(explicitLanguage)
    ? explicitLanguage : "";
  const title = String(track?.title || "").trim().slice(0, 120);
  const candidateIndex = verifiedContainerAudioStreamIndex(track);
  // Verify uniqueness within the actual current probe. FFprobe reports a
  // container stream index, whereas a missing producer field must never be
  // accepted as repeated 0 on multiple audio tracks.
  const verifiedStreamIndex = candidateIndex !== null
    && Array.isArray(allTracks)
    && allTracks.filter(item => verifiedContainerAudioStreamIndex(item) === candidateIndex).length === 1
    ? candidateIndex : null;
  return {
    schema: FILE_AUDIO_PREFERENCES_SCHEMA, fileOwner,
    streamIndex: verifiedStreamIndex,
    ordinal, count, language, title,
  };
}

export function matchFileAudioChoice(tracks, choice, source) {
  if (!Array.isArray(tracks) || !choice || choice.schema !== FILE_AUDIO_PREFERENCES_SCHEMA
    || !choice.fileOwner || choice.fileOwner !== verifiedAudioFileOwner(source)) return -1;
  if (choice.streamIndex !== null && choice.streamIndex !== undefined) {
    // A reordered probe can move audio stream 4 from audio ordinal 1 to 0.
    // Never silently fall back to ordinal 1 when UID 4 is not present.
    const matches = tracks.map((track, index) =>
      verifiedContainerAudioStreamIndex(track) === choice.streamIndex ? index : -1)
      .filter(index => index >= 0);
    return matches.length === 1 ? matches[0] : -1;
  }
  // Legacy/undisclosed stream identity: same verified file and unchanged audio
  // track count only. It is expressly not a durable cross-file preference.
  return Number.isSafeInteger(choice.ordinal) && choice.ordinal >= 0
    && choice.ordinal < tracks.length && choice.count === tracks.length
    ? choice.ordinal : -1;
}
