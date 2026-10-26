export const DEFAULT_PLAYBACK_RECOVERY_POLICY = Object.freeze({
  sameSourceRetries: 1,
  maxSourceSwitches: 2,
  progressResetSeconds: 5,
  stallAfterMs: 8_000,
});

// Browser MEDIA_ERR_DECODE (3) and MEDIA_ERR_SRC_NOT_SUPPORTED (4) suggest a
// format problem. Network stalls alone should not convert a playable HDR/4K
// stream into SDR H.264, because conversion cannot create missing torrent data.
export function playbackRetryStrategy(mode, reason, mediaErrorCode = null) {
  if (mode === "torrent-direct") {
    return reason === "error" && [3, 4].includes(Number(mediaErrorCode))
      ? "compatibility" : "restart-direct";
  }
  return "restart-transcode";
}

function sourceKey(value) {
  return String(value ?? "").trim();
}

function finiteNonNegative(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function normalizePolicy(policy = {}) {
  return {
    sameSourceRetries: Math.floor(finiteNonNegative(policy.sameSourceRetries, DEFAULT_PLAYBACK_RECOVERY_POLICY.sameSourceRetries)),
    maxSourceSwitches: Math.floor(finiteNonNegative(policy.maxSourceSwitches, DEFAULT_PLAYBACK_RECOVERY_POLICY.maxSourceSwitches)),
    progressResetSeconds: finiteNonNegative(policy.progressResetSeconds, DEFAULT_PLAYBACK_RECOVERY_POLICY.progressResetSeconds),
    stallAfterMs: finiteNonNegative(policy.stallAfterMs, DEFAULT_PLAYBACK_RECOVERY_POLICY.stallAfterMs),
  };
}

function uniqueSourceKeys(values = []) {
  const seen = new Set();
  const keys = [];
  for (const value of values || []) {
    const key = sourceKey(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

export function playbackRecoverySourceKey(libraryId, fileIndex) {
  const id = sourceKey(libraryId);
  // Number(null) and Number("") are both zero, but only an explicit index 0
  // identifies the first file in a torrent.
  if (fileIndex === null || fileIndex === undefined || (typeof fileIndex === "string" && !fileIndex.trim())) return "";
  const index = Number(fileIndex);
  if (!id || !Number.isSafeInteger(index) || index < 0) return "";
  return `${id}:${index}`;
}

export function createPlaybackRecoveryState(currentSourceKey = "") {
  const key = sourceKey(currentSourceKey);
  return {
    sourceKey: key,
    pendingSourceKey: "",
    retryCount: 0,
    sourceSwitches: 0,
    attemptedSourceKeys: key ? [key] : [],
    progressAnchorSeconds: null,
    lastProgressSeconds: null,
    cancelled: false,
    exhausted: false,
  };
}

export function resetPlaybackRecovery(state, currentSourceKey = state?.sourceKey || "") {
  return createPlaybackRecoveryState(currentSourceKey);
}

// A requested recovery switch is remembered in pendingSourceKey. Confirming that exact source
// preserves the incident history so a bad pair of sources cannot bounce back and forth forever.
// Any other source change is treated as an explicit/new playback choice and starts fresh.
export function changePlaybackRecoverySource(state, currentSourceKey) {
  const current = state || createPlaybackRecoveryState();
  const key = sourceKey(currentSourceKey);
  if (key === current.sourceKey && !current.pendingSourceKey) return current;
  if (key && key === current.pendingSourceKey) {
    return {
      ...current,
      sourceKey: key,
      pendingSourceKey: "",
      retryCount: 0,
      progressAnchorSeconds: null,
      lastProgressSeconds: null,
      cancelled: false,
      exhausted: false,
    };
  }
  return createPlaybackRecoveryState(key);
}

// A recovery-selected alternate can fail before it ever becomes the active source (for example,
// magnet resolution or startup returns false). Keep the failed target in attemptedSourceKeys and
// keep the switch budget consumed, but release the pending guard so recovery can choose the next
// untried alternate while the old source remains current.
export function failPlaybackRecoverySwitch(state) {
  const current = state || createPlaybackRecoveryState();
  if (!current.pendingSourceKey) return current;
  return { ...current, pendingSourceKey: "" };
}

export function cancelPlaybackRecovery(state) {
  const current = state || createPlaybackRecoveryState();
  return { ...current, pendingSourceKey: "", cancelled: true };
}

export function recordPlaybackProgress(state, {
  sourceKey: currentSourceKey = state?.sourceKey || "",
  currentTimeSeconds,
  seeking = false,
  policy,
} = {}) {
  let current = state || createPlaybackRecoveryState();
  const key = sourceKey(currentSourceKey);
  if (key !== current.sourceKey) current = changePlaybackRecoverySource(current, key);
  const seconds = Number(currentTimeSeconds);
  if (!key || seeking || !Number.isFinite(seconds) || seconds < 0) return current;

  const normalized = normalizePolicy(policy);
  const previous = current.lastProgressSeconds === null ? Number.NaN : Number(current.lastProgressSeconds);
  const movedBackward = Number.isFinite(previous) && seconds + 0.25 < previous;
  const anchor = current.progressAnchorSeconds === null ? Number.NaN : Number(current.progressAnchorSeconds);
  if (!Number.isFinite(anchor) || movedBackward) {
    return { ...current, progressAnchorSeconds: seconds, lastProgressSeconds: seconds };
  }

  if (seconds - anchor >= normalized.progressResetSeconds) {
    return {
      ...createPlaybackRecoveryState(key),
      cancelled: current.cancelled,
      progressAnchorSeconds: seconds,
      lastProgressSeconds: seconds,
    };
  }
  return { ...current, lastProgressSeconds: Math.max(previous || 0, seconds) };
}

export function requestPlaybackRecovery(state, {
  sourceKey: currentSourceKey = state?.sourceKey || "",
  alternateSourceKeys = [],
  reason = "error",
  policy,
} = {}) {
  let current = state || createPlaybackRecoveryState();
  const key = sourceKey(currentSourceKey);
  if (key !== current.sourceKey) current = changePlaybackRecoverySource(current, key);
  if (!key) return { state: { ...current, exhausted: true }, action: { type: "give-up", reason, sourceKey: "" } };
  if (current.cancelled) return { state: current, action: { type: "none", reason: "cancelled", sourceKey: key } };
  if (current.exhausted) return { state: current, action: { type: "none", reason: "exhausted", sourceKey: key } };
  if (current.pendingSourceKey) return { state: current, action: { type: "none", reason: "source-switch-pending", sourceKey: key } };

  const normalized = normalizePolicy(policy);
  if (current.retryCount < normalized.sameSourceRetries) {
    const next = { ...current, retryCount: current.retryCount + 1 };
    return {
      state: next,
      action: { type: "retry-source", reason, sourceKey: key, attempt: next.retryCount },
    };
  }

  if (current.sourceSwitches < normalized.maxSourceSwitches) {
    const attempted = new Set(uniqueSourceKeys(current.attemptedSourceKeys));
    attempted.add(key);
    const nextSourceKey = uniqueSourceKeys(alternateSourceKeys).find((candidate) => candidate !== key && !attempted.has(candidate));
    if (nextSourceKey) {
      return {
        state: {
          ...current,
          pendingSourceKey: nextSourceKey,
          sourceSwitches: current.sourceSwitches + 1,
          attemptedSourceKeys: [...attempted, nextSourceKey],
        },
        action: {
          type: "switch-source",
          reason,
          sourceKey: nextSourceKey,
          fromSourceKey: key,
          switchAttempt: current.sourceSwitches + 1,
        },
      };
    }
  }

  const exhausted = { ...current, exhausted: true };
  return { state: exhausted, action: { type: "give-up", reason, sourceKey: key } };
}

export function isPlaybackStallExpired({
  waitingSinceMs,
  nowMs,
  paused = false,
  seeking = false,
  ended = false,
  readyState = 0,
  haveFutureData = 3,
  stallAfterMs = DEFAULT_PLAYBACK_RECOVERY_POLICY.stallAfterMs,
} = {}) {
  if (paused || seeking || ended || Number(readyState) >= Number(haveFutureData)) return false;
  const started = waitingSinceMs === null || waitingSinceMs === undefined ? Number.NaN : Number(waitingSinceMs);
  const now = Number(nowMs);
  const threshold = finiteNonNegative(stallAfterMs, DEFAULT_PLAYBACK_RECOVERY_POLICY.stallAfterMs);
  return Number.isFinite(started) && Number.isFinite(now) && now >= started && now - started >= threshold;
}
