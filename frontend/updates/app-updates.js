// Updates: the update card, notifications and the changelog.
import { toast } from "../ui/ui.js";
import { updateIsActive, updateView } from "./update-view.js";
import { settingsView } from "../../app.js";
import { $, setToolStatus } from "../app/dom.js";
import { fetchJson, postJson } from "../app/http.js";
import { switchView } from "../app/navigation.js";
import { renderSettingsTabs } from "../settings/settings-page.js";

// An update restarts the server with the new version while this window still
// runs the old page. Reload once the server answers with a different version;
// a server that is only restarting (no answer) is left alone.
let loadedServerVersion = null;
export async function reloadAfterAppUpdate() {
  try {
    const health = await fetchJson("/api/health", { signal: AbortSignal.timeout(5000) });
    const version = String(health?.version || "");
    if (!version) return;
    if (loadedServerVersion === null) loadedServerVersion = version;
    else if (version !== loadedServerVersion) window.location.reload();
  } catch {}
}

// The Windows launcher is the source of truth for installation and update
// policy. Source checkouts cannot change or start a packaged-app update.
export let appUpdateSettingsBusy = false;
let appUpdateSettingsSnapshot = null;
// Native automatic checks use a fixed once-per-day cadence; it is not a UI
// preference. Keep the bridge payload compatible with existing launchers.
const AUTO_UPDATE_INTERVAL_DAYS = 1;
// A failed background availability check should never look like a side
// effect of turning the automatic-check setting on or off. Only show the
// network failure in this panel after the user requests Check for updates.
let manualAppUpdateCheck = false;
// Update progress in this window; see frontend/updates/update-view.js.
export const UPDATE_PENDING_KEY = "lvl-update-in-progress-v1";
export const UPDATE_LATER_KEY = "lvl-update-later-v1";
const UPDATE_PENDING_MAX_AGE_MS = 2 * 24 * 60 * 60_000;
export let appUpdateView = { phase: "idle" };
let appUpdateDownSince = null;
let appUpdatePollTimer = null;
let appUpdateUpdatedTimer = null;
export const appUpdateCardClosed = new Set();
function readStoredJson(key) {
  try { return JSON.parse(localStorage.getItem(key) || "null"); } catch { return null; }
}
export function writeStoredJson(key, value) {
  try { if (value) localStorage.setItem(key, JSON.stringify(value)); else localStorage.removeItem(key); } catch {}
}
function readUpdatePending() {
  const pending = readStoredJson(UPDATE_PENDING_KEY);
  if (!pending || typeof pending.to !== "string") return null;
  if (Date.now() - (Number(pending.at) || 0) > UPDATE_PENDING_MAX_AGE_MS) { writeStoredJson(UPDATE_PENDING_KEY, null); return null; }
  return pending;
}
// The server is expected to stop answering while an update installs.
function appUpdateExpectsRestart() {
  return updateIsActive(appUpdateView) || appUpdateView.phase === "stuck" || Boolean(readUpdatePending()?.active);
}
function paintUpdateProgress(holder, view, label = "") {
  if (!holder) return;
  holder.hidden = !view.progress;
  if (!view.progress) return;
  const percent = view.progress.percent;
  holder.classList.toggle("is-indeterminate", percent === null);
  const bar = holder.querySelector(".app-update-progress__bar");
  if (bar) bar.style.width = percent === null ? "" : `${percent}%`;
  const track = holder.querySelector(".app-update-progress__track");
  if (percent === null) track?.removeAttribute("aria-valuenow");
  else track?.setAttribute("aria-valuenow", String(percent));
  const text = holder.querySelector(".app-update-progress__label");
  if (text) text.textContent = label;
}
export function paintAppUpdateCard() {
  const report = appUpdateSettingsSnapshot;
  const pending = readUpdatePending();
  const view = updateView({ report, downSince: appUpdateDownSince, pending,
    loadedVersion: loadedServerVersion || "",
    later: readStoredJson(UPDATE_LATER_KEY), now: Date.now() });
  appUpdateView = view;
  // Remember the update across the reload, so the new window can say it worked.
  if ((view.phase === "downloading" || view.phase === "installing") && report?.installedVersion
      && !(pending?.to === view.version && pending.active))
    writeStoredJson(UPDATE_PENDING_KEY, { from: String(report.installedVersion), to: view.version, at: Date.now(), active: true });
  else if (view.phase === "ready" && report?.update?.installsWhenIdle && report?.installedVersion && pending?.to !== view.version)
    writeStoredJson(UPDATE_PENDING_KEY, { from: String(report.installedVersion), to: view.version, at: Date.now(), active: false });
  else if (view.phase === "failed" && pending?.active) writeStoredJson(UPDATE_PENDING_KEY, null);
  if (view.phase === "updated" && !appUpdateUpdatedTimer) {
    appUpdateUpdatedTimer = setTimeout(() => {
      writeStoredJson(UPDATE_PENDING_KEY, null);
      appUpdateCardClosed.add(`updated:${view.version}`);
      paintAppUpdateCard();
    }, 12_000);
  }
  const card = $("#app-update-card");
  if (!card) return view;
  const watching = Boolean($("#view-watch")?.classList.contains("is-active"));
  const show = view.phase !== "idle" && !appUpdateCardClosed.has(`${view.phase}:${view.version}`)
    && !(view.phase === "ready" && (view.snoozed || watching || !updateNotificationsEnabled()));
  card.hidden = !show;
  if (!show) return view;
  $("#app-update-card-title").textContent = view.title;
  $("#app-update-card-detail").textContent = view.detail || "";
  paintUpdateProgress($("#app-update-card-progress"), view);
  const install = $("#app-update-card-install"), retry = $("#app-update-card-retry");
  const notes = $("#app-update-card-notes"), later = $("#app-update-card-later");
  if (install) install.hidden = view.phase !== "ready";
  if (retry) {
    retry.hidden = view.phase !== "failed" && view.phase !== "stuck";
    retry.textContent = view.phase === "stuck" ? "Reload" : "Try again";
  }
  if (notes) notes.hidden = view.phase !== "updated";
  if (later) later.hidden = view.phase !== "ready";
  return view;
}
// Poll quickly while an update downloads, installs or restarts LVL.
function scheduleAppUpdatePoll() {
  if (appUpdatePollTimer || !(updateIsActive(appUpdateView) || appUpdateView.phase === "stuck")) return;
  appUpdatePollTimer = setTimeout(async () => {
    appUpdatePollTimer = null;
    await reloadAfterAppUpdate();
    await refreshAppUpdateSettings();
    scheduleAppUpdatePoll();
  }, appUpdateView.phase === "stuck" ? 5000 : 1500);
}
function paintAppUpdateSettings(report) {
  appUpdateSettingsSnapshot = report;
  const installed = Boolean(report?.installed);
  const view = paintAppUpdateCard();
  const updating = updateIsActive(view);
  const checking = Boolean(report?.checking || report?.downloading) || updating;
  const automatic = Boolean(report?.automatic);
  const auto = $("#settings-app-updates-auto");
  const check = $("#settings-app-updates-check");
  const install = $("#settings-app-updates-install");
  if (auto) {
    auto.checked = automatic;
    auto.disabled = !installed || appUpdateSettingsBusy;
  }
  if (check) {
    check.disabled = !installed || checking || appUpdateSettingsBusy;
    check.textContent = view.phase === "downloading" ? "Downloading…"
      : updating ? "Installing…" : report?.checking ? "Checking…" : "Check for updates";
  }
  if (install) {
    install.hidden = !installed || !report?.available || updating;
    install.disabled = checking || appUpdateSettingsBusy;
    install.textContent = report?.availableVersion
      ? `Install LVL ${report.availableVersion}…` : "Install available update…";
  }
  const version = $("#settings-app-updates-version");
  if (version) version.textContent = installed ? String(report.installedVersion || "—") : "Source build";
  paintUpdateProgress($("#settings-app-updates-progress"), view, view.detail || "");
  let message = "";
  let failure = false;
  if (installed) {
    if (view.phase === "downloading") message = `Downloading LVL ${view.version}.`;
    else if (updating) message = "Installing the update. LVL restarts on its own when it's done.";
    else if (view.phase === "failed") { message = view.detail; failure = true; }
    else if (report.checking) message = "Checking the update feed…";
    else if (report.available) message = automatic
      ? `LVL ${report.availableVersion} is available. It installs by itself when no video is open, or select Install now.`
      : `LVL ${report.availableVersion} is available. Select Install to update; LVL restarts on its own.`;
    else if (report?.error && manualAppUpdateCheck) { message = `Update check failed: ${report.error}`; failure = !report?.checking; }
    else if (report.lastCheckedAt) message = "No newer version found at the last check.";
    else message = "No checks completed yet. Check now, or enable automatic checks.";
    if (!automatic && !checking && view.phase !== "failed") message += " Automatic checks are off.";
  }
  setToolStatus("#settings-app-updates-status", message, failure);
  paintUpdateNotifications(report);
  scheduleAppUpdatePoll();
}
export async function refreshAppUpdateSettings({ checkNotifications = false } = {}) {
  if (appUpdateSettingsBusy) return;
  try {
    const report = await fetchJson("/api/app-updates/status", { signal: AbortSignal.timeout(5000) });
    appUpdateDownSince = null;
    paintAppUpdateSettings(report);
    if (checkNotifications) maybeCheckForUpdateNotifications(report);
  } catch (error) {
    // LVL is restarting into the update: no error, the card shows the progress.
    if (appUpdateExpectsRestart()) {
      appUpdateDownSince ??= Date.now();
      paintAppUpdateCard();
      scheduleAppUpdatePoll();
      return;
    }
    setToolStatus("#settings-app-updates-status", error instanceof TypeError
      ? "LVL isn't answering right now. Try again in a moment."
      : error.message || "Couldn't read updater settings", true);
  }
}
async function changeAppUpdateSettings() {
  if (appUpdateSettingsBusy || !appUpdateSettingsSnapshot?.installed) return;
  appUpdateSettingsBusy = true;
  manualAppUpdateCheck = false;
  const auto = $("#settings-app-updates-auto");
  const automatic = Boolean(auto?.checked);
  try {
    paintAppUpdateSettings(await postJson("/api/app-updates/settings", { automatic, intervalDays: AUTO_UPDATE_INTERVAL_DAYS }));
    setToolStatus("#settings-app-updates-status", automatic
      ? "Automatic updates on. LVL checks every hour and installs updates when no video is open."
      : "Automatic update checks disabled. You can still check manually.");
  } catch (error) {
    setToolStatus("#settings-app-updates-status", error.message || "Couldn't change update settings", true);
    paintAppUpdateSettings(appUpdateSettingsSnapshot);
  } finally {
    appUpdateSettingsBusy = false;
    if (appUpdateSettingsSnapshot) paintAppUpdateSettings(appUpdateSettingsSnapshot);
  }
}
export function wireAppUpdateSettings() {
  $("#settings-app-updates-auto")?.addEventListener("change", () => { void changeAppUpdateSettings(); });
  $("#settings-app-updates-check")?.addEventListener("click", async () => {
    if (appUpdateSettingsBusy || !appUpdateSettingsSnapshot?.installed) return;
    appUpdateSettingsBusy = true;
    manualAppUpdateCheck = true;
    try {
      // Checking is discovery, not consent to install. A separate Install
      // action authorizes the update; automatic-update mode remains native.
      paintAppUpdateSettings(await postJson("/api/app-updates/check", { apply: false }));
    } catch (error) {
      setToolStatus("#settings-app-updates-status", error.message || "Couldn't start the update check", true);
    } finally {
      appUpdateSettingsBusy = false;
      if (appUpdateSettingsSnapshot) paintAppUpdateSettings(appUpdateSettingsSnapshot);
    }
  });
  $("#settings-app-updates-install")?.addEventListener("click", async () => {
    if (appUpdateSettingsBusy || !appUpdateSettingsSnapshot?.available) return;
    appUpdateSettingsBusy = true;
    try {
      paintAppUpdateSettings(await postJson("/api/app-updates/install", {}));
      setToolStatus("#settings-app-updates-status", "Installing the update. LVL restarts on its own when it's done.");
    } catch (error) {
      setToolStatus("#settings-app-updates-status", error.message || "Couldn't start the verified update", true);
    } finally {
      appUpdateSettingsBusy = false;
      if (appUpdateSettingsSnapshot) paintAppUpdateSettings(appUpdateSettingsSnapshot);
    }
  });
  setInterval(() => {
    if (["updates", "notifications"].includes(settingsView.tab) && $("#view-settings")?.classList.contains("is-active")
        && !appUpdateSettingsBusy) void refreshAppUpdateSettings();
  }, 2500);
}

