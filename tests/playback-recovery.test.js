import test from "node:test";
import assert from "node:assert/strict";
import {
  cancelPlaybackRecovery,
  changePlaybackRecoverySource,
  createPlaybackRecoveryState,
  failPlaybackRecoverySwitch,
  isPlaybackStallExpired,
  playbackRecoverySourceKey,
  playbackRetryStrategy,
  recordPlaybackProgress,
  requestPlaybackRecovery,
} from "../frontend/player/playback-recovery.js";

test("network stalls reconnect original streams; decoder failures switch to compatibility", () => {
  assert.equal(playbackRetryStrategy("torrent-direct", "stall", 0), "restart-direct");
  assert.equal(playbackRetryStrategy("torrent-direct", "error", 2), "restart-direct");
  assert.equal(playbackRetryStrategy("torrent-direct", "error", 3), "compatibility");
  assert.equal(playbackRetryStrategy("torrent-direct", "error", 4), "compatibility");
  assert.equal(playbackRetryStrategy("transcode", "error", 3), "restart-transcode");
});

test("retries the same source once before switching to an untried alternate", () => {
  let state = createPlaybackRecoveryState("source-a");
  let result = requestPlaybackRecovery(state, { reason: "error", alternateSourceKeys: ["source-b", "source-c"] });
  assert.deepEqual(result.action, { type: "retry-source", reason: "error", sourceKey: "source-a", attempt: 1 });
  state = result.state;

  result = requestPlaybackRecovery(state, { reason: "error", alternateSourceKeys: ["source-a", "source-b", "source-c"] });
  assert.equal(result.action.type, "switch-source");
  assert.equal(result.action.sourceKey, "source-b");
  state = changePlaybackRecoverySource(result.state, "source-b");

  result = requestPlaybackRecovery(state, { reason: "stall", alternateSourceKeys: ["source-a", "source-b", "source-c"] });
  assert.deepEqual(result.action, { type: "retry-source", reason: "stall", sourceKey: "source-b", attempt: 1 });
  state = result.state;

  result = requestPlaybackRecovery(state, { reason: "stall", alternateSourceKeys: ["source-a", "source-b", "source-c"] });
  assert.equal(result.action.type, "switch-source");
  assert.equal(result.action.sourceKey, "source-c", "already attempted source-a is skipped instead of forming a loop");
});

test("recovery is bounded and emits give-up only once until reset", () => {
  const policy = { sameSourceRetries: 1, maxSourceSwitches: 1 };
  let state = createPlaybackRecoveryState("source-a");
  state = requestPlaybackRecovery(state, { alternateSourceKeys: ["source-b"], policy }).state;
  let result = requestPlaybackRecovery(state, { alternateSourceKeys: ["source-b"], policy });
  state = changePlaybackRecoverySource(result.state, result.action.sourceKey);
  state = requestPlaybackRecovery(state, { alternateSourceKeys: ["source-a"], policy }).state;
  result = requestPlaybackRecovery(state, { alternateSourceKeys: ["source-a"], policy });
  assert.equal(result.action.type, "give-up");
  assert.equal(result.state.exhausted, true);

  result = requestPlaybackRecovery(result.state, { alternateSourceKeys: ["source-a"] , policy });
  assert.equal(result.action.type, "none");
  assert.equal(result.action.reason, "exhausted");
});

test("a confirmed recovery switch preserves history while an unrelated source change resets it", () => {
  let state = createPlaybackRecoveryState("source-a");
  state = requestPlaybackRecovery(state, { alternateSourceKeys: ["source-b"] }).state;
  const switched = requestPlaybackRecovery(state, { alternateSourceKeys: ["source-b"] });
  assert.equal(switched.state.pendingSourceKey, "source-b");

  state = changePlaybackRecoverySource(switched.state, "source-b");
  assert.deepEqual(state.attemptedSourceKeys, ["source-a", "source-b"]);
  assert.equal(state.sourceSwitches, 1);

  state = changePlaybackRecoverySource(state, "manual-source");
  assert.deepEqual(state, createPlaybackRecoveryState("manual-source"));
});

