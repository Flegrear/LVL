// One completion and verified-episode identity contract for Library, playback and sync.
// A source hash still identifies a playable file; only a verified catalog+episode
// pair may connect watched intent from two independently downloaded sources.
export const VIDEO_COMPLETE_AT = 0.90;
const EPISODE_CODE = /^S\d{2}E\d{2,4}$/;
const VERIFIED_CATALOG_ID = /^tt\d{5,12}$/i;

export function videoProgressComplete(progress) {
  const duration = Number(progress?.durationMs);
  const position = Number(progress?.positionMs);
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(position) || position < 0)
    return false;
  // A saved "finished" flag is only an observation, not a manual watch.
  // Older clients sometimes wrote finished:true with a partial position.
  // Manual completion lives independently in video.watched/watchedChapters.
  return position >= duration * VIDEO_COMPLETE_AT;
}

export function videoPartialProgress(progress) {
  const duration = Number(progress?.durationMs);
  const position = Number(progress?.positionMs);
  return Number.isFinite(duration) && duration > 0 && Number.isFinite(position) && position >= 0
    && !videoProgressComplete(progress);
}

export function verifiedVideoEpisodeKey({ catalogId, catalogType } = {}, rawCode) {
  const code = String(rawCode || '').toUpperCase();
  const kind = String(catalogType || '').toLowerCase();
  if (!VERIFIED_CATALOG_ID.test(String(catalogId || '')) || kind !== 'series' || !EPISODE_CODE.test(code))
    return null;
  return `${kind}:${String(catalogId).toLowerCase()}:${code}`;
}

export function verifiedVideoWorkKey({ catalogId, catalogType } = {}) {
  const kind = String(catalogType || '').toLowerCase();
  if (!VERIFIED_CATALOG_ID.test(String(catalogId || '')) || !['series','movie'].includes(kind))
    return null;
  return `${kind}:${String(catalogId).toLowerCase()}`;
}

export function verifiedVideoEntryMatches(entry, context, code) {
  const id = verifiedVideoEpisodeKey(entry, code);
  return id !== null && id === verifiedVideoEpisodeKey(context, code);
}

// Explicit unwatched is retained as a negative intent even after a completed
// source's position is compacted. Imported counts cannot replace this choice.
export function videoWatchedChoice(entry, code) {
  const marker = entry?.watchedChapters?.[code];
  if (marker === false) return false;
  if (marker === true || typeof marker === 'number' && Number.isFinite(marker) && marker > 0) return true;
  return null;
}
