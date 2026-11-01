// Settings › Storage: usage, limits and leftover downloads.
import { bindTabs, confirmDialog } from "../ui/ui.js";
import { clientFeatures, learningEnabled, settingsView, video } from "../../app.js";
import { $, setToolStatus } from "../app/dom.js";
import { fetchJson, postJson } from "../app/http.js";
import { renderSettingsTabs } from "./settings-page.js";
import {
  absolutePlaybackSeconds, closeProgressiveEventStream, playerIsPlaying, restartTranscodeAt,
} from "../player/player-core.js";

let settingsStorageLoading = false;

function formatStorage(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(value >= 100 * 1024 ** 3 ? 0 : 1)} GB`;
  if (value >= 1024 ** 2) return `${Math.round(value / 1024 ** 2)} MB`;
  if (value > 0) return `${Math.max(1, Math.round(value / 1024))} KB`;
  return "0 MB";
}

function setStorageMeter(meter, usedBytes, limitBytes) {
  if (!meter) return;
  const percent = limitBytes > 0 ? Math.min(100, (usedBytes / limitBytes) * 100) : 0;
  meter.style.setProperty("--ui-progress", `${percent.toFixed(1)}%`);
  meter.setAttribute("aria-valuenow", String(Math.round(percent)));
  meter.classList.toggle("is-full", percent >= 95);
}

function updateStorageLimitSlider(slider) {
  if (!slider) return;
  const min = Number(slider.min) || 2;
  const max = Number(slider.max) || 1000;
  const value = Math.max(min, Math.min(max, Number(slider.value) || min));
  slider.style.setProperty("--storage-cap-percent", ((value - min) / Math.max(1, max - min) * 100).toFixed(2) + "%");
  slider.setAttribute("aria-valuetext", value + " GB maximum");
}

function paintStorageReport(report) {
  remuxMseCacheAllowed = report?.limits?.remuxCacheEnabled === true;
  if (!remuxMseCacheAllowed && typeof closeProgressiveEventStream === "function")
    closeProgressiveEventStream();
  const toGB = (bytes) => String(Math.round((Number(bytes) / 1024 ** 3) * 100) / 100);
  const playerInput = $("#storage-player-gb");
  const playerSlider = $("#storage-player-slider");
  const clipInput = $("#storage-clip-gb");
  const remuxCacheSwitch = $("#storage-remux-cache-enabled");
  if (remuxCacheSwitch) remuxCacheSwitch.checked = report?.limits?.remuxCacheEnabled === true;
  if (playerInput && document.activeElement !== playerInput) playerInput.value = toGB(report.limits.playerBytes);
  if (clipInput && document.activeElement !== clipInput) clipInput.value = toGB(report.limits.clipBytes);
  if (playerInput) { playerInput.min = toGB(report.ranges.playerBytes.min); playerInput.max = toGB(report.ranges.playerBytes.max); }
  if (playerSlider) {
    playerSlider.min = toGB(report.ranges.playerBytes.min);
    playerSlider.max = toGB(report.ranges.playerBytes.max);
    if (document.activeElement !== playerSlider) playerSlider.value = toGB(report.limits.playerBytes);
    updateStorageLimitSlider(playerSlider);
  }
  if (clipInput) { clipInput.min = toGB(report.ranges.clipBytes.min); clipInput.max = toGB(report.ranges.clipBytes.max); }
  const videos = Number(report.player.videos) || 0;
  $("#storage-player-usage").textContent = `${formatStorage(report.player.usedBytes)} of ${formatStorage(report.limits.playerBytes)} used${videos ? ` by ${videos} video${videos === 1 ? "" : "s"}` : ""}`;
  setStorageMeter($("#storage-player-meter"), report.player.usedBytes, report.limits.playerBytes);
  const clips = report.clips;
  const lines = [clips.cardCount ? `${clips.cardCount.toLocaleString()} for cards` : "", clips.dictationCount ? `${clips.dictationCount.toLocaleString()} for dictation` : ""].filter(Boolean).join(" and ");
  $("#storage-clip-usage").textContent = `${formatStorage(clips.usedBytes)} of ${formatStorage(report.limits.clipBytes)} used${lines ? `, ${lines}` : ""}`;
  setStorageMeter($("#storage-clip-meter"), clips.usedBytes, report.limits.clipBytes);
  $("#storage-deck-usage").textContent = report.decks.count
    ? `${formatStorage(report.decks.mediaBytes)} in ${report.decks.count} deck${report.decks.count === 1 ? "" : "s"}`
    : "No decks with media";
  const leftovers = $("#storage-leftovers");
  if (leftovers) {
    leftovers.hidden = !(Number(report.player.leftoverBytes) > 0 || Number(report.player.leftoverFolders) > 0);
    $("#storage-leftovers-title").textContent = `${formatStorage(report.player.leftoverBytes)} of leftover downloads`;
  }
  paintStorageRecommendations(report);
}

// "Recommended: 20 GB" under each budget, a Use button when the budget differs, and the same
// figures in the "?" tips.
function paintStorageRecommendations(report) {
  const recommended = report.recommended;
  if (!recommended) return;
  const sizeText = (bytes) => `${Math.round((Number(bytes) / 1024 ** 3) * 100) / 100} GB`;
  const rows = [
    ["player", recommended.playerBytes, report.limits.playerBytes, report.disk?.playerFreeBytes],
    ["clip", recommended.clipBytes, report.limits.clipBytes, report.disk?.dataFreeBytes],
  ];
  for (const [key, bytes, current, free] of rows) {
    const label = $(`#storage-${key}-rec`);
    const use = document.querySelector(`[data-storage-use="${key}"]`);
    const same = Math.abs(Number(bytes) - Number(current)) < 0.01 * 1024 ** 3;
    const freeText = Number.isFinite(free) && free !== null ? `, ${formatStorage(free)} free on this drive` : "";
    if (label) label.textContent = same ? `This is the recommended size${freeText}` : `Recommended: ${sizeText(bytes)}${freeText}`;
    if (use) {
      use.hidden = same;
      use.textContent = `Use ${sizeText(bytes)}`;
      use.dataset.bytes = String(bytes);
    }
    document.querySelectorAll(`[data-storage-rec="${key}"]`).forEach((node) => { node.textContent = sizeText(bytes); });
  }
  const lines = Math.round((Number(recommended.linesPerGB) * Number(recommended.clipBytes)) / 1024 ** 3 / 1000) * 1000;
  document.querySelectorAll('[data-storage-rec="clip-lines"]').forEach((node) => { node.textContent = lines.toLocaleString("en-US"); });
}