test("a failed recovery switch keeps its attempt consumed and chooses the next untried alternate", () => {
  let state = createPlaybackRecoveryState("source-a");
  state = requestPlaybackRecovery(state, { alternateSourceKeys: ["source-b", "source-c"] }).state;
  let result = requestPlaybackRecovery(state, { alternateSourceKeys: ["source-b", "source-c"] });
  assert.equal(result.action.sourceKey, "source-b");
  assert.equal(result.state.pendingSourceKey, "source-b");

  state = failPlaybackRecoverySwitch(result.state);
  assert.equal(state.sourceKey, "source-a", "the failed target never became current");
  assert.equal(state.pendingSourceKey, "");
  assert.equal(state.retryCount, 1, "the old source does not get another same-source retry");
  assert.equal(state.sourceSwitches, 1, "the failed switch still consumes the switch budget");
  assert.deepEqual(state.attemptedSourceKeys, ["source-a", "source-b"], "the failed target remains tried");

  result = requestPlaybackRecovery(state, { alternateSourceKeys: ["source-a", "source-b", "source-c"] });
  assert.equal(result.action.type, "switch-source");
  assert.equal(result.action.sourceKey, "source-c");
  assert.equal(result.state.sourceSwitches, 2);
});

test("sustained forward playback resets the incident budget", () => {
  let state = createPlaybackRecoveryState("source-a");
  state = requestPlaybackRecovery(state, { alternateSourceKeys: ["source-b"] }).state;
  state = recordPlaybackProgress(state, { currentTimeSeconds: 10, policy: { progressResetSeconds: 5 } });
  state = recordPlaybackProgress(state, { currentTimeSeconds: 14.9, policy: { progressResetSeconds: 5 } });
  assert.equal(state.retryCount, 1, "small progress does not hide a continuing stall incident");
  state = recordPlaybackProgress(state, { currentTimeSeconds: 15.1, policy: { progressResetSeconds: 5 } });
  assert.equal(state.retryCount, 0);
  assert.equal(state.sourceSwitches, 0);
  assert.deepEqual(state.attemptedSourceKeys, ["source-a"]);

  const recovered = requestPlaybackRecovery(state, { reason: "stall", alternateSourceKeys: ["source-b"] });
  assert.equal(recovered.action.type, "retry-source", "healthy playback earns a fresh bounded recovery incident");
});

test("progress while seeking does not reset recovery state", () => {
  let state = createPlaybackRecoveryState("source-a");
  state = requestPlaybackRecovery(state, { alternateSourceKeys: ["source-b"] }).state;
  const afterSeek = recordPlaybackProgress(state, { currentTimeSeconds: 120, seeking: true, policy: { progressResetSeconds: 1 } });
  assert.deepEqual(afterSeek, state);
});

test("cancellation suppresses recovery until a new source is selected", () => {
  let state = cancelPlaybackRecovery(createPlaybackRecoveryState("source-a"));
  let result = requestPlaybackRecovery(state, { alternateSourceKeys: ["source-b"] });
  assert.equal(result.action.type, "none");
  assert.equal(result.action.reason, "cancelled");

  state = changePlaybackRecoverySource(state, "source-b");
  result = requestPlaybackRecovery(state, { alternateSourceKeys: ["source-c"] });
  assert.equal(result.action.type, "retry-source");
});

test("stall expiry ignores pause, seek, end, and recovered buffer states", () => {
  const base = { waitingSinceMs: 1_000, nowMs: 9_000, stallAfterMs: 8_000, readyState: 2, haveFutureData: 3 };
  assert.equal(isPlaybackStallExpired(base), true);
  assert.equal(isPlaybackStallExpired({ ...base, nowMs: 8_999 }), false);
  assert.equal(isPlaybackStallExpired({ ...base, waitingSinceMs: null }), false, "unset wait must not count from Unix epoch");
  assert.equal(isPlaybackStallExpired({ ...base, paused: true }), false);
  assert.equal(isPlaybackStallExpired({ ...base, seeking: true }), false);
  assert.equal(isPlaybackStallExpired({ ...base, ended: true }), false);
  assert.equal(isPlaybackStallExpired({ ...base, readyState: 3 }), false);
});

test("source keys are stable for saved same-chapter sources", () => {
  assert.equal(playbackRecoverySourceKey("ABCDEF", 7), "ABCDEF:7");
  assert.equal(playbackRecoverySourceKey("ABCDEF", 0), "ABCDEF:0", "zero remains a valid file index");
  assert.equal(playbackRecoverySourceKey("", 7), "");
  assert.equal(playbackRecoverySourceKey("ABCDEF", -1), "");
  assert.equal(playbackRecoverySourceKey("ABCDEF", null), "", "missing index must not become file 0");
  assert.equal(playbackRecoverySourceKey("ABCDEF", ""), "", "blank index must not become file 0");
  assert.equal(playbackRecoverySourceKey("ABCDEF", "   "), "", "whitespace index must not become file 0");
  assert.equal(playbackRecoverySourceKey("ABCDEF", Number.MAX_SAFE_INTEGER + 1), "", "unsafe index cannot identify an episode");
});
