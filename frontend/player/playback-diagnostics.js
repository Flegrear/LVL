// Recovery-only, bounded, memory-only display history. Never accept raw
// exceptions, URLs, magnet links, titles, provider replies or session IDs.
const LABELS = Object.freeze({
  problem: "Playback interrupted",
  retry: "Retrying current source",
  switch: "Trying another source",
  failed: "Recovery attempt failed",
  restored: "Playback restored",
  stopped: "Playback stopped safely",
  cancelled: "Playback cancelled",
});
const REASONS = Object.freeze({
  stall: "Playback stalled",
  error: "Stream error",
  decode: "Decoder error",
  "early-eof": "Stream ended early",
  "alternate-failed": "Alternate source unavailable",
});
const PLANS = Object.freeze({
  direct: "Direct",
  remux: "Remux",
  transcode: "Transcode",
  other: "Other",
});

export function addRecoveryEvent(events, { type, reason, plan, attempt, seconds, now = Date.now() } = {}) {
  if (!Object.hasOwn(LABELS, type)) return events;
  const time = Number(now);
  const position = Number(seconds);
  const count = Number(attempt);
  const next = {
    at: Number.isFinite(time) ? time : 0,
    label: LABELS[type],
    reason: Object.hasOwn(REASONS, reason) ? REASONS[reason] : "",
    plan: Object.hasOwn(PLANS, plan) ? PLANS[plan] : PLANS.other,
    attempt: Number.isSafeInteger(count) && count >= 1 && count <= 20 ? count : 0,
    seconds: Number.isFinite(position) && position >= 0 ? Math.round(position) : 0,
  };
  return [...(Array.isArray(events) ? events : []).slice(-39), next];
}

export function recoveryEpisodeCode(sourceTag) {
  return String(sourceTag || "").match(/\bS\d{1,2}E\d{1,3}\b/i)?.[0]?.toUpperCase() || "Current video";
}
