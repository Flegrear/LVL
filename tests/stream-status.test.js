import test from "node:test";
import assert from "node:assert/strict";
import { classifyPlaybackStreamStatus } from "../frontend/player/stream-status.js";

const stalled = { stalled: true };
const reader = { role: "unknown", start: 1024, ageMs: 9000, nextPiecePresent: false, firstPiecePresent: true };

test("stream status requires a current active stall and missing reader piece for no-peers", () => {
  const health = { peers: 0, activeReaderCount: 1, readers: [reader], playheadVerified: false };
  assert.equal(classifyPlaybackStreamStatus(health, stalled).code, "no-peers");
  for (const condition of [{}, { stalled: true, paused: true }, { stalled: true, seeking: true },
    { stalled: true, ended: true }]) assert.equal(classifyPlaybackStreamStatus(health, condition), null);
  assert.equal(classifyPlaybackStreamStatus({ ...health, readers: [] }, stalled), null);
  assert.equal(classifyPlaybackStreamStatus({ ...health, readers: [{ nextPiecePresent: true }] }, stalled), null);
  assert.equal(classifyPlaybackStreamStatus({ ...health, readers: [{ nextPiecePresent: null, firstPiecePresent: false }] }, stalled), null,
    "completed or unobserved pending data cannot be inferred from a stale first piece");
  assert.equal(classifyPlaybackStreamStatus({ ...health, activeReaderCount: 0 }, stalled), null);
  assert.equal(classifyPlaybackStreamStatus(null, stalled), null);
  assert.equal(classifyPlaybackStreamStatus({ peers: 0, activeReaderCount: 1 }, stalled), null);
});

test("known requested range and observed slow source describe evidence without a playhead claim", () => {
  const requested = { requestedRangeActive: true, requestedPiecePresent: false, status: "missing-piece" };
  assert.equal(classifyPlaybackStreamStatus(requested, stalled).code, "missing-piece");
  assert.equal(classifyPlaybackStreamStatus({ ...requested, status: "slow-source" }, stalled).code, "slow-source");
  assert.equal(classifyPlaybackStreamStatus({ ...requested, requestedPiecePresent: true }, stalled), null);
  const low = { peers: 2, activeReaderCount: 2, downloadBytesPerSecond: 400, readers: [reader] };
  assert.equal(classifyPlaybackStreamStatus(low, stalled).code, "slow-source");
  assert.equal(classifyPlaybackStreamStatus({ ...low, downloadBytesPerSecond: 100_000 }, stalled).code, "waiting-for-piece");
  assert.equal(classifyPlaybackStreamStatus({ ...low, readers: [{ ...reader, ageMs: 50 }] }, stalled).code, "waiting-for-piece");
  assert.match(classifyPlaybackStreamStatus(low, stalled).message, /torrent/i);
  assert.doesNotMatch(classifyPlaybackStreamStatus(low, stalled).message, /playhead|episode|file|offset/i);
});

test("health snapshots and missing fields do not leak private reader data to UI", () => {
  const supplied = { ...reader, rawUrl: "magnet:?xt=secret", fileName: "SECRET.mkv" };
  const status = classifyPlaybackStreamStatus({ peers: 0, activeReaderCount: 1, readers: [supplied] }, stalled);
  assert.deepEqual(Object.keys(status).sort(), ["code", "message", "networkStarvation"]);
  assert.doesNotMatch(JSON.stringify(status), /magnet|secret|\.mkv/i);
  assert.equal(classifyPlaybackStreamStatus({ status: "no-peers", peers: 0, readers: [] }, stalled), null);
});