// Update notifications are deliberately scoped to *verified available app
// versions*. No generic alerts, speculative remote releases or demo messages.
// This preference affects a browser profile's presentation; every window
// checks the same installed LVL launcher for the actual available version.
export const UPDATE_ALERTS_PREF = "lvl-available-update-notifications-v1";
const UPDATE_ALERTS_CHECKED_AT = "lvl-available-update-check-at-v1";
let notificationCheckRunning = false;
let updateChangelogCache = null;
const updateNotificationsEnabled = () => localStorage.getItem(UPDATE_ALERTS_PREF) !== "0";
const activeUpdateNotice = (report) => updateNotificationsEnabled() && report?.installed
  && report?.available && Boolean(report?.availableVersion) ? {
    version: String(report.availableVersion),
    message: report?.notice?.message || `LVL ${report.availableVersion} is available`,
  } : null;

export function paintUpdateNotifications(report = appUpdateSettingsSnapshot) {
  const notice = activeUpdateNotice(report);
  const toggle = $("#settings-notification-update-alerts");
  if (toggle) toggle.checked = updateNotificationsEnabled();
  const badge = $("#sidebar-notification-count");
  if (badge) { badge.hidden = !notice; badge.textContent = notice ? "1" : ""; }
  const bell = $("#sidebar-notifications");
  if (bell) bell.setAttribute("aria-label", notice ? "Notifications: 1 app update available" : "Notifications");
  const list = $("#app-notifications-list");
  if (!list) return;
  list.replaceChildren();
  if (notice) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "app-notification-entry";
    const heading = document.createElement("strong");
    heading.textContent = `LVL ${notice.version} available`;
    const detail = document.createElement("span");
    detail.textContent = "Open Settings › Updates to install it";
    button.append(heading, detail);
    button.addEventListener("click", () => { closeUpdateNotificationPopover(); openUpdateSettings(); });
    list.append(button);
  } else {
    const empty = document.createElement("p");
    empty.textContent = updateNotificationsEnabled() ? "No notifications" : "Notifications disabled";
    list.append(empty);
  }
}

