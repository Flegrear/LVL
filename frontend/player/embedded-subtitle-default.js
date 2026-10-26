// Select one readable in-video track for the first playback of a source.
// Explicitly attached/hidden captions or a global off switch take precedence.
export function defaultEmbeddedSubtitleTrack({ media, attached = [], captionsEnabled = true, languages = [], normalizeLanguage = (value) => value } = {}) {
  if (!captionsEnabled || attached.some((track) => track.cues?.length)) return null;
  const candidates = (media?.subtitleTracks || []).filter((track) =>
    track?.textBased === true && track.streamIndex !== null && track.streamIndex !== undefined
    && Number.isInteger(Number(track.streamIndex)));
  for (const language of languages) {
    const match = candidates.find((track) => normalizeLanguage(track.language) === language);
    if (match) return match;
  }
  return candidates.find((track) => track.default === true || track.isDefault === true
    || track.disposition?.default === 1) || candidates[0] || null;
}
