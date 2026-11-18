// A Storage preference write can fail after a player switches from an indexed
// source to native playback. Only the exact source and operation that initiated
// that write may update the controls when the response arrives. This is shared
// with player-core's live-source capture and its Settings caller.
export function remuxPreferenceIntentMatches(saved, current, {
  allowNativeRestart = false,
} = {}) {
  if (!saved || !current || !saved.source || saved.source !== current.source
    || saved.sessionId !== current.sessionId
    || saved.fileIndex !== current.fileIndex) return false;
  // The deliberate native handoff changes the video URL (and the element's
  // frame generation), not the source-load request or transcode context. A
  // separate same-source load, audio/output or subtitle/language choice must
  // never be mistaken for that accepted handoff.
  if (allowNativeRestart) return saved.loadGeneration === current.loadGeneration
    && saved.context === current.context
    && saved.selectedAudioTrack === current.selectedAudioTrack
    && saved.audioIndex === current.audioIndex
    && saved.audioMode === current.audioMode
    && saved.selectedTrackId === current.selectedTrackId
    && saved.baseLanguage === current.baseLanguage
    && saved.targetLanguage === current.targetLanguage;
  // After the PUT is in flight, any later seek, source replacement or audio
  // operation is a new owner. Its pause/position/language intent wins.
  return saved.loadGeneration === current.loadGeneration
    && saved.context === current.context && saved.videoSrc === current.videoSrc
    && saved.selectedAudioTrack === current.selectedAudioTrack
    && saved.audioIndex === current.audioIndex
    && saved.audioMode === current.audioMode
    && saved.selectedTrackId === current.selectedTrackId
    && saved.baseLanguage === current.baseLanguage
    && saved.targetLanguage === current.targetLanguage;
}
