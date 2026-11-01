// Timestamps for synced changes: a hybrid logical clock. A stamp is
//   "<wall time in ms, 15 digits>-<counter, 4 hex digits>-<device id>"
// and stamps sort correctly as plain text. Each device moves its clock past every stamp
// it reads, so a change made after reading another device's change always sorts later,
// even when the two devices' clocks disagree by a few minutes. Device ids break ties.
const STAMP = /^(\d{15})-([0-9a-f]{4})-([a-z0-9][a-z0-9-]{2,31})$/;
export const DEVICE_ID = /^[a-z0-9][a-z0-9-]{2,31}$/;
// A stamp more than this far ahead of this device's clock is only followed up to this limit:
// a device whose clock is set years ahead can't push every later change behind its own.
export const MAX_AHEAD_MS = 24 * 60 * 60_000;
const MAX_COUNTER = 0xffff;

export function parseStamp(stamp) {
  const match = STAMP.exec(String(stamp || ""));
  return match ? { ms: Number(match[1]), counter: parseInt(match[2], 16), device: match[3] } : null;
}

export function formatStamp({ ms, counter, device }) {
  return `${String(ms).padStart(15, "0")}-${counter.toString(16).padStart(4, "0")}-${device}`;
}

// -1, 0 or 1, for sorting. Valid stamps compare as text; anything else sorts first.
export function compareStamps(a, b) {
  const left = STAMP.test(String(a || "")) ? String(a) : "";
  const right = STAMP.test(String(b || "")) ? String(b) : "";
  return left < right ? -1 : left > right ? 1 : 0;
}

// A new random device id, like "d-4k2m9x7q1z" (one per LVL install or phone).
export function newDeviceId(random = (bytes) => globalThis.crypto.getRandomValues(new Uint8Array(bytes))) {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  return `d-${Array.from(random(10), (byte) => alphabet[byte % alphabet.length]).join("")}`;
}

// last: the newest stamp this device made or read before (saved between runs).
export function createClock({ device, last = "", now = Date.now } = {}) {
  if (!DEVICE_ID.test(String(device || ""))) throw new Error(`Invalid sync device id: ${device}`);
  let state = parseStamp(last) || { ms: 0, counter: 0 };
  const advance = (ms, counter) => {
    if (counter > MAX_COUNTER) { ms += 1; counter = 0; }
    state = { ms, counter };
  };
  return {
    device,
    // A stamp for a change made on this device now.
    tick() {
      const wall = now();
      if (wall > state.ms) advance(wall, 0);
      else advance(state.ms, state.counter + 1);
      return formatStamp({ ...state, device });
    },
    // A stamp read from another device: this device's next stamps sort after it.
    observe(stamp) {
      const seen = parseStamp(stamp);
      if (!seen) return;
      const wall = now();
      const ms = Math.min(seen.ms, wall + MAX_AHEAD_MS);
      if (ms > state.ms) advance(ms, ms === seen.ms ? seen.counter : 0);
      else if (ms === state.ms) advance(ms, Math.max(state.counter, ms === seen.ms ? seen.counter : 0));
    },
    // Saved with the device's sync settings, so a restart never goes back in time.
    last: () => formatStamp({ ...state, device }),
  };
}
