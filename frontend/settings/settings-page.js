// Settings: its tabs and the General page.
import { escapeHtml, setActiveTab } from "../ui/ui.js";
import { learningLocaleOptions, normalizeLearningLocale } from "../../shared/settings/language-settings.js";
import { t } from "../ui/ui-i18n.js";
import { clientFeatures, learningEnabled, recsUi, SETTINGS_TABS, settingsView, state } from "../../app.js";
import { $ } from "../app/dom.js";
import { renderSettingsStorage } from "./storage-settings.js";
import { refreshAppUpdateSettings } from "../updates/app-updates.js";
import { renderAniListAutoSettings } from "../anilist/anilist-sync.js";
import {
  browserCoachStatus, coachProviders, coachProviderShortLabel, renderBrowserCoachStatus,
  selectedCoachProvider,
} from "../learning/voice-coach.js";

export function renderSettingsTabs() {
  if (!learningEnabled && settingsView.tab === "coach") settingsView.tab = "general";
  const coachTab = $("#settings-tab-coach");
  if (coachTab) coachTab.hidden = !learningEnabled;
  for (const tab of SETTINGS_TABS) {
    const panel = $(`#settings-panel-${tab}`);
    if (panel) panel.hidden = settingsView.tab !== tab;
  }
  setActiveTab($("#settings-tabs"), settingsView.tab);
  if (settingsView.tab === "storage" && $("#view-settings")?.classList.contains("is-active")) void renderSettingsStorage();
  if (settingsView.tab === "library" && $("#view-settings")?.classList.contains("is-active")) {
    recsUi.showSettings();
    clientFeatures.run("settings:library", { panel: $("#settings-panel-library") });
  }
  if (settingsView.tab === "updates" && $("#view-settings")?.classList.contains("is-active")) void refreshAppUpdateSettings();
  if (settingsView.tab === "notifications" && $("#view-settings")?.classList.contains("is-active")) void refreshAppUpdateSettings();
  clientFeatures.showSettingsTab(settingsView.tab, Boolean($("#view-settings")?.classList.contains("is-active")));
}

export function renderSettings() {
  renderAniListAutoSettings();
  const keyInput = $("#settings-subdl-key");
  const wyzieInput = $("#settings-wyzie-key");
  const subsourceInput = $("#settings-subsource-key");
  const baseInput = $("#settings-base-language");
  const targetInput = $("#settings-target-language");
  if (!keyInput || !baseInput || !targetInput) return;
  if (document.activeElement !== keyInput) keyInput.value = state.subdlKey;
  if (wyzieInput && document.activeElement !== wyzieInput) wyzieInput.value = state.wyzieKey;
  if (subsourceInput && document.activeElement !== subsourceInput) subsourceInput.value = state.subsourceKey;
  if (document.activeElement !== baseInput) baseInput.value = state.baseLanguage;
  if (document.activeElement !== targetInput) targetInput.value = state.targetLanguage;
  renderLocaleOptions("#settings-base-locale", baseInput.value, state.baseLocale);
  renderLocaleOptions("#settings-learning-locale", targetInput.value, state.targetLocale);
  const interfaceInput = $("#settings-interface-language");
  if (interfaceInput && document.activeElement !== interfaceInput) interfaceInput.value = state.interfaceLanguage;
  const stateNode = $("#settings-subdl-state");
  if (stateNode) {
    const keyed = [state.subdlKey, state.wyzieKey, state.subsourceKey].filter(Boolean).length;
    stateNode.textContent = t("{count} active", { count: 1 + keyed });
  }
  renderSettingsTabs();
  const pathNode = $("#settings-browser-coach-path");
  if (pathNode) pathNode.textContent = browserCoachStatus?.extensionPath || "browser-extension";
  const providerInput = $("#settings-ai-provider");
  const providerNote = $("#settings-ai-provider-note");
  const provider = selectedCoachProvider();
  if (providerInput) {
    const options = coachProviders.length ? coachProviders : [provider];
    providerInput.innerHTML = options.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.label)}</option>`).join("");
    providerInput.value = provider.id;
  }
  if (providerNote) {
    providerNote.textContent = provider.kind === "browser-subscription"
      ? "Uses the ChatGPT account you're signed in to in this browser, through the helper extension."
      : provider.kind === "local" ? "Runs on this computer." : `Uses ${coachProviderShortLabel(provider.label) || "the provider"} with your API key.`;
  }
  renderBrowserCoachStatus();
}

export function renderLocaleOptions(selector, language, selected) {
  const select = $(selector);
  if (!select || document.activeElement === select) return;
  const locale = normalizeLearningLocale(language, selected);
  select.innerHTML = learningLocaleOptions(language).map((option) => `<option value="${option.value}"${option.value === locale ? " selected" : ""} data-i18n="${option.key}">${escapeHtml(option.label)}</option>`).join("");
}
