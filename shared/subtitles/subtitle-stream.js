// Embedded subtitle tracks are read from finite windows of the torrent.
// FFmpeg's output timestamp offset restores original playback time; merge subsequent windows without
// changing the cue IDs that learning cards and playback may reference.
export const EMBEDDED_WINDOW_SECONDS = 180;
// Allow a little room for ASS/SRT cues already active at a seek target.
// Seeking directly to the playhead can otherwise miss a cue that began
// shortly before it.
export const EMBEDDED_SEEK_LOOKBACK_SECONDS = 6;

export function subtitleWindowStart(seconds, windowSeconds = EMBEDDED_WINDOW_SECONDS) {
  const time = Math.max(0, Number(seconds) || 0);
  return Math.floor(time / windowSeconds) * windowSeconds;
}

export function embeddedSubtitleSeekStart(seconds) {
  const at = Math.max(0, Number(seconds) || 0);
  return Math.max(0, Math.floor(at) - EMBEDDED_SEEK_LOOKBACK_SECONDS);
}

// Aligned 180s windows remain valid for older saved tracks. New quick-seek
// extractions cover an offset interval, not an entire aligned window: keep
// them distinct so e.g. a seek to 175s does not mark 0..180s as cached.
export function embeddedSubtitleCovers(track, seconds) {
  const at = Number(seconds);
  if (!Number.isFinite(at) || at < 0) return false;
  if (track?.embeddedCompletedWindows?.includes(subtitleWindowStart(at))) return true;
  return Array.isArray(track?.embeddedCompletedRanges) && track.embeddedCompletedRanges.some((range) =>
    Number.isFinite(Number(range?.start)) && Number.isFinite(Number(range?.end))
    && at >= Number(range.start) && at < Number(range.end));
}

// When prefetching, start at the edge of the already-loaded region rather
// than 25 seconds after the current time. Otherwise a seek late in a focused
// 180s range may leave a hole between its end and the next extracted cues.
export function embeddedSubtitleCoverageEnd(track, seconds) {
  const at = Number(seconds);
  if (!Number.isFinite(at) || at < 0) return null;
  let end = null;
  const aligned = subtitleWindowStart(at);
  if (track?.embeddedCompletedWindows?.includes(aligned)) end = aligned + EMBEDDED_WINDOW_SECONDS;
  if (Array.isArray(track?.embeddedCompletedRanges)) {
    for (const range of track.embeddedCompletedRanges) {
      const start = Number(range?.start), finish = Number(range?.end);
      if (Number.isFinite(start) && Number.isFinite(finish) && start >= 0
        && start <= at && finish > at && finish > start) end = Math.max(end ?? 0, finish);
    }
  }
  return end;
}

// HTTP body chunks can end halfway through a subtitle text line. Parsing an
// unfinished block invents a partial cue that survives beside the full text.
export function completedWebVttText(text, finished = false) {
  const normalized = String(text || "").replace(/\r\n?/g, "\n");
  if (finished) return normalized + "\n\n";
  const boundary = normalized.lastIndexOf("\n\n");
  return boundary < 0 ? "" : normalized.slice(0, boundary + 2);
}

export function embeddedExtractionError(text) {
  const result = String(text || "").match(/(?:^|\n)NOTE LVL-EXTRACT-PARTIAL:\s*([^\r\n]+)/);
  return result ? result[1].trim().slice(0, 200) : "";
}

// Media stream indexes are only unique within one file. Different torrent
// releases (even episodes with the same display title) can have identical
// stream numbers and must not reuse each other's embedded subtitle tracks.
export function embeddedTrackMatchesSource(track, source) {
  const original = track?.source;
  if (!original || !source || original.kind !== "torrent" || source.kind !== "torrent") return false;
  const index = (value) => value !== null && value !== undefined
    && !(typeof value === "string" && !value.trim())
    && Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;
  if (index(original.fileIndex) === null || index(original.fileIndex) !== index(source.fileIndex)) return false;
  const originalLibrary = String(original.libraryId || "").toLowerCase();
  const currentLibrary = String(source.libraryId || "").toLowerCase();
  if (originalLibrary && currentLibrary && originalLibrary !== currentLibrary) return false;
  const originalFile = String(original.fileName || "").trim().toLowerCase();
  const currentFile = String(source.fileName || "").trim().toLowerCase();
  if (originalFile && currentFile && originalFile !== currentFile) return false;
  if (originalLibrary && currentLibrary) return true; // Same infohash + file index across sessions.
  return Boolean(original.sessionId && original.sessionId === source.sessionId);
}

export function mergeSubtitleWindows(existing = [], incoming = [], trackId = "subtitle") {
  const seen = new Map();
  for (const cue of [...existing, ...incoming]) {
    const startMs = Number(cue?.startMs);
    const endMs = Number(cue?.endMs);
    const text = String(cue?.text || "").trim();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs || !text) continue;
    const key = `${startMs}|${endMs}|${text}`;
    if (!seen.has(key)) seen.set(key, { ...cue });
  }
  return [...seen.values()].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
    .map((cue) => {
      let hash = 2166136261;
      for (const char of cue.text) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
      return { ...cue, id: `${trackId}-${Math.round(cue.startMs)}-${Math.round(cue.endMs)}-${(hash >>> 0).toString(36)}`, trackId };
    });
}