// Notifications can discover updates independently of automated update checks,
// but only once daily. Users can disable all notification-only checks in the
// Notifications tab; this does not override native installation confirmation.
function maybeCheckForUpdateNotifications(report) {
  if (!updateNotificationsEnabled() || !report?.installed || report?.automatic
      || report?.checking || report?.downloading || notificationCheckRunning) return;
  const last = Number(localStorage.getItem(UPDATE_ALERTS_CHECKED_AT)) || 0;
  const interval = report?.error ? 60 * 60_000 : 24 * 60 * 60_000;
  if (Date.now() - last < interval) return;
  notificationCheckRunning = true;
  localStorage.setItem(UPDATE_ALERTS_CHECKED_AT, String(Date.now()));
  void postJson("/api/app-updates/check", { apply: false }).then(paintAppUpdateSettings)
    .catch((error) => console.warn("Update notification check deferred:", error?.message))
    .finally(() => { notificationCheckRunning = false; });
}

export function closeUpdateNotificationPopover({ restoreFocus = false } = {}) {
  const popover = $("#app-notifications-popover");
  if (popover) popover.hidden = true;
  $("#sidebar-notifications")?.setAttribute("aria-expanded", "false");
  if (restoreFocus) $("#sidebar-notifications")?.focus();
}
// An update notice leads to Settings › Updates, where it installs.
function openUpdateSettings() {
  closeUpdateNotificationPopover();
  settingsView.tab = "updates";
  localStorage.setItem("blackline-settings-tab", "updates");
  switchView("settings");
  renderSettingsTabs();
  void refreshAppUpdateSettings();
}
export function openUpdateNotificationPopover() {
  const popover = $("#app-notifications-popover");
  const bell = $("#sidebar-notifications");
  if (!popover || !bell) return;
  if (!popover.hidden) return closeUpdateNotificationPopover({ restoreFocus: true });
  paintUpdateNotifications();
  const rect = bell.getBoundingClientRect();
  const width = Math.min(320, window.innerWidth - 24);
  popover.style.left = `${Math.max(12, Math.min(window.innerWidth - width - 12, rect.right + 8))}px`;
  popover.style.top = `${Math.max(12, Math.min(window.innerHeight - 270, rect.top - 20))}px`;
  popover.hidden = false;
  bell.setAttribute("aria-expanded", "true");
  popover.focus();
}

