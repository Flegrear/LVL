// Torrent status is a bounded observation of server readers. The server does
// not verify which reader belongs to the video element or where its playhead
// is; never present an observed reader offset as the video's playhead.
const SLOW_AFTER_MS = 8_000;
const SLOW_RATE_BYTES_PER_SECOND = 16 * 1024;
const AUXILIARY_READER_ROLES = new Set(["probe", "subtitle", "speech"]);

const MESSAGES = Object.freeze({
  "no-peers": "No peers are connected while the torrent waits for data. Try another source.",
  "slow-source": "The torrent is downloading slowly. Try another source if playback doesn't resume.",
  "missing-piece": "A requested torrent range is missing data. Try another source if playback doesn't resume.",
  "waiting-for-piece": "Waiting for torrent pieces. Try another source if playback doesn't resume.",
});

/**
 * Only diagnose a real, active stall. Missing diagnostics mean unknown, never
 * zero peers, a missing playhead piece or a codec failure.
 */
export function classifyPlaybackStreamStatus(health, {
  stalled = false, paused = false, seeking = false, ended = false,
} = {}) {
  if (!stalled || paused || seeking || ended || !health || typeof health !== "object") return null;
  const readers = Array.isArray(health.readers) ? health.readers : [];
  // Server snapshots also contain subtitle extraction, probe and speech-sync
  // readers. Their missing pieces cannot explain an HTML video decoder stall,
  // and must never turn a codec error into a torrent-starvation diagnosis.
  const playbackReaders = readers.filter((reader) => reader
    && !AUXILIARY_READER_ROLES.has(reader.role));
  if (readers.length && !playbackReaders.length) return null;
  // The first piece may already have been delivered. The backend measures the
  // next *undelivered* byte, so later stalls are observable without treating a
  // previously cached first piece as proof the rest of the Range is available.
  const missing = playbackReaders.filter((reader) => reader.nextPiecePresent === false);
  // A global 0-peer count alone is uninformative when the browser already has
  // the media cached. It must coincide with an observed active missing piece.
  if (health.peers === 0 && missing.length > 0 && Number(health.activeReaderCount) > 0)
    return { code: "no-peers", message: MESSAGES["no-peers"], networkStarvation: true };

  // A verified offset describes a requested stream range, not a verified
  // playback position. The backend explicitly marks playheadVerified=false.
  if (health.requestedRangeActive === true && health.requestedPiecePresent === false) {
    const code = health.status === "slow-source" ? "slow-source"
      : health.status === "waiting-for-piece" ? "waiting-for-piece" : "missing-piece";
    return { code, message: MESSAGES[code], networkStarvation: true };
  }

  // The player cannot identify which internal reader the observation belongs
  // to. Here we may describe only the swarm/reader's state, never assert that
  // the video playhead is unbuffered or waiting on that particular piece.
  if (missing.length && Number(health.activeReaderCount) > 0) {
    const lowRate = Number.isFinite(health.downloadBytesPerSecond)
      && health.downloadBytesPerSecond < SLOW_RATE_BYTES_PER_SECOND;
    const waitingLongEnough = missing.some((reader) => Number(reader.ageMs) >= SLOW_AFTER_MS);
    const code = lowRate && waitingLongEnough ? "slow-source" : "waiting-for-piece";
    return { code, message: MESSAGES[code], networkStarvation: true };
  }
  return null;
}