export async function renderSettingsStorage({ report = null } = {}) {
  if (!$("#storage-player-gb")) return;
  if (!report) {
    if (settingsStorageLoading) return;
    settingsStorageLoading = true;
    try {
      report = await fetchJson("/api/storage");
    } catch (error) {
      setToolStatus("#storage-status", error.message || "Couldn't read the storage figures", true);
      return;
    } finally {
      settingsStorageLoading = false;
    }
  }
  paintStorageReport(report);
  clientFeatures.run("storage:render", { report, panel: $("#settings-panel-storage") });
}

async function saveStorageLimits(changes) {
  try {
    let report;
    try {
      report = await postJson("/api/storage/limits", changes);
    } catch (error) {
      if (error?.status !== 409 || error?.data?.error !== "clip_budget_confirmation_required") throw error;
      const affected = Number(error.data.clipCount) || 0;
      const used = formatStorage(Number(error.data.usedBytes) || 0);
      const requested = formatStorage(Number(error.data.requestedBytes) || 0);
      if (!(await confirmDialog({ title: "Reduce the storage limit?", confirmLabel: "Reduce the limit",
        text: `Your ${affected} saved learning clips use ${used}, more than the new ${requested} limit. Some clips may be deleted.` }))) {
        setToolStatus("#storage-status", "Storage limit unchanged; clips preserved.");
        return false;
      }
      report = await postJson("/api/storage/limits", { ...changes, confirmClipEviction: true });
    }
    playerStorageLimitCache = { value: report.limits.playerBytes, at: Date.now() };
    paintStorageReport(report);
    setToolStatus("#storage-status", "Saved");
    return true;
  } catch (error) {
    setToolStatus("#storage-status", error.message || "Couldn't save the limit", true);
    return false;
  }
}

// The player storage limit, for checking a video's size before playing it (kept for a minute).
let playerStorageLimitCache = { value: 0, at: 0 };
// Only use the optional single-fetch MSE consumer after a successful read of
// the same Storage setting that controls the server's remux cache.
export let remuxMseCacheAllowed = false;

