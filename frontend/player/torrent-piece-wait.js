// File byte buckets are only a rough timeline approximation for variable
// bitrate video. Use them to decide whether to WAIT for pieces, never to claim
// a precise decoded video frame, keyframe, or verified FFmpeg output.
export function torrentSeekPieceBucket({ buckets, targetSeconds, durationSeconds }) {
  if (!buckets?.length || !Number.isFinite(Number(durationSeconds))
    || Number(durationSeconds) <= 0 || !Number.isFinite(Number(targetSeconds))) return -1;
  return Math.max(0, Math.min(buckets.length - 1,
    Math.floor(Math.max(0, Number(targetSeconds)) / Number(durationSeconds) * buckets.length)));
}

export function torrentSeekPieceStatus({ buckets, targetSeconds, durationSeconds, verifiedComplete = false }) {
  if (verifiedComplete) return 'verified-complete';
  const index = torrentSeekPieceBucket({ buckets, targetSeconds, durationSeconds });
  if (index < 0) return 'unknown';
  // Include the preceding bucket for a copied-video keyframe that may begin
  // earlier than the requested timestamp. This is approximate, conservative.
  return buckets[index] === 255 && (index === 0 || buckets[index - 1] === 255)
    ? 'likely-ready' : 'missing';
}
