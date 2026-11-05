// Read-only explanation of configured versus effective fast seek, for the
// current exact source/audio plan. Never changes settings, data or cache quotas.
// The authoritative playback controller still validates every cached GOP/window.
function validRange(r) {
  return r && Number.isFinite(r.start) && Number.isFinite(r.end)
    && r.start >= 0 && r.end > r.start;
}
export function evaluateFastSeekState({
  configuredEnabled = false, serverEnabled = false, sourceMatches = false,
  audioMatches = false, mode = "unknown", verifiedSource = false,
  canCopyVideo = false, canEncodeVideo = false,
  fullIndexAvailable = true, sectionIndexAvailable = true, remuxWindowAvailable = true,
  availableCacheBytes = null, requiredCacheBytes = null,
  readyRanges = [], targetSeconds = null,
} = {}) {
  const configured = configuredEnabled === true;
  const server = serverEnabled === true;
  const selected = sourceMatches === true && audioMatches === true;
  const ranges = Array.isArray(readyRanges) ? readyRanges.filter(validRange) : [];
  const target = Number.isFinite(targetSeconds) && targetSeconds >= 0 ? targetSeconds : null;
  const readyAtTarget = verifiedSource === true && target !== null && ranges.some(({ start, end }) =>
    target >= start && target < end - 0.001);
  const budgetKnown = Number.isFinite(availableCacheBytes) && Number.isFinite(requiredCacheBytes)
    && requiredCacheBytes > 0 && availableCacheBytes >= 0;
  const budgetSufficient = budgetKnown && availableCacheBytes >= requiredCacheBytes;
  // A persisted Settings toggle is NOT an enabled seek engine. Android keeps
  // downloads, so WHOLE_EPISODE_COPY and SECTION_CACHE are currently false;
  // only exact-plan bounded remux windows may remain eligible, if independently
  // recorded and verified. Do not claim indexed availability from a toggle.
  const canPrepare = (canCopyVideo === true && (
    fullIndexAvailable === true || sectionIndexAvailable === true || remuxWindowAvailable === true))
    || (canEncodeVideo === true && (fullIndexAvailable === true || sectionIndexAvailable === true));
  let reason = "not-configured";
  if (configured && !server) reason = "server-cache-unavailable";
  else if (configured && server && !selected) reason = "stale-source-or-audio";
  else if (configured && server && selected && readyAtTarget) reason = "verified-target-ready";
  else if (configured && server && selected && !verifiedSource) reason = "source-bytes-not-verified";
  else if (configured && server && selected && !canPrepare) reason = "no-supported-cache-path";
  else if (configured && server && selected && budgetKnown && !budgetSufficient) reason = "insufficient-cache-headroom";
  else if (configured && server && selected) reason = "waiting-for-verified-seek-range";
  return Object.freeze({
    configured, serverEnabled: server, activeForSource: configured && server && selected,
    readyAtTarget: configured && server && selected && readyAtTarget,
    fullIndexAvailable: fullIndexAvailable === true,
    sectionIndexAvailable: sectionIndexAvailable === true,
    remuxWindowAvailable: remuxWindowAvailable === true,
    mode: ["direct", "remux", "transcode", "indexed", "progressive"].includes(mode) ? mode : "unknown",
    availableCacheBytes: Number.isFinite(availableCacheBytes) && availableCacheBytes >= 0
      ? Math.floor(availableCacheBytes) : null,
    budgetSufficient: budgetKnown ? budgetSufficient : null,
    readyRangeCount: ranges.length, reason,
  });
}