export async function playerStorageLimit() {
  if (Date.now() - playerStorageLimitCache.at < 60_000 && playerStorageLimitCache.value) return playerStorageLimitCache.value;
  try {
    const report = await fetchJson("/api/storage");
    // Missing/malformed Settings responses cannot authorize disk-backed
    // conversion or falsely paint any progressive section as seek-ready.
    remuxMseCacheAllowed = report?.limits?.remuxCacheEnabled === true;
    playerStorageLimitCache = { value: Number(report.limits?.playerBytes) || 0, at: Date.now() };
  } catch {}
  return playerStorageLimitCache.value;
}

export function wireStorageSettings() {
  bindTabs($("#settings-tabs"), {
    onChange: (value) => {
      if (!learningEnabled && value === "coach") return;
      settingsView.tab = value;
      localStorage.setItem("blackline-settings-tab", value);
      renderSettingsTabs();
    },
  });
  const limitChange = (input, key) => input?.addEventListener("change", () => {
    const value = Number(input.value);
    if (!Number.isFinite(value) || value <= 0) {
      setToolStatus("#storage-status", "Enter a size in GB", true);
      return;
    }
    void saveStorageLimits({ [key]: value });
  });
  limitChange($("#storage-player-gb"), "playerGB");
  limitChange($("#storage-clip-gb"), "clipGB");
  $("#storage-remux-cache-enabled")?.addEventListener("change", async (event) => {
    const toggle = event.currentTarget;
    const requested = toggle.checked;
    toggle.disabled = true;
    try {
      if (!requested && (video.dataset.indexed === "1" || video.dataset.progressive === "1")) {
        // Switch the active reader away before the server purges optional
        // indexed cache bytes. Do not leave a playing video pointing to a
        // file that may disappear underneath its next HTTP Range request.
        const position = absolutePlaybackSeconds(), playing = playerIsPlaying();
        // Purging the cache can delete the active MP4 before its pending
        // byte-range requests finish. Wait until the native replacement has
        // been accepted and installed before committing the destructive
        // settings change. On failure keep the cache enabled and playing.
        const switched = await restartTranscodeAt(position, { wasPlaying: playing, forceNative: true });
        if (!switched) {
          toggle.checked = true;
          setToolStatus("#storage-status", "Could not switch playback source; cache remains enabled.");
          return;
        }
      }
      const saved = await saveStorageLimits({ remuxCacheEnabled: requested });
      if (!saved) {
        toggle.checked = !requested;
        await renderSettingsStorage();
      }
    } finally {
      toggle.disabled = false;
    }
  });
  const playerSlider = $("#storage-player-slider");
  playerSlider?.addEventListener("input", () => {
    $("#storage-player-gb").value = playerSlider.value;
    updateStorageLimitSlider(playerSlider);
  });
  playerSlider?.addEventListener("change", () => {
    void saveStorageLimits({ playerGB: Number(playerSlider.value) });
  });
  document.querySelectorAll("[data-storage-use]").forEach((button) => button.addEventListener("click", () => {
    const gb = Math.round((Number(button.dataset.bytes) / 1024 ** 3) * 100) / 100;
    if (gb > 0) void saveStorageLimits({ [button.dataset.storageUse === "player" ? "playerGB" : "clipGB"]: gb });
  }));
  $("#storage-refresh")?.addEventListener("click", () => { void renderSettingsStorage(); });
  $("#storage-player-clear")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await postJson("/api/storage/clear-player", {});
      paintStorageReport(result.report);
      setToolStatus("#storage-status", result.freedBytes > 0
        ? "Cleared " + formatStorage(result.freedBytes) + " of unused video downloads."
        : "Nothing to clear.");
    } catch (error) {
      setToolStatus("#storage-status", error.message || "Couldn't free space", true);
    } finally {
      button.disabled = false;
    }
  });
  $("#storage-leftovers-clear")?.addEventListener("click", async (event) => {
    const size = $("#storage-leftovers-title")?.textContent || "the leftover downloads";
    const button = event.currentTarget;
    if (!(await confirmDialog({ title: `Delete ${size}?`, text: "These are downloads from earlier runs; nothing uses them.", confirmLabel: "Delete" }))) return;
    button.disabled = true;
    try {
      const result = await postJson("/api/storage/clear-leftovers", {});
      paintStorageReport(result.report);
      setToolStatus("#storage-status", result.freedBytes > 0
        ? "Cleared " + formatStorage(result.freedBytes) + " of leftover downloads."
        : "Nothing to clear.");
    } catch (error) {
      setToolStatus("#storage-status", error.message || "Couldn't delete the leftovers", true);
    } finally {
      button.disabled = false;
    }
  });
}
