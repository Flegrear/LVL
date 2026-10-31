// What the window shows about an app update: the floating update card and the
// progress bar in Settings > Updates. No DOM; app.js draws the result.
//
// The server reports the update phase (ready, downloading, installing,
// failed). While LVL installs, the server is stopped and restarted, so the
// window reads "no answer" as part of the update, not as an error.
//
// `pending` is what this browser remembers across the reload:
//   { from, to, at, active } active = it saw the download or install start.

export const UPDATE_STUCK_AFTER_MS = 2 * 60_000;
export const UPDATE_LATER_MS = 24 * 60 * 60_000;
// A server that comes back this long after an install started, still on the
// old version, means the install was rolled back.
const ROLLED_BACK_AFTER_MS = 20_000;
const ACTIVE = new Set(["downloading", "installing", "restarting"]);

export const updateIsActive = (view) => ACTIVE.has(view?.phase);

export function formatUpdateBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(value >= 100 * 1024 ** 2 ? 0 : 1)} MB`;
  return `${Math.max(1, Math.round(value / 1024))} KB`;
}

// 0-100, or null when the total isn't known (the bar then just moves).
export function updatePercent(progress) {
  const bytes = Number(progress?.bytes), total = Number(progress?.total);
  if (!Number.isFinite(bytes) || !Number.isFinite(total) || total <= 0) return null;
  return Math.max(0, Math.min(100, Math.floor(bytes / total * 100)));
}

const installing = (version) => ({ phase: "installing", version, title: `Installing LVL ${version}`,
  detail: "LVL restarts by itself. This window reloads when it's back.", progress: { percent: null } });
const failed = (version, current, reason = "") => ({ phase: "failed", version, title: "The update didn't install",
  detail: `LVL is still on ${current || "the version you had"}.${reason ? ` ${reason}` : ""}`, progress: null });

/**
 * @param {object} input
 * @param {object|null} input.report    last /api/app-updates/status answer
 * @param {number|null} input.downSince when the server stopped answering, if it has
 * @param {object|null} input.pending   see above
 * @param {string} input.loadedVersion  version the server reported when this page loaded
 * @param {object|null} input.later     { version, at } the user chose Later for
 * @param {number} input.now
 */
export function updateView({ report = null, downSince = null, pending = null, loadedVersion = "",
  later = null, now = Date.now() } = {}) {
  const installed = String(report?.installedVersion || loadedVersion || "");

  if (downSince) {
    if (!pending?.active || !pending.to) return { phase: "idle" };
    if (now - downSince >= UPDATE_STUCK_AFTER_MS) return { phase: "stuck", version: pending.to,
      title: "LVL hasn't restarted yet", detail: "If it doesn't come back, open LVL from the Start menu.", progress: null };
    return { ...installing(pending.to), phase: "restarting" };
  }

  // This window now runs the new version.
  if (pending?.to && installed === pending.to)
    return { phase: "updated", version: pending.to, title: `LVL updated to ${pending.to}`, detail: "", progress: null };

  if (!report?.installed) return { phase: "idle" };
  const update = report.update || {};
  const version = String(update.version || report.availableVersion || "");

  if (update.phase === "downloading" && version) {
    const percent = updatePercent(update.progress);
    const bytes = Number(update.progress?.bytes) || 0, total = Number(update.progress?.total) || 0;
    const amount = total ? `${formatUpdateBytes(bytes)} of ${formatUpdateBytes(total)}`
      : bytes ? formatUpdateBytes(bytes) : "Starting the download";
    return { phase: "downloading", version, title: `Downloading LVL ${version}`,
      detail: percent === null ? amount : `${percent}% · ${amount}`, progress: { percent } };
  }
  if (update.phase === "installing" && version) return installing(version);
  if (update.phase === "failed" && version) return failed(version, installed, update.error || "");

  // LVL restarted on the old version after this window saw the install start.
  if (pending?.active && pending.from && installed === pending.from && now - (Number(pending.at) || 0) > ROLLED_BACK_AFTER_MS)
    return failed(pending.to, installed);

  if (update.phase === "ready" && version) {
    const size = update.size?.bytes ? ` (${formatUpdateBytes(update.size.bytes)})` : "";
    const snoozed = later?.version === version && now - (Number(later.at) || 0) < UPDATE_LATER_MS;
    return { phase: "ready", version, snoozed, title: `LVL ${version} is ready`,
      detail: update.installsWhenIdle
        ? `It installs by itself when no video is open${size}.`
        : `Install it now${size}. LVL restarts by itself.`,
      progress: null };
  }
  return { phase: "idle" };
}
