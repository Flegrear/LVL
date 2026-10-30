// Select one readable in-video dialogue track for the first playback of a source.
// Explicitly attached/hidden captions or a global off switch take precedence.
function isSecondarySubtitleTrack(track) {
  if (track?.forced === true || track?.isForced === true || Number(track?.disposition?.forced) === 1) return true;
  const title = String(track?.title || "").trim().toLowerCase();
  if (!title || /\b(?:full|complete|dialogue|dialog|main)\b/.test(title)) return false;
  // Anime often separates signs, songs and OP/ED lyrics from full dialogue.
  // A title is a hint only: an explicitly labeled full track still wins.
  return /\b(?:signs|songs|lyrics|karaoke)\b/.test(title) && !/\bsign language\b/.test(title)
    || /\bop\s*[/&+ -]\s*ed\b|\b(?:opening|ending)\s*[/&+ -]\s*(?:ending|opening)\b/.test(title);
}

export function defaultEmbeddedSubtitleTrack({ media, attached = [], captionsEnabled = true, languages = [], normalizeLanguage = (value) => value } = {}) {
  if (!captionsEnabled || attached.some((track) => track.cues?.length)) return null;
  const candidates = (media?.subtitleTracks || []).filter((track) =>
    track?.textBased === true && track.streamIndex !== null && track.streamIndex !== undefined
    && Number.isInteger(Number(track.streamIndex)));
  const isDefault = (track) => track.default === true || track.isDefault === true
    || Number(track.disposition?.default) === 1;
  const preferred = (tracks) => tracks.find(isDefault) || tracks[0] || null;
  // Seek full dialogue in all preferred languages before falling back to a
  // forced/signs-only track: an English signs stream can precede Japanese
  // dialogue in the same MKV without providing spoken captions.
  const dialogue = candidates.filter((track) => !isSecondarySubtitleTrack(track));
  for (const language of languages) {
    const match = preferred(dialogue.filter((track) => normalizeLanguage(track.language) === language));
    if (match) return match;
  }
  return preferred(dialogue) || preferred(candidates);
}
