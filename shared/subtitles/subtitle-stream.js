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
  // Intervals may arrive as adjacent aligned and focused windows, in any
  // order. Merge their union from the seek point before choosing a prefetch
  // boundary, so [0,180)+[180,360) does not trigger a redundant 180s fetch.
  const intervals = [];
  for (const start of track?.embeddedCompletedWindows || []) {
    if (Number.isFinite(Number(start)) && Number(start) >= 0)
      intervals.push([Number(start), Number(start) + EMBEDDED_WINDOW_SECONDS]);
  }
  if (Array.isArray(track?.embeddedCompletedRanges)) {
    for (const range of track.embeddedCompletedRanges) {
      const start = Number(range?.start), finish = Number(range?.end);
      if (Number.isFinite(start) && Number.isFinite(finish) && start >= 0 && finish > start)
        intervals.push([start, finish]);
    }
  }
  intervals.sort((a, b) => a[0] - b[0]);
  let end = null;
  for (const [start, finish] of intervals) {
    if (end === null) {
      if (at >= start && at < finish) end = finish;
      continue;
    }
    if (start > end) break;
    end = Math.max(end, finish);
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

// Caption owners are media files, never display titles or transient decoder
// URLs. An unknown legacy owner is deliberately not eligible for a broad
// match: that caption can be reimported under the active source.
export function mediaSourceOwnerKey(source) {
  if (!source || typeof source !== "object") return "";
  if (source.kind === "torrent") {
    const index = Number(source.fileIndex);
    if (!Number.isSafeInteger(index) || index < 0
      || source.fileIndex === null || source.fileIndex === undefined || source.fileIndex === "") return "";
    const hash = String(source.infoHash || source.libraryId || "").trim().toLowerCase();
    if (/^[a-f0-9]{40}$/.test(hash)) return `torrent:${hash}:${index}`;
    const session = String(source.sessionId || "").trim();
    return session ? `torrent-session:${session}:${hash}:${index}` : "";
  }
  if (source.kind === "local") {
    const instance = String(source.fileInstanceId || source.contentId || "").trim();
    return instance ? `local:${instance}` : "";
  }
  return "";
}

export function mediaSourcesMatch(a, b) {
  const owner = mediaSourceOwnerKey(a);
  return Boolean(owner && owner === mediaSourceOwnerKey(b));
}

// A stream index is only unique inside its owning media file. Callers that
// select a particular embedded track also compare its embeddedStreamIndex.
export function embeddedTrackMatchesSource(track, source) {
  const original = track?.source;
  if (!original || !source || original.kind !== "torrent" || source.kind !== "torrent") return false;
  return mediaSourcesMatch(original, source);
}

export function mergeSubtitleWindows(existing = [], incoming = [], trackId = "subtitle") {
  const seen = new Map();
  for (const cue of [...existing, ...incoming]) {
    const startMs = Number(cue?.startMs);
    const endMs = Number(cue?.endMs);
    const text = String(cue?.text || "").trim();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs || !text) continue;
    // A repeated extraction of the same event is a duplicate; simultaneous
    // ASS actors/layers/styles with identical words are not. Do not erase
    // semantic ownership supplied by an ASS event during window stitching.
    const semantic = ["actor", "layer", "style", "kind"].map((field) => String(cue?.[field] ?? ""));
    const key = JSON.stringify([startMs, endMs, text, ...semantic]);
    if (!seen.has(key)) seen.set(key, { ...cue });
  }
  return [...seen.values()].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
    .map((cue) => {
      let hash = 2166136261;
      const semantic = ["actor", "layer", "style", "kind"]
        .map((field) => String(cue?.[field] ?? ""));
      // Legacy unannotated cue IDs must remain stable across the upgrade.
      const identityText = semantic.some(Boolean) ? [cue.text, ...semantic].join("\u0000") : cue.text;
      for (const char of identityText) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
      return { ...cue, id: `${trackId}-${Math.round(cue.startMs)}-${Math.round(cue.endMs)}-${(hash >>> 0).toString(36)}`, trackId };
    });
}