export async function openUpdateChangelog() {
  const dialog = $("#app-changelog-dialog");
  const history = $("#app-changelog-history");
  const intro = $("#app-changelog-intro");
  if (!dialog || !history) return;
  closeUpdateNotificationPopover();
  intro.textContent = "Release history bundled with this LVL installation.";
  if (appUpdateSettingsSnapshot?.availableVersion) {
    intro.textContent += ` LVL ${appUpdateSettingsSnapshot.availableVersion} has been announced; its new release notes will be bundled with that installer.`;
  }
  if (!dialog.open) dialog.showModal();
  await renderBundledChangelog(history);
}

// Both the Updates accordion and the bell's dialog render exactly the same
// local changelog entries. Use textContent, not innerHTML: release notes are
// data, not executable markup.
export async function renderBundledChangelog(history) {
  if (!history) return;
  history.replaceChildren();
  try {
    const data = updateChangelogCache || await fetchJson("/api/app-updates/changelog");
    updateChangelogCache = data;
    const entries = Array.isArray(data?.entries) ? data.entries : [];
    if (!entries.length) throw new Error("No release notes were found in the installed changelog.");
    for (const entry of entries) {
      const section = document.createElement("section");
      const title = document.createElement("h3");
      title.textContent = String(entry.title || entry.version || "Release notes");
      section.append(title);
      const changes = Array.isArray(entry.changes) ? entry.changes : [];
      if (changes.length) {
        const list = document.createElement("ul");
        for (const change of changes) {
          const item = document.createElement("li");
          item.textContent = String(change);
          list.append(item);
        }
        section.append(list);
      } else {
        const note = document.createElement("p");
        note.textContent = "No changes listed.";
        section.append(note);
      }
      history.append(section);
    }
  } catch (error) {
    const message = document.createElement("p");
    message.textContent = error?.message || "The installed changelog could not be loaded.";
    history.append(message);
  }
}

export async function startAppUpdateFromCard(url, body) {
  if (appUpdateSettingsBusy) return;
  appUpdateSettingsBusy = true;
  try {
    paintAppUpdateSettings(await postJson(url, body));
  } catch (error) {
    toast(error.message || "The update couldn't start", { tone: "error" });
  } finally {
    appUpdateSettingsBusy = false;
    if (appUpdateSettingsSnapshot) paintAppUpdateSettings(appUpdateSettingsSnapshot);
  }
}

export function handleOutsideUpdateNotificationClick(event) {
  if (!$("#app-notifications-popover")?.hidden
      && !event.target.closest("#app-notifications-popover, #sidebar-notifications")) closeUpdateNotificationPopover();
}
